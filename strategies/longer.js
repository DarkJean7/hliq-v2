#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Longer Bot
 *
 * Systematically longs a list of coins based on a configurable trigger.
 * Manages stop-loss and take-profit for each position independently.
 * Logs [WIN] when a trade closes in profit.
 *
 * Usage:
 *   node strategies/longer.js \
 *     --wallet 0xYOUR_AGENT_KEY \
 *     --coins BTC,ETH,SOL \
 *     --size 100 \
 *     --leverage 2 \
 *     --take-profit-pct 3 \
 *     --stop-loss-pct 2 \
 *     --trigger dump \
 *     --dump-pct 5 \
 *     --interval 5
 *
 * Triggers:
 *   always  — long everything in the list that doesn't have an open position
 *   dump    — long coins that dumped ≥ --dump-pct % over --dump-window
 *             dump-window: 1h | 4h | 1d | 3d | 1w  (default: 1d)
 *             e.g. --trigger dump --dump-pct 7 --dump-window 1w  → long if down ≥7% this week
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:            { type: 'string' },
    coins:             { type: 'string', default: 'BTC'  },
    size:              { type: 'string', default: '100'  },  // USD per position
    leverage:          { type: 'string', default: '2'    },
    'take-profit-pct': { type: 'string', default: '3'    },  // % from entry
    'stop-loss-pct':   { type: 'string', default: '2'    },  // % from entry, 0 = disabled
    trigger:           { type: 'string', default: 'always' }, // 'always' | 'dump'
    'dump-pct':        { type: 'string', default: '5'    },  // % drop to trigger long
    'dump-window':     { type: 'string', default: '1d'   },  // 1h | 4h | 1d | 3d | 1w
    interval:          { type: 'string', default: '5'    },  // minutes between checks
  },
  allowPositionals: false,
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

const COINS       = args.coins.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
const SIZE_USD    = parseFloat(args.size)
const LEVERAGE    = parseInt(args.leverage)
const TP_PCT      = parseFloat(args['take-profit-pct']) / 100
const SL_PCT      = parseFloat(args['stop-loss-pct'])   / 100
const TRIGGER     = args.trigger.toLowerCase()
const DUMP_PCT    = parseFloat(args['dump-pct']) / 100
const DUMP_WINDOW = args['dump-window'].toLowerCase()
const INTERVAL_MS = parseInt(args.interval) * 60 * 1000
const SLIPPAGE    = 0.003

// ─── DUMP WINDOW CONFIG ───────────────────────────────────────────────────────
const WINDOW_MAP = {
  '1h':  { candleInterval: '5m',  lookbackMs:  1 * 60 * 60 * 1000 },
  '4h':  { candleInterval: '15m', lookbackMs:  4 * 60 * 60 * 1000 },
  '1d':  { candleInterval: '1h',  lookbackMs: 24 * 60 * 60 * 1000 },
  '3d':  { candleInterval: '4h',  lookbackMs:  3 * 24 * 60 * 60 * 1000 },
  '1w':  { candleInterval: '1d',  lookbackMs:  7 * 24 * 60 * 60 * 1000 },
}
if (TRIGGER === 'dump' && !WINDOW_MAP[DUMP_WINDOW]) {
  console.error(`ERROR: --dump-window must be one of: ${Object.keys(WINDOW_MAP).join(', ')}`)
  process.exit(1)
}

if (COINS.length === 0) {
  console.error('ERROR: --coins must include at least one coin')
  process.exit(1)
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })

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

// ─── PLACE MARKET ORDER ───────────────────────────────────────────────────────
async function placeMarketOrder(coin, isBuy, sizeUsd, markPx) {
  const { index, szDecimals } = await getAssetInfo(coin)
  const limitPx = isBuy
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)
  const sz = sizeUsd / markPx

  await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(limitPx).toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: false,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))

  return roundSz(sz, szDecimals)
}

// ─── CLOSE POSITION (reduce-only) ─────────────────────────────────────────────
async function closePosition(coin, szi, markPx) {
  const { index, szDecimals } = await getAssetInfo(coin)
  const isBuy  = szi < 0   // short position → close with buy
  const absSzi = Math.abs(szi)
  const limitPx = isBuy
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)

  const result = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(limitPx).toString(),
      s: roundSz(absSzi, szDecimals).toString(),
      r: true,   // reduce-only
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))
}

// ─── GET PRICE CHANGE OVER WINDOW (for dump trigger) ─────────────────────────
async function getPriceChangePct(coin) {
  try {
    const { candleInterval, lookbackMs } = WINDOW_MAP[DUMP_WINDOW]
    const now     = Date.now()
    const from    = now - lookbackMs
    const candles = await info.candleSnapshot({
      coin,
      interval:  candleInterval,
      startTime: from,
      endTime:   now,
    })
    if (!candles || candles.length === 0) return 0
    const openPx = parseFloat(candles[0].o ?? 0)
    const lastPx = parseFloat(candles[candles.length - 1].c ?? 0)
    if (!openPx) return 0
    return (lastPx - openPx) / openPx
  } catch {
    return 0
  }
}

