// Macro with its REAL feeds (FRED, BLS, BEA, the Fed, Alternative.me, CoinGecko) and Hyperliquid stubbed,
// so it spends nothing from the trading IP's budget. Not in CI: it depends on other people's servers.
//   node tests/macro-live.mjs --port=5175 --shot=mobile.png --deskshot=desk.png
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const BASE = `http://localhost:${arg('port', '5175')}`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const r = await fetch(BASE + '/macro-data', { signal: AbortSignal.timeout(180_000) })
const d = await r.json()
t('answers', r.ok && Array.isArray(d.items), r.status)
const by = Object.fromEntries((d.items ?? []).map(i => [i.key, i]))
const inRange = (k, lo, hi) => t(`${k} is a sane number`, by[k]?.value > lo && by[k]?.value < hi, by[k]?.value)
for (const i of d.items ?? []) console.log(`    ${i.key.padEnd(9)} ${String(i.value == null ? 'null' : +i.value.toFixed(2)).padStart(8)}  ${i.date}  prev ${i.prev == null ? '-' : +i.prev.toFixed(2)}  ${i.pts.length} pts`)
console.log('    fng', d.fng?.value, d.fng?.label, '· cap', d.global?.cap, 'btc', d.global?.btc, '· calendars missing:', d.unknownCal)
console.log('    next:', (d.events ?? []).slice(0, 6).map(e => `${e.kind} ${new Date(e.t).toISOString().slice(0, 16)}`).join(' | '))
inRange('cpi', -2, 15); inRange('core', -2, 15); inRange('pce', -2, 15); inRange('corepce', -2, 15); inRange('ppi', -10, 25)
inRange('unrate', 2, 25); inRange('claims', 100, 7000); inRange('gdp', -40, 40); inRange('fed', 0, 20); inRange('y10', 0, 20); inRange('y2', 0, 20)
inRange('dollar', 70, 200); inRange('oil', 0, 300); inRange('vix', 5, 150); inRange('umich', 20, 130)
t('payrolls are a month\'s jobs, not the total', Math.abs(by.payrolls?.value) < 3000, by.payrolls?.value)
t('fear and greed', d.fng?.value >= 0 && d.fng?.value <= 100, d.fng)
t('market cap', d.global?.cap > 1e11, d.global)
for (const k of ['cpi', 'jobs', 'fomc', 'gdp', 'pce']) t(`a date for the next ${k}`, (d.events ?? []).some(e => e.kind === k), d.unknownCal)
t('answer stays small', JSON.stringify(d).length < 200_000, JSON.stringify(d).length)

const b = await chromium.launch()
async function shot(viewport, isMobile, file) {
  const ctx = await b.newContext({ viewport, isMobile, hasTouch: isMobile })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(/api\.hyperliquid\.xyz/, (route) => route.fulfill({ status: 200, contentType: 'application/json', json: {} }))
  const p = await ctx.newPage()
  await p.goto(BASE + '/app', { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => { for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1'); localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*'])); localStorage.setItem('hliq_pulse_seg', 'signals'); localStorage.setItem('hliq_sig_view', 'macro') })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 60000 })
  await p.evaluate(() => { document.getElementById('walletInput').value = '0x' + '1'.repeat(40); return window.loadDashboard() }).catch(() => {})
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  if (isMobile) await p.evaluate(() => window.__mobMoreTab('analysis')); else await p.evaluate(() => window.switchTab('analysis', document.querySelector(`.nav-tab[onclick*="'analysis'"]`)))
  await p.evaluate(() => window.__pulseSetSeg('signals'))
  await p.waitForSelector('#macroFng', { timeout: 60000 })
  await p.click('[data-macro-row="cpi"] .mob-v-row')
  await p.screenshot({ path: file })
  await p.evaluate(() => document.querySelector('[data-macro-group="inflation"]')?.scrollIntoView())
  await p.screenshot({ path: file.replace(/\.png$/, '-2.png') })
  await ctx.close()
}
if (arg('shot')) await shot({ width: 430, height: 930 }, true, arg('shot'))
if (arg('deskshot')) await shot({ width: 1500, height: 950 }, false, arg('deskshot'))
await b.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
