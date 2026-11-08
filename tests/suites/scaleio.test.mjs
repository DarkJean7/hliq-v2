// Trade Simulator: a position that changes size while it is open -- a partial take-profit and
// scaling in on further signals (src/backtest.js, the signal walk).
//
// Asked for: "add the option for the user to be able to tp just a portion, to be able to add a
// portion based on signals". Every figure below is worked by hand from candles built for it, so
// the test is the arithmetic, not a snapshot of whatever the engine printed.
import { runBacktest, normalise, coerceParams, BT_DEFAULTS, BT_FIELDS, BT_CHOICES, BT_MODULES } from '../../src/backtest.js'
import { replayMarks } from '../../src/simreplay.js'
import fs from 'fs'

const sim = fs.readFileSync('src/simulator.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

// Thirty quiet candles a dollar tall at 100, then a big green one closing at 103 (category 8),
// then whatever each test needs.
const flat = Array.from({ length: 30 }, (_, i) => ({ t: i * 36e5, o: 100, h: 100.5, l: 99.5, c: 100 }))
const big = { t: 30 * 36e5, o: 99, h: 103.2, l: 98.8, c: 103 }
const after = (...cs) => normalise([...flat, big, ...cs.map((c, k) => ({ t: (31 + k) * 36e5, ...c }))])
const base = { strategy: 'range', entryCategory: 8, useCooldown: false, useFees: false, pnlModel: 'notional',
  leverage: 1, sizePct: 100, takeProfitPct: 1, stopLossPct: 0.5 }

console.log(nl + '-- off by default, nothing changes --')
t('both are modules, off by default', BT_MODULES.some(m => m.key === 'usePartialTp') && BT_MODULES.some(m => m.key === 'useScaleIn') &&
  BT_DEFAULTS.usePartialTp === false && BT_DEFAULTS.useScaleIn === false)
t('their settings sit under them', ['ptpPct', 'ptpPortion'].every(k => BT_FIELDS.find(f => f.key === k)?.group === 'usePartialTp') &&
  ['addPortion', 'maxAdds'].every(k => BT_FIELDS.find(f => f.key === k)?.group === 'useScaleIn') &&
  BT_CHOICES.find(c => c.key === 'ptpBreakeven')?.group === 'usePartialTp' && BT_CHOICES.find(c => c.key === 'addLevels')?.group === 'useScaleIn')

console.log(nl + '-- a partial take-profit --')
// q = 1000 / 103 coins. First target 0.5% = 103.515, main target 1% = 104.03.
const q = 1000 / 103
const P = (o, ...cs) => runBacktest(after(...cs), { ...base, usePartialTp: true, ptpPct: 0.5, ptpPortion: 50, ...o }).trades[0]
const both = P({}, { o: 103, h: 103.6, l: 102.95, c: 103.5 }, { o: 103.5, h: 104.1, l: 103.4, c: 104 })
t('half is banked at the first target', near(both.partial?.px, 103.515) && near(both.partial.q, q / 2) && near(both.partial.pnl, q / 2 * 0.515), both.partial)
t('the rest takes the main target', both.exitBy === 'tp' && near(both.exitPx, 104.03), [both.exitBy, both.exitPx])
t('and the trade made both pieces', near(both.delta, q / 2 * 0.515 + q / 2 * 1.03), [both.delta, q / 2 * 1.545])
const be = P({}, { o: 103, h: 103.6, l: 102.95, c: 103.5 }, { o: 103.5, h: 103.6, l: 102.9, c: 103 })
t('then the rest\'s stop moves to the entry: a pullback closes it at breakeven', be.exitBy === 'breakeven' && near(be.exitPx, 103), [be.exitBy, be.exitPx])
t('and banking half then breaking even is a WIN, scored by the whole trade', be.outcome === 'win' && near(be.delta, q / 2 * 0.515), [be.outcome, be.delta])
const keep = P({ ptpBreakeven: 'no' }, { o: 103, h: 103.6, l: 102.95, c: 103.5 }, { o: 103.5, h: 103.6, l: 102.9, c: 103 }, { o: 103, h: 103.1, l: 102.4, c: 102.5 })
t('with the stop kept, the same pullback does not close it; the stop does', keep.exitBy === 'stop' && near(keep.exitPx, 102.485), [keep.exitBy, keep.exitPx])
// One candle reaching both the first target and the stop: the order inside it is unknown.
const tie = (amb) => P({ ambiguous: amb }, { o: 103, h: 103.6, l: 102.4, c: 103 })
t('a candle that hits the first target AND the stop: on "loss" no partial is assumed', !tie('loss').partial && tie('loss').exitBy === 'stop')
t('on "win" the partial comes first', !!tie('win').partial)
const rk = runBacktest(after({ o: 103, h: 103.6, l: 102.95, c: 103.5 }, { o: 103.5, h: 104.1, l: 103.4, c: 104 }),
  { ...base, pnlModel: 'risk', usePartialTp: true, ptpPct: 0.5, ptpPortion: 50 }).trades[0]
t('outside Hyperliquid sizing there is no position to take part of: nothing changes', !rk.partial)

console.log(nl + '-- scaling in --')
// Leverage 3 at half the balance leaves margin for an add. A second big green candle at 31
// (4.1 tall against a normal of about 1.1) is another category-8 signal the same way.
const SI = { ...base, leverage: 3, sizePct: 50, takeProfitPct: 5, stopLossPct: 2, useScaleIn: true, addPortion: 50, maxAdds: 2 }
const add1 = runBacktest(after({ o: 102.8, h: 107, l: 102.9, c: 106.9 }, { o: 106.9, h: 107.2, l: 106.5, c: 107 }), SI).trades[0]
const q0 = 1000 * 0.5 * 3 / 103
t('another signal the same way adds half the first size at that close', add1.adds?.length === 1 && near(add1.adds[0].px, 106.9) && near(add1.adds[0].q, q0 / 2), add1.adds)
const avg = (q0 * 103 + q0 / 2 * 106.9) / (q0 * 1.5)
t('the average entry is the weighted one', near(add1.avgEntry, avg), [add1.avgEntry, avg])
t('the target follows it, the same 5% from the new average', near(add1.tp, avg * 1.05), [add1.tp, avg * 1.05])
t('and the position is the sum', near(add1.q, q0 * 1.5), [add1.q, q0 * 1.5])
const stay = runBacktest(after({ o: 102.8, h: 107, l: 102.9, c: 106.9 }), { ...SI, addLevels: 'first' }).trades[0]
t('with levels kept, the target is where the first entry set it', near(stay.tp, 103 * 1.05), stay.tp)
const many = runBacktest(after({ o: 102.8, h: 107, l: 102.9, c: 106.9 }, { o: 106.9, h: 111.5, l: 106.8, c: 111 }, { o: 111, h: 116, l: 110.9, c: 115.8 }),
  { ...SI, takeProfitPct: 50, maxAdds: 1 }).trades[0]
t('no more adds than the limit', many.adds?.length === 1, many.adds)
const full = runBacktest(after({ o: 102.8, h: 107, l: 102.9, c: 106.9 }), { ...SI, leverage: 1, sizePct: 100 }).trades[0]
t('an add the account cannot margin is refused and counted, not made', !full.adds && full.addsRefused === 1, [full.adds, full.addsRefused])
const opp = runBacktest(after({ o: 106.9, h: 107, l: 102.8, c: 102.9 }), { ...SI, stopLossPct: 10 }).trades[0]
t('a signal the OTHER way is not an add', !opp.adds)

console.log(nl + '-- on screen --')
const mk = replayMarks([add1, both])
t('the chart gets a marker for each add and for the part taken early', mk.some(m => m.kind === 'add' && near(m.v, 106.9) && m.buy) && mk.some(m => m.kind === 'partial' && !m.buy))
t('the trade row says how many adds, the average, and the partial', sim.includes("t.adds?.length ? ` · <span") && sim.includes("_T('part out', 'parcial')") && sim.includes("breakeven: () => _T('breakeven'"))
t('limits are kept sane', (() => { const c = coerceParams({ ptpPortion: 150, maxAdds: 40, addPortion: 0 }); return c.ptpPortion === 99 && c.maxAdds === 10 && c.addPortion === 1 })())

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
