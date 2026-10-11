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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 600))) }
const H = 3_600_000

async function runBot({ args, prices, hours, startOffsetH = 0.5, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pfbot-')), T0 = Math.floor(Date.now() / H) * H - 400 * H }) {
  const log = path.join(dir, 'journal.jsonl')
  // T0: history behind the start, for the warm-up. A restart passes the same T0 and dir.
  try { fs.rmSync(path.join(dir, 'journal.jsonl')) } catch {}
  const hist = 300
  const START = T0 + (hist + startOffsetH) * H
  const shifted = Object.fromEntries(Object.entries(prices).map(([c, st]) => [c, st.map(([h, p]) => [h + hist, p])]))
  const speed = 900
  const child = spawn(process.execPath, ['--import', 'file://' + path.join(root, 'tests', 'fakehl.mjs').replace(/\\/g, '/'), path.join(root, 'strategies', 'portfolio.js'), ...args], {
    cwd: dir, env: { ...process.env, AGENT_KEY: Wallet.createRandom().privateKey, HLIQ_BOT: 'portfolio', FAKE_T0: String(T0), FAKE_START: String(START), FAKE_SPEED: String(speed), FAKE_PRICES: JSON.stringify(shifted), FAKE_LOG: log, FAKE_STATE: path.join(dir, 'exchange.json') },
  })
  let out = ''
  child.stdout.on('data', d => { out += d }); child.stderr.on('data', d => { out += d })
  await new Promise(r => setTimeout(r, hours * H / speed))
  child.kill('SIGTERM')
  await new Promise(r => child.on('close', r))
  const journal = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.portfolio-state.json'), 'utf8') || '{}')
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

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
