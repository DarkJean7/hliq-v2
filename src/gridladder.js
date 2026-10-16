/**
 * Grid Ladder — the engine. Pure: no network, no storage, no clock it does not get handed.
 *
 * Five long-only arithmetic grids on the HYPE perp, each in its own Hyperliquid account, each
 * with its own range. This file is everything that decides WHAT a bot should have on the book;
 * src/gridrunner.js decides WHEN, against an exchange adapter (live Hyperliquid, the dry-run
 * simulator, or the backtester — src/gridsim.js), and strategies/_gridstore.js remembers it.
 *
 * The model is PAIRS, not levels. With n levels L0 < L1 < … < Ln-1 there are n-1 pairs, and
 * pair i is "buy at Li, sell at Li+1". A pair is always in exactly one phase:
 *
 *   'I'  waiting for its share of the start-up inventory buy (only before the first fill)
 *   'B'  wants a post-only BUY of `sz` at Li
 *   'S'  holds `sz` bought, wants a post-only REDUCE-ONLY SELL of `sz` at Li+1
 *
 * A filled buy flips the pair to 'S'; a filled sell completes a CYCLE (its profit is booked)
 * and flips it back to 'B'. Level j can only ever be asked for by pair j (its buy) or pair
 * j-1 (its sell), and price order makes those two exclusive: phases always read B…B S…S from
 * the bottom up. `desiredOrders` still checks it and drops a second order at a level rather
 * than trusting the argument — "exactly one open order per level, ever" is a rule, not a hope.
 *
 * PARTIAL FILLS — the opposite order is placed only once a level is FULLY filled. A partial
 * buy keeps resting for the remainder (same order, or re-placed for `sz - filled` if it was
 * cancelled), and what was bought counts as inventory at its real cost meanwhile. Chosen over
 * "sell what filled now, track the rest" because it keeps one order per pair and one size per
 * cycle, which is what makes the cloid scheme and the one-order-per-level rule hold; the cost
 * is that a half-filled level waits for the rest before its sell goes up. Tested in
 * tests/suites/gridladder.test.mjs.
 */

export const MIN_NOTIONAL = 10           // Hyperliquid's minimum order value, USD
export const MAKER_FEE    = 0.00015      // base tier; the backtester and dry-run charge these
export const TAKER_FEE    = 0.00045
export const LADDER_COIN  = 'HYPE'

/** The default ladder. Every field is editable in the panel. */
export const DEFAULT_BOT = { levels: 10, usd: 20, leverage: 3, margin: 'isolated', killPrice: 0, sweepEnabled: false, sweepDays: 7 }
export const DEFAULT_LADDER = [[50, 70], [60, 80], [70, 90], [80, 100], [90, 110]]
  .map(([low, high], i) => ({ id: i + 1, low, high, ...DEFAULT_BOT, account: '', sub: '' }))

// ── Hyperliquid's price and size rules ───────────────────────────────────────
/** Decimals a perp price may carry at this magnitude: ≤ 5 significant figures AND ≤ 6 − szDecimals. */
export function pxDecimals(px, szDecimals) {
  const maxDec = Math.max(0, 6 - szDecimals)
  if (!(px > 0)) return maxDec
  const mag = Math.floor(Math.log10(px))
  return Math.max(0, Math.min(maxDec, 4 - mag))
}

/** A valid perp price. mode 'down' / 'up' never rounds to the wrong side of what was asked. */
export function roundPx(px, szDecimals, mode = 'nearest') {
  if (!(px > 0)) return 0
  let dec = pxDecimals(px, szDecimals)
  const f = 10 ** dec
  let r = mode === 'down' ? Math.floor(px * f + 1e-9) / f : mode === 'up' ? Math.ceil(px * f - 1e-9) / f : Math.round(px * f) / f
  // Rounding can cross a power of ten (99.9996 → 100.000), where fewer decimals are allowed.
  const dec2 = pxDecimals(r, szDecimals)
  if (dec2 < dec) { dec = dec2; const g = 10 ** dec; r = mode === 'down' ? Math.floor(r * g + 1e-9) / g : mode === 'up' ? Math.ceil(r * g - 1e-9) / g : Math.round(r * g) / g }
  return +r.toFixed(dec)
}

/** The smallest price step at this price. */
export const tickOf = (px, szDecimals) => 10 ** -pxDecimals(px, szDecimals)

/** A valid size, rounded DOWN so a level never asks for more than its dollars cover. */
export function roundSz(sz, szDecimals) {
  if (!(sz > 0)) return 0
  const f = 10 ** szDecimals
  return +(Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals)
}

