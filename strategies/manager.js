#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Strategy Manager
 *
 * Manages two sides simultaneously:
 *   SHORT: garbage assets near BTC 7-day high (+ S&P soft confirmation)
 *   LONG:  conviction assets — partial closes on BTC stale + re-entries + adds
 *
 * Usage:
 *   node strategies/manager.js \
 *     --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --long-assets BTC,SOL,HYPE \
 *     --short-assets PEPE,WIF,BONK \
 *     [--max-capital-pct 30] [--short-zone-pct 0.5] [--long-zone-pct 0.5] [--interval 1]
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused } from './_pause.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:            { type: 'string' },
    address:           { type: 'string' },
    'long-assets':     { type: 'string', default: '' },
    'short-assets':    { type: 'string', default: '' },
    'max-capital-pct': { type: 'string', default: '30'  },
    'short-zone-pct':  { type: 'string', default: '0.5' },
    'long-zone-pct':   { type: 'string', default: '0.5' },
    interval:          { type: 'string', default: '1'   },
  },
  allowPositionals: false,
  strict: false,
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

const LONG_ASSETS    = args['long-assets'].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
const SHORT_ASSETS   = args['short-assets'].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
const MAX_CAP_PCT    = parseFloat(args['max-capital-pct']) / 100   // e.g. 0.30
const SHORT_ZONE_PCT = parseFloat(args['short-zone-pct'])  / 100   // e.g. 0.005
const LONG_ZONE_PCT  = parseFloat(args['long-zone-pct'])   / 100   // e.g. 0.005
const INTERVAL_MS    = Math.max(1, parseInt(args.interval) || 1) * 60 * 1000

