# IronLaw Plugin

> Turn tens of thousands of hard-won lessons from real engineering sessions into delivery discipline, enforced outside the coding assistant.  
> One host-agnostic layer for every coding assistant; it only cares about three things: less rework, no drift, no reward-hacked fake "done".

## What it is

IronLaw is not a new coding assistant, and it is not a re-implementation of OpenCode. It is an efficiency-engineering component that sits outside the coding assistant:

```text
DeepSeek Harness / OpenCode / Claude / Grok / Zcode / Codex / Qoder / other thin-shell assistants
          │
          └── IronLaw layer: task constraints, factual evidence, completion gate, bounded repair
```

It starts from failure patterns that recur across tens of thousands of engineering sessions: the model is usually capable, but often lacks an external mechanism that keeps constraining it through a long task. IronLaw does not try to turn one model into another; it turns the task process into a verifiable engineering process.

Users keep their original GUI, provider, model, tools, and workspace. IronLaw does not require switching workbenches or understanding MCP; the launch shape is a unified CLI installer, a unified sidecar kernel, and thin per-host plugin/hook adapters.

```bash
npx @ironlaw/cli install --host opencode
```

After install, the user keeps using the host normally. IronLaw records facts, checks task state, and reminds, blocks, or requests a minimal repair when needed. What is described here is an observable mechanism, not a guarantee about any model, host, or task outcome.

## Why it is a Plugin, not a Skill or an MCP server

To understand IronLaw's integration shape, first separate the responsibilities of Router, Skill, MCP, and Plugin:

```text
User input
   │
   ▼
Router: choose Agent / Provider / Model / Skill
   │
   ▼
Agent + Skill: understand the task, plan steps, propose tool calls
   │
   ▼
OpenCode Runtime: actually executes tools, writes files, runs commands, ends the session
   │
   └──── IronLaw Plugin: observe, constrain, audit, repair
                         │
                         ▼
                    ironlawd sidecar
```

### Skill: a carrier of methodology, not an enforcement boundary

A Skill is good at freezing "how it should be done": checklists, code style, a framework's workflow, prompt templates for a class of tasks. A Router can select and load a Skill for the agent by task.

But a Skill still lives inside the model context:

- the model may not select it, or may follow it only partially;
- it may be dropped or overwritten after compaction;
- it cannot confirm whether a command actually ran;
- it cannot read an independent workspace fingerprint or artifact hash;
- it cannot hard-block a dangerous action before the tool runs;
- it cannot grant trustworthy evidence to "done".

So IronLaw's rules can be borrowed by a Skill, but IronLaw itself must not ship as a Skill. A Skill is the advice layer; IronLaw solves process control and delivery adjudication.

### MCP: a model-callable capability, not an external supervisor

MCP is good at giving the model search, databases, external APIs, or human-query capabilities. The model sees the tool schema and decides whether to call it.

That is not the right main path for IronLaw:

- tool descriptions and schemas add context tokens;
- the model may simply not call the governance tools;
- what the model calls and reports can still be dressed up as self-reported material;
- MCP does not natively own the host's full session/tool/permission/compaction lifecycle;
- it cannot reliably stop a tool call the host is already about to execute.

So MCP can serve as a future human-query interface — viewing reports, approving pending actions — but it cannot carry IronLaw's completion gate.

### Plugin: the only thin layer suited for host-level governance

A Plugin runs inside OpenCode's host lifecycle and can see the messages, tools, permissions, files, and session events that actually happen after the Router. It can:

- check and block before a tool executes;
- record the real return value after a tool executes;
- inject a short task anchor at message request or compaction time;
- trigger a completion audit after session idle;
- hand facts to an independent sidecar instead of letting the model grade itself.

So the relationship is:

```text
Router  decides who gets the task, with what model and Skill
Skill   decides what method the model should use
MCP     decides which external capabilities the model may call
Plugin  decides what actually happened on the host, which actions may continue, and whether it really finished
```

IronLaw does not fight Router for routing, Skill for methodology, or MCP for the tool ecosystem. It fills the delivery-control surface none of the three own: less rework, no drift, and catching reward-hacked fake completion. This describes the plugin's mechanism and observation boundary, not an outcome guarantee.

