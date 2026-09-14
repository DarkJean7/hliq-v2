// External markets on the compare chart — "lets make tradingview charts also be exactly like
// the other so they also can be compared".
//
// DXY, gold and the rest already looked like a coin in the Watch tab: same row, same icon,
// same sparkline. The Advanced · compare overlay was still coin-only, because its picker read
// loadWatchlist() and its fetch went to Hyperliquid's candleSnapshot — so the markets sitting
// directly below the coins in the same tab could not be put on the same chart as them.
//
// The half of this that is easy to get wrong is TIME. A coin trades continuously; an index
// does not. Both are drawn on ONE shared axis where a point's x position is its timestamp, so
// the window has to be anchored the same way for both, and a market that was shut has to be
// absent rather than flat.
import fs from 'fs'
import { EXT_TF, extChartUrlTf, parseSeries, EXT_MARKETS } from '../../src/extmarkets.js'

const CLI  = fs.readFileSync('src/main.js', 'utf8')
const SRV  = fs.readFileSync('serve-prod.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

// A Yahoo chart reply carrying these [ms, close] points.
const mk = (pairs) => ({ chart: { result: [{
  timestamp: pairs.map(p => p[0] / 1000),
  indicators: { quote: [{ close: pairs.map(p => p[1]) }] },
}] } })

const NOW = 1_800_000_000_000
const HOUR = 3600_000, DAY = 86400_000

console.log(nl + '-- every timeframe pill has an answer for a market, not just for a coin --')
{
  // The pills are built from WATCH_TF_CONFIG. A timeframe in that map with no EXT_TF entry is
  // a pill that silently drops every external market off the chart, and nothing else would
  // catch it — the fetch just returns nothing and the line disappears.
  const from = CLI.slice(CLI.indexOf('const WATCH_TF_CONFIG'))
  // Up to the brace that closes the object, which is the one at the start of a line — the
  // first `}` in the text closes the first ENTRY, and reading to there finds one timeframe.
  const block = from.slice(0, from.search(/\r?\n\}/))
  const tfs = [...block.matchAll(/'([^']+)':\s*\{/g)].map(m => m[1])
  t('the timeframes were found in main.js', tfs.length >= 5, tfs)
  t('and EXT_TF answers every one of them',
    tfs.every(tf => !!EXT_TF[tf]), tfs.filter(tf => !EXT_TF[tf]))
  t('with no extra timeframes nothing can ask for',
    Object.keys(EXT_TF).every(tf => tfs.includes(tf)), Object.keys(EXT_TF).filter(tf => !tfs.includes(tf)))
}

console.log(nl + '-- each one asks Yahoo for MORE than it needs, then trims --')
{
  const ms = (r) => {
    const m = /^(\d+)(d|mo|y)$/.exec(r)
    return m ? +m[1] * ({ d: DAY, mo: 30 * DAY, y: 365 * DAY })[m[2]] : 0
  }
  // Asking for exactly the window wanted comes back EMPTY whenever the market is shut, which
  // for the short windows is every weekend. Asking wide and cutting down always lands on real
  // sessions. Same reason range=5d is used for the 24h row quote.
  const bad = Object.entries(EXT_TF).filter(([, c]) => ms(c.range) <= c.span).map(([tf]) => tf)
  t('the range always covers more than the span', bad.length === 0, bad)
  t('an unknown timeframe is refused rather than guessed', extChartUrlTf('DX-Y.NYB', '2Y') === null)
  t('and so is a missing symbol', extChartUrlTf(null, '1D') === null)
  t('the url carries both the range and the interval',
    extChartUrlTf('DX-Y.NYB', '1M').includes('range=3mo&interval=1d'), extChartUrlTf('DX-Y.NYB', '1M'))
}

console.log(nl + '-- the window ends NOW, not at the market’s last tick --')
{
  // This is the whole reason parseSeries is not parseChart. parseChart anchors on the last
  // tick, which is right for a row that must print a 24h change while the market is shut. Do
  // that here and DXY's line is drawn shifted left of the coins beside it — describing Friday
  // while BTC describes today, on an axis where x IS the time.
  const fresh = parseSeries(mk([[NOW - 3 * HOUR, 100], [NOW - 2 * HOUR, 101], [NOW - HOUR, 102]]), '1D', NOW)
  t('points inside the window come back', fresh.length === 3, fresh.length)
  t('as {t, c} in milliseconds, like a Hyperliquid candle',
    fresh[0].t === NOW - 3 * HOUR && fresh[0].c === 100, fresh[0])

  // Friday's session, read on a Sunday.
  const stale = mk([[NOW - 3 * DAY, 100], [NOW - 3 * DAY + HOUR, 101], [NOW - 3 * DAY + 2 * HOUR, 99]])
  t('a market shut for the whole window returns nothing', parseSeries(stale, '1D', NOW).length === 0)
  t('and the SAME data is a real series over a longer window', parseSeries(stale, '1M', NOW).length === 3)
}

