#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — DCA Bot
 *
 * Dollar-cost averages into a position with market (IOC) orders of fixed USD
 * size, either on a time interval or on price moves against the position.
 *
 * Usage:
 *   node strategies/dca.js \
 *     --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --coin BTC --side long --size 100 \
 *     --interval 60 --max-orders 10 --max-position 0 --leverage 1
 *
 * Drop mode (buy the dip / short the pump):
 *   node strategies/dca.js ... --mode drop --drop-pct 2
 *   — long:  only buys when price drops ≥ drop-pct % from the last fill
 *   — short: only sells when price rises ≥ drop-pct % from the last fill
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused } from './_pause.js'
import { botCloid } from '../src/cloid.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:         { type: 'string' },
    address:        { type: 'string' },
    coin:           { type: 'string', default: 'BTC'  },
    side:           { type: 'string', default: 'long' },
    size:           { type: 'string', default: '100'  },   // USD per order
    interval:       { type: 'string', default: '60'   },   // minutes between checks
    'max-orders':   { type: 'string', default: '10'   },   // 0 = unlimited
    'max-position': { type: 'string', default: '0'    },   // USD, 0 = unlimited
    leverage:       { type: 'string', default: '1'    },
    mode:           { type: 'string', default: 'time' },   // 'time' | 'drop'
    'drop-pct':     { type: 'string', default: '2'    },   // % move from last fill
  },
  allowPositionals: false,
  strict: false,   // tolerate unknown flags from older/newer UIs
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

const COIN         = args.coin.toUpperCase()
const IS_BUY       = args.side.toLowerCase() !== 'short'
const ORDER_USD    = parseFloat(args.size)
const INTERVAL_MS  = Math.max(1, parseInt(args.interval) || 60) * 60 * 1000
const MAX_ORDERS   = parseInt(args['max-orders'])     // 0 = unlimited
const MAX_POSITION = parseFloat(args['max-position']) // USD, 0 = unlimited
const LEVERAGE     = parseInt(args.leverage)
const MODE         = args.mode.toLowerCase()          // 'time' | 'drop'
const DROP_PCT     = parseFloat(args['drop-pct'])     // % adverse move to trigger
const SLIPPAGE     = 0.003
const HL_MIN_ORDER = 10   // USD — HL rejects orders below this notional

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const QUERY_ADDR  = args.address ?? etherWallet.address   // master wallet for reads

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
  // If flooring pushed the notional below HL's $10 minimum, add one tick
  if (px > 0 && sz * px < HL_MIN_ORDER) sz = Math.round((sz + minTick) * factor) / factor
  return sz
}

// ─── ASSET INDEX CACHE ────────────────────────────────────────────────────────
let _metaCache = null

async function getAssetInfo(coin) {
  if (!_metaCache) {
    const meta = await info.meta()
    _metaCache = {}
    ;(meta.universe ?? []).forEach((u, i) => {
      _metaCache[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 }
    })
  }
  const asset = _metaCache[coin]
  if (!asset) throw new Error(`Unknown coin: ${coin}`)
  return asset
}

// ─── POSITION ────────────────────────────────────────────────────────────────
async function getPosition() {
  const state = await info.clearinghouseState({ user: QUERY_ADDR })
  const pos   = (state.assetPositions ?? []).find(p => p.position.coin === COIN)
  if (!pos || parseFloat(pos.position.szi ?? 0) === 0) return null
  const p = pos.position
  return {
    szi:    parseFloat(p.szi),
    entry:  parseFloat(p.entryPx ?? 0),
    upnl:   parseFloat(p.unrealizedPnl ?? 0),
    posVal: Math.abs(parseFloat(p.positionValue ?? 0)),
  }
}

async function auditPosition() {
  const p = await getPosition()
  if (!p) { log('AUDIT', `${COIN} — no open position`); return null }
  const side = p.szi > 0 ? 'LONG' : 'SHORT'
  log('AUDIT', `${COIN} ${side} | sz=${Math.abs(p.szi).toFixed(4)} | entry $${p.entry.toFixed(4)} | uPnL ${p.upnl >= 0 ? '+' : ''}${p.upnl.toFixed(2)} | value $${p.posVal.toFixed(2)}`)
  return p
}

