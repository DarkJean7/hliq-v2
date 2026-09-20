/**
 * INSOLVENT TERMINAL — trailing stop arithmetic
 *
 * Hyperliquid has no trailing-stop order type. A trailing stop therefore has to be something
 * that WATCHES: remember the best price reached since the stop went live, and get out when
 * price retraces from it by more than you are willing to give back.
 *
 * Everything here is pure. The watcher that uses it lives in strategies/trailstop.js and runs
 * on the server, because a stop that only works while a browser tab is open is not a stop.
 *
 * ── the shape of it ──
 *
 *   LONG   best = the HIGHEST mark since activation;  stop = best − retracement;  fire below
 *   SHORT  best = the LOWEST  mark since activation;  stop = best + retracement;  fire above
 *
 * `best` only ever moves in the favourable direction. That one-way ratchet is the whole
 * mechanism, and it is why the stop can never move against you: a long's stop rises with the
 * high-water mark and never falls, so the worst case is locked in the moment it is set.
 *
 * ── what the watcher does with it ──
 *
 * It keeps a reduce-only STOP-MARKET order resting on the exchange at `stopPx` and moves that
 * order up as the ratchet turns, rather than sitting on the trigger and sending an order at
 * the moment of retracement. The two behave identically while the watcher is alive, and
 * differently in the case that matters: if the process dies, a resting order is still there
 * and an intention in someone's memory is not. `shouldMoveStop` keeps that from becoming a
 * cancel/replace on every tick.
 */

/** Which way a position points. Positive size is long. */
export const sideOf = (szi) => (parseFloat(szi) || 0) >= 0 ? 'long' : 'short'

/** How the retracement is expressed. '%' of the best price, or an absolute price distance. */
export const RETRACE_UNITS = ['%', '$']

/**
 * A retracement, as a price distance from `best`.
 *
 * Percent is taken of the BEST price, not of entry — that is what "retraces by 5% from the
 * high" means, and using entry would make the trailing distance drift as the trade moved.
 */
export function retraceDistance(best, amount, unit = '%') {
  const b = Math.abs(parseFloat(best))
  const a = Math.abs(parseFloat(amount))
  if (!Number.isFinite(b) || !Number.isFinite(a) || !(a > 0)) return null
  return unit === '$' ? a : b * (a / 100)
}

/**
 * Where the stop sits, given the best price reached so far.
 *
 * Null when the inputs cannot produce one — never a number the caller might place an order
 * against by accident.
 */
export function stopPrice(side, best, amount, unit = '%') {
  const b = parseFloat(best)
  const d = retraceDistance(b, amount, unit)
  if (d == null || !Number.isFinite(b) || b <= 0) return null
  const px = side === 'long' ? b - d : b + d
  return px > 0 ? px : null
}

/**
 * Advance the ratchet.
 *
 * `best` only improves. Returns the new best, and whether this tick moved it — the caller
 * uses that to decide whether the resting order needs to follow.
 *
 * Before activation there is no best at all: an activation price means "do not start trailing
 * until the market has got this far", and recording highs before then would arm the stop
 * against a price the trade never actually reached in profit.
 */
export function advance(state, mark, { side, activationPx = null } = {}) {
  const m = parseFloat(mark)
  if (!Number.isFinite(m) || m <= 0) return { ...state, moved: false }

  let active = !!state?.active
  if (!active) {
    if (activationPx == null || activationPx === '') active = true
    else {
      const a = parseFloat(activationPx)
      if (!Number.isFinite(a)) active = true
      // Reached from either direction: a long activates at or above its activation price.
      else active = side === 'long' ? m >= a : m <= a
    }
    if (!active) return { ...state, active: false, moved: false }
    // The activating tick IS the first high-water mark.
    return { ...state, active: true, best: m, activatedAt: state?.activatedAt ?? Date.now(), moved: true }
  }

  const prev = parseFloat(state?.best)
  if (!Number.isFinite(prev)) return { ...state, active: true, best: m, moved: true }
  const better = side === 'long' ? m > prev : m < prev
  return better ? { ...state, active: true, best: m, moved: true } : { ...state, active: true, best: prev, moved: false }
}

/** Has price retraced past the stop? The watcher's own check, for the case where no resting
 *  order could be placed — it must still be able to get out. */
export function isTriggered(side, mark, stopPx) {
  const m = parseFloat(mark), s = parseFloat(stopPx)
  if (!Number.isFinite(m) || !Number.isFinite(s)) return false
  return side === 'long' ? m <= s : m >= s
}

