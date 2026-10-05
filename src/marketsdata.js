/**
 * INSOLVENT — Markets: every asset Hyperliquid lists, as rows that can be ranked.
 *
 * The /markets page (markets.html, src/markets.js) ranks them by volume, open interest,
 * market cap, 24h performance and funding. This file only turns Hyperliquid's own replies
 * into rows and sorts them: no DOM, no fetch, so all of it runs under node in the suite.
 *
 * ── where each figure comes from ──
 *
 *   price, 24h change   markPx against prevDayPx, per asset context
 *   volume 24h          dayNtlVlm (notional, USD)
 *   open interest       openInterest is in COINS, one side; × markPx gives USD
 *   funding             the hourly rate, shown as a percentage
 *   market cap          spot only: circulatingSupply × markPx, both from HL
 *
 * ── what is NOT here, and is null rather than 0 ──
 *
 * A null figure is "we do not know", never "there is none" — CLAUDE.md's most expensive rule.
 *   - Market cap for a perp. HL publishes supply for its own spot tokens only; BTC's market cap
 *     is not on Hyperliquid at all. Linked from spot for an allow-listed set of HL-native
 *     tokens (SPOT_LINKED), where the perp and the spot token are the same asset. A name match
 *     alone is not enough: a community spot token can share a ticker with a perp it is not.
 *   - Open interest and funding for spot: there are none to have, so those cells stay empty.
 *   - 7d / 30d performance: needs candle history per asset, which is a later step.
 */

import { classify, normHlCat, SECTOR_LABEL } from './sectors.js'

export const KINDS = { perp: 'Perps', hip3: 'HIP-3', spot: 'Spot' }

/** Spot pairs worth ranking: quoted in a dollar stablecoin, so their price IS a USD price. */
export const STABLE_QUOTES = new Set(['USDC', 'USDT0', 'USDH', 'USDE'])

/**
 * Perps whose market cap may be taken from the spot token of the same name: HL-native tokens,
 * where the perp tracks exactly that spot token. Anything else stays null until a source that
 * knows (CoinGecko, server-side) is wired in.
 */
export const SPOT_LINKED = new Set(['HYPE', 'PURR'])

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }
const pct = (px, prev) => (px != null && prev != null && prev > 0 ? (px / prev - 1) * 100 : null)

/**
 * One perp dex's metaAndAssetCtxs → rows. `dex` is null for the main dex, else the HIP-3
 * dex's short name ('xyz'); `dexLabel` its display name ('XYZ').
 */
export function perpRows(meta, ctxs, dex = null, dexLabel = null) {
  const out = []
  const uni = Array.isArray(meta?.universe) ? meta.universe : []
  uni.forEach((u, i) => {
    const c = ctxs?.[i]
    if (!u?.name || !c || u.isDelisted) return
    const price = num(c.markPx)
    if (!(price > 0)) return
    const oiCoins = num(c.openInterest)
    const fund = num(c.funding)
    out.push({
      id:       u.name,
      coin:     u.name,                        // what the app's /icon cache is keyed by
      sym:      u.name.replace(/^.*:/, ''),
      name:     null,
      kind:     dex ? 'hip3' : 'perp',
      dex:      dex ?? null,
      dexLabel: dex ? (dexLabel || dex) : null,
      price,
      chg24:    pct(price, num(c.prevDayPx)),
      vol24:    num(c.dayNtlVlm),
      oi:       oiCoins != null ? oiCoins * price : null,
      mcap:     null,
      funding1h: fund != null ? fund * 100 : null,
      maxLev:   num(u.maxLeverage),
    })
  })
  return out
}

/**
 * spotMetaAndAssetCtxs → rows, one per BASE token: when a token trades against several
 * stablecoins, its deepest-volume pair stands for it and `pairs` says how many there are.
 *
 * Tokens are looked up by their `index` FIELD, not by position in the array: the two
 * differ, and indexing the array by token id names the wrong token or none at all.
 */
