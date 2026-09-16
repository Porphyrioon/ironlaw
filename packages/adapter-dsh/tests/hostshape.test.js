// Real-host-shape fixture.
//
// Nothing in this file emits `meta.card` or `meta.exitCode`. A live DSH session does
// not produce them: across 37382 records of a real ledger there are 1807
// `payload.data.meta` objects and zero carry a `card` key (the real shapes are
// read/glob/diff output), and `exit_code` is null on every single record. The exit
// code exists only in `ToolExecutionSuccess.value`, which @deepseek-ai/dsh-tools
// documents as "execution-local, deliberately omitted from durable events", so it
// reaches the ledger only through the `tools/result` hook.
//
// These tests therefore drive the hook directly and keep the session event stream
// card-free, which is the shape the resolver has to work against.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceLedger } from '../lib/evidence.js'
import { apply } from '@ironlaw/adapter-dsh'

const fixture = t => { const root = mkdtempSync(join(tmpdir(), 'ironlaw-hs-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }

function host(root, extra = {}) {
  const handlers = new Map(), prompts = []
  const session = { id: 'session', ...extra }
  apply({ on(name, fn) { handlers.set(name, fn) }, tools: { guard() {} } }, { evidenceRoot: root })
  return {
    prompts,
    emit(type, data, seq) { handlers.get('session/event')(session, { type, data, seq }) },
    stop(turn = 1) { handlers.get('agent/turn-stopping')({ agent: { session, steer: m => prompts.push(m) }, turn }) },
    /** Fire the registry hook with a canonical result value, as DSH does. */
    toolResultHook(callId, name, args, value) {
      const exec = { callId, rootCallId: callId, name, arguments: args, agent: { session }, signal: new AbortController().signal, token: Symbol('exec') }
      const result = value && value.isError === true
        ? { isError: true, error: { kind: 'tool_failure', message: 'failed' }, content: [] }
        : { isError: false, value, content: [] }
      handlers.get('tools/result')(exec, result)
    },
  }
}

const ledger = root => new EvidenceLedger(root)
const decision = root => ledger(root).latest('session', 'completion.decision')
const taskType = root => ledger(root).latest('session', 'task.classification')?.task_type
const outcomeRecords = root => ledger(root).snapshot('session').filter(r => r.type === 'tool.outcome')
const proofs = root => { const l = ledger(root); return l.verifications('session', l.task('session').task_id).filter(v => v.status === 'passed') }

const user = (h, text, seq = 1) => h.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] }, seq)
const assistant = (h, text, seq) => h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text }] } }, seq)
// A session tool/result event with no meta at all: the real stream carries none for shell tools.
const sessResult = callId => ({ turn: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [] }] } })
// The failure channel the plugin reads for `result_status: 'failed'`: an isError content block.
const sessFailed = callId => ({ turn: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: true, content: [] }] } })
const edit = (h, callId, path, cSeq, rSeq) => {
  const args = { file_path: path, old_string: 'a', new_string: 'b' }
  h.emit('tool/call', { turn: 1, callId, name: 'edit', arguments: JSON.stringify(args) }, cSeq)
  h.toolResultHook(callId, 'edit', args, { ok: true }) // the capture a docs/write proof needs
  // Real edit meta is a bare diffs array with no `card` discriminator.
  h.emit('tool/result', { ...sessResult(callId), meta: { diffs: [{ path, oldText: 'a', newText: 'b' }] } }, rSeq)
}
/**
 * A shell call exactly as the real host produces it: parsed arguments to the hook, a
 * card-free session event, and the exit code delivered only through the hook's
 * canonical value. The tool name selects the masking dialect.
 */
const shell = (h, callId, command, exitCode, cSeq, rSeq, toolName = 'pwsh') => {
  const args = { command, description: 'run the command' }
  h.emit('tool/call', { turn: 1, callId, name: toolName, arguments: JSON.stringify(args) }, cSeq)
  h.toolResultHook(callId, toolName, args, {
    kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
    stdout: { text: exitCode === 0 ? 'ok' : 'boom', truncated: false }, stderr: { text: '', truncated: false },
  })
  h.emit('tool/result', sessResult(callId), rSeq)
}
const named = (h, callId, name, args, cSeq, rSeq) => {
  h.emit('tool/call', { turn: 1, callId, name, arguments: JSON.stringify(args) }, cSeq)
  h.toolResultHook(callId, name, args, { ok: true })
  h.emit('tool/result', sessResult(callId), rSeq)
}
/** A search whose durable result carries text — the shape a citation is checked against. */
const searched = (h, callId, query, resultText, cSeq, rSeq) => {
  const args = { query }
  h.emit('tool/call', { turn: 1, callId, name: 'web_search', arguments: JSON.stringify(args) }, cSeq)
  h.toolResultHook(callId, 'web_search', args, { ok: true })
  h.emit('tool/result', { turn: 1, message: { source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, isError: false,
      content: [{ type: 'text', text: resultText }] }] } }, rSeq)
}

// The hook is the fix: without a tool.outcome record the resolver has no exit code.
test('H1 the tools/result hook persists a canonical outcome keyed by call id', t => {
  const root = fixture(t), h = host(root)
  user(h, '修复登录的 bug 并验证')
  shell(h, 'v1', 'npm test', 0, 2, 3)
  assistant(h, '已修复。', 4)
  h.stop(1)
  const recs = outcomeRecords(root)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].tool_call_id, 'v1')
  assert.equal(recs[0].exit_code, 0)
  assert.equal(recs[0].payload.command, 'npm test')
  assert.equal(recs[0].payload.name, 'pwsh')
  assert.equal(recs[0].payload.is_error, false)
})

test('H2 fixture hygiene: no record ever carries meta.card or meta.exitCode', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'x\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  named(h, 'r1', 'read', { file_path: code }, 6, 7)
  assistant(h, '已修复并通过测试。', 8)
  h.stop(1)
  for (const r of ledger(root).snapshot('session')) {
    const meta = r.payload?.data?.meta
    if (!meta || typeof meta !== 'object') continue
    assert.ok(!('card' in meta), `meta.card leaked into ${r.type}`)
    assert.ok(!('exitCode' in meta), `meta.exitCode leaked into ${r.type}`)
  }
})

// A: the acceptance criterion. A code task verified by a real-host shell result.
test('A code: real-host npm test exit 0 IS verified_complete', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'module.exports=1\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并通过测试。', 6)
  h.stop(1)
  assert.equal(taskType(root), 'code')
  const d = decision(root)
  assert.equal(d.verdict, 'verified_complete', JSON.stringify(d.missing_requirements))
  assert.equal(d.missing_requirements.length, 0)
  assert.ok(proofs(root).some(p => p.source_kind === 'host_verifier' && p.requirement_ids.includes('AC-1')))
})

// B: a failing exit code must not verify.
test('B code: real-host npm test exit 1 is NOT verified_complete', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'module.exports=1\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 1, 4, 5)
  assistant(h, '已修复并通过测试。', 6)
  h.stop(1)
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1'))
})

