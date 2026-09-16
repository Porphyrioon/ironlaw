import { createHash } from 'node:crypto'
import type { EvidenceLedger, EvidenceRecord } from './evidence.js'
import { objectVersionDigest } from './fingerprint.js'
import { classifyTaskType, isTaskType, hostReadable, type TaskType } from './classify.js'
import { contentDigest, objectDigest } from './contract.js'
import { SHELL_TOOL, readableRegularFiles, shellWriteTargets, snapshotHolds } from './snapshot.js'
import type { AuditInput, Candidate, HardConstraintCheck, Requirement, Status, TaskContract, Verification } from './audit.js'

/**
 * Trusted host integration boundary. Assembles the audit input from durable host
 * events only — never from the candidate body or any model/summary self-report.
 *
 * Safety invariants (hard):
 * - A record whose `source_kind` is `model`/`summary` is never promoted to
 *   `host_verifier` proof.
 * - Without trusted host evidence the resolver stays `unknown`/incomplete; it
 *   never manufactures a passing verdict.
 * - Evidence requirements are not weakened to "make it pass".
 */
export interface ResolveAuditContext {
  session_id: string
  turn: number
  task: TaskContract
  response: string
  records: EvidenceRecord[]
  recovery: ReturnType<EvidenceLedger['recover']>
}

const COLLECTOR_VERSION = 'ironlaw/2.0-p2'
const sha256 = (v: unknown): string => `sha256:${createHash('sha256').update(JSON.stringify(v)).digest('hex')}`
const dataOf = (r: EvidenceRecord | undefined): any => (r?.payload as any)?.data ?? {}

/** Re-derive the assistant body from the durable record, mirroring the host capture in index.ts. */
function assistantText(payload: unknown): string {
  const content = (payload as any)?.data?.message?.content
  return (Array.isArray(content) ? content : [])
    .filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
}

/** A model/summary-sourced record is self-report, never host proof. */
function modelSourced(r: EvidenceRecord | undefined): boolean {
  return r?.source_kind === 'model' || r?.source_kind === 'summary'
}

/** Lowercase basename: no directory part, no trailing separator, POSIX or Win32. */
function baseName(path: string): string {
  const s = path.replace(/\\/g, '/').trim().replace(/\/+$/, '')
  const i = s.lastIndexOf('/')
  return (i >= 0 ? s.slice(i + 1) : s).toLowerCase()
}
/** A basename with its extension removed, so `README` and `README.md` compare equal. */
const stemOf = (base: string): string => base.replace(/\.[^.]+$/, '')
/** Forward slashes and lowercase, the form every path comparison here uses. */
const slashOf = (path: string): string => path.replace(/\\/g, '/').toLowerCase()

/**
 * Does a prohibition cover a target the request names? Deliberately permissive — the normalized
 * path or the basename — because this decides only which objects are kept OUT of the deliverable
 * list: a path the human forbade changing must not also be demanded as a document, and
 * over-matching here removes a requirement instead of inventing a violation. Violation detection
 * is the stricter {@link breaksProhibition}, and the two are deliberately different questions.
 */
export function prohibitionCoversTarget(prohibition: string, target: string): boolean {
  const na = slashOf(prohibition).replace(/\/+$/, ''), nb = slashOf(target).replace(/\/+$/, '')
  if (!na || !nb) return false
  return na === nb || baseName(na) === baseName(nb)
}

/**
 * Does an observed write break this prohibition? Stricter than the deliverable filter, because a
 * false match here says the agent violated a constraint it never touched:
 *
 * - A prohibition carrying directory components is matched as a path suffix at a segment
 *   boundary, so `config/app.yml` does not match `other/app.yml`. Basename-only matching reported
 *   exactly that violation for a file in a different directory.
 * - A prohibition ending in a separator names a directory: anything under it matches.
 * - A bare name (`protected.txt`, `README`) leaves only the basename to compare, and the check
 *   reference records that as the basis of the verdict.
 */
function breaksProhibition(scope: string, written: string): boolean {
  const raw = slashOf(scope), na = raw.replace(/\/+$/, ''), nb = slashOf(written)
  if (!na || !nb) return false
  if (raw.endsWith('/') && nb.startsWith(raw)) return true
  if (nb === na) return true
  if (/[\\/]/.test(scope)) return nb.endsWith(`/${na}`)
  return baseName(nb) === na
}

/** The first observed write that breaks this prohibition, if any. */
function violatingWrite(scope: string, written: string[]): string | undefined {
  return written.find(p => breaksProhibition(scope, p))
}

/** Shell tools whose command text can name a file they wrote. */
/**
 * Affected paths: DSH diff metas (mutations report `card:'diff'` with `diffs[].path`),
 * `meta.locations`, plus the path-like arguments of any tool call. Reads and searches are
 * collected too — the arguments are not filtered by tool name — so the list may contain
 * directories and paths that are not artifacts. Only host-readable *regular files* are
 * allowed to enter the object scope below; anything else would throw while hashing.
 */
function affectedPaths(records: EvidenceRecord[]): string[] {
  const paths = new Set<string>()
  for (const r of records) {
    const data = dataOf(r), meta = data.meta
    if (meta && typeof meta === 'object') {
      if (meta.card === 'diff' && Array.isArray(meta.diffs))
        for (const d of meta.diffs) if (typeof d?.path === 'string') paths.add(d.path)
      if (Array.isArray(meta.locations))
        for (const l of meta.locations) if (typeof l?.path === 'string') paths.add(l.path)
    }
    if (r.type === 'tool.call' && typeof data.arguments === 'string') {
      try {
        const args = JSON.parse(data.arguments)
        for (const k of ['path', 'file_path', 'filePath', 'target', 'filename', 'file'])
          if (typeof args?.[k] === 'string') paths.add(args[k])
      } catch { /* unparsed arguments carry no reliable path */ }
    }
    if (r.type === 'tool.call' && SHELL_TOOL.test(typeof data.name === 'string' ? data.name : ''))
      for (const target of shellWriteTargets(commandText(data), dialectOf(data.name))) paths.add(target)
  }
  return [...paths]
}

/**
 * Real digest over the affected host-readable files (includes uncommitted bytes). An empty
 * scope — or one where no path is an openable regular file — reports empty rather than
 * guessing; a directory or unreadable path is dropped per-path instead of collapsing the
 * whole digest, which previously turned every acceptance item into `evidence_stale`.
 */
function computeObjectDigest(records: EvidenceRecord[]): string {
  const paths = affectedPaths(records).filter(hostReadable)
  if (!paths.length) return ''
  try { return objectVersionDigest(paths) } catch { return '' }
}

/** Environment descriptor from observable host facts; non-empty for any real session. */
function computeEnvironmentDigest(ctx: ResolveAuditContext): string {
  const header = ctx.records.filter(r => r.type === 'session.request/header').at(-1)
  return sha256({ host: 'dsh', session_id: ctx.session_id, collector_version: COLLECTOR_VERSION,
    request: dataOf(header)?.header?.config ?? null })
}

/** Trusted host confirms applicability: `unknown` → `applicable`; authorized exclusions are left untouched. */
function withConfirmedApplicability(task: TaskContract): TaskContract {
  return { ...task, requirements: task.requirements.map(r =>
    r.applicability === 'unknown' ? { ...r, applicability: 'applicable' as const } : r) }
}

/** Pull the shell command string out of a tool call's arguments (string, or object/array under a common key). */
function commandText(callData: any): string {
  const raw = callData?.arguments
  let parsed: any = raw
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw) } catch { parsed = raw } }
  if (typeof parsed === 'string') return parsed
  if (parsed && typeof parsed === 'object') {
    for (const k of ['command', 'cmd', 'script', 'shell', 'code', 'commands', 'input']) {
      const v = parsed[k]
      if (typeof v === 'string') return v
      if (Array.isArray(v)) return v.filter((x: any) => typeof x === 'string').join(' && ')
    }
  }
  return ''
}

