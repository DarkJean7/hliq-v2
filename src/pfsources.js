/**
 * Where /portfolios gets its prices. Three choices, one per button:
 *
 *   hl     Hyperliquid's own daily closes — what can actually be traded here.
 *   tv     The real markets: each asset's exchange price — Nasdaq, NYSE, the Korea Exchange,
 *          NYMEX, FX — where we know its symbol. TradingView charts show these same prices
 *          but sell no data feed; the history comes from Yahoo Finance, which publishes them.
 *          A market with no verified symbol stays on Hyperliquid, and the page says which.
 *   mixed  Hyperliquid from the day each market listed there, and BEFORE that the outside
 *          history, scaled to meet Hyperliquid's first close: exchange prices for TradFi,
 *          CoinGecko for crypto. A stock basket keeps its years before the HIP-3 listing,
 *          and from the listing on it is what you could have traded.
 *
 * The maps below are allowlists, not guesses. A ticker is mapped only where it is certainly
 * the same asset: "BB" is BounceBit as a perp and BlackBerry as a stock, and a wrong match
 * shows somebody else's prices as yours (the STRK lesson in src/llama.js). Unlisted means
 * Hyperliquid, never a guess. The server fetches ONLY symbols in these maps, so the route
 * cannot be pointed at anything else.
 *
 * Pure: imported by src/portfolio.js, serve-prod.js and tests/suites/pfbacktest.test.mjs.
 */

export const SOURCES = [['hl', 'Hyperliquid'], ['tv', 'TradingView'], ['mixed', 'Mixed']]

/** TradFi markets on Hyperliquid (ticker without its dex) → exchange symbol. */
const US = 'AAOI AAPL AMAT AMD AMZN ARM ASML AVGO BABA BB BE BMNR BX CIEN CIFR COHR COIN COST CRCL CRDO CRWD CRWV CVX DELL DKNG EBAY EWJ EWT EWY EWZ GEV GLW GME GOOGL GOOG HIMS HOOD IBM IGV INTC IONQ IREN KORU LITE LLY LRCX MAGS MELI META MRNA MRVL MSFT MSTR MU NBIS NET NFLX NOK NOW NVDA ORCL PLTR QCOM RDDT RIVN RKLB SMCI SMH SNDK SOFI SOXL STRC STX TER TLT TSLA TSM TTWO TWST UMC URNM USAR VST WDC XBI XLE ZM SPY QQQ IWM'
export const TRADFI_YAHOO = {
  ...Object.fromEntries(US.split(' ').map(t => [t, t])),
  GPRO: 'GPRO', USBOND: 'TLT', USTECH: 'QQQ', SMALL2000: 'IWM',
  // listed outside the US — priced in their own currency, converted to dollars by the server
  SMSN: '005930.KS', SAMSUNG: '005930.KS', SKHX: '000660.KS', SKHY: '000660.KS', SKHYNIX: '000660.KS',
  HYUNDAI: '005380.KS', TCNT: '0700.HK', TENCENT: '0700.HK', SOFTBANK: '9984.T', KIOXIA: '285A.T', GIGADEV: '603986.SS',
  // indices
  SP500: '^GSPC', US500: '^GSPC', JP225: '^N225', KR200: '^KS200',
  // commodities — front-month futures
  GOLD: 'GC=F', SILVER: 'SI=F', COPPER: 'HG=F', PLATINUM: 'PL=F', PALLADIUM: 'PA=F',
  CL: 'CL=F', WTI: 'CL=F', USOIL: 'CL=F', OIL: 'CL=F', BRENTOIL: 'BZ=F', HO: 'HO=F', NATGAS: 'NG=F', GAS: 'NG=F',
  CORN: 'ZC=F', WHEAT: 'ZW=F', SOY: 'ZS=F',
  // FX, quoted as Hyperliquid quotes them
  EUR: 'EURUSD=X', GBP: 'GBPUSD=X', JPY: 'JPY=X',
}

/** Crypto with an unambiguous exchange quote (for "TradingView"; Mixed uses CoinGecko). */
const CRYPTO = 'BTC ETH SOL XRP DOGE ADA AVAX LINK DOT LTC BCH TRX XLM ZEC XMR ATOM NEAR UNI AAVE ETC FIL HBAR ICP ALGO DASH'
export const CRYPTO_YAHOO = Object.fromEntries(CRYPTO.split(' ').map(t => [t, t + '-USD']))

