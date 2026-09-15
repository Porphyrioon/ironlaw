import { accessSync, constants, statSync } from 'node:fs'
import { objectVersionDigest } from './fingerprint.js'

/** Shell tools whose command text can name a file they wrote. */
export const SHELL_TOOL = /^(?:pwsh|powershell|bash|sh|dash|zsh|ksh|fish|csh|tcsh|cmd)$/i

/**
 * Paths a shell command writes to. A shell-mediated edit leaves no diff meta, so it was both
 * outside the object scope and unable to answer a docs request. Only explicit write constructs
 * count, and every candidate is later required to be a host-readable regular file, so a path a
 * command merely prints cannot become a write. A redirect operator inside a quoted string is
 * data, not syntax (`Write-Output '> /tmp/README.md'` writes nothing), while the target of a
 * real redirect may itself be quoted (`printf x > "/abs/README.md"`).
 */
export function shellWriteTargets(command: string): string[] {
  const out = new Set<string>()
  for (const target of redirectTargets(command)) out.add(target)
  const unquoted = stripQuoted(command)
  const clean = (token: string): string => token.replace(/^["']+|["']+$/g, '')
  for (const m of unquoted.matchAll(/\b(?:tee|Set-Content|Add-Content|Out-File)\b([^\n;&|]*)/gi))
    for (const token of m[1].trim().split(/\s+/)) {
      const target = clean(token)
      if (target && !target.startsWith('-')) out.add(target)
    }
  for (const m of unquoted.matchAll(/\bsed\b[^\n;&|]*?\s-i\S*\s+([^\n;&|]*)/gi)) {
    const operands = m[1].trim().split(/\s+/).map(clean).filter(t => t && !t.startsWith('-'))
    const target = operands.at(-1)
    if (target) out.add(target)
  }
  return [...out]
}

/**
 * Redirect targets (`>`, `>>`) of a command, read with shell quoting in mind: an operator
 * inside quotes is text, an unquoted one takes the next token, which may be quoted.
 */
function redirectTargets(command: string): string[] {
  const out: string[] = []
  let quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === null && ch === '\\') { i++; continue }
    if (quote === null && (ch === '"' || ch === "'")) { quote = ch; continue }
    if (quote !== null) { if (ch === quote) quote = null; continue }
    if (ch !== '>') continue
    if (i > 0 && command[i - 1] === '&') continue        // `&>` and `2>&1` are not write targets
    let j = i + 1
    if (command[j] === '>') j++                          // append
    while (command[j] === ' ' || command[j] === '\t') j++
    if (command[j] === '&') continue                     // `>&1`
    if (command[j] === '"' || command[j] === "'") {
      const closing = command[j]
      const end = command.indexOf(closing, j + 1)
      if (end === -1) continue
      out.push(command.slice(j + 1, end))
      i = end
      continue
    }
    const start = j
    while (j < command.length && !/[\s;&|<>]/.test(command[j])) j++
    out.push(command.slice(start, j))
    i = j - 1
  }
  return out.map(t => t.replace(/^["']+|["']+$/g, '')).filter(t => t && !/^&\d*$/.test(t))
}

/**
 * Drop quoted spans before reading a command for shell syntax. `Write-Output '> /tmp/README.md'`
 * prints text; the `>` is data, not a redirection, and treating it as one let a printed string
 * stand in for a document write. Quote tracking follows shell rules closely enough for this
 * purpose: a backslash escapes the next character outside single quotes.
 */
function stripQuoted(command: string): string {
  let out = '', quote: string | null = null
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote === null) {
      if (ch === '\\') { out += '  '; i++; continue }
      if (ch === '"' || ch === "'") { quote = ch; out += ' '; continue }
      out += ch
      continue
    }
    if (ch === quote) { quote = null; out += ' '; continue }
    out += ' '
  }
  return out
}

/** Host-readable regular files among the candidates: directories and unreadable paths are not artifacts. */
export function readableRegularFiles(paths: string[]): string[] {
  const out: string[] = []
  for (const path of paths) {
    if (typeof path !== 'string' || !path.trim()) continue
    try {
      if (!statSync(path).isFile()) continue
      accessSync(path, constants.R_OK)
      out.push(path)
    } catch { /* missing, a directory, or unreadable: not an object */ }
  }
  return out
}

/**
 * The object version as it is **right now**, for the files this session has touched. Called
 * when a tool result is captured, so a proof attests the version that existed when the tool
 * ran. Empty string when no candidate is a readable regular file: the caller must then treat
 * the object version as unknown rather than assume the current one.
 */
export function snapshotObjectVersion(paths: Iterable<string>): string {
  const files = readableRegularFiles([...paths])
  if (!files.length) return ''
  try { return objectVersionDigest(files) } catch { return '' }
}

/**
 * Path-like arguments a tool call names, plus the write targets of a shell command. Used both
 * to choose the object scope and to know, at capture time, which files a result should be
 * pinned to.
 */
export function touchedPathsOf(toolName: string, args: unknown): string[] {
  const out: string[] = []
  let parsed: any = args
  if (typeof args === 'string') { try { parsed = JSON.parse(args) } catch { parsed = undefined } }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
    for (const key of ['path', 'file_path', 'filePath', 'target', 'filename', 'file', 'notebook_path'])
      if (typeof parsed[key] === 'string') out.push(parsed[key])
  if (SHELL_TOOL.test(toolName)) {
    const command = typeof parsed === 'string' ? parsed
      : parsed && typeof parsed === 'object'
        ? ['command', 'cmd', 'script', 'shell', 'code', 'commands', 'input']
          .map(k => (parsed as any)[k]).find(v => typeof v === 'string') ?? ''
        : ''
    if (command) out.push(...shellWriteTargets(command))
  }
  return out
}
