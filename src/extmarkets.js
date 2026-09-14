/**
 * INSOLVENT TERMINAL — the markets that are not on Hyperliquid.
 *
 * DXY, gold, the S&P, yields, forex. A watched COIN gets an icon, a sparkline and a price,
 * all from Hyperliquid's own candles. These have no such feed, so the Watch tab rendered them
 * as a TradingView embed instead — a different shape, in a different part of the tab, absent
 * from the home ticker strip. Reported as wanting DXY to be "just exactly as btc currently
 * is".
 *
 * Two feeds were checked before settling on this one:
 *
 *   HYPERLIQUID  actually lists some of them as HIP-3 builder markets — `xyz:DXY` has a mid
 *                of 97.15. But `candleSnapshot` returns ZERO candles for it: the market is
 *                listed and untraded, so there is no series to draw and the mid is nobody's
 *                price. `xyz:SP500` does have candles; DXY, gold and the rest do not.
 *   YAHOO        one request per symbol answers with a month of daily closes and a live
 *                quote, for every instrument in the list below, including while the market
 *                is shut. That is what the row needs.
 *
 * So the server fetches Yahoo and the client renders the result through the same code that
 * draws a coin. This module is the part they share: the whitelist (the browser never names a
 * URL, it names a market) and the parser (so "what is the change" is answered once).
 */

/**
 * TradingView symbol -> everything else about that market.
 *
 * Keyed by the TradingView symbol because that is what is already in people's watchlists and
 * what the chart overlay still opens. `y` is the Yahoo symbol the server is allowed to fetch;
 * nothing outside this map is fetchable, so a crafted symbol cannot turn the server into an
 * open proxy. `short` is the ticker as it should read in a row.
 */
export const EXT_MARKETS = {
  'CAPITALCOM:DXY':        { y: 'DX-Y.NYB', short: 'DXY',    name: 'US Dollar Index',  kind: 'Index' },
  'CAPITALCOM:US500':      { y: '^GSPC',    short: 'SPX',    name: 'S&P 500',          kind: 'Index' },
  'CAPITALCOM:US100':      { y: '^NDX',     short: 'NDX',    name: 'Nasdaq 100',       kind: 'Index' },
  'CAPITALCOM:US30':       { y: '^DJI',     short: 'DJI',    name: 'Dow Jones',        kind: 'Index' },
  'CAPITALCOM:VIX':        { y: '^VIX',     short: 'VIX',    name: 'Volatility',       kind: 'Index' },
  'TVC:GOLD':              { y: 'GC=F',     short: 'GOLD',   name: 'Gold · spot',      kind: 'Metal' },
  'TVC:SILVER':            { y: 'SI=F',     short: 'SILVER', name: 'Silver · spot',    kind: 'Metal' },
  'TVC:USOIL':             { y: 'CL=F',     short: 'WTI',    name: 'Crude Oil · WTI',  kind: 'Energy' },
  'CAPITALCOM:NATURALGAS': { y: 'NG=F',     short: 'NATGAS', name: 'Natural Gas',      kind: 'Energy' },
  'FRED:DGS10':            { y: '^TNX',     short: 'US10Y',  name: 'US 10Y Yield',     kind: 'Rate' },
  'FX:EURUSD':             { y: 'EURUSD=X', short: 'EURUSD', name: 'EUR / USD',        kind: 'FX' },
  'FX:GBPUSD':             { y: 'GBPUSD=X', short: 'GBPUSD', name: 'GBP / USD',        kind: 'FX' },
  'FX:USDJPY':             { y: 'USDJPY=X', short: 'USDJPY', name: 'USD / JPY',        kind: 'FX' },
}

/** Is this watchlist entry an external market (as opposed to a Hyperliquid coin)? */
export function isExtMarket(sym) { return Object.hasOwn(EXT_MARKETS, String(sym ?? '')) }

/** The Yahoo symbol the server may fetch for this market, or null. Nothing else is fetchable. */
export function extYahoo(sym) { return EXT_MARKETS[String(sym ?? '')]?.y ?? null }

/**
 * A quote in the units the instrument is actually quoted in.
 *
 * A coin row can put a dollar sign in front of everything, because a coin is priced in
 * dollars. These are not all: an index level is a number, a yield is a percentage, and a
 * currency pair is a rate. "$99.12" for the dollar index would be a category error, and
 * "$4.98" for the US 10-year would be a wrong one.
 */
export function extPriceStr(sym, price) {
  if (price == null || !Number.isFinite(Number(price))) return '—'
  const p = Number(price)
  const k = EXT_MARKETS[String(sym ?? '')]?.kind
  // A pair quoted in the hundreds carries three decimals, not four: USD/JPY is 153.554, and
  // "153.5540" claims a precision the quote does not have.
  if (k === 'FX')   return p >= 20 ? p.toFixed(3) : p.toFixed(4)
  if (k === 'Rate') return p.toFixed(3) + '%'
  const n = p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  // Metals and energy ARE dollar prices (an ounce, a barrel); an index level is not.
  return (k === 'Metal' || k === 'Energy') ? '$' + n : n
}

/** How far back the row looks. A coin's sparkline and its % both cover 24h; so do these. */
const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * One Yahoo chart response -> { price, pct, points }, or null if it carries no series.
 *
 * Both numbers describe THE SAME WINDOW, which is the whole point of doing this here rather
 * than taking the two figures Yahoo hands over. A month of daily closes next to a
 * one-session change puts a falling red line beside a rising green percentage in the same
 * row, and a reader has no way to know they are measuring different things.
 *
 * So: the last 24 hours OF TRADING, ending at the most recent tick — not the last 24 hours of
 * wall-clock, which over a weekend is empty. When a market has been shut all day that window
 * is its final session, and the row keeps reporting that session's move, which is true: the
 * price has not changed since.
 *
 * Falls back to daily closes for anything too sparse to draw intraday (a holiday-shortened
 * week, an instrument that ticks rarely). Something always draws, or we return null and the
 * row shows a dash — never a zero, which would read as "flat".
 */
