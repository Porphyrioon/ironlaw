/**
 * Secret redaction for the evidence ledger. Matches the redaction rules used
 * by @ironlaw/memory so both packages share one redaction contract.
 */

const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|authorization|cookie|credential|private[_-]?key|github[_-]?token)/i
const SECRET = /((?:api[_-]?key|access[_-]?token|refresh[_-]?token|github[_-]?token|password|secret|authorization|cookie)\s*[:=]\s*)[^\s,]+/gi
const JSON_SECRET = /("(?:api[_-]?key|access[_-]?token|refresh[_-]?token|github[_-]?token|password|secret|authorization|cookie|credential)[^"]*"\s*:\s*")[^"]*(")/gi
const ENV_SECRET = /(sk-[A-Za-z0-9_-]+|ark-[A-Za-z0-9_-]+|Bearer\s+[A-Za-z0-9._-]+)/g
// any scheme://user:pass@host — covers https, postgres, mysql, redis, mongodb, …
const URL_SECRET = /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi
const PEM = /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g

function redact(value: string): string {
  return value
    .replace(PEM, '[REDACTED_PRIVATE_KEY]')
    .replace(URL_SECRET, '$1[REDACTED]:[REDACTED]@')
    .replace(JSON_SECRET, '$1[REDACTED]$2')
    .replace(SECRET, '$1[REDACTED]')
    .replace(ENV_SECRET, '[REDACTED]')
    .slice(0, 12000)
}

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[DEPTH_LIMIT]'
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => sanitize(item, depth + 1))
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1),
      ]),
    )
  }
  return value
}

export function sanitizeEvidence(value: unknown): unknown {
  return sanitize(value)
}
