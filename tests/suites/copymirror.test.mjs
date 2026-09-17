// Copy trade: what the bot does about each of the target's moves.
//
// Asked: "make sure copy trading feature works". Reading it against a live wallet found two
// ways it lost money, both from the old rule of "apply scale% of every size change":
//
//   1. Following starts from now, so the target's existing book is not copied. When they
//      closed that book, the bot sold — with nothing to reduce — and opened a SHORT.
//   2. The per-trade cap applied to exits. A copy built from several capped opens was left
//      mostly open after the target left in one fill; and under a cap, half of their position
//      could be all of ours, so a partial close emptied us.
//
// These run the real planner. Nothing here is a regex over the source except the wiring.
import fs from 'fs'
import { planMirror, burstStart, burstRange, reconcileMine, HL_MIN_ORDER } from '../../src/copymirror.js'

const bot = fs.readFileSync('strategies/copytrade.js', 'utf8')
const cli = fs.readFileSync('src/main.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b) => Math.abs(a - b) < 1e-9

const BASE = { scale: 0.25, maxUsd: 0, maxPosition: 0, markPx: 100, carry: 0, mine: 0 }
const plan = (o) => planMirror({ ...BASE, ...o })
const sum  = (r) => r.orders.reduce((s, o) => s + o.delta, 0)

console.log(nl + '-- the bug that opened a short: closing what we never copied --')
{
  // They were long 10 before we followed. They close it. We hold nothing of theirs.
  const r = plan({ theirBefore: 10, theirDelta: -10, mine: 0 })
  t('no order at all', r.orders.length === 0, r)
  t('and it says why', r.notes.some(n => n.includes('nothing copied')), r.notes)
  // Same, partially.
  t('a partial close of an uncopied position does nothing either',
    plan({ theirBefore: 10, theirDelta: -4, mine: 0 }).orders.length === 0)
  // A short they had before, now covered: must not open a long.
  t('covering an uncopied short does not open a long',
    plan({ theirBefore: -8, theirDelta: 8, mine: 0 }).orders.length === 0)
}

console.log(nl + '-- the bug that left us in: exits are uncapped and proportional --')
{
  // Our copy: 4 capped opens of $250 = 10 units at $100. They exit everything in one fill.
  const r = plan({ theirBefore: 400, theirDelta: -400, mine: 10, maxUsd: 250 })
  t('a full exit closes the WHOLE copy, past the $250 cap', near(sum(r), -10), r)
  t('reduce-only', r.orders.every(o => o.reduceOnly))
  t('labelled a close', r.orders[0]?.kind === 'close')

  // Under a cap, 25% of their half can exceed all of ours. The old rule emptied us.
  const h = plan({ theirBefore: 400, theirDelta: -200, mine: 10, maxUsd: 250 })
  t('their half-exit is OUR half-exit, not our whole position', near(sum(h), -5), h)
  const q = plan({ theirBefore: 10, theirDelta: -1, mine: 8 })
  t('a 10% trim trims 10%', near(sum(q), -0.8), q)
}

console.log(nl + '-- opens and adds --')
{
  t('an open is scale% of their size', near(sum(plan({ theirBefore: 0, theirDelta: 10 })), 2.5))
  t('an add is scale% of the add, not of the whole', near(sum(plan({ theirBefore: 10, theirDelta: 6, mine: 2.5 })), 1.5))
  t('a short open is a sell', near(sum(plan({ theirBefore: 0, theirDelta: -8 })), -2))
  t('opens are never reduce-only', plan({ theirBefore: 0, theirDelta: 10 }).orders.every(o => !o.reduceOnly))
  const c = plan({ theirBefore: 0, theirDelta: 100, maxUsd: 250 })
  t('the per-trade cap still limits new risk', near(sum(c), 2.5), c)
  t('and says so', c.notes.some(n => n.includes('per trade')))
  const p = plan({ theirBefore: 10, theirDelta: 10, mine: 4, maxPosition: 500 })
  t('max position trims an add to the room left', near(sum(p), 1), p)
  t('at the cap, nothing is added',
    plan({ theirBefore: 10, theirDelta: 10, mine: 5, maxPosition: 500 }).orders.length === 0)
}

console.log(nl + '-- the $10 minimum holds opens, never exits --')
{
  const s = plan({ theirBefore: 0, theirDelta: 0.2 })         // 0.05 × $100 = $5
  t('a $5 open is held back', s.orders.length === 0 && near(s.carry, 0.05), s)
  const s2 = plan({ theirBefore: 0.2, theirDelta: 0.2, carry: s.carry })
  t('and fires once it stacks past $10', near(sum(s2), 0.1) && s2.carry === 0, s2)
  const tiny = plan({ theirBefore: 1, theirDelta: -1, mine: 0.05 })
  t('a full exit below $10 still goes (HL exempts a full reduce-only close)',
    near(sum(tiny), -0.05) && tiny.orders[0].reduceOnly, tiny)
  const part = plan({ theirBefore: 10, theirDelta: -1, mine: 0.5 })
  t('a partial exit below $10 is skipped rather than rejected by HL', part.orders.length === 0, part)
  t('the minimum is Hyperliquid’s', HL_MIN_ORDER === 10)
  const drop = plan({ theirBefore: 0.2, theirDelta: -0.2, mine: 0, carry: 0.05 })
  t('pending opens on a side they just left are dropped', drop.carry === 0, drop)
}

console.log(nl + '-- a flip is a close then an open --')
{
  const f = plan({ theirBefore: 10, theirDelta: -30, mine: 2.5 })   // long 10 → short 20
  t('two orders', f.orders.length === 2, f)
  t('first closes the whole copy, reduce-only',
    near(f.orders[0].delta, -2.5) && f.orders[0].reduceOnly && f.orders[0].kind === 'close', f.orders[0])
  t('then opens scale% of their NEW side', near(f.orders[1].delta, -5) && !f.orders[1].reduceOnly, f.orders[1])
  const g = plan({ theirBefore: 10, theirDelta: -30, mine: 0 })
  t('a flip we never copied the old side of still copies the new side',
    g.orders.length === 1 && near(g.orders[0].delta, -5), g)
  const m = plan({ theirBefore: 10, theirDelta: -30, mine: 5, maxPosition: 300 })
  t('max position after a flip ignores the side being closed', near(m.orders[1].delta, -3), m)
}

console.log(nl + '-- only what the bot opened is ever closed --')
{
  t('a hand-held position larger than the copy: only the copy counts', reconcileMine(2, 7) === 2)
  t('the user closed part of it: we track what is left', reconcileMine(5, 3) === 3)
  t('the user closed it all: nothing to unwind', reconcileMine(5, 0) === 0)
  t('the account is now the other way: nothing to unwind', reconcileMine(5, -3) === 0)
  t('shorts reconcile the same way', reconcileMine(-5, -3) === -3)
  // Their exit while the copy is somehow on the opposite side must leave it alone.
  t('a copy on the other side is not touched by their exit',
    plan({ theirBefore: 10, theirDelta: -10, mine: -2 }).orders.length === 0)
}

console.log(nl + '-- reading where a burst started --')
{
  // A sweep: three fills in the same millisecond, long 0 → 3, reported in any order.
  const sweep = [
    { side: 'B', sz: '1', startPosition: '2', time: 5 },
    { side: 'B', sz: '1', startPosition: '0', time: 5 },
    { side: 'B', sz: '1', startPosition: '1', time: 5 },
  ]
  t('the head of a same-millisecond chain is found', burstStart(sweep) === 0, burstStart(sweep))
  t('otherwise the earliest fill', burstStart([
    { side: 'A', sz: '2', startPosition: '5', time: 9 },
    { side: 'A', sz: '1', startPosition: '8', time: 1 },
  ]) === 8)
  t('a flip in one fill reads its real start',
    burstStart([{ side: 'A', sz: '30', startPosition: '10', time: 1 }]) === 10)
  t('no start position → null, not zero', burstStart([{ side: 'B', sz: '1', time: 1 }]) === null)

  // A real replay had a gap: 1,021 ZEC of fills missing between two that were present.
  // Summing sizes put the trader at 1,320.91; the next fill said 300. Read both ends instead.
  const gap = [
    { side: 'A', sz: '500', startPosition: '2300', time: 1 },   // 2300 → 1800
    // … missing: 1800 → 779.09 …
    { side: 'A', sz: '479.09', startPosition: '779.09', time: 3 },  // 779.09 → 300
  ]
  const g = burstRange(gap)
  t('a gap does not invent a position: after is what the last fill says',
    g.before === 2300 && near(g.after, 300), g)
  t('where summing would have said 1,320.91',
    near(2300 + gap.reduce((s, f) => s - parseFloat(f.sz), 0), 1320.91))
  const sweepR = burstRange([
    { side: 'B', sz: '1', startPosition: '2', time: 5 },
    { side: 'B', sz: '1', startPosition: '0', time: 5 },
    { side: 'B', sz: '1', startPosition: '1', time: 5 },
  ])
  t('both ends of a same-millisecond sweep', sweepR.before === 0 && sweepR.after === 3, sweepR)
  t('the bot reads the range, not the sum', bot.includes('burstRange(cf)') && bot.includes('range.after - range.before'))
}

console.log(nl + '-- a whole round trip ends flat --')
{
  // Target: open 10, add 10, trim 5, add 15, close 30. Copy with a tight cap.
  const moves = [[0, 10], [10, 10], [20, -5], [15, 15], [30, -30]]
  let mine = 0, carry = 0, worst = 0
  for (const [before, delta] of moves) {
    const r = planMirror({ ...BASE, maxUsd: 150, theirBefore: before, theirDelta: delta, mine, carry })
    carry = r.carry
    for (const o of r.orders) mine += o.delta
    if (Math.sign(mine) < 0) worst = mine
  }
  t('never on the wrong side', worst === 0, worst)
  t('flat when they are flat', near(mine, 0), mine)
}

console.log(nl + '-- the bot uses it, and keeps its record across a restart --')
{
  t('the planner drives the loop', bot.includes('planMirror({'))
  t('the copy is reconciled against the account each time', bot.includes('reconcileMine(was, ours[coin] ?? 0)'))
  t('reduce-only comes from the plan', bot.includes('r: reduceOnly,'))
  t('the record is persisted', bot.includes(".copytrade-state.json"))
  t('with the fills already copied, so a resume cannot copy them twice', bot.includes('seen: [...seen].slice(-500)'))
  t('a paper copy never shares a record with a live one', bot.includes("DRY_RUN ? ':dry' : ''"))
  t('a missed exit is retried', bot.includes('await retryExits()'))
  t('a partially filled exit is retried too', bot.includes('if (o.reduceOnly && filledSz <'))
  t('a missed OPEN is not chased', bot.includes('open skipped'))
  // Exits are sized from the copy, which is held in exact lots. A plain floor turned 0.29 into
  // 0.28 and left a 0.01 stub open after every such close (also 0.57, 0.58, 1.13–1.16 …).
  t('lot rounding does not shave an exit', /Math\.floor\(Math\.abs\(parseFloat\(n\)\) \* factor \+ 1e-9\)/.test(bot))
  t('and a plain floor really would have', Math.floor(0.29 * 100) === 28)
  t('while the epsilon keeps it', Math.floor(0.29 * 100 + 1e-9) === 29)
  t('dry run places nothing', /if \(DRY_RUN\) return \{ filledSz: sz, avgPx: markPx \}/.test(bot))
  // Scoped to the sheet: "ct-mode" alone matched "select-mode" elsewhere in main.js, and
  // the accumulator already pushes --dry-run, so an unscoped check passed with no UI at all.
  const sheet = cli.slice(cli.indexOf('window.__lbCopyTrade = function'), cli.indexOf('window.__lbCopyTrade = function') + 12000)
  t('the sheet offers a dry run', sheet.includes('id="ct-mode-dry"'))
  t('and passes it to the bot', sheet.includes("argv.push('--dry-run')"))
  // The instance is the address for a wallet, "P:<name>" for a paper account, and either with
  // -DRY for a dry run — so none of the four can collide.
  t('a dry run is its own instance, so it can run beside a live copy', sheet.includes("base + '-DRY' : base"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
