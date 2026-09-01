#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Outcome Grid Bot (prediction-market spread maker)
 *
 * A SPOT market-maker grid on a single prediction-outcome token (e.g. the YES
 * share of a market). Unlike the perp grid this is spot: no leverage, no
 * liquidation, and you can only sell shares you actually hold.
 *
 *   - BUY  limit orders at every level BELOW the current probability (accumulate dips)
 *   - SELL limit orders at every level ABOVE it, capped to held inventory and
 *     never below the average entry (profit gate — never sells at a loss)
 *   - the exchange is the source of truth: each cycle the desired grid is derived
 *     from open orders + held inventory and only the diff is placed/cancelled.
 *
 * Outcome token encoding: order-book coin "#N" (N = outcome*10 + side),
 * spot balance coin "+N", order asset id = 100_000_000 + N (HIP-4), price ∈ (0,1) = probability.
 *
 * Usage:
 *   node strategies/ocgrid.js \
 *     --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --coin '#4190' [--lower 0.40] [--upper 0.70] [--levels 10] [--size 0] [--interval 20]
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused, onPause, onResume } from './_pause.js'
import { botCloid } from '../src/cloid.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:     { type: 'string' },
    address:    { type: 'string' },
    coin:       { type: 'string' },                  // outcome token: "#N"
    lower:      { type: 'string', default: '0'  },   // probability 0-1; 0 = auto (mid −0.10)
    upper:      { type: 'string', default: '0'  },   // probability 0-1; 0 = auto (mid +0.10)
    levels:     { type: 'string', default: '10' },
    size:       { type: 'string', default: '0'  },   // USD per level; 0 = auto from spot USDC
    'size-pct': { type: 'string', default: '50' },   // % of free USDC used when auto-sizing
    interval:   { type: 'string', default: '20' },   // check cycle, seconds
  },
  allowPositionals: false,
  strict: false,
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) { console.error('ERROR: agent key not provided'); process.exit(1) }

