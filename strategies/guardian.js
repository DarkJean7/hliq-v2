#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Position Guardian (Liq Guard / Leverage Brake)
 *
 * Price-triggered risk module for ISOLATED-margin positions. One instance guards
 * ONE position in ONE mode; the two modes are independent and can run together on
 * the same position (different trigger levels):
 *
 *   --mode liqguard : ADD margin as price approaches the liquidation price, pushing
 *                     liq further away. Fixed --add-usd per fire, or --target-leverage
 *                     (top up until leverage ≤ target — preferred). Hard-capped by
 *                     --max-total-add (required) and --max-fires.
 *
 *   --mode levbrake : REDUCE position size by --reduce-pct (reduce-only IOC) as price
 *                     approaches liq. A smaller position moves liq favourably even at
 *                     the same margin. Capped by --max-fires.
 *
 * TRIGGER: --trigger-pct is the % of the way from entry to liq (e.g. 80 = fire when
 * mark is 80% of the entry→liq distance toward liquidation). --trigger-price sets an
 * absolute first-arm price instead (an implied pct is derived for re-arms). After each
 * fire the liq price is re-read and a NEW trigger is armed further out with the same
 * pct — until --max-fires (or the margin cap) is reached.
 *
 * The exchange is the source of truth: every tick reads the live position + mark and
 * recomputes the armed trigger from the CURRENT liq price, so restarts re-arm cleanly.
 *
 * Usage:
 *   node strategies/guardian.js --coin SPCX --mode liqguard \
 *     --address 0xMASTER --trigger-pct 80 --target-leverage 10 \
 *     --max-total-add 100 --max-fires 2 [--dry-run]
 *
 *   node strategies/guardian.js --coin SPCX --mode levbrake \
 *     --address 0xMASTER --trigger-pct 70 --reduce-pct 25 --max-fires 2
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
    wallet:            { type: 'string' },
    address:           { type: 'string' },
    coin:              { type: 'string' },
    mode:              { type: 'string', default: 'liqguard' }, // liqguard | levbrake
    'trigger-pct':     { type: 'string', default: '80'  },  // % of entry→liq distance toward liq
    'trigger-price':   { type: 'string', default: '0'   },  // absolute first-arm price (overrides pct)
    // liqguard
    'add-usd':         { type: 'string', default: '0'   },  // fixed USDC margin per fire
    'target-leverage': { type: 'string', default: '0'   },  // top up until leverage ≤ this (preferred)
    'max-total-add':   { type: 'string', default: '0'   },  // REQUIRED cap on cumulative USDC added
    // levbrake
    'reduce-pct':      { type: 'string', default: '25'  },  // % of current size reduced per fire
    // shared
    'max-fires':       { type: 'string', default: '2'   },
    interval:          { type: 'string', default: '5'   },  // poll cycle, seconds
    'dry-run':         { type: 'boolean', default: false },
    resume:            { type: 'boolean', default: false }, // restore persisted cumulative state
  },
  allowPositionals: false,
  strict: false,   // tolerate unknown flags from older UIs
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) { console.error('ERROR: agent key not provided'); process.exit(1) }
if (!args.coin) { console.error('ERROR: --coin is required'); process.exit(1) }

const MODE = String(args.mode).toLowerCase() === 'levbrake' ? 'levbrake' : 'liqguard'

// HIP-3 (builder-deployed) markets are prefixed "dex:SYM". A bare TradFi symbol not
// found on the main dex is resolved to its builder dex at startup (resolveCoin()).
const _rawCoin = String(args.coin)
let   IS_HIP3  = _rawCoin.includes(':')
let   DEX      = IS_HIP3 ? _rawCoin.split(':')[0].toLowerCase() : null
let   COIN     = IS_HIP3 ? `${DEX}:${_rawCoin.split(':')[1].toUpperCase()}` : _rawCoin.toUpperCase()
let   Q        = (addr) => DEX ? { user: addr, dex: DEX } : { user: addr }
let   MIDS_ARG = DEX ? { dex: DEX } : undefined

