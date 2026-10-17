# Troubleshooting

| Symptom | What to do |
| --- | --- |
| No panel in the sidebar | Restart the TUI. Check the entry is in `cli.json` (not `opencode.json`) and points at the directory, not `tui.tsx`. Check `session.sidebar` in `cli.json`. |
| No `ø cache hit rate` row and no `Session Summary` block | You installed the unscoped npm name `opencode-plugin-session-token-summary`, which is the upstream original. Use `@esuyo/esuyo-opencode-session`, or point the entry at this repository. |
| A row is missing | Its data is not available for this session. `≡ files`, `≈ saved`, `→ busy` and the tool durations in particular depend on message snapshots, catalog pricing, completed step timestamps, and completed tool timestamps. |
| Cost looks wrong | Check the label. `$ est. cost` and `$ cost incl. est.` are catalog estimates, not billed amounts. |
| A symbol renders as a box | The rows use single-width symbols from the Latin-1 Supplement, Arrows, Box Drawing, Block Elements and Geometric Shapes ranges. A font without those glyphs will show tofu; the panel itself is unaffected. |
