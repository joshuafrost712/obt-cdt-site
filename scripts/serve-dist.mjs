// Serve dist/ the way GitHub Pages serves it, so a browser check measures the
// real shell rather than a friendlier local one. Two behaviours matter:
//
//   1. Project Pages serve under a base prefix (/obt-cdt-site/), so a bare
//      local server would resolve asset paths that break in production.
//   2. Any unmatched path returns 404.html with a 404 status, which is how the
//      SPA-only routes (the portal) are reached at all. Spec CDT-00 finding 2
//      turns on this, so a server that fell back to index.html would hide it.
//
// Deliberately sends no Content-Security-Policy header. The site's policy ships
// in a meta tag because Pages cannot send headers, and a server that sent one
// would be testing a control the deployment does not have.
//
// Usage: node scripts/serve-dist.mjs [--port 4183] [--base /obt-cdt-site/]

import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const PORT = Number(arg('port', 4183))
const BASE = arg('base', '/obt-cdt-site/')
const ROOT = path.resolve(arg('root', 'dist'))

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
}

async function readCandidate(rel) {
  const target = path.join(ROOT, rel)
  if (!target.startsWith(ROOT)) return null
  try {
    const s = await stat(target)
    if (s.isDirectory()) return readCandidate(path.join(rel, 'index.html'))
    return { body: await readFile(target), ext: path.extname(target) }
  } catch {
    return null
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  let rel = decodeURIComponent(url.pathname)

  if (rel === '/' || rel === BASE.replace(/\/$/, '')) {
    res.writeHead(302, { Location: BASE }).end()
    return
  }
  if (!rel.startsWith(BASE)) {
    // Off-base requests are what a mis-set VITE_BASE looks like in production.
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`off-base: ${rel}`)
    return
  }
  rel = rel.slice(BASE.length - 1) || '/'

  const hit = await readCandidate(rel)
  if (hit) {
    res
      .writeHead(200, { 'Content-Type': TYPES[hit.ext] || 'application/octet-stream' })
      .end(hit.body)
    return
  }

  const fallback = await readCandidate('/404.html')
  if (fallback) {
    res.writeHead(404, { 'Content-Type': TYPES['.html'] }).end(fallback.body)
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }).end('no 404.html in dist')
})

server.listen(PORT, () => {
  console.log(`serving ${path.relative(process.cwd(), ROOT)} at http://localhost:${PORT}${BASE}`)
  console.log('unmatched paths fall through to 404.html with a 404 status, as Pages does')
})
