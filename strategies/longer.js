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
 *     --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --coins BTC,ETH,SOL --size 100 --leverage 2 \
 *     --take-profit-pct 3 --stop-loss-pct 2 \
 *     --trigger dump --dump-pct 5 --dump-window 1d --interval 5
 *
 * Triggers:
 *   always  — long everything in the list that doesn't have an open position
 *   dump    — long coins that dumped ≥ --dump-pct % over --dump-window
 *             dump-window: 1h | 4h | 1d | 3d | 1w  (default: 1d)
 *
 * After a stop-loss exit, the coin is on cooldown (--cooldown minutes,
 * default 60) before a new entry is allowed — prevents stop/re-enter loops.
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused } from './_pause.js'
import { botCloid } from '../src/cloid.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:            { type: 'string' },
    address:           { type: 'string' },
    coins:             { type: 'string', default: 'BTC'  },
    size:              { type: 'string', default: '100'  },  // USD per position
    leverage:          { type: 'string', default: '2'    },
    'take-profit-pct': { type: 'string', default: '3'    },  // % from entry
    'stop-loss-pct':   { type: 'string', default: '2'    },  // % from entry, 0 = disabled
    trigger:           { type: 'string', default: 'always' }, // 'always' | 'dump'
    'dump-pct':        { type: 'string', default: '5'    },  // % drop to trigger long
    'dump-window':     { type: 'string', default: '1d'   },  // 1h | 4h | 1d | 3d | 1w
    interval:          { type: 'string', default: '5'    },  // minutes between checks
    cooldown:          { type: 'string', default: '60'   },  // minutes after stop-loss before re-entry
  },
  allowPositionals: false,
  strict: false,
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
const INTERVAL_MS = Math.max(1, parseInt(args.interval) || 5) * 60 * 1000
const COOLDOWN_MS = Math.max(0, parseInt(args.cooldown) || 0) * 60 * 1000
const SLIPPAGE    = 0.003
const HL_MIN_ORDER = 10

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
const QUERY_ADDR  = args.address ?? etherWallet.address   // master wallet for reads

// ─── STATE ────────────────────────────────────────────────────────────────────
const cooldownUntil = new Map()   // coin → timestamp before which no re-entry

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

