# Notes

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
