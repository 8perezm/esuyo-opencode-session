import { Plugin } from "opentui:runtime-module:%40opencode%2Fplugin%2Ftui";
import type { Destination } from "@opencode/plugin/tui/context";
import { TextAttributes } from "opentui:runtime-module:%40opentui%2Fcore";
import type { ModelInfo } from "@opencode/client";
import { Show, createEffect, createSignal } from "opentui:runtime-module:solid-js";
import { h } from "./jsx";
import {
  combineCosts,
  computeDetails,
  EMPTY_DETAILS,
  fetchAssistantMessages,
  fetchDescendants,
  sumSessions,
  type SessionDetails,
} from "./usage";
import {
  createTrackerState,
  dropSession,
  ensureLogDir,
  handleStepEnded,
  handleStepFailed,
  handleStepStarted,
  handleTextDelta,
  handleToolCalled,
  logLine,
  pruneSamples,
  statusTextFor,
  type TrackerState,
} from "./tps";
import { DetailsPage, UsageRow } from "./details-page";
import { clip, errorMessage, fmt, fmtCost, fmtDuration } from "./format";

const id = "esuyo-opencode-session";
const REFRESH_DELAY_MS = 200;
const TOGGLE_COMMAND = "session.usage.details";
const MAX_MODEL_LABEL = 18;
const DETAILS_PAGE = "session-usage-details";
const PAGE_COMMAND = "session.usage.page";
const OPEN_LINK_LABEL = "⤺ open session details";

export interface UsageState {
  status: "loading" | "ready" | "error";
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  costMode: "reported" | "estimated" | "mixed";
  turns: number;
  details: SessionDetails;
  error?: string;
}

const EMPTY: UsageState = {
  status: "loading",
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
  costMode: "reported",
  turns: 0,
  details: { ...EMPTY_DETAILS },
};

