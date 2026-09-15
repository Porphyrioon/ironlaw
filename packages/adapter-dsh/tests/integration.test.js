import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceLedger } from '../lib/evidence.js'
import { objectVersionDigest } from '../lib/fingerprint.js'
// Import the compiled package entry resolved from package.json, not TS source.
import { apply } from '@ironlaw/adapter-dsh'
const fixture = t => { const root = mkdtempSync(join(tmpdir(), 'ironlaw-p1-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
function host(root, resolveAudit) {
  const handlers = new Map(), prompts = []
  apply({ on(name, fn) { handlers.set(name, fn) }, tools: { guard() {} } }, { evidenceRoot: root, resolveAudit })
  return { handlers, prompts, emit(type, data, seq) { handlers.get('session/event')({ id: 'session' }, { type, data, seq }) },
    stop(turn = 1) { handlers.get('agent/turn-stopping')({ agent: { session: { id: 'session' }, steer: message => prompts.push(message) }, turn }) } }
}
function resolved(task, request_id = 'stop:1') {
  return { request_id, task: { ...task, scope: ['fixture'], requirements: [{ requirement_id: 'AC-1', class: 'acceptance', source_kind: 'user_instruction', source_ref: task.source_ref, applicability: 'applicable', status: 'pending' }] }, candidate: { claims_success: false, response_kind: 'discussion', text: 'Discussion', requirement_claims: [] }, candidate_check: { status: 'consistent', source_ref: 'host:check' }, evidence: [], hard_constraints_checked: [], object_version_digest: 'o1', context_state_digest: 'c1', environment_digest: 'e1', now: 1 }
}
test('compiled entry A01 allows zero-tool response with trusted candidate check', t => {
  const root = fixture(t), h = host(root, ({ task }) => resolved(task))
  h.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Discuss' }] }, 1); h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Discussion' }] } }, 2); h.stop()
  const ledger = new EvidenceLedger(root)
  assert.equal(ledger.latest('session', 'completion.decision').verdict, 'allow_response'); assert.equal(h.prompts.length, 0)
})
test('compiled entry A06 pairs native message.source.callId despite out-of-order duplicate events', t => {
  const root = fixture(t), h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  h.emit('tool/result', { turn: 1, message: { source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'tool-result', toolCallId: 'call-1', isError: true, content: [] }] } }, 3)
  h.emit('tool/call', { turn: 1, callId: 'call-1', name: 'shell', arguments: '{}' }, 2)
  h.emit('tool/call', { turn: 1, callId: 'call-1', name: 'shell', arguments: '{}' }, 2)
  h.emit('tool/call', { turn: 1, callId: 'call-2', name: 'shell', arguments: '{}' }, 4)
  const ledger = new EvidenceLedger(root), calls = ledger.calls('session')
  assert.equal(calls.length, 2); assert.equal(calls.find(c => c.tool_call_id === 'call-1').status, 'failed')
  assert.equal(calls.find(c => c.tool_call_id === 'call-2').status, 'unknown')
  assert.equal(ledger.snapshot('session').filter(r => r.type === 'tool.call').length, 2)
  assert.ok(calls[0].call.task_id); assert.ok(calls[0].result.output_ref)
})
test('compiled entry A12 persists repair quota across restart; synthetic messages never revise task', t => {
  const root = fixture(t), first = host(root)
  first.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  first.stop(); assert.equal(first.prompts.length, 1); assert.equal(first.prompts[0].source.kind, 'system')
  const initialTask = new EvidenceLedger(root).task('session')
  first.emit('user/message', first.prompts[0], 2)
  first.stop(); assert.equal(first.prompts.length, 1)
  const next = host(root); next.stop(2)
  const ledger = new EvidenceLedger(root)
  assert.equal(ledger.task('session').objective_revision, initialTask.objective_revision)
  assert.equal(ledger.latest('session', 'completion.decision').verdict, 'incomplete')
  assert.equal(ledger.auditState('session', initialTask.task_id).repair_count, 1); assert.equal(next.prompts.length, 0)
})
test('A04 object digest covers actual uncommitted code, tests, config and dependencies', t => {
  const root = fixture(t), paths = ['code.js', 'test.js', 'config.json', 'lock.json'].map(p => join(root, p))
  paths.forEach(p => writeFileSync(p, 'original'))
  for (const p of paths) {
    const before = objectVersionDigest(paths); writeFileSync(p, 'changed')
    assert.notEqual(objectVersionDigest(paths), before); writeFileSync(p, 'original')
  }
  assert.equal(objectVersionDigest(paths), objectVersionDigest([...paths].reverse()))
  assert.throws(() => objectVersionDigest([]), /object_scope_unknown/)
})
test('compiled entry persists trusted evidence with task and requirement association', t => {
  const root = fixture(t), h = host(root, ({ task }) => {
    const i = resolved(task); i.candidate = { claims_success: true, response_kind: 'final_delivery', text: 'Discussion', requirement_claims: [] }
    i.evidence = [{ event_id: 'proof1', task_id: task.task_id, objective_revision: task.objective_revision, requirement_ids: ['AC-1'], object_version_digest: 'o1', environment_digest: 'e1', status: 'passed', complete: true, source_kind: 'host_verifier', verifier_ref: 'test:collector', output_ref: 'output:1', assertion_passed: true }]
    return i
  })
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1); h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Discussion' }] } }, 2); h.stop()
  const ledger = new EvidenceLedger(root), task = ledger.task('session')
  assert.equal(ledger.latest('session', 'completion.decision').verdict, 'verified_complete')
  assert.equal(ledger.verifications('session', task.task_id).length, 1)
  const row = ledger.snapshot('session').find(r => r.type === 'requirement.verification')
  assert.deepEqual(row.requirement_ids, ['AC-1']); assert.equal(row.schema_version, 2)
})
test('legacy ledger is readable but cannot produce v2 proof; corrupt state fails closed', t => {
  const root = fixture(t), file = join(root, 'events.ndjson')
  writeFileSync(file, JSON.stringify({ session_id: 'session', type: 'requirement.verification', payload: { status: 'passed' } }) + '\n')
  assert.deepEqual(new EvidenceLedger(root).verifications('session', 't1'), [])
  writeFileSync(file, readFileSync(file, 'utf8') + '{torn')
  assert.throws(() => new EvidenceLedger(root), /evidence_ledger_corrupt/)
})

test('compiled entry A13 user abort records cancelled; hook abort does not impersonate cancellation', t => {
  const root = fixture(t), h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  h.emit('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'policy' } } }, 2)
  assert.equal(new EvidenceLedger(root).latest('session', 'completion.decision'), undefined)
  h.emit('turn/end', { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }, 3)
  assert.equal(new EvidenceLedger(root).latest('session', 'completion.decision').verdict, 'cancelled')
  h.stop(3); assert.equal(h.prompts.length, 0)
})
test('compiled entry rejects candidate text different from actual assistant message', t => {
  const root = fixture(t), h = host(root, ({ task }) => resolved(task))
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  h.emit('assistant/message', { message: { content: [{ type: 'text', text: 'Everything is complete!' }] } }, 2)
  h.stop()
  const d = new EvidenceLedger(root).latest('session', 'completion.decision')
  assert.equal(d.verdict, 'repair_required'); assert.ok(d.reason_codes.includes('candidate_contract_invalid'))
})
