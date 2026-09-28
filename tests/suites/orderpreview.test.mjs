// The order ticket's position preview, on the right wallet.
//
// Reported with two screenshots: a 500,872 PUMP short open, 500,000 more entered, and the
// preview saying the new size would be 875,000. It also said the new margin would be $453.84
// — which is $259.25 for the order plus $194.59, and $194.59 is the margin of a DIFFERENT
// wallet's 375,000 PUMP short. 375,000 + 500,000 = 875,000.
//
// state.perpState in the combined view aggregates every wallet, so `.find(coin)` returned
// whichever wallet came first. _tradePositions() exists precisely for this and says so in its
// own comment; the estimator just was not using it.
//
// The estimator is lifted out of main.js and run against a fake state, so this is the real
// arithmetic rather than a grep for it.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.01) => Math.abs(a - b) < e

/**
 * A function out of main.js, whole. The parameter list is matched first, because
 * `_orderEstimate({ coin, ... })` destructures and the body brace is not the first one.
 */
const grab = (sig) => {
  const i = cli.indexOf(sig)
  if (i < 0) throw new Error('not found: ' + sig)
  let k = cli.indexOf('(', i), pd = 0
  for (; k < cli.length; k++) {
    if (cli[k] === '(') pd++
    else if (cli[k] === ')') { pd--; if (!pd) break }
  }
  let j = cli.indexOf('{', k), d = 0
  for (; j < cli.length; j++) {
    if (cli[j] === '{') d++
    else if (cli[j] === '}') { d--; if (!d) return cli.slice(i, j + 1) }
  }
  throw new Error('unbalanced: ' + sig)
}

/** The two functions under test, with everything they lean on stubbed. */
const harness = (state, tradeAcct) => new Function('STATE', 'ACCT', `
  const state = STATE
  const isConnected = () => false
  const _tradePerpState = null
  const _mktCtxMap = {}
  const window = { __getTradeAcct: () => ACCT }
  ${grab('function _tradePositions()')}
  ${grab('function _orderEstimate(')}
  return (args) => _orderEstimate(args)
`)(state, tradeAcct)

// The account in the screenshots, and the other wallet whose position was being read.
const MINE  = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
const pos = (coin, szi, entry, margin, liq, acct) => ({ position: {
  coin, szi: String(szi), entryPx: String(entry), marginUsed: String(margin),
  liquidationPx: String(liq), _acctAddr: acct,
  leverage: { type: 'cross', value: 10 }, maxLeverage: 10,
} })

console.log(nl + '-- the reported ticket --')
{
  // Mine: 500,872 short at 0.003063, $259.70 of margin. The other wallet: 375,000 short at
  // 0.002828, $194.59. Adding 500,000 more at 0.005185.
  const state = {
    isAllAccounts: true, tradeSide: 'short', isIsolated: false,
    perpState: { marginSummary: { accountValue: '2597' }, assetPositions: [
      pos('PUMP', -375000, 0.002828, 194.59, 0.0061, OTHER),   // first in the array, as it was
      pos('PUMP', -500872, 0.003063, 259.70, 0.00544399, MINE),
    ] },
  }
  const est = harness(state, MINE)({ coin: 'PUMP', side: 'short', coinSz: 500000, price: 0.005185, leverage: 10, orderType: 'market' })
  t('the new size is mine plus the order', near(Math.abs(est.newSzi), 1000872, 1), Math.abs(est.newSzi))
  // The number on the screenshot, and what it would still be if the wrong wallet were read.
  t('and not the other wallet\'s plus the order', Math.abs(est.newSzi) !== 875000)
  t('it is still a short', est.newSide === 'SHORT')
  // Weighted average of MY entry and the fill, not of a stranger's.
  t('the new average entry is mine', near(est.newEntry, (500872 * 0.003063 + 500000 * 0.005185) / 1000872, 1e-6), est.newEntry)
  t('and the new margin is mine plus the order\'s', near(est.newMargin, 259.70 + 259.25, 0.02), est.newMargin)
  // $453.84 was the screenshot: $259.25 of order margin on top of the OTHER position's $194.59.
  t('not the $453.84 that was on screen', !near(est.newMargin, 453.84, 0.02))
}