// C: masking gates still apply to hook-sourced exit codes. Under PowerShell a pipe
// does not mask (see the dialect block below), so only `;`, `||` and newline do.
test('C code: real-host masked "npm test || true" exit 0 is NOT verified_complete', t => {
  for (const cmd of ['npm test || true', 'npm test; true', 'npm test\necho done']) {
    const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'module.exports=1\n')
    const h = host(root)
    user(h, '修复登录的 bug 并验证')
    edit(h, 'e1', code, 2, 3)
    shell(h, 'v1', cmd, 0, 4, 5)
    assistant(h, '已修复并通过测试。', 6)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `masked must not verify: ${cmd}`)
  }
})

// D: relevance gate still applies.
test('D code: real-host "echo hello" exit 0 is NOT verified_complete', t => {
  for (const cmd of ['echo hello', 'ls -la', 'cat login.js', 'pwd']) {
    const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'module.exports=1\n')
    const h = host(root)
    user(h, '修复登录的 bug 并验证')
    edit(h, 'e1', code, 2, 3)
    shell(h, 'v1', cmd, 0, 4, 5)
    assistant(h, '已修复并通过测试。', 6)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `noop must not verify: ${cmd}`)
  }
})

// E: the ops template reads the same hook-sourced exit codes.
test('E ops: real-host "./deploy.sh prod" exit 0 IS verified_complete', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 0, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'ops')
  const d = decision(root)
  assert.equal(d.verdict, 'verified_complete', JSON.stringify(d.missing_requirements))
  assert.ok(proofs(root).some(p => p.verifier_ref.startsWith('dsh-host:ops-entry:')))
})
test('E ops: real-host "terraform plan" exit 0 is NOT verified_complete', t => {
  for (const cmd of ['terraform plan', 'docker compose build', 'echo hello', 'npm test']) {
    const root = fixture(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'ops', cmd)
    assert.notEqual(decision(root).verdict, 'verified_complete', `must not verify: ${cmd}`)
  }
})
test('E ops: real-host deploy exiting 1 is NOT verified_complete', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 1, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// Fail-closed edges on the new source.
test('F fail closed: an errored tool result carries no value, so no exit code', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'x\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  h.emit('tool/call', { turn: 1, callId: 'v1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) }, 4)
  h.toolResultHook('v1', 'pwsh', { command: 'npm test' }, { isError: true })
  h.emit('tool/result', { turn: 1, message: { source: { kind: 'tool', callId: 'v1' }, content: [{ type: 'tool-result', toolCallId: 'v1', isError: true, content: [] }] } }, 5)
  assistant(h, '已修复并通过测试。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})
test('F fail closed: a canonical value without a numeric exitCode verifies nothing', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'x\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  h.emit('tool/call', { turn: 1, callId: 'v1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) }, 4)
  h.toolResultHook('v1', 'pwsh', { command: 'npm test' }, { kind: 'foreground', stdout: { text: 'ok', truncated: false } })
  h.emit('tool/result', sessResult('v1'), 5)
  assistant(h, '已修复并通过测试。', 6)
  h.stop(1)
  const mine = outcomeRecords(root).filter(r => r.tool_call_id === 'v1')
  assert.equal(mine.length, 1, 'the command itself is recorded')
  assert.equal(mine[0].exit_code, null, 'a canonical value without an exit code records none')
  assert.notEqual(decision(root).verdict, 'verified_complete')
})
test('F fail closed: an exit code with no command text verifies nothing', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'x\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  h.emit('tool/call', { turn: 1, callId: 'v1', name: 'pwsh', arguments: JSON.stringify({ description: 'no command key' }) }, 4)
  h.toolResultHook('v1', 'pwsh', { description: 'no command key' }, { kind: 'foreground', exitCode: 0 })
  h.emit('tool/result', sessResult('v1'), 5)
  assistant(h, '已修复并通过测试。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})
test('F fail closed: no hook at all and no meta leaves a code task unverified', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'x\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  h.emit('tool/call', { turn: 1, callId: 'v1', name: 'pwsh', arguments: JSON.stringify({ command: 'npm test' }) }, 4)
  h.emit('tool/result', sessResult('v1'), 5)
  assistant(h, '已修复并通过测试。', 6)
  h.stop(1)
  assert.equal(outcomeRecords(root).filter(r => r.tool_call_id === 'v1').length, 0,
    'a call the hook never saw has no outcome, whatever else the session recorded')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})

// R1 (second independent review): a run captured before any file was observed has no version to
// attest. Filling in the current version afterwards let that run vouch for a file it never saw.
test('R1 a run captured before any file was observed cannot vouch for a later file', t => {
  const root = fixture(t), code = join(root, 'login.js')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  shell(h, 'v1', 'npm test', 0, 2, 3) // nothing observed yet: the capture is empty
  const captured = outcomeRecords(root).find(r => r.tool_call_id === 'v1')
  assert.equal(captured.object_version_digest ?? captured.payload.object_version_digest, '',
    'the fixture must actually capture nothing')

  writeFileSync(code, 'b\n')
  edit(h, 'e1', code, 4, 5) // the file appears only now, and the test is not re-run
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete',
    'a versionless run must not be filled in with the current version')
})

// R2: the touched scope is host state, so a remount has to recover it from the ledger, or a
// verification running afterwards captures nothing at all.
test('R2 a remounted plugin recovers the scope, and still invalidates after a change', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const first = host(root)
  user(first, '修复登录的 bug 并验证')
  edit(first, 'e1', file, 2, 3)
  assistant(first, '先改一处。', 4)
  first.stop(1) // no verification yet

  const second = host(root) // a remount on the same ledger
  shell(second, 'v2', 'npm test', 0, 5, 6)
  assistant(second, '已修复并验证。', 7)
  second.stop(2)
  assert.equal(decision(root).verdict, 'verified_complete', 'the remount must recover the object scope')

  writeFileSync(file, 'throw new Error("broken")\n')
  assistant(second, '又改了一点。', 8)
  second.stop(3)
  assert.notEqual(decision(root).verdict, 'verified_complete', 'a recovered scope must still invalidate')
})

// R3 (second review): collecting only usable successes and then claiming "the latest attempt"
// let a later host-reported failure be invisible, so an earlier success survived it. The failure
// has to reach BOTH channels DSH uses — the hook's isError and the session result block — which
// the first version of this test missed, leaving the explicit-failure branch uncovered.
test('R3 a later host-reported failure of the same entry point is not success', t => {
  const control = fixture(t), hc = host(control)
  user(hc, '部署到生产环境')
  shell(hc, 'd1', './deploy.sh prod', 0, 2, 3)
  assistant(hc, '已部署。', 4)
  hc.stop(1)
  assert.equal(decision(control).verdict, 'verified_complete', 'the single successful deploy passes on its own')

  const root = fixture(t), h = host(root), args = { command: './deploy.sh prod' }
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 0, 2, 3)
  h.emit('tool/call', { turn: 1, callId: 'd2', name: 'pwsh', arguments: JSON.stringify(args) }, 4)
  h.toolResultHook('d2', 'pwsh', args, { isError: true })
  h.emit('tool/result', sessFailed('d2'), 5)
  assistant(h, '已部署。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete',
    'the newest attempt failed on the host, whatever the earlier one did')
})

