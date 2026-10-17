# AGENTS.md

OpenCode 2 TUI sidebar plugin (`@esuyo/esuyo-opencode-session`). Shows token/cost usage for a session plus its subagents. Requires `opencode >=2.0.28 <3`.

## Layout

- `tui.ts` — plugin entrypoint (`Plugin.define`, sidebar slot, prompt-footer throughput slot, `session-usage-details` route registration, keymap). Owns the `UsageState` signal and all event/refresh wiring; imports presentation from `details-page.ts`. No JSX: UI is built with the `h()` helper in `jsx.ts` (hand-written element calls mirroring the Solid transform output) so the host transform has nothing to rewrite. Runtime imports must use the host's `opentui:runtime-module:*` virtual ids (see `jsx.ts` and `test/runtime-alias/`); bare `@opentui/*` or `solid-js` imports load an isolated copy that conflicts with the host instance.
- `details-page.ts` — presentational only: `DetailsPage`, shared `UsageRow`, page layout constants. Renders existing `state()` — never calls `refresh()` or adds client calls.
- `jsx.ts` — the `h()` element helper; the only place besides `test/runtime-alias/` that names virtual ids.
- `format.ts` — pure display formatting (`fmt`, `fmtCost`, `fmtDuration`, `fmtRate`, `clip`, `errorMessage`). No imports.
- `tps.ts` — throughput tracker (TPS/AVG/TTFT/GAP) plus JSONL logging. Event-driven only, no client requests.
- `usage.ts` — all pure logic: `computeTotals`, `sumSessions`, `estimateCost` / `combineCosts` / `estimateCacheSavings`, `computeDetails`, `fetchDescendants`, `fetchAssistantMessages`. Unit-test here first.
- `test/tui.test.ts` — only test file; covers `usage.ts` functions plus offscreen TUI render via `testRender` from `@opentui/solid`. `test/runtime-alias/` maps each virtual id to the devDependencies copy (wired via tsconfig `paths`); bun test has no host loader.
- `docs/` — design rationale (`session-summary-candidates.md`, `session-details-page.md`). Read before changing metrics/rows.

## Commands

```sh
npm run typecheck   # tsc --noEmit
npm run test        # bun test --preload @opentui/solid/preload
npm run check       # typecheck + test (use before PR)
npm run pack:check  # verify published file list
```

- Tests require **bun** (`bun:test`, `Bun.sleep`). Single test: `bun test --preload @opentui/solid/preload test/tui.test.ts -t "<name>"`.
- CI (`.github/workflows/publish.yml`, Node 22 + Bun 1.4.3): `npm ci` then `npm test`.
- No build step; npm publishes source files only (`files`: `tui.ts`, `details-page.ts`, `jsx.ts`, `format.ts`, `tps.ts`, `usage.ts`, `README.md`, `LICENSE`). Keep `files` and `tsconfig.json` `include` in sync when adding a source module.

## Conventions / gotchas

- `tsconfig.json`: no JSX in this repo (no `jsxImportSource` needed). `include` covers source modules plus `test/**` — keep it minimal and in sync with `files`. `paths` maps the `opentui:runtime-module:*` ids to `test/runtime-alias/` shims for typecheck/tests; the real host provides them at runtime.
- Install entry is the plugin **directory** in `cli.json` `plugins`, not `tui.tsx` and not `opencode.json`. Direct-file TUI entries are skipped by OpenCode 2.
- Zero-extra-request rule: sidebar `refresh()` fetches everything; `DetailsPage` and the expandable `Session Summary` block must only render existing `state()` — never call `refresh()` or add client calls. Regression-guarded by request counters in tests.
- Cost model: `message.cost === 0` with tokens = unreported (estimate from catalog); missing/undefined `cost` = skip, do not estimate. Model rows show `$` only for reported cost. Cache-hit rate = `cacheRead / (input + cacheRead + cacheWrite)`; null/omitted when denominator is 0.
- Busy time = union (merged, not summed) of completed step intervals so concurrent subagents count once; per-agent/per-tool durations are their own merges and may exceed the session total. Subagent `spanMs` is created→updated wall time (messages carry no session id, so per-child busy time is unknowable).
- `fetchDescendants` walks `session.list(parentID)` level-by-level with `FETCH_CONCURRENCY = 4`; keep the cap. Messages are paginated (`limit: 100`, assistant-only, `order: desc` then cursor).
- Publish is automatic on push to `main`/`master`: conventional-commit bump (`feat:`→minor, `BREAKING CHANGE:`/`major:`→major, else patch), then `npm publish`, tag, GitHub release.
