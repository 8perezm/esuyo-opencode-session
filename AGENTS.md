# AGENTS.md

OpenCode 2 TUI sidebar plugin (`@esuyo/esuyo-opencode-session`). Shows token/cost usage for a session plus its subagents. Requires `opencode >=2.0.28 <3`.

## Layout

- `tui.tsx` — plugin entrypoint (`Plugin.define`, sidebar slot + `session-usage-details` route page). Thin UI only; reads a shared `state()` signal.
- `usage.ts` — all pure logic: `computeTotals`, `sumSessions`, `estimateCost` / `combineCosts` / `estimateCacheSavings`, `computeDetails`, `fetchDescendants`, `fetchAssistantMessages`. Unit-test here first.
- `test/tui.test.ts` — only test file; covers `usage.ts` functions plus offscreen TUI render via `testRender` from `@opentui/solid`.
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
- No build step; npm publishes source files only (`files`: `tui.tsx`, `usage.ts`, `README.md`, `LICENSE`).

## Conventions / gotchas

- `tsconfig.json`: `jsx: react-jsx` with `jsxImportSource: @opentui/solid`; `tui.tsx` needs `/** @jsxImportSource @opentui/solid */`. `include` covers only `tui.tsx`, `usage.ts`, `test/**` — keep it that way.
- Install entry is the plugin **directory** in `cli.json` `plugins`, not `tui.tsx` and not `opencode.json`. Direct-file TUI entries are skipped by OpenCode 2.
- Zero-extra-request rule: sidebar `refresh()` fetches everything; `DetailsPage` and the expandable `Session Summary` block must only render existing `state()` — never call `refresh()` or add client calls. Regression-guarded by request counters in tests.
- Cost model: `message.cost === 0` with tokens = unreported (estimate from catalog); missing/undefined `cost` = skip, do not estimate. Model rows show `$` only for reported cost. Cache-hit rate = `cacheRead / (input + cacheRead + cacheWrite)`; null/omitted when denominator is 0.
- Busy time = union (merged, not summed) of completed step intervals so concurrent subagents count once; per-agent/per-tool durations are their own merges and may exceed the session total. Subagent `spanMs` is created→updated wall time (messages carry no session id, so per-child busy time is unknowable).
- `fetchDescendants` walks `session.list(parentID)` level-by-level with `FETCH_CONCURRENCY = 4`; keep the cap. Messages are paginated (`limit: 100`, assistant-only, `order: desc` then cursor).
- Publish is automatic on push to `main`/`master`: conventional-commit bump (`feat:`→minor, `BREAKING CHANGE:`/`major:`→major, else patch), then `npm publish`, tag, GitHub release.
