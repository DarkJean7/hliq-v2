// LIVE probe: the All Accounts equity headline against Hyperliquid itself, over minutes.
//
// Not part of CI -- it reads the real exchange, and its answer depends on the market. It exists
// because "the equity spikes" survived fix after fix that passed every hermetic test: a stubbed
// exchange cannot produce the drift between layers that caused them. This drives the real app
// with real wallets and real prices, reads the headline every second, and every minute asks
// Hyperliquid for each wallet's own portfolio value to compare against.
//
// A spike is a one-second change larger than the market could have made, and a disagreement
// with Hyperliquid's own sum. Both are reported with the numbers around them.
//
// Run:  node tests/eqlive-probe.mjs --wallets=0xabc…,0xdef… [--minutes=8] [--port=5175]
import { chromium, devices } from 'playwright'

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) || '').split('=')[1] || d
const WALLETS = arg('wallets', '').split(',').map(s => s.trim()).filter(Boolean)
const MINUTES = Number(arg('minutes', '8'))
const BASE = 'http://localhost:' + arg('port', '5175') + '/'
const STEP_USD = Number(arg('step', '25'))
if (!WALLETS.length) { console.error('pass --wallets=0x…,0x…'); process.exit(2) }

const HL = 'https://api.hyperliquid.xyz/info'
async function truth() {
  let sum = 0
  for (const user of WALLETS) {
    const r = await fetch(HL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'portfolio', user }) })
    if (!r.ok) return null
    const port = await r.json()
    const hist = (port ?? []).find(p => p[0] === 'allTime')?.[1]?.accountValueHistory ?? []
    if (!hist.length) return null
    sum += parseFloat(hist.at(-1)[1])
    await new Promise(r => setTimeout(r, 250))
  }
  return sum
}

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
const errs = []
p.on('pageerror', e => errs.push(e.message))
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
}, WALLETS)
// Straight into All Accounts, as the app reopens when that was the last view -- the cold open
// that showed "~$200 less until I pressed reload".
await p.evaluate(() => localStorage.setItem('walletAddr', '__all_accounts__'))
await p.reload({ waitUntil: 'domcontentloaded' })
const RELOAD_AT = Number(arg('reloadAt', '0'))   // seconds; reopen mid-run, from the cache the first session wrote

const read = () => p.evaluate(() => {
  const t = document.getElementById('mobVBalance')?.textContent ?? ''
  const m = t.replace(/[^0-9.]/g, '')
  return m ? parseFloat(m) : null
})

const t0 = Date.now()
let prev = null, first = null
const series = [], spikes = [], checks = []
let nextTruth = Date.now() + 20_000
console.log(`probing ${WALLETS.length} wallets for ${MINUTES} min, step threshold $${STEP_USD}`)
while (Date.now() - t0 < MINUTES * 60_000) {
  const v = await read()
  const at = Math.round((Date.now() - t0) / 1000)
  if (v != null) {
    if (first == null) { first = at; console.log(`  first figure at ${at}s: $${v.toFixed(2)}`) }
    series.push([at, v])
    if (prev != null && Math.abs(v - prev) >= STEP_USD) {
      spikes.push({ at, from: prev, to: v, d: v - prev })
      console.log(`  STEP ${at}s ${prev.toFixed(2)} -> ${v.toFixed(2)} (${(v - prev).toFixed(2)})`)
    }
    prev = v
  }
  if (RELOAD_AT && at >= RELOAD_AT && !globalThis.__reloaded) {
    globalThis.__reloaded = true
    console.log(`  -- reopening at ${at}s (cached rows from the first session) --`)
    await p.reload({ waitUntil: 'domcontentloaded' })
    prev = null
    nextTruth = Date.now() + 5_000
  }
  if (Date.now() >= nextTruth) {
    nextTruth = Date.now() + Number(arg('every', '60')) * 1000
    const tr = await truth()
    const now = await read()
    if (tr != null && now != null) {
      checks.push({ at, shown: now, hl: tr, diff: now - tr })
      console.log(`  check ${at}s shown $${now.toFixed(2)}  HL $${tr.toFixed(2)}  diff ${(now - tr).toFixed(2)}`)
    }
  }
  await p.waitForTimeout(1000)
}

const diffs = checks.map(c => Math.abs(c.diff))
console.log('\n── result ──')
console.log(`first figure after ${first ?? 'never'}s; ${series.length} readings`)
console.log(`steps >= $${STEP_USD} in one second: ${spikes.length}`)
console.log(`vs Hyperliquid: ${checks.length} checks, worst gap $${diffs.length ? Math.max(...diffs).toFixed(2) : '—'}, mean $${diffs.length ? (diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(2) : '—'}`)
// Around each step, the readings either side: a flat line and then a jump is a figure that
// stopped moving and caught up; a steady climb into it is the market.
for (const sp of spikes) {
  const around = series.filter(([at]) => Math.abs(at - sp.at) <= 12).map(([at, v]) => `${at}s:${v.toFixed(2)}`)
  console.log(`around ${sp.at}s: ${around.join(' ')}`)
}
if (errs.length) console.log('page errors:', errs.slice(0, 5))
await browser.close()
process.exit(0)
