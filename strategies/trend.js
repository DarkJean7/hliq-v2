#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Trend Follower
 *
 * Trades EMA crossovers: goes long when fast EMA crosses above slow EMA,
 * closes and goes short when fast EMA crosses below slow EMA.
 * The live position on the exchange is the source of truth — the bot never
 * stacks entries, and a failed close aborts the flip until the next tick.
 *
 * Usage:
 *   node strategies/trend.js \
 *     --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --coin BTC --fast-ema 9 --slow-ema 21 --candle-tf 1h \
 *     --size 500 --leverage 3 --interval 5 [--stop-loss-pct 2]
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused } from './_pause.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:          { type: 'string' },
    address:         { type: 'string' },
    coin:            { type: 'string', default: 'BTC' },
    'fast-ema':      { type: 'string', default: '9'   },
    'slow-ema':      { type: 'string', default: '21'  },
    'candle-tf':     { type: 'string', default: '1h'  },   // 1m 5m 15m 1h 4h 1d ...
    size:            { type: 'string', default: '500' },   // USD per position
    leverage:        { type: 'string', default: '3'   },
    interval:        { type: 'string', default: '5'   },   // minutes between checks
    'stop-loss-pct': { type: 'string', default: '0'   },   // 0 = never force-close at loss
  },
  allowPositionals: false,
  strict: false,
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
const INTERVAL_MS   = Math.max(1, parseInt(args.interval) || 5) * 60 * 1000
const STOP_LOSS_PCT = parseFloat(args['stop-loss-pct']) / 100   // 0 = disabled
const SLIPPAGE      = 0.003
const HL_MIN_ORDER  = 10

if (FAST_PERIOD >= SLOW_PERIOD) {
  console.error('ERROR: --fast-ema must be less than --slow-ema')
  process.exit(1)
}

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

// ─── EMA ──────────────────────────────────────────────────────────────────────
function calcEMA(closes, period) {
  if (closes.length < period) return null
  const k = 2 / (period + 1)
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
  }
  return ema
}

// ─── CANDLE FETCH ─────────────────────────────────────────────────────────────
const TF_HOURS = { '1m':1/60,'3m':3/60,'5m':5/60,'15m':0.25,'30m':0.5,'1h':1,'2h':2,'4h':4,'8h':8,'12h':12,'1d':24,'3d':72,'1w':168 }

async function fetchCloses(coin, interval, count) {
  const tfHours = TF_HOURS[interval] ?? 1
  const hours   = count * tfHours * 1.5 + tfHours * 10
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

// ─── CURRENT POSITION (exchange is the source of truth) ──────────────────────
async function getPosition() {
  const state = await info.clearinghouseState({ user: QUERY_ADDR })
  const pos   = (state.assetPositions ?? []).find(p => p.position.coin === COIN)
  if (!pos) return null
  const szi = parseFloat(pos.position.szi ?? 0)
  if (szi === 0) return null
  return {
    szi,
    side:  szi > 0 ? 'long' : 'short',
    entry: parseFloat(pos.position.entryPx ?? 0),
    upnl:  parseFloat(pos.position.unrealizedPnl ?? 0),
  }
}

async function auditPosition() {
  const pos = await getPosition()
  if (!pos) { log('AUDIT', `${COIN} — no open position`); return }
  log('AUDIT', `${COIN} ${pos.side.toUpperCase()} | sz=${Math.abs(pos.szi).toFixed(4)} | entry $${pos.entry.toFixed(4)} | uPnL ${pos.upnl >= 0 ? '+' : ''}${pos.upnl.toFixed(2)}`)
}

// ─── MARKET ORDER ─────────────────────────────────────────────────────────────
// Returns { filledSz, avgPx } — filledSz 0 when the IOC missed.
async function marketOrder({ isBuy, sz, markPx, reduceOnly = false }) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = isBuy
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)
  const rSz = roundSz(sz, szDecimals, roundPx(markPx))

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(limitPx, szDecimals).toString(),
      s: rSz.toString(),
      r: reduceOnly,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))

  const filled   = statuses[0]?.filled
  const filledSz = parseFloat(filled?.totalSz ?? 0)
  const avgPx    = parseFloat(filled?.avgPx ?? 0)
  log('ORDER', `${isBuy ? 'BUY ' : 'SELL'} ${filledSz || rSz} ${COIN} @ $${avgPx || roundPx(markPx)} (IOC${reduceOnly ? ', reduce-only' : ''})${filledSz ? '' : ' — DID NOT FILL'}`)
  return { filledSz, avgPx }
}

