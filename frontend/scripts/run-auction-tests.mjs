/**
 * 拍卖台账领域逻辑测试入口：用 esbuild 把 TS 测试打成单个 ESM 再执行。
 * 不引入 jest/vitest 等额外依赖；断言失败时进程退出码非 0。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.dirname(fileURLToPath(import.meta.url))

const result = await build({
  entryPoints: [path.join(root, 'test-auction.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '@': path.join(root, '..', 'src') },
  logLevel: 'silent'
})

const code = result.outputFiles[0].text
const dataUrl = 'data:text/javascript;base64,' + Buffer.from(code).toString('base64')

try {
  await import(dataUrl)
} catch (e) {
  console.error(e)
  process.exit(1)
}
