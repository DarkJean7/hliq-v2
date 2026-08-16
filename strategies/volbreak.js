#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Volatility Category Breakout
 *
 * Large-range breakout continuation. When a closed candle's high-low range is a
 * large multiple of the RECENT average range, bet on continuation in that
 * candle's direction: big green -> long, big red -> short.
 *
 * The "category" is the range bucket: 1 = range >= 1x the rolling average,
 * 2 = >= 2x, ... capped at 6. Sign follows the candle colour, so a big red
 * candle scores -4 and a big green one +4. Entry fires at |category| >= threshold.
 *
 * Ported from an OANDA forex backtest, with four bugs fixed:
 *   - the average range was computed over the WHOLE dataset (lookahead bias);
 *     it is now a rolling window of the N candles strictly BEFORE the signal
 *   - TP/SL were fixed pip distances that silently gave longs 2:1 and shorts
 *     1:1; both sides now scale off the same rolling range (see TP/SL below)
 *   - open positions came from an undefined helper; the exchange is now the
 *     single source of truth via clearinghouseState
 *   - the trade simulator compounded its own balance, bypassing all risk
 *     limits; live sizing goes through --size/--leverage like every other bot
 *
 * TP/SL — DELIBERATE CHOICE: both are multiples of the rolling average range,
 * so targets widen when the market is volatile and tighten when it is calm,
 * and long/short are symmetric. Defaults 2.0x TP / 1.0x SL = 2:1 reward:risk on
 * both sides. Pass --tp-mult/--sl-mult to change; they are NOT auto-derived
 * from each other, so an intentionally asymmetric book is still possible.
 *
 * In live mode TP and SL are placed as reduce-only trigger orders ON the
 * exchange, so they survive this process dying. The bot never stacks entries:
 * if a position is already open on the coin it holds until it is gone.
 *
 * Usage:
 *   # backtest (no key needed, places nothing)
 *   node strategies/volbreak.js --mode backtest --coin BTC --candle-tf 15m --candles 3000
 *
 *   # paper (live candles, logs signals, places nothing)
 *   node strategies/volbreak.js --mode paper --coin BTC --candle-tf 15m
 *
 *   # live
 *   node strategies/volbreak.js --mode live --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --coin BTC --candle-tf 15m --lookback 20 --threshold 3 \
 *     --tp-mult 2 --sl-mult 1 --cooldown 4 --size 500 --leverage 3
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused }  from './_pause.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:      { type: 'string' },
    address:     { type: 'string' },
    mode:        { type: 'string', default: 'paper' },   // backtest | paper | live
    coin:        { type: 'string', default: 'BTC' },
    'candle-tf': { type: 'string', default: '15m' },
    lookback:    { type: 'string', default: '20'  },     // candles in the rolling average
    threshold:   { type: 'string', default: '3'   },     // |category| needed to fire
    'tp-mult':   { type: 'string', default: '2'   },     // x rolling avg range
    'sl-mult':   { type: 'string', default: '1'   },     // x rolling avg range
    cooldown:    { type: 'string', default: '4'   },     // candles to wait after an entry
    size:        { type: 'string', default: '500' },     // USD notional per position
    leverage:    { type: 'string', default: '3'   },
    interval:    { type: 'string', default: '5'   },     // minutes between live checks
    candles:     { type: 'string', default: '2000' },    // backtest history length
    'fee-bps':   { type: 'string', default: '4.5' },     // taker fee per side, backtest only
    'start-equity': { type: 'string', default: '1000' }, // backtest bookkeeping only
    json:        { type: 'boolean', default: false },    // emit one JSON object instead of a log
  },
  allowPositionals: false,
  strict: false,
})

const VALID_TFS = ['1m','3m','5m','15m','30m','1h','2h','4h','8h','12h','1d','3d','1w']
const MODE      = ['backtest','paper','live'].includes(String(args.mode).toLowerCase())
  ? String(args.mode).toLowerCase() : 'paper'

