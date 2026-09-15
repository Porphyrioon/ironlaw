import test from 'node:test'
import assert from 'node:assert/strict'
import { classifyTaskType, isTaskType, TASK_TYPES } from '@ironlaw/adapter-dsh'

test('classifier: a documentation artifact stays docs even with a generic change verb', () => {
  for (const t of ['改 README', '更新 README', '写一份 API 文档', 'update the docs', '修订说明书', 'write a spec for X', '补充 changelog'])
    assert.equal(classifyTaskType(t), 'docs', t)
})

test('classifier: defect / code-change requests are code', () => {
  for (const t of ['修复登录 bug', 'Fix and test', '实现用户认证', '重构这个模块', '加一个单元测试', '改一下这段代码', '优化性能', 'run the test suite'])
    assert.equal(classifyTaskType(t), 'code', t)
})

test('classifier: operation requests are ops', () => {
  for (const t of ['部署到生产', '发布新版本', '重启服务', 'deploy to prod', 'rollback the release'])
    assert.equal(classifyTaskType(t), 'ops', t)
})

test('classifier: research requests are research', () => {
  for (const t of ['调研市面上的方案', '研究一下这个问题', '查一下相关资料', 'investigate the options'])
    assert.equal(classifyTaskType(t), 'research', t)
})

test('classifier: a pure question with no action is discussion', () => {
  for (const t of ['你怎么看这个方案', '为什么天是蓝的', '解释一下闭包', 'should we use REST or GraphQL'])
    assert.equal(classifyTaskType(t), 'discussion', t)
})

// ⑤ uncertain / empty / non-string falls to the strictest type.
test('classifier ⑤: uncertain, empty or non-string input falls to code (strictest)', () => {
  for (const t of ['', '   ', 'Do the task', 'hello there', 'the thing', null, undefined, 42, {}])
    assert.equal(classifyTaskType(t), 'code', JSON.stringify(t))
})

// Hard invariant: a strong code/defect signal outranks a discussion or docs framing, so a
// code task cannot smuggle itself into a weaker template by adding a question word.
test('classifier: a code/defect signal outranks discussion and docs framing (no bypass)', () => {
  assert.equal(classifyTaskType('讨论一下怎么实现这个功能'), 'code')
  assert.equal(classifyTaskType('解释这个 bug 的修复方案'), 'code')
  assert.equal(classifyTaskType('为什么测试总是失败'), 'code')
  assert.equal(classifyTaskType('聊聊要不要重构这段代码'), 'code')
})

test('classifier: TASK_TYPES and isTaskType guard', () => {
  assert.deepEqual([...TASK_TYPES].sort(), ['code', 'discussion', 'docs', 'ops', 'research'])
  assert.equal(isTaskType('docs'), true)
  assert.equal(isTaskType('nope'), false)
  assert.equal(isTaskType(undefined), false)
})
