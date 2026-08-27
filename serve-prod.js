#!/usr/bin/env node
// Production static server with API proxy.
// Serves dist/ with long-lived cache headers for hashed assets,
// and forwards /api/* to the strategy server on port 3001.

import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, statSync, existsSync, writeFileSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST      = join(__dirname, 'dist')
const PORT        = 5175
const API_PORT    = 3002
const NOTIFY_PORT = 3001

// TradingView symbol search (see the /tvsearch route). query|exchange → { at, body }.
const tvSearchCache = new Map()
const TV_SEARCH_TTL = 10 * 60_000

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
// Vite emits `index-CYtC1jGN.js` (hyphen before the hash), not `index.HASH.js`.
// The old pattern required a dot, so it never matched and every hashed bundle —
// including the ~1.1MB main chunk — was served `no-cache` and revalidated on
// every page load.
// Icon cache: hosts we're willing to fetch logos from (SSRF guard), and how long a
// "no artwork anywhere" result is remembered before we re-probe.
const ICON_HOSTS    = ['app.hyperliquid.xyz', 'coingecko.com', 's3-symbol-logo.tradingview.com', 's3.tradingview.com', 'flagcdn.com']
const ICON_MISS_TTL = 3 * 24 * 60 * 60 * 1000   // 3 days
// A logo-less coin returns this transparent 1×1 SVG with 200 (NOT a 404) so the client's
// letter-avatar base shows through and the console stays clean — no per-coin error spam.
const ICON_EMPTY    = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
const sendIconMiss  = res => res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' }).end(ICON_EMPTY)
const ICON_EXT      = ct => ct.includes('svg') ? '.svg' : ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : (ct.includes('jpeg') || ct.includes('jpg')) ? '.jpg' : '.img'

const HASH_RE = /[-.][A-Za-z0-9_-]{8,}\.(js|css)$/
// Self-hosted font files never change under a given name; fonts.css stays
// revalidated so it can point at new filenames if the families are regenerated.
const FONT_RE = /\.(woff2?|ttf)$/

// Write via a temp file + rename, because this process now runs as TWO cluster workers.
// writeFileSync truncates before it writes, so a plain write leaves a window where the other
// worker can read a half-written icon or a truncated meta JSON while serving the same coin.
// rename(2) is atomic within a filesystem, so a reader sees either the old file or the new
// one and never a partial. The temp name carries the pid so two workers cannot collide on it.
function writeAtomic(path, data) {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, data)
    renameSync(tmp, path)
  } catch (e) {
    try { unlinkSync(tmp) } catch {}   // don't leave debris behind on a failed write
    throw e
  }
}