export default Plugin.define({
  id,
  setup(context) {
    let disposed = false;
    let loadID = 0;
    let lastSessionID = "";
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let knownSessionIDs = new Set<string>();
    const [state, setState] = createSignal<UsageState>({ ...EMPTY });
    const [expanded, setExpanded] = createSignal(false);
    const toggleDetails = () => {
      setExpanded((open) => !open);
    };

    const [pageOpen, setPageOpen] = createSignal(false);

    /** The page's return target travels in the route data, the same way the host's diff viewer does
     *  it, so it survives a plugin reload or a second plugin instance. A target that points back at
     *  this page is dropped: it makes "back" look like a key that does nothing. */
    const usableReturnRoute = (route: unknown): Destination | undefined => {
      if (!route || typeof route !== "object") return undefined;
      const candidate = route as Destination;
      if (candidate.type === "plugin" && candidate.name === DETAILS_PAGE) return undefined;
      return candidate;
    };
    const backFrom = (returnRoute: Destination | undefined, sessionID: string | undefined): Destination =>
      returnRoute ?? (sessionID ? { type: "session", sessionID } : { type: "home" });

    const openPage = (sessionID: string) => {
      if (!sessionID) return;
      const current = context.ui.router.current();
      let returnRoute: Destination | undefined;
      if (current.type === "plugin" && current.name === DETAILS_PAGE) {
        // The sidebar stays visible while the page is open, so re-opening must keep the original
        // return target instead of capturing this page as the place to go back to.
        returnRoute = usableReturnRoute(current.data?.returnRoute);
      } else if (current.type === "plugin") {
        returnRoute = { type: "plugin", name: current.name, ...(current.data ? { data: { ...current.data } } : {}) };
      } else {
        returnRoute = current;
      }
      context.ui.router.navigate({
        type: "plugin",
        name: DETAILS_PAGE,
        data: { sessionID, returnRoute: backFrom(returnRoute, sessionID) },
      });
    };

    const closePage = () => {
      const current = context.ui.router.current();
      if (current.type !== "plugin" || current.name !== DETAILS_PAGE) return;
      const sessionID = typeof current.data?.sessionID === "string" ? current.data.sessionID : lastSessionID;
      context.ui.router.navigate(backFrom(usableReturnRoute(current.data?.returnRoute), sessionID));
    };

    const scheduleRefresh = () => {
      if (disposed || !lastSessionID) return;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refresh(lastSessionID);
      }, REFRESH_DELAY_MS);
    };

    const refresh = async (sessionID: string) => {
      if (disposed || !sessionID) return;
      const currentLoadID = ++loadID;

      try {
        const [root, descendants, rootMessages] = await Promise.all([
          context.client.session.get({ sessionID }),
          fetchDescendants(context.client, sessionID),
          fetchAssistantMessages(context.client, sessionID),
        ]);
        if (disposed || currentLoadID !== loadID) return;

        knownSessionIDs = new Set([sessionID, ...descendants.sessions.map((session) => session.id)]);
        const assistantMessages = [...rootMessages, ...descendants.messages];
        const totals: UsageState = {
          ...sumSessions([root, ...descendants.sessions], assistantMessages.length),
          status: "ready",
          costMode: "reported",
          details: { ...EMPTY_DETAILS },
        };

        let pricingModels: readonly ModelInfo[] | undefined;
        try {
          if (assistantMessages.some((message) => message.cost === 0 && message.tokens)) {
            const models = await context.client.model.list({ location: context.location });
            pricingModels = models.data;
            const combined = combineCosts(totals.cost, assistantMessages, models.data);
            totals.cost = combined.cost;
            totals.costMode = combined.mode;
          }
        } catch {
          // Pricing is optional; session totals remain available when it cannot load.
        }

        totals.details = computeDetails(root, descendants.sessions, assistantMessages, pricingModels);

        if (disposed || currentLoadID !== loadID) return;
        setState(totals);
      } catch (error) {
        if (disposed || currentLoadID !== loadID) return;
        if (state().status !== "ready") {
          setState({ ...EMPTY, status: "error", error: errorMessage(error) });
        }
      }
    };

    const refreshForKnownSession = (sessionID: string) => {
      if (knownSessionIDs.has(sessionID)) scheduleRefresh();
    };

    const stopUsageUpdate = context.data.on("session.usage.updated", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });
    const stopExecution = context.data.on("session.execution.succeeded", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });
    const stopSessionCreated = context.data.on("session.created", (event) => {
      if (event.data.parentID && knownSessionIDs.has(event.data.parentID)) {
        scheduleRefresh();
      }
    });
    const stopSessionDeleted = context.data.on("session.deleted", (event) => {
      refreshForKnownSession(event.data.sessionID);
    });

    // Live throughput (TPS/AVG/TTFT/GAP) tracker, ported from esuyo-opencode-tks.
    // Event-driven only: no client requests, so the zero-extra-request rule still holds.
    const tpsTracker: TrackerState = createTrackerState();
    const [tpsTick, bumpTpsTick] = createSignal(0);
    const bumpTps = () => bumpTpsTick((value) => value + 1);
    void ensureLogDir();

    const stamp = (event: { created: number }) =>
      Number.isFinite(event.created) ? event.created : Date.now();

    const isIdle = (sessionID: string): boolean => {
      try {
        return context.data.session?.status(sessionID) !== "running";
      } catch {
        return true;
      }
    };

    const tpsStatusText = (sessionID: string): string => {
      // Reading the tick subscribes this text to tracker changes.
      tpsTick();
      return statusTextFor(tpsTracker, sessionID, isIdle(sessionID));
    };

    const sampleDelta = (sessionID: string, messageID: string, delta: string, at: number) => {
      // Stamp samples with the host clock, the same clock step timings use,
      // so replayed or slightly delayed events stay consistent.
      handleTextDelta(tpsTracker, sessionID, messageID, delta, at);
      bumpTps();
    };

    const tpsStops: Array<() => void> = [
      context.data.on("session.text.delta", (event) =>
        sampleDelta(event.data.sessionID, event.data.assistantMessageID, event.data.delta, stamp(event)),
      ),
      context.data.on("session.reasoning.delta", (event) =>
        sampleDelta(event.data.sessionID, event.data.assistantMessageID, event.data.delta, stamp(event)),
      ),
      context.data.on("session.step.started", (event) => {
        handleStepStarted(tpsTracker, event.data.sessionID, event.data.assistantMessageID, stamp(event));
        bumpTps();
      }),
      context.data.on("session.step.ended", (event) => {
        const record = handleStepEnded(
          tpsTracker,
          event.data.sessionID,
          event.data.assistantMessageID,
          event.data.finish,
          event.data.tokens,
          stamp(event),
        );
        if (record) void logLine(record);
        // handleStepEnded already prunes; bumping re-renders the footer.
        bumpTps();
      }),
      context.data.on("session.step.failed", (event) => {
        handleStepFailed(tpsTracker, event.data.assistantMessageID);
        bumpTps();
      }),
      context.data.on("session.tool.called", (event) => {
        handleToolCalled(tpsTracker, event.data.sessionID, event.data.assistantMessageID, stamp(event));
        bumpTps();
      }),
      context.data.on("session.execution.interrupted", (event) => {
        dropSession(tpsTracker, event.data.sessionID);
        bumpTps();
      }),
      context.data.on("session.execution.failed", (event) => {
        dropSession(tpsTracker, event.data.sessionID);
        bumpTps();
      }),
    ];

    const tpsTimer = setInterval(() => {
      if (pruneSamples(tpsTracker)) bumpTps();
      else bumpTps();
    }, 1000);

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        createEffect(() => {
          const sessionID = props.sessionID;
          if (sessionID !== lastSessionID) {
            lastSessionID = sessionID;
            knownSessionIDs = new Set([sessionID]);
            setState({ ...EMPTY });
            void refresh(sessionID);
          }
        });

        const totalTokens = () => {
          const usage = state();
          return usage.input + usage.output + usage.reasoning + usage.cacheRead + usage.cacheWrite;
        };
        const cacheHitRate = () => {
          const usage = state();
          const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
          if (prompt === 0) return "—";
          return `${((usage.cacheRead / prompt) * 100).toFixed(1)}%`;
        };
        const costColor = () => {
          if (state().cost < 5) return context.theme.text.feedback.info.base;
          if (state().cost < 25) return context.theme.text.feedback.warning.base;
          return context.theme.text.feedback.error.base;
        };

        const d = () => state().details;
        const issues = () =>
          [
            d().truncated > 0 ? d().truncated + " truncated" : "",
            d().errored > 0 ? d().errored + " errored" : "",
            d().retried > 0 ? d().retried + " retried" : "",
          ]
            .filter(Boolean)
            .join(" · ");
        const hasDetails = () => {
          const x = d();
          return (
            x.toolCalls > 0 ||
            x.files > 0 ||
            x.subagents > 0 ||
            x.models > 1 ||
            x.savings > 0 ||
            x.truncated > 0 ||
            x.errored > 0 ||
            x.retried > 0 ||
            x.ageMs > 0 ||
            x.busyMs > 0
          );
        };

        return h(Show, {
          get when() {
            return (
              state().status === "loading" ||
              (state().status === "ready" &&
                (state().turns > 0 || totalTokens() > 0 || state().cost > 0))
            );
          },
          children: h("box", {
            gap: 0,
            children: [
              h("box", {
                flexDirection: "row",
                justifyContent: "space-between",
                children: [
                  h("text", {
                    fg: context.theme.text.base,
                    attributes: TextAttributes.BOLD,
                    children: "Session Token Summary",
                  }),
                  h("text", {
                    fg: context.theme.text.muted,
                    children: () => "↻ " + state().turns + " turn" + (state().turns === 1 ? "" : "s"),
                  }),
                ],
              }),
              h(Show, {
                get when() {
                  return state().status === "loading";
                },
                children: h("text", { fg: context.theme.text.muted, children: "Loading…" }),
              }),
              h(Show, {
                get when() {
                  return state().status === "ready";
                },
                children: h("box", {
                  gap: 0,
                  children: [
                    h(UsageRow, {
                      label: "↑ in",
                      get value() {
                        return fmt(state().input);
                      },
                      labelColor: context.theme.text.muted,
                      valueColor: context.theme.text.base,
                    }),
                    h(UsageRow, {
                      label: "↓ out",
                      get value() {
                        return fmt(state().output);
                      },
                      labelColor: context.theme.text.muted,
                      valueColor: context.theme.text.base,
                    }),
                    h(UsageRow, {
                      label: "▤ cache write",
                      get value() {
                        return fmt(state().cacheWrite);
                      },
                      labelColor: context.theme.text.muted,
                      valueColor: context.theme.text.base,
                    }),
                    h(UsageRow, {
                      label: "▤ cache read",
                      get value() {
                        return fmt(state().cacheRead);
                      },
                      labelColor: context.theme.text.muted,
                      valueColor: context.theme.text.base,
                    }),
                    h(UsageRow, {
                      label: "ø cache hit rate",
                      get value() {
                        return cacheHitRate();
                      },
                      labelColor: context.theme.text.muted,
                      valueColor: context.theme.text.base,
                    }),
                    h(Show, {
                      get when() {
                        return state().reasoning > 0;
                      },
                      children: h(UsageRow, {
                        label: "✦ think",
                        get value() {
                          return fmt(state().reasoning);
                        },
                        labelColor: context.theme.text.muted,
                        valueColor: context.theme.text.base,
                      }),
                    }),
                    h("box", { height: 1, border: ["top"], borderColor: context.theme.border.base }),
                    h("box", {
                      flexDirection: "row",
                      justifyContent: "space-between",
                      children: [
                        h("text", { fg: context.theme.text.muted, children: "Σ total" }),
                        h("text", {
                          fg: context.theme.text.base,
                          attributes: TextAttributes.BOLD,
                          children: () => fmt(totalTokens()),
                        }),
                      ],
                    }),
                    h(Show, {
                      get when() {
                        return state().cost > 0;
                      },
                      children: h("box", {
                        flexDirection: "row",
                        justifyContent: "space-between",
                        children: [
                          h("text", {
                            fg: context.theme.text.muted,
                            children: () =>
                              state().costMode === "estimated"
                                ? "$ est. cost"
                                : state().costMode === "mixed"
                                  ? "$ cost incl. est."
                                  : "$ cost",
                          }),
                          h("text", {
                            fg: () => costColor(),
                            children: () => fmtCost(state().cost),
                          }),
                        ],
                      }),
                    }),
                    h(Show, {
                      get when() {
                        return hasDetails();
                      },
                      children: [
                        h("box", { height: 1 }),
                        h("box", {
                          flexDirection: "row",
                          justifyContent: "space-between",
                          onMouseDown: toggleDetails,
                          children: h("text", {
                            fg: context.theme.text.base,
                            attributes: TextAttributes.BOLD,
                            children: () => (expanded() ? "▾ " : "▸ ") + "Session Summary",
                          }),
                        }),
                        h(Show, {
                          get when() {
                            return expanded();
                          },
                          children: h("box", {
                            gap: 0,
                            children: [
                              h(Show, {
                                get when() {
                                  return d().toolCalls > 0;
                                },
                                children: h(UsageRow, {
                                  label: "▣ tools",
                                  get value() {
                                    return (
                                      d().toolCalls + (d().toolFailed > 0 ? " · " + d().toolFailed + " failed" : "")
                                    );
                                  },
                                  labelColor: context.theme.text.muted,
                                  get valueColor() {
                                    return d().toolFailed > 0
                                      ? context.theme.text.feedback.warning.base
                                      : context.theme.text.base;
                                  },
                                }),
                              }),
                              h(Show, {
                                get when() {
                                  return d().files > 0;
                                },
                                children: h(UsageRow, {
                                  label: "≡ files",
                                  get value() {
                                    return fmt(d().files);
                                  },
                                  labelColor: context.theme.text.muted,
                                  valueColor: context.theme.text.base,
                                }),
                              }),
                              h(Show, {
                                get when() {
                                  return d().subagents > 0;
                                },
                                children: h(UsageRow, {
                                  label: "└ subagents",
                                  get value() {
                                    return (
                                      d().subagents + (d().subagentTokens > 0 ? " · " + fmt(d().subagentTokens) : "")
                                    );
                                  },
                                  labelColor: context.theme.text.muted,
                                  valueColor: context.theme.text.base,
                                }),
                              }),
                              h(Show, {
                                get when() {
                                  return d().models > 1;
                                },
                                children: h(UsageRow, {
                                  label: "◆ models",
                                  get value() {
                                    return d().models + " · " + clip(d().topModel, MAX_MODEL_LABEL) + " " + d().topShare + "%";
                                  },
                                  labelColor: context.theme.text.muted,
                                  valueColor: context.theme.text.base,
                                }),
                              }),
                              h(Show, {
                                get when() {
                                  return d().savings > 0;
                                },
                                children: h(UsageRow, {
                                  label: "≈ saved",
                                  get value() {
                                    return fmtCost(d().savings);
                                  },
                                  labelColor: context.theme.text.muted,
                                  valueColor: context.theme.text.feedback.info.base,
                                }),
                              }),
                              h(Show, {
                                get when() {
                                  return issues().length > 0;
                                },
                                children: h(UsageRow, {
                                  label: "× issues",
                                  get value() {
                                    return issues();
                                  },
                                  labelColor: context.theme.text.muted,
                                  get valueColor() {
                                    return d().errored > 0
                                      ? context.theme.text.feedback.error.base
                                      : context.theme.text.feedback.warning.base;
                                  },
                                }),
                              }),
                              h(Show, {
                                get when() {
                                  return d().ageMs > 0;
                                },
                                children: h(UsageRow, {
                                  label: "↺ initiated",
                                  get value() {
                                    return fmtDuration(d().ageMs);
                                  },
                                  labelColor: context.theme.text.muted,
                                  valueColor: context.theme.text.base,
                                }),
                              }),
                              h(Show, {
                                get when() {
                                  return d().busyMs > 0;
                                },
                                children: h(UsageRow, {
                                  label: "→ busy",
                                  get value() {
                                    return (
                                      fmtDuration(d().busyMs) +
                                      (d().avgStepMs > 0 ? " · " + fmtDuration(d().avgStepMs) + "/step" : "")
                                    );
                                  },
                                  labelColor: context.theme.text.muted,
                                  valueColor: context.theme.text.base,
                                }),
                              }),
                            ],
                          }),
                        }),
                        h("box", {
                          flexDirection: "row",
                          onMouseDown: () => openPage(props.sessionID),
                          children: h("text", { fg: context.theme.text.muted, children: OPEN_LINK_LABEL }),
                        }),
                      ],
                    }),
                  ],
                }),
              }),
            ],
          }),
        });
      },
    });

    let stopPage = () => {};
    try {
      stopPage = context.ui.router.register({
        name: DETAILS_PAGE,
        render: (input) => {
          const sessionID = typeof input.data?.sessionID === "string" ? input.data.sessionID : lastSessionID;
          return h(DetailsPage, {
            context,
            state,
            sessionID,
            onBack: closePage,
            onActive: setPageOpen,
          });
        },
      });
    } catch {
      // Another instance of this plugin already owns the route name. Its page reads the return
      // target from the route data, so opening the page still lands back on the right session.
    }

    const stopTpsSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const sessionID = input.sessionID;
        if (!sessionID) return null;
        return h("text", {
          fg: context.theme.text.muted,
          children: () => tpsStatusText(sessionID),
        });
      },
    });

    context.keymap.layer(() => ({
      commands: [
        {
          id: TOGGLE_COMMAND,
          title: "Toggle session usage details",
          description: "Show or hide the extra session metrics in the token summary panel",
          group: "session",
          bind: false,
          palette: true,
          slash: { name: "usage" },
          run: toggleDetails,
        },
        {
          id: PAGE_COMMAND,
          title: "Open session details page",
          description: "Open the full session breakdown in the main panel",
          group: "session",
          bind: false,
          palette: true,
          run: () => openPage(lastSessionID),
        },
      ],
    }));

    context.keymap.layer(() => ({
      // Disabled unless the page is open, so the plugin never holds an escape binding the rest of
      // the TUI is waiting for. Inline (no id) so the host registers `bind` straight onto the keymap.
      enabled: () => pageOpen(),
      commands: [
        {
          bind: "escape,ctrl+c",
          title: "Close session details",
          description: "Return to the session the details page was opened from",
          group: "session",
          run: closePage,
        },
      ],
    }));

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      clearInterval(tpsTimer);
      stopUsageUpdate();
      stopExecution();
      stopSessionCreated();
      stopSessionDeleted();
      for (const stop of tpsStops) stop();
      stopPage();
      stopSlot();
      stopTpsSlot();
    };
  },
});
