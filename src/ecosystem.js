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

// ─── BUILDER DEXES (HIP-3) AND THE RWA SPLIT ──────────────────────────────────
//
// perpCategories only covers HIP-3 markets — every entry it returns is prefixed with a dex
// name. Run against the main dex all 232 coins come back uncategorised, which is correct:
// the main dex is entirely crypto, and the stocks, commodities and FX markets live on
// builder dexes. So an RWA-versus-crypto figure is not a main-dex question at all.
const TRADFI = new Set(['stocks', 'commodities', 'indices', 'fx', 'metals', 'energy', 'preipo', 'rates'])

export function isTradFi(cat) { return TRADFI.has(String(cat ?? '').toLowerCase()) }

/**
 * @param {Array<{dex:string, pair:[object,object[]]}>} fetched  per-dex metaAndAssetCtxs
 * @param {object} cats  coin → category, from perpCategories
 * @param {object} main  the main-dex result from computeEcosystem, all of it crypto
 */
export function computeDexes(fetched, cats, main) {
  const catOf = (c) => String(cats?.[c] ?? '').toLowerCase()
  const dexes = []
  let rwaVol = 0, rwaOi = 0, cryptoVol = 0, cryptoOi = 0

  for (const { dex, pair } of (fetched ?? [])) {
    const universe = pair?.[0]?.universe
    const ctxs = pair?.[1]
    if (!Array.isArray(universe) || !Array.isArray(ctxs)) continue
    let vol = 0, oi = 0
    universe.forEach((u, i) => {
      const c = ctxs[i]
      if (!c) return
      const v = parseFloat(c.dayNtlVlm ?? 0)
      const o = parseFloat(c.openInterest ?? 0) * parseFloat(c.markPx ?? 0)
      if (!Number.isFinite(v) || !Number.isFinite(o)) return
      vol += v; oi += o
      if (isTradFi(catOf(u.name))) { rwaVol += v; rwaOi += o } else { cryptoVol += v; cryptoOi += o }
    })
    dexes.push({ dex, vol, oi, markets: universe.length })
  }

  // The main dex is crypto by definition, so it belongs on the crypto side of the split.
  cryptoVol += main?.totalVol ?? 0
  cryptoOi  += main?.totalOi  ?? 0

  dexes.sort((a, b) => b.vol - a.vol)
  const totalVol = rwaVol + cryptoVol
  return {
    dexes,
    live: dexes.filter(d => d.vol > 0),
    rwaVol, rwaOi, cryptoVol, cryptoOi,
    rwaVolShare: totalVol > 0 ? (rwaVol / totalVol) * 100 : 0,
    builderVol: dexes.reduce((s, d) => s + d.vol, 0),
    builderOi:  dexes.reduce((s, d) => s + d.oi,  0),
  }
}

/** Spot totals. Volume only — spot has no open interest to speak of. */
export function computeSpot(pair) {
  const ctxs = pair?.[1]
  const universe = pair?.[0]?.universe
  if (!Array.isArray(ctxs)) return { ok: false, vol: 0, pairs: 0, top: [] }
  // spotMetaAndAssetCtxs does NOT return ctxs index-parallel to universe — the pairing is
  // by c.coin. Zipping them by index silently attributed one market's price, supply and
  // volume to another: the "WOW" row was showing HYPE's $80 mark and $24B cap.
  const known = new Set((universe ?? []).map(u => u?.name).filter(Boolean))
  const rows = []
  let vol = 0
  ctxs.forEach((c) => {
    const v = parseFloat(c?.dayNtlVlm ?? 0)
    if (!Number.isFinite(v)) return
    vol += v
    const name = known.has(c?.coin) ? c.coin : null
    if (!name) return
    // A spot market has no open interest, funding or premium — those belong to perps, and
    // a card that showed 0 for them would be stating something false rather than absent.
    // It does have a price, a 24h move and a supply, so carry those.
    const mark = parseFloat(c?.markPx ?? 0) || parseFloat(c?.midPx ?? 0)
    const prev = parseFloat(c?.prevDayPx ?? 0)
    const supply = parseFloat(c?.circulatingSupply ?? 0)
    rows.push({
      coin: name, vol: v, spot: true,
      mark: Number.isFinite(mark) ? mark : 0,
      chg:  prev > 0 && mark > 0 ? (mark / prev - 1) * 100 : null,
      marketCap: supply > 0 && mark > 0 ? supply * mark : 0,
    })
  })
  rows.sort((a, b) => b.vol - a.vol)
  return { ok: rows.length > 0, vol, pairs: ctxs.length, top: rows.slice(0, 5) }
}

