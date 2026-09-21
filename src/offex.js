/**
 * INSOLVENT TERMINAL — off-exchange holdings
 *
 * Tokens you hold OUTSIDE Hyperliquid's spot book — a HyperEVM token in a wallet, NEST locked
 * on Nest Exchange, anything with a contract address — entered by hand and priced live, so
 * the Spot tab can say what they are worth next to everything else.
 *
 * ── what is typed and what is looked up ──
 *
 * The AMOUNT is typed. Reading it from the chain was considered and deliberately left out of
 * the first version: the holding that prompted this is locked NEST, and a lock is a position
 * (an NFT on the voting-escrow contract), not NEST sitting in a wallet — balanceOf on the
 * token reads 0 for it. A typed amount is right for every case; a chain read is right for
 * some. The PRICE is looked up, because nobody should be typing a price that moves.
 *
 * ── where the price comes from ──
 *
 * TWO sources, and the deepest pool either of them knows about wins.
 *
 * GeckoTerminal was the only source at first, and it was wrong for EAGLE by 40%: the one
 * EAGLE pool it indexes is an EAGLE/WHYPE pool created that morning with effectively $0 in
 * it and a single trade, priced $0.000191. The real market is EAGLE/NEST on Project X —
 * $104k of liquidity, half a million a day of volume, $0.000313 — and GeckoTerminal does not
 * index it. DexScreener does. So both are asked, and for each token the quote backed by more
 * liquidity is the one used; the other is a fallback for tokens only one of them lists.
 *
 * "Deepest pool" is the rule because it is the price you could actually sell into. SIGNAL
 * trades in several pools that disagree by more than 3×, and a price taken from whichever
 * pool answered first would triple or third the value at random.
 *
 * The server fetches it (serve-prod.js /offexprice), for three reasons: GeckoTerminal allows
 * about 30 requests a minute, one server-side cache serves every user; the browser names a
 * contract address and never a URL, so the route cannot be used as an open proxy; and none
 * of it touches Hyperliquid's rate budget.
 *
 * ── what it does NOT do ──
 *
 * It does not feed account equity, Net PnL or health. Those numbers match Hyperliquid to the
 * cent and can be checked against it; a self-reported amount priced from a thin pool cannot.
 * Off-exchange value is shown in its own group with its own subtotal, and as a separate
 * "incl. off-exchange" figure — never folded into the account.
 *
 * This file is shared by the server and the browser and touches neither: no DOM, no fetch,
 * no storage handle of its own (the caller passes one in), so all of it is testable in node.
 */

/** A contract address. Lower-cased on the way in so one token is never stored twice. */
export const isTokenAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.trim())
export const normAddr = (a) => (isTokenAddr(a) ? a.trim().toLowerCase() : null)

/** How many tokens one price request may name — GeckoTerminal's own cap on the multi call. */
export const MAX_PER_REQUEST = 30

/**
 * The GeckoTerminal URL for a set of HyperEVM tokens. Every address is validated first, so
 * nothing but 0x-hex ever reaches the path. Returns null when none survive.
 */
export function gtMultiUrl(addrs) {
  const ok = [...new Set((addrs ?? []).map(normAddr).filter(Boolean))].slice(0, MAX_PER_REQUEST)
  if (!ok.length) return null
  return `https://api.geckoterminal.com/api/v2/networks/hyperevm/tokens/multi/${ok.join(',')}`
}

/**
 * Below this much pool liquidity the price is a quote, not something you could sell into.
 * EAGLE reports $0 of reserve and still a price, which is exactly the case to warn about.
 */
export const THIN_LIQUIDITY_USD = 1_000

/**
 * One GeckoTerminal token record → what the app needs to know.
 *
 * Null when there is no usable price. A token GeckoTerminal has never heard of is simply
 * absent from its reply, and the caller treats absent as "no price", never as $0 — a holding
 * printed as worth nothing reads as a total loss.
 */
export function parseGtToken(rec) {
  const a = rec?.attributes
  const addr = normAddr(a?.address)
  if (!addr) return null
  const price = parseFloat(a.price_usd)
  const liq   = parseFloat(a.total_reserve_in_usd)
  return {
    addr,
    symbol: String(a.symbol ?? '').slice(0, 24) || null,
    name:   String(a.name ?? '').slice(0, 64) || null,
    icon:   typeof a.image_url === 'string' && /^https:\/\//.test(a.image_url) ? a.image_url : null,
    price:  Number.isFinite(price) && price > 0 ? price : null,
    liq:    Number.isFinite(liq) ? liq : null,
    thin:   !(Number.isFinite(liq) && liq >= THIN_LIQUIDITY_USD),
  }
}

