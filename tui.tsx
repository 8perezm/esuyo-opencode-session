/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode/plugin/tui";
import { TextAttributes, type RGBA } from "@opentui/core";
import { Show, createEffect, createSignal } from "solid-js";
import { combineCosts, fetchAssistantMessages, fetchDescendants, sumSessions } from "./usage";

const id = "opencode-session-tokens-sidebar";
const REFRESH_DELAY_MS = 200;

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
        };

        try {
          if (assistantMessages.some((message) => message.cost === 0 && message.tokens)) {
            const models = await context.client.model.list({ location: context.location });
            const combined = combineCosts(totals.cost, assistantMessages, models.data);
            totals.cost = combined.cost;
            totals.costMode = combined.mode;
          }
        } catch {
          // Pricing is optional; session totals remain available when it cannot load.
        }

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
        const cacheRatio = () => {
          const usage = state();
          const base = usage.input + usage.cacheWrite;
          if (base === 0) return usage.cacheRead > 0 ? "∞" : "—";
          return `${(usage.cacheRead / base).toFixed(1)}×`;
        };
        const costColor = () => {
          if (state().cost < 5) return context.theme.text.feedback.info.base;
          if (state().cost < 25) return context.theme.text.feedback.warning.base;
          return context.theme.text.feedback.error.base;
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
                  <UsageRow label="ø cache hit ratio" value={cacheRatio()} labelColor={context.theme.text.muted} valueColor={context.theme.text.base} />
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
                </box>
              </Show>
            </box>
          </Show>
        );
      },
    });

    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      stopUsageUpdate();
      stopExecution();
      stopSessionCreated();
      stopSessionDeleted();
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