/**
 * Does a series need converting to dollars? A listing in another currency does (Samsung in
 * won); an INDEX does not — ^N225 is a level in points, which is how Hyperliquid quotes JP225 too,
 * and converting it would add the yen's move to the index's.
 */
export const needsUsd = (sym, currency) => !!currency && currency !== 'USD' && !String(sym).startsWith('^')

/** Currencies a non-dollar listing can be in → the FX quote that converts it (units per USD). */
export const FX_PER_USD = { KRW: 'KRW=X', HKD: 'HKD=X', JPY: 'JPY=X', CNY: 'CNY=X' }

const ALLOWED = new Set([...Object.values(TRADFI_YAHOO), ...Object.values(CRYPTO_YAHOO), ...Object.values(FX_PER_USD)])
/** May the server fetch this exchange symbol? Only what these maps name. */
export const isAllowedYahoo = (s) => ALLOWED.has(String(s ?? ''))

/**
 * The exchange symbol for a market row ({ sym, group }), or null. TradFi and crypto maps are
 * kept apart: a stock ticker is looked up only for a TradFi market, a coin only for crypto.
 */
export function yahooFor(row) {
  if (!row?.sym) return null
  return row.group === 'tradfi' ? (TRADFI_YAHOO[row.sym] ?? TRADFI_YAHOO[row.label] ?? null) : (CRYPTO_YAHOO[row.sym] ?? null)
}

