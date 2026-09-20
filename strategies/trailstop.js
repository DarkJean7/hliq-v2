#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Trailing Stop
 *
 * Hyperliquid has no trailing-stop order type, so one has to be watched. This guards ONE
 * position on ONE market: it remembers the best price reached since it went live and keeps a
 * reduce-only STOP-MARKET order resting at `best − retracement` (for a long), moving that
 * order up as the high-water mark rises and never down.
 *
 * ── why it rests the order instead of waiting to send one ──
 *
 * The obvious build is "watch the mark, and when it retraces, send a market order". That is
 * identical to this while the process is alive, and much worse when it is not: a resting
 * order survives a crash, a deploy, a reboot and a rate-limit storm, and an intention held in
 * a variable survives none of them. A stop you can lose by restarting a server is not a stop.
 *
 * So the retracement level lives on the exchange at all times. The in-process trigger check is
 * kept as a backstop for the case where the order could not be placed at all — if we are
 * unprotected we should at least be able to get out.
 *
 * ── restart ──
 *
 * The high-water mark is persisted. Losing it would silently reset the stop to wherever the
 * market happens to be, which on a trade that has run a long way is a large, invisible giveback
 * — so it is written every time it moves and restored on resume. The exchange is still the
 * source of truth for the position and for what is actually resting.
 *
 * Usage:
 *   node strategies/trailstop.js --coin HYPE --address 0xMASTER \
 *     --retrace 5 --unit pct [--size-pct 100 | --size 20.19] [--activation 95] [--dry-run]
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isPaused } from './_pause.js'
import { botCloid } from '../src/cloid.js'
import { sideOf, stopPrice, advance, isTriggered, shouldMoveStop, resolveSize } from '../src/trailstop.js'

