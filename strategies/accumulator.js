#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Profit Accumulator
 *
 * Account-level DCA funded by trading profit. Watches ALL closed fills for the
 * master wallet, skims a % of NET realized profit, and batches it into spot buys
 * of a chosen token (default HYPE) — building a stack that is ring-fenced from
 * perp risk (only USDC is perp collateral on Hyperliquid; spot HYPE is not).
 *
 * ONE instance per address (account-wide), so it owns a single fill cursor and
 * can't double-count the way per-strategy skimming would across many processes.
 *
 *   Flow each cycle:
 *     1. Pull fills newer than the cursor; net them (Σ closedPnl − Σ fees).
 *     2. If the window is net-positive, buffer  cut% × netPnl.
 *     3. When the buffer ≥ threshold (and ≥ HL's $10 min): transfer that USDC
 *        perp → spot, then market-buy (IOC) the accumulation token.
 *
 * Cursor + buffer persist so a deploy/reboot --resume can't re-skim old fills.
 * A FRESH arm (no --resume) starts the cursor at "now" and the buffer at 0 — i.e.
 * deactivating discards any sub-threshold buffer (USDC just stays in the perp acct).
 *
 * Usage:
 *   node strategies/accumulator.js --address 0xMASTER \
 *     --asset HYPE --cut-pct 10 --threshold 15 [--max-daily 0] [--dry-run]
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isPaused, onPause, onResume } from './_pause.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:      { type: 'string' },
    address:     { type: 'string' },
    asset:       { type: 'string', default: 'HYPE' },  // spot token to accumulate
    'cut-pct':   { type: 'string', default: '25'  },   // % of net positive PnL to skim
    threshold:   { type: 'string', default: '11'  },   // min USD buffered before a buy
    'net-fees':  { type: 'string', default: 'true' },  // subtract fees so skim = true net
    'max-daily': { type: 'string', default: '0'   },   // optional daily USD skim cap (0 = none)
    interval:    { type: 'string', default: '60'  },   // scan cycle, seconds
    'dry-run':   { type: 'boolean', default: false },
    resume:      { type: 'boolean', default: false },  // restore persisted cursor + buffer
  },
  allowPositionals: false,
  strict: false,   // tolerate unknown flags from older UIs
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) { console.error('ERROR: agent key not provided'); process.exit(1) }

const ASSET_SYM = String(args.asset || 'HYPE').toUpperCase()
const CUT_PCT   = Math.min(1, Math.max(0, (parseFloat(args['cut-pct']) || 0) / 100))
const THRESHOLD = Math.max(0, parseFloat(args.threshold) || 0)
const NET_FEES  = String(args['net-fees']).toLowerCase() !== 'false'
const MAX_DAILY = Math.max(0, parseFloat(args['max-daily']) || 0)
const CHECK_MS  = Math.max(15, parseInt(args.interval) || 60) * 1000
const DRY_RUN   = !!args['dry-run']
const RESUME    = !!args.resume
// HL rejects spot orders below $10 notional. After the 0.3% fee headroom and the
// size round-DOWN (one tick can be ~$0.60 on HYPE), a $10 buffer produces a ~$9.4
// order that HL bounces. $11 is the smallest buffer that reliably clears $10 — this
// is the floor the buy fires at, so profit buys happen as soon as the minimum stacks.
const HL_MIN_ORDER = 11

if (CUT_PCT <= 0)   { console.error('ERROR: --cut-pct must be > 0'); process.exit(1) }
if (THRESHOLD <= 0) { console.error('ERROR: --threshold must be > 0'); process.exit(1) }

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const ADDRESS     = etherWallet.address          // agent key — signs only
const QUERY_ADDR  = args.address ?? ADDRESS      // master wallet — reads

// ─── STATE ────────────────────────────────────────────────────────────────────
let lastFillScan  = Date.now()   // fill cursor (ms) — only profit from arm-time forward
let toBuyUsd      = 0            // skimmed-but-unspent USD buffer
let lifetimeSpent = 0            // cumulative USD spent on the asset
let lifetimeQty   = 0            // cumulative asset units bought
let dayKey        = _today()     // UTC day for the daily cap
let daySkimmed    = 0            // USD skimmed so far today