// ─── PROTOCOL: THE ASSISTANCE FUND, AND WHAT FEES CAN HONESTLY BE SAID ────────
//
// Hyperliquid publishes no exchange-wide revenue figure — there is no endpoint for it, and
// userFees only ever describes the caller's own schedule. Two things CAN be stated exactly,
// and one thing cannot, so this keeps them apart.
//
// EXACT: the Assistance Fund. Hyperliquid routes fee revenue into buying HYPE, and the fund
// address is public and queryable like any other account. Its HYPE balance is a fact.
//
// NOT REVENUE: the fund's dollar VALUE, or the change in it. Its value moved $990M in a
// week while HYPE moved with it — that is mark-to-market on a 46.7M HYPE position, not a
// week of fees, and presenting it as revenue would overstate by an order of magnitude.
//
// ESTIMATED, AS A RANGE: fees are volume times a rate, and the maker/taker mix is not
// published. So this returns bounds — every trade a maker, every trade a taker — rather
// than a made-up point estimate inside them.
export const HL_FEE_TAKER = 0.00045   // published base tier; VIPs and stakers pay less,
export const HL_FEE_MAKER = 0.00015   // so the upper bound really is an upper bound

export function computeProtocol({ afBalances, afPortfolio, hypeMid, perpVol, spotVol } = {}) {
  const hype = (afBalances ?? []).find(b => String(b.coin).toUpperCase() === 'HYPE')
  const qty  = parseFloat(hype?.total ?? 0)
  const px   = parseFloat(hypeMid ?? 0)
  const afUsd = Number.isFinite(qty) && Number.isFinite(px) ? qty * px : 0

  const hist = (afPortfolio ?? []).find(p => p[0] === 'allTime')?.[1]?.accountValueHistory ?? []
  const since = hist.length ? Number(hist[0][0]) : 0

  const vol = (Number(perpVol) || 0) + (Number(spotVol) || 0)
  return {
    ok: qty > 0,
    afHype: qty,
    afUsd,
    since,
    // Bounds, not an estimate. The gap between them is the honest uncertainty.
    feesLow:  vol * HL_FEE_MAKER,
    feesHigh: vol * HL_FEE_TAKER,
    vol,
  }
}

// ─── SERIES → CHART ───────────────────────────────────────────────────────────
//
// Kept here with the rest of the arithmetic so the tests can drive it with real payloads;
// main.js only turns the result into SVG.

/** Trim a [ts, value] series to a trailing window. `ms = 0` means everything. */
export function windowSeries(points, ms) {
  if (!Array.isArray(points)) return []
  if (!ms) return points
  const cutoff = Date.now() - ms
  return points.filter(p => +p[0] >= cutoff)
}

/**
 * Normalise a series into SVG coordinates.
 *
 * The y-range is the data's own min→max, not 0→max. A fund that moved between $2.6B and
 * $3.7B is a chart with shape; anchored at zero it is a flat line near the top, which
 * says nothing. `pad` keeps the extremes off the edges so the stroke is not clipped.
 */
export function sparkPath(points, w = 300, h = 60, pad = 3) {
  const pts = (points ?? []).filter(p => Number.isFinite(+p[1]))
  if (pts.length < 2) return null
  const xs = pts.map(p => +p[0])
  const ys = pts.map(p => +p[1])
  const x0 = Math.min(...xs), x1 = Math.max(...xs)
  const y0 = Math.min(...ys), y1 = Math.max(...ys)
  const xSpan = x1 - x0 || 1
  // A dead-flat series would divide by zero; centring it is the honest picture.
  const ySpan = y1 - y0
  const X = (x) => pad + ((x - x0) / xSpan) * (w - pad * 2)
  const Y = (y) => ySpan === 0 ? h / 2 : h - pad - ((y - y0) / ySpan) * (h - pad * 2)
  const coords = pts.map(p => [X(+p[0]), Y(+p[1])])
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const area = `${line}L${coords[coords.length - 1][0].toFixed(1)},${h}L${coords[0][0].toFixed(1)},${h}Z`
  return {
    line, area, w, h,
    min: y0, max: y1,
    first: ys[0], last: ys[ys.length - 1],
    from: x0, to: x1,
    changePct: ys[0] > 0 ? (ys[ys.length - 1] / ys[0] - 1) * 100 : null,
  }
}

/**
 * Recorded volume readings → the fee series to chart.
 *
 * Returns BOTH bounds. The maker/taker mix is not published, so a single fee line would
 * be a made-up number inside a range we can actually state — the chart draws the range.
 * @param {Array<[number, number, number]>} points [ts, perpVol, spotVol]
 */
export function feeSeries(points) {
  const rows = (points ?? []).filter(p => Array.isArray(p) && Number.isFinite(+p[1]))
  return {
    low:  rows.map(p => [+p[0], (+p[1] + (+p[2] || 0)) * HL_FEE_MAKER]),
    high: rows.map(p => [+p[0], (+p[1] + (+p[2] || 0)) * HL_FEE_TAKER]),
    vol:  rows.map(p => [+p[0], +p[1] + (+p[2] || 0)]),
  }
}
