#!/usr/bin/env node
// Production static server with API proxy.
// Serves dist/ with long-lived cache headers for hashed assets,
// and forwards /api/* to the strategy server on port 3001.

import { createServer, request as httpRequest } from 'node:http'
import { createReadStream, statSync, existsSync, writeFileSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { join, extname, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { coinGeckoUpgrade } from './src/iconpick.js'
import { EXT_MARKETS, extYahoo, extChartUrl, parseChart, EXT_TF, extChartUrlTf, parseSeries } from './src/extmarkets.js'
import { SEC_CONCEPTS, SEC_TICKERS_URL, secConceptUrl, companyRevenue } from './src/secrev.js'
import { llamaSummaryUrl, sumDaily } from './src/llama.js'
import { cleanPortfolio, upsertFeatured } from './src/pfshared.js'
import { coinsOf, coinFile, stalest, buildPerf, HIST_FROM as PFC_FROM } from './src/pfgallery.js'
import { buildRevenue, verifyRevenue, cgForHyperliquid, cgMarketsUrl, CG_PAGES, LLAMA_FEES_URL, LLAMA_LITE_URL, LLAMA_FEESPAID_URL } from './src/llama.js'
import { fetchQuotes, normAnyAddr, normTokenAddr, pickDeepest, normNet, quoteKey, dsFindUrl, pickNetwork, MAX_PER_REQUEST as OFFEX_MAX } from './src/offex.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DIST      = join(__dirname, 'dist')
const PORT        = 5175
const API_PORT    = 3002
const NOTIFY_PORT = 3001

// TradingView symbol search (see the /tvsearch route). query|exchange → { at, body }.
const tvSearchCache = new Map()
const TV_SEARCH_TTL = 10 * 60_000

// External market quotes (see the /extquote route). TradingView symbol -> { at, q }.
const extQuoteCache = new Map()
// Off-exchange token prices, by lower-cased contract address → { at, t } where t is the parsed
// quote, or null for "GeckoTerminal does not know this token" (remembered too, so an unknown
// address is not re-asked on every poll).
const offexCache = new Map()
const OFFEX_TTL = 60_000
// addr -> { at, net } — which network an address trades on. Changes rarely; asked once per paste.
const offexFindCache = new Map()
const OFFEX_FIND_TTL = 10 * 60_000

// ── /markets-meta: revenue and fees by token (DefiLlama) + market caps (CoinGecko) ───────
// src/llama.js has the rules. DefiLlama: three feeds, ~15 MB, boiled down to a few KB and
// held for half an hour. CoinGecko: its top 2,000 coins, which say which coin a ticker MEANS
// (so Strike's revenue is not shown on Starknet's STRK) and give perps a market cap. Its free
// API throttles hard (429 after five quick pages), so the pages are fetched slowly, every six
// hours, and kept on disk, shared by every worker and surviving a restart.
// A stale copy is served while a fresh one is fetched; a failed refresh keeps the last good.
// Revenue is NOT served until CoinGecko has loaded once: unverified, it would put the wrong
// project's revenue back on a ticker.
const LLAMA_TTL = 30 * 60_000
const CG_TTL    = 6 * 60 * 60_000
const CG_FILE   = join(__dirname, 'data', 'cgtop.json')
let llamaData = null           // { at, bySym }
let llamaInflight = null
let cgData = null              // { at, top }
let cgInflight = null
let metaBody = null            // { key, body } — composed once per data change
// pm2 runs several workers. ONE fetches (CG_LOCK); the rest read what it wrote. Two fetching
// at once each tripped CoinGecko's limit for the other, and a worker that had started its own
// slow fetch kept answering 503 long after the file it needed was on disk.
const CG_LOCK = CG_FILE + '.lock'
const CG_LOCK_TTL = 15 * 60_000
function cgFromDisk() {
  try {
    const d = JSON.parse(readFileSync(CG_FILE, 'utf8'))
    if (d?.top && d.at && (!cgData || d.at > cgData.at)) cgData = d
  } catch {}
  return !!cgData
}
cgFromDisk()
function llamaRefresh() {
  if (llamaInflight) return llamaInflight
  const get = (u) => fetch(u, { signal: AbortSignal.timeout(45_000) }).then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
  llamaInflight = Promise.all([get(LLAMA_FEES_URL), get(LLAMA_LITE_URL), get(LLAMA_FEESPAID_URL).catch(() => null)])
    .then(([rev, lite, paid]) => { llamaData = { at: Date.now(), bySym: buildRevenue(rev, lite, paid).bySym } })
    .catch(e => console.warn('[markets-meta] DefiLlama refresh failed:', e.message))
    .finally(() => { llamaInflight = null })
  return llamaInflight
}
function cgRefresh() {
  if (cgInflight) return cgInflight
  cgInflight = (async () => {
    // Another worker may have refreshed it since this one started, or be doing so now.
    if (cgFromDisk() && Date.now() - cgData.at < CG_TTL) return
    try { if (Date.now() - statSync(CG_LOCK).mtimeMs < CG_LOCK_TTL) return } catch {}
    try { mkdirSync(dirname(CG_FILE), { recursive: true }); writeFileSync(CG_LOCK, String(process.pid)) } catch {}
    const pages = []
    let retries = 0
    for (let p = 1; p <= CG_PAGES; p++) {
      if (p > 1) await new Promise(r => setTimeout(r, 13_000))   // ~5 a minute: under the free limit
      try {
        const r = await fetch(cgMarketsUrl(p), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20_000) })
        // Throttled: wait a minute and retry the same page — a few times, never forever.
        if (r.status === 429 && retries++ < 4) { await new Promise(r2 => setTimeout(r2, 60_000)); p--; continue }
        if (r.ok) pages.push(await r.json())
      } catch {}
    }
    // Half the list is not the list: a ticker missing from a partial fetch would go unchecked.
    if (pages.length < CG_PAGES / 2) throw new Error(`only ${pages.length} of ${CG_PAGES} pages`)
    cgData = { at: Date.now(), top: cgForHyperliquid(pages) }
    try { mkdirSync(dirname(CG_FILE), { recursive: true }); writeAtomic(CG_FILE, JSON.stringify(cgData)) } catch {}
  })().finally(() => { try { if (readFileSync(CG_LOCK, 'utf8') === String(process.pid)) unlinkSync(CG_LOCK) } catch {} }).catch(e => console.warn('[markets-meta] CoinGecko refresh failed:', e.message)).finally(() => { cgInflight = null })
  return cgInflight
}
// ── Stocks' reported revenue, from the SEC (src/secrev.js) ──────────────────────────────
// Once a day: Hyperliquid's stock tickers (perpCategories — one weight-20 call a day, next to
// nothing beside the bots), the SEC's ticker → CIK list, then each company's revenue concepts,
// paced at ~6 a second (the SEC allows 10). One worker fetches (lock); all read the file.
// The SEC asks callers to identify themselves; SEC_CONTACT overrides the default.
const SEC_TTL = 24 * 60 * 60_000
const SEC_FILE = join(__dirname, 'data', 'secrev.json')
const SEC_LOCK = SEC_FILE + '.lock'
const SEC_UA = process.env.SEC_CONTACT || 'InsolventTerminal/1.0 (+https://insolvent.trade)'
let secData = null             // { at, stocks: { TICKER: { name, q, qStart, qEnd, qDerived, ttm, yoy } }, sic: { TICKER: [code, name] } }
let secInflight = null
function secFromDisk() {
  // A file from before industry codes were fetched has no `sic`; it counts as stale.
  // A file from before industry codes, or before the quarter history (v2), counts as stale.
  try { const d = JSON.parse(readFileSync(SEC_FILE, 'utf8')); if (d?.stocks && d.at && (!secData || d.at > secData.at)) secData = d.sic && d.v >= 2 ? d : { ...d, at: 0 } } catch {}
  return !!secData
}
secFromDisk()
function secRefresh() {
  if (secInflight) return secInflight
  secInflight = (async () => {
    if (secFromDisk() && Date.now() - secData.at < SEC_TTL) return
    try { if (Date.now() - statSync(SEC_LOCK).mtimeMs < 30 * 60_000) return } catch {}
    try { mkdirSync(dirname(SEC_FILE), { recursive: true }); writeFileSync(SEC_LOCK, String(process.pid)) } catch {}
    const cats = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"type":"perpCategories"}', signal: AbortSignal.timeout(15_000) }).then(r => r.json())
    const tickers = [...new Set((Array.isArray(cats) ? cats : []).filter(([, k]) => /^stocks?$/i.test(String(k))).map(([c]) => String(c).replace(/^.*:/, '')))]
    const secList = await fetch(SEC_TICKERS_URL, { headers: { 'User-Agent': SEC_UA }, signal: AbortSignal.timeout(30_000) }).then(r => r.json())
    const byTicker = new Map(Object.values(secList ?? {}).map(x => [x.ticker, x]))
    const stocks = {}, sic = {}
    for (const tk of tickers) {
      const co = byTicker.get(tk)
      if (!co) continue                                  // not an SEC filer (Tencent, SK Hynix…) or an ETF
      const byConcept = {}
      for (const concept of SEC_CONCEPTS) {
        await new Promise(r => setTimeout(r, 170))
        try {
          const r = await fetch(secConceptUrl(co.cik_str, concept), { headers: { 'User-Agent': SEC_UA }, signal: AbortSignal.timeout(20_000) })
          if (r.ok) byConcept[concept] = (await r.json())?.units?.USD ?? []
        } catch {}
      }
      const v = companyRevenue(byConcept)
      if (v) stocks[tk] = { name: co.title, ...v }
      // The company's SEC industry code, for its sector on /markets (src/sectors.js sicSectors).
      await new Promise(r => setTimeout(r, 170))
      try {
        const r = await fetch(`https://data.sec.gov/submissions/CIK${String(co.cik_str).padStart(10, '0')}.json`, { headers: { 'User-Agent': SEC_UA }, signal: AbortSignal.timeout(20_000) })
        const sub = r.ok ? await r.json() : null
        if (sub?.sic) sic[tk] = [Number(sub.sic), String(sub.sicDescription ?? '')]
      } catch {}
    }
    if (!Object.keys(stocks).length) throw new Error('no company answered')
    secData = { at: Date.now(), stocks, sic, v: 2 }
    writeAtomic(SEC_FILE, JSON.stringify(secData))
  })().finally(() => { try { if (readFileSync(SEC_LOCK, 'utf8') === String(process.pid)) unlinkSync(SEC_LOCK) } catch {} })
    .catch(e => console.warn('[markets-meta] SEC refresh failed:', e.message))
    .finally(() => { secInflight = null })
  return secInflight
}

