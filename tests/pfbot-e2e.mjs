// strategies/portfolio.js run for real against a fake Hyperliquid (tests/fakehl.mjs), on a fast
// clock: the process, its SDK, its orders and its saved ledger are all the real ones; only the
// exchange is pretend. The suites check each decision; this checks the bot acts on them.
//
// Scenario (1-hour candles, Channel breakout, take profit 10%, stop 3%, BTC 60% / ETH 40%):
//   BTC sits at 100, breaks out to 106 on the candle after the bot starts, then runs to 118.
//   ETH stays flat.
// The backtest of exactly this takes two trades: long at 106, out at its +10% target as BTC
// runs; and long again at 118, because a close at 118 is itself a new 20-candle breakout. The
// bot must take the SAME two: set leverage; open each with one market order sized to BTC's
// sub-account; rest each one's target and stop on the exchange; when the first target fills,
// cancel its stop and book the profit; hold the second (never close a trade the backtest still
// holds); never trade ETH. Then the allocation side: buy & hold buys once.
//
// This harness found a real bug before it shipped: the replay was handed the sub-account's CASH,
// negative while a trade is open, so it refused its own trade and the bot sold it a candle later.
//
// Run:  node tests/pfbot-e2e.mjs        (about 40 seconds; no network)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Wallet } from 'ethers'
import { createPaperHost, ownerOf } from '../src/paperhost.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 600))) }
const H = 3_600_000

