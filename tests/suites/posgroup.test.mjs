// One position held on several accounts, folded the same way on both shells.
//
// Mobile has merged same-coin/same-direction positions since the combined view shipped.
// Desktop never did: four wallets long the same coin were four rows that looked like four
// separate bets, with no account name and no bot badge to tell them apart. The arithmetic
// was the reason -- it lived inside the mobile card builder, so desktop had no access to it
// and nobody noticed the gap until it was reported.
//
// So the maths moved to src/posgroup.js and both shells call it. This suite tests that
// module directly, and then asserts the two call sites still exist -- because a merge that
// only one surface performs is the bug this fixes.
import fs from 'fs'
import { aggregatePosGroup, groupPositions, posGroupKey, posSideOf,
         posHealthPct } from '../../src/posgroup.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

const RND = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const CSS = fs.readFileSync('src/style.css', 'utf8')

// Two wallets long PUMP at different entries, leverages and health.
const m = (o) => ({ coin: 'PUMP', side: 'LONG', absSz: 0, entryPx: 0, liqPx: 0, markPx: 0,
                    posVal: 0, uPnl: 0, margin: 0, funding: 0, healthPct: 100,
                    lev: 10, isIso: false, acct: '', acctAddr: null, ...o })
const A = m({ absSz: 100, entryPx: 2, posVal: 300, uPnl: 100, margin: 30, funding: 1,
              markPx: 3, liqPx: 1.5, healthPct: 60, acct: 'China', acctAddr: '0xaa' })
const B = m({ absSz: 300, entryPx: 4, posVal: 900, uPnl: -300, margin: 90, funding: -4,
              markPx: 3, liqPx: 2.6, healthPct: 29, acct: 'Insolvent', acctAddr: '0xbb' })

console.log(nl + '-- what merges --')
{
  const g = aggregatePosGroup([A, B])
  t('size adds up', g.totSz === 400, String(g.totSz))
  t('notional adds up', g.totVal === 1200, String(g.totVal))
  t('unrealized PnL adds up', g.totUPnl === -200, String(g.totUPnl))
  t('margin adds up', g.totMrg === 120, String(g.totMrg))
  t('funding adds up', g.totFund === -3, String(g.totFund))
  // 100@2 + 300@4 = 1400/400 = 3.5, not the plain mean of 3.
  t('entry is weighted by size, not averaged', near(g.avgEntry, 3.5), String(g.avgEntry))
  t('ROE is the total against the total margin', near(g.roe, -200 / 120 * 100), String(g.roe))
  t('real leverage is notional over margin actually posted', near(g.realLev, 10), String(g.realLev))
  t('the count is the member count', g.n === 2)
}

console.log(nl + '-- what does NOT merge --')
{
  const g = aggregatePosGroup([A, B])
  // Liquidation is per account: one wallet can be liquidated while the others are fine.
  // Averaging the two would produce a number describing no account and no risk held.
  t('health is the WORST member, not the mean', g.healthPct === 29, String(g.healthPct))
  t('and the group names the account carrying it', g.worst.acct === 'Insolvent', g.worst.acct)
  t('the reason liq is not averaged is written down',
    fs.readFileSync('src/posgroup.js', 'utf8').includes('describes no account'))
}

console.log(nl + '-- mixed risk settings are flagged, not smoothed over --')
{
  t('same leverage and mode is not mixed', aggregatePosGroup([A, m({ lev: 10, isIso: false })]).mixed === false)
  t('a different leverage is mixed', aggregatePosGroup([A, m({ lev: 20, isIso: false })]).mixed === true)
  t('a different margin mode is mixed', aggregatePosGroup([A, m({ lev: 10, isIso: true })]).mixed === true)
}

console.log(nl + '-- the edges --')
{
  t('an empty group does not throw', aggregatePosGroup([]).n === 0)
  t('and reports zero rather than NaN', aggregatePosGroup([]).totVal === 0 && aggregatePosGroup([]).roe === 0)
  t('a single member is itself', aggregatePosGroup([A]).totVal === 300 && aggregatePosGroup([A]).healthPct === 60)
  // A HIP-3 coin missing from allMids has no mark on its row, but a sibling on another
  // wallet does — the group must not print "—" when the price is known.
  const g = aggregatePosGroup([m({ markPx: 0 }), m({ markPx: 3 })])
  t('a member with no mark does not blank the group mark', g.markPx === 3, String(g.markPx))
  t('zero size falls back to the first entry rather than dividing by zero',
    aggregatePosGroup([m({ absSz: 0, entryPx: 7 })]).avgEntry === 7)
}