console.log(nl + '-- and the other wallet, asked for on its own terms --')
{
  const state = {
    isAllAccounts: true, tradeSide: 'short', isIsolated: false,
    perpState: { marginSummary: { accountValue: '1000' }, assetPositions: [
      pos('PUMP', -375000, 0.002828, 194.59, 0.0061, OTHER),
      pos('PUMP', -500872, 0.003063, 259.70, 0.00544399, MINE),
    ] },
  }
  const est = harness(state, OTHER)({ coin: 'PUMP', side: 'short', coinSz: 500000, price: 0.005185, leverage: 10, orderType: 'market' })
  t('trading from it adds to ITS position', near(Math.abs(est.newSzi), 875000, 1), Math.abs(est.newSzi))
  t('with its own margin', near(est.newMargin, 194.59 + 259.25, 0.02), est.newMargin)
}

console.log(nl + '-- a single account is unaffected --')
{
  const state = {
    isAllAccounts: false, tradeSide: 'long', isIsolated: false,
    perpState: { marginSummary: { accountValue: '5000' }, assetPositions: [pos('ETH', 2, 3000, 600, 2500, null)] },
  }
  const est = harness(state, null)({ coin: 'ETH', side: 'long', coinSz: 1, price: 3100, leverage: 10, orderType: 'market' })
  t('it still finds the position', near(est.newSzi, 3, 1e-9))
  t('and averages the entry', near(est.newEntry, (2 * 3000 + 1 * 3100) / 3, 1e-9))
}

console.log(nl + '-- reducing and flipping still read the right wallet --')
{
  const state = {
    isAllAccounts: true, tradeSide: 'long', isIsolated: false,
    perpState: { marginSummary: { accountValue: '2597' }, assetPositions: [
      pos('PUMP', -375000, 0.002828, 194.59, 0.0061, OTHER),
      pos('PUMP', -500872, 0.003063, 259.70, 0.00544399, MINE),
    ] },
  }
  const buy = harness(state, MINE)
  t('a partial buy reduces MY short', near(Math.abs(buy({ coin: 'PUMP', side: 'long', coinSz: 100000, price: 0.005185, leverage: 10, orderType: 'market' }).newSzi), 400872, 1))
  // 500,872 bought back exactly closes mine; against the other wallet's 375,000 it would have
  // read as a flip into a 125,872 long.
  const flat = buy({ coin: 'PUMP', side: 'long', coinSz: 500872, price: 0.005185, leverage: 10, orderType: 'market' })
  t('buying my whole size closes it', Math.abs(flat.newSzi) < 1e-6 && flat.newSide === 'CLOSED', flat.newSzi)
  const over = buy({ coin: 'PUMP', side: 'long', coinSz: 600000, price: 0.005185, leverage: 10, orderType: 'market' })
  t('and buying past it flips to a long of the remainder', near(over.newSzi, 99128, 1) && over.newSide === 'LONG', over.newSzi)
}

console.log(nl + '-- every screen on the ticket asks the same way --')
{
  // Three copies of the same lookup, and the one that sends orders.
  t('the estimator scopes to the trading account',
    /const pos      = _tradePositions\(\)\.find\(p => p\.position\.coin === coin\)\?\.position/.test(cli))
  t('so does the desktop preview',
    /const existingPos = _tradePositions\(\)\s*\n\s*\.find\(p => p\.position\.coin === coin\)\?\.position/.test(cli))
  t('and the chart that draws entry and liquidation',
    /const pos = _tradePositions\(\)\s*\n\s*\.find\(p => p\.position\.coin === coin\)\?\.position/.test(cli))
  // This one does not merely display a wrong number: it closes a size.
  t('the bot\'s close intent scopes to its own account',
    /String\(p\.position\?\._acctAddr \?\? ''\)\.toLowerCase\(\) === String\(acct\)\.toLowerCase\(\)/.test(cli))
  // And nothing in the ticket reaches past it again.
  const est = grab('function _orderEstimate(')
  t('the estimator does not read the aggregate at all', !/state\.perpState\?\.assetPositions/.test(est))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
