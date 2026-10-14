/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import type { Context, Destination } from "@opencode/plugin/tui/context";
import { TextAttributes, type RGBA } from "@opentui/core";
import type { ModelInfo } from "@opencode/client";
import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import {
  combineCosts,
  computeDetails,
  EMPTY_DETAILS,
  fetchAssistantMessages,
  fetchDescendants,
  sumSessions,
  type SessionDetails,
} from "./usage";

const id = "opencode-session-tokens-sidebar";
const REFRESH_DELAY_MS = 200;
const TOGGLE_COMMAND = "session.usage.details";
const MAX_MODEL_LABEL = 18;
const DETAILS_PAGE = "session-usage-details";
const PAGE_COMMAND = "session.usage.page";
const OPEN_LINK_LABEL = "⤺ open session details";

interface UsageState {
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

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "K";
  return String(Math.trunc(n));
}

function fmtCost(c: number): string {
  if (c > 0 && c < 0.01) return "<$0.01";
  return "$" + c.toFixed(2);
}

function fmtDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return seconds + "s";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + "m";
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + "h" + String(minutes % 60).padStart(2, "0");
  return Math.floor(hours / 24) + "d" + String(hours % 24).padStart(2, "0") + "h";
}

function fmtRate(percent: number): string {
  return percent.toFixed(1) + "%";
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, Math.max(0, max - 1)) + "…";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "Failed to load session usage";
}

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

        return (
          <Show when={state().status !== "ready" || state().turns > 0 || totalTokens() > 0 || state().cost > 0}>
            <box gap={0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>Session Token Summary</text>
                <text fg={context.theme.text.muted}>{"↻ " + state().turns + " turn" + (state().turns === 1 ? "" : "s")}</text>
              </box>
              <Show when={state().status === "loading"}>
                <text fg={context.theme.text.muted}>Loading…</text>
              </Show>
              <Show when={state().status === "error"}>
                <text fg={context.theme.text.feedback.error.base}>{state().error || "Unknown error"}</text>
              </Show>
              <Show when={state().status === "ready"}>
                <box gap={0}>
                  <UsageRow label="↑ in" value={fmt(state().input)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                  <UsageRow label="↓ out" value={fmt(state().output)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                  <UsageRow label="▤ cache write" value={fmt(state().cacheWrite)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                  <UsageRow label="▤ cache read" value={fmt(state().cacheRead)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                  <UsageRow label="ø cache hit rate" value={cacheHitRate()} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                  <Show when={state().reasoning > 0}>
                    <UsageRow label="✦ think" value={fmt(state().reasoning)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                  </Show>
                  <box height={1} border={["top"]} borderColor={context.theme.border.base} />
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={context.theme.text.muted}>Σ total</text>
                    <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>{fmt(totalTokens())}</text>
                  </box>
                  <Show when={state().cost > 0}>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={context.theme.text.muted}>
                        {state().costMode === "estimated"
                          ? "$ est. cost"
                          : state().costMode === "mixed"
                            ? "$ cost incl. est."
                            : "$ cost"}
                      </text>
                      <text fg={costColor()}>{fmtCost(state().cost)}</text>
                    </box>
                  </Show>
                  <Show when={hasDetails()}>
                    <box height={1} />
                    <box flexDirection="row" justifyContent="space-between" onMouseDown={toggleDetails}>
                      <text fg={context.theme.text.base} attributes={TextAttributes.BOLD}>
                        {(expanded() ? "▾ " : "▸ ") + "Session Summary"}
                      </text>
                    </box>
                    <Show when={expanded()}>
                      <box gap={0}>
                        <Show when={d().toolCalls > 0}>
                          <UsageRow
                            label="▣ tools"
                            value={d().toolCalls + (d().toolFailed > 0 ? " · " + d().toolFailed + " failed" : "")}
                            labelColor={context.theme.text.muted}
                            valueColor={d().toolFailed > 0 ? context.theme.text.feedback.warning.base : context.theme.text.base}
                          />
                        </Show>
                        <Show when={d().files > 0}>
                          <UsageRow label="≡ files" value={fmt(d().files)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                        </Show>
                        <Show when={d().subagents > 0}>
                          <UsageRow
                            label="└ subagents"
                            value={d().subagents + (d().subagentTokens > 0 ? " · " + fmt(d().subagentTokens) : "")}
                            labelColor={context.theme.text.muted}
                            valueColor={context.theme.text.base}
                          />
                        </Show>
                        <Show when={d().models > 1}>
                          <UsageRow
                            label="◆ models"
                            value={d().models + " · " + clip(d().topModel, MAX_MODEL_LABEL) + " " + d().topShare + "%"}
                            labelColor={context.theme.text.muted}
                            valueColor={context.theme.text.base}
                          />
                        </Show>
                        <Show when={d().savings > 0}>
                          <UsageRow label="≈ saved" value={fmtCost(d().savings)} labelColor={context.theme.text.muted} valueColor={context.theme.text.feedback.info.base} />
                        </Show>
                        <Show when={issues().length > 0}>
                          <UsageRow
                            label="× issues"
                            value={issues()}
                            labelColor={context.theme.text.muted}
                            valueColor={d().errored > 0 ? context.theme.text.feedback.error.base : context.theme.text.feedback.warning.base}
                          />
                        </Show>
                        <Show when={d().ageMs > 0}>
                          <UsageRow label="↺ initiated" value={fmtDuration(d().ageMs)} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
                        </Show>
                        <Show when={d().busyMs > 0}>
                          <UsageRow
                            label="→ busy"
                            value={fmtDuration(d().busyMs) + (d().avgStepMs > 0 ? " · " + fmtDuration(d().avgStepMs) + "/step" : "")}
                            labelColor={context.theme.text.muted}
                            valueColor={context.theme.text.base}
                          />
                        </Show>
                      </box>
                    </Show>
                    <box flexDirection="row" onMouseDown={() => openPage(props.sessionID)}>
                      <text fg={context.theme.text.muted}>{OPEN_LINK_LABEL}</text>
                    </box>
                  </Show>
                </box>
              </Show>
            </box>
          </Show>
        );
      },
    });

    let stopPage = () => {};
    try {
      stopPage = context.ui.router.register({
        name: DETAILS_PAGE,
        render: (input) => {
          const sessionID = typeof input.data?.sessionID === "string" ? input.data.sessionID : lastSessionID;
          return <DetailsPage context={context} state={state} sessionID={sessionID} onBack={closePage} onActive={setPageOpen} />;
        },
      });
    } catch {
      // Another instance of this plugin already owns the route name. Its page reads the return
      // target from the route data, so opening the page still lands back on the right session.
    }

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
      // Disabled unless the page is open, so the plugin never holds an escape binding the rest of the
      // TUI is waiting for. Inline (no id) so the host registers `bind` straight onto the keymap.
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
      stopUsageUpdate();
      stopExecution();
      stopSessionCreated();
      stopSessionDeleted();
      stopPage();
      stopSlot();
    };
  },
});

