/**
 * Protocol revenue by TOKEN, from DefiLlama — for the /markets page's Revenue columns.
 *
 * DefiLlama reports revenue per PROTOCOL (pump.fun, PumpSwap, Hyperliquid Perps…), not per
 * token, so this joins two of its public feeds:
 *   /overview/fees?dataType=dailyRevenue   revenue 24h / 7d / 30d per protocol, + category
 *   /lite/protocols2                       each protocol's token (symbol + CoinGecko id),
 *                                          and each parent protocol's
 * and sums every protocol under the token it belongs to — pump.fun + PumpSwap + the app all
 * accrue to PUMP, the way DefiLlama's own table shows "Pump" as one row.
 *
 * ── which protocols count for a token ──
 *
 * A protocol's token is its OWN record's, else its parent's, and only when that record has a
 * CoinGecko id. The id is the guard: DefiLlama files Paxos's stablecoin issuer under a parent
 * whose symbol is PAXG, which would credit stablecoin revenue to a gold token — that parent
 * has no CoinGecko id, so it is left out. Tokens are keyed by CoinGecko id, so two protocols
 * sharing a ticker never merge.
 *
 * A ticker that maps to SEVERAL CoinGecko ids is ambiguous and dropped from `bySym`: the
 * Markets page matches by ticker, and a revenue figure on the wrong token is worse than none.
 *
 * Pure: no fetch, no DOM. serve-prod.js and the vite dev server fetch and cache; the suite
 * runs this on fixtures.
 */

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null }
const add = (a, b) => (a == null ? b : b == null ? a : a + b)
const tokenOf = (rec) => {
  const sym = typeof rec?.symbol === 'string' ? rec.symbol.trim().toUpperCase() : ''
  const gecko = rec?.geckoId ?? rec?.gecko_id ?? null
  return sym && sym !== '-' && gecko ? { sym, gecko } : null
}

/**
 * `feesFeed` (optional) is the same overview with dataType=dailyFees: what users PAID, as
 * opposed to revenue, what the protocol KEPT. Morpho's revenue is genuinely $0 — its fee
 * switch is off and ~$20M a month goes to lenders — so a revenue column alone reads as
 * missing data. Fees sit beside it.
 */
export function buildRevenue(fees, lite, feesFeed = null) {
  const feeBy = new Map((Array.isArray(feesFeed?.protocols) ? feesFeed.protocols : []).map(p => [String(p.defillamaId), p]))
  const protos  = Array.isArray(lite?.protocols) ? lite.protocols : []
  const parents = new Map((Array.isArray(lite?.parentProtocols) ? lite.parentProtocols : []).map(p => [p.id, p]))
  const byId    = new Map(protos.map(p => [String(p.defillamaId ?? p.id), p]))

  const byGecko = new Map()
  for (const f of (Array.isArray(fees?.protocols) ? fees.protocols : [])) {
    const rec = byId.get(String(f.defillamaId))
    const parentId = f.parentProtocol ?? rec?.parentProtocol ?? null
    const parent = parentId ? parents.get(parentId) : null
    const tok = tokenOf(rec) ?? tokenOf(parent)
    if (!tok) continue
    const cur = byGecko.get(tok.gecko) ?? {
      sym: tok.sym, gecko: tok.gecko, name: parent?.name ?? f.displayName ?? f.name,
      r24: null, r7: null, r30: null, f24: null, f7: null, f30: null, category: null, catRev: -1, protocols: 0, chains: new Set(),
    }
    cur.r24 = add(cur.r24, n(f.total24h))
    cur.r7  = add(cur.r7,  n(f.total7d))
    cur.r30 = add(cur.r30, n(f.total30d))
    const ff = feeBy.get(String(f.defillamaId))
    if (ff) { cur.f24 = add(cur.f24, n(ff.total24h)); cur.f7 = add(cur.f7, n(ff.total7d)); cur.f30 = add(cur.f30, n(ff.total30d)) }
    cur.protocols++
    for (const c of (f.chains ?? [])) cur.chains.add(c)
    // The category is the one its biggest earner carries: Pump is a Launchpad, not a Dexs,
    // because pump.fun out-earns PumpSwap.
    const w = n(f.total30d) ?? -1
    if (f.category && w > cur.catRev) { cur.category = f.category; cur.catRev = w }
    byGecko.set(tok.gecko, cur)
  }

  const bySymAll = new Map()
  for (const t of byGecko.values()) {
    if (!bySymAll.has(t.sym)) bySymAll.set(t.sym, [])
    bySymAll.get(t.sym).push(t)
  }
  const bySym = {}, ambiguous = []
  for (const [sym, list] of bySymAll) {
    if (list.length > 1) { ambiguous.push(sym); continue }
    const t = list[0]
    bySym[sym] = { name: t.name, gecko: t.gecko, category: t.category, r24: t.r24, r7: t.r7, r30: t.r30, f24: t.f24, f7: t.f7, f30: t.f30, protocols: t.protocols, chains: t.chains.size }
  }
  return { bySym, ambiguous }
}

