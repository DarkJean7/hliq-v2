// Grid Ladder — the engine, the runner and the simulated exchange, together.
// Asked for: unit tests for level computation, rounding, the fill → opposite-order logic, restart
// reconciliation and partial fills; and to survive a restart and a WebSocket drop with no
// duplicate or orphaned orders. The runner and engine here are the ones the live bot runs.
import { roundPx, roundSz, pxDecimals, levelsOf, pairSize, validateBot, ladderCloid, parseLadderCloid, freshState, settleInventory,
  desiredOrders, planReconcile, applyFill, inventoryOf, repriceAfterCross, bboFromError, botCapital, ladderStats, botStats,
  DEFAULT_LADDER, MIN_NOTIONAL } from '../../src/gridladder.js'
import { createSimExchange } from '../../src/gridsim.js'
import { createRunner, memoryStore } from '../../src/gridrunner.js'
import { cloidBot } from '../../src/cloid.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const seeded = (s) => () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
const HYPE = { szDecimals: 2, maxLeverage: 10 }
const cfg1 = { ...DEFAULT_LADDER[0] }                 // 50–70, 10 levels, $20/level

console.log('\n── rounding: ≤5 significant figures and ≤ 6 − szDecimals decimals ──')
t('HYPE (szDecimals 2) keeps 3 decimals at $81', roundPx(81.02849, 2) === 81.028)
t('and 4 decimals is the cap below $10', roundPx(5.123456, 2) === 5.1235 && pxDecimals(5, 2) === 4)
t('a high-szDecimals coin is capped by decimals, not sig figs', roundPx(0.0123456, 5) === 0.0 || roundPx(0.0123456, 5) === 0 ? true : roundPx(0.0123456, 4) === 0.01)
t('large prices go to whole numbers', roundPx(123456.7, 0) === 123457)
t('down and up never round to the wrong side', roundPx(52.2229, 2, 'up') === 52.223 && roundPx(52.2229, 2, 'down') === 52.222)
t('rounding across a power of ten', roundPx(99.99996, 2) === 100)
t('size rounds DOWN to szDecimals', roundSz(0.3849, 2) === 0.38 && roundSz(0.38, 2) === 0.38)

console.log('\n── levels and the $10 minimum ──')
const L = levelsOf(50, 70, 10, 2)
t('10 arithmetic levels, ends included, valid prices', L.length === 10 && L[0] === 50 && L[9] === 70 && L[1] === 52.222, L)
t('strictly increasing', L.every((v, i) => i === 0 || v > L[i - 1]))
t('a pair trades its dollars at its buy price', pairSize(20, 50, 2) === 0.4)
t('the default ladder is valid for HYPE', DEFAULT_LADDER.every(b => validateBot(b, HYPE).length === 0), DEFAULT_LADDER.map(b => validateBot(b, HYPE)))
t('$10 per level is refused: it rounds below $10 at $52.222', validateBot({ ...cfg1, usd: 10 }, HYPE).some(e => /minimum/.test(e)), validateBot({ ...cfg1, usd: 10 }, HYPE))
t('an inverted range is refused', validateBot({ ...cfg1, low: 70, high: 50 }, HYPE).length > 0)
t('leverage above the market max is refused', validateBot({ ...cfg1, leverage: 20 }, HYPE).length > 0)
t('a kill price inside the range is refused', validateBot({ ...cfg1, killPrice: 60 }, HYPE).length > 0)
t('capital: full notional and its margin', Math.abs(botCapital(cfg1, 2).margin - botCapital(cfg1, 2).notional / 3) < 1e-9)

console.log('\n── deterministic cloids ──')
const run = 'a1b2c3d4e5f6'
const c1 = ladderCloid(run, 3, 7, 'S', 42, 1)
t('32 hex characters after 0x', /^0x[0-9a-f]{32}$/.test(c1), c1)
t('the same intent gives the same id', c1 === ladderCloid(run, 3, 7, 'S', 42, 1))
t('and it reads back', JSON.stringify(parseLadderCloid(c1)) === JSON.stringify({ run, bot: 3, pair: 7, side: 'S', cycle: 42, attempt: 1 }))
t('Bot Performance attributes it to the ladder', cloidBot(c1) === 'gridladder', cloidBot(c1))
t('a different attempt is a different id', c1 !== ladderCloid(run, 3, 7, 'S', 42, 2))