const { values: args } = parseArgs({
  options: {
    wallet:     { type: 'string' },
    address:    { type: 'string' },
    coin:       { type: 'string' },
    retrace:    { type: 'string', default: '5'    },   // amount
    unit:       { type: 'string', default: 'pct'  },   // pct | usd
    'size-pct': { type: 'string', default: '100'  },   // % of the position to close
    size:       { type: 'string', default: ''     },   // absolute size, wins over size-pct
    activation: { type: 'string', default: ''     },   // do not start trailing until here
    interval:   { type: 'string', default: '5'    },   // poll seconds
    'dry-run':  { type: 'boolean', default: false },
    resume:     { type: 'boolean', default: false },
  },
  allowPositionals: false,
  strict: false,   // tolerate unknown flags from older UIs
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) { console.error('ERROR: agent key not provided'); process.exit(1) }
if (!args.coin) { console.error('ERROR: --coin is required'); process.exit(1) }

// HIP-3 (builder-deployed) markets are prefixed "dex:SYM", and every read has to carry the dex
// or it silently answers about the main exchange instead.
const _rawCoin = String(args.coin)
const IS_HIP3  = _rawCoin.includes(':')
const DEX      = IS_HIP3 ? _rawCoin.split(':')[0].toLowerCase() : null
const COIN     = IS_HIP3 ? `${DEX}:${_rawCoin.split(':')[1].toUpperCase()}` : _rawCoin.toUpperCase()
const Q        = (addr) => DEX ? { user: addr, dex: DEX } : { user: addr }
const MIDS_ARG = DEX ? { dex: DEX } : undefined

const RETRACE  = parseFloat(args.retrace) || 0
const UNIT     = String(args.unit).toLowerCase() === 'usd' ? '$' : '%'
const SIZE_PCT = parseFloat(args['size-pct'])
const SIZE_ABS = args.size === '' ? null : parseFloat(args.size)
const ACTIVATE = args.activation === '' ? null : parseFloat(args.activation)
const CHECK_MS = Math.max(2, parseInt(args.interval) || 5) * 1000
const DRY_RUN  = !!args['dry-run']
const RESUME   = !!args.resume

if (!(RETRACE > 0)) { console.error('ERROR: --retrace must be > 0'); process.exit(1) }
if (UNIT === '%' && RETRACE >= 100) { console.error('ERROR: a 100% retracement can never trigger'); process.exit(1) }

const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const QUERY_ADDR  = args.address ?? etherWallet.address

function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let m = msg
  if (tag.trim() === 'ERROR' && typeof m === 'string') {
    const h = m.search(/<\s*html/i)
    if (h !== -1) m = m.slice(0, h).replace(/[-\s]+$/, '').trim() || 'HTML error'
    m = m.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  console.log(`[${ts}] [${tag.padEnd(8)}] ${m}`)
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ─── PERSISTED HIGH-WATER MARK ────────────────────────────────────────────────
// Losing this resets the stop to wherever the market happens to be, which on a trade that has
// already run is a large and completely invisible giveback. Written whenever it moves.
const STATE_FILE = path.join(process.cwd(), '.trailstop-state.json')
const _key = () => `${(QUERY_ADDR || '').toLowerCase()}:${COIN.toUpperCase()}`
const _all = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
function saveState() {
  try { const a = _all(); a[_key()] = { ...trail, restingPx, restingOid, ts: Date.now() }; writeFileSync(STATE_FILE, JSON.stringify(a, null, 2)) }
  catch (e) { log('WARN', `Could not persist state: ${e.message}`) }
}
function clearState() {
  try { const a = _all(); if (a[_key()] !== undefined) { delete a[_key()]; writeFileSync(STATE_FILE, JSON.stringify(a, null, 2)) } } catch {}
}

let trail      = { active: false, best: null }
let restingPx  = null    // where our stop currently sits on the exchange
let restingOid = null

// HL perp tick rule: at most 5 significant figures AND at most (6 − szDecimals) decimals.
// Getting this wrong means "not divisible by tick size" and no stop at all, which is the one
// failure that must not happen quietly.
function roundPx(px, szDecimals) {
  if (!(px > 0)) return px
  const sig = Number(px.toPrecision(5))
  const dp  = Math.max(0, 6 - (Number.isFinite(szDecimals) ? szDecimals : 2))
  return Number(sig.toFixed(dp))
}

// ─── ASSET INDEX ──────────────────────────────────────────────────────────────
// Same resolution guardian.js uses, and it has to be exactly this: a HIP-3 asset's id is
// 100000 + dexIndex*10000 + i, NOT its position in that dex's universe. Getting it wrong does
// not fail loudly — it addresses a different market, which on a cancel means cancelling
// somebody else's order and on an order means opening a position in the wrong thing.
let _meta = null
async function loadMeta() {
  if (_meta) return
  _meta = {}
  if (DEX) {
    const [dexs, meta] = await Promise.all([info.perpDexs(), info.meta({ dex: DEX })])
    const dexIdx = (dexs ?? []).findIndex(d => d && d.name === DEX)
    if (dexIdx < 1) throw new Error(`Unknown perp dex: ${DEX}`)
    ;(meta.universe ?? []).forEach((u, i) => {
      _meta[u.name] = { index: 100000 + dexIdx * 10000 + i, szDecimals: u.szDecimals ?? 6 }
    })
  } else {
    const meta = await info.meta()
    ;(meta.universe ?? []).forEach((u, i) => { _meta[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 } })
  }
}
function assetInfo() {
  const bare = IS_HIP3 ? COIN.split(':')[1] : COIN
  const a = _meta?.[bare]
  if (!a) throw new Error(`Unknown coin: ${COIN}`)
  return a
}
const assetId     = () => assetInfo().index
const szDecimals  = () => assetInfo().szDecimals

async function readPosition() {
  const cs = await info.clearinghouseState(Q(QUERY_ADDR))
  const ap = (cs?.assetPositions ?? []).find(p => (p.position?.coin ?? '') === COIN)
  const szi = parseFloat(ap?.position?.szi ?? 0)
  if (!szi) return null
  return {
    szi,
    side:  sideOf(szi),
    entry: parseFloat(ap.position.entryPx ?? 0),
    size:  Math.abs(szi),
  }
}

async function readMark() {
  const mids = MIDS_ARG ? await info.allMids(MIDS_ARG) : await info.allMids()
  const key  = IS_HIP3 ? COIN : COIN
  const px   = parseFloat(mids?.[key] ?? mids?.[COIN] ?? 0)
  return px > 0 ? px : null
}

/**
 * Our resting stop, as the exchange sees it. The exchange is the truth: a stop we believe is
 * there and is not is exactly the state this bot exists to prevent.
 *
 * Matched by oid when we have one, and by shape when we do not. That second case is not
 * hypothetical — an order can be accepted without the response carrying an oid we recognise,
 * and treating that as "nothing is resting" would place a SECOND stop on the next tick and
 * then market out on top of both. Reduce-only keeps the damage to nothing, but the position
 * would still be closed twice over and the logs would make no sense.
 */
async function readResting() {
  const orders = await info.frontendOpenOrders(Q(QUERY_ADDR)).catch(() => null)
  if (orders == null) return undefined          // could not look — NOT the same as "none there"
  const stops = (orders ?? []).filter(o =>
    o.coin === COIN && o.reduceOnly && (o.isTrigger || /stop/i.test(String(o.orderType ?? ''))))
  if (restingOid != null) {
    const byOid = stops.find(o => o.oid === restingOid)
    if (byOid) return byOid
  }
  if (restingPx != null) {
    const near = stops.find(o => {
      const tp = parseFloat(o.triggerPx ?? o.limitPx ?? 0)
      return tp > 0 && Math.abs(tp - restingPx) / restingPx < 1e-6
    })
    // Adopt it, so from here on it is tracked by oid like any other.
    if (near) { restingOid = near.oid; return near }
  }
  return null
}

async function cancelResting() {
  if (restingOid == null) return
  try {
    await exchange.cancel({ cancels: [{ a: assetId(), o: restingOid }] })
    log('CANCEL', `Removed stop #${restingOid} @ ${restingPx}`)
  } catch (e) { log('WARN', `Could not cancel #${restingOid}: ${e.message}`) }
  restingOid = null; restingPx = null
}

const roundSz = (sz) => Number(Math.abs(sz).toFixed(szDecimals()))

async function placeStop(px, sz) {
  const pos = await readPosition()
  if (!pos) return false
  const isBuy = pos.side === 'short'            // closing a short means buying
  const trigger = roundPx(px, szDecimals())
  // A market stop still needs a limit far enough through to fill. 1% is what the app's own
  // placeTriggerOrder uses.
  const limitPx = roundPx(isBuy ? trigger * 1.01 : trigger * 0.99, szDecimals())
  if (DRY_RUN) { log('DRY', `Would rest stop ${sz} ${COIN} @ ${trigger}`); restingPx = trigger; return true }
  const res = await exchange.order({
    orders: [{
      c: botCloid(process.env.HLIQ_BOT), a: assetId(), b: isBuy, p: String(limitPx), s: String(roundSz(sz)), r: true,
      t: { trigger: { isMarket: true, triggerPx: String(trigger), tpsl: 'sl' } },
    }],
    grouping: 'na',
  })
  const st = res?.response?.data?.statuses?.[0]
  const oid = st?.resting?.oid ?? st?.filled?.oid ?? null
  if (st?.error) { log('ERROR', `Stop rejected: ${st.error}`); return false }
  restingOid = oid; restingPx = trigger
  log('STOP', `Resting ${sz} ${COIN} stop @ ${trigger}${oid ? ` (#${oid})` : ''}`)
  return true
}

/** Last resort: the resting order could not be placed and price has retraced anyway. */
async function marketOut(sz) {
  const pos = await readPosition()
  if (!pos) return
  const isBuy = pos.side === 'short'
  const mark = await readMark()
  if (!mark) return
  const px = roundPx(isBuy ? mark * 1.02 : mark * 0.98, szDecimals())
  if (DRY_RUN) { log('DRY', `Would market out ${sz} ${COIN}`); return }
  await exchange.order({
    orders: [{ c: botCloid(process.env.HLIQ_BOT), a: assetId(), b: isBuy, p: String(px), s: String(roundSz(sz)), r: true, t: { limit: { tif: 'Ioc' } } }],
    grouping: 'na',
  })
  log('FIRED', `No resting stop was in place — closed ${sz} ${COIN} at market`)
}

async function tick() {
  const pos = await readPosition()
  if (!pos) {
    // Position gone: closed by the stop, by hand, or liquidated. Clean up after ourselves —
    // a reduce-only order left behind is harmless but confusing, and the state file would
    // otherwise re-arm against a high-water mark from a trade that no longer exists.
    if (restingOid != null) await cancelResting()
    clearState()
    log('DONE', `${COIN} position is closed — trailing stop finished`)
    process.exit(0)
  }

  const mark = await readMark()
  if (!mark) { log('WARN', 'No mark price this tick'); return }

  const before = trail.active
  trail = advance(trail, mark, { side: pos.side, activationPx: ACTIVATE })
  if (!trail.active) return                       // waiting for the activation price
  if (!before) log('ARMED', `Activated at ${mark} — trailing ${RETRACE}${UNIT} from the ${pos.side === 'long' ? 'high' : 'low'}`)

  const sz = resolveSize(pos.size, { pct: SIZE_PCT, size: SIZE_ABS })
  if (!(sz > 0)) { log('WARN', 'Nothing to close'); return }

  const next = stopPrice(pos.side, trail.best, RETRACE, UNIT)
  if (next == null) { log('WARN', 'Retracement does not produce a usable stop'); return }

  // Did the exchange lose our order? If the oid is gone and the position is still open, it
  // either filled (handled above, the position would be gone) or was cancelled elsewhere.
  // Did the exchange lose our order? Only act on a definite answer: `undefined` means the
  // orders call failed, and treating a failed read as "the stop is gone" would cancel and
  // replace a perfectly good stop every time the network hiccuped.
  if (!DRY_RUN && (restingOid != null || restingPx != null)) {
    const still = await readResting()
    if (still === null) {
      log('WARN', `Stop${restingOid != null ? ` #${restingOid}` : ''} is no longer on the book — replacing`)
      restingOid = null; restingPx = null
    }
  }

  if (shouldMoveStop(pos.side, restingPx, next)) {
    const had = restingOid != null
    if (had) await cancelResting()
    const ok = await placeStop(next, sz)
    if (ok) { if (trail.moved || !had) saveState() }
    else if (isTriggered(pos.side, mark, next)) {
      // Unprotected AND already past the level: do not wait for the next tick.
      await marketOut(sz)
    }
  } else if (restingOid == null && isTriggered(pos.side, mark, next)) {
    await marketOut(sz)
  } else if (trail.moved) {
    saveState()
  }
}

;(async () => {
  await loadMeta()
  const pos0 = await readPosition()
  if (!pos0) { console.error(`ERROR: no open ${COIN} position to trail`); process.exit(1) }

  if (RESUME) {
    const s = _all()[_key()]
    if (s && Number.isFinite(parseFloat(s.best))) {
      trail = { active: !!s.active, best: parseFloat(s.best), activatedAt: s.activatedAt }
      restingPx = Number.isFinite(parseFloat(s.restingPx)) ? parseFloat(s.restingPx) : null
      restingOid = s.restingOid ?? null
      log('RESUME', `Restored high-water mark ${trail.best}${restingPx ? `, stop @ ${restingPx}` : ''}`)
    }
  } else {
    clearState()
  }

  const act = ACTIVATE != null ? ` | activates at ${ACTIVATE}` : ''
  log('START', `Trailing stop on ${COIN} ${pos0.side.toUpperCase()} | entry ${pos0.entry} | retrace ${RETRACE}${UNIT}`
    + ` | size ${SIZE_ABS ?? SIZE_PCT + '%'}${act}${DRY_RUN ? ' | DRY-RUN' : ''}`)

  while (true) {
    if (!isPaused()) {
      try { await tick() } catch (e) { log('ERROR', e.message) }
    }
    await sleep(CHECK_MS)
  }
})().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
