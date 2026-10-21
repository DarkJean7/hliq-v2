// Scroll smoothness, measured. Reported: "lets make the app be more smoother, currently when
// scrolling down for example its kinda buggy" — desktop, the new interface, a wallpaper set.
//
// Loads a stubbed account long enough to scroll (40 positions), puts a photo behind it the way
// Settings does, wheels down and back up, and records every animation frame. Each VARIANT
// injects a stylesheet that turns one effect off, so what each effect costs is a number rather
// than a guess. Not part of npm run test:browser: it reports, it does not pass or fail, and
// frame times depend on the machine. Compare variants within one run, never across machines.
//
//   npm run dev            (another terminal)
//   node tests/scrollperf.mjs [--port=5175] [--gpu] [--runs=2] [--mobile]
import { chromium } from 'playwright'

const arg = (k, d) => (process.argv.find(a => a.startsWith('--' + k + '=')) || '').split('=')[1] || d
const port = arg('port', '5175'), RUNS = +arg('runs', '2')
const GPU = process.argv.includes('--gpu'), MOBILE = process.argv.includes('--mobile')
// --live: real Hyperliquid data for one public wallet instead of the fixture, so the page is
// doing what it does for a user — repricing, re-rendering — while it is scrolled. Reads only.
const LIVE = process.argv.includes('--live')
const URL = `http://localhost:${port}/app`
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

const COINS = Array.from({ length: 40 }, (_, i) => 'C' + i)
const now = Date.now(), HR = 36e5
const WINDOW = {
  accountValueHistory: Array.from({ length: 60 }, (_, i) => [now - (59 - i) * HR, String(3000 + Math.sin(i / 4) * 300)]),
  pnlHistory: Array.from({ length: 60 }, (_, i) => [now - (59 - i) * HR, String(Math.sin(i / 4) * 300)]),
  vlm: '0',
}
const pos = COINS.map((c, i) => ({ type: 'oneWay', position: {
  coin: c, szi: String(i % 2 ? 10 : -10), entryPx: '100', positionValue: '1000', unrealizedPnl: String((i % 7) - 3),
  returnOnEquity: '0.01', liquidationPx: '50', marginUsed: '100', maxLeverage: 20,
  leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }))
const MARGIN = { accountValue: '3500', totalNtlPos: '40000', totalRawUsd: '3500', totalMarginUsed: '4000' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '400', withdrawable: '500', assetPositions: pos, time: now }
const UNIVERSE = COINS.map(c => ({ name: c, szDecimals: 2, maxLeverage: 20 }))
const CTX = COINS.map(() => ({ funding: '0', openInterest: '0', prevDayPx: '99', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }))
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: Object.fromEntries(COINS.map(c => [c, '100'])),
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX],
}

// What each variant switches off. '' is the app as shipped.
const VARIANTS = {
  'as shipped': '',
  'no card blur': 'html.has-bg-image * { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; }',
  'no big shadows': 'html.ui-nova * { box-shadow: none !important; }',
  'neither': 'html.has-bg-image * { -webkit-backdrop-filter: none !important; backdrop-filter: none !important; } html.ui-nova * { box-shadow: none !important; }',
}

const browser = await chromium.launch(GPU ? { args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=d3d11'] } : {})
const ctx = await browser.newContext(MOBILE
  ? { viewport: { width: 430, height: 930 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 }
  : { viewport: { width: 1885, height: 905 } })
if (!LIVE) try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
if (!LIVE) await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
if (!LIVE) await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
const p = await ctx.newPage()
await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  // Without these a language chooser covers the page and takes every wheel event.
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 30000 })
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await p.waitForFunction(() => document.querySelectorAll('#ovPosBody > *, .mob-v-pos-card, .ov-pos-row').length >= 10, null, { timeout: 30000 }).catch(() => {})

// A photo the size of a desktop screen, busy enough that a blur has real work to do.
await p.evaluate(() => {
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080
  const g = c.getContext('2d')
  for (let i = 0; i < 400; i++) {
    g.fillStyle = `hsl(${(i * 37) % 360} 60% ${20 + (i % 5) * 10}%)`
    g.beginPath(); g.arc(Math.random() * 1920, Math.random() * 1080, 20 + Math.random() * 120, 0, 7); g.fill()
  }
  const el = document.documentElement
  el.style.setProperty('--app-bg-image', `url("${c.toDataURL('image/jpeg', 0.85)}")`)
  el.style.setProperty('--app-bg-dim', '0.62')
  el.classList.add('has-bg-image')
})
await p.waitForTimeout(1500)
// ...and an announcement may still open on top. Anything modal goes.
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
// How far anything actually scrolled, so a run where the wheel went nowhere cannot pass for a
// smooth one (the first version of this measured a modal and reported "90fps").
await p.evaluate(() => addEventListener('scroll', (e) => {
  const el = e.target === document ? document.scrollingElement : e.target
  window.__maxScroll = Math.max(window.__maxScroll ?? 0, el.scrollTop)
}, { capture: true, passive: true }))
let moved = 0
await p.evaluate(() => {
  window.__mut = 0; window.__shift = 0
  new MutationObserver((ms) => { for (const m of ms) window.__mut += m.addedNodes.length + m.removedNodes.length }).observe(document.body, { childList: true, subtree: true })
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__shift += e.value }).observe({ type: 'layout-shift', buffered: false }) } catch {}
})
let mut = 0, shift = 0

