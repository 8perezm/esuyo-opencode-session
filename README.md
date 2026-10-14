# OpenCode Session Token Summary

[![npm version](https://img.shields.io/npm/v/opencode-plugin-session-token-summary)](https://www.npmjs.com/package/opencode-plugin-session-token-summary)

An OpenCode TUI plugin that adds a compact session-usage panel to the sidebar.
It aggregates the root session and all nested subagent sessions.

![alt text](image.png)

## Features

- Compact OpenCode sidebar panel with live session updates
- Input, output, reasoning, cache read, cache write, and total token counts
- Cache hit ratio and assistant turn count
- Usage aggregated across the root session and every nested subagent
- Reported API costs for metered providers
- API-equivalent cost estimates for quota and subscription-backed providers
- One combined cost total for sessions that mix metered and quota-backed models
- Clear labels distinguishing reported, estimated, and partially estimated costs
- V2 model-catalog pricing with context-tier support

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
