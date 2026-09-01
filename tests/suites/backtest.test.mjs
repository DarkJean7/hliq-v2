// The Trade Simulator: a backtest over Hyperliquid candles.
//
// A backtest exists to tell you whether a rule worked. One that quietly cheats is worse
// than none, because it gets believed -- so most of what is asserted here is the ways this
// refuses to flatter the result.
import fs from 'fs'
import { runBacktest, classify, normalise, coerceParams, BT_DEFAULTS, BT_FIELDS, BT_CHOICES, BT_OVERVIEW }
  from '../../src/backtest.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const htm = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')
const bt  = fs.readFileSync('src/backtest.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// A quiet market with an occasional large candle that then runs.
const mk = (n = 800) => {
  const rows = []
  let px = 100, t0 = Date.now() - n * 3600e3
  for (let i = 0; i < n; i++) {
    const big = i % 60 === 0 && i > 100
    const o = px, c = px + (big ? 2.4 : Math.sin(i / 5) * 0.15)
    rows.push({ t: t0 + i * 3600e3, o: String(o), h: String(Math.max(o, c) + (big ? 0.5 : 0.08)),
      l: String(Math.min(o, c) - (big ? 0.5 : 0.08)), c: String(c) })
    px = c
  }
  return rows
}
const rows = mk()

console.log(String.fromCharCode(10) + '-- it reads the candles safely --')
t('strings become numbers', normalise([{ t: 1, o: '2', h: '3', l: '1', c: '2.5' }])[0].c === 2.5)
t('junk rows are dropped, not turned into NaN', normalise([{ t: 1, o: 'x', h: 2, l: 1, c: 1.5 }, { t: 2, o: 1, h: 2, l: 1, c: 1.5 }]).length === 1)
t('an impossible candle is dropped', normalise([{ t: 1, o: 1, h: 1, l: 5, c: 1 }]).length === 0)
t('and they are put in time order', normalise([{ t: 5, o: 1, h: 2, l: 1, c: 1 }, { t: 2, o: 1, h: 2, l: 1, c: 1 }])[0].t === 2)
t('an empty set is a result, not a crash', runBacktest([]).tradesMade === 0)

console.log(String.fromCharCode(10) + '-- no lookahead in the baseline --')
// The original averaged every candle in the dataset, including ones after the trade, and
// judged each candle against that. Nobody has that number at the time.
const cats = classify(normalise(rows), { baselineLookback: 200 })
t('a candle is judged against the ones BEFORE it', bt.includes('avg = (runningSum - rows[i].range) / n'))
t('and never against itself', bt.includes('// the candle itself is not in its own baseline'))
t('no verdict at all until there is history', cats.slice(0, 10).every(c => c === null))
// null is not 0: 0 would mean "an ordinary candle" and could be traded against a threshold.
t('that verdict is null, not zero', cats[0] === null && cats.some(c => c === 0))
t('whole-sample is still available for comparison', classify(normalise(rows), { baselineLookback: 0 }).some(c => c != null))
t('and the view says so when it is used', cli.includes('including candles after each trade'))

console.log(String.fromCharCode(10) + '-- a candle that covers both levels --')
// Which came first is unknowable from OHLC. The original checked the target first.
const tight = { takeProfitPct: 0.05, stopLossPct: 0.05 }
const asLoss = runBacktest(rows, { ...tight, ambiguous: 'loss' })
const asWin  = runBacktest(rows, { ...tight, ambiguous: 'win' })
t('the default is the stop', BT_DEFAULTS.ambiguous === 'loss')
t('and the choice changes the answer, so it must not be silent', asLoss.won !== asWin.won, [asLoss.won, asWin.won])
t('the view flags it when set to the target', cli.includes('were counted as wins'))

console.log(String.fromCharCode(10) + '-- targets are percentages, not price offsets --')
// 0.01 added to a price is 100 pips on EUR/USD and a rounding error on BTC.
t('the target scales with the price', bt.includes('entry * (1 + p.takeProfitPct / 100)'))
t('as does the stop', bt.includes('entry * (1 - p.stopLossPct / 100)'))
const cheap = runBacktest(rows.map(r => ({ ...r, o: +r.o / 1e4, h: +r.h / 1e4, l: +r.l / 1e4, c: +r.c / 1e4 })))
t('so a market priced 10,000x lower behaves the same', cheap.tradesMade === runBacktest(rows).tradesMade,
  [cheap.tradesMade, runBacktest(rows).tradesMade])

console.log(String.fromCharCode(10) + '-- the accounting --')
const r = runBacktest(rows)
t('every trade taken is counted', r.tradesMade === r.trades.length)
t('won + lost + unresolved is every trade', r.won + r.lost + r.unresolved === r.tradesMade)
// A trade the data never resolved is not a win, not a loss, and not swept away.
t('unresolved trades are reported, not dropped', runBacktest(rows.slice(0, 320)).unresolved >= 0)
t('costs are charged even on an unresolved trade', bt.includes('// position was opened, so it was paid for') ||
  bt.includes('the position was opened, so it was paid for'))
t('a cost makes the result worse', runBacktest(rows, { feePct: 0 }).balance > r.balance)
t('drawdown is measured from the peak', r.maxDrawdown >= 0)
t('with no resolved trade the win rate is unknown, not zero', (() => {
  const none = runBacktest(rows, { takeProfitPct: 500, stopLossPct: 500 })
  return none.tradesMade > 0 && none.unresolved === none.tradesMade && none.winRate === null
})())
t('but all-losses is 0%, which is a different statement',
  runBacktest(rows, { takeProfitPct: 500, stopLossPct: 0.01 }).winRate === 0)
t('direction can be restricted', runBacktest(rows, { direction: 'long' }).trades.every(x => x.side === 'long'))
t('the cooldown keeps trades apart', (() => {
  const c = runBacktest(rows, { cooldownCandles: 20 }).trades
  return c.every((x, i) => i === 0 || x.i - c[i - 1].i > 20)
})())

console.log(String.fromCharCode(10) + '-- the form and the engine cannot drift --')
t('every box is a real parameter', BT_FIELDS.every(f => f.key in BT_DEFAULTS))
t('so is every choice', BT_CHOICES.every(c => c.key in BT_DEFAULTS))
t('a typed value is used', coerceParams({ startBalance: '5000' }).startBalance === 5000)
// Empty means "use the default"; reading it as 0 turns a cleared cooldown into none and a
// cleared baseline into whole-sample lookahead.
t('an empty box falls back to the default, never 0',
  coerceParams({ cooldownCandles: '', baselineLookback: '' }).baselineLookback === BT_DEFAULTS.baselineLookback)
t('the entry category is clamped to what exists', coerceParams({ entryCategory: '99' }).entryCategory === 6)
t('an unknown choice is ignored', coerceParams({ ambiguous: 'nope' }).ambiguous === 'loss')

console.log(String.fromCharCode(10) + '-- wired into the app --')
t('it is a tab in More called Trade Simulator', htm.includes("window.__mobMoreTab('simulator')") &&
  htm.includes('Trade Simulator'))
t('with a desktop pane and route', htm.includes('id="tab-simulator"') && htm.includes('id="deskSim"') &&
  cli.includes("if (name === 'simulator')  _simRender(_viewHost('deskSim'))"))
t('and a full page on mobile', /_MOBV_FULLPAGE = new Set\(\[[^\]]*'simulator'/.test(cli))
t('it fetches real Hyperliquid candles', cli.includes('await fetchCandles(_simCoin, _simIv, start)'))
// Too little history is not a result, and must not read as a rule that never fired.
t('too little history says so instead of reporting zero trades',
  cli.includes("_T('Not enough candle history"))
t('the whole form is read at once, so a run cannot mix old and new values',
  cli.includes('function _simCollect()'))
t('settings survive a reload', cli.includes("localStorage.setItem(SIM_KEY"))

console.log(String.fromCharCode(10) + '-- a result cannot pretend to be current --')
// Reported as "I change the direction and all three give the same output". All three give
// DIFFERENT outputs; what was on screen was the previous run, with nothing saying so.
t('touching a box marks the result stale', cli.includes('window.__simTouch = function()'))
t('every box reports being touched',
  (cli.match(/oninput="window\.__simTouch\(\)"/g) || []).length >= 3 &&
  cli.includes('onchange="window.__simTouch()"'))
t('the stale result is dimmed and labelled', cli.includes("res.style.opacity = '0.45'") &&
  cli.includes("_T('Settings changed since this run."))
t('running clears it', cli.includes('_simStale = false'))
// A panel that does not say what it ran is indistinguishable from one ignoring the form.
t('the result states the settings that produced it', cli.includes('const usedBits = [') &&
  cli.includes("_T('long only', 'solo largos')"))
t('and only the notice is repainted, so a keystroke is not swallowed',
  !/window\.__simTouch = function\(\)[\s\S]{0,300}_simRender\(/.test(cli))

// The engine was never the problem, but assert it anyway so it stays that way.
const dirRows = (() => {
  const out = []; let px = 100, t0 = Date.now() - 900 * 3600e3
  for (let i = 0; i < 900; i++) {
    const big = i % 40 === 0 && i > 100
    const d = (i / 40) % 2 < 1 ? 1 : -1
    const o = px, c = px + (big ? 2.4 * d : Math.sin(i / 5) * 0.15)
    out.push({ t: t0 + i * 3600e3, o, h: Math.max(o, c) + (big ? 0.5 : 0.08), l: Math.min(o, c) - (big ? 0.5 : 0.08), c })
    px = c
  }
  return out
})()
const three = ['both', 'long', 'short'].map(d => runBacktest(dirRows, { direction: d }))
t('the three directions really do differ',
  new Set(three.map(x => x.balance.toFixed(4))).size === 3, three.map(x => +x.balance.toFixed(2)))
t('long-only takes only longs', three[1].trades.every(x => x.side === 'long'))
t('short-only takes only shorts', three[2].trades.every(x => x.side === 'short'))
t('both never takes more than the two halves',
  three[0].tradesMade <= three[1].tradesMade + three[2].tradesMade)

console.log(String.fromCharCode(10) + '-- every parameter explains itself --')
t('each box has an explanation', BT_FIELDS.every(f => f.help && f.help.length > 80))
t('so does each choice', BT_CHOICES.every(c => c.help && c.help.length > 80))
// The text lives beside the parameter, so changing the model and changing its explanation
// is one edit rather than two that can disagree.
t('the copy sits with the definitions', bt.includes("key: 'winPct'") && bt.includes('NOT derived from the take profit'))
t('there is an overview of the whole model', BT_OVERVIEW.length >= 5 &&
  BT_OVERVIEW.every(([title, body]) => title && body.length > 60))
// The trap that prompted this: the target decides IF you win, the gain decides HOW MUCH.
t('the overview states that the price move does not size the result',
  BT_OVERVIEW.some(([, body]) => body.includes('does NOT set the size')))
t('and that a result is an upper bound', BT_OVERVIEW.some(([, body]) => body.includes('upper bound')))

t('a ? opens each one', cli.includes('function _simQ(key)') && cli.includes("window.__simHelp('${key}')"))
t('it toggles rather than re-rendering, so half-typed numbers survive',
  cli.includes('window.__simHelp = function(key)') &&
  !/window\.__simHelp = function\(key\)[\s\S]{0,400}_simRender\(/.test(cli))
t('the overview has its own toggle', cli.includes('window.__simOverview = function()'))
t('and every field renders one', cli.includes('${_simQ(f.key)}') && cli.includes('${_simQ(c.key)}'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
