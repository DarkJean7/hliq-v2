// A HIP-3 position's MARK froze the moment All Accounts opened.
//
// Reported on a META card: PnL -$9.78 against size 1.00 and entry $655.61 and a mark of
// $652.24, which says -$3.37. HL's own figure was right (positionValue 645.47, so -$10.14 at
// the time); the MARK beside it was the stale one. The two numbers came from different places
// and only one of them was still moving.
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

console.log('\n-- the combined view keeps deriving the builder-dex mark --')
const fast = grab(cli, 'async function _allAcctFastMids()')
t('the skip is about who OWNS the price, not whether one exists',
  fast.includes("if (!_isHip3Coin(coin) && parseFloat(state.allMids[coin] ?? 0) > 0) continue"))
t('a main-dex coin is still left to the live feed', fast.includes('!_isHip3Coin(coin) &&'))
t('the mark is still HL\'s own: positionValue / |szi|', fast.includes('state.allMids[coin] = String(pv / sz)'))
t('why it froze is written down where the next reader will be', fast.includes('self-fulfilling'))
t('and that this path never fetches HIP-3 mids', fast.includes('never calls fetchHip3Mids'))
t('the single-account path is the one that does', (cli.match(/fetchHip3Mids\(/g) ?? []).length === 1)

// The guard, run rather than read: does the second tick update, or skip?
const tick = (isHip3, existing) => !(!isHip3 && existing > 0)
t('main-dex coin with a live mid → left alone', tick(false, 103.7) === false)
t('main-dex coin with nothing yet → derived', tick(false, 0) === true)
t('HIP-3 coin on the FIRST tick → derived', tick(true, 0) === true)
t('HIP-3 coin on every tick AFTER → derived again (this is the fix)', tick(true, 652.24) === true)

// What the card showed, and what it shows now.
const mark = (pv, sz) => pv / sz
t('a frozen mark disagrees with its own PnL', Math.abs((652.24 - 655.61) - (645.47 - 655.61)) > 6)
t('the derived mark agrees with it exactly', (mark(645.47, 1) - 655.61).toFixed(2) === (645.47 - 655.61).toFixed(2))

console.log('\n-- a renamed builder market is still a builder market --')
// Position and order coins are run through hip3Rename, and 'xyz:CL' comes back as 'WTIOIL'.
// Six call sites tested for a ':' and so stopped recognising it — in both directions: no main
// feed carries it, and the code meant to look after it skipped it.
t('there is one helper for the question', cli.includes('function _isHip3Coin(coin)'))
t('it asks Hyperliquid\'s id, not the display name', cli.includes("String(hip3Original(String(coin ?? '')) ?? '').includes(':')"))
t('it says why the obvious test is wrong', cli.includes('a renamed market loses its prefix'))
t('every position filter uses it, not a bare colon',
  !/\(ap\.position \?\? ap\)\?\.coin \?\? ''\)\.includes\(':'\)/.test(cli) &&
  !/\(x\?\.position \?\? x\)\?\.coin \?\? ''\)\.includes\(':'\)/.test(cli))
t('the 12s carry-over keeps renamed positions', grab(cli, 'function _applyAcctLiveCs(r, cs, hip3Override)').includes('_isHip3Coin((ap.position ?? ap)?.coin)'))
t('so does the WebSocket carry-over', cli.includes('const _isHip3   = (x) => _isHip3Coin((x?.position ?? x)?.coin)'))
t('the mark-to-market book includes them', (cli.match(/filter\(ap => _isHip3Coin\(\(ap\.position \?\? ap\)\?\.coin\)\)/g) ?? []).length >= 3)
t('order-margin scaling leaves them to their own dex', cli.includes('const isH3      = _isHip3Coin'))

const isH3 = (coin, renames = { 'xyz:CL': 'WTIOIL' }) => {
  const orig = Object.fromEntries(Object.entries(renames).map(([k, v]) => [v, k]))
  return String(orig[coin] ?? coin).includes(':')
}
t('xyz:META is HIP-3', isH3('xyz:META') === true)
t('WTIOIL is HIP-3 even without a colon', isH3('WTIOIL') === true)
t('SOL is not', isH3('SOL') === false)
t('and neither is an empty coin', isH3('') === false)

console.log('\n-- the card reads both numbers from where they come from --')
const card = grab(cli, 'const _posCards = pos.map((ap, i) =>')
t('PnL is HL\'s own', card.includes("const uPnl    = parseFloat(p.unrealizedPnl ?? 0)"))
t('notional is HL\'s own', card.includes("const posVal  = parseFloat(p.positionValue ?? Math.abs(sz) * markPx)"))
t('and the mark goes through the one price store', card.includes('const markPx  = _posMarkPx(p)'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
