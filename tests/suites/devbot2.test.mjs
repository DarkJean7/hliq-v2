// Device bots, part two: as capable as a built-in bot, still without the key.
//
// The bot composes an exchange action and the MAIN THREAD signs it. That gives up nothing
// a key in the sandbox would allow — an agent key can trade but cannot withdraw or
// transfer — while leaving nothing in the sandbox worth stealing.
import fs from 'fs'
const bot = fs.readFileSync('src/devicebot.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const trd = fs.readFileSync('src/trading.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (src, sig) => {
  const i = src.indexOf(sig); if (i < 0) return ''
  let j = src.indexOf('{', i), d = 0
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1) } }
  return ''
}

console.log(String.fromCharCode(10) + '-- the bot asks; the app signs --')
t('there is a request bridge', bot.includes('function __req(kind, payload)'))
t('the worker gets an api object', bot.includes('self.api = api'))
t('it can read any public info endpoint', bot.includes('info: (payload) => __req(\'info\', payload)'))
t('and send any allowed trading action', bot.includes("exchange: (method, args) => __req('exchange', { method, args })"))
t('replies are matched to their request', bot.includes("if (m.t === 'res')") && bot.includes('__waiting.get(m.id)'))
t('a rejected request rejects the promise', bot.includes('if (m.error) w.reject(new Error(m.error))'))
t('onTick may be async now', bot.includes('.then(() => __onTick(m.ctx))'))
t('and a rejected tick is logged, not fatal', bot.includes(".catch((err) => {"))
t('the signing function lives in trading.js, with the key', trd.includes('export async function exchangeAction(acct, method, args)'))
t('it refuses an action the client does not have', trd.includes('Exchange has no "${method}" action'))
t('why signing-on-request beats handing the key over is recorded',
  bot.includes('deliberately better than handing the key over'))

console.log(String.fromCharCode(10) + '-- what a bot may ask the app to sign --')
const allow = grab(cli, 'const _DEVBOT_METHODS = new Set([')
for (const m of ['order', 'cancel', 'modify', 'updateLeverage', 'twapOrder'])
  t(`${m} is available`, allow.includes(`'${m}'`), m)
// The escalation that would undo the whole design: a bot approving a SECOND agent key,
// which would then act entirely outside this sandbox.
t('approveAgent is NOT available', !allow.includes('approveAgent'))
t('and that is explained, not just omitted', cli.includes('install a SECOND agent'))
for (const m of ['withdraw3', 'usdSend', 'spotSend', 'usdClassTransfer', 'vaultTransfer', 'subAccountTransfer'])
  t(`${m} is NOT available`, !allow.includes(m), m)
t('why the fund movers are listed anyway is recorded', cli.includes('closes the door if that ever changes'))

// Drive the gate itself.
const gate = new Function(`
  ${grab(cli, 'const _DEVBOT_METHODS = new Set([').replace('const _DEVBOT_METHODS', 'const M')}
  return (m) => M.has(m)`)()
t('a known method passes the gate', gate('order') === true)
t('approveAgent does not', gate('approveAgent') === false)
t('withdraw3 does not', gate('withdraw3') === false)
t('an invented method does not', gate('drainEverything') === false)
t('an empty method does not', gate('') === false)

console.log(String.fromCharCode(10) + '-- the rate cap covers BOTH routes --')
// Without this a bot sidesteps the cap entirely by calling api.order() instead of
// returning an intent, which would make the limit decorative.
t('placing methods are identified', cli.includes('const _DEVBOT_PLACING = new Set('))
t('the bridge checks the cap before signing', cli.includes('_DEVBOT_PLACING.has(method) && bot?.rateBlocked()'))
t('and records the send after', cli.includes('if (_DEVBOT_PLACING.has(method)) bot?.noteSend()'))
t('the bot class exposes both to the bridge', bot.includes('noteSend() {') && bot.includes('rateBlocked() {'))
t('why is recorded', bot.includes('which would make the cap decorative'))

const mk = (def) => new Function('def', `${grab(bot, 'class DeviceBot')}\n return new DeviceBot(def, {})`)(def)
// `coin` is required now: the market list is checked before the caps are, and a bot with
// no markets may trade nothing. These cases are about the caps, so give it one.
const b2 = mk({ coin: 'BTC', maxUsd: 0, maxPerMin: 2, maxOpen: 0 })
t('a 0 per-order limit means no cap', b2._check({ type: 'market', usd: 1e9 }, { openOrders: [] }) === null)
t('a 0 resting limit means no cap', b2._check({ type: 'limit', usd: 5, px: 1 }, { openOrders: new Array(500) }) === null)
b2.noteSend(); b2.noteSend()
t('but the rate cap still applies', b2.rateBlocked() === true)
t('and blocks a raw send too', /rate limit/.test(b2._check({ type: 'market', usd: 5 }, { openOrders: [] })))
const b3 = mk({ maxUsd: 0, maxPerMin: 0, maxOpen: 0 })
t('a 0 rate limit switches that cap off as well', b3.rateBlocked() === false)
t('0 is a deliberate off switch, not a missing value', bot.includes('deliberately switched a limit off'))

console.log(String.fromCharCode(10) + '-- a bot now sees the whole account --')
const snap = grab(cli, 'function _devBotSnapshot(def, bot)')
for (const k of ['mids:', 'positions:', 'orders:', 'margin:', 'paper:'])
  t(`snapshot carries ${k}`, snap.includes(k), k)
t('positions include leverage and liquidation price', snap.includes('liquidationPx:') && snap.includes('leverage:'))
t('it still does NOT carry the wallet address', !/\baddr\b/i.test(snap))
t('nor the agent key', !/agentKey|privateKey/i.test(snap))
t('why it no longer restricts to one market is recorded', snap.includes('it is a widget') || cli.includes('it is a widget'))
t('the home market is still what the limits key off', snap.includes('const coin = def.coin'))

console.log(String.fromCharCode(10) + '-- paper accounts say what they cannot simulate --')
const req = grab(cli, 'async function _devBotRequest(def, kind, payload, bot)')
t('paper handles order and cancel', req.includes("if (method === 'order')") && req.includes("if (method === 'cancel')"))
t('and refuses the rest plainly rather than pretending',
  req.includes('is not simulated on the paper account'))
t('a real account needs one selected', req.includes("if (!acct) throw new Error('no account selected')"))
t('info needs no account at all', req.includes('No key, no account, nothing to gate') || req.includes('no key, no account'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
