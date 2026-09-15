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
/** Append-only records; legacy rows remain readable but never become v2 proof. */
export class EvidenceLedger {
  readonly root: string
  private records: EvidenceRecord[] = []
  /** event_id -> first record with that id; makes idempotency/conflict checks O(1). */
  private index = new Map<string, EvidenceRecord>()
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
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue
        try { this.ingest(JSON.parse(lines[i])) }
        catch { throw new Error('evidence_ledger_corrupt') }
      }
      if (raw && !raw.endsWith('\n')) { appendFileSync(file, '\n'); this.offset += 1 }
    }
  }
  private ingest(record: EvidenceRecord): void {
    this.records.push(record)
    const id = record && typeof record === 'object' ? record.event_id : undefined
    if (typeof id === 'string' && !this.index.has(id)) this.index.set(id, record)
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
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue
      try { this.ingest(JSON.parse(line)) }
      catch { throw new Error('evidence_ledger_corrupt') }
    }
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
      started_at: null, ended_at: null, collector_version: 'ironlaw/2.0-p1',
      ...link, type, payload: safeJson(payload), occurred_at: new Date().toISOString(),
    }
    const line = `${JSON.stringify(record)}\n`
    appendFileSync(join(this.root, 'events.ndjson'), line)
    this.ingest(record)
    this.offset += Buffer.byteLength(line, 'utf8')
    return record
  }
  snapshot(sessionId: string): EvidenceRecord[] { return structuredClone(this.records.filter(r => r.session_id === sessionId)) }
  latest<T>(sessionId: string, type: string, taskId?: string): T | undefined {
    const r = this.records.filter(r => r.schema_version === 2 && r.session_id === sessionId
      && r.type === type && (!taskId || r.task_id === taskId)).at(-1)
    return r ? structuredClone(r.payload) as T : undefined
  }
  task(sessionId: string): TaskContract | undefined { return this.latest(sessionId, 'task.contract') }
  auditState(sessionId: string, taskId: string): AuditState | undefined { return this.latest(sessionId, 'completion.state', taskId) }
  /** Call/result pairing uses durable IDs. A call alone or result alone is unknown. */
  calls(sessionId: string): Array<{ tool_call_id: string; status: Status; call?: EvidenceRecord; result?: EvidenceRecord }> {
    const groups = new Map<string, { tool_call_id: string; status: Status; call?: EvidenceRecord; result?: EvidenceRecord }>()
    for (const r of this.snapshot(sessionId)) {
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
  verifications(sessionId: string, taskId: string): Verification[] {
    return this.snapshot(sessionId).filter(r => r.schema_version === 2 && r.task_id === taskId
      && r.type === 'requirement.verification').map(r => r.payload as Verification)
  }
  /** Re-open the durable log, never reconstruct authority or proof from a summary. */
  recover(sessionId: string) {
    const durable = new EvidenceLedger(this.root)
    const records = durable.snapshot(sessionId)
    const task = durable.task(sessionId)
    return { records, event_sequence: records.length, task,
      audit: task ? durable.auditState(sessionId, task.task_id) : undefined,
      evidence: task ? durable.verifications(sessionId, task.task_id) : [],
      calls: durable.calls(sessionId) }
  }
}
