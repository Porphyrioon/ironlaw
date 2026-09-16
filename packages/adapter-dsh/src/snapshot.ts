import { accessSync, constants, statSync } from 'node:fs'
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
 * One lexical unit of a command: a word (with its value already unescaped and unquoted, and a
 * flag saying whether quoting was involved) or an operator. Keeping the value instead of
 * blanking quoted spans is what lets a quoted path still be recognised as a path while a `>`
 * inside quotes stops being an operator.
 */
export interface ShellToken { value: string; quoted: boolean; operator: string | null }

const OPERATORS = ['>>', '&&', '||', '>', '|', ';', '\n']

/**
 * Split a command into tokens using one dialect's rules. Escaping is dialect-specific: POSIX
 * uses `\`, PowerShell uses a backtick, so `` Write-Output `> path `` prints text while
 * `Write-Output \> path` does not. A doubled quote inside a quoted string is a literal quote
 * in both shells.
 */
export function tokenizeShell(command: string, dialect: ShellDialect): ShellToken[] {
  const escape = dialect === 'powershell' ? '`' : '\\'
  const tokens: ShellToken[] = []
  let value = '', quoted = false, inWord = false
  const flush = (): void => {
    if (!inWord) return
    tokens.push({ value, quoted, operator: null })
    value = ''; quoted = false; inWord = false
  }
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
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
    if (operator) { flush(); tokens.push({ value: operator, quoted: false, operator }); i += operator.length - 1; continue }
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
