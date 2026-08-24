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
 *     [--coins BTC,HYPE] [--max-position 0] [--leverage 0] [--interval 30]
 *
 * ─── HOW IT MIRRORS ──────────────────────────────────────────────────────────
 * By SIGNED SIZE DELTA, not by "they opened a long, so open a long". Every fill is
 * ±size; we apply scale% of that delta to our own book. Opens, adds, partial closes,
 * full closes and outright flips all fall out of the same arithmetic, and our position
 * tracks theirs proportionally without the bot having to classify the trade.
 *
 * ─── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 * It does not replay history. The cursor starts at launch, so following someone does
 * not immediately buy their entire existing book at today's prices — which would be
 * the single most expensive way to start. You mirror what they do NEXT.
 *
 * It does not mirror spot or builder-dex (HIP-3) fills. Only coins in the main perp
 * universe are actionable here; anything else is logged and skipped rather than
 * guessed at.
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers }    from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused } from './_pause.js'

// ─── CLI ARGS ─────────────────────────────────────────────────────────────────
const { values: args } = parseArgs({
  options: {
    wallet:         { type: 'string' },
    address:        { type: 'string' },
    target:         { type: 'string' },                    // the wallet being followed
    scale:          { type: 'string', default: '25'  },    // % of their trade size
    'max-usd':      { type: 'string', default: '250' },    // cap per mirrored trade
    'max-position': { type: 'string', default: '0'   },    // USD cap per coin, 0 = none
    coins:          { type: 'string', default: ''    },    // allowlist, empty = all
    leverage:       { type: 'string', default: '0'   },    // 0 = leave account setting alone
    interval:       { type: 'string', default: '30'  },    // seconds between polls
  },
  allowPositionals: false,
  strict: false,   // tolerate unknown flags from older/newer UIs
})

const walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) {
  console.error('ERROR: agent key not provided')
  process.exit(1)
}

const TARGET = String(args.target ?? '').trim()
if (!/^0x[0-9a-fA-F]{40}$/.test(TARGET)) {
  console.error('ERROR: --target must be a wallet address')
  process.exit(1)
}

const SCALE        = Math.max(0, parseFloat(args.scale) || 0) / 100
const MAX_USD      = Math.max(0, parseFloat(args['max-usd']) || 0)
const MAX_POSITION = Math.max(0, parseFloat(args['max-position']) || 0)
const LEVERAGE     = Math.max(0, parseInt(args.leverage) || 0)
const INTERVAL_MS  = Math.max(10, parseInt(args.interval) || 30) * 1000
const ONLY = new Set(String(args.coins ?? '').split(',').map(c => c.trim().toUpperCase()).filter(Boolean))

const SLIPPAGE     = 0.005   // wider than DCA's: we are chasing someone else's fill
const HL_MIN_ORDER = 10      // USD — HL rejects orders below this notional

// ─── CLIENTS ──────────────────────────────────────────────────────────────────
const transport   = new HttpTransport()
const info        = new InfoClient({ transport })
const etherWallet = new ethers.Wallet(walletKey)
const exchange    = new ExchangeClient({ transport, wallet: etherWallet })
const QUERY_ADDR  = args.address ?? etherWallet.address   // master wallet for reads

if (QUERY_ADDR.toLowerCase() === TARGET.toLowerCase()) {
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
  return Math.floor(Math.abs(parseFloat(n)) * factor) / factor
}

// ─── ASSET INDEX CACHE ────────────────────────────────────────────────────────
let _metaCache = null

async function loadMeta() {
  const meta = await info.meta()
  _metaCache = {}
  ;(meta.universe ?? []).forEach((u, i) => {
    _metaCache[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 }
  })
  return _metaCache
}

// ─── POSITION ────────────────────────────────────────────────────────────────
async function getPositions() {
  const state = await info.clearinghouseState({ user: QUERY_ADDR })
  const out = {}
  for (const ap of (state.assetPositions ?? [])) {
    const szi = parseFloat(ap.position?.szi ?? 0)
    if (szi !== 0) out[ap.position.coin] = { szi, value: Math.abs(parseFloat(ap.position.positionValue ?? 0)) }
  }
  return out
}

