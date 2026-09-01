// Cold start must show nothing rather than yesterday's numbers.
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

console.log(String.fromCharCode(10) + '-- the cache is kept, whatever its age --')
// An age gate lived here for one release, on the theory that a stale cache painted the
// cold-start spike. Tested directly it was not: seeded with a three-hour-old cache carrying
// $9,999 equity and +$7,777 Net PnL, both figures stay dashed WITH or WITHOUT the gate.
// What the gate did do was throw the cache away, forcing a full-screen loader and a cold
// nine-wallet fan-out on every entry - measured 81 HL calls against 11 once removed.
// Built as an AsyncFunction: the loader decompresses, so its body contains `await` and
// plain `new Function` will not parse it. The stubs give it a store holding only the old
// uncompressed key, which is also the migration path for anyone whose cache predates
// compression -- so this exercises that fallback as well as the age question.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const load = new AsyncFunction('raw', `
  const _ALLACCT_CACHE_KEY = 'k'
  const _ALLACCT_CACHE_KEY_Z = 'kz'
  const localStorage = { getItem: (k) => k === 'k' ? raw : null, removeItem: () => {} }
  const gunzipFromString = async () => null
  ${grab(cli, 'function _allAcctCacheLoad()').replace('function _allAcctCacheLoad() {', '').slice(0, -1)}
`)
const mk = (ts) => JSON.stringify({ ts, results: [{ addr: '0xa', accountValue: 9999 }] })
t('a three-hour-old snapshot is still used for structure', (await load(mk(Date.now() - 3 * 3600e3)))?.length === 1)
t('so re-entry paints from it instead of showing the loader', (await load(mk(Date.now())))?.length === 1)
t('an empty result set is still refused', (await load(JSON.stringify({ ts: Date.now(), results: [] }))) === null)
t('junk does not throw', (await load('not json')) === null && (await load(null)) === null)
t('the age gate is gone', !cli.includes('_ALLACCT_CACHE_MAX_AGE_MS'))
t('and why it was wrong is recorded rather than just deleted',
  cli.includes('Tested directly, it was not') && cli.includes('Structure from cache'))

console.log('\n-- with no usable cache the view waits --')
const boot = cli.slice(cli.indexOf('if (!_allAcctCovers(_allAcctLastResults, entries))'), cli.indexOf('// The heavy fan-out re-pulls'))
t('an unusable cache leaves the results empty', boot.includes('_allAcctLastResults = _allAcctCovers(cached, entries) ? cached : []'))
t('and that path shows the loader and awaits a real fetch',
  boot.includes('_showAllAcctLoader()') && boot.includes('await _allAcctFetchAndRender(entries)'))

console.log('\n-- the figures refuse to guess while waiting --')
const bal = grab(cli, 'function _mobVRenderBalance()')
t('equity dashes until the portfolio history exists', bal.includes("balEl.innerHTML = '<span style=\"color:var(--muted)\">\u2014</span>'"))
t('and shows loading dots while a wallet is missing from the combined sum',
  bal.includes('acct-loading-dots'))
t('the combined total is the server figure or nothing', cli.includes('const totalNet    = _cpAll?.net ?? null'))
t('and a held Net PnL cannot be older than 20s', cli.includes('const COMBO_PNL_HOLD_MS = 20_000'))
t('Net PnL waits for the FULL fill history, not the 14-day window',
  cli.includes('state.fillsFull !== false'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
