// The bot file format: explicit enough that someone who has never seen this repo can
// write a file that works first time.
import fs from 'fs'
const bot = fs.readFileSync('src/devicebot.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- a bot may use any name it likes --')
// Evaluated globally, a file declaring its own `log` would silently replace the harness
// one, and `const api` would die on "already declared" — an error blaming our harness for
// something the author did nothing wrong to cause.
t('user code runs in a function scope, not the global one', bot.includes("const factory = new Function('api', 'log',"))
t('the helpers are passed in, not left as globals', bot.includes('__onTick = factory(api, log)'))
t('it is no longer eval-ed into the worker global', !bot.includes(';(0, eval)(m.code)'))
t('the collision problem is written down', bot.includes('collision-proof'))
t('and the exact error it used to cause is named', bot.includes("has already been declared"))
t('the format doc promises this', cli.includes('will not clash with the app'))

console.log(String.fromCharCode(10) + '-- a file ending in a line comment still works --')
// `code + ";return ..."` would be swallowed by a trailing // comment.
t('the return is separated by a real newline', bot.includes('String.fromCharCode(10) +'))
t('not by a semicolon alone', !bot.includes("m.code + ';return"))
t('why is recorded', bot.includes('last line is a // comment would otherwise swallow it'))

console.log(String.fromCharCode(10) + '-- the format is documented in the app --')
t('there is a spec sheet', cli.includes('window.__devBotSpec = function()'))
t('reachable from the section', cli.includes(`onclick="window.__devBotSpec()"`))
// Two call sites: the section header and the file field in the add/edit form. The
// definition itself is `window.__devBotSpec = function()`, which is not a call.
t('and from the add/edit form', (cli.match(/__devBotSpec\(\)/g) || []).length === 2)
t('why it lives in the app, not a README, is recorded',
  cli.includes('the person writing the file is often not'))

const spec = cli.slice(cli.indexOf('window.__devBotSpec = function()'), cli.indexOf('function _devBotInstallSheet'))
console.log(String.fromCharCode(10) + '-- and it actually says the things a writer needs --')
t('the one required function', spec.includes('function onTick(ctx) {'))
t('that it may be async', spec.includes('It may be <b>async</b>'))
t('the tick interval is the one you set', spec.includes('N is the interval'))
for (const k of ['coin:', 'mark:', 'position:', 'openOrders:', 'candles:', 'mids:', 'positions:', 'orders:', 'margin:', 'equity:', 'paper:'])
  t(`ctx documents ${k}`, spec.includes(k), k)
t('it warns that mids are strings', spec.includes('Hyperliquid gives as strings'))
t('all four intent shapes are shown',
  ['"market"', '"limit"', '"cancel"', '"close"'].every(x => spec.includes(x)))
t('it says sizes are USD, not coins', spec.includes('in <b>USD</b>, not coins'))
t('the api surface is listed', ['api.info', 'api.candles', 'api.order', 'api.cancel', 'api.exchange']
  .every(x => spec.includes(x)))
t('it states the app signs, not the file', spec.includes('signed by the app, not by your file'))
t('and what is refused', spec.includes('moves funds, or approves another agent, is refused'))
t('log() is documented', spec.includes('log("anything"'))
t('and that console.log is invisible', spec.includes('<b>console.log</b> goes nowhere'))
t('the missing globals are listed', ['window', 'document', 'localStorage', 'require']
  .every(x => spec.includes(x)))
t('it explains WHY they are missing', spec.includes('This is a Web Worker'))
t('it says fetch does work, rather than leaving it ambiguous', spec.includes('<b>fetch</b> does work'))
t('error behaviour is stated', spec.includes('A throw inside one tick is logged'))
t('a complete runnable example is included', spec.includes('const sma20  = closes.slice(-20)'))

console.log(String.fromCharCode(10) + '-- the refusal messages tell you the fix --')
t('no onTick names the function to define', bot.includes('Define: function onTick(ctx) { ... }'))
t('a parse failure is reported, not swallowed', bot.includes("'Could not load: '"))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
