import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Requirement } from './audit.js'

/**
 * A prohibition a human stated, with the object it protects: 「不要改 protected.txt」,
 * "do not touch config/", 「禁止修改 CHANGELOG」. Without this the constraint never entered the
 * contract at all, so the gate had nothing to check and let the modification through.
 */
const PROHIBITION = /(?:不要|别|禁止|不许)\s*(?:修改|改动?|编辑|碰|动)\s*([^\s，。；、,;"'）)】]+)|(?:do\s+not|don't|never)\s+(?:modify|change|edit|touch)\s+([^\s,.;"')]+)/gi

/** Paths a request forbids changing, in the order they were stated. */
export function prohibitionTargets(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(PROHIBITION)) {
    const target = (m[1] ?? m[2] ?? '').trim()
    if (target) out.add(target)
  }
  return [...out]
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
}

/**
 * The requirements a request actually declares.
 *
 * A documentation request names deliverables, so it gets one acceptance item per target: a
 * request naming README and CHANGELOG needs both, and producing one of them closes exactly one
 * item. Other types get a single acceptance item — a test run covers a repository, not a named
 * file, so inventing per-file acceptance for code would demand evidence no host can produce.
 *
 * Every stated prohibition becomes a hard item carrying the digest of the protected object at
 * the moment the revision started. That is what makes the constraint checkable later by the
 * host itself instead of being reported as unconfirmable.
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
  prohibitionTargets(input.text).slice(0, 5).forEach((path, i) => out.push({
    requirement_id: `HC-${i + 1}`, class: 'hard', source_kind: 'user_instruction',
    source_ref: input.sourceRef, applicability: 'unknown', status: 'unknown',
    scope: [path], baseline_digest: contentDigest(path),
  }))
  return out
}
