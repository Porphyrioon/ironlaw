# @ironlaw/adapter-dsh

IronLaw on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

IronLaw is a DeepSeek Harness orchestration plugin. Built on ordinary coding
tooling (hooks / sidecar / MCP), it turns thousands of real engineering
pitfalls into three automated guardrails: block dangerous actions before they
run, record verifiable evidence as they run, and refuse "done" without proof.

This package is a **native Cordis plugin**, not an MCP bridge. It hangs off the
DSH extension points themselves.

## What it does

| Capability | DSH extension point | Behavior |
|---|---|---|
| Tool-call evidence | `tools/pre-execute`, `tools/result` | Records every tool call's intent and outcome to an append-only NDJSON ledger |
| Destructive-action blocking | `tools/pre-execute` (waterfall) | In `enforcer` mode, blocks destructive tools before they run |
| Durable session evidence | `session/event` | Appends every durable session event and tracks per-turn tool evidence |
| Completion gate | `agent/turn-stopping` (serial) | Before a turn closes, requires verifiable tool evidence; otherwise steers a repair prompt back to the agent |

The evidence ledger is host-agnostic (`host: 'dsh'`), so the same evidence
chain can span DSH and the other IronLaw adapters.

## Install

```sh
npm install --global @deepseek-ai/dsh
dsh plugin --profile web add @ironlaw/adapter-dsh
```

Or enable it as a one-off patch overlay without installing:

```sh
dsh web --patch "$PWD/cordis.patch.yml"
```

## Configuration

Configuration is read from the environment (the bundle patch stays minimal):

| Variable | Default | Meaning |
|---|---|---|
| `IRONLAW_MODE` | `observe` | `observe` records only; `enforcer` also blocks destructive tools |
| `IRONLAW_EVIDENCE_ROOT` | `~/.ironlaw` | Directory for the `events.ndjson` evidence ledger |
| `IRONLAW_DESTRUCTIVE_TOOLS` | built-in list | Comma-separated extra regex fragments to treat as destructive |

The completion gate is on by default. It requires a turn to produce at least
one successful tool result with no tool errors before it may close; otherwise
the agent is steered a repair prompt instead of finishing.

## Develop

```sh
npm install
npm run build      # tsc -> lib/
npm run typecheck
```

Node.js 22+. The plugin is a function plugin (`name`/`inject`/`apply`) with no
runtime dependency beyond the DSH-provided `@deepseek-ai/cordis` context.

## License

MIT. IronLaw is an independent component; it is not affiliated with DeepSeek.
