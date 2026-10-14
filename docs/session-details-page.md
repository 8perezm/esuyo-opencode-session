# Session Details page — implementation plan

Status: **built (M1–M3), awaiting a live TUI check** (2026-10-14). The user rejected reaching the
details view by typing `/usage` in the composer, and instead wants a **clickable link under the
`Session Summary` block that opens a page in the main panel** with the full session breakdown.
See §9 for what shipped and where it deviates from this plan.

Nothing already shipped changes: `/usage`, the palette toggle, the sidebar block and its rows stay
exactly as they are. This is additive.

---

## 1. Goal

```
▾ Session Summary
▣ tools                   30 · 10 failed
≡ files                                3
≈ saved                           $32.87
↺ initiated                         2h02
→ busy                      5m · 1m/step
⤺ open session details                 ← click, opens a page in the main panel
```

The page is where the room-hungry metrics finally fit: the sidebar is capped at ~38 usable columns,
so per-tool, per-model and per-subagent breakdowns were rejected there (see
`session-summary-candidates.md` A4/A5). A route page has the whole terminal width.

Hard rule carried over from the sidebar work: **opening the page costs zero extra HTTP requests.**
It renders state the panel already fetched.

---

## 2. API surface (verified, not guessed)

Verified against `node_modules/@opencode/plugin/dist/tui/context.d.ts` (`@opencode/plugin@2.0.29`)
and against plaintext in the installed host binary
(`@opencode/cli-windows-x64/bin/opencode.exe`), which ships its own plugin page — the diff viewer.

| Surface | Signature | Notes |
| --- | --- | --- |
| Register a page | `context.ui.router.register(page: Page): () => void` | `Page = { name: string; render: (input: { data?: Record<string, any> }) => JSX.Element }` |
| Navigate | `context.ui.router.navigate(destination: Destination): void` | `Destination` = `Route` minus the plugin route's `id`, so `{ type: "plugin", name, data }` is valid |
| Current route | `context.ui.router.current(): Route` | `Route` = `home` \| `session{sessionID}` \| `plugin{id,name,data}` |
| Input mode | `context.keymap.mode.push(mode: string): () => void` | Cleanup restores the previous mode |
| Scoped layer | `context.keymap.layer(() => ({ mode, commands }))` | `mode` limits the layer; `bind: "escape,ctrl+c"` |
| Scrollable page | `<scrollbox>` | Valid intrinsic in `@opentui/solid/jsx-runtime.d.ts` (`scrollbox: ScrollBoxProps`) |

Host's own diff-viewer pattern, copied verbatim from the binary:

```js
// registration
t.ui.router.register({ name: DIFF_PAGE, render: () => <DiffViewer context={t} /> });

// open: capture where we came from, then jump
const current = t.context.ui.router.current();
const returnRoute = current.type === "session" ? { type: "session", sessionID: current.sessionID }
                  : current.type === "home"    ? { type: "home" }
                  : { type: "plugin", id: current.id, name: current.name, ...current.data ? { data: {...current.data} } : {} };
t.context.ui.router.navigate({ type: "plugin", name: DIFF_PAGE, data: { sessionID, returnRoute } });

// close
t.context.ui.router.navigate(returnRoute ?? { type: "home" });

// keyboard scope while the page is open
onMount(() => onCleanup(t.context.keymap.mode.push("menu")));
t.context.keymap.layer(() => ({ mode: "menu", commands: [{ bind: "escape,ctrl+c", run: onClose }] }));
```

Not chosen: `context.ui.panel.open(name)` + a `session.panel` slot claim. It is declared in the
types, but the host slot string could not be confirmed in the installed binary, so it needs a spike
before it can be trusted. The user picked the full page route.

---

## 3. Design decisions

1. **Route name** `session-usage-details`. Namespaced and collision-checked: host route names are
   internal (`opencode.diffs` owns its page), and plugin routes are keyed by the plugin's own id.
