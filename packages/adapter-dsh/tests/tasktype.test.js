import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceLedger } from '../lib/evidence.js'
// The compiled package entry wires defaultResolveAudit when no config.resolveAudit is given.
import { apply } from '@ironlaw/adapter-dsh'

const fixture = t => { const root = mkdtempSync(join(tmpdir(), 'ironlaw-tt-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
function host(root, resolveAudit) {
  const handlers = new Map(), prompts = []
  const session = { id: 'session' }
  apply({ on(name, fn) { handlers.set(name, fn) }, tools: { guard() {} } }, { evidenceRoot: root, resolveAudit })
  return { handlers, prompts,
    emit(type, data, seq) { handlers.get('session/event')(session, { type, data, seq }) },
    stop(turn = 1) { handlers.get('agent/turn-stopping')({ agent: { session, steer: m => prompts.push(m) }, turn }) },
    /** The host hook: exit code and captured object version exist only here (see hostshape.test.js). */
    toolResultHook(callId, name, args, value) {
      handlers.get('tools/result')(
        { callId, rootCallId: callId, name, arguments: args, agent: { session }, signal: new AbortController().signal, token: Symbol('exec') },
        { isError: false, value, content: [] })
    } }
}
const canonical = exitCode => ({ kind: 'foreground', exitCode, signal: null, timedOut: false, aborted: false,
  timeoutMs: 0, stdout: { text: 'ok', truncated: false }, stderr: { text: '', truncated: false } })
const toolResult = (callId, patch = {}) => ({ turn: 1, message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', toolCallId: callId, isError: false, content: [] }] }, ...patch })
const decision = root => new EvidenceLedger(root).latest('session', 'completion.decision')
const taskType = root => new EvidenceLedger(root).latest('session', 'task.classification')?.task_type
const user = (h, text, seq = 1) => h.emit('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] }, seq)
const assistant = (h, text, seq) => h.emit('assistant/message', { turn: 1, message: { content: [{ type: 'text', text }] } }, seq)
const edit = (h, callId, path, cSeq, rSeq, oldText = null, newText = 'new\n') => {
  const args = { file_path: path }
  h.emit('tool/call', { turn: 1, callId, name: 'edit', arguments: JSON.stringify(args) }, cSeq)
  h.toolResultHook(callId, 'edit', args, { ok: true })
  h.emit('tool/result', toolResult(callId, { meta: { card: 'diff', diffs: [{ path, oldText, newText }] } }), rSeq)
}
const shell = (h, callId, command, exitCode, cSeq, rSeq) => {
  h.emit('tool/call', { turn: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) }, cSeq)
  h.toolResultHook(callId, 'bash', { command }, canonical(exitCode))
  h.emit('tool/result', toolResult(callId), rSeq)
}

// ① The reported false positive: a README change with no test command must NOT be evidence_missing.
test('① docs: editing README with no verification command is not evidence_missing', t => {
  const root = fixture(t), readme = join(root, 'README.md'); writeFileSync(readme, '# Title\ninstall steps\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  edit(h, 'w1', readme, 2, 3, '# Title\n', '# Title\ninstall steps\n')
  assistant(h, 'README 已更新。', 4)
  h.stop(1)
  const d = decision(root), ledger = new EvidenceLedger(root)
  assert.equal(taskType(root), 'docs')
  assert.equal(d.verdict, 'verified_complete')
  assert.ok(!d.missing_requirements.some(m => m.missing_reason === 'evidence_missing'), 'docs must not be evidence_missing')
  const proof = ledger.verifications('session', ledger.task('session').task_id).find(v => v.status === 'passed')
  assert.equal(proof.source_kind, 'host_verifier')
  assert.deepEqual(proof.requirement_ids, ['AC-1'])
  assert.ok(proof.verifier_ref.startsWith('dsh-host:docs-artifact:'))
})

// docs is host-verified: if the target file is not actually readable, no proof is minted.
test('① docs: a claimed write whose file is not readable on the host is not verified', t => {
  const root = fixture(t), h = host(root)
  const ghost = join(root, 'MISSING.md') // never created on disk
  user(h, '更新 README 文档')
  edit(h, 'w1', ghost, 2, 3)
  assistant(h, '文档已写好。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// ② A code task with no verification command still requires evidence.
test('② code: a bug-fix request with a file edit but no verification stays evidence_missing', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'x')
  const h = host(root)
  user(h, '修复登录的 bug')
  edit(h, 'e1', code, 2, 3, 'x', 'y')
  assistant(h, '已修复。', 4)
  h.stop(1)
  const d = decision(root)
  assert.equal(taskType(root), 'code')
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})

// ③ Regressions under an explicit code classification: the strict path is unchanged.
function codeThenCommand(t, humanText, cmd, exitCode) {
  const root = fixture(t), code = join(root, 'code.js'); writeFileSync(code, 'module.exports=1\n')
  const h = host(root)
  user(h, humanText)
  edit(h, 'e1', code, 2, 3, null, 'module.exports=2\n')
  shell(h, 'v1', cmd, exitCode, 4, 5)
  assistant(h, '已修复并验证。', 6)
  h.stop(1)
  return decision(root)
}
test('③ regression: code + echo (exit 0) is NOT verified_complete', t => {
  const d = codeThenCommand(t, '修复并验证', 'echo hello', 0)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.missing_reason === 'evidence_missing'))
})
test('③ regression: code + npm test || true (exit 0) is NOT verified_complete', t => {
  const d = codeThenCommand(t, '修复并验证', 'npm test || true', 0)
  assert.notEqual(d.verdict, 'verified_complete')
})
test('③ regression: code + real npm test (exit 0) IS verified_complete', t => {
  const d = codeThenCommand(t, '修复并验证', 'npm test', 0)
  assert.equal(d.verdict, 'verified_complete')
  assert.equal(d.missing_requirements.length, 0)
})
test('③ regression: code + model self-report with no host evidence is repair_required', t => {
  const root = fixture(t), h = host(root)
  user(h, '实现并测试新功能')
  assistant(h, '所有测试都通过了，功能已完成！', 2)
  h.stop(1)
  assert.equal(taskType(root), 'code')
  assert.equal(decision(root).verdict, 'repair_required')
})

// ④ Security invariant: classification comes from the human request, never the model's prose.
test('④ human asks for a code change; the model calling it "just discussion" does not reclassify', t => {
  const root = fixture(t), code = join(root, 'login.js'); writeFileSync(code, 'x')
  const h = host(root)
  user(h, '改一下登录的代码')
  edit(h, 'e1', code, 2, 3, 'x', 'y')
  assistant(h, '这只是讨论，不需要任何验证。', 4)
  h.stop(1)
  const d = decision(root)
  assert.equal(taskType(root), 'code', 'type is derived from the human request only')
  assert.notEqual(d.verdict, 'allow_response', 'a model cannot turn a code task into a discussion')
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})

// ⑤ Uncertain request falls to the strictest type end-to-end.
test('⑤ uncertain request is classified code and still requires verification', t => {
  const root = fixture(t), h = host(root)
  user(h, 'Do the task')
  assistant(h, 'Task complete.', 2)
  h.stop(1)
  assert.equal(taskType(root), 'code')
  assert.equal(decision(root).verdict, 'repair_required')
})

// discussion: a pure question owes no artifact.
test('discussion: a pure question is allow_response with no evidence required', t => {
  const root = fixture(t), h = host(root)
  user(h, '你怎么看这个架构方案')
  assistant(h, '我建议用分层架构。', 2)
  h.stop(1)
  assert.equal(taskType(root), 'discussion')
  assert.equal(decision(root).verdict, 'allow_response')
  assert.equal(h.prompts.length, 0)
})

// research: delivered content plus a host-observed source verifies; no source does not.
test('research: delivered content with a host-observed retrieval verifies', t => {
  const root = fixture(t), h = host(root)
  user(h, '调研一下市面上的方案')
  h.emit('tool/call', { turn: 1, callId: 's1', name: 'web_search', arguments: JSON.stringify({ query: 'options' }) }, 2)
  h.emit('tool/result', toolResult('s1'), 3)
  assistant(h, '调研结论：方案 A 更合适。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'research')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('research: no host-observed source is not verified_complete', t => {
  const root = fixture(t), h = host(root)
  user(h, '调研一下市面上的方案')
  assistant(h, '我觉得方案 A 不错。', 2)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// ops: the actual entry point's unmasked exit 0 verifies; a masked one does not.
test('ops: a host-observed unmasked exit-0 deploy verifies', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 0, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'ops')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('ops: a masked deploy (|| true) is not verified_complete', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod || true', 0, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// ⑥ A template must match the human request, not merely any host-shaped artifact.
// Each "hole" case below was verified_complete before the fix; each control case is
// here so the fix cannot pass by simply rejecting everything.
const scratch = t => { const root = mkdtempSync(join(tmpdir(), 'ironlaw-tt6-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root }
const retrieval = (h, callId, name, args, cSeq, rSeq) => {
  h.emit('tool/call', { turn: 1, callId, name, arguments: JSON.stringify(args) }, cSeq)
  h.emit('tool/result', toolResult(callId), rSeq)
}

// docs hole A: README requested, an unrelated file written instead.
test('⑥ docs: README requested but an unrelated file written is not verified_complete', t => {
  const root = fixture(t), other = join(root, 'scratch-notes.txt'); writeFileSync(other, 'unrelated\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  edit(h, 'w1', other, 2, 3)
  assistant(h, '文档已更新。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})

// docs hole B: the request names no path, so only a document-shaped target counts.
test('⑥ docs: a non-document write with no path named is not verified_complete', t => {
  const root = fixture(t), other = join(root, 'scratch-notes.txt'); writeFileSync(other, 'notes\n')
  const h = host(root)
  user(h, '写一篇安装说明文档')
  edit(h, 'w1', other, 2, 3)
  assistant(h, '写好了。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.notEqual(decision(root).verdict, 'verified_complete')
})
test('⑥ docs: a Markdown write with no path named IS verified_complete', t => {
  const root = fixture(t), guide = join(root, 'install-guide.md'); writeFileSync(guide, '# Install\n')
  const h = host(root)
  user(h, '写一篇安装说明文档')
  edit(h, 'w1', guide, 2, 3, null, '# Install\nsteps\n')
  assistant(h, '写好了。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('⑥ docs: an explicitly named CHANGELOG.md IS verified_complete', t => {
  const root = fixture(t), cl = join(root, 'CHANGELOG.md'); writeFileSync(cl, '# Log\n')
  const h = host(root)
  user(h, '更新 CHANGELOG.md，记录本次变更')
  edit(h, 'w1', cl, 2, 3, '# Log\n', '# Log\n- v2\n')
  assistant(h, '已更新。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('⑥ docs: a named docs/ directory accepts files written under it', t => {
  const root = fixture(t), dir = join(root, 'docs'); mkdirSync(dir, { recursive: true })
  const page = join(dir, 'install.md'); writeFileSync(page, '# Install\n')
  const h = host(root)
  user(h, '在 docs/ 下补充安装说明')
  edit(h, 'w1', page, 2, 3, null, '# Install\nsteps\n')
  assistant(h, '已补充。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('⑥ docs: a URL in the request is a reference, not a target', t => {
  const root = fixture(t), guide = join(root, 'guide.md'); writeFileSync(guide, '# g\n')
  const h = host(root)
  user(h, '参考 https://example.com/style/README.md 更新文档')
  edit(h, 'w1', guide, 2, 3, null, '# g\nbody\n')
  assistant(h, '已更新。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('⑥ docs: a version number in the request is not a named target', t => {
  const root = fixture(t), notes = join(root, 'release-notes.md'); writeFileSync(notes, '# r\n')
  const h = host(root)
  user(h, '写一篇 v2.0 的说明文档')
  edit(h, 'w1', notes, 2, 3, null, '# r\nbody\n')
  assistant(h, '写好了。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.equal(decision(root).verdict, 'verified_complete')
})
test('⑥ docs: a different named document does not stand in for the requested one', t => {
  const root = fixture(t), readme = join(root, 'README.md'); writeFileSync(readme, '# x\n')
  const h = host(root)
  user(h, '更新 CONTRIBUTING.md 文档，说明贡献流程')
  edit(h, 'w1', readme, 2, 3, null, '# x\nbody\n')
  assistant(h, '已更新。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})

// ops hole C: any unmasked exit-0 command was accepted as "the entry point ran".
test('⑥ ops: a trivial echo (exit 0) is not verified_complete', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', 'echo hello', 0, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'ops')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1'))
})
test('⑥ ops: noop commands exiting 0 never verify', t => {
  for (const cmd of ['echo hello', 'printf done', 'true', ':', 'cd /tmp', 'ls -la', 'cat deploy.sh', 'pwd', 'which deploy']) {
    const root = scratch(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'ops', cmd)
    assert.notEqual(decision(root).verdict, 'verified_complete', `noop must not verify: ${cmd}`)
  }
})
test('⑥ ops: real entry points DO verify', t => {
  for (const cmd of ['./deploy.sh prod', 'cd /srv/app && ./deploy.sh prod', 'kubectl apply -f deploy.yaml',
    'npm run deploy', 'make release', 'docker compose up -d', 'python manage.py migrate', 'systemctl restart nginx']) {
    const root = scratch(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'ops', cmd)
    assert.equal(decision(root).verdict, 'verified_complete', `entry point must verify: ${cmd}`)
  }
})
test('⑥ ops: an interpreter given inline code is not an entry point', t => {
  for (const cmd of ['bash -c "echo hi"', 'python -c "print(1)"', 'sh -c "true"']) {
    const root = scratch(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `inline code must not verify: ${cmd}`)
  }
})
test('⑥ ops: a real entry point exiting non-zero is not verified_complete', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'd1', './deploy.sh prod', 1, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  assert.notEqual(decision(root).verdict, 'verified_complete')
})

// research hole D: reading any local file counted as consulting a source.
test('⑥ research: reading an unrelated local file is not verified_complete', t => {
  const root = fixture(t), other = join(root, 'scratch-notes.txt'); writeFileSync(other, 'unrelated\n')
  const h = host(root)
  user(h, '调研一下市面上的方案')
  retrieval(h, 'r1', 'read', { file_path: other }, 2, 3)
  assistant(h, '结论：方案 A 更合适。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'research')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1'))
})
test('⑥ research: local-only inspection tools never verify', t => {
  for (const name of ['read', 'grep', 'glob', 'find', 'list_dir']) {
    const root = scratch(t), h = host(root)
    user(h, '调研一下市面上的方案')
    retrieval(h, 'r1', name, { query: 'options' }, 2, 3)
    assistant(h, '结论：方案 A 更合适。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'research', name)
    assert.notEqual(decision(root).verdict, 'verified_complete', `local tool must not verify: ${name}`)
  }
})
test('⑥ research: external-source tools DO verify', t => {
  for (const name of ['web_search', 'WebFetch', 'browser_navigate', 'fetch_url', 'firecrawl_scrape']) {
    const root = scratch(t), h = host(root)
    user(h, '调研一下市面上的方案')
    retrieval(h, 'r1', name, { query: 'options' }, 2, 3)
    assistant(h, '结论：方案 A 更合适。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'research', name)
    assert.equal(decision(root).verdict, 'verified_complete', `external tool must verify: ${name}`)
  }
})

// Strictness floor: a masked exit code is no proof under any task type.
test('⑥ masking: a masked verification command never verifies under any type', t => {
  for (const [request, want] of [['更新 README 文档', 'docs'], ['调研一下市面上的方案', 'research'],
    ['部署到生产环境', 'ops'], ['修复并验证', 'code']]) {
    for (const cmd of ['npm test || true', 'npm test; true']) {
      const root = scratch(t), h = host(root)
      user(h, request)
      shell(h, 'c1', cmd, 0, 2, 3)
      assistant(h, '完成。', 4)
      h.stop(1)
      assert.equal(taskType(root), want, request)
      assert.notEqual(decision(root).verdict, 'verified_complete', `${want} + ${cmd} must not verify`)
    }
  }
})

// ⑦ Round 2: a non-code type must never be closed by evidence belonging to another
// type, and its own artifact must be the real thing.

// 缺陷4: falling back to strict code evidence let a free `npm test` satisfy a request
// that asked for a document / an external query / an operation.
test('⑦ docs: an unrelated write plus a passing npm test does NOT close the task', t => {
  const root = fixture(t), other = join(root, 'scratch-notes.txt'); writeFileSync(other, 'unrelated\n')
  const h = host(root)
  user(h, '更新 README 文档，补充安装说明')
  edit(h, 'w1', other, 2, 3)
  shell(h, 'c1', 'npm test', 0, 4, 5)
  assistant(h, '文档已更新，测试也过了。', 6)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})
test('⑦ research: no external source plus a passing npm test does NOT close the task', t => {
  const root = fixture(t), h = host(root)
  user(h, '调研一下市面上的方案')
  shell(h, 'c1', 'npm test', 0, 2, 3)
  assistant(h, '调研结论：方案 A 更合适。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'research')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'))
})
// The ops case used to fail only by accident (an empty digest made the borrowed
// evidence stale); it must now fail because no ops evidence exists at all.
test('⑦ ops: a passing npm test does NOT close a deploy task, and the reason is evidence_missing', t => {
  const root = fixture(t), h = host(root)
  user(h, '部署到生产环境')
  shell(h, 'c1', 'npm test', 0, 2, 3)
  assistant(h, '已部署。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'ops')
  const d = decision(root)
  assert.notEqual(d.verdict, 'verified_complete')
  assert.ok(d.missing_requirements.some(m => m.requirement_id === 'AC-1' && m.missing_reason === 'evidence_missing'),
    `expected evidence_missing, got ${JSON.stringify(d.missing_requirements)}`)
})

// 缺陷5: a dry run or a build changes no state, so it is not an operation entry point.
test('⑦ ops: read-only and build-only commands never verify', t => {
  for (const cmd of ['terraform plan', 'docker compose build', 'docker build -t app .', 'docker-compose build',
    'mvn release:prepare', 'cdk diff', 'pulumi preview', 'cargo pack', 'gradle installDist', 'helm template ./chart']) {
    const root = scratch(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'ops', cmd)
    assert.notEqual(decision(root).verdict, 'verified_complete', `state-changing entry required: ${cmd}`)
  }
})
test('⑦ ops: dry-run flags do not verify even on a real entry point', t => {
  for (const cmd of ['kubectl apply --dry-run=client -f d.yaml', 'helm install app ./chart --dry-run',
    'rsync --dry-run -av dist/ host:/srv/', 'ansible-playbook --check site.yml', './deploy.sh --dry-run prod']) {
    const root = scratch(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `dry run must not verify: ${cmd}`)
  }
})
test('⑦ ops: a build-named script is not a deploy entry point', t => {
  for (const cmd of ['./build.sh', './plan.sh', 'bash scripts/test.sh', './check.sh prod']) {
    const root = scratch(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `build-only script must not verify: ${cmd}`)
  }
})
test('⑦ ops: state-changing commands DO verify', t => {
  for (const cmd of ['terraform apply -auto-approve', 'docker compose up --build -d', 'docker push registry/app:1',
    'mvn release:perform', 'kubectl rollout restart deploy/api', 'git push origin main', 'rsync -av dist/ host:/srv/']) {
    const root = scratch(t), h = host(root)
    user(h, '部署到生产环境')
    shell(h, 'd1', cmd, 0, 2, 3)
    assistant(h, '已部署。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'ops', cmd)
    assert.equal(decision(root).verdict, 'verified_complete', `state-changing entry must verify: ${cmd}`)
  }
})

// 缺陷6: a backup or scratch copy is not the artifact the request named.
test('⑦ docs: a backup copy of the named file does NOT verify', t => {
  for (const name of ['README.bak', 'README.old', 'README.orig', 'README.tmp', 'README.save', 'README.copy',
    'README.backup', 'README.md~', 'README.md.bak']) {
    const root = scratch(t), bak = join(root, name); writeFileSync(bak, 'old backup\n')
    const h = host(root)
    user(h, '更新 README 文档，补充安装说明')
    edit(h, 'w1', bak, 2, 3)
    assistant(h, '已更新。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'docs', name)
    assert.notEqual(decision(root).verdict, 'verified_complete', `backup copy must not verify: ${name}`)
  }
})
test('⑦ docs: a backup copy is not a document artifact either when no path is named', t => {
  const root = fixture(t), dir = join(root, 'docs'); mkdirSync(dir, { recursive: true })
  const bak = join(dir, 'install.md.bak'); writeFileSync(bak, 'old\n')
  const h = host(root)
  user(h, '写一篇安装说明文档')
  edit(h, 'w1', bak, 2, 3)
  assistant(h, '写好了。', 4)
  h.stop(1)
  assert.equal(taskType(root), 'docs')
  assert.notEqual(decision(root).verdict, 'verified_complete')
})
// A named directory target matched on the path segment alone, so any backup left
// under it counted as the deliverable.
test('⑦ docs: a backup copy under a named docs/ directory does NOT verify', t => {
  for (const name of ['install.md.bak', 'install.md.old', 'install.md~', 'install.tmp']) {
    const root = scratch(t), dir = join(root, 'docs'); mkdirSync(dir, { recursive: true })
    const bak = join(dir, name); writeFileSync(bak, 'old\n')
    const h = host(root)
    user(h, '在 docs/ 下补充安装说明')
    edit(h, 'w1', bak, 2, 3)
    assistant(h, '已补充。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'docs', name)
    assert.notEqual(decision(root).verdict, 'verified_complete', `backup under docs/ must not verify: ${name}`)
  }
})
test('⑦ docs: the bare named file and its Markdown form both verify', t => {
  for (const name of ['README', 'README.md', 'README.mdx', 'README.rst', 'README.adoc']) {
    const root = scratch(t), f = join(root, name); writeFileSync(f, '# Title\n')
    const h = host(root)
    user(h, '更新 README 文档，补充安装说明')
    edit(h, 'w1', f, 2, 3, null, '# Title\ninstall\n')
    assistant(h, '已更新。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'docs', name)
    assert.equal(decision(root).verdict, 'verified_complete', `requested document must verify: ${name}`)
  }
})
test('⑦ docs: a non-document extension on the named stem does NOT verify', t => {
  for (const name of ['README.txt', 'README.json', 'README.log']) {
    const root = scratch(t), f = join(root, name); writeFileSync(f, 'x\n')
    const h = host(root)
    user(h, '更新 README 文档，补充安装说明')
    edit(h, 'w1', f, 2, 3)
    assistant(h, '已更新。', 4)
    h.stop(1)
    assert.notEqual(decision(root).verdict, 'verified_complete', `wrong extension must not verify: ${name}`)
  }
})

// 缺陷7: a tool name with no external indicator is not proof of an external source.
test('⑦ research: locally-named search tools never verify', t => {
  for (const name of ['search_files', 'codebase_search', 'search', 'retrieve', 'retrieval', 'grep_search', 'query']) {
    const root = scratch(t), h = host(root)
    user(h, '调研一下市面上的方案')
    retrieval(h, 'r1', name, { query: 'x' }, 2, 3)
    assistant(h, '结论：方案 A 更合适。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'research', name)
    assert.notEqual(decision(root).verdict, 'verified_complete', `local tool must not verify: ${name}`)
  }
})
test('⑦ research: externally-named tools still verify', t => {
  for (const name of ['web_search', 'WebFetch', 'browser_navigate', 'fetch_url', 'firecrawl_scrape',
    'http_request', 'playwright_open', 'online_lookup']) {
    const root = scratch(t), h = host(root)
    user(h, '调研一下市面上的方案')
    retrieval(h, 'r1', name, { query: 'x' }, 2, 3)
    assistant(h, '结论：方案 A 更合适。', 4)
    h.stop(1)
    assert.equal(taskType(root), 'research', name)
    assert.equal(decision(root).verdict, 'verified_complete', `external tool must verify: ${name}`)
  }
})