// ─── AUDIT ON STARTUP ─────────────────────────────────────────────────────────
async function auditPositions() {
  const state = await info.clearinghouseState({ user: etherWallet.address })
  for (const coin of COINS) {
    const pos = (state.assetPositions ?? []).find(p => p.position.coin === coin)
    if (!pos || parseFloat(pos.position.szi ?? 0) === 0) {
      log('AUDIT', `${coin} — no open position`)
      continue
    }
    const p    = pos.position
    const szi  = parseFloat(p.szi)
    const side = szi > 0 ? 'LONG' : 'SHORT'
    const entry = parseFloat(p.entryPx ?? 0)
    const upnl  = parseFloat(p.unrealizedPnl ?? 0)
    log('AUDIT', `${coin} ${side} | sz=${Math.abs(szi).toFixed(4)} | entry $${entry.toFixed(4)} | uPnL ${upnl >= 0 ? '+' : ''}${upnl.toFixed(2)}`)
  }
}

// ─── MAIN TICK ────────────────────────────────────────────────────────────────
async function tick() {
  const allMids   = await info.allMids()
  const acctState = await info.clearinghouseState({ user: etherWallet.address })

  for (const coin of COINS) {
    try {
      const markPx = parseFloat(allMids[coin] ?? 0)
      if (!markPx) { log('SKIP', `${coin} — no price`); continue }

      const posObj  = (acctState.assetPositions ?? []).find(p => p.position.coin === coin)
      const szi     = parseFloat(posObj?.position?.szi ?? 0)
      const entryPx = parseFloat(posObj?.position?.entryPx  ?? 0)
      const upnl    = parseFloat(posObj?.position?.unrealizedPnl ?? 0)

      // ── Manage existing LONG position ────────────────────────────────────
      if (szi > 0 && entryPx > 0) {
        const gainPct = (markPx - entryPx) / entryPx   // positive = price rose = profit for long

        // Take profit
        if (TP_PCT > 0 && gainPct >= TP_PCT) {
          log('TP', `${coin} take-profit hit — entry $${entryPx.toFixed(4)} → now $${markPx.toFixed(4)} (+${(gainPct * 100).toFixed(2)}%)`)
          await closePosition(coin, szi, markPx)
          log('WIN', `${coin} long closed TP | profit ~$${upnl.toFixed(2)} | entry $${entryPx.toFixed(4)} → $${markPx.toFixed(4)}`)
          continue
        }

        // Stop loss
        if (SL_PCT > 0 && gainPct <= -SL_PCT) {
          const lossPct = -gainPct * 100
          log('SL', `${coin} stop-loss hit — entry $${entryPx.toFixed(4)} → now $${markPx.toFixed(4)} (-${lossPct.toFixed(2)}%)`)
          await closePosition(coin, szi, markPx)
          log('CLOSE', `${coin} long stopped out | loss ~$${Math.abs(upnl).toFixed(2)}`)
          continue
        }

        log('HOLD', `${coin} LONG @ $${entryPx.toFixed(4)} | now $${markPx.toFixed(4)} | uPnL ${upnl >= 0 ? '+' : ''}$${upnl.toFixed(2)} | TP in ${((TP_PCT * 100) - gainPct * 100).toFixed(2)}%`)
        continue
      }

      // ── Skip if already short (unexpected for this bot) ──────────────────
      if (szi < 0) {
        log('SKIP', `${coin} — SHORT position open (not managed by Longer). Skipping.`)
        continue
      }

      // ── Check trigger to enter a long ────────────────────────────────────
      if (TRIGGER === 'dump') {
        const changePct = await getPriceChangePct(coin)
        if (changePct > -DUMP_PCT) {
          log('WAIT', `${coin} — ${DUMP_WINDOW} change: ${(changePct * 100).toFixed(2)}% — need ≤-${(DUMP_PCT * 100).toFixed(2)}%`)
          continue
        }
        log('TRIGGER', `${coin} down ${(Math.abs(changePct) * 100).toFixed(2)}% over ${DUMP_WINDOW} — entering long`)
      }

      // ── Enter long ───────────────────────────────────────────────────────
      const sz = await placeMarketOrder(coin, true, SIZE_USD, markPx)
      log('LONG', `${coin} longed ${sz} @ ~$${markPx.toFixed(4)} ($${SIZE_USD})`)

    } catch (e) {
      log('ERROR', `${coin} — ${e.message}`)
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `Longer Bot`)
  log('START', `Coins:     ${COINS.join(', ')}`)
  log('START', `Size:      $${SIZE_USD} | Leverage: ${LEVERAGE}x`)
  log('START', `Trigger:   ${TRIGGER}${TRIGGER === 'dump' ? ` (≥${(DUMP_PCT * 100).toFixed(1)}% drop over ${DUMP_WINDOW})` : ''}`)
  log('START', `TP: ${(TP_PCT * 100).toFixed(1)}%  |  SL: ${SL_PCT > 0 ? (SL_PCT * 100).toFixed(1) + '%' : 'disabled'}`)
  log('START', `Interval:  ${INTERVAL_MS / 60000} min`)
  log('START', '═'.repeat(60))

  for (const coin of COINS) await getAssetInfo(coin)
  await auditPositions()

  while (true) {
    try {
      await tick()
    } catch (e) {
      log('ERROR', `Tick failed: ${e.message}`)
    }
    log('WAIT', `Next cycle in ${INTERVAL_MS / 60000} min...`)
    await sleep(INTERVAL_MS)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
