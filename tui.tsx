/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode-ai/plugin/tui";
import { TextAttributes, type RGBA } from "@opentui/core";
import { Show, createSignal } from "solid-js";

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

function normalizedModelID(id: string): string {
  return (id.split("/").pop() || id).toLowerCase().replace(/[^a-z0-9]/g, "");
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
        await context.data.session.sync(sessionID);
        const family = context.data.session.family(sessionID);
        if (disposed || currentLoadID !== loadID) return;

        knownSessionIDs = new Set(family);
        const totals: UsageState = { ...EMPTY, status: "ready" };
        const assistantMessages = [] as Array<Awaited<ReturnType<typeof context.client.message.list>>["data"][number] & { type: "assistant" }>;

        for (const id of family) {
          let cursor: string | undefined;
          do {
            const page = await context.client.message.list({
              sessionID: id,
              limit: 100,
              ...(cursor ? { cursor } : { order: "desc" }),
            });
            assistantMessages.push(...page.data.filter((message) => message.type === "assistant"));
            cursor = page.cursor.next ?? undefined;
          } while (cursor);
        }
        if (disposed || currentLoadID !== loadID) return;

        for (const id of family) {
          const session = context.data.session.get(id);
          if (session) {
            totals.input += session.tokens.input;
            totals.output += session.tokens.output;
            totals.reasoning += session.tokens.reasoning;
            totals.cacheRead += session.tokens.cache.read;
            totals.cacheWrite += session.tokens.cache.write;
            totals.cost += session.cost;
          }

        }

        totals.turns = assistantMessages.length;

        try {
          await context.data.location.model.sync(context.location);
          const models = context.data.location.model.list(context.location) ?? [];
          const estimatedCost = assistantMessages.reduce((total, message) => {
            if (message.cost !== 0 || !message.tokens) return total;
            const model = models.find(
              (candidate) =>
                candidate.providerID === message.model.providerID &&
                (candidate.modelID === message.model.id || candidate.id === message.model.id) &&
                candidate.cost.length > 0,
            ) ?? models.find(
              (candidate) =>
                candidate.cost.length > 0 &&
                (normalizedModelID(candidate.modelID) === normalizedModelID(message.model.id) ||
                  normalizedModelID(candidate.id) === normalizedModelID(message.model.id)),
            );
            if (!model) return total;

            const contextTokens =
              message.tokens.input + message.tokens.cache.read + message.tokens.cache.write;
            const cost = model.cost
              .filter((entry) => entry.tier && contextTokens > entry.tier.size)
              .sort((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0] ??
              model.cost.find((entry) => !entry.tier);
            if (!cost) return total;

            return total +
              (message.tokens.input * cost.input +
                (message.tokens.output + message.tokens.reasoning) * cost.output +
                message.tokens.cache.read * cost.cache.read +
                message.tokens.cache.write * cost.cache.write) /
                1_000_000;
          }, 0);

          if (estimatedCost > 0) {
            totals.cost += estimatedCost;
            totals.costMode = totals.cost > estimatedCost ? "mixed" : "estimated";
          }
        } catch {
          // Pricing is optional; session totals remain available when it cannot load.
        }

        setState(totals);
      } catch (error) {
        if (disposed || currentLoadID !== loadID) return;
        setState({
          ...EMPTY,
          status: "error",
          error: errorMessage(error),
        });
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
    const stopSessionSelected = context.data.on("tui.session.select", (event) => {
      lastSessionID = event.data.sessionID;
      knownSessionIDs = new Set([lastSessionID]);
      setState({ ...EMPTY });
      void refresh(lastSessionID);
    });

    const stopSlot = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => {
        if (sessionID !== lastSessionID) {
          lastSessionID = sessionID;
          knownSessionIDs = new Set([sessionID]);
          setState({ ...EMPTY });
          void refresh(sessionID);
        }

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
          if (state().cost < 5) return context.theme.text.feedback.info.default;
          if (state().cost < 25) return context.theme.text.feedback.warning.default;
          return context.theme.text.feedback.error.default;
        };

        return (
          <Show when={state().status !== "ready" || state().turns > 0 || totalTokens() > 0 || state().cost > 0}>
            <box gap={0}>
              <box flexDirection="row" justifyContent="space-between">
                <text fg={context.theme.text.default} attributes={TextAttributes.BOLD}>Session Token Summary</text>
                <text fg={context.theme.text.subdued}>{"↻ " + state().turns + " turn" + (state().turns === 1 ? "" : "s")}</text>
              </box>
              <Show when={state().status === "loading"}>
                <text fg={context.theme.text.subdued}>Loading…</text>
              </Show>
              <Show when={state().status === "error"}>
                <text fg={context.theme.text.feedback.error.default}>{state().error || "Unknown error"}</text>
              </Show>
              <Show when={state().status === "ready"}>
                <box gap={0}>
                  <UsageRow label="↑ in" value={fmt(state().input)} labelColor={context.theme.text.subdued} valueColor={context.theme.text.default} />
                  <UsageRow label="↓ out" value={fmt(state().output)} labelColor={context.theme.text.subdued} valueColor={context.theme.text.default} />
                  <UsageRow label="▤ cache write" value={fmt(state().cacheWrite)} labelColor={context.theme.text.subdued} valueColor={context.theme.text.default} />
                  <UsageRow label="▤ cache read" value={fmt(state().cacheRead)} labelColor={context.theme.text.subdued} valueColor={context.theme.text.default} />
                  <UsageRow label="ø cache hit ratio" value={cacheRatio()} labelColor={context.theme.text.subdued} valueColor={context.theme.text.default} />
                  <Show when={state().reasoning > 0}>
                    <UsageRow label="✦ think" value={fmt(state().reasoning)} labelColor={context.theme.text.subdued} valueColor={context.theme.text.default} />
                  </Show>
                  <box height={1} border={["top"]} borderColor={context.theme.border.default} />
                  <box flexDirection="row" justifyContent="space-between">
                    <text fg={context.theme.text.subdued}>Σ total</text>
                    <text fg={context.theme.text.feedback.info.default}>{fmt(totalTokens())}</text>
                  </box>
                  <Show when={state().cost > 0}>
                    <box flexDirection="row" justifyContent="space-between">
                      <text fg={context.theme.text.subdued}>
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
      stopSessionSelected();
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