const COIN = String(args.coin || '').trim()           // "#N"
if (!/^#\d+$/.test(COIN)) { console.error('ERROR: --coin must be an outcome token like "#4190"'); process.exit(1) }
const N         = parseInt(COIN.slice(1))
const BAL_COIN  = '+' + N                              // spot balance key for the same outcome
const ASSET     = 100_000_000 + N                      // HIP-4 outcome order asset id (NOT 10000+N — that's regular spot → "invalid spot")
const SZ_DEC    = 2                                    // outcome shares: 2 dp (matches app)
let   ORDER_USD = parseFloat(args.size)                // 0 → auto-sized
const SIZE_PCT  = Math.min(1, Math.max(0.01, (parseFloat(args['size-pct']) || 50) / 100))
const CHECK_MS  = Math.max(5, parseInt(args.interval) || 20) * 1000
const HL_MIN_ORDER = 10            // USD — HL min notional
const MAX_PLACE_PER_CYCLE = 8
const PROFIT_BUFFER = 0.0005       // sells must clear avg entry by ≥0.05% — never sell at a loss

let LOWER  = parseFloat(args.lower)
let UPPER  = parseFloat(args.upper)
let LEVELS = parseInt(args.levels)

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const QUERY_ADDR  = args.address ?? etherWallet.address

// ─── STATE ────────────────────────────────────────────────────────────────────
let PRICES = []
const trackedOids = new Map()
let _fundsBackoffUntil = 0
const warnedForeign = new Set()

// ─── LOGGING / PRECISION ────────────────────────────────────────────────────────
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
function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// Probability price: ≤5 significant figures AND ≤4 decimal places (matches the app's
// outcome order rounding for szDecimals=2 → 0.0001 = 0.01¢ tick).
function roundPx(n) {
  const f = parseFloat(n)
  if (!(f > 0)) return 0
  const sig = parseFloat(f.toPrecision(5))
  return Math.round(sig * 1e4) / 1e4
}
function roundSz(n, px = 0) {
  let sz = Math.floor(parseFloat(n) * 100) / 100   // floor to 2 dp
  if (px > 0 && sz * px < HL_MIN_ORDER) sz = Math.round((sz + 0.01) * 100) / 100
  return sz
}

// ─── GRID LEVELS (linear in probability) ────────────────────────────────────────
function computePrices() {
  const step = (UPPER - LOWER) / (LEVELS - 1)
  return Array.from({ length: LEVELS }, (_, i) => roundPx(LOWER + i * step))
}
function gapAt(i) {
  if (PRICES.length < 2) return PRICES[0] * 0.05
  if (i >= PRICES.length - 1) return PRICES[i] - PRICES[i - 1]
  return PRICES[i + 1] - PRICES[i]
}
function entrySzAt(i) { return roundSz(ORDER_USD / PRICES[i], PRICES[i]) }
function exitProfitable(px, avgEntry) {
  if (!(avgEntry > 0)) return true
  return px >= avgEntry * (1 + PROFIT_BUFFER)
}

// ─── MARKET DATA ────────────────────────────────────────────────────────────────
async function getMark() {
  const book = await info.l2Book({ coin: COIN })
  const bid  = parseFloat(book?.levels?.[0]?.[0]?.px ?? 0)
  const ask  = parseFloat(book?.levels?.[1]?.[0]?.px ?? 0)
  return (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask || 0)
}

// Held inventory + average cost from the spot balance of this outcome.
async function getInventory() {
  const spot = await info.spotClearinghouseState({ user: QUERY_ADDR }).catch(() => null)
  const bal  = (spot?.balances ?? []).find(b => b.coin === BAL_COIN)
  const total = bal ? parseFloat(bal.total ?? 0) : 0
  const cost  = bal ? parseFloat(bal.entryNtl ?? 0) : 0
  return { total, avgEntry: total > 0 ? cost / total : 0 }
}
async function getFreeUsdc() {
  const spot = await info.spotClearinghouseState({ user: QUERY_ADDR }).catch(() => null)
  const u = (spot?.balances ?? []).find(b => b.coin === 'USDC')
  return u ? Math.max(0, parseFloat(u.total ?? 0) - parseFloat(u.hold ?? 0)) : 0
}

// ─── ORDER SNAPSHOT ─────────────────────────────────────────────────────────────
async function snapshotOrders() {
  const open = (await info.openOrders({ user: QUERY_ADDR }) ?? []).filter(o => o.coin === COIN)
  const levelOrders = new Map()
  const surplus = []
  for (const o of open) {
    const px = parseFloat(o.limitPx), oid = String(o.oid)
    let best = -1, bestDist = Infinity
    for (let i = 0; i < PRICES.length; i++) {
      const d = Math.abs(PRICES[i] - px)
      if (d < bestDist) { bestDist = d; best = i }
    }
    const e = { oid, side: o.side === 'B' ? 'buy' : 'sell', px, sz: parseFloat(o.sz) }
    if (best === -1 || bestDist > gapAt(best) * 0.4) {
      if (!warnedForeign.has(oid)) { warnedForeign.add(oid); log('FOREIGN', `Non-grid order oid=${oid} @ ${(px*100).toFixed(2)}¢`) }
      continue
    }
    if (levelOrders.has(best)) surplus.push({ levelIdx: best, ...e })
    else levelOrders.set(best, e)
  }
  return { levelOrders, surplus }
}

async function detectFills(levelOrders) {
  const openOids = new Set([...levelOrders.values()].map(e => e.oid))
  for (const [oid, t] of [...trackedOids.entries()].filter(([o]) => !openOids.has(o))) {
    trackedOids.delete(oid)
    try {
      const res = await info.orderStatus({ user: QUERY_ADDR, oid: parseInt(oid) })
      if ((res?.order?.status ?? '') === 'filled')
        log('FILL', `Level ${t.levelIdx} ${t.side.toUpperCase()} @ ${(t.px*100).toFixed(2)}¢  sz=${t.sz}`)
    } catch {}
  }
}

// ─── ORDER OPS ──────────────────────────────────────────────────────────────────
async function placeOrder(levelIdx, side, sz) {
  const px = PRICES[levelIdx]
  const result = await exchange.order({
    orders: [{ c: botCloid(process.env.HLIQ_BOT), a: ASSET, b: side === 'buy', p: px.toString(), s: sz.toString(), r: false, t: { limit: { tif: 'Alo' } } }],
    grouping: 'na',
  })
  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))
  const oid = String(statuses[0]?.resting?.oid ?? '')
  if (oid) trackedOids.set(oid, { side, levelIdx, px, sz })
  log('PLACE', `Level ${String(levelIdx).padStart(2)} ${side.toUpperCase()} @ ${(px*100).toFixed(2)}¢  sz=${sz}  oid=${oid}`)
}
async function cancelOid(oid, why) {
  try { await exchange.cancel({ cancels: [{ a: ASSET, o: parseInt(oid) }] }); log('CANCEL', `oid=${oid} — ${why}`) } catch {}
  trackedOids.delete(String(oid))
}

