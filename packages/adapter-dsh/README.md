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
| Completion adjudication | `agent/turn-stopping` (serial) | A pure adjudicator returns one of six verdicts from a versioned task contract and host-verified evidence; a `resolveAudit` resolver builds that evidence from durable host events only |
| Context governance | library API (`ContextStore`, `AdmissionController`, `DependencyRetriever`) | Three-phase compaction transaction, recoverable archive index, ledger recovery, and admission control under a final-render token budget |

The evidence ledger is host-agnostic (`host: 'dsh'`), so the same evidence
chain can span DSH and the other IronLaw adapters.

### Evidence-based completion

The completion gate no longer asks "did a tool run this round". It asks whether
every applicable acceptance item of the current task has still-valid evidence.
The trusted boundary is a `resolveAudit` resolver that assembles its input from
durable host events only: the candidate body is compared to the agent's final
message as recorded, and one `host_verifier` proof is built per complete
`tool.call` / `tool.result` pair.

The task type is classified from the human request (`code`, `docs`, `ops`,
`research`, `discussion`), and each type is satisfied only by its own
host-observed artifact — a document write that answers the request, a delivered
response backed by an external source query, a state-changing entry point, or no
artifact at all for a discussion. No type borrows another's evidence, so a
passing test suite cannot close a documentation request, and a model calling its
work "discussion" cannot reclassify it.

A result counts as acceptance evidence only when the command is a
verification-class invocation whose exit code reaches the host unmasked. The exit
code is not in the session event stream: the plugin persists it from the
`tools/result` hook's canonical tool value, because a real ledger carries no
structured exit code at all (measured: zero of 37k records). Masking is judged per
shell dialect — POSIX treats `|`, `;`, `||` and newline as masking, PowerShell
only `;`, `||` and newline, because a PowerShell pipeline preserves the exit code
(`cmd /c exit 3 | Select-Object -Last 1` still reports failure, while
`cmd /c exit 3; Write-Host hi` returns 0). An unrecognized tool name gets the
stricter POSIX reading. `echo` verifies nothing, and `npm test || true` is
rejected because the trailing segment eats the exit code.

### Context governance

Compaction is treated as budget-constrained task-state management: a three-phase
transaction (`prepare` / `validate` / `commit`, with a rollback pointer), a
recoverable archive index, ledger recovery from the append-only log, and
admission control under a final-render token budget. An item that was just
evicted is not re-injected on a mere similarity hit. An offline four-strategy
harness compares dependency-driven retention against age, similarity, and length
baselines; on its synthetic fixture it reports `evidence_insufficient` rather
than claiming a production benefit.

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

The completion gate is on by default. It requires each applicable acceptance item
to carry still-valid host-observed evidence before the turn may close; otherwise
the agent is steered a repair prompt instead of finishing, up to a bounded number
of repairs. In `observe` mode (the default) it only steers; destructive tool calls
are additionally blocked in `enforcer` mode.

## Develop

```sh
npm install
npm run build      # tsc -> lib/
npm run typecheck
npm test           # build + node --test tests/*.test.js
```

Node.js 22+. The plugin is a function plugin (`name`/`inject`/`apply`) with no
runtime dependency beyond the DSH-provided `@deepseek-ai/cordis` context.

## License

MIT. IronLaw is an independent component; it is not affiliated with DeepSeek.
