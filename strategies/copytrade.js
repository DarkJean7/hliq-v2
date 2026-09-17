#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Copy Trade Bot
 *
 * Follows another wallet and mirrors its perp trades onto yours, scaled down.
 *
 * Usage:
 *   node strategies/copytrade.js \
 *     --wallet 0xAGENT_KEY --address 0xMY_MASTER \
 *     --target 0xTHEIR_WALLET --scale 25 --max-usd 250 \
 *     [--coins BTC,HYPE] [--max-position 0] [--leverage 0] [--interval 30] [--dry-run]
 *
 * ─── HOW IT MIRRORS ──────────────────────────────────────────────────────────
 * Opens and adds: scale% of their size, capped per trade and per position.
 * Exits: the same FRACTION of our copy as they took off theirs. A full exit is a full exit,
 * whatever the caps did on the way in. src/copymirror.js has the rules and the two money-
 * losing bugs the old "scale% of every delta" rule had.
 *
 * The bot keeps its own record of what IT opened in each coin (`mine`), and only ever
 * unwinds that. A position the user holds by hand in the same coin is not its to close.
 * That record is persisted, so a deploy or reboot does not leave copied positions orphaned
 * with nothing left that knows to close them.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not replay history. The cursor starts at launch, so following someone does not
 * immediately buy their entire existing book at today's prices — which would be the single
 * most expensive way to start. You mirror what they do NEXT, and when they later close
 * something that was open before you started, nothing happens on your side.
 *
 * The one exception is a restart: if this same follow was running a few minutes ago, it
 * picks up from where it stopped, so a deploy does not silently skip their trades.
 *
 * It does not mirror spot or builder-dex (HIP-3) fills. Only coins in the main perp
 * universe are actionable here; anything else is logged and skipped rather than guessed at.
 *
 * ─── DRY RUN ─────────────────────────────────────────────────────────────────
 * --dry-run places nothing. Every order is filled on paper at the mark, and the bot keeps a
 * running P&L of what the copy would have made — the honest way to find out whether a wallet
 * is worth following before any money is behind it.
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isPaused } from './_pause.js'
import { botCloid } from '../src/cloid.js'
import { planMirror, burstRange, reconcileMine } from '../src/copymirror.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:         { type: 'string' },
    address:        { type: 'string' },
    target:         { type: 'string' },                    // the wallet being followed
    scale:          { type: 'string', default: '25'  },    // % of their trade size
    'max-usd':      { type: 'string', default: '250' },    // cap per mirrored OPEN
    'max-position': { type: 'string', default: '0'   },    // USD cap per coin, 0 = none
    coins:          { type: 'string', default: ''    },    // allowlist, empty = all
    leverage:       { type: 'string', default: '0'   },    // 0 = leave account setting alone
    interval:       { type: 'string', default: '30'  },    // seconds between polls
    'dry-run':      { type: 'boolean', default: false },   // simulate; place nothing
    'paper-target': { type: 'string' },                    // follow a PAPER account by name
  },
  allowPositionals: false,
  strict: false,   // tolerate unknown flags from older/newer UIs
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

/**
 * Who is being followed: a wallet, or a PAPER account by name.
 *
 * A paper account trades only on its owner's device, so there is no address to query. What it
 * does reach is our own leaderboard: the app posts each paper account's fills with its board
 * row, so the bot reads the same trades from there in the same shape Hyperliquid returns —
 * which is the whole reason planMirror needs no idea which kind of target this is.
 *
 * The orders it places are real either way. Following a simulated trader with real money is
 * the user's call; the sheet says so plainly before it starts.
 */
const PAPER_TARGET = String(args['paper-target'] ?? '').trim()
const TARGET = PAPER_TARGET || String(args.target ?? '').trim()
if (!PAPER_TARGET && !/^0x[0-9a-fA-F]{40}$/.test(TARGET)) {
  console.error('ERROR: --target must be a wallet address, or use --paper-target <name>')
  process.exit(1)
}
// Our own server, on the same box. HLIQ_API overrides it for a local run.
const API_BASE = process.env.HLIQ_API ?? 'http://127.0.0.1:3002'