/** A whole multi-token reply → { addr: parsed }, skipping anything unparseable. */
export function parseGtMulti(json) {
  const out = {}
  for (const rec of (Array.isArray(json?.data) ? json.data : [])) {
    const t = parseGtToken(rec)
    if (t) out[t.addr] = { ...t, src: 'GeckoTerminal', pool: null }
  }
  return out
}

/** DexScreener's batch endpoint for HyperEVM tokens. Same validation as gtMultiUrl. */
export function dsMultiUrl(addrs) {
  const ok = [...new Set((addrs ?? []).map(normAddr).filter(Boolean))].slice(0, MAX_PER_REQUEST)
  if (!ok.length) return null
  return `https://api.dexscreener.com/tokens/v1/hyperevm/${ok.join(',')}`
}

/**
 * DexScreener pairs → { addr: quote }, keeping each token's DEEPEST pair.
 *
 * Only pairs where the token is the BASE count: `priceUsd` is always the base token's price,
 * so a pair that merely quotes in our token (NEST, for EAGLE/NEST) would hand NEST the price
 * of EAGLE.
 */
export function parseDsPairs(json) {
  const out = {}
  for (const p of (Array.isArray(json) ? json : (Array.isArray(json?.pairs) ? json.pairs : []))) {
    const addr  = normAddr(p?.baseToken?.address)
    if (!addr) continue
    const price = parseFloat(p.priceUsd)
    const liq   = parseFloat(p?.liquidity?.usd)
    if (!(Number.isFinite(price) && price > 0)) continue
    const q = {
      addr,
      symbol: String(p.baseToken.symbol ?? '').slice(0, 24) || null,
      name:   String(p.baseToken.name ?? '').slice(0, 64) || null,
      icon:   typeof p?.info?.imageUrl === 'string' && /^https:\/\//.test(p.info.imageUrl) ? p.info.imageUrl : null,
      price,
      liq:    Number.isFinite(liq) ? liq : null,
      thin:   !(Number.isFinite(liq) && liq >= THIN_LIQUIDITY_USD),
      src:    'DexScreener',
      pool:   `${p.dexId ?? 'dex'} · ${p.baseToken.symbol ?? '?'}/${p?.quoteToken?.symbol ?? '?'}`.slice(0, 48),
    }
    if (!out[addr] || (q.liq ?? -1) > (out[addr].liq ?? -1)) out[addr] = q
  }
  return out
}

/**
 * The quote to use when both sources answered: whichever is backed by more liquidity. A
 * source with no liquidity figure loses to one that has any. Name and icon are taken from
 * whichever has them, so a token GeckoTerminal has no image for still gets DexScreener's.
 */
export function pickDeepest(a, b) {
  if (!a) return b ?? null
  if (!b) return a
  // A quote with no price cannot win on liquidity — it has nothing to offer but the name.
  const priced = (q) => q.price != null
  const win  = priced(a) !== priced(b)
    ? (priced(a) ? a : b)
    : ((b.liq ?? -1) > (a.liq ?? -1) ? b : a)
  const lose = win === a ? b : a
  return { ...win, symbol: win.symbol ?? lose.symbol, name: win.name ?? lose.name, icon: win.icon ?? lose.icon }
}

/** Merge both sources' replies into one { addr: quote }. */
export function mergeQuotes(gt = {}, ds = {}) {
  const out = {}
  for (const addr of new Set([...Object.keys(gt ?? {}), ...Object.keys(ds ?? {})])) {
    const q = pickDeepest(gt?.[addr], ds?.[addr])
    if (q) out[addr] = q
  }
  return out
}

/**
 * Ask both sources and merge. `fetchJson(url)` is injected so the server, the dev server and
 * the tests share this one function; a source that fails contributes nothing rather than
 * failing the other.
 */
