import { EvidenceLedger } from './evidence.js'
import { ContextStore, type ArchiveIndex } from './context.js'
import { openSync, closeSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

export interface RetrievalSignal {
  dependency_refs: string[]; state_digest: string; explicit_request_ref?: string
  /** Ranking only; deliberately ignored by the loading gate. */
  similarity?: number
}
interface Seen { dependencies: string[]; state: string; requests: string[] }
/** Trusted host validates provenance/scope/version and signal references. Returned data
 * still goes through AdmissionController; retrieval never grants instruction authority. */
export class DependencyRetriever {
  constructor(readonly store: ContextStore) {}
  retrieve(session: string, entry: ArchiveIndex, signal: RetrievalSignal,
    validate: (entry: ArchiveIndex, signal: RetrievalSignal) => boolean) {
    const ledger = this.store.ledger
    // Separate retrieval lock serializes read/consume; ledger.record owns events.lock.
    const lock = join(ledger.root, 'retrieval.lock'), fd = openSync(lock, 'wx')
    try {
      const state = new EvidenceLedger(ledger.root).latest<Record<string, Seen>>(session, 'retrieval.state') ?? {}
      const key = JSON.stringify([entry.id, entry.source_ref])
      const old = state[key]
      if (!signal.state_digest || !validate(structuredClone(entry), structuredClone(signal)))
        return { status: 'missing' as const, reason: 'unverified_source_version_scope_or_signal' }
      const dependency = signal.dependency_refs.some(ref => ref && !old?.dependencies.includes(ref))
      const request = !!signal.explicit_request_ref && !old?.requests.includes(signal.explicit_request_ref)
      const changed = !!old && old.state !== signal.state_digest
      if (!dependency && !request && !changed) return { status: 'not_loaded' as const, reason: 'no_new_signal' }
      // Consume even failed attempts: automatic repeated similarity searches cannot retry forever.
      state[key] = { dependencies: [...new Set([...(old?.dependencies ?? []), ...signal.dependency_refs])],
        requests: [...new Set([...(old?.requests ?? []), ...(signal.explicit_request_ref ? [signal.explicit_request_ref] : [])])],
        state: signal.state_digest }
      ledger.record(session, 'retrieval.state', state)
      return this.store.retrieve(session, entry)
    } finally { closeSync(fd); unlinkSync(lock) }
  }
}