const SCALE        = Math.max(0, parseFloat(args.scale) || 0) / 100
const MAX_USD      = Math.max(0, parseFloat(args['max-usd']) || 0)
const MAX_POSITION = Math.max(0, parseFloat(args['max-position']) || 0)
const LEVERAGE     = Math.max(0, parseInt(args.leverage) || 0)
const INTERVAL_MS  = Math.max(10, parseInt(args.interval) || 30) * 1000
const DRY_RUN      = !!args['dry-run']
const ONLY = new Set(String(args.coins ?? '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean))

const SLIPPAGE     = 0.005   // wider than DCA's: we are chasing someone else's fill
// A restart within this long of the last save resumes the cursor instead of starting at
// "now". Long enough to cover a deploy and the staggered resume; short enough that
// stopping a follow and starting it again tomorrow does not replay a day of trades.
const RESUME_WINDOW_MS = 15 * 60 * 1000

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const QUERY_ADDR  = args.address ?? etherWallet.address   // master wallet for reads

if (!PAPER_TARGET && QUERY_ADDR.toLowerCase() === TARGET.toLowerCase()) {
  console.error('ERROR: --target is this account. A wallet cannot follow itself.')
  process.exit(1)
}

// ─── LOGGING ──────────────────────────────────────────────────────────────────
function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  let m = msg
  if (tag.trim() === 'ERROR' && typeof m === 'string') {
    const h = m.search(/<\s*html/i)
    if (h !== -1) m = m.slice(0, h).replace(/[-\s]+$/, '').trim() || ((m.match(/<title>([^<]+)<\/title>/i) || [])[1] || 'HTML error').trim()
    m = m.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  console.log(`[${ts}] [${tag.padEnd(8)}] ${m}`)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const short = (a) => PAPER_TARGET ? `paper "${a}"` : a.slice(0, 6) + '…' + a.slice(-4)

/**
 * The target's fills since `startTime`, from Hyperliquid for a wallet or from our own
 * leaderboard for a paper account. Same shape both ways (HL's), so nothing downstream cares.
 */
async function fetchTargetFills(startTime) {
  if (!PAPER_TARGET) return await info.userFillsByTime({ user: TARGET, startTime })
  const r = await fetch(`${API_BASE}/api/leaderboard/paper/one?name=${encodeURIComponent(PAPER_TARGET)}&since=${Math.max(0, startTime - 1)}`)
  if (!r.ok) throw new Error(`paper feed ${r.status}`)
  const j = await r.json()
  return j?.fills ?? []
}

/** The target's open positions, for the exit retry. Paper positions come with its board row. */
async function fetchTargetPositions() {
  if (!PAPER_TARGET) {
    const cs = await info.clearinghouseState({ user: TARGET })
    const out = {}
    for (const ap of (cs.assetPositions ?? [])) out[ap.position.coin] = parseFloat(ap.position.szi ?? 0)
    return out
  }
  const r = await fetch(`${API_BASE}/api/leaderboard/paper/one?name=${encodeURIComponent(PAPER_TARGET)}`)
  if (!r.ok) throw new Error(`paper feed ${r.status}`)
  const j = await r.json()
  const out = {}
  for (const ap of (j?.row?.positions ?? [])) {
    const pos = ap.position ?? ap
    out[pos.coin] = parseFloat(pos.szi ?? 0)
  }
  return out
}

// ─── ROUNDING (same tick rules as the other bots) ─────────────────────────────
function roundPx(n, szDecimals) {
  const f = parseFloat(n)
  if (!(f > 0)) return 0
  const sig = parseFloat(f.toPrecision(5))
  if (szDecimals == null) return sig
  const maxDec = Math.max(0, 6 - szDecimals)
  const factor = Math.pow(10, maxDec)
  return Math.round(sig * factor) / factor
}

function roundSz(n, szDecimals = 6) {
  const factor = Math.pow(10, szDecimals)
  // The epsilon is for exits. The copy is held in exact lot sizes, and 0.29 × 100 is
  // 28.999999… in floating point: a plain floor closed 0.28 and left 0.01 behind.
  return Math.floor(Math.abs(parseFloat(n)) * factor + 1e-9) / factor
}

// ─── ASSET INDEX CACHE ────────────────────────────────────────────────────────
let _metaCache = null

async function loadMeta() {
  const meta = await info.meta()
  _metaCache = {}
  ;(meta.universe ?? []).forEach((u, i) => {
    // A delisted market still answers meta. Copying into one is a position with no exit.
    if (u.isDelisted) return
    _metaCache[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 }
  })
  return _metaCache
}

// ─── STATE ────────────────────────────────────────────────────────────────────
// Keyed by follower + target, and by mode: a paper copy must never be read as holding a real
// position, or a live follow started later would try to close something that does not exist.
const STATE_FILE = path.join(process.cwd(), '.copytrade-state.json')
const STATE_KEY  = `${QUERY_ADDR.toLowerCase()}:${PAPER_TARGET ? 'paper:' : ''}${TARGET.toLowerCase()}${DRY_RUN ? ':dry' : ''}`

let mine     = {}   // coin → signed size this bot opened and still holds
let carry    = {}   // coin → signed size of opens waiting to clear the $10 minimum
let cursor   = Date.now()
let paper    = { realized: 0, entry: {} }   // dry-run only: coin → avg entry
let seen     = new Set()                    // fill tids already mirrored

function _readAll() { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
function loadState() {
  const s = _readAll()[STATE_KEY]
  if (!s) return null
  mine  = s.mine  ?? {}
  paper = s.paper ?? paper
  return s
}
// Fill ids already copied, carried across a restart. The first poll after a resume re-asks
// from a minute before the saved cursor, and without these every fill in that minute would
// be copied a second time.
function restoreSeen(s) {
  for (const t of (s?.seen ?? [])) seen.add(t)
}
function saveState() {
  try {
    const all = _readAll()
    all[STATE_KEY] = { mine, paper, cursor, seen: [...seen].slice(-500), ts: Date.now() }
    writeFileSync(STATE_FILE, JSON.stringify(all, null, 2))
  } catch (e) { log('WARN', `Could not persist state: ${e.message}`) }
}

// ─── POSITIONS ────────────────────────────────────────────────────────────────
async function getPositions() {
  const state = await info.clearinghouseState({ user: QUERY_ADDR })
  const out = {}
  for (const ap of (state.assetPositions ?? [])) {
    const szi = parseFloat(ap.position?.szi ?? 0)
    if (szi !== 0) out[ap.position.coin] = szi
  }
  return out
}

// ─── ORDER ────────────────────────────────────────────────────────────────────
async function place(coin, delta, markPx, reduceOnly) {
  const { index, szDecimals } = _metaCache[coin]
  const sz = roundSz(delta, szDecimals)
  if (sz <= 0) return { filledSz: 0, avgPx: 0 }

  if (DRY_RUN) return { filledSz: sz, avgPx: markPx }

  const isBuy   = delta > 0
  const limitPx = isBuy ? markPx * (1 + SLIPPAGE) : markPx * (1 - SLIPPAGE)
  const result  = await exchange.order({
    orders: [{
      c: botCloid(process.env.HLIQ_BOT),
      a: index,
      b: isBuy,
      p: roundPx(limitPx, szDecimals).toString(),
      s: sz.toString(),
      r: reduceOnly,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))
  const filled = statuses[0]?.filled
  return { filledSz: parseFloat(filled?.totalSz ?? 0), avgPx: parseFloat(filled?.avgPx ?? 0) }
}

// Paper book: average entry per coin, and realized P&L as the copy is reduced.
function paperFill(coin, signedSz, px) {
  const held  = mine[coin] ?? 0
  const entry = paper.entry[coin] ?? px
  if (held === 0 || Math.sign(held) === Math.sign(signedSz)) {
    const next = held + signedSz
    paper.entry[coin] = (Math.abs(held) * entry + Math.abs(signedSz) * px) / Math.abs(next)
    return 0
  }
  const closed = Math.min(Math.abs(signedSz), Math.abs(held))
  const pnl    = closed * (px - entry) * Math.sign(held)
  paper.realized += pnl
  if (Math.abs(held + signedSz) < 1e-12) delete paper.entry[coin]
  return pnl
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
const levelled = new Set()
async function run() {
  log('START', '═'.repeat(60))
  log('START', `Copy Trade Bot${DRY_RUN ? '  —  DRY RUN (no orders are placed)' : ''}`)
  log('START', `Following: ${PAPER_TARGET ? `paper account "${PAPER_TARGET}" (simulated trader)` : TARGET}`)
  log('START', `Onto:      ${QUERY_ADDR}`)
  log('START', `Scale:     ${(SCALE * 100).toFixed(1)}% of their size  |  Max ${MAX_USD > 0 ? '$' + MAX_USD : 'unlimited'} per open`)
  log('START', `Coins:     ${ONLY.size ? [...ONLY].join(', ') : 'all perps'}  |  Max position: ${MAX_POSITION > 0 ? '$' + MAX_POSITION : 'unlimited'}`)
  log('START', `Leverage:  ${LEVERAGE > 0 ? LEVERAGE + 'x' : 'account default'}  |  Poll every ${INTERVAL_MS / 1000}s`)
  log('START', 'Exits mirror the fraction they close, uncapped. Only positions this bot opened are ever closed.')
  log('START', '═'.repeat(60))

  if (!(SCALE > 0)) { log('ERROR', 'Scale is 0% — nothing would ever be mirrored.'); process.exit(1) }

  await loadMeta()

  const saved = loadState()
  if (saved && Date.now() - (saved.ts ?? 0) < RESUME_WINDOW_MS && saved.cursor > 0) {
    cursor = saved.cursor
    restoreSeen(saved)
    log('RESUME', `Picking up from ${new Date(cursor).toISOString()} — trades made while this was down are copied now.`)
  } else {
    cursor = Date.now()
    log('INIT', 'Watching from now. Past trades are not copied.')
  }
  const held = Object.entries(mine).filter(([, v]) => v)
  if (held.length) log('INIT', `Managing copied positions: ${held.map(([c, v]) => `${c} ${v > 0 ? '+' : ''}${v}`).join(', ')}`)
  saveState()

  let idle = 0
  while (true) {
    if (isPaused()) { await sleep(INTERVAL_MS); continue }
    try {
      // Re-ask from slightly before the cursor: HL can surface a fill a beat late, and the
      // tid set is what actually prevents a double-mirror (fill HASHES repeat and are
      // useless for identity).
      const fills = await fetchTargetFills(cursor - 60_000)
      const fresh = (fills ?? []).filter(f => !seen.has(f.tid) && +f.time >= cursor - 60_000)
        .sort((a, b) => a.time - b.time)

      if (!fresh.length) {
        if (++idle % 20 === 0) log('WAIT', `No new trades from ${short(TARGET)} (${idle} checks)`)
        await sleep(INTERVAL_MS)
        continue
      }
      idle = 0

      // Group the burst per coin. Someone closing 10 in three fills is ONE order for us,
      // not three sub-minimum ones — and it costs a third of the fees.
      const byCoin = {}
      for (const f of fresh) {
        seen.add(f.tid)
        cursor = Math.max(cursor, +f.time)
        const coin = f.coin
        if (!_metaCache[coin]) {
          if (!String(coin).startsWith('@')) log('SKIP', `${coin} — not a main-dex perp (spot or builder dex)`)
          continue
        }
        if (ONLY.size && !ONLY.has(coin)) continue
        ;(byCoin[coin] ??= []).push(f)
      }

      if (Object.keys(byCoin).length) {
        const mids = await info.allMids()
        const ours = DRY_RUN ? null : await getPositions()

        for (const [coin, cf] of Object.entries(byCoin)) {
          // Both ends come from the fills, not from adding them up: if one is missing, the sum
          // invents a position they never held. See burstRange.
          const range = burstRange(cf)
          if (!range || range.before == null) { log('ERROR', `${coin}: fills carry no start position — skipped`); continue }
          const theirBefore = range.before
          const theirDelta  = range.after - range.before
          if (Math.abs(theirDelta) < 1e-12) continue
          const markPx = parseFloat(mids[coin] ?? 0)
          if (!(markPx > 0)) { log('ERROR', `No price for ${coin}`); continue }

          // What we really hold. In a dry run the paper book IS the position.
          if (!DRY_RUN) {
            const was = mine[coin] ?? 0
            mine[coin] = reconcileMine(was, ours[coin] ?? 0)
            if (was && mine[coin] !== was) log('SYNC', `${coin} copy was ${was}, account holds ${ours[coin] ?? 0} — tracking ${mine[coin]}`)
          }

          const plan = planMirror({
            theirBefore, theirDelta, mine: mine[coin] ?? 0, carry: carry[coin] ?? 0,
            scale: SCALE, maxUsd: MAX_USD, maxPosition: MAX_POSITION, markPx,
          })
          carry[coin] = plan.carry
          const theirs = `${theirDelta > 0 ? '+' : ''}${+theirDelta.toFixed(6)} (${theirBefore} → ${+(theirBefore + theirDelta).toFixed(6)})`
          for (const n of plan.notes) log(/minimum|nothing|other side/.test(n) ? 'CARRY' : 'CAP', `${coin} ${n} — they ${theirs}`)

          for (const o of plan.orders) {
            if (!o.reduceOnly && LEVERAGE > 0 && !levelled.has(coin) && !DRY_RUN) {
              try {
                await exchange.updateLeverage({ asset: _metaCache[coin].index, isCross: true, leverage: LEVERAGE })
                levelled.add(coin)
                log('INIT', `Leverage ${LEVERAGE}x cross on ${coin}`)
              } catch (e) { log('WARN', `Could not set leverage on ${coin}: ${e.message}`) }
            }
            try {
              const { filledSz, avgPx } = await place(coin, o.delta, markPx, o.reduceOnly)
              if (filledSz > 0) {
                const px     = avgPx || markPx
                const signed = Math.sign(o.delta) * filledSz
                const pnl    = DRY_RUN ? paperFill(coin, signed, px) : 0
                mine[coin]   = +((mine[coin] ?? 0) + signed).toFixed(8)
                if (Math.abs(mine[coin]) < 1e-12) delete mine[coin]
                // An IOC can fill in part. For an exit the rest still has to go.
                if (o.reduceOnly && filledSz < roundSz(o.delta, _metaCache[coin].szDecimals) - 1e-12) pendingExit[coin] = true
                log(DRY_RUN ? 'PAPER' : 'COPY',
                  `${o.delta > 0 ? 'BUY ' : 'SELL'} ${filledSz} ${coin} @ $${px.toFixed(4)} (~$${(filledSz * px).toFixed(2)}) [${o.kind}${o.reduceOnly ? ', reduce-only' : ''}] — they ${theirs}`
                  + (DRY_RUN && o.reduceOnly ? ` | P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}, total ${paper.realized >= 0 ? '+' : ''}$${paper.realized.toFixed(2)} before fees` : ''))
              } else if (o.reduceOnly) {
                // An exit that did not fill must be retried, not forgotten: we would be left
                // holding a position they have left. retryExits() closes it from `mine`.
                log('MISS', `${coin} exit IOC did not fill — retrying next check`)
                pendingExit[coin] = true
              } else {
                // An open that missed the slippage cap is let go. Chasing it later would buy
                // at a price they never paid.
                log('MISS', `${coin} IOC did not fill within ${(SLIPPAGE * 100).toFixed(1)}% — open skipped`)
              }
            } catch (e) {
              log('ERROR', `${coin}: ${e.message}`)
              if (o.reduceOnly) pendingExit[coin] = true
            }
          }
        }
      }

      await retryExits()

      // The tid set only needs to cover the re-ask window; unbounded it would grow for
      // as long as the bot runs.
      if (seen.size > 4000) seen = new Set([...seen].slice(-1000))
      saveState()
    } catch (e) {
      log('ERROR', e.message)
    }
    await sleep(INTERVAL_MS)
  }
}

// ─── EXITS THAT DID NOT FILL ──────────────────────────────────────────────────
// Only closes are retried, and only toward where the TARGET is now: if they have since
// re-entered, their new fills are mirrored normally and the retry is dropped.
const pendingExit = {}
async function retryExits() {
  const coins = Object.keys(pendingExit)
  if (!coins.length) return
  let theirs
  try { theirs = await fetchTargetPositions() } catch { return }
  const mids = await info.allMids()
  const ours = DRY_RUN ? null : await getPositions()
  for (const coin of coins) {
    if (!DRY_RUN) mine[coin] = reconcileMine(mine[coin] ?? 0, ours[coin] ?? 0)
    const m = mine[coin] ?? 0
    const t = theirs[coin] ?? 0
    // They are back on our side: the copy is wanted again, nothing to retry.
    if (!m || (t && Math.sign(t) === Math.sign(m))) { delete pendingExit[coin]; continue }
    const px = parseFloat(mids[coin] ?? 0)
    if (!(px > 0)) continue
    try {
      const { filledSz } = await place(coin, -m, px, true)
      if (filledSz > 0) {
        mine[coin] = +(m - Math.sign(m) * filledSz).toFixed(8)
        if (Math.abs(mine[coin]) < 1e-12) { delete mine[coin]; delete pendingExit[coin] }
        log('COPY', `${coin} retried exit filled ${filledSz}`)
      }
    } catch (e) { log('ERROR', `${coin} exit retry: ${e.message}`) }
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
