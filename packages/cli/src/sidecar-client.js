import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import path from "node:path"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"

function findNode() {
  if (process.env.IRONLAW_NODE_PATH && fs.existsSync(process.env.IRONLAW_NODE_PATH)) return process.env.IRONLAW_NODE_PATH
  const candidates = process.platform === "win32"
    ? [path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"), path.join(process.env.APPDATA || "", "npm", "node.exe")]
    : ["/usr/local/bin/node", "/usr/bin/node"]
  return candidates.find(candidate => fs.existsSync(candidate)) || process.execPath
}

export class SidecarClient {
  constructor(child) {
    this.child = child
    this.pending = new Map()
    this.queue = []
    this.closed = false
    this.degraded = false
    const lines = createInterface({ input: child.stdout })
    lines.on("line", line => {
      try {
        const message = JSON.parse(line)
        const waiter = this.pending.get(message.id)
        if (waiter) { this.pending.delete(message.id); waiter(message) }
      } catch { /* malformed sidecar output is ignored */ }
    })
    child.on("exit", () => {
      this.closed = true
      this.degraded = true
      for (const waiter of this.pending.values()) waiter({ ok: false, error: "sidecar exited" })
      this.pending.clear()
    })
  }

  static async spawn(options) {
    const sidecar = process.env.IRONLAW_SIDECAR_PATH || path.join(options.root, "sidecar.js")
    const child = spawn(findNode(), [sidecar, "serve", "--stdio", "--parent-pid", String(options.parentPid), "--project", options.directory], {
      cwd: options.directory,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    })
    const client = new SidecarClient(child)
    const handshake = await client.request("handshake", { host: "opencode", host_version: "1.18.x", adapter: "stable-v1" }, 1000)
    if (!handshake?.ok) { client.close(); throw new Error("IronLaw sidecar handshake failed") }
    const heartbeat = await client.request("heartbeat", { pid: process.pid }, 1000)
    if (!heartbeat?.ok) { client.close(); throw new Error("IronLaw sidecar heartbeat failed") }
    return client
  }

  request(method, params, timeoutMs) {
    if (this.closed) return Promise.resolve({ ok: false, error: "sidecar unavailable" })
    const id = randomUUID()
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: "sidecar timeout" }) }, timeoutMs)
      this.pending.set(id, message => { clearTimeout(timer); resolve(message.result ?? message) })
      try { this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`) }
      catch { clearTimeout(timer); this.pending.delete(id); resolve({ ok: false, error: "sidecar unavailable" }) }
    })
  }

  enqueue(method, params) {
    if (!this.closed) { try { this.child.stdin.write(`${JSON.stringify({ id: randomUUID(), method, params })}\n`) } catch { this.closed = true } }
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.child.stdin.end()
    setTimeout(() => this.child.kill(), 250).unref()
  }
}
