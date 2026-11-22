/**
 * The Oracle's server-side logger: "log every coin automatically even if nobody opens it".
 *
 * Until this, a market entered the live record only when somebody had its card on screen, so the
 * record was a record of what people happened to look at. Now serve-prod.js runs this over every
 * main-dex perp: each hour it reads the market the way the tab does (oraclescore.js) and logs one
 * call per horizon slot (outlooklog.js OL_CADENCE) at the book's mid. Browsers still log what they
 * show — HIP-3 and spot markets are only logged that way — and a call already logged for a slot is
 * not logged twice, whoever was first.
 *
 * Its budget is the bots'. This box trades from the same IP, so the logger keeps to its own
 * ceiling (budgetPerMin, 100 weight a minute ≈ 8% of the IP's refill) and works one market per
 * tick, a few requests at a time; a 429 stops it for ten minutes. Typical spend is lower, ~40 a
 * minute, because almost nothing is refetched:
 *   - the book (three aggregations, 2 each) every hour, for the ratio and the price;
 *   - 4h candles only when a new 4h candle has begun, the forming one patched from the mid between;
 *   - daily when the day turns, weekly once a day; all from the last candle kept, not a year again.
 * A market seen for the first time costs ~130 (a year of 4h, 1000 days, 3000 days of weekly), so a
 * cold start takes a few hours to reach every market, stalest first. What it has is kept on disk
 * per market (dir/<coin>.json), so a restart or a deploy picks up where it was.
 *
 * pm2 runs two workers and both call tick(); a lease file makes one of them the logger. The holder
 * touches it every tick; a lease untouched for a minute is a worker that died or was reloaded.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync, renameSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { toCandles, parseBooks, bookMid, bookRatio } from './zones.js'
import { mergeCandles, readFrom } from './candlestore.js'
import { weightOf } from './hlbudget.js'
import { readingsFor } from './oraclescore.js'
import { OL_HOURS } from './outlooklog.js'

const HOUR = 3600e3, DAY = 24 * HOUR
// The same spans the Analysis tab reads (analysis.js SPAN), so the score is read from the same history.
export const SPAN = { '4h': 365 * DAY, '1d': 1000 * DAY, '1w': 3000 * DAY }
export const LEASE_MS = 60e3
export const BACKOFF_MS = 10 * 60e3
const FLUSH_MS = 2 * 60e3, FLUSH_N = 120

/** Which candle series a market's kept copy needs refreshed at `now`. */
export function needs(m, now) {
  const at = m?.at ?? {}
  const out = []
  // A new 4h candle has begun since the last read: fetch. In between, the mid patches the one forming.
  if (!m?.candles?.['4h']?.length || Math.floor(now / (4 * HOUR)) !== Math.floor((at['4h'] ?? 0) / (4 * HOUR))) out.push('4h')
  if (!m?.candles?.['1d']?.length || Math.floor(now / DAY) !== Math.floor((at['1d'] ?? 0) / DAY)) out.push('1d')
  if (!m?.candles?.['1w']?.length || now - (at['1w'] ?? 0) > DAY) out.push('1w')
  return out
}

/** The forming candle, moved to the price now: close at the mid, high and low stretched to it. */
export function patchLast(c, px) {
  const k = c?.at(-1)
  if (!k || !(px > 0)) return c
  return [...c.slice(0, -1), { ...k, c: px, h: Math.max(k.h, px), l: Math.min(k.l, px) }]
}

/** metaAndAssetCtxs → the main-dex perps that trade, with funding (% an hour). */
export function marketsOf(res) {
  const [meta, ctxs] = Array.isArray(res) ? res : []
  const out = []
  ;(meta?.universe ?? []).forEach((u, i) => {
    if (!u?.name || u.isDelisted) return
    const f = Number(ctxs?.[i]?.funding)
    out.push({ coin: u.name, fundingPctHr: Number.isFinite(f) ? f * 100 : null })
  })
  return out
}

/** The market to read next: never read this hour, stalest first. Null when all are done. */
export function nextCoin(coins, done, now) {
  const hour = Math.floor(now / HOUR)
  let best = null
  for (const c of coins) {
    const d = done[c] ?? -1
    if (d >= hour) continue
    if (best == null || d < (done[best] ?? -1)) best = c
  }
  return best
}

const fileOf = (dir, coin) => join(dir, coin.replace(/[^A-Za-z0-9_-]/g, '_') + '.json')
function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
function writeJson(f, v) { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, f) }

/**
 * `info(body)` posts to Hyperliquid's /info and returns the JSON (a 429 throws with .rateLimited);
 * `addEntries(list)` logs [{ coin, hours, score, sigma, px, t }] (serve-prod.js, under its lock).
 */
