// The Agent Arena (src/agentsview.js), in the real app, both shells.
//
// Asked for: "lets add trading agents in paper trading" → "go with 1 + 3, shared": an Oracle agent
// and simple personas, each on its own paper account, a shared board, a journal per agent, and
// buy-and-hold BTC as the benchmark. The board ranks by return; colours follow the agent; a card
// opens to its rules, positions and journal; the chart shows every agent with a hover readout.
//
// Hermetic: /agents-data and Hyperliquid are stubbed.
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { AGENTS } from '../src/agents.js'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const SHOT = (process.argv.find(a => a.startsWith('--shot=')) || '').split('=')[1] || ''
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

// Returns chosen so the board order differs from the AGENTS order: momentum first, hodl third.
const NOW = Date.now(), H = 3600e3
const RET = { oracle: 1.5, momentum: 6.2, dip: -3.1, funding: 0.4, hodl: 2.0 }
const SUMMARY = {
  at: NOW - 60e3, started: NOW - 48 * H,
  agents: AGENTS.map(a => {
    const end = 1000 * (1 + RET[a.id] / 100)
    const curve = Array.from({ length: 49 }, (_, i) => [NOW - (48 - i) * H, 1000 + (end - 1000) * i / 48])
    return {
      id: a.id, name: a.name, color: a.color, blurb: a.blurb, lev: a.lev, max: a.max, every: a.every, baseline: !!a.baseline,
      equity: end, start: 1000, ret: RET[a.id], maxDD: a.id === 'dip' ? 4.2 : 0, trades: a.id === 'momentum' ? 4 : 0, wins: a.id === 'momentum' ? 3 : 0,
      positions: a.id === 'momentum' ? [{ coin: 'SOL', szi: 3.2, entryPx: 150, mark: 155, upnl: 16, lev: 2, value: 496 }, { coin: 'DOGE', szi: -2000, entryPx: 0.2, mark: 0.19, upnl: 20, lev: 2, value: 380 }] : [],
      stops: a.id === 'momentum' ? [{ coin: 'SOL', px: 132 }] : [],
      last: NOW - 2 * H, next: NOW + 22 * H, curve,
      journal: a.id === 'momentum' ? [
        { t: NOW - 2 * H, kind: 'open', coin: 'SOL', side: 'long', px: 150, why: '30d +24.0%: among the strongest' },
        { t: NOW - 3 * H, kind: 'stop', coin: 'ETH', side: 'long', px: 2800, pnl: -42.5, why: 'stop hit' },
      ] : [],
    }
  }),
}
const MIDS = { BTC: '90000', ETH: '3000', SOL: '150', HYPE: '40' }
const UNIVERSE = Object.keys(MIDS).map(name => ({ name, szDecimals: 2, maxLeverage: 20 }))
const CTX = UNIVERSE.map(u => { const px = MIDS[u.name]; return { funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] } })
const HL = { meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX], perpDexs: [null], allMids: MIDS,
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []] }

let answer = { status: 200, json: SUMMARY }
async function open(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/agents-data', r => r.fulfill({ status: answer.status, contentType: 'application/json', json: answer.json }))
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
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.__openAgents)
  await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
  return { ctx, p }
}

const board = (p) => p.evaluate(() => [...document.querySelectorAll('#agentArenaOverlay .ag-card')].map(c => ({ id: c.dataset.ag, ret: c.querySelector('.ag-ret')?.textContent.trim() })))

const errs = []
const browser = await chromium.launch()

