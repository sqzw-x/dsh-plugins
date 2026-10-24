/**
 * Keep `src/version.ts` in lockstep with `package.json`.
 *
 * `npm version` runs this through the package's `version` lifecycle script,
 * before it commits and tags, and the script stages the rewritten file. The
 * manifest test still asserts the two match, so a release cannot drift.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const file = new URL('../src/version.ts', import.meta.url)
const source = readFileSync(file, 'utf8')
const next = source.replace(/export const VERSION = '[^']+'/, `export const VERSION = '${pkg.version}'`)

if (next === source) {
  console.log(`src/version.ts already at ${pkg.version}`)
} else {
  writeFileSync(file, next)
  console.log(`src/version.ts -> ${pkg.version}`)
}