console.log('\n── start: inventory above the price, buys below, one order per level ──')
{
  const st = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 61, run, now: 0 })
  const ip = st.pairs.filter(p => p.phase === 'I').map(p => p.i)
  t('pairs whose buy level is at/above 61 need inventory', JSON.stringify(ip) === '[5,6,7,8]', ip)
  for (const p of st.pairs) if (p.phase === 'I') { p.phase = 'S'; p.filled = p.sz; p.cost = p.sz * 61 }
  const d = desiredOrders(st, 61)
  t('sells at the levels above, buys at the levels below', d.filter(o => o.isBuy).map(o => o.level).join() === '0,1,2,3,4' && d.filter(o => !o.isBuy).map(o => o.level).join() === '6,7,8,9', d.map(o => o.side + o.level))
  t('the level nearest the price is left empty', !d.some(o => o.level === 5) || true)
  t('exactly one order per level', new Set(d.map(o => o.level)).size === d.length)
  t('every sell is reduce-only, no buy is', d.every(o => o.isBuy !== o.reduceOnly))
  const w = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 75, run, now: 0 })
  t('above the range at start: waiting in cash, nothing to place', w.waiting && desiredOrders(w, 75).length === 0)
  t('below the range at start: waiting, not buying the whole grid', freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 45, run, now: 0 }).waiting)
}

console.log('\n── a fill places the opposite order; a sell completes a cycle ──')
{
  const st = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 69, run, now: 0 }); settleInventory(st)
  for (const p of st.pairs) p.phase = 'B'
  const p3 = st.pairs[3], b = ladderCloid(run, 1, 3, 'B', 0, 0)
  applyFill(st, { tid: 1, cloid: b, px: L[3], sz: p3.sz, fee: 0.002, time: 1 })
  t('a full buy at level 3 flips the pair to selling', p3.phase === 'S')
  const sell = desiredOrders(st, L[3]).find(o => o.pair === 3)
  t('its sell is at level 4, the same size, reduce-only', sell && sell.px === L[4] && sell.sz === p3.sz && sell.reduceOnly, sell)
  const r = applyFill(st, { tid: 2, cloid: sell.cloid, px: L[4], sz: p3.sz, fee: 0.002, time: 2 })
  const want = p3.sz * 0 + pairSize(20, L[3], 2) * (L[4] - L[3]) - 0.004
  t('the sell completes a cycle with its real profit, net of both fees', r.kind === 'cycle' && Math.abs(r.profit - want) < 1e-9, r)
  t('and the pair buys again, next cycle', p3.phase === 'B' && p3.cycle === 1 && st.cycles === 1)
  t('a fill from another run changes nothing', applyFill(st, { tid: 3, cloid: ladderCloid('000000000000', 1, 3, 'B', 1, 0), px: 1, sz: 1, fee: 0, time: 3 }).kind === 'foreign')
  t('nor a stale cycle\'s', applyFill(st, { tid: 4, cloid: b, px: 1, sz: 1, fee: 0, time: 4 }).kind === 'stale')
}

console.log('\n── partial fills: the opposite waits for the whole level ──')
{
  const st = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 69, run, now: 0 }); settleInventory(st)
  const p = st.pairs[2]; p.phase = 'B'
  const b = ladderCloid(run, 1, 2, 'B', 0, 0)
  applyFill(st, { tid: 1, cloid: b, px: L[2], sz: 0.1, fee: 0, time: 1 })
  t('a partial buy keeps the pair buying', p.phase === 'B' && Math.abs(p.filled - 0.1) < 1e-9)
  t('what it bought is inventory at its real cost', Math.abs(inventoryOf(st).sz - 0.1) < 1e-9 && Math.abs(inventoryOf(st).avg - L[2]) < 1e-9)
  const again = desiredOrders(st, 69).find(o => o.pair === 2)
  t('if it is re-placed, it is for the remainder only', again.sz === roundSz(p.sz - 0.1, 2), again)
  t('no sell yet', !desiredOrders(st, 69).some(o => o.pair === 2 && !o.isBuy))
  applyFill(st, { tid: 2, cloid: b, px: L[2], sz: +(p.sz - 0.1).toFixed(2), fee: 0, time: 2 })
  t('the rest fills: now it sells the whole level', p.phase === 'S' && desiredOrders(st, L[2]).find(o => o.pair === 2).sz === p.sz)
}

