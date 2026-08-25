#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Grid Bot (classic long grid)
 *
 * Places a fixed grid of limit orders between --lower and --upper:
 *   - BUY orders at every level below the current price
 *   - when a buy at level i fills, a reduce-only SELL is placed at level i+1
 *   - when that sell fills, the buy at level i is re-armed
 *   - a level is never re-bought while its paired sell is still open
 *
 * The exchange is the source of truth: every cycle the bot fetches its open
 * orders, derives the desired grid state, and places/cancels only the diff.
 * This makes the bot idempotent — restarts, timeouts, or lost responses can
 * never produce duplicate orders at a level.
 *
 * Defaults: range = mark ±10%, 10 levels, $50/level, 1x. All overridable.
 *
 * Usage:
 *   node strategies/grid.js \
 *     --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --coin ETH [--lower 2000] [--upper 3000] \
 *     [--levels 10 | --pct-interval 1.5] [--size 50] [--leverage 1] [--interval 15]
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused, onPause, onResume } from './_pause.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:         { type: 'string' },
    address:        { type: 'string' },
    coin:           { type: 'string', default: 'ETH' },
    lower:          { type: 'string', default: '0'  },  // 0 = auto: mark −10%
    upper:          { type: 'string', default: '0'  },  // 0 = auto: mark +10%
    levels:         { type: 'string', default: '10' },
    size:           { type: 'string', default: '0'  },  // USD per level; 0 = auto from balance
    'size-pct':     { type: 'string', default: '50' },  // % of free margin used when auto-sizing
    leverage:       { type: 'string', default: '1'  },
    interval:       { type: 'string', default: '15' },  // check cycle, seconds
    'pct-interval': { type: 'string', default: '0'  },  // % gap between levels (overrides --levels when >0)
    side:           { type: 'string', default: 'long' }, // 'long' (buy low, sell high) | 'short' (inverted)
    margin:         { type: 'string', default: 'cross' }, // 'cross' | 'isolated'
    'health-stop':  { type: 'string', default: '70' },   // stop adding to the position when health ≤ this % (0 = disable)
    'profit-band':  { type: 'string', default: '12' },   // auto-range width (%) anchored at avg entry when a position is open
    'total-margin': { type: 'string', default: '0'  },   // cap the margin THIS position may use (cross or isolated, per grid; 0 = off)
  },
  allowPositionals: false,
  strict: false,   // ignore unknown flags (e.g. legacy --entry-gap from older UI)
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

// HIP-3 (builder-deployed) markets are prefixed "dex:SYM" (e.g. "xyz:TSLA").
// The dex prefix is lowercase, the symbol uppercase. Reads must be dex-scoped
// and the asset id is computed differently (see getAssetInfo).
// HIP-3 vars are `let` — a bare TradFi symbol (e.g. "SPCX") not found on the main dex
// is resolved to its builder dex at startup (see resolveCoin()).
const _rawCoin     = String(args.coin)
let   IS_HIP3      = _rawCoin.includes(':')
let   DEX          = IS_HIP3 ? _rawCoin.split(':')[0].toLowerCase() : null
let   COIN         = IS_HIP3 ? `${DEX}:${_rawCoin.split(':')[1].toUpperCase()}` : _rawCoin.toUpperCase()
// Read-query args: HIP-3 endpoints need the dex param; main dex omits it.
let   Q            = (addr) => DEX ? { user: addr, dex: DEX } : { user: addr }
let   MIDS_ARG     = DEX ? { dex: DEX } : undefined
const IS_SHORT     = String(args.side || 'long').toLowerCase() === 'short'
const IS_ISOLATED  = String(args.margin || 'cross').toLowerCase() === 'isolated'
const TOTAL_MARGIN = parseFloat(args['total-margin']) || 0   // per-position margin cap (cross or isolated); 0 = off
let   ORDER_USD    = parseFloat(args.size)   // 0 → auto-sized from balance in run()
const SIZE_PCT     = Math.min(1, Math.max(0.01, (parseFloat(args['size-pct']) || 50) / 100))
const LEVERAGE     = parseInt(args.leverage)
const PCT_INTERVAL = parseFloat(args['pct-interval'] ?? '0')
const PCT_SPACING  = PCT_INTERVAL > 0
// Preview mode. The UI asks the bot what it WOULD do rather than recomputing the ladder
// itself, because the answer depends on live account state — the range can anchor to an
// open position's average entry, and the per-level size is derived from the capital
// actually available to trade. A second implementation in the browser would drift from
// this one and quietly show a plan the bot was never going to follow.
const PLAN_ONLY    = !!args.plan
const CHECK_MS     = Math.max(5, parseInt(args.interval) || 15) * 1000
const HL_MIN_ORDER = 10          // USD — HL rejects orders below this notional
const MAX_PLACE_PER_CYCLE = 8    // be gentle with the API / avoid bursts
const PROFIT_BUFFER = 0.0005     // exits must clear the avg entry by ≥0.05% (covers fees) — never close at a loss
const HEALTH_STOP   = parseFloat(args['health-stop'] ?? '70')   // stop adding to position when position health ≤ this % (0 = off)
const PROFIT_BAND   = Math.max(0.01, (parseFloat(args['profit-band']) || 12) / 100)   // auto-range band anchored at avg entry

// LOWER/UPPER/LEVELS resolved in run() (auto-range needs the mark price)
let LOWER  = parseFloat(args.lower)
let UPPER  = parseFloat(args.upper)
let LEVELS = parseInt(args.levels)

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const ADDRESS     = etherWallet.address          // agent key — used for signing
const QUERY_ADDR  = args.address ?? ADDRESS      // master wallet — used for all read queries

// ─── STATE ────────────────────────────────────────────────────────────────────
let PRICES = []                 // fixed level prices, computed once at start
const trackedOids = new Map()   // oid → { side, levelIdx, px, sz } — for fill detection / logging
let _marginBackoffUntil = 0     // pause new buys after an insufficient-margin rejection
let realizedPnl  = 0            // cumulative realized P&L — sourced from HL fills (matches HL exactly)
let totalFees    = 0            // cumulative fees from HL fills
let lastFillScan = 0            // high-water timestamp of fills already counted
const warnedForeign = new Set() // oids of non-grid orders we've already logged

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let m = msg
  // Trim noisy upstream errors (e.g. the HL API returning a full 502 HTML page) to one line.
  if (tag.trim() === 'ERROR' && typeof m === 'string') {
    const h = m.search(/<\s*html/i)
    if (h !== -1) m = m.slice(0, h).replace(/[-\s]+$/, '').trim() || ((m.match(/<title>([^<]+)<\/title>/i) || [])[1] || 'HTML error').trim()
    m = m.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  console.log(`[${ts}] [${tag.padEnd(8)}] ${m}`)
}

