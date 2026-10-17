import type { Context } from "@opencode/plugin/tui/context";
import { TextAttributes, type RGBA } from "opentui:runtime-module:%40opentui%2Fcore";
import { For, Show, onCleanup, onMount } from "opentui:runtime-module:solid-js";
import { h } from "./jsx";
import { clip, fmt, fmtCost, fmtDuration, fmtRate } from "./format";
import type { UsageState } from "./tui";

export function UsageRow(props: { label: string; value: string; labelColor: RGBA; valueColor: RGBA }) {
  return h("box", {
    flexDirection: "row",
    justifyContent: "space-between",
    children: [
      h("text", { fg: () => props.labelColor, children: () => props.label }),
      h("text", { fg: () => props.valueColor, children: () => props.value }),
    ],
  });
}

function SectionHeader(props: { title: string; fg: RGBA }) {
  return h("text", {
    fg: () => props.fg,
    attributes: TextAttributes.BOLD,
    children: () => props.title,
  });
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
  return h("box", {
    flexDirection: "row",
    children: [
      h("box", {
        width: PAGE_LABEL_COLUMN,
        flexShrink: 0,
        children: h("text", { fg: () => props.labelColor, children: () => props.label }),
      }),
      h("box", {
        flexDirection: "row",
        width: PAGE_VALUE_COLUMN,
        flexShrink: 0,
        justifyContent: "flex-end",
        children: h("text", { fg: () => props.valueColor, children: () => props.value }),
      }),
    ],
  });
}