## The three core goals

### 1. Less rework

Make every execution round aim at the final delivery, instead of first building a "looks like it runs" minimal frame and then having the user backfill spec, tests, build, and deployment. IronLaw uses a Task Contract, requirement-evidence mapping, and delivery-chain checks to surface rework risk as early as possible.

### 2. No drift

Make the model return to the original spec after context compaction, long execution, and handoffs, instead of treating an adjacent problem as the new goal. IronLaw keeps the original requirements, constraints, and allowed scope, and corrects with a short anchor when drift is detected.

### 3. Catch reward-hacked fake "done"

Natural-language claims like "tests passed", "build done", or "already fixed" are not accepted as delivery facts. IronLaw requires independent evidence from tool events, exit codes, file changes, workspace fingerprints, real builds, and the final journey. When evidence is insufficient, the task can only be unverified, pending-repair, or failed — never "done".

## Why these three keep happening

### A green test does not mean shippable

A test command exiting 0 only means one command ended successfully. It does not prove:

- the test actually covers the original requirement;
- the real path was not replaced with a mock;
- it is not the wrong test subset or an empty test;
- the source did not change again after the test passed;
- the build artifact really exists and starts;
- the install, deploy, relaunch, or delivery journey the user asked for is complete.

This is exactly where reward hacking happens: the model optimizes "make the current check pass" without delivering what the user actually wants. IronLaw judges "test passed" and "delivery complete" separately.

### Minimal frame, shortest path, usually means more rounds of rework

The model tends to pick the shortest-looking path: write a minimal frame first, get the tests green first, produce an intermediate artifact first. That looks efficient in the short term, but may drop constraints, move boundaries, or bypass the final user journey — and the user ends up re-specifying, re-testing, and re-packaging.

IronLaw does not forbid a reasonable minimal implementation; it requires the implementation path to keep mapping to the original spec and final acceptance items. An action that does not shrink the delivery gap is not valid progress. The point is not to make the model write more code, but to reduce the "finished one round, tear it down, redo it" rework.

### Mid-to-long tasks drift after compaction

After context compaction, long tool runs, and several handoffs, the model may forget the original goal and start solving an adjacent problem nobody asked for. The model's todo, handoff, or "I remember the user wanted…" cannot replace the original task.

IronLaw keeps the original task contract and injects a very short task anchor only when actually needed — not repeating the whole history every round. The anchor's job is to hold the boundary, not to stuff a new long prompt back into the model.

### The model can claim it did something it never did

"Tests passed", "build completed", "files updated" are just model text. If the event stream has no matching tool call, exit code, file change, or artifact hash, these are only claims awaiting verification — not completion evidence. This is IronLaw's direct defense against reward hacking: the model may report, but it cannot issue its own delivery certificate.

### The task keeps going forever after it is done

Without an external completion boundary, the model may keep reasoning, re-editing, or casually expanding scope after reporting, spending tokens without adding delivery value.

IronLaw turns continuation into a conditional, counted, must-make-progress repair action; with no new evidence or no hard gap closed, auto-continuation stops.

## What IronLaw does, in plain words

| What the user sees | Mechanism behind it | What it mainly prevents |
|---|---|---|
| Remembering what the task really asked | Task Contract, original-input hash, task anchor | spec drift, forgetting the goal after compaction, handoff rewriting the requirement |
| Knowing whether the model actually did it | Event Ledger, tool events, exit codes, file and Git facts | self-reported completion, fabricated tests, imaginary commands |
| Not mistaking a green light for delivery | CompletionGate, requirement-evidence mapping, delivery-chain check | test passed but not shippable, build missing artifacts, only intermediate files made |
| Stopping dangerous actions first | deterministic Policy Engine, workspace-boundary checks | out-of-scope deletion, dangerous Git operations, unauthorized publish |
| Detecting drift or spinning | Drift Score, progress detection, gap-delta comparison | long-range deviation, repeated edits, useless loops |
| Repairing only the smallest gap when continuing | bounded Repair Loop, repair fingerprint, budget cap | endless "one more thing", infinite continuation, useless retries |
| A broken plugin doesn't take down the host | sidecar watchdog, capability handshake, degradation strategy | plugin failure making OpenCode unusable |

