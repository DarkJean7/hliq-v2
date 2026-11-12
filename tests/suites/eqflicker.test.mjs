// "When I enter the app the equity, PnL, unrealized... change a lot for ten seconds."
//
// 1. The ledger pass copied every row when it started and was swapped in when it finished,
//    throwing away every live tick in between: values jumped back, then forward. Its answer is now
//    put onto the rows as they are when it finishes (_allAcctApplyLedger, lifted from main.js).
// 2. The deploy never restarted hliq-strat for a change in a module server.js imports, so a fix
//    there shipped to disk and never ran. serverdeps.mjs lists them; deploy.yml hashes them.
import { readFileSync } from 'node:fs'
import { serverDeps } from '../../serverdeps.mjs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? pass++ : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')

const m = /function _allAcctApplyLedger\(current, enriched\) \{[\s\S]*?\n\}/.exec(main)
t('the helper exists', !!m)
const apply = new Function(`${m[0]}; return _allAcctApplyLedger`)()

// The pass began when W1 was worth 900; the socket has since moved it to 845.
const current = [
  { addr: '0xAA', accountValue: 845.71, unrealizedPnl: -40, positions: ['live'] },
  { addr: '0xBB', accountValue: 10, error: 'Failed to load' },
  { addr: '0xCC', accountValue: 300, ledgerEntries: [{ old: 1 }], totalDeposited: 5, totalWithdrawn: 0 },
]
const enriched = [
  { addr: '0xaa', accountValue: 900, unrealizedPnl: 15, positions: ['stale'], ledgerEntries: [{ d: 1 }], totalDeposited: 1000, totalWithdrawn: 200 },
  { addr: '0xBB', accountValue: 999, ledgerEntries: [], totalDeposited: 0, totalWithdrawn: 0 },
  { addr: '0xCC', accountValue: 1 },                              // the pass did not reach it
]
const out = apply(current, enriched)
t('the live value stays -- not the one from when the pass began', out[0].accountValue === 845.71 && out[0].unrealizedPnl === -40 && out[0].positions[0] === 'live', out[0])
t('the transfers are taken from the pass', out[0].ledgerEntries.length === 1 && out[0].totalDeposited === 1000 && out[0].totalWithdrawn === 200, out[0])
t('matched by address whatever the case', out[0].totalDeposited === 1000)
t('a wallet in error is left alone', out[1].accountValue === 10 && !('ledgerEntries' in out[1]), out[1])
t('a wallet the pass did not reach keeps what it had', out[2].accountValue === 300 && out[2].totalDeposited === 5, out[2])
t('the rows are as many and in the same order', out.map(r => r.addr).join() === '0xAA,0xBB,0xCC')
t('no rows yet: the pass is all there is', apply([], enriched) === enriched)

// Every caller that takes the pass's answer puts it onto the current rows.
const callers = [...main.matchAll(/_maEnrichResults\((?:base|\[fresh\]|results), (?:false|true)\)/g)].length
t('the two combined-view callers go through it', (main.match(/_allAcctApplyLedger\(_allAcctLastResults, /g) ?? []).length === 2, callers)
t('neither swaps in the copies directly any more', !/_allAcctMerge\(enriched, _allAcctLastResults\)/.test(main) && !/_allAcctMerge\(await _maEnrichResults\(base, false\), _allAcctLastResults\)/.test(main))

// ── the deploy restarts hliq-strat when what it loads changes ──
const deps = serverDeps('server.js', new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
t('server.js itself', deps.includes('server.js'))
t('the module the seed fix is in', deps.includes('src/comboseed.js'), deps)
t('and the ones it reaches through a dynamic import', deps.some(f => f.startsWith('strategies/')), deps)
t('nothing from the browser bundle', !deps.includes('src/main.js'), deps)
const wf = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8')
t('CI hashes them', /node serverdeps\.mjs server\.js/.test(wf) && /\.strat-deps\.sha/.test(wf))
t('and records the hash only after the restart worked', /pm2 restart hliq-strat && echo .*\.strat-deps\.sha/.test(wf))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
