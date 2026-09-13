// DXY should look exactly like BTC.
//
// Reported twice. First: "i want in watch tab, to also make cards for the tradingview assets
// like in the image which btc cards appears but not for dxy." Then, when the answer was a
// TradingView card: "what i meant is that i want the dxy be just exactly as btc currently is.
// they are not looking nothing similar and also dxy is not appearing above under the
// deposit/withdraw/send".
//
// A coin row is an icon, a ticker, a sparkline and a price, and the same figures appear in the
// home strip. None of that can be drawn from an iframe, so the embed had to go and the numbers
// had to come from somewhere. Two feeds were checked first:
//
//   HYPERLIQUID  lists some of these as HIP-3 markets — `xyz:DXY` quotes 97.15 — but
//                candleSnapshot returns ZERO candles for it. Listed and untraded: no series to
//                draw, and a mid nobody trades at.
//   YAHOO        answers for every symbol in the map, including while the market is shut.
//
// So the server fetches, this module parses, and the coin renderers draw it.
import fs from 'fs'
import { EXT_MARKETS, isExtMarket, extYahoo, extPriceStr, parseChart, extChartUrl } from '../../src/extmarkets.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const SRV = fs.readFileSync('serve-prod.js', 'utf8').replace(/\r\n/g, '\n')
const MOD = fs.readFileSync('src/extmarkets.js', 'utf8')

// A Yahoo chart response, as the parser sees it.
const chart = (bars, meta = {}) => ({ chart: { result: [{
  meta, timestamp: bars.map(b => b[0]), indicators: { quote: [{ close: bars.map(b => b[1]) }] } }] } })
// `n` bars, one every 15 minutes, ending at `endSec`.
const series = (endSec, n, fn) =>
  [...Array(n)].map((_, i) => [endSec - (n - 1 - i) * 900, fn(i)])

console.log(nl + '-- only a market we mapped can be fetched --')
t('the map is keyed by TradingView symbol', isExtMarket('CAPITALCOM:DXY') && isExtMarket('TVC:GOLD'))
t('a coin is not an external market', !isExtMarket('BTC') && !isExtMarket('hype2:CHIP'))
t('nor is anything else', !isExtMarket('EVIL:HACK') && !isExtMarket('') && !isExtMarket(null))
t('each one names its Yahoo symbol', extYahoo('CAPITALCOM:DXY') === 'DX-Y.NYB')
t('and an unmapped one names nothing', extYahoo('EVIL:HACK') === null)
// The client sends a market name, never a URL, so a crafted value cannot make the server fetch
// an arbitrary host.
t('the URL is built here, from the mapped symbol only',
  extChartUrl(extYahoo('TVC:GOLD')).startsWith('https://query1.finance.yahoo.com/v8/finance/chart/GC%3DF'))
t('every market has a ticker and a kind',
  Object.values(EXT_MARKETS).every(m => m.y && m.short && m.name && m.kind))

console.log(nl + '-- the line and the percentage measure THE SAME WINDOW --')
{
  // This is the bug the parser exists to avoid: a month-long falling line beside a rising
  // one-session percentage, in the same row, with nothing to say they disagree on purpose.
  const end = Math.floor(Date.now() / 1000)
  // Three days of bars: falling hard early, rising over the last 24h.
  const bars = series(end, 3 * 96, i => i < 2 * 96 ? 200 - i * 0.5 : 100 + (i - 2 * 96) * 0.2)
  const q = parseChart(chart(bars))
  // 97, not 96: the boundary is inclusive, so the bar exactly 24h back is in the window.
  t('only the last 24h of trading is kept', q.points.length === 97, q.points.length)
  t('the window rises', q.points.at(-1) > q.points[0])
  t('and so does the percentage', q.pct > 0, q.pct)
  // Measured across the window only. The whole three days fell 40%; these 24 hours rose.
  t('the older decline is not counted', q.pct > 10 && q.pct < 20, q.pct)
}
{
  // A market shut all weekend: the last bar is days old. The window is the last 24 HOURS OF
  // TRADING, not of wall-clock, so Friday's session still draws instead of coming back empty.
  const friday = Math.floor(Date.now() / 1000) - 3 * 86400
  const q = parseChart(chart(series(friday, 40, i => 100 + i)))
  t('a stale series still reports', q !== null && q.points.length === 40, q && q.points.length)
  t('and still reports its move', q.pct > 0)
}
{
  // Too few bars to be a line: fall back to whatever the response does carry.
  const end = Math.floor(Date.now() / 1000)
  const q = parseChart(chart([[end - 5 * 86400, 10], [end - 4 * 86400, 11], [end, 12]]))
  t('a sparse window falls back to the whole series', q.points.length === 3, q.points)
}

