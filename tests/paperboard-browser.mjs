// Leaderboard → Paper with the Agent Arena agents on it, in the real app, both shells.
//
// Asked for: "add the agents to the paper leaderboard with their names and besides the name
// "(agent)", to identify them and be able to watch the accounts like a regular paper account".
// The board is read from /paper-board (serve-prod.js, src/paperboard.js); an agent row opens,
// Visit shows its positions and trades from /paper-board/one, and it offers no hide / remove /
// copy trade (nobody owns it, and the copy bot cannot follow it yet).
//
// Hermetic: /paper-board, /api and Hyperliquid are stubbed.
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ` → ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`)
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const NOW = Date.now()
const pos = (coin, szi) => ({ position: { coin, szi: String(szi), entryPx: '100', positionValue: String(Math.abs(szi) * 102), unrealizedPnl: String(szi * 2), liquidationPx: '40', leverage: { type: 'cross', value: 2 }, returnOnEquity: '0.04' }, type: 'oneWay' })
const track = (trades, wins) => ({ trades, wins, losses: trades - wins, grossWin: 30, grossLoss: 10, profitFactor: 3, pfBasis: 'trades', lastFillAt: NOW - 3600e3, maxDrawdown: { usd: 5, pct: 0.5 } })
const AGENT = { name: 'Oracle (agent)', agent: true, agentId: 'oracle', equity: 1042.5, pnl: 42.5, trades: 3, wins: 2, track: track(3, 2), unrealizedPnl: 4, realizedPnl: 40,
  volume: 6000, healthPct: 88, positions: [pos('SOL', 2)], openOrders: [], created: NOW - 2 * 86400e3, updated: NOW }
const ROWS = [
  { name: 'alice', equity: 1100, pnl: 100, trades: 4, wins: 3, track: track(4, 3), positions: [], openOrders: [], updated: NOW },
  AGENT,
  { name: 'HODL BTC (agent)', agent: true, agentId: 'hodl', equity: 990, pnl: -10, trades: 0, wins: 0, track: track(0, 0), positions: [pos('BTC', 0.01)], openOrders: [], updated: NOW },
]
const FILLS = [
  { coin: 'SOL', tid: 'p7', time: NOW - 3600e3, side: 'B', px: '100', sz: '2', closedPnl: '0', fee: '0.09', startPosition: '0', dir: 'Open Long' },
  { coin: 'ETH', tid: 'p5', time: NOW - 7200e3, side: 'A', px: '3100', sz: '0.1', closedPnl: '20', fee: '0.14', startPosition: '0.1', dir: 'Close Long' },
]
const MIDS = { BTC: '90000', ETH: '3000', SOL: '102', HYPE: '40' }
const UNIVERSE = Object.keys(MIDS).map(name => ({ name, szDecimals: 2, maxLeverage: 20 }))
const CTX = UNIVERSE.map(u => { const px = MIDS[u.name]; return { funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] } })
const HL = { meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX], perpDexs: [null], allMids: MIDS,
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []] }

const asked = []
async function open(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/paper-board', r => { asked.push('board'); return r.fulfill({ status: 200, contentType: 'application/json', json: { rows: ROWS, quiet: [], simulated: true, updatedAt: NOW } }) })
  await ctx.route('**/paper-board/one?**', r => {
    const name = new globalThis.URL(r.request().url()).searchParams.get('name')
    asked.push('one:' + name)
    return name === AGENT.name ? r.fulfill({ status: 200, contentType: 'application/json', json: { ok: true, row: AGENT, fills: FILLS, simulated: true, agent: true } })
      : r.fulfill({ status: 404, contentType: 'application/json', json: { error: 'no such paper account' } })
  })
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: b.type in HL ? HL[b.type] : [] })
  })
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
    localStorage.setItem('hliq_sub_unlocked', '1')
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.__goPaper)
  await p.evaluate(() => window.__goPaper())
  await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
  return { ctx, p }
}

// What the Visit sheet shows, once loaded.
async function visitOf(p) {
  await waitFor(p, 'the visit sheet', () => { const o = document.getElementById('paperVisitOv'); return o && o.style.display !== 'none' && /SOL/.test(o.textContent) })
  return p.evaluate(() => {
    const o = document.getElementById('paperVisitOv')
    // Shown as "(bot)" ("are the agents really agents or just bots?"); stored and asked for as "(agent)".
    return { name: /Oracle \(bot\)/.test(o.textContent) && !/\(agent\)/.test(o.textContent), sol: /SOL/.test(o.textContent), trades: /ETH/.test(o.textContent),
      copyTrade: /Copy trade/.test(o.textContent), remove: /Remove from leaderboard/.test(o.textContent) }
  })
}

const errs = []
const browser = await chromium.launch()