// ── /markets-revenue?sym=PUMP&type=revenue|fees: a token's daily history, for the chart ──
// Only a ticker the revenue table already carries (its DefiLlama slug comes from there), so
// the route never fetches what a caller names. An hour per slug and type; the newest day
// moves, the rest does not.
const REVHIST_TTL = 60 * 60_000
const revHist = new Map()        // 'slug|type' -> { at, pts }
async function revHistory(slugs, type) {
  const series = []
  for (const slug of slugs) {
    const k = slug + '|' + type
    const hit = revHist.get(k)
    if (hit && Date.now() - hit.at < REVHIST_TTL) { series.push(hit.pts); continue }
    const r = await fetch(llamaSummaryUrl(slug, type), { signal: AbortSignal.timeout(30_000) })
    if (!r.ok) throw new Error(String(r.status))
    const pts = (await r.json())?.totalDataChart ?? []
    if (revHist.size > 300) revHist.clear()
    revHist.set(k, { at: Date.now(), pts })
    series.push(pts)
  }
  return sumDaily(series)
}

function metaJson() {
  if (!llamaData || !cgData) return null
  const key = llamaData.at + ':' + cgData.at + ':' + (secData?.at ?? 0)
  if (metaBody?.key !== key) {
    const { bySym } = verifyRevenue(llamaData.bySym, cgData.top)
    // Ticker → [CoinGecko id, market cap]; the page uses the cap for perps HL gives none.
    const cg = Object.fromEntries(Object.entries(cgData.top).map(([s, v]) => [s, [v.id, v.mcap]]))
    // Stocks: null until the SEC list has loaded — the page then says so rather than show dashes as fact.
    metaBody = { key, body: JSON.stringify({ revenue: bySym, cg, stocks: secData?.stocks ?? null, sic: secData?.sic ?? null, at: llamaData.at, cgAt: cgData.at, secAt: secData?.at ?? null, source: 'DefiLlama, CoinGecko, SEC' }) }
  }
  return metaBody.body
}
const EXT_QUOTE_TTL = 60_000

