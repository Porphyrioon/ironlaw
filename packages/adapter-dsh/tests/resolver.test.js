import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceLedger } from '../lib/evidence.js'
// The compiled package entry wires defaultResolveAudit when no config.resolveAudit is given.
import { apply } from '@ironlaw/adapter-dsh'

const fixture = t => { const root = mkdtempSync(join(tmpdir(), 'ironlaw-resolver-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }

// host(root) with no resolver -> the adapter falls back to defaultResolveAudit (the unit under test).
function host(root, resolveAudit) {
  const handlers = new Map(), prompts = []
  const session = { id: 'session' }
  apply({ on(name, fn) { handlers.set(name, fn) }, tools: { guard() {} } }, { evidenceRoot: root, resolveAudit })
  return { handlers, prompts,
    emit(type, data, seq) { handlers.get('session/event')(session, { type, data, seq }) },
    stop(turn = 1) { handlers.get('agent/turn-stopping')({ agent: { session, steer: m => prompts.push(m) }, turn }) },
    /**
     * Fire the registry hook with a canonical result value, as DSH does. The exit code and the
     * captured object version exist only here: the session event stream carries neither, so a
     * fixture that invents a `meta.card:'terminal'` is testing a shape no host produces.
     */
    toolResultHook(callId, name, args, value) {
      handlers.get('tools/result')(
        { callId, rootCallId: callId, name, arguments: args, agent: { session }, signal: new AbortController().signal, token: Symbol('exec') },
        { isError: false, value, content: [] })
    } }
}
/** A shell tool's canonical value: what the host records when a command finishes. */
const canonical = exitCode => ({ kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false,
  timeoutMs: 0, stdout: { text: exitCode === 0 ? 'ok' : 'FAIL', truncated: false }, stderr: { text: '', truncated: false } })
const toolResult = (callId, patch = {}) => ({ turn: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [] }] }, ...patch })
const decision = root => new EvidenceLedger(root).latest('session', 'completion.decision')

test('resolver ① host-verified passing test run yields verified_complete', t => {
  const root = fixture(t), code = join(root, 'code.js'); writeFileSync(code, 'module.exports = 1\n')
  const h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Fix and test' }] }, 1)
  // A mutation whose diff meta carries the affected path -> real object_version_digest.
  h.emit('tool/call', { turn: 1, callId: 'edit-1', name: 'edit', arguments: JSON.stringify({ file_path: code }) }, 2)
  h.emit('tool/result', toolResult('edit-1', { meta: { card: 'diff', diffs: [{ path: code, oldText: null, newText: 'module.exports = 2\n' }] } }), 3)
  // The acceptance proof: a terminal test run that exited 0.
  h.emit('tool/call', { turn: 1, callId: 'test-1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) }, 4)
  h.toolResultHook('test-1', 'bash', { command: 'npm test' }, canonical(0))
  h.emit('tool/result', toolResult('test-1'), 5)
  h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Done; tests pass.' }] } }, 6)
  h.stop(1)
  const ledger = new EvidenceLedger(root), d = decision(root)
  assert.equal(d.verdict, 'verified_complete')
  assert.equal(d.missing_requirements.length, 0)
  assert.equal(h.prompts.length, 0)
  // The proof is host_verifier, requirement-linked, and persisted with a real digest.
  const proof = ledger.verifications('session', ledger.task('session').task_id).find(v => v.status === 'passed')
  assert.equal(proof.source_kind, 'host_verifier'); assert.deepEqual(proof.requirement_ids, ['AC-1'])
  assert.equal(proof.assertion_passed, true); assert.equal(proof.exit_code, 0)
  assert.ok(proof.object_version_digest.startsWith('sha256:'))
})

test('resolver ② final delivery with no host evidence is repair_required', t => {
  const root = fixture(t), h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Do the task' }] }, 1)
  h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Task complete.' }] } }, 2)
  h.stop(1)
  const d = decision(root)
  assert.equal(d.verdict, 'repair_required')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
  assert.equal(h.prompts.length, 1)
})

test('resolver ③ failing test run yields verification_failed', t => {
  const root = fixture(t), code = join(root, 'code.js'); writeFileSync(code, 'x')
  const h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  h.emit('tool/call', { turn: 1, callId: 'edit-1', name: 'edit', arguments: JSON.stringify({ file_path: code }) }, 2)
  h.emit('tool/result', toolResult('edit-1', { meta: { card: 'diff', diffs: [{ path: code, oldText: null, newText: 'y' }] } }), 3)
  // The command ran fine (isError false) but exited non-zero -> a real test failure.
  h.emit('tool/call', { turn: 1, callId: 'test-1', name: 'bash', arguments: JSON.stringify({ command: 'npm test' }) }, 4)
  h.toolResultHook('test-1', 'bash', { command: 'npm test' }, canonical(1))
  h.emit('tool/result', toolResult('test-1'), 5)
  h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'All good!' }] } }, 6)
  h.stop(1)
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'verification_failed'))
})

test('resolver ④ model self-reported success without host evidence is not verified_complete', t => {
  const root = fixture(t), h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  // The model claims success in prose but ran nothing the host can verify.
  h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'All tests passed and the feature is complete!' }] } }, 2)
  h.stop(1)
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.equal(d.verdict, 'repair_required')
})

