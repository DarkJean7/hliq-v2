/**
 * INSOLVENT TERMINAL — telling a transfer apart from a trade
 *
 * Every equity figure in this app is a bridge:
 *
 *     value = portfolio snapshot + (live perp equity − perp equity when the snapshot was taken)
 *
 * The snapshot is HL's own unified account value (spot included) and is up to five minutes
 * old; the perp delta carries it to now. That is only sound while every move in perp equity
 * is a move in the ACCOUNT's value — and it is not. On a unified account Hyperliquid moves
 * USDC between the spot and perp sides on its own: funding a new position's margin, reserving
 * margin when an order is placed, a bot's usdClassTransfer top-up. Perp equity jumps; the
 * account is worth exactly what it was a second earlier. The bridge publishes the transfer as
 * profit and holds it until the next snapshot lands, which is the reported "equity spikes with
 * a fake value when orders are placed or closed, then fixes itself".
 *
 * The quantity that does NOT move on a price tick is perp CASH:
 *
 *     cash = perp account value − unrealized PnL on the perp side
 *
 * Marks moving change unrealized and leave cash alone. So a change in cash is never the
 * market. It is one of two things, and they need opposite treatment:
 *
 *   TRANSFER — margin moved in or out, or an order reserved it. The account's total is
 *              unchanged, so the anchor must absorb it and the headline must not move.
 *   TRADE    — something filled. Realized PnL is real money and must reach the headline,
 *              but a fill usually drags a margin transfer along with it, and from the
 *              outside the two are one number. Neither treatment is right, so the only
 *              honest answer is to re-read HL's snapshot for that wallet.
 *
 * What separates them is whether any position CHANGED SIZE. A transfer cannot move a
 * position; a fill always does. That is the whole discriminator, and it is why this takes a
 * fingerprint of the position sizes rather than asking whether fills were fetched — the old
 * single-account version keyed off the fills tick, so between fills ticks a transfer went
 * uncorrected for up to fifteen seconds, and the combined view had no check at all.
 *
 * Main dex only, everywhere. `marginSummary.accountValue` is main-dex, while `assetPositions`
 * has HIP-3 positions merged in by the time the app sees it, so summing unrealized across both
 * subtracts builder-dex PnL from a main-dex equity figure and makes ordinary HIP-3 drift look
 * like a transfer on every tick.
 */

/** A HIP-3 (builder dex) coin is namespaced "dex:COIN". Main-dex coins never contain a colon. */
const isHip3 = (c) => String(c ?? '').includes(':')

/** The main-dex positions out of a merged assetPositions array. Accepts either shape HL
 *  returns: `{ position: {...} }` or the bare position. */
export function mainPositions(assetPositions) {
  return (assetPositions ?? [])
    .map(ap => ap?.position ?? ap)
    .filter(p => p && !isHip3(p.coin))
}

/**
 * An order-independent fingerprint of what is open and how big it is.
 *
 * Size, not just the coin list: a partial fill leaves the same coins open and is still a
 * trade. Formatted from the raw string HL sent rather than a parsed float, so an unchanged
 * position always produces a byte-identical key.
 */
export function posFingerprint(assetPositions) {
  return mainPositions(assetPositions)
    .map(p => String(p.coin) + ':' + String(p.szi))
    .sort()
    .join(',')
}

/** Perp cash: account value with unrealized PnL taken back out. Null if unreadable — a
 *  guess here would re-anchor on nothing. */
export function perpCash(perpAccountValue, assetPositions) {
  const av = parseFloat(perpAccountValue)
  if (!Number.isFinite(av)) return null
  let unreal = 0
  for (const p of mainPositions(assetPositions)) {
    const v = parseFloat(p.unrealizedPnl ?? 0)
    if (Number.isFinite(v)) unreal += v
  }
  return av - unreal
}

/** Both halves of a reading, ready to compare against the next one. */
export function cashSample(perpAccountValue, assetPositions) {
  const cash = perpCash(perpAccountValue, assetPositions)
  return cash == null ? null : { cash, fp: posFingerprint(assetPositions) }
}

/**
 * Below this, leave it alone.
 *
 * Funding settles hourly into cash with no position change, so it reads as a transfer and
 * would be absorbed rather than shown. At these account sizes an hour of funding is cents to
 * a few cents, and the next snapshot puts it back regardless — where a margin transfer is
 * tens or hundreds of dollars and lasts until something forces a refresh. Set well under the
 * smallest transfer worth catching and over the largest rounding difference.
 */
export const CASH_TOL = 0.25

/**
 * What happened between two readings.
 *
 *   'flat'     — nothing but the market moved. Do nothing.
 *   'transfer' — cash moved with every position untouched. Shift the anchor by `delta` so
 *                the displayed value does not move.
 *   'trade'    — cash moved and a position changed. Re-read the snapshot for this wallet;
 *                do NOT shift, because part of `delta` is real realized PnL.
 *   'unknown'  — no comparable previous reading. Record this one and wait.
 */
export function classifyCashMove(prev, next, tol = CASH_TOL) {
  if (!prev || !next || !Number.isFinite(prev.cash) || !Number.isFinite(next.cash))
    return { kind: 'unknown', delta: 0 }
  const delta = next.cash - prev.cash
  if (Math.abs(delta) <= tol)  return { kind: 'flat', delta }
  if (prev.fp === next.fp)     return { kind: 'transfer', delta }
  return { kind: 'trade', delta }
}