export const LLAMA_FEES_URL = 'https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue'
export const LLAMA_LITE_URL = 'https://api.llama.fi/lite/protocols2'

// ── CoinGecko: which coin a ticker means, and its market cap ─────────────────

/**
 * CoinGecko's /coins/markets pages (ordered by market cap) → { SYM: { id, mcap } }, FIRST
 * wins: the biggest coin with a ticker is the one that ticker means. The app resolves coin
 * icons by exactly this rule (main.js _initCGIconMap) for the same reason.
 */
export function cgTopBySymbol(pages) {
  const out = {}
  for (const c of (pages ?? []).flat()) {
    const sym = typeof c?.symbol === 'string' ? c.symbol.trim().toUpperCase() : ''
    if (!sym || !c.id || out[sym]) continue
    const mcap = Number(c.market_cap)
    out[sym] = { id: c.id, mcap: Number.isFinite(mcap) && mcap > 0 ? mcap : null }
  }
  return out
}

/**
 * Drop revenue that belongs to a DIFFERENT token sharing the ticker.
 *
 * Reported: STRK showed Strike's revenue (Hyperliquid's STRK is Starknet), XAI SideShift's,
 * MOVE BlueMove's. DefiLlama's token for a ticker is only accepted when it is the coin
 * CoinGecko says that ticker means; a ticker CoinGecko's list does not have keeps it, there
 * being nothing to contradict it. Returns { bySym, dropped }.
 */
export function verifyRevenue(bySym, cgTop) {
  const out = {}, dropped = []
  for (const [sym, t] of Object.entries(bySym ?? {})) {
    const want = cgTop?.[sym]?.id
    if (want && t.gecko && want !== t.gecko) { dropped.push(sym + ':' + t.gecko + '≠' + want); continue }
    out[sym] = t
  }
  return { bySym: out, dropped }
}

export const LLAMA_FEESPAID_URL = 'https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyFees'
export const CG_PAGES = 8   // the top 2,000 coins by market cap
export const cgMarketsUrl = (page) => `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false`

/**
 * Tickers whose Hyperliquid market is NOT the biggest coin CoinGecko has under that ticker.
 * Checked by hand; add to it when one is found. XAI: by market cap CoinGecko's "XAI" is
 * SideShift's token, while Hyperliquid's XAI perp is Xai (the gaming L3).
 */
export const HL_CG_OVERRIDES = {
  XAI: 'xai-blockchain',
  S: 'sonic-3',
  ME: 'magic-eden',
  IO: 'io-net',
  W: 'wormhole',
  MOVE: 'movement',
  STRK: 'starknet',
}

/** cgTopBySymbol with the overrides applied: { SYM: { id, mcap } }. */
export function cgForHyperliquid(pages) {
  const top = cgTopBySymbol(pages)
  const byId = new Map((pages ?? []).flat().filter(c => c?.id).map(c => [c.id, c]))
  for (const [sym, id] of Object.entries(HL_CG_OVERRIDES)) {
    const c = byId.get(id)
    const mcap = Number(c?.market_cap)
    // Outside the fetched pages the id is still the right one; only the cap is unknown.
    top[sym] = { id, mcap: Number.isFinite(mcap) && mcap > 0 ? mcap : null }
  }
  return top
}
