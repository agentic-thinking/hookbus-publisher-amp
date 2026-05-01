# @agenticthinking/hookbus-publisher-amp

**Sourcegraph Amp publisher for HookBus™.**

A TypeScript plugin that wires Amp's plugin API to a HookBus endpoint. Every Amp lifecycle event (session start, user prompt, tool call, tool result, agent end) is published to the bus; subscribers (CRE-AgentProtect, AgentSpend, auditors, KB injectors) then observe or gate the event.

MIT licence. Single file, ~170 lines, standard fetch + crypto APIs only.

## Event coverage (5 of 5)

| Amp event | HookBus event type | Can block? |
|---|---|---|
| `session.start` | `SessionStart` | No (fire-and-forget) |
| `agent.start` | `UserPromptSubmit` | Yes — can inject context or flag the prompt |
| `tool.call` | `PreToolUse` | Yes — allow / reject-and-continue / modify |
| `tool.result` | `PostToolUse` | No (fire-and-forget) |
| `agent.end` | `Stop` | No (fire-and-forget) |

Full Claude Code hook parity on Amp.

## Quick start

```bash
git clone https://github.com/agentic-thinking/hookbus-publisher-amp
cd hookbus-publisher-amp
./install.sh
```

The installer:
1. Drops `plugin/hookbus.ts` to `~/.config/amp/plugins/hookbus.ts`
2. Checks for **Bun** (Amp's plugin runtime), offers to install it if missing
3. Writes HookBus settings to `~/.config/amp/plugins/hookbus.env` with mode `600`
4. Installs `amp-hookbus` and, when possible, a HookBus-managed normal `amp` shim

Run `amp` or `amp-hookbus`. The plugin reads its local env file; the installer does not write HookBus secrets into your shell profile.

## Requirements

- Amp CLI (`npm install -g @sourcegraph/amp`)
- **Bun** runtime — Amp's plugin API executes TypeScript plugins via Bun, so Bun must be on `PATH` when Amp launches. The installer offers to install Bun for you.
- A running HookBus endpoint (default `http://localhost:18800/event`)

## How it works

Amp exposes an experimental plugin API (gated by the `PLUGINS=all` env flag). Plugin files live in `~/.config/amp/plugins/*.ts` and must start with the literal comment `// @i-know-the-amp-plugin-api-is-wip-and-very-experimental-right-now`.

This plugin registers handlers for all 5 lifecycle events. Each handler:

1. Builds a canonical HookBus envelope (`event_id`, `event_type`, `source`, `session_id`, `tool_name`, `tool_input`, `metadata`)
2. POSTs to `HOOKBUS_URL` with bearer auth via `HOOKBUS_TOKEN`
3. Translates the consolidated bus verdict back into Amp's plugin response shape:
   - `allow` → `{ action: 'allow' }` (for `tool.call`)
   - `deny` → `{ action: 'reject-and-continue', message: reason }` (for `tool.call`)
   - `ask` → `{ action: 'reject-and-continue', message: reason + ' (resubmit)' }`
   - `context` on `UserPromptSubmit` → `{ message: { content, display: true } }` (injects text into the thread)

Fire-and-forget events (`session.start`, `tool.result`, `agent.end`) do not block but still publish for audit coverage.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `HOOKBUS_URL` | `http://localhost:18800/event` | HookBus endpoint |
| `HOOKBUS_TOKEN` | _(empty)_ | Bearer token for authenticated bus |
| `HOOKBUS_SOURCE` | `amp` | Source label on envelopes |
| `HOOKBUS_TIMEOUT_MS` | `30000` | HTTP timeout per event |
| `HOOKBUS_FAIL_MODE` | `open` | `open` allows the action when bus is unreachable; `closed` denies |
| `PLUGINS` | set by wrapper | Must be `all` for Amp to load plugins |

Get the bearer token from the bus container:

```bash
docker exec hookbus cat /root/.hookbus/.token
```

## Session correlation

The plugin captures Amp's `thread.id` from the `session.start` event and stamps every subsequent envelope with that ID as `session_id`, so subscribers can correlate all events from a given Amp thread.

## Envelope schema

Matches the canonical HookBus event schema. See [hookbus-spec](https://github.com/agentic-thinking/hookbus) for the full contract.

## Failure behaviour

If the bus is unreachable the plugin fails **open** by default — tool calls proceed and prompts pass through unflagged, so Amp is never bricked by a missing bus. Set `HOOKBUS_FAIL_MODE=closed` for regulated environments where missing governance must block the action.

## Trademarks & attribution

- **Amp** and **Sourcegraph** are trademarks of Sourcegraph, Inc. Used here nominatively to identify the tool this publisher integrates with. No affiliation with, endorsement by, or sponsorship from Sourcegraph is claimed or implied.
- **HookBus™** is a trademark (common-law) of Agentic Thinking Limited.
- Amp's plugin API is marked experimental/WIP upstream and may change without notice.

## Licence

MIT. Copyright © 2026 Agentic Thinking Limited. See [`LICENSE`](./LICENSE).

## Contributing

PRs welcome. Before submitting, sign the [CLA](./CLA.md) and review [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`COVENANT.md`](./COVENANT.md).

---

Built by [Agentic Thinking Limited](https://agenticthinking.uk) (UK Company 17152930). Contact: contact@agenticthinking.uk
