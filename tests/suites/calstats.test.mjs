// Calendar month summary: which days count, what the best and worst of them are, and the
// average and volume over them.
import fs from 'fs'
const src = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- volume is counted apart from PnL --')
// byDay only holds days that CLOSED something, and best/worst/green/red all read it.
// Folding volume in would add zero-PnL days to monthKeys and quietly change what
// "best day" means when every closing day was negative.
t('volume has its own map', src.includes('const volByDay = {}'))
t('it is not written into byDay', !/volByDay\[key\][^\n]*byDay\[key\]/.test(src))
t('every fill counts, not just closing ones',
  src.slice(src.indexOf('const volByDay')).slice(0, 500).includes('for (const f of fills) {') &&
  !src.slice(src.indexOf('const volByDay')).slice(0, 500).includes('closedPnl === 0'))
t('a supplied notional wins over recomputing', src.includes('Number(f.notional ?? 0) || (sz * (parseFloat(f.px) || 0))'))
t('size is absolute, so a sell adds volume', src.includes('Math.abs(parseFloat(f.sz) || 0)'))
t('why it is separate is written down', src.includes('would change what those mean'))

const vol = new Function('fills', `
  const volByDay = {}
  for (const f of fills) {
    const sz  = Math.abs(parseFloat(f.sz) || 0)
    const ntl = Number(f.notional ?? 0) || (sz * (parseFloat(f.px) || 0))
    if (!ntl) continue
    const d   = new Date(f.time)
    const key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
    volByDay[key] = (volByDay[key] || 0) + ntl
  }
  return volByDay`)

const T = (day, o) => ({ time: new Date(2026, 7, day, 12).getTime(), ...o })
const v = vol([
  T(3, { sz: '2', px: '100', closedPnl: 0 }),      // an OPEN: no PnL, still volume
  T(3, { sz: '2', px: '110', closedPnl: 20 }),     // the close
  T(4, { sz: '-1', px: '50' }),                    // a sell, negative size
  T(5, { sz: '1', px: '9', notional: 999 }),       // notional supplied
])
t('an opening fill contributes volume', v['2026-08-03'] === 420)
t('a sell counts as volume, not against it', v['2026-08-04'] === 50)
t('a supplied notional is used verbatim', v['2026-08-05'] === 999)
t('a zero-value fill is skipped rather than becoming NaN',
  Object.keys(vol([T(6, { sz: '0', px: '10' })])).length === 0)
t('junk does not produce NaN', Object.keys(vol([T(6, { sz: 'x', px: 'y' })])).length === 0)

console.log(String.fromCharCode(10) + '-- the month total picks its own month --')
t('the month is filtered by year AND month', src.includes('return (y === year && m === month + 1) ? s + volByDay[k] : s'))
t('and rendered compactly', src.includes("'$' + fmtCompact(monthVolume)"))
t('zero volume reads as $0, not a dash', src.includes("monthVolume > 0 ? '$' + fmtCompact(monthVolume) : '$0'"))

console.log(String.fromCharCode(10) + '-- the average is per day ELAPSED, not per day traded --')
// Reported: "avg. trading day pnl is also missing to calculate that day and the current".
// $1,053.19 across eleven trading days read as $95.74/day while the month was thirteen days
// old — a rate the account did not earn. A flat day is part of how the month went.
t('the denominator is the days that have happened', src.includes('const elapsedDays = elapsedKeys.length'))
t('and it is null, not zero, when the month has not started', src.includes('elapsedDays > 0 ? monthPnl / elapsedDays : null'))
t('the card no longer claims to be per TRADING day', src.includes('<div class="stat-label">Avg / Day</div>'))
t('days that traded are still counted, for Trades Made', src.includes('const tradedDays  = tradedKeys.length') &&
  src.includes('const tradedKeys = monthKeys.filter(k => byDay[k].trades > 0)'))
t('and that card is the one that still says "over N days" of trading',
  src.includes('${monthFills}') && src.includes('over ${tradedDays} day'))
