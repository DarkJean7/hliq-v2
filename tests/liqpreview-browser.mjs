// The order preview's Est. Liq Price, on screen.
//
// Reported: adding 5 VVV to a 5 VVV long previewed liq $27.20 — above the $25.91 price, for a
// long — while Hyperliquid showed N/A for the same order. The fixture is the reporting account's
// state as Hyperliquid's API returned it (a unified account: $756.03 of spot USDC backing five
// cross longs), under a placeholder address. The model is checked to the cent in
// tests/suites/crossliq.test.mjs; this checks the ticket actually shows it.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const ADDR = '0x3333333333333333333333333333333333333333'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const P = (coin, szi, entry, upnl, liq, lev, maxLev, margin) => ({ type: 'oneWay', position: {
  coin, szi: String(szi), entryPx: String(entry), unrealizedPnl: String(upnl), liquidationPx: liq == null ? null : String(liq),
  leverage: { type: 'cross', value: lev }, maxLeverage: maxLev, marginUsed: String(margin),
  positionValue: String(Math.abs(szi) * (entry + upnl / szi)), returnOnEquity: '0', cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })
const POS = [
  P('SOL', 7.15, 111.1954, -36.218225, 32.5325915725, 20, 20, 37.941475),
  P('PYTH', 2000, 0.073563, 11.434, null, 5, 5, 31.712),
  P('PURR', 1000, 0.117091, -15.66163, null, 3, 3, 33.81),
  P('HYPE', 41.49, 84.8706, -129.227546, 68.7391428245, 10, 10, 339.205644),
  P('VVV', 5, 28.0564, -10.4924, null, 3, 3, 43.263333),
]
const mark = (c) => { const p = POS.find(x => x.position.coin === c).position; return +p.entryPx + +p.unrealizedPnl / +p.szi }
const MIDS = Object.fromEntries(POS.map(x => [x.position.coin, String(mark(x.position.coin))]))
const MARGIN = { accountValue: '588.920348', totalNtlPos: '4540.66594', totalRawUsd: '-3951.745592', totalMarginUsed: '485.932452' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '242.966225', withdrawable: '65.046421', assetPositions: POS, time: Date.now() }
const UNIVERSE = POS.map(x => ({ name: x.position.coin, szDecimals: 2, maxLeverage: x.position.maxLeverage }))
const CTX = POS.map(x => { const m = String(mark(x.position.coin)); return { funding: '0.0000125', openInterest: '0', prevDayPx: m, dayNtlVlm: '0', premium: '0', oraclePx: m, markPx: m, midPx: m, impactPxs: [m, m] } })
const WINDOW = { accountValueHistory: [[Date.now() - 36e5, '900'], [Date.now(), '915']], pnlHistory: [[Date.now() - 36e5, '0'], [Date.now(), '0']], vlm: '0' }
const HL = {
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, total: '756.032159', hold: '523.873927', entryNtl: '0' }] },
  userAbstraction: 'unifiedAccount',
  allMids: MIDS, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [{ name: 'USDC', index: 0, szDecimals: 8, weiDecimals: 8 }], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: b.type in HL ? HL[b.type] : {} })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => { errs.push(e.message); if (process.env.DEBUG) console.log('STACK', e.stack) })

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))

const preview = async (coin, size) => {
  await p.evaluate(({ coin, size }) => {
    window.switchTab('trade'); window.__selectCoin(coin); window.setSide('long'); window.setSizeMode('coin')
    const el = document.getElementById('sizeInput'); el.value = String(size); el.dispatchEvent(new Event('input', { bubbles: true }))
  }, { coin, size })
  await waitFor(p, 'the preview', () => document.getElementById('posPreview')?.style.display !== 'none' && !!document.getElementById('pp-new-liq')?.textContent.trim())
  // The account's mode is asked of HL once; let the answer land and the preview redraw with it.
  await p.waitForTimeout(400)
  await p.evaluate(() => { const el = document.getElementById('sizeInput'); el.dispatchEvent(new Event('input', { bubbles: true })) })
  return p.evaluate(() => ({ size: document.getElementById('pp-new-size')?.textContent.trim(), liq: document.getElementById('pp-new-liq')?.textContent.trim() }))
}

console.log('\n-- the reported ticket: +5 VVV on a 5 VVV long --')
const vvv = await preview('VVV', 5)
t('the new size is 10', /^10(\.0+)? VVV/.test(vvv.size ?? ''), true)
t('Est. Liq Price is N/A, as Hyperliquid shows — not $27.20', vvv.liq, 'N/A')

console.log('\n-- a position that does have a liq price --')
const hype = await preview('HYPE', 1)
const hypeLiq = parseFloat(String(hype.liq).replace(/[$,]/g, ''))
// HL has the 41.49 position at 68.739; one more HYPE moves it up a little, and it must stay
// under the price for a long.
t('adding 1 HYPE moves the liq up slightly from HL\'s 68.739 (' + hype.liq + ')', hypeLiq > 68.739 && hypeLiq < 72, true)
t('and it is below the price, as a long\'s must be', hypeLiq < mark('HYPE'), true)

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
