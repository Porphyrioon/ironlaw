import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { randomUUID } from 'node:crypto'
import { EvidenceLedger, type EvidenceRecord } from './evidence.js'
import { destructiveReason } from './policy.js'
import { auditTurn, repairPrompt, type AuditInput, type TaskContract } from './audit.js'
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
export function apply(ctx: Context, config: IronLawConfig = {}): void {
  const mode = config.mode ?? (process.env.IRONLAW_MODE === 'enforcer' ? 'enforcer' : 'observe')
  const ledger = new EvidenceLedger(config.evidenceRoot)
  const responses = new Map<string, { text: string; seq: number }>()
  const taskFor = (sessionId: string): TaskContract => ledger.task(sessionId) ?? {
    schema_version: 2, task_id: `unresolved:${sessionId}`, objective_revision: 1,
    source_ref: `session:${sessionId}`, scope: ['unresolved'], status: 'active',
    requirements: [{ requirement_id: 'AC-1', class: 'acceptance', source_kind: 'user_instruction',
      source_ref: '', applicability: 'unknown', status: 'unknown' }],
  }
  ctx.on('tools/pre-execute', async (exec, next) => {
    ledger.record(sessionIdOf(exec.agent), 'tool.execute.before', { name: exec.name, arguments: exec.arguments })
    return next()
  })
  if (mode === 'enforcer') ctx.tools.guard(exec => {
    const reason = destructiveReason(exec.name, exec.arguments)
    if (reason) ledger.record(sessionIdOf(exec.agent), 'policy.deny', { name: exec.name, reason })
    return reason
  })
  ctx.on('tools/result', (exec, result) => {
    ledger.record(sessionIdOf(exec.agent), 'tool.execute.after', { name: exec.name, isError: result.isError })
  })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'assistant/chunk') return
    const eventId = `dsh:${session.id}:${event.seq}`
    if (ledger.snapshot(session.id).some(r => r.event_id === eventId)) return
    const data = event.data as any
    let task = taskFor(session.id)
    // Only actual human messages revise the contract. Synthetic feedback retains provenance.
    if (event.type === 'user/message' && data.source?.kind === 'user') {
      const existing = ledger.task(session.id)
      task = { ...task, task_id: existing?.task_id ?? randomUUID(),
        objective_revision: existing ? existing.objective_revision + 1 : 1, source_ref: eventId }
      ledger.record(session.id, 'task.contract', task, { task_id: task.task_id, objective_revision: task.objective_revision })
      ledger.record(session.id, 'task.revision', { event_id: eventId, task_id: task.task_id, kind: 'user_revision',
        requirement_ids: task.requirements.map(r => r.requirement_id), source_ref: eventId, observed: true }, { task_id: task.task_id })
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
    const input: Omit<AuditInput, 'previous'> = config.resolveAudit?.({ session_id: sessionId, turn, task, response: response.text, records,
      recovery: ledger.recover(sessionId) }) ?? {
      request_id: `${sessionId}:${turn}:${response.seq}`, task,
      candidate: { claims_success: true, response_kind: 'final_delivery', text: response.text, requirement_claims: [] },
      candidate_check: { status: 'unknown', source_ref: '' }, evidence: [], hard_constraints_checked: [],
      object_version_digest: '', context_state_digest: `turn:${turn}`, environment_digest: '', now: Date.now(),
      recovery_events: records.filter(r => r.type === 'task.revision').map(r => r.payload as any),
    }
    const previous = ledger.auditState(sessionId, input.task.task_id)
    if (input.candidate?.text !== response.text) input.candidate_check = {
      status: 'contradictory', source_ref: `dsh:${sessionId}:${response.seq}`,
    }
    const replayed = previous && Object.hasOwn(previous.replay, input.request_id)
    const { decision, state } = auditTurn({ ...input, previous })
    ledger.record(sessionId, 'task.contract', { ...input.task, status: state.task_status }, { task_id: input.task.task_id, objective_revision: input.task.objective_revision })
    for (const proof of input.evidence) ledger.record(sessionId, 'requirement.verification', proof, {
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