console.log(nl + '-- the price is the freshest one, the change has a base --')
{
  const end = Math.floor(Date.now() / 1000)
  const bars = series(end, 10, () => 100)
  t('the live quote beats the last bar',
    parseChart(chart(bars, { regularMarketPrice: 101.5 })).price === 101.5)
  t('and the last bar carries it when there is no quote', parseChart(chart(bars)).price === 100)
  t('a nonsense quote does not win', parseChart(chart(bars, { regularMarketPrice: 0 })).price === 100)
  // Unknown, not zero: one bar has nothing to measure against.
  t('one bar means no percentage', parseChart(chart([[end, 5]])).pct === null)
  t('no series at all is null', parseChart(chart([])) === null)
  t('and so is junk', parseChart(null) === null && parseChart({}) === null)
  // A gap in the series is a hole in the data, not a zero print.
  const holed = { chart: { result: [{ meta: {}, timestamp: [end - 900, end],
    indicators: { quote: [{ close: [null, 7] }] } }] } }
  t('a null bar is dropped, not read as 0', parseChart(holed).points.every(Number.isFinite))
}

console.log(nl + '-- quoted in the units the instrument actually uses --')
{
  // A coin row can put a dollar sign on everything, because a coin is priced in dollars.
  // "$99.12" for the dollar index would be a category error; "$4.98" for the US 10-year a
  // wrong one.
  t('an index level has no currency', extPriceStr('CAPITALCOM:DXY', 99.122) === '99.12')
  t('a metal is a dollar price', extPriceStr('TVC:GOLD', 4408.9) === '$4,408.90')
  t('so is a barrel', extPriceStr('TVC:USOIL', 100.05) === '$100.05')
  t('a yield is a percentage', extPriceStr('FRED:DGS10', 4.975) === '4.975%')
  t('a currency pair carries four decimals', extPriceStr('FX:EURUSD', 1.16012) === '1.1601')
  t('unless it is quoted in the hundreds', extPriceStr('FX:USDJPY', 153.554) === '153.554')
  t('an unknown price is a dash, not a zero',
    extPriceStr('CAPITALCOM:DXY', null) === '—' && extPriceStr('CAPITALCOM:DXY', NaN) === '—')
}

console.log(nl + '-- the server fetches it, the browser never does --')
{
  t('there is a quote route', SRV.includes("if (url === '/extquote')"))
  t('it only serves mapped markets', SRV.includes('.filter(s => EXT_MARKETS[s])'))
  t('and caps how many it fetches at once', /\.filter\(s => EXT_MARKETS\[s\]\)\.slice\(0, \d+\)/.test(SRV))
  t('nothing mapped means 400, not a fetch', SRV.includes('if (!want.length) { res.writeHead(400'))
  t('answers are cached', SRV.includes('extQuoteCache') && SRV.includes('EXT_QUOTE_TTL'))
  // A symbol that answers with no series is left out so the row can show a dash. Sending a
  // zero would read as "flat", which is a different claim.
  t('a market with no series is omitted rather than zeroed', SRV.includes('if (q) { extQuoteCache.set'))
  t('the browser calls our origin only', CLI.includes("fetch('/extquote?s=' + encodeURIComponent(list.join(',')))"))
  t('why Hyperliquid is not the source is written down', MOD.includes('listed and untraded'))
}

console.log(nl + '-- and one renderer draws both kinds of row --')
{
  // The trick: the quote is written into the coin candle cache, under the same key shape, so
  // the sparkline, the scrub, the ticker cell and the row are all the code that already drew a
  // coin. Nothing downstream knows what an external market is.
  t('the quote is written into the coin cache',
    CLI.includes('_watchCandleCache[`${sym}_1D`] = { ts: Date.now(), candles: q.points.map(c => ({ c })) }'))
  t('the row is the coin row', CLI.includes('<canvas class="mob-watch-spark" id="${cid}" data-coin="${esc(sym)}"'))
  t('the home strip carries them too', CLI.includes('const list = [...loadWatchlist(), ...loadTvWatch()]'))
  t('so does the desktop ticker', (CLI.match(/\[\.\.\.loadWatchlist\(\), \.\.\.loadTvWatch\(\)\]/g) ?? []).length >= 2)
  // There is nothing to trade here, so a tap opens the chart instead of the trade screen.
  t('a market opens its chart, a coin opens the trade screen',
    CLI.includes("const open = isExtMarket(coin) ? 'window.__tvOpenChart' : 'window.__watchOpenTrade'"))
  t('the mini widget is gone', !CLI.includes('_tvMountMinis') &&
    !CLI.includes('embed-widget-mini-symbol-overview.js'))
  t('and why it could not stay is recorded', CLI.includes('it hid its own price'))
  t('the full chart is still what a tap opens', CLI.includes('embed-widget-advanced-chart.js'))
  // Its artwork is the curated stock/metal/flag map; CoinGecko's `gold` is a token that
  // borrowed the name.
  t('its icon never comes from a coin index',
    /isExtMarket\(coin\)\) \{[\s\S]{0,300}?_tradFiIconUrl/.test(CLI))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
