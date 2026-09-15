import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceLedger } from '../lib/evidence.js'

const fixture = t => { const root = mkdtempSync(join(tmpdir(), 'ironlaw-ev-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
const lines = root => readFileSync(join(root, 'events.ndjson'), 'utf8').split('\n').filter(l => l.trim())
const v2 = (i, session = 's') => JSON.stringify({ schema_version: 2, event_id: `e${i}`, host: 'dsh', session_id: session, task_id: null, objective_revision: null, requirement_ids: [], turn_id: null, tool_call_id: null, source_kind: 'host_event', operation: 'seed', object_ids: [], object_version_digest: null, result_status: 'unknown', exit_code: null, output_ref: null, started_at: null, ended_at: null, collector_version: 'ironlaw/2.0-p1', type: 'seed', payload: { i }, occurred_at: '2026-01-01T00:00:00.000Z' })

// ① Appending to a large ledger must read only the newly-appended tail, never the whole file.
test('append reads only the byte tail, not the full ledger (injected reader counts bytes)', t => {
  const root = fixture(t), file = join(root, 'events.ndjson'), N = 10000
  const seed = []
  for (let i = 0; i < N; i++) seed.push(v2(i))
  writeFileSync(file, seed.join('\n') + '\n')
  const fullSize = statSync(file).size
  assert.ok(fullSize > 500000, `seed ledger should be large, got ${fullSize}`)

  // B fully loads once at construction (offset = EOF of the seed).
  const B = new EvidenceLedger(root)
  let tailBytes = 0
  const orig = B.readTailBytes.bind(B)
  B.readTailBytes = (f, pos, len) => { tailBytes += len; return orig(f, pos, len) }

  // A separate writer appends one record AFTER B was constructed.
  const A = new EvidenceLedger(root)
  const aRec = A.record('s', 'from-a', { hello: 'world' })

  // B appends; it must read only A's tail, not re-read the 10k seed.
  const bRec = B.record('s', 'from-b', { seq: 1 })

  assert.ok(tailBytes > 0, 'B should read the tail A appended')
  assert.ok(tailBytes < 4096, `tail read ${tailBytes}B should be one record, not the ${fullSize}B file`)
  assert.ok(tailBytes * 50 < fullSize, `tail read ${tailBytes}B must be far below full ${fullSize}B (no linear re-read)`)
  // Incremental read folded in A's record; B's own append succeeded; no duplication on disk.
  const ids = B.snapshot('s').map(r => r.event_id)
  assert.ok(ids.includes(aRec.event_id), 'B must see the record A appended after construction')
  assert.ok(ids.includes(bRec.event_id))
  assert.equal(lines(root).length, N + 2)
})

// ② Idempotency: same event_id + identical content returns the existing record and adds no line.
test('record is idempotent for the same event_id and identical content', t => {
  const root = fixture(t), ledger = new EvidenceLedger(root)
  const link = { event_id: 'idem-1', task_id: 't', objective_revision: 1 }
  const first = ledger.record('s', 'tool.call', { a: 1 }, link)
  const second = ledger.record('s', 'tool.call', { a: 1 }, link)
  assert.equal(second.event_id, first.event_id)
  assert.deepEqual(second, first)
  assert.equal(lines(root).length, 1, 'idempotent record must not append a line')
  assert.equal(new EvidenceLedger(root).snapshot('s').length, 1)
})

// ③ Conflict: same event_id + different content (payload or link field) throws and appends nothing.
test('record throws evidence_event_id_conflict for same id with different content', t => {
  const root = fixture(t), ledger = new EvidenceLedger(root)
  ledger.record('s', 'tool.call', { a: 1 }, { event_id: 'c1', task_id: 't' })
  assert.throws(() => ledger.record('s', 'tool.call', { a: 2 }, { event_id: 'c1', task_id: 't' }), /evidence_event_id_conflict/)
  assert.throws(() => ledger.record('s', 'tool.call', { a: 1 }, { event_id: 'c1', task_id: 'other' }), /evidence_event_id_conflict/)
  assert.throws(() => ledger.record('s', 'tool.result', { a: 1 }, { event_id: 'c1', task_id: 't' }), /evidence_event_id_conflict/)
  assert.equal(lines(root).length, 1, 'a rejected conflict must not append a line')
  // The lock is released after the throw, so the ledger is still usable.
  assert.ok(ledger.record('s', 'tool.call', { a: 1 }, { event_id: 'c2', task_id: 't' }).event_id)
})

// ④ Multi-instance ordering: an already-constructed instance sees records another instance appends later.
test('a constructed instance sees records another instance appends afterwards', t => {
  const root = fixture(t)
  const A = new EvidenceLedger(root), B = new EvidenceLedger(root)
  const a1 = A.record('s', 'evt', { who: 'a1' })
  const b1 = B.record('s', 'evt', { who: 'b1' })
  const order = B.snapshot('s').map(r => r.event_id)
  assert.ok(order.includes(a1.event_id), 'B must see A record appended after B was constructed')
  assert.ok(order.includes(b1.event_id))
  assert.ok(order.indexOf(a1.event_id) < order.indexOf(b1.event_id), 'append order preserved')
  assert.equal(lines(root).length, 2)
  assert.equal(new EvidenceLedger(root).snapshot('s').length, 2)
})

// Known pit: a torn trailing line (interrupted write) must not crash the live reader and must not be ingested.
test('incremental read tolerates a torn trailing line without throwing or ingesting it', t => {
  const root = fixture(t), file = join(root, 'events.ndjson')
  const ledger = new EvidenceLedger(root)
  ledger.record('s', 'evt', { n: 1 })
  appendFileSync(file, '{"event_id":"torn","session_id":"s"') // partial line, no newline
  const rec = ledger.record('s', 'evt', { n: 2 }) // must not throw on the torn tail
  const ids = ledger.snapshot('s').map(r => r.event_id)
  assert.ok(!ids.includes('torn'), 'the incomplete fragment must not be ingested')
  assert.ok(ids.includes(rec.event_id), 'the live writer still records its own event')
  assert.equal(ledger.snapshot('s').filter(r => r.type === 'evt').length, 2)
})

// ⑤ Existing evidence guarantees, asserted directly: corrupt fails closed, legacy is read-only.
test('a corrupt ledger fails closed on construction', t => {
  const root = fixture(t), file = join(root, 'events.ndjson')
  writeFileSync(file, v2(0) + '\n' + '{torn')
  assert.throws(() => new EvidenceLedger(root), /evidence_ledger_corrupt/)
})
test('legacy rows stay readable but never become v2 proof', t => {
  const root = fixture(t), file = join(root, 'events.ndjson')
  writeFileSync(file, JSON.stringify({ session_id: 's', type: 'requirement.verification', payload: { status: 'passed' } }) + '\n')
  const ledger = new EvidenceLedger(root)
  assert.deepEqual(ledger.verifications('s', 't1'), [])
  assert.equal(ledger.snapshot('s').length, 1)
})

// ⑥ recover() must re-read the durable bytes for that one session, not rebuild a whole
// ledger: a per-turn full re-read is what made adjudication cost O(ledger size).
test('recover reads only the requested session range, and matches a cold full read', t => {
  const root = fixture(t), file = join(root, 'events.ndjson')
  const seed = []
  for (let i = 0; i < 5000; i++) seed.push(v2(i, `other-${i % 5}`))
  writeFileSync(file, seed.join('\n') + '\n')
  const fullSize = statSync(file).size
  const ledger = new EvidenceLedger(root)
  const a = ledger.record('mine', 'seed', { i: 'a' })
  const b = ledger.record('mine', 'seed', { i: 'b' })

  let bytes = 0
  const orig = ledger.readTailBytes.bind(ledger)
  ledger.readTailBytes = (f, pos, len) => { bytes += len; return orig(f, pos, len) }
  const view = ledger.recover('mine')

  assert.deepEqual(view.records.map(r => r.event_id), [a.event_id, b.event_id])
  assert.equal(view.event_sequence, 2)
  assert.ok(bytes > 0, 'recover must read something from disk (never proof from memory alone)')
  assert.ok(bytes * 10 < fullSize, `recover read ${bytes}B of a ${fullSize}B ledger; it must not re-read the file`)

  // Same answer as a cold instance that parsed the whole ledger.
  const cold = new EvidenceLedger(root)
  assert.deepEqual(view.records, cold.snapshot('mine'))
  assert.deepEqual(cold.verifications('mine', 't1'), [])
})

// ⑦ A session whose records all arrived before this instance existed still recovers.
test('recover returns a session that predates the instance', t => {
  const root = fixture(t), file = join(root, 'events.ndjson')
  const seed = []
  for (let i = 0; i < 500; i++) seed.push(v2(i, 'old-session'))
  seed.push(v2(501, 'other'))
  writeFileSync(file, seed.join('\n') + '\n')
  const view = new EvidenceLedger(root).recover('old-session')
  assert.equal(view.records.length, 500)
  assert.equal(view.event_sequence, 500)
  assert.equal(view.records.map(r => r.event_id)[0], 'e0')
})

// ⑧ A corrupt line in the tail must leave the instance exactly as it was. readTail
// ingested each good line as it parsed and only advanced its offset after the whole
// chunk succeeded, so throwing on a corrupt line left the good prefix ingested with an
// unmoved offset: the next call re-ingested that same prefix. recover() now calls
// readTail on the long-lived instance once per turn, so one corrupt line duplicated the
// tail into memory on every turn, forever.
test('a corrupt tail line throws without duplicating the good prefix on retry', t => {
  const root = fixture(t), file = join(root, 'events.ndjson')
  writeFileSync(file, v2(1, 'mine') + '\n' + v2(2, 'mine') + '\n')
  const ledger = new EvidenceLedger(root)
  const before = ledger.snapshot('mine').length
  assert.equal(before, 2)

  // Another writer appends two good lines and then a corrupt one.
  appendFileSync(file, v2(3, 'mine') + '\n' + v2(4, 'mine') + '\n' + '{"broken": ]\n')
  let throws = 0
  for (let i = 0; i < 5; i++) {
    try { ledger.recover('mine') } catch (e) { assert.equal(e.message, 'evidence_ledger_corrupt'); throws++ }
  }
  assert.equal(throws, 5, 'a corrupt tail must keep failing closed')
  assert.equal(ledger.snapshot('mine').length, before,
    `good prefix re-ingested on every retry: ${before} -> ${ledger.snapshot('mine').length}`)

  // Once the corrupt line is gone the tail folds in exactly once.
  writeFileSync(file, readFileSync(file, 'utf8').replace('{"broken": ]\n', ''))
  ledger.record('mine', 'seed', { i: 5 })
  const ids = ledger.snapshot('mine').map(r => r.event_id)
  assert.deepEqual(ids, ['e1', 'e2', 'e3', 'e4', ids.at(-1)], `unexpected ids ${JSON.stringify(ids)}`)
  assert.equal(new Set(ids).size, ids.length, 'no record may appear twice')
})

// ⑨ recover() reads a byte range that was captured earlier, so it has to fold in what
// another writer appended since. sessionBytes() calls readTail() for exactly this;
// without it the range is stale and another process's records never reach adjudication.
test('recover folds in records another instance appended after construction', t => {
  const root = fixture(t)
  writeFileSync(join(root, 'events.ndjson'), v2(1, 'mine') + '\n')
  const A = new EvidenceLedger(root)
  assert.equal(A.recover('mine').records.length, 1)

  const B = new EvidenceLedger(root)
  B.record('mine', 'from-b', { n: 2 })
  B.record('mine', 'from-b', { n: 3 })
  const view = A.recover('mine')
  assert.equal(view.records.length, 3, 'A must see what B appended after A was constructed')
  assert.equal(view.event_sequence, 3)
  assert.deepEqual(view.records.map(r => r.payload).slice(1), [{ n: 2 }, { n: 3 }])

  // A session A has never written to has no range at all until the tail is folded in.
  B.record('brand-new', 'from-b', { n: 1 })
  assert.equal(A.recover('brand-new').records.length, 1, 'a session A never wrote must still recover')
})