// ─── ORDERS — both return { filledSz, avgPx }; filledSz 0 = IOC missed ────────
async function placeMarketOrder(coin, isBuy, sizeUsd, markPx, reduceOnly = false, szOverride = null) {
  const { index, szDecimals } = await getAssetInfo(coin)
  const limitPx = isBuy
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)
  const sz = szOverride ?? roundSz(sizeUsd / markPx, szDecimals, roundPx(markPx))

  const result = await exchange.order({
    orders: [{
      c: botCloid(process.env.HLIQ_BOT),
      a: index,
      b: isBuy,
      p: roundPx(limitPx, szDecimals).toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: reduceOnly,
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

async function closePosition(coin, szi, markPx) {
  return placeMarketOrder(coin, szi < 0, 0, markPx, true, Math.abs(szi))
}

// ─── GET PRICE CHANGE OVER WINDOW (for dump trigger) ─────────────────────────
async function getPriceChangePct(coin) {
  try {
    const { candleInterval, lookbackMs } = WINDOW_MAP[DUMP_WINDOW]
    const now     = Date.now()
    const candles = await info.candleSnapshot({
      coin,
      interval:  candleInterval,
      startTime: now - lookbackMs,
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
  const state = await info.clearinghouseState({ user: QUERY_ADDR })
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
  const acctState = await info.clearinghouseState({ user: QUERY_ADDR })

  for (const coin of COINS) {
    try {
      const markPx = parseFloat(allMids[coin] ?? 0)
      if (!markPx) { log('SKIP', `${coin} — no price`); continue }

      const posObj  = (acctState.assetPositions ?? []).find(p => p.position.coin === coin)
      const szi     = parseFloat(posObj?.position?.szi ?? 0)
      const entryPx = parseFloat(posObj?.position?.entryPx ?? 0)
      const upnl    = parseFloat(posObj?.position?.unrealizedPnl ?? 0)

      // ── Manage existing LONG position ────────────────────────────────────
      if (szi > 0 && entryPx > 0) {
        const gainPct = (markPx - entryPx) / entryPx

        // Take profit
        if (TP_PCT > 0 && gainPct >= TP_PCT) {
          log('TP', `${coin} take-profit hit — entry $${entryPx.toFixed(4)} → now $${markPx.toFixed(4)} (+${(gainPct * 100).toFixed(2)}%)`)
          const { filledSz, avgPx } = await closePosition(coin, szi, markPx)
          if (filledSz > 0) {
            const exitPx = avgPx || markPx
            const profit = ((exitPx - entryPx) * filledSz).toFixed(2)
            log('WIN', `${coin} long closed TP | profit ~$${profit} | entry $${entryPx.toFixed(4)} → $${exitPx.toFixed(4)}`)
          } else {
            log('WARN', `${coin} TP close did not fill — retrying next cycle`)
          }
          continue
        }

        // Stop loss
        if (SL_PCT > 0 && gainPct <= -SL_PCT) {
          log('SL', `${coin} stop-loss hit — entry $${entryPx.toFixed(4)} → now $${markPx.toFixed(4)} (${(gainPct * 100).toFixed(2)}%)`)
          const { filledSz } = await closePosition(coin, szi, markPx)
          if (filledSz > 0) {
            log('CLOSE', `${coin} long stopped out | loss ~$${Math.abs(upnl).toFixed(2)}`)
            if (COOLDOWN_MS > 0) {
              cooldownUntil.set(coin, Date.now() + COOLDOWN_MS)
              log('COOLDOWN', `${coin} — no re-entry for ${COOLDOWN_MS / 60000} min`)
            }
          } else {
            log('WARN', `${coin} SL close did not fill — retrying next cycle`)
          }
          continue
        }

        log('HOLD', `${coin} LONG @ $${entryPx.toFixed(4)} | now $${markPx.toFixed(4)} | uPnL ${upnl >= 0 ? '+' : ''}$${upnl.toFixed(2)} | TP in ${((TP_PCT - gainPct) * 100).toFixed(2)}%`)
        continue
      }

      // ── Skip if already short (unexpected for this bot) ──────────────────
      if (szi < 0) {
        log('SKIP', `${coin} — SHORT position open (not managed by Longer). Skipping.`)
        continue
      }

      // ── Cooldown after a stop-loss exit ──────────────────────────────────
      const cdUntil = cooldownUntil.get(coin) ?? 0
      if (Date.now() < cdUntil) {
        log('WAIT', `${coin} — cooling down after stop-loss (${Math.ceil((cdUntil - Date.now()) / 60000)} min left)`)
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
      const { filledSz, avgPx } = await placeMarketOrder(coin, true, SIZE_USD, markPx)
      if (filledSz > 0) {
        log('LONG', `${coin} longed ${filledSz} @ $${(avgPx || markPx).toFixed(4)} (~$${SIZE_USD})`)
      } else {
        log('MISS', `${coin} entry IOC did not fill — retrying next cycle`)
      }

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
  log('START', `Size:      $${SIZE_USD} | Leverage: ${LEVERAGE}x  |  querying ${QUERY_ADDR}`)
  log('START', `Trigger:   ${TRIGGER}${TRIGGER === 'dump' ? ` (≥${(DUMP_PCT * 100).toFixed(1)}% drop over ${DUMP_WINDOW})` : ''}`)
  log('START', `TP: ${(TP_PCT * 100).toFixed(1)}%  |  SL: ${SL_PCT > 0 ? (SL_PCT * 100).toFixed(1) + '%' : 'disabled'}  |  SL cooldown: ${COOLDOWN_MS / 60000} min`)
  log('START', `Interval:  ${INTERVAL_MS / 60000} min`)
  log('START', '═'.repeat(60))

  if (SIZE_USD < HL_MIN_ORDER) {
    log('ERROR', `Size $${SIZE_USD} is below HL's $${HL_MIN_ORDER} minimum. Increase --size.`)
    process.exit(1)
  }

  for (const coin of COINS) {
    const { index } = await getAssetInfo(coin)
    try {
      await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })
    } catch (e) {
      log('WARN', `${coin}: could not set leverage: ${e.message}`)
    }
  }
  log('INIT', `Leverage set to ${LEVERAGE}x cross for ${COINS.length} coin(s)`)

  await auditPositions()

  while (true) {
    if (isPaused()) { await sleep(INTERVAL_MS); continue }
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
