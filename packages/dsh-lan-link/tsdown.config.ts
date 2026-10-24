import { pluginBuild } from 'dsh-plugin-toolkit/tsdown'

// `gateway` is its own public entry (`exports["./gateway"]`, and the tests import
// it directly) while `index` re-exports `startLanGateway` for plugin users.
export default pluginBuild({
  id: 'dsh-lan-link',
  client: false,
  extraEntries: [{ entry: { gateway: 'src/gateway.ts' }, dts: true, platform: 'node' }],
})