t('the Green / Red Days card is gone', !src.includes('Green / Red Days'))
t('and nothing still counts green and red separately',
  !src.includes('greenDays') && !src.includes('redDays'))
t('no-trade months render a dash', src.includes("avgDayPnl == null ? '—'"))
t('the sign is explicit', src.includes("(avgDayPnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(avgDayPnl))"))
t('the colour follows the sign', src.includes("avgDayPnl == null ? 'neu' : avgDayPnl >= 0 ? 'pos' : 'neg'"))
t('the day count is shown so the figure can be checked', src.includes('over ${elapsedDays} day'))
t('and pluralised', src.includes("elapsedDays !== 1 ? 's' : ''"))
t('why the rest of the month is not counted is recorded', src.includes('Tomorrow has not happened'))

const avg = new Function('monthPnl', 'elapsedDays', `
  return elapsedDays > 0 ? monthPnl / elapsedDays : null`)
t('121.35 over 8 days is 15.17', Math.abs(avg(121.35, 8) - 15.16875) < 1e-6)
t('a losing month averages negative', avg(-100, 5) === -20)
t('a month that has not begun is null', avg(0, 0) === null)
// The reported figures, end to end.
t('the reported month averages 81.01, not 95.74', Math.abs(avg(1053.19, 13) - 81.0146) < 1e-3)

console.log(String.fromCharCode(10) + '-- every day that HAPPENED is a day, traded or not --')
// Reported: "the current worst day now should be day 12 which did not did a trade or profit
// so it should be $0 not +13.56". Best and Worst used to run over the days that traded, so a
// quiet day could not win either — the month's worst day was the smallest PROFIT rather than
// the day nothing came in. A flat day is a $0 day, not a missing one.
const day = (pnl, trades = 1, deposited = 0) => ({ pnl, trades, deposited, withdrawn: 0 })
const SEP = (d) => '2026-09-' + String(d).padStart(2, '0')
const at  = (y, m, d) => new Date(y, m, d, 12).getTime()

// Mirrors the source: the elapsed window, the $0 default, the two reduces and the three
// renderers. Each line is pinned to src by an assertion below, so a divergence shows up.
const pick = new Function('byDay', 'year', 'month', 'earliest', 'nowTs', `
  const firstDay  = new Date(year, month, 1)
  const lastDay   = new Date(year, month + 1, 0)
  const monthKeys = Object.keys(byDay).filter(k => {
    const [y, m] = k.split('-').map(Number)
    return y === year && m === month + 1
  })
  const monthPnl   = monthKeys.reduce((s, k) => s + byDay[k].pnl, 0)
  const tradedKeys = monthKeys.filter(k => byDay[k].trades > 0)
  const dayKeyOf   = (d) => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0')
  const midnightOf = (ts) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d }
  const elapsedKeys = []
  if (Number.isFinite(earliest)) {
    const histStart = midnightOf(earliest)
    const from  = histStart > firstDay ? histStart : firstDay
    const today = midnightOf(nowTs)
    const to    = today < lastDay ? today : lastDay
    for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) elapsedKeys.push(dayKeyOf(d))
  }
  const pnlOf    = (k) => byDay[k]?.pnl ?? 0
  const bestDay  = elapsedKeys.reduce((b, k) => pnlOf(k) > pnlOf(b) ? k : b, elapsedKeys[0])
  const worstDay = elapsedKeys.reduce((w, k) => pnlOf(k) < pnlOf(w) ? k : w, elapsedKeys[0])
  const amt = (key) => {
    if (!key) return '—'
    const v = pnlOf(key)
    return (v > 0 ? '+$' : v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2)
  }
  const cls = (key) => { const v = key ? pnlOf(key) : 0; return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu' }
  const sub = (key) => !key ? '' : key + (byDay[key]?.trades > 0 ? '' : ' \\u00b7 no trades')
  return { bestDay, worstDay, best: amt(bestDay), worst: amt(worstDay),
           bestCls: cls(bestDay), worstCls: cls(worstDay), worstSub: sub(worstDay),
           elapsedDays: elapsedKeys.length, tradedDays: tradedKeys.length,
           avg: elapsedKeys.length ? monthPnl / elapsedKeys.length : null }`)

