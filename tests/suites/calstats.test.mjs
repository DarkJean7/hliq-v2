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
t('the denominator is green + red days', src.includes('const tradedDays = greenDays + redDays'))
t('and it is null, not zero, when nothing traded', src.includes('tradedDays > 0 ? monthPnl / tradedDays : null'))
t('no-trade months render a dash', src.includes("avgDayPnl == null ? '—'"))
t('the sign is explicit', src.includes("(avgDayPnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(avgDayPnl))"))
t('the colour follows the sign', src.includes("avgDayPnl == null ? 'neu' : avgDayPnl >= 0 ? 'pos' : 'neg'"))
t('the day count is shown so the figure can be checked', src.includes('over ${tradedDays} day'))
t('and pluralised', src.includes("tradedDays !== 1 ? 's' : ''"))
t('why the calendar is not the denominator is recorded', src.includes('report a number no day resembles'))

const avg = new Function('monthPnl', 'greenDays', 'redDays', `
  const tradedDays = greenDays + redDays
  return tradedDays > 0 ? monthPnl / tradedDays : null`)
t('121.35 over 8 days is 15.17', Math.abs(avg(121.35, 8, 0) - 15.16875) < 1e-6)
t('a losing month averages negative', avg(-100, 2, 3) === -20)
t('a month with no trades is null', avg(0, 0, 0) === null)
t('break-even days do not pad the denominator', avg(50, 2, 3) === 10)

console.log(String.fromCharCode(10) + '-- both cards are in the summary --')
const sum = src.slice(src.indexOf('<div class="cal-summary">'), src.indexOf('<div style="overflow-x:auto'))
t('Avg / Trading Day is a card', sum.includes('Avg / Trading Day'))
t('Month Volume is a card', sum.includes('Month Volume'))
t('the existing six are untouched',
  ['Month PnL', 'Green / Red Days', 'Best Day', 'Worst Day', 'Deposited', 'Withdrawn'].every(l => sum.includes(l)))
t('Max Drawdown is a card', sum.includes('Max Drawdown'))
t('Trades Made is a card', sum.includes('Trades Made'))
// Was eight; the month's worst peak-to-trough run and its fill count joined them. The
// count is asserted so a card cannot be dropped in a refactor without this going red.
t('there are ten cards now', (sum.match(/class="stat-card"/g) || []).length === 10)
t('drawdown is a RUN, not the worst single day',
  src.includes('ddPeak - ddRun') && src.includes('This is the run'))
t('and it is the month PnL curve, not account equity, and says so',
  src.includes('not of account equity'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