// T1 (third review): `objectDigestFor` preferred the file digest for every type, so an old
// deployment or search picked up the current file version and re-refreshed it on every later
// edit. Each type now has exactly one object domain.
test('T1 an operation proof does not adopt the working tree as its object', t => {
  const root = fixture(t), file = join(root, 'config.json')
  const h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 0, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  const first = proofs(root)
  assert.equal(decision(root).verdict, 'verified_complete')
  assert.equal(first.length, 1)

  writeFileSync(file, 'v1\n')
  edit(h, 'e1', file, 5, 6)
  assistant(h, '顺手改了配置。', 7)
  h.stop(2)
  // The newest proof is the one that must still attest the operation; a re-mint under a moved
  // file version would append a row whose digest follows the tree.
  assert.equal(proofs(root).at(-1).object_version_digest, first[0].object_version_digest,
    'the operation keeps attesting the operation, not the tree')
})

test('T1 a research proof does not adopt the working tree as its object', t => {
  const root = fixture(t), file = join(root, 'notes.md')
  const h = host(root)
  user(h, '调研一下市面上的方案')
  named(h, 's1', 'web_search', { query: 'options' }, 2, 3)
  assistant(h, '调研结论：方案 A 更合适。', 4)
  h.stop(1)
  const first = proofs(root)
  assert.equal(decision(root).verdict, 'verified_complete')

  writeFileSync(file, 'v1\n')
  edit(h, 'e1', file, 5, 6)
  assistant(h, '顺手记了笔记。', 7)
  h.stop(2)
  assert.equal(proofs(root).at(-1).object_version_digest, first[0].object_version_digest,
    'the delivery keeps attesting the delivery, not the tree')
})

// T4 (third review): the tokenizer kept token values, but the write scan never asked whether a
// token was a command being run. `Set-Content` as an argument, and a `>` inside a comment, are
// both text.
test('T4 command arguments and comments are not write syntax', t => {
  const forms = [
    path => `Write-Output 'Set-Content' '${path}'`,
    path => `Write-Output done # > '${path}'`,
  ]
  for (const form of forms) {
    const root = fixture(t), readme = join(root, 'README.md')
    writeFileSync(readme, 'unchanged\n')
    const h = host(root)
    user(h, '更新 README 文档，补充安装说明')
    shell(h, 'w1', form(readme), 0, 2, 3, 'pwsh')
    assistant(h, 'README 已更新。', 4)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `misread as a write: ${form(readme)}`)
  }
})

// T5 / old #8 (third review): the flag's `=value` form slipped past the help/version guard, and
// a backgrounded command's exit code reports the launch rather than the work.
test('T5 `npm test --help=true` does not verify', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', file, 2, 3)
  shell(h, 'v1', 'npm test --help=true', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

test('#8 a backgrounded verification does not verify', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', file, 2, 3)
  shell(h, 'v1', 'npm test &', 0, 4, 5, 'pwsh')
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete', 'a launch is not a completion')
})

// R4: escaping is dialect-specific. A backtick-escaped `>` in PowerShell is text; treating it
// as a redirect let a command that printed a path stand in for a document write.
test('R4 a backtick-escaped redirect is text, not a write', t => {
  const root = fixture(t), readme = join(root, 'README.md')
  writeFileSync(readme, 'unchanged\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  shell(h, 'w1', `Write-Output \`> ${readme}`, 0, 2, 3, 'pwsh')
  assistant(h, 'README 已更新。', 4)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// R5: a legitimate write must still be recognised — quoted or bare Windows paths included,
// whatever the write construct. Blanking quoted spans destroyed exactly these.
test('R5 quoted and bare Windows paths written by Set-Content or tee still verify', t => {
  const forms = [
    path => `Set-Content -LiteralPath "${path}" -Value new`,
    path => `Set-Content -LiteralPath ${path} -Value new`,
    path => `echo new | tee "${path}"`,
  ]
  for (const form of forms) {
    const root = fixture(t), readme = join(root, 'README.md')
    writeFileSync(readme, '# T\n')
    const h = host(root)
    user(h, '更新 README 文档，补充安装说明')
    shell(h, 'w1', form(readme), 0, 2, 3, 'pwsh')
    assistant(h, 'README 已更新。', 4)
    h.stop(1)
    assert.equal(decision(root).verdict, 'verified_complete', `not recognised: ${form(readme)}`)
  }
})

// The nag this replaces: after a verification, the session touches a NEW file. That file was
// never part of what the run attested, so the proof has to survive. Comparing two aggregate
// scope digests made it stale every turn, over a change the run never claimed to cover.
test('T6 a later unrelated file does not invalidate a passing run', t => {
  const root = fixture(t), code = join(root, 'login.js'), notes = join(root, 'notes.md')
  writeFileSync(code, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.equal(decision(root).verdict, 'verified_complete')

  writeFileSync(notes, 'scratch\n')
  edit(h, 'e2', notes, 7, 8)
  assistant(h, '又记了点笔记。', 9)
  h.stop(2)
  assert.equal(decision(root).verdict, 'verified_complete',
    'a file the run never captured must not invalidate it')
})

// ...and the mirror image: a captured file that changes afterwards does invalidate it.
test('T6b a change to a captured file does invalidate the run', t => {
  const root = fixture(t), code = join(root, 'login.js')
  writeFileSync(code, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.equal(decision(root).verdict, 'verified_complete')

  writeFileSync(code, 'throw new Error("broken")\n')
  assistant(h, '又改了一点。', 7)
  h.stop(2)
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.deepEqual(d.missing_requirements.map(m => m.missing_reason), ['evidence_stale'])
})

// R7 (live session, 2026-09-16): a passing run whose files moved, with no run in the new revision,
// was reported as `verification_failed` — the repair prompt told the agent to fix a failure that
// never happened. Found on the real machine in the 0.1.0 build; the fixtures had never combined
// "older revision" with "captured file moved".
test('R7 an older passing run whose files moved is stale, not failed', t => {
  const root = fixture(t), h = host(root), code = join(root, 'login.js')
  writeFileSync(code, 'a\n')
  user(h, '修复 login.js 的 bug 并跑测试')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复。', 6)
  h.stop(1)
  assert.equal(decision(root).verdict, 'verified_complete')

  writeFileSync(code, 'changed after the run\n')
  edit(h, 'e2', code, 7, 8)
  user(h, '继续修复 login 的问题', 9)
  assistant(h, '继续。', 10)
  h.stop(2)
  const d = decision(root)
  assert.deepEqual(d.missing_requirements.map(m => m.missing_reason), ['evidence_stale'],
    `the files moved; nothing failed: ${JSON.stringify(d.missing_requirements)}`)
  assert.doesNotMatch(d.repair_action ?? '', /run failed/i,
    'the repair prompt must not report a failure that never happened')
})

test('R7 an older run that really failed is still reported as failed', t => {
  const root = fixture(t), h = host(root), code = join(root, 'login.js')
  writeFileSync(code, 'a\n')
  user(h, '修复 login.js 的 bug 并跑测试')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 1, 4, 5)
  assistant(h, '已修复。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')

  user(h, '继续修复 login 的问题', 7)
  assistant(h, '继续。', 8)
  h.stop(2)
  assert.deepEqual(decision(root).missing_requirements.map(m => m.missing_reason), ['verification_failed'])
})

test('R7 older evidence that never ran a verification is a missing run, not a failure', t => {
  const root = fixture(t), h = host(root), code = join(root, 'login.js')
  writeFileSync(code, 'a\n')
  user(h, '修复 login.js 的 bug 并跑测试')
  named(h, 'r1', 'read', { file_path: code }, 2, 3)
  assistant(h, '看了一下。', 4)
  h.stop(1)

  user(h, '继续修复 login 的问题', 5)
  assistant(h, '继续。', 6)
  h.stop(2)
  assert.deepEqual(decision(root).missing_requirements.map(m => m.missing_reason), ['evidence_missing'],
    'a read is not a verification run, so its absence is not a failed one')
})

// T3 (third review): three ways of dropping an attempt each let an earlier success stand for
// work that had not happened — a call whose result never arrived, a masked retry that cannot be
// confirmed, and a different target entirely.
test('T3 an operation whose result never arrived is not success', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 0, 2, 3)
  h.emit('tool/call', { turn: 1, callId: 'd2', name: 'pwsh', arguments: JSON.stringify({ command: './deploy.sh prod' }) }, 4)
  assistant(h, '已部署。', 5)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete', 'a pending attempt cannot be assumed to have succeeded')
})

test('T3 a masked retry of the same operation is not success', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 0, 2, 3)
  shell(h, 'd2', './deploy.sh prod || true', 0, 4, 5)
  assistant(h, '已部署。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete',
    'an attempt that cannot be confirmed must not vanish')
})

test('T3 a success on another target does not stand in for a failed one', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh A', 1, 2, 3)
  shell(h, 'd2', './deploy.sh B', 0, 4, 5)
  assistant(h, '已部署。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete', 'B did not deploy A')
})