2. **Link row, not a slash command.** `⤺ open session details`, rendered with the existing
   `UsageRow`, clickable via `onMouseDown` — the same mechanism the `▾ Session Summary` title
   already uses. `⤺` (U+293A) is Supplemental Arrows-B; if it renders as tofu in the user's font,
   fall back to `→` or `↗` (both already proven in this panel).
3. **Keyboard access without the composer.** Palette-only command `session.usage.page`
   (`palette: true`, `bind: false`, **no `slash`**). `/usage` is left untouched.
4. **Back** = `escape` and `ctrl+c`, bound only while the page is open, via a pushed input mode —
   the host's own convention, so the bindings cannot leak into the session view.
5. **Shared state, no second fetch.** `state()` already lives in the `setup()` closure, so the page
   reads the same signal the sidebar writes. The page must not call `refresh()` on mount; it only
   renders `state()`. If `state().status === "loading"` it shows a loading line — the sidebar's own
   effect is already fetching.
6. **Page owns no data of its own.** `data.sessionID` is used only to (a) guard against a stale
   render after the user switches sessions and (b) label the header.

---

## 4. New derived data (all free, computed in `usage.ts`)

The page is only worth building if it shows more than the sidebar. Everything below is already in
the payloads the panel fetches — no new calls.

| Field | Source | Cost |
| --- | --- | --- |
| `modelSplit: Array<{ id, providerID, steps, tokens, cost }>` | group `assistantMessages` by `message.model` | none |
| `toolSplit: Array<{ name, calls, failed }>` | `content[]` parts where `type === "tool"`, `state.status === "error"` | none |
| `subagents: Array<{ id, title, tokens, cost }>` | `descendants.sessions`, already walked by `fetchDescendants` | none |

`computeDetails()` already iterates the messages once; these are extra accumulators in the same
pass, so the O(messages) cost is unchanged. `EMPTY_DETAILS` gains three empty arrays, and
`hasDetails()` in `tui.tsx` must **not** start keying off them (the sidebar block stays as it is).

Sort rules, fixed so the page is stable: `modelSplit` by `tokens` desc, `toolSplit` by `calls` desc,
`subagents` by `tokens` desc. Cap each section at 10 rows with a `+N more` line — the page scrolls,
but an unbounded list makes the header unreachable.

---

## 5. File-by-file changes

### `usage.ts`
- Extend `SessionDetails` with `modelSplit`, `toolSplit`, `subagents`; add to `EMPTY_DETAILS`.
- Fill them inside the existing single pass of `computeDetails()`.
- Keep `pricedEntry()` shared so `modelSplit[].cost` and `savings` cannot disagree.

### `tui.tsx`
- Constants: `DETAILS_PAGE = "session-usage-details"`, `PAGE_COMMAND = "session.usage.page"`,
  `CLOSE_COMMAND = "session.usage.page.close"`, `PAGE_MODE = "session-usage"`.
- `openPage(sessionID)`: capture `router.current()` as `returnRoute`, stash it in a closure signal,
  then `router.navigate({ type: "plugin", name: DETAILS_PAGE, data: { sessionID, returnRoute } })`.
- `closePage()`: `router.navigate(returnRoute ?? { type: "home" })`, mirroring the host.
- `context.ui.router.register({ name: DETAILS_PAGE, render: (input) => <DetailsPage ... /> })`,
  disposed in the plugin's teardown alongside `stopSlot`.
- Keymap layer additions:
  - `session.usage.page` — `palette: true`, `bind: false`, no `slash`, `run: () => openPage(lastSessionID)`.
  - a second layer `{ mode: PAGE_MODE, commands: [{ id: CLOSE_COMMAND, bind: "escape,ctrl+c", run: closePage }] }`,
    created only while the page is mounted (`keymap.mode.push(PAGE_MODE)` + `onCleanup`).
- Sidebar: one extra row at the bottom of the block, outside the `expanded()` `Show` so it is
  reachable while collapsed, and inside `hasDetails()` so it never dangles.
- `DetailsPage` component: `<scrollbox>` + section headers (`TOKENS`, `COST`, `ACTIVITY`, `MODELS`,
  `TOOLS`, `SUBAGENTS`, `TIMING`) reusing `fmt`, `fmtCost`, `fmtDuration`, `clip`. Footer line:
  `esc back`.

