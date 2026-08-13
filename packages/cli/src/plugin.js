import { SidecarClient } from "./sidecar-client.js"
import { fallbackPreTool } from "./fallback-policy.js"
import { fileURLToPath } from "node:url"
import { safeJson } from "./redact.js"

const REPAIR = "IRONLAW_REPAIR:v1"
const enforcement = process.env.IRONLAW_MODE === "enforcer"

export default async function IronLawPlugin(ctx) {
  let sidecar
  try { sidecar = await SidecarClient.spawn({ directory: ctx.directory, parentPid: process.pid, root: fileURLToPath(new URL("../", import.meta.url)) }) }
  catch (error) {
    if (process.env.IRONLAW_REQUIRE_SIDECAR === "1") throw error
    sidecar = null
    console.error("IronLaw degraded: evidence service unavailable; completion cannot be verified.")
  }
  const notify = (method, params) => sidecar?.enqueue(method, params)

  return {
    "chat.message": async (input, output) => {
      const parts = output.parts ?? []
      if (parts.some(part => part.type === "text" && String(part.text).includes(REPAIR))) return
      notify("session.event", safeJson({ type: "chat.message", input, parts }))
    },
    "experimental.chat.system.transform": async (input, output) => {
      if (!enforcement) return
      const anchor = await sidecar?.request("anchor.get", input, 20)
      if (anchor?.text) output.system.push(anchor.text)
    },
    "tool.execute.before": async (input, output) => {
      if (!enforcement) return
      const fallback = fallbackPreTool(input.tool, output.args, ctx.directory)
      if (fallback.block) throw new Error(fallback.reason)
      const decision = await sidecar?.request("policy.pre_tool", safeJson({ input, args: output.args }), 25)
      if (decision?.ok === false && sidecar?.degraded) console.error("IronLaw degraded: evidence service unavailable; completion cannot be verified.")
      if (decision?.verdict === "block") throw new Error(decision.reason)
    },
    "tool.execute.after": async (input, output) => notify("session.event", safeJson({ type: "tool.after", input, output })),
    "experimental.session.compacting": async (input, output) => {
      if (!enforcement) return
      const capsule = await sidecar?.request("task.capsule", input, 50)
      if (capsule?.text) output.context.push(capsule.text)
    },
    event: async ({ event }) => {
      notify("session.event", safeJson({ type: "opencode.event", event, sessionID: event.properties?.sessionID }))
      if (!enforcement || event.type !== "session.idle" || !sidecar || sidecar.degraded) return
      const sessionID = event.properties?.sessionID
      const audit = await sidecar.request("completion.audit", { sessionID }, 30_000)
      if (audit?.verdict !== "repair" || !audit.repairPrompt) return
      try {
        await ctx.client.session.promptAsync({ path: { id: sessionID }, body: { parts: [{ type: "text", text: audit.repairPrompt }] } })
      } catch { notify("session.event", { type: "repair.prompt.failed", sessionID }) }
    },
    dispose: async () => sidecar?.close(),
  }
}

export { IronLawPlugin }
