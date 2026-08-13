import path from "node:path"

const destructive = /(?:rm\s+[-\w]*r|rmdir\s+\/s|del\s+\/s|remove-item[^\r\n]*-recurse|format\s+|git\s+reset\s+--hard|git\s+clean\s+-f)/i

export function fallbackPreTool(tool, args, directory) {
  const text = typeof args === "string" ? args : String(args?.command ?? args?.cmd ?? JSON.stringify(args ?? ""))
  if (!/shell|command|terminal|bash|powershell|cmd/i.test(tool)) return { block: false }
  if (!destructive.test(text)) return { block: false }

  const cwd = path.resolve(directory)
  const hasOutsidePath = [...text.matchAll(/(?:[A-Za-z]:[\\/][^\s"']+|\.\.?[\\/][^\s"']+)/g)]
    .some(([match]) => {
      const target = path.resolve(cwd, match.replace(/^['"]|['"]$/g, ""))
    return target === cwd || (!target.startsWith(`${cwd}${path.sep}`) && target !== cwd)
    })
  if (hasOutsidePath || destructive.test(text)) return { block: true, reason: "IronLaw blocked a destructive operation; review it explicitly outside the agent." }
  return { block: true, reason: "IronLaw blocked a destructive operation pending explicit review." }
}
