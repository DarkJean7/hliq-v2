/**
 * INSOLVENT TERMINAL — what a copy-trade bot should do about one burst of someone else's fills.
 *
 * Pure: the target's fills and our book in, a list of orders out. strategies/copytrade.js
 * executes the result; the test suite runs the same function against real trade shapes.
 *
 * ─── WHY THIS IS NOT "APPLY scale% OF THEIR DELTA" ANY MORE ─────────────────────────────
 * That rule was simple and wrong in two ways that cost money:
 *
 *   A CLOSE OF A POSITION WE NEVER COPIED OPENED A SHORT.
 *     Following starts from "now", so their existing book is deliberately not bought. When
 *     they later closed that book, the bot saw a sell, had nothing to reduce, and placed a
 *     plain sell — which on Hyperliquid opens a short. The follower ended up positioned
 *     AGAINST the trader they chose to follow.
 *
 *   THE PER-TRADE CAP CAPPED EXITS.
 *     Opens are capped at `maxUsd` each, so a follower's copy is built from several capped
 *     slices. The target exits in one fill; the exit got the same cap, so most of the copy
 *     stayed open after the target was flat. And in the other direction: under a cap, half
 *     of THEIR position can be ALL of ours, so a proportional partial close emptied us.
 *
 * So exits are mirrored by FRACTION, not by size: if they take off 40% of their position we
 * take off 40% of ours, and a full exit is a full exit, whatever the caps did on the way in.
 * And "ours" means what THIS BOT opened (`mine`) — never a position the user holds by hand
 * in the same coin, which the bot has no business unwinding.
 *
 * Caps and the $10 minimum apply to opening risk only. Nothing here ever stops a follower
 * getting out.
 */

/** Hyperliquid rejects an order below $10 notional (a full reduce-only close is exempt). */
export const HL_MIN_ORDER = 10

const EPS = 1e-9
const sgn = (n) => (n > EPS ? 1 : n < -EPS ? -1 : 0)
const clean = (n) => (Math.abs(n) < EPS ? 0 : n)

/**
 * The target's position BEFORE a burst of fills in one coin.
 *
 * Every Hyperliquid fill carries `startPosition`: the signed size before that fill. The head
 * of the burst is the fill whose start is not the END of any other fill in it — which is the
 * earliest one even when several share a millisecond, as a single sweep of the book usually
 * does. Falls back to the earliest timestamp if the chain cannot be read (a fill missing).
 */
export function burstStart(fills) {
  const rows = (fills ?? []).map(f => {
    const start = parseFloat(f.startPosition)
    const sz    = (f.side === 'B' ? 1 : -1) * parseFloat(f.sz ?? 0)
    return { f, start, end: start + sz }
  }).filter(r => Number.isFinite(r.start))
  if (!rows.length) return null
  const ends = rows.map(r => r.end)
  const head = rows.filter(r => !ends.some(e => Math.abs(e - r.start) < 1e-9))
  const pick = (head.length === 1 ? head : rows).slice().sort((a, b) => (+a.f.time) - (+b.f.time))[0]
  return pick.start
}

/**
 * Where the target's position went over a burst: `{ before, after }`, or null.
 *
 * Both ends are read from the fills themselves — the first fill's start, the last fill's end —
 * rather than `before + Σ sizes`. The two agree when every fill is present. When one is
 * missing they do not, and the sum invents a position the target never held: a replay with a
 * gap in it had the bot believe a trader was at 1,320.91 when the next fill showed them at
 * 300, and the fraction it closed was computed from the invented number. The end of the last
 * fill is not an estimate; it is what Hyperliquid says they held.
 *
 * The tail is found the same way as the head: the fill whose end is not the start of another.
 */
export function burstRange(fills) {
  const rows = (fills ?? []).map(f => {
    const start = parseFloat(f.startPosition)
    const sz    = (f.side === 'B' ? 1 : -1) * parseFloat(f.sz ?? 0)
    return { f, start, end: start + sz }
  }).filter(r => Number.isFinite(r.start) && Number.isFinite(r.end))
  if (!rows.length) return null
  const before = burstStart(fills)
  const starts = rows.map(r => r.start)
  const tail   = rows.filter(r => !starts.some(s => Math.abs(s - r.end) < 1e-9))
  const pick   = (tail.length === 1 ? tail : rows).slice().sort((a, b) => (+b.f.time) - (+a.f.time))[0]
  return { before, after: clean(pick.end) }
}

/**
 * Keep the bot's record of what it holds honest against the account.
 *
 * The user can close a copied position by hand, or get liquidated. The bot must never try to
 * unwind more than actually exists, nor unwind in the wrong direction.
 */
