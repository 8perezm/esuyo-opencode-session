# Session Summary

One plugin, three live views for the [OpenCode](https://opencode.ai) terminal:

- **Sidebar usage** — what this session has cost: tokens, money, cache behaviour, and
  how much of the work was done by subagents. Everything it shows covers the whole
  session family — the session you are looking at plus every subagent it started.
- **Details page** — the full breakdown in the main panel: per-agent, per-model and
  per-subagent splits, slowest step, retries, and provider errors.
- **Footer throughput** — how fast it is running: `TPS live | AVG | TTFT | GAP` in the
  prompt footer, with per-step JSONL logging.

<table>
  <tr>
    <td><img src="docs/tui.png" alt="Sidebar usage panel and footer throughput" /></td>
    <td><img src="docs/detail-page.png" alt="Session details page" /></td>
  </tr>
</table>

---

The sidebar is a hard fork of
[opencode-plugin-session-token-summary](https://github.com/njbraun/opencode-plugin-session-token-summary)
by Nick Braun ([@njbraun](https://github.com/njbraun)).

The throughput line is a hard fork of
[Tarquinen/oc-tps](https://github.com/Tarquinen/oc-tps)
by Tarquinen ([@Tarquinen](https://github.com/Tarquinen)).

See [Credit](#credit-and-license).

## What you get

### Sidebar: what it cost

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

### Details page: the full breakdown

One click replaces the main panel with the complete breakdown: tokens, cost, activity
with how long each tool ran, per agent, per model and per subagent, how deep the session
family goes, the slowest step, the retries, and the last provider error.

### Footer: how fast it runs

**A live throughput line in the prompt footer** — `TPS live | AVG | TTFT | GAP`,
ported from `@esuyo/esuyo-opencode-tks`. Live tokens/sec over the last 5s streaming
window, the session-average tokens/sec and time-to-first-token across completed model
steps, and the gap since the previous final completion. Every completed model step is
also appended as one JSON object per line (numeric metadata only, never prompt text)
to `~/.local/share/opencode/esuyo-opencode-tks.log` (`ESUYO_TPS_LOG` overrides,
`/dev/null` disables).

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

## Docs

- [Usage](docs/usage.md)
- [Notes](docs/notes.md)
- [Troubleshooting](docs/troubleshooting.md)

## Credit and license

The sidebar is a hard fork of
[opencode-plugin-session-token-summary](https://github.com/njbraun/opencode-plugin-session-token-summary)
by **Nick Braun** ([@njbraun](https://github.com/njbraun)), who wrote the sidebar panel,
the cost estimation against OpenCode's model catalog, and the subagent aggregation that
this project is built on. The original MIT license and his copyright notice are kept
untouched in [LICENSE](LICENSE).

The `TPS | AVG | TTFT` throughput line is derived from
[`Tarquinen/oc-tps`](https://github.com/Tarquinen/oc-tps) at commit `89bf5b8`
(v0.0.10). The upstream project declared no license; original work remains attributed
to its author.

MIT, same as the original — see [LICENSE](LICENSE).
