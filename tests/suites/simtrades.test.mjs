// Every trade a simulation took, not just the summary of them.
//
// A summary says a rule won 47% of the time. It cannot say whether the entries were where
// you would have taken them, or whether one outlier carried the whole number. The ledger
// behind the figures is what makes a result checkable instead of believable.
import fs from 'fs'
import { runBacktest, coerceParams } from '../../src/backtest.js'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const eng = fs.readFileSync('src/backtest.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

const rows = Array.from({ length: 24 * 12 }, (_, i) => {
  const px = 100 + Math.sin(i / 6) * 6 + i * 0.05
  return { t: Date.UTC(2026, 5, 15) + i * 3600e3, o: px, h: px + 1, l: px - 1, c: px }
})

console.log(nl + '-- a trade says what it did, not just where the balance ended --')
// Without a per-trade figure the reader has to difference a running balance by eye, and
// the first trade has nothing to difference against.
for (const s of ['tokyo', 'trend', 'breakout']) {
  const r = runBacktest(rows, coerceParams({ strategy: s, startBalance: 1000 }))
  const closed = r.trades.filter(x => x.outcome !== 'open')
  if (!closed.length) continue
  t(`${s}: every closed trade carries its delta`, closed.every(x => Number.isFinite(x.delta)),
    `${closed.filter(x => Number.isFinite(x.delta)).length}/${closed.length}`)
  t(`${s}: the deltas add up to the net result`,
    Math.abs(closed.reduce((a, x) => a + x.delta, 0) - r.netPnl) < 1e-6,
    `${closed.reduce((a, x) => a + x.delta, 0).toFixed(6)} vs ${r.netPnl.toFixed(6)}`)
  t(`${s}: a win moves the balance up and a loss down`,
    closed.every(x => x.outcome === 'win' ? x.delta > -1e-9 : x.outcome === 'loss' ? x.delta < 1e-9 : true))
}
const g = runBacktest(rows, coerceParams({ strategy: 'grid', startBalance: 1000, gridLower: 95, gridUpper: 112, gridLevels: 8 }))
t('grid cycles carry one too', g.trades.every(x => Number.isFinite(x.delta)), String(g.trades.length))

console.log(nl + '-- and the prices needed to check it --')
const one = runBacktest(rows, coerceParams({ strategy: 'tokyo', startBalance: 1000 }))
const closed = one.trades.filter(x => x.outcome !== 'open')
t('an entry price', closed.every(x => x.entry > 0))
t('an exit price', closed.every(x => x.exitPx > 0))
t('when it opened and when it closed', closed.every(x => x.time > 0 && x.exitAt > 0))
t('the exit is never before the entry', closed.every(x => x.exitAt >= x.time))
t('a side', closed.every(x => x.side === 'long' || x.side === 'short'))
t('and an unfinished trade keeps its entry but has no exit',
  one.trades.filter(x => x.outcome === 'open').every(x => x.entry > 0 && x.exitPx === null))

console.log(nl + '-- the view --')
const view = grab(cli, 'function _simTradesHtml')
t('there is a trade list', view.length > 400)
t('it is on the result panel', cli.includes('${_simTradesHtml(r)}'))
t('it starts collapsed behind a count', view.includes('Show every trade ('))
t('nothing renders when there are no trades', view.includes("if (!all.length) return ''"))
t('newest first', view.includes('[...all].reverse()'))
t('why newest first is recorded', cli.includes('the end of a run is what you are usually checking'))

console.log(nl + '-- it does not try to draw two thousand rows --')
// A fifteen-market portfolio run produces a couple of thousand trades.
t('rows are paged', view.includes('_simTradePage * _SIM_TRADES_PER_PAGE'))
t('a page is 50', cli.includes('const _SIM_TRADES_PER_PAGE = 50'))
t('there is a way to see more', cli.includes('window.__simMoreTrades'))
t('and it says how many of how many', view.includes('${shown.length} of ${ordered.length}'))
t('the button disappears at the end', view.includes('shown.length < ordered.length'))
t('a new run starts at the first page', cli.includes('_simTradePage = 1        // a new run starts'))
t('why it is paged is recorded', cli.includes('locks the phone for seconds'))

console.log(nl + '-- what each row shows --')
t('entry and exit prices', view.includes('fmtPrice(t.entry)') && view.includes('fmtPrice(t.exitPx)'))
t('an exit that never happened is a dash, not a zero', view.includes("t.exitPx != null ? fmtPrice(t.exitPx) : '—'"))
t('both timestamps', view.includes('when(t.time)') && view.includes('when(t.exitAt)'))
t('how long it was held', view.includes('t.heldFor'))
t('what it did to the balance', view.includes('money(t.delta)'))
t('a missing delta shows as a dash rather than $0', view.includes("Number.isFinite(t.delta) ? money(t.delta) : '—'"))
t('the outcome, coloured', view.includes('outCol[t.outcome]'))
t('the side, as a direction', view.includes("t.side === 'long' ? '↑' : '↓'"))
t('and the market, but only when there is more than one', view.includes('multi ?') && view.includes('r.byMarket.length > 1'))
t('the market name is escaped', view.includes('esc(_ocCoinLabel(t.coin'))
t('the note explains why the same rule pays differently later',
  cli.includes('so the same rule pays more when the balance is bigger'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
