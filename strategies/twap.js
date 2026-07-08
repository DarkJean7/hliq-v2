#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — TWAP
 *
 * Splits a total USD amount into equal slices executed evenly over a duration
 * (time-weighted average price). Misses and partial fills roll into the
 * remaining slices so the full total is still executed.
 *
 * Usage:
 *   node strategies/twap.js \
 *     --wallet 0xAGENT_KEY [--address 0xMASTER] \
 *     --coin SOL --side long \
 *     --total 1000 --duration 60 --slices 12 --leverage 1
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import './_pause.js'   // installs SIGUSR1/2 handlers so pause/resume can't kill this process

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:         { type: 'string' },
    address:        { type: 'string' },
    coin:           { type: 'string', default: 'SOL'  },
    side:           { type: 'string', default: 'long' },
    total:          { type: 'string', default: '1000' },   // total USD to execute
    duration:       { type: 'string', default: '60'   },   // total duration in minutes
    slices:         { type: 'string', default: '12'   },   // number of equal sub-orders
    'max-position': { type: 'string', default: '0'    },   // USD, 0 = unlimited
    leverage:       { type: 'string', default: '1'    },
  },
  allowPositionals: false,
  strict: false,
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

const COIN         = args.coin.toUpperCase()
const IS_BUY       = args.side.toLowerCase() !== 'short'
const TOTAL_USD    = parseFloat(args.total)
const SLICES       = parseInt(args.slices)
const DURATION_MS  = parseInt(args.duration) * 60 * 1000
const LEVERAGE     = parseInt(args.leverage)
const INTERVAL_MS  = DURATION_MS / SLICES
const MAX_POSITION = parseFloat(args['max-position'])  // USD, 0 = unlimited
const SLIPPAGE     = 0.003
const HL_MIN_ORDER = 10

if (SLICES < 1) { console.error('ERROR: --slices must be ≥ 1'); process.exit(1) }

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

// ─── PRECISION ────────────────────────────────────────────────────────────────
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
  const state = await info.clearinghouseState({ user: QUERY_ADDR })
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
// Returns { filledSz, avgPx } — filledSz is 0 if the IOC missed entirely.
async function placeSlice(markPx, sliceUsd) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = IS_BUY
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)
  const sz = roundSz(sliceUsd / markPx, szDecimals, roundPx(markPx))

  const result = await exchange.order({
    orders: [{
      a: index,
      b: IS_BUY,
      p: roundPx(limitPx).toString(),
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

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `TWAP`)
  log('START', `Coin:     ${COIN}  |  Side: ${IS_BUY ? 'LONG' : 'SHORT'}`)
  log('START', `Total:    $${TOTAL_USD}  |  ${SLICES} slices × ~$${(TOTAL_USD / SLICES).toFixed(2)}`)
  log('START', `Duration: ${DURATION_MS / 60000} min  |  Interval: ${(INTERVAL_MS / 1000).toFixed(0)}s  |  Leverage: ${LEVERAGE}x  |  querying ${QUERY_ADDR}`)
  log('START', '═'.repeat(60))

  if (TOTAL_USD / SLICES < HL_MIN_ORDER) {
    log('ERROR', `Slice size $${(TOTAL_USD / SLICES).toFixed(2)} is below HL's $${HL_MIN_ORDER} minimum. Reduce --slices or increase --total.`)
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

  let remainingUsd = TOTAL_USD   // unexecuted notional rolls into later slices
  let totalFilled  = 0           // coin units actually filled
  let totalNotional = 0          // USD actually filled (for true avg price)
  let fills        = 0
  let errors       = 0

  for (let i = 1; i <= SLICES; i++) {
    const slicesLeft = SLICES - i + 1
    const sliceUsd   = remainingUsd / slicesLeft

    try {
      const allMids = await info.allMids()
      const markPx  = parseFloat(allMids[COIN] ?? 0)
      if (!markPx) throw new Error(`No price for ${COIN}`)

      // Max position guard (reads the master wallet)
      if (MAX_POSITION > 0) {
        const acctState = await info.clearinghouseState({ user: QUERY_ADDR })
        const pos       = (acctState.assetPositions ?? []).find(p => p.position.coin === COIN)
        const posVal    = pos ? Math.abs(parseFloat(pos.position.positionValue ?? 0)) : 0
        if (posVal >= MAX_POSITION) {
          log('SKIP', `Slice ${i} — position $${posVal.toFixed(2)} ≥ max $${MAX_POSITION} — stopping TWAP`)
          break
        }
      }

      if (sliceUsd < HL_MIN_ORDER) {
        log('DONE', `Remaining $${remainingUsd.toFixed(2)} below HL minimum — stopping`)
        break
      }

      const { filledSz, avgPx } = await placeSlice(markPx, sliceUsd)

      if (filledSz > 0) {
        const notional = filledSz * (avgPx || markPx)
        fills++
        totalFilled   += filledSz
        totalNotional += notional
        remainingUsd   = Math.max(0, remainingUsd - notional)
        const pctDone  = ((TOTAL_USD - remainingUsd) / TOTAL_USD * 100).toFixed(0)
        log('SLICE', `${i}/${SLICES} (${pctDone}% of total)  ${IS_BUY ? 'BUY ' : 'SELL'} ${filledSz} ${COIN} @ $${(avgPx || markPx).toFixed(4)} ($${notional.toFixed(2)})`)
      } else {
        log('MISS', `Slice ${i} IOC did not fill — $${sliceUsd.toFixed(2)} rolls into remaining slices`)
      }

    } catch (e) {
      errors++
      log('ERROR', `Slice ${i}: ${e.message} — notional rolls into remaining slices`)
    }

    if (remainingUsd <= 0.01) break

    if (i < SLICES) {
      log('WAIT', `Next slice in ${(INTERVAL_MS / 1000).toFixed(0)}s...`)
      await sleep(INTERVAL_MS)
    }
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const avgPx = totalFilled > 0 ? (totalNotional / totalFilled).toFixed(4) : 'N/A'

  log('DONE', '═'.repeat(60))
  log('DONE', `TWAP complete`)
  log('DONE', `Executed: $${totalNotional.toFixed(2)} / $${TOTAL_USD}  (${fills} fills, ${errors} errors)`)
  log('DONE', `Total sz: ${totalFilled.toFixed(6)} ${COIN}`)
  log('DONE', `Avg px:   $${avgPx}`)
  log('DONE', '═'.repeat(60))
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
