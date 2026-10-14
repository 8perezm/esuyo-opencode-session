# Session Summary panel — candidate metrics inventory

Date: 2026-10-14
Plugin: `C:\SERVER\REPOS\Esuyo\esuyo-opencode-session` (fork of `njbraun/opencode-plugin-session-token-summary`, HEAD `9b18e01`, `2.0.0`)
Host: OpenCode `2.0.29`
Status: cache-hit-rate change + `Session Summary` expanding block implemented, **uncommitted**
Purpose: decision document. Every candidate is listed with its data source and cost so each can be accepted or rejected on its own merits.

Rule that governs everything here: **the expanded block must never issue a request.** Expanding is a state flip over data the panel already holds.

---

## 1. Current state

Collapsed:

```
Session Token Summary                                   ↻ 12 turns
↑ in                                                    1,204,331
↓ out                                                     182,554
▤ cache write                                              41,002
▤ cache read                                            4,870,113
ø cache hit rate                                            79.6%
✦ think                                                     96,220
──────────────────────────────────────────────────
Σ total                                                 6,394,220
$ cost                                                     $14.21

▸ Session Summary
```

Expanded (`▸` → `▾`):

```
▾ Session Summary
▣ tools                                          87 · 3 failed
≡ files                                                     12
└ subagents                                          1 · 1.2M
◆ models                             2 · claude-opus-4-6 78%
≈ saved                                                   $6.10
× issues                                    1 truncated · 2 retried
↺ initiated                                        1d02h
→ busy                                              12m · 17s/step
```

Toggle: click the `Session Summary` title, `/usage`, or palette command `session.usage.details` (registered with `bind: false`, so it claims no keybinding).

### Implemented rows and where each value comes from

| Row | Source | Extra request |
| --- | --- | --- |
| `▣ tools` | `SessionMessageAssistant.content[]` where `type === "tool"`; `state.status === "error"` → failed | no |
| `≡ files` | `SessionMessageAssistant.snapshot.files` (unique paths) | no |
| `└ subagents` | descendant `SessionInfo[]` already walked by `fetchDescendants`, summed `tokens` | no |
| `◆ models` | `message.model` per assistant message → distinct count, dominant model, share of steps | no |
| `≈ saved` | `cacheRead × (cost.input − cost.cache.read) / 1e6` using the catalog pricing already loaded for `$ est. cost` | no |
| `× issues` | `finish === "length"` / `finish === "error"` or `error` present / `retry` present | no |
| `↺ initiated` | `now − session.time.created` (wall-clock age; `now` is injectable for tests) | no |
| `→ busy` | Union of every `[message.time.created, message.time.completed]` interval across root and subagent steps; `· Ns/step` is the mean of the individual intervals | no |

Implementation: `computeDetails()` in `usage.ts` runs **once per refresh** and its result is stored in the state object, so the render path stays O(rows). Tests assert request counters are identical before and after expanding.

### Decided: split the old `⏱ span` into two honest rows (2026-10-14)

The first version showed `session.time.updated − session.time.created`, which mixed two ideas under one label: it is the **wall-clock age of the session**, not agent work, so it included every minute spent idle, waiting on you, or asleep, and a session resumed days later reported days.

- `→ busy` now reports only time an agent was running: the merged union of step intervals, so concurrent subagent work counts once.
- `↺ initiated` keeps the wall-clock age you asked for, measured from creation to now. It deliberately keeps growing while the session is idle — that is what "time since it started" means.
- Consequences of the split: a step that is running right now is **not** in `→ busy` until it completes (`completed` is absent), so busy time advances in step-sized jumps; steps missing either timestamp are skipped, so `→ busy` can be `0` and the row hides itself while `↺ initiated` still shows.

### Decided: every row glyph stays non-emoji (2026-10-14)

The first version used `⚙ ✎ ⤷ ◈ ⚠ ◷ ⏱`. In the live TUI those broke the panel's alignment:

- `⏱` (U+23F1) and `⚠` (U+26A0) are drawn from the terminal's **emoji font**. They are wider than one cell, so the label text after them starts a column late, and they are drawn in colour — the theme's `text.muted` grey is ignored, which is why those icons did not match the token rows.
- `◷` (U+25F7) is a thin geometric shape and reads visibly smaller than the surrounding glyphs.
- `⚙` (U+2699) and `✎` (U+270E) are text-presentation by default but still fall back to a second face in most terminals.

Replacements, all single-width, monochrome, and from ranges the token rows already prove work in the user's font (`↑ ↓ ▤ ø Σ ↻ ─`):

| Row | Was | Now | Range |
| --- | --- | --- | --- |
| tools | `⚙` | `▣` (U+25A3) | Geometric Shapes |
| files | `✎` | `≡` (U+2261) | Math Operators |
| subagents | `⤷` | `└` (U+2514) | Box Drawing |
| models | `◈` | `◆` (U+25C6) | Geometric Shapes |
| saved | `≈` | `≈` (U+2248) — kept, already safe | Math Operators |
| issues | `⚠` | `×` (U+00D7) | Latin-1, same family as `ø` |
| initiated | `◷` | `↺` (U+21BA) | Arrows, same block as `↻` |
| busy | `⏱` | `→` (U+2192) | Arrows |

Rule for the candidates below: pick from **Arrows (U+2190–21FF), Box Drawing (U+2500–257F), Block Elements, Geometric Shapes, Math Operators, Latin-1**. Avoid anything with `Emoji_Presentation=Yes` — that set includes `⏳` `⌛` `▶` `◀` `◻` `◼` — and treat `U+2600`–`U+27BF` (dingbats and misc symbols) as unsafe even when they are text-presentation by default.

---

## 2. Constraints to keep in mind

- **Width.** The sidebar is a fixed-width panel; the V1 source uses `width={42}` and the V2 bundle uses an unresolved constant. With `paddingLeft/Right = 2`, budget **~38 usable columns** per row (label + value + gap). Long model IDs are clipped at 18 chars for this reason.
- **Height.** `sidebar.content` renders inside a `scrollbox` (`flexGrow: 1, minHeight: 0`), so extra rows scroll rather than squeezing the transcript. Vertical growth is safe; horizontal is not.
- **Glyphs.** Row icons must be single-width and monochrome, or the terminal draws them from an emoji font: one cell becomes two, the label column shifts, and the theme colour is ignored. See the glyph decision in §1.
- **Refresh cost today.** One `session.get` + a BFS over `session.list` (children, paged 100) + `message.list` per session (paged 100, `type: "assistant"`), concurrency capped at 4, debounced 200 ms, plus `model.list` only when some message reports `cost === 0`.
- **Host duplicates.** The host contributes its own blocks to the same slot: `opencode.sidebar.context` (`Context` / `N tokens` / `NN% used` / `$ spent`), `opencode.sidebar.mcp`, `opencode.sidebar.footer`. Anything matching those reads as a bug, not a feature.
- **Sibling plugin.** `@esuyo/esuyo-opencode-tks` owns the prompt-footer line (`TPS | AVG | TTFT | GAP`). Latency metrics belong there, not here.

---

## 3. Bucket A — free candidates (no request, not yet added)

"Free" means either already inside the fetched payload, or read from the TUI's reactive store (`context.data.*`), which is kept in sync by the host.

