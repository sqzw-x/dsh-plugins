/**
 * Single source of truth for the version reported by `window.__dshFocusNotify`.
 *
 * `test/manifest.test.mjs` asserts it matches package.json, so a release cannot
 * drift from what the page reports.
 */
export const VERSION = '0.3.0'