// ── levels and sizes ─────────────────────────────────────────────────────────
/** n arithmetic levels from low to high inclusive, each a valid price, strictly increasing. */
export function levelsOf(low, high, n, szDecimals) {
  const out = []
  for (let i = 0; i < n; i++) out.push(roundPx(low + (i * (high - low)) / (n - 1), szDecimals))
  return out
}

/** The size pair i trades: its dollars at its buy price. The sell is the same size. */
export const pairSize = (usd, buyPx, szDecimals) => roundSz(usd / buyPx, szDecimals)

/**
 * Everything wrong with a bot's config, as sentences. Empty = it can start. Checked against
 * the market's real szDecimals and max leverage, so the $10 minimum is tested on the size
 * that would actually be sent, after rounding down.
 */
export function validateBot(cfg, { szDecimals, maxLeverage = 50 } = {}) {
  const e = []
  const low = +cfg.low, high = +cfg.high, n = +cfg.levels, usd = +cfg.usd, lev = +cfg.leverage
  if (!(low > 0)) e.push('Range low must be above 0.')
  if (!(high > low)) e.push('Range high must be above range low.')
  if (!Number.isInteger(n) || n < 2 || n > 100) e.push('Levels must be a whole number from 2 to 100.')
  if (!(usd > 0)) e.push('USD per level must be above 0.')
  if (!Number.isInteger(lev) || lev < 1 || lev > maxLeverage) e.push(`Leverage must be a whole number from 1 to ${maxLeverage}.`)
  if (cfg.margin !== 'isolated' && cfg.margin !== 'cross') e.push('Margin mode must be isolated or cross.')
  if (cfg.killPrice && !(+cfg.killPrice > 0 && +cfg.killPrice < low)) e.push('The kill price must be below the range low (or 0 for off).')
  if (e.length || szDecimals == null) return e
  const px = levelsOf(low, high, n, szDecimals)
  if (new Set(px).size !== px.length) e.push('The range is too narrow for this many levels — two levels round to the same price.')
  for (let i = 0; i < n - 1; i++) {
    const sz = pairSize(usd, px[i], szDecimals)
    if (!(sz * px[i] >= MIN_NOTIONAL)) {
      e.push(`$${usd} per level is below Hyperliquid's $${MIN_NOTIONAL} minimum at $${px[i]} (${sz} ${LADDER_COIN} = $${(sz * px[i]).toFixed(2)}). Raise USD per level.`)
      break
    }
  }
  return e
}

/** What a bot commits when every pair holds inventory: full notional and the margin it needs. */
export function botCapital(cfg, szDecimals) {
  const px = levelsOf(+cfg.low, +cfg.high, +cfg.levels, szDecimals)
  let notional = 0
  for (let i = 0; i < px.length - 1; i++) notional += pairSize(+cfg.usd, px[i], szDecimals) * px[i]
  return { notional, margin: notional / Math.max(1, +cfg.leverage) }
}

// ── client order ids ─────────────────────────────────────────────────────────
// 0x | b07 (bot marker, src/cloid.js) | 0f (gridladder) | run 12 | bot 1 | pair 2 | side 1 | cycle 8 | attempt 3
// Deterministic: the same order intent always produces the same id, so after a restart an
// order on the book can be matched to the pair and cycle that placed it. `run` is fresh each
// time a bot starts from nothing, so a past run's orders never pass for this one's. `attempt`
// counts re-placements of the same intent (cancelled, or a post-only re-price): Hyperliquid
// will not take the same cloid twice.
export const LADDER_CODE = '0f'
const SIDES = { I: '1', B: '2', S: '3', C: '4' }
const SIDE_OF = Object.fromEntries(Object.entries(SIDES).map(([k, v]) => [v, k]))
const hex = (n, w) => (Math.max(0, Math.floor(n)) % 16 ** w).toString(16).padStart(w, '0')

export function ladderCloid(run, bot, pair, side, cycle = 0, attempt = 0) {
  if (!/^[0-9a-f]{12}$/.test(run)) throw new Error('bad run id')
  return '0xb07' + LADDER_CODE + run + hex(bot, 1) + hex(pair, 2) + SIDES[side] + hex(cycle, 8) + hex(attempt, 3)
}

