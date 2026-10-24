import { pluginBuild } from 'dsh-plugin-toolkit/tsdown'

// `engine` is exported as its own ESM entry so the rules can be unit-tested (and
// reused) without a browser; the preset builds it alongside the host and client.
export default pluginBuild({
  id: 'dsh-focus-notify',
  extraEntries: [{ entry: { engine: 'src/engine.ts' }, dts: true, platform: 'neutral' }],
})
