# Using it

## The panel

```
Session Token Summary                              ↻ 12 turns
↑ in                                                1,204,331
↓ out                                                 398,664
▤ cache write                                       4,120,000
▤ cache read                                       48,910,338
ø cache hit rate                                        97.6%
✦ think                                                51,887
─────────────────────────────────────────────────────────────
Σ total                                            63,942,200
$ cost                                                 $14.21

▸ Session Summary
```

| Row | Meaning |
| --- | --- |
| `↻ N turns` | Assistant turns across the session and its subagents |
| `↑ in` | Prompt tokens sent |
| `↓ out` | Completion tokens received |
| `▤ cache write` | Tokens written to the provider's prompt cache |
| `▤ cache read` | Tokens served from the provider's prompt cache |
| `ø cache hit rate` | Share of prompt tokens that came from cache: `cache read ÷ (in + cache read + cache write)` |
| `✦ think` | Reasoning tokens. Only shown when the session used a thinking model |
| `Σ total` | Sum of all of the above |
| `$ cost` | Cost reported by the provider, summed over the whole session family |
| `$ est. cost` | Nothing was reported; the figure is estimated from catalog prices |
| `$ cost incl. est.` | Some steps were reported, the rest estimated, combined into one total |

Estimated costs are what the same tokens *would* cost at published API rates. If you are
on a quota or subscription plan you are not necessarily charged that amount.

## The `Session Summary` block

Below the cost line there is a second block, collapsed by default. Open it by clicking
**`▸ Session Summary`**, by running `/usage`, or by running **Toggle session usage
details** in the command palette.

```
▾ Session Summary
▣ tools                                         87 · 3 failed
≡ files                                                    12
└ subagents                                          1 · 1.2M
◆ models                              2 · claude-opus-4-6 78%
≈ saved                                                 $6.10
× issues                              1 truncated · 2 retried
↺ initiated                                             1d02h
→ busy                                         12m · 17s/step
⤺ open session details
```

| Row | Meaning |
| --- | --- |
| `▣ tools` | Tool calls, with the failed ones called out |
| `≡ files` | Distinct files the session touched |
| `└ subagents` | How many subagents ran, and how many tokens they used |
| `◆ models` | How many models the session used, and the largest share. Only shown when more than one model was involved |
| `≈ saved` | What the cache reads would have cost uncached, at catalog prices |
| `× issues` | Steps that were truncated, errored, or retried |
| `↺ initiated` | Wall-clock age of the session, so it keeps growing while the session is idle |
| `→ busy` | How long agents were actually working, plus the average per step. Concurrent subagent work is counted once, not summed |

Rows appear only when there is something to show, and the whole block is omitted while
every value is zero or unavailable. `≈ saved` needs catalog pricing, `→ busy` needs
completed step timestamps, and `≡ files` needs file snapshots from the messages. Whether
the block is open is one setting shared by every session in the running TUI, and it
resets when the TUI restarts.

## The session details page

Click **`⤺ open session details`** at the bottom of the block, or run **Open session
details page** in the command palette. There is deliberately no slash command for it. The
main panel is replaced by the full breakdown for that session:

```
 Session Details                                                    ↻ 112 turns
 ses_ecs82d3a8ffe4Imi5BQg02CdU4                                        esc back
 C:\work\esuyo-opencode-session · fork of ses_9a4c7d2b1e · interrupted
 ──────────────────────────────────────────────────────────────────────────────
 Tokens
 ↑ in                                                                    626.3K
 ↓ out                                                                   315.2K
 ✦ think                                                                  51.9K
 ▤ cache read                                                             62.3M
 ▤ cache write                                                             1.2M
 ø cache hit rate                                                         96.4%
 Σ total                                                                  64.5M

 Cost
 $ cost                                                                  $14.21
 ≈ saved                                                                  $6.10

 Activity
 ▣ tools                                                560 · 112 failed · 2h14
   edit                                                               112 · 41m
   grep                                                                112 · 3m
   read                                                                112 · 2m
   shell                                                112 · 112 failed · 1h04
   write                                                              112 · 22m
 ≡ files                                                                      1
 └ subagents                                                1 · 1.2M · 2 levels
 × issues                                                             1 retried
 × last error                                             429 too many requests
 ↻ retries                                        3× max · 529 overloaded_error

 Agents
   build                            476 steps · 58.1M · 1h40 · $12.10 · ø 96.4%
   explore                              84 steps · 6.4M · 12m · $2.11 · ø 91.2%

 Models
   claude-3-7-sonnet-thinking                                   84 steps · 9.5M
   qwen3.8-flash-next-iq3_s                             28 steps · 3.2M · $4.10

 Subagents
   explore the auth module              explore · succeeded · 4m · 1.2M · $0.84

 Timing
 ↺ initiated                                                               2h58
 → busy                                                          1h52 · 1m/step
 → slowest                                                        1m12s · build
```

Leave it with `esc`, `ctrl+c`, or by clicking `esc back`. You land back where you came
from — the same session, never a new one. The page is a fixed 78 columns wide with values
right-aligned, so numbers line up on their last digit and long model IDs stay readable on
a wide terminal. Each breakdown is capped at eight rows with a `+N more` line, and a
model row shows a cost only when the API reported one for those steps.

The line under the session id tells you where the session ran, whether it was forked, and
how it ended. Long paths give way first, because the fork and the outcome are the parts
worth reading.

Some rows need a word of explanation:

- **`Agents`** splits the session by the agent that ran each step, and the last two figures
  are what that agent cost and its own cache hit rate. Because subagents run at the same
  time, per-agent busy time can add up to more than the session's `→ busy` total — that is
  expected, and it is why the section shows absolute time rather than a share.
- **`Subagents`** shows each child session's agent, how it ended, and how long it ran. The
  time is the child's wall clock from creation to its last update, not its working time.
- **Tool durations** are how long each tool actually ran, counted once when tools overlap.
  They appear only when the server reports tool timings, so a tool row can legitimately
  show just its call count.
- **`↻ retries`** is the highest attempt any step reached, plus the most recent reason a
  step was retried. `× issues` counts them; this row explains them.
- **`× last error`** is the most recent provider error in the session family, with its
  status when the provider sent one. Long messages are clipped to the value column.

## The throughput footer

```
TPS 62.4 | AVG 58.1 | TTFT 0.9s | GAP 12.3s
```

| Metric | Meaning |
| --- | --- |
| `TPS` | Live tokens/sec over the last 5s streaming window. Holds the last observed rate while idle. |
| `AVG` | Session-average tokens/sec across completed model steps, on wall-clock step time. Thinking, queueing and tool phases count, so it reads lower than live TPS on reasoning-heavy sessions. |
| `TTFT` | Session-average time from request start to first token. |
| `GAP` | Time since the previous step finished — model step or tool phase — when this step started, including user think-time. `-` until the second step starts. |

GAP is measured at every step start against the previous step's end, so tool
execution phases count as responses: a slow tool, a slow approval, or idle
queueing shows up as gap on the next step rather than hiding inside one number
that spans the whole tool loop. `AVG` and `TTFT` are measured per model step. The line
is contributed to the `prompt.footer.status` slot, so it shows whenever a session is
open. If you also installed `@esuyo/esuyo-opencode-tks`, uninstall it first so both
plugins do not register the same slot.

Each completed model step appends one JSON object per line (JSONL, numeric metadata
only — no prompt or response text) to `~/.local/share/opencode/esuyo-opencode-tks.log`.
Override with `ESUYO_TPS_LOG`, disable with `ESUYO_TPS_LOG=/dev/null`. Log writing is
best-effort and never crashes the TUI. The log path and schema match
`@esuyo/esuyo-opencode-tks` v1, so existing log analysis keeps working.