export function reconcileMine(mine, ourSzi) {
  const m = Number(mine) || 0, o = Number(ourSzi) || 0
  if (sgn(m) === 0 || sgn(o) !== sgn(m)) return 0
  return sgn(m) * Math.min(Math.abs(m), Math.abs(o))
}

/**
 * Decide the orders for one coin.
 *
 * @param {object} p
 * @param {number} p.theirBefore  target's signed position before the burst (burstStart)
 * @param {number} p.theirDelta   net signed size of the burst
 * @param {number} p.mine         signed size this bot opened and still holds (reconciled)
 * @param {number} p.carry        signed size of opens too small to place so far
 * @param {number} p.scale        fraction of their size to copy (0.25 = 25%)
 * @param {number} p.maxUsd       per-trade cap on NEW risk; 0 = none
 * @param {number} p.maxPosition  cap on the copied position's notional; 0 = none
 * @param {number} p.markPx
 * @returns {{ orders: {delta:number, reduceOnly:boolean, kind:string}[], carry:number, notes:string[] }}
 */
export function planMirror(p) {
  const before = clean(Number(p.theirBefore) || 0)
  const delta  = Number(p.theirDelta) || 0
  const after  = clean(before + delta)
  const mine   = Number(p.mine) || 0
  const px     = Number(p.markPx) || 0
  const scale  = Math.max(0, Number(p.scale) || 0)
  const maxUsd = Math.max(0, Number(p.maxUsd) || 0)
  const maxPos = Math.max(0, Number(p.maxPosition) || 0)
  let   carry  = Number(p.carry) || 0
  const orders = [], notes = []

  if (!(px > 0) || sgn(delta) === 0) return { orders, carry, notes }

  const sb = sgn(before), sa = sgn(after)
  const flip     = sb !== 0 && sa !== 0 && sb !== sa
  const reducing = sb !== 0 && !flip && Math.abs(after) < Math.abs(before)

  // ── 1. The part of their move that takes risk OFF ─────────────────────────────────────
  if (reducing || flip) {
    // Pending opens in the direction they are leaving are moot now.
    if (sgn(carry) === sb) carry = 0
    const fraction = (flip || sa === 0) ? 1 : (Math.abs(before) - Math.abs(after)) / Math.abs(before)
    // Only unwind what we hold ON THE SAME SIDE as them. Anything else is not a copy of
    // this position — including nothing at all, when they are closing something from before
    // we started following. That case used to open a short.
    const unwind = sgn(mine) === sb ? -mine * fraction : 0
    if (sgn(unwind) === 0) {
      notes.push(sgn(mine) === 0 ? 'their exit — nothing copied to close' : 'their exit — our copy is on the other side, left alone')
    } else if (fraction < 1 && Math.abs(unwind) * px < HL_MIN_ORDER) {
      // A partial reduce under the minimum cannot be placed. It is skipped, not carried:
      // their full exit always closes us fully, so this can only leave us slightly larger
      // than proportional for a while — never stuck in a position they have left.
      notes.push(`partial exit $${(Math.abs(unwind) * px).toFixed(2)} under the $${HL_MIN_ORDER} minimum — skipped`)
    } else {
      orders.push({ delta: unwind, reduceOnly: true, kind: fraction >= 1 ? 'close' : 'reduce' })
    }
  }

  // ── 2. The part that puts risk ON ──────────────────────────────────────────────────────
  let add = 0
  if (flip) add = after                              // their new side, from zero
  else if (!reducing) add = delta                    // an open, or an add
  if (sgn(add) !== 0) {
    let want = add * scale + (sgn(carry) === sgn(add) ? carry : 0)
    if (sgn(carry) !== sgn(add)) carry = 0
    if (maxUsd > 0 && Math.abs(want) * px > maxUsd) {
      notes.push(`capped $${(Math.abs(want) * px).toFixed(0)} → $${maxUsd} per trade`)
      want = sgn(want) * (maxUsd / px)
    }
    if (maxPos > 0) {
      // After a flip the old side is being closed in this same plan, so none of it counts.
      const held = flip ? 0 : (sgn(mine) === sgn(want) ? Math.abs(mine) * px : 0)
      const room = Math.max(0, maxPos - held) / px
      if (room <= EPS) { notes.push(`at max position $${maxPos}`); want = 0; carry = 0 }
      else if (Math.abs(want) > room) { notes.push(`trimmed to max position $${maxPos}`); want = sgn(want) * room }
    }
    if (sgn(want) !== 0) {
      if (Math.abs(want) * px < HL_MIN_ORDER) {
        carry = want
        notes.push(`$${(Math.abs(want) * px).toFixed(2)} under the $${HL_MIN_ORDER} minimum — held until it stacks`)
      } else {
        orders.push({ delta: want, reduceOnly: false, kind: flip ? 'flip' : 'open' })
        carry = 0
      }
    }
  }

  return { orders, carry, notes }
}
