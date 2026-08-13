import test from "node:test"
import assert from "node:assert/strict"
import { redact } from "../src/redact.js"

test("redacts credential-shaped JSON fields", () => {
  const output = redact('{"apiKey":"secret-value","message":"keep"}')
  assert.equal(output.includes("secret-value"), false)
  assert.equal(output.includes("keep"), true)
})

test("redacts access tokens", () => {
  assert.equal(redact('{"accessToken":"secret-value"}').includes("secret-value"), false)
})
