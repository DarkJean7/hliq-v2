/**
 * INSOLVENT TERMINAL — where liquidation really sits once a guard has done its work
 *
 * A Liq Guard adds margin as price approaches liquidation; a Lev Brake trims size. Either way
 * the liquidation price the exchange reports is the one for RIGHT NOW, before the guard has
 * fired — so a guarded position is safer than its own card says. Asked for in those words:
 * "the 'real' liquidation price if all of the fires from the liq guard are fired".
 *
 * This is that projection, and it is also what the guard modal's plan table draws, so there is
 * one copy of the arithmetic rather than a card and a modal that can disagree.
 *
 * ── the model ──
 *
 * Hyperliquid's isolated liquidation price, with maintenance fraction mf = 1 / (2 × maxLev):
 *
 *     long:   liq = (size × entry − margin) / (size × (1 − mf))
 *     short:  liq = (size × entry + margin) / (size × (1 + mf))
 *
 * At a FIXED size, liq moves linearly in margin — $1 of margin moves it by
 * 1 / (size × (1 ∓ mf)) — which is the slope the Liq Guard walks. The Lev Brake changes size
 * instead, holding the same isolated margin, so its liq is recomputed from the formula.
 *
 * Each fire happens at its own trigger price: `trigPct` of the way from entry toward the
 * liquidation price AS IT STANDS after the previous fire — so the fires spread out as the
 * guard pushes liquidation away, which is why this is a loop and not a multiplication.
 *
 * Estimates, deliberately: fills, fees and funding move the real numbers a little, and a
 * guard that is out of fires or out of budget stops early — which the projection also does.
 */

/** Maintenance-margin fraction for a market: half the reciprocal of its max leverage. */
export const maintFraction = (maxLev) => (maxLev > 0 ? 1 / (2 * maxLev) : 0)

/** Liquidation price for a size/margin, same model as above. Null when it cannot be had. */
export function liqPriceFor({ isLong, size, entry, margin, maxLev }) {
  const mf = maintFraction(maxLev)
  if (!(size > 0) || !(entry > 0)) return null
  const v = isLong
    ? (size * entry - margin) / (size * (1 - mf))
    : (size * entry + margin) / (size * (1 + mf))
  return Number.isFinite(v) ? Math.max(0, v) : null
}

/**
 * The isolated margin the position actually holds, inferred from the liquidation price the
 * exchange reports. Used by the brake, where size changes and that margin stays put.
 */
export function impliedMargin({ isLong, size, entry, liq, maxLev }) {
  const mf = maintFraction(maxLev)
  return isLong ? size * (entry - (1 - mf) * liq) : size * ((1 + mf) * liq - entry)
}

/**
 * Project the remaining fires.
 *
 * Position: `isLong, entry, size, liq, margin, maxLev`.
 * Guard:    `mode` ('liqguard' | 'levbrake'), `trigPct` (percent), `maxFires`,
 *           `firesUsed`, `added` (what it has already spent),
 *           liqguard: `addMode` ('target' | 'fixed'), `maxTotal`, `targetLev`
 *           levbrake: `reducePct` (percent of the position, each fire).
 *
 * Returns `{ rows, finalLiq, totalAdd, finalSize, firesLeft, exhausted }`, where each row is
 * `{ px, liq, add?, cut?, size? }` — numbers only, so the caller formats and translates.
 * `rows` is empty when nothing can be projected, and then `finalLiq` is the liq as it stands.
 */
export function guardPlan(cfg = {}) {
  const {
    mode = 'liqguard', isLong = true, entry = 0, size = 0, liq = 0, margin = 0, maxLev = 0,
    trigPct = 0, maxFires = 0, firesUsed = 0, added = 0,
    addMode = 'fixed', maxTotal = 0, targetLev = 0, reducePct = 0,
  } = cfg
  const out = { rows: [], finalLiq: liq > 0 ? liq : null, totalAdd: 0, finalSize: size, firesLeft: 0, exhausted: false }
  const pct = Number(trigPct) / 100
  if (!(liq > 0) || !(size > 0) || !(pct > 0) || !(entry > 0)) return out

  const mf = maintFraction(maxLev)
  const used = Math.max(0, Number(firesUsed) || 0)
  const remaining = Math.max(0, (Number(maxFires) || 0) - used)
  out.firesLeft = remaining
  out.exhausted = remaining <= 0
  // Each fire triggers a share of the way from entry to the liq price AS IT THEN IS.
  const trigFrom = (l) => (isLong ? entry - pct * (entry - l) : entry + pct * (l - entry))

  if (mode === 'liqguard') {
    const cap = Number(maxTotal) || 0
    if (cap <= 0) return out
    const slope = isLong ? 1 / (size * (1 - mf)) : 1 / (size * (1 + mf))   // Δliq per $1 of margin
    let cur = liq, m = margin, spent = Math.max(0, Number(added) || 0)
    for (let i = 0; i < remaining; i++) {
      const room = cap - spent
      if (room <= 0.01) { out.exhausted = true; break }
      const px = trigFrom(cur)
      let add
      if (addMode === 'target' && Number(targetLev) > 0) {
        // Top up to the target leverage AT THE TRIGGER PRICE, where the loss is already taken.
        const uPnlAtPx = (isLong ? px - entry : entry - px) * size
        add = Math.max(0, (size * px) / Number(targetLev) - (m + uPnlAtPx))
      } else {
        add = cap / Math.max(1, Number(maxFires) || 1)
      }
      add = Math.min(add, room)
      if (add < 0.01) { out.rows.push({ px, liq: cur, add: 0 }); continue }
      cur = Math.max(0, isLong ? cur - add * slope : cur + add * slope)
      out.rows.push({ px, liq: cur, add })
      m += add; spent += add; out.totalAdd += add
    }
    out.finalLiq = cur
    return out
  }

  // Lev Brake: size comes off, the isolated margin stays, so liq is recomputed each time.
  const r = Number(reducePct) / 100
  if (!(r > 0)) return out
  const M = impliedMargin({ isLong, size, entry, liq, maxLev })
  let cur = liq, s = size
  for (let i = 0; i < remaining; i++) {
    const px = trigFrom(cur)
    const cut = s * r
    const next = s - cut
    if (next <= 0) break
    const nextLiq = isLong
      ? (next * entry - M) / (next * (1 - mf))
      : (next * entry + M) / (next * (1 + mf))
    cur = Math.max(0, nextLiq)
    out.rows.push({ px, liq: cur, cut, size: next })
    s = next
  }
  out.finalLiq = cur
  out.finalSize = s
  return out
}

/**
 * How much further from the mark the guarded liquidation price sits, as a percentage of the
 * mark — the one number that says whether a guard is worth anything on this position.
 * Null when either price is missing.
 */
export function liqRoom(liq, mark) {
  if (!(liq > 0) || !(mark > 0)) return null
  return Math.abs(mark - liq) / mark * 100
}
