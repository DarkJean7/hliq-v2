// Grid Ladder — the SQLite store (strategies/_gridstore.js) and the backtest (src/gridbacktest.js).
// The store's one job: a fill and the state it changed are written together or not at all, so a
// restart can neither lose a fill nor count it twice. Needs Node 22+ (node:sqlite), which is
// what the server runs and what CI is pinned to.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sqliteStore, ladderKey } from '../../strategies/_gridstore.js'
import { createRunner } from '../../src/gridrunner.js'
import { createSimExchange } from '../../src/gridsim.js'
import { DEFAULT_LADDER, freshState, settleInventory, ladderCloid, parseLadderCloid, applyFill, inventoryOf } from '../../src/gridladder.js'
import { backtestLadder, candlePath, pickRegimes, fitLadder } from '../../src/gridbacktest.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const dir = mkdtempSync(join(tmpdir(), 'gl-'))
const file = join(dir, 'gl.db')
const cfg1 = { ...DEFAULT_LADDER[0] }

console.log('\n── fills and state are written together ──')
{
  const s = sqliteStore(file)
  const k = ladderKey('testnet', '0xABC', 1)
  t('keys are lower-cased and carry the network', k === 'testnet:0xabc:1')
  const st = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 69, run: 'abcdefabcdef', now: 0 }); settleInventory(st)
  s.save(k, st)
  const b = ladderCloid('abcdefabcdef', 1, 2, 'B', 0, 0)
  const fill = (tid) => ({ tid, cloid: b, px: 54.444, sz: 0.1, fee: 0.001, time: 10 + tid })
  let cur = s.load(k)
  s.applyFills(k, [fill(1)], (f) => applyFill(cur, f), () => cur)
  t('a fill changes the saved state', Math.abs(s.load(k).pairs[2].filled - 0.1) < 1e-9)
  s.applyFills(k, [fill(1)], (f) => applyFill(cur, f), () => cur)
  t('the same trade id again changes nothing', Math.abs(s.load(k).pairs[2].filled - 0.1) < 1e-9)
  // A crash halfway through a batch: nothing of it is kept, so the retry applies it whole.
  const before = JSON.stringify(s.load(k))
  let n = 0
  const e = (() => { try { s.applyFills(k, [fill(2), fill(3)], (f) => { if (++n === 2) throw new Error('crash'); return applyFill(cur, f) }, () => cur) } catch (x) { return x } })()
  t('a crash mid-batch rolls the whole batch back', e?.message === 'crash' && JSON.stringify(s.load(k)) === before)
  cur = s.load(k)
  s.applyFills(k, [fill(2), fill(3)], (f) => applyFill(cur, f), () => cur)
  t('and the retry applies both fills, once', Math.abs(s.load(k).pairs[2].filled - 0.3) < 1e-9)
  s.setControl(k, 'close')
  t('a stop mode is kept for the bot to read', s.control(k)?.cmd === 'close')
  s.clearControl(k)
  t('and cleared', s.control(k) === null)
  s.event(k, 'start', 'hello')
  t('events are kept, newest first', s.events(k, 5)[0]?.msg === 'hello')
  s.close()
  const s2 = sqliteStore(file)
  t('everything survives closing the file', Math.abs(s2.load(k).pairs[2].filled - 0.3) < 1e-9 && s2.all().length === 1)
  s2.close()
}

console.log('\n── a restart through the real file: nothing duplicated ──')
{
  const f2 = join(dir, 'restart.db')
  const sim = createSimExchange({ mid: 61, cash: 2000, time: 1000 })
  let s = sqliteStore(f2)
  const mk = (store, seed) => createRunner({ key: 'k', botId: 1, cfg: cfg1, ex: sim, store, now: () => sim.time, rand: () => ((seed = (seed * 16807) % 2147483647) / 2147483647) })
  let r = mk(s, 7)
  const offs = [sim.onFills(x => r.onFills(x)), sim.onOrderUpdates(u => r.onOrderUpdates(u))]
  await r.start(); await r.idle()
  for (const p of [59, 57, 60, 62, 58, 63, 65, 61]) { sim.setMid(p, sim.time + 60_000); await r.tick(p); await r.idle() }
  const book = sim.book.map(o => o.cloid).sort().join(), cycles = r.state.cycles
  offs.forEach(o => o()); s.close()                       // the process dies
  for (const p of [59, 56, 60]) sim.setMid(p, sim.time + 60_000)   // and the market moves on
  s = sqliteStore(f2)
  r = mk(s, 99)
  await r.start(); await r.idle()
  t('the new process resumes the same run', parseLadderCloid(sim.book[0]?.cloid)?.run === r.state.run)
  t('fills made while it was down are applied, cycles are not double-counted', r.state.cycles >= cycles && Math.abs(sim.pos - inventoryOf(r.state).sz) < 1e-9, [sim.pos, inventoryOf(r.state).sz])
  t('no cloid appears twice on the book', sim.book.length === new Set(sim.book.map(o => o.cloid)).size)
  void book
  s.close()
}

console.log('\n── backtest ──')
{
  const path = candlePath({ o: 100, h: 104, l: 99, c: 103 }, 0.01)
  t('a green candle goes down to its low before its high', path.indexOf(Math.min(...path)) < path.indexOf(Math.max(...path)))
  t('and the path is walked in small steps', path.length > 6 && path[0] === 100 && path.at(-1) === 103)
  const wave = Array.from({ length: 24 * 20 }, (_, i) => { const p = 80 + 12 * Math.sin(i / 9); return { t: 1_700_000_000_000 + i * 3_600_000, o: p, h: p + 0.6, l: p - 0.6, c: 80 + 12 * Math.sin((i + 1) / 9) } })
  const r = await backtestLadder({ candles: wave, funding: [{ time: 0, fundingRate: 0.0000125 }], bots: DEFAULT_LADDER })
  t('a range-bound market completes cycles and makes grid profit', r.cycles > 20 && r.realized > 0, [r.cycles, r.realized])
  t('fees and funding are charged', r.fees > 0 && r.funding > 0)
  t('the hold comparison is the same capital in HYPE', Math.abs(r.hold.pnl - r.capital * (r.endPx / r.startPx - 1)) < 1e-9)
  const crash = Array.from({ length: 24 * 10 }, (_, i) => { const p = 100 * Math.pow(0.988, i); return { t: 1_700_000_000_000 + i * 3_600_000, o: p, h: p * 1.002, l: p * 0.986, c: p * 0.988 } })
  const c = await backtestLadder({ candles: crash, bots: fitLadder(DEFAULT_LADDER, 100).map(b => ({ ...b, leverage: 5 })), cashMult: 1 })
  t('a leveraged ladder held through a crash is liquidated, and says so', c.liquidations > 0 && c.maxDrawdown > 0.5, [c.liquidations, c.maxDrawdown])
  const reg = pickRegimes([...wave, ...crash.map((x, i) => ({ ...x, t: wave.at(-1).t + (i + 1) * 3_600_000 }))], 5)
  t('the three regimes are picked from the data', reg.trending && reg.choppy && reg.crash && reg.crash.from > wave[0].t)
  t('fitting centres the ladder on a price', fitLadder(DEFAULT_LADDER, 40).every((b, i) => Math.abs(b.low - DEFAULT_LADDER[i].low / 2) < 0.01))
}

rmSync(dir, { recursive: true, force: true })
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