export function parseLadderCloid(c) {
  const m = /^0xb070f([0-9a-f]{12})([0-9a-f])([0-9a-f]{2})([1-4])([0-9a-f]{8})([0-9a-f]{3})$/.exec(String(c ?? '').toLowerCase())
  if (!m) return null
  return { run: m[1], bot: parseInt(m[2], 16), pair: parseInt(m[3], 16), side: SIDE_OF[m[4]], cycle: parseInt(m[5], 16), attempt: parseInt(m[6], 16) }
}

export const newRunId = (rand = Math.random) => Array.from({ length: 12 }, () => Math.floor(rand() * 16).toString(16)).join('')

// ── state ────────────────────────────────────────────────────────────────────
const cfgKey = (c) => [c.low, c.high, c.levels, c.usd].map(Number).join('|')
/** True when the grid itself changed (range, levels, size) — leverage and kill price are not the grid. */
export const gridChanged = (st, cfg) => !st || st.cfgKey !== cfgKey(cfg)

/**
 * A fresh bot at this mid. Outside its range it starts WAITING: above, it sits in cash; below,
 * it does not buy the whole grid at the bottom of a fall. It initialises the first time the
 * price is inside (see `armIfWaiting`).
 */
export function freshState({ bot, cfg, szDecimals, mid, run, now }) {
  const prices = levelsOf(+cfg.low, +cfg.high, +cfg.levels, szDecimals)
  const st = {
    v: 1, bot, run, cfgKey: cfgKey(cfg), cfg: { ...cfg }, szDecimals, prices, pairs: [],
    waiting: true, startedAt: now, lastFillTime: now - 60_000,
    realized: 0, cycles: 0, fees: 0, volume: 0, inventoryBuy: null,
    lifetime: { realized: 0, cycles: 0, fees: 0 },
  }
  armIfWaiting(st, mid)
  return st
}

/** Lay out the pairs the first time the price is inside the range. Returns whether it armed. */
export function armIfWaiting(st, mid) {
  if (!st.waiting || !(mid >= st.prices[0] && mid <= st.prices[st.prices.length - 1])) return false
  st.waiting = false
  st.pairs = st.prices.slice(0, -1).map((px, i) => ({
    i, sz: pairSize(+st.cfg.usd, px, st.szDecimals),
    // A pair whose buy level is at or above the price cannot rest a buy — it needs inventory.
    phase: px >= mid ? 'I' : 'B',
    cycle: 0, attempt: 0, px: null, placed: null,
    filled: 0, cost: 0, buyFee: 0, sold: 0, proceeds: 0, sellFee: 0,
  }))
  return true
}

/** Size the start-up inventory buy needs: every 'I' pair's size, in one order. */
export const inventoryNeeded = (st) => st.pairs.filter(p => p.phase === 'I').reduce((s, p) => s + p.sz, 0)

/** After the inventory buy is done: pairs it did not cover go back to resting buys. */
export function settleInventory(st) {
  for (const p of st.pairs) if (p.phase === 'I') { p.phase = 'B'; p.filled = 0; p.cost = 0; p.buyFee = 0 }
  if (st.inventoryBuy) st.inventoryBuy.done = true
}

/** What each pair wants on the book now: {pair, side, isBuy, px, sz, reduceOnly, cloid}. */
export function desiredOrders(st, mid, { paused = false, open = new Set() } = {}) {
  if (st.waiting || st.stopped) return []
  const lo = st.prices[0], hi = st.prices[st.prices.length - 1]
  const above = mid > hi, below = mid < lo
  const out = [], level = new Map()
  for (const p of st.pairs) {
    let o = null
    if (p.phase === 'B') {
      const sz = roundSz(p.sz - p.filled, st.szDecimals)
      if (sz > 0) o = { pair: p.i, side: 'B', isBuy: true, px: p.px ?? st.prices[p.i], sz, reduceOnly: false, level: p.i }
    } else if (p.phase === 'S') {
      const sz = roundSz(p.sz - p.sold, st.szDecimals)
      if (sz > 0) o = { pair: p.i, side: 'S', isBuy: false, px: p.px ?? st.prices[p.i + 1], sz, reduceOnly: true, level: p.i + 1 }
    }
    if (!o) continue
    o.cloid = ladderCloid(st.run, st.bot, p.i, o.side, p.cycle, p.attempt)
    const resting = open.has(o.cloid)
    // A new order needs: not paused; and for a buy, the price inside the range (above it the
    // bot sits in cash, below it holds and stops buying). An order already resting stays.
    if (!resting && (paused || (o.isBuy && (above || below)))) continue
    if (level.has(o.level)) continue        // one order per level — never a second
    level.set(o.level, o)
    out.push(o)
  }
  return out
}

