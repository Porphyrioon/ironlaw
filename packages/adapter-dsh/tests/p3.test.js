import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EvidenceLedger, ContextStore, retainCapsule, DependencyRetriever, taskCost, calibrate, selectSlice } from '@ironlaw/adapter-dsh'

const fixture = JSON.parse(readFileSync(new URL('../fixtures/p3-trace.json', import.meta.url), 'utf8'))
const rates = { cached_input: 1, uncached_input: 10, cache_write: 12, output: 20 }
const usage = (extra = {}) => ({ call_id: 'c1', task_id: 't', usage_ref: 'provider:1', kind: 'main',
  input_tokens: 100, cached_input: 40, cache_write: 10, input_includes_write: true, output: 5,
  latency_ms: 100, retry: false, rework: false, service_cost: 0, ...extra })

async function archive(t) {
  const root = mkdtempSync(join(tmpdir(), 'ironlaw-p3-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const ledger = new EvidenceLedger(root), store = new ContextStore(ledger)
  ledger.record('s', 'task.contract', { schema_version: 2, task_id: 'task', objective_revision: 1,
    source_ref: 'human:1', scope: ['code'], status: 'active', requirements: [] })
  store.saveStructure('s', { task_id: 'task', objective_revision: 1, objective: 'Investigate', todos: [], key_reasons: [], evidence_refs: [],
    entries: [{ id: 'e', version: 'v1', when: 'test', environment: 'fixture', object: 'code', purpose: 'Investigate',
      reasons: ['failed'], dependencies: [], action: 'read', result: 'failed', source_kind: 'host_event', source_ref: 'result:1',
      certainty: 'fact', expires_at: null, requirement_ids: [], load_when: 'dependency', original: 'Original failure reason', disposition: 'ARCHIVE_INDEX' }] })
  const result = await store.compact('s', capsule => ({ facts: [], assumptions: [], unknowns: [], capsule: retainCapsule(capsule) }))
  assert.equal(result.committed, true)
  return { store, root, entry: result.version.index[0] }
}

test('P3 actual archive loads only on new validated signals and persists consumption across restart', async t => {
  const { store, root, entry } = await archive(t)
  let retriever = new DependencyRetriever(store)
  const signal = { dependency_refs: [], state_digest: 'v1', similarity: 1 }
  assert.equal(retriever.retrieve('s', entry, signal, () => true).status, 'not_loaded')
  const first = { ...signal, dependency_refs: ['step:1'] }
  assert.deepEqual(retriever.retrieve('s', entry, first, () => true), { status: 'found', original: 'Original failure reason' })
  retriever = new DependencyRetriever(new ContextStore(new EvidenceLedger(root)))
  assert.equal(retriever.retrieve('s', entry, { ...first, similarity: 999 }, () => true).status, 'not_loaded')
  assert.equal(retriever.retrieve('s', entry, { ...first, state_digest: 'v2' }, () => true).status, 'found')
  const explicit = { ...first, state_digest: 'v2', explicit_request_ref: 'user:2' }
  assert.equal(retriever.retrieve('s', entry, explicit, () => true).status, 'found')
  assert.equal(retriever.retrieve('s', entry, explicit, () => true).status, 'not_loaded')
  assert.equal(retriever.retrieve('s', entry, { ...explicit, dependency_refs: ['step:2'] }, () => true).status, 'found')
})
test('P3 A16 corrupt archive returns missing and repeated failed request is not retried', async t => {
  const { store, entry } = await archive(t)
  const directory = join(store.root, readdirSync(store.root)[0])
  writeFileSync(join(directory, entry.recoverable_location.split('#')[0]), '{}')
  const signal = { dependency_refs: [], state_digest: 'v1', explicit_request_ref: 'user:1' }
  const retriever = new DependencyRetriever(store)
  assert.deepEqual(retriever.retrieve('s', entry, signal, () => true), { status: 'missing' })
  assert.equal(retriever.retrieve('s', entry, signal, () => true).status, 'not_loaded')
  assert.equal(retriever.retrieve('s', entry, { ...signal, explicit_request_ref: 'user:2' }, () => true).status, 'missing')
})
test('P3 retrieval rejects untrusted signals without consuming valid subsequent request', async t => {
  const { store, entry } = await archive(t), retriever = new DependencyRetriever(store)
  const signal = { dependency_refs: ['step'], state_digest: 'v1' }
  assert.equal(retriever.retrieve('s', entry, signal, () => false).status, 'missing')
  assert.equal(retriever.retrieve('s', entry, signal, () => true).status, 'found')
})
test('P3 cache input conventions normalize to disjoint categories, auxiliary calls counted once', () => {
  const call = usage(), summary = usage({ call_id: 'c2', kind: 'summary', input_tokens: 90,
    input_includes_write: false, retry: true, rework: true, service_cost: 3 })
  const result = taskCost('t', [call, call, summary], rates)
  assert.deepEqual(result.categories, { cached_input: 80, uncached_input: 100, cache_write: 20, output: 10 })
  assert.equal(result.total_cost, 1523)
  assert.deepEqual(result.hit_rate, { numerator: 80, denominator: 200, denominator_definition: 'all input tokens including writes', value: 0.4 })
  assert.equal(result.calls, 2); assert.equal(result.auxiliary_calls, 1)
  assert.equal(result.retries, 1); assert.equal(result.rework, 1); assert.equal(result.latency_ms_sum, 200)
})
test('P3 unknown convention, overlapping categories, invalid usage and conflicting call IDs fail', () => {
  for (const patch of [{ input_includes_write: undefined }, { cached_input: 101 }, { output: -1 }, { cache_write: 1.5 },
    { input_tokens: NaN }, { task_id: 'other' }, { usage_ref: '' }, { service_cost: Infinity }])
    assert.throws(() => taskCost('t', [usage(patch)], rates))
  assert.throws(() => taskCost('t', [usage(), usage({ output: 6 })], rates), /duplicate_conflict/)
  assert.throws(() => taskCost('t', [], { ...rates, output: -1 }), /rate_invalid/)
  assert.equal(taskCost('t', [], rates).hit_rate.value, null)
})
test('P3 A22 lower cache hit rate can coexist with lower whole-task cost', () => {
  const before = taskCost('t', [usage({ input_tokens: 1000, cached_input: 900, cache_write: 0 })], rates)
  const after = taskCost('t', [usage({ input_tokens: 50, cached_input: 0, cache_write: 0 }),
    usage({ call_id: 'helper', kind: 'retrieval', input_tokens: 10, cached_input: 0, cache_write: 0, output: 1 })], rates)
  assert.ok(after.hit_rate.value < before.hit_rate.value)
  assert.ok(after.total_cost < before.total_cost)
})
test('P3 four nonempty policies share identical slice and budget; dependencies recover version packages', () => {
  const report = calibrate([fixture.slices[0]])
  assert.equal(report.rows.length, 4)
  const [dep, age, similarity, length] = report.rows
  assert.deepEqual(dep.selected, ['goal', 'hard', 'step', 'proof', 'version'])
  assert.equal(dep.constraint_retention.value, 1); assert.equal(dep.state_accuracy.value, 1)
  assert.equal(dep.evidence_recovery.value, 1); assert.equal(dep.critical_deletion.value, 0)
  assert.equal(age.constraint_retention.value, 0)
  assert.equal(age.evidence_recovery.value, 1)
  assert.equal(similarity.state_accuracy.value, 1); assert.equal(similarity.evidence_recovery.value, 0)
  assert.equal(length.evidence_recovery.value, 0)
  assert.ok(report.rows.every(r => r.used_units <= 10 && r.selected.length > 0))
})
test('P3 oracle labels cannot influence selection and missing archive is not restored evidence', () => {
  const original = fixture.slices[0], changed = structuredClone(original)
  changed.oracle = { constraints: [], critical: [], states: [], evidence: [] }
  for (const strategy of ['dependency', 'age', 'similarity', 'length'])
    assert.deepEqual(selectSlice(original, strategy), selectSlice(changed, strategy))
  const row = calibrate([fixture.slices[1]]).rows[0]
  assert.equal(row.state_accuracy.value, 1); assert.equal(row.evidence_recovery.value, 0)
})
test('P3 invalid budgets fail and hard dependency package cannot be silently truncated', () => {
  const slice = structuredClone(fixture.slices[0]); slice.budget_units = 1
  const selected = selectSlice(slice, 'dependency')
  assert.equal(selected.configuration_unsatisfiable, true); assert.deepEqual(selected.selected, [])
  slice.budget_units = -1; assert.throws(() => selectSlice(slice, 'dependency'))
})
test('P3 harness real CLI produces byte-identical reports across two independent executions', () => {
  const script = new URL('../scripts/calibrate.mjs', import.meta.url)
  const a = execFileSync(process.execPath, [fileURLToPath(script)], { encoding: 'utf8' })
  const b = execFileSync(process.execPath, [fileURLToPath(script)], { encoding: 'utf8' })
  assert.equal(a, b)
  const report = JSON.parse(a)
  assert.equal(report.rows.length, 8); assert.equal(report.production_benefit, 'evidence_insufficient')
  assert.equal(report.confidence_interval, null)
})
test('P3 missing dependency excludes the whole pending evidence package; cycles terminate', () => {
  const slice = structuredClone(fixture.slices[0])
  slice.entries.find(e => e.id === 'proof').dependencies.push('missing')
  let result = selectSlice(slice, 'dependency')
  assert.deepEqual(result.selected, ['goal', 'hard']); assert.deepEqual(result.missing_dependencies, ['missing'])
  slice.entries.find(e => e.id === 'proof').dependencies = ['version', 'step']
  result = selectSlice(slice, 'dependency')
  assert.equal(result.selected.length, 5)
  assert.throws(() => selectSlice(slice, 'unrecognized'), /invalid/)
})
test('P3 aggregate denominators and baseline differences are explicit', () => {
  const report = calibrate(fixture.slices), dep = report.aggregate[0]
  assert.deepEqual(dep.metrics.evidence_recovery, { numerator: 1, denominator: 2, value: 0.5 })
  assert.deepEqual(dep.metrics.critical_deletion, { numerator: 0, denominator: 9, value: 0 })
  assert.equal(report.differences[0].dependency_minus_baseline.constraint_retention, 0.5)
})
