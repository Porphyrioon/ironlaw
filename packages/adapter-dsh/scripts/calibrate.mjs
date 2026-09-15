import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { calibrate } from '@ironlaw/adapter-dsh'
const file = process.argv[2] ?? new URL('../fixtures/p3-trace.json', import.meta.url)
const raw = readFileSync(file, 'utf8')
const fixture = JSON.parse(raw)
console.log(JSON.stringify({ fixture_sha256: createHash('sha256').update(raw).digest('hex'),
  provenance: fixture.provenance, ...calibrate(fixture.slices) }, null, 2))