test('T3 two targets that both pass still verify', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh A', 0, 2, 3)
  shell(h, 'd2', './deploy.sh B', 0, 4, 5)
  assistant(h, '已部署。', 6)
  h.stop(1)
  assert.equal(decision(root).verdict, 'verified_complete')
})

// F3 (third review #10): a request that names two documents declares two acceptance items, so
// producing one of them closes exactly one. The old contract had a single placeholder item and
// assigned it to any artifact, which is why README alone used to pass.
test('F3 a request naming two documents needs both', t => {
  const one = fixture(t), readme = join(one, 'README.md'), changelog = join(one, 'CHANGELOG.md')
  writeFileSync(readme, '# R\n'); writeFileSync(changelog, '# C\n')
  const h1 = host(one)
  user(h1, '更新 README.md 和 CHANGELOG.md 文档')
  edit(h1, 'w1', readme, 2, 3)
  assistant(h1, '都更新了。', 4)
  h1.stop(1)
  const d1 = decision(one)
  assert.notEqual(d1.verdict, 'verified_complete', 'README alone must not answer a two-target request')
  assert.ok(d1.missing_requirements.some(m => m.missing_reason === 'evidence_missing'))

  const both = fixture(t), r2 = join(both, 'README.md'), c2 = join(both, 'CHANGELOG.md')
  writeFileSync(r2, '# R\n'); writeFileSync(c2, '# C\n')
  const h2 = host(both)
  user(h2, '更新 README.md 和 CHANGELOG.md 文档')
  edit(h2, 'w1', r2, 2, 3)
  edit(h2, 'w2', c2, 4, 5)
  assistant(h2, '都更新了。', 6)
  h2.stop(1)
  assert.equal(decision(both).verdict, 'verified_complete', 'both documents answer both items')
})

// F3 (third review #11): a stated prohibition becomes a hard item carrying the digest of what it
// protects, so the host can check it itself instead of reporting it as unconfirmable. The
// absolute path is what makes the baseline readable, the same limitation shell writes have.
test('F3 a stated prohibition is checked by the host', t => {
  const violated = fixture(t), protect = join(violated, 'protected.txt'), code = join(violated, 'login.js')
  writeFileSync(protect, 'do not touch\n'); writeFileSync(code, 'a\n')
  const h1 = host(violated)
  user(h1, `不要修改 ${protect}，然后修复 login.js 并跑测试`)
  writeFileSync(protect, 'CHANGED\n')
  edit(h1, 'e1', code, 2, 3)
  shell(h1, 'v1', 'npm test', 0, 4, 5)
  assistant(h1, '已修复并验证。', 6)
  h1.stop(1)
  const d1 = decision(violated)
  assert.notEqual(d1.verdict, 'verified_complete', 'a violated prohibition must block')
  assert.ok(d1.missing_requirements.some(m => m.missing_reason === 'hard_constraint_unconfirmed'),
    `expected the hard item to fail, got ${JSON.stringify(d1.missing_requirements)}`)

  const kept = fixture(t), protect2 = join(kept, 'protected.txt'), code2 = join(kept, 'login.js')
  writeFileSync(protect2, 'do not touch\n'); writeFileSync(code2, 'a\n')
  const h2 = host(kept)
  user(h2, `不要修改 ${protect2}，然后修复 login.js 并跑测试`)
  edit(h2, 'e1', code2, 2, 3)
  shell(h2, 'v1', 'npm test', 0, 4, 5)
  assistant(h2, '已修复并验证。', 6)
  h2.stop(1)
  const dc = decision(kept)
  assert.equal(dc.verdict, 'verified_complete',
    `an untouched prohibition is compliant: ${JSON.stringify(dc.missing_requirements)}`)
})

// F3 follow-up: a prohibition that names no object cannot become a requirement. Spec §3 keeps an
// unconfirmable hard item pending review, but an item no evidence and no repair can ever close is
// a refusal that cannot terminate (§8), so the contract records the phrase instead of checking it.
test('F3 a prohibition that names no object is recorded, not enforced', t => {
  const root = fixture(t), readme = join(root, 'README.md')
  writeFileSync(readme, '# Title\n')
  const h = host(root)
  user(h, '不要动代码，只更新 README.md 文档')
  edit(h, 'w1', readme, 2, 3)
  assistant(h, '只改了 README。', 4)
  h.stop(1)
  const task = ledger(root).task('session')
  assert.deepEqual(task.unrepresentable_prohibitions, ['代码'],
    'the phrase is kept in the contract for provenance')
  assert.ok(!task.requirements.some(r => r.class === 'hard'),
    `a phrase that names no object is not a host-checkable item: ${JSON.stringify(task.requirements)}`)
  assert.equal(decision(root).verdict, 'verified_complete')
})

test('F3 an unresolvable prohibition stays pending review, not inapplicable', t => {
  const root = fixture(t), gone = join(root, 'never-created-4f2b.txt'), code = join(root, 'login.js')
  writeFileSync(code, 'a\n')
  const h = host(root) // no session cwd: the absolute path is readable, the object is simply absent
  user(h, `修复 login.js 的 bug 并跑测试，不要修改 ${gone}`)
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复。', 6)
  h.stop(1)
  const d = decision(root)
  const check = d.hard_constraints_checked.find(c => c.requirement_id === 'HC-1')
  assert.equal(check?.applicability, 'unknown',
    `the host may not judge an unverifiable constraint inapplicable: ${JSON.stringify(check)}`)
  assert.match(check.check_ref, /hard-unresolved/,
    'the check names why it could not be decided')
  assert.ok(d.missing_requirements.some(m => m.missing_reason === 'hard_constraint_unconfirmed'),
    `an unconfirmable prohibition is listed for review: ${JSON.stringify(d.missing_requirements)}`)
})