function UsageRow(props: { label: string; value: string; labelColor: RGBA; valueColor: RGBA }) {
  return (
    <box flexDirection="row" justifyContent="space-between">
      <text fg={props.labelColor}>{props.label}</text>
      <text fg={props.valueColor}>{props.value}</text>
    </box>
  );
}

function SectionHeader(props: { title: string; fg: RGBA }) {
  return (
    <text fg={props.fg} attributes={TextAttributes.BOLD}>
      {props.title}
    </text>
  );
}

const SPLIT_LIMIT = 8;
/** Split labels are clipped so `"  " + label` still fits inside the page's label column. */
const PAGE_LABEL_WIDTH = 31;
const PAGE_LABEL_COLUMN = 34;
const PAGE_VALUE_COLUMN = 44;
const PAGE_CONTENT_WIDTH = PAGE_LABEL_COLUMN + PAGE_VALUE_COLUMN;
/** Values are clipped to the value column so a long provider error cannot push the row wider. */
const PAGE_VALUE_WIDTH = PAGE_VALUE_COLUMN - 1;
/** Agent names on the `→ slowest` row are short; the full split below carries the real names. */
const MAX_AGENT_SUFFIX = 12;
/** The fork source id in the header is a reference, not something to read out in full. */
const MAX_FORK_ID = 20;