/**
 * Shell control operators, longest-first so `&&`/`||` are not split into `&`/`|`. A single `&`
 * is a connector too: it backgrounds what precedes it, so the host's exit code reports that the
 * launch succeeded, not that the command finished. `>&` and `&1` are redirections, not
 * backgrounding, and are left alone.
 */
const SHELL_OPS = /(?:&&|\|\||[;|\n]|(?<!>)&(?![&\d<>]))/g
/** Shell dialect, decided by the tool that ran the command. */
type ShellDialect = 'posix' | 'powershell'
/** PowerShell tool names; every other name is read as POSIX. */
const POWERSHELL_TOOL = /^(?:pwsh|powershell)$/i
/**
 * Dialect of the paired tool call. Unrecognized and missing names fall back to POSIX,
 * whose masking set is the larger one, so an unknown shell never gets the looser
 * PowerShell reading.
 */
function dialectOf(toolName: unknown): ShellDialect {
  return typeof toolName === 'string' && POWERSHELL_TOOL.test(toolName.trim()) ? 'powershell' : 'posix'
}
/**
 * Connectors after which a later segment's exit code wins, so the aggregate exit the
 * host reports no longer reflects the verifier: `||` (successor runs on failure and
 * its exit wins), `;` and newline (successor always runs and its exit wins).
 *
 * The dialects differ exactly on `|`. A POSIX pipeline exits with its last element, so
 * `|` masks. PowerShell pipes objects between commands and the host records the
 * subprocess exit code, which a pipe to a cmdlet leaves intact; measured on Windows
 * PowerShell 5.1, `cmd /c exit 3 | Select-Object -Last 1` and `cmd /c exit 3 | cat`
 * both still report the failure, while `cmd /c exit 3; Write-Host hi` reports success
 * (`;` masks there even when the successor is only a cmdlet). So `|` is masking for
 * POSIX only, and `;` masks in both.
 *
 * `&&` is absent from both: a failure short-circuits and propagates. `2>&1` is a
 * redirection, not a connector, and SHELL_OPS never splits on it. A single `&` masks in both
 * dialects: it backgrounds the command, so the recorded exit code is the launch's, not the
 * operation's, and an exit 0 there says nothing about whether the work finished.
 */
const MASKING_CONN: Record<ShellDialect, ReadonlySet<string>> = {
  posix: new Set(['||', ';', '|', '\n', '&']),
  powershell: new Set([';', '||', '\n', '&']),
}
/** Split a command line into segments and the connector that joins each pair. */
function splitShellSegments(cmd: string): { segs: string[]; conns: string[] } {
  const segs: string[] = [], conns: string[] = []
  const re = new RegExp(SHELL_OPS.source, 'g')
  let last = 0, m: RegExpExecArray | null
  while ((m = re.exec(cmd)) !== null) { segs.push(cmd.slice(last, m.index)); conns.push(m[0]); last = m.index + m[0].length }
  segs.push(cmd.slice(last))
  return { segs, conns }
}
/** Leading wrappers that do not change which program ultimately runs. */
const LEAD_STRIP = /^(?:sudo\s+|command\s+|npx\s+|pnpm\s+dlx\s+|yarn\s+dlx\s+|\.\.?\/|[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/
/**
 * Verification-class invocations, anchored at a segment's program verb. A bare
 * `test`/`build`/`check` word is NOT matched (only as a runner subcommand), so
 * `cat test.js` or `echo "npm test"` never classify. The set is deliberately
 * conservative: an unlisted or ambiguous verb fails closed (not verification).
 */
const VERIFIER_PATTERNS: RegExp[] = [
  /^(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|type-check|check|tsc)(?:[\s:]|$)/,
  /^node\s+(?:\S+\s+)*--test(?:\s|$)/,
  /^deno\s+(?:test|check|lint|fmt)(?:\s|$)/,
  /^(?:pytest|jest|vitest|mocha|ava|tape|cypress|playwright|karma|jasmine|codecept|phpunit|rspec|rubocop|ctest|tox|nox)(?:\s|$)/,
  /^(?:tsc|eslint|stylelint|biome|tslint|golangci-lint)(?:\s|$)/,
  /^(?:mypy|pyright|ruff|flake8|pylint|bandit)(?:\s|$)/,
  /^(?:prettier|black|isort)\s+(?:\S+\s+)*--check\b/,
  /^go\s+(?:test|vet|build)(?:\s|$)/,
  /^cargo\s+(?:test|build|clippy|check|fmt)(?:\s|$)/,
  /^make\s+(?:test|check|lint|build|verify)(?:\s|$)/,
  /^mvn\s+(?:test|verify|compile|check|validate)(?:\s|$)/,
  /^(?:gradle|gradlew)\s+(?:test|build|check|lint|verify)(?:\s|$)/,
  /^dotnet\s+(?:test|build)(?:\s|$)/,
  /^swift\s+test(?:\s|$)/,
  /^python[0-9.]*\s+(?:-m\s+)?(?:pytest|unittest|nose2?)(?:\s|$)/,
]

/**
 * True only when the command reliably runs a verification tool AND that tool's
 * exit code reaches the host's aggregate exit unmasked under the shell's own dialect.
 * Splits on shell operators and matches each segment's leading verb, so irrelevant
 * commands (echo/ls/cat/reads/prints) and unparseable commands return false (fail
 * closed). A verifier followed by a connector that masks in this dialect (or preceded
 * by `||`) can yield aggregate exit 0 despite a real failure, so it also returns
 * false. `&&` neighbours are kept: a failure short-circuits and propagates.
 */
/** A verifier asked for its own help or version runs nothing, whatever its exit code says. */
const HELP_OR_VERSION = /(?:^|\s)(?:--help|-h|--version|-V|-v)(?:=|\s|$)/

function isTrustworthyVerification(cmd: string, dialect: ShellDialect): boolean {
  if (!cmd || !cmd.trim()) return false
  const masking = MASKING_CONN[dialect]
  const { segs, conns } = splitShellSegments(cmd)
  const norm = segs.map(s => s.trim().replace(LEAD_STRIP, '').trim())
  // `npm test --help` / `--version` exit 0 without running anything: a verifier asked for its
  // own help or version is not a verification, and the exit code cannot say otherwise.
  const verifiers = norm.map((s, i) => (s && VERIFIER_PATTERNS.some(re => re.test(s)) && !HELP_OR_VERSION.test(s) ? i : -1))
    .filter(i => i >= 0)
  if (!verifiers.length) return false
  return verifiers.every(v => {
    for (let i = v; i < conns.length; i++) if (masking.has(conns[i])) return false
    return !(v > 0 && conns[v - 1] === '||')
  })
}

/** True when any connector could eat a failure in this dialect, so the aggregate exit no longer reflects the operation. */function hasMaskedExit(cmd: string, dialect: ShellDialect): boolean {
  if (!cmd || !cmd.trim()) return false
  const masking = MASKING_CONN[dialect]
  return splitShellSegments(cmd).conns.some(c => masking.has(c))
}

/**
 * One durable canonical outcome recorded by the host's `tools/result` hook. `digest` is the
 * object version as it stood when the tool ran — the fact a proof attests. It is captured, not
 * recomputed: re-deriving it at adjudication time re-bound an old passing run to whatever the
 * tree had become since, which is exactly the invalidation the digest exists to provide.
 */
interface CallOutcome { exit: number; cmd: string; digest: string; versions: Record<string, string> }

/**
 * Canonical outcomes by call id. A real DSH session puts the exit code only in the
 * execution-local result value, which never reaches the session event stream, so the
 * host hook persists it as a `tool.outcome` record. Entries without a numeric exit
 * code are dropped: an absent number is unknown, never a pass.
 */
function outcomesByCallId(ctx: ResolveAuditContext): Map<string, CallOutcome> {
  const out = new Map<string, CallOutcome>()
  for (const r of ctx.records) {
    if (r.type !== 'tool.outcome') continue
    const id = r.tool_call_id
    if (typeof id !== 'string' || !id) continue
    const exit = typeof r.exit_code === 'number' && Number.isFinite(r.exit_code) ? r.exit_code
      : typeof (r.payload as any)?.exit_code === 'number' ? (r.payload as any).exit_code : null
    if (exit === null) continue
    const cmd = (r.payload as any)?.command
    const digest = typeof r.object_version_digest === 'string' && r.object_version_digest
      ? r.object_version_digest
      : typeof (r.payload as any)?.object_version_digest === 'string' ? (r.payload as any).object_version_digest : ''
    out.set(id, { exit, cmd: typeof cmd === 'string' ? cmd : '', digest, versions: versionsOf(r) })
  }
  return out
}

/**
 * Captured object version per call id, for every tool result — including calls that carry no
 * exit code, such as a write tool: that result is still a moment at which the object version
 * was observed, and a proof about the written file must speak for that moment.
 */
function digestsByCallId(ctx: ResolveAuditContext): Map<string, string> {
  const out = new Map<string, string>()
  for (const r of ctx.records) {
    if (r.type !== 'tool.outcome') continue
    const id = r.tool_call_id
    if (typeof id !== 'string' || !id) continue
    const digest = typeof r.object_version_digest === 'string' && r.object_version_digest ? r.object_version_digest
      : typeof (r.payload as any)?.object_version_digest === 'string' ? (r.payload as any).object_version_digest : ''
    if (digest) out.set(id, digest)
  }
  return out
}

/** The per-file snapshot a `tool.outcome` captured, when the host recorded one. */
function versionsOf(record: EvidenceRecord): Record<string, string> {
  const raw = (record.payload as any)?.object_versions
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, string> = {}
  for (const [path, hash] of Object.entries(raw)) if (typeof hash === 'string') out[path] = hash
  return out
}

/** Per-file snapshots by call id, for every tool result that captured one. */
function versionsByCallId(ctx: ResolveAuditContext): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const r of ctx.records) {
    if (r.type !== 'tool.outcome') continue
    const id = r.tool_call_id
    if (typeof id !== 'string' || !id) continue
    const versions = versionsOf(r)
    if (Object.keys(versions).length) out.set(id, versions)
  }
  return out
}

