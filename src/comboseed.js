/**
 * INSOLVENT TERMINAL — a wallet's value from the server's copy, carried by price
 *
 * Reported as "when I open the app, Net PnL loads faster than account equity". Measured: 0.4s
 * against 6–7s on a reopen, 42s against 42s on a first open. Net PnL is quick because its slow
 * half (realized, fees, funding) does not move with price, so the server's copy is right however
 * old it is, and the half that moves is live on the phone within a second. The equity headline
 * is the sum of each wallet's own value (see _comboDisplayEquity), and it waited for every
 * wallet to be read afresh, one after another under the rate budget, because a row from last
 * session's cache is not a value for now.
 *
 * The server already reads every wallet's value, at most WALLET_FRESH_MS old. What it did not
 * send was what the wallet HELD when it was read, so a phone could not carry that value to now.
 * It sends it now, and a wallet's value until its own row is fresh is
 *
 *     value = server's value + Σ size × (price now − price when the server read it)
 *
 * -- exactly what a row does between its own snapshots (src/mtmbridge.js, _spotCarry), started
 * from a snapshot the server took instead. Nothing is bridged: there is no base, no second
 * figure to drift from, and a wallet switches to its own row the moment that row is fresh.
 *
 * What it does not see: HIP-3 positions (the server reads the main dex only), fees and anything
 * that moved money since the server's read. All of it bounded by the server's read being under a
 * minute old, and all of it corrected when the wallet's own row lands a few seconds later.
 */

/** A seed older than this is not a value for now; the wallet waits for its own row instead. */
export const SEED_MAX_MS = 3 * 60_000
/** A spot token the server could not price is ignored below this cost, and refuses the seed above it. */
export const SEED_UNPRICED_USD = 5

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

/**
 * Token name -> USDC mid, from `spotMetaAndAssetCtxs`. The first USDC-quoted pair of a token
 * wins, the same rule the client's _watchSpotKeyMap uses, so both sides price a token alike.
 */
export function spotPxFrom(metaAndCtxs) {
  const [meta, ctxs] = Array.isArray(metaAndCtxs) ? metaAndCtxs : []
  const tok = new Map((meta?.tokens ?? []).map(t => [t.index, t.name]))
  // By the pair's own name, never by position: the contexts are not in universe order, and
  // matching by index priced HYPE at $0.08.
  const ctxOf = new Map((ctxs ?? []).map(c => [c?.coin, c]))
  const out = {}
  ;(meta?.universe ?? []).forEach((u) => {
    if (u?.tokens?.[1] !== 0) return                 // USDC-quoted only
    const name = tok.get(u.tokens[0])
    if (!name || out[name] != null) return
    const c = ctxOf.get(u.name)
    const px = num(c?.midPx) ?? num(c?.markPx)
    if (px > 0) out[name] = px
  })
  return out
}

/**
 * What a wallet held when the server read it: `{ perp: {coin: [szi, mark]}, spot: {coin: [size, px]} }`.
 * Null when a holding worth counting cannot be priced -- a seed that silently leaves out a token
 * would carry the wallet as though it did not own it.
 */
export function seedBook(assetPositions, spotBalances, spotPx) {
  const perp = {}
  for (const ap of assetPositions ?? []) {
    const p = ap?.position ?? ap
    const szi = num(p?.szi), pv = num(p?.positionValue)
    if (!p?.coin || !szi || pv == null) continue
    perp[p.coin] = [szi, Math.abs(pv) / Math.abs(szi)]
  }
  const spot = {}
  for (const b of spotBalances ?? []) {
    const size = num(b?.total)
    if (!b?.coin || b.coin === 'USDC' || !(size > 0)) continue
    const px = spotPx?.[b.coin]
    if (px > 0) { spot[b.coin] = [size, px]; continue }
    if ((num(b.entryNtl) ?? 0) >= SEED_UNPRICED_USD) return null
  }
  return { perp, spot }
}

/**
 * The seed carried to now. Null -- not the uncarried value -- when it is too old, or when any
 * holding it would carry has no live price yet: the headline then waits rather than publish a
 * figure with a price move missing (empty is not the same as unknown).
 *
 * `perpMid(coin)` and `spotMid(token)` are the live prices; both answer 0 or null when unknown.
 */
export function seedValue(seed, perpMid, spotMid, now = Date.now()) {
  const v = num(seed?.value), at = num(seed?.at)
  if (!(v > 0) || !(at > 0) || now - at > SEED_MAX_MS || !seed.book) return null
  let d = 0
  for (const [coin, [szi, mark]] of Object.entries(seed.book.perp ?? {})) {
    const m = num(perpMid(coin))
    if (!(m > 0)) return null
    d += szi * (m - mark)
  }
  for (const [coin, [size, px]] of Object.entries(seed.book.spot ?? {})) {
    const m = num(spotMid(coin))
    if (!(m > 0)) return null
    d += size * (m - px)
  }
  return v + d
}