/**
 * The difference between what should be on the book and what is.
 * `open` is the exchange's open orders that are OURS (this run and bot), by cloid.
 * Anything of ours that is not wanted is cancelled; anything wanted that is not there is placed.
 * A wanted order whose last placement has vanished without filling is re-placed under the next
 * attempt number, because the exchange will not reuse the id.
 */
export function planReconcile(st, mid, openOrders, { paused = false } = {}) {
  const open = new Map(openOrders.map(o => [o.cloid, o]))
  // A placement that is no longer on the book and was not filled (fills are applied BEFORE
  // this runs) was cancelled or rejected: bump its attempt so the re-placement gets a new id.
  for (const p of st.pairs) {
    if (p.placed && !open.has(p.placed)) {
      const live = ladderCloid(st.run, st.bot, p.i, p.phase === 'S' ? 'S' : 'B', p.cycle, p.attempt)
      if (p.placed === live) { p.attempt++; p.px = null }
      p.placed = null
    }
  }
  const want = desiredOrders(st, mid, { paused, open: new Set(open.keys()) })
  const wantIds = new Set(want.map(o => o.cloid))
  return {
    place: want.filter(o => !open.has(o.cloid)),
    cancel: openOrders.filter(o => !wantIds.has(o.cloid)).map(o => o.cloid),
    keep: want.filter(o => open.has(o.cloid)),
  }
}

/** Record that an order was accepted onto the book (or filled at once). */
export function markPlaced(st, o) {
  const p = st.pairs[o.pair]
  if (p) { p.placed = o.cloid; p.px = o.px }
}

/**
 * A post-only order that would have crossed: the price it should go at instead — the touch on
 * its own side, never better for the taker than the level (a buy no higher, a sell no lower).
 * Never a taker order.
 */
export function repriceAfterCross(st, o, bbo) {
  const p = st.pairs[o.pair]
  if (!p) return null
  const lvl = o.isBuy ? st.prices[p.i] : st.prices[p.i + 1]
  const px = o.isBuy
    ? roundPx(Math.min(lvl, (bbo?.bid > 0 ? bbo.bid : lvl)), st.szDecimals, 'down')
    : roundPx(Math.max(lvl, (bbo?.ask > 0 ? bbo.ask : lvl)), st.szDecimals, 'up')
  p.attempt++
  p.px = px
  p.placed = null
  return { ...o, px, cloid: ladderCloid(st.run, st.bot, p.i, o.side, p.cycle, p.attempt) }
}

/** "Post only order would have immediately matched, bbo was 81.02@81.03" → {bid, ask}. */
export function bboFromError(msg) {
  const m = /bbo was\s*(\d+(?:\.\d+)?)@(\d+(?:\.\d+)?)/i.exec(String(msg ?? ''))
  return m ? { bid: +m[1], ask: +m[2] } : null
}
export const isCrossReject = (msg) => /post only|would have immediately matched/i.test(String(msg ?? ''))

/**
 * Apply ONE fill (already de-duplicated by trade id by the caller). Returns what happened:
 * {kind:'buy'|'sell'|'inventory'|'cycle'|'foreign', pair, profit?}. A fill whose cloid is not
 * this run's and bot's is 'foreign' and changes nothing.
 */
export function applyFill(st, f) {
  const c = parseLadderCloid(f.cloid)
  const px = +f.px, sz = +f.sz, fee = +f.fee || 0
  if (!c || c.run !== st.run || c.bot !== st.bot) return { kind: 'foreign' }
  st.fees += fee; st.volume += px * sz
  st.lastFillTime = Math.max(st.lastFillTime ?? 0, +f.time || 0)
  const eps = 10 ** -st.szDecimals / 2

  if (c.side === 'I') {
    // The start-up buy is one order for many pairs: fill them from the lowest up.
    let left = sz
    for (const p of st.pairs) {
      if (p.phase !== 'I' || left <= eps) continue
      const take = Math.min(left, p.sz - p.filled)
      p.filled += take; p.cost += take * px; p.buyFee += fee * (take / sz); left -= take
      if (p.filled >= p.sz - eps) { p.phase = 'S'; p.attempt = 0; p.px = null; p.placed = null }
    }
    return { kind: 'inventory' }
  }
  if (c.side === 'C') return { kind: 'close' }

  const p = st.pairs[c.pair]
  if (!p || p.cycle !== c.cycle) return { kind: 'stale' }
  if (c.side === 'B' && p.phase === 'B') {
    p.filled += sz; p.cost += sz * px; p.buyFee += fee
    if (p.filled >= p.sz - eps) { p.phase = 'S'; p.attempt = 0; p.px = null; p.placed = null }
    return { kind: 'buy', pair: p.i }
  }
  if (c.side === 'S' && p.phase === 'S') {
    p.sold += sz; p.proceeds += sz * px; p.sellFee += fee
    if (p.sold >= p.sz - eps) {
      const profit = p.proceeds - p.cost - p.buyFee - p.sellFee
      const done = { pair: p.i, cycle: p.cycle, sz: p.sz, buyPx: p.cost / p.filled, sellPx: p.proceeds / p.sold, fees: p.buyFee + p.sellFee, profit, time: +f.time || 0 }
      st.realized += profit; st.cycles++
      Object.assign(p, { phase: 'B', cycle: p.cycle + 1, attempt: 0, px: null, placed: null, filled: 0, cost: 0, buyFee: 0, sold: 0, proceeds: 0, sellFee: 0 })
      return { kind: 'cycle', pair: p.i, cycleDone: done, profit }
    }
    return { kind: 'sell', pair: p.i }
  }
  return { kind: 'stale' }
}

