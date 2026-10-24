/**
 * Shared plumbing for the plugins in this repository.
 *
 * - `dsh-plugin-toolkit/tsdown` — the build preset (host ESM entry + browser
 *   lazy-CJS client bundle).
 * - `dsh-plugin-toolkit/test` — cordis test doubles, route drivers, and the
 *   bundle artifact contracts.
 *
 * @module dsh-plugin-toolkit
 */
export { pluginBuild } from './tsdown.ts'
export {
  FakeWebServer,
  assertClientBundle,
  assertHostBundle,
  callRoute,
  makeRequest,
  makeResponse,
  mountPromptRegistry,
  tick,
} from './test.ts'
