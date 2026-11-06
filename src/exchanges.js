/**
 * Exchanges, for the Exchanges view on /markets: what DEXs earn, and what CEXs hold.
 *
 * Asked: "can we also add the revenue of cex, dex? in the markets tab."
 *
 *   DEX  DefiLlama's revenue and fees overviews (the same two feeds /markets-meta already reads
 *        for token revenue), protocols in the Dexs / Derivatives / Options categories, summed
 *        under their parent: Hyperliquid = Hyperliquid Perps + Hyperliquid Spot Orderbook, the
 *        way DefiLlama's own table shows it.
 *   CEX  DefiLlama's /cexs: assets held, net inflows, volume, open interest. A centralised
 *        exchange's revenue is not published anywhere a feed can read — most are private —
 *        so revenue shows only for the ones that report to the SEC (Coinbase, Robinhood…),
 *        from the filings /markets-meta already carries. Everything else is a dash, which
 *        means "not published", never zero.
 *
 * Pure: no fetch, no DOM. serve-prod.js and the vite dev server fetch and cache.
 */

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : null }
const add = (a, b) => (a == null ? b : b == null ? a : a + b)

export const DEX_KIND = { Dexs: 'Spot', Derivatives: 'Perps', Options: 'Options' }

/** DefiLlama's spot-DEX volume overview (/overview/dexs). Its perp-DEX one is paid. */
export const LLAMA_DEXVOL_URL = 'https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true'

/** One row per exchange (parent protocol), DEX categories only. `dexVol` adds spot volume. */
export function buildDexes(revFeed, feesFeed = null, lite = null, dexVol = null) {
  const feeBy = new Map((Array.isArray(feesFeed?.protocols) ? feesFeed.protocols : []).map(p => [String(p.defillamaId), p]))
  const parents = new Map((Array.isArray(lite?.parentProtocols) ? lite.parentProtocols : []).map(p => [p.id, p]))
  const protos = new Map((Array.isArray(lite?.protocols) ? lite.protocols : []).map(p => [String(p.defillamaId ?? p.id), p]))
  const by = new Map()
  for (const f of (Array.isArray(revFeed?.protocols) ? revFeed.protocols : [])) {
    const kind = DEX_KIND[f?.category]
    if (!kind) continue
    const key = f.parentProtocol ?? 'p:' + f.defillamaId
    const parent = f.parentProtocol ? parents.get(f.parentProtocol) : null
    const cur = by.get(key) ?? {
      id: key, name: parent?.name ?? f.displayName ?? f.name, logo: parent?.logo ?? f.logo ?? null,
      // What its token is worth, when it has one: a token's cap, not a valuation of the exchange.
      mcap: n((parent ?? protos.get(String(f.defillamaId)))?.mcap) || null, sym: (parent ?? protos.get(String(f.defillamaId)))?.symbol ?? null,
      kinds: new Set(), chains: new Set(), protocols: 0, top: -1,
      r24: null, r7: null, r30: null, f24: null, f7: null, f30: null,
    }
    cur.kinds.add(kind)
    for (const c of (f.chains ?? [])) cur.chains.add(c)
    cur.protocols++
    cur.r24 = add(cur.r24, n(f.total24h)); cur.r7 = add(cur.r7, n(f.total7d)); cur.r30 = add(cur.r30, n(f.total30d))
    const ff = feeBy.get(String(f.defillamaId))
    if (ff) { cur.f24 = add(cur.f24, n(ff.total24h)); cur.f7 = add(cur.f7, n(ff.total7d)); cur.f30 = add(cur.f30, n(ff.total30d)) }
    // Without a parent record, the biggest earner's logo stands for the group.
    const w = n(f.total30d) ?? -1
    if (!parent && w > cur.top && f.logo) { cur.logo = f.logo; cur.top = w }
    by.set(key, cur)
  }
  // Spot volume, onto the same groups: a protocol trading in the volume feed but earning nothing
  // in the revenue one is not added as an exchange of its own.
  for (const v of (Array.isArray(dexVol?.protocols) ? dexVol.protocols : [])) {
    if (v?.category !== 'Dexs') continue
    const cur = by.get(v.parentProtocol ?? 'p:' + v.defillamaId)
    if (cur) cur.spotVol = add(cur.spotVol ?? null, n(v.total24h))
  }
  return [...by.values()]
    .filter(d => (d.r30 ?? 0) > 0 || (d.f30 ?? 0) > 0 || (d.r24 ?? 0) > 0)
    .map(({ kinds, chains, top, ...d }) => ({ ...d, kind: [...kinds].join(' · '), chains: chains.size }))
}

