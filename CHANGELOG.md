# Changelog

## 0.1.1 (2026-09-16)

Patch release for `@ironlaw/adapter-dsh`, from defects the live host exposed after 0.1.0 — every one
of them only reachable with real sessions, all with a test and a killed mutation.

- A passing run whose captured files moved, in a revision that has no run of its own, was reported as
  `verification_failed` ("the run failed, fix it") although nothing had failed. The reason is now
  decided by the newest verification the host saw: passed → `evidence_superseded`, stale →
  `evidence_stale`, failed → `verification_failed`, none → `evidence_missing`.
- A host-reported failure with no exit code was reported as `evidence_missing`, i.e. as no run at all.
- The refusal for an unconfirmed prohibition fell back to a generic sentence that never mentioned a
  prohibition; it now says what the host saw (an observed write to the named object, or that it
  cannot check that object) and what to do.
- A research proof carried the search call's own file capture instead of the delivery's identity, so
  every research turn on a real host ended `evidence_stale` and could never close.
- The same defect existed in the ops template; `defaultResolveAudit` now stamps every proof with the
  digest the audit compares against, so the invariant holds by construction.
- Repair guidance for "no evidence" is chosen by task type (a deploy is no longer told to run the
  test suite, a document task is no longer told to run tests, a research task is told to consult a
  source the host can observe); the four reasons that had no line of their own now have one.
- Packaging: `files` names the compiler's outputs instead of the whole `lib` directory (a mutation
  run's `.mutbak` leftovers had shipped in the tarball), and `prepack` rebuilds. README (both
  languages): masking lists `&` in both dialects, test counts and probe history current.

Known limits carried from the 0.1.0 release: a relative prohibition whose object the host cannot
resolve stays `unknown` and blocks until the object becomes checkable (the arbiter accepted this
conservatism); research acceptance authenticates the sources a delivery cites but does not judge
whether a conclusion follows from them; the evidence ledger grows without rotation.

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
