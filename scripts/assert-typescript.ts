#!/usr/bin/env node
/**
 * The repository's language contract: every tracked source file is TypeScript.
 * Build output (`lib/`) is generated, ignored, and never tracked.
 *
 * Run in CI as part of `pnpm verify`. `git ls-files` is deliberate: it checks
 * what will actually be reviewed and published, not whatever happens to sit in
 * a working tree after a build.
 */
import { execFileSync } from 'node:child_process'

const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file !== '')

const offenders = files.filter((file) => /\.(js|mjs|cjs|jsx)$/.test(file))
if (offenders.length > 0) {
  console.error('assert-typescript: tracked JavaScript files are not allowed:')
  for (const file of offenders) console.error(`  - ${file}`)
  console.error('Convert them to .ts/.tsx (tests and scripts run through Node type stripping).')
  process.exitCode = 1
} else {
  console.log(`assert-typescript: ${String(files.length)} tracked files, no JavaScript source.`)
}