/** Page row: label column, then the value right-aligned in its own column. Right alignment keeps the
 *  numbers comparable down the page; the fixed columns keep the pair close enough to read across. */
function PageRow(props: { label: string; value: string; labelColor: RGBA; valueColor: RGBA }) {
  return (
    <box flexDirection="row">
      <box width={PAGE_LABEL_COLUMN} flexShrink={0}>
        <text fg={props.labelColor}>{props.label}</text>
      </box>
      <box flexDirection="row" width={PAGE_VALUE_COLUMN} flexShrink={0} justifyContent="flex-end">
        <text fg={props.valueColor}>{props.value}</text>
      </box>
    </box>
  );
}

function SplitRows(props: {
  entries: Array<{ label: string; value: string }>;
  labelColor: RGBA;
  valueColor: RGBA;
}) {
  return (
    <>
      <For each={props.entries.slice(0, SPLIT_LIMIT)}>
        {(entry) => (
          <PageRow
            label={"  " + entry.label}
            value={entry.value}
            labelColor={props.labelColor}
            valueColor={props.valueColor}
          />
        )}
      </For>
      <Show when={props.entries.length > SPLIT_LIMIT}>
        <text fg={props.labelColor}>{"  +" + (props.entries.length - SPLIT_LIMIT) + " more"}</text>
      </Show>
    </>
  );
}