// Compare-chart series (see /extcandles). "SYMBOL|TF" -> { at, pts }.
// A longer memory than the quote cache on purpose: a 1Y line built from weekly bars does not
// change between two people opening the same chart, and the window it describes moves by a
// day at a time. The 1D window is the only one that goes stale quickly.
const extSeriesCache = new Map()
const EXT_SERIES_TTL = { '1D': 60_000, '1W': 5 * 60_000 }
const EXT_SERIES_TTL_DEFAULT = 30 * 60_000

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

// ── /portfolios-data: the featured portfolios on /portfolios (src/pfshared.js) ───────────
// Public to read; writes need the dev PIN. The PIN is not known here — the strategy server
// owns it (~/.hliq/lb_pin or LB_PIN) and answers /api/leaderboard/verify-pin, so this asks
// that instead of keeping a second copy of a secret. Kept in this server, not that one, so
// publishing a portfolio never needs a change to server.js, whose deploy restarts the bots.
const PF_FILE = join(__dirname, 'data', 'portfolios.json')
let pfCache = null                                   // { mtime, list } — both workers read the file
function pfRead() {
  try {
    const st = statSync(PF_FILE)
    if (pfCache?.mtime !== st.mtimeMs) pfCache = { mtime: st.mtimeMs, list: JSON.parse(readFileSync(PF_FILE, 'utf8')).portfolios ?? [] }
    return pfCache.list
  } catch { return [] }
}
// ── /portfolios gallery prices: one market per tick, never a list ────────────────────────
//
// Why a trickle and not a refresh: the 22 featured portfolios reference 102 distinct markets,
// a candleSnapshot is weight 20, and this box shares its Hyperliquid IP with the bots. 102 of
// them at once is 2,040 weight against a 1,200/minute budget, and the request throttled behind
// it could be a bot closing a position (CLAUDE.md). One a minute is 20 weight/minute — under
// 2% — and fills the whole set in under two hours.
//
// A market not in the cache yet is simply absent from the answer, and the browser works that
// card out for itself exactly as it did before. Absent is "no answer", never "nothing here".
const PFC_DIR  = join(__dirname, 'data', 'pfcandles')
const PFC_TTL  = 22 * 3600e3          // a market is refreshed at most once a day
const PFC_TICK = 60_000               // at most one candleSnapshot a minute, from this box
const PFC_LOCK = join(PFC_DIR, '.lock')
const PFC_LOCK_TTL = 5 * 60_000
const pfcMem = new Map()              // coin -> { at, closes }  (this worker's copy)