console.log(nl + '-- grouping --')
{
  const long = m({ side: 'LONG' }), short = m({ side: 'SHORT' })
  const sol  = m({ coin: 'SOL' })
  const gs = groupPositions([long, short, sol, long])
  t('same coin and same side group together', gs[0].length === 2)
  // A long and a short on one coin across two wallets is a hedge, not one position:
  // summing them would report a flat book while both legs can still be liquidated.
  t('opposite sides do NOT group', gs.length === 3 && gs[1].length === 1 && gs[1][0].side === 'SHORT')
  t('different coins do not group', gs[2][0].coin === 'SOL')
  // The caller has already sorted by the clicked column; re-ordering here would silently
  // override it.
  t('arrival order is preserved', gs[0][0] === long && gs[1][0] === short)
  t('the key carries both coin and side', posGroupKey('SOL', 'LONG') === 'SOL|LONG')
  t('side comes from the sign of the size', posSideOf(5) === 'LONG' && posSideOf(-5) === 'SHORT')
  t('nothing to group does not throw', groupPositions([]).length === 0 && groupPositions(undefined).length === 0)
}

console.log(nl + '-- health is one calculation now --')
{
  // long: entry 100, liq 50, mark 75 → halfway
  t('a long halfway to liquidation is 50%', near(posHealthPct(1, 100, 50, 75), 50))
  t('a short halfway to liquidation is 50%', near(posHealthPct(-1, 100, 150, 125), 50))
  t('at entry it is 100%', near(posHealthPct(1, 100, 50, 100), 100))
  t('at the liq price it is 0%', posHealthPct(1, 100, 50, 50) === 0)
  t('past the liq price it clamps rather than going negative', posHealthPct(1, 100, 50, 10) === 0)
  t('no liq price reports 100, and says why', posHealthPct(1, 100, 0, 90) === 100 &&
    fs.readFileSync('src/posgroup.js', 'utf8').includes('is not "perfectly safe"'))
  t('mobile calls it instead of keeping its own copy', CLI.includes('return posHealthPct(p.szi, p.entryPx, p.liquidationPx, _posMarkPx(p))'))
  t('and so does the desktop row', RND.includes('const hp = posHealthPct(szi, entry, liq, mark)'))
  t('and the desktop sort comparator', RND.includes("case 'health': return posHealthPct("))
}

console.log(nl + '-- both shells fold with the shared module --')
{
  t('mobile imports it', CLI.includes("from './posgroup.js'"))
  t('and the merged card is built from it', CLI.includes('const g = aggregatePosGroup(members)'))
  t('mobile groups with it too', CLI.includes('groupPositions(_posCards)'))
  t('desktop imports it', RND.includes("from './posgroup.js'"))
  t('and groups its position table', RND.includes('groupPositions(sorted.map(ap => _ovPosMember(ap, allMids)))'))
  t('a group of one renders the ordinary row', RND.includes('? _ovMergedPosRow(g, allMids, tpslMap)'))
}

console.log(nl + '-- the desktop merged row shows the merged figures --')
{
  const i = RND.indexOf('function _ovMergedPosRow(')
  const row = RND.slice(i, RND.indexOf(nl + 'function ', i + 10))
  t('there is one', i > 0)
  t('size is the total', row.includes('_ovSz(g.totSz)') && row.includes('fmtUSD(g.totVal)'))
  t('entry is the weighted average', row.includes('_ovPx(g.avgEntry)'))
  t('margin and funding are totals', row.includes('fmtUSD(g.totMrg)') && row.includes('Math.abs(g.totFund)'))
  t('PnL is the total, with the combined ROE', row.includes('fmtPnL(g.totUPnl)') && row.includes('g.roe.toFixed(2)'))
  t('the account count is on the row', row.includes('×${g.n} accounts'))
  // The three that must NOT read as one uniform position.
  t('liq shows the nearest, not an average', row.includes('worstLiq') && row.includes('nearest'))
  t('health shows the worst member', row.includes('g.healthPct.toFixed(0)'))
  t('mixed leverage is called out', row.includes("g.mixed") && row.includes('mixed leverage'))
  t('and the bots running across the group are badged', row.includes('window._botBadgeGroupHtml'))
}