function DetailsPage(props: {
  context: Context;
  state: () => UsageState;
  sessionID: string;
  onBack: () => void;
  onActive: (open: boolean) => void;
}) {
  const theme = props.context.theme;

  onMount(() => {
    props.onActive(true);
    onCleanup(() => props.onActive(false));
  });

  const usage = () => props.state();
  const d = () => usage().details;
  const totalTokens = () =>
    usage().input + usage().output + usage().reasoning + usage().cacheRead + usage().cacheWrite;
  const cacheHitRate = () => {
    const prompt = usage().input + usage().cacheRead + usage().cacheWrite;
    if (prompt === 0) return "—";
    return fmtRate((usage().cacheRead / prompt) * 100);
  };
  const costLabel = () =>
    usage().costMode === "estimated" ? "$ est. cost" : usage().costMode === "mixed" ? "$ cost incl. est." : "$ cost";
  const issues = () =>
    [
      d().truncated > 0 ? d().truncated + " truncated" : "",
      d().errored > 0 ? d().errored + " errored" : "",
      d().retried > 0 ? d().retried + " retried" : "",
    ]
      .filter(Boolean)
      .join(" · ");
  const identity = () => {
    const fork = d().forkedFrom !== "" ? "fork of " + clip(d().forkedFrom, MAX_FORK_ID) : "";
    const facts = [fork, d().rootOutcome].filter(Boolean);
    if (d().directory === "") return facts.join(" · ");
    // The directory is the part that can give way: the fork reference and the outcome are short,
    // and they are the reason the line exists.
    const room = PAGE_CONTENT_WIDTH - facts.reduce((sum, fact) => sum + fact.length + 3, 0);
    return (room >= 8 ? [clip(d().directory, room), ...facts] : facts).join(" · ");
  };
  const retries = () =>
    [d().maxRetryAttempt > 1 ? d().maxRetryAttempt + "× max" : "", d().lastRetryError]
      .filter(Boolean)
      .join(" · ");
  const family = () =>
    [
      d().subagents + "",
      d().subagentTokens > 0 ? fmt(d().subagentTokens) : "",
      d().familyDepth > 1 ? d().familyDepth + " levels" : "",
    ]
      .filter(Boolean)
      .join(" · ");

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1} maxWidth={PAGE_CONTENT_WIDTH + 2}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base} attributes={TextAttributes.BOLD}>Session Details</text>
        <text fg={theme.text.muted}>{"↻ " + usage().turns + " turn" + (usage().turns === 1 ? "" : "s")}</text>
      </box>
      <box flexDirection="row" justifyContent="space-between" onMouseDown={() => props.onBack()}>
        <text fg={theme.text.muted}>{clip(props.sessionID, 40)}</text>
        <text fg={theme.text.muted}>esc back</text>
      </box>
      <Show when={identity() !== ""}>
        <text fg={theme.text.muted}>{clip(identity(), PAGE_CONTENT_WIDTH)}</text>
      </Show>
      <box height={1} border={["bottom"]} borderColor={theme.border.base} />
      <scrollbox flexGrow={1}>
        <Show when={usage().status === "loading"}>
          <text fg={theme.text.muted}>Loading…</text>
        </Show>
        <Show when={usage().status === "error"}>
          <text fg={theme.text.feedback.error.base}>{usage().error || "Unknown error"}</text>
        </Show>
        <Show when={usage().status === "ready"}>
          <box gap={0}>
            <SectionHeader title="Tokens" fg={theme.text.base} />
            <PageRow label="↑ in" value={fmt(usage().input)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            <PageRow label="↓ out" value={fmt(usage().output)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            <Show when={usage().reasoning > 0}>
              <PageRow label="✦ think" value={fmt(usage().reasoning)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            </Show>
            <PageRow label="▤ cache read" value={fmt(usage().cacheRead)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            <PageRow label="▤ cache write" value={fmt(usage().cacheWrite)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            <PageRow label="ø cache hit rate" value={cacheHitRate()} labelColor={theme.text.muted} valueColor={theme.text.base} />
            <PageRow label="Σ total" value={fmt(totalTokens())} labelColor={theme.text.muted} valueColor={theme.text.base} />

            <box height={1} />
            <SectionHeader title="Cost" fg={theme.text.base} />
            <Show when={usage().cost > 0}>
              <PageRow label={costLabel()} value={fmtCost(usage().cost)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            </Show>
            <Show when={d().savings > 0}>
              <PageRow label="≈ saved" value={fmtCost(d().savings)} labelColor={theme.text.muted} valueColor={theme.text.feedback.info.base} />
            </Show>

            <box height={1} />
            <SectionHeader title="Activity" fg={theme.text.base} />
            <Show when={d().toolCalls > 0}>
              <PageRow
                label="▣ tools"
                value={
                  d().toolCalls +
                  (d().toolFailed > 0 ? " · " + d().toolFailed + " failed" : "") +
                  (d().toolBusyMs > 0 ? " · " + fmtDuration(d().toolBusyMs) : "")
                }
                labelColor={theme.text.muted}
                valueColor={d().toolFailed > 0 ? theme.text.feedback.warning.base : theme.text.base}
              />
            </Show>
            <Show when={d().toolSplit.length > 0}>
              <SplitRows
                entries={d().toolSplit.map((tool) => ({
                  label: tool.name,
                  value:
                    tool.calls +
                    (tool.failed > 0 ? " · " + tool.failed + " failed" : "") +
                    (tool.durationMs > 0 ? " · " + fmtDuration(tool.durationMs) : ""),
                }))}
                labelColor={theme.text.muted}
                valueColor={theme.text.base}
              />
            </Show>
            <Show when={d().files > 0}>
              <PageRow label="≡ files" value={fmt(d().files)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            </Show>
            <Show when={d().subagents > 0}>
              <PageRow
                label="└ subagents"
                value={family()}
                labelColor={theme.text.muted}
                valueColor={theme.text.base}
              />
            </Show>
            <Show when={issues() !== ""}>
              <PageRow
                label="× issues"
                value={issues()}
                labelColor={theme.text.muted}
                valueColor={d().errored > 0 ? theme.text.feedback.error.base : theme.text.feedback.warning.base}
              />
            </Show>
            <Show when={d().lastError !== ""}>
              <PageRow
                label="× last error"
                value={clip(d().lastError, PAGE_VALUE_WIDTH)}
                labelColor={theme.text.muted}
                valueColor={theme.text.feedback.error.base}
              />
            </Show>
            <Show when={d().retried > 0}>
              <PageRow
                label="↻ retries"
                value={clip(retries(), PAGE_VALUE_WIDTH)}
                labelColor={theme.text.muted}
                valueColor={theme.text.feedback.warning.base}
              />
            </Show>

            <Show when={d().agentSplit.length > 0}>
              <box height={1} />
              <SectionHeader title="Agents" fg={theme.text.base} />
              <SplitRows
                entries={d().agentSplit.map((agent) => ({
                  label: clip(agent.name, PAGE_LABEL_WIDTH),
                  value:
                    agent.steps +
                    " steps · " +
                    fmt(agent.tokens) +
                    (agent.busyMs > 0 ? " · " + fmtDuration(agent.busyMs) : "") +
                    (agent.cost > 0 ? " · " + fmtCost(agent.cost) : "") +
                    (agent.cacheHit !== null ? " · ø " + fmtRate(agent.cacheHit) : ""),
                }))}
                labelColor={theme.text.muted}
                valueColor={theme.text.base}
              />
            </Show>

            <Show when={d().modelSplit.length > 0}>
              <box height={1} />
              <SectionHeader title="Models" fg={theme.text.base} />
              <SplitRows
                entries={d().modelSplit.map((model) => ({
                  label: clip(model.id, PAGE_LABEL_WIDTH),
                  value:
                    model.steps +
                    " steps · " +
                    fmt(model.tokens) +
                    (model.cost > 0 ? " · " + fmtCost(model.cost) : ""),
                }))}
                labelColor={theme.text.muted}
                valueColor={theme.text.base}
              />
            </Show>

            <Show when={d().subagentList.length > 0}>
              <box height={1} />
              <SectionHeader title="Subagents" fg={theme.text.base} />
              <SplitRows
                entries={d().subagentList.map((subagent) => ({
                  label: clip(subagent.title || subagent.id, PAGE_LABEL_WIDTH),
                  value: clip(
                    [
                      subagent.agent,
                      subagent.outcome,
                      subagent.spanMs > 0 ? fmtDuration(subagent.spanMs) : "",
                      fmt(subagent.tokens),
                      subagent.cost > 0 ? fmtCost(subagent.cost) : "",
                    ]
                      .filter(Boolean)
                      .join(" · "),
                    PAGE_VALUE_WIDTH,
                  ),
                }))}
                labelColor={theme.text.muted}
                valueColor={theme.text.base}
              />
            </Show>

            <box height={1} />
            <SectionHeader title="Timing" fg={theme.text.base} />
            <Show when={d().ageMs > 0}>
              <PageRow label="↺ initiated" value={fmtDuration(d().ageMs)} labelColor={theme.text.muted} valueColor={theme.text.base} />
            </Show>
            <Show when={d().busyMs > 0}>
              <PageRow
                label="→ busy"
                value={fmtDuration(d().busyMs) + (d().avgStepMs > 0 ? " · " + fmtDuration(d().avgStepMs) + "/step" : "")}
                labelColor={theme.text.muted}
                valueColor={theme.text.base}
              />
            </Show>
            <Show when={d().slowestMs > 0}>
              <PageRow
                label="→ slowest"
                value={
                  fmtDuration(d().slowestMs) +
                  (d().slowestAgent ? " · " + clip(d().slowestAgent, MAX_AGENT_SUFFIX) : "")
                }
                labelColor={theme.text.muted}
                valueColor={theme.text.base}
              />
            </Show>
          </box>
        </Show>
      </scrollbox>
    </box>
  );
}
