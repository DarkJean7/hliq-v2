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
 *     --wallet 0xYOUR_AGENT_KEY \
 *     --long-assets BTC,SOL,HYPE \
 *     --short-assets PEPE,WIF,BONK \
 *     [--max-capital-pct 30] \
 *     [--short-zone-pct 0.5] \
 *     [--interval 1]
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:             { type: 'string' },
    'long-assets':      { type: 'string', default: '' },
    'short-assets':     { type: 'string', default: '' },
    'max-capital-pct':  { type: 'string', default: '30'  },
    'short-zone-pct':   { type: 'string', default: '0.5' },
    'long-zone-pct':    { type: 'string', default: '0.5' },
    interval:           { type: 'string', default: '1'   },
  },
  allowPositionals: false,
})

if (!args.wallet) {
  console.error('ERROR: --wallet is required (agent private key starting with 0x)')
  process.exit(1)
}

const LONG_ASSETS    = args['long-assets'].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
const SHORT_ASSETS   = args['short-assets'].split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
const MAX_CAP_PCT    = parseFloat(args['max-capital-pct']) / 100   // e.g. 0.30
const SHORT_ZONE_PCT = parseFloat(args['short-zone-pct'])  / 100   // e.g. 0.005
const LONG_ZONE_PCT  = parseFloat(args['long-zone-pct'])   / 100   // e.g. 0.005
const INTERVAL_MS    = parseInt(args.interval) * 60 * 1000

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
const transport      = new HttpTransport()
const info           = new InfoClient({ transport })
const etherWallet    = new ethers.Wallet(args.wallet)
const exchange       = new ExchangeClient({ transport, wallet: etherWallet })
const ADDRESS        = etherWallet.address

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const BTC_COIN          = 'BTC'
const SPX_COIN          = 'SPX'     // S&P 500 perp on Hyperliquid
const GARBAGE_PUMP_PCT  = 0.07      // garbage coin up ≥7% in 24h
const BTC_PUMP_PCT      = 0.02      // BTC up ≥2% triggers long partial-close watch
const STALE_RANGE_PCT   = 0.0005    // <0.05% range in last 1h = stale
const LONG_ADD_DROP_PCT = 0.05      // add to long when 5% below entry
const MAX_LADDER        = 3         // max short entries per coin
const PARTIAL_CLOSE_PCT = 0.25      // close 25% of long on stale signal
const SLIPPAGE          = 0.003     // 0.3% slippage for market orders

// ─── RUNTIME STATE ────────────────────────────────────────────────────────────
const shortState = {}  // coin → { entries: number }
const longState  = {}  // coin → { staleWatchStart: number|null, pendingEntry: boolean }

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`[${ts}] [${tag.padEnd(8)}] ${msg}`)
}

// ─── PRICE PRECISION ──────────────────────────────────────────────────────────
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
  const state      = await info.clearinghouseState({ user: ADDRESS })
  const acctVal    = parseFloat(state.marginSummary?.accountValue ?? 0)
  const withdrawable = parseFloat(state.withdrawable ?? 0)
  const positions  = state.assetPositions ?? []
  const totalPosVal = positions.reduce((s, p) => s + Math.abs(parseFloat(p.position.positionValue ?? 0)), 0)
  return { acctVal, withdrawable, positions, totalPosVal }
}

// ─── ORDER PLACEMENT ──────────────────────────────────────────────────────────

async function marketOrder({ coin, isBuy, sz, markPx, reduceOnly = false }) {
  const { index, szDecimals } = await getAssetInfo(coin)
  const limitPx = isBuy
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)

  await exchange.updateLeverage({ asset: index, isCross: true, leverage: 1 })

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

  log('ORDER', `${isBuy ? 'BUY ' : 'SELL'} ${roundSz(sz, szDecimals)} ${coin} @ ~$${roundPx(markPx)} (market IOC)`)
  return result
}

async function limitOrder({ coin, isBuy, sz, px, reduceOnly = false }) {
  const { index, szDecimals } = await getAssetInfo(coin)

  await exchange.updateLeverage({ asset: index, isCross: true, leverage: 1 })

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(px).toString(),
      s: roundSz(sz, szDecimals).toString(),
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

  // Short zone: price within SHORT_ZONE_PCT % of 7-day high
  const btcInShortZone = btc7dHigh && btcMid >= btc7dHigh * (1 - SHORT_ZONE_PCT)
  const spxInShortZone = spx7dHigh && spxMid >= spx7dHigh * (1 - SHORT_ZONE_PCT)

  // Long zone: price within LONG_ZONE_PCT % of 7-day low
  const btcInLongZone = btc7dLow && btcMid <= btc7dLow * (1 + LONG_ZONE_PCT)

  // BTC 4h pump detection for long partial close
  const btc4hPump = pctChange(btcCandles4h)

  log('MACRO', `BTC $${btcMid.toFixed(0)} | 7d-high $${btc7dHigh?.toFixed(0)} short-zone: ${btcInShortZone ? '✓' : 'no'} | 7d-low $${btc7dLow?.toFixed(0)} long-zone: ${btcInLongZone ? '✓' : 'no'} | 4h chg: ${(btc4hPump * 100).toFixed(2)}%`)
  log('MACRO', `SPX $${spxMid.toFixed(2)} | 7d-high $${spx7dHigh?.toFixed(2)} | zone: ${spxInShortZone ? '✓ YES (soft)' : 'no'}`)

  return { btcMid, spxMid, btc7dHigh, btc7dLow, spx7dHigh, btcInShortZone, btcInLongZone, spxInShortZone, btc4hPump }
}