### `test/tui.test.ts`
- `computeDetails` fixtures: assert `modelSplit`, `toolSplit`, `subagents` contents and sort order.
- Navigation test with a fake `context.ui.router`: opening records one `navigate` call with
  `{ type: "plugin", name: DETAILS_PAGE, data: { sessionID, returnRoute } }`, and **request counters
  are unchanged** — this is the regression guard for the zero-extra-requests rule.
- Render test for the page at width 72: header, one row per section, `esc back` present.
- Existing expand/collapse tests must stay green untouched.

### `README.md`
- New `### Session details page` section with a rendered frame of the page and the note that it
  opens from the link or the palette, never from the composer.

### `docs/session-summary-candidates.md`
- New **Bucket D — page surface**: A4 (per-agent), A5 (top tools), A6 (slowest step), B1 (files with
  `+/-`) move from "rejected for the sidebar" to "belongs on the page".
- Close the open question about where room-hungry rows go.

---

## 6. Milestones

1. **M1 — navigation skeleton.** Route registered, link row, `esc`/`ctrl+c` back, palette command.
   Page renders only the numbers the sidebar already shows. *Verify in the live TUI before writing
   content* — this is where the unknowns are (mode push, focus, scroll, teardown).
2. **M2 — derived data.** `modelSplit` / `toolSplit` / `subagents` in `usage.ts` + tests.
3. **M3 — page content.** Sections, caps, `+N more`, colour rules matching the sidebar.
4. **M4 — docs.** README + Bucket D.

---

## 7. Risks and open questions

- **Input mode side effects.** While `PAGE_MODE` is pushed, the host's base-mode commands (prompt
  typing, leader key) are inactive — same as the host's diff viewer. Confirm `ctrl+c` closes rather
  than quitting the TUI, and that the leader key is not required to get out.
- **Teardown.** `router.register` returns a disposer; the page must be unregistered when the plugin
  reloads, or a reload leaves a route that renders a dead closure.
- **Stale session.** Navigating to another session while the page is open: the page reads `state()`,
  which the sidebar effect re-keys on `props.sessionID`. Decide whether the page follows the new
  session or navigates back.
- **No sidebar ⇒ no data.** The page depends on the sidebar's fetch. If the sidebar is hidden
  (`session.sidebar.toggle`), `state()` may be empty. Decide: force a refresh when the page mounts
  (breaks the zero-request rule only in that case), or show "open the sidebar".
- **Glyph for the link.** `⤺` is unverified in the user's font; `→`/`↗` are the safe fallbacks.
- **Width.** Page layout must degrade at narrow terminals (the sidebar can be dragged); target a
  usable layout down to ~60 columns, two columns for the token block above that.

---

## 8. Verification

```powershell
cd C:\SERVER\REPOS\Esuyo\esuyo-opencode-session
npm run typecheck
& "C:\Users\miguel\AppData\Local\Temp\opencode\bunbin\node_modules\@oven\bun-windows-x64\bin\bun.exe" `
  test --preload "@opentui/solid/preload"