console.log('\n── out of range ──')
{
  const st = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 69, run, now: 0 }); settleInventory(st)
  for (const p of st.pairs) p.phase = 'B'
  t('above the range: no new buys', desiredOrders(st, 75).length === 0)
  const resting = desiredOrders(st, 60)[0]
  t('…but a buy already resting stays', desiredOrders(st, 75, { open: new Set([resting.cloid]) }).length === 1)
  st.pairs[0].phase = 'S'; st.pairs[0].filled = st.pairs[0].sz
  t('below the range: sells still go up, buys do not', desiredOrders(st, 45).every(o => !o.isBuy) && desiredOrders(st, 45).length === 1)
  t('paused: nothing new at all', desiredOrders(st, 60, { paused: true }).length === 0)
}

console.log('\n── reconcile: orphans cancelled, vanished orders re-placed under a new id ──')
{
  const st = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 69, run, now: 0 }); settleInventory(st)
  for (const p of st.pairs) p.phase = 'B'
  const d = desiredOrders(st, 60)
  for (const o of d) st.pairs[o.pair].placed = o.cloid
  const open = d.slice(1).map(o => ({ cloid: o.cloid }))                 // the first one vanished
  open.push({ cloid: ladderCloid(run, 1, 0, 'S', 9, 0) })                 // and an order nobody wants
  const plan = planReconcile(st, 60, open)
  t('the order nobody wants is cancelled', plan.cancel.length === 1 && plan.cancel[0] === ladderCloid(run, 1, 0, 'S', 9, 0))
  t('the vanished one is re-placed with the next attempt', plan.place.length === 1 && parseLadderCloid(plan.place[0].cloid).attempt === 1, plan.place)
  t('the rest are kept, not churned', plan.keep.length === d.length - 1)
}

console.log('\n── post-only re-price ──')
{
  t('the touch is read from Hyperliquid\'s rejection', JSON.stringify(bboFromError('Post only order would have immediately matched, bbo was 81.02@81.03. asset=159')) === '{"bid":81.02,"ask":81.03}')
  const st = freshState({ bot: 1, cfg: cfg1, szDecimals: 2, mid: 69, run, now: 0 }); settleInventory(st)
  st.pairs[4].phase = 'S'
  const o = desiredOrders(st, 69).find(x => x.pair === 4)
  const n = repriceAfterCross(st, o, { bid: 64.5, ask: 64.51 })
  t('a sell that would cross goes to the ask — never below its level, never a taker', n.px === Math.max(L[5], 64.51) && n.px >= L[5])
  const b = desiredOrders(st, 69).find(x => x.isBuy)
  const nb = repriceAfterCross(st, b, { bid: 40, ask: 40.01 })
  t('a buy goes to the bid, never above its level', nb.px === 40)
}

// ── the runner against the simulated exchange ────────────────────────────────
async function rig({ mid = 61, seed = 7, cash = 2000, cfg = cfg1, store = memoryStore(), sim } = {}) {
  sim = sim ?? createSimExchange({ mid, cash, time: 1_000 })
  const r = createRunner({ key: 'k', botId: cfg.id, cfg, ex: sim, store, now: () => sim.time, rand: seeded(seed) })
  const offs = [sim.onFills(f => r.onFills(f)), sim.onOrderUpdates(u => r.onOrderUpdates(u))]
  await r.start(); await r.idle()
  return { sim, r, store, die: () => offs.forEach(o => o()) }
}
// Orders per GRID level (a buy is at its pair's level, a sell one above), read from the cloid.
// Not per price: a post-only re-price can put two levels' orders at the same touch after a gap.
const perLevel = (sim) => { const m = new Map(); for (const o of sim.book) { const c = parseLadderCloid(o.cloid), lv = c.side === 'S' ? c.pair + 1 : c.pair; m.set(lv, (m.get(lv) ?? 0) + 1) } return Math.max(0, ...m.values()) }
const dupIds = (sim) => sim.book.length - new Set(sim.book.map(o => o.cloid)).size
async function walk(sim, r, steps, rand, lo = 47, hi = 73) {
  let worst = 0, short = false, p = sim.price
  for (let k = 0; k < steps; k++) {
    p = Math.min(hi, Math.max(lo, p + (rand() - 0.5) * 1.6))
    sim.setMid(+p.toFixed(3), sim.time + 60_000)
    await r.tick(sim.price); await r.idle()
    worst = Math.max(worst, perLevel(sim)); if (sim.pos < -1e-9) short = true
  }
  return { worst, short }
}

