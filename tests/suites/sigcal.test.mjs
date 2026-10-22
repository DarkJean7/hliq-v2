// Signals → Calendar (src/sigcal.js). Asked: "what if we also add a calendar performance so i can
// see the asset performance on a desired month from the past". Month and day returns are closes
// against the close BEFORE them, so a month and its days describe the same moves.
import fs from 'fs'
import { dailyCloses, yearsOf, monthReturns, monthDays, tint } from '../../src/sigcal.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b) => a != null && Math.abs(a - b) < 1e-9
const DAY = 86_400_000
const at = (y, m, d) => Date.UTC(y, m, d)
// Hyperliquid's candle shape: strings, t at the day's open.
const k = (t, o, c) => ({ t, T: t + DAY - 1, s: 'X', i: '1d', o: String(o), c: String(c), h: String(Math.max(o, c)), l: String(Math.min(o, c)), v: '1', n: 1 })

// A market listed 2025-12-30 at 100. It closes 2025 at 110; January 2026 ends at 121; Feb ends 96.8.
const C = [k(at(2025, 11, 30), 100, 105), k(at(2025, 11, 31), 105, 110)]
for (let d = 1; d <= 31; d++) C.push(k(at(2026, 0, d), 110, d === 31 ? 121 : 110 + d * 0.3))
for (let d = 1; d <= 28; d++) C.push(k(at(2026, 1, d), 121, d === 28 ? 96.8 : 121))
const rows = dailyCloses(C)
const NOW = at(2026, 2, 5)   // early March 2026

t('daily rows: one per day, oldest first, numbers', rows.length === 61 && rows[0].c === 105 && rows[1].t > rows[0].t)
t('years it covers, newest first', JSON.stringify(yearsOf(rows)) === '[2026,2025]', yearsOf(rows))
const m26 = monthReturns(rows, 2026, NOW)
t('January: last close against December\'s last close (121 / 110)', near(m26[0].ret, 0.1), m26[0])
t('February: 96.8 / 121 = -20%', near(m26[1].ret, -0.2), m26[1])
t('a month with no trading has no figure, not 0%', m26[5].ret === null)
t('the month in progress is marked', m26[2].current === true && m26[1].current === false)
const m25 = monthReturns(rows, 2025, NOW)
t('the listing month is measured from its first price, and says so', near(m25[11].ret, 0.1) && m25[11].partial === true, m25[11])

const jan = monthDays(rows, 2026, 0, NOW)
t('January 2026 starts on a Thursday: three blanks in a Monday-first week', jan.lead === 3, jan.lead)
t('its first day is against December 31st\'s close', near(jan.days[0].ret, (110.3 / 110) - 1) && jan.days[0].partial === false, jan.days[0])
t('its last day is against the 30th', near(jan.days[30].ret, 121 / (110 + 30 * 0.3) - 1), jan.days[30])
t('best and worst days are named', jan.best?.d === 31 && jan.worst != null)
t('the month total matches the month view', near(jan.total, 0.1))
const feb = monthDays(rows, 2026, 1, NOW)
t('compounding February\'s days gives February\'s return', near(feb.days.reduce((p, x) => p * (1 + x.ret), 1) - 1, feb.total), feb.total)
const dec = monthDays(rows, 2025, 11, NOW)
t('a day before listing is blank', dec.days[0].ret === null && dec.days[28].ret === null)
t('the listing day is measured from its own open', near(dec.days[29].ret, 0.05) && dec.days[29].partial === true, dec.days[29])

// A gap in the data must not fold several days into one cell.
const gap = dailyCloses([k(at(2026, 3, 1), 10, 10), k(at(2026, 3, 5), 12, 13)])
const apr = monthDays(gap, 2026, 3, NOW)
t('after a gap, the day is measured from its own open, not the close days earlier', near(apr.days[4].ret, 13 / 12 - 1) && apr.days[4].partial === true, apr.days[4])

t('tint is bounded and zero for nothing', tint(null, 0.1) === 0 && tint(0.5, 0.1) === 1 && near(tint(-0.05, 0.1), 0.5))
t('rows without a usable close are dropped', dailyCloses([{ t: 1, c: 'x' }, null, k(at(2026, 0, 1), 1, 2)]).length === 1)

const cli = fs.readFileSync('src/main.js', 'utf8')
t('Signals shows it, under Performance', cli.includes('<div id="sigCalCard"') && cli.indexOf('id="sigCalCard"') > cli.indexOf("_T('Performance', 'Rendimiento')"))
t('reading the daily candles Signals already loads — no requests of its own', cli.includes("const raw = _pulseCandles[_sigCoin + '|1d']") && !/_sigCalHtml[\s\S]{0,4000}fetchCandles/.test(cli))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
