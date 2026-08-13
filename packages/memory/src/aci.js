// ACI: memory actively injected into the model's context, driven by the memory holder.
export function formatInjection(query, results) {
  if (!results || results.length === 0) return ""
  const lines = results.map(r => {
    const summary = typeof r.value === "string"
      ? r.value.replace(/\s+/g, " ").slice(0, 200)
      : JSON.stringify(r.value).slice(0, 200)
    return `- [${r.key}] ${summary}`
  })
  return `## Memory (relevant to: ${query})\n\n${lines.join("\n")}`
}