test('F3 a same-named file in another directory is not a violation', t => {
  const root = fixture(t), code = join(root, 'login.js')
  writeFileSync(code, 'a\n')
  const h = host(root)
  user(h, `修复 login.js 的 bug 并跑测试，不要修改 ${join(root, 'missing', 'config', 'app.yml')}`)
  edit(h, 'e1', code, 2, 3)
  edit(h, 'e2', join(root, 'other', 'app.yml'), 4, 5)
  shell(h, 'v1', 'npm test', 0, 6, 7)
  assistant(h, '已修复。', 8)
  h.stop(1)
  const check = decision(root).hard_constraints_checked.find(c => c.requirement_id === 'HC-1')
  assert.notEqual(check?.status, 'violated',
    `a path with directory components must not match on its basename alone: ${JSON.stringify(check)}`)
})

test('F3 a prohibition over a directory covers what is written under it', t => {
  const root = fixture(t), config = join(root, 'config'), code = join(root, 'login.js')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'app.yml'), 'a: 1\n'); writeFileSync(code, 'a\n')
  const h = host(root)
  user(h, `修复 login.js 的 bug 并跑测试，不要改 ${config}/`)
  edit(h, 'e1', code, 2, 3)
  edit(h, 'e2', join(config, 'app.yml'), 4, 5)
  shell(h, 'v1', 'npm test', 0, 6, 7)
  assistant(h, '已修复。', 8)
  h.stop(1)
  const check = decision(root).hard_constraints_checked.find(c => c.requirement_id === 'HC-1')
  assert.equal(check?.status, 'violated',
    `a write under the named directory is the violation: ${JSON.stringify(check)}`)
})

test('F3 a directory prohibition sees a change the session did not make', t => {
  const root = fixture(t), config = join(root, 'config'), code = join(root, 'login.js')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'app.yml'), 'a: 1\n'); writeFileSync(code, 'a\n')
  const h = host(root)
  user(h, `修复 login.js 的 bug 并跑测试，不要改 ${config}/`)
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  writeFileSync(join(config, 'app.yml'), 'a: 2\n') // no tool call: only the tree digest can see it
  assistant(h, '已修复。', 6)
  h.stop(1)
  const check = decision(root).hard_constraints_checked.find(c => c.requirement_id === 'HC-1')
  assert.equal(check?.status, 'violated',
    `the directory digest covers files the session never named: ${JSON.stringify(check)}`)
})

test('F3 a prohibition over an untouched directory is compliant', t => {
  const root = fixture(t), config = join(root, 'config'), code = join(root, 'login.js')
  mkdirSync(config, { recursive: true })
  writeFileSync(join(config, 'app.yml'), 'a: 1\n'); writeFileSync(code, 'a\n')
  const h = host(root)
  user(h, `修复 login.js 的 bug 并跑测试，不要改 ${config}/`)
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复。', 6)
  h.stop(1)
  const d = decision(root)
  const check = d.hard_constraints_checked.find(c => c.requirement_id === 'HC-1')
  assert.equal(check?.status, 'compliant', `an untouched tree is compliant: ${JSON.stringify(check)}`)
  assert.equal(d.verdict, 'verified_complete')
})

test('F3 an unopenable prohibition still catches the write the host observed', t => {
  const root = fixture(t), protect = join(root, 'unopenable-7c41.txt'), code = join(root, 'login.js')
  writeFileSync(protect, 'do not touch\n'); writeFileSync(code, 'a\n')
  const h = host(root) // no cwd on the session: the relative name cannot be resolved
  user(h, '修复 login.js 的 bug 并跑测试，禁止修改 unopenable-7c41.txt')
  writeFileSync(protect, 'CHANGED\n')
  edit(h, 'e1', protect, 2, 3)
  edit(h, 'e2', code, 4, 5)
  shell(h, 'v1', 'npm test', 0, 6, 7)
  assistant(h, '已修复。', 8)
  h.stop(1)
  const d = decision(root)
  const check = d.hard_constraints_checked.find(c => c.requirement_id === 'HC-1')
  assert.equal(check?.status, 'violated',
    `the observed write is the violation the host can see: ${JSON.stringify(d.hard_constraints_checked)}`)
  assert.match(check.check_ref, /observed-write/,
    'the check must name the write it observed, not a digest it never had')
  assert.notEqual(d.verdict, 'verified_complete', 'the write the host observed must break the stated prohibition')
  assert.ok(d.missing_requirements.some(m => m.missing_reason === 'hard_constraint_unconfirmed'),
    `expected the observed write to fail the hard item, got ${JSON.stringify(d.missing_requirements)}`)
})

test('F3 a prohibited path is not also a deliverable', t => {
  const root = fixture(t), keep = join(root, 'keep.txt'), readme = join(root, 'README.md')
  writeFileSync(keep, 'do not touch\n'); writeFileSync(readme, '# Title\n')
  const h = host(root)
  user(h, `不要修改 ${keep}，更新 README.md 文档`)
  edit(h, 'w1', readme, 2, 3)
  assistant(h, '已更新。', 4)
  h.stop(1)
  const task = ledger(root).task('session')
  assert.ok(!task.requirements.some(r => r.class === 'acceptance'
    && (r.scope ?? []).some(s => s.toLowerCase().includes('keep.txt'))),
  `an object the request forbids changing cannot also be a document it is waiting for: ${JSON.stringify(task.requirements)}`)
  assert.equal(decision(root).verdict, 'verified_complete')
})

test('F3 a prohibition naming a list protects every name in it', t => {
  const root = fixture(t), a = join(root, 'alpha.txt'), b = join(root, 'beta.txt'), readme = join(root, 'README.md')
  for (const [p, text] of [[a, 'a\n'], [b, 'b\n'], [readme, '# Title\n']]) writeFileSync(p, text)
  const h = host(root)
  user(h, '不要修改 alpha.txt 和 beta.txt，更新 README.md 文档')
  edit(h, 'e1', a, 2, 3)
  edit(h, 'e2', readme, 4, 5)
  assistant(h, '已更新。', 6)
  h.stop(1)
  const task = ledger(root).task('session')
  const scopes = task.requirements.filter(r => r.class === 'acceptance').flatMap(r => r.scope ?? [])
  assert.ok(!scopes.some(s => /alpha|beta/.test(s)),
    `a name inside the prohibition is not a deliverable: ${JSON.stringify(task.requirements)}`)
  assert.notEqual(decision(root).verdict, 'verified_complete',
    'the second name in the list is protected too, and the host saw alpha.txt change')
})

test('F3 a relative prohibition resolves against the session working directory', t => {
  const root = fixture(t), readme = join(root, 'README.md')
  writeFileSync(readme, '# Title\n'); writeFileSync(join(root, 'protected.txt'), 'do not touch\n')
  const h = host(root, { cwd: root })
  user(h, '不要修改 protected.txt，更新 README.md 文档')
  writeFileSync(join(root, 'protected.txt'), 'CHANGED\n')
  edit(h, 'w1', readme, 2, 3)
  assistant(h, '已更新。', 4)
  h.stop(1)
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete',
    'with the working directory known, the protected object is checked by digest')
})

