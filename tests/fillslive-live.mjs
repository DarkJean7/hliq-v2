// The single-account fills socket against LIVE Hyperliquid (not hermetic, not in browser.mjs).
//
// tests/suites/fillslive.test.mjs asserts the wiring from source; this proves the subscription
// actually goes out on the wire for the account on screen, and moves when the account does.
// A real fill cannot be staged here, so what it checks is the part that can fail silently: that
// Hyperliquid is asked for the right wallet's fills at all.
//
//   npm run dev &   then   node tests/fillslive-live.mjs [--port=5175]
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
const A = '0x' + '0'.repeat(39) + '1', B = '0x' + '0'.repeat(39) + '2'
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const b = await chromium.launch()
const p = await (await b.newContext({ viewport: { width: 1400, height: 900 } })).newPage()
const sent = []
p.on('websocket', ws => ws.on('framesent', f => { if (/userFills/.test(f.payload)) sent.push(String(f.payload)) }))
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
})
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => typeof window.loadDashboard === 'function', null, { timeout: 120000 })

const load = (a) => p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, a)
const subFor = (a) => sent.some(s => /"subscribe"/.test(s) && s.toLowerCase().includes(a))
const unsubFor = (a) => sent.some(s => /"unsubscribe"/.test(s) && s.toLowerCase().includes(a))
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await p.waitForTimeout(250) } return false }

await load(A)
t('the account on screen subscribes to its fills', await until(() => subFor(A)), sent)
await load(B)
t('switching account subscribes the new one', await until(() => subFor(B)), sent)
t('and lets go of the old', await until(() => unsubFor(A)), sent)

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
