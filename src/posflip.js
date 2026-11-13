// Flip a position to the other side in one order.
//
// Asked for: "if i have 1 long btc, open a 2 btc short so it closes the position and opens 1
// short btc". One market order for twice the size, the other way, NOT reduce-only: the first
// half closes the position, the second opens the new one. Same leverage and margin mode as the
// position it replaces, so a 10x cross long becomes a 10x cross short rather than whatever the
// trade ticket was last left on.
//
// Pure: main.js supplies the position and places the order (window.__posFlip).

/**
 * @param pos  a Hyperliquid position: { coin, szi, leverage: { type, value } }
 * @returns { coin, isBuy, sz, from, to, leverage, isIsolated } or null when there is nothing to flip
 */
export function flipPlan(pos) {
  const szi = parseFloat(pos?.szi ?? 0)
  if (!pos?.coin || !Number.isFinite(szi) || szi === 0) return null
  const size = Math.abs(szi)
  return {
    coin: pos.coin,
    isBuy: szi < 0,                         // a short flips by buying, a long by selling
    // Twice a valid size is a valid size: same number of decimals, so no rounding can leave a
    // sliver of the old position behind or open a different size than the one closed.
    sz: size * 2,
    size,
    from: szi > 0 ? 'long' : 'short',
    to:   szi > 0 ? 'short' : 'long',
    leverage: Math.max(1, Math.round(parseFloat(pos.leverage?.value ?? 1)) || 1),
    isIsolated: pos.leverage?.type === 'isolated',
  }
}

/**
 * What the order did, from the exchange's answer. IOC can fill only part: then the position is
 * somewhere between closed and flipped, and the reader must be told which, not "done".
 */
export function flipOutcome(plan, filledSz) {
  const f = Math.max(0, Number(filledSz) || 0)
  const eps = plan.size * 1e-6
  if (f <= eps) return { kind: 'none' }
  if (f >= plan.sz - eps) return { kind: 'flipped' }
  if (f >= plan.size - eps) return { kind: 'partial', left: f - plan.size, side: plan.to }      // closed, part opened
  return { kind: 'partial', left: plan.size - f, side: plan.from }                                // part closed only
}