// Pause: FREEZE — leave resting orders and held shares in place; the bot just stops
// placing/cancelling/reconciling until resumed.
onPause(()  => log('PAUSE', 'Paused — resting orders left in place, bot frozen until resumed'))
onResume(() => log('RESUME', 'Resumed — managing grid again next cycle'))

// ─── RECONCILE ──────────────────────────────────────────────────────────────────
async function reconcile() {
  const markPx = await getMark()
  if (!(markPx > 0)) { log('ERROR', `No book price for ${COIN}`); return }

  const { levelOrders, surplus } = await snapshotOrders()
  await detectFills(levelOrders)
  for (const s of surplus) await cancelOid(s.oid, `duplicate at level ${s.levelIdx}`)

  const { total: inventory, avgEntry } = await getInventory()
  const szEps = (ORDER_USD / UPPER) * 0.25
  let placed = 0

  // ── PROFIT GATE: cancel any resting sell that would close below avg entry ──
  if (avgEntry > 0) {
    for (const [i, e] of [...levelOrders.entries()]) {
      if (e.side === 'sell' && !exitProfitable(e.px, avgEntry)) {
        await cancelOid(e.oid, `sell @ ${(e.px*100).toFixed(2)}¢ would sell below avg ${(avgEntry*100).toFixed(2)}¢ — held`)
        levelOrders.delete(i)
      }
    }
  }

  // ── SELLS (cap to held inventory, only above mark, only at a profit) ──
  const openSells = [...levelOrders.entries()].filter(([, e]) => e.side === 'sell')
  let totalSellSz = openSells.reduce((s, [, e]) => s + e.sz, 0)
  let excess = totalSellSz - inventory
  if (excess > szEps) {
    for (const [i, e] of [...openSells].sort((a, b) => b[0] - a[0])) {   // farthest above first
      if (excess <= szEps) break
      await cancelOid(e.oid, `sell at level ${i} not backed by inventory`)
      levelOrders.delete(i); totalSellSz -= e.sz; excess -= e.sz
    }
  }
  let uncovered = inventory - totalSellSz
  for (let i = 0; i < PRICES.length; i++) {
    if (placed >= MAX_PLACE_PER_CYCLE) break
    if (uncovered * PRICES[i] < HL_MIN_ORDER) break
    if (PRICES[i] <= markPx + gapAt(i) * 0.5) continue           // only above mark
    if (!exitProfitable(PRICES[i], avgEntry)) continue           // never at a loss
    if (levelOrders.has(i)) continue
    const sz = roundSz(Math.min(entrySzAt(i), uncovered), PRICES[i])
    if (sz * PRICES[i] < HL_MIN_ORDER) break
    try {
      await placeOrder(i, 'sell', sz)
      levelOrders.set(i, { oid: 'pending', side: 'sell', px: PRICES[i], sz })
      uncovered -= sz; placed++
    } catch (e) {
      if (/match/i.test(e.message)) log('SKIP', `Sell level ${i} would cross — deferred`)
      else log('ERROR', `Sell level ${i}: ${e.message}`)
      break
    }
  }

  // ── BUYS (every level below mark not already paired with a sell one up) ──
  for (let i = 0; i < PRICES.length; i++) {
    if (placed >= MAX_PLACE_PER_CYCLE) break
    if (PRICES[i] >= markPx - gapAt(i) * 0.5) continue            // only below mark
    const blocked = levelOrders.get(i + 1)?.side === 'sell'        // lot's sell still open
    const open    = levelOrders.get(i)
    if (open?.side === 'buy') { if (blocked) { await cancelOid(open.oid, `buy at ${i} blocked — sell open at ${i+1}`); levelOrders.delete(i) } continue }
    if (open || blocked) continue
    if (Date.now() < _fundsBackoffUntil) continue
    try {
      await placeOrder(i, 'buy', entrySzAt(i))
      levelOrders.set(i, { oid: 'pending', side: 'buy', px: PRICES[i], sz: 0 })
      placed++
    } catch (e) {
      if (/match/i.test(e.message)) { log('SKIP', `Buy level ${i} would cross — deferred`) }
      else if (/insufficient|balance|margin/i.test(e.message)) {
        _fundsBackoffUntil = Date.now() + 10 * 60 * 1000
        log('WARN', `Insufficient USDC at level ${i} — pausing new buys 10 min (sells/cancels continue)`)
        break
      } else log('ERROR', `Buy level ${i}: ${e.message}`)
    }
  }

  const liveBuys  = [...levelOrders.values()].filter(e => e.side === 'buy').length
  const liveSells = [...levelOrders.values()].filter(e => e.side === 'sell').length
  const unrl = avgEntry > 0 ? (markPx - avgEntry) * inventory : 0
  const held = uncovered > szEps && avgEntry > 0 ? `  | holding ${uncovered.toFixed(2)} (no profitable sell vs avg ${(avgEntry*100).toFixed(2)}¢)` : ''
  log('SCAN', `mark ${(markPx*100).toFixed(2)}¢ | inv ${inventory.toFixed(2)} sh @ ${(avgEntry*100).toFixed(2)}¢ | ${liveBuys} buys / ${liveSells} sells | unrl ${unrl >= 0 ? '+' : ''}$${unrl.toFixed(2)}${held}`)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  const markPx = await getMark()
  if (!(markPx > 0)) { log('ERROR', `No book price for ${COIN} — market may be closed`); process.exit(1) }

  // Auto-range: mid ±0.10 probability, clamped to (0.01, 0.99)
  if (!(LOWER > 0)) LOWER = roundPx(Math.max(0.01, markPx - 0.10))
  if (!(UPPER > 0)) UPPER = roundPx(Math.min(0.99, markPx + 0.10))
  if (LOWER >= UPPER) { console.error('ERROR: --lower must be less than --upper'); process.exit(1) }
  if (!(LEVELS >= 2)) { console.error('ERROR: --levels must be ≥ 2'); process.exit(1) }
  PRICES = computePrices()

  const freeUsdc  = await getFreeUsdc()
  const buyLevels = PRICES.filter(p => p < markPx).length || 1
  if (!(ORDER_USD > 0)) {
    ORDER_USD = Math.floor(freeUsdc * SIZE_PCT / buyLevels * 100) / 100
    log('INIT', `Auto-size: ${(SIZE_PCT*100).toFixed(0)}% of $${freeUsdc.toFixed(2)} free USDC ÷ ${buyLevels} buy levels → $${ORDER_USD.toFixed(2)}/level`)
  }
  if (ORDER_USD < HL_MIN_ORDER) {
    log('ERROR', `Size per level $${ORDER_USD.toFixed(2)} is below HL's $${HL_MIN_ORDER} minimum — free USDC ($${freeUsdc.toFixed(2)}) too low for ${buyLevels} buy levels. Deposit USDC, reduce --levels, or set --size.`)
    process.exit(1)
  }

  const { total: inv0, avgEntry: ae0 } = await getInventory()
  log('START', '═'.repeat(60))
  log('START', `Outcome Grid — spot spread maker`)
  log('START', `Token:    ${COIN} (asset ${ASSET})  |  mark ${(markPx*100).toFixed(2)}¢`)
  log('START', `Range:    ${(LOWER*100).toFixed(1)}¢ – ${(UPPER*100).toFixed(1)}¢  |  ${LEVELS} levels  |  $${ORDER_USD}/level`)
  log('START', `Inventory: ${inv0.toFixed(2)} shares${ae0 > 0 ? ` @ avg ${(ae0*100).toFixed(2)}¢` : ''}  |  free USDC $${freeUsdc.toFixed(2)}  |  interval ${CHECK_MS/1000}s`)
  log('START', `Querying ${QUERY_ADDR}`)
  log('START', '═'.repeat(60))

  await reconcile()
  log('RUN', 'Grid initialized. Reconciling every cycle...')
  while (true) {
    await sleep(CHECK_MS)
    if (isPaused()) continue   // frozen — resting orders left in place, shares held
    try { await reconcile() } catch (e) { log('ERROR', `Cycle: ${e.message}`) }
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