/**
 * Terminal evidence for one call: the durable canonical outcome, and only that. An outcome
 * with no captured object version is NOT evidence of anything — the legacy `meta.card` UI
 * shape DSH never emits was the other candidate, and accepting it meant accepting a terminal
 * fact with no version to attest, which the turn's own digest then filled in. No capture, no
 * proof: the missing version stays unknown instead of being replaced by the current one.
 */
function terminalOf(outcome: CallOutcome | undefined): CallOutcome | null {
  return outcome && outcome.cmd.trim() ? outcome : null
}

/**
 * Shells and runtimes that accept inline code (`-c`/`-e`), so an invocation of one
 * is an entry point only when it is given a script file to run.
 */
const INTERPRETER = new Set(['sh', 'bash', 'zsh', 'ksh', 'dash', 'fish', 'csh', 'tcsh', 'python', 'python2',
  'python3', 'node', 'nodejs', 'deno', 'bun', 'ts-node', 'perl', 'ruby', 'php', 'powershell', 'pwsh', 'cmd'])
/** A script-file argument: the only thing that turns an interpreter call into an entry point. */
const SCRIPT_ARG = /[^\s\\/]+\.(?:sh|bash|zsh|ksh|py|rb|pl|js|mjs|cjs|ts|ps1|bat|cmd)(?:\s|$)/
/**
 * Commands that ship nothing by themselves — they print, inspect, or move the shell.
 * Their exit 0 reports only that they ran, so they are never an operation entry point
 * (spec §12 A05: an irrelevant exit-0 command satisfies no acceptance requirement).
 */
const OPS_NOOP = new Set(['echo', 'printf', 'true', 'false', 'yes', 'test', ':', '.', 'cd', 'pushd', 'popd', 'pwd',
  'ls', 'dir', 'cat', 'tac', 'bat', 'head', 'tail', 'less', 'more', 'wc', 'stat', 'file', 'type', 'which', 'whereis',
  'command', 'whoami', 'id', 'hostname', 'uname', 'arch', 'date', 'uptime', 'env', 'printenv', 'set', 'export',
  'unset', 'alias', 'history', 'jobs', 'ps', 'top', 'htop', 'free', 'df', 'du', 'sort', 'uniq', 'cut', 'tr', 'tee',
  'xargs', 'seq', 'man', 'help', 'info', 'tree', 'find', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'awk', 'sed', 'diff',
  'cmp', 'md5sum', 'sha1sum', 'sha256sum', 'basename', 'dirname', 'realpath', 'readlink', 'mktemp', 'touch', 'sleep',
  'wait', 'read'])
/**
 * Operation entry points, anchored at a segment's program verb after directory
 * stripping. Every verb here changes state somewhere — it ships, publishes, applies,
 * transfers or restarts. Read-only and build-only verbs (`terraform plan`,
 * `docker build`, `pulumi preview`, `helm template`, `mvn release:prepare`) are
 * deliberately absent: they exit 0 having changed nothing, so they cannot complete a
 * request to deploy. Same discipline as VERIFIER_PATTERNS — an unlisted or ambiguous
 * verb fails closed.
 */
const OPS_ENTRY_PATTERNS: RegExp[] = [
  /^[^\s\\/]+\.(?:sh|bash|zsh|ksh|py|rb|pl|js|mjs|cjs|ts|ps1|bat|cmd|exe)(?:\s|$)/,
  /^(?:deploy|redeploy|release|publish|ship|rollout)\b/,
  /^(?:npm|yarn|pnpm|bun)\s+(?:run\s+)?(?:deploy|release|publish|ship|rollout)(?:[\s:]|$)/,
  /^make\s+(?:deploy|release|publish|ship|rollout|install|serve|up)(?:\s|$)/,
  /^(?:gradle|gradlew)\s+(?:deploy|release|publish)(?:\s|$)/,
  /^mvn\s+(?:deploy|release:perform)(?:\s|$)/,
  /^(?:dotnet|cargo|twine|gem|composer|nuget)\s+(?:publish|upload|release|push)(?:\s|$)/,
  /^(?:docker|podman)\s+(?:compose\s+)?(?:push|run|up|start|deploy|restart)(?:\s|$)/,
  /^(?:docker-compose|podman-compose)\s+(?:up|push|restart|start)(?:\s|$)/,
  /^kubectl\s+(?:apply|rollout|scale|set|create|replace|patch|delete)(?:\s|$)/,
  /^helm\s+(?:install|upgrade|rollback|uninstall)(?:\s|$)/,
  /^(?:terraform|tofu)\s+(?:apply|destroy)(?:\s|$)/,
  /^(?:pulumi|cdk|serverless|sls|sam|sst)\s+(?:up|deploy|destroy)(?:\s|$)/,
  /^ansible(?:-playbook)?\b/,
  /^(?:systemctl|service)\s+(?:start|stop|restart|reload|enable|disable)\s+\S/,
  /^(?:pm2|supervisorctl|forever)\s+(?:start|restart|reload|stop|delete|resurrect)\b/,
  /^(?:scp|rsync|sftp|ssh)\s+\S/,
  /^git\s+push(?:\s|$)/,
  /^(?:aws|gcloud|az|oci|doctl|fly|flyctl|vercel|netlify|wrangler|heroku|railway|render|surge|amplify)(?:\s+[\w.@:/-]+){0,3}\s+[\w.-]*(?:deploy|release|publish|sync|upload|rollout|apply|push)\b/,
]
/**
 * Program and script names that only build, inspect or dry-run. Running one exits 0
 * without changing any deployed state, so it is not an operation entry point even
 * though it is a real script (`./build.sh`, `bash scripts/test.sh`).
 */
