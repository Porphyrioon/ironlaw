import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import { fileURLToPath } from "node:url"
import crypto from "node:crypto"

test("sidecar performs handshake and records an event", async () => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const project = path.join(here, "fixtures", crypto.randomUUID())
  const child = spawn(process.execPath, [path.join(here, "..", "sidecar.js"), "serve", "--stdio", "--project", project], { stdio: ["pipe", "pipe", "ignore"] })
  const lines = createInterface({ input: child.stdout })
  const next = () => new Promise(resolve => lines.once("line", line => resolve(JSON.parse(line))))
  child.stdin.write(JSON.stringify({ id: "1", method: "handshake" }) + "\n")
  assert.equal((await next()).result.ok, true)
  child.stdin.write(JSON.stringify({ id: "2", method: "session.event", params: { type: "chat.message", input: { sessionID: "ses_test" }, parts: [{ type: "text", text: "fix login" }] } }) + "\n")
  assert.equal((await next()).result.verdict, "recorded")
  lines.close()
  child.stdin.destroy()
  child.kill()
  child.unref()
})
