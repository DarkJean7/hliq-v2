/**
 * A portfolio, run live: the decisions, with no exchange in sight.
 *
 * strategies/portfolio.js is the bot — it fetches prices, places orders and keeps state on
 * disk. Everything it DECIDES is here, pure, so the same rules the /portfolios backtest
 * simulates (src/pfbacktest.js simulate()) can be tested without a wallet: which day is a
 * rebalancing day, what each holding should be, which orders close the gap.
 *
 * THE LEDGER. A Hyperliquid account nets every position per market, and the same account may
 * hold the coin by hand or under another bot. So the bot never reads "the BTC position" as its
 * own: it keeps a ledger of what IT bought — units per market and the cash it has left — and
 * trades the difference between its ledger and its targets. Its equity is that ledger marked
 * at the current price, which is the backtest's own arithmetic:
 *   equity = reserve + cash + Σ units × price          (cash goes negative with leverage)
 * The exchange is consulted only to catch the ledger claiming more than exists (reconcile).
 *
 * Spot holdings are skipped: no bot here trades spot yet, and their weight is spread over the
 * rest. The launch screen lists them, so a skipped holding is never a silent one.
 */

export const LIVE_STRATEGIES = ['hold', 'monthly', 'weekly', 'band', 'dca', 'trend']
export const HL_MIN_ORDER = 10                   // USD: Hyperliquid refuses smaller orders
export const LIVE_DEFAULTS = { monthDay: 1, weekDay: 1, band: 0.05, dcaEvery: 7, dcaBuys: 8, dcaUpfront: 0, trendDays: 50, trendBuffer: 0 }
const DAY = 86_400_000
export const dayOf = (t) => Math.floor(t / DAY) * DAY

/** A holding no bot can trade yet: spot (`@N`, or kind 'spot'). */
export const isSpotItem = (i) => String(i.coin ?? '').startsWith('@') || i.kind === 'spot'

/**
 * The weights the bot trades: signed (a short is negative), Σ|w| = 1, over the holdings it
 * can trade. → { weights: { coin: w }, skipped: [coin] }
 */
export function liveWeights(items) {
  const skipped = [], live = []
  for (const i of items ?? []) {
    const w = Number(i.w ?? i.weight)
    if (!(w > 0)) continue
    if (isSpotItem(i)) { skipped.push(i.coin); continue }
    live.push([i.coin, i.side === 'short' ? -w : w])
  }
  const sum = live.reduce((a, [, w]) => a + Math.abs(w), 0)
  return { weights: sum > 0 ? Object.fromEntries(live.map(([c, w]) => [c, w / sum])) : {}, skipped }
}

/** Each market's leverage: asked (a number or 'max'), capped at that market's maximum. */
export function liveLeverage(lev, maxLev) {
  const m = Number(maxLev) > 0 ? Number(maxLev) : 1
  if (lev === 'max') return m
  return Math.max(1, Math.min(m, Math.round(Number(lev) || 1)))
}

/** A ledger for a new run. DCA starts in reserve and is released buy by buy. */
export function freshLedger(budget, strategy, now) {
  const dca = strategy === 'dca'
  return { v: 1, startedAt: now, budget, cash: dca ? 0 : budget, reserve: dca ? budget : 0, units: {},
    lastRebal: null, lastEval: null, dcaDone: 0, trendOn: null, fees: 0, trades: 0 }
}

/** The ledger marked at `px`. Null when a held market has no price: unknown, not zero. */
export function equityOf(ledger, px) {
  let v = 0
  for (const [c, u] of Object.entries(ledger.units ?? {})) {
    if (!u) continue
    if (!(px[c] > 0)) return null
    v += u * px[c]
  }
  return ledger.reserve + ledger.cash + v
}

/** Trailing simple average of `closes` (oldest first), the last `n`. Null with too few. */
export function smaOf(closes, n) {
  const xs = (closes ?? []).filter(x => x > 0)
  if (xs.length < Math.min(n, 2)) return null
  const tail = xs.slice(-n)
  return tail.reduce((a, x) => a + x, 0) / tail.length
}

/**
 * What to do now. Pure.
 *   strategy, params (LIVE_DEFAULTS' keys), weights (liveWeights), ledger, px { coin: price },
 *   levBy { coin: leverage }, now (ms), sma { coin: average } (trend only)
 * → { due, reason, targets: { coin: units } | null, release: $ from reserve to cash, trendOn }
 * `due` false means hold still; `reason` says why either way, for the log.
 */
