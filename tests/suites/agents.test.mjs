// The Agent Arena: "go with 1 + 3, shared" — an Oracle-following agent, simple personas beside it,
// and buy-and-hold BTC as the benchmark, each on its own paper account run by the server.
// src/agents.js decides; src/agentrunner.js trades it through the real paper engine.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { AGENTS, agentById, planOf, sizeFor, maxDrawdown, thin, retOver, liquidUniverse, valueAt } from '../../src/agents.js'
import { createAgentRunner, latestReadings, COOL_MS } from '../../src/agentrunner.js'
import { createPaperHost } from '../../src/paperhost.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const H = 3600e3, D = 24 * H
const NOW = Date.UTC(2026, 10, 24, 12)

// 30 markets of daily candles: coin i trends by drift[i] a day, volume falls with i.
function days(n, drift, vol, end = NOW) {
  const out = []; let p = 100
  for (let i = n - 1; i >= 0; i--) { p *= 1 + drift; out.push({ t: end - i * D, o: p, h: p, l: p, c: p, v: vol }) }
  return out
}
const daily = {}
for (let i = 0; i < 30; i++) daily['C' + i] = days(90, (i < 3 ? 0.006 : i < 5 ? -0.006 : 0) , 1e6 / (i + 1))
daily.BTC = days(90, 0.001, 5e6)