```

Baseline at the time of writing: typecheck clean, **20 pass / 0 fail, 61 assertions**.

Offscreen render harness for the page (scratch file, deleted afterwards): `testRender` with a fake
`context.ui.router` that records `navigate` calls, then `captureCharFrame()` at width 72 — the same
harness that produced the sidebar frames in `README.md`.

Live check after M1: click the link, `esc` back, palette command, session switch while open, plugin
reload while open.

---

## 9. What shipped (2026-10-14)

M1, M2 and M3 are implemented; the live TUI check is still outstanding.

| Piece | Value |
| --- | --- |
| Route | `session-usage-details`, registered with `ui.router.register` and disposed in the plugin teardown |
| Open | `onMouseDown` on the `⤺ open session details` row, or palette command `session.usage.page` |
| Close | inline command bound to `escape,ctrl+c`, in a plugin keymap layer that is disabled unless the page is open; `closePage` reads the return target from the live route |
| Back target | `returnRoute` captured from `router.current()` at open time, carried in the route data and read back by the page — the host diff viewer's pattern |
| Page sections | Tokens, Cost, Activity (+ per-tool breakdown, + last error, + retries), Agents, Models, Subagents, Timing (+ slowest step), plus an identity line under the session id |

Deviations from the plan, all deliberate:

- **`modelSplit[].cost` is only shown when the API reported it.** The plugin estimates cost for
  zero-cost messages at the *total* level; splitting an estimate across models would imply
  precision that is not there, so a model row shows `steps · tokens` and adds `· $cost` only when a
  real per-step cost exists.
- **A section heading only renders when at least one of its rows has a value.** `Cost`,
  `Activity` and `Timing` wrap their spacer, heading and rows in a single `Show`; `Agents`,
  `Models` and `Subagents` already did. Before this, a session with no recorded cost showed a
  bare `Cost` heading over an empty gap, and a chat-only session showed a bare `Activity`.
- **The page drops the `◆ models` headline row** the sidebar shows; the `Models` section replaces it.
  Keeping both read as duplication.
- **The page is 78 columns wide: `PAGE_LABEL_COLUMN` (34) plus `PAGE_VALUE_COLUMN` (44), the value
  column right-aligned.** The first version reused the sidebar's `space-between` rows, which on a wide
  terminal pushed each value 100+ columns away from its label; the second version left-aligned the
  value, which lost the column of digits that makes the numbers readable. `UsageRow` stays for the
  narrow sidebar; `PageRow` is page-only, and split labels are clipped to `PAGE_LABEL_WIDTH` (31) so
  the two-space indent still fits the label column. The outer box's `maxWidth` is
  `PAGE_CONTENT_WIDTH + 2` to cover its own padding — with the value right-aligned, a two-column
  mistake clips whole values instead of trailing spaces.
- **The return target lives in the route data, not in a plugin closure.** The first version kept it
  in a `let` inside `setup()`, and `esc` landed on `{type:"home"}` — a fresh session in a new tab —
  whenever that closure was empty. Now `openPage` puts `returnRoute` in the navigate payload and the
  page reads it back from `input.data`, which is how the host's own diff viewer does it. If it is
  missing, the page falls back to `{type:"session", sessionID}` for the session it is showing, and
  only then to home. `router.register` is wrapped in `try/catch` so a second plugin instance cannot
  take the sidebar down with a "Route already registered" throw.
- **`esc` and clicking `esc back` did nothing because "back" was navigating to the page itself.** The
  sidebar stays on screen while the page is open, so clicking the link again captured the *page* route
  as the return target; going "back" then re-rendered the same page, which reads as a dead key and a
  dead link. `openPage` now keeps the original `returnRoute` when the current route is already this
  page, and `backFrom` drops any return target that points at this page.
- **The close binding lives in the plugin's own keymap layer, in a second layer that is disabled
  unless the page is open, and the command is inline (no `id`).** The first two attempts created the
  layer from inside the page component with a named command; both were dead in the live TUI. Inline
  commands get their `bind` registered straight onto the keymap, which is what every host page that
  closes on `escape` does (the storybook pages, the diff menus), and gating the *layer* rather than
  the command means the plugin holds no escape binding at all while the page is closed. The exact
  reason the earlier variants never fired is still unconfirmed — this matches the pattern that does.
- **`esc back` is a clickable row**, not just a label, so leaving the page does not depend on a
  binding alone.
- **`subagentList[].title`** is `session.title ?? ""`; the page falls back to the session id.
- **No forced refresh when the sidebar is hidden.** The §7 open question is still open: the page
  renders `state()`, which the sidebar effect populates. If the sidebar is toggled off, the page can
  show a loading or empty state. Left as-is rather than spending a request.
- **`⤺` (U+293A, Supplemental Arrows-B) is outside the ranges the glyph rule in
  `session-summary-candidates.md` recommends.** Kept anyway: it has rendered correctly across every
  live TUI run so far, with no tofu reported. If it ever breaks on another font, swap to `↗` or drop
  the icon; the row is otherwise plain text.

### Second round: A4, A6, A9 (same day)

The three Bucket D rows that needed no new data were added to the page only — the sidebar is
unchanged, because all three are too wide for ~38 columns.

| Row | Source | Notes |
| --- | --- | --- |
| `Agents` section | `message.agent` on every assistant step | `agentSplit[]` carries `steps`, `tokens`, `cost` and `busyMs`. `busyMs` is that agent's own `mergedDuration`, so the per-agent figures can exceed the session `→ busy` total when agents overlap — correct, and the reason the section shows absolute time instead of a share. |
| `→ slowest 1m12s · build` | longest `completed - created` across the family | Running steps are excluded, the same rule as `→ busy`. The agent suffix is clipped to `MAX_AGENT_SUFFIX` (12); the full names are in the `Agents` section. |
| `× last error 429 too many requests` | newest `message.error` | Chosen by `time.created`, not array position: messages are collected per session and newest-first, so the combined array is not chronological. `describeError` renders `status message`, falling back to `type` when the message is empty, and the value is clipped to `PAGE_VALUE_WIDTH` (43). |

Test coverage added: navigation payload and `returnRoute`, re-opening the page keeping the original
return target, closing without a `returnRoute` still returning to the session rather than home, the
close layer being enabled only while the page is open, request counters unchanged across open and
close, the page's section headers and value column, the three original splits (`toolSplit`,
`modelSplit`, `subagentList`) including their sort order, and the new rows: per-agent split with
per-agent busy time against the merged session total, slowest step with its agent, and the newest
error picked out of out-of-order messages.

### Third round: identity, family shape, tool time, retry detail (same day)

Six more page-only rows, all from payloads the sidebar already fetches.

| Row | Notes |
| --- | --- |
| Identity line | `directory · fork of ses_… · interrupted`, from `location.directory`, `fork` and `outcome` on the root session. Clipping is deliberate: the directory absorbs the cut, because the fork reference and the outcome are the short facts the line exists to show. A first version clipped the whole line and lost the outcome. |
| `└ subagents 2 · 132 · 3 levels` | `familyDepth` walks each child's parent chain with a `seen` set so a malformed cycle cannot spin. |
| Subagent rows | `agent · outcome · span · tokens · cost`. The span is the child session's created-to-updated wall time, **not** merged busy time: `message.list` payloads carry no session id, so the panel cannot attribute a descendant's messages to a specific child. Naming it "busy" would be a claim the data does not support. |
| Tool durations | `▣ tools 560 · 112 failed · 12m` and one figure per tool. Start is `time.ran` when present (before that the step is only streaming input), else `time.created`. Per-tool figures are that tool's own merged runs, so they can exceed the session total when tools overlap. Omitted entirely when the server leaves `completed` out; whether a live payload populates `ran`/`completed` has not been confirmed either way, so the omission path is the safety net rather than a proven case. |
| `Agents` cost and cache share | `· $1.50 · ø 8.9%`. `ø` is the sidebar's cache-hit marker; the rate is null when an agent has no prompt tokens to divide by, rather than a misleading 0%. |
| `↻ retries 3× max · 529 overloaded` | Highest `retry.attempt` reached plus the newest `retry.error`, chosen by `retry.at` for the same out-of-order reason as `× last error`. |

Deliberately left out on request: the tool failure *message* from `state.error`. The page stays
numbers, with `× last error` as the one place prose appears.

Test coverage added: tool durations with overlapping runs merged, the `ran`-missing fallback, and
the no-timestamps case; subagent agent/outcome/span; family depth at 1, 2 and 3 levels; the identity
fields; retry attempt and newest retry reason; and the page render asserting the identity line, the
retries row, the family depth, a subagent's outcome, an agent's cost and cache share, and a tool
duration. A later test renders a session with no cost and no activity and asserts the `Cost` and
`Activity` headings are gone while `Tokens` and `Timing` remain. Baseline is now
**31 pass / 134 assertions**.
