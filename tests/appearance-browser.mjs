// Three desktop screens brought in line with the rest of the app. Asked: "the portfolios (only
// from main app of course, not landing page) tab is not matching the overall main app. make
// settings idk centered and with more sense in desktop. fix allocation section tabs to be bigger
// and match other tabs like analysis."
//
//   Portfolios  the framed /portfolios?embed=1 takes the app's theme, live (src/pftheme.js),
//               while the public /portfolios keeps its own
//   Settings    centred, two columns on a wide screen
//   Allocation  the same full-width segment header as Analysis (_paneSegHeader)
//
// Hermetic: the exchange and the app's server are stubbed.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = `http://localhost:${port}`
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

const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }]
const CTX = UNIVERSE.map(() => ({ funding: '0', openInterest: '100', prevDayPx: '100', dayNtlVlm: '1000', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }))
const HL = {
  allMids: { BTC: '100', ETH: '100' }, meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX],
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  perpCategories: [], allPerpMetas: [], perpDexs: [null], outcomeMeta: {}, candleSnapshot: [],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/portfolios-data/**', r => r.fulfill({ status: 200, json: [] }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: b.type in HL ? HL[b.type] : {} })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(BASE + '/app', { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
})
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.__goPaper)
await p.evaluate(() => window.__goPaper())
await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))

console.log('\n-- Portfolios takes the app\'s theme --')
await p.evaluate(() => window.switchTab('portfolios'))
const frame = async () => (await p.$('#pfEmbedFrame'))?.contentFrame()
await waitFor(p, 'the frame', () => document.getElementById('pfEmbedFrame')?.contentDocument?.documentElement?.classList.contains('pf-embed'))
let f = await frame()
await f.waitForFunction(() => !!document.documentElement.style.getPropertyValue('--accent'), null, { timeout: 15000 }).catch(() => {})
const appAccent = () => p.evaluate(() => getComputedStyle(document.body).getPropertyValue('--accent').trim())
const frameAccent = () => f.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim())
t('the frame\'s accent is the app\'s', await frameAccent(), await appAccent())
await p.evaluate(() => window.__onAccentChange(142))
await p.waitForTimeout(300)
const green = await appAccent()
t('change the accent in the app and the frame follows, without a reload', await frameAccent(), green)
t('(and it really did change)', /142/.test(green), true)
t('the frame lets the app show through it', await f.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgba(0, 0, 0, 0)')
t('no scanlines', await f.evaluate(() => getComputedStyle(document.body, '::after').display), 'none')
t('the app\'s typeface, not the terminal mono, on its labels', await f.evaluate(() => {
  const el = document.querySelector('.pf-gal-sort, .pf-lbl'); return el ? !/JetBrains/.test(getComputedStyle(el).fontFamily) : null }), true)
t('no landing-page headline over a tab already called Portfolios', await f.evaluate(() => getComputedStyle(document.querySelector('.mk-title')).display), 'none')

console.log('\n-- the public /portfolios is untouched --')
const pub = await ctx.newPage()
await pub.goto(BASE + '/portfolios', { waitUntil: 'domcontentloaded' })
await pub.waitForTimeout(800)
t('no embed class', await pub.evaluate(() => document.documentElement.classList.contains('pf-embed')), false)
t('its own orange accent', await pub.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()), '#ff8a2a')
t('and its headline', await pub.evaluate(() => getComputedStyle(document.querySelector('.mk-title')).display !== 'none'), true)
await pub.close()

console.log('\n-- Settings: centred, two columns on a wide screen --')
await p.evaluate(() => window.switchTab('settings'))
await p.waitForTimeout(300)
const st = await p.evaluate(() => {
  const b = document.querySelector('#tab-settings .settings-body'), r = b.getBoundingClientRect(), pr = b.parentElement.getBoundingClientRect()
  return { cols: getComputedStyle(b).columnCount, off: Math.round(Math.abs((r.left - pr.left) - (pr.right - r.right))) }
})
t('two columns', st.cols, '2')
t('centred in its panel', st.off <= 2, true)

console.log('\n-- Allocation tabs match Analysis --')
const seg = async (tab) => {
  await p.evaluate((x) => window.switchTab(x), tab)
  await p.waitForTimeout(400)
  return p.evaluate(() => {
    const head = [...document.querySelectorAll('.pane-seg-head')].find(h => h.offsetParent !== null)
    const bs = [...(head?.querySelectorAll('[data-seg]') ?? [])]
    return { n: bs.length, grow: bs.every(b => getComputedStyle(b).flexGrow === '1'), h: Math.round(bs[0]?.getBoundingClientRect().height ?? 0), font: bs[0] ? getComputedStyle(bs[0]).fontSize : null }
  })
}
const alloc = await seg('allocation')
const ana = await seg('pulse')
t('Allocation has its three tabs, sharing the width', [alloc.n, alloc.grow], [3, true])
t('the same height and type as Analysis\'s', [alloc.h, alloc.font], [ana.h, ana.font])

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