const OPS_BUILD_ONLY = new Set(['build', 'rebuild', 'compile', 'package', 'pack', 'bundle', 'plan', 'preview',
  'diff', 'test', 'tests', 'check', 'lint', 'validate', 'verify', 'fmt', 'format', 'clean', 'dryrun', 'dry-run'])
/**
 * Flags that turn a real entry point into a rehearsal, so nothing changes state.
 * Long forms only: short flags are ambiguous (`-n` is rsync's dry run but kubectl's
 * namespace), and a false negative here blocks a genuine deploy.
 */
const DRY_RUN_FLAG = /(?:^|\s)--(?:dry-?run|check|preview|noop|no-op)(?:[=\s]|$)/

/** True when one shell segment invokes a real, state-changing operation entry point. */
function opsEntrySegment(seg: string): boolean {
  const s = seg.trim().replace(LEAD_STRIP, '').trim()
  if (!s || DRY_RUN_FLAG.test(s)) return false
  const parts = s.split(/\s+/)
  const base = baseName(parts[0]), verb = stemOf(base)
  if (!verb || OPS_NOOP.has(verb) || OPS_BUILD_ONLY.has(verb)) return false
  const rest = [base, ...parts.slice(1)].join(' ')
  if (INTERPRETER.has(verb)) {
    // An interpreter counts only for the script it runs, and that script must not be
    // a build/test either.
    const script = rest.match(SCRIPT_ARG)?.[0].trim()
    return !!script && !OPS_BUILD_ONLY.has(stemOf(baseName(script)))
  }
  return OPS_ENTRY_PATTERNS.some(re => re.test(rest))
}

/**
 * True when the command actually invokes an operation entry point. Masking is gated
 * by the caller (`opsOutcomes` drops any command with a masking connector), so this
 * answers only "is a real operation here": a noop exiting 0 is not one.
 */
function runsOpsEntry(cmd: string): boolean {
  if (!cmd || !cmd.trim()) return false
  return splitShellSegments(cmd).segs.some(opsEntrySegment)
}

/**
 * One `host_verifier` proof per complete call/result pair from the ledger.
 * - A half pair (call or result alone) is skipped: it stays unknown, never proof.
 * - A model/summary-sourced record is skipped: self-report is never proof.
 * - Shell/command results are judged by exit code, taken from the durable canonical
 *   `tool.outcome` record the host hook writes (primary, and the only source a real
 *   DSH session produces) or from a `card:'terminal'` meta (fallback shape). Either
 *   way a result without a trusted numeric exit code stays `unknown` with
 *   `assertion_passed:null`.
 * - Only a verification-class command (test/build/lint/typecheck runner) may
 *   associate with acceptance requirements. An irrelevant exit-0 command
 *   (echo/ls/cat/read/print) records its honest outcome but claims no
 *   requirement, so it can neither verify nor shadow a real verification
 *   (spec §12 A05: echo/unrelated writes do not satisfy acceptance).
 * - A verification command whose exit code is masked by a later segment (or preceded
 *   by `||`) is also rejected, so `npm test || true` cannot pass off a failing test as
 *   success. Which connectors mask depends on the dialect of the tool that ran it (see
 *   MASKING_CONN); `&&` neighbours are kept in both (failure propagates).
 * - Association also requires a determinate (passed/failed) status, so an
 *   indeterminate record never claims a requirement either.
 */
function buildEvidence(ctx: ResolveAuditContext, task: TaskContract, objectDigest: string, envDigest: string): Verification[] {
  const applicableIds = task.requirements
    .filter(r => r.class === 'acceptance' && r.applicability === 'applicable')
    .map(r => r.requirement_id)
  const out: Verification[] = []
  const outcomes = outcomesByCallId(ctx)
  for (const c of ctx.recovery.calls) {
    if (!c.call || !c.result) continue
    if (modelSourced(c.call) || modelSourced(c.result)) continue
    const resultData = dataOf(c.result), callData = dataOf(c.call)
    const toolName = typeof callData.name === 'string' ? callData.name : 'unknown'
    const t = terminalOf(outcomes.get(c.tool_call_id))
    const exitCode = t ? t.exit : null
    const hostFailed = c.result.result_status === 'failed' || c.status === 'failed'
    let status: Status, assertionPassed: boolean | null, requiresExitCode = false
    if (hostFailed) { status = 'failed'; assertionPassed = false }
    else if (t) { requiresExitCode = true; assertionPassed = t.exit === 0; status = t.exit === 0 ? 'passed' : 'failed' }
    else { status = 'unknown'; assertionPassed = null }
    const determinate = status === 'passed' || status === 'failed'
    // Relevance + anti-masking gate: only an unmasked verification-class command speaks to acceptance.
    const verifiesAcceptance = !!t && isTrustworthyVerification(t.cmd, dialectOf(callData.name))
    // The files this run captured must still look exactly as they did when it ran. That is the
    // real question — and unlike comparing two moving aggregate digests it does not turn stale
    // just because the session later touched some other file. When they no longer match, the
    // proof is kept but marked stale, so the gate reports `evidence_stale` (re-run it) instead
    // of pretending no run was ever recorded.
    const held = !!t && snapshotHolds(t.versions)
    out.push({
      event_id: `verify:${c.result.event_id}`,
      task_id: c.result.task_id ?? task.task_id,
      objective_revision: c.result.objective_revision ?? task.objective_revision,
      requirement_ids: verifiesAcceptance && determinate ? applicableIds : [],
      object_version_digest: objectDigest, environment_digest: envDigest,
      object_versions: t?.versions,
      status: verifiesAcceptance && determinate && !held ? 'stale' : status,
      complete: true, source_kind: 'host_verifier',
      verifier_ref: `dsh-tool:${toolName}:${c.tool_call_id}`,
      output_ref: c.result.output_ref ?? c.result.event_id,
      tool_call_id: c.tool_call_id, exit_code: exitCode,
      requires_exit_code: requiresExitCode, assertion_passed: assertionPassed,
    })
  }
  return out
}

/** True for a durable record carrying an actual human message, not synthetic feedback. */
function isHumanMessage(r: EvidenceRecord): boolean {
  return r.type === 'session.user/message' && dataOf(r)?.source?.kind === 'user'
}
/** The text parts of a message record's payload. */
function messageText(payload: unknown): string {
  const content = (payload as any)?.data?.content
  return (Array.isArray(content) ? content : []).filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
}
/** The latest human message in the durable log, or undefined when there is none. */
function latestHumanMessage(ctx: ResolveAuditContext): EvidenceRecord | undefined {
  return [...ctx.records].reverse().find(r => isHumanMessage(r))
}

/**
 * Task type as classified by the host from the human request (see classify.ts).
 * Read from the durable `task.classification` record the host persists per
 * objective revision; if absent, re-derived from the latest human message; never
 * from model output. Unknown/absent → `code` (strictest), failing closed.
 */
function readTaskType(ctx: ResolveAuditContext): TaskType {
  for (const r of [...ctx.records].reverse()) {
    if (r.type === 'task.classification') {
      const t = (r.payload as any)?.task_type
      if (isTaskType(t)) return t
    }
  }
  const human = latestHumanMessage(ctx)
  return human ? classifyTaskType(messageText(human.payload)) : 'code'
}

/**
 * The human request the current classification was derived from, by following the
 * `task.classification` record's `source_ref` back to that exact message; the latest
 * human message when no classification was persisted. An evidence template matches
 * its artifact against this text, so it comes from durable host records only — a
 * model cannot widen its own target by describing the work differently.
 */
function humanRequestText(ctx: ResolveAuditContext): string {
  const ref = (ctx.records.filter(r => r.type === 'task.classification').at(-1)?.payload as any)?.source_ref
  if (typeof ref === 'string' && ref) {
    const src = ctx.records.find(r => r.event_id === ref)
    if (src && isHumanMessage(src)) return messageText(src.payload)
  }
  const human = latestHumanMessage(ctx)
  return human ? messageText(human.payload) : ''
}

