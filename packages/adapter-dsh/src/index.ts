import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { createHash, randomUUID } from 'node:crypto'
import { EvidenceLedger, type Association, type EvidenceRecord } from './evidence.js'
import { destructiveReason } from './policy.js'
import { auditTurn, repairPrompt, type AuditInput, type TaskContract } from './audit.js'
import { defaultResolveAudit, namedTargets } from './resolver.js'
import { classifyTaskType } from './classify.js'
import { declaredRequirements } from './contract.js'
import { snapshotObjectVersions, touchedPathsOf, versionDigestOf } from './snapshot.js'

/**
 * The declared contract. Applicability and authorization found while adjudicating one revision
 * are per-turn facts: persisting them let a discussion exemption survive into a later code task
 * and excuse it from evidence entirely. Only what the human gave us is stored.
 */
function declared(task: TaskContract): TaskContract {
  return { ...task, requirements: task.requirements.map(r => {
    const { exclusion: _exclusion, ...rest } = r as TaskContract['requirements'][number] & { exclusion?: unknown }
    return { ...rest, applicability: 'unknown' as const, status: 'unknown' as const }
  }) }
}

/**
 * An id for a record whose payload is re-derived from current state: the content is folded
 * into the id, so re-deriving it later writes a NEW row instead of colliding with the old
 * one. The ledger refuses to reuse an id for different content — an invariant worth keeping —
 * but a derived record's content legitimately moves (a re-classification, a retried call),
 * and the collision used to surface as a thrown error inside the turn-stopping hook, which
 * killed the decision, the repair prompt and the gate itself for the rest of the session.
 */
function versionedId(base: string, payload: unknown, link: Association): string {
  let body: string
  try { body = JSON.stringify([payload, Object.entries(link).sort()]) ?? 'undefined' }
  catch { body = `unserializable:${randomUUID()}` }
  return `${base}:${createHash('sha256').update(body).digest('hex').slice(0, 12)}`
}
export const name = 'ironlaw'
export const inject = ['tools', 'sessions', 'agents']
export interface IronLawConfig {
  mode?: 'observe' | 'enforcer'
  evidenceRoot?: string
  /** False is shadow-only; it cannot manufacture a verified verdict. */
  requireEvidence?: boolean
  /** Trusted integration boundary, NOT model/tool-output JSON. Resolve authority,
   * candidate/body consistency, fingerprints and requirement checks here.
   * Without it the adapter explicitly reports unknown, with bounded feedback. */
  resolveAudit?: (context: { session_id: string; turn: number; task: TaskContract;
    response: string; records: EvidenceRecord[]; recovery: ReturnType<EvidenceLedger['recover']> }) => Omit<AuditInput, 'previous'>
}
function sessionIdOf(agent: { session?: { id?: unknown } } | undefined): string {
  const id = agent?.session?.id
  return typeof id === 'string' ? id : 'unknown'
}
/**
 * Exit code from a canonical tool result value. DSH keeps that value execution-local
 * and deliberately omits it from durable session events (`ToolExecutionSuccess.value`),
 * and the real host's `payload.data.meta` is tool-structured output, never a UI card,
 * so this hook is the only place the number can be captured. Without it no terminal
 * evidence exists in a live session at all.
 */
