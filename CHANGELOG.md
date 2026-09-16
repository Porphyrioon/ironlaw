# Changelog

## 0.1.0 (2026-09-16)

First release. `@ironlaw/adapter-dsh` ships as 0.1.0; `@ironlaw/cli` and `@ironlaw/memory`
remain at 0.1.0-alpha.1, since only the adapter went through this release's review rounds.

- `@ironlaw/cli`: OpenCode adapter (hooks + sidecar + installer), conservative
  pre-tool policy, completion audit, redaction.
- `@ironlaw/memory`: Git-backed, source-scoped shared memory MCP server with
  BM25 search and ACI injection.
- `@ironlaw/adapter-dsh`: DeepSeek Harness native Cordis plugin — host-side evidence and
  completion gate (`ironlaw/2.0-p2`): evidence ledger, per-task-type acceptance templates,
  host-checked prohibitions, per-file object versions, authenticated citations for research,
  bounded repair.
  Known limits recorded at release (see `research/context-compaction/IronLaw2.0-独立第五轮复核报告-ba2e0a0.md`):
  a relative prohibition whose object the host cannot resolve stays `unknown` and blocks until the
  object becomes checkable; research acceptance authenticates the sources a delivery cites but does
  not judge whether a conclusion follows from them; the evidence ledger grows without rotation.
