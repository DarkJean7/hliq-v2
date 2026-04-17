#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — DCA Bot
 *
 * Dollar-cost averages into a position by placing market orders
 * of fixed USD size on a fixed time interval.
 *
 * Usage:
 *   node strategies/dca.js \
 *     --wallet 0xYOUR_AGENT_KEY \
 *     --coin BTC \
 *     --side long \
 *     --size 100 \
 *     --interval 60 \
 *     --max-orders 10 \
 *     --leverage 1
 *
 * Drop mode (buy on dip):
 *   node strategies/dca.js ... --mode drop --drop-pct 2
 *   — Only buys when price drops ≥ drop-pct % from last buy price.
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:       { type: 'string' },
    coin:         { type: 'string', default: 'BTC'  },
    side:         { type: 'string', default: 'long' },
    size:         { type: 'string', default: '100'  },   // USD per order
    interval:     { type: 'string', default: '60'   },   // minutes between orders
    'max-orders':    { type: 'string', default: '10'  },   // 0 = unlimited
    'max-position':  { type: 'string', default: '0'   },   // USD, 0 = unlimited
    leverage:        { type: 'string', default: '1'   },
    mode:            { type: 'string', default: 'time' },  // 'time' | 'drop'
    'drop-pct':      { type: 'string', default: '2'   },   // % drop from last buy
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
const ORDER_USD   = parseFloat(args.size)
const INTERVAL_MS = parseInt(args.interval) * 60 * 1000
const MAX_ORDERS    = parseInt(args['max-orders'])     // 0 = unlimited
const MAX_POSITION  = parseFloat(args['max-position']) // USD, 0 = unlimited
const LEVERAGE      = parseInt(args.leverage)
const MODE          = args.mode.toLowerCase()          // 'time' | 'drop'
const DROP_PCT      = parseFloat(args['drop-pct'])     // % drop to trigger buy
const SLIPPAGE    = 0.003

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

// ─── ORDER ────────────────────────────────────────────────────────────────────
async function placeOrder(markPx) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  const limitPx = IS_BUY
    ? markPx * (1 + SLIPPAGE)
    : markPx * (1 - SLIPPAGE)
  const sz = ORDER_USD / markPx

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

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
async function run() {
  log('START', '═'.repeat(60))
  log('START', `DCA Bot`)
  log('START', `Coin:      ${COIN}  |  Side: ${IS_BUY ? 'LONG' : 'SHORT'}`)
  log('START', `Size:      $${ORDER_USD} per order`)
  if (MODE === 'drop') {
    log('START', `Mode:      DROP — buy every ${DROP_PCT}% dip from last buy`)
  } else {
    log('START', `Interval:  ${INTERVAL_MS / 60000} min  |  Max orders: ${MAX_ORDERS || 'unlimited'}`)
  }
  log('START', `Leverage: ${LEVERAGE}x  |  Max orders: ${MAX_ORDERS || 'unlimited'}`)
  log('START', '═'.repeat(60))

  await getAssetInfo(COIN)
  await auditPosition()

  let count      = 0
  let lastBuyPx  = 0   // used in drop mode

  // In drop mode, seed lastBuyPx from existing position entry price
  if (MODE === 'drop') {
    const acctState = await info.clearinghouseState({ user: etherWallet.address })
    const pos = (acctState.assetPositions ?? []).find(p => p.position.coin === COIN)
    if (pos && parseFloat(pos.position.szi ?? 0) !== 0) {
      lastBuyPx = parseFloat(pos.position.entryPx ?? 0)
      if (lastBuyPx > 0) log('DROP', `Seeding lastBuyPx from open position: $${lastBuyPx.toFixed(4)}`)
    }
  }

  while (true) {
    if (MAX_ORDERS > 0 && count >= MAX_ORDERS) {
      log('DONE', `Placed ${count} orders — max-orders reached. Exiting.`)
      process.exit(0)
    }

    try {
      const allMids = await info.allMids()
      const markPx  = parseFloat(allMids[COIN] ?? 0)
      if (!markPx) throw new Error(`No price for ${COIN}`)

      // Drop mode: only buy when price dropped ≥ DROP_PCT % from last buy
      if (MODE === 'drop') {
        if (lastBuyPx > 0) {
          const dropFromLast = (lastBuyPx - markPx) / lastBuyPx * 100
          if (dropFromLast < DROP_PCT) {
            log('WAIT', `${COIN} @ $${markPx.toFixed(4)} — need ${DROP_PCT}% dip from last buy $${lastBuyPx.toFixed(4)} (current: ${dropFromLast.toFixed(2)}% drop)`)
            await sleep(INTERVAL_MS)
            continue
          }
        } else {
          log('DROP', `No lastBuyPx yet — placing first order at $${markPx.toFixed(4)}`)
        }
      }

      // Max position guard
      if (MAX_POSITION > 0) {
        const acctState = await info.clearinghouseState({ user: etherWallet.address })
        const pos       = (acctState.assetPositions ?? []).find(p => p.position.coin === COIN)
        const posVal    = pos ? Math.abs(parseFloat(pos.position.positionValue ?? 0)) : 0
        if (posVal >= MAX_POSITION) {
          log('SKIP', `Position $${posVal.toFixed(2)} ≥ max $${MAX_POSITION} — waiting`)
          log('WAIT', `Next check in ${INTERVAL_MS / 60000} min...`)
          await sleep(INTERVAL_MS)
          continue
        }
      }

      const sz = await placeOrder(markPx)
      count++
      lastBuyPx = markPx  // update reference for next drop check

      const remaining = MAX_ORDERS > 0 ? `${count}/${MAX_ORDERS}` : count
      log('ORDER', `#${remaining} ${IS_BUY ? 'BUY ' : 'SELL'} ${sz} ${COIN} @ ~$${markPx.toFixed(2)} ($${ORDER_USD})${MODE === 'drop' ? ` | next dip target: $${(markPx * (1 - DROP_PCT / 100)).toFixed(4)}` : ''}`)

    } catch (e) {
      log('ERROR', e.message)
    }

    if (MAX_ORDERS > 0 && count >= MAX_ORDERS) {
      log('DONE', `All ${MAX_ORDERS} orders placed. Exiting.`)
      process.exit(0)
    }

    log('WAIT', `Next check in ${INTERVAL_MS / 60000} min...`)
    await sleep(INTERVAL_MS)
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
