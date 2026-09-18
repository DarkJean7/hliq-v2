/**
 * INSOLVENT TERMINAL — cancelling a set of orders, and saying honestly what happened
 *
 * Three copies of this logic existed: Cancel All on desktop, Cancel All on mobile, and Cancel
 * Selected. Each had its own copy of the same twenty lines — including the two subtleties
 * below, which is exactly the kind of thing that gets fixed in one copy and not the others.
 * Adding "cancel every order on one asset" as a fourth copy was not an option.
 *
 * Two subtleties worth stating once, here:
 *
 *  1. A batch cancel that partly fails THROWS. The SDK raises ApiRequestError when any single
 *     cancel is rejected, and the per-order statuses are inside the error, not the result. Read
 *     only the happy path and a batch where one order had already filled looks like a total
 *     failure, leaving nine cancelled orders on screen.
 *
 *  2. "Already gone" is success. never placed / already cancelled / filled all mean the order
 *     is not resting any more, which is what the user asked for. Reporting those as failures
 *     taught people to press the button again.
 *
 * One payload is signed by ONE account — cancelOrders refuses a mixed batch rather than sign
 * another wallet's order with whoever happens to be connected. So a selection spanning wallets
 * is split per account and sent as one batch each, which is what lets an asset-wide cancel work
 * in the combined view at all.
 */

/** 'buy' or 'sell' for an order, however the side arrived. */
export function sideOf(o) {
  const s = String(o?.side ?? '')
  return (s === 'B' || /^buy$/i.test(s)) ? 'buy' : 'sell'
}

/**
 * Orders for one asset, optionally on one side.
 *
 * Matched on the EXACT coin id, never the display label: HIP-3 coins are dex-prefixed
 * ("xyz:SPCX") and renamed for display, so two different markets can show the same name, and
 * cancelling by what is on screen could reach into the wrong one.
 *
 * The side is the point rather than a refinement: "clear my HYPE bids" is a different
 * intention from "close out HYPE", and a ladder usually has a position resting against it on
 * the other side. Cancelling both would take out the exits with the entries.
 */
export function ordersForCoin(orders, coin, side = null) {
  const c = String(coin ?? '')
  if (!c) return []
  const want = side == null ? null : (side === 'B' ? 'buy' : side === 'A' || side === 'S' ? 'sell' : String(side).toLowerCase())
  return (orders ?? []).filter(o =>
    String(o?.coin ?? '') === c && (want == null || sideOf(o) === want))
}

/** Split a selection into one batch per owning account, since one payload is signed by one
 *  account. A single-account view has no `_acctAddr` at all and yields one batch keyed ''. */
export function byAccount(orders) {
  const out = new Map()
  for (const o of orders ?? []) {
    const k = String(o?._acctAddr ?? '').toLowerCase()
    if (!out.has(k)) out.set(k, [])
    out.get(k).push(o)
  }
  return out
}

/** The per-order statuses, from either a result or the error a partial failure throws. */
export function statusesFrom(resultOrError) {
  const r = resultOrError
  return r?.response?.data?.statuses            // a result
    ?? r?.response?.response?.data?.statuses    // an ApiRequestError
    ?? []
}

/**
 * An order the exchange says is no longer resting is a SUCCESS: it is gone, which is what was
 * asked for. Reporting these as failures taught people to press the button again.
 *
 * Exported because the single-order cancels test the same thing against an error MESSAGE
 * rather than a status, and the rule belongs in one place whichever shape it arrives in.
 */
const GONE = /never placed|already cancel|filled/i
export function isAlreadyGone(text) { return GONE.test(String(text ?? '')) }

/**
 * Pair each order with its status and split into done and failed.
 *
 * No statuses at all means the call succeeded without itemising (or the shape changed) — the
 * batch is taken as done, because the alternative is telling the user nothing happened while
 * their orders quietly vanish from the exchange.
 */
export function classifyCancels(orders, statuses) {
  const list = orders ?? []
  const st   = statuses ?? []
  if (!st.length) return { ok: [...list], failed: [] }
  const ok = [], failed = []
  list.forEach((o, i) => {
    const s = st[i]
    if (!s || s === 'success' || (s && s.success !== undefined)) ok.push(o)
    else if (s?.error && GONE.test(s.error)) ok.push(o)
    else failed.push({ order: o, error: s?.error ?? 'failed' })
  })
  return { ok, failed }
}

/** "8 buy limit · 2 sell limit" — what a confirm needs so the count is never a surprise. */
export function describeOrders(orders, kindLabel = (k) => k) {
  const counts = new Map()
  for (const o of orders ?? []) {
    const side = (o?.side === 'B' || o?.side === 'b' || o?.isBuy) ? 'buy' : 'sell'
    const kind = o?._kind ?? (o?.isTrigger ? 'trigger' : 'limit')
    const k = `${side} ${kindLabel(kind)}`.toLowerCase()
    counts.set(k, (counts.get(k) ?? 0) + 1)
  }
  return [...counts].map(([k, n]) => `${n} ${k}`).join(' · ')
}

/** "✓ Cancelled 10 orders" / "8 cancelled, 2 failed" — one wording for every caller. */
export function summarize(ok, failed) {
  const n = ok?.length ?? 0, f = failed?.length ?? 0
  if (!f) return `✓ Cancelled ${n} order${n === 1 ? '' : 's'}`
  if (!n) return `Could not cancel ${f} order${f === 1 ? '' : 's'}`
  return `${n} cancelled, ${f} failed`
}
