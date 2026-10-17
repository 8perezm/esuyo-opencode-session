/** @jsxImportSource @opentui/solid */

import type { Context } from "@opencode/plugin/tui/context";
import { TextAttributes, type RGBA } from "@opentui/core";
import { For, Show, onCleanup, onMount } from "solid-js";
import { clip, fmt, fmtCost, fmtDuration, fmtRate } from "./format";
import type { UsageState } from "./tui";

export function UsageRow(props: { label: string; value: string; labelColor: RGBA; valueColor: RGBA }) {
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

export function DetailsPage(props: {
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
      {/* Header lives inside the scroll area so it shares the scroll container's
        hit-testing with the content below; a fixed header above a nested scroll
        region misresolves clicks once the region arms. */}
      <scrollbox flexGrow={1}>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.base} attributes={TextAttributes.BOLD}>
            Session Details
          </text>
          <text fg={theme.text.muted}>{"↻ " + usage().turns + " turn" + (usage().turns === 1 ? "" : "s")}</text>
        </box>
        <box flexDirection="row" justifyContent="space-between">
          <text fg={theme.text.muted}>{clip(props.sessionID, 40)}</text>
          <text fg={theme.text.muted} onMouseDown={() => props.onBack()}>
            esc back
          </text>
        </box>
        <Show when={identity() !== ""}>
          <text fg={theme.text.muted}>{clip(identity(), PAGE_CONTENT_WIDTH)}</text>
        </Show>
        <box height={1} border={["bottom"]} borderColor={theme.border.base} />
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

            <Show when={usage().cost > 0 || d().savings > 0}>
              <box height={1} />
              <SectionHeader title="Cost" fg={theme.text.base} />
              <Show when={usage().cost > 0}>
                <PageRow label={costLabel()} value={fmtCost(usage().cost)} labelColor={theme.text.muted} valueColor={theme.text.base} />
              </Show>
              <Show when={d().savings > 0}>
                <PageRow label="≈ saved" value={fmtCost(d().savings)} labelColor={theme.text.muted} valueColor={theme.text.feedback.info.base} />
              </Show>
            </Show>

            <Show
              when={
                d().toolCalls > 0 ||
                d().files > 0 ||
                d().subagents > 0 ||
                issues() !== "" ||
                d().lastError !== "" ||
                d().retried > 0
              }
            >
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

            <Show when={d().ageMs > 0 || d().busyMs > 0 || d().slowestMs > 0}>
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
            </Show>
          </box>
        </Show>
      </scrollbox>
    </box>
  );
}
