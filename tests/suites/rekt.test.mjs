// Rekt-01 (src/rekt.js): "i would like my own personal agent that learns itself" — self-tuning,
// with risk limits, market lists, style and arena as settings "only changeable by users with dev
// mode on". It learns signal weights from hourly shadow calls and its stop and hold from its trades.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { cleanConfig, DEFAULT_CONFIG, signalsOf, blend, normalize, learnSignals, pickArm, learnTrade, initLearn, rektAgent, allowed, SIGNALS, FLOOR, STOPS, HORIZONS, REKT_ID } from '../../src/rekt.js'
import { createAgentRunner } from '../../src/agentrunner.js'
import { createPaperHost } from '../../src/paperhost.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const H = 3600e3, D = 24 * H
const NOW = Date.UTC(2026, 10, 24, 12)
const seq = (vals) => { let i = 0; return () => vals[i++ % vals.length] }

function days(n, drift, vol, end = NOW) {
  const out = []; let p = 100
  for (let i = n - 1; i >= 0; i--) { p *= 1 + drift; out.push({ t: end - i * D, o: p, h: p, l: p, c: p, v: vol }) }
  return out
}

console.log('-- settings --')
const c0 = cleanConfig({})
t('defaults', JSON.stringify(c0) === JSON.stringify(DEFAULT_CONFIG))
const c1 = cleanConfig({ maxLev: 99, maxPositions: 0, maxLossPct: 'x', pauseDDPct: 1, markets: { mode: 'allow', list: 'btc, eth  sol,<b>,kpepe' }, style: 'yolo', horizon: 'weeks', arena: false, paused: 1, extra: 'dropped' })
t('every field clamped, unknowns dropped', c1.maxLev === 10 && c1.maxPositions === 1 && c1.maxLossPct === DEFAULT_CONFIG.maxLossPct && c1.pauseDDPct === 5 && c1.style === 'balanced' && c1.horizon === 'weeks' && c1.arena === false && c1.paused === true && !('extra' in c1), c1)
t('the coin list is cleaned (kPEPE keeps its k)', c1.markets.list.join() === 'BTC,ETH,SOL,kPEPE', c1.markets.list)
t('allow / block lists', allowed('BTC', c1) && !allowed('DOGE', c1) && !allowed('BTC', cleanConfig({ markets: { mode: 'block', list: ['BTC'] } })) && allowed('X', c0))

console.log('-- signals --')
const daily = { UP: days(90, 0.01, 1e6), DN: days(90, -0.01, 1e6) }
const ctx0 = { now: NOW, daily, readings: { UP: { score: 60, t: NOW - H }, OLD: { score: 90, t: NOW - 7 * H } }, funding: { UP: 0.0001, DN: -0.00005 } }
const s = signalsOf('UP', ctx0)
t('oracle = score/100; momentum up; reversion against the week; funding against who pays', s.oracle === 0.6 && s.momentum > 0.5 && s.reversion < 0 && s.funding === -1, s)
t('a stale call or no data is null, not zero', signalsOf('OLD', ctx0).oracle === null && signalsOf('NONE', ctx0).momentum === null)
t('blend is the weighted mean of what has data', Math.abs(blend({ oracle: 1, momentum: null, reversion: -1, funding: null }, { oracle: 0.75, momentum: 0.1, reversion: 0.25, funding: 0.1 }) - 0.5) < 1e-9)
t('blend with nothing to say is null', blend({ oracle: null, momentum: null, reversion: null, funding: null }, normalize({})) === null)
const nw = normalize({ oracle: 100, momentum: 0, reversion: 0, funding: 0 })
t('weights sum to 1 and none falls below the floor', Math.abs(SIGNALS.reduce((a, k) => a + nw[k], 0) - 1) < 1e-9 && SIGNALS.every(k => nw[k] >= FLOOR - 1e-12), nw)

console.log('-- loop 1: it learns which signal to trust --')
// Ten markets; momentum is always right (prices keep trending), reversion is always wrong.
const cfg = cleanConfig({ horizon: 'hours' })
const L = initLearn(NOW)
const coins = Array.from({ length: 10 }, (_, i) => 'M' + i)
const dd = Object.fromEntries(coins.map((c, i) => [c, days(90, i % 2 ? 0.01 : -0.01, 1e6)]))
let px = Object.fromEntries(coins.map((c, i) => [c, 100]))
for (let h = 0; h < 48; h++) {
  const now = NOW + h * H
  learnSignals(L, { now, daily: dd, readings: {}, funding: {}, marks: px }, cfg)
  px = Object.fromEntries(coins.map((c, i) => [c, px[c] * (i % 2 ? 1.01 : 0.99)]))
}
t('momentum, right every time, is now trusted most', SIGNALS.every(k => k === 'momentum' || L.w.momentum > L.w[k]), L.w)
t('reversion, wrong every time, is trusted least', SIGNALS.every(k => k === 'reversion' || L.w.reversion <= L.w[k]), L.w)
t('it kept score: momentum right 100% of its calls, reversion 0%', L.stats.momentum.hits === L.stats.momentum.called && L.stats.momentum.called > 100 && L.stats.reversion.hits === 0, L.stats)
t('signals with no data are not scored (oracle, funding)', L.stats.oracle.n === 0 && L.stats.funding.n === 0)
t('one shadow call per market per hour, scored once', L.shadow.every(x => NOW + 47 * H - x.t < HORIZONS.hours.evalH * H) && L.shadow.length <= coins.length * HORIZONS.hours.evalH)
t('its weights over time are kept for the chart', L.hist.length >= 8)

