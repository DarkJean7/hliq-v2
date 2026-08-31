// A held Net PnL is a reading from another moment.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n-- the hold is bounded now --')
const held = new Function('last', 'nRows', 'now', `
  const COMBO_PNL_HOLD_MS = 20000
  const _comboPnlLast = last
  const Date = { now: () => now }
  ${grab(cli, 'function _comboPnlHeld(nRows)').replace('function _comboPnlHeld(nRows) {', '').slice(0, -1)}
`)
const NOW = 1_000_000
const mk = (at) => ({ net: 184.2, unreal: -12, wallets: 9, parts: {}, at })
t('a figure from a second ago may stand in', held(mk(NOW - 1000), 9, NOW)?.net === 184.2)
t('one from a minute ago may NOT', held(mk(NOW - 60_000), 9, NOW) === null)
t('the limit itself still counts as within the hold', held(mk(NOW - 20_000), 9, NOW)?.net === 184.2)
t('a millisecond past it does not', held(mk(NOW - 20_001), 9, NOW) === null)
t('a different wallet count is refused regardless of age', held(mk(NOW), 8, NOW) === null)
t('nothing held yields nothing', held(null, 9, NOW) === null)
t('an entry with no timestamp is treated as ancient, not as fresh', held({ net: 1, wallets: 9 }, 9, NOW) === null)
t('a held figure is marked as such', held(mk(NOW - 1000), 9, NOW)?.held === true)

console.log('\n-- and the stored figure carries its time --')
t('the timestamp is written when it is computed', cli.includes('parts, at: Date.now() }'))
t('the limit is short on purpose', cli.includes('const COMBO_PNL_HOLD_MS = 20_000'))
t('the old unbounded behaviour is recorded so it cannot come back',
  cli.includes('This used to have no age limit at all'))
t('the call sites still hold rather than inventing a number',
  (cli.match(/return _comboPnlHeld\(rows\.length\)/g) ?? []).length === 2)
t('and a refused hold renders as a dash, not a row sum',
  cli.includes('const totalNet    = _cpAll?.net ?? null'))

console.log('\n-- a large step reports what moved --')
const w = grab(cli, 'function _comboPnlWatch(net, ctx)')
t('it exists', !!w)
t('small moves are ignored — the market moves', w.includes('if (step < 25) return'))
t('and it is throttled to once a minute', w.includes('Date.now() - _pnlStepAt < 60_000'))
t('the report carries BOTH halves, which is what identifies the cause',
  w.includes('settled=${ctx.settled') && w.includes('unreal=${ctx.unreal'))
t('plus the snapshot age', w.includes('snapAge='))
t('and the wallet counts the guard checks', w.includes('pnlWallets=${ctx.pnlWallets}') && w.includes('wallets=${ctx.wallets}'))
t('the first reading cannot be a step', w.includes('if (prev == null'))
t('it is wired into the computed path', cli.includes('_comboPnlWatch(net, {'))
t('a non-finite figure is not reported as a step', w.includes('!Number.isFinite(net)'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
