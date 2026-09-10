// Many orders, one intent: a grid's ladder folded into a single row.
//
// Asked for after positions got the same treatment. The win is real — a grid rests twelve buys
// on one coin at twelve prices, and ninety-one open orders is mostly that — but the fold has to
// know what may NOT be joined. A resting limit sell, a take profit and a stop loss can all be
// "sell SOL", and they are three different intentions. Folding a stop in with a take profit
// would report a ladder nobody placed and hide the one order that closes a losing trade.
import fs from 'fs'
import { groupOrders, aggregateOrderGroup, orderSide, orderKind, orderPx,
         orderGroupKey, nearestAwayPct, ORDER_KIND_LABEL,
         expectedPnl, groupExpectedPnl } from '../../src/ordergroup.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

const o = (over = {}) => ({ coin: 'SOL', side: 'B', sz: '10', limitPx: '100', oid: 1, ...over })

console.log(nl + '-- reading one order --')
t('B is a buy', orderSide(o()) === 'buy')
t('A is a sell', orderSide(o({ side: 'A' })) === 'sell')
t('and the word forms too', orderSide(o({ side: 'sell' })) === 'sell' && orderSide(o({ side: 'buy' })) === 'buy')
t('the resting price is the limit', orderPx(o()) === 100)
// triggerPx arrives as the STRING "0.0" on a plain limit, so ?? never falls through.
t('a trigger wins when there is one', orderPx(o({ triggerPx: '95' })) === 95)
t('and "0.0" is not a trigger', orderPx(o({ triggerPx: '0.0' })) === 100)
t('a take profit is its own kind', orderKind(o({ orderType: 'Take Profit Market' })) === 'tp')
t('so is a stop', orderKind(o({ orderType: 'Stop Market' })) === 'sl')
t('the trigger condition names it too', orderKind(o({ triggerCondition: 'sl' })) === 'sl')
t('reduce-only is distinct from a plain limit', orderKind(o({ reduceOnly: true })) === 'reduce')
t('and a plain limit is a limit', orderKind(o()) === 'limit')
t('every kind has a label', ['tp', 'sl', 'reduce', 'limit'].every(k => ORDER_KIND_LABEL[k]))

console.log(nl + '-- what joins --')
{
  const ladder = [110, 105, 100, 95].map((px, i) => o({ limitPx: String(px), oid: i }))
  const gs = groupOrders(ladder)
  t('a ladder of one coin and side is ONE group', gs.length === 1 && gs[0].length === 4)
  const g = aggregateOrderGroup(gs[0])
  t('the count is the rung count', g.n === 4)
  t('sizes add up', g.totSz === 40)
  t('notional adds up', near(g.notional, 10 * (110 + 105 + 100 + 95)))
  t('the average is size-weighted', near(g.avgPx, 102.5))
  t('and the RANGE is what a ladder actually looks like', g.loPx === 95 && g.hiPx === 110)
  t('which is flagged as a spread', g.spread === true)
  // Arrival order is the caller's sort; re-ordering here would override the tapped column.
  t('the group keeps the order it arrived in', gs[0][0].oid === 0 && gs[0][3].oid === 3)
}

console.log(nl + '-- and what does NOT --')
{
  // The important one. All three are "sell SOL".
  const mixed = [
    o({ side: 'A', orderType: 'Limit' }),
    o({ side: 'A', orderType: 'Take Profit Market', triggerPx: '120' }),
    o({ side: 'A', orderType: 'Stop Market', triggerPx: '80' }),
  ]
  const gs = groupOrders(mixed)
  t('a limit, a take profit and a stop stay three groups', gs.length === 3, String(gs.length))
  t('why is written down',
    fs.readFileSync('src/ordergroup.js', 'utf8').includes('hide the one order that closes a losing trade'))
  t('opposite sides do not join', groupOrders([o(), o({ side: 'A' })]).length === 2)
  t('different coins do not join', groupOrders([o(), o({ coin: 'HYPE' })]).length === 2)
  t('reduce-only is kept apart from a plain limit',
    groupOrders([o(), o({ reduceOnly: true })]).length === 2)
  t('the key carries all three', orderGroupKey(o()) === 'SOL|buy|limit')
}

console.log(nl + '-- a stack at one price is not a range --')
{
  const g = aggregateOrderGroup([o(), o({ oid: 2 })])
  t('the low and the high are the same', g.loPx === 100 && g.hiPx === 100)
  // "$0.21 – $0.21" reads as a bug rather than a fact.
  t('so it is not called a spread', g.spread === false)
  t('and the average is that price', g.avgPx === 100)
}

console.log(nl + '-- the nearest rung is the one about to fill --')
{
  const g = aggregateOrderGroup([110, 105, 100].map(px => o({ limitPx: String(px) })))
  t('of a whole ladder, the closest is reported', near(nearestAwayPct(g, 101), (100 - 101) / 101 * 100))
  t('it keeps its sign', nearestAwayPct(g, 90) > 0 && nearestAwayPct(g, 120) < 0)
  t('no mark means no answer, not zero', nearestAwayPct(g, 0) === null)
  t('and no members means no answer', nearestAwayPct({ members: [] }, 100) === null)
}

console.log(nl + '-- the edges --')
{
  t('nothing to group does not throw', groupOrders([]).length === 0 && groupOrders(undefined).length === 0)
  t('an empty group aggregates to zero, not NaN',
    aggregateOrderGroup([]).n === 0 && aggregateOrderGroup([]).totSz === 0)
  t('a zero-price order does not drag the range to zero',
    aggregateOrderGroup([o({ limitPx: '0' }), o({ limitPx: '100' })]).loPx === 100)
  t('a negative size is counted by magnitude', aggregateOrderGroup([o({ sz: '-5' })]).totSz === 5)
  t('accounts are collected for the combined view',
    aggregateOrderGroup([o({ _acct: 'Dark' }), o({ _acct: 'Jon' }), o({ _acct: 'Dark' })]).accounts.length === 2)
}

