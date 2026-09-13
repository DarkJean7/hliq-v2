// Calendar month summary: average PnL per trading day, and traded volume.
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

console.log(String.fromCharCode(10) + '-- the average is per TRADING day --')
// Dividing by the calendar would report a number no day resembles, and would shrink
// purely because a month is longer.
// Was green + red days counted separately, which existed only to feed the Green / Red Days
// card. That card is gone and the denominator is now the one population the whole summary
// uses: days that traded.
t('the denominator is the days that traded', src.includes('const tradedDays = tradedKeys.length'))
t('and a trading day is one with fills, not one with a non-zero result',
  src.includes('const tradedKeys = monthKeys.filter(k => byDay[k].trades > 0)'))
t('the Green / Red Days card is gone', !src.includes('Green / Red Days'))
t('and nothing still counts green and red separately',
  !src.includes('greenDays') && !src.includes('redDays'))
t('and it is null, not zero, when nothing traded', src.includes('tradedDays > 0 ? monthPnl / tradedDays : null'))
t('no-trade months render a dash', src.includes("avgDayPnl == null ? '—'"))
t('the sign is explicit', src.includes("(avgDayPnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(avgDayPnl))"))
t('the colour follows the sign', src.includes("avgDayPnl == null ? 'neu' : avgDayPnl >= 0 ? 'pos' : 'neg'"))
t('the day count is shown so the figure can be checked', src.includes('over ${tradedDays} day'))
t('and pluralised', src.includes("tradedDays !== 1 ? 's' : ''"))
t('why the calendar is not the denominator is recorded', src.includes('report a number no day resembles'))

const avg = new Function('monthPnl', 'tradedDays', `
  return tradedDays > 0 ? monthPnl / tradedDays : null`)
t('121.35 over 8 days is 15.17', Math.abs(avg(121.35, 8) - 15.16875) < 1e-6)
t('a losing month averages negative', avg(-100, 5) === -20)
t('a month with no trades is null', avg(0, 0) === null)

console.log(String.fromCharCode(10) + '-- best and worst day are the best and worst day --')
// Reported: eleven green days, zero red, and Worst Day showed a dash. It rendered only when
// the day was negative, so a month that never lost money reported no worst day at all —
// "make worst day be the less profitable day, it can be positive or 0, and of course
// negative". The same hardcoded sign sat on Best Day, which would have printed '+$-160.97'
// for a month where every day lost.
const day = (pnl, trades = 1, deposited = 0) => ({ pnl, trades, deposited, withdrawn: 0 })
const pick = new Function('byDay', `
  const monthKeys  = Object.keys(byDay)
  const tradedKeys = monthKeys.filter(k => byDay[k].trades > 0)
  const bestDay    = tradedKeys.reduce((b, k) => byDay[k].pnl > (byDay[b]?.pnl ?? -Infinity) ? k : b, tradedKeys[0])
  const worstDay   = tradedKeys.reduce((w, k) => byDay[k].pnl < (byDay[w]?.pnl ?? Infinity) ? k : w, tradedKeys[0])
  const amt = (key) => {
    if (!key) return '—'
    const v = byDay[key].pnl
    return (v > 0 ? '+$' : v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2)
  }
  const cls = (key) => { const v = key ? byDay[key].pnl : 0; return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu' }
  return { bestDay, worstDay, best: amt(bestDay), worst: amt(worstDay),
           bestCls: cls(bestDay), worstCls: cls(worstDay), tradedDays: tradedKeys.length }`)

{
  // The reported month: every day green.
  const r = pick({ '2026-09-09': day(160.97), '2026-09-10': day(12.40), '2026-09-11': day(95.02) })
  t('an all-green month still has a worst day', r.worstDay === '2026-09-10', r)
  t('and it reads as the positive number it is', r.worst === '+$12.40', r)
  t('coloured green, because it made money', r.worstCls === 'pos', r)
  t('best day is unaffected', r.best === '+$160.97' && r.bestCls === 'pos', r)
}
{
  // The mirror case, which would have printed '+$-5.00' before.
  const r = pick({ '2026-09-01': day(-5), '2026-09-02': day(-120.5) })
  t('an all-red month prints Best Day with a minus, not a plus', r.best === '-$5.00', r)
  t('and colours it red', r.bestCls === 'neg', r)
  t('worst is the deeper loss', r.worst === '-$120.50' && r.worstDay === '2026-09-02', r)
}
{
  const r = pick({ '2026-09-01': day(40), '2026-09-02': day(0), '2026-09-03': day(-10) })
  t('a break-even trading day can be neither best nor worst when both sides exist',
    r.bestDay === '2026-09-01' && r.worstDay === '2026-09-03', r)
  t('and it counts as a trading day', r.tradedDays === 3, r)
}
{
  // Exactly zero is a result a day can have, and it must not print a sign.
  const r = pick({ '2026-09-01': day(0), '2026-09-02': day(30) })
  t('a zero day reads as $0.00, with no sign', r.worst === '$0.00', r)
  t('and is coloured neutral', r.worstCls === 'neu', r)
}
{
  // A deposit is not a day's trading result. Counting it would hand Worst Day to a $0 day
  // that never traded.
  const r = pick({ '2026-09-01': day(0, 0, 5000), '2026-09-02': day(25), '2026-09-03': day(80) })
  t('a deposit-only day cannot take Worst Day', r.worstDay === '2026-09-02', r)
  t('nor pad the trading-day count', r.tradedDays === 2, r)
}
{
  const r = pick({})
  t('a month with nothing in it has no best or worst', r.bestDay === undefined && r.worstDay === undefined)
  t('and renders a dash rather than throwing', r.best === '—' && r.worst === '—', r)
  t('with a neutral colour', r.worstCls === 'neu')
}
t('the renderer really is sign-aware', src.includes("(v > 0 ? '+$' : v < 0 ? '-$' : '$') + fmtUSD(Math.abs(v))"))
t('and colour-aware', src.includes("return v > 0 ? 'pos' : v < 0 ? 'neg' : 'neu'"))
t('both cards use it', src.includes('${dayCls(bestDay)}') && src.includes('${dayCls(worstDay)}') &&
  src.includes('${dayAmt(bestDay)}') && src.includes('${dayAmt(worstDay)}'))
t('the worst day is no longer gated on being negative',
  !src.includes('byDay[worstDay].pnl < 0'))
t('why is written down', src.includes('The LEAST profitable day, whatever its sign'))

console.log(String.fromCharCode(10) + '-- both cards are in the summary --')
const sum = src.slice(src.indexOf('<div class="cal-summary">'), src.indexOf('<div style="overflow-x:auto'))
t('Avg / Trading Day is a card', sum.includes('Avg / Trading Day'))
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
