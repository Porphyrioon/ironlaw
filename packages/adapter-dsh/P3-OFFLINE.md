# P3 offline calibration and usage accounting

Run from repository root after building the adapter:

```powershell
npm.cmd run typecheck
npm.cmd test
node packages/adapter-dsh/scripts/calibrate.mjs
node packages/adapter-dsh/scripts/calibrate.mjs path/to/trace.json
```

The CLI imports the compiled package entry. Input is `{ provenance, slices: TraceSlice[] }`;
see `src/calibration.ts` and `fixtures/p3-trace.json`. The shipped two slices are synthetic
event histories, not sanitized production captures. A real historical dataset must supply
its own source reference and frozen oracle labels. There is no model call, online scorer,
host history replacement, or DROP_ACTIVE write in this harness.

## Frozen policy definitions and metrics

Every policy sees the same entries, cutoff, ordering signals and unit budget. Units are
explicit fixture sizes, NOT real tokenizer measurements. Do not compare runs with different
models, budgets, tools or cutoff points as a policy effect.

- Dependency: retain goal and constraint roots with transitive dependencies as one mandatory
  package; report configuration_unsatisfiable if it cannot fit. Then consider pending steps
  in supplied order, keeping each complete dependency package if it fits. Missing dependencies
  are reported, and incomplete packages are excluded. No labels from the oracle enter selection.
- Age: newest sequence first. Similarity: descending supplied ranking score (not probability).
- Length: shortest units first. Baseline ties use lexical ID; skip entries that do not fit.
  These deliberately naive offline deletion controls are NOT runtime constraint policies.

Each metric returns numerator, denominator and value (`null` for zero denominator):

- Constraint retention: selected labeled constraints / labeled constraints.
- State accuracy: exact value AND version matches / labeled state questions. Read latest
  retained sequence for each key; missing and wrong state both fail. This is deterministic
  record recovery, not a model comprehension score.
- Evidence recovery: readable matching ref AND version with all transitive dependencies
  selected / labeled evidence questions. Fixture `readable` is a frozen availability label;
  the separate retrieval tests exercise real archive bytes/digests.
- Critical deletion: excluded labeled critical entries / labeled critical entries. This
  measures simulated removal from active context, never deletion of original archives.

Micro aggregation sums numerators and denominators over slices. Differences are dependency
minus each baseline, in proportions; negative critical-deletion difference is favorable.
Output has no timestamp/randomness and includes the input SHA-256.

## Dependency retrieval

`DependencyRetriever(ContextStore).retrieve(session, index, signal, validate)` returns
found/original, missing, or not_loaded. A first load needs a dependency or explicit request;
later loads need a previously unseen dependency/request or a changed state digest. Similarity
never triggers loading. A host validator MUST check original source, scope, version and
signal references; never pass an unconditional validator in production. Consume failed
attempts too; recovery requires a fresh request or observed change. Session state persists
in the existing append-only ledger, serialized by a separate retrieval lock. A crashed lock
fails closed; automatic stale-lock removal is intentionally absent.

This is an opt-in compiled API, not a newly enabled DSH hook. Found text remains source data
and MUST pass the existing AdmissionController limits before model injection. P2 owns entry,
injection, active memory, rendered context and retrieval-chain budgets. No side-effect replay
callback exists. Known expiry/applicability checks belong to the trusted validator.

## Costs

`taskCost(taskId, calls, rates)` takes actual provider usage references and explicit normalized
input conventions. `input_tokens` always includes cached reads; `input_includes_write` says
whether writes are included. Uncached = input - cached - included writes. Negative residuals,
missing conventions and malformed usage fail. Duplicate call IDs with identical usage are
counted once; conflicting usage fails. Inputs must use one currency and one rate schedule;
split different model/rate schedules into separate accounting runs before summing costs.

Rates are currency PER TOKEN. Cached, uncached, write and output costs are disjoint; helpers
are ordinary calls with kind summary/retrieval, not an extra token category. Extra service
cost is added once. The report includes auxiliary-call count, retries, rework and sum of call
latencies (not elapsed wall time for parallel calls). Hit rate is cached / (cached + uncached
+ write), with both counts and the denominator definition. Entire tasks, including helpers
and retries, must be supplied; a single post-compact turn cannot prove whole-task savings.

## Experiment boundary

Current results are fixture regression evidence only. CI is null and production benefit is
`evidence_insufficient`: two deterministic synthetic slices are not independent full-task
samples, and zero observed critical loss does not establish zero risk or noninferiority.
No required noninferiority sample size is claimed without pilot discordance/variance and a
preselected power. A future study must freeze the -2 percentage point margin, paired task
sampling, power/sample-size analysis, 95% interval method and stopping rules BEFORE evaluation.
Run repeated full tasks with fixed model/tools/budget and stratify by adapter, task class and
actual compact count. Include existing, evidence-only, dedup/masking, summary/on-demand and
full-policy groups plus fixed-period versus budget/phase triggers. Report success, false
success/blocking, constraint loss, recovery, cost and latency; separate eviction, summary,
retrieval and comprehension failures. These are future experiment requirements, not completed
host benchmarks or deployment approval.
