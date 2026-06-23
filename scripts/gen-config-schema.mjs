// scripts/gen-config-schema.mjs — generate docs/strategy.config.schema.json from the canonical
// Zod schema (src/config/schema.ts). Run via `npm run gen:schema` (compiles first, then this).
// The committed JSON Schema is the trackable reference operators/CI use to validate
// strategy.config.json; regenerate + commit whenever StrategyConfigSchema changes.
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { StrategyConfigSchema } from '../dist/config/schema.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'strategy.config.schema.json')

const schema = zodToJsonSchema(StrategyConfigSchema, {
  name: 'StrategyConfig',
  $refStrategy: 'none',
})

writeFileSync(out, JSON.stringify(schema, null, 2) + '\n')
console.error(`wrote ${out}`)