/** Exchanges that file with the SEC, by DefiLlama name → ticker. */
export const CEX_TICKERS = { Coinbase: 'COIN', Robinhood: 'HOOD', Bullish: 'BLSH', Gemini: 'GEMI', eToro: 'ETOR', Kraken: 'KRAK' }

/** Companies whose market cap can be worked out: the SEC's number for the shares, by CIK. */
export const CEX_CIK = { COIN: 1679788, HOOD: 1783879 }
export const secFactsUrl = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`
/**
 * Shares behind a company's market cap: the latest basic weighted average in its filings. Not the
 * cover-page count, because only this concept covers both Coinbase and Robinhood (each has two
 * share classes, and Robinhood stopped tagging CommonStockSharesOutstanding in 2021). A quarter's
 * average runs close to the count, and the cell says ≈. Null when the filings do not have it.
 */
export function sharesFromFacts(facts) {
  const u = facts?.facts?.['us-gaap']?.WeightedAverageNumberOfSharesOutstandingBasic?.units?.shares
  if (!Array.isArray(u) || !u.length) return null
  const end = u.reduce((a, b) => (String(b.end) > a ? String(b.end) : a), '')
  const vals = u.filter(x => x.end === end).map(x => Number(x.val)).filter(x => x > 0)
  return vals.length ? Math.max(...vals) : null
}

/**
 * What an exchange is worth, as far as anyone can say. A listed company: shares × its live price.
 * Otherwise its token's market cap, kept apart by `kind` because that is what the TOKEN is worth, not
 * the business. Neither is unknown (null), never 0.
 *   cg: /markets-meta's { SYM: [id, mcap] }; shares: { TICKER: n }; priceOf(ticker) → price
 */
export function worthOfCex(r, { shares = null, cg = null, priceOf = () => null } = {}) {
  const px = r.ticker && shares?.[r.ticker] ? Number(priceOf(r.ticker)) : 0
  if (px > 0) return { worth: px * shares[r.ticker], worthKind: 'stock' }
  const cap = r.coin ? Number(cg?.[String(r.coin).toUpperCase()]?.[1]) : 0
  return cap > 0 ? { worth: cap, worthKind: 'token', worthSym: r.coin } : { worth: null, worthKind: null }
}

export function buildCexes(feed) {
  const list = Array.isArray(feed?.cexs) ? feed.cexs : Array.isArray(feed) ? feed : []
  return list
    // Anything it reports a number for. "where are some popular exchanges like coinbase": requiring
    // assets dropped Coinbase, Upbit and Bithumb, which have volume but no public wallet list.
    // Unknown assets are null, never 0.
    .filter(c => c?.name && [c.cleanAssetsTvl, c.currentTvl, c.spotVolume, c.derivVolume, c.oi].some(v => n(v) > 0))
    .map(c => ({
      id: String(c.slug ?? c.name), name: String(c.name), coin: c.coinSymbol ?? null,
      slug: c.slug ?? String(c.name).toLowerCase().replace(/[^a-z0-9]+/g, '-'), ticker: CEX_TICKERS[c.name] ?? null,
      assets: n(c.cleanAssetsTvl) ?? n(c.currentTvl) ?? null,
      in24: n(c.inflows_24h), in7: n(c.inflows_1w), in30: n(c.inflows_1m),
      spotVol: n(c.spotVolume), derivVol: n(c.derivVolume), vol24: add(n(c.spotVolume), n(c.derivVolume)), oi: n(c.oi),
    }))
}

/** A CEX with its SEC revenue joined, when the company files. */
export function withCexRevenue(rows, stocks) {
  return rows.map(r => {
    const s = r.ticker && stocks ? stocks[r.ticker] : null
    // Its 30d is a third of the last quarter, marked ≈ where it shows, like a company on Revenue.
    return { ...r, sq: s?.q ?? null, sttm: s?.ttm ?? null, syoy: s?.yoy ?? null, r30: s?.q != null ? s.q / 3 : null, r30Approx: s?.q != null }
  })
}

export function sortEx(rows, key, asc = false) {
  return rows.slice().sort((a, b) => {
    const x = a[key], y = b[key]
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return asc ? x - y : y - x
  })
}
