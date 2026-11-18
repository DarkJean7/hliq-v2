// The leaderboard's Popular board: a curated list of publicly known entities (src/lbknown.js).
// What this guards: every entry is a well-formed, unique address with a source; the feed scan
// finds exactly the listed rows; an address missing from the feed is unknown, never zero.
import fs from 'fs'
import { KNOWN, PERIODS, statsFor, knownView, compactStats } from '../../src/lbknown.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('-- the list --')
t('every address is a full, lower-case 0x address', KNOWN.every(k => /^0x[0-9a-f]{40}$/.test(k.addr)), KNOWN.filter(k => !/^0x[0-9a-f]{40}$/.test(k.addr)).map(k => k.name))
t('no address twice', new Set(KNOWN.map(k => k.addr)).size === KNOWN.length)
t('every entry names its source and links it', KNOWN.every(k => k.src && /^https:\/\//.test(k.url) && k.note && k.tag && k.name))
t('the disputed attribution says so', /disputed/i.test(KNOWN.find(k => k.addr.startsWith('0xb317'))?.note ?? ''))

console.log('-- reading the feed --')
const row = (a, v, pnlAll) => ({ ethAddress: a, accountValue: String(v), displayName: null,
  windowPerformances: [['day', { pnl: '1', roi: '0.01', vlm: '10' }], ['week', { pnl: '2', roi: '0.02', vlm: '20' }],
    ['month', { pnl: '3', roi: '0.03', vlm: '30' }], ['allTime', { pnl: String(pnlAll), roi: '0.5', vlm: '99' }]] })
const A = KNOWN[0].addr, B = KNOWN[1].addr
const other = '0x' + '1'.repeat(40)
const feed = { leaderboardRows: [row(other, 5, 5), row(A.toUpperCase().replace('0X', '0x'), 100, -50), row(B, 200, 900)] }
for (const [label, text] of [['compact', JSON.stringify(feed)], ['pretty-printed', JSON.stringify(feed, null, 2)]]) {
  const s = statsFor(text, KNOWN.map(k => k.addr))
  t(`${label}: finds the listed rows, and only them`, Object.keys(s).sort().join() === [A, B].sort().join(), Object.keys(s))
  t(`${label}: reads value and every period`, s[B]?.v === 200 && s[B]?.p.a === 900 && s[B]?.r.d === 0.01 && s[B]?.x.m === 30, s[B])
}
t('a missing window is null, not 0', compactStats({ accountValue: '1', windowPerformances: [] }).p.a === null)

console.log('-- the board --')
const s = statsFor(JSON.stringify(feed), KNOWN.map(k => k.addr))
const v = knownView(s, { period: 'a', sort: 'pnl' })
t('every entity is on the board, with or without numbers', v.length === KNOWN.length)
t('sorted by the period\'s PnL', v[0].addr === B && v[1].addr === A, v.slice(0, 2).map(r => r.name))
t('an entity missing from the feed sorts last with null stats, not as $0', v.slice(2).every(r => r.s === null))
t('by value', knownView(s, { sort: 'value' })[0].addr === B)
t('before any numbers load, the list still shows', knownView(null).length === KNOWN.length)
t('periods are 24h / 7d / 30d / All', PERIODS.map(p => p[1]).join() === '24h,7d,30d,All')

console.log('-- wiring --')
const main = fs.readFileSync('src/main.js', 'utf8')
t('both shells have the Popular tab', (main.match(/tab\('popular', '⭐ Popular'\)/g) ?? []).length === 2)
t('a late real-board load does not paint over Popular (phone)', /_mobVActiveTab !== 'leaderboard' \|\| _lbMode !== 'real'\) return/.test(main))
t('nor does the sort chip (phone)', /if \(_lbMode === 'popular'\) return {3}\/\/ it has its own sort chips/.test(main))
const srv = fs.readFileSync('serve-prod.js', 'utf8')
t('serve-prod serves /lb-known from the filtered feed', /url === '\/lb-known'/.test(srv) && /statsFor\(await r\.text\(\), KNOWN\.map/.test(srv))
t('and answers null, not {}, before it has numbers', /end\('\{"stats":null\}'\)/.test(srv))
t('the Accounts menu can copy a saved wallet\'s address', /class="ws-addr-copy"[^>]*__lbCopyAddr/.test(main))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
