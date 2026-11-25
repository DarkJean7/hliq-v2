// The leaderboard's Popular board: a curated list of publicly known entities (src/lbknown.js),
// each row LIVE from Hyperliquid in the Real board's shape.
//
// What this guards: every entry is a well-formed, unique address with a source; a row's numbers
// all come from one moment and add up (net = unrealized + realized) -- the board first took
// value and PnL from Hyperliquid's lagging stats file and positions from nowhere, and a user
// found "+30.64M, value 19.68M" beside a page saying $17.46M: "nothing matches".
import fs from 'fs'
import { KNOWN, KNOWN_PERIODS, knownRow } from '../../src/lbknown.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('-- the list --')
t('every address is a full, lower-case 0x address', KNOWN.every(k => /^0x[0-9a-f]{40}$/.test(k.addr)), KNOWN.filter(k => !/^0x[0-9a-f]{40}$/.test(k.addr)).map(k => k.name))
t('no address twice', new Set(KNOWN.map(k => k.addr)).size === KNOWN.length)
t('every entry names its source and links it', KNOWN.every(k => k.src && /^https:\/\//.test(k.url) && k.note && k.tag && k.name))
t('the disputed attribution says so', /disputed/i.test(KNOWN.find(k => k.addr.startsWith('0xb317'))?.note ?? ''))
t('a .hl name is not passed off as proof', KNOWN.filter(k => /\.hl/.test(k.note)).every(k => /different wallet/.test(k.note)))

console.log('-- a row, from smartestmoney\'s real answers (Nov 18 2026) --')
const series = (v, pnl) => ({ accountValueHistory: [[1, '1'], [2, String(v)]], pnlHistory: [[1, '0'], [2, String(pnl)]], vlm: '97679987.03' })
const PORTFOLIO = [['day', series(17464253.9, -4227835.5)], ['week', series(17464253.9, -9004078.18)],
  ['month', series(17464253.9, -18908139.18)], ['allTime', series(17464253.903077, 28370010.493077)],
  ['perpAllTime', series(13680856.31, 28425001.8)]]
const CS = { assetPositions: [
  { position: { coin: 'HYPE', szi: '1380042.66', entryPx: '38.6755', positionValue: '91200119.1861', unrealizedPnl: '37826189.139352', liquidationPx: '20.1', leverage: { type: 'cross', value: 5 }, returnOnEquity: '3.5', marginUsed: '18240023.8' } },
  { position: { coin: 'BTC', szi: '0', entryPx: '0', positionValue: '0', unrealizedPnl: '0' } },
] }
const r = knownRow('0x082e843a431aef031264dc232693dd710aedca88', PORTFOLIO, CS)
t('account value is the portfolio\'s, as Visit / Hyperliquid show it', r.accountValue === 17464253.903077, r.accountValue)
t('net PnL is the all-time portfolio PnL (not the perp-only one)', r.netPnl === 28370010.493077, r.netPnl)
t('unrealized is the open positions\'', Math.abs(r.unrealizedPnl - 37826189.139352) < 1e-6, r.unrealizedPnl)
t('and they add up: net = unrealized + realized', Math.abs(r.unrealizedPnl + r.realizedPnl - r.netPnl) < 1e-6, r)
t('a flat (size 0) position is not listed', r.positions.length === 1 && r.positions[0].position.coin === 'HYPE')
t('positions keep HL\'s { position } wrapper the renderers read', r.positions[0].position.marginUsed === '18240023.8')
t('PnL by period', r.periods.d === -4227835.5 && r.periods.w === -9004078.18 && r.periods.m === -18908139.18 && r.periods.a === 28370010.493077, r.periods)
t('volume from the all-time window', r.totalVolume === 97679987.03)
t('no portfolio → no row (not a row of zeros)', knownRow('0x' + '1'.repeat(40), [], CS) === null)
t('no positions answer → unrealized 0, the rest still there', knownRow('0x1', PORTFOLIO, null)?.unrealizedPnl === 0)
t('periods are 24h / 7d / 30d / All', KNOWN_PERIODS.map(p => p[1]).join() === '24h,7d,30d,All')

console.log('-- wiring --')
const main = fs.readFileSync('src/main.js', 'utf8')
t('Popular sits between Real and Paper, on both shells',
  (main.match(/tab\('real', 'Real'\)\}\$\{tab\('popular', '⭐ Popular'\)\}\$\{tab\('paper', '📝 Paper'\)\}/g) ?? []).length === 2)
t('drawn by the Real board\'s renderers', /_mobVBuildLbHtml\(_lbKnownRows\(\), \{ known: true \}\)/.test(main) && /_lbRowHtml\(r, i \+ 1, _lbSortDir < 0\)/.test(main))
t('a known row offers no remove / hide (it is not on the real board)', /\} else if \(r\.addr && !opts\.known\) \{/.test(main) && /\$\{entry\.known \|\| entry\._agent \? '' : isP \? `/.test(main))
t('a late real-board load does not paint over Popular (phone)', /_mobVActiveTab !== 'leaderboard' \|\| _lbMode !== 'real'\) return/.test(main))
const srv = fs.readFileSync('serve-prod.js', 'utf8')
t('serve-prod builds the rows live, one request at a time', /url === '\/lb-known'/.test(srv) && /knownRow\(addr, portfolio, cs\)/.test(srv) && /POP_GAP/.test(srv))
t('a 429 stops the round', /if \(e\.rateLimited\) \{/.test(srv))
t('and it answers null, not {}, before it has rows', /end\('\{"rows":null\}'\)/.test(srv))
t('the Accounts menu can copy a saved wallet\'s address', /class="ws-addr-copy"[^>]*__lbCopyAddr/.test(main))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