for (const [label, opts] of [['phone', { ...devices['iPhone 14 Pro'] }], ['desktop', { viewport: { width: 1500, height: 950 } }]]) {
  console.log(`\n-- ${label} --`)
  answer = { status: 200, json: SUMMARY }
  const { ctx, p } = await open(opts)
  t(`${label}: More has an Agent Arena entry`, await p.evaluate(() => !!document.querySelector('#mobMoreDrawer button[onclick="window.__openAgents()"]')), true)
  if (label === 'desktop') t('desktop: and the sidebar has one, visible', await p.evaluate(() => { const e = document.querySelector('.sidebar-item[onclick="window.__openAgents()"]'); return !!e && e.offsetParent !== null }), true)
  await p.evaluate(() => window.__openAgents())
  await waitFor(p, 'the board', () => document.querySelectorAll('#agentArenaOverlay .ag-card').length === 5)
  const b = await board(p)
  t(`${label}: ranked by return, best first`, b.map(x => x.id), ['momentum', 'hodl', 'oracle', 'funding', 'dip'])
  t(`${label}: returns signed`, b.map(x => x.ret), ['+6.20%', '+2.00%', '+1.50%', '+0.40%', '−3.10%'])
  t(`${label}: HODL BTC is marked as the benchmark`, await p.evaluate(() => /benchmark/.test(document.querySelector('.ag-card[data-ag="hodl"] .ag-name')?.textContent ?? '')), true)
  t(`${label}: every other agent says how far it is from HODL`, await p.evaluate(() => document.querySelector('.ag-card[data-ag="momentum"] .ag-stats')?.textContent.includes('+4.20%')), true)
  t(`${label}: a dot keeps the agent's colour, whatever its rank`, await p.evaluate((c) => getComputedStyle(document.querySelector('.ag-card[data-ag="momentum"] .ag-name i')).backgroundColor, AGENTS.find(a => a.id === 'momentum').color), 'rgb(167, 139, 250)')
  t(`${label}: the chart has a line per agent and a legend`, await p.evaluate(() => [document.querySelectorAll('#agentArenaOverlay .ag-chart svg path').length, document.querySelectorAll('#agentArenaOverlay .ag-leg').length]), [5, 5])

  // Hover the middle of the chart: the readout lists all five, best first.
  const box = await p.locator('#agentArenaOverlay .ag-chart svg').boundingBox()
  await p.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2)
  await waitFor(p, 'the readout', () => getComputedStyle(document.querySelector('.ag-tip')).display !== 'none', null, 4000)
  t(`${label}: hovering the chart reads every agent at that time`, await p.evaluate(() => document.querySelectorAll('.ag-tip > div i').length), 5)

  await p.click('.ag-card[data-ag="momentum"] [data-ag-open]')
  await waitFor(p, 'the card opens', () => !!document.querySelector('.ag-card[data-ag="momentum"] .ag-body'))
  const body = await p.evaluate(() => {
    const c = document.querySelector('.ag-card[data-ag="momentum"]')
    return { rules: /30-day trends/.test(c.querySelector('.ag-blurb')?.textContent ?? ''), pos: c.querySelectorAll('.ag-body table:not(.ag-journal) tbody tr').length,
      stop: c.querySelector('.ag-body table:not(.ag-journal) tbody tr td:last-child')?.textContent, jr: c.querySelectorAll('.ag-journal tbody tr').length,
      stopped: /Stopped/.test(c.querySelector('.ag-journal')?.textContent ?? ''), loss: c.querySelector('.ag-j-stop .neg')?.textContent, why: /among the strongest/.test(c.textContent),
      drag: [...c.querySelectorAll('.ag-tbl-wrap')].every(w => w.hasAttribute('data-dragscroll')) }
  })
  t(`${label}: a card opens to its rules, positions (with stops) and journal`, body, { rules: true, pos: 2, stop: '132.000', jr: 2, stopped: true, loss: '−$42.50', why: true, drag: true })
  t(`${label}: it fits, no sideways page scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.ag-scroll').scrollWidth <= document.querySelector('.ag-scroll').clientWidth), true)
  if (SHOT) await p.screenshot({ path: `${SHOT}/agents-${label}.png` })
  await p.click('[data-ag-close]')
  t(`${label}: × closes it`, await p.evaluate(() => getComputedStyle(document.getElementById('agentArenaOverlay')).display), 'none')

  // Before the server's first run the answer is unknown, and the screen says so — not "no agents".
  answer = { status: 503, json: { agents: null } }
  await p.evaluate(() => window.__openAgents())
  await waitFor(p, 'the starting message', () => /starting up/.test(document.querySelector('#agentArenaOverlay .ag-scroll')?.textContent ?? ''), null, 8000)
  t(`${label}: before the first run it says the agents are starting`, await p.evaluate(() => /starting up/.test(document.querySelector('#agentArenaOverlay .ag-scroll').textContent)), true)
  await ctx.close()
}

t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
