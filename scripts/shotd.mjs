/**
 * Screenshot sink.
 *
 * The browser pane the game is driven in is whatever width the workspace layout
 * left over — 265 px on a bad day — and a model you are trying to judge the
 * silhouette of cannot be looked at through that. So the page renders itself at
 * a size we choose, off the pane's own dimensions entirely, and POSTs the canvas
 * here as a data URL.
 *
 * usage: node scripts/shotd.mjs [port]   (writes to /tmp/kt/<name>.png)
 */
import { createServer } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const PORT = Number(process.argv[2] ?? 5191)
const OUT = '/tmp/kt'
mkdirSync(OUT, { recursive: true })

createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.end()
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    try {
      const { name, data } = JSON.parse(body)
      const png = Buffer.from(String(data).split(',')[1], 'base64')
      const path = join(OUT, `${String(name).replace(/[^\w.-]/g, '_')}.png`)
      writeFileSync(path, png)
      console.log(`${path}  ${(png.length / 1024).toFixed(0)} kB`)
      res.end('ok')
    } catch (e) {
      console.error(e)
      res.statusCode = 400
      res.end(String(e))
    }
  })
}).listen(PORT, () => console.log(`shotd on :${PORT} -> ${OUT}`))
