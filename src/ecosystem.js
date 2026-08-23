// ─── HYPERLIQUID PULSE ────────────────────────────────────────────────────────
//
// Exchange-wide metrics, computed here from Hyperliquid's own public API rather than
// pulled from someone else's dashboard.
//
// The alternative was hl.eco's backend: ~54 undocumented endpoints, no CORS header (so it
// would need proxying through our server), a 429 on the second request in a burst, and an
// /api/auth/token suggesting the open parts can close at any time. Everything below comes
// from ONE documented call — metaAndAssetCtxs, weight 20 — which cannot break because
// someone else shipped a refactor.
//
// Pure functions on purpose: the tests drive them with the real API payload.

/** Hyperliquid quotes funding per HOUR. Annualised so it is comparable to anything else. */
export function fundingApr(hourly) {
  const f = Number(hourly)
  return Number.isFinite(f) ? f * 24 * 365 * 100 : 0
}

/**
 * @param {[object, object[]]} pair the raw metaAndAssetCtxs response
 * @param {object} opts.minVol  24h notional a market needs before it can appear in the
 *                              "extremes" lists. Without it a market that traded $2,000
 *                              all day can top the funding chart on a rounding artefact.
 *                              Deliberately low: MOVE at -3000% APR on $1.7M of volume is
 *                              a real squeeze, not noise, and must survive.
 */
export function computeEcosystem(pair, { minVol = 100_000, top = 5 } = {}) {
  const meta = pair?.[0]
  const ctxs = pair?.[1]
  const universe = Array.isArray(meta?.universe) ? meta.universe : []
  if (!universe.length || !Array.isArray(ctxs)) {
    return { ok: false, coins: 0, totalOi: 0, totalVol: 0, rows: [], topOi: [], topVol: [], fundingHigh: [], fundingLow: [], gainers: [], losers: [] }
  }

  const rows = []
  let totalOi = 0, totalVol = 0
  universe.forEach((u, i) => {
    const c = ctxs[i]
    if (!c) return
    const mark = parseFloat(c.markPx ?? 0)
    const prev = parseFloat(c.prevDayPx ?? 0)
    // openInterest is in BASE units; only mark price makes it comparable across coins.
    const oi   = parseFloat(c.openInterest ?? 0) * mark
    const vol  = parseFloat(c.dayNtlVlm ?? 0)
    if (!Number.isFinite(mark) || mark <= 0) return
    rows.push({
      coin: u.name,
      mark,
      oi:   Number.isFinite(oi)  ? oi  : 0,
      vol:  Number.isFinite(vol) ? vol : 0,
      apr:  fundingApr(c.funding),
      chg:  prev > 0 ? (mark / prev - 1) * 100 : 0,
      // A perp trading above its oracle means longs are paying up to be long.
      premium: parseFloat(c.premium ?? 0) * 100,
    })
    totalOi  += Number.isFinite(oi)  ? oi  : 0
    totalVol += Number.isFinite(vol) ? vol : 0
  })

  const liquid = rows.filter(r => r.vol >= minVol)
  const by = (list, key, dir) => [...list].sort((a, b) => (a[key] - b[key]) * dir).slice(0, top)

  return {
    ok: rows.length > 0,
    coins: rows.length,
    liquidCoins: liquid.length,
    totalOi,
    totalVol,
    rows,
    topOi:  by(rows, 'oi',  -1),
    topVol: by(rows, 'vol', -1),
    // Funding is where the crowding shows: a high positive rate means longs are paying
    // shorts to stay long, which is the market telling you the trade is busy.
    fundingHigh: by(liquid, 'apr', -1),
    fundingLow:  by(liquid, 'apr',  1),
    gainers: by(liquid, 'chg', -1),
    losers:  by(liquid, 'chg',  1),
  }
}

/** Share of total open interest, for the concentration read. */
export function oiShare(d, coin) {
  if (!d?.totalOi) return 0
  const r = d.rows.find(x => x.coin === coin)
  return r ? (r.oi / d.totalOi) * 100 : 0
}

/**
 * How top-heavy the exchange is: the share of open interest held by the largest N markets.
 * One number that says whether Hyperliquid is a BTC/ETH venue or a long tail.
 */
export function oiConcentration(d, n = 3) {
  if (!d?.totalOi) return 0
  const t = [...d.rows].sort((a, b) => b.oi - a.oi).slice(0, n)
    .reduce((s, r) => s + r.oi, 0)
  return (t / d.totalOi) * 100
}
