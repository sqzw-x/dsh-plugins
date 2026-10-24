/**
 * The one tsdown preset every TypeScript plugin in this repository builds with.
 *
 * Why it exists: each plugin needs the same two artifacts, and getting either
 * shape wrong fails silently in the browser.
 *
 *  - `lib/index.js` — the host half the profile composes. Every `@deepseek-ai/*`
 *    import is a peer provided by the running harness, so it is never bundled.
 *  - `lib/client.js` — the browser half, emitted as the lazy-CJS factory the
 *    page's module table calls (`window.__ModuleLoader__.load`). The factory id
 *    MUST equal the package name: the client roster keys modules by it, and a
 *    mismatch silently drops the module from the page.
 *
 * React is never bundled into the client half: the page serves its own copy, and
 * a second React in the bundle breaks hooks at runtime.
 *
 * @module dsh-plugin-toolkit/tsdown
 */
import type { UserConfig } from 'tsdown'

/**
 * Banner opening the lazy-CJS factory that owns the client module.
 * @param id - module id, which must equal the npm package name.
 * @returns the banner text.
 */
function clientBanner(id: string): string {
  return `window.__ModuleLoader__.load({
\tid: ${JSON.stringify(id)},
\tfactory: (require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;`
}

const CLIENT_FOOTER = `\t\treturn module.exports;
\t}
});`

/** Options for {@link pluginBuild}. */
export interface PluginBuildOptions {
  /** The client module id; must equal the package name. */
  id: string
  /** Emit `lib/client.js` (default: true). */
  client?: boolean
  /** Emit host type declarations (default: true). */
  dts?: boolean
  /** Wipe `lib/` before the host entry builds (default: true). */
  clean?: boolean
  /** Additional host-side entries merged over the same external/no-bundle defaults. */
  extraEntries?: UserConfig[]
}

/**
 * Build configuration for one plugin package.
 *
 * @param options - what to build.
 * @returns the tsdown config array.
 */
export function pluginBuild({ id, client = true, dts = true, clean = true, extraEntries = [] }: PluginBuildOptions): UserConfig[] {
  if (typeof id !== 'string' || id.trim() === '') throw new Error('pluginBuild: `id` must be the package name')
  const configs: UserConfig[] = [
    {
      entry: { index: 'src/index.ts' },
      outDir: 'lib',
      format: 'esm',
      platform: 'node',
      dts,
      clean,
      deps: { neverBundle: [/^@deepseek-ai\//] },
      outExtensions: () => ({ js: '.js' }),
    },
  ]
  for (const extra of extraEntries) {
    configs.push({
      outDir: 'lib',
      format: 'esm',
      platform: 'neutral',
      dts: true,
      deps: { neverBundle: [/^@deepseek-ai\//] },
      outExtensions: () => ({ js: '.js' }),
      ...extra,
    })
  }
  if (client) {
    configs.push({
      entry: { client: 'src/client.ts' },
      outDir: 'lib',
      format: 'cjs',
      platform: 'browser',
      dts: false,
      deps: { neverBundle: [/^react$/, /^react\//, /^@deepseek-ai\//] },
      outExtensions: () => ({ js: '.js' }),
      outputOptions: { banner: clientBanner(id), footer: CLIENT_FOOTER },
    })
  }
  return configs
}
