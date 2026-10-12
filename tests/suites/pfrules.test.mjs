// DCA on drops, and the three new allocation strategies (src/pfrules.js), in the backtest
// (src/pfbacktest.js simulate) and the live bot (src/pflive.js decide) alike.
// Asked for: "make the dca also have an option that instead of time by % drops. or both. also
// add more strategies".
import fs from 'fs'
import { basketChange, annualVol, trailingReturn, invVolWeights, momentumWeights, volScale, basketVol, DCA_TIME, DCA_DROP, DCA_BOTH } from '../../src/pfrules.js'
import { simulate, STRATEGIES, ALLOC_DEFAULTS } from '../../src/pfbacktest.js'
import { decide, freshLedger, LIVE_STRATEGIES, LIVE_DEFAULTS, liveArgs } from '../../src/pflive.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const DAY = 864e5
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

console.log('\n-- the rules --')
t('basket change is weighted: half up 10%, half flat → +5%', near(basketChange({ A: 0.5, B: 0.5 }, { A: 100, B: 10 }, { A: 110, B: 10 }), 0.05))
t('a short gains when its price falls', near(basketChange({ A: -1 }, { A: 100 }, { A: 90 }), 0.1))
t('nothing comparable is unknown (null), not 0', basketChange({ A: 1 }, {}, { A: 1 }) === null)
const flat = Array(40).fill(100), wild = Array.from({ length: 40 }, (_, i) => 100 * (i % 2 ? 1.05 : 0.95))
t('a flat price has zero volatility; a jumpy one a lot', annualVol(flat, 30) === 0 && annualVol(wild, 30) > 1)
t('too little history is null', annualVol([1, 2, 3], 30) === null && trailingReturn([1, 2], 30) === null)
t('trailing return over the window', near(trailingReturn([100, 50, 100, 110, 120, 130, 150], 2), 150 / 120 - 1))
{
  const w = invVolWeights({ A: 0.5, B: 0.5 }, { A: 0.4, B: 0.8 })
  t('risk parity: twice the volatility, half the share', near(w.A, 2 / 3) && near(w.B, 1 / 3), w)
  const u = invVolWeights({ A: 0.5, B: 0.5 }, { A: 0.4, B: null })
  t('a market with no volatility yet keeps the others\' average (not 0, not infinite)', near(u.A, 0.5) && near(u.B, 0.5), u)
  t('a short stays short', invVolWeights({ A: 0.5, B: -0.5 }, { A: 1, B: 1 }).B < 0)
}
{
  const m = momentumWeights({ A: 0.25, B: 0.25, C: 0.25, D: 0.25 }, { A: 0.3, B: 0.1, C: -0.2, D: 0.2 }, 2)
  t('momentum holds the top N risers, scaled up to fill the book', Object.keys(m).sort().join() === 'A,D' && near(m.A, 0.5), m)
  t('one that fell is never held, even if the top N has room', !('C' in momentumWeights({ A: 0.5, C: 0.5 }, { A: 0.1, C: -0.1 }, 5)))
  t('everything falling: all cash', Object.keys(momentumWeights({ A: 1 }, { A: -0.1 }, 3)).length === 0)
  t('a short with a falling price is momentum for it', 'S' in momentumWeights({ S: -1 }, { S: -0.2 }, 1))
}
t('vol target: calmer than the target, hold all; twice as wild, half; never more than all', volScale(0.3, 0.5) === 1 && near(volScale(1, 0.5), 0.5) && volScale(null, 0.5) === 1)
t('basket volatility combines the holdings', basketVol({ A: 1 }, { A: wild }, 30) > 1 && near(basketVol({ A: 1 }, { A: flat }, 30), 0))

