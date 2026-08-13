# IronLaw

IronLaw is a governance and evidence layer for coding agents: it records real
events, keeps verifiable evidence, and gates "done" on reproducible proof
rather than the model's own claims. A framework runs the agent; IronLaw proves
what the agent did and whether it actually finished.

## Packages

| Package | npm | Role |
|---|---|---|
| [`packages/cli`](packages/cli) | `@ironlaw/cli` | Plugin + sidecar + installer (`ironlaw`) |
| [`packages/memory`](packages/memory) | `@ironlaw/memory` | Git-backed, source-scoped shared memory MCP server |
| [`packages/adapter-dsh`](packages/adapter-dsh) | `@ironlaw/adapter-dsh` | DeepSeek Harness native Cordis plugin (evidence + enforcer blocking + completion gate) |

## Quick start

```sh
npm install
npm test
```

See each package's README for install and framework-specific setup.

## Frameworks

| Framework | Adapter status |
|---|---|
| DeepSeek Harness (DSH) | native Cordis plugin implemented (evidence + enforcer blocking + completion gate) |
| OpenCode | hooks + sidecar implemented |
| Claude / Grok / Codex / Qoder / Zcode | detected, adapter planned |

## License

MIT. IronLaw is an independent component; it is not affiliated with any coding
framework or model vendor.
