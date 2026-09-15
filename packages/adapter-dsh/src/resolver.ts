import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import type { EvidenceLedger, EvidenceRecord } from './evidence.js'
import { objectVersionDigest } from './fingerprint.js'
import type { AuditInput, Candidate, HardConstraintCheck, Status, TaskContract, Verification } from './audit.js'

/**
 * Trusted host integration boundary. Assembles the audit input from durable host
 * events only — never from the candidate body or any model/summary self-report.
 *
 * Safety invariants (hard):
 * - A record whose `source_kind` is `model`/`summary` is never promoted to
 *   `host_verifier` proof.
 * - Without trusted host evidence the resolver stays `unknown`/incomplete; it
 *   never manufactures a passing verdict.
 * - Evidence requirements are not weakened to "make it pass".
 */
export interface ResolveAuditContext {
  session_id: string
  turn: number
  task: TaskContract
  response: string
  records: EvidenceRecord[]
  recovery: ReturnType<EvidenceLedger['recover']>
}

const COLLECTOR_VERSION = 'ironlaw/2.0-p1'
const sha256 = (v: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`
const dataOf = (r: EvidenceRecord | undefined): any => (r?.payload as any)?.data ?? {}

/** Re-derive the assistant body from the durable record, mirroring the host capture in index.ts. */
function assistantText(payload: unknown): string {
  const content = (payload as any)?.data?.message?.content
  return (Array.isArray(content) ? content : [])
    .filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
}

/** A model/summary-sourced record is self-report, never host proof. */
function modelSourced(r: EvidenceRecord | undefined): boolean {
  return r?.source_kind === 'model' || r?.source_kind === 'summary'
}

/**
 * Affected file paths: DSH diff metas (mutations report `card:'diff'` with
 * `diffs[].path`) plus write/edit call arguments. Reads/searches carry no
 * mutation path, so they do not enter the object scope.
 */
function affectedPaths(records: EvidenceRecord[]): string[] {
  const paths = new Set<string>()
  for (const r of records) {
    const data = dataOf(r), meta = data.meta
    if (meta && typeof meta === 'object') {
      if (meta.card === 'diff' && Array.isArray(meta.diffs))
        for (const d of meta.diffs) if (typeof d?.path === 'string') paths.add(d.path)
      if (Array.isArray(meta.locations))
        for (const l of meta.locations) if (typeof l?.path === 'string') paths.add(l.path)
    }
    if (r.type === 'tool.call' && typeof data.arguments === 'string') {
      try {
        const args = JSON.parse(data.arguments)
        for (const k of ['path', 'file_path', 'filePath', 'target', 'filename', 'file'])
          if (typeof args?.[k] === 'string') paths.add(args[k])
      } catch { /* unparsed arguments carry no reliable path */ }
    }
  }
  return [...paths]
}

/** Real digest over affected, readable files (includes uncommitted bytes); conservative empty when scope is unknown. */
function computeObjectDigest(records: EvidenceRecord[]): string {
  const paths = affectedPaths(records).filter(p => { try { return existsSync(p) } catch { return false } })
  if (!paths.length) return ''
  try { return objectVersionDigest(paths) } catch { return '' }
}

/** Environment descriptor from observable host facts; non-empty for any real session. */
function computeEnvironmentDigest(ctx: ResolveAuditContext): string {
  const header = ctx.records.filter(r => r.type === 'session.request/header').at(-1)
  return sha256({ host: 'dsh', session_id: ctx.session_id, collector_version: COLLECTOR_VERSION,
    request: dataOf(header)?.header?.config ?? null })
}

/** Trusted host confirms applicability: `unknown` → `applicable`; authorized exclusions are left untouched. */
function withConfirmedApplicability(task: TaskContract): TaskContract {
  return { ...task, requirements: task.requirements.map(r =>
    r.applicability === 'unknown' ? { ...r, applicability: 'applicable' as const } : r) }
}

/** Pull the shell command string out of a tool call's arguments (string, or object/array under a common key). */
function commandText(callData: any): string {
  const raw = callData?.arguments
  let parsed: any = raw
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw) } catch { parsed = raw } }
  if (typeof parsed === 'string') return parsed
  if (parsed && typeof parsed === 'object') {
    for (const k of ['command', 'cmd', 'script', 'shell', 'code', 'commands', 'input']) {
      const v = parsed[k]
      if (typeof v === 'string') return v
      if (Array.isArray(v)) return v.filter((x: any) => typeof x === 'string').join(' && ')
    }
  }
  return ''
}

/** Shell control operators, longest-first so `&&`/`||` are not split into `&`/`|`. */
const SHELL_OPS = /&&|\|\||[;|\n]/g
/**
 * Connectors after which the preceding segment's exit code can be eaten by a
 * later segment, so the host's aggregate exit no longer reflects the verifier:
 * `||` (successor runs on failure and its exit wins), `;` and newline (successor
 * always runs and its exit wins), `|` (pipeline exit is the last element's).
 * `&&` is deliberately absent: a failure short-circuits and propagates.
 */
const MASKING_CONN = new Set(['||', ';', '|', '\n'])
/** Split a command line into segments and the connector that joins each pair. */
function splitShellSegments(cmd: string): { segs: string[]; conns: string[] } {
  const segs: string[] = [], conns: string[] = []
  const re = new RegExp(SHELL_OPS.source, 'g')
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) { segs.push(cmd.slice(last, m.index)); conns.push(m[0]); last = m.index + m[0].length }
  segs.push(cmd.slice(last))
  return { segs, conns }
}
/** Leading wrappers that do not change which program ultimately runs. */
const LEAD_STRIP = /^(?:sudo\s+|command\s+|npx\s+|pnpm\s+dlx\s+|yarn\s+dlx\s+|\.\.?\/|[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/
/**
 * Verification-class invocations, anchored at a segment's program verb. A bare
 * `test`/`build`/`check` word is NOT matched (only as a runner subcommand), so
 * `cat test.js` or `echo "npm test"` never classify. The set is deliberately
 * conservative: an unlisted or ambiguous verb fails closed (not verification).
 */
const VERIFIER_PATTERNS: RegExp[] = [
  /^(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check|tsc)(?:[\s:]|$)/,
  /^node\s+(?:\S+\s+)*--test(?:\s|$)/,
  /^deno\s+(?:test|check|lint|fmt)(?:\s|$)/,
  /^(?:pytest|jest|vitest|mocha|ava|tape|cypress|playwright|karma|jasmine|codecept|phpunit|rspec|rubocop|ctest|tox|nox)(?:\s|$)/,
  /^(?:tsc|eslint|stylelint|biome|tslint|golangci-lint)(?:\s|$)/,
  /^(?:mypy|pyright|ruff|flake8|pylint|bandit)(?:\s|$)/,
  /^(?:prettier|black|isort)\s+(?:\S+\s+)*--check\b/,
  /^go\s+(?:test|vet|build)(?:\s|$)/,
  /^cargo\s+(?:test|build|clippy|check|fmt)(?:\s|$)/,
  /^make\s+(?:test|check|lint|build|verify)(?:\s|$)/,
  /^mvn\s+(?:test|verify|compile|check|validate)(?:\s|$)/,
  /^(?:gradle|gradlew)\s+(?:test|build|check|lint|verify)(?:\s|$)/,
  /^dotnet\s+(?:test|build)(?:\s|$)/,
  /^swift\s+test(?:\s|$)/,
  /^python[0-9.]*\s+(?:-m\s+)?(?:pytest|unittest|nose2?)(?:\s|$)/,
]

/**
 * True only when the command reliably runs a verification tool AND that tool's
 * exit code reaches the host's aggregate exit unmasked. Splits on shell operators
 * and matches each segment's leading verb, so irrelevant commands (echo/ls/cat/
 * reads/prints) and unparseable commands return false (fail closed). A verifier
 * followed by `||`/`;`/`|` (or preceded by `||`) can yield aggregate exit 0
 * despite a real failure, so it also returns false. `&&` neighbours are kept:
 * a failure short-circuits and propagates to the aggregate exit.
 */
function isTrustworthyVerification(cmd: string): boolean {
  if (!cmd || !cmd.trim()) return false
  const { segs, conns } = splitShellSegments(cmd)
  const norm = segs.map(s => s.trim().replace(LEAD_STRIP, '').trim())
  const verifiers = norm.map((s, i) => (s && VERIFIER_PATTERNS.some(re => re.test(s)) ? i : -1)).filter(i => i >= 0)
  if (!verifiers.length) return false
  return verifiers.every(v => {
    for (let i = v; i < conns.length; i++) if (MASKING_CONN.has(conns[i])) return false
    return !(v > 0 && conns[v - 1] === '||')
  })
}

/**
 * One `host_verifier` proof per complete call/result pair from the ledger.
 * - A half pair (call or result alone) is skipped: it stays unknown, never proof.
 * - A model/summary-sourced record is skipped: self-report is never proof.
 * - Shell/command results are judged by exit code (`card:'terminal'`); anything
 *   without a trusted success signal stays `unknown` with `assertion_passed:null`.
 * - Only a verification-class command (test/build/lint/typecheck runner) may
 *   associate with acceptance requirements. An irrelevant exit-0 command
 *   (echo/ls/cat/read/print) records its honest outcome but claims no
 *   requirement, so it can neither verify nor shadow a real verification
 *   (spec §12 A05: echo/unrelated writes do not satisfy acceptance).
 * - A verification command whose exit code is masked by a later `||`/`;`/`|`
 *   segment (or preceded by `||`) is also rejected, so `npm test || true` cannot
 *   pass off a failing test as success; `&&` neighbours are kept (failure propagates).
 * - Association also requires a determinate (passed/failed) status, so an
 *   indeterminate record never claims a requirement either.
 */
function buildEvidence(ctx: ResolveAuditContext, task: TaskContract, objectDigest: string, envDigest: string): Verification[] {
  const applicableIds = task.requirements
    .filter(r => r.class === 'acceptance' && r.applicability === 'applicable')
    .map(r => r.requirement_id)
  const out: Verification[] = []
  for (const c of ctx.recovery.calls) {
    if (!c.call || !c.result) continue
    if (modelSourced(c.call) || modelSourced(c.result)) continue
    const resultData = dataOf(c.result), callData = dataOf(c.call)
    const toolName = typeof callData.name === 'string' ? callData.name : 'unknown'
    const meta = resultData.meta
    const terminal = !!meta && typeof meta === 'object' && meta.card === 'terminal'
    const exitCode = terminal && typeof meta.exitCode === 'number' ? meta.exitCode : null
    const hostFailed = c.result.result_status === 'failed' || c.status === 'failed'
    let status: Status, assertionPassed: boolean | null, requiresExitCode = false
    if (hostFailed) { status = 'failed'; assertionPassed = false }
    else if (terminal && exitCode !== null) { requiresExitCode = true; assertionPassed = exitCode === 0; status = exitCode === 0 ? 'passed' : 'failed' }
    else { status = 'unknown'; assertionPassed = null }
    const determinate = status === 'passed' || status === 'failed'
    // Relevance + anti-masking gate: only an unmasked verification-class command speaks to acceptance.
    const verifiesAcceptance = terminal && isTrustworthyVerification(commandText(callData))
    out.push({
      event_id: `verify:${c.result.event_id}`,
      task_id: c.result.task_id ?? task.task_id,
      objective_revision: c.result.objective_revision ?? task.objective_revision,
      requirement_ids: verifiesAcceptance && determinate ? applicableIds : [],
      object_version_digest: objectDigest, environment_digest: envDigest,
      status, complete: true, source_kind: 'host_verifier',
      verifier_ref: `dsh-tool:${toolName}:${c.tool_call_id}`,
      output_ref: c.result.output_ref ?? c.result.event_id,
      tool_call_id: c.tool_call_id, exit_code: exitCode,
      requires_exit_code: requiresExitCode, assertion_passed: assertionPassed,
    })
  }
  return out
}

/**
 * Hard constraints are listed one-by-one. The host cannot confirm compliance of
 * an arbitrary hard requirement from tool events alone, so each stays `unknown`
 * and fails closed (`hard_constraint_unconfirmed`) rather than being asserted
 * compliant without trusted proof.
 */
function buildHardChecks(task: TaskContract): HardConstraintCheck[] {
  return task.requirements.filter(r => r.class === 'hard').map(r => ({
    requirement_id: r.requirement_id, applicability: r.applicability,
    status: 'unknown' as const, check_ref: `host:hard:${r.requirement_id}`,
  }))
}

export function defaultResolveAudit(ctx: ResolveAuditContext): Omit<AuditInput, 'previous'> {
  const task = withConfirmedApplicability(ctx.task)
  const objectDigest = computeObjectDigest(ctx.records)
  const envDigest = computeEnvironmentDigest(ctx)
  const evidence = buildEvidence(ctx, task, objectDigest, envDigest)

  // Host-side check: the candidate body must equal the agent's final message as
  // durably recorded. No recorded message → unknown (fails closed).
  const assistant = ctx.records.filter(r => r.type === 'session.assistant/message').at(-1)
  let candidateCheck: AuditInput['candidate_check']
  if (!assistant) candidateCheck = { status: 'unknown', source_ref: '' }
  else candidateCheck = assistantText(assistant.payload) === ctx.response
    ? { status: 'consistent', source_ref: assistant.event_id }
    : { status: 'contradictory', source_ref: assistant.event_id }

  const candidate: Candidate = { claims_success: true, response_kind: 'final_delivery', text: ctx.response, requirement_claims: [] }
  const responseSeq = (assistant?.payload as any)?.seq ?? -1
  return {
    request_id: `${ctx.session_id}:${ctx.turn}:${responseSeq}`,
    task, candidate, candidate_check: candidateCheck, evidence,
    hard_constraints_checked: buildHardChecks(task),
    object_version_digest: objectDigest,
    context_state_digest: `dsh:${ctx.session_id}:turn:${ctx.turn}:events:${ctx.recovery.event_sequence}`,
    environment_digest: envDigest, now: Date.now(),
    recovery_events: ctx.records.filter(r => r.type === 'task.revision').map(r => r.payload as any),
  }
}
