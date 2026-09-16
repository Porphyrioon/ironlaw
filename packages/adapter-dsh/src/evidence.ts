import { appendFileSync, mkdirSync, readFileSync, existsSync, statSync, openSync, readSync, closeSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sanitizeEvidence } from './redact.js'
import type { Status, Verification, AuditState, TaskContract } from './audit.js'
export interface EvidenceRecord {
  schema_version: 2; event_id: string; host: 'dsh'; session_id: string
  task_id: string | null; objective_revision: number | null; requirement_ids: string[]
  turn_id: string | null; tool_call_id: string | null; source_kind: string
  operation: string; object_ids: string[]; object_version_digest: string | null
  result_status: Status; exit_code: number | null; output_ref: string | null
  started_at: string | null; ended_at: string | null; collector_version: string
  type: string; payload: unknown; occurred_at: string
}
export type Association = Partial<Omit<EvidenceRecord, 'schema_version' | 'host' | 'session_id' | 'type' | 'payload' | 'occurred_at'>>
function safeJson(value: unknown): unknown {
  try { return JSON.parse(JSON.stringify(sanitizeEvidence(value))) }
  catch { return { __unserializable__: true } }
}
/** Latest v2 record of a type among already-parsed records, payload cloned off the ledger. */
function latestIn<T>(records: EvidenceRecord[], type: string, taskId?: string): T | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]
    if (r.schema_version === 2 && r.type === type && (!taskId || r.task_id === taskId)) return structuredClone(r.payload) as T
  }
  return undefined
}
/** Call/result pairing uses durable IDs. A call alone or result alone is unknown. */
function callsIn(records: EvidenceRecord[]): Array<{ tool_call_id: string; status: Status; call?: EvidenceRecord; result?: EvidenceRecord }> {
  const groups = new Map<string, { tool_call_id: string; status: Status; call?: EvidenceRecord; result?: EvidenceRecord }>()
  for (const r of records) {
    if (!r.tool_call_id || !['tool.call', 'tool.result'].includes(r.type)) continue
    if (r.schema_version !== 2) continue
    const key = JSON.stringify([r.task_id, r.objective_revision, r.tool_call_id])
    const item = groups.get(key) ?? { tool_call_id: r.tool_call_id, status: 'unknown' as Status }
    if (r.type === 'tool.call') item.call = r
    else item.result = r
    item.status = item.call && item.result ? item.result.result_status : 'unknown'
    groups.set(key, item)
  }
  return [...groups.values()]
}
function verificationsIn(records: EvidenceRecord[], taskId: string): Verification[] {
  return records.filter(r => r.schema_version === 2 && r.task_id === taskId
    && r.type === 'requirement.verification').map(r => r.payload as Verification)
}
/** Append-only records; legacy rows remain readable but never become v2 proof. */
export class EvidenceLedger {
  readonly root: string
  private records: EvidenceRecord[] = []
  /** event_id -> first record with that id; makes idempotency/conflict checks O(1). */
  private index = new Map<string, EvidenceRecord>()
  /** session_id -> its records in append order, so every per-session query is O(session)
   * instead of O(ledger). The ledger grows forever; the queries must not. */
  private bySession = new Map<string, EvidenceRecord[]>()
  /** session_id -> the extents (contiguous byte runs) of its lines on disk. A single
   * `[first, last]` interval degenerates to the whole file as soon as two sessions interleave,
   * which is the normal case when more than one session is open; a list of runs keeps the read
   * proportional to what the session actually wrote. */
  private ranges = new Map<string, Array<{ start: number; end: number }>>()
  /** Byte offset of events.ndjson already loaded into memory; appends read only past it. */
  private offset = 0
  constructor(root?: string) {
    this.root = root ?? process.env.IRONLAW_EVIDENCE_ROOT ?? join(homedir(), '.ironlaw')
    mkdirSync(this.root, { recursive: true })
    const file = join(this.root, 'events.ndjson')
    if (existsSync(file)) {
      const buf = readFileSync(file)
      this.offset = buf.byteLength
      const raw = buf.toString('utf8')
      const lines = raw.split('\n')
      let lineStart = 0
      for (let i = 0; i < lines.length; i++) {
        const text = lines[i], width = Buffer.byteLength(text, 'utf8') + 1
        if (text.trim()) {
          try { this.ingest(JSON.parse(text), lineStart, lineStart + width) }
          catch { throw new Error('evidence_ledger_corrupt') }
        }
        lineStart += width
      }
      if (raw && !raw.endsWith('\n')) { appendFileSync(file, '\n'); this.offset += 1 }
    }
  }
  private ingest(record: EvidenceRecord, byteStart?: number, byteEnd?: number): void {
    this.records.push(record)
    const id = record && typeof record === 'object' ? record.event_id : undefined
    if (typeof id === 'string' && !this.index.has(id)) this.index.set(id, record)
    const sessionId = record && typeof record === 'object' ? record.session_id : undefined
    if (typeof sessionId !== 'string') return
    const list = this.bySession.get(sessionId)
    if (list) list.push(record); else this.bySession.set(sessionId, [record])
    if (byteStart === undefined || byteEnd === undefined) return
    const extents = this.ranges.get(sessionId)
    const last = extents?.at(-1)
    // Contiguous with the session's previous line -> extend; otherwise this is a new run.
    if (extents && last && last.end === byteStart) last.end = byteEnd
    else if (extents) extents.push({ start: byteStart, end: byteEnd })
    else this.ranges.set(sessionId, [{ start: byteStart, end: byteEnd }])
  }
  record(sessionId: string, type: string, payload: unknown, link: Association = {}): EvidenceRecord {
    return this.withLock(() => {
      this.readTail()
      return this.append(sessionId, type, payload, link)
    })
  }
  /** Fold in records other writers appended since this.offset; tolerate a torn trailing line. */
  private readTail(): void {
    const file = join(this.root, 'events.ndjson')
    if (!existsSync(file)) return
    const size = statSync(file).size
    if (size <= this.offset) return
    const chunk = this.readTailBytes(file, this.offset, size - this.offset).toString('utf8')
    const lastNewline = chunk.lastIndexOf('\n')
    if (lastNewline === -1) return
    const complete = chunk.slice(0, lastNewline)
    // All-or-nothing: parse the whole tail before ingesting any of it, and advance the
    // offset only after every line is in. Ingesting line by line meant a corrupt line
    // threw with the good prefix already folded in and the offset unmoved, so the next
    // call re-ingested that same prefix. recover() calls this once per turn, so one
    // corrupt line would duplicate the tail into memory on every turn.
    const pending: Array<{ record: EvidenceRecord; start: number; end: number }> = []
    let lineStart = this.offset
    for (const line of complete.split('\n')) {
      const width = Buffer.byteLength(line, 'utf8') + 1
      if (line.trim()) {
        try { pending.push({ record: JSON.parse(line), start: lineStart, end: lineStart + width }) }
        catch { throw new Error('evidence_ledger_corrupt') }
      }
      lineStart += width
    }
    for (const p of pending) this.ingest(p.record, p.start, p.end)
    this.offset += Buffer.byteLength(complete, 'utf8') + 1
  }
  /** Seam for tests to count bytes read; reads only [position, position+length). */
  private readTailBytes(file: string, position: number, length: number): Buffer {
    const fd = openSync(file, 'r')
    try {
      const buf = Buffer.allocUnsafe(length)
      let read = 0
      while (read < length) {
        const n = readSync(fd, buf, read, length - read, position + read)
        if (n <= 0) break
        read += n
      }
      return buf.subarray(0, read)
    } finally { closeSync(fd) }
  }
  /** Shared with context commit: no append between final validation and pointer swap. */
  withLock<T>(action: () => T): T {
    const file = join(this.root, 'events.lock'), fd = openSync(file, 'wx')
    try { return action() } finally { closeSync(fd); unlinkSync(file) }
  }
  private append(sessionId: string, type: string, payload: unknown, link: Association): EvidenceRecord {
    if (link.event_id) {
      const existing = this.index.get(link.event_id)
      if (existing) {
        if (existing.session_id !== sessionId || existing.type !== type
          || JSON.stringify(existing.payload) !== JSON.stringify(safeJson(payload))
          || Object.entries(link).some(([key, value]) => JSON.stringify(existing[key as keyof EvidenceRecord]) !== JSON.stringify(value))) throw new Error('evidence_event_id_conflict')
        return existing
      }
    }
    const record: EvidenceRecord = {
      schema_version: 2, event_id: randomUUID(), host: 'dsh', session_id: sessionId,
      task_id: null, objective_revision: null, requirement_ids: [], turn_id: null,
      tool_call_id: null, source_kind: 'host_event', operation: type, object_ids: [],
      object_version_digest: null, result_status: 'unknown', exit_code: null, output_ref: null,
      started_at: null, ended_at: null, collector_version: 'ironlaw/2.0-p2',
      ...link, type, payload: safeJson(payload), occurred_at: new Date().toISOString(),
    }
    const line = `${JSON.stringify(record)}\n`
    const width = Buffer.byteLength(line, 'utf8'), byteStart = this.offset
    appendFileSync(join(this.root, 'events.ndjson'), line)
    this.ingest(record, byteStart, byteStart + width)
    this.offset += width
    return record
  }
  /** True when this exact event id is already durably recorded for this session (O(1)). */
  hasEvent(sessionId: string, eventId: string): boolean {
    const r = this.index.get(eventId)
    return !!r && r.session_id === sessionId
  }
  snapshot(sessionId: string): EvidenceRecord[] { return structuredClone(this.bySession.get(sessionId) ?? []) }
  latest<T>(sessionId: string, type: string, taskId?: string): T | undefined {
    return latestIn<T>(this.bySession.get(sessionId) ?? [], type, taskId)
  }
  task(sessionId: string): TaskContract | undefined { return this.latest(sessionId, 'task.contract') }
  auditState(sessionId: string, taskId: string): AuditState | undefined { return this.latest(sessionId, 'completion.state', taskId) }
  calls(sessionId: string): Array<{ tool_call_id: string; status: Status; call?: EvidenceRecord; result?: EvidenceRecord }> {
    return callsIn(this.snapshot(sessionId))
  }
  verifications(sessionId: string, taskId: string): Verification[] {
    return verificationsIn(this.snapshot(sessionId), taskId)
  }
  /** The durable bytes holding this session's lines, or null when there are none. */
  private sessionBytes(sessionId: string): Buffer | null {
    const file = join(this.root, 'events.ndjson')
    if (!existsSync(file)) return null
    this.readTail() // fold in bytes another writer appended, so the extents are current
    const size = statSync(file).size
    if (size === 0) return null
    const extents = this.ranges.get(sessionId)
    if (!extents || !extents.length) return this.readTailBytes(file, 0, size)
    const chunks: Buffer[] = []
    for (const extent of extents) {
      const start = Math.max(0, Math.min(extent.start, size))
      const end = Math.max(start, Math.min(extent.end, size))
      if (end > start) chunks.push(this.readTailBytes(file, start, end - start))
    }
    return chunks.length ? Buffer.concat(chunks) : null
  }
  /**
   * Re-open the durable log for one session, never reconstruct authority or proof from a
   * summary. The bytes are re-read from disk, so a tampered or in-memory-only value cannot
   * become proof — but only the range that holds this session's lines is read, instead of
   * building a second whole ledger and re-parsing every session on every turn.
   */
  recover(sessionId: string) {
    const buf = this.sessionBytes(sessionId)
    const records: EvidenceRecord[] = []
    if (buf) {
      const raw = buf.toString('utf8'), lastNewline = raw.lastIndexOf('\n')
      const complete = lastNewline === -1 ? raw : raw.slice(0, lastNewline)
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { throw new Error('evidence_ledger_corrupt') }
        const r = parsed as EvidenceRecord
        if (r && typeof r === 'object' && r.session_id === sessionId) records.push(r)
      }
    }
    const task = latestIn<TaskContract>(records, 'task.contract')
    return { records, event_sequence: records.length, task,
      audit: task ? latestIn<AuditState>(records, 'completion.state', task.task_id) : undefined,
      evidence: task ? verificationsIn(records, task.task_id) : [],
      calls: callsIn(records) }
  }
}
