import { createHash } from 'node:crypto'
export const POLICY_VERSION = 'ironlaw/2.0-p2'
export const MAX_REPAIRS = 2
export type Status = 'pending' | 'passed' | 'failed' | 'unknown' | 'stale'
export type Verdict = 'allow_response' | 'verified_complete' | 'repair_required' | 'incomplete' | 'blocked' | 'cancelled'
export interface Requirement {
  requirement_id: string
  class: 'hard' | 'acceptance'
  source_kind: 'user_instruction' | 'system_policy' | 'data'
  source_ref: string
  applicability: 'applicable' | 'not_applicable' | 'unknown'
  status: Status
  superseded_by?: string
  /** What this item is about, as the host read it from the request: a path, a document name,
   * a directory. Acceptance items are matched to their OWN artifacts through this, so a
   * request naming two targets cannot be closed by producing one of them. */
  scope?: string[]
  /** For a prohibition: the content digest of the protected object when the revision started.
   * The host re-reads that object at adjudication time and can therefore check the constraint
   * itself instead of reporting it as unconfirmable. */
  baseline_digest?: string
  /** Only the host authority resolver may authorize exclusions. */
  exclusion?: { authorized: boolean; source_ref: string; reason: string }
}
export interface TaskContract {
  schema_version: 2; task_id: string; objective_revision: number; source_ref: string
  scope: string[]; requirements: Requirement[]; status: Verdict | 'active'
  /** Prohibitions the request stated that name no object the host can check. Recorded for
   * provenance only: they are not requirements, so nothing can be repaired into satisfying them,
   * and they never excuse or block a verdict. */
  unrepresentable_prohibitions?: string[]
}
export interface Candidate {
  claims_success: boolean
  response_kind: 'final_delivery' | 'status_update' | 'clarification' | 'discussion' | 'incomplete_report' | 'blocked_report' | 'cancellation_ack'
  text: string
  requirement_claims: Array<{ requirement_id: string; status: Status }>
}
export interface HardConstraintCheck {
  requirement_id: string; applicability: Requirement['applicability']
  status: 'compliant' | 'violated' | 'unknown'; check_ref: string
}
export interface Verification {
  event_id: string; task_id: string; objective_revision: number; requirement_ids: string[]
  object_version_digest: string; environment_digest: string; status: Status; complete: boolean
  /** The per-file snapshot this proof was captured against, when it attests a file set. The
   * resolver re-checks these files at adjudication time; the aggregate digest above stays a
   * consistency tag between proof and input rather than the thing that decides staleness. */
  object_versions?: Record<string, string>
  source_kind: 'host_verifier' | 'model' | 'summary'; verifier_ref: string; output_ref: string
  tool_call_id?: string; exit_code?: number | null; requires_exit_code?: boolean
  assertion_passed: boolean | null; expires_at?: number
}
export interface RecoveryEvent {
  event_id: string; task_id: string; kind: 'evidence' | 'object_change' | 'user_revision' | 'blocker_resolved'
  requirement_ids: string[]; source_ref: string; observed: boolean
}
export interface Decision {
  decision_id: string; task_id: string; objective_revision: number; verdict: Verdict
  missing_requirements: Array<{ requirement_id: string; missing_reason: string }>
  evidence_refs: string[]; reason_codes: string[]; repair_action: string | null
  policy_version: string; hard_constraints_checked: HardConstraintCheck[]
}
export interface AuditState {
  schema_version: 2; task_id: string; task_status: TaskContract['status']; attempt_id?: string
  repair_count: number; repair_keys: string[]; consumed_recovery_refs: string[]
  object_version_digest: string; context_state_digest: string
  last_decision?: Decision; replay: Record<string, Decision>; replay_inputs: Record<string, string>
}
export interface AuditInput {
  request_id: string; task: TaskContract; candidate: Candidate
  /** Independent host check against actual response text. Unknown fails closed. */
  candidate_check: { status: 'consistent' | 'contradictory' | 'unknown'; source_ref: string }
  evidence: Verification[]; hard_constraints_checked: HardConstraintCheck[]
  /** Requirement-level gaps the trusted resolver established before the proof lookup — a citation
   * the host never observed, for instance. A declared gap is reported as that requirement's
   * missing reason, so the refusal names the real cause instead of the generic fallback. */
  evidence_gaps?: Array<{ requirement_id: string; reason: string }>
  object_version_digest: string; context_state_digest: string; environment_digest: string; now: number
  cancellation?: { source_kind: 'user_instruction'; source_ref: string }
  blocker?: { evidence_ref: string; no_feasible_workaround: boolean; recovery_condition: string }
  recovery_events?: RecoveryEvent[]; previous?: AuditState
}
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
const excluded = (r: Requirement) => r.applicability === 'not_applicable'
  && r.exclusion?.authorized === true && !!r.exclusion.source_ref && !!r.exclusion.reason