test('F3 an English prohibition keeps the extension it names', t => {
  const root = fixture(t), protect = join(root, 'notes.md'), code = join(root, 'login.js')
  writeFileSync(protect, 'n\n'); writeFileSync(code, 'a\n')
  const h = host(root)
  user(h, 'Fix the login bug in login.js and run the tests. Do not modify notes.md.')
  edit(h, 'e1', protect, 2, 3)
  edit(h, 'e2', code, 4, 5)
  shell(h, 'v1', 'npm test', 0, 6, 7)
  assistant(h, 'Fixed.', 8)
  h.stop(1)
  const check = decision(root).hard_constraints_checked.find(c => c.requirement_id === 'HC-1')
  assert.equal(check?.status, 'violated',
    `a captured name must keep its extension: ${JSON.stringify(decision(root).hard_constraints_checked)}`)
})

// The non-shell templates keep working on the real shapes.
test('G docs: a real edit with card-free diffs meta still verifies', t => {  const root = fixture(t), readme = join(root, 'README.md'); writeFileSync(readme, '# Title\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  edit(h, 'w1', readme, 2, 3)
  assistant(h, '已更新。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('G research: a real web_search call still verifies', t => {
  const root = fixture(t), h = host(root)
  user(h, '调研一下市面上的方案')
  // A search whose result carries the source, and a delivery that cites it: §56 evidence.
  searched(h, 's1', 'options', '1. https://example.com/options — comparison', 2, 3)
  assistant(h, '结论：方案 A 更合适，见 https://example.com/options。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'research')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('R6 research: a citation the host never observed is refused', t => {
  const root = fixture(t), h = host(root)
  user(h, '调研一下市面上的方案')
  searched(h, 's1', 'options', '1. https://example.com/options — comparison', 2, 3)
  assistant(h, '结论：方案 A 更合适，见 https://invented.example/study。', 4)
  h.stop(1)
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete', 'an unobserved citation must not close a research task')
  assert.deepEqual(d.reason_codes, ['citation_unobserved'], JSON.stringify(d.missing_requirements))
})
test('R6 research: consulting sources without citing one is refused', t => {
  const root = fixture(t), h = host(root)
  user(h, '调研一下市面上的方案')
  searched(h, 's1', 'options', '1. https://example.com/options — comparison', 2, 3)
  assistant(h, '结论：方案 A 更合适。', 4)
  h.stop(1)
  assert.deepEqual(decision(root).reason_codes, ['citation_unobserved'])
})
test('R6 research: a source the host observed nowhere leaves the citation rule silent', t => {
  const root = fixture(t), h = host(root)
  user(h, '调研一下市面上的方案')
  // The tool result carries no URL: the host has nothing to check a citation against, and it
  // must not demand one, or the requirement could never be satisfied.
  named(h, 's1', 'web_search', { query: 'options' }, 2, 3)
  assistant(h, '结论：方案 A 更合适。', 4)
  h.stop(1)
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('G discussion: a pure question is still allow_response', t => {
  const root = fixture(t), h = host(root)
  user(h, '你怎么看这个架构方案')
  assistant(h, '我建议用分层架构。', 2)
  h.stop(1)
  assert.equal(taskType(root), 'discussion')
  assert.equal(decision(root).verdict, 'allow_response')
})

// The record is keyed by call id, so a repeated hook cannot duplicate or hijack it.
test('H3 the outcome record is idempotent per call id', t => {
  const root = fixture(t), h = host(root)
  user(h, '修复登录的 bug 并验证')
  const args = { command: 'npm test', description: 'd' }
  h.emit('tool/call', { turn: 1, callId: 'v1', name: 'pwsh', arguments: JSON.stringify(args) }, 2)
  const value = { kind: 'foreground', exitCode: 0, stdout: { text: 'ok', truncated: false } }
  h.toolResultHook('v1', 'pwsh', args, value)
  h.toolResultHook('v1', 'pwsh', args, value)
  h.emit('tool/result', sessResult('v1'), 3)
  assistant(h, '已通过。', 4)
  h.stop(1)
  assert.equal(outcomeRecords(root).length, 1)
})

// ---------------------------------------------------------------------------
// Dialect-aware masking.
//
// DSH records the SUBPROCESS exit code (dsh-pwsh-local: `proc.exitCode =
// outcome.exitCode` from ctx.subprocess.spawn), not PowerShell's $LASTEXITCODE
// variable. Measured on Windows PowerShell 5.1 through a clean Start-Process exit
// code, the two shells are opposite on `|`:
//   cmd /c exit 3 | Select-Object -Last 1   -> failure still reported (pipe does NOT mask)
//   cmd /c exit 3 | cat                     -> failure still reported
//   cmd /c exit 3 2>&1 | Select-Object -L5  -> failure still reported (2>&1 is a redirect)
//   cmd /c exit 3; Write-Host hi            -> success reported (`;` masks, cmdlet or not)
//   cmd /c exit 3; cmd /c exit 0            -> success reported
// In bash a pipeline exits with its last element, so `|` masks there. The masking set
// therefore has to follow the dialect of the tool that ran the command, and an
// unrecognized tool name falls back to POSIX, which is the stricter reading.
// ---------------------------------------------------------------------------
/** Run one code task whose only verification is `cmd` under `toolName`, and return the verdict. */
function codeVerdict(t, toolName, cmd, exitCode = 0) {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'module.exports=1\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', code, 2, 3)
  shell(h, 'v1', cmd, exitCode, 4, 5, toolName)
  assistant(h, '已修复并通过测试。', 6)
  h.stop(1)
  assert.equal(taskType(root), 'code', cmd)
  return decision(root)
}

// A
test('dialect A: pwsh + "npm test" exit 0 IS verified_complete', t => {
  assert.equal(codeVerdict(t, 'pwsh', 'npm test').verdict, 'verified_complete')
})
// B: a PowerShell pipe does not mask, and a trailing 2>&1 is a redirect, not a connector.
test('dialect B: pwsh + a verification piped to Select-Object IS verified_complete', t => {
  for (const cmd of ['npm run typecheck 2>&1 | Select-Object -Last 3',
    'npm test 2>&1 | Select-Object -Last 5',
    'npm test | Select-Object -Last 5',
    'npm test | cat',
    'node --test tests/x.test.js 2>&1 | Select-Object -Last 45',
    'npm test | Tee-Object -FilePath out.txt']) {
    const d = codeVerdict(t, 'pwsh', cmd)
    assert.equal(d.verdict, 'verified_complete', `pwsh pipe must not mask: ${cmd} -> ${JSON.stringify(d.missing_requirements)}`)
  }
})
test('dialect B2: the tool name "powershell" gets the same reading as "pwsh"', t => {
  assert.equal(codeVerdict(t, 'powershell', 'npm test 2>&1 | Select-Object -Last 5').verdict, 'verified_complete')
})
// C, D, E: `;`, `||` and newline still mask under PowerShell, cmdlet successor or not.
test('dialect C: pwsh + a semicolon AFTER the verifier is NOT verified_complete', t => {
  for (const cmd of ['npm test 2>&1 | Select-Object -Last 5; Write-Host done',
    'npm test; Write-Host done',
    'npm test; exit 0']) {
    assert.notEqual(codeVerdict(t, 'pwsh', cmd).verdict, 'verified_complete', `semicolon must mask: ${cmd}`)
  }
})
test('dialect E: pwsh + "npm test || Write-Host recovered" is NOT verified_complete', t => {
  assert.notEqual(codeVerdict(t, 'pwsh', 'npm test || Write-Host recovered').verdict, 'verified_complete')
})
test('dialect: pwsh + a newline after the verifier is NOT verified_complete', t => {
  assert.notEqual(codeVerdict(t, 'pwsh', 'npm test\nWrite-Host done').verdict, 'verified_complete')
})
// F, G: bash keeps the POSIX reading, so a pipe masks there.
test('dialect F: bash + "npm test | tail -5" is NOT verified_complete', t => {
  for (const cmd of ['npm test | tail -5', 'npm test | cat', 'npm test 2>&1 | tail -n 5']) {
    assert.notEqual(codeVerdict(t, 'bash', cmd).verdict, 'verified_complete', `bash pipe must mask: ${cmd}`)
  }
})
test('dialect G: bash + "npm test || true" and "npm test; true" are NOT verified_complete', t => {
  for (const cmd of ['npm test || true', 'npm test; true']) {
    assert.notEqual(codeVerdict(t, 'bash', cmd).verdict, 'verified_complete', cmd)
  }
})
// H: an unrecognized tool name gets the stricter POSIX reading, never the looser one.
test('dialect H: an unknown shell tool name falls back to POSIX', t => {
  for (const tool of ['shell', 'terminal', 'run_command', 'exec', 'cmd', '']) {
    for (const cmd of ['npm test | tail -5', 'npm test; true']) {
      assert.notEqual(codeVerdict(t, tool, cmd).verdict, 'verified_complete',
        `unknown tool ${JSON.stringify(tool)} must fail closed: ${cmd}`)
    }
  }
})
// The dialect changes masking only, never the other gates.
test('dialect: PowerShell reading does not weaken relevance, exit code, or noop gates', t => {
  assert.notEqual(codeVerdict(t, 'pwsh', 'echo hello').verdict, 'verified_complete')
  assert.notEqual(codeVerdict(t, 'pwsh', 'ls -la').verdict, 'verified_complete')
  assert.notEqual(codeVerdict(t, 'pwsh', 'npm test', 1).verdict, 'verified_complete')
  assert.notEqual(codeVerdict(t, 'pwsh', 'npm run nothinghere | Select-Object -Last 3').verdict, 'verified_complete')
})
// A leading non-verifier segment joined by && is still fine in both dialects.
test('dialect: a leading segment joined by && keeps the verifier trustworthy', t => {
  assert.equal(codeVerdict(t, 'pwsh', 'cd D:/repo && npm test').verdict, 'verified_complete')
  assert.equal(codeVerdict(t, 'bash', 'cd /tmp && npm test').verdict, 'verified_complete')
})
// ops reads the same dialect: a PowerShell pipe must not disqualify a real entry point.
test('dialect ops: pwsh entry point behind a pipe verifies, a semicolon after it does not', t => {
  const ok = fixture(t), h1 = host(ok)
  user(h1, '部署到生产环境')
  shell(h1, 'd1', './deploy.sh prod 2>&1 | Tee-Object -FilePath deploy.log', 0, 2, 3)
  assistant(h1, '已部署。', 4)
  h1.stop(1)
  assert.equal(taskType(ok), 'ops')
  assert.equal(decision(ok).verdict, 'verified_complete')

  const bad = fixture(t), h2 = host(bad)
  user(h2, '部署到生产环境')
  shell(h2, 'd1', './deploy.sh prod; Write-Host done', 0, 2, 3)
  assistant(h2, '已部署。', 4)
  h2.stop(1)
  assert.notEqual(decision(bad).verdict, 'verified_complete')
})

// A directory among the call path arguments must not empty the object digest. Before this
// fix, readFileSync(directory) threw EISDIR inside objectVersionDigest, the surrounding
// catch returned '', and audit.ts:116 turned that empty digest into `evidence_stale` for
// every acceptance item of the rest of the session. A real session hit it after a single
// `grep` over a folder, with a perfect exit-0 verification run that could not be accepted.
test('D1 a directory path in an unrelated call does not poison the object digest', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  named(h, 'g1', 'grep', { path: root, pattern: 'login' }, 2, 3) // path argument is a DIRECTORY
  edit(h, 'e1', file, 4, 5)
  shell(h, 'v1', 'npm test', 0, 6, 7)
  assistant(h, '已修复并验证。', 8)
  h.stop(1)
  const d = decision(root)
  assert.equal(d.verdict, 'verified_complete', 'a directory in the object scope must not block a verified run')
  assert.ok(!d.missing_requirements.some(m => m.missing_reason === 'evidence_stale'))
  assert.ok(!d.missing_requirements.some(m => m.missing_reason === 'evidence_missing'))
})

// The same shape without any file artifact must still fail closed: dropping directories
// must not make an empty object scope look like a valid one.
test('D2 dropping non-file paths does not make an empty object scope acceptable', t => {
  const root = fixture(t), h = host(root)
  user(h, '修复登录的 bug 并验证')
  named(h, 'g1', 'grep', { path: root, pattern: 'login' }, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete', 'no file in scope means no valid object version')
})

// A proof must attest the object version that existed WHEN THE TOOL RAN. Re-deriving the digest
// at adjudication time instead re-bound an old passing run to whatever the tree had become
// since — the invalidation the digest comparison exists to provide never fired. This test used
// to assert the wrong outcome (`verified_complete` after the file changed without a re-run);
// an independent review (F1) found that, and the assertion is now inverted.
test('D3 a run is not carried over to a later object version, and does not collide', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', file, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.equal(decision(root).verdict, 'verified_complete')
  const before = proofs(root).map(p => ({ id: p.event_id, digest: p.object_version_digest }))
  assert.equal(before.length, 1)

  writeFileSync(file, 'throw new Error("regressed")\n') // the attested object has moved on
  assistant(h, '我又改了实现。', 7)
  h.stop(2) // must not throw evidence_event_id_conflict

  const d = decision(root)
  assert.equal(d.verdict, 'repair_required', 'a passing run cannot be re-bound to a later object')
  assert.deepEqual(d.missing_requirements.map(m => m.missing_reason), ['evidence_stale'])
  assert.deepEqual(proofs(root).map(p => ({ id: p.event_id, digest: p.object_version_digest })), before,
    'the recorded proof keeps the version it was captured against')
})

// F1, second half: a re-run after the change must be able to pass again.
test('D4 re-running the verification after the object moved verifies the new version', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', file, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)

  writeFileSync(file, 'c\n')
  shell(h, 'v2', 'npm test', 0, 7, 8) // a fresh run against the new version
  assistant(h, '重新验证过。', 9)
  h.stop(2)
  assert.equal(decision(root).verdict, 'verified_complete')
  assert.equal(proofs(root).length, 2, 'the new version gets its own proof')
})

// An independent review found the discussion exemption being persisted into the contract, where
// it excused a later code task from evidence entirely (F2).
test('F2 a discussion exemption does not survive into a later code task', t => {
  const root = fixture(t)
  const h = host(root)
  user(h, '解释一下这个概念', 1)
  assistant(h, '它是这样工作的。', 2)
  h.stop(1)
  assert.equal(decision(root).verdict, 'allow_response')

  user(h, '修复登录的 bug 并验证', 3) // a new revision, code type, and no tools at all
  assistant(h, '已修复。', 4)
  h.stop(2)
  const d = decision(root)
  assert.equal(taskType(root), 'code')
  assert.notEqual(d.verdict, 'verified_complete', 'a code task needs its own evidence')
  assert.equal(d.evidence_refs.length, 0)
  assert.ok(d.missing_requirements.length > 0)
})

// F5: an earlier success followed by a failure of the same entry point must not read as success.
test('F5 a later failing deploy of the same entry point is not success', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 0, 2, 3)
  shell(h, 'd2', './deploy.sh prod', 1, 4, 5)
  assistant(h, '已部署。', 6)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// F6: a verifier asked for its own help or version runs nothing, whatever it exits with.
test('F6 `npm test --help` and `--version` do not verify', t => {
  for (const command of ['npm test --help', 'npm test --version']) {
    const root = fixture(t), file = join(root, 'login.js')
    writeFileSync(file, 'b\n')
    const h = host(root)
    user(h, '修复登录的 bug 并验证')
    edit(h, 'e1', file, 2, 3)
    shell(h, 'v1', command, 0, 4, 5)
    assistant(h, '已修复并验证。', 6)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `${command} must not verify`)
  }
})

// F7: printed text that looks like a redirect is data, not a document write.
test('F7 a printed string that looks like a redirect is not a document write', t => {
  const root = fixture(t), readme = join(root, 'README.md')
  writeFileSync(readme, 'unchanged\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  shell(h, 'w1', `Write-Output '> ${readme}'`, 0, 2, 3)
  assistant(h, 'README 已更新。', 4)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// A derived record's id carries its content, so the same call reporting a different canonical
// value writes its own row instead of colliding (and the latest row stays authoritative).
test('E1 a repeated tools/result hook for one call does not collide', t => {
  const root = fixture(t), h = host(root)
  const args = { command: 'npm test', description: 'run the test' }
  const value = exitCode => ({ kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false, timeoutMs: 0,
    stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } })
  user(h, '修复登录的 bug 并验证')
  h.emit('tool/call', { turn: 1, callId: 'c1', name: 'pwsh', arguments: JSON.stringify(args) }, 2)
  h.toolResultHook('c1', 'pwsh', args, value(1))
  h.toolResultHook('c1', 'pwsh', args, value(0))
  h.emit('tool/result', sessResult('c1'), 3)
  assistant(h, '已修复并验证。', 4)
  h.stop(1) // must not throw evidence_event_id_conflict
  const rows = outcomeRecords(root).filter(r => r.tool_call_id === 'c1')
  assert.equal(rows.length, 2, 'each canonical value gets its own outcome row')
  assert.equal(rows.at(-1).exit_code, 0, 'the latest outcome stays authoritative')
})

// Containment: a collision on a re-derived record must not take the whole turn down. The
// patch below simulates one; the decision still has to land, and the anomaly has to be
// visible in the ledger rather than swallowed.
test('E2 a collision on a derived record cannot kill the decision', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const original = EvidenceLedger.prototype.record
  let simulated = 0
  EvidenceLedger.prototype.record = function (sessionId, type, payload, link) {
    if (type === 'task.classification' && simulated === 0) { simulated++; throw new Error('evidence_event_id_conflict') }
    return original.call(this, sessionId, type, payload, link)
  }
  try {
    const h = host(root)
    user(h, '修复登录的 bug 并验证')
    edit(h, 'e1', file, 2, 3)
    shell(h, 'v1', 'npm test', 0, 4, 5)
    assistant(h, '已修复并验证。', 6)
    h.stop(1) // must not throw out of the turn-stopping hook
    assert.equal(simulated, 1, 'the collision must actually have been simulated')
    assert.equal(decision(root).verdict, 'verified_complete', 'the decision must still be recorded')
    const conflicts = ledger(root).snapshot('session').filter(r => r.type === 'policy.conflict')
    assert.equal(conflicts.length, 1, 'the collision must be recorded as a diagnostic row')
    assert.equal(conflicts[0].payload.type, 'task.classification')
  } finally { EvidenceLedger.prototype.record = original }
})

// A shell-mediated edit leaves no diff meta and no write-tool call. It used to be invisible
// twice over: the object scope stayed empty (so the object digest was '' and every acceptance
// item became evidence_stale) and a document written that way could not answer a docs request.
test('E3 a document written through a shell is observable', t => {
  const root = fixture(t), readme = join(root, 'README.md')
  writeFileSync(readme, '# T\ninstall\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  shell(h, 'w1', `printf '# T\\ninstall\\n' > "${readme}"`, 0, 2, 3)
  assistant(h, 'README 已更新。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.equal(decision(root).verdict, 'verified_complete')
})

// The same shape for a code task: the only change was made by a shell command, so the object
// scope has to include the file that command wrote, or a real verification run cannot land.
test('E4 a file changed only through a shell enters the object scope', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  shell(h, 'w1', `printf 'c\\n' > "${file}"`, 0, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  const d = decision(root)
  assert.equal(d.verdict, 'verified_complete')
  assert.ok(!d.missing_requirements.some(m => m.missing_reason === 'evidence_stale'))
})

// A masked shell write must not answer a docs request: the aggregate exit code no longer
// speaks for the write.
test('E5 a masked shell write does not answer a docs request', t => {
  const root = fixture(t), readme = join(root, 'README.md')
  writeFileSync(readme, '# T\ninstall\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  shell(h, 'w1', `printf '# T\\ninstall\\n' > "${readme}" || true`, 0, 2, 3)
  assistant(h, 'README 已更新。', 4)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// Every user message advances the task revision, so a passing run from the previous revision
// cannot close the current one. That case must not read as "you supplied nothing": the
// decision has to say the evidence exists but is superseded, and the prompt has to say that
// re-running the same command is the fix.
test('E6 a passing run from an earlier revision reports evidence_superseded, not missing', t => {
  const root = fixture(t), file = join(root, 'login.js')
  writeFileSync(file, 'b\n')
  const h = host(root)
  user(h, '修复登录的 bug 并验证')
  edit(h, 'e1', file, 2, 3)
  shell(h, 'v1', 'npm test', 0, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  assert.equal(decision(root).verdict, 'verified_complete')

  user(h, '那现在解释一下你的改动', 7) // a new message = a new task revision
  assistant(h, '我把返回值改成了 b。', 8)
  h.stop(2)
  const d = decision(root)
  assert.equal(d.verdict, 'repair_required')
  assert.deepEqual(d.missing_requirements.map(m => `${m.requirement_id}:${m.missing_reason}`), ['AC-1:evidence_superseded'])
  assert.match(d.repair_action, /earlier task revision/)
  assert.match(d.repair_action, /Re-run the same command in this revision/)
})