## Technical principles

### 1. An external state machine, not a hidden second Leader

IronLaw does not have another large model review the worker every round. It puts a single-agent task into a finite state machine outside the model:

```text
OBSERVING
    ↓ code task recognized
ACTIVE
    ↓ model stops / claims done
VERIFYING
    ├─ all hard acceptance has valid evidence → VERIFIED
    ├─ gap is repairable                    → REPAIR_REQUIRED
    ├─ dangerous or out-of-scope action     → BLOCKED
    └─ budget exhausted / no progress       → FAILED_UNVERIFIED
```

The model cannot write the task directly to `VERIFIED`; the todo cannot write it directly to `VERIFIED`; a single command exiting 0 cannot write it directly to `VERIFIED`. Only the CompletionGate may grant delivery status.

### 2. Evidence ledger and evidence grades

Every evidence record stores its source, time, workspace fingerprint, command summary, and related acceptance items. Once evidence is produced, if the related source file changes again, the old evidence is automatically invalidated.

```text
E0  model natural-language claim of completion
E1  todo / handoff / self-reported file list
E2  OpenCode tool call and its return value
E3  sidecar's independent file, Git, command, and hash checks
E4  sidecar's real test, build, launch, relaunch, and artifact checks
```

E0 and E1 cannot be upgraded into E3/E4. A typical reward-hack path is: modify the test so it passes, run only the wrong subset, claim a command ran, or only generate a config file. IronLaw breaks these into fact checks instead of accepting the model's summary.

### 3. A requirement-evidence graph, not a single test switch

The original task is decomposed into hard acceptance items, prohibitions, allowed scope, and expected evidence. Completion is checked item by item along the delivery chain:

```text
requirement mapping
  → implementation change
  → valid test
  → real build/launch
  → user journey
  → persistence/relaunch
  → final artifact
```

If any hard link is missing, the state is incomplete or blocked — not "passed with reservations".

### 4. Low-cost re-anchor and drift detection

IronLaw does not re-inject the whole spec every round. It injects a ~200–400 token task capsule at task establishment, context compaction, evidence expiration, or obvious drift:

```text
[IronLaw task anchor]
Objective: fix login-state loss after refresh.
Open requirements: AC-2 expired-token error; AC-3 real refresh journey.
Constraints: don't swap the auth framework; never claim an unrun test passed.
Current evidence: unit=pass; build=stale; journey=missing.
Completion rule: all hard acceptance must have valid evidence before reporting done.
```

The drift score only triggers a reminder or a blocking policy; it is not completion evidence. Signals include: edits unrelated to open acceptance items, repeated edits with no new evidence, the goal disappearing after compaction, handoff conflicting with the original spec.

### 5. Bounded repair and cost control

Auto-repair is not a vague "keep trying"; it only sends the current smallest gap:

- at most 1 round by default;
- at most 2 rounds in later Managed mode;
- each round must close at least one hard gap;
- the same decision fingerprint must not continue twice;
- stop immediately on user stop, budget exhaustion, or no progress;
- repair messages carry an anti-recursion marker and never re-create the task.

So IronLaw's goal is not to make every task run more rounds, but to use a small fixed overhead to reduce the manual rework after a whole task fails.

### 5.1 Sidecar/subprocess lifecycle guardrails (not multi-agent seats)

"Subprocess" here only means the plugin sidecar or an OS process the host explicitly starts — not another agent, and not a Leader/Worker seat. The plugin does not create multi-agent setups, assign seats, or dispatch roles. What must be prevented is the same session / same external start request pulling up processes repeatedly, and children outliving a dead parent, accumulating large numbers of Bun/OpenCode processes.

So the unified kernel must treat sidecar/subprocess lifecycle as a P0 problem:

