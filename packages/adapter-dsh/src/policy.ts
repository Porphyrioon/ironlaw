/**
 * IronLaw destructive-action policy (parameter-level).
 *
 * The guard inspects the tool name AND its arguments, so ordinary shell
 * commands (pwd, npm test, build) pass while genuinely destructive commands
 * (rm -rf, format, disk overwrite) and sensitive-path writes are denied.
 * A whole-tool-name block would break DSH Code Mode and normal scripting.
 */

const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r|-rf|-fr)\b/,
  /\brm\s+-[a-z]*r\b/,
  /\bdel\s+\/[sf]\b/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+(-[a-z]*d[a-z]*f|-[a-z]*f[a-z]*d)\b/,
  />\s*\/dev\/(sd|hd|nvme|md)/,
]

const DANGEROUS_PATH_PATTERNS: RegExp[] = [
  /(^|[\\/])\.ssh[\\/]/,
  /(^|[\\/])\.gnupg[\\/]/,
  /(^|[\\/])\.aws[\\/](credentials|config)/,
  /\.env($|[\\/."])/,
  /(^|[\\/])id_rsa($|[\\/."])/,
  /(^|[\\/])\.git[\\/](config|credentials)/,
  /(^|[\\/])\.npmrc($|[\\/."])/,
  /(^|[\\/])\.netrc($|[\\/."])/,
]

const SHELL_TOOLS = /^(pwsh|bash|shell|terminal|run_code|exec)$/
const FILE_WRITE_TOOLS = /^(write|edit|str_replace_editor|fs_write|fs_edit|fs_replace|fs_create|create_file|patch)/

export function destructiveReason(name: string, args: unknown): string | undefined {
  const argStr = typeof args === 'string' ? args : JSON.stringify(args ?? {})

  if (SHELL_TOOLS.test(name)) {
    for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
      if (pattern.test(argStr)) return `dangerous command blocked (${pattern.source})`
    }
    return undefined
  }

  if (FILE_WRITE_TOOLS.test(name)) {
    for (const pattern of DANGEROUS_PATH_PATTERNS) {
      if (pattern.test(argStr)) return `dangerous path blocked (${pattern.source})`
    }
    return undefined
  }

  return undefined
}