/** What the bot holds by its own books: size and cost of everything bought and not yet sold. */
export function inventoryOf(st) {
  let sz = 0, cost = 0
  for (const p of st.pairs ?? []) {
    if (p.phase === 'S' || p.phase === 'I') {
      const left = (p.phase === 'S' ? p.sz : p.filled) - p.sold
      sz += left; cost += p.filled > 0 ? (p.cost / p.filled) * left : 0
    } else if (p.phase === 'B' && p.filled > 0) { sz += p.filled; cost += p.cost }
  }
  return { sz, cost, avg: sz > 0 ? cost / sz : null }
}

/** The kill switch: a hard stop price, off when 0. */
export const killed = (st, mid) => +st.cfg?.killPrice > 0 && mid > 0 && mid <= +st.cfg.killPrice

/**
 * The panel's numbers for one bot. `funding` is what the account paid (+) or received (−) on
 * HYPE since the bot started; `accountValue` is the account's total. Fees are inside both the
 * realized profit (a cycle is net of its two fees) and the cost basis of what is held.
 */
export function botStats(st, { mid = 0, funding = 0, accountValue = null, openBuyNotional = 0, now = Date.now() } = {}) {
  const inv = inventoryOf(st)
  const unrealized = inv.sz > 0 && mid > 0 ? inv.sz * mid - inv.cost : 0
  const lev = Math.max(1, +st.cfg?.leverage || 1)
  const inUse = ((inv.sz * (mid || inv.avg || 0)) + openBuyNotional) / lev
  const days = Math.max(1 / 24, (now - (st.startedAt ?? now)) / 86_400_000)
  return {
    realized: st.realized, cycles: st.cycles, fees: st.fees, funding,
    inventory: inv.sz, avgEntry: inv.avg, unrealized,
    net: st.realized + unrealized - funding,
    capitalInUse: inUse, capitalIdle: accountValue != null ? Math.max(0, accountValue - inUse) : null,
    perDay: st.realized / days, perWeek: (st.realized / days) * 7, days,
  }
}

/** The ladder's totals: sums, except the per-day figures, which are summed rates. */
export function ladderStats(list) {
  const t = { realized: 0, cycles: 0, fees: 0, funding: 0, inventory: 0, unrealized: 0, net: 0, capitalInUse: 0, capitalIdle: 0, perDay: 0, perWeek: 0 }
  let cost = 0, idleKnown = true
  for (const s of list) {
    for (const k of Object.keys(t)) if (k !== 'capitalIdle') t[k] += s[k] || 0
    if (s.capitalIdle == null) idleKnown = false; else t.capitalIdle += s.capitalIdle
    if (s.avgEntry) cost += s.avgEntry * s.inventory
  }
  t.avgEntry = t.inventory > 0 ? cost / t.inventory : null
  if (!idleKnown) t.capitalIdle = null      // a missing account is unknown, not $0 idle
  return t
}

/** Shift a ladder so its middle sits at `px` (the configured ladder is centred on its own middle). */
export function fitLadder(bots, px) {
  const lo = Math.min(...bots.map(b => +b.low)), hi = Math.max(...bots.map(b => +b.high))
  const k = px / ((lo + hi) / 2)
  const r = (v) => +(v * k).toPrecision(5)
  return bots.map(b => ({ ...b, low: r(+b.low), high: r(+b.high), usd: b.usd }))
}
