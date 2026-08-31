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
t('spot shows what the purchase cost', cal.includes("$${fmtUSD(t.notional ?? 0)}"))
t('a perp still shows its PnL', cal.includes("${netPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(netPnl))}"))
t('and a dash when it opened rather than closed', cal.includes("cal-detail-pnl\" style=\"color:var(--muted)\">—"))
t('the three cases are exclusive — a spot row cannot also print a PnL',
  /isSpot\s*\?[\s\S]{0,140}:\s*t\.closedPnl !== 0/.test(cal))
t('a missing notional is zero, not NaN', cal.includes('t.notional ?? 0'))
t('the PnL shown is net of the fee, as before', cal.includes('const netPnl  = t.closedPnl - t.fee'))
t('the reason is written down', cal.includes('Buying spot is a purchase'))

console.log('\n── History still behaves the same ──')
const hist = cli.slice(cli.indexOf('const _isSpot   = _isSpotFill(f.coin)'), cli.indexOf('const btn = (dir, disabled)'))
t('spot shows the value', hist.includes("_isSpot ? '$' + fmtUSD(_ntl)"))
t('a perp keeps PnL', hist.includes("pnl !== 0 ? (pnl >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(pnl))"))
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