// ─── LOGGING / UTIL ─────────────────────────────────────────────────────────────
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
const sleep = ms => new Promise(r => setTimeout(r, ms))
function _today() { return new Date().toISOString().slice(0, 10) }

// HL price tick: ≤5 significant figures AND ≤(MAX_DEC - szDecimals) decimals, where
// MAX_DEC is 6 for perps and 8 for SPOT. Accumulator buys SPOT, so pass isSpot=true
// to use the spot cap; the old magnitude form applied only the sig-fig cap and could
// emit too many decimals → HL rejects ("not divisible by tick size").
// szDecimals omitted → pure 5-sig-fig (unchanged behavior for threshold math).
function roundPx(n, szDecimals, isSpot = false) {
  const f = parseFloat(n)
  if (!(f > 0)) return 0
  const sig = parseFloat(f.toPrecision(5))
  if (szDecimals == null) return sig
  const maxDec = Math.max(0, (isSpot ? 8 : 6) - szDecimals)
  const factor = Math.pow(10, maxDec)
  return Math.round(sig * factor) / factor
}
function roundSz(n, szDecimals = 6) {
  const factor = Math.pow(10, szDecimals)
  return Math.floor(parseFloat(n) * factor) / factor
}

// ─── STATE PERSISTENCE ──────────────────────────────────────────────────────────
// Cursor + buffer survive restarts so an auto-resume (deploy/reboot) can't re-scan
// old fills and double-skim. Keyed by master+asset. A fresh arm (no --resume) clears
// the key, restarting the cursor at "now" — which discards any sub-threshold buffer.
const STATE_FILE = path.join(process.cwd(), '.accumulator-state.json')
function _stateKey() { return `${(QUERY_ADDR || '').toLowerCase()}:${ASSET_SYM}` }
function _readAllState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
function loadState() { return _readAllState()[_stateKey()] || null }
function saveState() {
  try {
    const all = _readAllState()
    all[_stateKey()] = { lastFillScan, toBuyUsd, lifetimeSpent, lifetimeQty, dayKey, daySkimmed, ts: Date.now() }
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2))
  } catch (e) { log('WARN', `Could not persist state: ${e.message}`) }
}
function clearState() {
  try { const all = _readAllState(); if (all[_stateKey()] !== undefined) { delete all[_stateKey()]; writeFileSync(STATE_FILE, JSON.stringify(all, null, 2)) } }
  catch {}
}

// ─── SPOT ASSET RESOLUTION ───────────────────────────────────────────────────────
// HL spot orders use asset id = 10000 + pairIndex. Resolve SYM/USDC from spotMeta:
// match the token by name, then the universe pair holding that token + USDC.
let _spot = null
async function resolveSpot() {
  if (_spot) return _spot
  const sm     = await info.spotMeta()
  const tokens = sm?.tokens ?? []
  const tok    = tokens.find(t => (t.name || '').toUpperCase() === ASSET_SYM)
  if (!tok) throw new Error(`Spot token "${ASSET_SYM}" not found`)
  const usdc   = tokens.find(t => (t.name || '').toUpperCase() === 'USDC')
  if (!usdc) throw new Error('USDC spot token not found')
  const pair   = (sm.universe ?? []).find(u => Array.isArray(u.tokens) && u.tokens.includes(tok.index) && u.tokens.includes(usdc.index))
  if (!pair) throw new Error(`No ${ASSET_SYM}/USDC spot pair`)
  _spot = { asset: 10000 + pair.index, name: pair.name, szDecimals: tok.szDecimals ?? 6 }
  return _spot
}

// Free (un-held) spot USDC available to spend.
async function getFreeSpotUsdc() {
  const sp = await info.spotClearinghouseState({ user: QUERY_ADDR }).catch(() => null)
  const u  = (sp?.balances ?? []).find(b => b.coin === 'USDC')
  return u ? Math.max(0, parseFloat(u.total ?? 0) - parseFloat(u.hold ?? 0)) : 0
}

