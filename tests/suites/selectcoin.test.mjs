// One market is selected at a time, and every part of the ticket agrees which one.
//
// Reported: "wth btc is selected and for some reason its says 'buy/long io:OAI' also with the
// leverage set correctly li==at 6x like it is really OAI".
//
// Reproduced on the code as it was, by selecting io:OAI and then opening BTC from the watch
// strip:
//
//   selected  BTC          chip  BTC          sum-price  $77,849.50
//   button    io:OAI       levMax 6
//
// Half the ticket had moved to BTC and half had not — and the half that had not was the half
// that decides what a click actually does. __watchOpenTrade set the coin, the header, the
// summary and the chart by hand, which was a copy of __selectCoin missing two lines: the submit
// button and the leverage cap. A partial copy of a function is a bug with a delay on it.
//
// So the rule this suite exists to hold: ONE writer of state.selectedCoin, and everybody goes
// through it.
import fs from 'fs'

const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

const grab = (sig) => {
  const start = CLI.indexOf(sig)
  if (start < 0) throw new Error('not found: ' + sig)
  let i = CLI.indexOf('{', start), depth = 0
  for (; i < CLI.length; i++) {
    if (CLI[i] === '{') depth++
    else if (CLI[i] === '}') { depth--; if (depth === 0) return CLI.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

console.log(nl + '-- exactly one thing may change the selected market --')
{
  const writes = CLI.match(/state\.selectedCoin\s*=[^=]/g) ?? []
  t('there is one writer, not two', writes.length === 1, writes.length)
  t('and it is __selectCoin',
    grab('window.__selectCoin = function (coin)').includes('state.selectedCoin = coin'))
}

console.log(nl + '-- and it moves every part of the ticket together --')
{
  const fn = grab('window.__selectCoin = function (coin)')
  // The two that were missing from the hand-rolled copy are the two that matter most: the
  // button says what a click will do, and the cap says what leverage the market allows.
  t('the submit button follows the coin', fn.includes('updateSubmitBtn()'))
  t('so does the leverage cap', fn.includes('slider.max = maxLev'))
  t('and it is the market’s own maximum', fn.includes('const maxLev     = _coinMaxLev(coin)'))
  // A leverage above the new market's ceiling is pulled down; one below is left alone, because
  // it is a choice the user made and 6x is a legal leverage on a 40x market.
  t('a leverage above the new ceiling is pulled down', fn.includes('if (state.leverage > maxLev)'))
  t('the header follows', fn.includes('updateCoinHeader(coin)'))
  t('the summary follows', fn.includes('updateOrderSummary()'))
  t('the chart follows', fn.includes('loadTradeChart(coin)'))
}

console.log(nl + '-- every entry point goes through it --')
{
  // Four ways to pick a market, and they must not each re-implement the ticket.
  t('the watch strip', grab('window.__watchOpenTrade = function(coin)').includes('window.__selectCoin(coin)'))
  t('the mobile coin picker', grab('window._mobVSelectTradeCoin = function(coin)').includes('window.__selectCoin(coin)'))
  t('the mobile markets list', grab('window._mobSelectMarket = function(coin)').includes('window.__selectCoin(coin)'))
  t('the trade-card search', grab('window._tcsSelect = function(coin)').includes('window.__selectCoin(coin)'))
  t('and the desktop dropdown row calls it directly', CLI.includes("onclick=\"window.__selectCoin('${coin}')\""))
  // The specific regression: a partial copy of the selection logic.
  t('no path sets the coin and the header by hand any more',
    !/state\.selectedCoin = coin\s*\n\s*updateCoinHeader\(coin\)/.test(CLI))
  t('why is written down', CLI.includes('not a hand-rolled subset of it'))
}

console.log(nl + '-- the header updates the trade chip too, and can be told nothing --')
{
  // updateCoinHeader returns early twice before it reaches the trade-card chip: once when the
  // market header is not on the page, once when the coin is null. Neither is a reason to leave
  // a stale ticker sitting in the ticket — worth knowing about if this desyncs again.
  const fn = grab('function updateCoinHeader(coin)')
  t('the chip is part of the same function', fn.includes("document.getElementById('tcsCoinInput')"))
  t('and it is documented as such', fn.includes('Also update trade card search bar'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