console.log(nl + '-- what an order books is decided by what it DOES, not its label --')
{
  // Reported: an order that closes a position was showing no expected PnL. The old rule
  // required a Take Profit / Stop / reduce-only FLAG, and a grid's exit sells carry none of
  // them -- they are plain limits that close a position exactly as a take profit does.
  const LONG  = { szi: '6', entryPx: '100', marginUsed: '60' }
  const SHORT = { szi: '-6', entryPx: '100', marginUsed: '60' }

  const sell = o({ side: 'A', sz: '6', limitPx: '110' })
  t('a plain limit sell against a long books its profit',
    near(expectedPnl(sell, LONG).pnl, 60), JSON.stringify(expectedPnl(sell, LONG)))
  t('with no flag on it at all', orderKind(sell) === 'limit')
  t('and below entry it books the loss',
    near(expectedPnl(o({ side: 'A', sz: '6', limitPx: '90' }), LONG).pnl, -60))
  t('a buy against a short is the mirror',
    near(expectedPnl(o({ side: 'B', sz: '6', limitPx: '90' }), SHORT).pnl, 60))

  // The other half of the report: some orders open, and an opening order has nothing to book.
  t('a buy against a long books nothing — it adds', expectedPnl(o({ side: 'B', sz: '6' }), LONG) === null)
  t('a sell against a short books nothing either', expectedPnl(o({ side: 'A', sz: '6' }), SHORT) === null)
  t('and with no position at all there is nothing to close against',
    expectedPnl(sell, null) === null && expectedPnl(sell, { szi: '0', entryPx: '100' }) === null)

  // An order larger than the position closes part and opens the rest the other way. Quoting
  // the PnL for the whole size would be wrong.
  {
    const big = expectedPnl(o({ side: 'A', sz: '10', limitPx: '110' }), LONG)
    t('an oversized order books only the part that closes', near(big.pnl, 60), JSON.stringify(big))
    t('and reports the part that opens', big.closing === 6 && big.opening === 4, JSON.stringify(big))
  }
  // HL's "close everything" order.
  t('a size of zero means the whole position',
    near(expectedPnl(o({ side: 'A', sz: '0', limitPx: '110' }), LONG).pnl, 60))
  // A trigger order prices off its trigger, not its limit.
  t('a take profit prices off the trigger',
    near(expectedPnl(o({ side: 'A', sz: '6', limitPx: '0', triggerPx: '120',
                         orderType: 'Take Profit Market' }), LONG).pnl, 120))
  t('a missing entry price is refused rather than guessed',
    expectedPnl(sell, { szi: '6', entryPx: '0' }) === null)

  // The ladder as a whole.
  const ladder = [110, 115, 120].map(px => o({ side: 'A', sz: '2', limitPx: String(px) }))
  t('a ladder books the sum of its rungs',
    near(groupExpectedPnl(ladder, LONG), 2 * 10 + 2 * 15 + 2 * 20), String(groupExpectedPnl(ladder, LONG)))
  // Null, not zero: zero would read as "this breaks even".
  t('an opening ladder books null, not zero',
    groupExpectedPnl([o({ side: 'B' }), o({ side: 'B' })], LONG) === null)
  t('and so does a ladder with no position behind it', groupExpectedPnl(ladder, null) === null)
}

console.log(nl + '-- both shells fold with it --')
{
  const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  const RND = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')
  t('mobile imports it', CLI.includes("from './ordergroup.js'"))
  t('and folds its order list', CLI.includes('groupOrders(_ordCards)') &&
    CLI.includes('function _mobVMergedOrdCard(members)'))
  // Select mode exists to tick individual orders; folding would put them out of reach.
  t('but never while selecting', CLI.includes('_mobVOrdSelMode') &&
    /_mobVOrdSelMode[\s\S]{0,140}_ordCards\.map\(c => c\.__html\)/.test(CLI))
  t('a group of one renders the ordinary card', CLI.includes("g.length > 1 ? _mobVMergedOrdCard(g) : g[0].__html"))
  t('desktop imports it', RND.includes("from './ordergroup.js'"))
  t('and folds its order table', RND.includes('function _ovMergedOrdRow(g, allMids)') &&
    RND.includes('groupOrders(sorted)'))
  t('expanding a group shows the real rows, so Cancel still reaches one order',
    RND.includes('_ovOrderRows(g.members, allMids)') && CLI.includes('members.map(m => m.__html)'))
  // One implementation, or the two shells quote different numbers for the same order.
  t('both price an order through the shared expectedPnl',
    CLI.includes('const _exp = expectedPnl(o, _pos)') && RND.includes('expectedPnl(o, _ovPosFor(o))'))
  t('and the desktop no longer demands a flag first',
    !RND.includes("if (!isTp && !isSl && !o.reduceOnly) return null"))
  t('the folded row says what the whole ladder books',
    CLI.includes('groupExpectedPnl(members, _gPos)') && RND.includes('groupExpectedPnl(g.members'))
  // In the combined view two wallets hold the same coin; pricing against the wrong one is a
  // made-up number.
  t('the position is matched by owner, not just by coin',
    CLI.includes('_guardFindPos(o.coin, o._acctAddr ?? null)') && RND.includes('function _ovPosFor(o)'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
