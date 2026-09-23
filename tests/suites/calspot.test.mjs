// The spot rule, shared by History and the Calendar.
import fs from 'fs'
import { isSpotCoin } from '../../src/format.js'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const rnd = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

console.log('\n── one rule, one place ──')
t('the predicate is shared, not copied', cli.includes("isSpotCoin } from './format.js'") && rnd.includes('isSpotCoin'))
t('History binds it to its loaded spot map',
  cli.includes('const _isSpotFill = (coin) => isSpotCoin(coin, _spotNameMap)'))
t('the Calendar uses it without one, since the shapes decide it alone',
  rnd.includes('const isSpot = isSpotCoin(t.coin)'))

console.log('\n── what counts as spot ──')
t('a market id', isSpotCoin('@107') === true)
t('a pair name', isSpotCoin('PURR/USDC') === true)
t('a bare perp is not', isSpotCoin('HYPE') === false && isSpotCoin('SOL') === false)
t('the perp and spot market of one token are told apart',
  isSpotCoin('HYPE') === false && isSpotCoin('@107') === true)
t('an outcome market is not spot', isSpotCoin('#11420') === false && isSpotCoin('+3') === false)
t('a HIP-3 builder perp is not spot', isSpotCoin('xyz:SPCX') === false)
t('empty is not spot', isSpotCoin('') === false && isSpotCoin(null) === false && isSpotCoin(undefined) === false)
t('a loaded map can confirm an odd name', isSpotCoin('WEIRD', { WEIRD: 'WEIRD' }) === true)
t('but cannot mislabel a perp — it is never keyed by a bare name',
  isSpotCoin('HYPE', { '@107': 'HYPE' }) === false)
t('a map without the coin changes nothing', isSpotCoin('HYPE', { '@1': 'PURR' }) === false)

console.log('\n── the calendar row ──')
const cal = rnd.slice(rnd.indexOf('const tradesHtml = trades.length'), rnd.indexOf('const txHtml'))
// Was: spot was tested FIRST, so a spot row could never print a PnL. Reported as a day
// header of +$138.26 against green rows summing to $79.24. The missing $59.02 was one
// spot sell — @107 HYPE, closedPnl 59.01686232 — counted in the header and drawn in the
// row as a grey $420.57 notional. Hyperliquid realizes PnL on a spot SELL against your
// cost basis; only a buy closes nothing. So the PnL is tested first now.
// Scoped to the day detail: aggregateByHash further up has a grouper of its own, and an
// assertion that matched it would pass with this one unchanged.
const day   = rnd.slice(rnd.indexOf('export function calDayClick'), rnd.indexOf('export function renderPnLCalendar'))
const iPnl  = cal.indexOf('const right = t.closedPnl !== 0')
const iSpot = cal.indexOf(': isSpot')
const iDash = cal.indexOf('>—</span>')
t('a closed trade shows its PnL, spot or perp', iPnl > -1)
t('the spot notional is the fallback, not the rule', iSpot > iPnl)
t('and the dash is last, for a perp that opened rather than closed', iSpot > -1 && iDash > iSpot)
t('spot still shows what the trade was worth when it closed nothing',
  cal.includes("$${fmtUSD(t.notional ?? 0)}"))
t('a perp still shows its PnL', cal.includes("${netPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(netPnl))}"))
t('a missing notional is zero, not NaN', cal.includes('t.notional ?? 0'))
t('the reason is written down', cal.includes('A SPOT SELL DOES CARRY CLOSED PnL'))

console.log('\n── the fee that comes off is dollars ──')
// HL charges in the asset received: USDC on a sell, the bought token on a spot buy —
// 0.5945587 KNTQ on one of the fills from that same day. Subtracting that from a dollar
// PnL would be a unit error, and only became reachable once spot rows print a PnL.
t('only a USDC fee is subtracted',
  cal.includes("const netPnl  = t.closedPnl - ((t.feeToken ?? 'USDC') === 'USDC' ? t.fee : 0)"))
t('so the day\'s grouper has to carry the fee token',
  day.includes('fee: 0, feeToken: f.feeToken, closedPnl: 0'))

console.log('\n── the header and the rows count the same fills ──')
t('the day total takes every fill that closed something',
  rnd.includes('if (f.closedPnl === 0) continue') && rnd.includes('byDay[key].pnl    += f.closedPnl'))
t('and the rows print a PnL for exactly that set — neither filters on spot',
  cal.includes('const right = t.closedPnl !== 0') && !/const right = isSpot/.test(cal))

console.log('\n── History follows the same order ──')
const hist = cli.slice(cli.indexOf('const _isSpot   = _isSpotFill(f.coin)'), cli.indexOf('const btn = (dir, disabled)'))
const hPnl  = hist.indexOf("pnl !== 0 ? (pnl >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(pnl))")
const hSpot = hist.indexOf("_isSpot ? '$' + fmtUSD(_ntl)")
t('a closed trade shows its PnL first', hPnl > -1 && hSpot > hPnl)
t('spot shows the value when it closed nothing', hSpot > -1)
t('and a dash otherwise', hist.includes(": '—'}</span>"))

console.log('\n── the boot crash that surfaced while testing this ──')
// _stopAllAcctWs clears this map and runs from loadDashboard during module evaluation, so
// a `const` declared 16,000 lines further down did not exist yet.
const declAt = cli.indexOf('const _hip3WsDexes = new Map()')
const useAt  = cli.indexOf('_hip3WsDexes.clear()')
t('the map is declared BEFORE the code that clears it', declAt > 0 && declAt < useAt)
t('and beside the rest of the socket state', cli.indexOf('const _acctWsSubs') < declAt && declAt - cli.indexOf('const _acctWsSubs') < 1200)
t('with the reason recorded so it does not get moved back',
  cli.includes("Cannot access '_hip3WsDexes' before initialization"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
