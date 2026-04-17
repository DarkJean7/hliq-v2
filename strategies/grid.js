#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Grid Bot
 *
 * Places a grid of limit buy and sell orders between a lower and upper price.
 * When a buy fills, places a new sell one level up. When a sell fills, places
 * a new buy one level down. Profits from price oscillation within the range.
 *
 * Usage:
 *   node strategies/grid.js \
 *     --wallet 0xYOUR_AGENT_KEY \
 *     --coin ETH \
 *     --lower 2000 \
 *     --upper 3000 \
 *     --levels 10 \
 *     --size 50 \
 *     --leverage 1
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:   { type: 'string' },
    address:  { type: 'string' },                    // master wallet address (for margin check)
    coin:     { type: 'string', default: 'ETH'  },
    lower:    { type: 'string', default: '2000' },   // USD
    upper:    { type: 'string', default: '3000' },   // USD
    levels:   { type: 'string', default: '10'   },   // number of grid lines
    size:     { type: 'string', default: '50'   },   // USD per level
    leverage: { type: 'string', default: '1'    },
  },
  allowPositionals: false,
  strict: false,   // ignore unknown flags (e.g. --long-assets passed from UI)
})

if (!args.wallet) {
  console.error('ERROR: --wallet is required (agent private key starting with 0x)')
  process.exit(1)
}

const COIN        = args.coin.toUpperCase()
const LOWER       = parseFloat(args.lower)
const UPPER       = parseFloat(args.upper)
const LEVELS      = parseInt(args.levels)
const ORDER_USD   = parseFloat(args.size)
const LEVERAGE    = parseInt(args.leverage)
const CHECK_MS    = 30 * 1000   // check for fills every 30 seconds
const HL_MIN_ORDER = 10          // USD — HL rejects orders below this notional

if (LOWER >= UPPER)  { console.error('ERROR: --lower must be less than --upper'); process.exit(1) }
if (LEVELS < 2)      { console.error('ERROR: --levels must be ≥ 2');              process.exit(1) }

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(args.wallet)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const ADDRESS     = etherWallet.address

// ─── STATE ────────────────────────────────────────────────────────────────────
// Map of gridPriceLevelIndex → { side: 'buy'|'sell', oid: string, px: number, sz: number }
const grid       = new Map()   // priceIndex → { side, oid, px, sz }
const oidToLevel = new Map()   // oid → priceIndex

let totalCostBasis = 0   // sum of (px * sz) for all buy fills
let totalProceeds  = 0   // sum of (px * sz) for all sell fills

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`[${ts}] [${tag.padEnd(8)}] ${msg}`)
}

// ─── PRECISION ────────────────────────────────────────────────────────────────
function roundPx(n) {
  // HL prices use 5 significant figures (e.g. ETH at $2103 → tick size 0.1)
  const f = parseFloat(n)
  if (f <= 0) return 0
  const magnitude = Math.floor(Math.log10(Math.abs(f)))
  const factor    = Math.pow(10, 4 - magnitude)
  return Math.round(f * factor) / factor
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
    const meta = await info.meta()
    _meta = {}
    ;(meta.universe ?? []).forEach((u, i) => {
      _meta[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 }
    })
  }
  const asset = _meta[coin]
  if (!asset) throw new Error(`Unknown coin: ${coin}`)
  return asset
}

// ─── POSITION AUDIT ───────────────────────────────────────────────────────────
async function auditPosition() {
  const state = await info.clearinghouseState({ user: ADDRESS })
  const pos   = (state.assetPositions ?? []).find(p => p.position.coin === COIN)
  if (!pos || parseFloat(pos.position.szi ?? 0) === 0) {
    log('AUDIT', `${COIN} — no open position`)
    return
  }
  const p      = pos.position
  const szi    = parseFloat(p.szi)
  const side   = szi > 0 ? 'LONG' : 'SHORT'
  const entry  = parseFloat(p.entryPx ?? 0)
  const upnl   = parseFloat(p.unrealizedPnl ?? 0)
  const posVal = parseFloat(p.positionValue ?? 0)
  log('AUDIT', `${COIN} ${side} | sz=${Math.abs(szi).toFixed(4)} | entry $${entry.toFixed(4)} | uPnL ${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)} | value $${Math.abs(posVal).toFixed(2)}`)
  log('AUDIT', `Grid will ADD to this position — ensure range/size aligns with your existing ${side}`)
}

