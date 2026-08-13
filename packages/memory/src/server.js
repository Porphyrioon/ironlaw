#!/usr/bin/env node
import os from "node:os"
import path from "node:path"
import readline from "node:readline"
import { init, write, read, forget, search, sync } from "./store.js"
import { formatInjection } from "./aci.js"

const root = process.env.IRONLAW_MEMORY_ROOT || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache"), "ironlaw-memory")
const remote = process.env.IRONLAW_MEMORY_REMOTE || null
const source = process.env.IRONLAW_MEMORY_SOURCE || null
init(root, remote)

const TOOLS = [
  {
    name: "memory_write",
    description: "Write a node into the Memory Graph. Value is redacted before it is stored.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Node key (slug)." },
        value: { description: "Node value: text or any JSON." },
        scope: { type: "string", enum: ["session", "user"], default: "user" },
        tags: { type: "array", items: { type: "string" }, default: [] },
        ttl_seconds: { type: ["number", "null"], default: null },
      },
      required: ["key", "value"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  },
  {
    name: "memory_search",
    description: "Search the Memory Graph. Returns nodes ranked by relevance.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        scope: { type: "string", enum: ["session", "user"], default: "user" },
        limit: { type: "number", default: 10 },
        source: { type: "string", description: "Filter by source host. Omit to search all." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "memory_forget",
    description: "Remove a node from the Memory Graph.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        scope: { type: "string", enum: ["session", "user"], default: "user" },
      },
      required: ["key"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "memory_recall",
    description: "Read a single node by key.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string" },
        scope: { type: "string", enum: ["session", "user"], default: "user" },
      },
      required: ["key"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "memory_inject",
    description: "ACI: return a formatted memory block for the current task, to inject into context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Current task or question." },
        scope: { type: "string", enum: ["session", "user"], default: "user" },
        limit: { type: "number", default: 5 },
        source: { type: "string", description: "Filter by source host. Omit to search all." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "memory_sync",
    description: "Sync the git-backed store with its remote.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["push", "pull"], default: "push" },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
]

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`)
}

// This is a legacy MCP server (initialize/tools/list/tools/call over stdio).
// It accepts the legacy protocol line (2024-10-07 through 2025-06-18) and
// rejects 2026-07-28 modern (server/discover + per-request metadata) and any
// unknown/fictional version rather than echoing it as if supported.
const LEGACY_PROTOCOL_VERSIONS = new Set(["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18"])

function callTool(name, args) {
  switch (name) {
    case "memory_write": return write(root, { ...args, source: args.source ?? source })
    case "memory_search": return search(root, args.query, args.scope ?? "user", args.limit ?? 10, args.source ?? null)
    case "memory_forget": return { forgotten: forget(root, args.key, args.scope ?? "user") }
    case "memory_recall": return read(root, args.key, args.scope ?? "user")
    case "memory_inject": return { injection: formatInjection(args.query, search(root, args.query, args.scope ?? "user", args.limit ?? 5, args.source ?? null)) }
    case "memory_sync": return { result: sync(root, args.direction ?? "push") }
    default: throw new Error(`unknown tool: ${name}`)
  }
}

function handle(msg) {
  if (!msg || typeof msg !== "object") return
  const { id, method, params } = msg
  if (method === "initialize") {
    // Legacy MCP implementation: initialize/tools/list/tools/call over stdio
    // (protocol 2024-10-07 / 2024-11-05). We do NOT implement the 2026-07-28
    // modern transport (server/discover + per-request metadata), so we must
    // not echo an arbitrary client protocolVersion as if we supported it.
    const requested = params?.protocolVersion || "2024-11-05"
    if (!LEGACY_PROTOCOL_VERSIONS.has(requested)) {
      return respondError(id, -32600, `unsupported protocolVersion "${requested}"; this server speaks legacy MCP (${[...LEGACY_PROTOCOL_VERSIONS].join(", ")}) over stdio`)
    }
    return respond(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: "@ironlaw/memory", version: "0.1.0" },
    })
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return
  if (method === "ping") return respond(id, {})
  if (method === "tools/list") return respond(id, { tools: TOOLS })
  if (method === "tools/call") {
    try {
      const result = callTool(params?.name, params?.arguments || {})
      return respond(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] })
    } catch (error) {
      return respond(id, { content: [{ type: "text", text: `error: ${error.message}` }], isError: true })
    }
  }
  return respondError(id, -32601, `method not found: ${method}`)
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
rl.on("line", line => {
  try { handle(JSON.parse(line)) } catch { /* ignore malformed line */ }
})
