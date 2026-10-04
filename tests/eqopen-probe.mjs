// LIVE probe: how long after opening does All Accounts show its equity, against its Net PnL.
//
// Reported as "Net PnL loads faster than account equity". Not part of CI -- it reads the real
// exchange. Opens the app straight into All Accounts with nothing cached, then reopens it
// (--reopens times) from the cache the first session wrote, and prints when each figure first
// showed a number.
//
// Run:  node tests/eqopen-probe.mjs --wallets=0xabc…,0xdef… [--reopens=2] [--gap=90] [--port=5175]
// --gap is the seconds the app stays closed between opens; above 45 the cache it reopens from
// is no longer fresh, above 180 neither is the server's copy unless it kept it warm.
import { chromium, devices } from 'playwright'

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d
const WALLETS = arg('wallets', '').split(',').map(s => s.trim()).filter(Boolean)
const REOPENS = Number(arg('reopens', '2'))
const BASE = 'http://localhost:' + arg('port', '5175') + '/app'
const LIMIT_MS = Number(arg('limit', '120')) * 1000
if (!WALLETS.length) { console.error('pass --wallets=0x…,0x…'); process.exit(2) }

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'], viewport: { width: 430, height: 930 } })
const p = await ctx.newPage()
// --api=http://localhost:3002 sends /api/combined to a server.js run locally -- the dev server
// has none, so without it the app runs as though the server had no snapshot.
const API = arg('api', '')
if (API) await p.route(/\/api\/combined(\/seeds)?$/, async (route) => {
  const r = await fetch(API + new URL(route.request().url()).pathname, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: route.request().postData() })
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

const num = (id) => p.evaluate((id) => {
  const t = document.getElementById(id)?.textContent ?? ''
  return /\d/.test(t) ? t.trim() : null
}, id).catch(() => null)

async function open(label) {
  const t0 = Date.now()
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  let eq = null, pnl = null
  while (Date.now() - t0 < LIMIT_MS && (eq == null || pnl == null)) {
    const at = ((Date.now() - t0) / 1000).toFixed(1)
    if (eq == null && await num('mobVBalance')) eq = at
    if (pnl == null && await num('mobVUnrealPnl')) pnl = at
    await p.waitForTimeout(250)
  }
  console.log(`${label}: equity at ${eq ?? 'never'}s, Net PnL at ${pnl ?? 'never'}s`)
  // Let this session finish loading so the next reopen has a full cache to start from, then
  // CLOSE the app for the gap -- an open page keeps asking the server, which keeps it warm.
  await p.waitForTimeout(20_000)
  await p.goto('about:blank')
  await p.waitForTimeout(Number(arg('gap', '20')) * 1000)
}

await open('cold (nothing cached)')
for (let i = 1; i <= REOPENS; i++) await open(`reopen ${i}`)
await browser.close()
process.exit(0)