/** File-path arguments on a tool call. */
function pathsForCall(callData: any): string[] {
  const out: string[] = []
  const raw = callData?.arguments
  let parsed: any = raw
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw) } catch { parsed = undefined } }
  if (parsed && typeof parsed === 'object')
    for (const k of ['path', 'file_path', 'filePath', 'target', 'filename', 'file', 'notebook_path'])
      if (typeof parsed[k] === 'string') out.push(parsed[k])
  return out
}

const WRITE_TOOL = /(write|edit|create|patch|save|append|str_?replace|apply|overwrite)/i
/**
 * Tools that consult a source outside the workspace. Every alternative is an
 * external indicator. A bare `search`/`retriev`/`query` is deliberately NOT
 * accepted: local retrieval tools are commonly named `search_files` or
 * `codebase_search`, and one local hit is not research. A tool whose name does not
 * say where it looks fails closed.
 */
const EXTERNAL_SOURCE_TOOL = /(web|browse|browser|http|url|fetch|curl|wget|scrape|crawl|internet|online|serp|playwright)/i
/** A complete, host-sourced, non-failed call/result pair (narrows call+result to defined). */
const hostOk = <T extends { call?: EvidenceRecord; result?: EvidenceRecord; status: Status }>(c: T): c is T & { call: EvidenceRecord; result: EvidenceRecord } =>
  !!c.call && !!c.result && !modelSourced(c.call) && !modelSourced(c.result)
  && c.result.result_status !== 'failed' && c.status !== 'failed'

/** Conventional documentation basenames: these name a target even without an extension. */
const DOC_NAME = /\b(?:readme|changelog|licen[cs]e|contributing|notice|security|code_of_conduct)\b/gi
/**
 * Path-shaped tokens in a request: a slash-containing path, or a name carrying an
 * alphabetic extension. Ordinary words and version numbers (`v2.0`) are not targets,
 * so a request that names nothing falls through to the document-shape check.
 */
const PATH_TOKEN = /(?:[A-Za-z0-9_.@+\-]+[\\/])+[A-Za-z0-9_.@+\-]*[\\/]?|[A-Za-z0-9_@+\-]+\.[A-Za-z][A-Za-z0-9]{0,7}\b/g
/** A URL is a reference to read, not a target to write. */
const URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi

interface NamedTarget { norm: string; base: string; stem: string; dir: boolean }
export type { NamedTarget }

/**
 * The file and directory targets the human request names explicitly. URLs are dropped
 * whole first, so neither their host nor their path segments can be mistaken for a
 * target and reject every legitimate artifact.
 */
export function namedTargets(request: string): NamedTarget[] {
  const text = request.replace(URL, ' ')
  const out: NamedTarget[] = []
  const add = (raw: string, dir: boolean): void => {
    const norm = slashOf(raw).replace(/\/+$/, ''), base = baseName(norm)
    if (!base || out.some(o => o.norm === norm && o.dir === dir)) return
    out.push({ norm, base, stem: stemOf(base), dir })
  }
  for (const m of text.matchAll(PATH_TOKEN)) add(m[0], /[\\/]$/.test(m[0]))
  for (const m of text.matchAll(DOC_NAME)) add(m[0], false)
  return out
}

/** Documentation extensions: the only ones a bare target name may carry. */
const DOC_EXT = /\.(?:md|mdx|rst|adoc)$/
/** Backup, editor-swap and scratch suffixes: a copy of the artifact, not the artifact. */
const BACKUP_SUFFIX = /\.(?:bak|old|orig|tmp|temp|save|saved|copy|backup|swp|swo)$/
/** True when a slash-normalized path's basename marks it as a backup or scratch copy. */
function isBackupCopy(slashPath: string): boolean {
  const base = baseName(slashPath)
  return base.endsWith('~') || BACKUP_SUFFIX.test(base)
}

/**
 * Does a written path answer one named target? Comparison is on the basename,
 * case-insensitive. A target the request spelled with an extension must match it
 * exactly; a bare target name (`README`) also accepts a documentation extension
 * (`README.md`) and nothing else. So `README.bak`, `README.md~` and `README.txt` are
 * not the README the human asked for — stem equality alone let a backup pass as the
 * original.
 */
function answersTarget(slashPath: string, t: NamedTarget): boolean {
  const base = baseName(slashPath)
  if (base === t.base) return true
  if (isBackupCopy(slashPath)) return false
  if (t.dir) return slashPath.startsWith(`${t.norm}/`) || slashPath.includes(`/${t.norm}/`)
  return !t.base.includes('.') && DOC_EXT.test(base) && stemOf(base) === t.stem
}

/** Documentation shape: a doc extension, or a file under a `docs/` directory. */
function isDocShaped(slashPath: string): boolean {
  return DOC_EXT.test(slashPath) || /(?:^|\/)docs\//.test(slashPath)
}

/**
 * Does this artifact answer the docs request? A target the request names must match;
 * when it names none, only a documentation-shaped file counts. A backup copy answers
 * neither. An unrelated artifact mints no proof either way, so "I wrote something
 * readable" is not completion.
 */
function answersDocsRequest(path: string, named: NamedTarget[]): boolean {
  const n = slashOf(path)
  return named.length ? named.some(t => answersTarget(n, t)) : !isBackupCopy(n) && isDocShaped(n)
}

/**
 * docs template: a host_verifier proof per write/edit-class result whose target file
 * the host can now open for reading AND that answers the human request (see
 * `answersDocsRequest`). Keyed on the result event so repeated turns never collide.
 * The proof comes from the host filesystem, never from the model saying "I wrote it".
 */
function buildDocsEvidence(ctx: ResolveAuditContext, task: TaskContract, objectDigest: string, envDigest: string): Verification[] {
  const items = acceptanceItems(task), out: Verification[] = []
  if (!items.length) return out
  const named = namedTargets(humanRequestText(ctx))
  const outcomes = outcomesByCallId(ctx)
  const versions = versionsByCallId(ctx)
  for (const c of ctx.recovery.calls) {
    if (!hostOk(c)) continue
    const callData = dataOf(c.call), meta = dataOf(c.result).meta
    const callName = typeof callData.name === 'string' ? callData.name : ''
    const diff = !!meta && typeof meta === 'object' && meta.card === 'diff'
    // A document written through a shell (a redirect, `sed -i`, `tee`) leaves no diff meta.
    // It is still host-observable: the command names the target, the recorded outcome says the
    // command succeeded unmasked, and the host can open the resulting file.
    const command = SHELL_TOOL.test(callName) ? commandText(callData) : ''
    const outcome = command ? outcomes.get(c.tool_call_id ?? '') : undefined
    const shellWrote = !!command && !!outcome && outcome.exit === 0 && !hasMaskedExit(command, dialectOf(callName))
    if (!diff && !shellWrote && !WRITE_TOOL.test(callName)) continue
    const candidates = pathsForCall(callData)
    if (diff && Array.isArray(meta.diffs)) for (const d of meta.diffs) if (typeof d?.path === 'string') candidates.push(d.path)
    if (shellWrote) for (const p of shellWriteTargets(command, dialectOf(callName))) candidates.push(p)
    const written = candidates.filter(p => hostReadable(p) && answersDocsRequest(p, named))
    if (!written.length) continue
    // Bind each written artifact to the requirement it actually answers. Assigning every
    // acceptance item to any artifact is what let a request naming README and CHANGELOG close
    // on README alone.
    const matched = items.filter(item => written.some(p => answersItem(p, item, named)))
    if (!matched.length) continue
    // The document must still be the file the write captured; a later edit to it means this
    // proof no longer speaks for what is on disk, so it is kept and marked stale.
    const writeVersions = versions.get(c.tool_call_id ?? '') ?? {}
    const held = snapshotHolds(writeVersions)
    out.push({
      event_id: `verify:${c.result.event_id}`, task_id: c.result.task_id ?? task.task_id,
      objective_revision: c.result.objective_revision ?? task.objective_revision,
      requirement_ids: matched.map(item => item.requirement_id), object_version_digest: objectDigest,
      environment_digest: envDigest, object_versions: writeVersions, status: held ? 'passed' : 'stale',
      complete: true, source_kind: 'host_verifier',
      verifier_ref: `dsh-host:docs-artifact:${written[0]}`, output_ref: c.result.output_ref ?? c.result.event_id,
      requires_exit_code: false, exit_code: null, assertion_passed: true,
    })
  }
  return out
}