// ─── ORDER ────────────────────────────────────────────────────────────────────
// Returns the actually-filled size (0 if the IOC missed entirely).
async function placeOrder(markPx) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = IS_BUY
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)
  const sz = roundSz(ORDER_USD / markPx, szDecimals, roundPx(markPx))

  const result = await exchange.order({
    orders: [{
      c: botCloid(process.env.HLIQ_BOT),
      a: index,
      b: IS_BUY,
      p: roundPx(limitPx, szDecimals).toString(),
      s: sz.toString(),
      r: false,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))

  const filled = statuses[0]?.filled
  return {
    filledSz: parseFloat(filled?.totalSz ?? 0),
    avgPx:    parseFloat(filled?.avgPx ?? 0),
  }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `DCA Bot`)
  log('START', `Coin:      ${COIN}  |  Side: ${IS_BUY ? 'LONG' : 'SHORT'}`)
  log('START', `Size:      $${ORDER_USD} per order  |  Max position: ${MAX_POSITION > 0 ? '$' + MAX_POSITION : 'unlimited'}`)
  if (MODE === 'drop') {
    log('START', `Mode:      DROP — ${IS_BUY ? 'buy' : 'sell'} every ${DROP_PCT}% ${IS_BUY ? 'dip' : 'pump'} from last fill (checked every ${INTERVAL_MS / 60000} min)`)
  } else {
    log('START', `Mode:      TIME — every ${INTERVAL_MS / 60000} min`)
  }
  log('START', `Leverage:  ${LEVERAGE}x  |  Max orders: ${MAX_ORDERS || 'unlimited'}  |  querying ${QUERY_ADDR}`)
  log('START', '═'.repeat(60))

  if (ORDER_USD < HL_MIN_ORDER) {
    log('ERROR', `Order size $${ORDER_USD} is below HL's $${HL_MIN_ORDER} minimum. Increase --size.`)
    process.exit(1)
  }

  const { index } = await getAssetInfo(COIN)
  try {
    await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })
    log('INIT', `Leverage set to ${LEVERAGE}x cross for ${COIN}`)
  } catch (e) {
    log('WARN', `Could not set leverage: ${e.message}`)
  }

  const existing = await auditPosition()

  let count      = 0
  let lastFillPx = 0   // reference price for drop mode

  // In drop mode, seed the reference from the existing position's entry price
  if (MODE === 'drop' && existing && existing.entry > 0) {
    // Only seed when the existing position matches our direction
    if ((IS_BUY && existing.szi > 0) || (!IS_BUY && existing.szi < 0)) {
      lastFillPx = existing.entry
      log('DROP', `Seeding reference from open position entry: $${lastFillPx.toFixed(4)}`)
    }
  }

  while (true) {
    if (isPaused()) { await sleep(INTERVAL_MS); continue }
    try {
      const allMids = await info.allMids()
      const markPx  = parseFloat(allMids[COIN] ?? 0)
      if (!markPx) throw new Error(`No price for ${COIN}`)

      // Drop mode: wait for an adverse move from the last fill.
      // Long: price must DROP drop-pct%. Short: price must RISE drop-pct%.
      if (MODE === 'drop' && lastFillPx > 0) {
        const movePct = IS_BUY
          ? (lastFillPx - markPx) / lastFillPx * 100
          : (markPx - lastFillPx) / lastFillPx * 100
        if (movePct < DROP_PCT) {
          log('WAIT', `${COIN} @ $${markPx.toFixed(4)} — need ${DROP_PCT}% ${IS_BUY ? 'dip' : 'pump'} from $${lastFillPx.toFixed(4)} (current: ${movePct.toFixed(2)}%)`)
          await sleep(INTERVAL_MS)
          continue
        }
      } else if (MODE === 'drop') {
        log('DROP', `No reference price yet — placing first order at $${markPx.toFixed(4)}`)
      }

      // Max position guard (reads the master wallet)
      if (MAX_POSITION > 0) {
        const pos = await getPosition()
        if (pos && pos.posVal >= MAX_POSITION) {
          log('SKIP', `Position $${pos.posVal.toFixed(2)} ≥ max $${MAX_POSITION} — waiting ${INTERVAL_MS / 60000} min`)
          await sleep(INTERVAL_MS)
          continue
        }
      }

      const { filledSz, avgPx } = await placeOrder(markPx)

      if (filledSz > 0) {
        count++
        lastFillPx = avgPx || markPx
        const remaining = MAX_ORDERS > 0 ? `${count}/${MAX_ORDERS}` : count
        log('ORDER', `#${remaining} ${IS_BUY ? 'BUY ' : 'SELL'} ${filledSz} ${COIN} @ $${(avgPx || markPx).toFixed(4)} (~$${ORDER_USD})${MODE === 'drop' ? ` | next trigger: $${(lastFillPx * (IS_BUY ? 1 - DROP_PCT / 100 : 1 + DROP_PCT / 100)).toFixed(4)}` : ''}`)
      } else {
        // IOC missed (price moved past the slippage cap) — don't count it
        log('MISS', `IOC order did not fill (price moved) — retrying next cycle`)
      }

      if (MAX_ORDERS > 0 && count >= MAX_ORDERS) {
        log('DONE', `All ${MAX_ORDERS} orders placed. Exiting.`)
        process.exit(0)
      }

    } catch (e) {
      log('ERROR', e.message)
    }

    log('WAIT', `Next check in ${INTERVAL_MS / 60000} min...`)
    await sleep(INTERVAL_MS)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