test('resolver ④b a model-sourced tool record is never minted as host_verifier proof', t => {
  const root = fixture(t), h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  // A tool pair explicitly sourced from the model, even with exit 0, must not become proof.
  h.emit('tool/call', { turn: 1, callId: 'm-1', name: 'bash', arguments: '{}', source: { kind: 'model' } }, 2)
  h.emit('tool/result', { ...toolResult('m-1', { meta: { card: 'terminal', exitCode: 0 } }), source: { kind: 'model' } }, 3)
  h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Verified by me.' }] } }, 4)
  h.stop(1)
  const ledger = new EvidenceLedger(root), d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.equal(ledger.verifications('session', ledger.task('session').task_id).length, 0)
})

test('resolver override: a custom config.resolveAudit takes precedence over the default', t => {
  const root = fixture(t)
  // A custom resolver reports an ordinary discussion claiming no success. The default resolver
  // always claims success, so allow_response here proves the override (not the default) ran.
  const h = host(root, ({ task }) => ({ request_id: 'custom:1',
    task: { ...task, scope: ['fixture'], requirements: [{ requirement_id: 'AC-1', class: 'acceptance', source_kind: 'user_instruction', source_ref: task.source_ref, applicability: 'applicable', status: 'pending' }] },
    candidate: { claims_success: false, response_kind: 'discussion', text: 'Discussing', requirement_claims: [] },
    candidate_check: { status: 'consistent', source_ref: 'host:custom' }, evidence: [], hard_constraints_checked: [],
    object_version_digest: 'o1', context_state_digest: 'c1', environment_digest: 'e1', now: 1 }))
  h.emit('user/message', { source: { kind: 'user' }, content: [] }, 1)
  h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: 'Discussing' }] } }, 2)
  h.stop(1)
  assert.equal(decision(root).verdict, 'allow_response')
})

// Relevance gate (spec §12 A05): a file change plus an exit-0 command reaches
// verified_complete only when the command is a real verification runner. An
// irrelevant command (echo/ls/cat/read/print) must not satisfy acceptance.
function editThenCommand(t, cmd, exitCode = 0) {
  const root = fixture(t), code = join(root, 'code.js'); writeFileSync(code, 'module.exports=1\n')
  const h = host(root)
  h.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: '修复并验证' }] }, 1)
  h.emit('tool/call', { turn: 1, callId: 'edit-1', name: 'edit', arguments: JSON.stringify({ file_path: code }) }, 2)
  h.emit('tool/result', toolResult('edit-1', { meta: { card: 'diff', diffs: [{ path: code, oldText: null, newText: 'module.exports=2\n' }] } }), 3)
  h.emit('tool/call', { turn: 1, callId: 'v-1', name: 'bash', arguments: JSON.stringify({ command: cmd }) }, 4)
  h.toolResultHook('v-1', 'bash', { command: cmd }, canonical(exitCode))
  h.emit('tool/result', toolResult('v-1'), 5)
  h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text: '已修复并验证。' }] } }, 6)
  h.stop(1)
  return decision(root)
}

test('relevance: file change + echo (exit 0) is NOT verified_complete', t => {
  const d = editThenCommand(t, 'echo hello')
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})
test('relevance: file change + ls (exit 0) is NOT verified_complete', t => {
  const d = editThenCommand(t, 'ls -la')
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})
test('relevance: file change + cat (exit 0) is NOT verified_complete', t => {
  const d = editThenCommand(t, 'cat code.js')
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})
test('relevance: file change + npm test (exit 0) IS verified_complete', t => {
  const d = editThenCommand(t, 'npm test')
  assert.equal(d.verdict, 'verified_complete')
  assert.equal(d.missing_requirements.length, 0)
})
test('relevance: a passing runner masked behind cat (cat x && npm test) still verifies', t => {
  const d = editThenCommand(t, 'cat README.md && npm test')
  assert.equal(d.verdict, 'verified_complete')
})
test('relevance: a verification word as a non-verb argument (cat test.js) is NOT verified_complete', t => {
  const d = editThenCommand(t, 'cat test.js')
  assert.notEqual(d.verdict, 'verified_complete')
})

// Exit-code masking (reviewer _maskprobe.mjs): a verifier whose failure is eaten
// by a later `|| true` / `; true` reports aggregate exit 0 and must NOT verify.
test('masking: npm test || true (aggregate exit 0) is NOT verified_complete', t => {
  const d = editThenCommand(t, 'npm test || true', 0)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})
test('masking: npm test; true (aggregate exit 0) is NOT verified_complete', t => {
  const d = editThenCommand(t, 'npm test; true', 0)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})
test('masking: npm test (exit 0) IS verified_complete', t => {
  const d = editThenCommand(t, 'npm test', 0)
  assert.equal(d.verdict, 'verified_complete')
  assert.equal(d.missing_requirements.length, 0)
})
test('masking: npm test (exit 1) is verification_failed', t => {
  const d = editThenCommand(t, 'npm test', 1)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'verification_failed'))
})
test('masking: leading cd /tmp && npm test (exit 0) IS verified_complete', t => {
  const d = editThenCommand(t, 'cd /tmp && npm test', 0)
  assert.equal(d.verdict, 'verified_complete')
})