console.log('-- loop 2: it learns its own stop and hold --')
t('an untried choice is tried first, sometimes', pickArm({}, STOPS, seq([0.1, 0.0])) === STOPS[0])
t('otherwise the best average so far', pickArm({ 3: { n: 5, sum: -5 }, 5: { n: 5, sum: 10 }, 8: { n: 5, sum: 1 }, 12: { n: 5, sum: 0 }, 18: { n: 5, sum: 2 } }, STOPS, seq([0.9])) === 5)
const L2 = initLearn(NOW)
L2.open.BTC = { t: NOW, eq: 1000, stop: 8, hold: 96 }
t('a trade credits its stop and hold with its result in % of equity', learnTrade(L2, 'BTC', 25) === 2.5 && L2.arms.stop[8].n === 1 && L2.arms.hold[96].sum === 2.5 && L2.trades === 1 && !L2.open.BTC)

console.log('-- decisions --')
const uni = Object.fromEntries(Array.from({ length: 30 }, (_, i) => ['C' + i, days(90, i < 4 ? 0.012 : 0, 1e6 / (i + 1))]))
const marks = Object.fromEntries(Object.entries(uni).map(([c, k]) => [c, String(k.at(-1).c)]))
// Trend and bounce cancel on a steady riser at equal weights; the Oracle's call tips C0–C3 over.
const RD = Object.fromEntries(['C0', 'C1', 'C2', 'C3'].map(c => [c, { score: 80, t: NOW - H }]))
const ctxD = (over = {}) => ({ now: NOW, daily: uni, readings: RD, funding: {}, marks, held: [], cool: {}, equity: 1000, rng: seq([0.9]), learn: initLearn(NOW), config: cleanConfig({}), ...over })
const d1 = rektAgent.decide(ctxD())
t('opens the strongest blends, up to max positions', d1.length === 4 && d1.every(w => w.side === 'long' && /^C[0-3]$/.test(w.coin)), d1.map(w => w.coin + w.side))
t('sized so its stop loses at most maxLossPct of equity', d1.every(w => Math.abs(w.notional * w.stopPct / 100 - 1000 * 0.02) < 1e-6 || w.notional <= 1000 * 0.98 * w.lev / 4 + 1e-9), d1.map(w => [w.notional, w.stopPct]))
t('says why: the score and the signal that led it', /score \+0\.\d\d, led by .+ · stop \d+%, hold ≤\d+h/.test(d1[0].why), d1[0].why)
t('the allow list is respected', rektAgent.decide(ctxD({ config: cleanConfig({ markets: { mode: 'allow', list: ['C2'] } }) })).map(w => w.coin).join() === 'C2')
t('paused in its settings: opens nothing, keeps what it holds', (() => { const r = rektAgent.decide(ctxD({ config: cleanConfig({ paused: true }), held: [{ coin: 'C0', side: 'long' }] })); return r.length === 1 && r[0].coin === 'C0' })())
const Lp = initLearn(NOW); Lp.peak = 1000
t('down past pauseDDPct from its peak: pauses itself', rektAgent.decide(ctxD({ learn: Lp, equity: 700 })).length === 0 && Math.abs(Lp.pausedBy?.dd - 30) < 1e-9)
rektAgent.decide(ctxD({ learn: Lp, equity: 900 }))
t('and resumes once back within half of it', Lp.pausedBy === null)
t('a market taken off the allow list is closed', !rektAgent.decide(ctxD({ config: cleanConfig({ markets: { mode: 'block', list: ['C0'] } }), held: [{ coin: 'C0', side: 'long' }] })).some(w => w.coin === 'C0'))
const Lh = initLearn(NOW); Lh.open.C0 = { t: NOW - 50 * H, eq: 1000, stop: 8, hold: 48 }
t('held as long as it chose to: closed', !rektAgent.decide(ctxD({ learn: Lh, held: [{ coin: 'C0', side: 'long' }], cool: { C0: NOW + 1 } })).some(w => w.coin === 'C0'))
t('style: aggressive levers more than cautious', rektAgent.levOf(cleanConfig({ style: 'aggressive', maxLev: 4 })) === 4 && rektAgent.levOf(cleanConfig({ style: 'cautious', maxLev: 4 })) === 2)
t('no candles or no prices → null (could not look)', rektAgent.decide(ctxD({ daily: {} })) === null && rektAgent.decide(ctxD({ marks: {} })) === null)