/** The delivered response as durably recorded by the host; null when absent or empty. */
function recordedDelivery(ctx: ResolveAuditContext): { ref: string; text: string } | null {
  const assistant = ctx.records.filter(r => r.type === 'session.assistant/message').at(-1)
  const text = assistantText(assistant?.payload)
  return assistant && text.trim() ? { ref: assistant.event_id, text } : null
}

/**
 * The delivery a query answers: the first assistant message recorded **after** that query — in
 * practice the reply of the turn the search belonged to. Taking the latest delivery instead let
 * an old search be re-stamped with a later reply, so the proof claimed the new answer was backed
 * by the old source. Falls back to the latest delivery when there is no query to anchor to.
 */
function deliveryForQuery(ctx: ResolveAuditContext, query: { seq: number | null } | null): { ref: string; text: string } | null {
  if (!query || query.seq === null) return recordedDelivery(ctx)
  for (const r of ctx.records) {
    if (r.type !== 'session.assistant/message') continue
    const seq = (r.payload as any)?.seq
    if (typeof seq !== 'number' || seq <= query.seq) continue
    const text = assistantText(r.payload)
    if (text.trim()) return { ref: r.event_id, text }
  }
  return null
}

/**
 * The most recent host-observed query to a source outside the workspace, together with the
 * object version captured at that query and the revision it ran under. Returning the capture
 * rather than a bare boolean is what lets a research proof speak for the moment it was made.
 */
function lastExternalQuery(ctx: ResolveAuditContext): { ref: string; digest: string; revision: number | null; seq: number | null } | null {
  const captured = digestsByCallId(ctx)
  let found: { ref: string; digest: string; revision: number | null; seq: number | null } | null = null
  for (const c of ctx.recovery.calls) {
    if (!hostOk(c)) continue
    const name = dataOf(c.call).name
    if (typeof name !== 'string' || !EXTERNAL_SOURCE_TOOL.test(name)) continue
    const seq = (c.result.payload as any)?.seq
    found = { ref: c.result.event_id, digest: captured.get(c.tool_call_id ?? '') ?? '',
      revision: c.result.objective_revision ?? null, seq: typeof seq === 'number' ? seq : null }
  }
  return found
}

/** One observed attempt at an operation entry point, successful or not — or not yet finished. */
interface OpsAttempt {
  eventId: string; ref: string; cmd: string
  /** The operation this attempt targets, normalized from its entry segment. */
  target: string
  outcome: 'passed' | 'failed' | 'unknown'
  exit: number | null; digest: string; revision: number | null
}

/** The entry segment an operation attempts, normalized so the same operation groups together. */
function opsTarget(cmd: string): string {
  for (const segment of splitShellSegments(cmd).segs) {
    const normalized = segment.trim().replace(LEAD_STRIP, '').trim()
    if (normalized && runsOpsEntry(normalized)) return normalized.replace(/\s+/g, ' ').toLowerCase()
  }
  return cmd.trim().replace(/\s+/g, ' ').toLowerCase()
}

/**
 * Every observed attempt at an operation entry point, in durable order — including the ones the
 * host reports as failed and the ones whose result has not arrived yet. Three ways of dropping
 * an attempt each let an earlier success stand for work that had not happened:
 *
 * - collecting only usable successes (a later host-reported failure carries no exit code);
 * - requiring a numeric exit code (a pending call has none);
 * - dropping masked commands entirely, when the honest reading is "this attempt cannot be
 *   confirmed", not "this attempt does not exist".
 *
 * Only a command that is not an entry point at all is ignored: it operates on nothing. The
 * command text comes from the call, so an attempt stays identifiable without its result.
 */
function opsAttempts(ctx: ResolveAuditContext): OpsAttempt[] {
  const out: OpsAttempt[] = []
  const outcomes = outcomesByCallId(ctx)
  const captured = digestsByCallId(ctx)
  for (const c of ctx.recovery.calls) {
    if (!c.call) continue
    if (modelSourced(c.call) || (c.result && modelSourced(c.result))) continue
    const callData = dataOf(c.call)
    const cmd = commandText(callData)
    if (!cmd.trim() || !runsOpsEntry(cmd)) continue
    const dialect = dialectOf(callData.name)
    const masked = hasMaskedExit(cmd, dialect)
    const t = masked ? null : terminalOf(outcomes.get(c.tool_call_id))
    const hostFailed = !!c.result && (c.result.result_status === 'failed' || c.status === 'failed')
    const outcome: OpsAttempt['outcome'] = hostFailed || (t && t.exit !== 0) ? 'failed' : t && !masked ? 'passed' : 'unknown'
    out.push({
      eventId: c.result?.event_id ?? c.call.event_id,
      ref: c.result?.output_ref ?? c.result?.event_id ?? c.call.event_id,
      cmd, target: opsTarget(cmd), outcome, exit: t ? t.exit : null,
      digest: t?.digest || captured.get(c.tool_call_id ?? '') || '',
      revision: c.result?.objective_revision ?? null,
    })
  }
  return out
}

function acceptanceIds(task: TaskContract): string[] {
  return task.requirements.filter(r => r.class === 'acceptance' && r.applicability === 'applicable').map(r => r.requirement_id)
}

/** The applicable acceptance items themselves, so a template can bind evidence per item. */
function acceptanceItems(task: TaskContract): Requirement[] {
  return task.requirements.filter(r => r.class === 'acceptance' && r.applicability === 'applicable')
}

/**
 * Whether a written artifact answers this requirement's declared target. An item with no target
 * of its own keeps the older, coarser rule (any target the request named).
 */
function answersItem(path: string, item: Requirement, named: NamedTarget[]): boolean {
  const scope = item.scope?.filter(Boolean) ?? []
  if (!scope.length) return answersDocsRequest(path, named)
  // answersTarget expects the normalized form every other comparison here uses.
  const normalized = slashOf(path)
  return namedTargets(scope.join(' ')).some(target => answersTarget(normalized, target))
}

/** A URL as it appears in a delivery, a query or a search result. */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`）)】\]]+|\bwww\.[^\s<>"'`）)】\]]+/gi

/**
 * A source reduced to what identifies it: scheme-less, lowercase, without a trailing slash,
 * query or fragment. `https://Example.com/a/` and `https://example.com/a?utm=1` are the same
 * source; `https://example.com/other` is not.
 */
function normalizeSource(url: string): string {
  return url.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '')
    // Trailing sentence punctuation is not part of the source: Chinese prose ends a URL with
    // 「。」 the same way English ends it with `.`, and keeping it made every citation in a
    // Chinese delivery look like a different (invented) source.
    .replace(/[.,;:。，；：、)）】\]]+$/, '')
    .split(/[?#]/)[0].replace(/\/+$/, '').toLowerCase()
}

/** Every URL inside an arbitrary record payload, without assuming where the host put it. */
function urlsIn(value: unknown, out: Set<string>): void {
  if (typeof value === 'string') {
    for (const m of value.matchAll(URL_IN_TEXT)) out.add(normalizeSource(m[0]))
    return
  }
  if (Array.isArray(value)) { for (const v of value) urlsIn(v, out); return }
  if (value && typeof value === 'object') for (const v of Object.values(value)) urlsIn(v, out)
}

/** The call a durable record belongs to, from whichever field shape the host used. */
function recordCallId(data: any): string {
  if (typeof data?.callId === 'string') return data.callId
  if (typeof data?.message?.source?.callId === 'string') return data.message.source.callId
  const block = data?.message?.content?.find?.((p: any) => p?.type === 'tool-result')
  return typeof block?.toolCallId === 'string' ? block.toolCallId : ''
}

/**
 * The sources the host actually observed: every URL that appears in an external-source tool's
 * arguments or result. This is what a delivery's citations are checked against — the host cannot
 * judge whether a conclusion follows from a source, but it can tell a source the session really
 * reached from one that was invented.
 */
function observedSources(ctx: ResolveAuditContext): Set<string> {
  const out = new Set<string>()
  const externalCalls = new Set<string>()
  for (const r of ctx.records) {
    if (r.type !== 'tool.call') continue
    const data = dataOf(r)
    if (typeof data?.name !== 'string' || !EXTERNAL_SOURCE_TOOL.test(data.name)) continue
    const id = recordCallId(data)
    if (id) externalCalls.add(id)
    urlsIn(r.payload, out)
  }
  for (const r of ctx.records) {
    if (r.type !== 'tool.result') continue
    if (!externalCalls.has(recordCallId(dataOf(r)))) continue
    urlsIn(r.payload, out)
  }
  out.delete('')
  return out
}

/** The sources a delivery cites, normalized the same way as the observed ones. */
function citedSources(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(URL_IN_TEXT)) out.add(normalizeSource(m[0]))
  out.delete('')
  return [...out]
}