{
  // THE REPORTED MONTH. Eleven traded days, day 12 quiet, day 13 is today and has not traded.
  // The reported figures: $1,053.19 over eleven days, best $160.97 on the 11th, and $13.56
  // on the 7th — which was being shown as the worst day.
  const byDay = {}
  const pnls = [103.60, 94.29, 125.40, 95.08, 88.22, 127.30, 13.56, 35.01, 107.44, 102.32, 160.97]
  pnls.forEach((v, i) => { byDay[SEP(i + 1)] = day(v, 20) })
  const r = pick(byDay, 2026, 8, at(2026, 8, 1), at(2026, 8, 13))
  t('the fixture is the reported month', Math.abs(pnls.reduce((s, x) => s + x, 0) - 1053.19) < 1e-9)
  t('the worst day is the quiet one, not the smallest profit', r.worstDay === SEP(12), r)
  t('and it reads $0.00', r.worst === '$0.00', r)
  t('neutral, because nothing happened', r.worstCls === 'neu', r)
  t('captioned so the blank cell in the grid is explained', r.worstSub.endsWith('· no trades'), r)
  t('the best day is still the best traded day', r.bestDay === SEP(11) && r.best === '+$160.97', r)
  t('thirteen days have happened, not eleven', r.elapsedDays === 13 && r.tradedDays === 11, r)
  t('so the average is 81.01, not the 95.74 it showed', Math.abs(r.avg - 81.0146) < 0.01, r.avg)
}
{
  // Tomorrow is not a $0 day. Counting the whole month would shrink the average every day.
  const r = pick({ [SEP(1)]: day(300, 4) }, 2026, 8, at(2026, 8, 1), at(2026, 8, 3))
  t('the rest of the month is not counted', r.elapsedDays === 3, r)
  t('and the average is over what has happened', r.avg === 100, r)
  t('a future day cannot be the worst day', r.worstDay === SEP(2), r)
}
{
  // A month that began before the account did must not open with $0 days nobody lived through.
  const r = pick({ [SEP(7)]: day(50, 2), [SEP(9)]: day(-20, 3) },
    2026, 8, at(2026, 8, 7), at(2026, 8, 10))
  t('the window starts at the first day of history', r.elapsedDays === 4, r)
  t('so days before the account existed are not $0 days', r.worstDay === SEP(9), r)
  t('and the average divides by four, not ten', Math.abs(r.avg - 7.5) < 1e-9, r)
}
{
  // A whole past month counts to its last day, not to today.
  const byDay = { '2026-08-04': day(-40, 2), '2026-08-20': day(10, 1) }
  const r = pick(byDay, 2026, 7, at(2026, 7, 1), at(2026, 8, 13))
  t('a past month counts every one of its days', r.elapsedDays === 31, r)
  t('the worst day is still the losing one', r.worstDay === '2026-08-04' && r.worst === '-$40.00', r)
}
{
  // Consistency: if every trading day lost, the best day is the day you did not trade.
  const r = pick({ [SEP(1)]: day(-5, 1), [SEP(2)]: day(-120.5, 2) },
    2026, 8, at(2026, 8, 1), at(2026, 8, 3))
  t('a flat day can be the BEST day in a losing month', r.bestDay === SEP(3) && r.best === '$0.00', r)
  t('worst is still the deeper loss', r.worst === '-$120.50' && r.worstCls === 'neg', r)
}
{
  // A deposit is not a trading result, but the day it happened is still a $0 day like any
  // other quiet day — the distinction the caption carries.
  const r = pick({ [SEP(1)]: day(0, 0, 5000), [SEP(2)]: day(25, 3) },
    2026, 8, at(2026, 8, 1), at(2026, 8, 2))
  t('a deposit-only day is a $0 day', r.worstDay === SEP(1) && r.worst === '$0.00', r)
  t('and is captioned as untraded', r.worstSub.endsWith('· no trades'), r)
  t('it does not count as a trading day', r.tradedDays === 1, r)
}
{
  // Ties go to the earliest, both ways, so the cards do not swap day on an unrelated repaint.
  const r = pick({ [SEP(2)]: day(10, 1) }, 2026, 8, at(2026, 8, 1), at(2026, 8, 4))
  t('the first of several equal days wins', r.worstDay === SEP(1), r)
}
{
  const future = pick({}, 2026, 11, at(2026, 8, 1), at(2026, 8, 13))
  t('a month that has not happened has no days', future.elapsedDays === 0, future)
  t('and renders a dash rather than $0', future.best === '—' && future.worst === '—', future)
  t('with a null average', future.avg === null, future)
  const before = pick({}, 2025, 0, at(2026, 8, 1), at(2026, 8, 13))
  t('a month before the account existed is empty too', before.elapsedDays === 0, before)
  const noHistory = pick({}, 2026, 8, Infinity, at(2026, 8, 13))
  t('and an account with no history at all is not a crash', noHistory.worst === '—', noHistory)
}