const TRIGGER_PCT   = Math.min(0.99, Math.max(0.01, (parseFloat(args['trigger-pct']) || 80) / 100))
const TRIGGER_PRICE = parseFloat(args['trigger-price']) || 0
const ADD_USD       = parseFloat(args['add-usd']) || 0
const TARGET_LEV    = parseFloat(args['target-leverage']) || 0
const MAX_TOTAL_ADD = parseFloat(args['max-total-add']) || 0
const REDUCE_PCT    = Math.min(1, Math.max(0.01, (parseFloat(args['reduce-pct']) || 25) / 100))
const MAX_FIRES     = Math.max(1, parseInt(args['max-fires']) || 2)
const CHECK_MS      = Math.max(2, parseInt(args.interval) || 5) * 1000
const DRY_RUN       = !!args['dry-run']
const RESUME        = !!args.resume
const HL_MIN_ORDER  = 10

if (MODE === 'liqguard') {
  if (MAX_TOTAL_ADD <= 0) { console.error('ERROR: --max-total-add is required for liqguard (cap on total USDC added)'); process.exit(1) }
  if (ADD_USD <= 0 && TARGET_LEV <= 0) { console.error('ERROR: set --add-usd or --target-leverage for liqguard'); process.exit(1) }
}

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const ADDRESS     = etherWallet.address          // agent key — signs only
const QUERY_ADDR  = args.address ?? ADDRESS      // master wallet — reads

// ─── STATE ────────────────────────────────────────────────────────────────────
let fires        = 0      // number of times this guard has fired
let totalAdded   = 0      // cumulative USDC margin added (liqguard)
let impliedPct   = TRIGGER_PCT   // derived from --trigger-price for re-arms
let cooldownUntil = 0     // brief pause after a fire so HL state settles

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

// ─── CUMULATIVE STATE PERSISTENCE ───────────────────────────────────────────────
// The hard cap (max-total-add) and max-fires are tracked across process restarts so a
// deploy/reboot/crash can't reset the counter and let the bot top up again. Keyed by
// mode+master+coin. A FRESH arm (no --resume) clears the key, starting the cap over.
const STATE_FILE = path.join(process.cwd(), '.guardian-state.json')
function _stateKey() { return `${MODE}:${(QUERY_ADDR || '').toLowerCase()}:${COIN.toUpperCase()}` }
function _readAllState() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
function loadState()  { return _readAllState()[_stateKey()] || null }
function saveState()  {
  try { const all = _readAllState(); all[_stateKey()] = { totalAdded, fires, ts: Date.now() }; writeFileSync(STATE_FILE, JSON.stringify(all, null, 2)) }
  catch (e) { log('WARN', `Could not persist state: ${e.message}`) }
}
function clearState() {
  try { const all = _readAllState(); if (all[_stateKey()] !== undefined) { delete all[_stateKey()]; writeFileSync(STATE_FILE, JSON.stringify(all, null, 2)) } }
  catch {}
}

function roundPx(n) {
  const f = parseFloat(n)
  if (f <= 0) return 0
  const magnitude = Math.floor(Math.log10(Math.abs(f)))
  const factor    = Math.pow(10, 4 - magnitude)
  return Math.round(f * factor) / factor
}
function roundSz(n, szDecimals = 6) {
  const factor = Math.pow(10, szDecimals)
  return Math.floor(parseFloat(n) * factor) / factor
}

// ─── ASSET INDEX CACHE ──────────────────────────────────────────────────────────
let _meta = null
async function getAssetInfo(coin) {
  if (!_meta) {
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
      ;(meta.universe ?? []).forEach((u, i) => {
        _meta[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 }
      })
    }
  }
  const asset = _meta[coin]
  if (!asset) throw new Error(`Unknown coin: ${coin}`)
  return asset
}

