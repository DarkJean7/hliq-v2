#!/usr/bin/env node
// Production static server with API proxy.
// Serves dist/ with long-lived cache headers for hashed assets,
// and forwards /api/* to the strategy server on port 3001.

import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST      = join(__dirname, 'dist')
const PORT        = 5175
const API_PORT    = 3002
const NOTIFY_PORT = 3001

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.webp': 'image/webp',
  '.woff2':'font/woff2',
  '.woff': 'font/woff',
  '.ttf':  'font/ttf',
}

// Hashed assets (e.g. index-AbCdEfGh.js) can be cached for 1 year
const HASH_RE = /\.[a-zA-Z0-9]{8,}\.(js|css)$/

function serveFile(res, filePath) {
  const ext      = extname(filePath).toLowerCase()
  const mime     = MIME[ext] ?? 'application/octet-stream'
  const isHashed = HASH_RE.test(filePath)
  const cache    = isHashed
    ? 'public, max-age=31536000, immutable'
    : 'no-cache'

  try {
    const stat = statSync(filePath)
    res.writeHead(200, {
      'Content-Type':   mime,
      'Cache-Control':  cache,
      'Content-Length': stat.size,
    })
    createReadStream(filePath).pipe(res)
  } catch {
    serveFile(res, join(DIST, 'index.html'))
  }
}

function proxyTo(req, res, port, name) {
  const proxy = httpRequest({
    hostname: 'localhost', port,
    path: req.url, method: req.method,
    headers: req.headers,
  }, upstream => {
    res.writeHead(upstream.statusCode, upstream.headers)
    upstream.pipe(res)
  })
  proxy.on('error', () => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `${name} unreachable — is it running?` }))
  })
  req.pipe(proxy)
}

createServer((req, res) => {
  const url = req.url.split('?')[0]

  // Proxy API calls to the strategy server, push endpoints to the notify server.
  // (nginx normally routes these directly; this keeps standalone use working.)
  if (url.startsWith('/api/'))    return proxyTo(req, res, API_PORT, 'Strategy server')
  if (url.startsWith('/notify/')) return proxyTo(req, res, NOTIFY_PORT, 'Notify server')

  // Profile picture storage
  if (url.startsWith('/pfp/')) {
    const addr = url.slice(5).toLowerCase()
    if (!/^0x[0-9a-f]{40}$/.test(addr)) { res.writeHead(400).end(); return }
    const pfpDir  = join(__dirname, 'data', 'pfp')
    const imgPath = join(pfpDir, addr + '.jpg')
    if (req.method === 'GET') {
      if (existsSync(imgPath)) return serveFile(res, imgPath)
      res.writeHead(404).end(); return
    }
    if (req.method === 'POST') {
      let body = ''
      req.on('data', chunk => { body += chunk; if (body.length > 2_000_000) req.destroy() })
      req.on('end', () => {
        try {
          const { dataUrl } = JSON.parse(body)
          if (!dataUrl?.startsWith('data:image/')) { res.writeHead(400).end(); return }
          mkdirSync(pfpDir, { recursive: true })
          writeFileSync(imgPath, Buffer.from(dataUrl.split(',')[1], 'base64'))
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        } catch { res.writeHead(500).end() }
      })
      return
    }
    res.writeHead(405).end(); return
  }

  // Static files
  const candidate = join(DIST, url === '/' ? 'index.html' : url)
  const filePath  = existsSync(candidate) && !candidate.endsWith('/')
    ? candidate
    : join(DIST, 'index.html')   // SPA fallback

  serveFile(res, filePath)
}).listen(PORT, () => {
  console.log(`Insolvent Terminal — serving on http://localhost:${PORT}`)
})
