// All Accounts Net PnL needs every wallet's ledger figure (HL portfolio value less HL all-time
// PnL), so one wallet without it shows "waiting for every wallet". Reported: "seems like
// everything loads and sometimes some cards like in this case the net pnl".
//
// The cause: a failed portfolio read became [] and was stored as FRESH history, so that wallet
// had no ledger figure for the whole eight-minute TTL. Empty is not the same as unknown.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const src = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

t('a failed portfolio read is null, not an empty portfolio',
  !/info\.portfolio\(\{ user: entry\.addr \}\)\.catch\(\(\) => \[\]\)/.test(src) &&
  src.includes('info.portfolio({ user: entry.addr }).catch(() => null),'))
const i = src.indexOf('if (!_histFresh && portfolio == null) {')
const block = i < 0 ? '' : src.slice(i, src.indexOf('} else if (!_histFresh) {', i))
t('the failure is handled before anything is cached', i > 0 && block.length > 0)
t('it falls back to the last snapshot together with its own anchor',
  block.includes('({ portfolio, perpAtHist: _perpAtHist, bookAtHist: _bookAtHist } = _hc)'))
t('and never stores the failure as fresh, so the next fan retries',
  block.includes('ts: _hc?.ts ?? 0') && !block.includes('Date.now()'))
t('the Net PnL card still refuses a sum that is missing a wallet',
  src.includes('if (!Number.isFinite(cum) || !Number.isFinite(av)) return null'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