async function runBot({ args, prices, hours, startOffsetH = 0.5, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfbot-')), T0 = Math.floor(Date.now() / H) * H - 400 * H, env = {}, script = 'portfolio.js', preload = false }) {
  const log = path.join(dir, 'journal.jsonl')
  // T0: history behind the start, for the warm-up. A restart passes the same T0 and dir.
  try { fs.rmSync(path.join(dir, 'journal.jsonl')) } catch {}
  const hist = 300
  const START = T0 + (hist + startOffsetH) * H
  const shifted = Object.fromEntries(Object.entries(prices).map(([c, st]) => [c, st.map(([h, p]) => [h + hist, p])]))
  const speed = 900
  // The fake exchange first; then, for a bot on paper, the preload the server starts it with.
  const imp = (p) => ['--import', 'file://' + p.replace(/\\/g, '/')]
  const child = spawn(process.execPath, [...imp(path.join(root, 'tests', 'fakehl.mjs')), ...(preload ? imp(path.join(root, 'strategies', '_paperpreload.js')) : []), path.join(root, 'strategies', script), ...args], {
    cwd: dir, env: { ...process.env, AGENT_KEY: Wallet.createRandom().privateKey, HLIQ_BOT: script.replace(/\.js$/, ''), FAKE_T0: String(T0), FAKE_START: String(START), FAKE_SPEED: String(speed), FAKE_PRICES: JSON.stringify(shifted), FAKE_LOG: log, FAKE_STATE: path.join(dir, 'exchange.json'), ...env },
  })
  let out = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
  // Listened for from the start: a bot that dies on launch has closed before anyone waits.
  let exited = false
  const closed = new Promise(r => child.on('close', () => { exited = true; r() }))
  // Timed from the bot's first log line: until then it is loading, and its clock is not running.
  for (let i = 0; i < 300 && !exited && !/\[START/.test(out); i++) await new Promise(r => setTimeout(r, 100))
  await new Promise(r => setTimeout(r, hours * H / speed))
  child.kill('SIGTERM')
  await closed
  const journal = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  // A ledger the bot never saved is no ledger: null, and the assertions say so — not a crash.
  let state = {}
  try { state = JSON.parse(fs.readFileSync(path.join(dir, '.portfolio-state.json'), 'utf8') || '{}') } catch {}
  return { out, journal, state: Object.values(state)[0], dir, T0 }
}
const items = Buffer.from(JSON.stringify([{ coin: 'BTC', w: 60 }, { coin: 'ETH', w: 40 }])).toString('base64')
const base = ['--address', '0x0000000000000000000000000000000000000001', '--id', 'E2E', '--items', items, '--budget', '1000', '--leverage', '2', '--run', 'r1']

console.log('\n-- a trading strategy: Channel breakout on every holding --')
{
  const sp = Buffer.from(JSON.stringify({ breakoutLookback: 20, takeProfitPct: 10, stopLossPct: 3 })).toString('base64')
  const r = await runBot({ args: [...base, '--strategy', 'bot:breakout', '--tf', '1h', '--sparams', sp], prices: { BTC: [[0, 100], [1, 106], [3, 118]], ETH: [[0, 50]] }, hours: 5 })
  const j = r.journal
  if (process.env.E2E_DEBUG) console.log(r.out)
  const iocs = j.filter(e => e.ev === 'ioc'), trig = j.filter(e => e.ev === 'trigger')
  ok('leverage set on both markets, cross', j.filter(e => e.ev === 'leverage').length === 2 && j.every(e => e.ev !== 'leverage' || (e.isCross && e.leverage === 2)), j.filter(e => e.ev === 'leverage'))
  ok('the breakout is bought with one market order, sized to BTC\'s sub-account: $600 at 2× ≈ 11.32 BTC', iocs[0]?.coin === 'BTC' && iocs[0].isBuy && Math.abs(iocs[0].sz - 1200 / 106) < 0.01, iocs)
  ok('it is stamped as the portfolio bot\'s order', /^0xb070e/.test(iocs[0]?.cloid ?? ''), iocs[0]?.cloid)
  const tp = trig.find(e => e.tpsl === 'tp'), sl = trig.find(e => e.tpsl === 'sl')
  ok('a target at +10% and a stop at −3% rest on the exchange, reduce-only, for the whole position', tp && sl && Math.abs(tp.trig - 116.6) < 0.1 && Math.abs(sl.trig - 102.82) < 0.1 && tp.reduceOnly && sl.reduceOnly && tp.sz === iocs[0].sz && !tp.isBuy, trig)
  ok('the target fills when BTC runs past it', j.some(e => e.ev === 'triggered' && e.tpsl === 'tp'))
  ok('and the bot cancels the stop it no longer needs', j.some(e => e.ev === 'cancel' && e.oid === sl?.oid))
  const sub = r.state?.subs?.BTC
  const won = 600 + iocs[0].sz * (116.6 - 106) - iocs[0].sz * (106 + 116.6) * 0.00045
  ok('the profit is booked, and the second trade is sized from it: ($600 + 11.32 × 10.6 − fees) × 2 ÷ 118', iocs[1]?.isBuy && Math.abs(iocs[1].sz - won * 2 / 118) < 0.01, [iocs[1], won])
  ok('the live trades are the backtest\'s: in at 106, out at the target, in again at 118', iocs.filter(e => e.isBuy).map(e => e.px).join() === '106,118' && j.filter(e => e.ev === 'triggered').map(e => e.px).join() === '116.6', iocs)
  ok('the second is held with its own target and stop resting: never closed while the backtest holds it', sub?.trade?.entry === 118 && !!sub.trade.tpOid && !!sub.trade.slOid && !iocs.some(e => e.reduceOnly), sub)
  ok('ETH, flat, is never traded', !j.some(e => (e.ev === 'ioc' || e.ev === 'trigger') && e.coin === 'ETH'))
  ok('the log says what it did', /OPEN\s*\]?\s*BTC long/.test(r.out.replace(/\s+/g, ' ')) || /BTC long/.test(r.out), r.out.slice(-1500))
  ok('no errors', !/\[ERROR/.test(r.out), r.out.split('\n').filter(l => /ERROR/.test(l)))
}

console.log('\n-- an allocation strategy: buy & hold --')
{
  const r = await runBot({ args: [...base, '--strategy', 'hold', '--interval', '1'], prices: { BTC: [[0, 100], [2, 120]], ETH: [[0, 50]] }, hours: 3 })
  const iocs = r.journal.filter(e => e.ev === 'ioc')
  ok('buys the weights once at 2×: $1,200 of BTC (12) and $800 of ETH (16)', iocs.length === 2 && iocs.some(e => e.coin === 'BTC' && Math.abs(e.sz - 12) < 1e-6) && iocs.some(e => e.coin === 'ETH' && Math.abs(e.sz - 16) < 1e-6), iocs)
  ok('and holds: equity follows BTC to 120 (1000 + 12 × 20, less fees)', r.state && Math.abs(r.state.equity - (1000 + 240 - 2000 * 0.00045)) < 0.5, r.state?.equity)
  ok('no errors', !/\[ERROR/.test(r.out), r.out.split('\n').filter(l => /ERROR/.test(l)))
}

console.log('\n-- a restart (deploy, reboot) never buys twice --')
{
  // Buy & hold for two hours, stopped, then resumed with the same arguments, as the server does.
  const args = [...base, '--strategy', 'hold', '--interval', '1']
  const prices = { BTC: [[0, 100]], ETH: [[0, 50]] }
  const a = await runBot({ args, prices, hours: 2 })
  const b = await runBot({ args: [...args, '--resume'], prices, hours: 2, dir: a.dir, T0: a.T0, startOffsetH: 2.5 })
  ok('the first run buys', a.journal.filter(e => e.ev === 'ioc').length === 2)
  ok('the resumed run carries on from the ledger and buys nothing', /carrying on from the saved ledger/.test(b.out) && b.journal.filter(e => e.ev === 'ioc').length === 0, b.journal)
  // Even with --fresh among the saved arguments, the same run id carries on.
  const b2 = await runBot({ args: [...args, '--fresh', '--resume'], prices, hours: 1, dir: a.dir, T0: a.T0, startOffsetH: 5 })
  ok('a restart of a run that began with --fresh still carries on: the run id is the same', /carrying on/.test(b2.out) && b2.journal.filter(e => e.ev === 'ioc').length === 0, b2.journal)
  // A NEW launch asking to start over is a new run id: that one does start fresh.
  const c = await runBot({ args: [...args.map(x => (x === 'r1' ? 'r2' : x)), '--fresh'], prices, hours: 1, dir: a.dir, T0: a.T0, startOffsetH: 7 })
  ok('only a new launch with --fresh starts a new ledger', /new ledger/.test(c.out))
  // The trading side: a trade held across a restart keeps its stop and target, and is not re-entered.
  const sp = Buffer.from(JSON.stringify({ breakoutLookback: 20, takeProfitPct: 10, stopLossPct: 3 })).toString('base64')
  const targs = [...base, '--strategy', 'bot:breakout', '--tf', '1h', '--sparams', sp]
  const tprices = { BTC: [[0, 100], [1, 106]], ETH: [[0, 50]] }
  const d = await runBot({ args: targs, prices: tprices, hours: 2.5 })
  const e = await runBot({ args: [...targs, '--resume'], prices: tprices, hours: 2, dir: d.dir, T0: d.T0, startOffsetH: 3 })
  ok('the trading bot opened once before the restart', d.journal.filter(x => x.ev === 'ioc').length === 1, d.journal)
  ok('and after it holds the same trade: no new order, no close', e.journal.filter(x => x.ev === 'ioc' || x.ev === 'trigger').length === 0 && e.state?.subs?.BTC?.trade?.entry === 106, [e.journal, e.state?.subs?.BTC])
}

console.log('\n-- spot (@5 is a spot pair: balances, spot USDC, 1×, long only) --')
{
  const enc = (x) => Buffer.from(JSON.stringify(x)).toString('base64')
  const sbase = (its, id) => ['--address', '0x0000000000000000000000000000000000000001', '--id', id, '--items', enc(its), '--budget', '1000', '--leverage', '2', '--run', 'r' + id]
  // Buy & hold, half BTC (perp, 2×) and half @5 (spot, at 10).
  const a = await runBot({ args: [...sbase([{ coin: 'BTC', w: 50 }, { coin: '@5', w: 50, kind: 'spot' }], 'S1'), '--strategy', 'hold', '--interval', '1'], prices: { BTC: [[0, 100]], '@5': [[0, 10]] }, hours: 1 })
  const io = a.journal.filter(e => e.ev === 'ioc')
  const sp = io.find(e => e.coin === '@5'), perp = io.find(e => e.coin === 'BTC')
  ok('the spot holding is bought as spot, at 1×: $500 of @5 at 10 = 50', sp?.spot && sp.isBuy && Math.abs(sp.sz - 50) < 1e-9 && !sp.reduceOnly, io)
  ok('the perp beside it keeps its leverage: $500 at 2× = 10 BTC', Math.abs((perp?.sz ?? 0) - 10) < 1e-9)
  ok('leverage is set on the perp only — spot has none to set', a.journal.filter(e => e.ev === 'leverage').length === 1)
  ok('the ledger holds the spot units, and its equity counts them', Math.abs((a.state?.units?.['@5'] ?? 0) - 50) < 1e-9 && Math.abs(a.state.equity - (1000 - 500 * 0.0007 - 1000 * 0.00045)) < 0.05, a.state)
  ok('no errors', !/\[ERROR/.test(a.out), a.out.split('\n').filter(l => /ERROR/.test(l)))
  // Not enough USDC in the SPOT balance: the bot says so before it tries, and does not count the rebalance done.
  const b = await runBot({ args: [...sbase([{ coin: 'BTC', w: 50 }, { coin: '@5', w: 50, kind: 'spot' }], 'S2'), '--strategy', 'hold', '--interval', '1'], prices: { BTC: [[0, 100]], '@5': [[0, 10]] }, hours: 0.2, env: { FAKE_SPOT_USDC: '100' } })
  ok('short of spot USDC: it says how much spot needs and that an agent key cannot move it', /spot buys need ~\$500\.00 of USDC in the SPOT balance; it has \$100\.00/.test(b.out) && b.journal.some(e => e.ev === 'spot-refused'), b.out.split('\n').filter(l => /WARN|ERROR/.test(l)))
  ok('and tries again rather than marking the rebalance done', b.state?.lastRebal == null)
  // A short spot holding cannot exist: skipped and said.
  const c = await runBot({ args: [...sbase([{ coin: 'BTC', w: 50 }, { coin: '@5', w: 50, side: 'short' }], 'S3'), '--strategy', 'hold', '--interval', '1'], prices: { BTC: [[0, 100]], '@5': [[0, 10]] }, hours: 0.2 })
  ok('a short spot holding is skipped, and the log says why', /skipped \(a spot holding cannot be short\): @5/.test(c.out) && !c.journal.some(e => e.coin === '@5'))
  // A trading strategy on spot: the breakout bought; the bot itself is its target (no trigger orders on spot).
  const sp2 = Buffer.from(JSON.stringify({ breakoutLookback: 20, takeProfitPct: 10, stopLossPct: 3 })).toString('base64')
  const d = await runBot({ args: [...sbase([{ coin: '@5', w: 100, kind: 'spot' }], 'S4'), '--strategy', 'bot:breakout', '--tf', '1h', '--sparams', sp2], prices: { '@5': [[0, 10], [1, 10.6], [3, 11.8]] }, hours: 3.6 })
  const dio = d.journal.filter(e => e.ev === 'ioc')
  ok('the spot breakout is bought at 1×: $1,000 at 10.6 = 94.33', dio[0]?.isBuy && Math.abs(dio[0].sz - 94.33) < 1e-9, dio)
  ok('no trigger orders are placed on spot', !d.journal.some(e => e.ev === 'trigger'))
  ok('the bot sells it itself when its +10% target is reached', dio[1] && !dio[1].isBuy && Math.abs(dio[1].sz - 94.33) < 1e-9 && /its target was reached/.test(d.out), [dio, d.out.split('\n').filter(l => /CLOSE|ERROR/.test(l))])
  ok('no errors', !/\[ERROR/.test(d.out), d.out.split('\n').filter(l => /ERROR/.test(l)))
}

console.log('\n-- paper: the same bot, on a paper account (src/paperexchange.js) --')
{
  // An owner with a $1,000 paper account made for the bot, as the page makes it.
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfpaper-'))
  const host = createPaperHost({ dir: pdir })
  const secret = 'a1'.repeat(32)
  host.sync({ secret, client: 'testclient', push: { hliq_paper_s_bot1: JSON.stringify({ balance: 1000, positions: [], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1000, created: 0 }) } })
  const paperStore = () => JSON.parse(host.read(ownerOf(secret)).kv.hliq_paper_s_bot1.v)
  const sp = Buffer.from(JSON.stringify({ breakoutLookback: 20, takeProfitPct: 10, stopLossPct: 3 })).toString('base64')
  const pargs = ['--address', '0x' + ownerOf(secret), '--id', 'PAPER1', '--items', items, '--budget', '1000', '--leverage', '2', '--run', 'p1', '--strategy', 'bot:breakout', '--tf', '1h', '--sparams', sp, '--paper', 'bot1']
  const r = await runBot({ args: pargs, prices: { BTC: [[0, 100], [1, 106]], ETH: [[0, 50]] }, hours: 2.5, env: { AGENT_KEY: secret, PAPER_DIR: pdir } })
  const st = paperStore()
  if (process.env.E2E_DEBUG) console.log(r.out)
  ok('NOTHING reaches the exchange: no order, cancel or leverage call arrived there', !r.journal.some(e => ['ioc', 'trigger', 'cancel', 'leverage', 'ioc-miss'].includes(e.ev)), r.journal)
  ok('the breakout is bought in the paper account instead: 11.32 BTC at 106 plus paper slippage', Math.abs((st.positions[0]?.szi ?? 0) - 1200 / 106) < 0.01 && Math.abs(st.positions[0].entryPx - 106 * 1.0003) < 0.01, st.positions)
  ok('paper charges the fee a person would pay (taker, 0.045%)', Math.abs(Number(st.fills[0]?.fee) - st.positions[0].szi * st.positions[0].entryPx * 0.00045) < 0.01, st.fills[0])
  const trig = st.orders.filter(o => o.isTrigger)
  ok('its target and stop rest in the paper account, reduce-only', trig.length === 2 && trig.every(o => o.reduceOnly && !o.isBuy) && trig.some(o => o.tpsl === 'tp' && Math.abs(o.triggerPx - 116.6 * 1.0003) < 0.1), trig)
  ok('the bot holds the trade in its ledger, sized as live would be', Math.abs((r.state?.subs?.BTC?.trade?.sz ?? 0) - st.positions[0].szi) < 1e-9, r.state?.subs?.BTC)
  ok('no errors', !/\[ERROR/.test(r.out), r.out.split('\n').filter(l => /ERROR/.test(l)))
  // The server's paper tick fills the target with the app closed; the bot, resumed, books it.
  host.tick({ marks: { BTC: '118' }, assets: { BTC: { szDecimals: 4, maxLeverage: 20 } }, funding: {} })
  ok('the server\'s paper tick fills the target', !paperStore().positions.length && paperStore().fills[0]?.dir === 'Close Long')
  const r2 = await runBot({ args: [...pargs, '--resume'], prices: { BTC: [[0, 100], [1, 106], [2.6, 118]], ETH: [[0, 50]] }, hours: 1.5, dir: r.dir, T0: r.T0, startOffsetH: 3, env: { AGENT_KEY: secret, PAPER_DIR: pdir } })
  const sub = r2.state?.subs?.BTC
  ok('the bot sees it closed and books the paper fill price, not a guess', sub && !(sub.trade?.time === r.state.subs.BTC.trade.time) && /closed on the exchange/.test(r2.out), [sub, r2.out.split('\n').filter(l => /CLOSE|ERROR/.test(l))])
  ok('still nothing reached the exchange', !r2.journal.some(e => ['ioc', 'trigger', 'cancel', 'leverage'].includes(e.ev)))
  // Spot on paper: bought into the paper account's spot balances, paid in full, at the spot fee.
  host.sync({ secret, client: 'testclient', seen: Object.fromEntries(Object.entries(host.read(ownerOf(secret)).kv).map(([k, x]) => [k, x.rev])), push: { hliq_paper_s_spot1: JSON.stringify({ balance: 1000, positions: [], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1000, created: 0 }) } })
  const sitems = Buffer.from(JSON.stringify([{ coin: 'BTC', w: 50 }, { coin: '@5', w: 50, kind: 'spot' }])).toString('base64')
  const r3 = await runBot({ args: ['--address', '0x' + ownerOf(secret), '--id', 'PSPOT', '--items', sitems, '--budget', '600', '--leverage', '2', '--run', 'p3', '--strategy', 'hold', '--interval', '1', '--paper', 'spot1'], prices: { BTC: [[0, 100]], '@5': [[0, 10]] }, hours: 1, env: { AGENT_KEY: secret, PAPER_DIR: pdir } })
  const ss = JSON.parse(host.read(ownerOf(secret)).kv.hliq_paper_s_spot1.v)
  ok('spot on paper lands in the paper account\'s spot balances: $300 of @5 at 10 (+ slippage) ≈ 30', Math.abs((ss.balances?.['@5']?.total ?? 0) - 30) < 0.01 && ss.fills.some(x => x.dir === 'Buy' && x.coin === '@5'), [ss.balances, ss.fills.slice(0, 3)])
  ok('paid in full at the paper spot fee (0.07%), the perp beside it margined at 2×', Math.abs(Number(ss.fills.find(x => x.coin === '@5').fee) - 30 * 10 * 1.0003 * 0.0007) < 0.01 && Math.abs((ss.positions.find(x => x.coin === 'BTC')?.szi ?? 0) - 6) < 1e-9, ss)
  ok('and still nothing reached the exchange', !r3.journal.some(e => ['ioc', 'trigger', 'cancel', 'leverage'].includes(e.ev)) && !/\[ERROR/.test(r3.out), r3.out.split('\n').filter(l => /ERROR/.test(l)))
  fs.rmSync(pdir, { recursive: true, force: true })
}

console.log('\n-- any bot on paper: strategies/_paperpreload.js, as the server starts them --')
{
  const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfany-'))
  const host = createPaperHost({ dir: pdir })
  const secret = 'b2'.repeat(32), owner = '0x' + ownerOf(secret)
  const blank = JSON.stringify({ balance: 1000, positions: [], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1000, created: 0 })
  host.sync({ secret, client: 'testclient', push: { hliq_paper_s_tr1: blank, hliq_paper_s_gr1: blank } })
  const acct = (slot) => JSON.parse(host.read(ownerOf(secret)).kv['hliq_paper_s_' + slot].v)
  const env = { AGENT_KEY: secret, PAPER_DIR: pdir }
  const exchangeHit = (j) => j.some(e => ['ioc', 'trigger', 'cancel', 'leverage', 'ioc-miss', 'spot-refused'].includes(e.ev))
  // A steady rise: the fast EMA above the slow one, so the Trend bot goes long.
  const rising = { BTC: Array.from({ length: 61 }, (_, i) => [i - 60, 70 + i * 0.5]) }
  const tr = await runBot({ script: 'trend.js', preload: true, args: ['--address', owner, '--coin', 'BTC', '--size', '200', '--leverage', '2', '--interval', '1', '--candle-tf', '1h', '--paper', 'tr1'], prices: rising, hours: 0.5, env })
  const ta = acct('tr1')
  ok('the Trend bot, unchanged, trades the paper account: long BTC for its $200', ta.positions[0]?.coin === 'BTC' && ta.positions[0].szi > 0 && Math.abs(ta.positions[0].szi * ta.positions[0].entryPx - 200) < 2, [ta.positions, tr.out.split('\n').filter(l => /ERROR|OPEN|ORDER/.test(l)).slice(0, 4)])
  ok('at the leverage it set — on the paper account', ta.positions[0]?.leverage === 2)
  ok('and nothing reaches the exchange', !exchangeHit(tr.journal), tr.journal.slice(0, 5))
  // The Grid bot: a ladder of resting buys, in the paper account's orders.
  const gr = await runBot({ script: 'grid.js', preload: true, args: ['--address', owner, '--coin', 'BTC', '--levels', '5', '--size', '20', '--leverage', '2', '--interval', '5', '--paper', 'gr1'], prices: { BTC: [[0, 100]] }, hours: 0.3, env })
  const ga = acct('gr1')
  ok('the Grid bot rests its ladder in the paper account', ga.orders.filter(o => !o.isTrigger && o.isBuy).length >= 2, [ga.orders.length, gr.out.split('\n').filter(l => /ERROR|WARN/.test(l)).slice(0, 4)])
  ok('nothing reaches the exchange', !exchangeHit(gr.journal), gr.journal.slice(0, 5))
  ok('no errors from either', !/\[ERROR/.test(tr.out + gr.out), (tr.out + gr.out).split('\n').filter(l => /ERROR/.test(l)).slice(0, 5))
  fs.rmSync(pdir, { recursive: true, force: true })
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