// Resolve a bare TradFi symbol to its HIP-3 dex (e.g. "SPCX" → "xyz:SPCX").
async function resolveCoin() {
  if (IS_HIP3) return
  const mainMids = await info.allMids().catch(() => ({}))
  if (parseFloat(mainMids[COIN] ?? 0) > 0) return
  let dexs = []
  try { dexs = await info.perpDexs() } catch { return }
  for (const d of (dexs ?? [])) {
    if (!d?.name) continue
    try {
      const dmids = await info.allMids({ dex: d.name })
      const key = Object.keys(dmids).find(k => k.split(':').pop().toUpperCase() === COIN && parseFloat(dmids[k]) > 0)
      if (key) {
        IS_HIP3 = true; DEX = d.name.toLowerCase(); COIN = key
        Q = (addr) => ({ user: addr, dex: DEX }); MIDS_ARG = { dex: DEX }
        log('INIT', `Resolved "${_rawCoin}" → ${COIN} on HIP-3 dex "${DEX}"`)
        return
      }
    } catch {}
  }
  log('WARN', `Could not find "${_rawCoin}" on the main dex or any HIP-3 dex`)
}

// ─── POSITION SNAPSHOT ──────────────────────────────────────────────────────────
function _bareSym(c) { return String(c).includes(':') ? String(c).split(':')[1].toUpperCase() : String(c).toUpperCase() }
async function getPosition() {
  const cs = await info.clearinghouseState(Q(QUERY_ADDR))
  // HIP-3 clearinghouse may return the coin with OR without the "dex:" prefix —
  // match on the bare symbol so both shapes resolve to the same position.
  const sym = _bareSym(COIN)
  const ap = (cs.assetPositions ?? []).find(p => p.position.coin === COIN || _bareSym(p.position.coin) === sym)
  if (!ap) return null
  const p   = ap.position
  const szi = parseFloat(p.szi ?? 0)
  if (szi === 0) return null
  return {
    szi, size: Math.abs(szi), isLong: szi > 0,
    entry:      parseFloat(p.entryPx ?? 0),
    liq:        parseFloat(p.liquidationPx ?? 0),
    marginUsed: parseFloat(p.marginUsed ?? 0),
    uPnl:       parseFloat(p.unrealizedPnl ?? 0),
    posVal:     parseFloat(p.positionValue ?? (Math.abs(szi) * parseFloat(p.entryPx ?? 0))),
    levType:    p.leverage?.type ?? 'isolated',
  }
}

// Free USDC this account can commit as margin (matches HL's "available to add").
async function availableToAdd() {
  try {
    const d = await info.activeAssetData({ user: QUERY_ADDR, coin: COIN })
    return Math.max(0, parseFloat(d?.availableToTrade?.[0] ?? 0))
  } catch {
    return Infinity   // read failed — don't block; HL validates the real cap
  }
}

// ─── TRIGGER MATH ───────────────────────────────────────────────────────────────
// Price at which the guard fires, given the live position. Anchored to the CURRENT
// liq price each tick, so after a fire (liq moved away) the trigger re-arms further out.
function computeTriggerPx(pos) {
  if (TRIGGER_PRICE > 0 && fires === 0) {
    // Honour the explicit absolute price for the first arm; derive an implied pct
    // (relative to entry→liq) so re-arms keep the same proportional distance.
    impliedPct = pos.isLong
      ? (pos.entry - TRIGGER_PRICE) / Math.max(1e-9, pos.entry - pos.liq)
      : (TRIGGER_PRICE - pos.entry) / Math.max(1e-9, pos.liq - pos.entry)
    impliedPct = Math.min(0.99, Math.max(0.01, impliedPct))
  }
  const pct = TRIGGER_PRICE > 0 ? impliedPct : TRIGGER_PCT
  const raw = pos.isLong
    ? pos.entry - pct * (pos.entry - pos.liq)
    : pos.entry + pct * (pos.liq - pos.entry)
  return roundPx(raw)
}

function isTriggered(markPx, pos, trigPx) {
  return pos.isLong ? markPx <= trigPx : markPx >= trigPx
}

