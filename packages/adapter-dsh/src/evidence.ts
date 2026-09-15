import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
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
  constructor(root?: string) {
    this.root = root ?? process.env.IRONLAW_EVIDENCE_ROOT ?? join(homedir(), '.ironlaw')
    mkdirSync(this.root, { recursive: true })
    const file = join(this.root, 'events.ndjson')
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      const lines = raw.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue
        try { this.records.push(JSON.parse(lines[i])) }
        catch { throw new Error('evidence_ledger_corrupt') }
      }
      if (raw && !raw.endsWith('\n')) appendFileSync(file, '\n')
    }
  }
  record(sessionId: string, type: string, payload: unknown, link: Association = {}): EvidenceRecord {
    if (link.event_id) {
      const existing = this.records.find(r => r.event_id === link.event_id)
      if (existing) {
        if (existing.session_id !== sessionId || existing.type !== type
          || JSON.stringify(existing.payload) !== JSON.stringify(safeJson(payload))) throw new Error('evidence_event_id_conflict')
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
    appendFileSync(join(this.root, 'events.ndjson'), `${JSON.stringify(record)}\n`)
    this.records.push(record)
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
      const key = JSON.stringify([r.task_id, r.tool_call_id])
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
}
