// What the app spends of Hyperliquid's rate budget.
//
// HL allows 1200 weight/min per IP, shared between /info and /exchange — so overspending it
// does not merely stall the dashboard, it starves order placement. Documented weights: 2 for
// l2Book/allMids/clearinghouseState/orderStatus/spotClearinghouseState/exchangeStatus, 60 for
// userRole, 20 for every other info request.
//
// Measured with tests/hl-weight.mjs (stubbed, so it costs HL nothing):
//
//   ALL ACCOUNTS, 10 wallets, cold load   1380 weight/min   115% of budget
//   SINGLE ACCOUNT, steady state             339 weight/min    28%
//
// Six endpoints at weight 20 PER WALLET were 1200 of that 1380 — the whole budget, before an
// order goes out. This suite pins the cadence decisions that follow from the measurement.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

console.log(nl + '-- the heavy polls follow what is on screen --')
{
  // frontendOpenOrders and userFillsByTime are weight 20 and were polled every ~8s whatever
  // the user was looking at: 300 weight/min for one idle wallet. The tab that shows the data
  // keeps the old cadence; everything else settles for a count that can be 20s old.
  t('the cadence asks which tab is active', cli.includes("const _tabIs = (...names) => names.includes(_activeTab) || names.includes(_mobVActiveTab)"))
  t('orders poll faster only when the Orders tab is up', cli.includes("const _ordEvery   = _tabIs('orders') ? 2 : 4"))
  t('fills poll faster only for the tabs built from fills',
    cli.includes("const _fillsEvery = _tabIs('history', 'trades', 'calendar', 'performance') ? 3 : 6"))
  t('and both gates use it', cli.includes('_refreshTick % _ordEvery === 0') && cli.includes('_refreshTick % _fillsEvery === 0'))
  // A slower poll must never make an action feel slow: anything the user does forces a tick.
  t('a forced refresh still bypasses both', cli.includes('const _ordTick   = _forced ||') && cli.includes('const _fillsTick = _forced ||'))
  // Nothing is lost by polling less often — the fetch is incremental.
  t('why nothing is missed is written down', cli.includes('userFillsByTime is keyed off latestFillTs'))
  t('and the measurement that motivated it is cited', cli.includes('tests/hl-weight.mjs'))
}

console.log(nl + '-- the fan-out is still rationed --')
{
  // These were already in place and are what keeps the steady state cheap; they are pinned
  // here so a future "just fetch it every tick" cannot quietly undo the budget.
  t('the HIP-3 fan runs on a subset of ticks', cli.includes('const _fanTick  = _refreshTick === 1 || _refreshTick % 4 === 0'))
  t('the full fan is rarer still', cli.includes('const _fullFan  = _refreshTick === 1 || _refreshTick % 24 === 0'))
  t('prices are skipped on tabs that show none', cli.includes('const _needsPrices = '))
  t('and the combined view skips a wallet the WebSocket is streaming',
    cli.includes('if (_acctWsOk(r.addr)) return'))
  t('a 429 opens a breaker rather than retrying into it', cli.includes('if (_hlLimited()) return'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