function roundPx(n, szDecimals) {
  // HL price tick: <=5 significant figures AND <=(6 - szDecimals) decimals. The old
  // magnitude form applied only the sig-fig cap, so a low-priced / high-szDecimals asset
  // could emit too many decimals and HL rejected the order ("not divisible by tick size").
  // szDecimals omitted => pure 5-sig-fig (unchanged behavior for range/threshold math).
  const f = parseFloat(n)
  if (!(f > 0)) return 0
  const sig = parseFloat(f.toPrecision(5))
  if (szDecimals == null) return sig
  const maxDec = Math.max(0, 6 - szDecimals)
  const factor = Math.pow(10, maxDec)
  return Math.round(sig * factor) / factor
}

function roundSz(n, szDecimals = 6, px = 0) {
  const factor  = Math.pow(10, szDecimals)
  const minTick = 1 / factor
  let   sz      = Math.floor(parseFloat(n) * factor) / factor
  // If flooring caused the notional to fall below HL's $10 minimum, add one tick
  if (px > 0 && sz * px < HL_MIN_ORDER) sz = Math.round((sz + minTick) * factor) / factor
  return sz
}

// ─── ASSET INDEX CACHE ────────────────────────────────────────────────────────
let _meta = null

async function getAssetInfo(coin) {
  if (!_meta) {
    _meta = {}
    if (DEX) {
      // HIP-3 asset id = 100000 + perpDexIndex*10000 + indexInDexUniverse.
      // perpDexs[0] is null (main dex); builder dexes start at index 1.
      const [dexs, meta] = await Promise.all([info.perpDexs(), info.meta({ dex: DEX })])
      const dexIdx = (dexs ?? []).findIndex(d => d && d.name === DEX)
      if (dexIdx < 1) throw new Error(`Unknown perp dex: ${DEX}`)
      ;(meta.universe ?? []).forEach((u, i) => {
        _meta[u.name] = { index: 100000 + dexIdx * 10000 + i, szDecimals: u.szDecimals ?? 6 }
      })
    } else {
      const meta = await info.meta()
      ;(meta.universe ?? []).forEach((u, i) => {
        _meta[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 }
      })
    }
  }
  const asset = _meta[coin]
  if (!asset) throw new Error(`Unknown coin: ${coin}`)
  return asset
}

// ─── GRID PRICE LEVELS ────────────────────────────────────────────────────────
// Level prices become RESTING orders, so they must be tick-valid for the asset —
// pass szDecimals so roundPx applies the decimal cap, not just the sig-fig cap.
function computePrices(szDecimals) {
  if (PCT_SPACING) {
    // Geometric: equal % gap between each level
    const ratio = Math.pow(UPPER / LOWER, 1 / (LEVELS - 1))
    return Array.from({ length: LEVELS }, (_, i) => roundPx(LOWER * Math.pow(ratio, i), szDecimals))
  }
  // Linear: equal $ gap between each level
  const step = (UPPER - LOWER) / (LEVELS - 1)
  return Array.from({ length: LEVELS }, (_, i) => roundPx(LOWER + i * step, szDecimals))
}

// Gap size around level i — used as the matching tolerance and the dead zone
// around the mark price.
function gapAt(i) {
  if (PRICES.length < 2) return PRICES[0] * 0.01
  if (i >= PRICES.length - 1) return PRICES[i] - PRICES[i - 1]
  return PRICES[i + 1] - PRICES[i]
}

// Per-level order size in coin units. Exits use the size of the entry one
// level past them (long: a sell at i closes the lot bought at i−1;
// short: a buy at i closes the lot sold at i+1).
function entrySzAt(i, szDecimals) {
  return roundSz(ORDER_USD / PRICES[i], szDecimals, PRICES[i])
}
function exitSzAt(i, szDecimals) {
  const srcIdx = IS_SHORT ? Math.min(PRICES.length - 1, i + 1) : Math.max(0, i - 1)
  return roundSz(ORDER_USD / PRICES[srcIdx], szDecimals, PRICES[i])
}

// Profit gate: an exit is only allowed where it closes the position for a profit
// vs the average entry. Short covers must be below avg entry; long exits above.
// When no position basis is known, don't gate (nothing to lose).
function exitProfitable(px, avgEntry) {
  if (!(avgEntry > 0)) return true
  return IS_SHORT ? px <= avgEntry * (1 - PROFIT_BUFFER)
                  : px >= avgEntry * (1 + PROFIT_BUFFER)
}

// ─── EXCHANGE SNAPSHOT ────────────────────────────────────────────────────────
// Fetch open orders and map them onto grid levels. Returns:
//   levelOrders: Map levelIdx → { oid, side, px, sz }
//   surplus:     orders that map to an already-occupied level (duplicates to cancel)
async function snapshotOrders() {
  const open  = (await info.openOrders(Q(QUERY_ADDR)) ?? []).filter(o => o.coin === COIN)
  const levelOrders = new Map()
  const surplus = []
  const foreign = []

  for (const o of open) {
    const px  = parseFloat(o.limitPx)
    const oid = String(o.oid)

    // Match to the nearest level within 40% of the local gap
    let best = -1, bestDist = Infinity
    for (let i = 0; i < PRICES.length; i++) {
      const d = Math.abs(PRICES[i] - px)
      if (d < bestDist) { bestDist = d; best = i }
    }
    const fEntry = { oid, side: o.side === 'B' ? 'buy' : 'sell', px, sz: parseFloat(o.sz), reduceOnly: !!(o.reduceOnly ?? o.isReduceOnly) }
    if (best === -1 || bestDist > gapAt(best) * 0.4) {
      // Not a grid order for the current range (manual order, or leftover from a
      // previous run with a different range). Tracked so loss-making leftover
      // exits can be cancelled by the profit gate.
      foreign.push(fEntry)
      if (!warnedForeign.has(oid)) {
        warnedForeign.add(oid)
        log('FOREIGN', `Non-grid order oid=${oid} @ $${px} (no level within tolerance)`)
      }
      continue
    }

    if (levelOrders.has(best)) {
      surplus.push({ levelIdx: best, ...fEntry })
    } else {
      levelOrders.set(best, fEntry)
    }
  }

  return { levelOrders, surplus, foreign }
}

