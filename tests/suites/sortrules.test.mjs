// One set of sort rules, on every screen: the phone's.
//
// "lets make desktop pnl and every sort match the same mobile behaviour". The same arrow meant
// opposite things: ▼ was lowest first on the phone and highest first on desktop.
import fs from 'fs'
import { posCmp, ordCmp, ordSideCmp, POS_FIRST_DIR, ORD_FIRST_DIR, featuredMember } from '../../src/sortrules.js'
import { groupPositions } from '../../src/posgroup.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const rd = (f) => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const sorted = (xs, cmp, dir) => [...xs].sort((a, b) => cmp(a, b, dir))

console.log('-- positions --')
t('a first press is ▼', POS_FIRST_DIR === -1)
t('▼ puts the lowest PnL first', JSON.stringify(sorted([5, -27, -2], posCmp, -1)) === '[-27,-2,5]')
t('▲ puts the biggest first', JSON.stringify(sorted([5, -27, -2], posCmp, 1)) === '[5,-2,-27]')
t('▼ reads names A→Z', JSON.stringify(sorted(['SOL', 'BTC'], posCmp, -1)) === '["BTC","SOL"]')
t('▲ reads names Z→A', JSON.stringify(sorted(['BTC', 'SOL'], posCmp, 1)) === '["SOL","BTC"]')

console.log('-- orders --')
t('a first press is ▲', ORD_FIRST_DIR === 1)
t('▲ is biggest first', JSON.stringify(sorted([1, 3, 2], ordCmp, 1)) === '[3,2,1]')
t('▲ reads names A→Z', JSON.stringify(sorted(['SOL', 'BTC'], ordCmp, 1)) === '["BTC","SOL"]')
t('a value missing goes last either way', sorted([-Infinity, 2, 1], ordCmp, 1).at(-1) === -Infinity && sorted([-Infinity, 2, 1], ordCmp, -1).at(-1) === -Infinity)
const o = [{ side: 'A', coin: 'BTC' }, { side: 'B', coin: 'SOL' }, { side: 'B', coin: 'ETH' }]
t('by side: buys first, then by coin', sorted(o, ordSideCmp, 1).map(x => x.coin).join() === 'ETH,SOL,BTC', sorted(o, ordSideCmp, 1))
t('and the sells first when flipped', sorted(o, ordSideCmp, -1)[0].coin === 'BTC')

console.log('-- a coin on several accounts --')
const M = (coin, side, uPnl, acct, posVal = 1, healthPct = 100) => ({ coin, side, uPnl, acct, posVal, healthPct })
const pos = [M('UNI', 'LONG', 0.12, 'Near'), M('XRP', 'LONG', -2.35, 'Dark'), M('UNI', 'LONG', -27.2, 'Brrr')]
const biggest = sorted(pos, (a, b, d) => posCmp(a.uPnl, b.uPnl, d), 1)
const groups = groupPositions(biggest)
t('a coin sits where its first account lands, not by its total', groups.map(g => g[0].coin).join() === 'UNI,XRP', groups)
t('so the row names that account: Top PnL', featuredMember(groups[0], 'pnl', 1).member.acct === 'Near')
t('and on ▼, the lowest', featuredMember(groups[0], 'pnl', -1).member.acct === 'Brrr')
t('value picks by value', featuredMember([M('A', 'LONG', 0, 'x', 5), M('A', 'LONG', 0, 'y', 9)], 'value', 1).member.acct === 'y')
const worst = M('A', 'LONG', 0, 'risky', 1, 12)
t('anything else shows the riskiest', featuredMember([M('A', 'LONG', 0, 'x'), worst], 'health', 1, worst).member.acct === 'risky')

console.log('-- used everywhere --')
const r = rd('src/render.js'), m = rd('src/main.js')
t('Overview positions', /const cmp = \(av, bv\) => posCmp\(av, bv, _ovPosSortDir\)/.test(r))
t('and no group re-sort undoing it', !r.includes('_ovGroupSortVal'))
t('Overview orders', /ordCmp\(_ovOrdSortVal\(a/.test(r))
t('Trade tab positions', /return posCmp\(av, bv, _mPosSortDir\)/.test(r))
t('Trade tab orders', /return ordCmp\(av, bv, _mOrdSortDir\)/.test(r))
t('a new column starts where the phone does, on all four', /_ovPosSortDir = POS_FIRST_DIR/.test(r) && /_ovOrdSortDir = ORD_FIRST_DIR/.test(r) && /_mPosSortDir = POS_FIRST_DIR \}/.test(r) && /_mOrdSortDir = ORD_FIRST_DIR \}/.test(r))
t('the phone reads the same rules', /return posCmp\(va, vb, _mobVPosSortDir\)/.test(m) && /featuredMember\(members, 'pnl', _mobVPosSortDir\)/.test(m))
t('the merged desktop row names the account', /const feat = _ovFeatLine\(g\)/.test(r))
// Under the column the sort is about, not the market name: "Top PnL" beside the coin read as a
// fact about the coin, far from the PnL figure it explains.
t('under the column it is about', /featIn\('pnl'\)/.test(r) && /featIn\('value'\)/.test(r) && /featIn\('health'\)/.test(r))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