// ─── ACTIONS ────────────────────────────────────────────────────────────────────
async function fireLiqGuard(pos, markPx) {
  // How much margin to add this fire.
  let add = ADD_USD
  if (TARGET_LEV > 0) {
    // Target the EFFECTIVE leverage = notional / equity (equity = margin + uPnL), so a
    // losing position (which shrinks equity) actually tops up. Margin-only would miss it.
    const equity     = pos.marginUsed + pos.uPnl
    const needEquity = pos.posVal / TARGET_LEV
    add = Math.max(0, needEquity - equity)           // we only ever ADD
  }
  const remaining = MAX_TOTAL_ADD - totalAdded
  if (remaining <= 0.01) { log('SPENT', `Max total margin added ($${MAX_TOTAL_ADD}) reached — no more top-ups`); return false }
  add = Math.min(add, remaining)
  const avail = await availableToAdd()
  if (avail <= 0)  { log('ERROR', `No available margin in account to add (insufficient funds) — will retry`); return false }
  add = Math.min(add, avail)
  if (add < 1)     { log('SKIP', `Computed margin add $${add.toFixed(2)} too small — skipping`); return false }

  const oldLiq = pos.liq
  if (DRY_RUN) {
    log('DRY-RUN', `Would ADD $${add.toFixed(2)} margin to ${COIN} @ mark $${markPx} (liq $${oldLiq})`)
  } else {
    const { index } = await getAssetInfo(COIN)
    const ntli = Math.round(add * 1e6)               // positive = add margin
    await exchange.updateIsolatedMargin({ asset: index, isBuy: pos.isLong, ntli })
    await sleep(1500)                                 // let HL recompute liq
  }
  totalAdded += add
  fires++
  saveState()
  const np = await getPosition()
  log('FIRE', `LIQ GUARD #${fires} | +$${add.toFixed(2)} margin @ mark $${markPx} | liq $${oldLiq} → $${np?.liq ?? '?'} | total added $${totalAdded.toFixed(2)}/$${MAX_TOTAL_ADD}${DRY_RUN ? ' [DRY]' : ''}`)
  return true
}

