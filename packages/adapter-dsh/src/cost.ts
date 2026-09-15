export interface Usage {
  call_id: string; task_id: string; usage_ref: string
  kind: 'main' | 'summary' | 'retrieval'; input_tokens: number
  cached_input: number; cache_write: number; output: number
  /** Explicit provider convention: whether input_tokens includes cache writes. */
  input_includes_write: boolean
  latency_ms: number; retry: boolean; rework: boolean; service_cost: number
}
export interface Rates { cached_input: number; uncached_input: number; cache_write: number; output: number }
export function taskCost(taskId: string, calls: Usage[], rates: Rates) {
  const categories: Rates = { cached_input: 0, uncached_input: 0, cache_write: 0, output: 0 }
  if (!(['cached_input', 'uncached_input', 'cache_write', 'output'] as const)
    .every(key => Number.isFinite(rates[key]) && rates[key] >= 0)) throw new Error('cost_rate_invalid')
  const seen = new Map<string, string>()
  let latency_ms = 0, retries = 0, rework = 0, auxiliary_calls = 0, service_cost = 0
  for (const call of calls) {
    if (call.task_id !== taskId) throw new Error('cost_task_mismatch')
    if (!call.call_id || !call.usage_ref || !['main', 'summary', 'retrieval'].includes(call.kind)
      || typeof call.input_includes_write !== 'boolean' || typeof call.retry !== 'boolean' || typeof call.rework !== 'boolean'
      || ![call.input_tokens, call.cached_input, call.cache_write, call.output].every(n => Number.isSafeInteger(n) && n >= 0)
      || ![call.latency_ms, call.service_cost].every(n => Number.isFinite(n) && n >= 0)) throw new Error('cost_usage_invalid')
    const encoded = JSON.stringify(call)
    if (seen.has(call.call_id)) {
      if (seen.get(call.call_id) !== encoded) throw new Error('cost_duplicate_conflict')
      continue
    }
    seen.set(call.call_id, encoded)
    const uncached = call.input_tokens - call.cached_input - (call.input_includes_write ? call.cache_write : 0)
    if (uncached < 0) throw new Error('cost_overlapping_input_categories')
    categories.cached_input += call.cached_input; categories.uncached_input += uncached
    categories.cache_write += call.cache_write; categories.output += call.output
    latency_ms += call.latency_ms; retries += Number(call.retry); rework += Number(call.rework)
    auxiliary_calls += Number(call.kind !== 'main'); service_cost += call.service_cost
  }
  const denominator = categories.cached_input + categories.uncached_input + categories.cache_write
  const costs: Rates = { cached_input: categories.cached_input * rates.cached_input,
    uncached_input: categories.uncached_input * rates.uncached_input,
    cache_write: categories.cache_write * rates.cache_write, output: categories.output * rates.output }
  if (!Object.values(categories).every(Number.isSafeInteger) || !Number.isSafeInteger(denominator)
    || !Number.isFinite(Object.values(costs).reduce((a, b) => a + b, service_cost))
    || !Number.isFinite(latency_ms)) throw new Error('cost_numeric_overflow')
  return { task_id: taskId, categories, costs, total_cost: Object.values(costs).reduce((a, b) => a + b, service_cost),
    service_cost, calls: seen.size, auxiliary_calls, latency_ms_sum: latency_ms, retries, rework,
    hit_rate: { numerator: categories.cached_input, denominator, denominator_definition: 'all input tokens including writes',
      value: denominator ? categories.cached_input / denominator : null } }
}