// Pin the harness to the source it mirrors.
t('the elapsed window is bounded by history at the start',
  src.includes('const from  = histStart > firstDay ? histStart : firstDay'))
t('and by today at the end', src.includes('const to    = today < lastDay ? today : lastDay'))
t('history counts ledger entries, not just fills',
  src.includes('const earliest = [...fills, ...ledger].reduce((m, x) => (x?.time < m ? x.time : m), Infinity)'))
t('the walk is day by day', src.includes('for (const d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) elapsedKeys.push(dayKeyOf(d))'))
t('a day with no entry is worth $0', src.includes('const pnlOf      = (k) => byDay[k]?.pnl ?? 0'))
t('best and worst both read it',
  src.includes('elapsedKeys.reduce((b, k) => pnlOf(k) > pnlOf(b) ? k : b, elapsedKeys[0])') &&
  src.includes('elapsedKeys.reduce((w, k) => pnlOf(k) < pnlOf(w) ? k : w, elapsedKeys[0])'))
t('the renderer is sign-aware', src.includes("(v > 0 ? '+$' : v < 0 ? '-$' : '$') + fmtUSD(Math.abs(v))"))
t('and colour-aware', src.includes("return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu'"))
t('an untraded winner says so', src.includes("(byDay[key]?.trades > 0 ? '' : ' · no trades')"))
t('both cards use the caption', src.includes('${daySub(bestDay)}') && src.includes('${daySub(worstDay)}'))
t('the worst day is not gated on being negative', !src.includes('byDay[worstDay].pnl < 0'))
t('why a quiet day counts is written down', src.includes('A day you did not trade is a $0 day, not a missing one'))

console.log(String.fromCharCode(10) + '-- both cards are in the summary --')
const sum = src.slice(src.indexOf('<div class="cal-summary">'), src.indexOf('<div style="overflow-x:auto'))
t('Avg / Day is a card', sum.includes('>Avg / Day<'))
t('Month Volume is a card', sum.includes('Month Volume'))
t('the existing five are untouched',
  ['Month PnL', 'Best Day', 'Worst Day', 'Deposited', 'Withdrawn'].every(l => sum.includes(l)))
t('Max Drawdown is a card', sum.includes('Max Drawdown'))
t('Trades Made is a card', sum.includes('Trades Made'))
// Was eight, then ten when the worst peak-to-trough run and the fill count joined; nine now
// that Green / Red Days has been removed — it restated what Best and Worst Day already show,
// and its denominator was the only reason the two were counted apart. The count is asserted
// so a card cannot be dropped in a refactor without this going red.
t('there are nine cards now', (sum.match(/class="stat-card"/g) || []).length === 9)
t('drawdown is a RUN, not the worst single day',
  src.includes('ddPeak - ddRun') && src.includes('This is the run'))
t('and it is the month PnL curve, not account equity, and says so',
  src.includes('not of account equity'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
