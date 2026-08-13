import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

function rpc(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params })
}

function drive(messages) {
  return new Promise(resolve => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ilmem-e2e-"))
    const child = spawn(process.execPath, ["src/server.js"], {
      cwd: path.resolve("."),
      env: { ...process.env, IRONLAW_MEMORY_ROOT: tmp },
      stdio: ["pipe", "pipe", "pipe"],
    })
    const out = []
    child.stdout.on("data", d => out.push(d.toString()))
    for (const m of messages) child.stdin.write(m + "\n")
    child.stdin.end()
    const timer = setTimeout(() => { child.kill(); resolve(out.join("")) }, 3000)
    child.on("close", () => { clearTimeout(timer); resolve(out.join("")) })
  })
}

test("initialize → tools/list → write → inject round trip", async () => {
  const out = await drive([
    rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    rpc(2, "tools/list"),
    rpc(3, "tools/call", { name: "memory_write", arguments: { key: "pref", value: "用户偏好中文回答", scope: "user" } }),
    rpc(4, "tools/call", { name: "memory_inject", arguments: { query: "回答语言偏好" } }),
  ])
  const byId = {}
  for (const line of out.split("\n").filter(Boolean)) {
    const msg = JSON.parse(line)
    if (msg.id !== undefined) byId[msg.id] = msg
  }
  assert.equal(byId[1].result.protocolVersion, "2025-06-18")
  assert.equal(byId[2].result.tools.length, 6)
  assert.match(byId[3].result.content[0].text, /中文回答/)
  assert.match(byId[4].result.content[0].text, /Memory/)
})