console.log('-- in the runner --')
const dir = fs.mkdtempSync(join(os.tmpdir(), 'rekt-'))
const oracleDir = join(dir, 'oracle'); fs.mkdirSync(oracleDir)
for (const [coin, c] of Object.entries(uni)) fs.writeFileSync(join(oracleDir, coin + '.json'), JSON.stringify({ coin, candles: { '1d': c } }))
const paperHost = createPaperHost({ dir: join(dir, 'paper') })
let clock = NOW
const mids = { ...marks, BTC: '100' }
const names = Object.keys(mids)
const post = async (b) => b.type === 'allMids' ? { ...mids } : b.type === 'metaAndAssetCtxs' ? [{ universe: names.map(n => ({ name: n, szDecimals: 3, maxLeverage: 20 })) }, names.map(() => ({ funding: '0' }))] : {}
const origNow = Date.now; Date.now = () => clock
try {
  const runner = createAgentRunner({ dir: join(dir, 'agents'), paperHost, post, readings: () => RD, oracleDir, now: () => clock, log: { warn: () => {} }, rng: seq([0.9]) })
  t('settings save cleaned, to its own file', runner.saveConfig({ maxPositions: 2, maxLev: 50 }).maxLev === 10 && runner.configOf().maxPositions === 2)
  await runner.tick()
  const s1 = JSON.parse(fs.readFileSync(runner.summaryFile, 'utf8'))
  const r1 = s1.agents.find(a => a.id === REKT_ID)
  t('Rekt-01 is on the board, marked yours, with its settings and what it learned', r1 && r1.personal && r1.config.maxPositions === 2 && r1.learn && r1.max === 2, r1 && Object.keys(r1))
  t('it opened up to its max positions, each with a stop', r1.positions.length === 2 && r1.stops.length === 2, r1.journal)
  t('its first shadow calls are waiting to be scored', r1.learn.pending > 0)
  const st = runner._state().agents[REKT_ID].learn
  t('each open position remembers the stop and hold it was opened with', Object.keys(st.open).length === 2 && Object.values(st.open).every(o => STOPS.includes(o.stop) && o.eq > 0))
  // A stop fills on the paper tick: the runner credits the loss to that stop and hold.
  const coin = r1.positions[0].coin, stopPx = r1.stops.find(x => x.coin === coin).px
  mids[coin] = String(stopPx * 0.97)
  paperHost.tick({ marks: mids, assets: Object.fromEntries(names.map(n => [n, { szDecimals: 3, maxLeverage: 20 }])), funding: {} })
  clock += 6 * 60e3
  await runner.tick()
  const L3 = runner._state().agents[REKT_ID].learn
  const armed = Object.values(L3.arms.stop).reduce((a, x) => a + x.n, 0)
  t('a stop-out teaches it: one trade credited, at a loss', L3.trades === 1 && armed === 1 && Object.values(L3.arms.stop)[0].sum < 0, L3.arms)
  t('out of the arena: flagged hidden for the server to strip', (runner.saveConfig({ arena: false }), clock += 6 * 60e3, await runner.tick(), JSON.parse(fs.readFileSync(runner.summaryFile, 'utf8')).agents.find(a => a.id === REKT_ID).hidden === true))
} finally { Date.now = origNow }
fs.rmSync(dir, { recursive: true, force: true })

console.log('-- wiring --')
const srv = fs.readFileSync('serve-prod.js', 'utf8')
t('settings are saved only with a verified dev PIN', /url === '\/agents-config'[\s\S]{0,400}devPinOk\(req\.headers\['x-lb-pin'\]\)[\s\S]{0,200}if \(!ok\) return send\(403/.test(srv))
t('out of the arena it is stripped unless the dev PIN checks out', srv.includes("j.agents = j.agents.filter(a => !a.hidden)") && srv.includes("'Cache-Control': 'private, no-store'"))
const view = fs.readFileSync('src/rektview.js', 'utf8'), av = fs.readFileSync('src/agentsview.js', 'utf8')
t('the form is shown in dev mode only; others see the settings read-only', view.includes("if (!dev) {") && av.includes('dev: isDevMode()') && view.includes("localStorage.getItem('hliq_dev') === '1'"))
t('a repaint never takes a settings field from under the typist', av.includes("document.activeElement?.closest?.('[data-rk-form]')"))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
