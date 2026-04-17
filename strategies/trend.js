#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Trend Follower
 *
 * Trades EMA crossovers: goes long when fast EMA crosses above slow EMA,
 * closes and goes short when fast EMA crosses below slow EMA.
 *
 * Usage:
 *   node strategies/trend.js \
 *     --wallet 0xYOUR_AGENT_KEY \
 *     --coin BTC \
 *     --fast-ema 9 \
 *     --slow-ema 21 \
 *     --size 500 \
 *     --leverage 3 \
 *     --interval 5
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:           { type: 'string' },
    coin:             { type: 'string', default: 'BTC' },
    'fast-ema':       { type: 'string', default: '9'   },   // fast EMA period
    'slow-ema':       { type: 'string', default: '21'  },   // slow EMA period
    'candle-tf':      { type: 'string', default: '1h'  },   // candle timeframe: 1m 5m 15m 1h 4h 1d
    size:             { type: 'string', default: '500' },   // USD per position
    leverage:         { type: 'string', default: '3'   },
    interval:         { type: 'string', default: '5'   },   // minutes between checks
    'stop-loss-pct':  { type: 'string', default: '0'   },   // 0 = never force-close at loss
  },
  allowPositionals: false,
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

const VALID_TFS = ['1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d','3d','1w']

const COIN          = args.coin.toUpperCase()
const FAST_PERIOD   = parseInt(args['fast-ema'])
const SLOW_PERIOD   = parseInt(args['slow-ema'])
const CANDLE_TF     = VALID_TFS.includes(args['candle-tf']) ? args['candle-tf'] : '1h'
const POSITION_USD  = parseFloat(args.size)
const LEVERAGE      = parseInt(args.leverage)
const INTERVAL_MS   = parseInt(args.interval) * 60 * 1000
const STOP_LOSS_PCT = parseFloat(args['stop-loss-pct']) / 100   // 0 = disabled
const SLIPPAGE      = 0.003

if (FAST_PERIOD >= SLOW_PERIOD) {
  console.error('ERROR: --fast-ema must be less than --slow-ema')
  process.exit(1)
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const ADDRESS     = etherWallet.address

// ─── STATE ────────────────────────────────────────────────────────────────────
// 'long' | 'short' | 'flat'
let currentSide = 'flat'
let entryPx     = null    // price when position was opened

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`[${ts}] [${tag.padEnd(8)}] ${msg}`)
}

// ─── PRECISION ────────────────────────────────────────────────────────────────
function roundPx(n) {
  const f = parseFloat(n)
  if (f >= 10000) return Math.round(f * 10) / 10
  if (f >= 1000)  return Math.round(f * 100) / 100
  if (f >= 1)     return Math.round(f * 1000) / 1000
  return parseFloat(f.toPrecision(5))
}

function roundSz(n, szDecimals = 6) {
  const factor = Math.pow(10, szDecimals)
  return Math.floor(parseFloat(n) * factor) / factor
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

// ─── EMA ──────────────────────────────────────────────────────────────────────
/**
 * Calculate EMA from an array of close prices.
 * Returns the final EMA value (most recent).
 */
function calcEMA(closes, period) {
  if (closes.length < period) return null

  const k   = 2 / (period + 1)
  let ema   = closes.slice(0, period).reduce((a, b) => a + b, 0) / period

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
  }

  return ema
}

// ─── CANDLE FETCH ─────────────────────────────────────────────────────────────
const TF_HOURS = { '1m':1/60,'3m':3/60,'5m':5/60,'15m':0.25,'30m':0.5,'1h':1,'2h':2,'4h':4,'8h':8,'12h':12,'1d':24,'3d':72,'1w':168 }

async function fetchCloses(coin, interval, count) {
  // Fetch enough candles for the slow EMA + a small buffer
  const tfHours = TF_HOURS[interval] ?? 1
  const hours   = count * tfHours * 1.5 + tfHours * 10  // 1.5x buffer + warmup
  const endTime   = Date.now()
  const startTime = endTime - hours * 60 * 60 * 1000

  try {
    const candles = await info.candleSnapshot({ coin, interval, startTime, endTime })
    return candles.map(c => parseFloat(c.c))
  } catch (e) {
    log('CANDLES', `Failed: ${e.message}`)
    return []
  }
}

// ─── CURRENT POSITION ────────────────────────────────────────────────────────
async function getPosition() {
  const state     = await info.clearinghouseState({ user: ADDRESS })
  const positions = state.assetPositions ?? []
  const pos       = positions.find(p => p.position.coin === COIN)
  if (!pos) return null
  const szi = parseFloat(pos.position.szi ?? 0)
  if (szi === 0) return null
  return pos.position
}

async function auditPosition() {
  const pos = await getPosition()
  if (!pos) {
    log('AUDIT', `${COIN} — no open position`)
    return
  }
  const szi      = parseFloat(pos.szi)
  const side     = szi > 0 ? 'LONG' : 'SHORT'
  const entry    = parseFloat(pos.entryPx ?? 0)
  const posVal   = parseFloat(pos.positionValue ?? 0)
  const upnl     = parseFloat(pos.unrealizedPnl ?? 0)
  const upnlPct  = entry > 0 ? (upnl / Math.abs(posVal - upnl) * 100).toFixed(2) : '?'
  log('AUDIT', `${COIN} ${side} | sz=${Math.abs(szi).toFixed(4)} | entry $${entry.toFixed(4)} | uPnL ${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)} (${upnlPct}%)`)

  // Always sync entryPx from live position on startup
  if (entry > 0) entryPx = entry
  if (szi > 0) currentSide = 'long'
  else if (szi < 0) currentSide = 'short'
}