async function fireLevBrake(pos, markPx) {
  const { index, szDecimals } = await getAssetInfo(COIN)
  let sz = roundSz(pos.size * REDUCE_PCT, szDecimals)
  // Respect HL's $10 minimum: bump up, but never exceed the whole position.
  if (sz * markPx < HL_MIN_ORDER) sz = roundSz(Math.max(sz, HL_MIN_ORDER / markPx), szDecimals)
  if (sz > pos.size) sz = roundSz(pos.size, szDecimals)
  if (sz <= 0) { log('SKIP', `Reduce size rounds to 0 — skipping`); return false }

  const oldLiq = pos.liq
  const isBuy  = !pos.isLong                          // reduce long = sell; reduce short = buy
  const px     = roundPx(isBuy ? markPx * 1.01 : markPx * 0.99)   // IOC 1% through mark
  if (DRY_RUN) {
    log('DRY-RUN', `Would REDUCE ${sz} ${COIN} (${(REDUCE_PCT * 100).toFixed(0)}%) reduce-only @ ~$${px} (mark $${markPx}, liq $${oldLiq})`)
  } else {
    const result   = await exchange.order({
      orders: [{ a: index, b: isBuy, p: px.toString(), s: sz.toString(), r: true, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    })
    const statuses = result?.response?.data?.statuses ?? []
    const errs     = statuses.filter(s => s.error).map(s => s.error)
    if (errs.length) { log('ERROR', `Reduce order rejected: ${errs.join(', ')} — will retry`); return false }
    await sleep(1500)
  }
  fires++
  saveState()
  const np = await getPosition()
  log('FIRE', `LEV BRAKE #${fires} | reduced ${sz} ${COIN} @ mark $${markPx} | liq $${oldLiq} → $${np?.liq ?? '?'} | size ${pos.size} → ${np?.size ?? 0}${DRY_RUN ? ' [DRY]' : ''}`)
  return true
}

// ─── PAUSE (freeze; positions/orders untouched) ──────────────────────────────────
onPause(()  => log('PAUSE', 'Paused — monitoring frozen, no actions until resumed'))
onResume(() => log('RESUME', 'Resumed — monitoring again'))

// ─── TICK ─────────────────────────────────────────────────────────────────────
async function tick() {
  const pos = await getPosition()
  if (!pos) { log('DONE', `No open ${COIN} position — guardian stopping`); clearState(); process.exit(0) }
  if (pos.levType !== 'isolated') {
    log('WARN', `${COIN} position is ${pos.levType}, not isolated — guardian only manages isolated positions; stopping`)
    clearState(); process.exit(0)
  }

  const mids   = await info.allMids(MIDS_ARG)
  const markPx = parseFloat(mids[COIN] ?? 0)
  if (!markPx) { log('ERROR', `No price for ${COIN}`); return }

  const trigPx = computeTriggerPx(pos)

  if (fires >= MAX_FIRES) return            // budget spent — stay armed/idle (visible as running)
  if (Date.now() < cooldownUntil) return    // settle after a recent fire
  if (DRY_RUN && fires >= MAX_FIRES) return

  if (isTriggered(markPx, pos, trigPx)) {
    log('TRIGGER', `${MODE === 'liqguard' ? 'Liq Guard' : 'Lev Brake'} armed @ $${trigPx} hit (mark $${markPx}, liq $${pos.liq}) — firing`)
    try {
      const ok = MODE === 'liqguard' ? await fireLiqGuard(pos, markPx) : await fireLevBrake(pos, markPx)
      if (ok) {
        cooldownUntil = Date.now() + Math.max(CHECK_MS, 4000)
        const np = await getPosition()
        if (np) log('ARMED', `Re-armed ${MODE} on ${COIN} | new liq $${np.liq} | next trigger $${computeTriggerPx(np)} (fire ${fires}/${MAX_FIRES})`)
      }
    } catch (e) {
      log('ERROR', `${MODE} action failed: ${e.message} — will retry next cycle`)
    }
  }
}

// ─── MAIN LOOP ──────────────────────────────────────────────────────────────────
;(async () => {
  await resolveCoin()
  const pos0 = await getPosition()
  if (!pos0) { console.error(`ERROR: no open ${COIN} position to guard`); process.exit(1) }
  if (pos0.levType !== 'isolated') { console.error(`ERROR: ${COIN} position is ${pos0.levType}, not isolated — guardian supports isolated only`); process.exit(1) }

  // Cumulative cap: restore on auto-resume (deploy/reboot), reset on a fresh arm.
  if (RESUME) {
    const st = loadState()
    if (st) {
      totalAdded = parseFloat(st.totalAdded) || 0
      fires      = parseInt(st.fires) || 0
      log('RESUME', `Restored cumulative state — fires ${fires}/${MAX_FIRES}${MODE === 'liqguard' ? `, added $${totalAdded.toFixed(2)}/$${MAX_TOTAL_ADD}` : ''}`)
    }
  } else {
    clearState()   // fresh arm — start the cap counter over
  }

  const trigDesc = TRIGGER_PRICE > 0 ? `$${TRIGGER_PRICE} (abs)` : `${(TRIGGER_PCT * 100).toFixed(0)}% to liq`
  const actDesc  = MODE === 'liqguard'
    ? `${TARGET_LEV > 0 ? `target ${TARGET_LEV}x` : `add $${ADD_USD}`}/fire, cap $${MAX_TOTAL_ADD}`
    : `reduce ${(REDUCE_PCT * 100).toFixed(0)}%/fire`
  log('START', `Guardian ${MODE === 'liqguard' ? 'LIQ GUARD' : 'LEV BRAKE'} on ${COIN} ${pos0.isLong ? 'LONG' : 'SHORT'} | entry $${pos0.entry} liq $${pos0.liq} | trigger ${trigDesc} | ${actDesc} | maxFires ${MAX_FIRES}${DRY_RUN ? ' | DRY-RUN' : ''}`)
  log('ARMED', `Watching ${COIN} | armed trigger $${computeTriggerPx(pos0)} (mark approaches liq)`)

  while (true) {
    if (!isPaused()) {
      try { await tick() } catch (e) { log('ERROR', e.message) }
    }
    await sleep(CHECK_MS)
  }
})().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
