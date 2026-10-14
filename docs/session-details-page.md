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
| Page sections | Tokens, Cost, Activity (+ per-tool breakdown), Models, Subagents, Timing |

Deviations from the plan, all deliberate:

- **`modelSplit[].cost` is only shown when the API reported it.** The plugin estimates cost for
  zero-cost messages at the *total* level; splitting an estimate across models would imply
  precision that is not there, so a model row shows `steps · tokens` and adds `· $cost` only when a
  real per-step cost exists.
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
- **`⤺` (U+293A, Supplemental Arrows-B) is unverified in the user's font.** It is outside the ranges
  the glyph rule in `session-summary-candidates.md` recommends. If it renders as tofu, swap to `↗`
  or drop the icon; the row is otherwise plain text.

Test coverage added: navigation payload and `returnRoute`, re-opening the page keeping the original
return target, closing without a `returnRoute` still returning to the session rather than home, the
close layer being enabled only while the page is open, request counters unchanged across open and
close, the page's section headers and value column, and the three new splits (`toolSplit`,
`modelSplit`, `subagentList`) including their sort order. Baseline is now **22 pass / 104
assertions**.