/**
 * The citation gap for a research delivery, if any. Spec §56 asks research evidence for the
 * sources supporting its conclusions; a host-side gate cannot judge support, but it can refuse a
 * citation to a source the session never reached, and it can ask a delivery that consulted
 * sources to name at least one. Requiring a citation when the host observed no source at all
 * would be a requirement nothing could satisfy, so that case leaves the rule silent.
 */
function researchCitationGaps(ctx: ResolveAuditContext, task: TaskContract): Array<{ requirement_id: string; reason: string }> {
  const query = lastExternalQuery(ctx)
  const delivery = deliveryForQuery(ctx, query)
  if (!query || !delivery) return []
  const observed = observedSources(ctx)
  const cited = citedSources(delivery.text)
  const invented = cited.filter(source => !observed.has(source))
  const uncited = observed.size > 0 && cited.length === 0
  if (!invented.length && !uncited) return []
  return acceptanceItems(task).map(item => ({ requirement_id: item.requirement_id, reason: 'citation_unobserved' }))
}

/**
 * research template: the delivered content is durably recorded by the host AND the
 * model consulted at least one source outside the workspace. Keyed on the recorded
 * delivery event. Without a recorded delivery or an external query, no proof (fail
 * closed) — a conclusion drawn from nothing but local files is not research. The proof is
 * attributed to the revision of the query it rests on, so a search from an earlier task
 * revision cannot close a new one.
 */
function buildResearchEvidence(ctx: ResolveAuditContext, task: TaskContract, objectDigest: string, envDigest: string): Verification[] {
  const ids = acceptanceIds(task)
  const query = lastExternalQuery(ctx)
  const delivery = deliveryForQuery(ctx, query)
  if (!ids.length || !delivery || !query) return []
  // A delivery whose citations do not survive the check is not evidence: the gap is reported
  // instead, so the refusal names the invented or missing source rather than a generic absence.
  if (researchCitationGaps(ctx, task).length) return []
  // Research's object is the delivered content, whose digest comes from the delivery and does not
  // move with the working tree — the same value `objectDigestFor('research')` hands the audit.
  // Preferring the search call's own file capture here (which a live session always has once it
  // has touched a file) made the proof disagree with the input digest on every real run, so a
  // correct delivery was reported `evidence_stale` and could never close.
  const digest = objectDigest
  if (!digest) return []
  return [{
    event_id: `verify:${delivery.ref}`, task_id: task.task_id,
    objective_revision: query.revision ?? task.objective_revision,
    requirement_ids: ids, object_version_digest: digest, environment_digest: envDigest,
    status: 'passed', complete: true, source_kind: 'host_verifier',
    verifier_ref: 'dsh-host:research-delivery', output_ref: delivery.ref,
    requires_exit_code: false, exit_code: null, assertion_passed: true,
  }]
}

/**
 * ops template: the actual entry point ran and the host observed a determinate, unmasked
 * exit 0. A masked (`|| true`, `;`, pipe, background `&`), non-zero, absent or not-yet-arrived
 * result is no proof, and neither is a noop command (`echo`, `ls`, `cat`, ...) that exits 0
 * without operating on anything.
 *
 * The **newest attempt per target** decides, and every target the session attempted must be
 * passing: an earlier success followed by a failure of the same entry point must not read as
 * success (spec §107), and neither must a success on a different target stand in for a failed
 * one. Comparing whole-command texts instead would let "deploy A" and "deploy B" pass for each
 * other, so attempts are grouped by their entry segment.
 */
function buildOpsEvidence(ctx: ResolveAuditContext, task: TaskContract, objectDigest: string, envDigest: string): Verification[] {
  const ids = acceptanceIds(task)
  const attempts = opsAttempts(ctx)
  if (!ids.length || !attempts.length) return []
  const latestByTarget = new Map<string, OpsAttempt>()
  for (const attempt of attempts) latestByTarget.set(attempt.target, attempt)
  if ([...latestByTarget.values()].some(attempt => attempt.outcome !== 'passed')) return []
  const latest = attempts.at(-1)
  if (!latest) return []
  // An operation's object is not a file set: this digest is derived from the observed outcomes
  // themselves, so it cannot silently track a later edit the way a file digest can, and it is the
  // same value the audit compares proofs against. Preferring the attempt's own file capture (which
  // a live session has as soon as it has touched a file) made the audit report `evidence_stale` for
  // a correct deploy — the same defect the research template had.
  const digest = objectDigest
  if (!digest) return []
  return [{
    event_id: `verify:${latest.eventId}`, task_id: task.task_id,
    objective_revision: latest.revision ?? task.objective_revision,
    requirement_ids: ids, object_version_digest: digest, environment_digest: envDigest,
    status: 'passed', complete: true, source_kind: 'host_verifier',
    verifier_ref: `dsh-host:ops-entry:${latest.cmd.slice(0, 80)}`, output_ref: latest.ref,
    requires_exit_code: false, exit_code: latest.exit, assertion_passed: true,
  }]
}

/**
 * Discussion owes no acceptance artifact. The host authority excludes the
 * placeholder acceptance requirement (authorized, with provenance); `hard`
 * constraints are left untouched and still fail closed.
 */
function discussionTask(task: TaskContract, ctx: ResolveAuditContext): TaskContract {
  const ref = ctx.records.filter(r => r.type === 'task.classification').at(-1)?.event_id ?? `dsh:${ctx.session_id}:discussion`
  return { ...task, requirements: task.requirements.map(r => r.class === 'acceptance'
    ? { ...r, applicability: 'not_applicable' as const,
        exclusion: { authorized: true, source_ref: ref, reason: 'discussion task: no acceptance artifact required' } }
    : r) }
}

/**
 * The object version a task of this type can be certified against. Each type has exactly ONE
 * object domain, and a proof may only ever carry the digest of its own domain:
 *
 * - code / docs / discussion attest a set of files, so the digest is the file-set digest, and
 *   evidence without a captured version claims nothing.
 * - ops attests an operation: its object is the observed attempts, so the digest is derived
 *   from those events — never from the working tree.
 * - research attests delivered content: the digest is derived from that delivery.
 *
 * Preferring the file digest for every type (which this function used to do) made the "the
 * object is not a file set" argument false in the implementation: an old deployment or search
 * then picked up the current file version through its template's fallback and re-refreshed that
 * binding on every later edit.
 */
function objectDigestFor(type: TaskType, ctx: ResolveAuditContext): string {
  if (type === 'ops') {
    const attempts = opsAttempts(ctx)
    return attempts.length ? sha256({ object: 'ops-attempts', attempts }) : ''
  }
  if (type === 'research') {
    const delivery = deliveryForQuery(ctx, lastExternalQuery(ctx))
    return delivery ? sha256({ object: 'research-delivery', text: delivery.text }) : ''
  }
  return computeObjectDigest(ctx.records)
}