// ─── MARKET ORDER ─────────────────────────────────────────────────────────────
async function marketOrder({ isBuy, sz, markPx, reduceOnly = false }) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = isBuy
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)

  await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(limitPx).toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: reduceOnly,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))

  log('ORDER', `${isBuy ? 'BUY ' : 'SELL'} ${roundSz(sz, szDecimals)} ${COIN} @ ~$${roundPx(markPx)} (market IOC)`)
  return result
}

// ─── CLOSE POSITION ───────────────────────────────────────────────────────────
async function closePosition(markPx) {
  const pos = await getPosition()
  if (!pos) { currentSide = 'flat'; entryPx = null; return }

  const szi    = parseFloat(pos.szi)
  const isBuy  = szi < 0   // closing a short → buy; closing a long → sell
  const sz     = Math.abs(szi)
  const side   = szi > 0 ? 'LONG' : 'SHORT'

  log('CLOSE', `${side} sz=${sz} @ ~$${markPx}`)
  await marketOrder({ isBuy, sz, markPx, reduceOnly: true })

  // Record win if profitable
  if (entryPx) {
    const pnl = szi > 0
      ? (markPx - entryPx)              // long: profit when exit > entry
      : (entryPx - markPx)              // short: profit when exit < entry
    if (pnl > 0) {
      const pnlPct = (pnl / entryPx * 100).toFixed(2)
      const pnlUsd = (pnl * sz).toFixed(2)
      log('WIN', `${COIN} ${side} closed profitable | entry $${entryPx.toFixed(4)} → exit $${markPx.toFixed(4)} | +${pnlPct}% | ~$${pnlUsd}`)
    }
  }

  currentSide = 'flat'
  entryPx     = null
}

// ─── OPEN POSITION ────────────────────────────────────────────────────────────
async function openPosition(side, markPx) {
  const sz = POSITION_USD / markPx
  const isBuy = side === 'long'
  log('OPEN', `${side.toUpperCase()} sz=${sz.toFixed(6)} @ ~$${markPx}`)
  await marketOrder({ isBuy, sz, markPx, reduceOnly: false })
  currentSide = side
  entryPx     = markPx
}

// ─── TICK ────────────────────────────────────────────────────────────────────
async function tick() {
  const allMids = await info.allMids()
  const markPx  = parseFloat(allMids[COIN] ?? 0)
  if (!markPx) throw new Error(`No price for ${COIN}`)

  const needed = SLOW_PERIOD + 10
  const closes = await fetchCloses(COIN, CANDLE_TF, needed)

  if (closes.length < SLOW_PERIOD + 1) {
    log('WARN', `Not enough candles (${closes.length}) for slow EMA (${SLOW_PERIOD}) — skipping`)
    return
  }

  const fastEMA = calcEMA(closes, FAST_PERIOD)
  const slowEMA = calcEMA(closes, SLOW_PERIOD)

  if (fastEMA === null || slowEMA === null) {
    log('WARN', 'EMA calculation failed — skipping')
    return
  }

  const isBullish = fastEMA > slowEMA
  const signal    = isBullish ? 'long' : 'short'

  log('EMA', `Fast(${FAST_PERIOD})=${fastEMA.toFixed(2)}  Slow(${SLOW_PERIOD})=${slowEMA.toFixed(2)}  → ${signal.toUpperCase()}  | ${COIN} $${markPx}`)

  // Sync state with actual position
  const pos = await getPosition()
  if (pos) {
    const szi = parseFloat(pos.szi)
    currentSide = szi > 0 ? 'long' : szi < 0 ? 'short' : 'flat'
  } else {
    currentSide = 'flat'
  }

  if (signal === currentSide) {
    log('HOLD', `Already ${currentSide} — no action`)
    return
  }

  // Close existing position if any — but never close at a loss unless stop-loss is hit
  if (currentSide !== 'flat') {
    const livePos  = await getPosition()
    const upnl     = livePos ? parseFloat(livePos.unrealizedPnl ?? 0) : 0
    const entryVal = livePos ? Math.abs(parseFloat(livePos.positionValue ?? 0) - upnl) : 0
    const lossPct  = entryVal > 0 ? -upnl / entryVal : 0   // positive = losing

    if (upnl < 0) {
      const stopHit = STOP_LOSS_PCT > 0 && lossPct >= STOP_LOSS_PCT
      if (!stopHit) {
        log('HOLD', `Signal flipped to ${signal.toUpperCase()} but position is at a loss (${(-lossPct * 100).toFixed(2)}%) — holding, not closing`)
        return
      }
      log('STOP', `Stop-loss triggered — loss ${(lossPct * 100).toFixed(2)}% ≥ ${(STOP_LOSS_PCT * 100).toFixed(2)}% threshold — closing`)
    }

    await closePosition(markPx)
  }

  // Open new position
  await openPosition(signal, markPx)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `Trend Follower`)
  log('START', `Coin:      ${COIN}`)
  log('START', `EMA:       Fast(${FAST_PERIOD}) / Slow(${SLOW_PERIOD})  |  Timeframe: ${CANDLE_TF}`)
  log('START', `Size:      $${POSITION_USD}  |  Leverage: ${LEVERAGE}x  |  Interval: ${INTERVAL_MS / 60000}min`)
  log('START', `Stop-loss: ${STOP_LOSS_PCT > 0 ? (STOP_LOSS_PCT * 100).toFixed(1) + '%' : 'disabled (hold through losses)'}`)
  log('START', '═'.repeat(60))

  await getAssetInfo(COIN)
  await auditPosition()

  while (true) {
    log('RUN', '─'.repeat(60))

    try {
      await tick()
    } catch (e) {
      log('ERROR', `Tick: ${e.message}`)
    }

    log('WAIT', `Next check in ${INTERVAL_MS / 60000} min...`)
    await sleep(INTERVAL_MS)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
