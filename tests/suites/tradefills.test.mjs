// "My trades" on the Trade tab (src/tradefills.js): the account's own recent trades in the
// market on screen. "show 3, as unexpanded and 10 when expanded".
import fs from 'fs'
import { recentTrades, tradeLabel, isBuy, myTradesCardHtml, SHOW_FOLDED, SHOW_OPEN } from '../../src/tradefills.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const fill = (oid, time, px, sz, rawSide, dir, closedPnl = 0, extra = {}) => ({ coin: 'ETH', oid, time, px, sz, rawSide, side: rawSide === 'B' ? 'BUY' : 'SELL', dir, closedPnl, fee: 0.01, ...extra })

console.log('-- trades, not fills --')
const fills = [
  fill(1, 1000, 100, 1, 'A', 'Close Long', 5), fill(1, 1001, 102, 1, 'A', 'Close Long', 5),
  fill(2, 500, 90, 2, 'B', 'Open Long'),
  fill(3, 2000, 95, 1, 'B', 'Buy'),
]
const tr = recentTrades(fills)
t('one order in two pieces is one trade', tr.length === 3)
t('newest first', tr.map(x => x.oid).join() === '3,1,2', tr.map(x => x.oid))
t('at its size-weighted price, with all it closed', tr[1].px === 101 && tr[1].sz === 2 && tr[1].closedPnl === 10, tr[1])
t('not loaded stays unknown (null), never "no trades"', recentTrades(null) === null && recentTrades(undefined) === null)
t('loaded and empty is an empty list', Array.isArray(recentTrades([])) && recentTrades([]).length === 0)
t('the same oid on two accounts is two trades', recentTrades([fill(7, 1, 1, 1, 'B', 'Buy', 0, { _acctAddr: '0xa' }), fill(7, 2, 1, 1, 'B', 'Buy', 0, { _acctAddr: '0xb' })]).length === 2)

console.log('-- words and colour --')
t('the direction, in sentence case', tradeLabel({ dir: 'Close Long' }) === 'Close long' && tradeLabel({ dir: 'Open Short' }) === 'Open short')
t('spot has no direction: Buy / Sell from the side', tradeLabel({ rawSide: 'B' }) === 'Buy' && tradeLabel({ rawSide: 'A' }) === 'Sell')
t('a buy that closes a short is green (a buy)', isBuy({ rawSide: 'B', dir: 'Close Short' }) === true)
t('a sell that closes a long is red', isBuy({ rawSide: 'A', dir: 'Close Long' }) === false)
t('without a side, the direction decides', isBuy({ dir: 'Open Long' }) === true && isBuy({ dir: 'Close Long' }) === false)

console.log('-- the card --')
const many = Array.from({ length: 14 }, (_, i) => fill(100 + i, 10_000 + i, 100 + i, 1, i % 2 ? 'B' : 'A', i % 2 ? 'Open Long' : 'Close Long', i % 2 ? 0 : 1))
const rowsIn = (html) => (html.match(/class="tf-row"/g) ?? []).length
const folded = myTradesCardHtml(recentTrades(many), { coin: 'ETH', now: 20_000 })
t(`folded: ${SHOW_FOLDED}`, rowsIn(folded) === 3 && SHOW_FOLDED === 3)
t(`expanded: ${SHOW_OPEN}`, rowsIn(myTradesCardHtml(recentTrades(many), { coin: 'ETH', expanded: true })) === 10 && SHOW_OPEN === 10)
t('the toggle offers ten', /data-tb-fills-more>Show 10</.test(folded))
t('and only when there is more than three', !/data-tb-fills-more/.test(myTradesCardHtml(recentTrades(many.slice(0, 3)), { coin: 'ETH' })))
t('fewer than ten: it offers what there is', /Show 5</.test(myTradesCardHtml(recentTrades(many.slice(0, 5)), { coin: 'ETH' })))
t('loading says so', /Loading your trades/.test(myTradesCardHtml(null, { coin: 'ETH' })))
t('none says so, for this market and this account', /no trades in this market on this account/.test(myTradesCardHtml([], { coin: 'ETH' })))
t('an opening trade has a dash for closed PnL, not $0', /tf-none">—</.test(folded) && !/\$0\.00/.test(folded))
t('privacy mode blurs size and PnL', /\*\*\*/.test(myTradesCardHtml(recentTrades(many), { coin: 'ETH', prv: () => '***' })))
t('a HIP-3 market drops its dex prefix in the title', /My trades · NVDA/.test(myTradesCardHtml([], { coin: 'xyz:NVDA' })))
t('the combined view tags each row with its account', /<em>Brrr<\/em>/.test(myTradesCardHtml(recentTrades([fill(1, 1, 1, 1, 'B', 'Buy', 0, { _acct: 'Brrr', _acctAddr: '0xa' })]), { coin: 'ETH', combined: true })))
t('a label is escaped', !/<script>/.test(myTradesCardHtml(recentTrades([fill(1, 1, 1, 1, 'B', '<script>', 0)]), { coin: 'ETH' })))

console.log('-- wiring --')
const main = fs.readFileSync('src/main.js', 'utf8')
t('main.js hands over this account\'s fills, null until they are its own',
  /fills: \(c\) => \{\s*if \(state\.fillsFor !== state\.addr \|\| !Array\.isArray\(state\.fills\)\) return null/.test(main))
t('every place that loads fills says whose they are',
  /state\.fills = fills\s+state\.fillsFor = addr/.test(main) && /fillsFor:\s+'__all_accounts__'/.test(main) && /state\.fillsFor\s+= PAPER_ADDR/.test(main))
const tb = fs.readFileSync('src/tradebrief.js', 'utf8')
t('the card goes under the Market one', /marketHtml\(\) \+ tradesHtml\(f\)/.test(tb))
t('a new fill repaints it', /fillsSig\(fillsOf\(\)\) !== paintedFills/.test(tb))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
