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

/** The columns a table can be ranked by. */
export const SORT_KEYS = ['vol24', 'oi', 'mcap', 'chg24', 'funding1h', 'price']

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
export function filterRows(rows, { kind = 'all', dex = null, q = '' } = {}) {
  const s = String(q ?? '').trim().toLowerCase()
  return rows.filter(r =>
    (kind === 'all' || r.kind === kind) &&
    (!dex || r.dex === dex) &&
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
export function buildMarkets({ core = null, spot = null, hip3 = [] } = {}) {
  const perps = core ? perpRows(core[0], core[1]) : []
  const perpSyms = new Set(perps.map(p => p.sym))
  const spots = (spot ? spotRows(spot[0], spot[1]) : [])
    .map(r => { const d = spotDisplayName(r.sym, perpSyms); return d === r.sym ? r : { ...r, sym: d, wrapped: r.sym } })
  const hips = hip3.flatMap(h => perpRows(h.data?.[0], h.data?.[1], h.dex, h.label))
  return [...linkMarketCaps(perps, spots), ...spots, ...dedupeHip3(hips)]
}
