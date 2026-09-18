// ROE — return on equity — and the leaderboard sorter that ranks by it.
//
// Asked for: "in the leaderboard add a sorter from lowest to highest, add new 'roe' parentesis
// data where it needs, and add it as a new filter also. add also 'roe' across the whole app
// where its needed."
//
// ROE answers what a dollar figure cannot: +$500 is a great month on $2,000 and a poor one on
// $200,000. The board ranked by dollars alone, so it read as a list of who is richest rather
// than who trades well.
import fs from 'fs'
import { accountRoe, partRoe, positionRoe, fmtRoe, compareRoe, MIN_BASIS } from '../../src/roe.js'

const cli = fs.readFileSync('src/main.js', 'utf8')
const rnd = fs.readFileSync('src/render.js', 'utf8')
const mod = fs.readFileSync('src/roe.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

console.log(nl + '-- the basis is what the account STARTED with --')
{
  // An account that doubled returned 100%, not 50%. Dividing by today's equity — which is what
  // the desktop tile used to do — understates every winner by exactly its own success.
  t('a doubled account returns 100%', accountRoe({ accountValue: 2000, netPnl: 1000 }) === 100)
  t('not 50%, which is PnL over current equity', accountRoe({ accountValue: 2000, netPnl: 1000 }) !== 50)
  t('a halved account returns −50%', accountRoe({ accountValue: 1000, netPnl: -1000 }) === -50)
  t('flat is zero', accountRoe({ accountValue: 500, netPnl: 0 }) === 0)
  t('a part of the PnL uses the same basis', partRoe(500, { accountValue: 2000, netPnl: 1000 }) === 50)
}

console.log(nl + '-- an unknowable return is NULL, never zero --')
{
  // The distinction that has cost this codebase three bugs. "+0.0%" beside a real trader's
  // number is a claim; a dash is the truth.
  t('an errored row has no ROE', accountRoe({ accountValue: 100, netPnl: 5, error: 'x' }) === null)
  t('a basis that rounds to nothing has no ROE', accountRoe({ accountValue: 1000, netPnl: 1000 }) === null)
  t('nor does a negative one — an account that lost more than it ever had',
    accountRoe({ accountValue: 10, netPnl: 50 }) === null)
  t('the threshold is stated, not magic', MIN_BASIS === 1 && mod.includes('export const MIN_BASIS'))
  t('missing numbers give null', accountRoe({}) === null && accountRoe(null) === null)
  t('and null formats as a dash', fmtRoe(null) === '—' && fmtRoe(NaN) === '—')
  t('a real one formats with its sign', fmtRoe(12.34) === '+12.3%' && fmtRoe(-4) === '-4.0%')
  t('why null rather than zero is written down', mod.includes('UNKNOWN return, not a zero one'))
}

console.log(nl + '-- a position’s ROE is Hyperliquid’s own number --')
{
  // returnOnEquity arrives as a RATIO and already carries the leverage: a 3× long up 5% on the
  // mark is +15% on the margin committed.
  t('taken from the exchange', positionRoe({ position: { returnOnEquity: '0.15' } }) === 15)
  t('derived from margin only as a fallback',
    positionRoe({ position: { unrealizedPnl: '10', marginUsed: '50' } }) === 20)
  t('a bare position object works too', positionRoe({ returnOnEquity: '-0.5' }) === -50)
  t('no margin and no ROE is unknown, not zero',
    positionRoe({ position: { unrealizedPnl: '10', marginUsed: '0' } }) === null)
  t('and nothing at all is null', positionRoe(null) === null)
}

console.log(nl + '-- sorting, both directions --')
{
  const rows = [
    { addr: 'a', accountValue: 2000, netPnl: 1000 },   // +100%
    { addr: 'b', accountValue: 11000, netPnl: 1000 },  // +10%
    { addr: 'c', accountValue: 900, netPnl: -100 },    // −10%
  ]
  const desc = [...rows].sort((x, y) => compareRoe(x, y, -1)).map(r => r.addr).join('')
  const asc  = [...rows].sort((x, y) => compareRoe(x, y, 1)).map(r => r.addr).join('')
  t('highest first', desc === 'abc', desc)
  t('and lowest first — the end of the board that matters if you are about to copy someone',
    asc === 'cba', asc)
  // A row with no ROE is not a loser, so it must not float to the top when the list flips.
  const withUnknown = [...rows, { addr: 'z', accountValue: 10, netPnl: 10 }]
  t('an unknown ROE sorts last whichever way the list points',
    [...withUnknown].sort((x, y) => compareRoe(x, y, -1)).at(-1).addr === 'z' &&
    [...withUnknown].sort((x, y) => compareRoe(x, y, 1)).at(-1).addr === 'z')
  t('two unknowns tie rather than flipping about', compareRoe({ accountValue: 1, netPnl: 1 }, { accountValue: 2, netPnl: 2 }) === 0)
}

console.log(nl + '-- the board offers it, in both shells --')
{
  t('one sort state, shared', cli.includes("let _lbSortBy          = 'value'") && cli.includes('let _lbSortDir         = -1'))
  t('and it is no longer mobile-only', !cli.includes('_mobVLbSortBy'))
  t('one comparator, used by both', cli.includes('function _lbSortRows(rows, sortBy = _lbSortBy, dir = _lbSortDir)'))
  t('an errored row ranks last either way', /_lbSortRows[\s\S]{0,400}if \(a\.error\) return 1[\s\S]{0,60}if \(b\.error\) return -1/.test(cli))
  t('ROE is a sort key', cli.includes("if (sortBy === 'roe') return compareRoe(a, b, dir)"))
  t('mobile has an ROE chip', cli.includes("${chip('roe', 'ROE')}"))
  t('desktop has a sort bar at all — it had none', cli.includes('function _lbDeskSortBar()') &&
    cli.includes('${_lbDeskSortBar()}'))
  t('desktop sorts its rows', cli.includes('${_lbSortRows(results).map((r, i) => _lbRowHtml(r, i + 1, _lbSortDir < 0)).join('))
  t('pressing the active key flips direction', cli.includes('if (_lbSortBy === by) _lbSortDir = -_lbSortDir'))
  t('and the arrow says which way', cli.includes("const arrow = _lbSortDir < 0 ? '↓' : '↑'"))

  // Rank 1 of a lowest-first list is the WORST account on the board.
  t('the podium is withheld when the list is not a ranking', cli.includes('const podium = dir < 0'))
  t('the crown too', cli.includes('if (i === 0 && podium) {'))
  t('the desktop medals as well', cli.includes('function _lbRankHtml(rank, podium = true)') &&
    cli.includes('if (!podium) return `<span class="lb-rank-num">${rank}</span>`'))
  t('and the row is told which it is', cli.includes('function _lbRowHtml(entry, rank, podium = true)'))
  t('why, in words', cli.includes('WORST'))
}

console.log(nl + '-- and it is shown where a PnL is shown --')
{
  t('the bracketed percentage on a board row IS ROE, and says so',
    cli.includes('title="Return on equity'))
  t('it comes from the module, not its own arithmetic', cli.includes('const pct = partRoe(val, { accountValue: acctVal, netPnl, error: err })'))
  t('unrealized carries it too, not just realized and net',
    cli.includes('${_lbPnl(entry.unrealizedPnl, entry.error)}${_lbPct(entry.unrealizedPnl, entry.accountValue, entry.netPnl, entry.error)}'))
  t('the expanded row states it outright', cli.includes('<span class="lb-pnl-lbl">ROE</span>'))
  t('so does the mobile row', cli.includes("['ROE',        fmtRoe(accountRoe(r)), nCls],"))
  t('the mobile equity card carries it on the PnL label', cli.includes('_pnlNet ? \'Net PnL\' : \'Unreal. PnL\'') &&
    /const _roe = _pnlReady \? partRoe\(_pnlVal/.test(cli))
  t('the Portfolio tab has an ROE row', cli.includes('<span>ROE</span>'))
  // The desktop tile divided by CURRENT equity, which understates every winner.
  t('the desktop tile no longer divides by current equity',
    !rnd.includes("(n / accountValue * 100).toFixed(2)"))
  t('it uses the shared basis', rnd.includes('const r = partRoe(n, { accountValue, netPnl })'))
  t('and labels the tile ROE', rnd.includes("sub: pctEq(netPnl) ? 'ROE ' + pctEq(netPnl) : 'incl. funding'"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