if (!LONG_ASSETS.length && !SHORT_ASSETS.length) {
  console.error('ERROR: provide at least one of --long-assets or --short-assets')
  process.exit(1)
}
if (SHORT_ZONE_PCT <= 0 || SHORT_ZONE_PCT > 1) {
  console.error('ERROR: --short-zone-pct must be between 0.1 and 100 (e.g. 0.5 = within 0.5% of 7d high)')
  process.exit(1)
}
if (LONG_ZONE_PCT <= 0 || LONG_ZONE_PCT > 1) {
  console.error('ERROR: --long-zone-pct must be between 0.1 and 100 (e.g. 0.5 = within 0.5% of 7d low)')
  process.exit(1)
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const QUERY_ADDR  = args.address ?? etherWallet.address   // master wallet for reads

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BTC_COIN            = 'BTC'
const SPX_COIN            = 'SPX'        // S&P 500 perp (soft signal — ok if absent)
const GARBAGE_PUMP_PCT    = 0.07         // garbage coin up ≥7% in 24h
const BTC_PUMP_PCT        = 0.02         // BTC up ≥2% triggers long partial-close watch
const STALE_RANGE_PCT     = 0.0005       // <0.05% range in last 1h = stale
const LONG_ADD_DROP_PCT   = 0.05         // add to long when 5% below entry
const MAX_LADDER          = 3            // max short entries per coin
const PARTIAL_CLOSE_PCT   = 0.25         // close 25% of long on stale signal
const PARTIAL_COOLDOWN_MS = 4 * 60 * 60 * 1000  // one partial close per 4h signal window
const ADD_COOLDOWN_MS     = 60 * 60 * 1000      // one add per coin per hour
const SLIPPAGE            = 0.003
const HL_MIN_ORDER        = 10

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
// In-memory only — seeded from live positions at startup where possible.
const shortState = {}  // coin → { entries, lastAddAt }
const longState  = {}  // coin → { pendingEntry, lastAddAt, lastPartialAt }

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

// ─── PRICE PRECISION ──────────────────────────────────────────────────────────
function roundPx(n) {
  // 5 significant figures
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
  if (px > 0 && sz * px < HL_MIN_ORDER) sz = Math.round((sz + minTick) * factor) / factor
  return sz
}

// ─── ASSET INDEX CACHE ────────────────────────────────────────────────────────
let _metaCache = null
const _levSet  = new Set()   // coins whose leverage we've already set this run

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

async function ensureLeverage(coin, index) {
  if (_levSet.has(coin)) return
  try {
    await exchange.updateLeverage({ asset: index, isCross: true, leverage: 1 })
    _levSet.add(coin)
  } catch (e) {
    log('WARN', `${coin}: could not set leverage: ${e.message}`)
  }
}

// ─── CANDLE HELPERS ───────────────────────────────────────────────────────────

async function fetchCandles(coin, interval, hours) {
  const endTime   = Date.now()
  const startTime = endTime - hours * 60 * 60 * 1000
  try {
    return await info.candleSnapshot({ coin, interval, startTime, endTime })
  } catch (e) {
    log('CANDLES', `${coin} ${interval} failed: ${e.message}`)
    return []
  }
}

/** Highest high over a candle array */
function candleHigh(candles) {
  if (!candles.length) return null
  return Math.max(...candles.map(c => parseFloat(c.h)))
}

/** % change open of first candle → close of last candle */
function pctChange(candles) {
  if (candles.length < 2) return 0
  const open  = parseFloat(candles[0].o)
  const close = parseFloat(candles.at(-1).c)
  if (!open) return 0
  return (close - open) / open
}

/** Price range (high-low) as % of midpoint over all candles */
function candleRange(candles) {
  if (!candles.length) return 0
  const high = Math.max(...candles.map(c => parseFloat(c.h)))
  const low  = Math.min(...candles.map(c => parseFloat(c.l)))
  const mid  = (high + low) / 2
  return mid > 0 ? (high - low) / mid : 0
}

// ─── ACCOUNT DATA ─────────────────────────────────────────────────────────────

async function getAccount() {
  const state        = await info.clearinghouseState({ user: QUERY_ADDR })
  const acctVal      = parseFloat(state.marginSummary?.accountValue ?? 0)
  const withdrawable = parseFloat(state.withdrawable ?? 0)
  const positions    = state.assetPositions ?? []
  const totalPosVal  = positions.reduce((s, p) => s + Math.abs(parseFloat(p.position.positionValue ?? 0)), 0)
  return { acctVal, withdrawable, positions, totalPosVal }
}

// ─── ORDER PLACEMENT ──────────────────────────────────────────────────────────
// Returns { filledSz, avgPx } — filledSz 0 when the IOC missed.
async function marketOrder({ coin, isBuy, sz, markPx, reduceOnly = false }) {
  const { index, szDecimals } = await getAssetInfo(coin)
  await ensureLeverage(coin, index)
  const limitPx = isBuy
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(limitPx).toString(),
      s: roundSz(sz, szDecimals, roundPx(markPx)).toString(),
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
  log('ORDER', `${isBuy ? 'BUY ' : 'SELL'} ${filledSz || roundSz(sz, szDecimals)} ${coin} @ $${avgPx || roundPx(markPx)} (IOC)${filledSz ? '' : ' — DID NOT FILL'}`)
  return { filledSz, avgPx }
}

async function limitOrder({ coin, isBuy, sz, px, reduceOnly = false }) {
  const { index, szDecimals } = await getAssetInfo(coin)
  await ensureLeverage(coin, index)

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(px).toString(),
      s: roundSz(sz, szDecimals, roundPx(px)).toString(),
      r: reduceOnly,
      t: { limit: { tif: 'Gtc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))

  log('LIMIT', `${isBuy ? 'BUY ' : 'SELL'} ${roundSz(sz, szDecimals)} ${coin} @ $${roundPx(px)} (GTC)`)
  return result
}

// ─── MACRO SIGNALS ────────────────────────────────────────────────────────────

async function getMacroSignals(allMids) {
  const [btcCandles7d, spxCandles7d, btcCandles4h] = await Promise.all([
    fetchCandles(BTC_COIN, '1d', 24 * 7),
    fetchCandles(SPX_COIN, '1d', 24 * 7),
    fetchCandles(BTC_COIN, '1h', 4),
  ])

  const btcMid = parseFloat(allMids[BTC_COIN] ?? 0)
  const spxMid = parseFloat(allMids[SPX_COIN] ?? 0)

  const btc7dHigh = candleHigh(btcCandles7d)
  const btc7dLow  = btcCandles7d.length ? Math.min(...btcCandles7d.map(c => parseFloat(c.l))) : null
  const spx7dHigh = candleHigh(spxCandles7d)

  const btcInShortZone = btc7dHigh && btcMid >= btc7dHigh * (1 - SHORT_ZONE_PCT)
  const spxInShortZone = spx7dHigh && spxMid >= spx7dHigh * (1 - SHORT_ZONE_PCT)
  const btcInLongZone  = btc7dLow  && btcMid <= btc7dLow  * (1 + LONG_ZONE_PCT)

  const btc4hPump = pctChange(btcCandles4h)

  log('MACRO', `BTC $${btcMid.toFixed(0)} | 7d-high $${btc7dHigh?.toFixed(0)} short-zone: ${btcInShortZone ? '✓' : 'no'} | 7d-low $${btc7dLow?.toFixed(0)} long-zone: ${btcInLongZone ? '✓' : 'no'} | 4h chg: ${(btc4hPump * 100).toFixed(2)}%`)
  if (spxMid > 0) log('MACRO', `SPX $${spxMid.toFixed(2)} | 7d-high $${spx7dHigh?.toFixed(2)} | zone: ${spxInShortZone ? '✓ YES (soft)' : 'no'}`)

  return { btcMid, spxMid, btc7dHigh, btc7dLow, spx7dHigh, btcInShortZone, btcInLongZone, spxInShortZone, btc4hPump }
}

// ─── SHORT SIDE ───────────────────────────────────────────────────────────────
// `cap` is shared mutable state: { used, limit } in USD — kept current within a
// tick so multiple entries can't blow past the capital cap together.

async function runShortSide(macro, positions, acctVal, cap, allMids) {
  if (!SHORT_ASSETS.length) return

  if (!macro.btcInShortZone) {
    log('SHORT', 'BTC not in short zone — skipping')
    return
  }

  for (const coin of SHORT_ASSETS) {
    const markPx = parseFloat(allMids[coin] ?? 0)
    if (!markPx) { log('SHORT', `${coin} — no price, skipping`); continue }

    const pos     = positions.find(p => p.position.coin === coin)
    const szi     = pos ? parseFloat(pos.position.szi ?? 0) : 0
    const isShort = szi < 0

    if (!shortState[coin]) shortState[coin] = { entries: isShort ? 1 : 0, lastAddAt: 0 }

    // ── Add to losing short ───────────────────────────────────────────────────
    if (isShort) {
      if (shortState[coin].entries >= MAX_LADDER) {
        log('SHORT', `${coin} — max ladder (${MAX_LADDER}) reached, holding`)
        continue
      }
      if (Date.now() - shortState[coin].lastAddAt < ADD_COOLDOWN_MS) continue

      const entryPx  = parseFloat(pos.position.entryPx ?? markPx)
      const isLosing = markPx > entryPx

      if (isLosing && cap.used < cap.limit) {
        const slice = Math.min((acctVal * MAX_CAP_PCT) / SHORT_ASSETS.length, cap.limit - cap.used)
        if (slice < HL_MIN_ORDER) continue
        log('SHORT', `${coin} — adding to loss. Entry $${entryPx.toFixed(4)} → now $${markPx.toFixed(4)} (+${((markPx / entryPx - 1) * 100).toFixed(2)}%)`)
        try {
          const { filledSz, avgPx } = await marketOrder({ coin, isBuy: false, sz: slice / markPx, markPx })
          if (filledSz > 0) {
            shortState[coin].entries++
            shortState[coin].lastAddAt = Date.now()
            cap.used += filledSz * (avgPx || markPx)
          }
        } catch (e) { log('ERROR', `Short add ${coin}: ${e.message}`) }
      }
      continue
    }

    // ── New short entry ───────────────────────────────────────────────────────
    if (cap.used >= cap.limit) {
      log('SHORT', `Cap ${(MAX_CAP_PCT * 100).toFixed(0)}% used — skip ${coin}`)
      continue
    }

    // 24h pump on the garbage coin — 1h candles over a 24h window
    const coinCandles24h = await fetchCandles(coin, '1h', 24)
    const pump24h        = pctChange(coinCandles24h)

    if (pump24h < GARBAGE_PUMP_PCT) {
      log('SHORT', `${coin} up only ${(pump24h * 100).toFixed(1)}% in 24h (need ≥${GARBAGE_PUMP_PCT * 100}%) — skip`)
      continue
    }

    // S&P soft confirmation: +15% size if SPX also near 7d high
    const spxMult = macro.spxInShortZone ? 1.15 : 1.0
    const slice   = Math.min((acctVal * MAX_CAP_PCT) / SHORT_ASSETS.length * spxMult, cap.limit - cap.used)
    if (slice < HL_MIN_ORDER) continue

    log('SHORT', `${coin} NEW SHORT — pumped ${(pump24h * 100).toFixed(1)}% in 24h | BTC in zone | SPX: ${macro.spxInShortZone ? 'confirming (+15% size)' : 'neutral'}`)
    try {
      const { filledSz, avgPx } = await marketOrder({ coin, isBuy: false, sz: slice / markPx, markPx })
      if (filledSz > 0) {
        shortState[coin].entries  = 1
        shortState[coin].lastAddAt = Date.now()
        cap.used += filledSz * (avgPx || markPx)
      }
    } catch (e) { log('ERROR', `Short entry ${coin}: ${e.message}`) }
  }
}

// ─── LONG SIDE ────────────────────────────────────────────────────────────────

async function runLongSide(macro, positions, acctVal, cap, allMids) {
  if (!LONG_ASSETS.length) return

  for (const coin of LONG_ASSETS) {
    const markPx = parseFloat(allMids[coin] ?? 0)
    if (!markPx) continue

    const pos = positions.find(p => p.position.coin === coin)
    const szi = pos ? parseFloat(pos.position.szi ?? 0) : 0

    if (!longState[coin]) longState[coin] = { pendingEntry: false, lastAddAt: 0, lastPartialAt: 0 }

    // ── New long entry in long zone ───────────────────────────────────────────
    if (szi <= 0) {
      if (longState[coin].pendingEntry) {
        log('LONG', `${coin} — entry pending confirmation from exchange, skipping`)
        continue
      }
      if (!macro.btcInLongZone) {
        log('LONG', `${coin} — no position & BTC not in long zone — skipping`)
        continue
      }
      if (cap.used >= cap.limit) {
        log('LONG', `Cap ${(MAX_CAP_PCT * 100).toFixed(0)}% used — skip ${coin}`)
        continue
      }
      const slice = Math.min((acctVal * MAX_CAP_PCT) / LONG_ASSETS.length, cap.limit - cap.used)
      if (slice < HL_MIN_ORDER) continue
      log('LONG', `${coin} NEW LONG — BTC near 7d low ($${macro.btc7dLow?.toFixed(0)}) | entering ~$${slice.toFixed(2)}`)
      try {
        const { filledSz, avgPx } = await marketOrder({ coin, isBuy: true, sz: slice / markPx, markPx })
        if (filledSz > 0) {
          longState[coin].pendingEntry = true   // guard against double-entry next tick
          cap.used += filledSz * (avgPx || markPx)
        }
      } catch (e) { log('ERROR', `Long entry ${coin}: ${e.message}`) }
      continue
    }

    // Position confirmed — clear pending flag
    longState[coin].pendingEntry = false

    const entryPx = parseFloat(pos.position.entryPx ?? markPx)

    // ── Add to losing long (rate-limited) ─────────────────────────────────────
    const dropFromEntry = (entryPx - markPx) / entryPx
    if (dropFromEntry >= LONG_ADD_DROP_PCT && cap.used < cap.limit
        && Date.now() - longState[coin].lastAddAt >= ADD_COOLDOWN_MS) {
      const slice = Math.min((acctVal * MAX_CAP_PCT) / LONG_ASSETS.length, cap.limit - cap.used)
      if (slice >= HL_MIN_ORDER) {
        log('LONG', `${coin} ADD — down ${(dropFromEntry * 100).toFixed(1)}% from entry $${entryPx.toFixed(4)} | adding ~$${slice.toFixed(2)}`)
        try {
          const { filledSz, avgPx } = await marketOrder({ coin, isBuy: true, sz: slice / markPx, markPx })
          if (filledSz > 0) {
            longState[coin].lastAddAt = Date.now()
            cap.used += filledSz * (avgPx || markPx)
          }
        } catch (e) { log('ERROR', `Long add ${coin}: ${e.message}`) }
        continue
      }
    }

    // ── Partial close on BTC stale signal ─────────────────────────────────────
    // Step 1: BTC pumped ≥2% in last 4h
    if (macro.btc4hPump < BTC_PUMP_PCT) continue

    // One partial close per signal window — without this the bot would shave
    // 25% off the position every tick while BTC stays pumped + stale.
    if (Date.now() - longState[coin].lastPartialAt < PARTIAL_COOLDOWN_MS) continue

    // Step 2: BTC pumped — check the last 1h candle for stale
    const btc1hCandles = await fetchCandles(BTC_COIN, '1h', 1)
    const staleRange   = candleRange(btc1hCandles)
    if (staleRange > STALE_RANGE_PCT) {
      log('LONG', `${coin} — BTC pumped ${(macro.btc4hPump * 100).toFixed(2)}% in 4h, watching for stale (range ${(staleRange * 100).toFixed(3)}%)`)
      continue
    }

    // Step 3: BTC is stale — partial close the long
    log('LONG', `${coin} PARTIAL CLOSE — BTC stale (range ${(staleRange * 100).toFixed(3)}% in 1h) | closing ${PARTIAL_CLOSE_PCT * 100}% of position`)
    const closeSz = Math.abs(szi) * PARTIAL_CLOSE_PCT
    try {
      const { filledSz, avgPx } = await marketOrder({ coin, isBuy: false, sz: closeSz, markPx, reduceOnly: true })
      if (filledSz <= 0) { log('WARN', `${coin} partial close did not fill — retrying next cycle`); continue }

      longState[coin].lastPartialAt = Date.now()
      const exitPx = avgPx || markPx
      if (exitPx > entryPx) {
        const pnlPct = ((exitPx - entryPx) / entryPx * 100).toFixed(2)
        const pnlUsd = ((exitPx - entryPx) * filledSz).toFixed(2)
        log('WIN', `${coin} partial close @ $${exitPx.toFixed(4)} | entry $${entryPx.toFixed(4)} | +${pnlPct}% | ~$${pnlUsd} profit`)
      }

      // Place limit re-entry at original entry price
      log('LONG', `${coin} RE-ENTRY LIMIT — placing buy @ $${entryPx.toFixed(4)} for ${filledSz.toFixed(4)} coins`)
      await limitOrder({ coin, isBuy: true, sz: filledSz, px: entryPx })
    } catch (e) { log('ERROR', `Long partial close ${coin}: ${e.message}`) }
  }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function run() {
  log('START', '═'.repeat(60))
  log('START', `Insolvent Terminal — Strategy Manager`)
  log('START', `Querying:  ${QUERY_ADDR}`)
  log('START', `Long:      ${LONG_ASSETS.length  ? LONG_ASSETS.join(', ')  : '(none)'}`)
  log('START', `Short:     ${SHORT_ASSETS.length ? SHORT_ASSETS.join(', ') : '(none)'}`)
  log('START', `Cap limit: ${MAX_CAP_PCT * 100}% | Short zone: ${SHORT_ZONE_PCT * 100}% from 7d high | Long zone: ${LONG_ZONE_PCT * 100}% from 7d low | Interval: ${INTERVAL_MS / 60000}min`)
  log('START', '═'.repeat(60))

  // Pre-load asset index cache
  await getAssetInfo(BTC_COIN).catch(() => {})

  while (true) {
    if (isPaused()) { await sleep(INTERVAL_MS); continue }
    log('RUN', '─'.repeat(60))

    try {
      const allMids = await info.allMids()

      const [macro, account] = await Promise.all([
        getMacroSignals(allMids),
        getAccount(),
      ])

      const { acctVal, withdrawable, positions, totalPosVal } = account
      if (acctVal <= 0) {
        log('WARN', `Account value $0 for ${QUERY_ADDR} — is --address set to the right master wallet?`)
        await sleep(INTERVAL_MS)
        continue
      }

      // Shared capital tracker — updated as orders fill within this tick
      const cap = { used: totalPosVal, limit: acctVal * MAX_CAP_PCT }

      log('ACCT', `Value $${acctVal.toFixed(2)} | Available $${withdrawable.toFixed(2)} | Capital used ${(cap.used / acctVal * 100).toFixed(1)}% / ${(MAX_CAP_PCT * 100).toFixed(0)}%`)

      await runShortSide(macro, positions, acctVal, cap, allMids)
      await runLongSide(macro, positions, acctVal, cap, allMids)

    } catch (e) {
      log('ERROR', `Loop: ${e.message}`)
    }

    log('RUN', `Sleeping ${INTERVAL_MS / 60000} min...`)
    await sleep(INTERVAL_MS)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