function pfcRead(coin) {
  const hit = pfcMem.get(coin)
  if (hit) return hit
  try {
    const j = JSON.parse(readFileSync(join(PFC_DIR, coinFile(coin) + '.json'), 'utf8'))
    const rec = { at: Number(j.at) || 0, closes: Array.isArray(j.closes) ? j.closes : [] }
    pfcMem.set(coin, rec)
    return rec
  } catch { return null }
}
const pfcAt = (coin) => pfcRead(coin)?.at ?? 0

let pfcBusy = false
async function pfcTick() {
  if (pfcBusy) return
  const coins = coinsOf(pfRead())
  if (!coins.length) return
  // Re-read from disk before choosing: another worker may have refreshed since this one's
  // memory was filled, and the two would otherwise take turns fetching the same market.
  for (const c of coins) pfcMem.delete(c)
  const coin = stalest(coins, pfcAt, PFC_TTL)
  if (!coin) return
  // One worker fetches. The cluster runs several and every one of them holds this timer.
  try { if (Date.now() - statSync(PFC_LOCK).mtimeMs < PFC_LOCK_TTL) return } catch {}
  pfcBusy = true
  try {
    mkdirSync(PFC_DIR, { recursive: true })
    writeFileSync(PFC_LOCK, String(process.pid))
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: PFC_FROM, endTime: Date.now() } }),
      signal: AbortSignal.timeout(20_000),
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    const closes = (Array.isArray(j) ? j : [])
      .map(k => [Number(k.t), Number(k.c)]).filter(([t, c]) => Number.isFinite(t) && c > 0)
    // A market that answered with nothing is still RECORDED, with its time: otherwise it is
    // chosen again on the very next tick and starves every market behind it.
    writeAtomic(join(PFC_DIR, coinFile(coin) + '.json'), JSON.stringify({ coin, at: Date.now(), closes }))
    pfcMem.delete(coin)
    pfPerf = null
    console.log(`[portfolios] ${coin}: ${closes.length} daily closes`)
  } catch (e) {
    console.warn('[portfolios] ' + coin + ' refresh failed:', e.message)
  } finally {
    try { if (readFileSync(PFC_LOCK, 'utf8') === String(process.pid)) unlinkSync(PFC_LOCK) } catch {}
    pfcBusy = false
  }
}
setInterval(() => { pfcTick().catch(() => {}) }, PFC_TICK).unref?.()

// The computed cards, rebuilt when the portfolios or the prices change, and once an hour so a
// window measured from "now" cannot drift a day behind.
let pfPerf = null
function pfPerfNow() {
  const list = pfRead()
  const stamp = list.map(p => p.id).join(',') + '|' + list.length
  if (pfPerf && pfPerf.stamp === stamp && Date.now() - pfPerf.at < 3600e3) return pfPerf
  const closes = {}
  for (const c of coinsOf(list)) { const rec = pfcRead(c); if (rec?.closes?.length) closes[c] = rec.closes }
  const t0 = Date.now()
  const perf = buildPerf(list, closes)
  pfPerf = { stamp, at: Date.now(), perf, coins: Object.keys(closes).length }
  console.log(`[portfolios] built ${Object.keys(perf).length}/${list.length} cards from ${pfPerf.coins} markets in ${Date.now() - t0}ms`)
  return pfPerf
}

