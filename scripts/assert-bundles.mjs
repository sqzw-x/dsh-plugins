#!/usr/bin/env node
/**
 * Repo-wide bundle contract check.
 *
 * Each package's own tests already assert what it ships, but those tests can be
 * narrowed or skipped. This walks every package that declares a DSH bundle and
 * checks the two artifacts the loader actually consumes:
 *
 *  - `lib/index.js` is importable and exports `apply`;
 *  - `lib/client.js`, when declared, is the lazy-CJS module-table factory with
 *    the package name as its id.
 *
 * Run after `pnpm build`; CI does that through `pnpm verify`.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertClientBundle, assertHostBundle } from 'dsh-plugin-toolkit/test'

const root = new URL('..', import.meta.url).pathname
const failures = []
const checked = []

for (const name of readdirSync(join(root, 'packages'))) {
  const dir = join(root, 'packages', name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dsh === undefined) continue

  const hostEntry = join(dir, 'lib', 'index.js')
  if (!existsSync(hostEntry)) {
    failures.push(`${manifest.name}: lib/index.js is missing (run pnpm build)`)
    continue
  }
  try {
    await assertHostBundle(hostEntry)
    checked.push(`${manifest.name}: host ok`)
  } catch (error) {
    failures.push(`${manifest.name}: ${error instanceof Error ? error.message : String(error)}`)
  }

  const clientEntry = join(dir, 'lib', 'client.js')
  if (manifest.dsh.client !== undefined) {
    if (!existsSync(clientEntry)) {
      failures.push(`${manifest.name}: declares dsh.client but lib/client.js is missing`)
      continue
    }
    try {
      assertClientBundle(clientEntry, manifest.name)
      checked.push(`${manifest.name}: client ok`)
    } catch (error) {
      failures.push(`${manifest.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

for (const line of checked) console.log(`  ✓ ${line}`)
if (failures.length > 0) {
  console.error('\nBundle contract failures:')
  for (const failure of failures) console.error(`  ✗ ${failure}`)
  process.exit(1)
}
console.log(`\n${checked.length} bundle contract(s) verified.`)