export async function fetchQuotes(addrs, fetchJson) {
  const safe = (u) => (u ? fetchJson(u).catch(() => null) : Promise.resolve(null))
  const [gtJ, dsJ] = await Promise.all([safe(gtMultiUrl(addrs)), safe(dsMultiUrl(addrs))])
  // `both` matters as much as `ok`: with only one source answering, a token can come back
  // priced from the WRONG pool — EAGLE from GeckoTerminal alone is the empty pool, 40% low.
  return { quotes: mergeQuotes(gtJ ? parseGtMulti(gtJ) : {}, dsJ ? parseDsPairs(dsJ) : {}), ok: !!(gtJ || dsJ), both: !!(gtJ && dsJ) }
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────

/**
 * Holdings are stored per ACCOUNT, under that account's real address.
 *
 * CLAUDE.md, written after agent keys were wiped for a day: in the combined view `state.addr`
 * is the string '__all_accounts__', and the paper account is a sentinel too. A storage key
 * built from either is written to and never read back. So a non-address is refused outright
 * rather than turned into a key.
 */
export const storageKey = (acct) => {
  const a = normAddr(acct)
  return a ? `hliq_offex_${a}` : null
}

/** An entry as it is stored. Anything else in localStorage is ignored rather than trusted. */
export function cleanEntry(e) {
  const token  = normAddr(e?.token)
  const amount = parseFloat(e?.amount)
  if (!token || !(amount > 0) || !Number.isFinite(amount)) return null
  const cost = parseFloat(e?.cost)
  return {
    token,
    amount,
    // Cost basis is optional. Absent means "unknown", which shows no PnL — never a 0 basis,
    // which would show the whole value as profit.
    cost:   Number.isFinite(cost) && cost > 0 ? cost : null,
    symbol: typeof e.symbol === 'string' ? e.symbol.slice(0, 24) : null,
    name:   typeof e.name === 'string' ? e.name.slice(0, 64) : null,
    icon:   typeof e.icon === 'string' && /^https:\/\//.test(e.icon) ? e.icon : null,
    note:   typeof e.note === 'string' ? e.note.slice(0, 60) : '',
    added:  Number.isFinite(e.added) ? e.added : Date.now(),
  }
}

export function loadHoldings(store, acct) {
  const k = storageKey(acct)
  if (!k || !store) return []
  try {
    const raw = JSON.parse(store.getItem(k) || '[]')
    return (Array.isArray(raw) ? raw : []).map(cleanEntry).filter(Boolean)
  } catch { return [] }
}

/** Throws on a non-address rather than silently writing somewhere nothing reads. */
export function saveHoldings(store, acct, list) {
  const k = storageKey(acct)
  if (!k) throw new Error('Off-exchange holdings belong to a real account, not ' + String(acct))
  const clean = (list ?? []).map(cleanEntry).filter(Boolean)
  store.setItem(k, JSON.stringify(clean))
  return clean
}

/**
 * Add a holding, or replace the one for the same token.
 *
 * One row per token per account: adding NEST twice updates the amount rather than listing
 * two NEST rows whose sum nobody asked for.
 */
export function upsertHolding(list, entry) {
  const e = cleanEntry(entry)
  if (!e) return list
  const rest = (list ?? []).filter(x => x.token !== e.token)
  return [...rest, e]
}

export function removeHolding(list, token) {
  const t = normAddr(token)
  return (list ?? []).filter(x => x.token !== t)
}

// ─── VALUE ────────────────────────────────────────────────────────────────────

/**
 * What a holding is worth, and what it made.
 *
 * Every figure is null when it cannot be known — no price, no cost basis — so a renderer
 * prints a dash rather than a $0 that reads as "worthless" or a PnL that reads as real.
 */
export function holdingValue(entry, quote) {
  const price = quote?.price ?? null
  const usd   = price != null ? entry.amount * price : null
  const cost  = entry.cost ?? null
  const pnl   = usd != null && cost != null ? usd - cost : null
  const roi   = pnl != null && cost > 0 ? (pnl / cost) * 100 : null
  return { price, usd, cost, pnl, roi, thin: !!quote?.thin }
}

/**
 * The sum of what can be priced, and whether anything could not.
 *
 * `complete: false` means at least one holding has no price, so `usd` is a floor, not a
 * total. The caller says so — "empty is not the same as unknown", the most expensive rule
 * in this repo, applies to a partial sum just the same.
 */
export function holdingsTotal(list, quotes) {
  let usd = 0, priced = 0
  for (const e of (list ?? [])) {
    const v = holdingValue(e, quotes?.[e.token])
    if (v.usd != null) { usd += v.usd; priced++ }
  }
  return { usd, priced, count: (list ?? []).length, complete: priced === (list ?? []).length }
}