function SplitRows(props: {
  entries: Array<{ label: string; value: string }>;
  labelColor: RGBA;
  valueColor: RGBA;
}) {
  return [
    h(For, {
        get each() {
          return props.entries.slice(0, SPLIT_LIMIT);
        },
        children: (entry: { label: string; value: string }) =>
          h(PageRow, {
            get label() {
              return "  " + entry.label;
            },
            get value() {
              return entry.value;
            },
            get labelColor() {
              return props.labelColor;
            },
            get valueColor() {
              return props.valueColor;
            },
          }),
      }),
      h(Show, {
        get when() {
          return props.entries.length > SPLIT_LIMIT;
        },
        children: h("text", {
          fg: () => props.labelColor,
          children: () => "  +" + (props.entries.length - SPLIT_LIMIT) + " more",
        }),
      }),
    ];
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

  return h("box", {
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
    maxWidth: PAGE_CONTENT_WIDTH + 2,
    // Header lives inside the scroll area so it shares the scroll container's
    // hit-testing with the content below; a fixed header above a nested scroll
    // region misresolves clicks once the region arms.
    children: h("scrollbox", {
      flexGrow: 1,
      children: [
        h("box", {
          flexDirection: "row",
          justifyContent: "space-between",
          children: [
            h("text", {
              fg: theme.text.base,
              attributes: TextAttributes.BOLD,
              children: "Session Details",
            }),
            h("text", {
              fg: theme.text.muted,
              children: () => "↻ " + usage().turns + " turn" + (usage().turns === 1 ? "" : "s"),
            }),
          ],
        }),
        h("box", {
          flexDirection: "row",
          justifyContent: "space-between",
          children: [
            h("text", { fg: theme.text.muted, children: clip(props.sessionID, 40) }),
            h("text", {
              fg: theme.text.muted,
              onMouseDown: () => props.onBack(),
              children: "esc back",
            }),
          ],
        }),
        h(Show, {
          get when() {
            return identity() !== "";
          },
          children: h("text", {
            fg: theme.text.muted,
            children: () => clip(identity(), PAGE_CONTENT_WIDTH),
          }),
        }),
        h("box", { height: 1, border: ["bottom"], borderColor: theme.border.base }),
        h(Show, {
          get when() {
            return usage().status === "loading";
          },
          children: h("text", { fg: theme.text.muted, children: "Loading…" }),
        }),
        h(Show, {
          get when() {
            return usage().status === "error";
          },
          children: h("text", {
            fg: theme.text.feedback.error.base,
            children: () => usage().error || "Unknown error",
          }),
        }),
        h(Show, {
          get when() {
            return usage().status === "ready";
          },
          children: h("box", {
            gap: 0,
            children: [
              h(SectionHeader, { title: "Tokens", fg: theme.text.base }),
              h(PageRow, {
                label: "↑ in",
                get value() {
                  return fmt(usage().input);
                },
                labelColor: theme.text.muted,
                valueColor: theme.text.base,
              }),
              h(PageRow, {
                label: "↓ out",
                get value() {
                  return fmt(usage().output);
                },
                labelColor: theme.text.muted,
                valueColor: theme.text.base,
              }),
              h(Show, {
                get when() {
                  return usage().reasoning > 0;
                },
                children: h(PageRow, {
                  label: "✦ think",
                  get value() {
                    return fmt(usage().reasoning);
                  },
                  labelColor: theme.text.muted,
                  valueColor: theme.text.base,
                }),
              }),
              h(PageRow, {
                label: "▤ cache read",
                get value() {
                  return fmt(usage().cacheRead);
                },
                labelColor: theme.text.muted,
                valueColor: theme.text.base,
              }),
              h(PageRow, {
                label: "▤ cache write",
                get value() {
                  return fmt(usage().cacheWrite);
                },
                labelColor: theme.text.muted,
                valueColor: theme.text.base,
              }),
              h(PageRow, {
                label: "ø cache hit rate",
                get value() {
                  return cacheHitRate();
                },
                labelColor: theme.text.muted,
                valueColor: theme.text.base,
              }),
              h(PageRow, {
                label: "Σ total",
                get value() {
                  return fmt(totalTokens());
                },
                labelColor: theme.text.muted,
                valueColor: theme.text.base,
              }),
              h(Show, {
                get when() {
                  return usage().cost > 0 || d().savings > 0;
                },
                children: [
                  h("box", { height: 1 }),
                  h(SectionHeader, { title: "Cost", fg: theme.text.base }),
                  h(Show, {
                    get when() {
                      return usage().cost > 0;
                    },
                    children: h(PageRow, {
                      get label() {
                        return costLabel();
                      },
                      get value() {
                        return fmtCost(usage().cost);
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.base,
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().savings > 0;
                    },
                    children: h(PageRow, {
                      label: "≈ saved",
                      get value() {
                        return fmtCost(d().savings);
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.feedback.info.base,
                    }),
                  }),
                ],
              }),
              h(Show, {
                get when() {
                  return (
                    d().toolCalls > 0 ||
                    d().files > 0 ||
                    d().subagents > 0 ||
                    issues() !== "" ||
                    d().lastError !== "" ||
                    d().retried > 0
                  );
                },
                children: [
                  h("box", { height: 1 }),
                  h(SectionHeader, { title: "Activity", fg: theme.text.base }),
                  h(Show, {
                    get when() {
                      return d().toolCalls > 0;
                    },
                    children: h(PageRow, {
                      label: "▣ tools",
                      get value() {
                        return (
                          d().toolCalls +
                          (d().toolFailed > 0 ? " · " + d().toolFailed + " failed" : "") +
                          (d().toolBusyMs > 0 ? " · " + fmtDuration(d().toolBusyMs) : "")
                        );
                      },
                      labelColor: theme.text.muted,
                      get valueColor() {
                        return d().toolFailed > 0 ? theme.text.feedback.warning.base : theme.text.base;
                      },
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().toolSplit.length > 0;
                    },
                    children: h(SplitRows, {
                      get entries() {
                        return d().toolSplit.map((tool) => ({
                          label: tool.name,
                          value:
                            tool.calls +
                            (tool.failed > 0 ? " · " + tool.failed + " failed" : "") +
                            (tool.durationMs > 0 ? " · " + fmtDuration(tool.durationMs) : ""),
                        }));
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.base,
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().files > 0;
                    },
                    children: h(PageRow, {
                      label: "≡ files",
                      get value() {
                        return fmt(d().files);
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.base,
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().subagents > 0;
                    },
                    children: h(PageRow, {
                      label: "└ subagents",
                      get value() {
                        return family();
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.base,
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return issues() !== "";
                    },
                    children: h(PageRow, {
                      label: "× issues",
                      get value() {
                        return issues();
                      },
                      labelColor: theme.text.muted,
                      get valueColor() {
                        return d().errored > 0
                          ? theme.text.feedback.error.base
                          : theme.text.feedback.warning.base;
                      },
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().lastError !== "";
                    },
                    children: h(PageRow, {
                      label: "× last error",
                      get value() {
                        return clip(d().lastError, PAGE_VALUE_WIDTH);
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.feedback.error.base,
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().retried > 0;
                    },
                    children: h(PageRow, {
                      label: "↻ retries",
                      get value() {
                        return clip(retries(), PAGE_VALUE_WIDTH);
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.feedback.warning.base,
                    }),
                  }),
                ],
              }),
              h(Show, {
                get when() {
                  return d().agentSplit.length > 0;
                },
                children: [
                  h("box", { height: 1 }),
                  h(SectionHeader, { title: "Agents", fg: theme.text.base }),
                  h(SplitRows, {
                    get entries() {
                      return d().agentSplit.map((agent) => ({
                        label: clip(agent.name, PAGE_LABEL_WIDTH),
                        value:
                          agent.steps +
                          " steps · " +
                          fmt(agent.tokens) +
                          (agent.busyMs > 0 ? " · " + fmtDuration(agent.busyMs) : "") +
                          (agent.cost > 0 ? " · " + fmtCost(agent.cost) : "") +
                          (agent.cacheHit !== null ? " · ø " + fmtRate(agent.cacheHit) : ""),
                      }));
                    },
                    labelColor: theme.text.muted,
                    valueColor: theme.text.base,
                  }),
                ],
              }),
              h(Show, {
                get when() {
                  return d().modelSplit.length > 0;
                },
                children: [
                  h("box", { height: 1 }),
                  h(SectionHeader, { title: "Models", fg: theme.text.base }),
                  h(SplitRows, {
                    get entries() {
                      return d().modelSplit.map((model) => ({
                        label: clip(model.id, PAGE_LABEL_WIDTH),
                        value:
                          model.steps +
                          " steps · " +
                          fmt(model.tokens) +
                          (model.cost > 0 ? " · " + fmtCost(model.cost) : ""),
                      }));
                    },
                    labelColor: theme.text.muted,
                    valueColor: theme.text.base,
                  }),
                ],
              }),
              h(Show, {
                get when() {
                  return d().subagentList.length > 0;
                },
                children: [
                  h("box", { height: 1 }),
                  h(SectionHeader, { title: "Subagents", fg: theme.text.base }),
                  h(SplitRows, {
                    get entries() {
                      return d().subagentList.map((subagent) => ({
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
                      }));
                    },
                    labelColor: theme.text.muted,
                    valueColor: theme.text.base,
                  }),
                ],
              }),
              h(Show, {
                get when() {
                  return d().ageMs > 0 || d().busyMs > 0 || d().slowestMs > 0;
                },
                children: [
                  h("box", { height: 1 }),
                  h(SectionHeader, { title: "Timing", fg: theme.text.base }),
                  h(Show, {
                    get when() {
                      return d().ageMs > 0;
                    },
                    children: h(PageRow, {
                      label: "↺ initiated",
                      get value() {
                        return fmtDuration(d().ageMs);
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.base,
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().busyMs > 0;
                    },
                    children: h(PageRow, {
                      label: "→ busy",
                      get value() {
                        return (
                          fmtDuration(d().busyMs) +
                          (d().avgStepMs > 0 ? " · " + fmtDuration(d().avgStepMs) + "/step" : "")
                        );
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.base,
                    }),
                  }),
                  h(Show, {
                    get when() {
                      return d().slowestMs > 0;
                    },
                    children: h(PageRow, {
                      label: "→ slowest",
                      get value() {
                        return (
                          fmtDuration(d().slowestMs) +
                          (d().slowestAgent ? " · " + clip(d().slowestAgent, MAX_AGENT_SUFFIX) : "")
                        );
                      },
                      labelColor: theme.text.muted,
                      valueColor: theme.text.base,
                    }),
                  }),
                ],
              }),
            ],
          }),
        }),
      ],
    }),
  });
}
