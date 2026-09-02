// A running device bot belongs to the account it was STARTED on.
//
// The order path asks for "the current account" every time it sends, and nothing held a
// running bot to the one it was armed for. Switching accounts handed the bot over: on
// paper, two accounts filling with the same bot's trades — which reads as one account with
// mixed data, and is what a user reported. On a real wallet it is worse: a bot armed for
// one wallet quietly trading another.
import fs from 'fs'
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

console.log(nl + '-- an account id that can tell two paper accounts apart --')
// Every paper account shares the address __paper__, so the address alone cannot.
const id = grab(cli, 'function _botAcctId')
t('there is one', id.length > 40)
t('paper is keyed by SLOT, not by address', id.includes("return 'paper:' + paperSlot()"))
t('a real wallet is its own address', id.includes('_stratTargetAddr()'))
t('why the address is not enough is recorded', cli.includes('cannot' + nl + ' * distinguish them') ||
  cli.includes('the address alone cannot'))

console.log(nl + '-- the bot is bound when it starts --')
t('starting records the account', cli.includes('bot.acctId = _botAcctId()'))
t('and says what it is for', cli.includes('the account it is now bound to'))

console.log(nl + '-- and stops if you leave that account --')
const chg = grab(cli, 'function _devBotAcctChanged')
t('there is a guard', chg.length > 100)
t('it does nothing while the account is unchanged', chg.includes('if (_botAcctId() === bot.acctId) return false'))
t('a bot with no recorded account is left alone', chg.includes('!bot.acctId'))
t('an already-stopped bot is not stopped twice', chg.includes('bot.stopped'))
t('it stops the bot rather than merely warning', chg.includes('bot.stop()'))
t('and says why, in the bot\'s own log', chg.includes("bot.say('warn'") && chg.includes('the account changed'))
t('the message tells you how to run it here', chg.includes('start it again here'))
t('the card is repainted so it does not still read as running', chg.includes('_mobVRenderStrategies'))
t('a failed repaint cannot swallow the stop', chg.includes('try { _mobVRenderStrategies'))

console.log(nl + '-- both routes to the exchange are covered --')
const snap = grab(cli, 'function _devBotSnapshot')
t('the tick path checks first, before any ctx is built',
  snap.indexOf('_devBotAcctChanged(bot)') < snap.indexOf('const coin = def.coin'))
t('and returns nothing, so no intent can form', snap.includes('if (_devBotAcctChanged(bot)) return null'))
t('why returning null is enough is recorded', cli.includes('it cannot form an intent against an'))
t('the raw api path checks too',
  cli.includes("if (_devBotAcctChanged(bot)) throw new Error('the account changed"))
t('and it runs before the order is signed',
  cli.indexOf('_devBotAcctChanged(bot)) throw') < cli.indexOf('await exchangeAction(acct, method, args)'))

console.log(nl + '-- why it stops rather than following --')
t('the reasoning is recorded', cli.includes('It cannot follow you'))
t('with the paper symptom named', cli.includes('reading as one account with'))
t('and the real-wallet one', cli.includes('quietly trading another'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
