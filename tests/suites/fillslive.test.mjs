// A trade shows up everywhere the moment Hyperliquid reports it.
//
// "lets make the app reaction faster when a trade is made. some data take time to update. for
// example the celebration of a trade being closed, history, calendar". A single account learned
// about its fills only on the poll (15–30s); the combined view folded socket fills into the stored
// history but left the wallet rows — which History, Calendar, the celebration and the "Order
// filled" card read — to the five-minute refresh. These assert the wiring that closes both gaps.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c) => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n))
const main = fs.readFileSync('src/main.js', 'utf8')
const fn = (name) => {
  const i = main.indexOf(name)
  return i < 0 ? '' : main.slice(i, i + 2600)
}

console.log('-- single account --')
{
  const sync = fn('async function _singleFillsWsSync()')
  t('subscribes to its own fills', /subsClient\(\)\.userFills\(\{ user: want \}/.test(sync))
  t('only for a real address, never the combined or paper sentinel', /!state\.isAllAccounts && !isPaper\(\) && _isRealAddr\(state\.addr\)/.test(sync))
  t('the replayed snapshot is not news', /ev\?\.isSnapshot/.test(sync))
  t('a push forces the refresh an action of your own would', /refreshLive\(true\)/.test(sync))
  t('at most one forced refresh every 5s (a grid bot fills often)', /_singleFillsLast \+ 5000/.test(sync))
  t('an account switch drops the old subscription', /old\?\.unsubscribe/.test(sync))
  const rl = fn('async function refreshLive(force = false)')
  t('every tick keeps the subscription on the right account', /_singleFillsWsSync\(\)/.test(rl))
  t('a forced refresh during one in flight runs right after, not at the next tick',
    /if \(_refreshInProgress\) \{ if \(force\) _refreshAgain = true; return \}/.test(rl)
    && /if \(_refreshAgain\) \{ _refreshAgain = false;/.test(main))
}

console.log('-- All Accounts --')
{
  const ws = fn('async function _startHistWs(entries)')
  t('a socket fill reaches the wallet row too', /_comboFillsLive\(addr, ev\.fills\)/.test(ws))
  const live = fn('function _comboFillsLive(addr, raw)')
  t('in the row\'s own shape, without duplicates', /parseFills\(raw\)\.filter\(f => !have\.has\(fillKey\(f\)\)\)/.test(live))
  t('the "Order filled" card hears it at once', /notifyFills\(raw, \{ acct: r\.addr/.test(live))
  t('and a hidden wallet stays quiet', /!_maHiddenLoad\(\)\.has\(r\.addr\)/.test(live))
  t('History, Calendar and the celebration repaint once per burst', /_allAcctReaggregate\(\)/.test(live) && /setTimeout\(/.test(live))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
