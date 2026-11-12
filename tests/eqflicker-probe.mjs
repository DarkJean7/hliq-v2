// LIVE probe: does All Accounts' equity flick between figures in the first seconds after opening?
//
// Reported as "when I enter the app from my phone the equity, PnL, unrealized... change a lot for
// about ten seconds until it takes the real amount". eqstep had it: the total swinging between
// $3,155 and $3,448 five times in seven seconds, every wallet moving together and back.
//
// Not part of CI -- it reads the real exchange. Opens All Accounts once so the app writes its
// caches, closes it for --gap seconds, reopens, and prints every change to the headline with
// each wallet's part and where it came from (its own row, or the server's read carried by price).
//
// Run:  node tests/eqflicker-probe.mjs --wallets=0xabc…,0xdef… [--gap=120] [--trace=40] [--port=5175]
//       [--api=https://insolvent.trade]   (the dev server has no /api/combined)
import { chromium, devices } from 'playwright'

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d
const WALLETS = arg('wallets', '').split(',').map(s => s.trim()).filter(Boolean)
const BASE = 'http://localhost:' + arg('port', '5175') + '/app'
const GAP = Number(arg('gap', '120')) * 1000, TRACE = Number(arg('trace', '40')) * 1000
if (!WALLETS.length) { console.error('pass --wallets=0x…,0x…'); process.exit(2) }

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'], viewport: { width: 430, height: 930 } })
const p = await ctx.newPage()
const API = arg('api', '')
if (API) await p.route(/\/api\/combined(\/seeds)?$/, async (route) => {
  const r = await fetch(API + new URL(route.request().url()).pathname, { method: route.request().method(), headers: { 'Content-Type': 'application/json' }, body: route.request().postData() })
  await route.fulfill({ status: r.status, contentType: 'application/json', body: await r.text() })
})
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate((ws) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_privacy', '0')
  const list = ws.map((a, i) => ({ addr: a, label: 'W' + (i + 1) }))
  localStorage.setItem('savedWallets', JSON.stringify(list))
  localStorage.setItem('hliq_multi_accounts', JSON.stringify(list))
  localStorage.setItem('walletAddr', '__all_accounts__')
}, WALLETS)

const read = () => p.evaluate(() => ({
  eq: document.getElementById('mobVBalance')?.textContent?.trim() ?? '',
  parts: window.__comboParts?.() ?? null,
})).catch(() => null)

async function trace(label, ms) {
  const t0 = Date.now()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  let last = null, changes = 0
  while (Date.now() - t0 < ms) {
    const s = await read()
    if (s && s.eq !== last) {
      changes++
      const parts = (s.parts ?? []).map(x => `${x.a}:${x.row}${x.cached ? 'c' : ''}${x.err ? 'E' : ''}/s=${x.seed}`).join(' ')
      console.log(`${label} +${((Date.now() - t0) / 1000).toFixed(1)}s  ${s.eq || '(blank)'}  | ${parts}`)
      last = s.eq
    }
    await p.waitForTimeout(150)
  }
  console.log(`${label}: ${changes} distinct figures in ${ms / 1000}s`)
}

await trace('cold', 60_000)
await p.goto('about:blank')
console.log(`closed for ${GAP / 1000}s`)
await p.waitForTimeout(GAP)
await trace('reopen', TRACE)
await browser.close()
process.exit(0)
