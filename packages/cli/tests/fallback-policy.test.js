import test from "node:test"
import assert from "node:assert/strict"
import { fallbackPreTool } from "../src/fallback-policy.js"

test("allows ordinary shell commands", () => {
  assert.equal(fallbackPreTool("shell", { command: "npm test" }, "C:/work").block, false)
})

test("blocks recursive deletion outside workspace", () => {
  const result = fallbackPreTool("shell", { command: "rm -rf C:/Users" }, "C:/work")
  assert.equal(result.block, true)
})

test("blocks deleting the workspace root", () => {
  assert.equal(fallbackPreTool("shell", { command: "rm -rf C:/work" }, "C:/work").block, true)
})