console.log('\n-- DCA on drops, in the backtest --')
const grid = (series) => ({ days: series[Object.keys(series)[0]].map((_, i) => i * DAY), px: series })
{
  // A price that falls 5% a day for 10 days, then flat.
  const fall = Array.from({ length: 30 }, (_, i) => 100 * Math.pow(0.95, Math.min(i, 10)))
  const g = grid({ A: fall })
  const drop = simulate(g, 0, { A: 1 }, 'dca', { capital: 1000, feeBps: 0, dcaMode: DCA_DROP, dcaDrop: 0.1, dcaBuys: 4 })
  // Buys: day 0 (first), then each time 10% below the last buy: day 3 (0.857), day 5 (0.774 < 0.857*0.9), day 7.
  t('drop mode buys on day one and then each 10% below the last buy, until the capital is in', drop.rebalances === 4, drop.rebalances)
  const time = simulate(g, 0, { A: 1 }, 'dca', { capital: 1000, feeBps: 0, dcaMode: DCA_TIME, dcaEvery: 7 })
  t('time mode is unchanged: every 7 days over the window', time.rebalances === 5, time.rebalances)
  const up = simulate(grid({ A: Array.from({ length: 30 }, (_, i) => 100 + i) }), 0, { A: 1 }, 'dca', { capital: 1000, feeBps: 0, dcaMode: DCA_DROP, dcaDrop: 0.1, dcaBuys: 4 })
  t('a price that only rises: drop mode buys once and keeps the rest in cash (said in its description)', up.rebalances === 1 && up.equity.at(-1) > 1000 && up.equity.at(-1) < 1100, [up.rebalances, up.equity.at(-1)])
  const both = simulate(g, 0, { A: 1 }, 'dca', { capital: 1000, feeBps: 0, dcaMode: DCA_BOTH, dcaEvery: 7, dcaDrop: 0.1, dcaBuys: 8 })
  t('either: drop buys and dated buys both count', both.rebalances > drop.rebalances, [both.rebalances, drop.rebalances])
}

console.log('\n-- the new strategies, in the backtest --')
{
  const n = 120
  const calm = Array.from({ length: n }, (_, i) => 100 * (1 + 0.01 * Math.sin(i)))
  const wildS = Array.from({ length: n }, (_, i) => 100 * (1 + 0.08 * Math.sin(i)))
  const g = grid({ A: calm, B: wildS })
  for (const id of ['invvol', 'momentum', 'voltarget']) {
    const r = simulate(g, 40, { A: 0.5, B: 0.5 }, id, { capital: 1000, feeBps: 0 })
    t(`${id} runs and trades`, r.equity.length === n - 40 && r.rebalances > 0 && r.equity.every(v => v > 0), [r.rebalances])
  }
  t('they are listed with labels and descriptions', ['invvol', 'momentum', 'voltarget'].every(id => STRATEGIES.some(s => s.id === id && s.label && s.desc)))
  const v = simulate(grid({ A: wildS }), 40, { A: 1 }, 'voltarget', { capital: 1000, feeBps: 0, volTarget: 0.2 })
  const hold = simulate(grid({ A: wildS }), 40, { A: 1 }, 'hold', { capital: 1000, feeBps: 0 })
  const swing = (e) => Math.max(...e) - Math.min(...e)
  t('vol target swings less than holding the same wild coin', swing(v.equity) < swing(hold.equity), [swing(v.equity), swing(hold.equity)])
}

