/**
 * INSOLVENT TERMINAL — the combined-equity bridge
 *
 * All Accounts shows one number for nine wallets. It comes from a server SNAPSHOT (complete,
 * authoritative, but up to a minute old) carried forward to now with a delta measured from the
 * live rows. The snapshot is the anchor; the delta is the bridge.
 *
 * The bridge used to be measured on PERP EQUITY ALONE:
 *
 *     val = snap.accountValue + (SUM(row._perpLive) - snap.perpBase)
 *
 * That is only correct while nothing moves between the spot and perp sides of a wallet. It
 * does move — placing a position, a bot topping up its margin, a usdClassTransfer — and then
 * perp equity falls by the amount transferred while the wallet's TOTAL is unchanged. The
 * bridge reported the whole transfer as a loss and held it until the next snapshot, which is
 * the reported "equity dips by roughly the margin, then fixes itself".
 *
 * Caught in telemetry (kind=eqstep) rather than guessed:
 *
 *     04:53  step -239.06 (5721.59 -> 5482.53)  snapMoved=1
 *            snapVal=5722.67  perpBase=2631.45  livePerp=2391.31  snapAge=11s
 *            worstWallet=0xaa7Ad5  worstDelta=-240.08  moved=1
 *     04:54  step +154.48 -> 5721.78            perpBase=2476.09  livePerp=2476.27
 *
 * One wallet, -240 on the perp side alone, recovered the moment the snapshot caught up.
 *
 * So the bridge is measured on each row's TOTAL instead. A row's accountValue already spans
 * both sides of that wallet, so a transfer between them nets to zero inside it and never
 * reaches the headline. Perp-only stays as the fallback for the case it was written for: a
 * snapshot adopted before the rows could be summed has no total to anchor against, and a
 * stale-by-a-minute bridge is still better than no bridge.
 */

/** Sum a field across rows. Returns null if ANY row cannot answer — a partial sum is a wrong
 *  total, and the caller must fall back rather than publish it. */
function sumOrNull(rows, pick) {
  let total = 0
  for (const r of rows ?? []) {
    const v = parseFloat(pick(r))
    if (!Number.isFinite(v)) return null
    total += v
  }
  return total
}

/**
 * The combined equity, or null when no basis is trustworthy.
 *
 * `snap`: { accountValue, perpBase, acctBase, wallets } — acctBase is the sum of the rows'
 *          own totals at the instant the snapshot was adopted, and may be absent.
 * `rows`: the visible per-wallet rows, each with `accountValue` and `_perpLive`.
 *
 * Returns { val, basis } where basis is 'total' or 'perp', so the caller can log which bridge
 * produced a figure without recomputing it.
 */
export function bridgeCombined(snap, rows) {
  if (!snap || !Array.isArray(rows)) return null
  const anchor = parseFloat(snap.accountValue)
  if (!Number.isFinite(anchor)) return null
  // The snapshot describes a specific set of wallets. If the visible set has changed since,
  // the anchor no longer corresponds to it and any delta measured against it is meaningless.
  if (rows.length !== snap.wallets) return null

  // Preferred: bridge on each wallet's TOTAL, which a spot/perp transfer cannot move.
  const acctBase = parseFloat(snap.acctBase)
  if (Number.isFinite(acctBase)) {
    const liveAcct = sumOrNull(rows, r => r.accountValue)
    if (liveAcct != null) return { val: anchor + (liveAcct - acctBase), basis: 'total' }
  }

  // Fallback: the original perp-only bridge.
  const perpBase = parseFloat(snap.perpBase)
  if (!Number.isFinite(perpBase)) return null
  const livePerp = sumOrNull(rows, r => r._perpLive)
  if (livePerp == null) return null
  return { val: anchor + (livePerp - perpBase), basis: 'perp' }
}

/**
 * How far a single row's total may move away from its perp move before it is read as an
 * artifact rather than as money. Generous on purpose: spot token holdings do drift with the
 * market between ticks, and absorbing real drift would be worse than letting a small one
 * through.
 */
export const ARTIFACT_TOL = 5

/**
 * Re-anchor for changes that are NOT profit and loss.
 *
 * Bridging on each row's total fixed the spot/perp transfer, and introduced a second
 * sensitivity: a row's accountValue is itself derived from a cached portfolio snapshot, so it
 * also steps when that cache fills or refreshes — and when a position closes and the row is
 * rebuilt. Caught in eqstep straight after the first fix:
 *
 *     05:17  step +156.15  basis=total  acctBase=5563.45  snapVal=5722.48  worstDelta=-0.97
 *     05:17  step -157.47  basis=total  acctBase=5722.72  (re-anchored, back where it started)
 *
 * The total moved 159 while the perp side moved under a dollar, and the next snapshot put it
 * straight back. That is the tell, and it is what separates the two cases: REAL profit moves a
 * wallet's total and its perp equity together, because the position lives on the perp side. A
 * row settling, a cache refreshing, or a close rebuilding the row moves the total ALONE.
 *
 * So each row's total move is compared against its own perp move, and the unexplained part is
 * folded into the anchor instead of being published as a gain. It reaches the headline on the
 * next server snapshot, which is the authority for anything that is not a price move.
 */
export function reanchor(prev, rows, acctBase) {
  const base = parseFloat(acctBase)
  if (!Number.isFinite(base) || !prev) return { acctBase, absorbed: 0, worst: null }
  let absorbed = 0, worst = null, worstAbs = 0
  for (const r of rows ?? []) {
    const p = prev.get(r.addr)
    if (!p) continue
    const acct = parseFloat(r.accountValue), perp = parseFloat(r._perpLive)
    if (![acct, perp, p.acct, p.perp].every(Number.isFinite)) continue
    // The part of this wallet's move that its own perp equity does not explain.
    const gap = (acct - p.acct) - (perp - p.perp)
    if (Math.abs(gap) <= ARTIFACT_TOL) continue
    absorbed += gap
    if (Math.abs(gap) > worstAbs) { worstAbs = Math.abs(gap); worst = { addr: r.addr, gap } }
  }
  return { acctBase: base + absorbed, absorbed, worst }
}

/** The per-wallet pair the next comparison needs. */
export function snapshotRows(rows) {
  const m = new Map()
  for (const r of rows ?? []) {
    m.set(r.addr, { acct: parseFloat(r.accountValue), perp: parseFloat(r._perpLive) })
  }
  return m
}

/**
 * The rows' summed total at snapshot-adoption time, to be stored on the snapshot.
 *
 * Returned separately rather than folded into the snapshot by the server: the server knows the
 * authoritative total, but only the client knows what its own rows currently add up to, and
 * the bridge needs BOTH ends measured the same way. Null when the rows cannot all answer, in
 * which case the snapshot simply carries no acctBase and the perp bridge is used.
 */
export function acctBaseFrom(rows) {
  return sumOrNull(rows, r => r.accountValue)
}
