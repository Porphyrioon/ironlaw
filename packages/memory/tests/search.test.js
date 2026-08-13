import test from "node:test"
import assert from "node:assert/strict"
import { bm25Search } from "../src/search.js"

test("ranks matching English docs first", () => {
  const docs = [
    { key: "nvidia", text: "nvidia stock holdings", value: {}, tags: [], scope: "user", updated_ts: 1 },
    { key: "color", text: "favorite color is blue", value: {}, tags: [], scope: "user", updated_ts: 1 },
  ]
  const r = bm25Search(docs, "nvidia holdings", 10)
  assert.equal(r[0].key, "nvidia")
})

test("ranks matching Chinese docs first", () => {
  const docs = [
    { key: "pwd", text: "数据库密码轮换流程", value: {}, tags: [], scope: "user", updated_ts: 1 },
    { key: "theme", text: "前端主题颜色偏好", value: {}, tags: [], scope: "user", updated_ts: 1 },
  ]
  const r = bm25Search(docs, "数据库密码", 10)
  assert.equal(r[0].key, "pwd")
})

test("empty docs returns empty", () => {
  assert.deepEqual(bm25Search([], "q", 10), [])
})
