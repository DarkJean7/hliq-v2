/**
 * Money moved between two wallets that are BOTH in the view is a transfer, not a deposit and a
 * withdrawal.
 *
 * Asked for from All Accounts: "when an account from all accounts send assets to another
 * account that is also in all accounts it should not count as a deposit or withdrawal. label
 * them just as transfers since thats what really happened ... i dont want the sum to affect the
 * real deposits/withdrawals cards". A $250 send from Spartan to Insolvent was booked twice --
 * Withdrawn $250 on one wallet, Deposited $250 on the other -- so the month's cards grew by
 * money that never entered or left the set of accounts on screen.
 *
 * The set is whatever the view covers, asked for when needed rather than remembered: main.js
 * hands over a function that answers with the combined view's wallets (addr -> label), or null
 * in a single account, where every send really is money in or out of the account shown.
 *
 * Its own module so it can be tested without a DOM; render.js's ledgerFlow consults it, and
 * that is the one rule every deposit/withdrawal figure in the app goes through.
 */

const _real = (a) => (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) ? a : null
const _owner = (entry, addr) => _real(entry?._acctAddr) ?? _real(addr)

let _peersFn = () => null
export function setLedgerPeers(fn) { _peersFn = typeof fn === 'function' ? fn : () => null }

const PEER_TYPES = ['send', 'spotTransfer', 'internalTransfer', 'subAccountTransfer']

function ends(entry, addr) {
  const t = entry?.delta?.type
  if (!PEER_TYPES.includes(t)) return null
  let peers = null
  try { peers = _peersFn() } catch {}
  if (!peers || typeof peers.get !== 'function') return null
  const d = entry.delta
  const own = String(_owner(entry, addr) ?? '').toLowerCase()
  const from = String(d.user ?? '').toLowerCase(), to = String(d.destination ?? '').toLowerCase()
  if (!from || !to || from === to) return null
  if (!peers.has(from) || !peers.has(to)) return null
  // The entry must belong to one of its two ends -- a ledger row from some third wallet that
  // merely names two of ours is not ours to relabel.
  if (own && own !== from && own !== to) return null
  return { from, to, own, fromName: peers.get(from) || from.slice(0, 6), toName: peers.get(to) || to.slice(0, 6) }
}

/** A transfer between two wallets in view. */
export function isPeerTransfer(entry, addr = null) { return ends(entry, addr) != null }

/**
 * The RECEIVING wallet's copy of a transfer between two in view. Each side keeps its own ledger
 * row for the same transfer; showing both lists one transfer twice. The sender's row stands for it.
 */
export function isPeerMirror(entry, addr = null) {
  const e = ends(entry, addr)
  return !!e && !!e.own && e.own === e.to
}

/** "Spartan → Insolvent", or null when it is not a transfer between two wallets in view. */
export function peerRoute(entry, addr = null) {
  const e = ends(entry, addr)
  return e ? `${e.fromName} → ${e.toName}` : null
}

/** A transfer's USD size, unsigned -- how much moved, not which way for whom. */
export function peerAmount(entry) {
  const d = entry?.delta ?? {}
  const v = parseFloat(d.usdcValue ?? d.usdc ?? 0)
  return Number.isFinite(v) ? Math.abs(v) : 0
}
