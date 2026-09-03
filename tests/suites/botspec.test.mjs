// The bot file format describes the runner it ships with.
//
// The spec is the only thing a stranger reads. The person writing a bot file often does
// not have this repo — a friend hands over a .js and never sees main.js — so if the spec
// and _devBotSnapshot disagree, the spec wins in practice and the bot is wrong.
//
// That already happened: ctx grew `coins`, `marks` and `config`, intents grew a `coin`
// field, and the spec said none of it. A card could list fifteen markets while its file,
// written from the spec, could only ever touch one, and nothing anywhere said so.
//
// So this suite does not check the prose. It reads the keys the snapshot actually hands a
// bot and insists each one is written down somewhere a bot author will see.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const region = (sig, end) => {
  const i = cli.indexOf(sig); if (i < 0) return ''
  const j = cli.indexOf(end, i)
  return j < 0 ? cli.slice(i) : cli.slice(i, j)
}
const spec = region('window.__devBotSpec = function()', 'function _devBotInstallSheet')
const snap = region('function _devBotSnapshot(def, bot)', '// An approved intent becomes an order')

console.log(nl + '-- both halves exist --')
t('the spec is in the app, not only in a README', spec.length > 2000, String(spec.length))
t('and it is reachable from a bot card', /__devBotSpec\(\)/.test(cli))
t('the snapshot is the thing it describes', snap.length > 1000, String(snap.length))
// The rationale sits in the JSDoc above the function, which is outside `spec`.
t('why it lives in the app is written down', cli.includes('never sees this codebase'))

console.log(nl + '-- every field the snapshot hands a bot is documented --')
// Keys of the object _devBotSnapshot returns: one indent level inside `return {`.
const body = snap.slice(snap.indexOf('return {'))
const keys = [...new Set(
  [...body.matchAll(/^ {4}([a-zA-Z][a-zA-Z0-9]*)\s*[:,]/gm)].map(m => m[1])
)]
t('the keys were actually found', keys.length >= 12, keys.join(','))
for (const k of keys) t(`ctx.${k} is in the spec`, spec.includes(k), keys.join(','))

console.log(nl + '-- and so is every way a bot can act --')
// The intent types _devBotExecute branches on, plus the market an intent may name.
const exec = region('async function _devBotExecute(def, it)', 'const _DEVBOT_METHODS')
const types = [...new Set([...exec.matchAll(/it\.type === '([a-z]+)'/g)].map(m => m[1]))]
t('the intent types were found', types.length >= 3, types.join(','))
for (const ty of types) t(`the "${ty}" intent is in the spec`, spec.includes(`"${ty}"`), types.join(','))
t('so is naming a market on an intent', /type: "market", coin:/.test(spec))
t('and that the card is a ceiling, not a shopping list',
  spec.includes('not</b> a list of what to trade'))
t('the trap that cost a real afternoon is spelled out',
  spec.includes('never reads <b>ctx.coins</b> only ever touches its home market'))

console.log(nl + '-- what a practice account does differently --')
// A spec that only describes the real exchange sends people to debug a paper account.
t('the spec has a paper section', spec.includes('On a practice account'))
t('it says intents are simulated', /intents.*simulated/s.test(spec))
t('it names the methods paper accepts but ignores',
  spec.includes('updateLeverage') && spec.includes('accepted, does nothing'))
t('every no-op the runner allows is listed in the spec',
  ['updateLeverage', 'updateIsolatedMargin', 'scheduleCancel'].every(m => spec.includes(m)))
t('and it warns that anything else throws', spec.includes('anything else'))
t('the reason leverage is a no-op is given, not just the rule',
  spec.includes('sizes every order by its notional'))

console.log(nl + '-- the sandbox rules a stranger cannot guess --')
t('no window, document or localStorage', spec.includes('<b>window</b>'))
t('no imports — it is one file', spec.includes('put everything in the one file'))
t('console.log goes nowhere', spec.includes('<b>console.log</b> goes nowhere'))
t('onTick may be async', spec.includes('<b>async</b>'))
t('sizes are USD, not coins', spec.includes('Sizes are in <b>USD</b>'))
t('candles start empty', spec.includes('empty on the first few ticks'))
t('the key is never in the sandbox', spec.includes('your key is never inside the sandbox'))

console.log(nl + '-- it is readable in both languages --')
// A spec only half-translated is worse than one not translated at all: the reader cannot
// tell which half they are missing.
const es = [...spec.matchAll(/_T\(/g)].length
t('every paragraph goes through _T', es >= 20, String(es))
t('the paper section is translated', spec.includes('En una cuenta de práctica'))
t('so is the market-list warning', spec.includes('no</b> una lista de qué operar'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
