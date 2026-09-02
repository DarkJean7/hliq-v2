// A device bot's settings live on its card, not inside its file.
//
// The thing this replaces: a bot with `const RIESGO = 0.03` at the top, where changing the
// risk means editing the file, and editing the file of a running bot means re-installing
// it. Now a bot declares its knobs, the user fills them in, and they arrive as
// ctx.config.params.
import fs from 'fs'
import { parseBotParams } from '../../src/devicebot.js'

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

console.log(nl + '-- one name = value per line --')
t('a number becomes a number', parseBotParams('riesgo = 0.03').riesgo === 0.03)
t('a negative one too', parseBotParams('offset = -2').offset === -2)
t('an exponent too', parseBotParams('tiny = 1e-9').tiny === 1e-9)
t('true and false become booleans',
  parseBotParams('a = true\nb = false').a === true && parseBotParams('a = true\nb = false').b === false)
t('anything else stays a string', parseBotParams('zona = America/New_York').zona === 'America/New_York')
t('a colon separates too', parseBotParams('riesgo: 0.05').riesgo === 0.05)

console.log(nl + '-- the parts people get wrong --')
// A time is the case that made the first-separator rule necessary: splitting on every
// colon would turn 07:00 into 07.
t('a time keeps its minutes', parseBotParams('entrada = 07:00').entrada === '07:00')
t('and survives a colon separator too', parseBotParams('entrada: 07:00').entrada === '07:00')
t('a value containing = keeps it', parseBotParams('q = a=b').q === 'a=b')
t('whitespace around either side is trimmed', parseBotParams('   riesgo   =   0.03   ').riesgo === 0.03)
t('a line without a separator is skipped', Object.keys(parseBotParams('just some words')).length === 0)
t('a line with no key is skipped', Object.keys(parseBotParams('= 5')).length === 0)
t('blank lines are fine', Object.keys(parseBotParams('\n\na = 1\n\n')).length === 1)
t('# comments are ignored', parseBotParams('# riesgo = 9\nriesgo = 1').riesgo === 1)
t('// comments are ignored', parseBotParams('// riesgo = 9\nriesgo = 1').riesgo === 1)
t('a trailing comment is not part of the value', parseBotParams('riesgo = 0.03  # el de siempre').riesgo === 0.03)
t('and neither is a // one', parseBotParams('riesgo = 0.03  // as before').riesgo === 0.03)
t('a # inside a word is left alone', parseBotParams('tag = a#b').tag === 'a#b')
t('quotes are stripped, and keep the text verbatim',
  parseBotParams('s = "0.03"').s === '0.03' && parseBotParams("s = '07:00'").s === '07:00')
t('an empty value is an empty string, not a zero', parseBotParams('s =').s === '')
t('nothing at all parses to nothing',
  Object.keys(parseBotParams('')).length === 0 && Object.keys(parseBotParams(null)).length === 0)
t('a later line wins', parseBotParams('a = 1\na = 2').a === 2)

console.log(nl + '-- why not JSON, written down --')
t('the choice is explained', bot.includes('JSON was the obvious alternative and was rejected'))
t('and so is the failure it avoids', bot.includes('without saying why'))

console.log(nl + '-- the settings reach the bot --')
const snap = grab(cli, 'function _devBotSnapshot')
t('the snapshot carries a config', snap.includes('config: {'))
t('it carries the card fields',
  ['coin: def.coin', 'maxUsd: def.maxUsd', 'maxPerMin: def.maxPerMin', 'maxOpen: def.maxOpen',
   'everySec: def.everySec', 'leverage: def.leverage'].every(x => snap.includes(x)))
t('and the parsed settings', snap.includes('params: parseBotParams(def.params'))
t('a bot can tell it is a dry run', snap.includes('dry: !!'))
t('the parser is imported, not redefined', cli.includes('parseBotParams } from \'./devicebot.js\''))

console.log(nl + '-- reading a cap is not the same as being allowed to widen it --')
// The caps are in ctx so a bot can size an order that will pass. They are still checked
// here, after the bot has spoken, and the check does not consult ctx.
t('why the caps are readable is recorded', snap.includes('as information, not as permission'))
t('the check still runs in the main thread', bot.includes('_check(') && bot.includes('over the'))
t('and the limits are not reachable from the worker',
  bot.includes('A bot cannot widen its own limits — they are not in') ||
  bot.includes('they are not in' + nl + ' * the worker'))

console.log(nl + '-- the field is on the card --')
t('the editor has a settings box', cli.includes('id="devBotParams"'))
t('it is saved with the rest of the definition', cli.includes("params: document.getElementById('devBotParams')?.value ?? ''"))
t('the raw text is kept, not a re-serialised object',
  cli.includes('Stored as the TEXT the user typed'))
t('why that matters is recorded', cli.includes('comments, order and'))
t('the field is escaped when it is painted back', cli.includes("${esc(d.params ?? '')}"))
t('the contract is documented for whoever writes the next bot',
  bot.includes('config: { coin, maxUsd, maxPerMin, maxOpen, everySec, leverage, dry,'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
