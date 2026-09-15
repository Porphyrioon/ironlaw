import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { EvidenceLedger } from './evidence.js'
import type { TaskContract } from './audit.js'

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface ContextEntry {
  id: string; version: string; when: string; environment: string; object: string
  purpose: string; reasons: string[]; dependencies: string[]; action: string; result: string
  source_kind: string; source_ref: string; certainty: 'fact' | 'assumption' | 'unknown'
  expires_at: number | null; requirement_ids: string[]; load_when: string; original: string
  disposition: 'KEEP_ACTIVE' | 'ARCHIVE_INDEX'
}
export interface ContextStructure {
  task_id: string; objective_revision: number; objective: string
  todos: string[]; key_reasons: string[]; evidence_refs: string[]; entries: ContextEntry[]
}
export interface TaskCapsule {
  task: TaskContract; structure: ContextStructure
  recovery: ReturnType<EvidenceLedger['recover']>
}
export interface ContextSummary {
  facts: string[]; assumptions: string[]; unknowns: string[]
  /** Exact safety capsule is retained alongside prose; omission is a failed validation. */
  capsule: RetentionCapsule
}
export interface RetentionCapsule {
  task: TaskContract; objective: string; todos: string[]; key_reasons: string[]; evidence_refs: string[]
  evidence: TaskCapsule['recovery']['evidence']; audit: TaskCapsule['recovery']['audit']
  calls: Array<{ tool_call_id: string; status: string; call_ref?: string; result_ref?: string }>
}
export function retainCapsule(original: TaskCapsule): RetentionCapsule {
  const { objective, todos, key_reasons, evidence_refs } = original.structure
  return structuredClone({ task: original.task, objective, todos, key_reasons,
    evidence_refs: [...new Set([...evidence_refs, ...original.recovery.evidence.flatMap(e => [e.event_id, e.output_ref])])],
    evidence: original.recovery.evidence, audit: original.recovery.audit,
    calls: original.recovery.calls.map(c => ({ tool_call_id: c.tool_call_id, status: c.status,
      call_ref: c.call?.event_id, result_ref: c.result?.event_id })) })
}
export interface ArchiveIndex extends Omit<ContextEntry, 'original' | 'disposition'> {
  disposition: 'ARCHIVE_INDEX'; recoverable_location: string; archive_digest: string
}
export interface ContextVersion {
  schema_version: 1; version: string; previous: string | null; session_id: string
  event_sequence: number; objective_revision: number; archive: string; archive_digest: string
  index: ArchiveIndex[]; active: ContextEntry[]; summary: ContextSummary
}
interface Pointer { current: string; previous: string | null }
interface Prepared {
  session_id: string; token: string; previous: string | null; snapshot_digest: string
  capsule: TaskCapsule; archive: string; archive_digest: string
}
interface Validated { prepared: Prepared; version: ContextVersion }

/** Portable pre/post-compact capsules. This does not rewrite any host's history.
 * All writers to a session must use this store; cross-process compact uses an exclusive lock.
 * Orphan archives/versions are harmless: only the atomically replaced pointer is active.
 */
