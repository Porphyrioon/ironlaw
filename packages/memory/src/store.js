import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { bm25Search } from "./search.js"
import { sanitizeMemory } from "./redact.js"

const SCOPES = new Set(["session", "user"])

function assertScope(scope) {
  if (!SCOPES.has(scope)) throw new Error(`invalid scope: ${scope}`)
}

// Encode any non [\w.-] character as _<hex>, so keys like "a/b" and "a?b" map
// to distinct files instead of colliding on the same sanitized name.
function safeKey(key) {
  const encoded = String(key).replace(/[^\w.-]/g, c => `_${c.charCodeAt(0).toString(16)}`)
  return encoded.slice(0, 200) || "untitled"
}

function nodeFile(root, scope, key) {
  assertScope(scope)
  return path.join(root, scope, `${safeKey(key)}.json`)
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" })
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || "").trim()}`)
  return (r.stdout || "").trim()
}

// First commit must not depend on a global identity; fall back to a local one.
function ensureGitIdentity(root) {
  const name = spawnSync("git", ["config", "--get", "user.name"], { cwd: root, encoding: "utf8" })
  if (name.status === 0 && name.stdout.trim()) return
  git(root, ["config", "user.name", "ironlaw"])
  git(root, ["config", "user.email", "ironlaw@local"])
}

export function init(root, remoteUrl) {
  fs.mkdirSync(root, { recursive: true })
  for (const s of SCOPES) fs.mkdirSync(path.join(root, s), { recursive: true })
  if (!fs.existsSync(path.join(root, ".git"))) {
    git(root, ["init", "-q"])
    ensureGitIdentity(root)
    if (remoteUrl) git(root, ["remote", "add", "origin", remoteUrl])
    // ensure HEAD exists so the repo can be pushed before any write
    const head = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, encoding: "utf8" })
    if (head.status !== 0) git(root, ["commit", "--allow-empty", "-q", "-m", "init: @ironlaw/memory store"])
  }
  return root
}

export function write(root, { key, value, scope = "user", tags = [], ttl_seconds = null, source = null }) {
  assertScope(scope)
  // Session-scoped nodes default to a 24h TTL so they don't linger forever.
  const effectiveTtl = ttl_seconds ?? (scope === "session" ? 86400 : null)
  const node = {
    key,
    value: sanitizeMemory(value),
    scope,
    tags: (tags || []).map(t => sanitizeMemory(String(t))),
    ttl_seconds: effectiveTtl,
    source: source ? sanitizeMemory(String(source)) : null,
    updated_ts: Math.floor(Date.now() / 1000),
  }
  const file = nodeFile(root, scope, key)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(node, null, 2) + "\n")
  // Only user-scoped nodes enter git history; session nodes stay ephemeral.
  if (scope === "user") gitCommit(root, "memory.write")
  return node
}

export function read(root, key, scope = "user") {
  const file = nodeFile(root, scope, key)
  if (!fs.existsSync(file)) return null
  const node = JSON.parse(fs.readFileSync(file, "utf8"))
  if (expired(node)) { fs.unlinkSync(file); return null }
  return node
}

export function forget(root, key, scope = "user") {
  const file = nodeFile(root, scope, key)
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  if (scope === "user") gitCommit(root, "memory.forget")
  return true
}

export function list(root, scope = "user", source = null) {
  assertScope(scope)
  const dir = path.join(root, scope)
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
    .filter(n => !expired(n))
    .filter(n => source ? n.source === source : true)
    .sort((a, b) => b.updated_ts - a.updated_ts)
}

function expired(node) {
  if (!node.ttl_seconds) return false
  return Date.now() / 1000 - node.updated_ts > node.ttl_seconds
}

function textOf(node) {
  const v = node.value
  if (typeof v === "string") return v
  return `${JSON.stringify(v)} ${(node.tags || []).join(" ")}`
}

export function search(root, query, scope = "user", limit = 10, source = null) {
  const docs = list(root, scope, source).map(n => ({ key: n.key, value: n.value, tags: n.tags, scope: n.scope, source: n.source, updated_ts: n.updated_ts, text: textOf(n) }))
  return bm25Search(docs, query, limit)
}

export function gitCommit(root, message) {
  git(root, ["add", "-A"])
  const r = spawnSync("git", ["diff", "--cached", "--quiet"], { cwd: root, encoding: "utf8" })
  if (r.status === 0) return false
  git(root, ["commit", "-q", "-m", message])
  return true
}

export function sync(root, direction = "push") {
  // -u origin HEAD sets upstream on first push so later syncs just work.
  if (direction === "push") return git(root, ["push", "-q", "-u", "origin", "HEAD"])
  if (direction === "pull") return git(root, ["pull", "-q", "--rebase"])
  throw new Error(`unknown sync direction: ${direction}`)
}