// ─── CLOSE POSITION — returns true only when the position is actually gone ───
async function closePosition(markPx) {
  const pos = await getPosition()
  if (!pos) return true

  log('CLOSE', `${pos.side.toUpperCase()} sz=${Math.abs(pos.szi)} @ ~$${markPx}`)
  const { filledSz, avgPx } = await marketOrder({
    isBuy: pos.szi < 0,
    sz: Math.abs(pos.szi),
    markPx,
    reduceOnly: true,
  })

  if (filledSz <= 0) {
    log('WARN', 'Close did not fill — aborting flip until next tick')
    return false
  }

  const exitPx = avgPx || markPx
  const pnl    = pos.szi > 0 ? (exitPx - pos.entry) : (pos.entry - exitPx)
  if (pnl > 0 && pos.entry > 0) {
    const pnlPct = (pnl / pos.entry * 100).toFixed(2)
    const pnlUsd = (pnl * filledSz).toFixed(2)
    log('WIN', `${COIN} ${pos.side.toUpperCase()} closed profitable | entry $${pos.entry.toFixed(4)} → exit $${exitPx.toFixed(4)} | +${pnlPct}% | ~$${pnlUsd}`)
  }

  // Verify it's actually gone (partial close → still open)
  const remains = await getPosition()
  if (remains) {
    log('WARN', `Position partially closed (${Math.abs(remains.szi)} remains) — finishing next tick`)
    return false
  }
  return true
}

// ─── OPEN POSITION ────────────────────────────────────────────────────────────
async function openPosition(side, markPx) {
  const sz = POSITION_USD / markPx
  log('OPEN', `${side.toUpperCase()} ~${sz.toFixed(6)} ${COIN} @ ~$${markPx}`)
  const { filledSz } = await marketOrder({ isBuy: side === 'long', sz, markPx, reduceOnly: false })
  if (filledSz <= 0) log('WARN', 'Open did not fill — retrying next tick')
}

// ─── TICK ────────────────────────────────────────────────────────────────────
async function tick() {
  const allMids = await info.allMids()
  const markPx  = parseFloat(allMids[COIN] ?? 0)
  if (!markPx) throw new Error(`No price for ${COIN}`)

  const closes = await fetchCloses(COIN, CANDLE_TF, SLOW_PERIOD + 10)
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

  const signal = fastEMA > slowEMA ? 'long' : 'short'
  log('EMA', `Fast(${FAST_PERIOD})=${fastEMA.toFixed(2)}  Slow(${SLOW_PERIOD})=${slowEMA.toFixed(2)}  → ${signal.toUpperCase()}  | ${COIN} $${markPx}`)

  // Live position is the source of truth — never trust in-memory state
  const pos = await getPosition()
  const currentSide = pos?.side ?? 'flat'

  if (signal === currentSide) {
    log('HOLD', `Already ${currentSide} — no action`)
    return
  }

  // Close existing position — but never close at a loss unless stop-loss is hit
  if (pos) {
    const lossPct = pos.entry > 0
      ? (pos.side === 'long' ? (pos.entry - markPx) / pos.entry : (markPx - pos.entry) / pos.entry)
      : 0   // positive = losing

    if (lossPct > 0) {
      const stopHit = STOP_LOSS_PCT > 0 && lossPct >= STOP_LOSS_PCT
      if (!stopHit) {
        log('HOLD', `Signal flipped to ${signal.toUpperCase()} but position is at a loss (${(lossPct * 100).toFixed(2)}%) — holding, not closing`)
        return
      }
      log('STOP', `Stop-loss triggered — loss ${(lossPct * 100).toFixed(2)}% ≥ ${(STOP_LOSS_PCT * 100).toFixed(2)}% threshold — closing`)
    }

    const closed = await closePosition(markPx)
    if (!closed) return   // don't open against a position that didn't close
  }

  await openPosition(signal, markPx)
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `Trend Follower`)
  log('START', `Coin:      ${COIN}`)
  log('START', `EMA:       Fast(${FAST_PERIOD}) / Slow(${SLOW_PERIOD})  |  Timeframe: ${CANDLE_TF}`)
  log('START', `Size:      $${POSITION_USD}  |  Leverage: ${LEVERAGE}x  |  Interval: ${INTERVAL_MS / 60000}min`)
  log('START', `Stop-loss: ${STOP_LOSS_PCT > 0 ? (STOP_LOSS_PCT * 100).toFixed(1) + '%' : 'disabled (hold through losses)'}  |  querying ${QUERY_ADDR}`)
  log('START', '═'.repeat(60))

  if (POSITION_USD < HL_MIN_ORDER) {
    log('ERROR', `Position size $${POSITION_USD} is below HL's $${HL_MIN_ORDER} minimum. Increase --size.`)
    process.exit(1)
  }

  const { index } = await getAssetInfo(COIN)
  try {
    await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })
    log('INIT', `Leverage set to ${LEVERAGE}x cross for ${COIN}`)
  } catch (e) {
    log('WARN', `Could not set leverage: ${e.message}`)
  }

  await auditPosition()

  while (true) {
    if (isPaused()) { await sleep(INTERVAL_MS); continue }
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
