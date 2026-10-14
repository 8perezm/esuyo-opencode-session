# OpenCode Session Token Summary

[![npm version](https://img.shields.io/npm/v/opencode-plugin-session-token-summary)](https://www.npmjs.com/package/opencode-plugin-session-token-summary)

An OpenCode TUI plugin that adds a compact session-usage panel to the sidebar.
It aggregates the root session and all nested subagent sessions.

![alt text](image.png)

## Features

- Compact OpenCode sidebar panel with live session updates
- Input, output, reasoning, cache read, cache write, and total token counts
- Cache hit rate (share of prompt tokens served from cache) and assistant turn count
- Usage aggregated across the root session and every nested subagent
- Reported API costs for metered providers
- API-equivalent cost estimates for quota and subscription-backed providers
- One combined cost total for sessions that mix metered and quota-backed models
- Clear labels distinguishing reported, estimated, and partially estimated costs
- V2 model-catalog pricing with context-tier support
- Expandable **Session Summary** block: tool calls and failures, files touched,
  subagent split, model split, estimated prompt-cache savings,
  truncated/errored/retried steps, session age, and agent busy time

## Session Summary block

The token panel itself is always fully rendered. Below the cost line the panel
adds a second block with its own expanding title, collapsed by default:

```
Session Token Summary                                   ↻ 12 turns
↑ in                                                     1,204,331
…
Σ total                                                  6,394,220
$ cost                                                     $14.21

▸ Session Summary
```

Expand it by clicking the **Session Summary** title, running `/usage`, or
running the **Toggle session usage details** command (`session.usage.details`)
from the command palette. Expanded:

```
▾ Session Summary
▣ tools                                          87 · 3 failed
≡ files                                                     12
└ subagents                                          1 · 1.2M
◆ models                             2 · claude-opus-4-6 78%
≈ saved                                                   $6.10
× issues                                      1 truncated · 2 retried
↺ initiated                                        1d02h
→ busy                                              12m · 17s/step
⤺ open session details
```

The block is omitted entirely while every value is zero or unavailable. Every
detail is derived from the session and message data the panel already fetches,
so expanding issues no additional requests and costs a single state flip.
Individual rows are hidden when their data is missing: `≈ saved` needs catalog
pricing, `→ busy` needs completed step timestamps, and `≡ files` needs message
snapshots. `↺ initiated` is wall-clock age since the session was created, so it
keeps growing while the session is idle. `→ busy` is the union of every step
interval across the session and its subagents, so concurrent subagent work is
counted once instead of summed. The toggle is per plugin instance and resets
when the TUI restarts.

Row glyphs stay inside the Arrows, Box Drawing, Block Elements, Geometric
Shapes and Math Operators ranges, the same ranges the token rows use. Emoji
code points such as `⚠` or `⏱` are left out on purpose: terminals draw them from
an emoji font, which is wider than one cell, ignores the theme colour, and makes
the row look misaligned next to the rest of the panel.

### Session details page

The link at the bottom of the block, or the **Open session details page** command
(`session.usage.page`) in the command palette, replaces the main panel with the
full breakdown for the session. There is deliberately no slash command for it.

```
 Session Details                                                    ↻ 112 turns
 ses_ecs82d3a8ffe4Imi5BQg02CdU4                                        esc back
 ──────────────────────────────────────────────────────────────────────────────
 Tokens
 ↑ in                                                                    626.3K
 ↓ out                                                                   315.2K
 ▤ cache read                                                             62.3M
 ▤ cache write                                                                0
 ø cache hit rate                                                         99.0%
 Σ total                                                                  63.2M

 Activity
 ▣ tools                                                       560 · 112 failed
   edit                                                                     112
   grep                                                                     112
   read                                                                     112
   shell                                                       112 · 112 failed
   write                                                                    112
 ≡ files                                                                      1

 Models
   claude-3-7-sonnet-thinking                                   84 steps · 9.5M
   qwen3.8-flash-next-iq3_s                                     28 steps · 3.2M

 Timing
 ↺ initiated                                                               2h58
 → busy                                                          1h52 · 1m/step
```

The page is 78 columns wide: a 34-column label column and a 44-column value column that is
right-aligned, so numbers line up on their last digit and long model IDs are not clipped. `esc`
or `ctrl+c`, or clicking `esc back`, returns to wherever you came from; the return target travels
with the route, and if it is missing the page goes back to the session it is showing rather than
opening a fresh one. The page renders the state the sidebar already fetched, so opening it issues
no requests — the per-model, per-tool and per-subagent breakdowns are derived in the same pass as
the sidebar numbers. Each breakdown is capped at eight rows with a `+N more` line, and a model row
shows a cost only when the API reported one for that step.

## Compatibility

| OpenCode version | Plugin version | Installation |
| --- | --- | --- |
| OpenCode V2 (`opencode`, `>=2.0.28 <3`) | `2.x` | Use the V2 instructions below. |
| OpenCode V1 | `0.4.1` | Install the pinned legacy package with the V1 instructions below. |

## OpenCode 2 Install

For a local checkout, run `npm ci`, then replace the existing package entry in
`~/.config/opencode/cli.json` with the checkout directory. Preserve other plugins and settings:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": [
    "/absolute/path/to/opencode-plugin-session-token-summary"
  ]
}
```

Use the directory, not `tui.tsx`: OpenCode V2 resolves the directory's `tui`
entrypoint and skips direct-file TUI entries. Restart the TUI if it does not reload.

After `2.0.0` is published, you can use `opencode-plugin-session-token-summary@^2`
instead of the local path. The published `0.4.x` package targets the legacy TUI
plugin API and cannot be used with OpenCode 2.

## OpenCode V1 Install

OpenCode V1 users must install the final legacy release, `0.4.1`:

1. Press `Ctrl+P` in OpenCode and choose **Install plugin**.
2. Press `Tab` to install globally.
3. Enter `opencode-plugin-session-token-summary@0.4.1`.

This creates an entry in `~/.config/opencode/tui.json`. Do not install an
unversioned package in V1 after `2.0.0` is published, because later releases
target OpenCode 2.

## Notes

The panel reads V2 session totals and paginated assistant messages for the
selected session and its nested descendants. It limits descendant requests to
four concurrent operations and keeps the last complete snapshot if a background
refresh fails. It works with the connected server, including remote servers,
and needs no separate API key.

Nonzero cost reported by OpenCode is shown as `$ cost`. For messages with an
explicit zero cost, the plugin uses OpenCode's model
catalog to calculate what the same tokens would cost at published API rates.
Fully estimated totals are shown as `$ est. cost`; totals that combine reported
and estimated amounts are shown as `$ cost incl. est.` Quota or subscription
users are not necessarily charged the estimated amount. If catalog pricing
cannot be matched, only the reported cost is shown.

## Development

```sh
npm install
npm run check
npm run pack:check
```

## License

[MIT](LICENSE)