// ─── ORDER ────────────────────────────────────────────────────────────────────
/**
 * @param delta signed size to apply to our book (+ buy, − sell)
 * @param ourSzi our current signed position, so a reducing order can be marked
 *               reduce-only — that is what stops a mistimed mirror from opening
 *               the opposite side when we are already smaller than they are.
 */
async function applyDelta(coin, delta, markPx, ourSzi) {
  const { index, szDecimals } = _metaCache[coin]
  const isBuy = delta > 0
  const sz    = roundSz(delta, szDecimals)
  if (sz <= 0) return { filledSz: 0, avgPx: 0 }

  // Reducing, and not past flat: reduce-only is safe and strictly better.
  const reducing = ourSzi !== 0 && Math.sign(delta) !== Math.sign(ourSzi) && sz <= Math.abs(ourSzi)

  const limitPx = isBuy ? markPx * (1 + SLIPPAGE) : markPx * (1 - SLIPPAGE)
  const result  = await exchange.order({
    orders: [{
      a: index,
      b: isBuy,
      p: roundPx(limitPx, szDecimals).toString(),
      s: sz.toString(),
      r: reducing,
      t: { limit: { tif: 'Ioc' } },
    }],
    grouping: 'na',
  })

  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  if (errors.length) throw new Error(errors.join(', '))
  const filled = statuses[0]?.filled
  return { filledSz: parseFloat(filled?.totalSz ?? 0), avgPx: parseFloat(filled?.avgPx ?? 0), reducing }
}

// ─── MAIN LOOP ────────────────────────────────────────────────────────────────
//
// Below HL's $10 minimum an order simply cannot be placed. At a 25% scale that would
// silently drop most of a small trader's activity, so undersized deltas are CARRIED
// per coin and fire once they stack past the minimum. The mirror stays faithful; it
// just arrives in lumps.
const carry    = {}   // coin → signed size waiting to be placed
const levelled = new Set()
let   seen     = new Set()   // fill tids already mirrored