export function spotRows(meta, ctxs) {
  const tok = new Map((meta?.tokens ?? []).map(t => [t.index, t]))
  const ctxBy = new Map((ctxs ?? []).map(c => [c?.coin, c]))
  const best = new Map()
  for (const u of (meta?.universe ?? [])) {
    const base = tok.get(u?.tokens?.[0]), quote = tok.get(u?.tokens?.[1])
    const c = ctxBy.get(u?.name)
    if (!base || !quote || !c || !STABLE_QUOTES.has(quote.name)) continue
    const price = num(c.markPx)
    if (!(price > 0)) continue
    const circ = num(c.circulatingSupply)
    const cap  = circ != null && circ > 0 ? circ * price : null
    const vol  = num(c.dayNtlVlm)
    // Protocol-deployed spot (BTC, ETH, stocks) must have traded to be listed. Spot deploys
    // are permissionless, and a token named "MSFT" with Microsoft's share count and $0 of
    // volume multiplies out to a real-looking $3.7T — the app's market list hit exactly this.
    const protocol = String(base.deployerTradingFeeShare ?? '0') !== '0' && parseFloat(base.deployerTradingFeeShare) !== 0
    if (protocol && !(vol > 0)) continue
    const row = {
      id:       'spot:' + base.name,
      coin:     u.name,                        // '@107' — the key the app's icon cache uses
      sym:      base.name,
      name:     typeof base.fullName === 'string' && base.fullName ? base.fullName : null,
      kind:     'spot',
      dex:      null,
      dexLabel: null,
      quote:    quote.name,
      price,
      chg24:    pct(price, num(c.prevDayPx)),
      vol24:    vol,
      oi:       null,
      // Above the ceiling it is a supply glitch (RUBT reports ~$1.4 quadrillion), not a cap.
      mcap:     cap != null && cap <= MCAP_CEIL ? cap : null,
      funding1h: null,
      maxLev:   null,
      pairs:    1,
      protocol,
    }
    const prev = best.get(base.name)
    if (!prev) { best.set(base.name, row); continue }
    const pairs = prev.pairs + 1
    best.set(base.name, (row.vol24 ?? -1) > (prev.vol24 ?? -1) ? { ...row, pairs } : { ...prev, pairs })
  }
  return [...best.values()]
}

/** Larger than every crypto asset combined: a figure above it is a supply glitch. */
export const MCAP_CEIL = 4e12

/** Give allow-listed HL-native perps the market cap of their spot token. Returns new rows. */
//
// Also any PROTOCOL-deployed spot token that trades: those are Hyperliquid's and Unit's own
// (UBTC, UETH, USOL…), published with the real supply, so BTC's perp gets BTC's market cap.
// Community tokens are never linked — anyone can deploy one named after a perp.
export function linkMarketCaps(perps, spots) {
  const ok = (s) => s.mcap != null && (SPOT_LINKED.has(s.sym) || (s.protocol && (s.vol24 ?? 0) > 0))
  const caps = new Map(spots.filter(ok).map(s => [s.sym, s.mcap]))
  return perps.map(r => (r.kind === 'perp' && caps.has(r.sym) ? { ...r, mcap: caps.get(r.sym), mcapFrom: 'spot' } : r))
}

/**
 * DefiLlama categories too generic to describe a token when we know better: NEAR's biggest
 * earner on DefiLlama is a bridge, but NEAR is a Layer 1.
 */
export const WEAK_LLAMA_CATS = new Set(['Bridge', 'Cross Chain Bridge', 'Services', 'Interface', 'Developer Tools', 'Chain'])
/** The tag to name a row by: a specific one before the 'defi' umbrella. */
const firstStrongTag = (tags) => tags.find(t => t !== 'defi') ?? tags[0]

/**
 * One row per TOKEN, for revenue: revenue is a token's, not a market's, so PUMP's perp and
 * its wrapped spot must not both count it. The perp stands for the token when there is one,
 * else its most-traded row.
 */
export function onePerToken(rows) {
  const best = new Map()
  for (const r of rows) {
    const cur = best.get(r.sym)
    const score = (x) => (x.kind === 'perp' ? 2 : x.kind === 'hip3' ? 1 : 0) * 1e15 + (x.vol24 ?? 0)
    if (!cur || score(r) > score(cur)) best.set(r.sym, r)
  }
  return [...best.values()]
}

/** The columns a table can be ranked by. */
export const SORT_KEYS = ['vol24', 'oi', 'mcap', 'chg24', 'funding1h', 'price', 'rev24', 'rev7', 'rev30']

