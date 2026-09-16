import test from 'node:test'
import assert from 'node:assert/strict'
import { auditTurn, MAX_REPAIRS } from '../lib/audit.js'
export const task = () => ({ schema_version: 2, task_id: 't1', objective_revision: 1, source_ref: 'user:1', scope: ['code+tests+config+deps'], status: 'active', requirements: [{ requirement_id: 'AC-1', class: 'acceptance', source_kind: 'user_instruction', source_ref: 'user:1', applicability: 'applicable', status: 'pending' }] })
export const proof = (patch = {}) => ({ event_id: 'v1', task_id: 't1', objective_revision: 1, requirement_ids: ['AC-1'], object_version_digest: 'objects:1', environment_digest: 'env:1', status: 'passed', complete: true, source_kind: 'host_verifier', verifier_ref: 'collector:test', output_ref: 'raw:1', assertion_passed: true, exit_code: 0, requires_exit_code: true, ...patch })
export const input = (patch = {}) => ({ request_id: 'stop:1', task: task(), candidate: { claims_success: true, response_kind: 'final_delivery', text: 'Delivered', requirement_claims: [{ requirement_id: 'AC-1', status: 'passed' }] }, candidate_check: { status: 'consistent', source_ref: 'host:body-check' }, evidence: [], hard_constraints_checked: [], object_version_digest: 'objects:1', context_state_digest: 'ctx:1', environment_digest: 'env:1', now: 100, ...patch })
const verdict = i => auditTurn(i).decision.verdict
const ordinary = kind => ({ claims_success: false, response_kind: kind, text: 'Not complete; discussing next steps', requirement_claims: [] })
test('A01 zero-tool discussion allows response without success', () => {
  const r = auditTurn(input({ candidate: ordinary('discussion') }))
  assert.equal(r.decision.verdict, 'allow_response'); assert.equal(r.state.task_status, 'active'); assert.deepEqual(r.decision.evidence_refs, [])
})
test('A02 code plan claiming completion is rejected with requirement gap', () => {
  const r = auditTurn(input()); assert.equal(r.decision.verdict, 'repair_required')
  assert.deepEqual(r.decision.missing_requirements, [{ requirement_id: 'AC-1', missing_reason: 'evidence_missing' }])
})
test('A03 valid prior-turn evidence reused for completion and reporting', () => {
  const first = auditTurn(input({ evidence: [proof()] }))
  const next = auditTurn(input({ request_id: 'turn:2', previous: first.state, evidence: [proof()], context_state_digest: 'ctx:2' }))
  assert.equal(next.decision.verdict, 'verified_complete'); assert.deepEqual(next.decision.evidence_refs, ['v1'])
  const report = auditTurn(input({ request_id: 'turn:3', previous: next.state, evidence: [proof()], candidate: ordinary('status_update') }))
  assert.equal(report.decision.verdict, 'allow_response'); assert.equal(report.state.task_status, 'verified_complete')
})
test('A04 file/config/dependency digest change invalidates old proof', () => {
  const r = auditTurn(input({ evidence: [proof()], object_version_digest: 'objects:changed' }))
  assert.equal(r.decision.verdict, 'repair_required'); assert.ok(r.decision.reason_codes.includes('evidence_stale'))
})
test('A05 echo or unrelated writes do not satisfy requirements', () => {
  assert.equal(verdict(input({ evidence: [proof({ requirement_ids: ['unrelated'] })] })), 'repair_required')
})
test('A06 missing tool result remains unknown', () => {
  const r = auditTurn(input({ evidence: [proof({ complete: false, status: 'unknown', exit_code: null })] }))
  assert.equal(r.decision.verdict, 'repair_required'); assert.ok(r.decision.reason_codes.includes('evidence_unknown'))
})
test('A07 later same-scope pass supersedes failure; unrelated error cannot poison it', () => {
  assert.equal(verdict(input({ evidence: [proof({ status: 'failed', assertion_passed: false }), proof({ event_id: 'v2' }), proof({ event_id: 'v3', requirement_ids: ['other'], status: 'failed' })] })), 'verified_complete')
  assert.equal(verdict(input({ evidence: [proof(), proof({ event_id: 'v2', status: 'failed' })] })), 'repair_required')
})
test('A08 exit zero with failed assertion is not verification', () => {
  assert.equal(verdict(input({ evidence: [proof({ assertion_passed: false, exit_code: 0 })] })), 'repair_required')})