// ─── GRID PRICE LEVELS ────────────────────────────────────────────────────────
function gridPrices() {
  const step = (UPPER - LOWER) / (LEVELS - 1)
  return Array.from({ length: LEVELS }, (_, i) => roundPx(LOWER + i * step))
}

// ─── OPEN ORDER MAP ───────────────────────────────────────────────────────────
async function fetchOpenOids() {
  const state = await info.openOrders({ user: ADDRESS })
  const set   = new Set()
  for (const o of (state ?? [])) {
    if (o.coin === COIN) set.add(String(o.oid))
  }
  return set
}

// ─── PLACE A GRID LIMIT ORDER ─────────────────────────────────────────────────
async function placeGridOrder(levelIdx, side, px, reduceOnly = false) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const isBuy = side === 'buy'
  const sz    = roundSz(ORDER_USD / px, szDecimals, roundPx(px))

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(px).toString(),
      s: sz.toString(),
      r: reduceOnly,
      t: { limit: { tif: 'Gtc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))

  const oid = String(statuses[0]?.resting?.oid ?? statuses[0]?.filled?.oid ?? '')
  if (oid) {
    grid.set(levelIdx, { side, oid, px, sz })
    oidToLevel.set(oid, levelIdx)
  }

  log('PLACE', `Level ${levelIdx.toString().padStart(2)} ${side.toUpperCase()} @ $${px}  oid=${oid}`)
  return oid
}

// ─── CANCEL A LEVEL'S ORDER ───────────────────────────────────────────────────
async function cancelGridOrder(levelIdx) {
  const entry = grid.get(levelIdx)
  if (!entry) return
  const { index } = await getAssetInfo(COIN)

  try {
    await exchange.cancel({ cancels: [{ a: index, o: parseInt(entry.oid) }] })
    log('CANCEL', `Level ${levelIdx} oid=${entry.oid}`)
  } catch (_) { /* already filled or gone */ }

  grid.delete(levelIdx)
  oidToLevel.delete(entry.oid)
}

// ─── RECOVER EXISTING ORDERS ─────────────────────────────────────────────────
// On restart the in-memory grid map is empty, but HL may already have orders
// from the previous run. Scan open orders and register any that sit exactly on
// a grid level so we don't place duplicates.
async function recoverExistingOrders() {
  const openOrders = await info.openOrders({ user: ADDRESS })
  const coinOrders = (openOrders ?? []).filter(o => o.coin === COIN)
  if (!coinOrders.length) return

  const prices = gridPrices()
  let recovered = 0

  for (const order of coinOrders) {
    const orderPx = roundPx(parseFloat(order.limitPx))
    const levelIdx = prices.findIndex(p => roundPx(p) === orderPx)
    if (levelIdx === -1) continue
    if (grid.has(levelIdx)) continue

    const side = order.side === 'B' ? 'buy' : 'sell'
    const oid  = String(order.oid)
    const sz   = parseFloat(order.sz)

    grid.set(levelIdx, { side, oid, px: orderPx, sz })
    oidToLevel.set(oid, levelIdx)
    recovered++
    log('RECOVER', `Level ${levelIdx} ${side.toUpperCase()} @ $${orderPx}  oid=${oid} — existing order re-registered`)
  }

  if (recovered > 0) log('RECOVER', `Re-registered ${recovered} existing order(s) — skipping placement for those levels`)
}

// ─── INITIALIZE GRID ─────────────────────────────────────────────────────────
async function initGrid(markPx) {
  const prices = gridPrices()
  log('INIT', `Grid prices: ${prices[0]} → ${prices.at(-1)} | ${prices.length} levels | $${ORDER_USD}/level`)

  // Recover any orders already sitting on grid levels (e.g. from a previous run)
  await recoverExistingOrders()

  // Only place BUY orders below current price where no order exists yet.
  // SELL orders are placed reactively when a buy fills — at init there is no
  // long position to close, so reduce-only sells would be rejected.
  const placePromises = []
  for (let i = 0; i < prices.length; i++) {
    const px = prices[i]
    if (px >= markPx) continue
    if (grid.has(i)) continue   // already registered — don't duplicate
    placePromises.push(placeGridOrder(i, 'buy', px, false).catch(e => log('ERROR', `Init level ${i}: ${e.message}`)))
  }
  await Promise.all(placePromises)

  log('INIT', `Active: ${grid.size} / ${prices.length} levels (${placePromises.length} new orders placed)`)
}

// ─── CLOSE ENTIRE POSITION AT UPPER BOUNDARY ─────────────────────────────────
async function closeAtUpperBoundary(markPx) {
  const acctState = await info.clearinghouseState({ user: ADDRESS })
  const pos       = (acctState.assetPositions ?? []).find(p => p.position.coin === COIN)
  const szi       = parseFloat(pos?.position?.szi ?? 0)

  // Cancel every open grid order first
  const levelsToClear = [...grid.keys()]
  await Promise.all(levelsToClear.map(i => cancelGridOrder(i)))
  log('CLOSE', `Cancelled ${levelsToClear.length} open grid order(s)`)

  if (szi <= 0) {
    log('CLOSE', `No long position open — grid cleared, will reinitialize`)
    return
  }

  const { index, szDecimals } = await getAssetInfo(COIN)
  // IOC reduce-only sell — price 1% below mark to guarantee immediate fill
  const sellPx = roundPx(markPx * 0.99)
  const sellSz = roundSz(szi, szDecimals, sellPx)

  log('CLOSE', `Upper $${UPPER} hit (mark $${markPx}) — closing long ${szi} ${COIN} @ $${sellPx} (IOC)`)

  try {
    const result   = await exchange.order({
      orders: [{ a: index, b: false, p: sellPx.toString(), s: sellSz.toString(), r: true, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    })
    const statuses = result?.response?.data?.statuses ?? []
    const err      = statuses.filter(s => s.error).map(s => s.error)
    if (err.length) {
      log('ERROR', `Close failed: ${err.join(', ')}`)
    } else {
      const f = statuses[0]?.filled
      const netPnl = (totalProceeds - totalCostBasis).toFixed(4)
      log('CLOSE', `Position closed${f ? ` | avg $${f.avgPx}` : ''} | grid realized P&L: ${netPnl >= 0 ? '+' : ''}$${netPnl}`)
    }
  } catch (e) {
    log('ERROR', `Close order threw: ${e.message}`)
  }
}

// ─── CHECK & REBALANCE ────────────────────────────────────────────────────────
async function checkFills() {
  // Check upper boundary first — if hit, close everything and return
  const mids   = await info.allMids()
  const markPx = parseFloat(mids[COIN] ?? 0)
  if (markPx >= UPPER) {
    await closeAtUpperBoundary(markPx)
    return
  }

  const openOids = await fetchOpenOids()
  const prices   = gridPrices()
  const missing  = []

  for (const [levelIdx, entry] of grid.entries()) {
    if (!openOids.has(entry.oid)) {
      missing.push({ levelIdx, entry })
    }
  }

  // Resolve each missing order: was it filled or externally cancelled?
  const filled = []
  await Promise.all(missing.map(async ({ levelIdx, entry }) => {
    try {
      const status = await info.orderStatus({ user: ADDRESS, oid: parseInt(entry.oid) })
      const orderStatus = status?.order?.orderStatus ?? status?.status ?? ''
      if (orderStatus === 'filled') {
        filled.push({ levelIdx, entry })
      } else {
        // Cancelled externally — remove from grid without placing counter
        grid.delete(levelIdx)
        oidToLevel.delete(entry.oid)
        log('CANCEL', `Level ${levelIdx} oid=${entry.oid} cancelled externally — removed from grid`)
      }
    } catch (_) {
      // If status check fails, treat as filled to be conservative
      filled.push({ levelIdx, entry })
    }
  }))

  for (const { levelIdx, entry } of filled) {
    grid.delete(levelIdx)
    oidToLevel.delete(entry.oid)

    log('FILL', `Level ${levelIdx} ${entry.side.toUpperCase()} @ $${entry.px} filled`)

    // Track P&L
    if (entry.side === 'buy')  totalCostBasis += entry.px * entry.sz
    if (entry.side === 'sell') totalProceeds  += entry.px * entry.sz

    // When a buy fills → place sell one level up
    // When a sell fills → place buy one level down
    const counterIdx = entry.side === 'buy' ? levelIdx + 1 : levelIdx - 1

    if (counterIdx < 0 || counterIdx >= prices.length) {
      log('EDGE', `Level ${levelIdx} at grid edge — no counter order placed`)
      continue
    }

    // Cancel any existing order at the counter level and replace it
    await cancelGridOrder(counterIdx)

    const counterSide = entry.side === 'buy' ? 'sell' : 'buy'
    const counterPx   = prices[counterIdx]

    // A sell fill completes a buy→sell cycle = realized profit
    if (entry.side === 'sell') {
      const profit = ((entry.px - counterPx) * entry.sz).toFixed(4)
      log('WIN', `${COIN} grid cycle complete | buy $${counterPx} → sell $${entry.px} | profit ~$${profit}`)
    }

    try {
      // Sell counter-orders are reduce-only — they close the long opened by the buy,
      // never open a new short position.
      const isReduceOnly = counterSide === 'sell'
      await placeGridOrder(counterIdx, counterSide, counterPx, isReduceOnly)
    } catch (e) {
      log('ERROR', `Counter order level ${counterIdx}: ${e.message}`)
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `Grid Bot`)
  log('START', `Coin:     ${COIN}`)
  log('START', `Range:    $${LOWER} – $${UPPER}  |  ${LEVELS} levels  |  $${ORDER_USD}/level`)
  log('START', `Leverage: ${LEVERAGE}x  |  Check interval: ${CHECK_MS / 1000}s`)
  log('START', '═'.repeat(60))

  if (ORDER_USD < HL_MIN_ORDER) {
    log('ERROR', `Size per level $${ORDER_USD} is below HL's $${HL_MIN_ORDER} minimum order value. Increase --size.`)
    process.exit(1)
  }

  const { index } = await getAssetInfo(COIN)

  // Set leverage once at startup
  try {
    await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })
    log('INIT', `Leverage set to ${LEVERAGE}x cross for ${COIN}`)
  } catch (e) {
    log('WARN', `Could not set leverage: ${e.message}`)
  }

  // Check available margin using master wallet address if provided.
  // The agent key (--wallet) has no balance of its own; only the master wallet does.
  const masterAddr = args.address ?? null
  if (masterAddr) {
    const acctState    = await info.clearinghouseState({ user: masterAddr })
    const withdrawable = parseFloat(acctState.withdrawable ?? 0)
    const buyLevels    = Math.ceil(LEVELS / 2)
    const estMargin    = ORDER_USD * buyLevels / LEVERAGE
    log('INIT', `Free margin: $${withdrawable.toFixed(2)} | Est. required: ~$${estMargin.toFixed(2)} ($${ORDER_USD}/level × ~${buyLevels} buys ÷ ${LEVERAGE}x)`)
    if (withdrawable < ORDER_USD / LEVERAGE) {
      log('ERROR', `Insufficient free margin ($${withdrawable.toFixed(2)}) — need at least $${(ORDER_USD / LEVERAGE).toFixed(2)} per order at ${LEVERAGE}x leverage. Fund account or reduce --size.`)
      process.exit(1)
    }
  } else {
    log('INIT', `Margin check skipped (pass --address <master wallet> to enable)`)
  }

  const allMids = await info.allMids()
  const markPx  = parseFloat(allMids[COIN] ?? 0)
  if (!markPx) { log('ERROR', `No price for ${COIN}`); process.exit(1) }

  log('PRICE', `Current ${COIN} price: $${markPx}`)
  await auditPosition()

  if (markPx < LOWER || markPx > UPPER) {
    log('WARN', `Price $${markPx} is outside grid range ($${LOWER}–$${UPPER}). Grid will still be placed.`)
  }

  await initGrid(markPx)

  log('RUN', 'Grid initialized. Monitoring for fills...')

  while (true) {
    await sleep(CHECK_MS)

    try {
      await checkFills()
      const netPnl    = totalProceeds - totalCostBasis
      const pnlStr    = `realized P&L: ${netPnl >= 0 ? '+' : ''}$${netPnl.toFixed(4)}`
      log('SCAN', `Grid active — ${grid.size} live orders | ${pnlStr}`)

      if (grid.size === 0) {
        log('REINIT', 'All orders consumed — reinitializing grid at current price...')
        const newMids = await info.allMids()
        const newPx   = parseFloat(newMids[COIN] ?? 0)
        if (newPx) {
          await initGrid(newPx)
          log('REINIT', `Grid reinitialized at $${newPx}`)
        } else {
          log('ERROR', 'Cannot reinitialize — no price available')
        }
      }
    } catch (e) {
      log('ERROR', `Check: ${e.message}`)
    }
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