/**
 * Sort by `key`, descending unless `asc`. Nulls go LAST in both directions: an unknown
 * market cap is not the smallest market cap, and must not top an ascending sort.
 */
export function sortRows(rows, key = 'vol24', asc = false) {
  const k = SORT_KEYS.includes(key) ? key : 'vol24'
  return [...rows].sort((a, b) => {
    const x = a[k], y = b[k]
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    return asc ? x - y : y - x
  })
}

/** Filter by kind ('all' | 'perp' | 'hip3' | 'spot'), HIP-3 dex and a search string. */
/**
 * "Strict": the markets someone actually trades, like Hyperliquid's own Strict toggle.
 *
 * Hyperliquid's strict list is hand-picked and not in its API (it shows MOVE and STABLE with
 * $0 of volume), so this is a stated rule rather than a copy of it:
 *   - every listed core perp;
 *   - a HIP-3 market that is live (volume or open interest) — dead copies are not;
 *   - a spot token that is protocol-deployed (and so already had to trade to be listed here),
 *     has at least STRICT_SPOT_MIN_VOL of 24h volume, has protocol revenue, or is one of the
 *     curated tokens (src/sectors.js) — the long tail of community deploys is not.
 */
export const STRICT_SPOT_MIN_VOL = 10_000
export function isStrict(r) {
  if (r.kind === 'perp') return true
  if (r.shadow) return false
  if (r.kind === 'hip3') return (r.vol24 ?? 0) > 0 || (r.oi ?? 0) > 0
  return !!r.protocol || (r.vol24 ?? 0) >= STRICT_SPOT_MIN_VOL || r.rev30 != null || (r.tags ?? []).length > 0
}

export function filterRows(rows, { kind = 'all', dex = null, q = '', group = null, sector = null, strict = false } = {}) {
  const s = String(q ?? '').trim().toLowerCase()
  return rows.filter(r =>
    (!strict || isStrict(r)) &&
    (kind === 'all' || r.kind === kind) &&
    (!dex || r.dex === dex) &&
    (!group || r.group === group) &&
    (!sector || (r.tags ?? []).includes(sector)) &&
    (!s || r.sym.toLowerCase().includes(s) || (r.name ?? '').toLowerCase().includes(s) || (r.dexLabel ?? '').toLowerCase().includes(s)))
}

/**
 * Headline figures for a set of rows. Sums skip unknowns and say how many they covered, so a
 * caller can tell a total from a floor.
 */
export function summarize(rows) {
  let vol = 0, oi = 0, volN = 0, oiN = 0
  for (const r of rows) {
    if (r.vol24 != null) { vol += r.vol24; volN++ }
    if (r.oi != null) { oi += r.oi; oiN++ }
  }
  const moved = rows.filter(r => r.chg24 != null && (r.vol24 ?? 0) >= MOVER_MIN_VOL)
  const byChg = sortRows(moved, 'chg24')
  return {
    count: rows.length, vol, volN, oi, oiN,
    gainer: byChg[0] ?? null,
    loser:  byChg.length ? byChg[byChg.length - 1] : null,
    topVol: sortRows(rows, 'vol24')[0] ?? null,
    topOi:  sortRows(rows.filter(r => r.oi != null), 'oi')[0] ?? null,
  }
}
/**
 * Top gainer/loser only among assets that actually traded: a market with $40 of volume that
 * moved 300% on one fill is not "the top gainer" in any sense a reader means.
 */
export const MOVER_MIN_VOL = 100_000

/**
 * Unit's wrapped tokens are named UBTC / UETH / USOL; Hyperliquid shows them as BTC / ETH /
 * SOL. Strip the U only when what is left is a listed perp, so UNI and USDC keep their names.
 */
export function spotDisplayName(name, perpSyms) {
  return /^U[A-Z0-9]{2,}$/.test(name) && perpSyms.has(name.slice(1)) ? name.slice(1) : name
}

/**
 * The same stock or index is listed on several HIP-3 dexes, most of them dead copies with a
 * stale price. Every LIVE market stays (volume or open interest); a symbol whose copies are
 * all dead keeps only its most-traded one, so it appears once rather than six times.
 */
