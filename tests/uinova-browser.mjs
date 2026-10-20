// Settings → Interface: Classic or New (src/uinova.css), driven through the real app on both
// shells against a stubbed Hyperliquid. Asked: "make a new version that is toggable in the
// settings. i want to try a new look without losing the current one".
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 300))) }
const until = async (label, fn, ms = 20000) => {
  const t0 = Date.now()
  for (;;) { try { if (await fn()) return true } catch {} if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false } await new Promise(r => setTimeout(r, 150)) }
}
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }]
const HL = {
  allMids: { BTC: '100000' }, meta: { universe: UNIVERSE }, perpDexs: [null], allPerpMetas: [{ universe: UNIVERSE }],
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100000', dayNtlVlm: '0', premium: '0', oraclePx: '100000', markPx: '100000', midPx: '100000', impactPxs: ['100000', '100000'] }]],
  candleSnapshot: [], outcomeMeta: {}, perpCategories: [], clearinghouseState: { assetPositions: [], marginSummary: { accountValue: '0' } },
}

const browser = await chromium.launch()
for (const [w, h, mob] of [[1400, 900, false], [430, 930, true]]) {
  console.log(`\n== ${mob ? 'phone' : 'desktop'} ==`)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route(/\/api\/|\/paper\//, route => route.fulfill({ status: 503, contentType: 'application/json', json: { ok: false } }))
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.clear()
    for (const [k, v] of Object.entries({ hliq_lang: 'en', hliq_lang_chosen: '1', hliq_onboard_done: '1', hliq_onboard_welcomed_v1: '1', hliq_onboard_tour_v1: '1', hliq_install_nudge_v2: '9999999999999', hliq_ann_dismissed: '["*"]' }))
      localStorage.setItem(k, v)
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await until('boot', () => p.evaluate(() => !!window.__goPaper && !!window.__onUiVersion))
  await p.evaluate(() => window.__goPaper('main'))
  ok('Classic by default — nothing changes for anyone who has not chosen', !(await p.evaluate(() => document.documentElement.classList.contains('ui-nova'))))
  const font = () => p.evaluate(() => getComputedStyle(document.querySelector(document.querySelector('.ov-eq-val')?.offsetParent ? '.ov-eq-val' : '.mob-v-balance') ?? document.body).fontFamily)
  const classicFont = await font()

  // Open Settings and flip the switch the way a person would.
  if (mob) {
    await p.evaluate(() => window.mobVTab('settings'))
    await until('the phone settings', () => p.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'New')))
    await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'New').click())
  } else {
    await p.evaluate(() => window.switchTab('settings', null))
    await until('the desktop switch', () => p.evaluate(() => !!document.querySelector('#uiVersionSeg')?.offsetParent))
    await p.click('#uiVersionSeg .settings-seg-btn:has-text("New")')
  }
  ok('the switch turns the new look on', await p.evaluate(() => document.documentElement.classList.contains('ui-nova') && localStorage.getItem('hliq_ui') === 'nova'))
  if (!mob) ok('and the switch shows it', await p.evaluate(() => document.querySelector('#uiVersionSeg .settings-seg-btn.active')?.textContent.trim() === 'New'))

  // It is the choice on this device: a reload comes back in it, before first paint.
  await p.reload({ waitUntil: 'domcontentloaded' })
  ok('a reload keeps it, set before the app even boots', await p.evaluate(() => document.documentElement.classList.contains('ui-nova')))
  await until('boot again', () => p.evaluate(() => !!window.__goPaper))
  await p.evaluate(() => window.__goPaper('main'))
  await until('the account', () => p.evaluate(() => !!(document.querySelector('.ov-eq-val')?.offsetParent || document.querySelector('.mob-v-balance'))))
  const novaFont = await font()
  ok('it really is a different look (the numbers are no longer monospace)', /Inter/.test(novaFont) && novaFont !== classicFont, [classicFont, novaFont])

  if (!mob) {
    // Focus (the chosen layout): no sidebar column, a menu button that slides it in.
    const sideX = () => p.evaluate(() => document.querySelector('.sidebar').getBoundingClientRect().right)
    await until('the layout to settle', async () => (await sideX()) <= 0)
    ok('Focus: the sidebar is off the page, the menu button is there', (await sideX()) <= 0 && await p.evaluate(() => !!document.getElementById('novaMenuBtn')?.offsetParent), [await sideX(), await p.evaluate(() => !!document.getElementById('novaMenuBtn')?.offsetParent)])
    await p.click('#novaMenuBtn')
    await until('the panel', async () => (await sideX()) > 200)
    ok('the menu slides the sidebar in', (await sideX()) > 200)
    await p.click('.sidebar .sidebar-item[data-tab="overview"]')
    await until('it closes', async () => (await sideX()) <= 0)
    ok('choosing a page closes it again', (await sideX()) <= 0 && await p.evaluate(() => !document.documentElement.classList.contains('nova-nav-open')))
    await p.evaluate(() => window.switchTab('overview', null))
    await until('the quick actions', () => p.evaluate(() => document.querySelectorAll('.ov-equity .nova-actions .nova-act').length === 4))
    // Asked: "swap biggest win and biggest loss with unrealized pnl and net pnl".
    const labels = (sel) => p.evaluate((sel) => [...document.querySelectorAll(sel + ' > * .ov-stat-label')].map(e => e.textContent.trim()), sel)
    await until('the swap', async () => (await labels('.ov-winloss')).join() === 'Unrealized PnL,Net PnL')
    ok('Unrealized PnL and Net PnL sit where the win/loss pair was', (await labels('.ov-winloss')).join() === 'Unrealized PnL,Net PnL', await labels('.ov-winloss'))
    ok('and Biggest Win / Biggest Loss lead the stat tiles', (await labels('.ov-stat-strip')).slice(0, 2).join() === 'Biggest Win,Biggest Loss', await labels('.ov-stat-strip'))
    ok('the overview has the four quick actions under the balance', await p.evaluate(() => [...document.querySelectorAll('.nova-act')].map(b => b.textContent).join() === 'Deposit,Withdraw,Send,Trade'))
  }

  await p.evaluate(() => window.__onUiVersion('classic'))
  if (!mob) {
    await until('the cards back', () => p.evaluate(() => [...document.querySelectorAll('.ov-winloss > * .ov-stat-label')].map(e => e.textContent.trim()).join() === 'Biggest Win,Biggest Loss'))
    ok('and in Classic the cards are back where they always were', await p.evaluate(() =>
      [...document.querySelectorAll('.ov-stat-strip > * .ov-stat-label')].map(e => e.textContent.trim()).slice(0, 2).join() === 'Unrealized PnL,Net PnL'))
  }
  if (!mob) ok('back in Classic: the sidebar is where it was, the new controls are gone', await p.evaluate(() =>
    document.querySelector('.sidebar').getBoundingClientRect().left >= 0 && !document.getElementById('novaMenuBtn').offsetParent && !document.querySelector('.nova-actions')?.offsetParent))
  ok('and back to Classic in one tap, exactly as it was', !(await p.evaluate(() => document.documentElement.classList.contains('ui-nova'))) && (await font()) === classicFont)
  if (mob) ok('the phone page does not scroll sideways in the new look', await p.evaluate(() => { document.documentElement.classList.add('ui-nova'); return document.documentElement.scrollWidth <= window.innerWidth + 1 }))
  ok('no page errors', errs.length === 0, errs)
  await ctx.close()
}
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