- every start binds a `lease_id`, parent process, session, start time, and task budget;
- the same `handoff_id` is idempotent and must not start twice;
- every IronLaw-managed subprocess has a wall-clock TTL, an idle TTL, and a max retry count;
- reclaim the child tree when the parent exits, heartbeat is lost, or the task enters a failed state;
- check for an existing active lease for the same project/session before starting;
- `status` shows active leases, orphan leases, and cumulative CPU and memory;
- `doctor --workers` lists and safely reclaims subprocesses IronLaw itself started;
- never kill by the global `bun` name; identify precisely by lease, command summary, and parent-child relation.

This machine once accumulated 25 running `opencode run --format json --pure` subprocesses, roughly 2 GB of memory; that class of incident outranks any new host adapter. Without lifecycle guardrails, the plugin's own runtime would create rework and cost problems.

### 6. Hook + sidecar, not MCP by default

The OpenCode plugin receives host events, runs fast pre-policy checks, and injects short anchors; the local sidecar owns the state machine, evidence ledger, workspace checks, and completion audit.

```text
OpenCode GUI / Provider / Agent
            │
      IronLaw Plugin
            │ stdio NDJSON
            ▼
       ironlawd sidecar
```

The launch does not register a dozen governance tools with the model. This avoids a fixed MCP-schema token tax, and avoids handing the "is it done" judgment to the model's voluntary tool calls. MCP may later serve as a human-query or cross-host compatibility interface, but it is not the launch main path.

### 7. Turning the "iron rules" into executable algorithms

The iron rules discussed in the Hackathon design are not another longer system prompt; they become executable orchestration algorithms:

| Methodology | Technical expression in the layer | Problem it solves |
|---|---|---|
| VDDG entropy reduction | intent compilation, Task Contract, requirement-evidence mapping | divergent input, vague goal, shortest-path misreading of the requirement |
| boundary conservation | allowed scope, must/must-not, tool pre-policy | task boundary widened, handoff rewriting the original requirement |
| loop control | finite state machine, progress scoring, repair budget, idempotent fingerprint | long-range spinning, repeated edits, endless continuation |
| evidence conservation | event sourcing, evidence grades, workspace hash, stale invalidation | self-reported results passing as facts, stale tests passing as new evidence |
| controlled entropy increase | constrained exploration and candidate comparison | chasing only the shortest path, executing without arguing it through |

The launch unified kernel implements the first four as a single-agent closed loop; controlled entropy increase, model certification, and multi-agent collaboration belong to other components, outside this plugin's committed scope.

### 8. Not every model gets the same guardrail

The long-term direction is to extract model behavior labels from real engineering sessions — tendency to skip steps, tool-call accuracy, boundary awareness, sycophantic output, long-range stability. Labels are not for scoring or showing off; they let the orchestration layer choose different task granularity, checkpoints, and review intensity.

This layer is called `CertifyGate`. For now it only keeps the interface and research conclusions; it is not a hidden model-evaluation service in the current plugin, and it does not add extra model calls by default.

## Multi-host usage

The launch is designed host-agnostic: the unified kernel connects through host adapters. Currently implemented: OpenCode (hooks + sidecar) and DeepSeek Harness (native Cordis plugin: evidence recording + destructive-action blocking + completion gate). Claude, Grok, Zcode, Codex, Qoder, and other hosts with verifiable hooks are in the launch support surface, but each host must separately pass its capability probe and acceptance matrix. Hosts without hooks are not in the launch support commitment.

What about hosts without hooks? The launch does not fake them as integrated. The README and CLI only provide a copyable minimal MCP toolset prompt, which the user forwards to that host's agent themselves:

```text
For this task, use the IronLaw MCP minimal toolset:
1. il_status — read current task state before starting;
2. il_check — submit a check before each change or dangerous command;
3. il_report — before finishing, submit the commands actually run, exit codes, and open items.
Do not treat tool returns or natural-language claims as delivery evidence; mark unrun checks as unrun.
```

This is only a user-forwarded operating guide, not a host adapter, not automatic injection, and not launch feature support. Only hosts that provide verifiable hooks enter the IronLaw launch adapter matrix.