export function decide({ strategy, params = {}, weights, ledger, px, levBy = {}, now, sma = {} }) {
  const p = { ...LIVE_DEFAULTS, ...params }
  const keys = Object.keys(weights)
  const missing = keys.filter(k => !(px[k] > 0))
  if (missing.length) return { due: false, reason: `no price yet for ${missing.join(', ')}`, targets: null, release: 0 }
  const day = dayOf(now), d = new Date(now)
  const first = ledger.lastRebal == null
  const fresh = ledger.lastRebal == null || ledger.lastRebal < day       // not rebalanced today
  const lev = (k) => (levBy[k] > 0 ? levBy[k] : 1)
  let due = false, reason = '', on = null, release = 0

  if (strategy === 'hold') { due = first; reason = first ? 'first day: buying the weights' : 'holding' }
  else if (strategy === 'monthly') {
    const md = Math.min(28, Math.max(1, Math.round(p.monthDay)))
    due = first || (fresh && d.getUTCDate() === md)
    reason = first ? 'first day: buying the weights' : due ? `day ${md} of the month: rebalancing` : `next rebalance on day ${md}`
  } else if (strategy === 'weekly') {
    const wd = Math.min(6, Math.max(0, Math.round(p.weekDay)))
    due = first || (fresh && d.getUTCDay() === wd)
    reason = first ? 'first day: buying the weights' : due ? 'rebalancing day' : 'waiting for the rebalancing day'
  } else if (strategy === 'band') {
    if (first) { due = true; reason = 'first day: buying the weights' }
    else if (fresh) {
      const eq = ledger.cash + keys.reduce((a, k) => a + (ledger.units[k] ?? 0) * px[k], 0)
      const worst = eq > 0 ? Math.max(...keys.map(k => Math.abs((ledger.units[k] ?? 0) * px[k] / (lev(k) * eq) - weights[k]))) : 0
      due = worst > p.band
      reason = due ? `drifted ${(worst * 100).toFixed(1)} points: rebalancing` : `largest drift ${(worst * 100).toFixed(1)} of ${(p.band * 100).toFixed(1)} points`
    } else reason = 'rebalanced today'
  } else if (strategy === 'dca') {
    const n = Math.max(1, Math.round(p.dcaBuys)), every = Math.max(1, Math.round(p.dcaEvery))
    const nextAt = dayOf(ledger.startedAt) + ledger.dcaDone * every * DAY
    if (ledger.dcaDone < n && now >= nextAt) {
      const tranche = ledger.budget * (1 - Math.min(1, Math.max(0, p.dcaUpfront))) / n
      release = Math.min(ledger.reserve, tranche + (ledger.dcaDone === 0 ? ledger.budget * Math.min(1, Math.max(0, p.dcaUpfront)) : 0))
      due = true; reason = `buy ${ledger.dcaDone + 1} of ${n}`
    } else reason = ledger.dcaDone >= n ? 'every buy made: holding' : `buy ${ledger.dcaDone + 1} of ${n} on ${new Date(nextAt).toISOString().slice(0, 10)}`
  } else if (strategy === 'trend') {
    if (!(first || ledger.lastEval == null || ledger.lastEval < day)) reason = 'checked today'
    else {
      const prev = ledger.trendOn
      on = Object.fromEntries(keys.map(k => {
        const m = sma[k], q = px[k], b = Math.max(0, p.trendBuffer)
        if (!(m > 0)) return [k, true]                                    // no average yet: hold, as the backtest does
        if (!b || !prev) return [k, q >= m]
        return [k, q >= m * (1 + b) ? true : q < m * (1 - b) ? false : !!prev[k]]
      }))
      due = first || keys.some(k => on[k] !== prev?.[k])
      const outs = keys.filter(k => !on[k])
      reason = due ? (outs.length ? `out (below average): ${outs.join(', ')}` : 'all above their average') : 'no change'
    }
  } else return { due: false, reason: `unknown strategy ${strategy}`, targets: null, release: 0 }

  if (!due) return { due, reason, targets: null, release: 0, trendOn: on }
  // Targets from the equity that is invested (cash + positions); a DCA reserve waits outside.
  const eq = ledger.cash + release + keys.reduce((a, k) => a + (ledger.units[k] ?? 0) * px[k], 0)
  const targets = Object.fromEntries(keys.map(k => [k, on && !on[k] ? 0 : lev(k) * eq * weights[k] / px[k]]))
  // A market the ledger holds but the portfolio no longer does is closed.
  for (const k of Object.keys(ledger.units ?? {})) if (!(k in targets) && ledger.units[k]) targets[k] = 0
  return { due, reason, targets, release, trendOn: on }
}