| # | Row | Source | What it tells you | Caveats | My read |
| --- | --- | --- | --- | --- | --- |
| A1 | `⚿ waiting: bash` | `data.session.permission.list(sessionID)` → `PermissionRequest[]` (`action`, `resources[]`, `message`) | The agent is blocked on a permission prompt, which currently looks identical to a slow model | Needs a re-render trigger: `permission.asked` / `permission.replied` events are not currently subscribed | **Highest value.** Add first |
| A2 | `● running` / `idle 3m` | `data.session.status(id)` → `"idle" \| "running"`; `session.time.idle` | Whether the session is live right now | `session.status` event needed to stay live; V1 returned `{ type }`, V2 returns the bare string | Cheap, obvious |
| A3 | `⟳ 2 queued` | `data.session.pending.list(id)` → `SessionInboxInfo[]` | Prompts waiting in the inbox (steer vs queue) | Only meaningful if you use queued prompts | Nice if you queue |
| A4 | `◇ build 30 · explore 11` | `message.agent` per assistant message | How much work subagents did vs the primary agent | Row competes with `◆ models` for attention; `◆` and `◇` are close enough to read as a pair — pick a different glyph if both rows ship | Useful with subagents |
| A5 | `▣ edit 14 · read 22 · bash 9` | `content[].name` on tool parts | Which tools dominate; pairs with the failure count | Needs a top-3 truncation rule to fit 38 cols | Good, but decide the cut-off |
| A6 | `→ slowest step 1m12s` | `message.time.created → completed` | Tail latency of the session; the average hides it | Nothing | Cheap, complements `→ busy` |
| A7 | `$0.42/turn` | `cost / turns` | Cost efficiency per assistant step | Ambiguous denominator: "turns" here counts assistant messages (steps), not user prompts | Rename before shipping |
| A8 | `✧ 41% of output` | `reasoning / output` | How much of the output budget went to thinking | Raw `✦ think` count is already visible | Low value |
| A9 | `× last error: 429 …` | `message.error` (`type`, `message`, `status`), `retry.attempt` | *Why* steps failed, not just how many | Error text is unbounded — clip hard; may contain provider detail you don't want on screen | Decide clipping + whether to show at all |
| A10 | `✓ succeeded` / `interrupted` | `session.outcome` → `"succeeded" \| "failed" \| "interrupted"` | Terminal outcome of the session | Only meaningful once finished; noisy during work | Optional |
| A11 | `⌥ 2 other sessions running` | `ui.tabs.list()` → `{ busy, unread: "activity" \| "error" }` | Cross-session awareness | Client-local (this TUI's tabs), not session truth | Situational |
| A12 | `⎇ main` | `data.location.vcs.info()` → `{ provider?, branch }` | Which branch the session is in | The host may already surface branch elsewhere in the sidebar — verify before adding | Verify first |
| A13 | `⌁ 3 shells` | `data.shell.list()` | Running shells | Rarely interesting | Skip |
| A14 | `≡ 14 edits, 6 writes` | tool names again | Edits vs files touched (same file edited repeatedly) | Overlaps A5 | Pick A5 **or** A14 |
| A15 | persisted toggle | `context.storage.store("details", { initial: { open: false } })` | Expansion survives TUI restart and hot reload | Disk write only on toggle, so no per-frame cost; state becomes global rather than per-session | Small, worth it if the reset annoys you |

### One assumption to verify in the live TUI

`≡ files` depends on `message.list` responses carrying `snapshot.files`, and `▣ tools` depends on them carrying `content[]`. The declared response type is `SessionMessagesResponse.data: SessionMessageInfo[]` (full message objects), and the unit tests pass with hand-built fixtures — but I have **not** confirmed against a real session that the server populates `snapshot` on list responses. If `≡ files` shows nothing in a session that clearly edited files, that is why, and fixing it would push the row into Bucket B.

---

## 4. Bucket B — costs a request

| # | Row | Call | Cost | Verdict |
| --- | --- | --- | --- | --- |
| B1 | `≡ files 12 (+431 −92)` | `client.session.diff({ sessionID })` → `FileDiffInfo[]` (`file`, `patch`, `additions`, `deletions`, `status`) | One call per refresh **and** the response embeds `patch` text per file — payload, not latency, is the problem | Reject for this panel. If wanted, fetch once on expand and cache, never on refresh |
| B2 | `⌥ 12 prompts` (real user-turn count) | drop `type: "assistant"` from `message.list` | Roughly doubles the messages already paged | Reject. Also fixes the naming problem in A7 only at a cost |
| B3 | `▤ compacted 2×` | same — `SessionMessageCompactionCompleted` is filtered out by `type: "assistant"` | Same extra paging | Reject |
| B4 | `▣ bash p50 4.2s` | `client.session.stats({ project, tools: "detail" })` → `SessionStatsToolUsage[]` | One call, but the endpoint is **project/date-scoped** (`from`, `to`, `project`, `timezone`, `tools`) — no `sessionID` | Wrong scope for a per-session row. Belongs on a page (see C3) |
| B5 | `▓ context 148k/200k 74%` | `client.session.context({ sessionID })` → `SessionMessageInfo[]`, plus `ModelInfo.limit.context` | One call, potentially large | Reject — duplicate, see C1 |

---

## 5. Bucket C — deliberately out

| # | Item | Why |
| --- | --- | --- |
| C1 | Context-window usage | Host `opencode.sidebar.context` already renders `Context` / `N tokens` / `NN% used` / `$ spent` |
| C2 | MCP server health | Host `opencode.sidebar.mcp` |
| C3 | Project stats (streak, activeDays, per-model totals, activity) | `session.stats` is project-scoped; belongs in a `ui.router.register` page or the host's existing `/stats` |
| C4 | TPS / AVG / TTFT / GAP | Owned by `@esuyo/esuyo-opencode-tks` in the prompt footer; two sources of the same number invites disagreement |
| C5 | Version line | Host `opencode.sidebar.footer` |

Note on the host's `$ spent` vs this plugin's `$ cost`: they are **not** the same number. The host uses `data.session.cost` for the root session only; this plugin sums the whole session family and adds catalog estimates for zero-cost messages. Keep the labels distinct or it reads as a bug.

---

## 5b. Bucket D — page surface (built 2026-10-14)

The details page exists (see `session-details-page.md`), so rows that were rejected for the ~38-column sidebar now have a home. Already rendered there: per-tool breakdown (A5), model split with steps/tokens, subagent list, per-agent split with each agent's busy time (A4), slowest step (A6), last error (A9). Still candidates:

| # | Row | Where it goes |
| --- | --- | --- |
| B1 | `≡ files 12 (+431 −92)` | only with a lazy `session.diff` on first open, then cached — never on refresh |

Built as of 2026-10-14, with the wording settled during implementation:

| # | Row | Notes |
| --- | --- | --- |
| A4 | `Agents` section, one row per agent: `build 30 steps · 1.2M · 12m` | `message.agent` carries the actor on every step, so the split is exact rather than inferred from session titles. The last field is that agent's own merged step time; because agents run concurrently, the per-agent figures can add up to more than the session `→ busy` total, which is why the section is labelled per-agent and not shown as a share. No `◇` glyph: the other split rows on the page are plain indented names. |
| A6 | `→ slowest 1m12s · build` in `Timing` | Longest completed step in the whole family, tagged with the agent that ran it. Steps still running are excluded, same as `→ busy`. |
| A9 | `× last error 429 too many requests` in `Activity` | Newest `message.error` by `time.created`, not by array position: messages are collected per session and newest-first, so the arrays are not chronological. Formatted `status message`, falling back to the error `type`. Clipped to `PAGE_VALUE_WIDTH` (43) so a long provider message cannot widen the row. |

Third round, same day — the remaining zero-request rows the user asked for:

| Row | Source | Notes |
| --- | --- | --- |
| Header identity line | `session.location.directory`, `session.fork`, `session.outcome` (A10) | `directory · fork of ses_… · interrupted`. The directory is the part that gets clipped: the fork reference and the outcome are short and are the reason the line exists, so the budget is spent on them first. |
| `└ subagents 3 · 1.2M · 2 levels` | parent chain of the already fetched descendants | Family shape. Depth is walked per child with a `seen` set, so a malformed cycle cannot spin. |
| Subagent rows: `explore · succeeded · 4m · 1.2M · $0.84` | `session.agent`, `session.outcome`, `session.time` | The span is created-to-updated on the child session, not merged busy time: the panel holds the child's messages but cannot tell which of them belong to which child, because `message.list` payloads carry no session id. |
| `▣ tools 560 · 112 failed · 12m` and per-tool `bash 112 · 1m` | tool part `time.ran → completed`, falling back to `created` | Stats only — the failure *message* on the tool error state is deliberately not rendered. Per-tool time is that tool's own merged runs, so it can exceed the session total when tools overlap. Renders nothing when the server leaves `completed` out, which is why the field is optional rather than assumed; whether a live payload populates those timestamps is still unconfirmed. |
| `Agents` rows gain `· $1.00 · ø 8.9%` | `message.cost`, and `message.tokens` per agent | `ø` is the same marker the sidebar uses for cache hit rate. Null when the agent has no prompt tokens to divide by. |
| `↻ retries 3× max · 429 too many requests` | `message.retry.attempt` / `.at` / `.error` | Highest attempt reached plus the newest retry reason. `↻` also marks the turn count in the page header; it is the only repeat, and retry is what the glyph means. |

The zero-request rule applies to the page as well: it renders the state the sidebar already fetched, and `test/tui.test.ts` asserts the request counters do not move across open and close.

---

## 6. Recommended order

1. **A1** waiting-on-permission (+ subscribe `permission.asked` / `permission.replied`)
2. **A2** running/idle indicator
3. **A6** slowest step
4. **A5** top tools by name (with a fixed top-3 rule)
5. **A4** per-agent split
6. **A15** persist the toggle

Everything else: hold. B1 is the only Bucket B item with real appeal, and only if fetched lazily on expand and cached.

---

## 7. Open questions

- [ ] Does `≡ files` actually populate in a real session (see §3 assumption)?
- [ ] Is "turns" (assistant messages) the right denominator for `→ busy`'s `/step` and for A7 — or should the panel start distinguishing prompts from steps?
- [ ] Do you want error text on screen (A9), and if so how many characters?
- [ ] Should the expanded state persist across restarts (A15), or stay per-session-run?
- [ ] Glyph set: two diamond rows (models, agents) and two `▣`-adjacent rows (tools, top tools) — which glyphs stay?
- [ ] Is a keybinding wanted for the toggle? Currently `bind: false`; a binding would go in your `opencode.json` keybinds against command id `session.usage.details`.
- [ ] Should the block move to `sidebar.footer`, or stay inside the same block as the token panel?

---

## 8. Appendix — what the V2 SDK exposes

Verified against `@opencode/plugin@2.0.29` (`dist/tui/context.d.ts`) and `@opencode/client` (`dist/promise/generated/types.d.ts`).

### `context.data` (reactive store, no HTTP)

```
on(type, handler) / listen(handler)
session.list() .get(id) .root(id) .family(id) .cost(id) .status(id) .sync(id) .invalidate(id)
session.pending.list(id)          // SessionInboxInfo[]
session.message.list(id) .get(id, messageID)
session.permission.list(id)       // PermissionRequest[]
session.form.list(id) .reply() .cancel()
project.list() .get(id) ; project.permission.list(projectID)
shell.list() .get(id)
location.default()
location.vcs.info()               // { provider?, branch }
location.agent.list() .command.list() .integration.list()
location.mcp.server.list() .mcp.resource.list()
location.model.list() .provider.list() .reference.list() .skill.list()
```

Each collection exposes `list() / sync() / invalidate()`; `list()` returns `undefined` until synced.

### `context.ui`

```
slot({ append | prepend | before | after | replace, render })
panel.open(name, { presentation: "panel" | "fullscreen" }) .close() .current()
router.register(page) .navigate(destination) .current()
tabs.enabled() .list() .open(id) .focus(id) .move(id, i) .close(id)
model.current() ; model.variant.list() .set(v)
dialog.*  toast.show()  format.path()
```

Slot paths published by the host: `app`, `home.footer`, `home.footer.status`, `prompt.footer`, `prompt.footer.status`, `prompt.footer.file`, `session.composer.top`, `session.panel`, `sidebar.content`, `sidebar.footer`. (`prompt.footer`'s `showDetails` input is derived from interrupt state and terminal width ≥ 80 — it is **not** a user toggle.)

### Other context surfaces

- `context.storage.store(key, { initial })` — durable JSON, synced across TUI instances, survives hot reload.
- `context.storage.memory(key, { initial })` — in-memory, survives hot reload only.
- `context.keymap.layer(factory)` — commands with `id`, `title`, `bind` (string or `false`), `palette`, `slash: { name }`, `run`.
- `context.attention.notify()`, `context.theme`, `context.themeMode`, `context.app.version`, `context.client`, `context.location`, `context.renderer`.

### Types that matter for these rows

```ts
TokenUsageInfo = { input, output, reasoning, cache: { read, write } }

SessionInfo = { id, parentID?, fork?, projectID, agent?, model?, cost,
                tokens, outcome?, time: { created, updated, idle?, viewed?, archived? },
                title?, subpath?, metadata?, permissions?, revert?, location }

SessionMessageAssistant = { id, time: { created, streamed?, completed? }, type: "assistant",
  agent, model, content: (Text | Reasoning | Tool)[], snapshot?: { start?, end?, files? },
  finish?: "stop"|"length"|"tool-calls"|"content-filter"|"error"|"unknown", rawFinish?,
  providerState?, cost?, tokens?, error?, retry? }

SessionMessageAssistantTool = { type: "tool", id, name, executed?,
  state: Streaming | Running | Completed | Error, time: { created, ran?, completed? } }

FileDiffInfo = { file, patch, additions, deletions, status: "added"|"deleted"|"modified" }
SessionStatsInfo = { range, sessions, subagents, prompts, steps, tokens, cost,
                     tools: none|summary|detail, activeDays, streak, activity[], models[] }
ModelInfo.limit = { context, input?, output }
PermissionRequest = { id, sessionID, action, resources[], save?, metadata?, source?, message? }
VcsInfo = { provider?, branch }
McpServer = { name, status: connected|pending|disabled|failed|needs_auth }
```

### Events available via `context.data.on(...)`

Subscribed today: `session.usage.updated`, `session.execution.succeeded`, `session.created`, `session.deleted`.

Not subscribed, potentially relevant: `session.step.started/ended/failed/streamed`, `session.usage.recorded`, `session.tool.called/success/failed/progress`, `session.idle`, `session.status`, `session.compaction.started/delta/ended/failed`, `session.retry.scheduled`, `session.execution.started/failed/interrupted`, `session.inbox.enqueued/delivered/cancelled`, `permission.asked/replied`, `session.renamed`, `session.forked`, `session.model.selected`, `session.agent.selected`, `session.viewed`, `mcp.status.changed`, `vcs.branch.updated`.

Full host slash-command list (for collision checking): `agents, btw, cd, clear, compact, connect, copy, debug, diff, editor, exit, export, fork, help, highlights, mcps, models, new, open, pair, plugins, redo, reload, rename, restart, sessions, settings, share, skills, stats, status, terminal, themes, timeline, undo, update, variants, worktrees`. `/usage` is free.

---

## 9. Wiring and verification

- Live plugin entry: `~/.config/opencode/cli.json` → `"plugins": ["@esuyo/esuyo-opencode-tks", "C:/SERVER/REPOS/Esuyo/esuyo-opencode-session"]`. Use the **directory**, not `tui.tsx`.
- Check: `opencode plugin list` should show the second entry as `local`.
- Typecheck: `npm run typecheck` (tsc, strict).
- Tests: `bun test --preload @opentui/solid/preload` — 18 tests. bun is not on `PATH`; a throwaway copy lives at `C:\Users\miguel\AppData\Local\Temp\opencode\bunbin\node_modules\@oven\bun-windows-x64\bin\bun.exe`. CI uses `oven-sh/setup-bun@v2` with bun `1.3.14` and runs `bun run check`.
- Remote still points at `njbraun/…`; changes are uncommitted.
