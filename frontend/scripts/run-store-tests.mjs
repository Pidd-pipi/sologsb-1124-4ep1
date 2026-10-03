/**
 * 用 esbuild 即时打包 store 集成测试后交给 node 运行。
 * 用法：node scripts/run-store-tests.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'node_modules/.cache/auction-store-tests.mjs')

await build({
  entryPoints: [resolve(root, 'tests/auctionStore.test.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile,
  alias: { '@': resolve(root, 'src') }
})

try {
  await import(outfile)
} catch (err) {
  console.error(err)
  process.exitCode = 1
}
