import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { init, write, read, forget, search } from "../src/store.js"

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ilmem-"))
}

test("writes and reads a node", () => {
  const root = init(tmpRoot())
  write(root, { key: "k1", value: "hello", scope: "user" })
  assert.equal(read(root, "k1").value, "hello")
})

test("redacts secrets on write", () => {
  const root = init(tmpRoot())
  write(root, { key: "k2", value: "db password=supersecret", scope: "user" })
  assert.equal(read(root, "k2").value.includes("supersecret"), false)
})

test("forget removes a node", () => {
  const root = init(tmpRoot())
  write(root, { key: "k3", value: "x" })
  assert.equal(forget(root, "k3"), true)
  assert.equal(read(root, "k3"), null)
})

test("search finds matching nodes", () => {
  const root = init(tmpRoot())
  write(root, { key: "pref", value: "用户偏好中文回答" })
  write(root, { key: "other", value: "unrelated english text" })
  const r = search(root, "中文", "user", 10)
  assert.equal(r[0].key, "pref")
})

test("session and user scopes are isolated", () => {
  const root = init(tmpRoot())
  write(root, { key: "temp", value: "x", scope: "session" })
  write(root, { key: "keep", value: "y", scope: "user" })
  assert.equal(read(root, "temp", "user"), null)
  assert.equal(read(root, "keep", "session"), null)
})

test("source filters search results", () => {
  const root = init(tmpRoot())
  write(root, { key: "a", value: "claude preference", source: "claude" })
  write(root, { key: "b", value: "codex preference", source: "codex" })
  const r = search(root, "preference", "user", 10, "claude")
  assert.equal(r.length, 1)
  assert.equal(r[0].key, "a")
})