export function newAuditState(taskId: string): AuditState {
  return { schema_version: 2, task_id: taskId, task_status: 'active', repair_count: 0,
    repair_keys: [], consumed_recovery_refs: [], object_version_digest: '', context_state_digest: '', replay: {}, replay_inputs: {} }
}
/** Pure adjudicator. Persist returned state before steering feedback. */
export function auditTurn(input: AuditInput): { decision: Decision; state: AuditState } {
  const { task, candidate: c } = input
  const state = structuredClone(input.previous ?? newAuditState(task.task_id))
  if (state.schema_version !== 2 || state.task_id !== task.task_id) throw new Error('audit_state_contract_invalid')
  const cancelled = state.task_status === 'cancelled'
    || (input.cancellation?.source_kind === 'user_instruction' && !!input.cancellation.source_ref)
  const inputDigest = digest({ ...input, task: { ...task, status: undefined }, previous: undefined, now: undefined, context_state_digest: undefined })
  if (!cancelled && Object.hasOwn(state.replay, input.request_id)) {
    if (state.replay_inputs[input.request_id] !== inputDigest) throw new Error('audit_request_id_conflict')
    if (state.replay[input.request_id].verdict === 'verified_complete'
      && input.evidence.some(e => e.expires_at !== undefined && input.now >= e.expires_at)) throw new Error('audit_replay_evidence_expired')
    return { decision: state.replay[input.request_id], state }
  }
  const missing: Decision['missing_requirements'] = [], refs: string[] = [], reasons: string[] = []
  const add = (id: string, reason: string) => { missing.push({ requirement_id: id, missing_reason: reason }); reasons.push(reason) }
  const requirements = task.requirements ?? [], ids = requirements.map(r => r.requirement_id)
  const contractValid = task.schema_version === 2 && !!task.task_id && !!task.source_ref
    && Number.isInteger(task.objective_revision) && task.objective_revision > 0
    && Array.isArray(task.scope) && task.scope.length > 0 && requirements.length > 0
    && new Set(ids).size === ids.length && ids.every(Boolean)
    && requirements.every(r => ['hard', 'acceptance'].includes(r.class)
      && ['applicable', 'not_applicable', 'unknown'].includes(r.applicability)
      && ['pending', 'passed', 'failed', 'unknown', 'stale'].includes(r.status))
  if (!contractValid) add('$task', 'task_contract_invalid')
  const ordinaryKinds = ['status_update', 'clarification', 'discussion', 'incomplete_report', 'blocked_report', 'cancellation_ack']
  const candidateValid = c && typeof c.claims_success === 'boolean' && typeof c.text === 'string'
    && (c.claims_success ? c.response_kind === 'final_delivery' : ordinaryKinds.includes(c.response_kind))
    && Array.isArray(c.requirement_claims) && c.requirement_claims.every(r => ids.includes(r.requirement_id)
      && ['pending', 'passed', 'failed', 'unknown', 'stale'].includes(r.status))
    && input.candidate_check?.status === 'consistent' && !!input.candidate_check.source_ref
  if (!candidateValid) add('$candidate', 'candidate_contract_invalid')
  for (const r of requirements.filter(r => r.class === 'hard' && !excluded(r))) {
    const checks = input.hard_constraints_checked.filter(h => h.requirement_id === r.requirement_id)
    if (!r.source_ref || !['user_instruction', 'system_policy'].includes(r.source_kind)
      || r.applicability !== 'applicable' || r.superseded_by || r.status === 'stale'
      || checks.length !== 1 || checks[0].status !== 'compliant'
      || checks[0].applicability !== 'applicable' || !checks[0].check_ref) add(r.requirement_id, 'hard_constraint_unconfirmed')
  }
  const unsafe = missing.length > 0
  // Acceptance items only. A hard constraint is not an artifact to produce: it is checked by the
  // host (`hard_constraints_checked`, above). Letting it through this loop demanded a
  // host_verifier proof bound to it as well, which no host can supply, so any declared hard
  // constraint made completion impossible.
  for (const r of requirements.filter(r => r.class === 'acceptance' && !excluded(r))) {
    if (r.applicability !== 'applicable') { add(r.requirement_id, 'applicability_unknown'); continue }
    const declared = input.evidence_gaps?.find(g => g.requirement_id === r.requirement_id)
    if (declared) { add(r.requirement_id, declared.reason); continue }
    const e = input.evidence.filter(e => e.task_id === task.task_id && e.objective_revision === task.objective_revision
      && e.requirement_ids.includes(r.requirement_id) && e.source_kind === 'host_verifier').at(-1)
    if (!e) {
      // Distinguish "this revision was never verified" from "it was verified under an earlier
      // task revision". The revision advances with every user message, so the second case is
      // the common one in a live session, and its fix is to re-run the same command — not to
      // invent new evidence. The task's own requirement set and the object digest still decide
      // validity; only the reported reason and its guidance differ.
      const older = input.evidence.filter(v => v.task_id === task.task_id
        && v.objective_revision !== task.objective_revision
        && v.requirement_ids.includes(r.requirement_id) && v.source_kind === 'host_verifier')
      const olderPassed = older.some(v => v.status === 'passed' && v.assertion_passed === true
        && (typeof v.exit_code !== 'number' || v.exit_code === 0))
      add(r.requirement_id, olderPassed ? 'evidence_superseded' : older.length ? 'verification_failed' : 'evidence_missing')
      continue
    }
    if (!input.object_version_digest || !input.environment_digest || e.object_version_digest !== input.object_version_digest
      || e.environment_digest !== input.environment_digest || (e.expires_at !== undefined && input.now >= e.expires_at)) {
      add(r.requirement_id, 'evidence_stale'); continue
    }
    if (!e.complete || !e.verifier_ref || !e.output_ref || e.status === 'unknown' || e.status === 'pending'
      || (e.requires_exit_code && typeof e.exit_code !== 'number') || e.assertion_passed === null) {
      add(r.requirement_id, 'evidence_unknown'); continue
    }
    if (e.status !== 'passed' || e.assertion_passed !== true || (typeof e.exit_code === 'number' && e.exit_code !== 0)) {
      add(r.requirement_id, e.status === 'stale' ? 'evidence_stale' : 'verification_failed'); continue
    }
    refs.push(e.event_id)
  }
  const last = state.last_decision
  const recoveries = (input.recovery_events ?? []).filter(e => e.task_id === task.task_id && e.observed && e.source_ref
    && !state.consumed_recovery_refs.includes(e.event_id)
    && (e.kind === 'user_revision' || e.requirement_ids.some(id => last?.missing_requirements.some(m => m.requirement_id === id)))
    && (e.kind !== 'evidence' || input.evidence.some(v => v.event_id === e.event_id && v.source_kind === 'host_verifier')))
  const ended = ['incomplete', 'blocked', 'verified_complete'].includes(state.task_status)
  const canResume = recoveries.length > 0 || (state.task_status === 'verified_complete' && missing.length > 0)
  if (ended && canResume) { state.repair_count = 0; state.repair_keys = []; state.attempt_id = undefined }
  state.consumed_recovery_refs.push(...recoveries.map(e => e.event_id))
  const block = input.blocker
  const blocked = !!block?.no_feasible_workaround && !!block.recovery_condition
    && input.evidence.some(e => e.event_id === block.evidence_ref && e.task_id === task.task_id
      && e.objective_revision === task.objective_revision && e.source_kind === 'host_verifier'
      && e.complete && e.verifier_ref && e.output_ref && e.status === 'failed'
      && e.object_version_digest === input.object_version_digest && e.environment_digest === input.environment_digest)
  let verdict: Verdict, repair: string | null = null
  if (cancelled) verdict = 'cancelled'
  else if (ended && !canResume && state.task_status !== 'verified_complete') {
    verdict = !unsafe && !c.claims_success && ['status_update', 'clarification', 'discussion', 'cancellation_ack'].includes(c.response_kind)
      ? 'allow_response' : state.task_status as Verdict
  } else if (!unsafe && c.claims_success && missing.length === 0) verdict = 'verified_complete'
  else if (!unsafe && missing.length > 0 && blocked) verdict = 'blocked'
  else if (unsafe || c.claims_success) {
    state.attempt_id ??= digest([task.task_id, task.objective_revision, input.request_id])
    const keys = missing.map(m => digest([task.task_id, task.objective_revision, m.requirement_id, m.missing_reason, input.object_version_digest]))
    const newKeys = keys.filter(k => !state.repair_keys.includes(k))
    const objectChangeVerified = !state.repair_count || state.object_version_digest === input.object_version_digest
      || recoveries.some(e => e.kind === 'object_change' || e.kind === 'user_revision')
    if (state.repair_count < MAX_REPAIRS && newKeys.length && objectChangeVerified) {
      verdict = 'repair_required'; state.repair_count++; state.repair_keys.push(...keys)
      repair = missing.map(m => `${m.requirement_id}: ${m.missing_reason}`).join('; ') + '. ' + guidance(missing)
    } else { verdict = 'incomplete'; reasons.push('repair_budget_exhausted_or_duplicate') }
  } else if (c.response_kind === 'incomplete_report' || c.response_kind === 'blocked_report') {
    verdict = 'incomplete'; if (c.response_kind === 'blocked_report') reasons.push('blocker_unconfirmed')
  } else verdict = 'allow_response'
  const decision: Decision = { decision_id: digest([task.task_id, task.objective_revision, input.request_id, verdict]),
    task_id: task.task_id, objective_revision: task.objective_revision, verdict, missing_requirements: missing,
    evidence_refs: refs, reason_codes: [...new Set(reasons)], repair_action: repair, policy_version: POLICY_VERSION,
    hard_constraints_checked: structuredClone(input.hard_constraints_checked) }
  if (verdict !== 'allow_response') { state.task_status = verdict; state.last_decision = decision }
  state.object_version_digest = input.object_version_digest; state.context_state_digest = input.context_state_digest
  state.replay[input.request_id] = decision
  state.replay_inputs[input.request_id] = inputDigest
  return { decision, state }
}
/**
 * What to do about each gap, in the order a reader needs it. A bare reason code says that
 * something is missing but not that the missing thing is a *re-run*: the common live case is a
 * passing verification whose task revision has since advanced, where the fix is to run the
 * same command again in the current revision. Reasons without specific guidance fall back to
 * the generic sentence, so the message never becomes misleadingly precise.
 */