const floorTo = (x, dec) => { const f = 10 ** dec; return Math.floor(Math.abs(x) * f + 1e-9) / f }

/**
 * The orders that move the ledger to its targets. Reductions first, so they free margin for
 * the buys. An order under Hyperliquid's $10 minimum is left out and reported, except a close
 * to zero, which goes reduce-only (the exchange takes those).
 *   szDec { coin: size decimals }
 * → { orders: [{ coin, isBuy, sz, reduceOnly, usd }], tooSmall: [coin] }
 */
export function ordersFor(units, targets, px, szDec = {}, minUsd = HL_MIN_ORDER) {
  const orders = [], tooSmall = []
  for (const [k, tgt] of Object.entries(targets)) {
    const have = units[k] ?? 0
    const d = tgt - have
    const sz = floorTo(d, szDec[k] ?? 4)
    if (!(sz > 0)) continue
    const usd = sz * px[k]
    // Toward zero on the same side: reduce-only, so it can never open the other way.
    const reduce = have !== 0 && Math.sign(d) === -Math.sign(have) && Math.abs(d) <= Math.abs(have) + 1e-12
    const closing = tgt === 0 && have !== 0
    if (usd < minUsd && !closing) { tooSmall.push(k); continue }
    orders.push({ coin: k, isBuy: d > 0, sz: closing ? floorTo(have, szDec[k] ?? 4) || sz : sz, reduceOnly: reduce || closing, usd })
  }
  orders.sort((a, b) => (b.reduceOnly - a.reduceOnly) || (a.isBuy - b.isBuy))
  return { orders, tooSmall }
}

/** The ledger after a fill: `signedSz` positive bought, negative sold, at `px`, paying `feeRate`. */
export function applyFill(ledger, coin, signedSz, px, feeRate = 0.00045) {
  const notional = Math.abs(signedSz * px)
  const fee = notional * feeRate
  const units = { ...ledger.units, [coin]: (ledger.units[coin] ?? 0) + signedSz }
  if (Math.abs(units[coin]) < 1e-12) delete units[coin]
  return { ...ledger, units, cash: ledger.cash - signedSz * px - fee, fees: ledger.fees + fee, trades: ledger.trades + 1 }
}

/**
 * The exchange as a check on the ledger. Where the account holds LESS of a market, on the
 * ledger's side, than the ledger says (closed by hand, liquidated), the ledger is cut to what
 * exists: the bot must not believe in units it does not have. Holding MORE is fine — that is
 * someone else's position in the same market. → { ledger, fixed: [{ coin, from, to }] }
 */
export function reconcile(ledger, held) {
  const fixed = []
  const units = { ...ledger.units }
  for (const [k, u] of Object.entries(units)) {
    if (!(k in held)) continue                         // not read this time: unknown, leave it
    const h = held[k] ?? 0
    const same = Math.sign(h) === Math.sign(u)
    const cap = same ? Math.min(Math.abs(u), Math.abs(h)) : 0
    if (cap < Math.abs(u) - 1e-9) {
      fixed.push({ coin: k, from: u, to: Math.sign(u) * cap })
      if (cap) units[k] = Math.sign(u) * cap
      else delete units[k]
    }
  }
  return { ledger: fixed.length ? { ...ledger, units } : ledger, fixed }
}

/** Args → the bot's CLI flags, in one place for the page and the tests. */
export function liveArgs({ id, name, items, strategy, params = {}, budget, lev, margin, fresh = false, run = String(Date.now()), tf = null, both = false, sparams = null }) {
  const enc = (o) => (typeof Buffer !== 'undefined' ? Buffer.from(JSON.stringify(o)).toString('base64') : btoa(unescape(encodeURIComponent(JSON.stringify(o)))))
  const a = ['--id', String(id), '--name', String(name ?? id).slice(0, 40), '--items', enc(items.map(i => ({ coin: i.coin, w: Number(i.w), side: i.side === 'short' ? 'short' : 'long', kind: i.kind ?? null }))),
    '--strategy', strategy, '--budget', String(budget), '--leverage', String(lev), '--margin', margin === 'isolated' ? 'isolated' : 'cross']
  for (const [k, v] of Object.entries(params)) if (v != null && k in LIVE_DEFAULTS) a.push('--' + k, String(v))
  // A trading strategy ('bot:rsi'…): its candle, its direction rule, its own settings.
  if (String(strategy).startsWith('bot:')) {
    a.push('--tf', tf ?? '4h')
    if (both) a.push('--both')
    if (sparams) a.push('--sparams', enc(sparams))
  }
  a.push('--run', run)
  if (fresh) a.push('--fresh')
  return a
}