/**
 * The paths this revision actually wrote: writer-tool arguments, diff metadata and shell write
 * targets. Reads are excluded on purpose — opening the protected file is not changing it, and
 * counting reads turned every inspection of it into a violation.
 */
function writtenPaths(records: EvidenceRecord[]): string[] {
  const paths = new Set<string>()
  for (const r of records) {
    const data = dataOf(r)
    const meta = data?.meta
    if (r.type === 'tool.result') {
      if (Array.isArray(meta?.diffs))
        for (const d of meta.diffs) if (typeof d?.path === 'string') paths.add(d.path)
      if (Array.isArray(meta?.locations))
        for (const l of meta.locations) if (typeof l?.path === 'string') paths.add(l.path)
    }
    if (r.type !== 'tool.call') continue
    const name = typeof data?.name === 'string' ? data.name : ''
    if (SHELL_TOOL.test(name)) {
      for (const target of shellWriteTargets(commandText(data), dialectOf(name))) paths.add(target)
      continue
    }
    if (!WRITE_TOOL.test(name) || typeof data.arguments !== 'string') continue
    try {
      const args = JSON.parse(data.arguments)
      for (const k of ['path', 'file_path', 'filePath', 'target', 'filename', 'file'])
        if (typeof args?.[k] === 'string') paths.add(args[k])
    } catch { /* unparsed arguments carry no reliable path */ }
  }
  return [...paths]
}

/**
 * Hard constraints are listed one-by-one, and a prohibition is decided in this order:
 *
 * 1. A write the host actually observed under that name is a violation, whatever the object looks
 *    like afterwards — the human said not to touch it, and restoring the bytes does not undo the
 *    write the gate watched.
 * 2. A captured baseline (file content, or a directory's tree) is re-read and compared.
 * 3. With neither, the item stays `unknown`: spec §3 keeps an unconfirmable hard item and lists
 *    it for review, and the only thing the host may not do is declare it satisfied.
 */
function buildHardChecks(task: TaskContract, ctx: ResolveAuditContext): HardConstraintCheck[] {
  const written = writtenPaths(ctx.records)
  return task.requirements.filter(r => r.class === 'hard').map(r => {
    const scope = r.scope?.[0]
    const hit = scope ? violatingWrite(scope, written) : undefined
    if (hit) return { requirement_id: r.requirement_id, applicability: 'applicable' as const,
      status: 'violated' as const, check_ref: `dsh-host:observed-write:${slashOf(hit)}` }
    if (!scope || !r.baseline_digest) return { requirement_id: r.requirement_id,
      applicability: 'unknown' as const, status: 'unknown' as const,
      check_ref: `host:hard-unresolved:${scope || r.requirement_id}` }
    const now = objectDigest(scope.replace(/[\\/]+$/, ''))
    const status: HardConstraintCheck['status'] = !now ? 'unknown' : now === r.baseline_digest ? 'compliant' : 'violated'
    return { requirement_id: r.requirement_id, applicability: r.applicability, status,
      check_ref: `dsh-host:unchanged:${scope}` }
  })
}

/**
 * A proof's identity: which tool result it came from AND which object version it attests.
 * The resolver re-mints proofs for every call on every turn, while the object digest moves
 * with the working tree. With a bare `verify:<result id>`, turn two therefore re-recorded
 * the same id with a different digest, and the ledger's idempotency check threw
 * `evidence_event_id_conflict` out of the turn-stopping hook: no state, no decision and no
 * repair prompt followed, so the gate died silently for the rest of the session. Versioning
 * the id makes a re-mint a new record instead of a conflict, which is what the audit already
 * expects — it takes the latest proof and rejects the ones whose digest no longer matches.
 */
function proofVersionId(proof: Verification): Verification {
  const tag = proof.object_version_digest
    ? createHash('sha256').update(proof.object_version_digest).digest('hex').slice(0, 12)
    : 'nocontent'
  return { ...proof, event_id: `${proof.event_id}:${tag}` }
}

export function defaultResolveAudit(ctx: ResolveAuditContext): Omit<AuditInput, 'previous'> {
  const taskType = readTaskType(ctx)
  const confirmed = withConfirmedApplicability(ctx.task)
  const objectDigest = objectDigestFor(taskType, ctx)
  const envDigest = computeEnvironmentDigest(ctx)

  // Host-side check: the candidate body must equal the agent's final message as
  // durably recorded. No recorded message → unknown (fails closed).
  const assistant = ctx.records.filter(r => r.type === 'session.assistant/message').at(-1)
  let candidateCheck: AuditInput['candidate_check']
  if (!assistant) candidateCheck = { status: 'unknown', source_ref: '' }
  else candidateCheck = assistantText(assistant.payload) === ctx.response
    ? { status: 'consistent', source_ref: assistant.event_id }
    : { status: 'contradictory', source_ref: assistant.event_id }

  // Type → acceptance template (spec §4). Each type is satisfied only by its own
  // host-observed artifact, and only one that answers this human request: a document
  // the request asked for, a state-changing operation entry point, a query to a
  // source outside the workspace. There is deliberately NO fallback to the `code`
  // template — running the test suite is free, so borrowing it let an unrelated
  // `npm test` close a docs/research/ops task and made the request matching above
  // decorative. No own artifact means `evidence_missing`, failing closed. The type
  // came from the human request only — a model calling its work "discussion" cannot
  // select that template.
  let task = confirmed
  let candidate: Candidate = { claims_success: true, response_kind: 'final_delivery', text: ctx.response, requirement_claims: [] }
  let evidence: Verification[]
  let gaps: Array<{ requirement_id: string; reason: string }> = []
  if (taskType === 'discussion') {
    task = discussionTask(confirmed, ctx)
    candidate = { claims_success: false, response_kind: 'discussion', text: ctx.response, requirement_claims: [] }
    evidence = []
  } else if (taskType === 'docs') {
    evidence = buildDocsEvidence(ctx, confirmed, objectDigest, envDigest)
  } else if (taskType === 'research') {
    evidence = buildResearchEvidence(ctx, confirmed, objectDigest, envDigest)
    gaps = researchCitationGaps(ctx, confirmed)
  } else if (taskType === 'ops') {
    evidence = buildOpsEvidence(ctx, confirmed, objectDigest, envDigest)
  } else {
    evidence = buildEvidence(ctx, confirmed, objectDigest, envDigest)
  }

  // The audit compares every proof's object digest with the input's, and reports `evidence_stale`
  // when they differ — so a proof may only ever carry THIS run's domain digest. The templates above
  // each know their own object, and two of them used to prefer a per-call value (a file capture
  // recorded when the call ran); any session that had touched a file then produced a correct proof
  // the audit could never accept. Stamping here makes the invariant hold by construction instead of
  // relying on every template to remember it.
  evidence = evidence.map(proof => proof.object_version_digest === objectDigest
    ? proof : { ...proof, object_version_digest: objectDigest })

  // Version the proof ids before anything can reference them (decision.evidence_refs, a
  // blocker's evidence_ref): an id is only ever written once, under one object version.
  evidence = evidence.map(proofVersionId)

  // A prohibition the host cannot open is either broken by an observed write or reported
  // unknown; the returned task carries only prohibitions the host can actually represent.
  const responseSeq = (assistant?.payload as any)?.seq ?? -1
  return {
    request_id: `${ctx.session_id}:${ctx.turn}:${responseSeq}`,
    task, task_type: taskType, candidate, candidate_check: candidateCheck, evidence, evidence_gaps: gaps,
    hard_constraints_checked: buildHardChecks(task, ctx),
    object_version_digest: objectDigest,
    context_state_digest: `dsh:${ctx.session_id}:turn:${ctx.turn}:events:${ctx.recovery.event_sequence}`,
    environment_digest: envDigest, now: Date.now(),
    recovery_events: ctx.records.filter(r => r.type === 'task.revision').map(r => r.payload as any),
  }
}