// ─── SHORT SIDE ───────────────────────────────────────────────────────────────

async function runShortSide(macro, positions, acctVal, totalPosVal, allMids) {
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

    if (!shortState[coin]) shortState[coin] = { entries: 0 }

    // ── Add to losing short ───────────────────────────────────────────────────
    if (isShort) {
      if (shortState[coin].entries >= MAX_LADDER) {
        log('SHORT', `${coin} — max ladder (${MAX_LADDER}) reached, holding`)
        continue
      }
      const entryPx  = parseFloat(pos.position.entryPx ?? markPx)
      const isLosing = markPx > entryPx

      if (isLosing && totalPosVal / acctVal < MAX_CAP_PCT) {
        const slice = (acctVal * MAX_CAP_PCT) / SHORT_ASSETS.length
        const sz    = slice / markPx
        log('SHORT', `${coin} — adding to loss. Entry $${entryPx.toFixed(4)} → now $${markPx.toFixed(4)} (+${((markPx / entryPx - 1) * 100).toFixed(2)}%)`)
        try {
          await marketOrder({ coin, isBuy: false, sz, markPx })
          shortState[coin].entries++
        } catch (e) { log('ERROR', `Short add ${coin}: ${e.message}`) }
      }
      continue
    }

    // ── New short entry ───────────────────────────────────────────────────────
    if (totalPosVal / acctVal >= MAX_CAP_PCT) {
      log('SHORT', `Cap ${(MAX_CAP_PCT * 100).toFixed(0)}% used — skip ${coin}`)
      continue
    }

    // Check 24h pump on the garbage coin
    const coinCandles24h = await fetchCandles(coin, '1d', 24)
    const pump24h        = pctChange(coinCandles24h)

    if (pump24h < GARBAGE_PUMP_PCT) {
      log('SHORT', `${coin} up only ${(pump24h * 100).toFixed(1)}% in 24h (need ≥${GARBAGE_PUMP_PCT * 100}%) — skip`)
      continue
    }

    // S&P soft confirmation: +15% size if SPX also near 7d high
    const spxMult = macro.spxInShortZone ? 1.15 : 1.0
    const slice   = (acctVal * MAX_CAP_PCT) / SHORT_ASSETS.length * spxMult
    const sz      = slice / markPx

    log('SHORT', `${coin} NEW SHORT — pumped ${(pump24h * 100).toFixed(1)}% in 24h | BTC in zone | SPX: ${macro.spxInShortZone ? 'confirming (+15% size)' : 'neutral'}`)
    try {
      await marketOrder({ coin, isBuy: false, sz, markPx })
      shortState[coin].entries = 1
    } catch (e) { log('ERROR', `Short entry ${coin}: ${e.message}`) }
  }
}

// ─── LONG SIDE ────────────────────────────────────────────────────────────────