console.log('-- the personas --')
t('five agents, ids unique, HODL BTC is the only benchmark', AGENTS.length === 5 && new Set(AGENTS.map(a => a.id)).size === 5 && AGENTS.filter(a => a.baseline).map(a => a.id).join() === 'hodl')
t('colours are fixed per agent and none is the app\'s green or red', new Set(AGENTS.map(a => a.color)).size === 5 && AGENTS.every(a => /^#[0-9a-f]{6}$/i.test(a.color)))
t('every agent explains itself in English and Spanish', AGENTS.every(a => a.blurb?.length === 2 && a.blurb.every(s => s.length > 40)))
t('retOver: 30 days of +0.6% a day ≈ +19.7%', Math.abs(retOver(daily.C0, 30) - (1.006 ** 30 - 1) * 100) < 1e-9)
t('retOver: unknown when the history does not reach', retOver(daily.C0.slice(0, 10), 30) === null)
t('liquidUniverse: the 25 most traded, with 60+ days', (() => { const u = liquidUniverse({ ...daily, NEW: days(20, 0, 1e9) }); return u.length === 25 && u[0] === 'BTC' && !u.includes('NEW') })())

const ctx = (over = {}) => ({ now: NOW, daily, funding: {}, readings: {}, held: [], cool: {}, ...over })
const mo = agentById('momentum')
const w1 = mo.decide(ctx())
t('momentum: longs the two strongest, shorts the two weakest', w1.filter(w => w.side === 'long').map(w => w.coin).sort().join() === 'C0,C1' && w1.filter(w => w.side === 'short').length === 2, w1)
t('momentum: keeps a long while it is still top 5', mo.decide(ctx({ held: [{ coin: 'C2', side: 'long' }] })).some(w => w.coin === 'C2' && /still top 5/.test(w.why)))
t('momentum: a coin cooling down is not reopened', !mo.decide(ctx({ cool: { C0: NOW + 1 } })).some(w => w.coin === 'C0'))
t('momentum: no candles → null (could not look), not an empty list', mo.decide(ctx({ daily: {} })) === null)

const dip = agentById('dip')
const dd = { ...daily, C5: [...days(83, 0, 1e6 / 6), ...days(7, -0.03, 1e6 / 6).map((k, i) => ({ ...k, c: 100 * 0.97 ** (i + 1) }))] }
const w2 = dip.decide(ctx({ daily: dd }))
t('dip: buys the sharp 7-day drop', w2.some(w => w.coin === 'C5' && w.side === 'long'), w2)
t('dip: sells after 5 days even if still down', !dip.decide(ctx({ daily: dd, held: [{ coin: 'C5', side: 'long', openedAt: NOW - 6 * D }], cool: { C5: NOW + 1 } })).some(w => w.coin === 'C5'))

const fu = agentById('funding')
const w3 = fu.decide(ctx({ funding: { C1: 0.0001, C2: -0.00005, C3: 0.00001 } }))
t('funding: shorts where longs pay, longs where shorts pay, ignores the small', w3.some(w => w.coin === 'C1' && w.side === 'short') && w3.some(w => w.coin === 'C2' && w.side === 'long') && !w3.some(w => w.coin === 'C3'), w3)
t('funding: no rates → null', fu.decide(ctx({ funding: {} })) === null)

const or = agentById('oracle')
const R = (score, age = H) => ({ score, sigma: 0.03, t: NOW - age })
const w4 = or.decide(ctx({ readings: { A: R(80), B: R(-60), C: R(45), D: R(39), E: R(90, 7 * H) } }))
t('oracle: opens the 3 strongest calls of 40+, both sides, ignores stale ones', w4.map(w => w.coin + w.side).join() === 'Along,Bshort,Clong', w4)
t('oracle: stop at two expected moves, between 3% and 15%', w4[0].stopPct === 6)
t('oracle: keeps a long while its call stays ≥ 15, closes when it fades', or.decide(ctx({ readings: { A: R(20) }, held: [{ coin: 'A', side: 'long' }] })).some(w => w.coin === 'A') && !or.decide(ctx({ readings: { A: R(10), Z: R(5) }, held: [{ coin: 'A', side: 'long' }] })).some(w => w.coin === 'A'))
t('oracle: a held coin with no fresh call is kept (unknown ≠ faded)', or.decide(ctx({ readings: { Z: R(5) }, held: [{ coin: 'A', side: 'long' }] })).some(w => w.coin === 'A'))
t('oracle: no readings at all → null', or.decide(ctx()) === null)
t('hodl: always BTC long', agentById('hodl').decide(ctx()).map(w => w.coin + w.side).join() === 'BTClong')

console.log('-- plans and numbers --')
const held = [{ coin: 'A', side: 'long' }, { coin: 'B', side: 'short' }, { coin: 'C', side: 'long' }]
const pl = planOf(held, [{ coin: 'A', side: 'long' }, { coin: 'B', side: 'long' }, { coin: 'D', side: 'short' }])
t('plan: keeps A, flips B, closes C, opens D', pl.close.map(h => h.coin).join() === 'B,C' && pl.open.map(w => w.coin).join() === 'B,D', pl)
t('plan: null (could not look) changes nothing', (() => { const p = planOf(held, null); return !p.close.length && !p.open.length })())
t('size: equal share of equity × leverage, floored to the decimals', sizeFor(1000, 2, 4, 3, 2) === 166.66 && sizeFor(1000, 2, 4, 0, 2) === 0)
t('max drawdown', Math.abs(maxDrawdown([[0, 100], [1, 120], [2, 90], [3, 130]]) - 25) < 1e-9 && maxDrawdown([[0, 1], [1, 2]]) === 0)
t('thin keeps the last point', (() => { const c = Array.from({ length: 1000 }, (_, i) => [i, i]); const x = thin(c, 50); return x.length === 50 && x.at(-1)[0] === 999 })())
t('latest 24h reading per coin', (() => { const r = latestReadings([{ coin: 'A', hours: 24, score: 10, t: 1 }, { coin: 'A', hours: 24, score: 50, t: 2 }, { coin: 'A', hours: 4, score: 99, t: 3 }]); return r.A.score === 50 })())
t('chart: value at a time is the last point at or before it', valueAt([[1, 5], [3, 7]], 2) === 5 && valueAt([[1, 5]], 0) === null)

console.log('-- the runner, through the real paper engine --')
const dir = fs.mkdtempSync(join(os.tmpdir(), 'agents-'))
const paperDir = join(dir, 'paper'), oracleDir = join(dir, 'oracle')
fs.mkdirSync(oracleDir, { recursive: true })
for (const [coin, c] of Object.entries(daily)) fs.writeFileSync(join(oracleDir, coin + '.json'), JSON.stringify({ coin, candles: { '1d': c } }))
const paperHost = createPaperHost({ dir: paperDir })
let clock = NOW
const mids = Object.fromEntries(Object.entries(daily).map(([c, k]) => [c, String(k.at(-1).c)]))
const uni = Object.keys(daily)
let calls = []
const post = async (body) => {
  calls.push(body.type)
  if (body.type === 'allMids') return { ...mids }
  if (body.type === 'metaAndAssetCtxs') return [{ universe: uni.map(n => ({ name: n, szDecimals: 3, maxLeverage: 20 })) }, uni.map(n => ({ funding: n === 'C1' ? '0.0001' : '0.000001' }))]
  return {}
}
const runner = createAgentRunner({ dir: join(dir, 'agents'), paperHost, post, readings: () => ({ C0: { score: 70, sigma: 0.02, t: clock - H } }), oracleDir, now: () => clock, log: { warn: () => {} } })
const origNow = Date.now
Date.now = () => clock
try {
  await runner.tick()
  const s1 = JSON.parse(fs.readFileSync(runner.summaryFile, 'utf8'))
  const by = Object.fromEntries(s1.agents.map(a => [a.id, a]))
  t('summary: all five agents, each starting at $1,000', s1.agents.length === 5 && s1.agents.every(a => a.start === 1000))
  t('hodl bought BTC at 1×', by.hodl.positions.length === 1 && by.hodl.positions[0].coin === 'BTC' && by.hodl.positions[0].lev === 1, by.hodl.positions)
  t('oracle opened C0 long with a stop', by.oracle.positions.some(p => p.coin === 'C0' && p.szi > 0) && by.oracle.stops.some(s => s.coin === 'C0'), by.oracle)
  t('momentum opened four, every one with a stop', by.momentum.positions.length === 4 && by.momentum.stops.length === 4, by.momentum.positions)
  t('funding shorted C1', by.funding.positions.some(p => p.coin === 'C1' && p.szi < 0), by.funding.journal)
  t('fees were paid: equity just under $1,000', by.momentum.equity < 1000 && by.momentum.equity > 995, by.momentum.equity)
  t('the journal says why', by.momentum.journal.every(j => j.kind === 'open' && j.why && j.px > 0))
  t('the secret is the server\'s, not in the repo', /^[0-9a-f]{64}$/.test(runner.secret()) && fs.existsSync(join(dir, 'agents', 'secret')))
  t('Hyperliquid was asked only for prices and limits', calls.every(c => c === 'allMids' || c === 'metaAndAssetCtxs'), calls)

  // An hour later the Oracle's call fades: the oracle agent closes, nobody else is due.
  clock += H + 1000
  calls = []
  const rd = runner
  const r2 = createAgentRunner({ dir: join(dir, 'agents'), paperHost, post, readings: () => ({ C0: { score: 5, sigma: 0.02, t: clock - 60e3 }, X: { score: 1, sigma: 0.02, t: clock } }), oracleDir, now: () => clock, log: { warn: () => {} } })
  await r2.tick()
  const s2 = JSON.parse(fs.readFileSync(r2.summaryFile, 'utf8'))
  const o2 = s2.agents.find(a => a.id === 'oracle')
  t('oracle closed C0 when its call faded, with a PnL and a reason', !o2.positions.length && o2.journal[0].kind === 'close' && Number.isFinite(o2.journal[0].pnl), o2.journal[0])
  t('its leftover stop was cancelled', !o2.stops.length)
  t('a closed coin cools down for a day', r2._state().agents.oracle.cool.C0 === clock + COOL_MS)
  t('a run the agents did not close is not journalled as a stop', !s2.agents.some(a => a.journal.some(j => j.kind === 'stop')))
  t('the equity curve gained a point', s2.agents.find(a => a.id === 'hodl').curve.length >= 2)

  // The price falls through a momentum long's stop: the server's paper tick fills it, and the
  // runner reads it as a stop-out on its next look.
  const mom = s2.agents.find(a => a.id === 'momentum')
  const longC = mom.positions.find(p => p.szi > 0).coin
  const stopPx = mom.stops.find(s => s.coin === longC).px
  mids[longC] = String(stopPx * 0.98)
  paperHost.tick({ marks: mids, assets: Object.fromEntries(uni.map(n => [n, { szDecimals: 3, maxLeverage: 20 }])), funding: {} })
  clock += 6 * 60e3
  await r2.tick()
  const s3 = JSON.parse(fs.readFileSync(r2.summaryFile, 'utf8'))
  const m3 = s3.agents.find(a => a.id === 'momentum')
  t('a stop filled by the paper tick shows as "stopped", with its loss', m3.journal[0].kind === 'stop' && m3.journal[0].coin === longC && m3.journal[0].pnl < 0, m3.journal[0])
  t('and the coin is not held any more', !m3.positions.some(p => p.coin === longC))
} finally { Date.now = origNow }

console.log('-- wiring --')
const srv = fs.readFileSync('serve-prod.js', 'utf8')
t('serve-prod runs it and serves /agents-data', srv.includes("createAgentRunner({") && srv.includes("url === '/agents-data'") && srv.includes('agentRunner.tick()'))
t('before the first run the answer is unknown (503), not an empty board', srv.includes(`res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"agents":null}')`))
t('it is not part of the bot server (shipping it never restarts a bot)', !fs.readFileSync('server.js', 'utf8').includes('agentrunner'))
const html = fs.readFileSync('index.html', 'utf8'), main = fs.readFileSync('src/main.js', 'utf8')
t('More → Agent Arena opens it', html.includes('onclick="window.__openAgents()"') && main.includes("import('./agentsview.js').then(m => m.openAgentArena({ t: _T }))"))
t('the dev server has a twin', fs.readFileSync('vite.config.js', 'utf8').includes("path === '/agents-data'"))
const view = fs.readFileSync('src/agentsview.js', 'utf8')
t('its tables scroll sideways (data-dragscroll)', (view.match(/class="ag-tbl-wrap" data-dragscroll/g) ?? []).length === 2)
t('.gitignore keeps the arena\'s data (and its secret) out of the repo', /^\/?data\/?$/m.test(fs.readFileSync('.gitignore', 'utf8')) || fs.readFileSync('.gitignore', 'utf8').includes('data/'))

fs.rmSync(dir, { recursive: true, force: true })
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