// ─── FILL DETECTION (for logs & P&L only — placement never depends on this) ──
async function detectFills(levelOrders) {
  const openOids = new Set([...levelOrders.values()].map(e => e.oid))
  const gone = [...trackedOids.entries()].filter(([oid]) => !openOids.has(oid))

  for (const [oid, t] of gone) {
    trackedOids.delete(oid)
    try {
      const res    = await info.orderStatus({ user: QUERY_ADDR, oid: parseInt(oid) })
      const status = res?.order?.status ?? ''
      if (status === 'filled') {
        log('FILL', `Level ${t.levelIdx} ${t.side.toUpperCase()} @ $${t.px} filled  sz=${t.sz}`)
        if (t.side === (IS_SHORT ? 'buy' : 'sell')) {
          // An exit filled — one grid cycle complete. Per-lot prices shown for
          // reference; the cumulative realized P&L comes from HL fills below.
          const entryPx = IS_SHORT
            ? PRICES[Math.min(PRICES.length - 1, t.levelIdx + 1)]
            : PRICES[Math.max(0, t.levelIdx - 1)]
          log('WIN', `${COIN} grid cycle complete | ${IS_SHORT ? `sell $${entryPx} → buy $${t.px}` : `buy $${entryPx} → sell $${t.px}`}`)
        }
      } else {
        log('GONE', `Level ${t.levelIdx} ${t.side.toUpperCase()} oid=${oid} ${status || 'removed'} (not filled)`)
      }
    } catch {
      log('GONE', `Level ${t.levelIdx} ${t.side.toUpperCase()} oid=${oid} — status check failed`)
    }
  }
}

// ─── REALIZED P&L — sourced from HL fills (matches HL's average-cost accounting) ──
// Incrementally pulls only fills newer than the last seen, sums their closedPnl
// for this coin. This is literally the number HL shows, not a local estimate.
async function updateRealized() {
  try {
    const fills = await info.userFillsByTime({ user: QUERY_ADDR, startTime: lastFillScan + 1 })
    if (!Array.isArray(fills) || !fills.length) return
    for (const f of fills) {
      if (f.time > lastFillScan) lastFillScan = f.time
      if (f.coin !== COIN) continue
      realizedPnl += parseFloat(f.closedPnl ?? 0)
      totalFees   += parseFloat(f.fee ?? 0)
    }
  } catch { /* keep last known totals; retry next cycle */ }
}