console.log('\n-- the same rules, live --')
{
  t('the live bot runs every new strategy', ['invvol', 'momentum', 'voltarget'].every(s => LIVE_STRATEGIES.includes(s)))
  t('and passes their settings through to the bot', (() => { const a = liveArgs({ id: 'x', items: [{ coin: 'A', w: 1 }], strategy: 'dca', params: { dcaMode: 1, dcaDrop: 0.1 }, budget: 100, lev: 1 }); return a.includes('--dcaMode') && a[a.indexOf('--dcaDrop') + 1] === '0.1' })())
  const now = Date.UTC(2026, 0, 5)
  let L = freshLedger(1000, 'dca', now)
  const P = { dcaMode: DCA_DROP, dcaDrop: 0.1, dcaBuys: 4 }
  let d = decide({ strategy: 'dca', params: P, weights: { A: 1 }, ledger: L, px: { A: 100 }, now })
  t('live drop DCA: the first buy is right away', d.due && near(d.release, 250))
  L = { ...L, dcaDone: 1, reserve: 750, cash: 0, units: { A: 2.5 }, lastRebal: now, dcaRef: { A: 100 }, lastBuyAt: now }
  d = decide({ strategy: 'dca', params: P, weights: { A: 1 }, ledger: L, px: { A: 95 }, now: now + 3 * DAY })
  t('5% down: waits, and says what it waits for', !d.due && /10\.0% below the last buy/.test(d.reason) && /-5\.0%/.test(d.reason), d.reason)
  d = decide({ strategy: 'dca', params: P, weights: { A: 1 }, ledger: L, px: { A: 89 }, now: now + 3 * DAY })
  t('11% down: buys the next part', d.due && near(d.release, 250) && /buy 2 of 4/.test(d.reason), d.reason)
  d = decide({ strategy: 'dca', params: { ...P, dcaMode: DCA_BOTH, dcaEvery: 7 }, weights: { A: 1 }, ledger: L, px: { A: 99 }, now: now + 7 * DAY })
  t('either: the schedule still buys without a drop', d.due)
  const hist = { A: Array.from({ length: 40 }, (_, i) => 100 + i), B: Array.from({ length: 40 }, (_, i) => 100 - i) }
  const m = decide({ strategy: 'momentum', params: { momTop: 1, momDays: 30 }, weights: { A: 0.5, B: 0.5 }, ledger: freshLedger(1000, 'momentum', now), px: { A: 139, B: 61 }, now, hist })
  t('live momentum holds the riser, not the faller', m.due && m.targets.A > 0 && m.targets.B === 0 && /holding A/.test(m.reason), m)
  const r = decide({ strategy: 'invvol', params: {}, weights: { A: 0.5, B: 0.5 }, ledger: freshLedger(1000, 'invvol', now), px: { A: 100, B: 100 }, now, hist: { A: calmOf(), B: wildOf() } })
  t('live risk parity gives the calmer coin more', r.due && r.targets.A > r.targets.B, r.targets)
  const vt = decide({ strategy: 'voltarget', params: { volTarget: 0.1 }, weights: { A: 1 }, ledger: freshLedger(1000, 'voltarget', now), px: { A: 100 }, now, hist: { A: wildOf() } })
  t('live vol target holds less of a wild basket', vt.due && vt.targets.A * 100 < 1000 && /holding \d+% of the basket/.test(vt.reason), vt)
}
function calmOf() { return Array.from({ length: 40 }, (_, i) => 100 * (1 + 0.01 * Math.sin(i))) }
function wildOf() { return Array.from({ length: 40 }, (_, i) => 100 * (1 + 0.08 * Math.sin(i))) }

console.log('\n-- the page --')
{
  const pf = fs.readFileSync('src/portfolio.js', 'utf8').replace(/\r\n/g, '\n')
  t('DCA has a "Buy when" choice: every N days, price drops, or either', pf.includes("key: 'dcaMode', label: 'Buy when'") && pf.includes("['1', 'Price drops'], ['2', 'Either']"))
  t('each new strategy has its settings and a plain description', ['invvol', 'momentum', 'voltarget'].every(id => new RegExp(`\\n  ${id}: \\[`).test(pf) && new RegExp(`\\n  ${id}: '`).test(pf)))
  t('the page sends the new settings to the backtest and the bot', (pf.match(/dcaMode: Number\(ap\('dcaMode'\)\)/g) || []).length === 2)
  t('defaults agree between the page, the backtest and the bot', ALLOC_DEFAULTS.dcaDrop === LIVE_DEFAULTS.dcaDrop && ALLOC_DEFAULTS.volTarget === LIVE_DEFAULTS.volTarget && ALLOC_DEFAULTS.momTop === LIVE_DEFAULTS.momTop)
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