async function runLongSide(macro, positions, acctVal, totalPosVal, allMids) {
  if (!LONG_ASSETS.length) return

  for (const coin of LONG_ASSETS) {
    const markPx = parseFloat(allMids[coin] ?? 0)
    if (!markPx) continue

    const pos   = positions.find(p => p.position.coin === coin)
    const szi   = pos ? parseFloat(pos.position.szi ?? 0) : 0

    if (!longState[coin]) longState[coin] = { staleWatchStart: null, pendingEntry: false }

    // ── New long entry in long zone ───────────────────────────────────────────
    if (szi <= 0) {
      // If we placed an entry last tick but position hasn't confirmed yet, wait
      if (longState[coin].pendingEntry) {
        log('LONG', `${coin} — entry pending confirmation from exchange, skipping`)
        continue
      }
      if (!macro.btcInLongZone) {
        log('LONG', `${coin} — no position & BTC not in long zone — skipping`)
        continue
      }
      if (totalPosVal / acctVal >= MAX_CAP_PCT) {
        log('LONG', `Cap ${(MAX_CAP_PCT * 100).toFixed(0)}% used — skip ${coin}`)
        continue
      }
      const slice = (acctVal * MAX_CAP_PCT) / LONG_ASSETS.length
      const sz    = slice / markPx
      log('LONG', `${coin} NEW LONG — BTC near 7d low ($${macro.btc7dLow?.toFixed(0)}, now $${markPx.toFixed(2)}) | entering ${sz.toFixed(4)} coins`)
      try {
        await marketOrder({ coin, isBuy: true, sz, markPx })
        longState[coin].pendingEntry = true   // guard against double-entry next tick
      } catch (e) { log('ERROR', `Long entry ${coin}: ${e.message}`) }
      continue
    }

    // Position confirmed — clear pending flag
    longState[coin].pendingEntry = false

    const entryPx = parseFloat(pos.position.entryPx ?? markPx)

    // ── Add to losing long ────────────────────────────────────────────────────
    const dropFromEntry = (entryPx - markPx) / entryPx
    if (dropFromEntry >= LONG_ADD_DROP_PCT && totalPosVal / acctVal < MAX_CAP_PCT) {
      const slice = (acctVal * MAX_CAP_PCT) / LONG_ASSETS.length
      const sz    = slice / markPx
      log('LONG', `${coin} ADD — down ${(dropFromEntry * 100).toFixed(1)}% from entry $${entryPx.toFixed(4)} | adding ${sz.toFixed(4)} coins`)
      try {
        await marketOrder({ coin, isBuy: true, sz, markPx })
      } catch (e) { log('ERROR', `Long add ${coin}: ${e.message}`) }
      continue
    }

    // ── Partial close on BTC stale signal ─────────────────────────────────────
    // Step 1: BTC pumped ≥2% in last 4h
    if (macro.btc4hPump < BTC_PUMP_PCT) {
      longState[coin].staleWatchStart = null
      continue
    }

    // Step 2: BTC pumped — now watch the last 1h candle for stale
    const btc1hCandles = await fetchCandles(BTC_COIN, '1h', 1)
    const staleRange   = candleRange(btc1hCandles)
    const isStale      = staleRange <= STALE_RANGE_PCT

    if (!isStale) {
      if (!longState[coin].staleWatchStart) {
        longState[coin].staleWatchStart = Date.now()
        log('LONG', `${coin} — BTC pumped ${(macro.btc4hPump * 100).toFixed(2)}% in 4h, watching for stale...`)
      }
      continue
    }

    // Step 3: BTC is stale — partial close the long
    log('LONG', `${coin} PARTIAL CLOSE — BTC stale (range ${(staleRange * 100).toFixed(3)}% in 1h) | closing ${PARTIAL_CLOSE_PCT * 100}% of position`)
    const closeSz = Math.abs(szi) * PARTIAL_CLOSE_PCT
    try {
      await marketOrder({ coin, isBuy: false, sz: closeSz, markPx, reduceOnly: true })

      const pnlPct = ((markPx - entryPx) / entryPx * 100).toFixed(2)
      const pnlUsd = ((markPx - entryPx) * closeSz).toFixed(2)
      if (markPx > entryPx) {
        log('WIN', `${coin} partial close @ $${markPx.toFixed(4)} | entry $${entryPx.toFixed(4)} | +${pnlPct}% | ~$${pnlUsd} profit`)
      }

      // Place limit re-entry at original entry price
      log('LONG', `${coin} RE-ENTRY LIMIT — placing buy @ $${entryPx.toFixed(4)} for ${closeSz.toFixed(4)} coins`)
      await limitOrder({ coin, isBuy: true, sz: closeSz, px: entryPx })
    } catch (e) { log('ERROR', `Long partial close ${coin}: ${e.message}`) }

    longState[coin].staleWatchStart = null
  }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────

async function run() {
  log('START', '═'.repeat(60))
  log('START', `Insolvent Terminal — Strategy Manager`)
  log('START', `Address:   ${ADDRESS}`)
  log('START', `Long:      ${LONG_ASSETS.length  ? LONG_ASSETS.join(', ')  : '(none)'}`)
  log('START', `Short:     ${SHORT_ASSETS.length ? SHORT_ASSETS.join(', ') : '(none)'}`)
  log('START', `Cap limit: ${MAX_CAP_PCT * 100}% | Short zone: ${SHORT_ZONE_PCT * 100}% from 7d high | Long zone: ${LONG_ZONE_PCT * 100}% from 7d low | Interval: ${INTERVAL_MS / 60000}min`)
  log('START', '═'.repeat(60))

  // Pre-load asset index cache
  await getAssetInfo(BTC_COIN).catch(() => {})

  while (true) {
    log('RUN', '─'.repeat(60))

    try {
      const allMids = await info.allMids()

      const [macro, account] = await Promise.all([
        getMacroSignals(allMids),
        getAccount(),
      ])

      const { acctVal, withdrawable, positions, totalPosVal } = account
      const capUsed = acctVal > 0 ? totalPosVal / acctVal : 0

      log('ACCT', `Value $${acctVal.toFixed(2)} | Available $${withdrawable.toFixed(2)} | Capital used ${(capUsed * 100).toFixed(1)}% / ${(MAX_CAP_PCT * 100).toFixed(0)}%`)

      await runShortSide(macro, positions, acctVal, totalPosVal, allMids)
      await runLongSide(macro, positions, acctVal, totalPosVal, allMids)

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
