import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { objectVersionDigest } from './fingerprint.js'

/** Shell tools whose command text can name a file they wrote. */
export const SHELL_TOOL = /^(?:pwsh|powershell|bash|sh|dash|zsh|ksh|fish|csh|tcsh|cmd)$/i

/** Which shell's quoting and escaping rules apply to a command's text. */
export type ShellDialect = 'posix' | 'powershell'

/** The dialect a tool name implies; anything unrecognized is read as POSIX (the stricter one). */
export function dialectOfTool(toolName: unknown): ShellDialect {
  return typeof toolName === 'string' && /^(?:pwsh|powershell)$/i.test(toolName) ? 'powershell' : 'posix'
}

/**
 * One lexical unit of a command: a word (value already unescaped and unquoted, plus whether
 * quoting was involved) or an operator. `command` marks the word as sitting in command position
 * — the head of a segment rather than one of its arguments — which is what separates a command
 * being run from its own argument text.
 */
export interface ShellToken { value: string; quoted: boolean; operator: string | null; command: boolean }

const OPERATORS = ['>>', '&&', '||', '>', '|', ';', '\n', '&']

/**
 * Split a command into tokens using one dialect's rules. Escaping is dialect-specific: POSIX
 * uses `\`, PowerShell uses a backtick, so `` Write-Output `> path `` prints text while
 * `Write-Output \> path` does not. A doubled quote inside a quoted string is a literal quote in
 * both shells. `#` at the start of a word opens a comment, so a `>` written after it is text.
 */
export function tokenizeShell(command: string, dialect: ShellDialect): ShellToken[] {
  const escape = dialect === 'powershell' ? '`' : '\\'
  const tokens: ShellToken[] = []
  let value = '', quoted = false, inWord = false, commandPosition = true
  const flush = (): void => {
    if (!inWord) return
    // An environment assignment (`NODE_ENV=prod`) does not consume command position.
    const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(value)
    tokens.push({ value, quoted, operator: null, command: commandPosition && !assignment })
    if (!assignment) commandPosition = false
    value = ''; quoted = false; inWord = false
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '#' && !inWord) {
      const end = command.indexOf('\n', i)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (ch === escape) {
      const next = command[i + 1]
      if (next !== undefined) { value += next; i++ } else value += ch
      inWord = true
      continue
    }
    if (ch === '"' || ch === "'") {
      const quote = ch
      quoted = true; inWord = true
      i++
      while (i < command.length) {
        const inner = command[i]
        if (inner === quote) {
          if (command[i + 1] === quote) { value += quote; i += 2; continue }
          break
        }
        if (quote === '"' && inner === escape && command[i + 1] !== undefined) { value += command[i + 1]; i += 2; continue }
        value += inner; i++
      }
      continue
    }
    const operator = OPERATORS.find(op => command.startsWith(op, i))
    if (operator) {
      flush()
      tokens.push({ value: operator, quoted: false, operator, command: false })
      commandPosition = true
      i += operator.length - 1
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') { flush(); continue }
    value += ch; inWord = true
  }
  flush()
  return tokens
}

/** Flags whose next token is a path, for the cmdlets that take one explicitly. */
const PATH_FLAG = /^-(?:literal|file)?path$/i
/** A token that looks like a path rather than an argument value. */
const PATH_SHAPED = /[\\/]|\.[A-Za-z0-9]{1,8}$/

/**
 * Paths a shell command writes to. A shell-mediated edit leaves no diff meta, so it was both
 * outside the object scope and unable to answer a docs request. Only explicit write constructs
 * count — a redirect, `tee`, `Set-Content`/`Out-File`, `sed -i` — and every candidate is later
 * required to be a host-readable regular file, so a path a command merely prints cannot become
 * a write. Read through the dialect's own tokenizer, so a quoted target is still a target while
 * an escaped or quoted `>` is not an operator.
 */
export function shellWriteTargets(command: string, dialect: ShellDialect = 'posix'): string[] {
  const tokens = tokenizeShell(command, dialect)
  const out = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.operator === '>' || token.operator === '>>') {
      const next = tokens[i + 1]
      if (next && !next.operator && next.value && !/^&\d*$/.test(next.value)) out.add(next.value)
      continue
    }
    if (token.operator) continue
    if (!token.command) continue // only a command being run writes; its arguments do not
    const name = token.value.toLowerCase()
    if (name === 'tee' || name === 'set-content' || name === 'add-content' || name === 'out-file') {
      for (let j = i + 1; j < tokens.length && !tokens[j].operator; j++) {
        const arg = tokens[j]
        if (PATH_FLAG.test(arg.value)) {
          const path = tokens[j + 1]
          if (path && !path.operator && path.value) out.add(path.value)
          j++
          continue
        }
        if (arg.value.startsWith('-')) continue
        if (PATH_SHAPED.test(arg.value)) out.add(arg.value)
      }
      continue
    }
    if (name === 'sed') {
      let inPlace = false
      const operands: string[] = []
      for (let j = i + 1; j < tokens.length && !tokens[j].operator; j++) {
        const arg = tokens[j]
        if (/^-i/.test(arg.value)) { inPlace = true; continue }
        if (arg.value.startsWith('-')) continue
        operands.push(arg.value)
      }
      const target = operands.at(-1)
      if (inPlace && target) out.add(target)
    }
  }
  return [...out]
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
 * The same snapshot, kept **per file**: absolute path -> content hash. One aggregate digest for
 * the whole scope cannot be re-checked later, because the scope itself keeps growing — a file
 * written after a verification changed the aggregate and made a perfectly valid proof look
 * stale, turn after turn. With the per-file map the proof can be re-checked against exactly the
 * files it captured.
 */
export function snapshotObjectVersions(paths: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const file of readableRegularFiles([...paths])) {
    try {
      out[resolve(file)] = createHash('sha256').update(readFileSync(file)).digest('hex')
    } catch { /* unreadable between the check and the read: not captured */ }
  }
  return out
}

/** A stable digest of a per-file snapshot, for the record's single `object_version_digest` field. */
export function versionDigestOf(versions: Record<string, string>): string {
  const entries = Object.entries(versions).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return entries.length ? `sha256:${createHash('sha256').update(JSON.stringify(entries)).digest('hex')}` : ''
}

/**
 * True while every file the snapshot captured is still readable and byte-identical. This is the
 * question a proof actually needs answered — "do the files this run attested still look the way
 * they did when it ran?" — and it is answerable without knowing what else the session touched.
 */
export function snapshotHolds(versions: Record<string, string>): boolean {
  const entries = Object.entries(versions ?? {})
  if (!entries.length) return false
  for (const [path, hash] of entries) {
    try {
      if (!statSync(path).isFile()) return false
      accessSync(path, constants.R_OK)
      if (createHash('sha256').update(readFileSync(path)).digest('hex') !== hash) return false
    } catch { return false }
  }
  return true
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
    if (command) out.push(...shellWriteTargets(command, dialectOfTool(toolName)))
  }
  return out
}