export function dedupeHip3(rows) {
  const live = (r) => (r.vol24 ?? 0) > 0 || (r.oi ?? 0) > 0
  const out = rows.filter(r => r.kind !== 'hip3' || live(r))
  const dead = new Map()
  for (const r of rows) {
    if (r.kind !== 'hip3' || live(r)) continue
    if (out.some(x => x.kind === 'hip3' && x.sym === r.sym)) continue
    if (!dead.has(r.sym)) dead.set(r.sym, r)
  }
  return [...out, ...dead.values()]
}

/**
 * Everything, from the raw replies: core perps, spot, and each HIP-3 dex that answered.
 * `hip3` is [{ dex, label, data: [meta, ctxs] }]; a dex that failed is simply not in it, and
 * the caller reports how many of how many loaded rather than presenting a partial list as all.
 */
export function buildMarkets({ core = null, spot = null, hip3 = [], cats = null, revenue = null } = {}) {
  const perps = core ? perpRows(core[0], core[1]) : []
  const perpSyms = new Set(perps.map(p => p.sym))
  const spots = (spot ? spotRows(spot[0], spot[1]) : [])
    .map(r => { const d = spotDisplayName(r.sym, perpSyms); return d === r.sym ? r : { ...r, sym: d, wrapped: r.sym } })
  const hips = hip3.flatMap(h => perpRows(h.data?.[0], h.data?.[1], h.dex, h.label))
  return categorize([...linkMarketCaps(perps, spots), ...spots, ...dedupeHip3(hips)], cats, revenue)
}

/**
 * Categories and revenue onto rows.
 *
 * `cats` is perpCategories' [[coin, category], …] — HIP-3 markets only; a main-dex perp is
 * crypto. A PROTOCOL spot token whose ticker Hyperliquid lists as a stock elsewhere is a
 * tokenised stock and filed as one; a community spot token is never, whatever it is named.
 * `revenue` is src/llama.js bySym; only crypto rows take it (a stock's ticker can collide
 * with a protocol token's). Null `revenue` means it did not load — every rev* stays null.
 */
export function categorize(rows, cats = null, revenue = null) {
  const catOf = new Map((Array.isArray(cats) ? cats : []).map(([c, k]) => [c, k]))
  const stockSyms = new Set([...catOf].filter(([, k]) => normHlCat(k) === 'stocks').map(([c]) => c.replace(/^.*:/, '')))
  const perpSyms = new Set(rows.filter(r => r.kind === 'perp').map(r => r.sym))
  return rows.map(r => {
    const hl = r.kind === 'hip3' ? (catOf.get(r.coin) ?? null)
      : r.kind === 'spot' && r.protocol && stockSyms.has(r.sym) ? 'stocks'
      : null
    // A SHADOW: a community spot token sharing a core perp's ticker that barely trades — there
    // is a $97K community "PUMP" next to the real one. It inherits nothing by its name: no
    // revenue, no categories, not strict. Real HYPE spot is community-deployed too, but it
    // trades, so it is not a shadow. A protocol spot token (UPUMP, Unit's wrapped PUMP) is
    // the same asset and keeps everything.
    const shadow = r.kind === 'spot' && !r.protocol && perpSyms.has(r.sym) && (r.vol24 ?? 0) < STRICT_SPOT_MIN_VOL
    const rev = shadow ? null : (revenue?.[r.sym.toUpperCase()] ?? null)
    const c = shadow ? { group: 'crypto', hlCat: 'crypto', tags: [] } : classify({ sym: r.sym, hlCat: hl, llamaCat: rev?.category ?? null })
    const useRev = c.group === 'crypto' && rev
    return {
      ...r, group: c.group, hlCat: c.hlCat, tags: c.tags, shadow,
      // The one label the table shows: DefiLlama's own word for a revenue token, like its
      // table; else our first sector; else what Hyperliquid calls it.
      category: (useRev && rev.category && !(WEAK_LLAMA_CATS.has(rev.category) && c.tags[0]) ? rev.category : null)
        || (c.tags[0] ? SECTOR_LABEL[firstStrongTag(c.tags)] : null) || (c.group === 'tradfi' ? null : 'Crypto'),
      rev24: useRev ? rev.r24 : null, rev7: useRev ? rev.r7 : null, rev30: useRev ? rev.r30 : null,
      revName: useRev ? rev.name : null,
    }
  })
}
