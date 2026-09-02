// A device bot can trade more than one market.
//
// It used to be pinned to exactly one, which made a portfolio strategy — the same rule over
// fifteen markets — fifteen separate installs to start, stop and watch. The card now carries
// a LIST, and that list is the guardrail: an intent may name any market on it and no other.
//
// The list replacing "one coin" must not be a way to trade markets the user never chose, so
// most of what follows is about refusal.
import fs from 'fs'
import { DeviceBot, botCoins } from '../../src/devicebot.js'

const bot = fs.readFileSync('src/devicebot.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- what counts as the bot\'s markets --')
t('a list is the list', botCoins({ coins: ['ZEC', 'XMR'] }).join() === 'ZEC,XMR')
t('duplicates collapse', botCoins({ coins: ['ZEC', 'ZEC', 'XMR'] }).join() === 'ZEC,XMR')
t('junk in the list is dropped', botCoins({ coins: ['ZEC', '', null, 7, 'XMR'] }).join() === 'ZEC,XMR')
// Every bot installed before this existed has only `coin`, and must keep working untouched.
t('a bot saved before lists still has its market', botCoins({ coin: 'BTC' }).join() === 'BTC')
t('an empty list falls back to the single coin', botCoins({ coin: 'BTC', coins: [] }).join() === 'BTC')
t('a bot with neither has no markets', botCoins({}).length === 0)
t('and nothing throws on rubbish', botCoins(null).length === 0 && botCoins({ coins: 'ZEC' }).join() === '')

console.log(nl + '-- the list is a guardrail, not a hint --')
const mk = (def) => new DeviceBot({ maxUsd: 1000, maxPerMin: 100, maxOpen: 10, ...def }, { onChange() {} })
const b = mk({ coin: 'ZEC', coins: ['ZEC', 'XMR'] })
const ctx = { orders: [], openOrders: [] }
const buy = (coin) => ({ type: 'market', coin, isBuy: true, usd: 25 })

