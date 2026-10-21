// The strategy server's own Hyperliquid reads are metered (server.js hlInfo, src/hlbudget.js).
//
// Reported: "net pnl is for some reason not loading". Every wallet answered; the server's combined
// snapshot was ten hours old because its reads kept being refused — 3,021 of 3,758 error-log lines
// were HL 429 ([lb] 1,195, [subs] 959, [combined] 867), from loops that fired as fast as they
// could. The same IP places the trading bots' orders, which is the part that costs money.
import fs from 'fs'
import { createBudget, weightOf, HL_BUDGET } from '../../src/hlbudget.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const fn = srv.slice(srv.indexOf('async function hlInfo(payload) {'), srv.indexOf('async function hlInfo(payload) {') + 900)

t('the server imports the same budget model as the browser', srv.includes("import { createBudget, weightOf as hlWeightOf, HL_BUDGET } from './src/hlbudget.js'"))
t('hlInfo claims the weight before it waits', /const ms = Math\.min\(_srvBudget\.waitFor\(w\), SRV_HL_MAX_WAIT_MS\)\n\s*_srvBudget\.spend\(w\)\n\s*if \(ms > 0\) await sleep\(ms\)/.test(fn))
t('a 429 drains the model', fn.includes('if (r.status === 429) { _srvBudget.drain();'))
t('with a large reserve kept for the bots\' orders', srv.includes('createBudget({ startLevel: HL_BUDGET / 2, reserve: 500 })'))
t('and a cap, so a request answering a person never hangs', srv.includes('const SRV_HL_MAX_WAIT_MS = 20_000'))
t('every background read goes through it (no other fetch of /info but the cached auth check)',
  (srv.match(/fetch\(HL_INFO/g) ?? []).length === 2 && srv.includes("type: 'extraAgents'"))

// What it does to a burst: the leaderboard round asks for thirty weight-20 reads at once.
let now = 0
const b = createBudget({ startLevel: HL_BUDGET / 2, reserve: 500, now: () => now })
let immediate = 0
for (let i = 0; i < 30; i++) { if (b.waitFor(weightOf('portfolio')) === 0) immediate++; b.spend(weightOf('portfolio')) }
t('only what leaves the reserve intact goes at once', immediate === 5, immediate)
t('the rest are spread at the refill rate, not fired together', b.waitFor(20) > 20_000, b.waitFor(20))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
