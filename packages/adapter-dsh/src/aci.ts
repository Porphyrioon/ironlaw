import { EvidenceLedger } from './evidence.js'

export interface AdmissionEntry {
  id: string; version: string; text: string; source_kind: string; source_ref: string
  scope: string; tier: 'hard' | 'dependency' | 'optional'; state_digest: string
  dependency_refs: string[]; explicit_request_ref?: string
  /** Ranking signal only, never a confidence probability or a re-entry signal. */
  similarity?: number
  rule?: { rule_id: string; authority: string; target: string; trigger: string; exit: string; superseded_by?: string }
}
export interface AdmissionBudget {
  context_tokens: number; output_reserve: number; tool_result_reserve: number
  per_injection: number; active_memory: number; per_entry: number; consecutive_retrievals: number
}
export interface AdmissionRenderer {
  /** The model's fixed tokenizer, supplied by the trusted host integration. */
  countTokens: (rendered: string) => number
  /** Must include system/tools/user/tail/index/protocol wrappers, with all active memory. */
  renderContext: (active: AdmissionEntry[]) => string
  /** Includes memory protocol wrappers, not just entry.text. */
  renderMemory: (active: AdmissionEntry[]) => string
  /** Trusted authority/version/scope resolver; validate re-entry refs here too. */
  validate: (entry: AdmissionEntry) => boolean
}
interface AdmissionState {
  active: AdmissionEntry[]; evicted: AdmissionEntry[]; consecutive: number
}
export interface AdmissionResult {
  status: 'admitted' | 'configuration_unsatisfiable'; active: AdmissionEntry[]; injected: AdmissionEntry[]
  rejected: Array<{ id: string; reason: string }>; rendered: string; tokens: number
}
/** Session-scoped durable ACI state: compact/restart cannot reset the eviction gate. */
export class AdmissionController {
  constructor(readonly ledger: EvidenceLedger) {}
  private state(sessionId: string): AdmissionState {
    return new EvidenceLedger(this.ledger.root).latest(sessionId, 'aci.state') ?? { active: [], evicted: [], consecutive: 0 }
  }
  private save(sessionId: string, state: AdmissionState) { this.ledger.record(sessionId, 'aci.state', state) }
  evict(sessionId: string, ids: string[]): void {
    const state = this.state(sessionId), removed = state.active.filter(e => ids.includes(e.id))
    if (removed.some(e => e.tier === 'hard')) throw new Error('aci_hard_constraint_cannot_evict')
    state.evicted = [...state.evicted.filter(e => !removed.some(r => r.id === e.id)), ...removed]
    state.active = state.active.filter(e => !ids.includes(e.id))
    this.save(sessionId, state)
  }
  /** Call only after a real non-retrieval host step, not another similarity search. */
  endRetrievalChain(sessionId: string): void {
    const state = this.state(sessionId); state.consecutive = 0; this.save(sessionId, state)
  }
  admit(sessionId: string, candidates: AdmissionEntry[], budget: AdmissionBudget, renderer: AdmissionRenderer): AdmissionResult {
    if (!Object.values(budget).every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('aci_budget_invalid')
    const count = (text: string) => {
      const n = renderer.countTokens(text)
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('aci_token_count_invalid')
      return n
    }
    const state = this.state(sessionId), previous = structuredClone(state.active)
    const rejected: AdmissionResult['rejected'] = [], injected: AdmissionEntry[] = []
    const render = (active: AdmissionEntry[]) => renderer.renderContext(structuredClone(active))
    const memory = (active: AdmissionEntry[]) => count(renderer.renderMemory(structuredClone(active)))
    const fits = (active: AdmissionEntry[]) => count(render(active)) + budget.output_reserve + budget.tool_result_reserve <= budget.context_tokens
      && memory(active) <= budget.active_memory
    const fail = (id: string, reason: string): AdmissionResult => ({ status: 'configuration_unsatisfiable', active: previous,
      injected: [], rejected: [...rejected, { id, reason }], rendered: render(previous), tokens: count(render(previous)) })
    // Stable rules stay resident. Stale/unauthorized items cannot silently become instructions.
    if (state.active.some(e => !renderer.validate(structuredClone(e)) || memory([e]) > budget.per_entry) || !fits(state.active))
      return fail('$active', 'active_context_requires_reconfiguration')
    state.consecutive++
    const rank = { hard: 0, dependency: 1, optional: 2 }, seen = new Set<string>()
    const contentKey = (e: AdmissionEntry) => JSON.stringify([e.source_kind, e.source_ref, e.version, e.scope, e.tier, e.rule, e.text])
    const content = new Set(state.active.map(contentKey))
    for (const candidate of [...candidates].sort((a, b) => rank[a.tier] - rank[b.tier])) {
      const e = structuredClone(candidate)
      const reject = (reason: string) => rejected.push({ id: e.id, reason })
      if (seen.has(e.id)) { reject('duplicate'); continue }
      seen.add(e.id)
      const resident = state.active.find(a => a.id === e.id)
      if (resident && JSON.stringify(resident) === JSON.stringify(e)) { reject('already_active'); continue }
      if (!e.id || !e.version || !e.source_ref || !e.scope || !e.state_digest
        || !['hard', 'dependency', 'optional'].includes(e.tier) || !renderer.validate(structuredClone(e))) {
        if (e.tier === 'hard') return fail(e.id, 'hard_authority_version_scope_unknown')
        reject('authority_version_scope_unknown'); continue
      }
      if (!resident && content.has(contentKey(e))) { reject('duplicate_content'); continue }
      const removed = state.evicted.find(a => a.id === e.id || contentKey(a) === contentKey(e))
      if (removed && e.state_digest === removed.state_digest && e.version === removed.version
        && !e.dependency_refs.some(ref => !removed.dependency_refs.includes(ref))
        && !(e.explicit_request_ref && e.explicit_request_ref !== removed.explicit_request_ref)) {
        reject('evicted_without_new_signal'); continue
      }
      if (resident?.tier === 'hard' && e.tier !== 'hard') return fail(e.id, 'hard_authority_change_requires_resolution')
      const next = [...state.active.filter(a => a.id !== e.id), e]
      const reason = state.consecutive > budget.consecutive_retrievals ? 'retrieval_limit'
        : memory([e]) > budget.per_entry ? 'entry_limit'
        : memory([...injected, e]) > budget.per_injection ? 'injection_limit'
        : !fits(next) ? 'context_or_active_memory_limit' : undefined
      if (reason) {
        if (e.tier === 'hard') return fail(e.id, reason)
        reject(reason); continue
      }
      state.active = next; injected.push(e); content.add(contentKey(e))
    }
    // One persisted state event, including rejected retrievals, before returning anything to inject.
    this.save(sessionId, state)
    return { status: 'admitted', active: state.active, injected, rejected, rendered: render(state.active), tokens: count(render(state.active)) }
  }
}
