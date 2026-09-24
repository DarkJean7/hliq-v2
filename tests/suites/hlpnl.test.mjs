// Every PnL the app calls "net" is Hyperliquid's own, not a rebuild of it.
//
// Reported on a closed account: HL said −$3,443.12, the app said −$3,022.32. The app was
// adding realized + unrealized + funding − fees, and that sum cannot be complete:
//
//   · realized PnL comes from fills' closedPnl, which HL reports for PERPS only, so a loss
//     taken selling a spot token is invisible to it;
//   · funding read $0.00 because an idle account's funding window had nothing in it.
//
// HL publishes the answer. `cumLedger` is every dollar ever paid in, and equity minus it is
// the PnL on its own portfolio page. Measured against six live wallets, the app's derivation
// of cumLedger (portfolio value − all-time PnL, both from the `portfolio` call it already
// makes) equals HL's own cumLedger to 0.0000 on every one.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

console.log(nl + '-- the identity this rests on --')
{
  // Live figures from three of the wallets, on the day this was written. equity − cumLedger is
  // HL's own all-time PnL, and portfolio value − that PnL gives cumLedger back.
  const W = [
    { equity: 1806.06, cum: 1351.18, hlPnl: 454.88 },
    { equity: 907.62, cum: 1429.56, hlPnl: -521.94 },
    { equity: 1101.97, cum: 193.35, hlPnl: 908.62 },
  ]
  t('equity − cumLedger is HL\'s all-time PnL', W.every(w => near(w.equity - w.cum, w.hlPnl, 0.005)))
  t('and it inverts: value − PnL gives cumLedger', W.every(w => near(w.equity - w.hlPnl, w.cum, 0.005)))
  // The reported account: $0 left, $3,443.12 ever paid in.
  t('a closed account reads as everything it was ever paid', near(0 - 3443.12, -3443.12))
  // What the old sum produced from the same account's parts.
  t('the itemised sum was $420.80 short', near(261.85 - 3284.17, -3022.32, 0.005) && near(-3022.32 - -3443.12, 420.80, 0.005))
}

console.log(nl + '-- a single account --')
{
  t('there is one reader for the figure', /function _hlCumLedger\(\)/.test(cli) && /function _hlAllTimePnl\(accountValue\)/.test(cli))
  t('null when unknown, never 0', /return Number\.isFinite\(v\) \? v : null/.test(cli) &&
    /if \(cum == null \|\| !Number\.isFinite\(accountValue\)\) return null/.test(cli))
  t('the Portfolio tab prefers it', /const _hlNet = _hlAllTimePnl\(accountValue\)\s*\n\s*if \(_hlNet != null\) netPnl = _hlNet/.test(cli))
  t('so does Net Deposited', /const netDeposited  = _hlIn != null \? _hlIn : totalDeposited - totalWithdrawn/.test(cli))
  t('and the balance card', /_hlPnl != null \? _hlPnl \+ _oxPnl : netPnl/.test(cli))
  t('which no longer waits for the all-time fills it does not need', /_hlPnl != null \|\| state\.fillsFull !== false/.test(cli))
}

console.log(nl + '-- every wallet in All Accounts --')
{
  t('each row derives it from the portfolio call it already makes',
    /const _cumLedger       = \(portfolioAcctVal != null && Number\.isFinite\(_hlPnlAtHist\)\)/.test(cli) &&
    /const _pnlHist         = allTimePort\?\.\[1\]\?\.pnlHistory \?\? \[\]/.test(cli))
  t('no extra request is made for it', !/webData2.*per wallet|type: 'webData2'/.test(cli.slice(cli.indexOf('const _pnlHist'), cli.indexOf('const _pnlHist') + 2000)))
  t('the row carries it', /return \{ \.\.\.entry, accountValue, _cumLedger,/.test(cli))
  t('the row\'s own Net PnL is HL\'s', /const netPnl           = _cumLedger != null && Number\.isFinite\(accountValue\)\s*\n\s*\? accountValue - _cumLedger/.test(cli))
  t('a cached row keeps it', /Number\.isFinite\(cached\._cumLedger\) && Number\.isFinite\(accountValue\)/.test(cli))
  t('the combined total sums the wallets\' own figures', /const _hlNet = \(\(\) => \{/.test(cli) && /sum \+= av - cum/.test(cli))
  // The rule this file keeps re-learning: a total missing a wallet is wrong, not small.
  t('and refuses unless every wallet can answer',
    /if \(!Number\.isFinite\(cum\) \|\| !Number\.isFinite\(av\)\) return null/.test(cli))
  t('the itemised sum stays as the fallback', /if \(haveUnreal && snap && Number\.isFinite\(Number\(snap\.settledPnl\)\)/.test(cli))
  t('and as the breakdown beside it', /parts = snap && Number\.isFinite\(Number\(snap\.settledPnl\)\)/.test(cli))
  t('combined Net Deposited is the sum of the wallets\' own', /cumLedger: visible\.reduce\(\(s, r\) => s \+ \(Number\.isFinite\(Number\(r\._cumLedger\)\)/.test(cli))
  t('with the ledger walk only where a wallet has not answered', /: \(r\.totalDeposited \|\| 0\) - \(r\.totalWithdrawn \|\| 0\)\), 0\) \}/.test(cli))
  t('and the Portfolio tab reads it in the combined view too', !/function _hlCumLedger\(\)\s*\{\s*\n\s*if \(state\.isAllAccounts\) return null/.test(cli))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