test('A09 verified read-only sources and readable document satisfy content acceptance', () => {
  assert.equal(verdict(input({ evidence: [proof({ verifier_ref: 'document:sections+sources', requires_exit_code: false, exit_code: null })] })), 'verified_complete')
})
test('A12 same gap across turn/compact/restart gets one prompt then incomplete', () => {
  const a = auditTurn(input()); assert.equal(a.state.repair_count, 1)
  const replay = auditTurn(input({ previous: a.state })); assert.deepEqual(replay, a)
  const b = auditTurn(input({ request_id: 'turn:2', context_state_digest: 'compact:2', previous: JSON.parse(JSON.stringify(a.state)) }))
  assert.equal(b.decision.verdict, 'incomplete'); assert.equal(b.state.repair_count, 1)
  const c = auditTurn(input({ request_id: 'turn:3', previous: b.state })); assert.equal(c.decision.verdict, 'incomplete'); assert.equal(c.decision.repair_action, null)
})
test('A13 real user cancellation is terminal and proven external blocker is not success', () => {
  const a = auditTurn(input({ cancellation: { source_kind: 'user_instruction', source_ref: 'user:cancel' } }))
  assert.equal(a.decision.verdict, 'cancelled')
  assert.equal(verdict(input({ previous: a.state, request_id: 'new', evidence: [proof()] })), 'cancelled')
  const b = input({ candidate: ordinary('blocked_report'), evidence: [proof({ status: 'failed', assertion_passed: false })], blocker: { evidence_ref: 'v1', no_feasible_workaround: true, recovery_condition: 'service returns healthy' } })
  assert.equal(verdict(b), 'blocked'); delete b.blocker; assert.equal(verdict(b), 'incomplete')
})
test('all applicable requirements, not candidate subset, must pass', () => {
  const t = task(); t.requirements.push({ ...t.requirements[0], requirement_id: 'AC-2' })
  assert.equal(verdict(input({ task: t, evidence: [proof()] })), 'repair_required')
})
test('hard constraints gate ordinary replies and unknown source cannot be dropped', () => {
  const t = task(); t.requirements[0].class = 'hard'
  assert.equal(verdict(input({ task: t, candidate: ordinary('discussion') })), 'repair_required')
  const checks = [{ requirement_id: 'AC-1', applicability: 'applicable', status: 'compliant', check_ref: 'host:check' }]
  assert.equal(verdict(input({ task: t, evidence: [proof()], hard_constraints_checked: checks })), 'verified_complete')
  t.requirements[0].applicability = 'not_applicable'
  assert.equal(verdict(input({ task: t, evidence: [proof()], hard_constraints_checked: checks })), 'repair_required')
  t.requirements[0].exclusion = { authorized: true, source_ref: 'user:2', reason: 'revoked' }
  assert.equal(verdict(input({ task: t })), 'verified_complete')
})
test('candidate contract rejects omitted bool, contradictory text and false final_delivery', () => {
  for (const c of [{ text: 'done', response_kind: 'final_delivery', requirement_claims: [] }, { ...ordinary('discussion'), response_kind: 'final_delivery' }]) {
    const r = auditTurn(input({ candidate: c, evidence: [proof()] })); assert.ok(r.decision.reason_codes.includes('candidate_contract_invalid'))
  }
  assert.equal(verdict(input({ evidence: [proof()], candidate_check: { status: 'unknown', source_ref: 'host:check' } })), 'repair_required')
})
test('second distinct stable gap allowed but total budget is two', () => {
  const a = auditTurn(input())
  const b = auditTurn(input({ previous: a.state, request_id: '2', evidence: [proof({ status: 'failed' })] }))
  assert.equal(b.decision.verdict, 'repair_required'); assert.equal(b.state.repair_count, MAX_REPAIRS)
  const c = auditTurn(input({ previous: b.state, request_id: '3', evidence: [proof({ complete: false })] }))
  assert.equal(c.decision.verdict, 'incomplete'); assert.equal(c.state.repair_count, 2)
})
test('only relevant observed recovery reopens ended attempt', () => {
  const a = auditTurn(input()); const b = auditTurn(input({ previous: a.state, request_id: '2' }))
  assert.equal(verdict(input({ previous: b.state, request_id: '3', evidence: [proof()] })), 'incomplete')
  const recovery_events = [{ event_id: 'v2', task_id: 't1', kind: 'evidence', requirement_ids: ['AC-1'], source_ref: 'raw:2', observed: true }]
  const c = auditTurn(input({ previous: b.state, request_id: '4', evidence: [proof({ event_id: 'v2' })], recovery_events }))
  assert.equal(c.decision.verdict, 'verified_complete'); assert.equal(c.state.repair_count, 0)
})
test('model VALID and summary facts cannot promote themselves to passed', () => {
  for (const source_kind of ['model', 'summary']) assert.equal(verdict(input({ evidence: [proof({ source_kind })] })), 'repair_required')
})
test('cancellation overrides a replayed success request', () => {
  const a = auditTurn(input({ evidence: [proof()] }))
  assert.equal(verdict(input({ previous: a.state, cancellation: { source_kind: 'user_instruction', source_ref: 'user:stop' } })), 'cancelled')
})
test('reusing a decision request ID with changed objects fails closed', () => {
  const a = auditTurn(input({ evidence: [proof()] }))
  assert.throws(() => auditTurn(input({ previous: a.state, evidence: [proof()], object_version_digest: 'changed' })), /audit_request_id_conflict/)
})
test('same request cannot replay evidence after its expiry', () => {
  const a = auditTurn(input({ evidence: [proof({ expires_at: 200 })] }))
  assert.throws(() => auditTurn(input({ previous: a.state, evidence: [proof({ expires_at: 200 })], now: 201 })), /audit_replay_evidence_expired/)
})
test('environment, revision and unknown exit code are separately rejected', () => {
  for (const patch of [{ environment_digest: 'other' }, { objective_revision: 2 }, { exit_code: null }]) {
    assert.equal(verdict(input({ evidence: [proof(patch)] })), 'repair_required')
  }
})
// R9 (sixth-round reviewers): the reason must describe the newest verification the host saw. An
// earlier pass does not un-fail a later failure, and a run the host reported as failed is not the
// same thing as no run at all.
test('R9 the newest older run decides the reason, not any earlier pass', () => {
  const passed = proof({ objective_revision: 0 })
  const failedLater = proof({ event_id: 'v2', objective_revision: 0, status: 'failed', assertion_passed: false, exit_code: 1 })
  const r = auditTurn(input({ task: { ...task(), objective_revision: 2 }, evidence: [passed, failedLater] }))
  assert.equal(r.decision.verdict, 'repair_required')
  assert.deepEqual(r.decision.missing_requirements, [{ requirement_id: 'AC-1', missing_reason: 'verification_failed' }])
  assert.match(r.decision.repair_action, /run failed/i)
})
test('R9 a host-reported failure with no exit code is a failed run, not a missing one', () => {
  const failedNoCode = proof({ objective_revision: 0, status: 'failed', assertion_passed: false, exit_code: null, requires_exit_code: false })
  const r = auditTurn(input({ task: { ...task(), objective_revision: 2 }, evidence: [failedNoCode] }))
  assert.deepEqual(r.decision.missing_requirements, [{ requirement_id: 'AC-1', missing_reason: 'verification_failed' }])
})
test('R9 a stale older run is still stale, and a passed one still superseded', () => {
  const stale = proof({ objective_revision: 0, status: 'stale' })
  assert.deepEqual(auditTurn(input({ task: { ...task(), objective_revision: 2 }, evidence: [stale] }))
    .decision.missing_requirements, [{ requirement_id: 'AC-1', missing_reason: 'evidence_stale' }])
  const passed = proof({ objective_revision: 0 })
  assert.deepEqual(auditTurn(input({ task: { ...task(), objective_revision: 2 }, evidence: [passed] }))
    .decision.missing_requirements, [{ requirement_id: 'AC-1', missing_reason: 'evidence_superseded' }])
})
test('R9 the missing-evidence guidance names the artifact the task type needs', () => {
  const repair = type => auditTurn(input({ task: { ...task(), objective_revision: 2 }, task_type: type })).decision.repair_action
  assert.match(repair('ops'), /operation entry point/i)
  assert.match(repair('docs'), /document artifact/i)
  assert.match(repair('research'), /source outside the workspace/i)
  assert.match(repair('code'), /verification-class/i)
})
test('R9 a fallback reason still explains itself', () => {
  const body = auditTurn(input({
    candidate: { claims_success: false, response_kind: 'discussion', text: 'x', requirement_claims: [] },
    candidate_check: { status: 'contradictory', source_ref: 'host:body-check' },
  }))
  assert.ok(body.decision.reason_codes.includes('candidate_contract_invalid'), JSON.stringify(body.decision.reason_codes))
  assert.match(body.decision.repair_action ?? '', /not well formed/i,
    'a reason with no specific line must still say something useful')
})