function serveFile(res, filePath, allowIndexFallback = true) {
  const ext      = extname(filePath).toLowerCase()
  const mime     = MIME[ext] ?? 'application/octet-stream'
  const immutable = HASH_RE.test(filePath) || FONT_RE.test(filePath)
  const cache     = immutable
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
    const fallbackPath = join(DIST, 'index.html')
    if (allowIndexFallback && filePath !== fallbackPath) {
      return serveFile(res, fallbackPath, false)
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
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

  // Profile picture storage. Accepts a wallet address, or the "__all_accounts__"
  // sentinel used by the combined view (letters/underscores only, so filename-safe).
  if (url.startsWith('/pfp/')) {
    const addr = url.slice(5).toLowerCase()
    const valid = /^0x[0-9a-f]{40}$/.test(addr) || addr === '__all_accounts__'
    if (!valid) { res.writeHead(400).end(); return }
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
          writeAtomic(imgPath, Buffer.from(dataUrl.split(',')[1], 'base64'))
          res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}')
        } catch { res.writeHead(500).end() }
      })
      return
    }
    res.writeHead(405).end(); return
  }

  // ── Coin icon cache/proxy ────────────────────────────────────────────────────
  // Logos were fetched by every client directly from external CDNs (Hyperliquid /
  // CoinGecko / TradingView) on every render — flaky (403/404s), slow, and console-noisy.
  // Now the browser asks OUR server for /icon/<coin> (with the resolved source URLs as ?u=
  // hints); we fetch it once, cache it on disk, and serve every future request first-party.
  // A "miss" is remembered (ICON_MISS_TTL) so we don't re-probe a logo-less coin forever.
  if (url.startsWith('/icon/')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    let coin
    try { coin = decodeURIComponent(url.slice(6)) } catch { res.writeHead(400).end(); return }
    if (!coin || coin.length > 64 || !/^[A-Za-z0-9:@._/-]+$/.test(coin)) { res.writeHead(400).end(); return }
    const safe     = coin.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()
    const iconDir  = join(__dirname, 'data', 'icons')
    const metaPath = join(iconDir, safe + '.json')
    // Client candidate URLs, in the order the client sent (crypto = CoinGecko first, HL
    // fallback; TradFi = TradingView). Whitelisted hosts only.
    const query = (req.url.split('?')[1] || '')
    const cands = query.split('&').filter(p => p.startsWith('u=')).map(p => { try { return decodeURIComponent(p.slice(2)) } catch { return '' } }).filter(Boolean)
    const whitelisted = u => { try { const h = new URL(u).hostname; return ICON_HOSTS.some(x => h === x || h.endsWith('.' + x)) } catch { return false } }
    const fetchIcon = async (list) => {
      for (const srcUrl of list.slice(0, 6)) {
        if (!whitelisted(srcUrl)) continue
        try {
          const r = await fetch(srcUrl, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.tradingview.com/', 'Accept': 'image/*' } })
          if (!r.ok) continue
          const ct = (r.headers.get('content-type') || '').toLowerCase()
          if (!ct.startsWith('image/')) continue   // HL returns 200 HTML for missing icons
          const buf = Buffer.from(await r.arrayBuffer())
          if (buf.length < 80) continue            // too small to be real artwork
          return { buf, ct, ext: ICON_EXT(ct), src: srcUrl }
        } catch { /* try next */ }
      }
      return null
    }
    // Artwork first, then meta. Meta is what a reader trusts to decide the file is there, so
    // it must never land before the image it points at.
    const store = r => { mkdirSync(iconDir, { recursive: true }); writeAtomic(join(iconDir, safe + r.ext), r.buf); writeAtomic(metaPath, JSON.stringify({ ct: r.ct, ext: r.ext, src: r.src })) }
    const serve = r => res.writeHead(200, { 'Content-Type': r.ct, 'Cache-Control': 'public, max-age=86400' }).end(r.buf)
    ;(async () => {
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          if (meta.miss) {
            if (Date.now() - meta.at < ICON_MISS_TTL) { sendIconMiss(res); return }
            // stale miss → fall through and re-probe
          } else {
            // UPGRADE: if this coin was cached from a non-CoinGecko source (e.g. HL, because it
            // was first requested before the client's CoinGecko map had loaded) and a CoinGecko
            // candidate is now available, replace it with the real CoinGecko artwork. Fixes the
            // race where some cryptos stuck on the wrong/fallback icon.
            const cgCand = cands.find(u => u.includes('coingecko'))
            if (cgCand && !String(meta.src || '').includes('coingecko')) {
              const up = await fetchIcon([cgCand])
              if (up) { store(up); serve(up); return }
            }
            const f = join(iconDir, safe + meta.ext)
            if (existsSync(f)) { res.writeHead(200, { 'Content-Type': meta.ct, 'Cache-Control': 'public, max-age=86400' }); createReadStream(f).pipe(res); return }
          }
        } catch { /* corrupt meta — re-probe */ }
      }
      const got = await fetchIcon(cands)
      if (got) { store(got); serve(got); return }
      // Nothing worked — remember the miss (so we don't re-probe every request) and return a
      // transparent 200 (not a 404) so the client's letter base shows with no console error.
      try { mkdirSync(iconDir, { recursive: true }); writeAtomic(metaPath, JSON.stringify({ miss: true, at: Date.now() })) } catch {}
      sendIconMiss(res)
    })()
    return
  }

  // ── TradingView symbol search proxy ──────────────────────────────────────────
  // The Analysis tab lets you chart any market TradingView carries, which needs a
  // symbol search. TradingView's search endpoint gates on Referer and answers a
  // browser on our origin with 403, so the lookup has to happen here. Only the
  // query text leaves the box — no wallet, no account, nothing user-identifying.
  // Answers are memoised for TV_SEARCH_TTL because the same handful of queries
  // ("dxy", "btc") come back constantly and the symbol list barely moves.
  if (url === '/tvsearch') {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const qs   = new URLSearchParams(req.url.split('?')[1] || '')
    const text = (qs.get('q') || '').trim().slice(0, 64)
    // Exchange filter is an id like HYPERLIQUID; keep it to the shape TV uses so a
    // crafted value can't reach anything but the search endpoint's own parameter.
    const exch = (qs.get('exchange') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24)
    if (!text) { res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"symbols":[]}'); return }

    const key = text.toLowerCase() + '|' + exch
    const hit = tvSearchCache.get(key)
    if (hit && Date.now() - hit.at < TV_SEARCH_TTL) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }).end(hit.body)
      return
    }
    ;(async () => {
      try {
        const u = 'https://symbol-search.tradingview.com/symbol_search/v3/?text=' + encodeURIComponent(text) +
                  '&hl=0&lang=en&domain=production' + (exch ? '&exchange=' + exch : '')
        const r = await fetch(u, {
          headers: { 'Referer': 'https://www.tradingview.com/', 'Origin': 'https://www.tradingview.com',
                     'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(8000),
        })
        if (!r.ok) { res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"symbols":[]}'); return }
        const j = await r.json()
        // Hand the client only what it draws. The raw record carries a dozen logo and
        // provider fields that would triple the payload for nothing.
        const body = JSON.stringify({
          symbols: (j.symbols ?? []).slice(0, 40).map(s => ({
            // `prefix` wins when present: it is the id the widget wants, and it differs
            // from `source_id` on the broker feeds (Capital.com, Tickmill, …).
            full: (s.prefix || s.source_id || '') + ':' + String(s.symbol || '').replace(/<[^>]*>/g, ''),
            sym:  String(s.symbol || '').replace(/<[^>]*>/g, ''),
            ex:   s.exchange || s.source_id || '',
            desc: s.description || '',
            type: s.type || '',
          })).filter(s => s.full.includes(':') && !s.full.startsWith(':')),
        })
        if (tvSearchCache.size > 500) tvSearchCache.clear()
        tvSearchCache.set(key, { at: Date.now(), body })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }).end(body)
      } catch {
        res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"symbols":[]}')
      }
    })()
    return
  }

  // Static files
  const candidate = join(DIST, url === '/' ? 'index.html' : url)
  if (existsSync(candidate) && !candidate.endsWith('/')) return serveFile(res, candidate)

  // SPA fallback — but ONLY for real navigations. Returning index.html with a 200
  // for a missing font/script/image makes the browser download 150KB of HTML and
  // then fail to parse it (Chrome reports it as a slow-network font intervention).
  // Sec-Fetch-Dest tells us what the request is for; clients that omit it (curl,
  // old browsers) fall back to "does the path look like a file?".
  const dest = req.headers['sec-fetch-dest']
  const isNavigation = dest
    ? dest === 'document'
    : !/\.[a-z0-9]{2,8}$/i.test(url)

  if (!isNavigation) { res.writeHead(404).end(); return }
  serveFile(res, join(DIST, 'index.html'))
}).listen(PORT, () => {
  console.log(`Insolvent Trade — serving on http://localhost:${PORT}`)
})