function readJson(req, max = 64_000) {
  return new Promise((resolve) => {
    let n = 0; const chunks = []
    req.on('data', c => { n += c.length; if (n > max) { req.destroy(); resolve(null) } else chunks.push(c) })
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(null) } })
    req.on('error', () => resolve(null))
  })
}
// true / false, or null when the strategy server could not say (it is down) — not a "no".
function devPinOk(pin) {
  if (!pin) return Promise.resolve(false)
  return new Promise((resolve) => {
    const r = httpRequest({ host: '127.0.0.1', port: API_PORT, path: '/api/leaderboard/verify-pin', method: 'POST', headers: { 'x-lb-pin': String(pin).slice(0, 200) }, timeout: 5000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200 ? true : res.statusCode === 403 ? false : null)
    })
    r.on('error', () => resolve(null)); r.on('timeout', () => { r.destroy(); resolve(null) })
    r.end()
  })
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
    // Uploads moved to POST /api/pfp on the strategy server, which is where the ownership
    // proof lives. This accepted ANY post for ANY address — the only thing stopping a
    // stranger replacing your picture was that the button was hidden. Reads stay here.
    res.writeHead(405, { 'Content-Type': 'application/json' })
       .end('{"error":"upload moved to POST /api/pfp"}')
    return
  }

  // ── Global-chat pictures ─────────────────────────────────────────────────────
  // Written by POST /api/chat on the strategy server, which is where the size cap, the
  // rate limit and the JPEG check live. This only SERVES them, the way /pfp/ above does.
  //
  // The id pattern is the whole path validation: it has no dot and no slash, so nothing
  // here can be talked into reading outside the directory. nosniff on top of an explicit
  // image/jpeg, because these are the one thing on this origin a stranger put there — a
  // browser that sniffed one as HTML would be running it on our domain.
  if (url.startsWith('/chatimg/')) {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const id = url.slice(9).replace(/\.jpg$/, '')
    if (!/^[a-z0-9]{8,24}$/.test(id)) { res.writeHead(400).end(); return }
    const imgPath = join(__dirname, 'data', 'chatimg', id + '.jpg')
    if (!existsSync(imgPath)) { res.writeHead(404).end(); return }
    const st = statSync(imgPath)
    res.writeHead(200, {
      'Content-Type': 'image/jpeg',
      'Content-Length': st.size,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      // The bytes never change under an id, so it can be cached hard. A deleted message's
      // picture is gone from the feed either way.
      'Cache-Control': 'public, max-age=31536000, immutable',
    })
    createReadStream(imgPath).pipe(res)
    return
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
    // Which generation of the client's icon-resolution logic asked. The client bumps its
    // _ICON_V whenever that logic changes, and its comment has always said the bump makes
    // stale icons re-fetch "against the corrected server" — but the bump only busted the
    // BROWSER's cache. We answered from the same file, so a coin cached under the old,
    // wrong resolution stayed wrong forever (NVDA held Robinhood's logo, from a CoinGecko
    // entry the client no longer offers). Stored in the meta rather than in the filename so
    // a bump re-probes each coin exactly once and overwrites in place, instead of orphaning
    // the whole icon directory every time.
    const iconVer = (query.match(/(?:^|&)v=(\d{1,4})(?:&|$)/) || [, '0'])[1]
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
    const store = r => { mkdirSync(iconDir, { recursive: true }); writeAtomic(join(iconDir, safe + r.ext), r.buf); writeAtomic(metaPath, JSON.stringify({ ct: r.ct, ext: r.ext, src: r.src, v: iconVer })) }
    const serve = r => res.writeHead(200, { 'Content-Type': r.ct, 'Cache-Control': 'public, max-age=86400' }).end(r.buf)
    // ?ro=1 — READ-ONLY, for /markets. That page shows the icons the app already chose and
    // never chooses one itself: probing with its own sources would cache a worse logo (or a
    // miss, which the app then serves as a letter) over what the app resolves. Hit: serve it.
    // Anything else: the transparent miss, and NOTHING written.
    if (/(?:^|&)ro=1(?:&|$)/.test(query)) {
      try {
        const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, 'utf8')) : null
        const f = meta && !meta.miss && meta.ext ? join(iconDir, safe + meta.ext) : null
        if (f && existsSync(f)) { res.writeHead(200, { 'Content-Type': meta.ct, 'Cache-Control': 'public, max-age=86400' }); createReadStream(f).pipe(res); return }
      } catch {}
      sendIconMiss(res)
      return
    }
    ;(async () => {
      if (existsSync(metaPath)) {
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
          // Cached under an older resolution than the client is running: what is on disk was
          // chosen from a candidate list this client would no longer send. Re-probe with the
          // list it did send. A miss is re-probed for the same reason — the old generation
          // may simply have been asking the wrong sources.
          const staleGen = String(meta.v ?? '') !== String(iconVer)
          if (meta.miss || staleGen) {
            if (staleGen) {
              const got = await fetchIcon(cands)
              if (got) { store(got); serve(got); return }
              try { writeAtomic(metaPath, JSON.stringify({ miss: true, at: Date.now(), v: iconVer })) } catch {}
              sendIconMiss(res); return
            }
            if (Date.now() - meta.at < ICON_MISS_TTL) { sendIconMiss(res); return }
            // stale miss → fall through and re-probe
          } else {
            // UPGRADE: if this coin was cached from a non-CoinGecko source (e.g. HL, because it
            // was first requested before the client's CoinGecko map had loaded) and a CoinGecko
            // candidate is now available, replace it with the real CoinGecko artwork. Fixes the
            // race where some cryptos stuck on the wrong/fallback icon.
            //
            // Only when the client RANKED CoinGecko above what we have, though — see
            // src/iconpick.js for why upgrading on mere presence put Robinhood's logo on NVDA.
            const cgCand = coinGeckoUpgrade(cands, meta.src)
            if (cgCand) {
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
      // Stamped with the generation that failed. Without it a miss reads as stale on the very
      // next request, and a logo-less coin would re-probe four external CDNs forever.
      try { mkdirSync(iconDir, { recursive: true }); writeAtomic(metaPath, JSON.stringify({ miss: true, at: Date.now(), v: iconVer })) } catch {}
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

  // ── External market quotes (DXY, gold, yields, forex) ────────────────────────
  // Hyperliquid has no feed for these, so the Watch tab used to draw them as a TradingView
  // embed: a different shape from a coin row, and nothing the home ticker strip could read.
  // This hands the client the same three things it has for a coin — a price, a change and a
  // series — so one renderer draws both. src/extmarkets.js has the why and the symbol map.
  //
  // The client names a MARKET, never a URL: anything outside that map is rejected, so this
  // cannot be turned into an open proxy. Answers are memoised for a minute because every
  // client with DXY watched asks for the same row on the same poll, and the underlying quote
  // does not move faster than that.
  if (url === '/extquote') {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const qs   = new URLSearchParams(req.url.split('?')[1] || '')
    const want = (qs.get('s') || '').split(',').map(s => s.trim()).filter(s => EXT_MARKETS[s]).slice(0, 20)
    if (!want.length) { res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"quotes":{}}'); return }
    ;(async () => {
      const quotes = {}
      await Promise.all(want.map(async (sym) => {
        const hit = extQuoteCache.get(sym)
        if (hit && Date.now() - hit.at < EXT_QUOTE_TTL) { quotes[sym] = hit.q; return }
        try {
          const r = await fetch(extChartUrl(extYahoo(sym)), {
            headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
          })
          if (!r.ok) return
          const q = parseChart(await r.json())
          // A symbol that answers with no series is left OUT of the reply rather than sent as
          // a zero. The row then shows a dash, which is the truth: we do not know its price.
          if (q) { extQuoteCache.set(sym, { at: Date.now(), q }); quotes[sym] = q }
        } catch { /* leave it out */ }
      }))
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' })
         .end(JSON.stringify({ quotes }))
    })()
    return
  }

  // ── Off-exchange token prices (HyperEVM, via GeckoTerminal) ────────────────────
  // Tokens held outside Hyperliquid's spot book, typed into the Spot tab by hand. The client
  // names contract ADDRESSES — validated as 0x-hex before they go anywhere near a URL — so
  // this cannot be pointed at anything but GeckoTerminal's token endpoint. One minute of
  // cache, shared by every client, because GeckoTerminal allows about thirty calls a minute
  // and the same NEST row is asked for by everyone who holds it. src/offex.js has the why.
  if (url === '/markets-revenue') {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const qs   = new URLSearchParams(req.url.split('?')[1] || '')
    const sym  = String(qs.get('sym') || '').toUpperCase().slice(0, 24)
    const type = qs.get('type') === 'fees' ? 'fees' : 'revenue'
    // pm2 runs several workers and each loads the revenue table on its own first request: a
    // chart asked of a worker that has not yet (any worker, right after a deploy) must load it
    // rather than answer 404 for a token the page is showing.
    ;(async () => {
      if (!cgData) cgFromDisk()
      if (!llamaData) await llamaRefresh()
      const tok = llamaData && cgData ? verifyRevenue(llamaData.bySym, cgData.top).bySym[sym] : null
      if (!tok?.slugs?.length) { res.writeHead(llamaData && cgData ? 404 : 503, { 'Content-Type': 'application/json' }).end('{"points":null}'); return }
      return revHistory(tok.slugs, type)
      .then(points => res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' })
        .end(JSON.stringify({ sym, type, name: tok.name, points })))
      .catch(() => res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"points":null}'))
    })()
    return
  }

  if (url === '/portfolios-data' || url === '/portfolios-data/save' || url === '/portfolios-data/delete') {
    const send = (code, obj) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj))
    if (url === '/portfolios-data') {
      if (req.method !== 'GET') { res.writeHead(405).end(); return }
      // `perf` carries only the cards the cached prices can answer for. A portfolio missing
      // from it is one the browser still works out itself — see src/pfgallery.js.
      let perf = {}, asOf = 0
      try { const b = pfPerfNow(); perf = b.perf; asOf = b.at } catch (e) { console.warn('[portfolios] perf failed:', e.message) }
      return send(200, { portfolios: pfRead(), perf, asOf })
    }
    if (req.method !== 'POST') { res.writeHead(405).end(); return }
    ;(async () => {
      const ok = await devPinOk(req.headers['x-lb-pin'])
      if (ok === null) return send(503, { error: 'could not check the PIN right now' })
      if (!ok) return send(403, { error: 'forbidden' })
      const b = await readJson(req)
      if (!b) return send(400, { error: 'bad request' })
      let list = pfRead()
      if (url === '/portfolios-data/save') {
        const p = cleanPortfolio(b.portfolio)
        if (!p) return send(400, { error: 'not a portfolio: it needs a name and at least one holding with a weight' })
        const next = upsertFeatured(list, p)
        if (!next) return send(409, { error: 'the featured list is full' })
        list = next
      } else {
        const id = String(b.id ?? '')
        if (!list.some(x => x.id === id)) return send(404, { error: 'no such portfolio' })
        list = list.filter(x => x.id !== id)
      }
      try { mkdirSync(dirname(PF_FILE), { recursive: true }); writeAtomic(PF_FILE, JSON.stringify({ portfolios: list })) }
      catch { return send(500, { error: 'could not save' }) }
      pfCache = null
      pfPerf = null
      return send(200, { portfolios: list })
    })()
    return
  }

  if (url === '/markets-meta') {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const send = () => {
      const body = metaJson()
      return body
        ? res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' }).end(body)
        // Unknown, not empty: the page shows dashes and says revenue did not load.
        : res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"revenue":null}')
    }
    // CoinGecko takes minutes to fetch politely; never make a visitor wait for it.
    // Pick up what another worker fetched — cheap, and the reason a worker is not left at 503.
    if (!cgData || Date.now() - cgData.at > CG_TTL) cgFromDisk()
    if (!cgData || Date.now() - cgData.at > CG_TTL) cgRefresh()
    if (!secData || Date.now() - secData.at > SEC_TTL) secFromDisk()
    if (!secData || Date.now() - secData.at > SEC_TTL) secRefresh()
    if (llamaData && Date.now() - llamaData.at < LLAMA_TTL) return send()
    if (llamaData) { llamaRefresh(); return send() }       // stale: serve it, refresh behind
    llamaRefresh().then(send)
    return
  }

  if (url === '/offexprice') {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const qs   = new URLSearchParams(req.url.split('?')[1] || '')
    // ?find=<addr> — which supported network it trades on (DexScreener, across chains). The
    // add sheet asks this when HyperEVM has no market for a pasted address.
    const find = normAnyAddr(qs.get('find') || '')
    if (find) {
      ;(async () => {
        const hit = offexFindCache.get(find)
        let net = hit && Date.now() - hit.at < OFFEX_FIND_TTL ? hit.net : undefined
        if (net === undefined) {
          try {
            const r = await fetch(dsFindUrl(find), { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
            if (r.ok) { net = pickNetwork(await r.json(), find); offexFindCache.set(find, { at: Date.now(), net }) }
          } catch {}
          if (offexFindCache.size > 2000) offexFindCache.clear()
        }
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ net: net ?? null }))
      })()
      return
    }
    // ?n=<network> — one of src/offex.js NETWORKS, anything else is HyperEVM. Never put in a
    // URL as typed: it only ever selects an id from that table.
    const net  = normNet(qs.get('n'))
    // Validated in the shape `net` uses: 0x hex, or a base58 mint on Solana (case kept).
    const want = [...new Set((qs.get('a') || '').split(',').map(a => normTokenAddr(net, a)).filter(Boolean))].slice(0, OFFEX_MAX)
    if (!want.length) { res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"prices":{}}'); return }
    ;(async () => {
      const prices = {}
      const stale  = []
      for (const a of want) {
        const hit = offexCache.get(quoteKey(net, a))
        if (hit && Date.now() - hit.at < OFFEX_TTL) { if (hit.t) prices[a] = hit.t }
        else stale.push(a)
      }
      if (stale.length) {
        try {
          // GeckoTerminal AND DexScreener, deepest pool wins — GeckoTerminal alone priced
          // EAGLE from an empty pool 40% under its real market. See src/offex.js.
          const { quotes: got, ok, both } = await fetchQuotes(stale, async (u) => {
            const r = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
            if (!r.ok) throw new Error(String(r.status))
            return r.json()
          }, net)
          if (ok) {
            for (const a of stale) {
              const prev = offexCache.get(quoteKey(net, a))?.t ?? null
              // With one source down, the deeper of (what it just said, what we last knew)
              // wins — otherwise EAGLE flips between its real pool and an empty one each time
              // DexScreener blinks. And a half answer is kept only briefly, so the next poll
              // asks both again.
              const t = both ? (got[a] ?? null) : pickDeepest(prev, got[a] ?? null)
              offexCache.set(quoteKey(net, a), { at: both ? Date.now() : Date.now() - OFFEX_TTL + 10_000, t })
              if (t) prices[a] = t
            }
          }
          // When BOTH sources fail, nothing is cached: the next poll asks again rather than
          // holding a "no price" for a minute because the price services hiccupped once.
        } catch { /* leave them out — the row shows a dash, which is the truth */ }
        if (offexCache.size > 2000) offexCache.clear()
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' })
         .end(JSON.stringify({ prices }))
    })()
    return
  }

  // ── External market series, for the compare chart ────────────────────────────
  // /extquote hands back one window — the 24 hours the Watch row reports. The compare chart
  // has seven timeframe pills, and a market that could only answer one of them dropped off
  // the chart as soon as anyone pressed 1M. This answers any of them.
  //
  // Same shape as Hyperliquid's candleSnapshot rows, {t, c}, because that is what
  // computeCompare reads: the client puts a coin and a market into the same map and the
  // chart cannot tell which is which. Same whitelist too — the client names a market and a
  // timeframe, never a URL.
  if (url === '/extcandles') {
    if (req.method !== 'GET') { res.writeHead(405).end(); return }
    const qs   = new URLSearchParams(req.url.split('?')[1] || '')
    const tf   = (qs.get('tf') || '1D').trim()
    const want = (qs.get('s') || '').split(',').map(s => s.trim()).filter(s => EXT_MARKETS[s]).slice(0, 20)
    if (!want.length || !EXT_TF[tf]) {
      res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"series":{}}'); return
    }
    ;(async () => {
      const series = {}
      const ttl = EXT_SERIES_TTL[tf] ?? EXT_SERIES_TTL_DEFAULT
      await Promise.all(want.map(async (sym) => {
        const key = sym + '|' + tf
        const hit = extSeriesCache.get(key)
        if (hit && Date.now() - hit.at < ttl) { series[sym] = hit.pts; return }
        try {
          const r = await fetch(extChartUrlTf(extYahoo(sym), tf), {
            headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000),
          })
          if (!r.ok) return
          const pts = parseSeries(await r.json(), tf)
          // An EMPTY series is cached like any other: over a weekend the dollar index really
          // has no ticks in the last 24 hours, and re-asking Yahoo every minute for an answer
          // that cannot change until Monday is a fetch nobody needs. It is still sent, so the
          // client can say "closed" rather than "loading" forever.
          extSeriesCache.set(key, { at: Date.now(), pts })
          series[sym] = pts
        } catch { /* leave it out: absent means unknown, empty means shut */ }
      }))
      if (extSeriesCache.size > 400) extSeriesCache.clear()
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' })
         .end(JSON.stringify({ series }))
    })()
    return
  }

  // / is the landing page; the app lives at /app (see landing.html for who gets redirected
  // past it). /app is not a file, so the navigation fallback below serves it index.html —
  // that is the whole of the app's route. /app/ is sent to /app so the page has one URL.
  if (url === '/app/') {
    const qs = req.url.slice(url.length)
    res.writeHead(301, { Location: '/app' + qs }).end()
    return
  }
  if (url === '/index.html') {
    res.writeHead(301, { Location: '/app' }).end()
    return
  }

  // /markets — every Hyperliquid asset ranked (markets.html). Public, like the landing.
  if (url === '/markets/') {
    res.writeHead(301, { Location: '/markets' + req.url.slice(url.length) }).end()
    return
  }
  if (url === '/markets') return serveFile(res, join(DIST, 'markets.html'))
  // /portfolios — build a basket and backtest it (portfolio.html). Public, like /markets.
  if (url === '/portfolios/') {
    res.writeHead(301, { Location: '/portfolios' + req.url.slice(url.length) }).end()
    return
  }
  if (url === '/portfolios') return serveFile(res, join(DIST, 'portfolio.html'))

  // Static files
  const candidate = join(DIST, url === '/' ? 'landing.html' : url)
  if (existsSync(candidate) && !candidate.endsWith('/')) return serveFile(res, candidate)

  // SPA fallback — but ONLY for real navigations. Returning index.html with a 200
  // for a missing font/script/image makes the browser download 150KB of HTML and
  // then fail to parse it (Chrome reports it as a slow-network font intervention).
  // Sec-Fetch-Dest tells us what the request is for; clients that omit it (curl,
  // old browsers) fall back to "does the path look like a file?".
  // /app is the app's own route and is answered unconditionally. A page load that the
  // service worker re-fetches can arrive with Sec-Fetch-Dest: empty rather than document, and
  // judging /app by that header 404'd the whole app on the day it moved there from / (which
  // never hit this branch, being a real file). Sec-Fetch-Mode: navigate counts for the same reason.
  if (url === '/app') return serveFile(res, join(DIST, 'index.html'))
  const dest = req.headers['sec-fetch-dest']
  const isNavigation = req.headers['sec-fetch-mode'] === 'navigate' || (dest
    ? dest === 'document'
    : !/\.[a-z0-9]{2,8}$/i.test(url))

  if (!isNavigation) { res.writeHead(404).end(); return }
  serveFile(res, join(DIST, 'index.html'))
}).listen(PORT, () => {
  console.log(`Insolvent Trade — serving on http://localhost:${PORT}`)
})