function canonicalExitCode(value: unknown): number | null {
  const exit = (value as { exitCode?: unknown } | null | undefined)?.exitCode
  return typeof exit === 'number' && Number.isFinite(exit) ? exit : null
}
/** Command text from already-parsed hook arguments, which arrive as objects rather than JSON strings. */
function canonicalCommand(args: unknown): string {
  if (typeof args === 'string') return args
  if (!args || typeof args !== 'object') return ''
  for (const k of ['command', 'cmd', 'script', 'shell', 'code', 'commands', 'input']) {
    const v = (args as Record<string, unknown>)[k]
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string').join(' && ')
  }
  return ''
}
export function apply(ctx: Context, config: IronLawConfig = {}): void {
  const mode = config.mode ?? (process.env.IRONLAW_MODE === 'enforcer' ? 'enforcer' : 'observe')
  const ledger = new EvidenceLedger(config.evidenceRoot)
/**
 * Write a record whose content is re-derived from current state. A collision on such a
 * record is a data anomaly, not a reason to lose the turn: the gate's whole job is the
 * decision at the end of this hook, so the anomaly is recorded as its own diagnostic row
 * and the turn continues. Core transaction records (contract, state, decision) are written
 * with `ledger.record` directly and still fail loud, because those failing means the ledger
 * itself is inconsistent and a silent pass would be worse.
 */
  const recordDerived = (sessionId: string, type: string, payload: unknown, link: Association): void => {
    try { ledger.record(sessionId, type, payload, link) }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes('evidence_event_id_conflict')) throw error
      ledger.record(sessionId, 'policy.conflict',
        { type, attempted_event_id: link.event_id ?? null, message },
        { event_id: `dsh:${sessionId}:conflict:${randomUUID()}`, task_id: link.task_id ?? null })
    }
  }
  const responses = new Map<string, { text: string; seq: number }>()
  /**
   * Files this session has named so far, per session. Kept so that a tool result can be pinned
   * to the object version that existed WHEN IT RAN: re-deriving the digest at adjudication time
   * instead re-bound a passing run to whatever the tree had become since, which defeated the
   * invalidation the digest comparison exists to provide.
   */
  const touched = new Map<string, Set<string>>()
  /**
   * The session's touched paths, restored from its durable records the first time it is asked
   * for. Without this a plugin remount (reload, restart) starts with an empty scope, so a
   * verification running afterwards captures no object version at all and the proof that should
   * attest it cannot be tied to the files it verified.
   */
  const touchedFor = (sessionId: string): Set<string> => {
    const known = touched.get(sessionId)
    if (known) return known
    const restored = new Set<string>()
    for (const record of ledger.snapshot(sessionId)) {
      if (record.type !== 'tool.call') continue
      const data = (record.payload as any)?.data
      if (!data) continue
      for (const path of touchedPathsOf(typeof data.name === 'string' ? data.name : '', data.arguments)) restored.add(path)
    }
    touched.set(sessionId, restored)
    return restored
  }
  const rememberTouched = (sessionId: string, toolName: string, args: unknown): void => {
    const paths = touchedPathsOf(toolName, args)
    if (!paths.length) return
    const set = touchedFor(sessionId)
    for (const path of paths) set.add(path)
  }
  const taskFor = (sessionId: string): TaskContract => declared(ledger.task(sessionId) ?? {
    schema_version: 2, task_id: `unresolved:${sessionId}`, objective_revision: 1,
    source_ref: `session:${sessionId}`, scope: ['unresolved'], status: 'active',
    requirements: [{ requirement_id: 'AC-1', class: 'acceptance', source_kind: 'user_instruction',
      source_ref: '', applicability: 'unknown', status: 'unknown' }],
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    const sessionId = sessionIdOf(exec.agent)
    rememberTouched(sessionId, exec.name, exec.arguments)
    ledger.record(sessionId, 'tool.execute.before', { name: exec.name, arguments: exec.arguments })
    return next()
  })
  if (mode === 'enforcer') ctx.tools.guard(exec => {
    const reason = destructiveReason(exec.name, exec.arguments)
    if (reason) ledger.record(sessionIdOf(exec.agent), 'policy.deny', { name: exec.name, reason })
    return reason
  })
  ctx.on('tools/result', (exec, result) => {
    const sessionId = sessionIdOf(exec.agent)
    rememberTouched(sessionId, exec.name, exec.arguments)
    ledger.record(sessionId, 'tool.execute.after', { name: exec.name, isError: result.isError })
    // Persist the canonical outcome under its own record type, keyed by call id. The
    // tool.call/tool.result pairing written by the session event stream is left untouched;
    // this adds the exit code that stream never carries, plus the object version as of now.
    const exitCode = canonicalExitCode(result.isError ? undefined : result.value)
    const command = canonicalCommand(exec.arguments)
    const callId = typeof exec.callId === 'string' ? exec.callId : ''
    const versions = snapshotObjectVersions(touchedFor(sessionId))
    const objectDigest = versionDigestOf(versions)
    if (!callId || (exitCode === null && !command && !objectDigest)) return
    const outcome = { tool_call_id: callId, name: exec.name, command, exit_code: exitCode, is_error: result.isError,
      object_version_digest: objectDigest, object_versions: versions }
    const outcomeLink = { tool_call_id: callId, exit_code: exitCode }
    recordDerived(sessionId, 'tool.outcome', outcome,
      { ...outcomeLink, event_id: versionedId(`dsh:${sessionId}:outcome:${callId}`, outcome, outcomeLink) })
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/chunk') return
    const eventId = `dsh:${session.id}:${event.seq}`
    if (ledger.hasEvent(session.id, eventId)) return
    const data = event.data as any
    // The session stream is the other place a call's arguments appear; a fixture or a host
    // that only drives events must still feed the object scope used when pinning results.
    if (event.type === 'tool/call') rememberTouched(session.id, typeof data.name === 'string' ? data.name : '', data.arguments)
    let task = taskFor(session.id)
    // Only actual human messages revise the contract. Synthetic feedback retains provenance.
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      const existing = ledger.task(session.id)
      const humanText = (Array.isArray(data.content) ? data.content : [])
        .filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
      // Host-side classification from the human request only; persisted per revision so the type
      // is stable across turns and never re-derived from model output.
      const taskType = classifyTaskType(humanText)
      // A document request names deliverables, so each named target becomes its own acceptance
      // item; other types keep one item, because a test run covers a repository rather than a
      // named file. Stated prohibitions become hard items carrying the digest of what they
      // protect, which is what makes them checkable by the host later.
      // A trailing slash is what marks a directory target; dropping it here made the item's own
      // scope unparseable later, so a request naming `docs/` could never be answered.
      const targets = taskType === 'docs' ? namedTargets(humanText).map(t => (t.dir ? `${t.norm}/` : t.norm)) : []
      task = { ...task, task_id: existing?.task_id ?? randomUUID(),
        objective_revision: existing ? existing.objective_revision + 1 : 1, source_ref: eventId,
        scope: targets.length ? targets : task.scope,
        requirements: declaredRequirements({ text: humanText, sourceRef: eventId, targets, perTarget: taskType === 'docs' }) }
      ledger.record(session.id, 'task.contract', task, { task_id: task.task_id, objective_revision: task.objective_revision })
      ledger.record(session.id, 'task.revision', { event_id: eventId, task_id: task.task_id, kind: 'user_revision',
        requirement_ids: task.requirements.map(r => r.requirement_id), source_ref: eventId, observed: true }, { task_id: task.task_id })
      const classification = { task_type: taskType, source_ref: eventId, observed: true }
      const classificationLink = { task_id: task.task_id, objective_revision: task.objective_revision }
      recordDerived(session.id, 'task.classification', classification,
        { ...classificationLink, event_id: versionedId(`${eventId}:classification`, classification, classificationLink) })
    }
    if (event.type === 'assistant/message') responses.set(session.id, {
      text: (data.message?.content ?? []).filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n'), seq: event.seq,
    })
    const callId = data.callId ?? data.message?.source?.callId
      ?? data.message?.content?.find((p: any) => p.type === 'tool-result')?.toolCallId
    const type = event.type === 'tool/call' ? 'tool.call' : event.type === 'tool/result' ? 'tool.result' : `session.${event.type}`
    const error = !!data.error || (data.message?.content ?? []).some((p: any) => p.isError === true)
    ledger.record(session.id, type, { seq: event.seq, data }, {
      event_id: eventId, task_id: task.task_id, objective_revision: task.objective_revision,
      turn_id: data.turn === undefined ? null : String(data.turn), tool_call_id: callId ?? null,
      result_status: error ? 'failed' : 'unknown', output_ref: eventId,
      source_kind: data.source?.kind ?? 'host_event',
      started_at: type === 'tool.call' ? new Date().toISOString() : null,
      ended_at: type === 'tool.result' ? new Date().toISOString() : null,
    })
    if (event.type === 'turn/end' && data.reason?.kind === 'aborted' && data.reason.reason?.kind === 'user') {
      const { state, decision } = auditTurn({ request_id: eventId, task,
        candidate: { claims_success: false, response_kind: 'cancellation_ack', text: '', requirement_claims: [] },
        candidate_check: { status: 'consistent', source_ref: eventId }, cancellation: { source_kind: 'user_instruction', source_ref: eventId },
        evidence: [], hard_constraints_checked: [], object_version_digest: '', context_state_digest: '', environment_digest: '', now: Date.now(),
        previous: ledger.auditState(session.id, task.task_id) })
      ledger.record(session.id, 'completion.state', state, { task_id: task.task_id })
      ledger.record(session.id, 'completion.decision', decision, { task_id: task.task_id, event_id: decision.decision_id })
    }
  })
  ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    const sessionId = sessionIdOf(agent), task = taskFor(sessionId)
    const response = responses.get(sessionId) ?? { text: '', seq: -1 }
    const records = ledger.snapshot(sessionId)
    const resolveCtx = { session_id: sessionId, turn, task, response: response.text, records,
      recovery: ledger.recover(sessionId) }
    const input: Omit<AuditInput, 'previous'> = config.resolveAudit?.(resolveCtx) ?? defaultResolveAudit(resolveCtx)
    const previous = ledger.auditState(sessionId, input.task.task_id)
    if (input.candidate?.text !== response.text) input.candidate_check = {
      status: 'contradictory', source_ref: `dsh:${sessionId}:${response.seq}`,
    }
    const replayed = previous && Object.hasOwn(previous.replay, input.request_id)
    const { decision, state } = auditTurn({ ...input, previous })
    // Persist the DECLARED contract, not the resolver's per-turn transform: applicability and
    // authorization are re-derived each revision, and storing them let a discussion exemption
    // outlive the discussion and excuse a later code task from evidence.
    ledger.record(sessionId, 'task.contract', { ...declared(input.task), status: state.task_status }, { task_id: input.task.task_id, objective_revision: input.task.objective_revision })
    for (const proof of input.evidence) recordDerived(sessionId, 'requirement.verification', proof, {
      event_id: proof.event_id, task_id: proof.task_id, objective_revision: proof.objective_revision,
      requirement_ids: proof.requirement_ids, tool_call_id: proof.tool_call_id ?? null,
      source_kind: proof.source_kind, result_status: proof.status, output_ref: proof.output_ref,
      object_version_digest: proof.object_version_digest, exit_code: proof.exit_code ?? null,
    })
    // Persist one full transaction before feedback; turn boundaries never reset attempts.
    ledger.record(sessionId, 'completion.state', state, { task_id: input.task.task_id, objective_revision: input.task.objective_revision })
    ledger.record(sessionId, 'completion.decision', decision, { task_id: input.task.task_id, event_id: decision.decision_id })
    if (!replayed && decision.verdict === 'repair_required' && config.requireEvidence !== false) {
      const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: repairPrompt(decision) }],
        source: { kind: 'system', name: 'ironlaw', decision_id: decision.decision_id } }
      agent.steer(message as Parameters<typeof agent.steer>[0])
    }
  })
}


// Public protocol types and host-side fingerprint utility.
export type { TaskContract, Requirement, Candidate, Verification, Decision, AuditState, AuditInput, RecoveryEvent, HardConstraintCheck, Verdict } from './audit.js'
export { objectVersionDigest } from './fingerprint.js'
export { classifyTaskType, isTaskType, TASK_TYPES } from './classify.js'
export type { TaskType } from './classify.js'
export { defaultResolveAudit } from './resolver.js'
export type { ResolveAuditContext } from './resolver.js'
export { EvidenceLedger } from './evidence.js'
export { ContextStore, retainCapsule } from './context.js'
export type { ContextEntry, ContextStructure, ContextSummary, TaskCapsule, RetentionCapsule, ArchiveIndex, ContextVersion } from './context.js'
export { AdmissionController } from './aci.js'
export type { AdmissionEntry, AdmissionBudget, AdmissionRenderer, AdmissionResult } from './aci.js'
export { DependencyRetriever } from './retrieval.js'
export type { RetrievalSignal } from './retrieval.js'
export { taskCost } from './cost.js'
export type { Usage, Rates } from './cost.js'
export { calibrate, selectSlice } from './calibration.js'
export type { TraceEntry, TraceSlice, Strategy } from './calibration.js'
