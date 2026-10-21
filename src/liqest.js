/**
 * Estimated liquidation price of a CROSS position after an order — the "Est. Liq Price" in the
 * order preview.
 *
 * Reported: adding 5 VVV to a 5 VVV long previewed a liq price of $27.20 — ABOVE the $25.91
 * price, for a long, which would mean already liquidated — while Hyperliquid showed N/A for the
 * same order. Two faults:
 *
 *   - The position had no liq price of its own (null: nothing liquidates it), and the preview
 *     only knew how to "add to a position" by scaling the current liq price. Without one it
 *     fell through to the fresh-position branch and treated all 10 VVV as new.
 *   - That branch backed the position with the PERP account value. On a unified account the
 *     collateral is the SPOT USDC balance ($756.03 here), not the perp-side figure ($588.92).
 *
 * The model, which is Hyperliquid's own: you are liquidated when what backs your cross
 * positions falls to the maintenance margin they need. Moving this coin's price to P, with
 * everything else held where it is:
 *
 *     equity + newSzi × (P − mark)  =  otherMaint + |newSzi| × P × mmr
 *
 * Checked against HL's own liq prices on the reporting account: HYPE 68.739 and SOL 32.533 both
 * come out to the cent with equity = spot USDC total (756.03), and neither does with the perp
 * account value. Adding the 5 VVV then gives a price below zero — N/A, as HL says.
 */

/**
 * What backs cross positions on the USDC books.
 *
 * Unified (or portfolio margin): the spot USDC balance — which on a unified account already
 * carries unrealized PnL — less margin locked in isolated positions. Standard: the perp
 * account value. Null when the figure needed is not there: unknown is not zero, and a zero
 * here would put a liq price at the current price.
 */
export function crossEquity({ unified, spotBalances, dexStates, perpAccountValue }) {
  if (unified) {
    const usdc = (spotBalances ?? []).find(b => Number(b?.token) === 0 || String(b?.coin).toUpperCase() === 'USDC')
    const total = parseFloat(usdc?.total ?? NaN)
    if (!Number.isFinite(total)) return null
    let iso = 0
    for (const d of dexStates ?? []) for (const ap of d?.assetPositions ?? []) {
      const p = ap?.position ?? ap
      if (p?.leverage?.type === 'isolated') iso += Math.abs(parseFloat(p.marginUsed ?? 0)) || 0
    }
    return total - iso
  }
  const av = parseFloat(perpAccountValue ?? NaN)
  return Number.isFinite(av) ? av : null
}

/** Cross maintenance margin summed over every dex — the same total HL measures health with. */
export function totalCrossMaint(dexStates) {
  let s = 0
  for (const d of dexStates ?? []) { const m = parseFloat(d?.crossMaintenanceMarginUsed ?? 0); if (Number.isFinite(m)) s += m }
  return s
}

/**
 * The price at which the position is liquidated after the order.
 *
 * `curSzi`/`newSzi` signed sizes before and after; `mark` the price everything is marked at now;
 * `price` where the order fills; `fee` what it costs. Returns:
 *   { px: number }           a liquidation price
 *   { px: null, none: true } nothing liquidates it — a long whose price would be ≤ 0, or a
 *                            short with no finite price (HL shows "N/A")
 *   null                     not enough to say (no equity, no price)
 */
export function crossLiqPx({ curSzi = 0, newSzi, mark, price, fee = 0, equity, crossMaint = 0, mmr }) {
  if (!Number.isFinite(newSzi) || newSzi === 0) return null
  if (!(mark > 0) || !Number.isFinite(equity) || !(mmr > 0)) return null
  const px = price > 0 ? price : mark
  // The order's own effect on equity right after it fills: its fee, and the gap between where
  // it fills and where it is marked.
  const eq = equity - fee + (newSzi - curSzi) * (mark - px)
  // Maintenance for everything EXCEPT this coin, which is recomputed at P below.
  const other = Math.max(0, crossMaint - Math.abs(curSzi) * mark * mmr)
  const room = eq - other
  const a = Math.abs(newSzi)
  if (newSzi > 0) {
    const p = (a * mark - room) / (a * (1 - mmr))
    if (!(p > 0)) return { px: null, none: true }
    return { px: Math.min(p, mark) }          // above the mark would mean liquidated already
  }
  const p = (room + a * mark) / (a * (1 + mmr))
  if (!Number.isFinite(p)) return { px: null, none: true }
  return { px: Math.max(p, mark) }
}
