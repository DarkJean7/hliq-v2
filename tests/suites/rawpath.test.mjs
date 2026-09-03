// The other route to the exchange answers to the same card.
//
// A device bot can place an order two ways: return an intent, which DeviceBot._check
// measures against the card, or call api.order() directly. Only the first was checked.
// The method allow-list and the rate cap applied to both; the market, the order size and
// the resting-order cap did not — so a bot carded "BTC, ETH, max $40" could place $5,000
// of anything through api.order() and the app would sign it.
//
// Not a way to steal a key: the worker never holds one. A way to lose an account, which is
// the risk the caps exist for, and it made two of the three decorative.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const trd = fs.readFileSync('src/trading.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}
const guard = grab(cli, 'async function _devBotCheckRaw')
const bridge = grab(cli, 'async function _devBotRequest')

console.log(nl + '-- the guard exists and runs before anything is signed --')
t('there is a guard', guard.length > 400)
t('the bridge calls it', bridge.includes('await _devBotCheckRaw(def, method, args, bot)'))
t('before the dry-run branch, so a preview reports refusals too',
  bridge.indexOf('_devBotCheckRaw') < bridge.indexOf('if (bot?.dry)'))
t('and before the order is sent', bridge.indexOf('_devBotCheckRaw') < bridge.indexOf('exchangeAction(acct'))
t('why the gap mattered is recorded', cli.includes('could place'))
t('and that it is not a key-theft hole', cli.includes('not a way to steal a key'))

console.log(nl + '-- an asset id is resolved by the one function that knows how --')
// Three encodings: main dex is a plain index, HIP-3 is 100000 + dexIdx*10000 + i, an
// outcome market is 100_000_000 + N. A second copy of that would drift and start refusing
// legitimate HIP-3 orders.
t('trading.js exports the resolver', trd.includes('export async function assetIdFor(coin)'))
t('it delegates to the existing one', trd.includes('return (await getAssetInfo(coin)).index'))
t('main.js imports it rather than reimplementing', cli.includes('  assetIdFor,'))
t('the guard does not do its own id arithmetic',
  !guard.includes('100000 +') && !guard.includes('100_000_000'))
t('why it must be that function is recorded', trd.includes('second copy would drift and start refusing legitimate HIP-3 orders'))

console.log(nl + '-- forward, not reverse --')
// Resolving the few coins on the card and looking the order's id up in THAT is the cheap
// direction; a reverse map over the whole exchange would need the same three encodings.
t('the card is resolved, not the exchange', guard.includes('for (const c of allowed)'))
t('and the order id is looked up in it', guard.includes('byId.get(Number(a))'))
t('why that direction is recorded', cli.includes('Forward, not reverse'))

console.log(nl + '-- every shape of argument is covered --')
// The bug this nearly shipped with: batchModify is { modifies: [{ oid, order }] }, not
// { orders }. Read as the latter it checks nothing and passes everything, which is worse
// than not checking, because it looks checked.
t('order carries orders[]', guard.includes("method === 'order' ? (args?.orders ?? [])"))
t('batchModify unwraps modifies[].order',
  guard.includes("(args?.modifies ?? []).map(m => m?.order)"))
t('modify carries a single order', guard.includes("method === 'modify' ? [args?.order]"))
t('twapOrder carries twap', guard.includes("method === 'twapOrder' ? [args?.twap]"))
t('updateLeverage and updateIsolatedMargin carry asset',
  guard.includes("method === 'updateLeverage' || method === 'updateIsolatedMargin' ? args?.asset"))
t('twapCancel carries a', guard.includes("method === 'twapCancel' ? args?.a"))
t('cancel and cancelByCloid carry cancels[], keyed differently',
  guard.includes('const a = c?.a ?? c?.asset'))
t('the batchModify shape trap is recorded', cli.includes('NOT { orders }'))

console.log(nl + '-- what is checked --')
t('the market, against the card', guard.includes("is not one of this bot's markets"))
t('the refusal names what IS allowed', guard.includes('${allowed.join(\', \')}'))
t('the order size, against max per order', guard.includes('per-order limit you set'))
t('priced from the order, falling back to the mark', guard.includes('Number(o?.p) > 0 ? Number(o.p) : _livePx(coin)'))
t('a size that cannot be priced is refused, not waved through',
  guard.includes('cannot price ${coin} to check it'))
t('resting orders, against the cap', guard.includes('already ${already} resting orders, limit ${cap}'))
t('counted across the bot\'s own markets only', guard.includes('mine.has(o.coin)'))
t('an IOC order is not counted as resting', guard.includes("o.t.limit.tif !== 'Ioc'"))
t('a cap of 0 means no cap, as everywhere else', guard.includes('if (cap > 0'))
t('and a maxUsd of 0 likewise', guard.includes('if (def.maxUsd > 0)'))

console.log(nl + '-- reducing risk still answers to the market list --')
// Cancelling or setting leverage on a market the user never listed is still reaching into
// a market the user never listed, even though neither opens a position.
t('cancel is market-checked', guard.includes("for (const c of (args?.cancels ?? []))"))
t('so is updateLeverage', guard.includes("method === 'updateLeverage'"))
t('why is recorded', cli.includes('is still reaching into a'))

console.log(nl + '-- a lookup failure is not a policy violation --')
// A network blip must not be logged as the bot having tried to trade something forbidden,
// or it sends you hunting a rule violation that never happened.
t('unresolved markets are tracked', guard.includes('const unresolved = []'))
t('and reported as themselves', guard.includes('could not look up ${unresolved.join'))
t('the call is still refused, not waved through', guard.includes('— not sent'))
t('why the two are told apart is recorded', cli.includes('rule violation that never happened'))

console.log(nl + '-- a bot with no markets can do nothing --')
t('an empty card is refused outright', guard.includes("throw new Error('this bot has no markets on its card')"))

console.log(nl + '-- what was already true stays true --')
t('the method allow-list still applies', bridge.includes('_DEVBOT_METHODS.has(method)'))
t('withdrawals were never on it',
  !grab(cli, 'const _DEVBOT_METHODS = new Set').includes('withdraw'))
t('nor was approving another agent',
  !grab(cli, 'const _DEVBOT_METHODS = new Set').includes('approveAgent'))
t('the rate cap still covers both routes', bridge.includes('_DEVBOT_PLACING.has(method) && bot?.rateBlocked()'))
t('a dry run still closes this route', bridge.includes("bot.say('info', 'Would call api.'"))
const bot = fs.readFileSync('src/devicebot.js', 'utf8').replace(/\r\n/g, '\n')
t('the intent path keeps its own checks', bot.includes('const why = this._check(it, ctx)'))


console.log(nl + '-- a practice account is for finding out whether it works --')
// A bot that sets its leverage used to run on a real account and fail on a paper one,
// which inverts what a paper account is for. The no-ops are accepted; everything the
// paper engine genuinely cannot model still throws with its reason.
t('the no-ops are named once, next to the other method sets',
  cli.includes("const _DEVBOT_PAPER_NOOP = new Set(['updateLeverage', 'updateIsolatedMargin', 'scheduleCancel'])"))
t('paper accepts them', bridge.includes('_DEVBOT_PAPER_NOOP.has(method)'))
t('and says they did nothing, rather than pretending',
  bridge.includes("does nothing on a paper account"))
t('anything it cannot model still throws',
  bridge.includes('is not simulated on the paper account'))
t('the no-op check comes after the caps, not before',
  bridge.indexOf('_devBotCheckRaw') < bridge.indexOf('_DEVBOT_PAPER_NOOP'))
t('why paper has no leverage to set is recorded',
  cli.includes('sizes every order by its notional'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
