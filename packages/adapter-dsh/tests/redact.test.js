import test from "node:test"
import assert from "node:assert/strict"
import { sanitizeEvidence } from "../lib/redact.js"

test("redacts secret keys recursively", () => {
  const out = sanitizeEvidence({ api_key: "sk-abc123", note: "hi", nested: { authorization: "Bearer xyz" } })
  assert.equal(out.api_key, "[REDACTED]")
  assert.equal(out.note, "hi")
  assert.equal(out.nested.authorization, "[REDACTED]")
})

test("redacts bearer tokens in strings", () => {
  assert.equal(sanitizeEvidence("use Bearer abc.def.ghi here"), "use [REDACTED] here")
})

test("redacts url credentials", () => {
  assert.equal(sanitizeEvidence("https://u:p@host/x"), "https://[REDACTED]:[REDACTED]@host/x")
})

test("redacts password fields", () => {
  assert.equal(sanitizeEvidence({ password: "p@ss" }).password, "[REDACTED]")
})