const COIN        = args.coin.toUpperCase()
const CANDLE_TF   = VALID_TFS.includes(args['candle-tf']) ? args['candle-tf'] : '15m'
const LOOKBACK    = Math.max(2, parseInt(args.lookback)  || 20)
const THRESHOLD   = Math.max(1, parseInt(args.threshold) || 3)
const TP_MULT     = Math.max(0.1, parseFloat(args['tp-mult']) || 2)
const SL_MULT     = Math.max(0.1, parseFloat(args['sl-mult']) || 1)
const COOLDOWN    = Math.max(0, parseInt(args.cooldown) ?? 4)
const POSITION_USD = parseFloat(args.size)
const LEVERAGE    = parseInt(args.leverage)
const INTERVAL_MS = Math.max(1, parseInt(args.interval) || 5) * 60 * 1000
const BT_CANDLES  = Math.max(LOOKBACK + 10, parseInt(args.candles) || 2000)
const FEE         = (parseFloat(args['fee-bps']) || 0) / 10000
const START_EQ    = parseFloat(args['start-equity']) || 1000

const SLIPPAGE     = 0.003
const HL_MIN_ORDER = 10
const CATEGORY_MAX = 6

// Live/paper both read the chain; only live needs a key that can sign.
const walletKey = process.env.AGENT_KEY || args.wallet
if (MODE === 'live' && !walletKey) {
  console.error('ERROR: agent key not provided (required for --mode live)')
  process.exit(1)
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = walletKey ? new ethers.Wallet(walletKey) : null
const exchange    = etherWallet ? new ExchangeClient({ transport, wallet: etherWallet }) : null
const QUERY_ADDR  = args.address ?? etherWallet?.address ?? null

// JSON mode must keep stdout clean — the caller parses the whole stream.
const JSON_OUT = !!args.json

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  if (JSON_OUT) return
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let m = msg
  if (tag.trim() === 'ERROR' && typeof m === 'string') {
    const h = m.search(/<\s*html/i)
    if (h !== -1) m = m.slice(0, h).replace(/[-\s]+$/, '').trim() || ((m.match(/<title>([^<]+)<\/title>/i) || [])[1] || 'HTML error').trim()
    m = m.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  console.log(`[${ts}] [${tag.padEnd(8)}] ${m}`)
}

function roundPx(n, szDecimals) {
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

// ─── CANDLE FETCH ─────────────────────────────────────────────────────────────
const TF_HOURS = { '1m':1/60,'3m':3/60,'5m':5/60,'15m':0.25,'30m':0.5,'1h':1,'2h':2,'4h':4,'8h':8,'12h':12,'1d':24,'3d':72,'1w':168 }

/**
 * Hyperliquid candleSnapshot -> the internal candle shape the rest of this
 * module uses. Every downstream function reads only these fields, so swapping
 * the data source again means touching nothing but this function.
 *
 * NOTE: unlike the OANDA original, Open is the candle's REAL open. The original
 * overwrote each open with the previous candle's close to fake a continuous
 * series; on a 24/7 perp there are no session gaps, so that hack is dropped.
 */
async function fetchCandles(coin, interval, count) {
  const tfHours   = TF_HOURS[interval] ?? 1
  const endTime   = Date.now()
  const startTime = endTime - (count * tfHours * 1.5 + tfHours * 10) * 60 * 60 * 1000

  const raw = await info.candleSnapshot({ coin, interval, startTime, endTime })
  const out = { Time: [], Open: [], High: [], Low: [], Close: [], Color: [] }
  for (const c of raw ?? []) {
    const o = parseFloat(c.o), h = parseFloat(c.h), l = parseFloat(c.l), cl = parseFloat(c.c)
    if (![o, h, l, cl].every(Number.isFinite)) continue
    out.Time.push(Number(c.t))
    out.Open.push(o); out.High.push(h); out.Low.push(l); out.Close.push(cl)
    out.Color.push(cl - o < 0 ? 'Red' : 'Green')
  }
  return out
}

// ─── SIGNAL MATH ──────────────────────────────────────────────────────────────
const range = (candles, i) => candles.High[i] - candles.Low[i]

/**
 * Average High-Low range over the LOOKBACK candles strictly before idx.
 * Returns null when there is not enough history — the caller must skip, never
 * fall back to a partial window (that was the original's lookahead bug).
 */
function computeRollingAverage(candles, idx, lookback = LOOKBACK) {
  if (idx < lookback) return null
  let sum = 0
  for (let i = idx - lookback; i < idx; i++) sum += range(candles, i)
  const avg = sum / lookback
  return avg > 0 ? avg : null
}

/** Range bucket 1..6 relative to the rolling average, negated for red candles. */
function categorize(candles, idx, lookback = LOOKBACK) {
  const avg = computeRollingAverage(candles, idx, lookback)
  if (avg == null) return null
  const cat = Math.min(CATEGORY_MAX, Math.floor(range(candles, idx) / avg))
  return candles.Color[idx] === 'Red' ? -cat : cat
}

/**
 * Signal for the candle at idx, entered at its close.
 * TP/SL are multiples of the rolling average range (see header).
 */
function generateSignal(candles, idx, opts = {}) {
  const lookback  = opts.lookback  ?? LOOKBACK
  const threshold = opts.threshold ?? THRESHOLD
  const tpMult    = opts.tpMult    ?? TP_MULT
  const slMult    = opts.slMult    ?? SL_MULT

  const avg = computeRollingAverage(candles, idx, lookback)
  if (avg == null) return null
  const cat = categorize(candles, idx, lookback)
  if (cat == null || Math.abs(cat) < threshold) return null

  const side  = cat > 0 ? 'long' : 'short'
  const entry = candles.Close[idx]
  const dir   = side === 'long' ? 1 : -1
  return {
    idx,
    side,
    category:   cat,
    entry,
    avgRange:   avg,
    takeProfit: entry + dir * tpMult * avg,
    stopLoss:   entry - dir * slMult * avg,
    time:       candles.Time[idx],
  }
}

// ─── BACKTEST ─────────────────────────────────────────────────────────────────
/**
 * Walk-forward simulation. Entry at the signal candle's close, then each later
 * candle is checked for TP/SL.
 *
 * INTRABAR AMBIGUITY: when one candle's range covers BOTH levels we cannot know
 * which printed first, so it is scored as a LOSS. That is the pessimistic
 * assumption and it matters most on wide TP/SL multiples.
 *
 * Equity here is a reporting device only (fixed notional per trade, no
 * compounding) so backtest numbers can never be confused with live sizing,
 * which goes through --size/--leverage and the account's real margin.
 */
function runBacktest(candles, opts = {}) {
  const cooldown = opts.cooldown ?? COOLDOWN
  const notional = opts.notional ?? POSITION_USD

  const n = candles.Close.length
  const trades = []
  let equity = opts.startEquity ?? START_EQ
  let peak = equity, maxDD = 0
  const curve = [{ t: candles.Time[0] ?? 0, equity }]
  let cooldownUntil = -1

  for (let i = 0; i < n - 1; i++) {
    if (i < cooldownUntil) continue
    const sig = generateSignal(candles, i, opts)
    if (!sig) continue

    cooldownUntil = i + 1 + cooldown

    // Resolve the trade against subsequent candles.
    let exitIdx = null, exitPx = null, outcome = null
    for (let j = i + 1; j < n; j++) {
      const hitTp = sig.side === 'long' ? candles.High[j] >= sig.takeProfit : candles.Low[j]  <= sig.takeProfit
      const hitSl = sig.side === 'long' ? candles.Low[j]  <= sig.stopLoss   : candles.High[j] >= sig.stopLoss
      if (hitSl) { exitIdx = j; exitPx = sig.stopLoss;   outcome = 'loss'; break }   // ties -> loss
      if (hitTp) { exitIdx = j; exitPx = sig.takeProfit; outcome = 'win';  break }
    }
    if (exitIdx == null) {
      // Still open at the end of the data — marked to the last close and
      // reported separately so it can't inflate the win rate.
      exitIdx = n - 1; exitPx = candles.Close[n - 1]; outcome = 'open'
    }

    const dir     = sig.side === 'long' ? 1 : -1
    const grossPct = dir * (exitPx - sig.entry) / sig.entry
    const pnl      = notional * grossPct - notional * FEE * 2
    equity += pnl
    peak    = Math.max(peak, equity)
    maxDD   = Math.max(maxDD, peak > 0 ? (peak - equity) / peak : 0)
    curve.push({ t: candles.Time[exitIdx], equity })

    trades.push({
      side: sig.side, category: sig.category, entry: sig.entry, exit: exitPx,
      tp: sig.takeProfit, sl: sig.stopLoss, outcome, pnl,
      entryTime: sig.time, exitTime: candles.Time[exitIdx],
      barsHeld: exitIdx - i,
    })
  }

  const closed = trades.filter(t => t.outcome !== 'open')
  const wins   = closed.filter(t => t.outcome === 'win')
  return {
    trades, curve,
    totalTrades:  trades.length,
    closedTrades: closed.length,
    stillOpen:    trades.length - closed.length,
    wins:   wins.length,
    losses: closed.length - wins.length,
    winRate: closed.length ? wins.length / closed.length : 0,
    startEquity: opts.startEquity ?? START_EQ,
    finalEquity: equity,
    maxDrawdown: maxDD,
    avgBarsHeld: closed.length ? closed.reduce((s, t) => s + t.barsHeld, 0) / closed.length : 0,
  }
}

function reportBacktest(r, candles) {
  const pct = (x) => `${(x * 100).toFixed(2)}%`
  const from = candles.Time[0] ? new Date(candles.Time[0]).toISOString().slice(0, 16).replace('T', ' ') : '?'
  const to   = candles.Time.at(-1) ? new Date(candles.Time.at(-1)).toISOString().slice(0, 16).replace('T', ' ') : '?'

  log('RESULT', '═'.repeat(60))
  log('RESULT', `${COIN} ${CANDLE_TF} | ${candles.Close.length} candles | ${from} -> ${to} UTC`)
  log('RESULT', `lookback ${LOOKBACK} | threshold ${THRESHOLD} | TP ${TP_MULT}x / SL ${SL_MULT}x avg range | cooldown ${COOLDOWN}`)
  log('RESULT', '─'.repeat(60))
  log('RESULT', `Trades:       ${r.totalTrades} (${r.closedTrades} closed, ${r.stillOpen} open at end)`)
  log('RESULT', `Win rate:     ${pct(r.winRate)}  (${r.wins}W / ${r.losses}L)`)
  log('RESULT', `Avg hold:     ${r.avgBarsHeld.toFixed(1)} candles`)
  log('RESULT', `Equity:       $${r.startEquity.toFixed(2)} -> $${r.finalEquity.toFixed(2)}  (${pct((r.finalEquity - r.startEquity) / r.startEquity)})`)
  log('RESULT', `Max drawdown: ${pct(r.maxDrawdown)}`)
  log('RESULT', `Fees:         ${(FEE * 10000).toFixed(1)} bps/side on $${POSITION_USD} notional`)
  log('RESULT', '─'.repeat(60))

  // Per-category breakdown — shows whether bigger breakouts actually pay more.
  const byCat = new Map()
  for (const t of r.trades) {
    if (t.outcome === 'open') continue
    const k = Math.abs(t.category)
    const c = byCat.get(k) ?? { n: 0, w: 0, pnl: 0 }
    c.n++; if (t.outcome === 'win') c.w++; c.pnl += t.pnl
    byCat.set(k, c)
  }
  for (const k of [...byCat.keys()].sort((a, b) => a - b)) {
    const c = byCat.get(k)
    log('RESULT', `  |cat| ${k}: ${String(c.n).padStart(4)} trades | ${pct(c.w / c.n).padStart(7)} win | ${c.pnl >= 0 ? '+' : ''}$${c.pnl.toFixed(2)}`)
  }

  // Sparse equity curve so the log stays readable on long runs.
  log('RESULT', '─'.repeat(60))
  const step = Math.max(1, Math.ceil(r.curve.length / 12))
  const pts  = r.curve.filter((_, i) => i % step === 0 || i === r.curve.length - 1)
  log('RESULT', `Equity curve: ${pts.map(p => '$' + p.equity.toFixed(0)).join(' -> ')}`)
  log('RESULT', '═'.repeat(60))
  if (r.stillOpen) log('NOTE', `${r.stillOpen} trade(s) never hit TP or SL and are excluded from the win rate.`)
  log('NOTE', 'Funding is NOT modelled — see the header note. On multi-day holds it is material.')
}

// ─── LIVE: POSITION (exchange is the source of truth) ────────────────────────
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

async function marketOrder({ isBuy, sz, markPx }) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = isBuy ? markPx * (1 + SLIPPAGE) : markPx * (1 - SLIPPAGE)
  const rSz     = roundSz(sz, szDecimals, roundPx(markPx))

  const result = await exchange.order({
    orders: [{
      a: index, b: isBuy,
      p: roundPx(limitPx, szDecimals).toString(),
      s: rSz.toString(),
      r: false,
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
  log('ORDER', `${isBuy ? 'BUY ' : 'SELL'} ${filledSz || rSz} ${COIN} @ $${avgPx || roundPx(markPx)} (IOC)${filledSz ? '' : ' — DID NOT FILL'}`)
  return { filledSz, avgPx }
}

/** Reduce-only trigger order, so TP/SL live on the exchange and outlive this process. */
async function triggerOrder({ isBuy, sz, triggerPx, tpsl }) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = isBuy ? triggerPx * (1 + 0.01) : triggerPx * (1 - 0.01)
  const result = await exchange.order({
    orders: [{
      a: index, b: isBuy,
      p: roundPx(limitPx, szDecimals).toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: true,
      t: { trigger: { triggerPx: roundPx(triggerPx, szDecimals).toString(), isMarket: true, tpsl } },
    }],
    grouping: 'na',
  })
  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))
  log('ORDER', `${tpsl.toUpperCase()} armed @ $${roundPx(triggerPx, szDecimals)}`)
}

async function openPosition(sig, markPx) {
  const sz = POSITION_USD / markPx
  log('OPEN', `${sig.side.toUpperCase()} ~${sz.toFixed(6)} ${COIN} @ ~$${markPx} | cat ${sig.category > 0 ? '+' : ''}${sig.category}`)
  const { filledSz } = await marketOrder({ isBuy: sig.side === 'long', sz, markPx })
  if (filledSz <= 0) { log('WARN', 'Entry did not fill — no TP/SL armed, retrying next tick'); return false }

  // TP/SL sized to what actually filled, not what we asked for.
  const closeIsBuy = sig.side === 'short'
  try { await triggerOrder({ isBuy: closeIsBuy, sz: filledSz, triggerPx: sig.takeProfit, tpsl: 'tp' }) }
  catch (e) { log('ERROR', `TP failed: ${e.message}`) }
  try { await triggerOrder({ isBuy: closeIsBuy, sz: filledSz, triggerPx: sig.stopLoss,  tpsl: 'sl' }) }
  catch (e) { log('ERROR', `SL failed: ${e.message} — position is UNPROTECTED`) }
  return true
}

// ─── LIVE TICK ────────────────────────────────────────────────────────────────
let _lastEntryCandleTime = 0   // cooldown anchored to candle time, so restarts respect it

async function tick() {
  const candles = await fetchCandles(COIN, CANDLE_TF, LOOKBACK + 5)
  if (candles.Close.length < LOOKBACK + 2) {
    log('WARN', `Not enough candles (${candles.Close.length}) for lookback ${LOOKBACK} — skipping`)
    return
  }

  // The final candle is still forming; signal off the last CLOSED one.
  const idx = candles.Close.length - 2
  const cat = categorize(candles, idx)
  const avg = computeRollingAverage(candles, idx)
  const t   = new Date(candles.Time[idx]).toISOString().slice(11, 16)
  log('SCAN', `${COIN} ${CANDLE_TF} candle ${t}Z | range $${range(candles, idx).toFixed(4)} vs avg $${avg?.toFixed(4)} | cat ${cat > 0 ? '+' : ''}${cat}`)

  const pos = await getPosition()
  if (pos) {
    log('HOLD', `Position already open (${pos.side.toUpperCase()} sz=${Math.abs(pos.szi)}, uPnL ${pos.upnl >= 0 ? '+' : ''}${pos.upnl.toFixed(2)}) — TP/SL are on the exchange`)
    return
  }

  const sig = generateSignal(candles, idx)
  if (!sig) { log('WAIT', `No signal (need |cat| >= ${THRESHOLD})`); return }

  // Cooldown in candle time, so a restart cannot re-fire the same breakout.
  const tfMs = (TF_HOURS[CANDLE_TF] ?? 1) * 60 * 60 * 1000
  if (_lastEntryCandleTime && candles.Time[idx] - _lastEntryCandleTime < COOLDOWN * tfMs) {
    const left = Math.ceil((COOLDOWN * tfMs - (candles.Time[idx] - _lastEntryCandleTime)) / tfMs)
    log('WAIT', `Signal ${sig.side.toUpperCase()} cat ${sig.category} suppressed — cooldown, ~${left} candle(s) left`)
    return
  }

  const allMids = await info.allMids()
  const markPx  = parseFloat(allMids[COIN] ?? 0)
  if (!markPx) throw new Error(`No price for ${COIN}`)

  log('SIGNAL', `${sig.side.toUpperCase()} cat ${sig.category > 0 ? '+' : ''}${sig.category} | entry ~$${markPx} | TP $${sig.takeProfit.toFixed(4)} | SL $${sig.stopLoss.toFixed(4)}`)

  if (MODE === 'paper') {
    log('PAPER', 'Would enter here — paper mode places nothing')
    _lastEntryCandleTime = candles.Time[idx]
    return
  }

  const opened = await openPosition(sig, markPx)
  if (opened) _lastEntryCandleTime = candles.Time[idx]
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `Volatility Category Breakout — ${MODE.toUpperCase()}`)
  log('START', `Coin:      ${COIN}  |  Timeframe: ${CANDLE_TF}`)
  log('START', `Signal:    rolling avg ${LOOKBACK} candles  |  |category| >= ${THRESHOLD}`)
  log('START', `TP/SL:     ${TP_MULT}x / ${SL_MULT}x avg range (${(TP_MULT / SL_MULT).toFixed(2)}:1 R:R, symmetric long/short)`)
  log('START', `Cooldown:  ${COOLDOWN} candles`)
  if (MODE !== 'backtest') log('START', `Size:      $${POSITION_USD}  |  Leverage: ${LEVERAGE}x  |  Interval: ${INTERVAL_MS / 60000}min  |  querying ${QUERY_ADDR}`)
  log('START', '═'.repeat(60))

  if (MODE === 'backtest') {
    const candles = await fetchCandles(COIN, CANDLE_TF, BT_CANDLES)
    if (candles.Close.length < LOOKBACK + 10) {
      const msg = `Only ${candles.Close.length} candles returned — need more than ${LOOKBACK + 10}`
      if (JSON_OUT) { process.stdout.write(JSON.stringify({ ok: false, error: msg })); process.exit(0) }
      log('ERROR', msg)
      process.exit(1)
    }
    const r = runBacktest(candles)

    if (JSON_OUT) {
      // Per-|category| breakdown, same grouping the text report prints.
      const byCat = {}
      for (const t of r.trades) {
        if (t.outcome === 'open') continue
        const k = Math.abs(t.category)
        const c = byCat[k] ?? (byCat[k] = { n: 0, wins: 0, pnl: 0 })
        c.n++; if (t.outcome === 'win') c.wins++; c.pnl += t.pnl
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        coin: COIN, interval: CANDLE_TF,
        params: { lookback: LOOKBACK, threshold: THRESHOLD, tpMult: TP_MULT, slMult: SL_MULT,
                  cooldown: COOLDOWN, notional: POSITION_USD, feeBps: FEE * 10000 },
        candles: candles.Close.length,
        from: candles.Time[0] ?? null,
        to:   candles.Time.at(-1) ?? null,
        totalTrades: r.totalTrades, closedTrades: r.closedTrades, stillOpen: r.stillOpen,
        wins: r.wins, losses: r.losses, winRate: r.winRate,
        breakEvenWinRate: SL_MULT / (TP_MULT + SL_MULT),   // what the R:R demands
        avgBarsHeld: r.avgBarsHeld,
        startEquity: r.startEquity, finalEquity: r.finalEquity,
        returnPct: (r.finalEquity - r.startEquity) / r.startEquity,
        maxDrawdown: r.maxDrawdown,
        byCategory: byCat,
        // Downsampled so a 3000-candle run doesn't ship a huge payload.
        curve: r.curve.filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 60)) === 0 || i === a.length - 1),
        trades: r.trades.slice(-40),
      }))
      return
    }

    reportBacktest(r, candles)
    return
  }

  if (!QUERY_ADDR) { log('ERROR', '--address or an agent key is required for live/paper mode'); process.exit(1) }
  if (POSITION_USD < HL_MIN_ORDER) {
    log('ERROR', `Position size $${POSITION_USD} is below HL's $${HL_MIN_ORDER} minimum. Increase --size.`)
    process.exit(1)
  }

  if (MODE === 'live') {
    const { index } = await getAssetInfo(COIN)
    try {
      await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })
      log('INIT', `Leverage set to ${LEVERAGE}x cross for ${COIN}`)
    } catch (e) {
      log('WARN', `Could not set leverage: ${e.message}`)
    }
  }

  const pos = await getPosition()
  log('AUDIT', pos
    ? `${COIN} ${pos.side.toUpperCase()} | sz=${Math.abs(pos.szi).toFixed(4)} | entry $${pos.entry.toFixed(4)} | uPnL ${pos.upnl >= 0 ? '+' : ''}${pos.upnl.toFixed(2)}`
    : `${COIN} — no open position`)

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
