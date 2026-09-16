import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { Requirement } from './audit.js'

/**
 * A prohibition a human stated, with the object it protects: 「不要改 protected.txt」,
 * "do not touch config/", 「禁止修改 CHANGELOG」. Without this the constraint never entered the
 * contract at all, so the gate had nothing to check and let the modification through.
 */
const PROHIBITION = /(?:不要|别|禁止|不许)\s*(?:修改|改动?|编辑|碰|动)\s*([^\s，。；、,;"'）)】]+)|(?:do\s+not|don't|never)\s+(?:modify|change|edit|touch)\s+([^\s,;"'）)】]+)/gi
/** One more name in the same prohibition: 「A 和 B」「A、B」「A, B」「A and B」. */
const LIST_SEP = /\s*(?:和|与|及|、|,|&|and)\s*/iy
/** A name inside a prohibition: the same shape the first one is captured with. */
const NAME_AT = /[^\s，。；、,;"'）)】]+/iy
/**
 * A continuation name has to look like an object: a path, an extension, or Chinese words. Without
 * this, an English sentence's next words ("… and b.txt, then update README") entered the list as
 * prohibited objects, which is noise the contract should not carry.
 */
const NAME_IS_OBJECT = /[\\/]|\.[A-Za-z]|[\u4e00-\u9fff]/
/**
 * A name with the sentence period that follows it removed. Dots are part of a file name, so the
 * pattern cannot stop at the first one the way it used to: 「do not modify README.md」 captured
 * `README`, which then matched no write and protected nothing.
 */
const stripPeriod = (name: string): string => name.trim().replace(/\.+$/, '')
/** Where the clause a prohibition governs ends. */
const CLAUSE_END = /[，。；、,;.!?\n]/

/**
 * The end of the clause a prohibition governs, so a list can be read whole without swallowing
 * the sentence that follows it.
 */
function clauseEnd(text: string, from: number): number {
  for (let i = from; i < text.length; i++) if (CLAUSE_END.test(text[i])) return i
  return text.length
}

/**
 * Paths a request forbids changing, in the order they were stated. A prohibition typically
 * names a list — 「不要修改 A 和 B」 — and reading only the first name left the second one looking
 * like a deliverable the human was waiting for, so the contract demanded a change to a file the
 * same sentence forbade touching.
 */
export function prohibitionTargets(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(PROHIBITION)) {
    const first = stripPeriod(m[1] ?? m[2] ?? '')
    if (first) out.add(first)
    let at = (m.index ?? 0) + m[0].length
    for (;;) {
      LIST_SEP.lastIndex = at
      const sep = LIST_SEP.exec(text)
      if (!sep) break
      NAME_AT.lastIndex = sep.index + sep[0].length
      const name = NAME_AT.exec(text)
      if (!name || !NAME_IS_OBJECT.test(name[0])) break
      const clean = stripPeriod(name[0])
      if (!clean) break
      out.add(clean)
      at = name.index + name[0].length
    }
  }
  return [...out]
}

/**
 * The request with its prohibition clauses blanked out. A clause that forbids a change is not
 * the work being asked for: 「不要动代码，只更新 README.md 文档」 is a documentation request that
 * happens to mention code, and classifying the prohibition as the task turned it into a code
 * task that demanded a test run the human never asked for.
 */
export function withoutProhibitions(text: string): string {
  let out = '', at = 0
  for (const m of text.matchAll(PROHIBITION)) {
    const start = m.index ?? 0
    const end = clauseEnd(text, start + m[0].length)
    out += `${text.slice(at, start)} `
    at = end
  }
  return out + text.slice(at)
}

/**
 * The content digest of an object as the host sees it right now. Empty when it cannot be read,
 * which the caller must treat as unknown rather than as "unchanged".
 */
export function contentDigest(path: string): string {
  try { return `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}` } catch { return '' }
}

export interface DeclaredInput {
  /** The human request, verbatim. */
  text: string
  /** The durable event id of that message: every item's provenance. */
  sourceRef: string
  /** Targets the host read out of the request. */
  targets: string[]
  /** True when the request is a document task, where each named target is its own deliverable. */
  perTarget: boolean
  /** Paths the request forbids changing, already separated from its deliverables. */
  prohibited?: string[]
  /**
   * The session working directory when the host exposes one. A relative path in a request can
   * only be opened after it is resolved against this; without it the object stays unreadable
   * and the resolver has to fall back to observed writes.
   */
  baseDir?: string
}

/** The object a path names, resolved against the session workspace when it is relative. */
function resolvable(path: string, baseDir?: string): string {
  if (!path) return ''
  if (isAbsolute(path)) return path
  return baseDir ? resolve(baseDir, path) : ''
}

/**
 * The requirements a request actually declares.
 *
 * A documentation request names deliverables, so it gets one acceptance item per target: a
 * request naming README and CHANGELOG needs both, and producing one of them closes exactly one
 * item. Other types get a single acceptance item — a test run covers a repository, not a named
 * file, so inventing per-file acceptance for code would demand evidence no host can produce.
 *
 * Every stated prohibition becomes a hard item carrying the digest of what it protects at the
 * moment the revision started — when the host can actually open that object. A prohibition the
 * host cannot read (a relative path in a session with no known working directory, or a phrase
 * that names no file at all) still becomes an item, with an empty baseline: the resolver then
 * decides per turn between an observed write that breaks it and an authorized exclusion, so the
 * constraint is never silently dropped and never blocks every future turn either.
 */
export function declaredRequirements(input: DeclaredInput): Requirement[] {
  const out: Requirement[] = []
  const targets = [...new Set(input.targets.map(t => t.trim()).filter(Boolean))].slice(0, 5)
  if (input.perTarget && targets.length) {
    targets.forEach((target, i) => out.push({
      requirement_id: `AC-${i + 1}`, class: 'acceptance', source_kind: 'user_instruction',
      source_ref: input.sourceRef, applicability: 'unknown', status: 'unknown', scope: [target],
    }))
  } else {
    out.push({
      requirement_id: 'AC-1', class: 'acceptance', source_kind: 'user_instruction',
      source_ref: input.sourceRef, applicability: 'unknown', status: 'unknown',
    })
  }
  const prohibited = input.prohibited ?? prohibitionTargets(input.text)
  ;[...new Set(prohibited.map(t => t.trim()).filter(Boolean))].slice(0, 5).forEach((path, i) => out.push({
    requirement_id: `HC-${i + 1}`, class: 'hard', source_kind: 'user_instruction',
    source_ref: input.sourceRef, applicability: 'unknown', status: 'unknown',
    scope: [resolvable(path, input.baseDir) || path], baseline_digest: contentDigest(resolvable(path, input.baseDir)),
  }))
  return out
}