export function parseChart(json) {
  const r = json?.chart?.result?.[0]
  if (!r) return null
  const ts     = r.timestamp ?? []
  const closes = r.indicators?.quote?.[0]?.close ?? []
  const series = ts.map((t, i) => [t * 1000, closes[i]]).filter(([, c]) => Number.isFinite(c))
  if (!series.length) return null

  const lastAt = series.at(-1)[0]
  let window = series.filter(([t]) => t >= lastAt - WINDOW_MS)
  if (window.length < 5) window = series.slice(-30)   // too sparse to be a line on its own

  const points = window.map(([, c]) => c)
  const live   = Number(r.meta?.regularMarketPrice)
  // The live quote is fresher than the last bar during a session; the last bar is all there
  // is once the market shuts.
  const price  = Number.isFinite(live) && live > 0 ? live : points.at(-1)
  // A single bar has nothing to measure against. Comparing the price to ITSELF would print a
  // confident 0.00% — "flat" — for a market we cannot actually say anything about.
  const base   = points.length >= 2 ? points[0] : null
  const pct    = base ? ((price - base) / base) * 100 : null
  return { price, pct, points }
}

/**
 * The Yahoo URL for a market. Server-side only — the browser only ever calls our origin.
 *
 * 5 days at 15 minutes, not 1 day: `range=1d` answers with an EMPTY series for anything whose
 * market is shut, which on a Sunday is all of them. Five days always contains a session, and
 * parseChart takes the last 24 hours of trading out of it.
 */
export function extChartUrl(yahooSym) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yahooSym) + '?range=5d&interval=15m'
}

/**
 * The Watch tab's timeframes, in Yahoo's vocabulary.
 *
 * Keyed by the same labels as WATCH_TF_CONFIG in main.js, because the compare chart offers
 * one set of pills and both kinds of market have to answer to them — a DXY that only had a
 * 24h series would drop off the chart the moment anyone pressed 1M.
 *
 * `range` is always WIDER than `span`. The series is then cut down to the span. Asking Yahoo
 * for exactly the window wanted answers with an empty series whenever the market is shut,
 * which for the shorter windows is every weekend; asking wide and trimming always lands on
 * real sessions. Intraday intervals are also capped by Yahoo (15m is only served for ~60
 * days, 1h for ~730), which is why the longer windows step down to daily and weekly bars.
 */
export const EXT_TF = {
  '1D': { range: '5d',  interval: '15m', span: 24 * 3600_000 },
  '1W': { range: '1mo', interval: '1h',  span: 7 * 86400_000 },
  '1M': { range: '3mo', interval: '1d',  span: 30 * 86400_000 },
  '3M': { range: '6mo', interval: '1d',  span: 90 * 86400_000 },
  '6M': { range: '1y',  interval: '1d',  span: 180 * 86400_000 },
  '1Y': { range: '2y',  interval: '1wk', span: 365 * 86400_000 },
  '5Y': { range: '10y', interval: '1mo', span: 5 * 365 * 86400_000 },
}

/** The Yahoo URL for one market over one timeframe. Unknown timeframe -> null, not a guess. */
export function extChartUrlTf(yahooSym, tf) {
  const cfg = EXT_TF[String(tf ?? '')]
  if (!cfg || !yahooSym) return null
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' +
    encodeURIComponent(yahooSym) + '?range=' + cfg.range + '&interval=' + cfg.interval
}

/**
 * One Yahoo chart response -> `[{ t, c }, …]` inside a window ENDING NOW, or [].
 *
 * The timestamps are the point of this function, and the reason it is not parseChart.
 *
 * parseChart answers "how has this market moved", and anchors its window at the market's own
 * last tick — over a weekend that is Friday's session, which is the right answer for a row
 * that has to print a change while the market is shut.
 *
 * A comparison chart is a different question. Every series is drawn on ONE shared time axis
 * against coins that trade continuously, so a point's position is its real timestamp. Anchor
 * DXY at its last tick there and its line is drawn in the wrong place — shifted left by
 * however long the market has been closed, describing Friday while BTC beside it describes
 * today. So this window is `now - span` to now, always, and a shut market simply has no
 * points in it.
 *
 * Which is why an empty return is a real answer and not a failure: over a weekend the dollar
 * index genuinely has no ticks in the last 24 hours. The caller says so rather than drawing
 * a flat line, because a flat line at Friday's close is a price nobody quoted.
 */
export function parseSeries(json, tf, now = Date.now()) {
  const cfg = EXT_TF[String(tf ?? '')]
  if (!cfg) return []
  const r = json?.chart?.result?.[0]
  if (!r) return []
  const ts     = r.timestamp ?? []
  const closes = r.indicators?.quote?.[0]?.close ?? []
  const all = ts
    .map((t, i) => ({ t: t * 1000, c: closes[i] }))
    .filter(p => Number.isFinite(p.t) && p.t > 0 && Number.isFinite(p.c) && p.c > 0)
  if (all.length < 2) return []
  const cut = all.filter(p => p.t >= now - cfg.span)
  // One point is not a series: it has nothing to be a percentage of, and computeCompare would
  // drop it anyway. Say empty rather than sending a single point that reads as flat.
  return cut.length >= 2 ? cut : []
}