/**
 * Minimum improvement, as a fraction of price, before the resting order is replaced.
 *
 * Every move is a cancel and a place: two /exchange requests out of the same rate budget an
 * order placement needs, on every tick of a trending market. A tenth of a percent is far
 * inside any retracement worth setting, so nothing is given up by batching the ratchet.
 */
export const MIN_STOP_MOVE = 0.001

/**
 * Should the resting stop be replaced?
 *
 * Only ever in the favourable direction, and only when it is worth the two requests. A stop
 * that moved backwards would be a trailing stop that gives back more than it promised, so
 * that case is refused outright rather than rate-limited.
 */
export function shouldMoveStop(side, restingPx, nextPx, minMove = MIN_STOP_MOVE) {
  const n = parseFloat(nextPx)
  if (!Number.isFinite(n) || n <= 0) return false
  const r = parseFloat(restingPx)
  if (!Number.isFinite(r)) return true                    // nothing resting yet
  const improved = side === 'long' ? n > r : n < r
  if (!improved) return false
  return Math.abs(n - r) / n >= minMove
}

/**
 * How much of the position to close, from a percentage or an absolute size.
 *
 * Clamped to what is actually held: a stop for more than the position would be rejected by
 * the exchange, and one placed while the position was larger must not keep trying to sell
 * size that has since been closed by hand.
 */
export function resolveSize(positionSz, { pct = null, size = null } = {}) {
  const held = Math.abs(parseFloat(positionSz) || 0)
  if (!(held > 0)) return 0
  if (size != null && size !== '') {
    const s = Math.abs(parseFloat(size))
    return Number.isFinite(s) && s > 0 ? Math.min(s, held) : 0
  }
  const p = parseFloat(pct)
  if (!Number.isFinite(p) || p <= 0) return 0
  return Math.min(held, held * (Math.min(p, 100) / 100))
}

/**
 * Everything wrong with a proposed trailing stop, in the order a person would hit them.
 *
 * Returned as a list rather than thrown: the modal shows the first one under the field and
 * the Confirm button reads `!errors.length`, so a half-filled form explains itself instead of
 * failing on submit.
 */
export function validate({ side, positionSz, amount, unit = '%', pct = 100, size = null,
                           activationPx = null, markPx = null } = {}) {
  const errs = []
  const held = Math.abs(parseFloat(positionSz) || 0)
  if (!(held > 0)) errs.push('No open position to trail.')

  const a = parseFloat(amount)
  if (!Number.isFinite(a) || a <= 0) errs.push('Enter a retracement.')
  else if (unit === '%' && a >= 100) errs.push('A 100% retracement would never trigger.')
  else if (unit === '$' && markPx != null && a >= Math.abs(parseFloat(markPx)))
    errs.push('That retracement is wider than the price.')

  if (!(resolveSize(held, { pct, size }) > 0)) errs.push('Enter a size to close.')

  if (activationPx != null && activationPx !== '') {
    const ap = parseFloat(activationPx)
    if (!Number.isFinite(ap) || ap <= 0) errs.push('Activation price must be a number.')
    // An activation price already behind the market activates instantly, which is not what
    // someone setting one means — they are waiting for a level that has not been reached.
    else if (markPx != null && Number.isFinite(parseFloat(markPx))) {
      const m = parseFloat(markPx)
      if (side === 'long' && ap <= m) errs.push('Activation price is already below the mark — it would start immediately.')
      if (side === 'short' && ap >= m) errs.push('Activation price is already above the mark — it would start immediately.')
    }
  }
  return errs
}

/** The sentence under the form, with the numbers filled in once they are known. */
export function describe({ side, amount, unit = '%', best = null, markPx = null, activationPx = null } = {}) {
  const amt = Number.isFinite(parseFloat(amount)) && parseFloat(amount) > 0
    ? (unit === '%' ? parseFloat(amount) + '%' : '$' + parseFloat(amount))
    : '--'
  const ref = best ?? markPx
  const px  = stopPrice(side, ref, amount, unit)
  const from = side === 'long' ? 'highest' : 'lowest'
  const head = (activationPx != null && activationPx !== '')
    ? `Once the mark reaches ${activationPx}, this starts tracking the ${from} price. `
    : ''
  return head + `When the mark price retraces by ${amt} from the ${from} price recorded since activation, `
    + `a stop market order closes the position` + (px ? ` — around ${px.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} at today's mark.` : '.')
}