t('a market on the list passes', b._check(buy('ZEC'), ctx) === null)
t('the other one does too', b._check(buy('XMR'), ctx) === null)
t('one that is not is refused', /not one of this bot's markets/.test(b._check(buy('DOGE'), ctx) ?? ''))
t('the refusal names what IS allowed', /ZEC, XMR/.test(b._check(buy('DOGE'), ctx) ?? ''))
t('naming no market means the home market', b._check({ type: 'market', isBuy: true, usd: 25 }, ctx) === null)
t('a non-string market is refused',
  /must be a market name/.test(b._check({ type: 'market', coin: 42, isBuy: true, usd: 25 }, ctx) ?? ''))

// Closing and cancelling skip the size and rate caps — reducing risk should never be
// blocked. They must NOT skip the market list: closing a position in a market the user
// never listed is still trading a market the user never listed.
t('close on a listed market passes', b._check({ type: 'close', coin: 'XMR' }, ctx) === null)
t('close on an unlisted one is refused', b._check({ type: 'close', coin: 'DOGE' }, ctx) !== null)
t('cancel on an unlisted one is refused', b._check({ type: 'cancel', coin: 'DOGE', oid: 1 }, ctx) !== null)
t('why that is deliberate is recorded', bot.includes('is still trading a market the'))

const old = mk({ coin: 'BTC' })
t('a pre-list bot still trades its market', old._check(buy('BTC'), ctx) === null)
t('and still cannot trade another', old._check(buy('ETH'), ctx) !== null)

console.log(nl + '-- caps apply across the markets, not per market --')
// A cap of ten that each of fifteen markets could reach on its own is a cap of a hundred
// and fifty.
const c = mk({ coin: 'ZEC', coins: ['ZEC', 'XMR', 'NEAR'], maxOpen: 3 })
const resting = (n, coin) => ({ orders: Array.from({ length: n }, () => ({ coin })), openOrders: [] })
const lim = (coin) => ({ type: 'limit', coin, isBuy: true, usd: 25, px: 100 })
t('three resting in one market fills a cap of three',
  /already 3 resting/.test(c._check(lim('XMR'), resting(3, 'ZEC')) ?? ''))
t('counted across all of them, not just the one being ordered',
  c._check(lim('ZEC'), resting(3, 'NEAR')) !== null)
t('another bot\'s orders do not count against it',
  c._check(lim('ZEC'), resting(3, 'DOGE')) === null)
t('why is recorded', bot.includes('is a cap of a hundred'))
t('the per-order cap still applies to every market',
  /over the \$1000 per-order limit/.test(mk({ coin: 'ZEC', coins: ['ZEC', 'XMR'] })
    ._check({ type: 'market', coin: 'XMR', isBuy: true, usd: 5000 }, ctx) ?? ''))

console.log(nl + '-- a tick may speak for every market --')
// Ten intents was ample for one market and silently wrong for fifteen: at a shared window
// boundary every market can want to turn over at once, and the eleventh would vanish.
const exec = grab(bot, 'async _execute(intents)')
t('the per-tick cap scales with the market count', exec.includes('DeviceBot.coinsOf(this.def).length * 2'))
t('it never drops below the old ten', exec.includes('Math.max(10,'))
t('and an overflow is said out loud, not swallowed',
  exec.includes('only the first') && exec.includes("this.say('warn'"))
t('why ten was wrong is recorded', bot.includes('silently wrong for one on fifteen'))

console.log(nl + '-- the app routes each intent to its own market --')
const ex = grab(cli, 'async function _devBotExecute')
t('the coin comes from the intent, falling back to home', ex.includes('const coin = it.coin ?? def.coin'))
t('and execute re-checks the list itself', ex.includes("botCoins(def).includes(coin)"))
t('why it repeats the check is recorded', ex.includes('one refactor away from not existing'))
t('the error names the market that has no price', ex.includes("'no mark price for ' + coin"))

const snap = grab(cli, 'function _devBotSnapshot')
t('the bot is told which markets it may use', snap.includes('coins: botCoins(def)'))
t('and given a mark for each', snap.includes('marks: Object.fromEntries('))
t('a mark of zero is left out rather than passed as 0',
  snap.includes('.filter(([, p]) => p > 0)'))
t('the config carries the list too', snap.includes('coins: botCoins(def),'))

console.log(nl + '-- the card --')
t('the editor keeps a list', cli.includes('id="devBotCoins"'))
t('markets show as chips', cli.includes('function _devBotChipsHtml'))
t('one can be added', cli.includes('window.__devBotAddCoin'))
t('and removed', cli.includes('window.__devBotRemoveCoin'))
t('but never all of them', grab(cli, 'window.__devBotRemoveCoin = function').includes('if (!list.length) return'))
t('removing repaints only the chips, not the sheet',
  grab(cli, 'function _devBotCoinsSet').includes('chips.innerHTML'))
t('why not the whole sheet is recorded', cli.includes('throw away the file the'))
t('the saved coin is the first of the list', cli.includes('coin: coinList[0],'))
t('the picker is an action, not a selection',
  cli.includes("_T('— pick one to add —'"))
t('it resets after each add', grab(cli, 'window.__devBotAddCoin = function').includes("if (sel) sel.value = ''"))
t('why a sticky picker was confusing is recorded',
  cli.includes('reads as "this bot trades BTC"'))
t('an empty list keeps the market the bot already had, rather than becoming BTC',
  cli.includes("coinList = [existingId ? (devBotsLoad().find(b => b.id === existingId)?.coin) : null]"))
t('and only a bot with no history at all defaults to BTC',
  cli.includes("if (!coinList.length) coinList = ['BTC']"))
t('the docs tell the next author how to name a market',
  bot.includes("Add a 'coin' to send one to another of your markets"))
t('and that the list is the limit', bot.includes('that list is the guardrail'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