```bash
npx @ironlaw/cli install --host opencode
npx @ironlaw/cli install --host claude
# DeepSeek Harness native plugin:
#   npm install --global @deepseek-ai/dsh
#   dsh plugin --profile web add @ironlaw/adapter-dsh
npx @ironlaw/cli doctor
npx @ironlaw/cli status
npx @ironlaw/cli report --last
npx @ironlaw/cli uninstall --host opencode
```

Product modes:

- `Observe`: record sessions, tasks, and evidence; no injection, no blocking, no continuation;
- `Guarded`: enable dangerous-action blocking, task anchor, completion gate, and one minimal repair;
- `Managed`: two-round repair and an optional verifier, considered later.

For unknown versions, failed capability probes, or a host that has not passed real acceptance, only `Observe` is allowed; writing config must not be passed off as enabled orchestration.

## Where it sits in efficiency engineering

IronLaw is one foundational component of efficiency engineering, focused on "does the task get delivered correctly in one shot" — not a complete coding-assistant product.

Around it, a larger efficiency-engineering component system can form:

```text
ideation
  → argumentation
  → planning
  → execution
  → review
  → delivery
```

Possible other components include:

- custom coding tools for specific languages, frameworks, deployment environments, and enterprise standards;
- UnionAgents: a multi-agent workbench for role collaboration, task dispatch, and result merging;
- an A2A protocol for exchanging tasks, state, and evidence between agents, tools, and workbenches;
- workflow components that freeze the ideation/argumentation/planning/execution/review methodology;
- team-facing reports, metrics, replay, and engineering knowledge bases.

This system can be read as one complete working-method chain:

```text
ideation → argumentation → planning → execution → review → delivery
  │           │              │          │          │
  └─ controlled entropy ─────┴─ VDDG/boundary conservation ─┴─ IronLaw completion gate
```

These are other directions in the efficiency-engineering ecosystem, not part of this plugin's committed scope. Currently only the IronLaw Plugin, the unified CLI/protocol prototype, and its necessary local sidecar are open-sourced; whether and when other components go public depends on the Hackathon judges' conclusion and later product boundaries.

## Relationship to the Hackathon entry

The current open-source plugin and the Hackathon entry are two clearly separated deliverables:

- IronLaw Plugin is a host-external, general delivery-governance layer;
- it does not replace, bundle, or copy the Hackathon entry;
- it does not depend on the entry's private code, data, or runtime;
- it can be installed, uninstalled, and verified independently;
- the arrangement for later multi-agent workbench, A2A protocol, and methodology components waits on the judges' conclusion.

## Current open-source scope

This release publishes one monorepo (npm workspaces) with three npm packages:

```text
ironlaw/
├── packages/cli/          # @ironlaw/cli: install / doctor / status / host-agnostic sidecar kernel
├── packages/memory/       # @ironlaw/memory: Git-versioned shared memory MCP
└── packages/adapter-dsh/  # @ironlaw/adapter-dsh: DeepSeek Harness native Cordis plugin
```

The monorepo's full test suite currently passes 32 tests (cli 6 + memory 13 + adapter-dsh 13). This is protocol, local-sidecar, and DSH-plugin prototype evidence only; it does not mean every host, version, provider, or task outcome is accepted, and it is not a delivery guarantee to users.

## How to judge whether the project succeeds

Success is not "the model outputs more" or "more green tests". It is:

| Metric | Meaning |
|---|---|
| first-pass delivery rate | share of tasks passing all real acceptance on the first run |
| fake-completion rate | share of tasks the model claims done but hard acceptance fails |
| spec-drift rate | share of final implementations violating or omitting the original requirement |
| effective task cost | total provider cost / number of `VERIFIED` tasks |
| extra-token ratio | IronLaw's token increase relative to baseline |
| repair-round yield | real acceptance gap closed by auto-repair |
| false-block rate | share of legitimate tool calls IronLaw wrongly blocks |

If the layer only makes reports look more complete without raising real delivery rate, lowering fake-completion rate, or reducing rework, it should not keep stacking more orchestration roles.