async function run() {
  log('START', '═'.repeat(60))
  log('START', 'Copy Trade Bot')
  log('START', `Following: ${TARGET}`)
  log('START', `Onto:      ${QUERY_ADDR}`)
  log('START', `Scale:     ${(SCALE * 100).toFixed(1)}% of their size  |  Max ${MAX_USD > 0 ? '$' + MAX_USD : 'unlimited'} per trade`)
  log('START', `Coins:     ${ONLY.size ? [...ONLY].join(', ') : 'all perps'}  |  Max position: ${MAX_POSITION > 0 ? '$' + MAX_POSITION : 'unlimited'}`)
  log('START', `Leverage:  ${LEVERAGE > 0 ? LEVERAGE + 'x' : 'account default'}  |  Poll every ${INTERVAL_MS / 1000}s`)
  log('START', '═'.repeat(60))

  if (!(SCALE > 0)) { log('ERROR', 'Scale is 0% — nothing would ever be mirrored.'); process.exit(1) }

  await loadMeta()

  // History is NOT replayed. Anything they did before this moment is theirs alone.
  let cursor = Date.now()
  log('INIT', `Watching from now. Past trades are not copied.`)

  let idle = 0
  while (true) {
    if (isPaused()) { await sleep(INTERVAL_MS); continue }
    try {
      // Re-ask from slightly before the cursor: HL can surface a fill a beat late, and
      // the tid set is what actually prevents a double-mirror (fill HASHES repeat and
      // are useless for identity).
      const fills = await info.userFillsByTime({ user: TARGET, startTime: cursor - 60_000 })
      const fresh = (fills ?? []).filter(f => !seen.has(f.tid)).sort((a, b) => a.time - b.time)

      if (!fresh.length) {
        if (++idle % 20 === 0) log('WAIT', `No new trades from ${TARGET.slice(0, 6)}…${TARGET.slice(-4)} (${idle} checks)`)
        await sleep(INTERVAL_MS)
        continue
      }
      idle = 0

      // Net the burst per coin. Someone closing 10 in three fills is ONE order for us,
      // not three sub-minimum ones — and it costs a third of the fees.
      const net = {}
      for (const f of fresh) {
        seen.add(f.tid)
        cursor = Math.max(cursor, f.time)
        const coin = f.coin
        if (!_metaCache[coin]) { log('SKIP', `${coin} — not a main-dex perp (spot or builder dex)`); continue }
        if (ONLY.size && !ONLY.has(coin)) continue
        const signed = (f.side === 'B' ? 1 : -1) * parseFloat(f.sz ?? 0)
        net[coin] = (net[coin] ?? 0) + signed
      }

      if (!Object.keys(net).length) { await sleep(INTERVAL_MS); continue }

      const mids = await info.allMids()
      const ours = await getPositions()

      for (const [coin, theirDelta] of Object.entries(net)) {
        if (theirDelta === 0) continue
        const markPx = parseFloat(mids[coin] ?? 0)
        if (!(markPx > 0)) { log('ERROR', `No price for ${coin}`); continue }

        let delta = theirDelta * SCALE + (carry[coin] ?? 0)

        // Cap the notional. Clamping keeps the direction and drops the excess — the
        // carry is NOT credited here, or a whale's single trade would queue up and
        // leak out over the following hours long after the move was over.
        if (MAX_USD > 0 && Math.abs(delta) * markPx > MAX_USD) {
          log('CAP', `${coin} ${(Math.abs(delta) * markPx).toFixed(0)} → $${MAX_USD} per-trade cap`)
          delta = Math.sign(delta) * (MAX_USD / markPx)
        }

        const ourSzi = ours[coin]?.szi ?? 0

        // Position cap applies to opening only — never block someone getting out.
        if (MAX_POSITION > 0 && Math.sign(delta) === Math.sign(ourSzi || delta)) {
          const have = (ours[coin]?.value ?? 0)
          if (have >= MAX_POSITION) { log('SKIP', `${coin} at $${have.toFixed(0)} ≥ max $${MAX_POSITION}`); carry[coin] = 0; continue }
          const room = (MAX_POSITION - have) / markPx
          if (Math.abs(delta) > room) delta = Math.sign(delta) * room
        }

        const { szDecimals } = _metaCache[coin]
        const notional = Math.abs(delta) * markPx
        // A close is exempt from the minimum: if we hold a dust position they just
        // exited, we must be allowed to exit too.
        const closing  = ourSzi !== 0 && Math.sign(delta) !== Math.sign(ourSzi)
        if (notional < HL_MIN_ORDER && !closing) {
          carry[coin] = delta
          log('CARRY', `${coin} $${notional.toFixed(2)} < $${HL_MIN_ORDER} min — held until it stacks`)
          continue
        }
        if (roundSz(delta, szDecimals) <= 0) { carry[coin] = delta; continue }

        if (LEVERAGE > 0 && !levelled.has(coin)) {
          try {
            await exchange.updateLeverage({ asset: _metaCache[coin].index, isCross: true, leverage: LEVERAGE })
            levelled.add(coin)
            log('INIT', `Leverage ${LEVERAGE}x cross on ${coin}`)
          } catch (e) { log('WARN', `Could not set leverage on ${coin}: ${e.message}`) }
        }

        try {
          const { filledSz, avgPx, reducing } = await applyDelta(coin, delta, markPx, ourSzi)
          if (filledSz > 0) {
            carry[coin] = 0
            const px = avgPx || markPx
            log('COPY', `${delta > 0 ? 'BUY ' : 'SELL'} ${filledSz} ${coin} @ $${px.toFixed(4)} (~$${(filledSz * px).toFixed(2)})${reducing ? ' [reduce-only]' : ''} — mirroring ${theirDelta > 0 ? '+' : ''}${theirDelta.toFixed(4)}`)
          } else {
            // The IOC missed the slippage cap. Keep the delta so the next poll retries
            // rather than silently falling behind their book.
            carry[coin] = delta
            log('MISS', `${coin} IOC did not fill — carried to next check`)
          }
        } catch (e) {
          carry[coin] = 0
          log('ERROR', `${coin}: ${e.message}`)
        }
      }

      // The tid set only needs to cover the re-ask window; unbounded it would grow for
      // as long as the bot runs.
      if (seen.size > 4000) seen = new Set([...seen].slice(-1000))

    } catch (e) {
      log('ERROR', e.message)
    }
    await sleep(INTERVAL_MS)
  }
}

run().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
