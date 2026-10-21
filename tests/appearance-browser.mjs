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

console.log('\n-- a wallpaper is framed and previewed before it is used --')
// "when uploading a photo (user image or background image), it should let the user resize, etc,
// and preview before putting it". A busy 800×400 PNG so there is something to frame.
const WALL = Buffer.from(await p.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 800; c.height = 400
  const g = c.getContext('2d'); for (let i = 0; i < 40; i++) { g.fillStyle = `hsl(${i * 9} 70% 50%)`; g.fillRect(i * 20, 0, 20, 400) }
  return c.toDataURL('image/png').split(',')[1]
}), 'base64')
const wallInput = 'input[type=file][onchange*="__onBackdropFile"]'
await p.setInputFiles(wallInput, { name: 'wall.png', mimeType: 'image/png', buffer: WALL })
t('picking one opens the editor', await waitFor(p, 'the editor', () => !!document.querySelector('.imged-ov .imged-cv')), true)
t('in this screen\'s shape', await p.evaluate(() => { const s = document.querySelector('.imged-stage').getBoundingClientRect(); return Math.abs(s.width / s.height - innerWidth / innerHeight) < 0.03 }), true)
t('under the dim the app will use, with a sample card to judge it by', await p.evaluate(() =>
  !!document.querySelector('.imged-ov .imged-dim') && !!document.querySelector('.imged-ov .imged-sample')), true)
t('not applied while it is being framed', await p.evaluate(() => document.documentElement.classList.contains('has-bg-image')), false)
// Zoom in, then drag: the stage must still be covered (no empty edge), which cropRect guarantees.
await p.evaluate(() => { const z = document.querySelector('.imged-zoom'); z.value = '2.5'; z.dispatchEvent(new Event('input')) })
const box = await p.$eval('.imged-stage', el => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })
await p.mouse.move(box.x, box.y); await p.mouse.down(); await p.mouse.move(box.x + 400, box.y + 200, { steps: 6 }); await p.mouse.up()
t('the zoom took', await p.$eval('.imged-zoom', z => +z.value), 2.5)
await p.click('.imged-ov [data-act="cancel"]')
t('Cancel leaves the app as it was', await p.evaluate(() => !document.querySelector('.imged-ov') && !document.documentElement.classList.contains('has-bg-image')), true)
await p.setInputFiles(wallInput, { name: 'wall.png', mimeType: 'image/png', buffer: WALL })
await waitFor(p, 'the editor', () => !!document.querySelector('.imged-ov .imged-cv'))
await p.click('.imged-ov [data-act="apply"]')
await waitFor(p, 'the wallpaper', () => document.documentElement.classList.contains('has-bg-image'))
t('Apply sets it', await p.evaluate(() => document.documentElement.classList.contains('has-bg-image')), true)
t('as the framed crop, in this screen\'s shape', await p.evaluate(() => new Promise((res) => {
  const url = (localStorage.getItem('hliq_backdrop_img') || getComputedStyle(document.documentElement).getPropertyValue('--app-bg-image').replace(/^url\("?|"?\)$/g, ''))
  const img = new Image(); img.onload = () => res(Math.abs(img.width / img.height - innerWidth / innerHeight) < 0.03); img.onerror = () => res(false); img.src = url
})), true)
await p.evaluate(() => window.__onBackdropClear?.())

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
