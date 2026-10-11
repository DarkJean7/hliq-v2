// The paper account on screen stays the one on screen.
//
// Reported: a paper account ("PF · insolvent") showed the Challenge account's positions, and
// the two seemed to swap. Four seconds after boot the Challenge auto-submit switched the paper
// account to the Challenge one — under whatever account was being looked at, with that
// account's name still in the header.
//
// Hermetic: enrolled in the Challenge (its account holds ADA and HYPE), looking at another
// paper account (it holds SOL). Well past the four seconds, SOL is on screen and ADA is not.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x))) }
const waitFor = async (p, label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}
const UNIVERSE = ['BTC', 'SOL', 'ADA', 'HYPE'].map(name => ({ name, szDecimals: 2, maxLeverage: 20 }))
const MIDS = { BTC: '100', SOL: '110', ADA: '0.25', HYPE: '86' }
const HL = {
  allMids: MIDS, meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] }, perpDexs: [null], allPerpMetas: [{ universe: UNIVERSE }],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, UNIVERSE.map(u => ({ funding: '0', openInterest: '0', prevDayPx: MIDS[u.name], dayNtlVlm: '0', premium: '0', oraclePx: MIDS[u.name], markPx: MIDS[u.name], midPx: MIDS[u.name], impactPxs: [MIDS[u.name], MIDS[u.name]] }))],
  candleSnapshot: [], outcomeMeta: {},
}
const store = (positions) => JSON.stringify({ balance: 1000, positions, orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1000, created: Date.now() })
const pos = (coin, szi, entryPx) => ({ coin, szi, entryPx, margin: Math.abs(szi * entryPx) / 5, leverage: 5, isIsolated: false })

for (const [label, opts] of [['desktop', { viewport: { width: 1500, height: 950 } }], ['mobile', { viewport: { width: 430, height: 930 }, isMobile: true, hasTouch: true }]]) {
  console.log('\n-- ' + label + ' --')
  const browser = await chromium.launch()
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/paper/sync', r => r.fulfill({ status: 503, contentType: 'application/json', json: { ok: false } }))
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(([chal, pf]) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_chal_active', '1')
    localStorage.setItem('hliq_paper_chal_v2', chal)
    localStorage.setItem('hliq_paper_accts', JSON.stringify([{ slot: 'apf1', name: 'PF · insolvent', createdAt: 1 }]))
    localStorage.setItem('hliq_paper_s_apf1', pf)
    localStorage.setItem('hliq_paper_slot', 'apf1')
  }, [store([pos('ADA', -100, 0.3), pos('HYPE', 2, 50)]), store([pos('SOL', 1, 100)])])
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.__goPaper)
  await p.evaluate(() => window.__goPaper('apf1'))
  // The phone draws its position cards inside #mobVContent; the desktop in its positions table.
  const shows = (coin) => p.evaluate((c) => {
    const mob = document.getElementById('mobVContent')
    if (mob?.offsetParent) return new RegExp('\\b' + c + '\\b').test(mob.innerText)
    return [...document.querySelectorAll('*')].some(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === c && e.closest('[class*="pos"], [id*="pos"], [id*="Pos"], [class*="Pos"]'))
  }, coin)
  await waitFor(p, 'SOL on screen', () => [...document.querySelectorAll('*')].some(e => e.offsetParent && e.childElementCount === 0 && e.textContent.trim() === 'SOL'))
  ok('the chosen paper account is on screen', await shows('SOL'))
  // Past the four seconds after boot at which the Challenge used to take over.
  await p.waitForTimeout(6500)
  ok('well after boot it still is: SOL, its own position', await shows('SOL'))
  ok('and the Challenge account\'s ADA has not appeared under its name', !(await shows('ADA')))
  ok('it stays the account in use', await p.evaluate(() => localStorage.getItem('hliq_paper_slot')) === 'apf1')
  ok('no page errors', !errs.length, errs)
  await browser.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
