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

export function buildRevenue(fees, lite) {
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
      r24: null, r7: null, r30: null, category: null, catRev: -1, protocols: 0, chains: new Set(),
    }
    cur.r24 = add(cur.r24, n(f.total24h))
    cur.r7  = add(cur.r7,  n(f.total7d))
    cur.r30 = add(cur.r30, n(f.total30d))
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
    bySym[sym] = { name: t.name, gecko: t.gecko, category: t.category, r24: t.r24, r7: t.r7, r30: t.r30, protocols: t.protocols, chains: t.chains.size }
  }
  return { bySym, ambiguous }
}

export const LLAMA_FEES_URL = 'https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true&dataType=dailyRevenue'
export const LLAMA_LITE_URL = 'https://api.llama.fi/lite/protocols2'
