// BM25 retrieval over Memory Graph nodes. Implementation detail of memory.search.
export function tokenize(text) {
  const tokens = []
  const s = String(text).toLowerCase()
  for (const m of s.matchAll(/[a-z0-9]+/g)) tokens.push(m[0])
  for (const m of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0]
    for (const ch of seg) tokens.push(ch)
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
  }
  return tokens
}

export function bm25Search(docs, query, k = 10) {
  const N = docs.length
  if (N === 0) return []
  const k1 = 1.5
  const b = 0.75

  const docTokens = docs.map(d => tokenize(d.text))
  const docLen = docTokens.map(t => t.length)
  const avgdl = docLen.reduce((a, c) => a + c, 0) / N

  const inverted = new Map()
  docTokens.forEach((tokens, i) => {
    const freq = new Map()
    for (const t of tokens) freq.set(t, (freq.get(t) || 0) + 1)
    for (const [t, f] of freq) {
      if (!inverted.has(t)) inverted.set(t, [])
      inverted.get(t).push([i, f])
    }
  })

  const scores = new Map()
  for (const qt of new Set(tokenize(query))) {
    const postings = inverted.get(qt)
    if (!postings) continue
    const idf = Math.log((N - postings.length + 0.5) / (postings.length + 0.5) + 1)
    for (const [i, f] of postings) {
      const denom = f + k1 * (1 - b + b * docLen[i] / avgdl)
      scores.set(i, (scores.get(i) || 0) + idf * (f * (k1 + 1)) / denom)
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([i, score]) => ({ key: docs[i].key, value: docs[i].value, tags: docs[i].tags, scope: docs[i].scope, source: docs[i].source, updated_ts: docs[i].updated_ts, score: Math.round(score * 1000) / 1000 }))
}