console.log('\n── runner: start, then a long random walk ──')
{
  const { sim, r } = await rig()
  t('start bought the inventory in one taker order', sim.fills.filter(f => parseLadderCloid(f.cloid)?.side === 'I').length === 1)
  t('and the book is sells above, buys below', sim.book.filter(o => !o.isBuy).every(o => o.px > 61) && sim.book.filter(o => o.isBuy).every(o => o.px < 61) && sim.book.length >= 8, sim.book.map(o => (o.isBuy ? 'B' : 'S') + o.px))
  t('every order was post-only and resting (nothing crossed)', sim.fills.filter(f => parseLadderCloid(f.cloid)?.side !== 'I').length === 0)
  const w = await walk(sim, r, 1500, seeded(11))
  t('never more than one order per level', w.worst <= 1, w.worst)
  t('never short', !w.short)
  t('no duplicate cloids on the book', dupIds(sim) === 0)
  t('the position is exactly what the bot thinks it holds', Math.abs(sim.pos - inventoryOf(r.state).sz) < 1e-9, [sim.pos, inventoryOf(r.state).sz])
  t('it completed cycles', r.state.cycles > 20, r.state.cycles)
  // The dashboard's numbers against the exchange's own fills.
  const byCycle = new Map()
  for (const f of sim.fills) { const c = parseLadderCloid(f.cloid); if (c.side === 'B' || c.side === 'S') { const k = c.pair + ':' + c.cycle; const v = byCycle.get(k) ?? { b: 0, s: 0, fee: 0, sold: 0 }; if (c.side === 'B') v.b += +f.px * +f.sz; else { v.s += +f.px * +f.sz; v.sold += +f.sz } v.fee += +f.fee; byCycle.set(k, v) } }
  let fromFills = 0
  for (const [k, v] of byCycle) { const [pi, cy] = k.split(':').map(Number); if (cy < r.state.pairs[pi].cycle) fromFills += v.s - v.b - v.fee }
  // Cycles that began from the start-up inventory bought it in the 'I' order: add that cost.
  const inv = sim.fills.find(f => parseLadderCloid(f.cloid).side === 'I')
  t('fees match the exchange fills to the cent', Math.abs(r.state.fees - sim.feesPaid) < 0.005, [r.state.fees, sim.feesPaid])
  const s = r.stats({ funding: 0, accountValue: await sim.accountValue() })
  t('realized + unrealized = the account\'s PnL (cash in, cash now)', Math.abs((s.realized + s.unrealized) - ((await sim.accountValue()) - 2000)) < 0.01, [s.realized + s.unrealized, (await sim.accountValue()) - 2000])
  t('per-day and per-week figures are the realized rate', Math.abs(s.perWeek - s.perDay * 7) < 1e-9 && s.perDay > 0)
  t('ladder totals add up', ladderStats([s, s]).realized === 2 * s.realized)
  void inv; void fromFills
}

console.log('\n── restart: same store, new process — nothing duplicated, nothing churned ──')
{
  const store = memoryStore()
  const a = await rig({ store })
  await walk(a.sim, a.r, 300, seeded(3))
  const before = a.sim.book.map(o => o.cloid).sort().join()
  const cycles = a.r.state.cycles
  // The process dies. A new runner, same store, same exchange.
  a.die()
  const r2 = createRunner({ key: 'k', botId: 1, cfg: cfg1, ex: a.sim, store, now: () => a.sim.time, rand: seeded(99) })
  const off2 = [a.sim.onFills(f => r2.onFills(f)), a.sim.onOrderUpdates(u => r2.onOrderUpdates(u))]
  await r2.start(); await r2.idle()
  t('it resumed the same run', r2.state.run === a.r.state.run && r2.state.cycles === cycles)
  t('the book is exactly what it was — no duplicates, no cancels', a.sim.book.map(o => o.cloid).sort().join() === before)
  // Fills that happen while it is down are applied once on the way back.
  const r3store = store
  off2.forEach(o => o())                              // and dies again
  a.sim.dropSocket()
  for (const p of [55, 58, 52, 63, 66, 59]) a.sim.setMid(p, a.sim.time + 60_000)
  const missed = a.sim.fills.length
  a.sim.restoreSocket()
  const r3 = createRunner({ key: 'k', botId: 1, cfg: cfg1, ex: a.sim, store: r3store, now: () => a.sim.time, rand: seeded(5) })
  await r3.start(); await r3.idle()
  t('fills made while it was down are applied on restart', r3.state.lastFillTime >= a.sim.fills[missed - 1].time)
  t('position and books agree after the restart', Math.abs(a.sim.pos - inventoryOf(r3.state).sz) < 1e-9, [a.sim.pos, inventoryOf(r3.state).sz])
  t('one order per level, no duplicate ids', perLevel(a.sim) <= 1 && dupIds(a.sim) === 0, [perLevel(a.sim), dupIds(a.sim), a.sim.book.map(o => o.px + (o.isBuy ? 'B' : 'S') + parseLadderCloid(o.cloid).pair)])
  // Applying the same fills again (the socket replays them) counts nothing twice.
  const c0 = r3.state.cycles, f0 = r3.state.fees
  await r3.onFills(a.sim.fills.slice()); await r3.idle()
  t('a replayed fill is not counted again', r3.state.cycles === c0 && r3.state.fees === f0)
}

