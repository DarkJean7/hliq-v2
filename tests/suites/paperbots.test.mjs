// Two bugs a fresh paper account exposed.
//
// 1. It reported "Strats 1" with nothing running. The badge falls back to counting every
//    key in serverStatus that is `true`, and paper's synthesised status is exactly
//    { ok: true, _configs: {} } -- so it counted the online flag as a strategy.
//
// 2. Paper bots were stored under ONE key for the whole browser. Once several paper
//    accounts existed, a bot started on the practice account read as running on every
//    account created afterwards, managing a position that account does not hold.
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

console.log(nl + '-- the badge counts strategies, not bookkeeping --')
// The count, lifted out and run against the exact status paper synthesises.
const _from = cli.indexOf("const notABot = new Set(")
const src = cli.slice(_from, cli.indexOf("mobStrat.textContent = count", _from))
const count = new Function('serverStatus', `
  const isGuard = k => k.startsWith('liqguard:') || k.startsWith('levbrake:')
  const inst = Object.keys(serverStatus?._instances ?? {}).filter(k => !isGuard(k)).length
  ${src}
  return count`)

t('a fresh paper account counts nothing', count({ ok: true, _configs: {} }) === 0,
  String(count({ ok: true, _configs: {} })))
t('a paper account with one bot counts one',
  count({ ok: true, grid: true, _configs: { 'grid:': { args: ['--coin', 'HYPE'] } } }) === 1,
  String(count({ ok: true, grid: true, _configs: { 'grid:': {} } })))
t('two bots count two', count({ ok: true, grid: true, dca: true, _configs: {} }) === 2)
t('a real account counts its instances', count({ ok: true, _instances: { 'grid:HYPE': true, 'grid:SOL': true } }) === 2)
t('guards are still excluded from the instance count',
  count({ _instances: { 'grid:HYPE': true, 'liqguard:HYPE': true, 'levbrake:HYPE': true } }) === 1)
t('and from the fallback', count({ ok: true, grid: true, liqguard: true, levbrake: true, _configs: {} }) === 1)
t('every underscore key is bookkeeping', count({ ok: true, _paused: {}, _guards: {}, _instances: {} }) === 0)
t('an empty status counts nothing', count({}) === 0 && count(undefined) === 0)
t('why `ok` was counted is recorded', cli.includes('`ok`, the online flag'))
t('with the symptom, not just the rule', cli.includes('reported one running'))

console.log(nl + '-- a paper bot belongs to ONE paper account --')
const key = grab(cli, 'function _paperBotsKey')
t('the key is per slot', key.includes('paperSlot()'))
t('the practice account keeps the original key, so a running bot survives',
  key.includes("s === 'main' ? PAPER_BOTS_KEY"))
t('every other account gets its own', key.includes('`${PAPER_BOTS_KEY}_${s}`'))
t('load reads through it', cli.includes('JSON.parse(localStorage.getItem(_paperBotsKey()))'))
t('save writes through it', cli.includes('localStorage.setItem(_paperBotsKey(), JSON.stringify(m))'))
t('no caller still reads the bare key directly',
  !/getItem\(PAPER_BOTS_KEY\)/.test(cli) && !/setItem\(PAPER_BOTS_KEY,/.test(cli))
t('why sharing one key was wrong is recorded',
  cli.includes('managing a position that account does not hold'))

console.log(nl + '-- deleting an account takes its bots with it --')
const del = grab(cli, 'window.__paperAcctDelete = function')
t('the bot config is removed too', del.includes('localStorage.removeItem(`${PAPER_BOTS_KEY}_${slot}`)'))
t('and it says which half removes what', del.includes('paper.js removes the store'))

console.log(nl + '-- what paper still simulates, and what it does not --')
// Unchanged, and worth pinning: only the grid bot is modelled here. A half-faithful copy
// of a trigger-driven bot would teach the wrong thing.
t('grid is the only simulated type', cli.includes("const PAPER_BOT_TYPES = new Set(['grid'])"))
t('why is recorded', cli.includes('a half-faithful copy that drifts'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
