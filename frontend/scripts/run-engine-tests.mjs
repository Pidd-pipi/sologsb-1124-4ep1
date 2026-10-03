/**
 * 用 esbuild 即时打包 TS 单测后交给 node 运行（无需 Jest/Vitest）。
 * 用法：node scripts/run-engine-tests.mjs
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outfile = resolve(root, 'node_modules/.cache/auction-engine-tests.mjs')

await build({
  entryPoints: [resolve(root, 'tests/auctionEngine.test.ts')],
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
