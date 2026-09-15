export interface TraceEntry {
  id: string; sequence: number; text: string; units: number; similarity: number
  dependencies: string[]; state?: { key: string; value: string; version: string }
  evidence?: { ref: string; version: string; readable: boolean }
}
export interface TraceSlice {
  id: string; task_id: string; source_ref: string; budget_units: number
  entries: TraceEntry[]; roots: { goals: string[]; constraints: string[]; pending_steps: string[] }
  /** Frozen independent evaluation labels, never consumed by selection. */
  oracle: { constraints: string[]; critical: string[]; states: Array<{ key: string; value: string; version: string }>;
    evidence: Array<{ ref: string; version: string }> }
}
export type Strategy = 'dependency' | 'age' | 'similarity' | 'length'
const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, value: denominator ? numerator / denominator : null })
export function selectSlice(slice: TraceSlice, strategy: Strategy) {
  if (!['dependency', 'age', 'similarity', 'length'].includes(strategy)
    || !Number.isSafeInteger(slice.budget_units) || slice.budget_units < 0
    || new Set(slice.entries.map(e => e.id)).size !== slice.entries.length
    || slice.entries.some(e => !e.id || !Number.isSafeInteger(e.units) || e.units <= 0
      || !Number.isFinite(e.sequence) || !Number.isFinite(e.similarity))) throw new Error('calibration_trace_invalid')
  const byId = new Map(slice.entries.map(e => [e.id, e]))
  const selected = new Set<string>(), missing = new Set<string>()
  let used = 0, unsatisfiable = false
  const closure = (id: string, pack: Set<string>): boolean => {
    if (pack.has(id) || selected.has(id)) return true
    const entry = byId.get(id)
    if (!entry) { missing.add(id); return false }
    pack.add(id)
    return entry.dependencies.map(d => closure(d, pack)).every(Boolean)
  }
  const add = (pack: Set<string>) => {
    const cost = [...pack].reduce((n, id) => n + byId.get(id)!.units, 0)
    if (used + cost > slice.budget_units) return false
    pack.forEach(id => selected.add(id)); used += cost; return true
  }
  if (strategy === 'dependency') {
    const required = new Set<string>()
    ;[...slice.roots.goals, ...slice.roots.constraints].forEach(id => closure(id, required))
    if (missing.size || !add(required)) unsatisfiable = true
    if (!unsatisfiable) for (const id of slice.roots.pending_steps) {
      const pack = new Set<string>(); if (closure(id, pack)) add(pack)
    }
  } else {
    const rank = [...slice.entries].sort((a, b) => (strategy === 'age' ? b.sequence - a.sequence
      : strategy === 'similarity' ? b.similarity - a.similarity : a.units - b.units) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const entry of rank) add(new Set([entry.id]))
  }
  return { selected: [...selected], used_units: used, configuration_unsatisfiable: unsatisfiable, missing_dependencies: [...missing] }
}
export function calibrate(slices: TraceSlice[]) {
  const strategies: Strategy[] = ['dependency', 'age', 'similarity', 'length']
  const rows = slices.flatMap(slice => strategies.map(strategy => {
    const selection = selectSlice(slice, strategy), ids = new Set(selection.selected)
    const retained = slice.entries.filter(e => ids.has(e.id))
    const states = new Map<string, NonNullable<TraceEntry['state']>>()
    for (const e of [...retained].sort((a, b) => a.sequence - b.sequence)) if (e.state) states.set(e.state.key, e.state)
    // Evidence is recoverable only as a complete dependency package, including version/conditions.
    const complete = (id: string, visited = new Set<string>()): boolean => {
      if (visited.has(id)) return true
      visited.add(id)
      const e = retained.find(e => e.id === id)
      return !!e && e.dependencies.every(d => complete(d, visited))
    }
    return { slice_id: slice.id, strategy, ...selection,
      constraint_retention: ratio(slice.oracle.constraints.filter(id => ids.has(id)).length, slice.oracle.constraints.length),
      state_accuracy: ratio(slice.oracle.states.filter(s => { const got = states.get(s.key); return got?.value === s.value && got.version === s.version }).length, slice.oracle.states.length),
      evidence_recovery: ratio(slice.oracle.evidence.filter(want => retained.some(e => e.evidence?.readable && e.evidence.ref === want.ref && e.evidence.version === want.version && complete(e.id))).length, slice.oracle.evidence.length),
      critical_deletion: ratio(slice.oracle.critical.filter(id => !ids.has(id)).length, slice.oracle.critical.length) }
  }))
  const metrics = ['constraint_retention', 'state_accuracy', 'evidence_recovery', 'critical_deletion'] as const
  const aggregate = strategies.map(strategy => ({ strategy, metrics: Object.fromEntries(metrics.map(metric => {
    const group = rows.filter(row => row.strategy === strategy)
    return [metric, ratio(group.reduce((n, row) => n + row[metric].numerator, 0), group.reduce((n, row) => n + row[metric].denominator, 0))]
  })) }))
  const differences = aggregate.slice(1).map(baseline => ({ baseline: baseline.strategy,
    dependency_minus_baseline: Object.fromEntries(metrics.map(metric => {
      const a = aggregate[0].metrics[metric].value, b = baseline.metrics[metric].value
      return [metric, a === null || b === null ? null : a - b]
    })) }))
  return { schema_version: 1, evidence_level: 'offline_fixture_replay', production_benefit: 'evidence_insufficient',
    confidence_interval: null, confidence_interval_reason: 'No independent full-task execution sample; deterministic slices are not statistical replicates',
    tokenizer: 'explicit fixture units; not model tokens', aggregation: 'micro: sum numerators / sum denominators', aggregate, differences, rows }
}
