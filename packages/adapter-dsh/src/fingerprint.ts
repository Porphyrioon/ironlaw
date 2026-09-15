import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
/** Caller supplies the conservative complete object/config/dependency set.
 * Missing/unreadable objects throw, never reuse a previous digest. Includes uncommitted bytes. */
export function objectVersionDigest(paths: string[]): string {
  if (!paths.length) throw new Error('object_scope_unknown')
  const hash = createHash('sha256')
  for (const file of [...new Set(paths.map(p => resolve(p)))].sort()) {
    hash.update(JSON.stringify([file, createHash('sha256').update(readFileSync(file)).digest('hex')]))
  }
  return `sha256:${hash.digest('hex')}`
}
