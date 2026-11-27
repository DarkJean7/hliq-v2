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
import { rektAgent, DEFAULT_CONFIG, STOPS, HORIZONS } from '../src/rekt.js'

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
const RET = { oracle: 1.5, momentum: 6.2, dip: -3.1, funding: 0.4, hodl: 2.0, rekt01: 3.0 }
const SUMMARY = {
  at: NOW - 60e3, started: NOW - 48 * H,
  agents: [...AGENTS, rektAgent].map(a => {
    const end = 1000 * (1 + RET[a.id] / 100)
    const curve = Array.from({ length: 49 }, (_, i) => [NOW - (48 - i) * H, 1000 + (end - 1000) * i / 48])
    return {
      id: a.id, name: a.name, color: a.color, blurb: a.blurb, lev: a.lev, max: a.max, every: a.every, baseline: !!a.baseline,
      equity: end, start: 1000, ret: RET[a.id], maxDD: a.id === 'dip' ? 4.2 : 0, trades: a.id === 'momentum' ? 4 : 0, wins: a.id === 'momentum' ? 3 : 0,
      positions: a.id === 'momentum' ? [{ coin: 'SOL', szi: 3.2, entryPx: 150, mark: 155, upnl: 16, lev: 2, value: 496, liq: 80.5, margin: 248, cross: true, funding: -0.42 }, { coin: 'DOGE', szi: -2000, entryPx: 0.2, mark: 0.19, upnl: 20, lev: 2, value: 380, liq: null, margin: 190, cross: true, funding: 0.1 }] : [],
      realized: a.id === 'momentum' ? 45.5 : 0, cash: 300,
      stops: a.id === 'momentum' ? [{ coin: 'SOL', px: 132 }, { coin: 'SOL', px: 180, tp: true }] : [],
      last: NOW - 2 * H, next: NOW + 22 * H, curve,
      ...(a.personal ? { personal: true, hidden: false, config: DEFAULT_CONFIG, learn: {
        since: NOW - 48 * H, weights: { oracle: 0.4, momentum: 0.3, reversion: 0.1, funding: 0.2 }, trades: 3, pending: 420,
        hist: Array.from({ length: 9 }, (_, i) => [NOW - (8 - i) * 6 * H, { oracle: 0.25 + i * 0.02, momentum: 0.25 + i * 0.006, reversion: 0.25 - i * 0.02, funding: 0.25 - i * 0.006 }]),
        stats: { oracle: { n: 900, hit: 0.58, avg: 0.04 }, momentum: { n: 1200, hit: 0.54, avg: 0.02 }, reversion: { n: 1200, hit: 0.44, avg: -0.03 }, funding: { n: 800, hit: 0.51, avg: 0.01 } },
        stops: STOPS.map(v => ({ v, n: v === 8 ? 2 : v === 5 ? 1 : 0, avg: v === 8 ? 1.2 : v === 5 ? -0.8 : null })), holds: HORIZONS.days.holds.map(v => ({ v, n: v === 96 ? 3 : 0, avg: v === 96 ? 0.5 : null })),
        pausedBy: null, peak: 1031 } } : {}),
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
    localStorage.setItem('hliq_sub_unlocked', '1')
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.__openAgents && !!window.__goPaper)
  // A tab lives inside the app, so open one: the paper account needs no wallet.
  await p.evaluate(() => window.__goPaper())
  await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
  return { ctx, p }
}

const board = (p) => p.evaluate(() => [...document.querySelectorAll('#agentArena .ag-card')].map(c => ({ id: c.dataset.ag, ret: c.querySelector('.ag-ret')?.textContent.trim() })))

const errs = []
const browser = await chromium.launch()

for (const [label, opts] of [['phone', { ...devices['iPhone 14 Pro'] }], ['desktop', { viewport: { width: 1500, height: 950 } }]]) {
  console.log(`\n-- ${label} --`)
  answer = { status: 200, json: SUMMARY }
  const { ctx, p } = await open(opts)
  t(`${label}: More has an Agent Arena entry`, await p.evaluate(() => !!document.querySelector(`#mobMoreDrawer button[onclick="window.__mobMoreTab('agents')"]`)), true)
  if (label === 'desktop') {
    t('desktop: and the sidebar has one, visible', await p.evaluate(() => { const e = document.querySelector('.sidebar-item[data-tab="agents"]'); return !!e && e.offsetParent !== null }), true)
    await p.evaluate(() => document.querySelector('.sidebar-item[data-tab="agents"]').click())   // the sidebar scrolls; the row may be below its fold
  } else await p.evaluate(() => window.__mobMoreTab('agents'))
  await waitFor(p, 'the board', () => document.querySelectorAll('#agentArena .ag-card').length === 6)
  // "not take the whole window and behave like all tabs": in the page, the app's own navigation still there.
  t(`${label}: a tab, not an overlay over the app`, await p.evaluate(() => {
    const r = document.getElementById('agentArena')
    const nav = document.querySelector(innerWidth > 900 ? '.sidebar-item.active[data-tab="agents"]' : '#mobVBotMore')   // the sidebar is fixed, so ask its size, not offsetParent
    return [!!r.closest(innerWidth > 900 ? '#tab-agents.active' : '#mobVContent'), getComputedStyle(r).position !== 'fixed', !!nav && nav.getBoundingClientRect().width > 0]
  }), [true, true, true])
  const b = await board(p)
  t(`${label}: ranked by return, best first`, b.map(x => x.id), ['momentum', 'rekt01', 'hodl', 'oracle', 'funding', 'dip'])
  t(`${label}: returns signed`, b.map(x => x.ret), ['+6.20%', '+3.00%', '+2.00%', '+1.50%', '+0.40%', '−3.10%'])
  t(`${label}: HODL BTC is marked as the benchmark`, await p.evaluate(() => /benchmark/.test(document.querySelector('.ag-card[data-ag="hodl"] .ag-name')?.textContent ?? '')), true)
  t(`${label}: every other agent says how far it is from HODL`, await p.evaluate(() => document.querySelector('.ag-card[data-ag="momentum"] .ag-stats')?.textContent.includes('+4.20%')), true)
  t(`${label}: a dot keeps the agent's colour, whatever its rank`, await p.evaluate((c) => getComputedStyle(document.querySelector('.ag-card[data-ag="momentum"] .ag-name i')).backgroundColor, AGENTS.find(a => a.id === 'momentum').color), 'rgb(167, 139, 250)')
  t(`${label}: the chart has a line per agent and a legend`, await p.evaluate(() => [document.querySelectorAll('#agentArena .ag-chart svg path').length, document.querySelectorAll('#agentArena .ag-leg').length]), [6, 6])

  // Hover the middle of the chart: the readout lists all five, best first.
  const box = await p.locator('#agentArena .ag-chart svg').boundingBox()
  await p.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2)
  await waitFor(p, 'the readout', () => getComputedStyle(document.querySelector('.ag-tip')).display !== 'none', null, 4000)
  t(`${label}: hovering the chart reads every agent at that time`, await p.evaluate(() => document.querySelectorAll('.ag-tip > div i').length), 6)

  await p.click('.ag-card[data-ag="momentum"] [data-ag-open]')
  await waitFor(p, 'the card opens', () => !!document.querySelector('.ag-card[data-ag="momentum"] .ag-body'))
  const body = await p.evaluate(() => {
    const c = document.querySelector('.ag-card[data-ag="momentum"]')
    return { rules: /30-day trends/.test(c.querySelector('.ag-blurb')?.textContent ?? ''), pos: c.querySelectorAll('.ag-pos').length,
      stop: /Stop132\.000/.test(c.querySelector('.ag-pos').textContent), jr: c.querySelectorAll('.ag-journal tbody tr').length,
      stopped: /Stopped/.test(c.querySelector('.ag-journal')?.textContent ?? ''), loss: c.querySelector('.ag-j-stop .neg')?.textContent, why: /among the strongest/.test(c.textContent),
      drag: [...c.querySelectorAll('.ag-tbl-wrap')].every(w => w.hasAttribute('data-dragscroll')) }
  })
  t(`${label}: a card opens to its rules, positions (with stops) and journal`, body, { rules: true, pos: 2, stop: true, jr: 2, stopped: true, loss: '−$42.50', why: true, drag: true })
  // "we missing important data like liq price, size in tokens, etc" — inside the opened card ("unexpand the positions": closed cards list none).
  t(`${label}: a closed card lists no positions`, await p.evaluate(() => document.querySelectorAll('.ag-card:not(.open) .ag-pos').length), 0)
  const kvOf = (coin) => p.evaluate((coin) => { const e = [...document.querySelectorAll('.ag-card[data-ag="momentum"] .ag-pos')].find(x => x.querySelector('.ag-pos-h b').textContent === coin)
    return Object.fromEntries([...e.querySelectorAll('.ag-kv > span')].map(s => [s.querySelector('small').textContent, s.querySelector('b').textContent.replace(/\s+/g, ' ').trim()])) }, coin)
  const sol = await kvOf('SOL'), doge = await kvOf('DOGE')
  t(`${label}: a position shows size in tokens, liq price and how far, margin, stop, take profit, funding`, [sol.Size, sol['Liq. price'], sol.Margin, sol.Stop, sol['Take profit'], sol.Funding], ['3.2 SOL', '80.500 48.1%', '$248.00', '132.000', '180.000', '−$0.42'])
  t(`${label}: no liquidation price is "None", not 0; a short's size in its tokens`, [doge['Liq. price'], doge.Size], ['None', '2,000 DOGE'])
  t(`${label}: the card adds unrealized, realized, exposure, margin and free cash`, await p.evaluate(() => { const s = document.querySelector('.ag-card[data-ag="momentum"] .ag-stats').textContent.replace(/\s+/g, ' ')
    return ['Unrealized PnL+$36.00', 'Realized PnL+$45.50', 'Exposure$876', 'Margin used$438.00', 'Free cash$300.00'].filter(x => !s.includes(x)) }), [])
  t(`${label}: it fits, no sideways page scroll`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.ag-scroll').scrollWidth <= document.querySelector('.ag-scroll').clientWidth), true)
  if (SHOT) await p.screenshot({ path: `${SHOT}/agents-${label}.png` })

  // Rekt-01: "my own personal agent that learns itself"; settings "only changeable by users with dev mode on".
  await p.click('.ag-card[data-ag="rekt01"] [data-ag-open]')
  await waitFor(p, 'Rekt-01 opens', () => !!document.querySelector('.ag-card[data-ag="rekt01"] .rk'))
  const rk = await p.evaluate(() => {
    const c = document.querySelector('.ag-card[data-ag="rekt01"]')
    return { yours: !!c.querySelector('.ag-yours'), bars: [...c.querySelectorAll('.rk-wn')].map(e => e.textContent.trim()), top: c.querySelector('.rk-wv')?.textContent,
      chart: !!c.querySelector('.rk-wchart path'), bestStop: c.querySelector('.rk-arms th.rk-best')?.textContent, form: !!c.querySelector('[data-rk-form]'), ro: !!c.querySelector('.rk-set.ro'), hint: /dev mode/.test(c.textContent),
      st: c.querySelector('.rk-st')?.textContent, ctl: c.querySelectorAll('[data-rk-ctl]').length }
  })
  t(`${label}: Rekt-01 shows what it has learned, most trusted signal first`, [rk.yours, rk.bars[0], rk.top, rk.chart, rk.bestStop], [true, 'Oracle call', '40%', true, '8%'])
  t(`${label}: without dev mode its settings are read-only`, [rk.form, rk.ro, rk.hint], [false, true, true])
  t(`${label}: without dev mode: its status, no controls`, [rk.st, rk.ctl], ['Running', 0])
  if (SHOT) await p.locator('.ag-card[data-ag="rekt01"]').screenshot({ path: `${SHOT}/rekt-${label}.png` })
  await p.click('#agentArena >> xpath=.. >> button[aria-label="Close"]')
  t(`${label}: × leaves it, like any tab`, await p.evaluate(() => { const r = document.getElementById('agentArena'); return !r || r.offsetParent === null }), true)

  // Dev mode: the form, and a save that carries the PIN and the values typed.
  await p.evaluate(() => { localStorage.setItem('hliq_dev', '1'); localStorage.setItem('hliq_lb_pin', 'test-pin') })
  let saved = null
  await ctx.route('**/agents-config', async (r) => { saved = { pin: r.request().headers()['x-lb-pin'], body: JSON.parse(r.request().postData() || '{}') }; await r.fulfill({ status: 200, contentType: 'application/json', json: { ok: true, config: { ...DEFAULT_CONFIG, ...saved.body.config } } }) })
  let pinSent = null
  await ctx.route('**/agents-data', r => { pinSent = r.request().headers()['x-lb-pin'] ?? null; return r.fulfill({ status: 200, contentType: 'application/json', json: SUMMARY }) })
  await p.evaluate(() => window.__openAgents())
  await waitFor(p, 'the form', () => !!document.querySelector('.ag-card[data-ag="rekt01"] [data-rk-form]'))
  // The desktop tab keeps the arena while hidden, so coming back paints the form from what it
  // has BEFORE the refetch goes out. Wait for the request itself, not just the form: reading
  // pinSent at once passed locally and failed on CI's slower runner.
  for (const t0 = Date.now(); pinSent === null && Date.now() - t0 < 8000;) await new Promise(r => setTimeout(r, 50))
  t(`${label}: dev mode asks with its PIN and gets the form`, [pinSent, await p.evaluate(() => !!document.querySelector('[data-rk-form] [name=maxLev]'))], ['test-pin', true])
  await p.fill('[data-rk-form] [name=maxLev]', '5')
  await p.selectOption('[data-rk-form] [name=mode]', 'allow')
  await p.fill('[data-rk-form] [name=list]', 'btc, eth')
  await p.selectOption('[data-rk-form] [name=style]', 'cautious')
  await p.uncheck('[data-rk-form] [name=arena]')
  await p.click('[data-rk-save]')
  await waitFor(p, 'the save', () => /Saved/.test(document.querySelector('.rk-status')?.textContent ?? ''), null, 8000)
  t(`${label}: Save sends the PIN and the values`, saved && [saved.pin, saved.body.config.maxLev, saved.body.config.markets.mode, saved.body.config.markets.list, saved.body.config.style, saved.body.config.arena], ['test-pin', 5, 'allow', ['btc', 'eth'], 'cautious', false])
  t(`${label}: and says it was saved, flagged out of the Bot Pit`, await p.evaluate(() => [/Saved/.test(document.querySelector('.rk-status').textContent), /not in the Bot Pit/.test(document.querySelector('.ag-card[data-ag="rekt01"] .ag-name').textContent)]), [true, true])
  t(`${label}: the settings form fits too`, await p.evaluate(() => document.querySelector('.ag-scroll').scrollWidth <= document.querySelector('.ag-scroll').clientWidth), true)
  // The controls: "restart, pause, stop, start … clear its track". Each carries the PIN; clear asks first.
  const ctl = []
  await ctx.route('**/agents-control', async (r) => { const b = JSON.parse(r.request().postData() || '{}'); ctl.push([r.request().headers()['x-lb-pin'], b.action]); await r.fulfill({ status: 200, contentType: 'application/json', json: { ok: true, config: { ...DEFAULT_CONFIG, status: { pause: 'paused', stop: 'stopped' }[b.action] ?? 'running' } } }) })
  t(`${label}: running shows Pause, Stop, Restart, Clear — not Start`, await p.evaluate(() => [...document.querySelectorAll('[data-rk-ctl]')].map(b => b.dataset.rkCtl)), ['pause', 'stop', 'restart', 'clear'])
  await p.click('[data-rk-ctl="pause"]')
  await waitFor(p, 'the pause', () => !!document.querySelector('[data-rk-ctl="start"]'), null, 8000)
  t(`${label}: Pause sends the PIN; the board shows it paused, with Start`, [ctl.at(-1), await p.evaluate(() => [document.querySelector('.rk-st').textContent, /Paused:/.test(document.querySelector('.rk-paused')?.textContent ?? '')])], [['test-pin', 'pause'], ['Paused', true]])
  p.once('dialog', d => d.dismiss())
  await p.click('[data-rk-ctl="clear"]')
  await p.waitForTimeout(300)
  t(`${label}: Clear track asks first; Cancel sends nothing`, ctl.length, 1)
  p.once('dialog', d => d.accept())
  await p.click('[data-rk-ctl="clear"]')
  await waitFor(p, 'the clear', () => /Done|Queued/.test(document.querySelector('.rk-ctl-status')?.textContent ?? ''), null, 8000)
  t(`${label}: OK sends it`, ctl.at(-1), ['test-pin', 'clear'])
  await ctx.unroute('**/agents-control')
  if (SHOT) await p.locator('.ag-card[data-ag="rekt01"] .rk-form').screenshot({ path: `${SHOT}/rekt-form-${label}.png` })
  await p.click('#agentArena >> xpath=.. >> button[aria-label="Close"]')
  await ctx.unroute('**/agents-data')
  await ctx.route('**/agents-data', r => r.fulfill({ status: answer.status, contentType: 'application/json', json: answer.json }))

  // Before the server's first run the answer is unknown, and the screen says so — not "no agents".
  answer = { status: 503, json: { agents: null } }
  await p.evaluate(() => window.__openAgents())
  await waitFor(p, 'the starting message', () => /starting up/.test(document.querySelector('#agentArena .ag-scroll')?.textContent ?? ''), null, 8000)
  t(`${label}: before the first run it says the agents are starting`, await p.evaluate(() => /starting up/.test(document.querySelector('#agentArena .ag-scroll').textContent)), true)
  await ctx.close()
}

t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