console.log(nl + '-- and it never invents a line --')
{
  t('one lone point is not a series',
    parseSeries(mk([[NOW - 5 * DAY, 100], [NOW - HOUR, 101]]), '1D', NOW).length === 0)
  t('nulls in the close array are dropped, not read as zero',
    parseSeries(mk([[NOW - 3 * HOUR, 100], [NOW - 2 * HOUR, null], [NOW - HOUR, 102]]), '1D', NOW).length === 2)
  t('a reply with no series at all is empty, not a throw', parseSeries({}, '1D', NOW).length === 0)
  t('an unknown timeframe is empty too', parseSeries(mk([[NOW - HOUR, 1], [NOW, 2]]), '9Y', NOW).length === 0)
}

console.log(nl + '-- the server will only fetch a market it already knows --')
{
  const route = SRV.slice(SRV.indexOf("if (url === '/extcandles')"), SRV.indexOf("// Static files"))
  t('the route exists', route.length > 200)
  t('the symbol is filtered through the whitelist', route.includes('filter(s => EXT_MARKETS[s])'))
  t('the timeframe is checked against EXT_TF', route.includes('!EXT_TF[tf]'))
  t('and a bad request is a 400, not a fetch', /writeHead\(400[\s\S]{0,80}series/.test(route))
  t('the reply is capped like /extquote', route.includes('.slice(0, 20)'))
  // An empty series is a real answer — "shut all weekend" — and caching it is what stops the
  // client re-asking every render for something that cannot change until Monday.
  t('an empty series is cached as an answer', /extSeriesCache\.set\(key, \{ at: Date\.now\(\), pts \}\)/.test(route))
  t('why that is deliberate is written down', route.includes('really'))
}

console.log(nl + '-- the client puts both kinds of market on one chart --')
{
  const grab = (sig) => {
    const start = CLI.indexOf(sig)
    if (start < 0) throw new Error('not found: ' + sig)
    let i = CLI.indexOf('{', start), depth = 0
    for (; i < CLI.length; i++) {
      if (CLI[i] === '{') depth++
      else if (CLI[i] === '}') { depth--; if (depth === 0) return CLI.slice(start, i + 1) }
    }
    throw new Error('unbalanced')
  }
  const fetchFn  = grab('async function _cmpFetch()')
  const renderFn = grab('function _cmpRender()')

  t('the picker offers the external markets too', renderFn.includes('loadTvWatch().filter(isExtMarket)'))
  t('and groups them the way the Watch tab does',
    renderFn.includes("groupHead(T('Coins'))") && renderFn.includes("groupHead(T('Markets'))"))
  t('the default selection includes them', grab('window.__openWatchAdvanced = function()').includes('loadTvWatch()'))
  t('they are fetched from our own server, not from Hyperliquid', fetchFn.includes('/extcandles?tf='))

  // The 429 breaker exists to stop us hammering HYPERLIQUID. Letting it also block a fetch to
  // our own origin would blank DXY for the duration of a rate limit it had nothing to do with.
  t('the HL rate-limit breaker gates the coin half only',
    /_hlLimited\(\) \? \[\] : sel\.filter/.test(fetchFn))
  t('so _cmpFetch does not bail on it wholesale', !/^\s*if \(_cmpLoading \|\| _hlLimited\(\)\) return/m.test(fetchFn))

  // Two windows, two caches. The row's <sym>_1D entry is anchored at the last tick; a compare
  // series is anchored at now. One cache holding both under the same key would hand whichever
  // was written last to both readers.
  t('compare series get their own cache', CLI.includes('const _extCmpCache = {}'))
  t('and the row cache is left alone', fetchFn.includes('_extCmpCache[`${sym}_${_cmpTf}`]'))
  t('why they cannot share is written down', CLI.includes('Deliberately NOT _watchCandleCache'))

  // "Fetched and empty" and "not fetched yet" are different states and must read differently.
  t('a closed market is named rather than counted', renderFn.includes('was closed for this whole window'))
  t('and it is told apart from still loading', renderFn.includes('?.candles?.length === 0'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