const scroller = await p.evaluate(() => {
  const all = [document.scrollingElement, ...document.querySelectorAll('*')]
  const s = all.filter(e => e && e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) || e === document.scrollingElement)
    .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight))[0]
  return { tag: s.tagName + (s.id ? '#' + s.id : '') + (s.className && typeof s.className === 'string' ? '.' + s.className.split(' ')[0] : ''), range: s.scrollHeight - s.clientHeight }
})
console.log(`scrolling ${scroller.tag}, ${scroller.range}px of travel · ${MOBILE ? 'mobile 430x930' : 'desktop 1885x905'} · ${GPU ? 'GPU' : 'software'} rendering`)

// Where the wheel goes: over the hero card, which has no scroller of its own, so it scrolls the
// PAGE — what "scrolling down" means. (Over the positions table it scrolls that table instead.)
const target = await p.evaluate(() => {
  const el = document.querySelector('.ov-hero, .ov-equity, .chart-container, .mob-v-card')
  const r = el?.getBoundingClientRect()
  return r ? { x: r.left + r.width / 2, y: r.top + Math.min(r.height / 2, 120) } : null
})

// A trace, not requestAnimationFrame. Headless Chromium's frame clock does not wait for
// painting, so rAF intervals said 90fps with or without a full-screen blur. What makes a
// scroll stutter is the work each scroll step sets off — repainting, rasterising, layout and
// any script listening for it — and the trace adds that up per thread.
//
// The renderer alone is not enough: a backdrop blur is drawn by the GPU process, so a trace of
// the page's own threads showed ~15ms of work a second with or without it. So this measures
// how BUSY each thread that takes part in drawing a frame was — overlapping events merged, so
// nothing is counted twice — in milliseconds per second of scrolling. One thread near 1000 is
// a thread that could not keep up, and that is a dropped frame.
const THREADS = { CrRendererMain: 'page', Compositor: 'compositor', CrGpuMain: 'gpu', VizCompositorThread: 'display' }
async function measure() {
  const cdp = await ctx.newCDPSession(p)
  const events = []
  cdp.on('Tracing.dataCollected', (e) => events.push(...e.value))
  const done = new Promise(r => cdp.once('Tracing.tracingComplete', r))
  await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline,viz,gpu,cc,toplevel', transferMode: 'ReportEvents' })
  await p.evaluate(() => { window.__maxScroll = 0; window.__mut = 0; window.__shift = 0 })
  const vp = p.viewportSize()
  await p.mouse.move(target?.x ?? vp.width * 0.45, target?.y ?? vp.height * 0.3)
  const t0 = Date.now()
  for (const dir of [1, -1]) for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, dir * 100); await p.waitForTimeout(LIVE ? 70 : 16) }
  await p.waitForTimeout(300)
  const secs = (Date.now() - t0) / 1000
  ;({ moved, mut, shift } = await p.evaluate(() => ({ moved: window.__maxScroll ?? 0, mut: window.__mut, shift: window.__shift })))
  await cdp.send('Tracing.end'); await done; await cdp.detach()
  // Thread names arrive as metadata events; key the rest by pid:tid.
  const names = new Map()
  for (const e of events) if (e.ph === 'M' && e.name === 'thread_name') names.set(e.pid + ':' + e.tid, e.args?.name)
  const spans = new Map()
  for (const e of events) {
    if (e.ph !== 'X' || !e.dur) continue
    const k = THREADS[names.get(e.pid + ':' + e.tid)]
    if (!k) continue
    if (!spans.has(k)) spans.set(k, [])
    spans.get(k).push([e.ts, e.ts + e.dur])
  }
  const busy = {}
  for (const [k, xs] of spans) {
    xs.sort((a, b) => a[0] - b[0])
    let tot = 0, [s, f] = xs[0]
    for (const [a, b] of xs.slice(1)) { if (a > f) { tot += f - s; s = a; f = b } else f = Math.max(f, b) }
    tot += f - s
    busy[k] = tot / 1000 / secs
  }
  return busy
}

const rows = []
for (const [name, css] of Object.entries(VARIANTS)) {
  await p.evaluate((css) => {
    let s = document.getElementById('__perfVariant')
    if (!s) { s = document.createElement('style'); s.id = '__perfVariant'; document.head.appendChild(s) }
    s.textContent = css
  }, css)
  await p.waitForTimeout(500)
  const rs = []
  for (let r = 0; r < RUNS; r++) rs.push(await measure())
  const avg = (k) => rs.reduce((s, x) => s + (x[k] ?? 0), 0) / rs.length
  const row = { variant: name, 'moved px': moved }
  for (const k of Object.values(THREADS)) row[k] = Math.round(avg(k))
  row['nodes rewritten'] = mut
  row['layout shift'] = +shift.toFixed(3)
  row.busiest = Math.max(...Object.values(THREADS).map(k => row[k]))
  rows.push(row)
}
console.log('ms each thread was busy per second of scrolling (near 1000 = dropping frames; lower is smoother):')
console.table(rows)
await browser.close()
