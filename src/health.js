/**
 * INSOLVENT TERMINAL — account health, the way Hyperliquid computes it
 *
 * The number on the Health bar is meant to be 100 minus Hyperliquid's Unified Account Ratio,
 * the figure their own UI shows under "Unified Account Summary". It was not. Reported side by
 * side: we said 89.1% while Hyperliquid said the ratio was 16.10%, which is 83.9%.
 *
 * We were computing `1 − crossMaintenanceMarginUsed / portfolioValue`. Both halves were wrong,
 * and both in the direction that flatters — the worst way for a liquidation gauge to be wrong.
 *
 *   NUMERATOR   crossMaintenanceMarginUsed off the main clearinghouse state is MAIN DEX ONLY.
 *               A position on a builder dex has its own maintenance margin and it was not
 *               counted. Measured on one live account: 133.73 main + 7.66 on xyz.
 *
 *   DENOMINATOR portfolio value is everything the account is worth — including spot tokens and
 *               unrealized PnL. That is not what backs a cross position. The collateral is the
 *               SPOT BALANCE of the quote token, less whatever isolated positions have locked
 *               away. On the same account: $903.95 of USDC, not the $1,211.55 portfolio value
 *               that included ~$354 of HYPE. Holding HYPE does not protect a USDC-collateralised
 *               position from liquidation.
 *
 *   Ours: 1 − 133.73 / 1211.55 = 89.0%      HL: 1 − 141.39 / 903.95 = 84.4%
 *
 * ── the algorithm ──
 *
 * Transcribed from `computeUnifiedAccountRatio` in Hyperliquid's own docs (Trading → Account
 * abstraction modes → Unified Account Ratio). Per COLLATERAL TOKEN: sum cross maintenance
 * margin across every dex that settles in that token, divide by that token's spot balance less
 * the isolated margin locked in it, and take the WORST token. A max, not an average: you are
 * liquidated on the book that runs out first, so an average would hide exactly the case the
 * gauge exists to show.
 */

/** USDC is token 0 and collateralises the main dex and almost every builder dex. */
export const USDC_TOKEN = 0

/**
 * Hyperliquid's Unified Account Ratio, as a fraction (0.1564 = 15.64%).
 *
 * `dexStates` is one entry per perp dex the account has state on, each
 * `{ crossMaintenanceMarginUsed, assetPositions, collateralToken? }`. `spotBalances` is the
 * spot clearinghouse state's balances — under a unified account that IS the trading balance
 * for both spot and perps, which is why it is the denominator.
 *
 * Returns null when there is nothing to divide by. Null is not zero: "no collateral found" is
 * not "perfectly healthy", and rendering 100% for it is how a gauge lies at the worst moment.
 */
export function unifiedAccountRatio(dexStates, spotBalances) {
  const crossByToken = new Map()
  const isoByToken   = new Map()

  for (const d of dexStates ?? []) {
    if (!d) continue
    // Builder dexes do not declare their collateral token on perpDexs, and all of the ones
    // that exist today settle in USDC. A dex that ever says otherwise is honoured.
    const token = Number.isFinite(d.collateralToken) ? d.collateralToken : USDC_TOKEN
    const cross = parseFloat(d.crossMaintenanceMarginUsed ?? 0)
    if (Number.isFinite(cross)) crossByToken.set(token, (crossByToken.get(token) ?? 0) + cross)
    for (const ap of (d.assetPositions ?? [])) {
      const p = ap?.position ?? ap
      if (p?.leverage?.type !== 'isolated') continue
      const m = Math.abs(parseFloat(p.marginUsed ?? 0))
      if (Number.isFinite(m)) isoByToken.set(token, (isoByToken.get(token) ?? 0) + m)
    }
  }
  if (!crossByToken.size) return null

  let worst = null
  for (const [token, cross] of crossByToken) {
    const bal = (spotBalances ?? []).find(b => Number(b?.token) === token)
    const spotTotal = parseFloat(bal?.total ?? NaN)
    if (!Number.isFinite(spotTotal)) continue
    const available = spotTotal - (isoByToken.get(token) ?? 0)
    if (!(available > 0)) continue
    const r = cross / available
    if (worst == null || r > worst) worst = r
  }
  return worst
}

/**
 * Health, 0–100, as the bar shows it. Null when the ratio cannot be computed.
 *
 * Not clamped at the bottom for cosmetic reasons — a ratio over 100% means maintenance margin
 * exceeds the collateral, which is a liquidatable account, and it should read 0 rather than a
 * negative number nobody can interpret.
 */
export function accountHealth(dexStates, spotBalances) {
  const r = unifiedAccountRatio(dexStates, spotBalances)
  if (r == null) return null
  return Math.max(0, Math.min(100, (1 - r) * 100))
}

/** The bar's colour band. Unknown is its own case: grey, never green. */
export function healthClass(pct) {
  if (pct == null || !Number.isFinite(pct)) return 'muted'
  return pct > 60 ? 'pos' : pct > 30 ? 'warn' : 'neg'
}

/**
 * The fallback for when there is no spot balance to divide by — a sub-account, a stale cache,
 * or a read that failed.
 *
 * This is the OLD formula, and it is kept only because a missing gauge is worse than an
 * approximate one. It is optimistic whenever the account holds spot tokens, so callers should
 * prefer the real ratio and treat this as a degraded mode rather than an equivalent.
 */
export function approxHealth(maintMargin, marginBase) {
  const m = parseFloat(maintMargin), b = parseFloat(marginBase)
  if (!Number.isFinite(m) || !Number.isFinite(b) || !(b > 0)) return null
  return Math.max(0, Math.min(100, (1 - m / b) * 100))
}