export class ContextStore {
  private prepared = new WeakMap<object, string>()
  private validated = new WeakMap<object, string>()
  constructor(readonly ledger: EvidenceLedger, readonly root = join(ledger.root, 'context')) {}
  private directory(sessionId: string) { return join(this.root, hash(sessionId)) }
  private pointer(sessionId: string): Pointer | undefined {
    const file = join(this.directory(sessionId), 'current.json')
    if (!existsSync(file)) return undefined
    const pointer = JSON.parse(readFileSync(file, 'utf8')) as Pointer
    if (!/^[a-f0-9-]+\.json$/.test(pointer.current)
      || (pointer.previous !== null && !/^[a-f0-9-]+\.json$/.test(pointer.previous))) throw new Error('context_pointer_invalid')
    return pointer
  }
  private persist(file: string, value: unknown) {
    const fd = openSync(file, 'wx')
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd) } finally { closeSync(fd) }
  }
  saveStructure(sessionId: string, structure: ContextStructure): void {
    const task = this.ledger.recover(sessionId).task
    if (!task || task.task_id !== structure.task_id || task.objective_revision !== structure.objective_revision
      || !structure.objective.trim()) throw new Error('context_task_mismatch')
    if (new Set(structure.entries.map(e => e.id)).size !== structure.entries.length) throw new Error('context_duplicate_entry')
    for (const e of structure.entries) {
      if (!['KEEP_ACTIVE', 'ARCHIVE_INDEX'].includes(e.disposition)) throw new Error('context_drop_disabled')
      if (![e.id, e.version, e.when, e.environment, e.object, e.purpose, e.action, e.result,
        e.source_kind, e.source_ref, e.load_when, e.original].every(v => typeof v === 'string' && v.length > 0)
        || !['fact', 'assumption', 'unknown'].includes(e.certainty)) throw new Error('context_entry_invalid')
    }
    this.ledger.record(sessionId, 'context.structure', structure, { task_id: task.task_id, objective_revision: task.objective_revision })
  }
  prepare(sessionId: string): Prepared {
    const recovery = this.ledger.recover(sessionId), task = recovery.task
    const structure = [...recovery.records].reverse().find(r => r.schema_version === 2 && r.type === 'context.structure'
      && r.task_id === task?.task_id && r.objective_revision === task?.objective_revision)?.payload as ContextStructure | undefined
    if (!task || !structure) throw new Error('context_structure_missing')
    const capsule: TaskCapsule = { task, structure, recovery }
    const directory = this.directory(sessionId)
    mkdirSync(directory, { recursive: true })
    const token = randomUUID(), archive = `${token}.archive.json`, archive_digest = hash(capsule)
    // Persist and read back originals BEFORE invoking any summarizer.
    this.persist(join(directory, archive), capsule)
    if (hash(JSON.parse(readFileSync(join(directory, archive), 'utf8'))) !== archive_digest) throw new Error('archive_unreadable')
    const prepared: Prepared = { session_id: sessionId, token, previous: this.pointer(sessionId)?.current ?? null,
      snapshot_digest: hash(recovery), capsule, archive, archive_digest }
    this.prepared.set(prepared, hash(prepared))
    return prepared
  }
  validate(prepared: Prepared, summary: ContextSummary): Validated {
    if (!this.prepared.has(prepared)) throw new Error('context_prepare_required')
    if (this.prepared.get(prepared) !== hash(prepared)) throw new Error('context_prepared_changed')
    const original = JSON.parse(readFileSync(join(this.directory(prepared.session_id), prepared.archive), 'utf8')) as TaskCapsule
    if (hash(original) !== prepared.archive_digest || hash(summary.capsule) !== hash(retainCapsule(original))
      || ![summary.facts, summary.assumptions, summary.unknowns].every(a => Array.isArray(a) && a.every(s => typeof s === 'string')))
      throw new Error('context_summary_incomplete')
    if (hash(this.ledger.recover(prepared.session_id)) !== prepared.snapshot_digest) throw new Error('context_events_changed')
    const index: ArchiveIndex[] = original.structure.entries.filter(e => e.disposition === 'ARCHIVE_INDEX').map(e => {
      const { original: _text, disposition: _disposition, ...metadata } = e
      return { ...metadata, disposition: 'ARCHIVE_INDEX', archive_digest: prepared.archive_digest,
        recoverable_location: `${prepared.archive}#${encodeURIComponent(e.id)}` }
    })
    const validated: Validated = { prepared: structuredClone(prepared), version: {
      schema_version: 1, version: `${prepared.token}.json`, previous: prepared.previous, session_id: prepared.session_id,
      event_sequence: original.recovery.event_sequence, objective_revision: original.task.objective_revision,
      archive: prepared.archive, archive_digest: prepared.archive_digest, index,
      active: original.structure.entries.filter(e => e.disposition === 'KEEP_ACTIVE'), summary: structuredClone(summary),
    } }
    this.validated.set(validated, hash(validated))
    return validated
  }
  commit(validated: Validated): ContextVersion {
    return this.ledger.withLock(() => this.commitLocked(validated))
  }
  private commitLocked(validated: Validated): ContextVersion {
    if (!this.validated.has(validated)) throw new Error('context_validation_required')
    if (this.validated.get(validated) !== hash(validated)) throw new Error('context_validated_changed')
    this.validated.delete(validated)
    const { prepared: p, version } = validated, directory = this.directory(p.session_id)
    const lock = join(directory, 'commit.lock'), fd = openSync(lock, 'wx')
    try {
      // Revalidate under lock, including caller mutation, disk damage and events arriving after validation.
      this.prepared.set(p, hash(p))
      const checked = this.validate(p, version.summary)
      if (hash(checked.version) !== hash(version)) throw new Error('context_version_changed')
      if ((this.pointer(p.session_id)?.current ?? null) !== p.previous) throw new Error('context_version_conflict')
      this.persist(join(directory, version.version), version)
      const temp = join(directory, `${p.token}.pointer.tmp`)
      this.persist(temp, { current: version.version, previous: p.previous })
      renameSync(temp, join(directory, 'current.json'))
      return structuredClone(version)
    } finally { closeSync(fd); unlinkSync(lock) }
  }
  async compact(sessionId: string, summarize: (capsule: TaskCapsule) => ContextSummary | Promise<ContextSummary>) {
    try {
      const prepared = this.prepare(sessionId)
      const summary = await summarize(structuredClone(prepared.capsule))
      return { committed: true as const, version: this.commit(this.validate(prepared, summary)) }
    } catch (error) {
      return { committed: false as const, reason: error instanceof Error ? error.message : 'context_compact_failed' }
    }
  }
  current(sessionId: string): ContextVersion | undefined {
    const pointer = this.pointer(sessionId)
    return pointer ? JSON.parse(readFileSync(join(this.directory(sessionId), pointer.current), 'utf8')) : undefined
  }
  rollback(sessionId: string): ContextVersion {
    const directory = this.directory(sessionId), lock = join(directory, 'commit.lock'), fd = openSync(lock, 'wx')
    try {
      const pointer = this.pointer(sessionId)
      if (!pointer?.previous) throw new Error('context_rollback_missing')
      const previous = JSON.parse(readFileSync(join(directory, pointer.previous), 'utf8')) as ContextVersion
      if (hash(JSON.parse(readFileSync(join(directory, previous.archive), 'utf8'))) !== previous.archive_digest) throw new Error('archive_unreadable')
      const temp = join(directory, `${randomUUID()}.pointer.tmp`)
      this.persist(temp, { current: pointer.previous, previous: previous.previous })
      renameSync(temp, join(directory, 'current.json'))
      return previous
    } finally { closeSync(fd); unlinkSync(lock) }
  }
  retrieve(sessionId: string, entry: ArchiveIndex): { status: 'found'; original: string } | { status: 'missing' } {
    try {
      const [file, id] = entry.recoverable_location.split('#')
      if (!/^[a-f0-9-]+\.archive\.json$/.test(file)) return { status: 'missing' }
      const capsule = JSON.parse(readFileSync(join(this.directory(sessionId), file), 'utf8')) as TaskCapsule
      if (hash(capsule) !== entry.archive_digest) return { status: 'missing' }
      const original = capsule.structure.entries.find(e => e.id === decodeURIComponent(id) && e.version === entry.version)?.original
      return original === undefined ? { status: 'missing' } : { status: 'found', original }
    } catch { return { status: 'missing' } }
  }
}
