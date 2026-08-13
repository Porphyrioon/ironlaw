import test from "node:test"
import assert from "node:assert/strict"
import { destructiveReason } from "../lib/policy.js"

test("allows ordinary shell commands", () => {
  assert.equal(destructiveReason("pwsh", { command: "echo hi" }), undefined)
  assert.equal(destructiveReason("pwsh", { command: "npm test" }), undefined)
  assert.equal(destructiveReason("bash", { command: "pwd" }), undefined)
})

test("blocks dangerous shell commands", () => {
  assert.ok(destructiveReason("pwsh", { command: "rm -rf /tmp/x" }))
  assert.ok(destructiveReason("bash", { command: "git reset --hard" }))
  assert.ok(destructiveReason("pwsh", { command: "rm -r build" }))
})

test("blocks sensitive-path writes", () => {
  assert.ok(destructiveReason("write", { path: "/home/u/.env" }))
  assert.ok(destructiveReason("write", { path: "/home/u/.ssh/id_rsa" }))
  assert.ok(destructiveReason("str_replace_editor", { file_path: "/home/u/.npmrc" }))
})

test("allows normal writes and reads", () => {
  assert.equal(destructiveReason("write", { path: "/home/u/notes.md" }), undefined)
  assert.equal(destructiveReason("read", { path: "/home/u/notes.md" }), undefined)
})
