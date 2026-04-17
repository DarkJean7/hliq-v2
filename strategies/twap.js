#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — TWAP
 *
 * Splits a total order into equal slices and executes them
 * evenly over a specified duration (time-weighted average price).
 *
 * Usage:
 *   node strategies/twap.js \
 *     --wallet 0xYOUR_AGENT_KEY \
 *     --coin SOL \
 *     --side long \
 *     --total 1000 \
 *     --duration 60 \
 *     --slices 12 \
 *     --leverage 1
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:          { type: 'string' },
    coin:            { type: 'string', default: 'SOL'  },
    side:            { type: 'string', default: 'long' },
    total:           { type: 'string', default: '1000' },   // total USD to execute
    duration:        { type: 'string', default: '60'   },   // total duration in minutes
    slices:          { type: 'string', default: '12'   },   // number of equal sub-orders
    'max-position':  { type: 'string', default: '0'    },   // USD, 0 = unlimited
    leverage:        { type: 'string', default: '1'    },
  },
  allowPositionals: false,
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

const COIN        = args.coin.toUpperCase()
const IS_BUY      = args.side.toLowerCase() !== 'short'
const TOTAL_USD   = parseFloat(args.total)
const SLICES      = parseInt(args.slices)
const DURATION_MS = parseInt(args.duration) * 60 * 1000
const LEVERAGE    = parseInt(args.leverage)
const SLICE_USD    = TOTAL_USD / SLICES
const INTERVAL_MS  = DURATION_MS / SLICES
const MAX_POSITION = parseFloat(args['max-position'])  // USD, 0 = unlimited
const SLIPPAGE     = 0.003

if (SLICES < 1)    { console.error('ERROR: --slices must be ≥ 1'); process.exit(1) }

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
  const state = await info.clearinghouseState({ user: etherWallet.address })
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
}

// ─── SLICE ORDER ──────────────────────────────────────────────────────────────
async function placeSlice(markPx) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = IS_BUY
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)
  const sz = SLICE_USD / markPx

  await exchange.updateLeverage({ asset: index, isCross: true, leverage: LEVERAGE })

  const result = await exchange.order({
    orders: [{
      a: index,
      b: IS_BUY,
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

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `TWAP`)
  log('START', `Coin:     ${COIN}  |  Side: ${IS_BUY ? 'LONG' : 'SHORT'}`)
  log('START', `Total:    $${TOTAL_USD}  |  ${SLICES} slices × $${SLICE_USD.toFixed(2)}`)
  log('START', `Duration: ${DURATION_MS / 60000} min  |  Interval: ${(INTERVAL_MS / 1000).toFixed(0)}s  |  Leverage: ${LEVERAGE}x`)
  log('START', '═'.repeat(60))

  await getAssetInfo(COIN)
  await auditPosition()

  const filledPrices = []
  let totalFilled    = 0
  let errors         = 0

  for (let i = 1; i <= SLICES; i++) {
    try {
      const allMids = await info.allMids()
      const markPx  = parseFloat(allMids[COIN] ?? 0)
      if (!markPx) throw new Error(`No price for ${COIN}`)

      // Max position guard
      if (MAX_POSITION > 0) {
        const acctState = await info.clearinghouseState({ user: etherWallet.address })
        const pos       = (acctState.assetPositions ?? []).find(p => p.position.coin === COIN)
        const posVal    = pos ? Math.abs(parseFloat(pos.position.positionValue ?? 0)) : 0
        if (posVal >= MAX_POSITION) {
          log('SKIP', `Slice ${i} — position $${posVal.toFixed(2)} ≥ max $${MAX_POSITION} — stopping TWAP`)
          break
        }
      }

      const sz = await placeSlice(markPx)
      filledPrices.push(markPx)
      totalFilled += sz

      const pctDone = ((i / SLICES) * 100).toFixed(0)
      log('SLICE', `${i}/${SLICES} (${pctDone}%)  ${IS_BUY ? 'BUY ' : 'SELL'} ${sz} ${COIN} @ ~$${markPx.toFixed(2)}`)

    } catch (e) {
      errors++
      log('ERROR', `Slice ${i}: ${e.message}`)
    }

    if (i < SLICES) {
      log('WAIT', `Next slice in ${(INTERVAL_MS / 1000).toFixed(0)}s...`)
      await sleep(INTERVAL_MS)
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const avgPx = filledPrices.length
    ? (filledPrices.reduce((a, b) => a + b, 0) / filledPrices.length).toFixed(2)
    : 'N/A'

  log('DONE', '═'.repeat(60))
  log('DONE', `TWAP complete`)
  log('DONE', `Filled:   ${filledPrices.length}/${SLICES} slices  (${errors} errors)`)
  log('DONE', `Total sz: ${totalFilled.toFixed(6)} ${COIN}`)
  log('DONE', `Avg px:   $${avgPx}`)
  log('DONE', '═'.repeat(60))
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
