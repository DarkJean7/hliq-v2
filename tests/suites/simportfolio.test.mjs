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
// The simulator's screen moved to src/simulator.js; the one helper it shares with the bot
// cards stayed in main.js. The assertions are about the app, so they read both.
const cli = ['src/main.js', 'src/simulator.js'].map(p => fs.readFileSync(p, 'utf8')).join('\n').replace(/\r\n/g, '\n')

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
  grab(cli, 'function _resolveMarketId').includes("s.split(':')[0].toLowerCase()"))
// Nobody types the prefix any more, but a market id still carries it and the fetch needs it.
t('the prefix survives in the id even though it is never shown', grab(cli, 'function _mktName').includes(".replace(/^.*:/, '')") &&
  grab(cli, 'function _resolveMarketId').includes("s.split(':')[0].toLowerCase()"))

// Every entry goes through the resolver, because "SMSN" is not a market -- "xyz:SMSN" is
// -- and it can be typed that way from the table, from Hyperliquid's own list, or by a
// list saved before the ids existed. Fixing only the "load all 15" button left all three
// broken, which is what shipped.
const resolve = grab(cli, 'function _resolveMarketId')
t('the list resolves every entry', grab(cli, 'function _simCoinList').includes('.map(_resolveMarketId)'))
t('and the resolver is shared with the bot card, not copied',
  cli.includes("Shared by the Trade Simulator's") && cli.includes('_resolveMarketId(part)'))
t('a portfolio row supplies its own id', resolve.includes('if (row?.market) return row.market'))
t('and needs no market data loaded to do it', resolve.includes('needs no market data loaded'))
t('anything else falls back to the resolver the bot fields use',
  resolve.includes('_resolveGridCoin(up)'))
t('a full id is left alone', resolve.includes("if (s.includes(':'))"))
t('it resolves at use time rather than migrating what was saved',
  cli.includes('Resolved at USE time rather than migrated'))
t('why fixing only the button was not enough is recorded',
  cli.includes('left all three still broken, which is what shipped'))
// The box took a comma-separated list; the picker takes one market at a time, as many times
// as you like, and the list is still stored and resolved the same way.
t('several markets can be chosen', cli.includes('const next = list.includes(id) ? list.filter(c => c !== id) : [...list, id]'))
t('the whole Tokyo table loads in one tap', cli.includes('window.__simLoadPortfolio'))
// It loaded the table's KEYS, which are bare tickers -- so nine builder-dex markets were
// sent to the API as names it does not have, and came back as 500s in the "left out" list.
t('and loads the ids the exchange knows, not the bare keys',
  cli.includes('_simCoin = tokyoMarkets().join') && !cli.includes('_simCoin = Object.keys(BT_TOKYO_TABLE)'))
// It used to tell you to type the dex prefix. Nobody types the prefix now -- the search
// finds the market by name -- so a 500 simply means the market is not there.
t('a 500 is translated into something actionable',
  cli.includes("_T(' (no such market on Hyperliquid)'") && !cli.includes('needs its prefix'))

console.log(nl + '-- each market runs its own Tokyo windows --')
// Running ZEC's hours against XMR is not a portfolio, it is the same rule fifteen times.
// Run, Compare and Sweep all go through the same three steps now -- load the candles, pick
// each market's parameters, run -- so the assertions follow those steps, not one caller.
const runBlock = grab(cli, 'window.__simRun = async function')
const paramsFor = grab(cli, 'function _simParamsFor')
const runOn = grab(cli, 'function _simRunOn')
const loadBlock = grab(cli, 'async function _simLoad')
t('windows are looked up per market', paramsFor.includes('const row = tokyoWindowsFor(coin)'))
// The per-market parameters now also carry that market's max leverage, so the windows are laid
// over those rather than over the shared ones.
t('and applied to that market only', paramsFor.includes('return { ...withLev, tokyoLongFrom: row.long[0]'))
t('every market carries its own max leverage', paramsFor.includes('maxLev: _simMaxLev(coin) ?? 20'))
t('every run goes through it', runOn.includes('const par = _simParamsFor(coin, params)'))
t('why is recorded', cli.includes('it is the same rule fifteen times'))
t('a market with no row is skipped, not run on the wrong hours',
  runOn.includes("skipped?.push(_mktName(coin) + ' (not in the portfolio table)')"))
t('the form warns before the run, too', cli.includes('each one uses ITS OWN row'))

console.log(nl + '-- fetching many markets does not trip the limiter --')
// Fifteen candleSnapshot calls in one burst is the shape that gets rate-limited, and a
// limited run reports "not enough history" for markets that have plenty.
t('the fetch is pooled', loadBlock.includes('await hlPool(coins,') && loadBlock.includes('}, 3)'))
// Comparing twelve strategies must not mean twelve fetches per market.
t('and cached, so a comparison or sweep fetches each market once',
  loadBlock.includes('_simCache.get(key)') && loadBlock.includes('_simCache.set(key,'))
t('why is recorded', cli.includes('is exactly the shape that trips the per-IP limiter'))
// hlPool resolves out of order, so the runs used to be sorted back afterwards. They are now
// run after the fetch, walking the typed list, so they are in that order to begin with.
t('results are in the order typed', runOn.includes('for (const coin of coins)') && !runOn.includes('hlPool'))
t('a market that could not be fetched is named, not silently dropped',
  runBlock.includes('_simSkipped = skipped') && cli.includes("_T('Left out: ', 'Omitidos: ')"))
t('and nothing runnable at all is an error, not an empty result',
  runBlock.includes("_T('Nothing could be simulated: '"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