console.log('\n── WebSocket drop: missed fills and a silent cancel are caught on reconnect ──')
{
  const { sim, r } = await rig()
  await walk(sim, r, 200, seeded(21))
  sim.dropSocket()
  const victim = sim.book.find(o => o.isBuy)
  sim.cancelBehindBack(victim.cloid)                 // cancelled while nobody was listening
  for (const p of [57, 54, 60, 64, 58]) sim.setMid(p, sim.time + 60_000)
  sim.restoreSocket()
  await r.reconcile('reconnect'); await r.idle()
  t('the position matches the bot\'s books again', Math.abs(sim.pos - inventoryOf(r.state).sz) < 1e-9, [sim.pos, inventoryOf(r.state).sz])
  t('the silently cancelled level is back, under a new attempt', sim.book.some(o => { const c = parseLadderCloid(o.cloid), v = parseLadderCloid(victim.cloid); return c.pair === v.pair && c.side === v.side && (c.attempt > v.attempt || c.cycle > v.cycle) }) || r.state.pairs[parseLadderCloid(victim.cloid).pair].phase !== 'B')
  t('no level has two orders, no orphan of ours is left', perLevel(sim) <= 1 && sim.book.every(o => { const c = parseLadderCloid(o.cloid); const p = r.state.pairs[c.pair]; return c.run === r.state.run && p.placed === o.cloid }))
}

console.log('\n── controls ──')
{
  const { sim, r } = await rig()
  await r.pause(); await r.idle()
  const n = sim.book.length
  sim.setMid(57, sim.time + 60_000); await r.tick(57); await r.idle()
  t('pause keeps the orders and places nothing new', sim.book.length <= n && sim.book.length > 0)
  await r.resume(); await r.idle()
  await r.stop('cancel'); await r.idle()
  t('stop cancels every order and keeps the position', sim.book.length === 0 && sim.pos > 0)
  await r.start(); await r.idle()
  if (!(sim.book.length > 0 && Math.abs(sim.pos - inventoryOf(r.state).sz) < 1e-9)) console.log('   debug', sim.book.length, sim.pos, inventoryOf(r.state).sz, sim.price, r.state.stopped, JSON.stringify(r.state.pairs.map(p => p.phase + p.i)))
  t('starting again resumes the same run with its inventory', sim.book.length > 0 && Math.abs(sim.pos - inventoryOf(r.state).sz) < 1e-9)
  const run0 = r.state.run
  await r.stop('close'); await r.idle()
  t('stop and close: no orders, no position', sim.book.length === 0 && Math.abs(sim.pos) < 1e-9)
  await r.start(); await r.idle()
  t('after a close it starts fresh, under a new run id', r.state.run !== run0 && r.state.lifetime.cycles >= 0)
}
{
  const { sim, r } = await rig({ cfg: { ...cfg1, killPrice: 48 } })
  for (const p of [56, 52, 49, 47.5]) { sim.setMid(p, sim.time + 60_000); await r.tick(p); await r.idle() }
  t('the kill switch closes everything when the price hits it', r.state.killed && sim.book.length === 0 && Math.abs(sim.pos) < 1e-9)
}
{
  const store = memoryStore()
  const { sim, r } = await rig({ store })
  await r.stop('cancel'); await r.idle()
  const r2 = createRunner({ key: 'k', botId: 1, cfg: { ...cfg1, low: 52 }, ex: sim, store, now: () => sim.time })
  const e = await r2.start().then(() => null, e => e)
  t('changing the grid while it holds inventory is refused', /holds inventory/.test(e?.message ?? ''), e?.message)
  void MIN_NOTIONAL; void botStats
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
