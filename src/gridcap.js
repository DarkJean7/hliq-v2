/**
 * INSOLVENT TERMINAL — the grid bot's margin cap, as arithmetic
 *
 * A grid run with `--total-margin 100` went to $147 of margin on a 10x ADA short
 * (0x01A4…D6D7, 2026-09-21), with two more entry orders still resting. Three faults stacked:
 *
 *   1. The cap only looked at the margin the position ALREADY used. Resting entry orders are
 *      margin that has been committed and not yet drawn — a ladder placed while the position
 *      was small fills later and walks straight through the cap. It tripped at $107 on an
 *      order that was placed when the position was well under it.
 *
 *   2. A restart re-centres the grid on the new mark, so the previous run's entry orders stop
 *      matching a level and were filed as "foreign" — and the new run placed its own ladder on
 *      top. Two ladders, one cap. The restarts were deploys: every push that changes server.js
 *      restarts the bot server, and with it every running bot.
 *
 *   3. When the cap DID trip, it cancelled only entries it could match to a current level. The
 *      orphaned ladder was invisible to it; two of those orders filled over the next four hours.
 *
 * So the cap now budgets what is COMMITTED — position margin plus the margin of every resting
 * order that would add to the position — and the bot cancels its own orphaned entries on sight.
 * Orders a person placed by hand are counted against the budget (they add to the same
 * position) but never cancelled: the cap governs the bot, not the account owner.
 *
 * Pure, so the rule is tested without a market: tests/suites/gridcap.test.mjs.
 */

/** Margin an order will draw if it fills, at the grid's leverage. */
export function orderMargin(o, leverage) {
  const lev = Number(leverage)
  const sz  = Math.abs(parseFloat(o?.sz))
  const px  = Math.abs(parseFloat(o?.px ?? o?.limitPx))
  if (!(lev > 0) || !Number.isFinite(sz) || !Number.isFinite(px)) return 0
  return (sz * px) / lev
}

/**
 * Does this resting order ADD to the grid's position if it fills?
 *
 * A short grid's entries are sells, a long grid's are buys. A reduce-only order can only
 * shrink the position, so it is never an entry whichever side it is on.
 */
export function isEntry(o, isShort) {
  if (!o || o.reduceOnly) return false
  return isShort ? o.side === 'sell' : o.side === 'buy'
}

/**
 * Which of the bot's own entries to cancel so the committed margin fits under the cap, and
 * how much room is left for new ones.
 *
 *   own     — entries this bot placed for the CURRENT grid: cancellable
 *   others  — entries on the same coin it did not place (a manual order): counted, never cancelled
 *
 * Farthest from the mark goes first. Those fill last, so keeping the near ones keeps the grid
 * working where price actually is while the far exposure is what gets given up.
 *
 * `cap <= 0` means no cap: nothing is cancelled and the headroom is unlimited.
 */
export function capPlan({ cap, leverage, posMargin, own = [], others = [], markPx, eps = 0.01 }) {
  const c = Number(cap)
  const base = Math.max(0, Number(posMargin) || 0)
  const ownM   = own.map(o => ({ o, m: orderMargin(o, leverage) }))
  const otherM = others.reduce((s, o) => s + orderMargin(o, leverage), 0)
  let committed = base + otherM + ownM.reduce((s, x) => s + x.m, 0)
  if (!(c > 0)) return { cancel: [], committed, headroom: Infinity }

  const cancel = []
  const mark = Number(markPx)
  const far = [...ownM].sort((a, b) =>
    Math.abs(parseFloat(b.o.px) - mark) - Math.abs(parseFloat(a.o.px) - mark))
  for (const x of far) {
    if (committed <= c + eps) break
    cancel.push(x.o)
    committed -= x.m
  }
  return { cancel, committed, headroom: Math.max(0, c - committed) }
}

/** May an order drawing `margin` be placed with `headroom` left? No cap means yes. */
export function fitsCap({ cap, headroom, margin, eps = 0.01 }) {
  if (!(Number(cap) > 0)) return true
  return Number(margin) <= Number(headroom) + eps
}
