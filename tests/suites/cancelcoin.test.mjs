// Cancelling every order on one asset and ONE SIDE, in one tap.
//
// Asked for: "add an option to be able to just close all orders from just one asset … the user
// dont need to manually select all individual orders" — a ten-rung grid took ten taps in Select
// mode — then narrowed: "make it that it closes the whole asset but from the chosen side".
//
// The side matters rather than being a refinement. A ladder usually has a position resting
// against it on the other side, so clearing HYPE bids and clearing HYPE asks are different
// intentions, and taking both would remove the exits along with the entries. The assertions
// that described the whole-asset version are restated below for that reason.
//
// The batching and response-reading below already existed THREE times (Cancel All on desktop,
// Cancel All on mobile, Cancel Selected). Each carried its own copy of the two subtleties this
// suite pins, which is how one copy gets fixed and the others do not.
import fs from 'fs'
import { ordersForCoin, byAccount, statusesFrom, classifyCancels, describeOrders, summarize, sideOf }
  from '../../src/cancelbatch.js'

const cli = fs.readFileSync('src/main.js', 'utf8')
const rnd = fs.readFileSync('src/render.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const o = (oid, coin, extra = {}) => ({ oid, coin, ...extra })

console.log(nl + '-- picking the asset, and the side --')
{
  const orders = [o(1, 'HYPE'), o(2, 'HYPE'), o(3, 'BTC'), o(4, 'xyz:HYPE')]
  t('every order on the coin when no side is named', ordersForCoin(orders, 'HYPE').map(x => x.oid).join() === '1,2')
  // HIP-3 markets are dex-prefixed and renamed for display, so two markets can show the same
  // name. Matching on the label would reach into the wrong book.
  t('a HIP-3 market with the same label is a DIFFERENT asset',
    ordersForCoin(orders, 'xyz:HYPE').map(x => x.oid).join() === '4')
  t('and it is matched on the exact id, not a prefix', ordersForCoin(orders, 'HY').length === 0)
  t('an unknown coin cancels nothing', ordersForCoin(orders, 'DOGE').length === 0)
  t('so does an empty one — never "everything"', ordersForCoin(orders, '').length === 0 && ordersForCoin(orders, null).length === 0)

  // The side, in every spelling it arrives in: 'B'/'A' off the wire, 'buy'/'sell' from a group.
  const sided = [
    o(11, 'HYPE', { side: 'B' }), o(12, 'HYPE', { side: 'B' }),
    o(13, 'HYPE', { side: 'A' }), o(14, 'BTC', { side: 'B' }),
  ]
  t('only that side', ordersForCoin(sided, 'HYPE', 'B').map(x => x.oid).join() === '11,12')
  t('the other side is untouched — it is usually the exits',
    ordersForCoin(sided, 'HYPE', 'A').map(x => x.oid).join() === '13')
  t('a group card spells the side out in words', ordersForCoin(sided, 'HYPE', 'buy').map(x => x.oid).join() === '11,12')
  t('and "sell" resolves the same as "A"', ordersForCoin(sided, 'HYPE', 'sell').map(x => x.oid).join() === '13')
  t('sideOf reads every spelling', ['B', 'buy', 'Buy'].every(x => sideOf({ side: x }) === 'buy') &&
    ['A', 'S', 'sell'].every(x => sideOf({ side: x }) === 'sell'))
  t('and a side never leaks across assets', ordersForCoin(sided, 'BTC', 'B').map(x => x.oid).join() === '14')
}

console.log(nl + '-- one payload is signed by one account --')
{
  // cancelOrders refuses a mixed batch rather than sign another wallet's order with whoever is
  // connected. Splitting per account is what lets this work in the combined view at all, where
  // a coin is often held on several wallets.
  const orders = [o(1, 'HYPE', { _acctAddr: '0xAA' }), o(2, 'HYPE', { _acctAddr: '0xbb' }), o(3, 'HYPE', { _acctAddr: '0xaa' })]
  const m = byAccount(orders)
  t('split per owning account', m.size === 2)
  t('and case does not make a second account', (m.get('0xaa') ?? []).length === 2)
  t('a single-account view yields one batch', byAccount([o(1, 'HYPE'), o(2, 'HYPE')]).size === 1)
}

console.log(nl + '-- reading what the exchange said --')
{
  // 1. A partly-failed batch THROWS, with the statuses inside the error.
  t('statuses come off a result', statusesFrom({ response: { data: { statuses: ['success'] } } }).length === 1)
  t('and off the error a partial failure throws',
    statusesFrom({ response: { response: { data: { statuses: ['success', 'x'] } } } }).length === 2)
  t('neither shape present is no statuses, not a crash', statusesFrom(undefined).length === 0)

  // 2. "Already gone" is success — it is not resting any more, which is what was asked.
  const orders = [o(1, 'HYPE'), o(2, 'HYPE'), o(3, 'HYPE'), o(4, 'HYPE')]
  const r = classifyCancels(orders, [
    'success',
    { error: 'Order was never placed, already canceled, or filled. asset=123' },
    { error: 'Insufficient margin' },
    { success: {} },
  ])
  t('a plain success counts', r.ok.some(x => x.oid === 1))
  t('an order that already filled or cancelled counts too', r.ok.some(x => x.oid === 2))
  t('a real error does not', r.failed.length === 1 && r.failed[0].order.oid === 3)
  t('and an object status counts', r.ok.some(x => x.oid === 4))
  // Telling the user nothing happened while the exchange quietly cancelled is the worse error.
  t('no statuses at all is taken as done', classifyCancels(orders, []).ok.length === 4)
  t('summaries read plainly',
    summarize(r.ok, r.failed) === '3 cancelled, 1 failed' &&
    summarize([1], []) === '✓ Cancelled 1 order' &&
    summarize([], [1, 2]) === 'Could not cancel 2 orders')
}

console.log(nl + '-- the confirm says exactly what will go --')
{
  const orders = [
    o(1, 'HYPE', { side: 'B', _kind: 'limit' }), o(2, 'HYPE', { side: 'B', _kind: 'limit' }),
    o(3, 'HYPE', { side: 'A', _kind: 'limit' }),
  ]
  t('broken down by side and kind', describeOrders(orders) === '2 buy limit · 1 sell limit')
  t('an empty set describes nothing', describeOrders([]) === '')
}

console.log(nl + '-- wired into both shells --')
{
  t('one runner replaced the three copies',
    cli.includes('async function _cancelBatch(orders)'))
  const copies = [...cli.matchAll(/never placed\|already cancel\|filled/g)]
  t('the rule for "already gone" lives in the module, not in main.js', copies.length === 0, copies.length)
  t('and the single-order cancels use it too, against the error message',
    [...cli.matchAll(/isAlreadyGone\(e\.message\)/g)].length === 2)
  t('the duplicated status-reading is gone', !cli.includes('e?.response?.response?.data?.statuses'))
  t('the runner splits per account', cli.includes('for (const [acct, batch] of byAccount(orders))'))
  t('and passes that account through, so it signs with the right key',
    cli.includes('acct || null)'))

  // Was `(coin)`: the whole asset. It now takes the side, and a null side still means the lot.
  t('the cancel takes an asset and a side', cli.includes('window.__cancelCoinOrders = async function(coin, side = null)'))
  t('it confirms before firing', /window\.__cancelCoinOrders[\s\S]{0,1400}_appConfirm/.test(cli))
  t('it needs a key first', /window\.__cancelCoinOrders[\s\S]{0,600}_canAct\(\)/.test(cli))
  // Scoped to the asset, not to the card it is offered from: a coin can have a buy ladder and
  // a sell ladder, and "all HYPE orders" means both.
  t('it takes every order on the coin and side', /window\.__cancelCoinOrders[\s\S]{0,400}ordersForCoin\(state\.openOrders \?\? \[\], coin, side\)/.test(cli))
  t('and the confirm says which side is going',
    cli.includes("const sideW = side == null ? '' : (_ordSideOf({ side }) === 'buy'"))
  t('while promising the other side is not', cli.includes('The other side and your positions are not touched'))

  // Both were `(g.coin)` / `(o.coin, '0')` — the whole asset. They now carry the row's side.
  t('mobile offers it on the group card, for that group’s side',
    cli.includes('${_ordCancelCoinBtnHtml(g.coin, g.side)}'))
  t('and on a lone order, for its own side', cli.includes("${_ordCancelCoinBtnHtml(o.coin, o.side, '0')}"))
  t('a single order does not get it — it already has Cancel',
    cli.includes('if (all.length < 2) return '))
  // A batch half-signs if one of the accounts cannot.
  t('every owning account must be able to sign',
    cli.includes('const can = all.every(o => window.__acctCanTrade(o._acctAddr ?? null))'))
  // The count is that asset-and-side, not the group, so it can never cancel more than it says.
  t('the label names the count and the side',
    cli.includes('Cancel all ${all.length} ${esc(lbl)} ${sw}'))

  t('desktop offers it in the orders table', rnd.includes("window.__cancelCoinOrders('${esc(o.coin)}','${o.side}')"))
  t('counted per asset AND side', rnd.includes("const sideKey    = (o) => o.coin + '|' + (o.side === 'B' ? 'buy' : 'sell')"))
  t('only when that side has more than one', rnd.includes('${(coinCounts[sideKey(o)] ?? 0) > 1 ?'))
  t('and the button says which side', rnd.includes("${o.side === 'B' ? 'buys' : 'sells'}"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
