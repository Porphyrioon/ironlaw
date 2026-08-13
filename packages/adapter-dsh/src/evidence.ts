import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { sanitizeEvidence } from './redact.js'

/**
 * One line of the append-only evidence ledger.
 *
 * The ledger is host-agnostic: `host` is `'dsh'` for this adapter, but the
 * schema is shared with the other IronLaw adapters so the same evidence chain
 * can span multiple hosts. It is deliberately NOT tied to any single
 * framework's session model.
 */
export interface EvidenceRecord {
  event_id: string
  host: 'dsh'
  session_id: string
  type: string
  payload: unknown
  occurred_at: string
}

function safeJson(value: unknown): unknown {
  try {
    const sanitized = sanitizeEvidence(value)
    return JSON.parse(JSON.stringify(sanitized))
  } catch {
    return { __unserializable__: true }
  }
}

export class EvidenceLedger {
  readonly root: string

  constructor(root?: string) {
    this.root = root ?? process.env.IRONLAW_EVIDENCE_ROOT ?? join(homedir(), '.ironlaw')
    mkdirSync(this.root, { recursive: true })
  }

  record(sessionId: string, type: string, payload: unknown): void {
    const record: EvidenceRecord = {
      event_id: randomUUID(),
      host: 'dsh',
      session_id: sessionId,
      type,
      payload: safeJson(payload),
      occurred_at: new Date().toISOString(),
    }
    appendFileSync(join(this.root, 'events.ndjson'), `${JSON.stringify(record)}\n`)
  }
}