// ─── FILL SCAN — net realized PnL since the cursor (account-wide) ─────────────────
// Σ closedPnl − Σ fees over the window. Mirrors grid.js's incremental fill scan but
// across every coin. Skim only when the window is net-positive, so losing windows
// (or windows that are all fees) are skipped. Cursor advances regardless.
async function scanWindow() {
  let fills
  try { fills = await info.userFillsByTime({ user: QUERY_ADDR, startTime: lastFillScan + 1 }) }
  catch (e) { log('WARN', `Fill scan failed: ${e.message} — retry next cycle`); return 0 }
  if (!Array.isArray(fills) || !fills.length) return 0

  let sumClosed = 0, sumFees = 0, newest = lastFillScan
  for (const f of fills) {
    if (f.time > newest) newest = f.time
    sumClosed += parseFloat(f.closedPnl ?? 0)
    sumFees   += parseFloat(f.fee ?? 0)
  }
  lastFillScan = newest

  const net = NET_FEES ? (sumClosed - sumFees) : sumClosed
  return net
}

// ─── BUY — transfer perp USDC → spot, then market-buy (IOC) the asset ─────────────
async function buy(usd) {
  const spot = await resolveSpot()
  const mids = await info.allMids()
  const mid  = parseFloat(mids[spot.name] ?? 0)
  if (!mid) { log('ERROR', `No spot price for ${ASSET_SYM} (${spot.name}) — retry next cycle`); return false }

  const px = roundPx(mid * 1.005, spot.szDecimals, true)   // marketable: 0.5% through mid, spot tick
  const estSz = roundSz(usd / px, spot.szDecimals)
  if (estSz <= 0) { log('WARN', `Buffer $${usd.toFixed(2)} too small for one ${ASSET_SYM} unit @ $${px}`); return false }

  if (DRY_RUN) {
    log('DRY-RUN', `Would transfer $${usd.toFixed(2)} perp→spot and BUY ~${estSz} ${ASSET_SYM} @ ~$${px} (mid $${mid})`)
    lifetimeSpent += usd
    lifetimeQty   += estSz
    log('WIN', `Accumulated ${estSz} ${ASSET_SYM} for $${usd.toFixed(2)} (~$${px}) [DRY] | lifetime ${lifetimeQty.toFixed(spot.szDecimals)} ${ASSET_SYM}`)
    return true
  }

  // Move the skim into the spot wallet (inverse of grid.js's margin top-up).
  try { await exchange.usdClassTransfer({ amount: usd.toFixed(2), toPerp: false }) }
  catch (e) { log('ERROR', `perp→spot transfer failed: ${e.message} — buffer kept, retry next cycle`); return false }
  await sleep(1500)

  // Size against the USDC that actually landed; keep a small headroom for fees.
  const freeUsdc = await getFreeSpotUsdc()
  const spend    = Math.min(usd, freeUsdc)
  let   sz       = roundSz((spend * 0.997) / px, spot.szDecimals)
  // Rounding down can drop the order below HL's $10 notional min. Bump up to the
  // smallest size that clears $10, but only if the landed USDC can still afford it.
  const HL_MIN_NOTIONAL = 10
  if (sz * px < HL_MIN_NOTIONAL) {
    const tick  = 1 / Math.pow(10, spot.szDecimals)
    const minSz = Math.ceil((HL_MIN_NOTIONAL / px) / tick) * tick
    if (roundSz(minSz, spot.szDecimals) * px <= freeUsdc) sz = roundSz(minSz, spot.szDecimals)
  }
  if (sz <= 0 || sz * px < HL_MIN_NOTIONAL) { log('ERROR', `Post-transfer free USDC $${freeUsdc.toFixed(2)} too small to clear HL's $${HL_MIN_NOTIONAL} min — USDC sits in spot, retry next cycle`); return false }

  let result
  try {
    result = await exchange.order({
      orders: [{ a: spot.asset, b: true, p: px.toString(), s: sz.toString(), r: false, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    })
  } catch (e) { log('ERROR', `Spot buy threw: ${e.message} — USDC sits in spot, retry next cycle`); return false }

  const statuses = result?.response?.data?.statuses ?? []
  const errs     = statuses.filter(s => s.error).map(s => s.error)
  if (errs.length) { log('ERROR', `Spot buy rejected: ${errs.join(', ')} — USDC sits in spot, retry next cycle`); return false }

  // Pull the actual fill out of the response when present.
  const filled = statuses.map(s => s.filled).find(Boolean)
  const gotSz  = filled ? parseFloat(filled.totalSz ?? sz) : sz
  const avgPx  = filled ? parseFloat(filled.avgPx ?? px)  : px
  lifetimeSpent += gotSz * avgPx
  lifetimeQty   += gotSz
  log('WIN', `Accumulated ${gotSz} ${ASSET_SYM} for $${(gotSz * avgPx).toFixed(2)} (avg $${avgPx}) | lifetime ${lifetimeQty.toFixed(spot.szDecimals)} ${ASSET_SYM}`)
  return true
}

// ─── PAUSE (freeze skimming; nothing pending to unwind) ──────────────────────────
onPause(()  => log('PAUSE', 'Paused — not skimming or buying until resumed'))
onResume(() => log('RESUME', 'Resumed — watching fills again'))

// ─── TICK ─────────────────────────────────────────────────────────────────────
async function tick() {
  // Roll the daily cap window.
  const td = _today()
  if (td !== dayKey) { dayKey = td; daySkimmed = 0 }

  const net = await scanWindow()
  if (net > 0) {
    let skim = net * CUT_PCT
    if (MAX_DAILY > 0) skim = Math.min(skim, Math.max(0, MAX_DAILY - daySkimmed))
    if (skim > 0) {
      toBuyUsd   += skim
      daySkimmed += skim
      log('SKIM', `Window net +$${net.toFixed(2)} → skimmed $${skim.toFixed(2)} (${(CUT_PCT * 100).toFixed(0)}%) | buffer $${toBuyUsd.toFixed(2)}/$${THRESHOLD}${MAX_DAILY > 0 ? ` | today $${daySkimmed.toFixed(2)}/$${MAX_DAILY}` : ''}`)
    } else if (MAX_DAILY > 0) {
      log('SCAN', `Window net +$${net.toFixed(2)} | daily skim cap $${MAX_DAILY} reached — holding`)
    }
  }

  // Fire a buy once the buffer clears both the user threshold and HL's $10 min.
  if (toBuyUsd >= Math.max(THRESHOLD, HL_MIN_ORDER)) {
    const amount = toBuyUsd
    const ok = await buy(amount)
    if (ok) toBuyUsd = Math.max(0, toBuyUsd - amount)
  }
  saveState()
}

// ─── MAIN LOOP ──────────────────────────────────────────────────────────────────
;(async () => {
  // Validate the asset is a real spot pair before we start (fail fast in the UI).
  let spot
  try { spot = await resolveSpot() }
  catch (e) { console.error(`ERROR: ${e.message}`); process.exit(1) }

  if (RESUME) {
    const st = loadState()
    if (st) {
      lastFillScan  = parseInt(st.lastFillScan) || Date.now()
      toBuyUsd      = parseFloat(st.toBuyUsd) || 0
      lifetimeSpent = parseFloat(st.lifetimeSpent) || 0
      lifetimeQty   = parseFloat(st.lifetimeQty) || 0
      dayKey        = st.dayKey || _today()
      daySkimmed    = parseFloat(st.daySkimmed) || 0
      log('RESUME', `Restored — cursor ${new Date(lastFillScan).toISOString()} | buffer $${toBuyUsd.toFixed(2)} | lifetime ${lifetimeQty} ${ASSET_SYM}`)
    }
  } else {
    clearState()                 // fresh arm — discard any prior buffer
    lastFillScan = Date.now()    // only count profit from now forward
    saveState()
  }

  log('START', `Accumulator on ${QUERY_ADDR} | skim ${(CUT_PCT * 100).toFixed(0)}% of net PnL → buy ${ASSET_SYM} (spot ${spot.name}) | threshold $${THRESHOLD}${MAX_DAILY > 0 ? ` | daily cap $${MAX_DAILY}` : ''} | net-of-fees ${NET_FEES}${DRY_RUN ? ' | DRY-RUN' : ''}`)

  while (true) {
    if (!isPaused()) {
      try { await tick() } catch (e) { log('ERROR', e.message) }
    }
    await sleep(CHECK_MS)
  }
})().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