export const yahooUrl = (sym) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=10y&interval=1d`
export const cgChartUrl = (id) => `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365&interval=daily`

const DAY = 86_400_000
const day = (t) => Math.floor(t / DAY) * DAY

/** Yahoo chart JSON → { pts: [[dayMs, close]], currency }. Split-adjusted closes; one point per day. */
export function parseYahooDaily(json) {
  const r = json?.chart?.result?.[0]
  const ts = r?.timestamp, cl = r?.indicators?.quote?.[0]?.close
  if (!Array.isArray(ts) || !Array.isArray(cl)) return { pts: [], currency: null }
  const by = new Map()
  ts.forEach((t, i) => { const c = Number(cl[i]); if (c > 0 && Number.isFinite(c)) by.set(day(t * 1000), c) })
  return { pts: [...by].sort((a, b) => a[0] - b[0]), currency: r?.meta?.currency ?? null }
}

/** CoinGecko market_chart JSON → [[dayMs, price]], the last price of each day. */
export function parseCgChart(json) {
  const by = new Map()
  for (const [t, p] of (Array.isArray(json?.prices) ? json.prices : [])) if (Number(p) > 0) by.set(day(Number(t)), Number(p))
  return [...by].sort((a, b) => a[0] - b[0])
}

/** Local-currency closes → dollars, with an FX series in units per USD (KRW=X ≈ 1,400). */
export function toUsd(pts, fx) {
  const f = [...fx].sort((a, b) => a[0] - b[0])
  if (!f.length) return []
  let j = 0, rate = null
  const out = []
  for (const [t, v] of pts) {
    while (j < f.length && f[j][0] <= t) rate = f[j++][1]
    const r = rate ?? f[0][1]
    if (r > 0) out.push([t, v / r])
  }
  return out
}

/**
 * Outside history before Hyperliquid's first close, scaled to meet it, then Hyperliquid's own.
 * Returns are what is kept: the outside series is multiplied by one constant, so every
 * day-to-day move before the listing is the market's own. → { pts, splicedAt|null }
 */
export function splice(ext, hl) {
  if (!hl?.length) return { pts: ext ?? [], splicedAt: null }
  const first = hl[0][0]
  const before = (ext ?? []).filter(([t]) => t < first)
  if (!before.length) return { pts: hl, splicedAt: null }
  // The outside close on the listing day (or the last one before it) is where the two meet.
  const at = [...(ext ?? [])].reverse().find(([t]) => t <= first)
  const scale = at && at[1] > 0 ? hl[0][1] / at[1] : 1
  return { pts: [...before.map(([t, v]) => [t, v * scale]), ...hl], splicedAt: first }
}

/**
 * Where a market's outside history comes from, decided from its Hyperliquid id ALONE — so the
 * server (which prices the featured cards) and the browser (which prices yours) always choose
 * the same source for the same market, and a card reads the same whichever of them answered.
 *
 *   'xyz:NVDA'  a HIP-3 market whose ticker is on the TradFi map → its exchange series.
 *   'ZEC'       a crypto perp → its exchange quote ("TradingView", majors only) or CoinGecko
 *               (Mixed). A k-prefixed perp (kPEPE is 1,000 PEPE) is not its coin's price.
 *   '@700'      a spot market → Hyperliquid only: its id names no ticker without the spot table.
 */
export function planFor(coin) {
  const c = String(coin ?? '')
  if (!c || c.startsWith('@')) return { sym: null, tradfi: false, yahooTv: null, yahooMixed: null, cgSym: null }
  const sym = c.includes(':') ? c.slice(c.indexOf(':') + 1) : c
  const tradfi = c.includes(':') && Object.hasOwn(TRADFI_YAHOO, sym)
  return {
    sym, tradfi,
    yahooTv: tradfi ? TRADFI_YAHOO[sym] : (CRYPTO_YAHOO[sym] ?? null),
    yahooMixed: tradfi ? TRADFI_YAHOO[sym] : null,
    cgSym: tradfi || /^k[A-Z]/.test(sym) ? null : sym.toUpperCase(),
  }
}

/** CoinGecko's free history is a year: it only adds to a coin Hyperliquid listed since. */
export const CG_SPAN = 360 * DAY
export const wantsCg = (hl, now = Date.now()) => !!hl?.length && hl[0][0] > now - CG_SPAN

/**
 * The closes a market is priced with in a mode, from its Hyperliquid series and (when there is
 * one) its outside series. → { pts, used: 'hl'|'tv'|'cg', splicedAt }
 */
export function closesFor(mode, hl, ext, extSrc = 'tv') {
  // Outside series lose any history before a data seam; Hyperliquid's own lose its splits, where
  // an exchange series (TradFi) is there to tell a split from a move.
  const x = dropBeforeBreak(ext)
  const h = extSrc === 'tv' && x?.length ? repairSplits(hl, x) : (hl ?? [])
  if (mode === 'tv') return x?.length ? { pts: x, used: 'tv', splicedAt: null } : { pts: h, used: 'hl', splicedAt: null }
  if (mode === 'mixed' && x?.length) {
    const sp = splice(x, h)
    return { pts: sp.pts, used: sp.splicedAt ? extSrc : 'hl', splicedAt: sp.splicedAt }
  }
  return { pts: h, used: 'hl', splicedAt: null }
}

/**
 * Stock splits in Hyperliquid's own closes. HIP-3 history is not split-adjusted: KIOXIA's 3-for-1
 * on Sep 28, 2026 reads 357 → 114, a -68% day that never happened (the exchange, which IS
 * adjusted, shows -3.5%). Where a market has an exchange reference, a day on which Hyperliquid's
 * move and the exchange's differ by 1.6× or more is a split, and everything before it is
 * rescaled so that day moves as the exchange's did. Without a reference nothing is touched —
 * crypto does not split.
 */
export const SPLIT_GAP = 1.6
export function repairSplits(hl, ref) {
  if (!hl?.length || !ref?.length) return hl ?? []
  const r = [...ref].sort((a, b) => a[0] - b[0])
  const at = (t) => { let lo = 0, hi = r.length - 1, v = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (r[m][0] <= t) { v = r[m][1]; lo = m + 1 } else hi = m - 1 } return v }
  const out = hl.map(p => [p[0], p[1]])
  let f = 1
  for (let k = out.length - 1; k >= 1; k--) {
    out[k][1] *= f
    const a = at(hl[k - 1][0]), b = at(hl[k][0])
    if (!(a > 0 && b > 0) || r[0][0] > hl[k - 1][0]) continue
    const gap = (hl[k][1] / hl[k - 1][1]) / (b / a)
    if (gap >= SPLIT_GAP || gap <= 1 / SPLIT_GAP) f *= gap
  }
  out[0][1] *= f
  return out
}

/**
 * Outside history with a break in it. A listed asset does not close at five times (or a fifth
 * of) the day before; when a series says so, it is a data seam — Yahoo's AAVE carries the old
 * LEND token, swapped 100:1 in Oct 2020 — and only what comes after the seam is kept.
 */
export function dropBeforeBreak(pts, k = 5) {
  if (!pts?.length) return pts ?? []
  let from = 0
  for (let i = 1; i < pts.length; i++) { const q = pts[i][1] / pts[i - 1][1]; if (q > k || q < 1 / k) from = i }
  return from ? pts.slice(from) : pts
}
