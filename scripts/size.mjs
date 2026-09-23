// Report the minified + gzipped size of dist/mini.js (run `npm run build` first).
import { readFileSync } from 'node:fs'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { build } from 'vite'

const out = await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    write: false,
    minify: true,
    lib: { entry: new URL('../mini.ts', import.meta.url).pathname, formats: ['es'], fileName: 'mini' },
  },
})
const code = [out].flat()[0].output[0].code
const kb = (n) => (n / 1024).toFixed(2) + ' KB'
const lines = readFileSync(new URL('../mini.ts', import.meta.url), 'utf8').split('\n').length
console.log(`mini.ts source: ${lines} lines`)
console.log(`minified:       ${kb(code.length)}`)
console.log(`gzip:           ${kb(gzipSync(code).length)}`)
console.log(`brotli:         ${kb(brotliCompressSync(code).length)}`)