// ─── ORDER OPS ────────────────────────────────────────────────────────────────
async function placeOrder(levelIdx, side, sz, reduceOnly) {
  const { index } = await getAssetInfo(COIN)
  const px = PRICES[levelIdx]

  const result = await exchange.order({
    orders: [{
      a: index,
      b: side === 'buy',
      p: px.toString(),
      s: sz.toString(),
      r: reduceOnly,
      t: { limit: { tif: 'Alo' } },   // post-only: never crosses the book
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))

  const oid = String(statuses[0]?.resting?.oid ?? '')
  if (oid) trackedOids.set(oid, { side, levelIdx, px, sz })
  log('PLACE', `Level ${String(levelIdx).padStart(2)} ${side.toUpperCase()} @ $${px}  sz=${sz}  oid=${oid}`)
}

async function cancelOid(oid, why) {
  const { index } = await getAssetInfo(COIN)
  try {
    await exchange.cancel({ cancels: [{ a: index, o: parseInt(oid) }] })
    log('CANCEL', `oid=${oid} — ${why}`)
  } catch { /* already gone */ }
  trackedOids.delete(String(oid))
}

// Pause: FREEZE — leave resting orders in place and the position untouched; the bot
// just stops placing/cancelling/reconciling until resumed. Resume continues management.
onPause(()  => log('PAUSE', 'Paused — resting orders left in place, bot frozen (no place/cancel/reconcile) until resumed'))
onResume(() => log('RESUME', 'Resumed — managing grid again next cycle'))

// ─── CLOSE ENTIRE POSITION AT UPPER BOUNDARY ─────────────────────────────────
async function closeAtBoundary(markPx, levelOrders) {
  const bound = IS_SHORT ? `Lower $${LOWER}` : `Upper $${UPPER}`
  for (const e of levelOrders.values()) await cancelOid(e.oid, 'boundary hit')
  log('CLOSE', `Cancelled ${levelOrders.size} open grid order(s)`)

  const acctState = await info.clearinghouseState(Q(QUERY_ADDR))
  const pos       = (acctState.assetPositions ?? []).find(p => p.position.coin === COIN)
  const szi       = parseFloat(pos?.position?.szi ?? 0)
  const openSz    = IS_SHORT ? Math.max(0, -szi) : Math.max(0, szi)

  if (openSz <= 0) {
    log('CLOSE', `${bound} hit — no open ${IS_SHORT ? 'short' : 'long'} position. Grid stopped.`)
    process.exit(0)
  }

  const { index, szDecimals } = await getAssetInfo(COIN)
  const closePx = roundPx(IS_SHORT ? markPx * 1.01 : markPx * 0.99, szDecimals)   // IOC 1% through mark, tick-valid
  const closeSz = roundSz(openSz, szDecimals, closePx)

  log('CLOSE', `${bound} hit (mark $${markPx}) — closing ${IS_SHORT ? 'short' : 'long'} ${openSz} ${COIN} @ $${closePx} (IOC)`)
  try {
    const result   = await exchange.order({
      orders: [{ a: index, b: IS_SHORT, p: closePx.toString(), s: closeSz.toString(), r: true, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    })
    const statuses = result?.response?.data?.statuses ?? []
    const err      = statuses.filter(s => s.error).map(s => s.error)
    if (err.length) log('ERROR', `Close failed: ${err.join(', ')}`)
    else {
      const f = statuses[0]?.filled
      await sleep(2500)        // let the close fill register in HL's fill feed
      await updateRealized()
      log('CLOSE', `Position closed${f ? ` | avg $${f.avgPx}` : ''} | grid realized P&L: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(4)} (fees $${totalFees.toFixed(2)})`)
    }
  } catch (e) {
    log('ERROR', `Close order threw: ${e.message}`)
  }
  process.exit(0)
}

// ─── RECONCILE — derive desired grid state and apply the diff ─────────────────
async function reconcile() {
  const mids   = await info.allMids(MIDS_ARG)
  const markPx = parseFloat(mids[COIN] ?? 0)
  if (!markPx) { log('ERROR', `No price for ${COIN}`); return }

  const { levelOrders, surplus, foreign } = await snapshotOrders()

  // Take-profit boundary: long grids cash out at the TOP, short grids at the BOTTOM
  if (!IS_SHORT && markPx >= UPPER) { await closeAtBoundary(markPx, levelOrders); return }
  if (IS_SHORT  && markPx <= LOWER) { await closeAtBoundary(markPx, levelOrders); return }

  await detectFills(levelOrders)

  // Duplicate orders at the same level — cancel the extras (auto-heals old runs)
  for (const s of surplus) {
    await cancelOid(s.oid, `duplicate at level ${s.levelIdx}`)
  }

  // Inventory: open position size in the grid's direction determines exits
  const acctState = await info.clearinghouseState(Q(QUERY_ADDR))
  const pos       = (acctState.assetPositions ?? []).find(p => p.position.coin === COIN)
  const szi       = parseFloat(pos?.position?.szi ?? 0)
  const inventory = IS_SHORT ? Math.max(0, -szi) : Math.max(0, szi)
  const avgEntry  = parseFloat(pos?.position?.entryPx ?? 0)
  const { szDecimals } = await getAssetInfo(COIN)
  const szEps     = (ORDER_USD / UPPER) * 0.25   // tolerance: a quarter of the smallest lot

  // Account health = HL's "Unified Account Ratio": 1 − maintenanceMargin / USDC balance.
  // This is the % the app shows in the header, so a 70% stop means the same thing the
  // user sees. When it's at/under HEALTH_STOP we stop ADDING to the position (cancel
  // entry-side orders, place no new entries) — only profit-taking exits stay. 0 disables.
  const maintMargin = parseFloat(acctState.crossMaintenanceMarginUsed ?? acctState.marginSummary?.totalMarginUsed ?? 0)
  let spotUSDCTotal = 0
  try {
    const sp = await info.spotClearinghouseState({ user: QUERY_ADDR })
    const u  = (sp?.balances ?? []).find(b => b.coin === 'USDC')
    spotUSDCTotal = u ? parseFloat(u.total ?? 0) : 0
  } catch {}
  const perpAcctVal = parseFloat(acctState.marginSummary?.accountValue ?? 0)
  const marginBase  = spotUSDCTotal > 0 ? spotUSDCTotal : perpAcctVal
  const healthPct   = marginBase > 0 ? Math.max(0, (1 - maintMargin / marginBase) * 100) : 100

  // Stop ADDING to the position (cancel entry-side orders, place no new entries; exits
  // stay) when EITHER the per-position margin cap is hit OR account health is too low.
  // The cap reads THIS position's live margin (notional ÷ leverage in cross), so each
  // grid is bounded independently regardless of what other bots are doing.
  const posMarginUsed = parseFloat(pos?.position?.marginUsed ?? 0)
  const stopReason =
      (TOTAL_MARGIN > 0 && posMarginUsed >= TOTAL_MARGIN)        ? `position margin $${posMarginUsed.toFixed(2)} ≥ cap $${TOTAL_MARGIN.toFixed(2)}`
    : (HEALTH_STOP > 0 && inventory > 0 && healthPct <= HEALTH_STOP) ? `health ${healthPct.toFixed(1)}% ≤ ${HEALTH_STOP}%`
    : ''
  const stopEntries = !!stopReason

  let placed = 0
  const exitSide  = IS_SHORT ? 'buy'  : 'sell'
  const entrySide = IS_SHORT ? 'sell' : 'buy'

  // ── PROFIT GATE ──────────────────────────────────────────────────────────────
  // Never close at a loss: cancel any resting exit (current grid level OR a
  // leftover order from a previous run) that would close vs the average entry
  // on the losing side. Uncovered inventory simply waits — the bot accumulates
  // rather than buying back above where it sold (short) / selling below (long).
  if (avgEntry > 0) {
    for (const [i, e] of [...levelOrders.entries()]) {
      if (e.side === exitSide && !exitProfitable(e.px, avgEntry)) {
        await cancelOid(e.oid, `${exitSide} @ $${e.px} would close at a loss vs avg $${avgEntry.toFixed(5)} — held`)
        levelOrders.delete(i)
      }
    }
    for (const e of foreign) {
      // openOrders omits reduceOnly, so infer an exit from side: in a short grid
      // a buy is a cover, in a long grid a sell is a close. (reduceOnly !== false
      // keeps it correct if a richer order feed ever provides the flag.)
      const sideIsExit = (IS_SHORT && e.side === 'buy') || (!IS_SHORT && e.side === 'sell')
      const isExit = sideIsExit && e.reduceOnly !== false
      if (isExit && !exitProfitable(e.px, avgEntry)) {
        await cancelOid(e.oid, `leftover ${e.side} @ $${e.px} would close at a loss vs avg $${avgEntry.toFixed(5)} — cancelled`)
      }
    }
  }

  // ── EXITS (reduce-only) ──────────────────────────────────────────────────────
  // Existing exits are FIXED — a lot's exit stays at the level it was placed at,
  // even as price moves. We only:
  //   a) cancel exits no longer backed by inventory (farthest from mark first)
  //   b) place exits for uncovered inventory at the nearest eligible free levels
  //      past the mark (long: above it, short: below it)
  // The half-gap dead zone makes a fresh entry fill map its exit to the NEXT
  // level past it, never its own level.
  const openExits = [...levelOrders.entries()].filter(([, e]) => e.side === exitSide)
  let totalExitSz = openExits.reduce((s, [, e]) => s + e.sz, 0)

  let excess = totalExitSz - inventory
  if (excess > szEps) {
    const farthestFirst = [...openExits].sort((a, b) => IS_SHORT ? a[0] - b[0] : b[0] - a[0])
    for (const [i, e] of farthestFirst) {
      if (excess <= szEps) break
      await cancelOid(e.oid, `${exitSide} at level ${i} no longer backed by inventory`)
      levelOrders.delete(i)
      totalExitSz -= e.sz
      excess      -= e.sz
    }
  }

  let uncovered = inventory - totalExitSz
  const exitIdxs = [...PRICES.keys()]
  if (IS_SHORT) exitIdxs.reverse()   // shorts cover downward: nearest level below mark first
  // Spread the WHOLE uncovered position across the eligible profitable exit levels, so a
  // large position sells in proportionally big chunks rather than tiny ORDER_USD lots.
  // Each chunk = max(grid lot, even share of the position). Normal grids (small inventory)
  // are unchanged — the grid lot dominates there.
  const _eligibleExitCount = exitIdxs.filter(i => {
    const elig = IS_SHORT ? PRICES[i] < markPx - gapAt(i) * 0.5 : PRICES[i] > markPx + gapAt(i) * 0.5
    return elig && exitProfitable(PRICES[i], avgEntry) && !levelOrders.has(i)
  }).length
  const _exitShare = _eligibleExitCount > 0 ? uncovered / _eligibleExitCount : 0
  for (const i of exitIdxs) {
    if (placed >= MAX_PLACE_PER_CYCLE) break
    if (uncovered * PRICES[i] < HL_MIN_ORDER) break
    const eligible = IS_SHORT
      ? PRICES[i] < markPx - gapAt(i) * 0.5
      : PRICES[i] > markPx + gapAt(i) * 0.5
    if (!eligible) continue
    if (!exitProfitable(PRICES[i], avgEntry)) continue   // never place a losing close
    if (levelOrders.has(i)) continue
    const sz = roundSz(Math.min(Math.max(exitSzAt(i, szDecimals), _exitShare), uncovered), szDecimals, PRICES[i])
    if (sz * PRICES[i] < HL_MIN_ORDER) break
    try {
      await placeOrder(i, exitSide, sz, true)
      levelOrders.set(i, { oid: 'pending', side: exitSide, px: PRICES[i], sz })
      uncovered -= sz
      placed++
    } catch (e) {
      const msg = e.message ?? ''
      if (msg.includes('immediately match')) log('SKIP', `Exit level ${i} would cross the book — deferred`)
      else log('ERROR', `Exit level ${i}: ${msg} — retried next cycle`)
      break   // exits are sequential lots — don't skip ahead on failure
    }
  }

  // ── HEALTH STOP: don't add to the position when it's unhealthy ──────────────────
  // Cancel any resting entry-side orders and skip placing new ones — only the
  // profit-taking exits remain, so the position can only shrink, never grow.
  if (stopEntries) {
    for (const [i, e] of [...levelOrders.entries()]) {
      if (e.side === entrySide) {
        await cancelOid(e.oid, `${stopReason} — not adding to position`)
        levelOrders.delete(i)
      }
    }
  }

  // ── ENTRIES ──────────────────────────────────────────────────────────────────
  // Long: a buy at every level below mark. Short: a sell at every level above.
  // A level is skipped while its lot's exit (one level past it) is still open —
  // this is what prevents re-entering a level right after its fill.
  for (let i = 0; !stopEntries && i < PRICES.length; i++) {
    const eligible = IS_SHORT
      ? PRICES[i] > markPx + gapAt(i) * 0.5
      : PRICES[i] < markPx - gapAt(i) * 0.5
    if (!eligible) continue
    const pairIdx = IS_SHORT ? i - 1 : i + 1
    const blocked = levelOrders.get(pairIdx)?.side === exitSide
    const open    = levelOrders.get(i)

    if (open?.side === entrySide) {
      if (blocked) {
        await cancelOid(open.oid, `${entrySide} at level ${i} blocked — lot's exit still open at ${pairIdx}`)
        levelOrders.delete(i)
      }
      continue
    }
    if (open || blocked || placed >= MAX_PLACE_PER_CYCLE) continue
    if (Date.now() < _marginBackoffUntil) continue   // margin exhausted — don't spam

    try {
      await placeOrder(i, entrySide, entrySzAt(i, szDecimals), false)
      levelOrders.set(i, { oid: 'pending', side: entrySide, px: PRICES[i], sz: 0 })
      placed++
    } catch (e) {
      const msg = e.message ?? ''
      if (msg.includes('immediately match')) {
        log('SKIP', `Entry level ${i} would cross the book — deferred`)
      } else if (/margin/i.test(msg)) {
        _marginBackoffUntil = Date.now() + 10 * 60 * 1000
        log('WARN', `Insufficient margin at level ${i} — pausing new entries for 10 min (exits/cancels unaffected)`)
        break
      } else {
        log('ERROR', `Entry level ${i}: ${msg} — retried next cycle`)
      }
    }
  }

  await updateRealized()
  const liveBuys  = [...levelOrders.values()].filter(e => e.side === 'buy').length
  const liveSells = [...levelOrders.values()].filter(e => e.side === 'sell').length
  const held = uncovered > szEps && avgEntry > 0
    ? `  | holding ${uncovered.toFixed(2)} (no profitable exit vs avg $${avgEntry.toFixed(5)})`
    : ''
  const healthStr = inventory > 0 ? ` | health ${healthPct.toFixed(1)}%${stopEntries ? ' (adds paused — sell only)' : ''}` : ''
  log('SCAN', `mark $${markPx} | inv ${inventory.toFixed(4)} ${COIN} ${IS_SHORT ? 'short' : 'long'}${healthStr} | ${liveBuys} buys / ${liveSells} sells | realized P&L: ${realizedPnl >= 0 ? '+' : ''}$${realizedPnl.toFixed(4)}${held}`)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
// Resolve a bare TradFi symbol (no "dex:" prefix) that isn't on the main dex to its
// builder dex, so the grid works on HIP-3 markets even when only the symbol is passed.
async function resolveCoin() {
  if (IS_HIP3) return                                   // already "dex:SYM"
  const mainMids = await info.allMids().catch(() => ({}))
  if (parseFloat(mainMids[COIN] ?? 0) > 0) return       // exists on main dex
  let dexs = []
  try { dexs = await info.perpDexs() } catch { return }
  for (const d of (dexs ?? [])) {
    if (!d?.name) continue                              // index 0 (main) is null
    try {
      const dmids = await info.allMids({ dex: d.name })
      const key = Object.keys(dmids).find(k => k.split(':').pop().toUpperCase() === COIN && parseFloat(dmids[k]) > 0)
      if (key) {
        IS_HIP3 = true; DEX = d.name.toLowerCase(); COIN = key
        Q = (addr) => ({ user: addr, dex: DEX }); MIDS_ARG = { dex: DEX }
        log('INIT', `Resolved "${_rawCoin}" → ${COIN} on HIP-3 dex "${DEX}"`)
        return
      }
    } catch {}
  }
  log('WARN', `Could not find "${_rawCoin}" on the main dex or any HIP-3 dex — orders may fail`)
}

async function run() {
  await resolveCoin()
  const allMids = await info.allMids(MIDS_ARG)
  const markPx  = parseFloat(allMids[COIN] ?? 0)
  if (!markPx) { log('ERROR', `No price for ${COIN}`); process.exit(1) }

  // Account state up front — needed both for position-aware auto-range and capital.
  const [acct0, spot0, aad0] = await Promise.all([
    info.clearinghouseState(Q(QUERY_ADDR)),
    info.spotClearinghouseState({ user: QUERY_ADDR }).catch(() => null),
    info.activeAssetData({ user: QUERY_ADDR, coin: COIN }).catch(() => null),
  ])

  // Range resolution:
  //   • Explicit --lower/--upper provided  → use them (skip auto).
  //   • No bounds + position OPEN in coin   → AUTO anchored to avg entry (profitable
  //       ladder: long avg → avg+band, short avg−band → avg).
  //   • No bounds + no position             → AUTO mark ±10%.
  // (Restarts strip stored bounds server-side, so a restart always re-derives auto.)
  {
    const _p0   = (acct0.assetPositions ?? []).find(p => p.position.coin === COIN)
    const _szi0 = parseFloat(_p0?.position?.szi ?? 0)
    const _avg0 = parseFloat(_p0?.position?.entryPx ?? 0)
    const _hasPos = (IS_SHORT ? _szi0 < 0 : _szi0 > 0) && _avg0 > 0
    if (!(LOWER > 0) && !(UPPER > 0) && _hasPos) {
      if (IS_SHORT) {
        UPPER = roundPx(_avg0)
        LOWER = roundPx(Math.min(_avg0, markPx) * (1 - PROFIT_BAND))
      } else {
        LOWER = roundPx(_avg0)
        UPPER = roundPx(Math.max(_avg0, markPx) * (1 + PROFIT_BAND))
      }
      log('INIT', `Auto-range anchored to avg entry $${_avg0} (position open) → $${LOWER}–$${UPPER} (${(PROFIT_BAND * 100).toFixed(0)}% band)`)
    } else {
      if (!(LOWER > 0)) LOWER = roundPx(markPx * 0.90)
      if (!(UPPER > 0)) UPPER = roundPx(markPx * 1.10)
    }
  }
  if (LOWER >= UPPER) { console.error('ERROR: --lower must be less than --upper'); process.exit(1) }

  if (PCT_SPACING) {
    LEVELS = Math.max(2, Math.floor(Math.log(UPPER / LOWER) / Math.log(1 + PCT_INTERVAL / 100)) + 1)
  }
  if (!(LEVELS >= 2)) { console.error('ERROR: --levels must be ≥ 2'); process.exit(1) }

  const { szDecimals: _levelSzDec } = await getAssetInfo(COIN)
  PRICES = computePrices(_levelSzDec)

  // activeAssetData.availableToTrade is the authoritative max-openable NOTIONAL and
  // already reflects UNIFIED collateral (spot USDC counts toward perp margin) — so it
  // works for both main-dex and HIP-3, unlike `withdrawable` (perp-sub-account only,
  // reads ~0 on a unified account or when funds are in an isolated position). It bakes
  // in leverage, so /LEVERAGE gives a margin-equiv the ×LEVERAGE auto-size restores.
  const availVals = (aad0?.availableToTrade ?? []).map(x => Math.max(0, parseFloat(x) || 0)).filter(v => v > 0)
  const availNtl  = availVals.length ? Math.min(...availVals) : 0
  const usdcBal      = (spot0?.balances ?? []).find(b => b.coin === 'USDC')
  const spotFree     = (!IS_HIP3 && usdcBal) ? Math.max(0, parseFloat(usdcBal.total ?? 0) - parseFloat(usdcBal.hold ?? 0)) : 0
  const withdrawable = parseFloat(acct0.withdrawable ?? 0)

  // Prefer availableToTrade. Only fall back to withdrawable + spot USDC (legacy,
  // non-unified) when activeAssetData is unavailable.
  let freeMargin, capital, capSrc
  if (availNtl > 0) {
    freeMargin = LEVERAGE > 0 ? availNtl / LEVERAGE : availNtl
    capital    = freeMargin
    capSrc     = `$${availNtl.toFixed(2)} available to trade${IS_HIP3 ? ` on ${DEX}` : ''}`
  } else {
    freeMargin = withdrawable
    capital    = freeMargin + spotFree
    capSrc     = `capital $${capital.toFixed(2)} ($${freeMargin.toFixed(2)} perp + $${spotFree.toFixed(2)} spot USDC)`
  }
  const buyLevelCnt = (IS_SHORT ? PRICES.filter(p => p > markPx) : PRICES.filter(p => p < markPx)).length || 1

  // Auto-size: when --size isn't provided, allocate --size-pct of the budget
  // (× leverage) across the buy levels so the grid always fits.
  if (!(ORDER_USD > 0)) {
    ORDER_USD = Math.floor(capital * LEVERAGE * SIZE_PCT / buyLevelCnt * 100) / 100
    log('INIT', `Auto-size: ${(SIZE_PCT * 100).toFixed(0)}% of ${capSrc} × ${LEVERAGE}x ÷ ${buyLevelCnt} buy levels → $${ORDER_USD.toFixed(2)}/level`)
  }

  // Per-position margin cap (--total-margin): the grid's entry margin = ORDER_USD ×
  // entryLevels ÷ LEVERAGE. Cap ORDER_USD so the grid's resting entries target no more
  // than TOTAL_MARGIN of margin for THIS position. Applies in BOTH cross and isolated —
  // each grid instance caps its own position independently. A runtime backstop in the
  // tick also halts new entries if the live position margin reaches the cap (the real
  // protection against a counter-trend grid accumulating past the cap as price trends).
  if (TOTAL_MARGIN > 0) {
    const maxOrderUsd = Math.floor(TOTAL_MARGIN * LEVERAGE / buyLevelCnt * 100) / 100
    ORDER_USD = Math.min(ORDER_USD > 0 ? ORDER_USD : maxOrderUsd, maxOrderUsd)
    log('INIT', `Margin cap: $${TOTAL_MARGIN.toFixed(2)} × ${LEVERAGE}x ÷ ${buyLevelCnt} entry levels → $${ORDER_USD.toFixed(2)}/level max (${IS_ISOLATED ? 'isolated' : 'cross'})`)
  }

  if (ORDER_USD < HL_MIN_ORDER) {
    // Not enough buying power to size new entries — but if there's an open position
    // we keep running in EXIT-ONLY mode: closes are reduce-only (need no margin) and
    // FREE margin as they fill, so the bot ladders profit-taking sells (profit-gated,
    // never below avg entry) and resumes buying automatically once margin frees.
    const pos0     = (acct0.assetPositions ?? []).find(p => p.position.coin === COIN)
    const invSz    = Math.abs(parseFloat(pos0?.position?.szi ?? 0))
    // availableToTrade is the margin LEFT after existing resting orders reserve theirs,
    // so a low number here often just means the grid is already placed. Adopt & manage
    // the existing position AND/OR orders instead of crashing.
    const existing = (await info.openOrders(Q(QUERY_ADDR)).catch(() => [])).filter(o => o.coin === COIN)
    if (invSz > 0 || existing.length) {
      if (existing.length) {
        // Match the already-placed grid's lot size so resumed orders stay consistent.
        const avg = existing.reduce((s, o) => s + Math.abs(parseFloat(o.sz)) * parseFloat(o.limitPx), 0) / existing.length
        ORDER_USD = Math.max(HL_MIN_ORDER, Math.floor(avg * 100) / 100)
      } else {
        ORDER_USD = Math.max(HL_MIN_ORDER, Math.floor(invSz * markPx / LEVELS * 100) / 100)
      }
      log('WARN', `Low buying power ($${capital.toFixed(2)}) — adopting existing ${COIN} state (${invSz > 0 ? `position ${invSz}` : 'no position'}, ${existing.length} resting order(s)) and managing it. New entries resume automatically when margin frees (lot ~$${ORDER_USD.toFixed(2)}).`)
    } else {
      log('ERROR', `Size per level $${ORDER_USD.toFixed(2)} is below HL's $${HL_MIN_ORDER} minimum and there's no open ${COIN} position or orders to manage — capital ($${capital.toFixed(2)}) too low for ${buyLevelCnt} buy levels. Deposit funds, reduce --levels, or set --size explicitly.`)
      process.exit(1)
    }
  }

  // Margin top-up: if perp free margin can't cover the grid but spot USDC can,
  // transfer the shortfall to perps automatically (runs for explicit --size too).
  // HIP-3 dexes have their own collateral that spot USDC can't auto-fund — skip.
  const requiredMargin = ORDER_USD * buyLevelCnt / LEVERAGE

  // ── PREVIEW: everything above this point is a READ. Stop here. ─────────────
  // Deliberately before the margin top-up below, which moves spot USDC to perps — a
  // preview must not move money any more than it places orders. Nothing after this line
  // runs, so there is no path from --plan to an order.
  if (PLAN_ONLY) {
    // Walk the SAME two loops the tick does, in the same order, with the same helpers —
    // so the preview reports what will actually rest, not an idealised ladder.
    //
    // Two things make those differ, and both were being drawn wrongly before:
    //
    //  • EXITS are backed by inventory, not by the lot size. A grid holding 3 tokens
    //    cannot rest four sells of ~2 each; it fills the nearest levels until the
    //    position runs out and the remainder falls under HL's $10 minimum.
    //  • ENTRIES are placed cheapest-first (the loop runs low → high). For a long grid
    //    that means the levels nearest the mark are the ones margin runs out on — the
    //    opposite of what the ladder's shape suggests.
    const _exitSide  = IS_SHORT ? 'buy'  : 'sell'
    const _entrySide = IS_SHORT ? 'sell' : 'buy'
    const _p0    = (acct0.assetPositions ?? []).find(x => x.position.coin === COIN)
    const _szi0  = parseFloat(_p0?.position?.szi ?? 0)
    const _avg0  = parseFloat(_p0?.position?.entryPx ?? 0)
    const _inv   = (IS_SHORT ? _szi0 < 0 : _szi0 > 0) ? Math.abs(_szi0) : 0

    const _isExitLvl  = (i) => IS_SHORT ? PRICES[i] < markPx - gapAt(i) * 0.5 : PRICES[i] > markPx + gapAt(i) * 0.5
    const _isEntryLvl = (i) => IS_SHORT ? PRICES[i] > markPx + gapAt(i) * 0.5 : PRICES[i] < markPx - gapAt(i) * 0.5

    const planned = new Map()   // level idx → { side, sz, blocked }
    const blockedAt = (i, why) => planned.set(i, { ...(planned.get(i) ?? {}), blocked: why })

    // Orders already resting are ADOPTED by the tick, not replaced — it maps each one to
    // its nearest level and leaves it alone. Without this the preview double-counts: it
    // would report levels as unaffordable when the margin is already committed to the very
    // orders sitting on them, which is exactly what a re-run of a live grid looks like.
    const _restingLvl = new Map()
    for (const o of ((await info.openOrders(Q(QUERY_ADDR)).catch(() => [])) ?? []).filter(o => o.coin === COIN)) {
      const px = parseFloat(o.limitPx)
      let best = -1, bestDist = Infinity
      for (let i = 0; i < PRICES.length; i++) {
        const d = Math.abs(PRICES[i] - px)
        if (d < bestDist) { bestDist = d; best = i }
      }
      if (best === -1 || bestDist > gapAt(best) * 0.4) continue   // foreign order, not this grid
      if (!_restingLvl.has(best)) _restingLvl.set(best, { side: o.side === 'B' ? 'buy' : 'sell', sz: parseFloat(o.sz) })
    }
    for (const [i, e] of _restingLvl) planned.set(i, { side: e.side, sz: e.sz, blocked: 'resting' })

    // ── exits, mirroring the exit loop ──
    const _exitIdxs = [...PRICES.keys()]
    if (IS_SHORT) _exitIdxs.reverse()
    const _eligibleExitCount = _exitIdxs.filter(i => _isExitLvl(i) && exitProfitable(PRICES[i], _avg0)).length
    // Inventory already covered by a resting exit cannot be sold twice.
    let _uncovered = Math.max(0, _inv - [..._restingLvl.values()].filter(e => e.side === _exitSide).reduce((a, e) => a + e.sz, 0))
    const _share = _eligibleExitCount > 0 ? _uncovered / _eligibleExitCount : 0
    for (const i of _exitIdxs) {
      if (!_isExitLvl(i)) continue
      if (_restingLvl.has(i)) continue                      // already there — adopted, not re-placed
      if (!exitProfitable(PRICES[i], _avg0)) { blockedAt(i, 'losing'); continue }
      if (_uncovered * PRICES[i] < HL_MIN_ORDER) { blockedAt(i, 'inventory'); continue }
      const sz = roundSz(Math.min(Math.max(exitSzAt(i, _levelSzDec), _share), _uncovered), _levelSzDec, PRICES[i])
      if (sz * PRICES[i] < HL_MIN_ORDER) { blockedAt(i, 'inventory'); continue }
      planned.set(i, { side: _exitSide, sz, blocked: null })
      _uncovered -= sz
    }

    // ── entries, mirroring the entry loop: low index → high, on a margin budget ──
    // Each entry reserves ORDER_USD / LEVERAGE of margin. When the budget is gone the
    // remaining levels are real orders the bot wants but cannot afford yet — it retries
    // them as margin frees, which is why they are marked rather than dropped.
    let _budget = capital
    const _perOrder = ORDER_USD / LEVERAGE
    for (let i = 0; i < PRICES.length; i++) {
      if (!_isEntryLvl(i)) continue
      if (_restingLvl.has(i)) continue                      // adopted; its margin is already spent
      if (planned.has(i) && planned.get(i).side) continue
      const sz = entrySzAt(i, _levelSzDec)
      if (_budget + 1e-9 < _perOrder) { planned.set(i, { side: _entrySide, sz, blocked: 'margin' }); continue }
      _budget -= _perOrder
      planned.set(i, { side: _entrySide, sz, blocked: null })
    }

    const orders = [...PRICES.keys()].map(i => {
      const pl = planned.get(i)
      const side = pl?.side ?? ((IS_SHORT ? PRICES[i] > markPx : PRICES[i] < markPx) ? 'buy' : 'sell')
      return {
        px: PRICES[i],
        side,
        sz: pl?.sz ?? roundSz(ORDER_USD / PRICES[i], _levelSzDec, PRICES[i]),
        usd: ORDER_USD,
        type: 'limit',
        // null = placed on the first cycle. Otherwise why not:
        //   'margin'    — wanted, unaffordable right now, retried as margin frees
        //   'inventory' — nothing left to sell; appears once the position grows
        //   'losing'    — would close below the average entry; the bot never does that
        //   'resting'   — an order is already sitting there; the tick adopts it
        //   'near'      — inside the half-gap dead zone around the mark, not yet eligible
        blocked: pl?.blocked ?? (pl ? null : 'near'),
      }
    })
    const entries = orders.filter(o => o.side === _entrySide)
    const _pp = (acct0.assetPositions ?? []).find(x => x.position.coin === COIN)
    const _sz = parseFloat(_pp?.position?.szi ?? 0)
    console.log('__PLAN__' + JSON.stringify({
      ok: true,
      coin: COIN, dex: DEX || null, side: IS_SHORT ? 'short' : 'long',
      markPx, lower: LOWER, upper: UPPER, levels: LEVELS,
      spacing: PCT_SPACING ? PCT_INTERVAL + '%' : roundPx((UPPER - LOWER) / (LEVELS - 1)),
      orders,
      orderUsd: ORDER_USD,
      leverage: LEVERAGE,
      margin: IS_ISOLATED ? 'isolated' : 'cross',
      // What the sizing was actually derived from, so the preview shows the user their own
      // capital rather than a number with no provenance.
      capital, capitalSource: capSrc, freeMargin,
      requiredMargin,
      entryLevels: entries.length,
      // What the first cycle actually rests, and what it holds back.
      willPlace: orders.filter(o => !o.blocked).length,
      resting:   orders.filter(o => o.blocked === 'resting').length,
      heldBack:  orders.filter(o => o.blocked === 'margin' || o.blocked === 'inventory').length,
      inventory: _inv, avgEntry: _avg0,
      // Margin the orders it CAN place will actually consume.
      marginUsed: orders.filter(o => !o.blocked && o.side === _entrySide).length * (ORDER_USD / LEVERAGE),
      perOrderMargin: ORDER_USD / LEVERAGE,
      autoRange: !(parseFloat(args.lower) > 0) && !(parseFloat(args.upper) > 0),
      autoSize:  !(parseFloat(args.size) > 0),
      fits: requiredMargin <= capital,
      minOrder: HL_MIN_ORDER,
      // The whole position, not just its size. A grid started on top of one behaves very
      // differently depending on which way it points: same direction and it adds to the
      // position while its exits take profit against the average entry; opposite and its
      // entries reduce what is already there before opening anything new. The preview
      // cannot say that without knowing the side.
      position: _szi0 ? {
        szi:        _szi0,
        side:       _szi0 > 0 ? 'long' : 'short',
        entryPx:    _avg0,
        value:      parseFloat(_pp.position.positionValue ?? 0),
        uPnl:       parseFloat(_pp.position.unrealizedPnl ?? 0),
        roe:        parseFloat(_pp.position.returnOnEquity ?? 0) * 100,
        marginUsed: parseFloat(_pp.position.marginUsed ?? 0),
        liqPx:      parseFloat(_pp.position.liquidationPx ?? 0),
        leverage:   _pp.position.leverage?.value ?? null,
        levType:    _pp.position.leverage?.type ?? null,
        funding:    parseFloat(_pp.position.cumFunding?.sinceOpen ?? 0),
        // Does the grid point the same way as what is already open?
        aligned:    IS_SHORT ? _szi0 < 0 : _szi0 > 0,
      } : null,
    }))
    process.exit(0)
  }

  if (IS_HIP3) {
    if (freeMargin < requiredMargin) {
      log('WARN', `HIP-3 dex "${DEX}" free margin $${freeMargin.toFixed(2)} < ~$${requiredMargin.toFixed(2)} needed. Deposit USDC into the ${DEX} dex (spot USDC can't auto-fund it) or orders may fail.`)
    }
  } else if (availNtl <= 0 && withdrawable < requiredMargin && spotFree > 1) {
    // Legacy non-unified fallback only — a unified account needs no transfer
    // (availableToTrade already counts spot USDC), so this won't fire for it.
    const amt = Math.min(spotFree, requiredMargin - withdrawable + 1)   // +$1 buffer
    try {
      await exchange.usdClassTransfer({ amount: amt.toFixed(2), toPerp: true })
      log('INIT', `Transferred $${amt.toFixed(2)} spot USDC → perps (margin top-up for ~$${requiredMargin.toFixed(2)} required)`)
    } catch (e) {
      log('WARN', `Auto-transfer spot → perps failed: ${e.message} — transfer USDC to Perps manually if orders fail`)
    }
  }

  log('START', '═'.repeat(60))
  log('START', `Grid Bot — classic ${IS_SHORT ? 'SHORT' : 'long'} grid`)
  log('START', `Coin:     ${COIN}${DEX ? ` (HIP-3 dex "${DEX}")` : ''}  |  mark $${markPx}`)
  log('START', `Range:    $${LOWER} – $${UPPER}  |  ${LEVELS} levels (${PCT_SPACING ? PCT_INTERVAL + '%' : '$' + roundPx((UPPER - LOWER) / (LEVELS - 1))} spacing)  |  $${ORDER_USD}/level`)
  log('START', `Leverage: ${LEVERAGE}x ${IS_ISOLATED ? 'isolated' : 'cross'}  |  Check interval: ${CHECK_MS / 1000}s  |  querying ${QUERY_ADDR}`)
  log('START', '═'.repeat(60))

  const { index } = await getAssetInfo(COIN)
  if (DEX) log('INIT', `Resolved ${COIN} → asset id ${index}`)

  try {
    await exchange.updateLeverage({ asset: index, isCross: !IS_ISOLATED, leverage: LEVERAGE })
    log('INIT', `Leverage set to ${LEVERAGE}x ${IS_ISOLATED ? 'isolated' : 'cross'} for ${COIN}`)
  } catch (e) {
    log('WARN', `Could not set leverage: ${e.message}`)
  }

  // Margin sanity check — use the unified margin-equiv (availableToTrade-derived),
  // which counts spot USDC on a unified account; `withdrawable` reads ~0 there.
  {
    const buyLevels = PRICES.filter(p => p < markPx).length
    const estMargin = ORDER_USD * buyLevels / LEVERAGE
    log('INIT', `Free margin: $${freeMargin.toFixed(2)}${availNtl > 0 ? ` ($${availNtl.toFixed(2)} buying power)` : ''} | est. required: ~$${estMargin.toFixed(2)} ($${ORDER_USD} × ${buyLevels} buys ÷ ${LEVERAGE}x)`)
    if (freeMargin < ORDER_USD / LEVERAGE) {
      log('WARN', `Low free margin ($${freeMargin.toFixed(2)}) — buy placements may fail`)
    }
  }

  if (markPx < LOWER || markPx > UPPER) {
    log('WARN', `Price $${markPx} is outside grid range ($${LOWER}–$${UPPER}) — grid idles until price re-enters`)
  }

  // Realized P&L counts fills from this run forward (matches HL from now on)
  lastFillScan = Date.now()

  // First reconcile adopts any existing grid orders, cancels duplicates from
  // old runs, and places whatever the desired state is missing.
  await reconcile()
  log('RUN', 'Grid initialized. Reconciling every cycle...')

  while (true) {
    await sleep(CHECK_MS)
    if (isPaused()) continue   // frozen — resting orders left in place, position held
    try {
      await reconcile()
    } catch (e) {
      log('ERROR', `Cycle: ${e.message}`)
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
