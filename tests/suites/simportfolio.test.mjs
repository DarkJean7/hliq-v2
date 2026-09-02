// Several markets in the Trade Simulator, on one account.
//
// The mistake this exists to prevent: running a rule on ZEC and then on XMR gives two
// results that cannot be added. Each was measured against its own starting balance, so
// their percentages overlap in time and their drawdowns are not the drawdown of holding
// both. A portfolio is one balance, and the trades have to be replayed against it in the
// order they closed.
import fs from 'fs'
import { runBacktest, runPortfolio, coerceParams, BT_DEFAULTS, BT_CHOICES } from '../../src/backtest.js'

const eng = fs.readFileSync('src/backtest.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

// Three markets with different price paths, same rule.
const mk = (seed, n = 24 * 20) => Array.from({ length: n }, (_, i) => {
  const px = 100 + Math.sin((i + seed) / 7) * 8 + i * 0.02 * seed
  return { t: Date.UTC(2026, 5, 15) + i * 3600e3, o: px, h: px + 1, l: px - 1, c: px }
})
const P = coerceParams({ strategy: 'tokyo', startBalance: 1000,
  tokyoLongFrom: '07:00', tokyoLongTo: '21:00', tokyoShortFrom: '21:00', tokyoShortTo: '07:00' })
const runs = [
  { coin: 'ZEC',  result: runBacktest(mk(1), P) },
  { coin: 'XMR',  result: runBacktest(mk(2), P) },
  { coin: 'NEAR', result: runBacktest(mk(3), P) },
]
const port = runPortfolio(runs, P)

console.log(nl + '-- one account, not three --')
t('it runs', port.tradesMade > 20, String(port.tradesMade))
t('it names the markets', port.markets.join(',') === 'ZEC,XMR,NEAR', port.markets.join(','))
t('every trade is tagged with its market', port.trades.every(x => typeof x.coin === 'string' && x.coin))
t('trades are applied in the order they CLOSED',
  port.trades.every((x, i) => i === 0 || x.closedAt >= port.trades[i - 1].closedAt))
t('why closing order and not opening order is recorded',
  eng.includes('acts on the balance when it CLOSES'))
t('one balance runs through them all',
  port.trades.every((x, i) => i === 0 || Math.abs(x.balance - (port.trades[i - 1].balance + x.delta)) < 1e-9))

console.log(nl + '-- the rows add up --')
// Rows taken from separate single-market runs would each describe a different account and
// sum to something that never happened.
const rowSum = port.byMarket.reduce((a, m) => a + m.netPnl, 0)
t('per-market PnL sums to the portfolio PnL', Math.abs(rowSum - port.netPnl) < 1e-6,
  `${rowSum.toFixed(6)} vs ${port.netPnl.toFixed(6)}`)
t('per-market trade counts sum to the total',
  port.byMarket.reduce((a, m) => a + m.trades, 0) === port.tradesMade)
t('wins and losses sum too',
  port.byMarket.reduce((a, m) => a + m.won, 0) === port.won &&
  port.byMarket.reduce((a, m) => a + m.lost, 0) === port.lost)
t('the rows come from the shared run, not from each market\'s own',
  eng.includes('from the SHARED run rather than from its own'))
t('the view says so where someone will read it',
  cli.includes('so these add up to the total above'))
t('rows are ordered by what they contributed', port.byMarket[0].netPnl >= port.byMarket[1].netPnl)

console.log(nl + '-- a single market is unchanged --')
// The re-booking must be equivalent to the original walk, or every existing result moves.
const solo = runPortfolio([runs[0]], P)
t('one market through the portfolio path matches its own run',
  Math.abs(solo.netPnl - (runs[0].result.balance - P.startBalance)) < 1e-6,
  `${solo.netPnl.toFixed(6)} vs ${(runs[0].result.balance - P.startBalance).toFixed(6)}`)
t('and the app does not route a single market through it at all',
  cli.includes('runs.length === 1 && coins.length === 1'))

console.log(nl + '-- adding markets spreads the account, it does not multiply it --')
const full = runPortfolio(runs, { ...P, splitRisk: false })
t('splitting is the default', BT_DEFAULTS.splitRisk === true)
t('full risk moves the balance much further', Math.abs(full.netPnl) > Math.abs(port.netPnl) * 2,
  `${port.netPnl.toFixed(2)} split vs ${full.netPnl.toFixed(2)} full`)
t('the split is by market count', port.splitRisk === true && full.splitRisk === false)
t('it is a visible choice', BT_CHOICES.some(c => c.key === 'splitRisk'))
t('whose help explains both questions',
  /answers a different question/.test(BT_CHOICES.find(c => c.key === 'splitRisk')?.help ?? ''))
t('and says which one the deployed bot asks',
  /deployed portfolio bot does/.test(BT_CHOICES.find(c => c.key === 'splitRisk')?.help ?? ''))
t('the choice survives coercion as a boolean, not a string',
  coerceParams({ splitRisk: 'false' }).splitRisk === false &&
  coerceParams({ splitRisk: 'true' }).splitRisk === true)

console.log(nl + '-- an unfinished trade is not scored --')
t('open trades are skipped in the merge', eng.includes("if (t.outcome === 'open') continue"))
t('but still counted and reported', port.unresolved >= 0 && 'unresolved' in port)

console.log(nl + '-- the market box takes a list --')
t('it splits on commas and spaces', grab(cli, 'function _simCoinList').includes('.split(/[,\\s]+/)'))
t('duplicates collapse', grab(cli, 'function _simCoinList').includes('new Set'))
t('a builder-dex prefix survives',
  grab(cli, 'function _simResolveMarket').includes("s.split(':')[0].toLowerCase()"))
t('why it is not simply uppercased is recorded', cli.includes('"xyz:SPCX" is not "XYZ:SPCX"'))

// Every entry goes through the resolver, because "SMSN" is not a market -- "xyz:SMSN" is
// -- and it can be typed that way from the table, from Hyperliquid's own list, or by a
// list saved before the ids existed. Fixing only the "load all 15" button left all three
// broken, which is what shipped.
const resolve = grab(cli, 'function _simResolveMarket')
t('the list resolves every entry', grab(cli, 'function _simCoinList').includes('.map(_simResolveMarket)'))
t('a portfolio row supplies its own id', resolve.includes('if (row?.market) return row.market'))
t('and needs no market data loaded to do it', resolve.includes('needs no market data loaded'))
t('anything else falls back to the resolver the bot fields use',
  resolve.includes('_resolveGridCoin(up)'))
t('a full id is left alone', resolve.includes("if (s.includes(':'))"))
t('it resolves at use time rather than migrating what was saved',
  cli.includes('Resolved at USE time rather than migrated'))
t('why fixing only the button was not enough is recorded',
  cli.includes('left all three still broken, which is what shipped'))
t('the label says a list is allowed', cli.includes("_T('comma separated', 'separados por comas')"))
t('the whole Tokyo table loads in one tap', cli.includes('window.__simLoadPortfolio'))
// It loaded the table's KEYS, which are bare tickers -- so nine builder-dex markets were
// sent to the API as names it does not have, and came back as 500s in the "left out" list.
t('and loads the ids the exchange knows, not the bare keys',
  cli.includes('_simCoin = tokyoMarkets().join') && !cli.includes('_simCoin = Object.keys(BT_TOKYO_TABLE)'))
t('a 500 is translated into something actionable',
  cli.includes('no such market — a builder-dex market needs its prefix'))

console.log(nl + '-- each market runs its own Tokyo windows --')
// Running ZEC's hours against XMR is not a portfolio, it is the same rule fifteen times.
const runBlock = grab(cli, 'window.__simRun = async function')
t('windows are looked up per market', runBlock.includes('const row = tokyoWindowsFor(coin)'))
t('and applied to that market only', runBlock.includes('par = { ..._simParams, tokyoLongFrom: row.long[0]'))
t('why is recorded', cli.includes('it is the same rule fifteen times'))
t('a market with no row is skipped, not run on the wrong hours',
  runBlock.includes("skipped.push(coin + ' (not in the portfolio table)')"))
t('the form warns before the run, too', cli.includes('each one uses ITS OWN row'))

console.log(nl + '-- fetching many markets does not trip the limiter --')
// Fifteen candleSnapshot calls in one burst is the shape that gets rate-limited, and a
// limited run reports "not enough history" for markets that have plenty.
t('the fetch is pooled', runBlock.includes('await hlPool(coins,') && runBlock.includes('}, 3)'))
t('why is recorded', cli.includes('is exactly the shape that trips the per-IP limiter'))
t('results are put back in the order typed', runBlock.includes('runs.sort((a, b) => coins.indexOf(a.coin) - coins.indexOf(b.coin))'))
t('a market that could not be fetched is named, not silently dropped',
  runBlock.includes('_simSkipped = skipped') && cli.includes("_T('Left out: ', 'Omitidos: ')"))
t('and nothing runnable at all is an error, not an empty result',
  runBlock.includes("_T('Nothing could be simulated: '"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
