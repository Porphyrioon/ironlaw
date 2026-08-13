import test from "node:test"
import assert from "node:assert/strict"
import { redact, sanitizeMemory } from "../src/redact.js"

test("redacts credential-shaped JSON fields", () => {
  const out = redact('{"apiKey":"secret-value","message":"keep"}')
  assert.equal(out.includes("secret-value"), false)
  assert.equal(out.includes("keep"), true)
})

test("redacts postgres database URLs", () => {
  const out = redact("postgres://dbuser:dbsecret@example.com:5432/appdb")
  assert.equal(out.includes("dbsecret"), false)
})

test("sanitizes nested objects by key", () => {
  const out = sanitizeMemory({ password: "hunter2", note: "keep" })
  assert.equal(out.password, "[REDACTED]")
  assert.equal(out.note, "keep")
})
