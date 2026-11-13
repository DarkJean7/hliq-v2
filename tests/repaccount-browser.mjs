// The account replay on a wide desktop window, with the trade count of a real account.
//
// Reported with a screenshot: "the portfolio replay looks really awful and barely understandable".
// The chart was drawn 320 wide and stretched to ~1,800 px, so every triangle was a flat sliver and
// the labels were smeared sideways; 150 trades on the line were 150 triangles in a band; and the
// last four were labelled, stacking "BUY BUY BUY" over the line. Hermetic: exchange stubbed.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)  [--shot=file.png]
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const APP  = `http://localhost:${port}/app`
const ADDR = '0x4444444444444444444444444444444444444444'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const t = (n, ok, x = '') => { ok ? pass++ : fail++; console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : ' → ' + JSON.stringify(x))) }
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// Seven days of an account that trades HYPE all day: 150 fills, alternating opens and closes.
const NOW = Date.now(), H = 3600e3, START = NOW - 7 * 24 * H
const FILLS = []
for (let k = 0; k < 150; k++) {
  const time = START + Math.round((k + 1) * (7 * 24 * H - 2 * H) / 150)
  const close = k % 2 === 1
  FILLS.push({ coin: 'HYPE', px: String(40 + (k % 7)), sz: '2', side: close ? 'A' : 'B', time, startPosition: close ? '2' : '0',
    dir: close ? 'Close Long' : 'Open Long', closedPnl: close ? String(1 + (k % 5)) : '0', hash: '0x' + k.toString(16).padStart(64, '0'),
    oid: 1000 + k, crossed: true, fee: '0.08', tid: 5000 + k, feeToken: 'USDC' })
}
FILLS.reverse()     // newest first, as the exchange sends them
const hist = (n, f) => Array.from({ length: n }, (_, i) => [START + i * (7 * 24 * H) / (n - 1), String(f(i))])
const WINDOW = { accountValueHistory: hist(170, i => 1000 + i * 0.7), pnlHistory: hist(170, i => i * 0.7), vlm: '29153' }
const MARGIN = { accountValue: '1118', totalNtlPos: '0', totalRawUsd: '1118', totalMarginUsed: '0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1118', assetPositions: [], time: NOW }
const UNIVERSE = [{ name: 'HYPE', szDecimals: 2, maxLeverage: 10 }]
const ctx1 = { funding: '0', openInterest: '1', prevDayPx: '44', dayNtlVlm: '1', premium: '0', oraclePx: '44', markPx: '44', midPx: '44', impactPxs: ['44', '44'] }
const reply = (b) => {
  switch (b.type) {
    case 'allMids': return { HYPE: '44' }
    case 'metaAndAssetCtxs': return [{ universe: UNIVERSE }, [ctx1]]
    case 'meta': return { universe: UNIVERSE }
    case 'perpDexs': return [null]
    case 'allPerpMetas': return [{ universe: UNIVERSE }]
    case 'spotMeta': return { tokens: [], universe: [] }
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'clearinghouseState': return STATE
    case 'spotClearinghouseState': return { balances: [] }
    case 'portfolio': return ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, WINDOW])
    case 'webData2': return { clearinghouseState: STATE, openOrders: [] }
    case 'userFills': case 'userFillsByTime': return FILLS
    case 'frontendOpenOrders': case 'userFunding': case 'perpCategories': case 'userNonFundingLedgerUpdates':
    case 'subAccounts': case 'candleSnapshot': case 'extraAgents': return []
    default: return {}
  }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1900, height: 900 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: reply(b) })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1')
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'fills', () => (window.state?.fills?.length ?? 0) > 0 || true)
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
await p.evaluate(() => window.__openReplay())
await waitFor(p, 'the replay chart', () => !!document.querySelector('#repStage svg'))
// Acc. PnL, the line, triangles on: the screenshot's settings. Then to the end of the series.
await p.evaluate(() => { window.__repSeries?.('pnl'); window.__repStyle?.('line') })
await p.waitForTimeout(300)
await p.evaluate(() => { const s = document.getElementById('repScrub'); if (s) { s.value = s.max; s.dispatchEvent(new Event('input', { bubbles: true })) } })
await p.waitForTimeout(500)

const m = await p.evaluate(() => {
  const svg = document.querySelector('#repStage svg')
  const vb = svg?.viewBox?.baseVal
  const rect = svg?.getBoundingClientRect()
  const tris = svg ? svg.querySelectorAll('polygon').length : 0
  const labels = svg ? [...svg.querySelectorAll('text')].map(x => x.textContent).filter(x => /BUY|SELL|\$/.test(x)) : []
  const tri = svg?.querySelector('polygon')?.getBoundingClientRect()
  return { vbW: vb?.width, w: rect?.width, h: rect?.height, tris, labels, triW: tri?.width, triH: tri?.height, frames: document.getElementById('repPos')?.textContent }
})
t('the chart is drawn at the width it is shown at, not stretched', m.vbW && Math.abs(m.vbW - m.w) <= 2, m)
t('taller on a wide screen', m.h >= 250, m)
t('triangles are triangles, not slivers', m.triW > 0 && m.triH > 0 && m.triW / m.triH < 2.2, m)
t('150 trades do not draw 150 triangles', m.tris > 0 && m.tris <= Math.ceil(m.w / 16) * 2, m)
t('one label, on the latest trade', m.labels.length <= 1, m)
const shot = (process.argv.find(a => a.startsWith('--shot=')) || '').split('=')[1]
if (shot) { await p.evaluate(() => document.getElementById("bootSplash")?.remove()); await p.evaluate(() => document.getElementById("repStage")?.scrollIntoView({ block: "center" })); await p.waitForTimeout(300) }
if (shot) await p.screenshot({ path: shot, clip: await p.evaluate(() => { const r = document.getElementById('repStage').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } }) })

t('no page errors', !errs.length, errs)
console.log(`\n${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
