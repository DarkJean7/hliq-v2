/**
 * How a list of positions or orders sorts, on every screen.
 *
 * Asked: "lets make desktop pnl and every sort match the same mobile behaviour". The two shells had
 * opposite meanings for the same arrow: on the phone ▼ put the lowest PnL first, and on desktop it
 * put the highest. These are the phone's rules, in one place, so they cannot come apart again.
 *
 * POSITIONS: ▲ (dir 1) biggest first, ▼ (dir -1) lowest first; a name reads A→Z on ▼. A new column
 * starts on ▼, so the first press of PnL shows the worst position on top, which is what a phone has
 * always opened on.
 *
 * ORDERS: ▲ (dir 1) biggest first and A→Z, ▼ the reverse. A new column starts on ▲.
 *
 * Pure: no DOM, no state.
 */

// A value missing from a row (an order with no estimated PnL) goes last whichever way it is sorted:
// infinities would otherwise subtract to NaN, and NaN leaves a sort in no order at all.
const numCmp = (av, bv, dir) => {
  const aOk = Number.isFinite(av), bOk = Number.isFinite(bv)
  if (!aOk || !bOk) return aOk === bOk ? 0 : aOk ? -1 : 1
  return dir * (bv - av)
}

export const POS_FIRST_DIR = -1
export function posCmp(av, bv, dir) {
  if (typeof av === 'string' || typeof bv === 'string') return -dir * String(av).localeCompare(String(bv))
  return numCmp(av, bv, dir)
}

export const ORD_FIRST_DIR = 1
export function ordCmp(av, bv, dir) {
  if (typeof av === 'string' || typeof bv === 'string') return dir * String(av).localeCompare(String(bv))
  return numCmp(av, bv, dir)
}

/** Sorting by side: buys first on ▲, then by coin within each, or the blocks come out in any order. */
export function ordSideCmp(a, b, dir) {
  const sa = a.side === 'B' ? 0 : 1, sb = b.side === 'B' ? 0 : 1
  return sa !== sb ? dir * (sa - sb) : String(a.coin).localeCompare(String(b.coin))
}

/**
 * Which account a merged row features, following the sort: the one that put the coin where it is.
 * A coin held on several accounts sits where its first account lands, so a row can read −$27 and
 * still rank first on "biggest PnL" because one of its accounts is up. Naming that account is what
 * makes the order make sense. `metric`: 'pnl' | 'value' | anything else (the riskiest account).
 * members: [{ uPnl, posVal, healthPct, acct }]; `worst` is aggregatePosGroup's riskiest.
 */
export function featuredMember(members, metric, dir, worst) {
  const top = dir > 0
  const pick = (k) => members.reduce((f, m) => (top ? m[k] > f[k] : m[k] < f[k]) ? m : f, members[0])
  if (metric === 'pnl') return { mode: 'pnl', top, member: pick('uPnl') }
  if (metric === 'value') return { mode: 'value', top, member: pick('posVal') }
  return { mode: 'health', top, member: worst ?? members[0] }
}