console.log(nl + '-- eleven columns share one width, so the numbers have to fit --')
{
  // The tracks are pinned (minmax(0, 1fr)) so every row lines up under the header. That
  // makes a too-wide value clip instead of shoving its column, which is only an improvement
  // if the values are trimmed to fit — hence the two table-local formatters.
  t('the tracks are pinned, and why is recorded',
    CSS.includes('repeat(7, minmax(0, 1fr))') && CSS.includes('minmax(AUTO, 1fr)'))
  t('an overflowing cell ellipsises rather than overlapping the next',
    CSS.includes('.ov-pos-row > .mono, .ov-pos-row > .ov-pos-size'))
  t('prices are trimmed for the table only', RND.includes('function _ovPx(n)') &&
    RND.includes('fmtPrice itself is used by the order forms'))
  t('and sizes drop decimals that carry nothing', RND.includes('function _ovSz(n)'))
  t('both position rows use them', (RND.match(/_ovPx\(/g) ?? []).length >= 6 &&
    (RND.match(/_ovSz\(/g) ?? []).length >= 3)
  // The group subtitle is the one string longer than a market name; it wraps rather than
  // losing the half that says the accounts do not share a leverage.
  t('the group subtitle may wrap instead of truncating',
    CSS.includes('.ov-pos-grouprow .ov-pos-mkt i:first-of-type'))
}

console.log(nl + '-- desktop rows say whose position it is, and what is running on it --')
{
  t('there is a meta line', RND.includes('function _ovPosMeta(p)'))
  t('it shows the account name', RND.includes('class="acct-pill notranslate"'))
  t('and the bot badge for THAT wallet', RND.includes('window._botBadgeHtml(p.coin, p._acctAddr ?? null, true)'))
  t('the position row renders it', RND.includes('const meta = _ovPosMeta(p)') && RND.includes('<i>${lev}× ${levT}</i>${meta}'))
  t('main.js exposes the badge builders to it', CLI.includes('window._botBadgeHtml      = _botBadgeHtml') &&
    CLI.includes('window._botBadgeGroupHtml = _botBadgeGroupHtml'))
  // .ov-pos-mkt span makes every nested span a flex column, which would stack the pill on
  // top of the badge. The meta line needs the more specific rule to stay a row.
  t('the meta line survives the nested-span rule', CSS.includes('.ov-pos-mkt .ov-pos-meta'))
  t('members are nested without breaking column alignment',
    CSS.includes('.ov-pos-group-body') && CSS.includes('inset 3px 0 0'))
}

console.log(nl + '-- a desktop action goes to the wallet that owns the position --')
{
  const i = RND.indexOf('function _ovPositionRow(')
  const row = RND.slice(i, RND.indexOf(nl + 'window.__ovTogglePos', i))
  t('the owner is read off the position', row.includes("const acct    = p._acctAddr ?? null"))
  // Every one of these takes an owner and desktop passed none, so in All Accounts a close on
  // wallet four was signed by whichever account happened to be selected.
  // Not a regex: the argument lists contain `)` of their own (`${esc(p.coin)}`), so
  // "up to the closing paren" matches a fragment. The owner is the LAST argument, so what
  // must be true is that `,${acctArg})` closes the call.
  for (const fn of ['__openEditModal', '__openAdjustMarginModal', '__openCloseModal']) {
    const at = row.indexOf(fn + '(')
    const call = at < 0 ? '' : row.slice(at, row.indexOf('"', at))
    t(`${fn} is given the owner`, call.includes(',${acctArg})'), call.slice(0, 80))
  }
  t('both guards are given the owner',
    (row.match(/__openGuardModal\('(liqguard|levbrake)','\$\{esc\(p\.coin\)\}','\$\{side\}',\$\{acctArg\}\)/g) ?? []).length === 2)
  t('a wallet with no agent key cannot act from these rows', row.includes('window.__acctCanTrade(acct)'))
  // Two wallets on one coin used to produce two rows with the same element id, so opening
  // the second silently opened the first.
  t('the expand id carries the owner', row.includes("p._acctAddr ? '_' + p._acctAddr.slice(2, 8)"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
