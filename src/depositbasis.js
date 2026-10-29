/**
 * INSOLVENT TERMINAL — what a wallet has put in, for the leaderboard's ROE
 *
 * ROE is net PnL over what the account started with, and the board estimated that as
 * `accountValue - netPnl`. Once profits are withdrawn that goes negative: Spartan, +$922 on an
 * account now worth $518, had a "start" of -$404 and no ROE at all — and the board's best
 * performers were exactly the rows sorted to the bottom without one ("why some accounts dont
 * show the roe").
 *
 * The fallback basis is every dollar that ever came IN: bridge deposits and transfers received
 * from another wallet. Withdrawals are not subtracted — that is the arithmetic that went negative.
 * A spot <-> perp move (accountClassTransfer) is one account between its own pockets and is not
 * money in; neither is a rewards claim, which is earned rather than put up.
 *
 * Read by server.js from userNonFundingLedgerUpdates, carried forward per row like the fills.
 */

const PEER_TYPES = new Set(['send', 'spotTransfer', 'internalTransfer', 'subAccountTransfer'])

/** USD that one ledger entry brought into `addr`; 0 for anything that is not money arriving. */
export function inflowOf(entry, addr) {
  const d = entry?.delta
  const me = String(addr ?? '').toLowerCase()
  if (!d || !me) return 0
  let v = 0
  if (d.type === 'deposit') v = parseFloat(d.usdc)
  else if (PEER_TYPES.has(d.type)) {
    const to = String(d.destination ?? '').toLowerCase(), from = String(d.user ?? '').toLowerCase()
    if (to !== me || from === me) return 0
    v = parseFloat(d.usdcValue ?? d.usdc)
  }
  return Number.isFinite(v) && v > 0 ? v : 0
}

/** Sum of inflowOf over entries; the newest entry's time, so the next read starts after it. */
export function depositStep(state, entries, addr) {
  let deposited = Number(state?.deposited) || 0
  // Judged against where this read STARTED, not the newest seen so far: two entries in the same
  // millisecond are both new.
  const floor = Number.isFinite(state?.lastLedgerTs) ? state.lastLedgerTs : -Infinity
  let lastLedgerTs = floor
  for (const e of Array.isArray(entries) ? entries : []) {
    const t = Number(e?.time)
    if (!Number.isFinite(t) || t <= floor) continue   // already counted
    deposited += inflowOf(e, addr)
    if (t > lastLedgerTs) lastLedgerTs = t
  }
  return { deposited, lastLedgerTs }
}