function guidance(missing: Array<{ missing_reason: string }>): string {
  const byReason: Record<string, string> = {
    evidence_missing: 'No verification-class run is recorded for this task revision. Run the project\'s own verification (its test, build or lint command) as a single unmasked command so the host records its exit code, then report.',
    evidence_superseded: 'A passing verification run exists but is bound to an earlier task revision — the revision advances with each user message, so earlier evidence cannot close this one. Re-run the same command in this revision, then report.',
    evidence_stale: 'The verification\'s object version no longer matches the current files, so it cannot speak for them. Re-run the verification after your last change, then report.',
    verification_failed: 'The verification run failed. Fix the failure, re-run it, then report.',
    evidence_unknown: 'The verification outcome is indeterminate (no exit code, no assertion result). Re-run it so the host records a determinate outcome.',
    citation_unobserved: 'The delivery cites a source the host never observed, or cites none although the session consulted sources. Cite only URLs the host actually recorded (the ones your searches and fetches returned), the way the source was reached, then report.',
  }
  const lines = [...new Set(missing.map(m => byReason[m.missing_reason]).filter((line): line is string => !!line))]
  return lines.length ? lines.join(' ') : 'Supply current requirement-linked evidence or honestly report the remaining gap.'
}

export function repairPrompt(decision: Decision): string {
  return `[IRONLAW_REPAIR:v2 decision=${decision.decision_id}] ${decision.repair_action ?? decision.reason_codes.join(', ')}`
}
