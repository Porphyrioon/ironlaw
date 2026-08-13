import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import readline from "node:readline"
import { safeJson, redact } from "./src/redact.js"

const args = process.argv.slice(2)
const project = path.resolve(args[args.indexOf("--project") + 1] || process.cwd())
const parentPid = Number(args[args.indexOf("--parent-pid") + 1])
const root = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "IronLaw", "opencode") : path.join(process.env.HOME || process.cwd(), ".cache", "ironlaw", "opencode")
const projectHash = crypto.createHash("sha256").update(project).digest("hex")
const dir = path.join(root, "projects", projectHash)
fs.mkdirSync(dir, { recursive: true })
const eventsPath = path.join(dir, "events.ndjson")
const statePath = path.join(dir, "state.json")
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { tasks: {} }
const save = () => fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex")
const writeEvent = (type, payload) => {
  fs.appendFileSync(eventsPath, `${JSON.stringify({ event_id: crypto.randomUUID(), type, payload: safeJson(payload), occurred_at: new Date().toISOString() })}\n`)
}
const sessionTask = sessionID => state.tasks[sessionID]
const taskFor = (sessionID, text = "") => {
  if (!state.tasks[sessionID]) state.tasks[sessionID] = { task_id: `tsk_${crypto.randomUUID().replaceAll("-", "")}`, session_id: sessionID, objective: redact(text).slice(0, 240), origin_hash: `sha256:${hash(text)}`, state: "ACTIVE", requirements: [{ id: "AC-1", text: "实现原始任务并保留真实验证证据", status: "MISSING" }], evidence: [], repair_count: 0, created_at: new Date().toISOString() }
  return state.tasks[sessionID]
}
function response(id, result, ok = true) { process.stdout.write(`${JSON.stringify({ id, ok, result })}\n`) }
function audit(sessionID) {
  const task = sessionTask(sessionID)
  if (!task) return { verdict: "recorded" }
  // A tool result is evidence, not completion. Independent verification is not wired
  // until the real OpenCode session probe can supply command and workspace facts.
  const valid = task.evidence.some(item => item.kind === "independent.verification" && item.status === "VALID")
  if (valid) { task.state = "VERIFIED"; writeEvent("decision", { sessionID, verdict: "verified" }); save(); return { verdict: "verified" } }
  if (task.repair_count >= 2) { task.state = "FAILED_UNVERIFIED"; save(); return { verdict: "failed_unverified" } }
  task.state = "REPAIR_REQUIRED"; task.repair_count += 1; save()
  return { verdict: "repair", repairPrompt: `[${"IRONLAW_REPAIR:v1"} attempt=${task.repair_count}]\n当前不能结束任务：缺少真实工具执行结果或退出码证据。请只完成验证并报告未执行的检查，不得把自报结果描述为已通过。` }
}
async function handle(message) {
  const { id, method, params = {} } = message
  if (method === "handshake") return response(id, { ok: true, adapter: "stable-v1", required: ["chat.message", "tool.execute.before", "tool.execute.after", "event"] })
  if (method === "heartbeat") { writeEvent("heartbeat", params); return response(id, { ok: true, pid: process.pid }) }
  const sessionID = params.sessionID || params.event?.properties?.sessionID || params.input?.sessionID || params.input?.input?.sessionID
  if (method === "session.event") {
    const text = params.parts?.map(part => part.text || "").join(" ") || ""
    const task = taskFor(sessionID || "unknown", text)
    if (params.type === "tool.after") task.evidence.push({ kind: "tool.after", exit_code: params.output?.metadata?.exitCode ?? null, created_at: new Date().toISOString() })
    writeEvent(params.type, params); save(); return response(id, { verdict: "recorded" })
  }
  if (method === "policy.pre_tool") return response(id, { verdict: "allow" })
  if (method === "anchor.get" || method === "task.capsule") {
    const task = sessionTask(sessionID)
    return response(id, task ? { text: `[IronLaw task anchor]\nObjective: ${task.objective}\nCompletion rule: only valid execution evidence can mark VERIFIED.` } : {})
  }
  if (method === "completion.audit") return response(id, audit(params.sessionID))
  return response(id, {}, false)
}
const input = readline.createInterface({ input: process.stdin })
input.on("line", line => { try { void handle(JSON.parse(line)) } catch { /* ignore malformed IPC */ } })
process.on("SIGTERM", () => process.exit(0))
if (parentPid > 0) {
  const watchdog = setInterval(() => {
    try { process.kill(parentPid, 0) }
    catch { clearInterval(watchdog); process.exit(0) }
  }, 1000)
  watchdog.unref()
}
