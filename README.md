# Session Token Summary

A session-usage panel for the [OpenCode](https://opencode.ai) terminal. It sits in the
session sidebar and answers, at a glance, what this session has cost: tokens, money,
cache behaviour, and how much of the work was done by subagents. Everything it shows
covers the whole session family — the session you are looking at plus every subagent it
started.

It is a hard fork of
[opencode-plugin-session-token-summary](https://github.com/njbraun/opencode-plugin-session-token-summary)
by Nick Braun ([@njbraun](https://github.com/njbraun)). See
[Credit](#credit-and-license).

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

## What you get

**A token panel in the sidebar** — input, output, reasoning, cache write and cache read
tokens, the cache hit rate, a total, and the cost. Assistant turns are shown next to the
title.

**Cost you can trust** — when the provider reports a cost, it is shown as reported. When
it reports nothing (quota plans, subscription plans, Claude Pro, Copilot), the cost is
estimated from OpenCode's own model catalog at published API rates, and the label says so:
`$ cost`, `$ est. cost`, or `$ cost incl. est.` for a session that mixes both.

**An expandable `Session Summary` block** — tool calls and failures, files touched,
subagent split, model split, what the prompt cache saved you, truncated/errored/retried
steps, session age, and how long the agents were actually busy.

**A full session details page** — one click replaces the main panel with the complete
breakdown: tokens, cost, activity with how long each tool ran, per agent, per model and
per subagent, how deep the session family goes, the slowest step, the retries, and the
last provider error.

Nothing here costs an extra request. Every number is derived from the session and message
data the panel already reads, so expanding the block or opening the page is instant.

## Requirements

OpenCode 2 (`>=2.0.28`). This is a terminal plugin, so it is configured in `cli.json`,
not in `opencode.json`.

For OpenCode 1, use the original upstream plugin instead: this fork does not support the
V1 terminal API.

## Install

**From npm** — this fork is published as `@esuyo/esuyo-opencode-session`:

```sh
opencode plugin add @esuyo/esuyo-opencode-session
```

**From GitHub** — OpenCode also accepts a Git package specifier, which is how you run
changes that are not in a release yet:

```sh
opencode plugin add github:8perezm/esuyo-opencode-session
```

Pin a branch or tag if you want a fixed version, for example
`github:8perezm/esuyo-opencode-session#main`.

Do not install the unscoped `opencode-plugin-session-token-summary`: that is the
[upstream original](https://github.com/njbraun/opencode-plugin-session-token-summary),
which this project is a fork of. Having both installed renders two copies of the block.

**From a local checkout** — useful if you want to edit it or run an unreleased version:

```sh
git clone https://github.com/8perezm/esuyo-opencode-session.git
cd esuyo-opencode-session
npm ci
```

Then put the checkout **directory** in the `plugins` array of
`~/.config/opencode/cli.json`, alongside any plugins you already have:

```jsonc title="~/.config/opencode/cli.json"
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "/absolute/path/to/esuyo-opencode-session"
  ]
}
```

Use the directory, not `tui.tsx`: OpenCode 2 resolves the `tui` entrypoint from a
directory and skips direct-file TUI entries. Restart the TUI if the panel does not appear.

If the sidebar itself is hidden, that is an OpenCode setting, not a plugin one — see
`session.sidebar` in `cli.json`.

## Using it

### The panel

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

### The `Session Summary` block

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

### The session details page

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

## Notes

- The panel reads session totals and paginated assistant messages for the selected session
  and its nested descendants, with at most four requests in flight. If a background
  refresh fails, the last complete numbers stay on screen.
- It works against the connected server, including a remote one, and needs no API key of
  its own. It reads the same session data the TUI already has; it sends nothing anywhere.
- The host sidebar also shows a `$ spent` figure. That one covers the root session only,
  while `$ cost` here covers the whole session family and includes catalog estimates, so
  the two are expected to differ.
- This fork publishes to npm as `@esuyo/esuyo-opencode-session`. The unscoped
  `opencode-plugin-session-token-summary` is the upstream original: installing that name
  gets you the original panel, and installing it alongside this one renders two copies of
  the block.
- A section on the details page only appears when it has something to show. A session with
  no recorded cost has no `Cost` heading, and a session with no tool calls, files,
  subagents or issues has no `Activity` heading.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| No panel in the sidebar | Restart the TUI. Check the entry is in `cli.json` (not `opencode.json`) and points at the directory, not `tui.tsx`. Check `session.sidebar` in `cli.json`. |
| No `ø cache hit rate` row and no `Session Summary` block | You installed the unscoped npm name `opencode-plugin-session-token-summary`, which is the upstream original. Use `@esuyo/esuyo-opencode-session`, or point the entry at this repository. |
| A row is missing | Its data is not available for this session. `≡ files`, `≈ saved`, `→ busy` and the tool durations in particular depend on message snapshots, catalog pricing, completed step timestamps, and completed tool timestamps. |
| Cost looks wrong | Check the label. `$ est. cost` and `$ cost incl. est.` are catalog estimates, not billed amounts. |
| A symbol renders as a box | The rows use single-width symbols from the Latin-1 Supplement, Arrows, Box Drawing, Block Elements and Geometric Shapes ranges. A font without those glyphs will show tofu; the panel itself is unaffected. |

## Credit and license

This is a hard fork of
[opencode-plugin-session-token-summary](https://github.com/njbraun/opencode-plugin-session-token-summary)
by **Nick Braun** ([@njbraun](https://github.com/njbraun)), who wrote the sidebar panel,
the cost estimation against OpenCode's model catalog, and the subagent aggregation that
this project is built on. The original MIT license and his copyright notice are kept
untouched in [LICENSE](LICENSE).

What this fork adds on top of upstream `2.0.0`:

- the `ø cache hit rate` row
- the expandable `Session Summary` block, with per-tool, per-model and per-subagent
  breakdowns, session age, and busy time that counts concurrent subagent work once
- the session details page in the main panel, opened from a link or the command palette,
  with correct back-navigation and no extra requests
- the page's per-agent split, slowest step, provider errors and retry detail, per-tool
  timings, subagent outcomes, family depth, and the session identity line
- [docs](docs) recording which metrics were considered and why some were rejected

MIT, same as the original — see [LICENSE](LICENSE).