console.log('\n-- phone --')
{
  const { ctx, p } = await open({ ...devices['iPhone 14 Pro Max'], viewport: { width: 430, height: 930 }, isMobile: true })
  await waitFor(p, 'the mobile shell', () => !!window.mobVGoTab)
  await p.evaluate(() => { localStorage.setItem('hliq_dev', '1'); localStorage.setItem('hliq_lb_pin', 'test-pin') })   // dev mode: the buttons an agent must NOT get
  await p.evaluate(() => window.mobVGoTab('leaderboard'))
  await waitFor(p, 'the mode bar', () => /Paper/.test(document.getElementById('mobVContent')?.textContent ?? ''))
  await p.evaluate(() => window._mobVLbMode('paper'))
  await waitFor(p, 'the rows', () => document.querySelectorAll('#mobVContent .mob-v-row').length >= 3)
  const names = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .mob-v-row .mob-v-row-name')].map(e => e.textContent.trim()))
  t('phone: the board is read from /paper-board', asked.includes('board'), true)
  t('phone: the arena bots are on it, shown as "(bot)"', ['Oracle (bot)', 'HODL BTC (bot)'].every(n => names.some(x => x.includes(n))) && !names.some(x => /\(agent\)/.test(x)), true)
  const id = await p.evaluate(() => [...document.querySelectorAll('#mobVContent [id^="mrd-lb-"]')].map(e => e.id.slice(4)).find(x => /Oracle/.test(x)))
  await p.evaluate((id) => window._mobVToggleRow(id), id)
  const x = await p.evaluate((id) => { const el = document.getElementById('mrd-' + id); return el && { shown: el.style.display !== 'none', visit: /Visit/.test(el.textContent), copyTrade: /Copy trade/.test(el.textContent), remove: /Remove from leaderboard|Hide/.test(el.textContent), sol: /SOL/.test(el.textContent) } }, id)
  t('phone: an agent row opens to its positions and Visit', [x?.shown, x?.sol, x?.visit], [true, true, true])
  t('phone: Copy trade ("make the agents copy-tradeable"), but no hide or remove — even in dev mode', [x?.copyTrade, x?.remove], [true, false])
  // …which a person's row does have, so the line above is not passing because nothing ever shows them.
  const ida = await p.evaluate(() => [...document.querySelectorAll('#mobVContent [id^="mrd-lb-"]')].map(e => e.id.slice(4)).find(x => /alice/.test(x)))
  await p.evaluate((id) => window._mobVToggleRow(id), ida)
  t('phone: a person\'s row keeps copy trade, hide and remove', await p.evaluate((id) => { const el = document.getElementById('mrd-' + id); return [/Copy trade/.test(el.textContent), /Remove from leaderboard/.test(el.textContent), /Hide/.test(el.textContent)] }, ida), [true, true, true])
  await p.evaluate((id) => document.querySelector('#mrd-' + id + ' button[onclick*="__paperVisit"]').click(), id)
  const v = await visitOf(p)
  t('phone: Visit asks /paper-board/one for it', asked.includes('one:Oracle (agent)'), true)
  t('phone: and shows it like any paper account — positions and trades', [v.name, v.sol, v.trades], [true, true, true])
  t('phone: no remove there either', v.remove, false)
  t('phone: it fits, no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await ctx.close()
}

console.log('\n-- desktop --')
{
  const { ctx, p } = await open({ viewport: { width: 1500, height: 950 } })
  await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
  await p.evaluate(() => window.switchTab('leaderboard'))
  await p.evaluate(() => window.__lbDeskMode('paper'))
  await waitFor(p, 'the rows', () => document.querySelectorAll('#leaderboardRoot tr.lb-row').length >= 3)
  const labels = await p.evaluate(() => [...document.querySelectorAll('#leaderboardRoot tr.lb-row .lb-label')].map(e => e.textContent.trim()))
  t('desktop: the arena bots are on it, shown as "(bot)"', ['Oracle (bot)', 'HODL BTC (bot)'].every(n => labels.some(x => x.includes(n))) && !labels.some(x => /\(agent\)/.test(x)), true)
  const uid = await p.evaluate(() => { const r = [...document.querySelectorAll('#leaderboardRoot tr.lb-row')].find(r => /Oracle \(bot\)/.test(r.textContent)); return (r.getAttribute('onclick') ?? '').match(/'(lbx-[^']+)'/)?.[1] })
  await p.evaluate((uid) => window.__lbToggle(uid, document.querySelector('tr.lb-row[onclick*="' + uid + '"]')), uid)
  const x = await p.evaluate((uid) => { const el = document.getElementById(uid); return el && { visit: /Visit/.test(el.textContent), copyTrade: /Copy trade/.test(el.textContent), remove: /Remove|Hide|Rename/.test(el.textContent) } }, uid)
  t('desktop: an agent row has Visit and Copy trade, no hide / remove', [x?.visit, x?.copyTrade, x?.remove], [true, true, false])
  await p.evaluate((uid) => document.querySelector('#' + uid + ' button[onclick*="__paperVisit"]').click(), uid)
  const v = await visitOf(p)
  t('desktop: Visit shows its positions and trades', [v.name, v.sol, v.trades], [true, true, true])
  await ctx.close()
}

await browser.close()
t('no page errors', errs, [])
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
