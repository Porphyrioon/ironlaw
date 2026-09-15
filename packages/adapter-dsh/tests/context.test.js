import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceLedger, ContextStore, retainCapsule, apply } from '@ironlaw/adapter-dsh'
import { auditTurn } from '../lib/audit.js'

const summary = capsule => ({ facts: ['Recorded output, not independent proof'], assumptions: [], unknowns: ['Host rewrite support'], capsule: retainCapsule(capsule) })
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ironlaw-p2-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ledger = new EvidenceLedger(root), store = new ContextStore(ledger)
  const task = { schema_version: 2, task_id: 'task', objective_revision: 1, source_ref: 'human:1', scope: ['code'], status: 'active',
    requirements: [{ requirement_id: 'H', class: 'hard', source_kind: 'user_instruction', source_ref: 'human:1', applicability: 'applicable', status: 'unknown' }] }
  ledger.record('s', 'task.contract', task, { task_id: 'task', objective_revision: 1 })
  const entry = { id: 'E1', version: 'v1', when: '2026-09-15', environment: 'Windows test', object: 'code', purpose: 'Test', reasons: ['Old version failed'], dependencies: ['config:v1'], action: 'run tests', result: 'recorded', source_kind: 'host_event', source_ref: 'result:1', certainty: 'fact', expires_at: null, requirement_ids: ['H'], load_when: 'when changing config', original: 'original raw output '.repeat(400), disposition: 'ARCHIVE_INDEX' }
  const structure = { task_id: 'task', objective_revision: 1, objective: 'Preserve constraints', todos: ['Review config'], key_reasons: ['Previous failure must remain recoverable'], evidence_refs: ['result:1'], entries: [entry] }
  store.saveStructure('s', structure)
  return { root, ledger, store, task, structure }
}
test('A10 compiled API: persist/read originals before summary, commit capsule and recover unchanged proof', async t => {
  const { root, ledger, store, task } = fixture(t)
  const proof = { event_id: 'proof', task_id: 'task', objective_revision: 1, requirement_ids: ['H'], object_version_digest: 'objects', environment_digest: 'env', status: 'passed', complete: true, source_kind: 'host_verifier', verifier_ref: 'collector', output_ref: 'result:1', assertion_passed: true }
  ledger.record('s', 'requirement.verification', proof, { event_id: 'proof', task_id: 'task', objective_revision: 1, requirement_ids: ['H'] })
  const input = { request_id: 'first', task, candidate: { claims_success: true, response_kind: 'final_delivery', text: 'Done', requirement_claims: [] }, candidate_check: { status: 'consistent', source_ref: 'host' }, evidence: [proof], hard_constraints_checked: [{ requirement_id: 'H', applicability: 'applicable', status: 'compliant', check_ref: 'host' }], object_version_digest: 'objects', environment_digest: 'env', context_state_digest: 'old', now: 1 }
  const beforeAudit = auditTurn(input)
  assert.equal(beforeAudit.decision.verdict, 'verified_complete')
  ledger.record('s', 'completion.state', beforeAudit.state, { task_id: 'task' })
  const before = ledger.recover('s')
  const result = await store.compact('s', capsule => {
    const dir = join(store.root, readdirSync(store.root)[0])
    const file = readdirSync(dir).find(f => f.endsWith('.archive.json'))
    assert.deepEqual(JSON.parse(readFileSync(join(dir, file), 'utf8')), capsule)
    return summary(capsule)
  })
  assert.equal(result.committed, true)
  assert.equal(result.version.previous, null)
  const restart = new EvidenceLedger(root).recover('s')
  assert.deepEqual(restart, before)
  assert.equal(auditTurn({ ...input, request_id: 'after', evidence: restart.evidence, task: restart.task, previous: restart.audit, context_state_digest: result.version.version }).decision.verdict, 'verified_complete')
  assert.ok(JSON.stringify(result.version).length < JSON.stringify(before).length)
  assert.deepEqual(new ContextStore(new EvidenceLedger(root)).current('s'), result.version)
})
test('A10 replay isolates revision/task IDs, pairs out-of-order results and keeps missing results unknown', t => {
  const { root, ledger } = fixture(t), link = { task_id: 'task', objective_revision: 1, requirement_ids: ['H'], tool_call_id: 'c' }
  ledger.record('s', 'tool.result', {}, { ...link, event_id: 'r', result_status: 'passed' })
  ledger.record('s', 'tool.call', {}, { ...link, event_id: 'c' })
  new EvidenceLedger(root).record('s', 'tool.call', {}, { ...link, event_id: 'c' })
  assert.throws(() => ledger.record('s', 'tool.call', {}, { ...link, event_id: 'c', requirement_ids: ['other'] }), /conflict/)
  ledger.record('s', 'tool.call', {}, { ...link, objective_revision: 2, event_id: 'c2' })
  const recovered = new EvidenceLedger(root).recover('s')
  assert.equal(recovered.calls.length, 2)
  assert.equal(recovered.calls[0].status, 'passed'); assert.equal(recovered.calls[1].status, 'unknown')
  assert.deepEqual(recovered.calls[0].call.requirement_ids, ['H'])
})
test('A10 compiled apply exposes recovered evidence to trusted resolver after restart', t => {
  const { root, ledger } = fixture(t)
  ledger.record('s', 'tool.call', {}, { task_id: 'task', event_id: 'pending', tool_call_id: 'pending' })
  let recovered
  const handlers = new Map()
  apply({ on: (name, handler) => handlers.set(name, handler), tools: { guard() {} } }, { evidenceRoot: root,
    resolveAudit: context => { recovered = context.recovery; throw new Error('inspection complete') } })
  assert.throws(() => handlers.get('agent/turn-stopping')({ agent: { session: { id: 's' } }, turn: 2 }), /inspection complete/)
  assert.equal(recovered.task.task_id, 'task'); assert.equal(recovered.calls[0].status, 'unknown')
})
test('A11 archive write failure never calls summarizer or replaces previous version', async t => {
  const { store } = fixture(t)
  const first = await store.compact('s', summary)
  assert.equal(first.committed, true)
  const dir = join(store.root, readdirSync(store.root)[0])
  const blocked = join(dir, 'blocked'); writeFileSync(blocked, 'not a directory')
  const broken = new ContextStore(store.ledger, blocked)
  let called = false
  assert.equal((await broken.compact('s', () => { called = true; throw new Error() })).committed, false)
  assert.equal(called, false); assert.equal(store.current('s').version, first.version.version)
})
test('A11 summary cannot omit a hard constraint, goal, todo, reason, evidence ref or certainty sections', async t => {
  const { store } = fixture(t)
  const first = await store.compact('s', summary)
  for (const mutate of [s => s.capsule.task.requirements.pop(), s => s.capsule.objective = '', s => s.capsule.todos.pop(), s => s.capsule.key_reasons.pop(), s => s.capsule.evidence_refs.pop(), s => delete s.unknowns]) {
    const result = await store.compact('s', capsule => { const s = summary(capsule); mutate(s); return s })
    assert.equal(result.committed, false); assert.equal(result.reason, 'context_summary_incomplete')
    assert.equal(store.current('s').version, first.version.version)
  }
})
test('transaction rejects new events after prepare and after validation, retaining prior pointer', async t => {
  const { store, ledger } = fixture(t), first = await store.compact('s', summary)
  let p = store.prepare('s')
  ledger.record('s', 'tool.call', {}, { tool_call_id: 'late' })
  assert.throws(() => store.validate(p, summary(p.capsule)), /events_changed/)
  p = store.prepare('s'); const v = store.validate(p, summary(p.capsule))
  new EvidenceLedger(ledger.root).record('s', 'session.event', { arrived: true })
  assert.throws(() => store.commit(v), /events_changed/)
  assert.equal(store.current('s').version, first.version.version)
})
test('atomic pointer swap has rollback, rejects competing commit and recovers original after repeated compact', async t => {
  const { store } = fixture(t), first = await store.compact('s', summary)
  const competing = store.prepare('s'), validated = store.validate(competing, summary(competing.capsule))
  const second = await store.compact('s', summary)
  assert.equal(second.version.previous, first.version.version)
  assert.throws(() => store.commit(validated), /version_conflict/)
  assert.equal(store.retrieve('s', second.version.index[0]).original, competing.capsule.structure.entries[0].original)
  assert.equal(store.rollback('s').version, first.version.version)
  assert.equal(store.current('s').version, first.version.version)
})
test('A11 pointer staging failure and corrupt archive cannot replace old version', async t => {
  const { store } = fixture(t), first = await store.compact('s', summary)
  const p = store.prepare('s'), v = store.validate(p, summary(p.capsule))
  const dir = join(store.root, readdirSync(store.root)[0])
  writeFileSync(join(dir, p.archive), '{}')
  assert.throws(() => store.commit(v), /summary_incomplete/)
  assert.equal(store.current('s').version, first.version.version)
  // A directory at the temporary-pointer name causes failure after immutable version persistence.
  const p2 = store.prepare('s'), v2 = store.validate(p2, summary(p2.capsule))
  mkdirSync(join(dir, `${p2.token}.pointer.tmp`))
  assert.throws(() => store.commit(v2), /EEXIST/)
  assert.equal(store.current('s').version, first.version.version)
})
test('A16 archive index retains event metadata and missing retrieval never invokes tools', async t => {
  const { store, structure } = fixture(t), { version } = await store.compact('s', summary)
  const index = version.index[0]
  for (const key of ['when', 'environment', 'object', 'purpose', 'reasons', 'dependencies', 'action', 'result', 'source_kind', 'source_ref', 'certainty', 'expires_at', 'requirement_ids', 'load_when']) assert.deepEqual(index[key], structure.entries[0][key])
  assert.equal(store.retrieve('s', index).status, 'found')
  assert.equal(store.retrieve('s', { ...index, recoverable_location: '../events.ndjson#E1' }).status, 'missing')
  const dir = join(store.root, readdirSync(store.root)[0])
  rmSync(join(dir, version.archive))
  assert.deepEqual(store.retrieve('s', index), { status: 'missing' })
})
test('DROP_ACTIVE is unavailable without a cumulative-loss policy; hard constraints stay in capsule', t => {
  const { store, structure } = fixture(t)
  structure.entries[0].disposition = 'DROP_ACTIVE'
  assert.throws(() => store.saveStructure('s', structure), /drop_disabled/)
})
test('transaction handles cannot be modified to bypass stale-event or capsule validation', t => {
  const { store } = fixture(t)
  const p = store.prepare('s'); p.snapshot_digest = 'forged'
  assert.throws(() => store.validate(p, summary(p.capsule)), /prepared_changed/)
  const p2 = store.prepare('s'), v = store.validate(p2, summary(p2.capsule))
  v.version.summary.capsule.task.requirements.pop()
  assert.throws(() => store.commit(v), /validated_changed/)
  assert.equal(store.current('s'), undefined)
})