export function createOracleLogger({ dir, info, addEntries, budgetPerMin = 100, now = () => Date.now(), log = console }) {
  mkdirSync(dir, { recursive: true })
  const LEASE = join(dir, 'lease'), STATE = join(dir, 'state.json')
  let busy = false, backoff = 0, spent = [], pending = [], lastFlush = 0
  let st = null    // { coins: [{coin, fundingPctHr}], ctxAt, done: {coin: hour} }

  const room = () => { const t = now(); spent = spent.filter(x => t - x.t < 60e3); return budgetPerMin - spent.reduce((s, x) => s + x.w, 0) }
  async function ask(body, w) {
    if (room() < w) return { skipped: true }
    spent.push({ t: now(), w })
    try { return { res: await info(body) } }
    catch (e) { if (e?.rateLimited) { backoff = now() + BACKOFF_MS; log.warn?.('[oracle] rate limited, standing down 10 min') } return { err: e, limited: !!e?.rateLimited } }
  }
  function holdLease() {
    try {
      const t = now(), mine = String(process.pid)
      if (existsSync(LEASE)) {
        const who = readFileSync(LEASE, 'utf8').trim()
        if (who !== mine && t - statSync(LEASE).mtimeMs < LEASE_MS) return false
      }
      writeFileSync(LEASE, mine)
      return true
    } catch { return false }
  }
  function flush(force = false) {
    if (!pending.length) return
    if (!force && pending.length < FLUSH_N && now() - lastFlush < FLUSH_MS) return
    const list = pending; pending = []
    try { addEntries(list); lastFlush = now() } catch (e) { log.warn?.('[oracle] log write failed:', e.message); pending = list.concat(pending) }
  }

  async function step() {
    // Re-read each step: the lease may have been the other worker's since this one last held it.
    st = readJson(STATE) ?? st ?? { coins: [], ctxAt: 0, done: {} }
    if (!st.coins.length || now() - st.ctxAt > 55 * 60e3) {
      const r = await ask({ type: 'metaAndAssetCtxs' }, weightOf('metaAndAssetCtxs'))
      if (!r.res) return
      const ms = marketsOf(r.res)
      if (ms.length) { st.coins = ms; st.ctxAt = now() }
    }
    const coin = nextCoin(st.coins.map(m => m.coin), st.done, now())
    if (!coin) return flush(true)
    const f = fileOf(dir, coin)
    const m = readJson(f) ?? { coin, candles: {}, at: {} }
    // Candles first, one series at a time; whatever did not fit the budget waits for the next tick.
    for (const tf of needs(m, now())) {
      const kept = m.candles[tf], spanStart = now() - SPAN[tf]
      const req = { coin, interval: tf, startTime: readFrom(kept, spanStart), endTime: now() }
      const r = await ask({ type: 'candleSnapshot', req }, weightOf('candleSnapshot', { req }))
      if (r.skipped || r.limited) { writeJson(f, m); return }
      if (r.err) { st.done[coin] = Math.floor(now() / HOUR); writeJson(f, m); return }
      const fresh = toCandles(r.res)
      m.candles[tf] = kept?.length ? mergeCandles(kept, fresh, spanStart) : fresh
      m.at[tf] = now()
    }
    if (!m.candles['4h']?.length || !m.candles['1d']?.length) { st.done[coin] = Math.floor(now() / HOUR); writeJson(f, m); return }
    // The book: the ratio, and the price this call is logged at.
    const raws = []
    for (const n of [undefined, 3, 2]) {
      const r = await ask(n ? { type: 'l2Book', coin, nSigFigs: n } : { type: 'l2Book', coin }, weightOf('l2Book'))
      // A 429 stops the market here: the next request would only be throttled too.
      if (r.skipped || r.limited) { writeJson(f, m); return }
      raws.push(r.res ?? null)
    }
    const books = parseBooks(raws)
    const px = bookMid(books)
    st.done[coin] = Math.floor(now() / HOUR)
    if (!(px > 0)) { writeJson(f, m); return }
    const candles = { '4h': patchLast(m.candles['4h'], px), '1d': patchLast(m.candles['1d'], px), '1w': m.candles['1w'] ?? [] }
    const ratio = bookRatio(books)?.ratio ?? null
    const fundingPctHr = st.coins.find(x => x.coin === coin)?.fundingPctHr ?? null
    const t = now()
    const rd = readingsFor({ candles, price: px, ratio, fundingPctHr, hours: OL_HOURS, now: t })
    for (const h of OL_HOURS) if (rd[h]) pending.push({ coin, hours: h, score: rd[h].score, sigma: rd[h].sigma, px, t })
    m.ratio = ratio
    writeJson(f, m)
    flush()
  }

  return {
    async tick() {
      if (busy || now() < backoff || !holdLease()) return
      busy = true
      try { await step() }
      catch (e) { log.warn?.('[oracle] tick failed:', e.message) }
      finally {
        try { if (st) writeJson(STATE, st) } catch {}
        busy = false
      }
    },
    flush: () => flush(true),
    _state: () => st,
  }
}
