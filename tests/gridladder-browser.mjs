// The Grid Ladder panel (src/gridladder-ui.js), driven through the real app against a stubbed
// Hyperliquid (mainnet and testnet hosts) and a stubbed bot server.
//
// Asserts what the panel promises: five bots with the default ranges; testnet by default; a
// level below Hyperliquid's $10 minimum cannot start; two bots on one account cannot start;
// Start sends exactly the bot's config (network, --vault for a subaccount, never --mainnet-ok
// off mainnet); mainnet is off until confirmed; a running bot shows its numbers, can't be
// edited, and Stop & close asks first and then sends mode "close"; the phone layout does not
// scroll sideways.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 400))) }
const until = async (label, fn, ms = 20000) => {
  const t0 = Date.now()
  for (;;) { try { if (await fn()) return true } catch {} if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false } await new Promise(r => setTimeout(r, 150)) }
}
const A = '0x' + 'a1'.repeat(20), B = '0x' + 'b2'.repeat(20), SUB = '0x' + 'c3'.repeat(20)
const KEY_A = '0x' + '11'.repeat(32), KEY_B = '0x' + '22'.repeat(32)
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'HYPE', szDecimals: 2, maxLeverage: 10 }]
const ctxRow = (px) => ({ funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] })
const HL = {
  allMids: { BTC: '100000', HYPE: '81' }, meta: { universe: UNIVERSE }, perpDexs: [null], allPerpMetas: [{ universe: UNIVERSE }],
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [ctxRow('100000'), ctxRow('81')]],
  candleSnapshot: [], outcomeMeta: {}, perpCategories: [], clearinghouseState: { assetPositions: [], marginSummary: { accountValue: '0' } },
}
// Testnet's HYPE is isolated-only and priced differently.
const HL_TEST = { metaAndAssetCtxs: [{ universe: [UNIVERSE[0], { ...UNIVERSE[1], onlyIsolated: true }] }, [ctxRow('100000'), ctxRow('42.5')]] }

const RUNNING = {
  key: `testnet:${A}:1`, bot: 1, instance: 'L1', network: 'testnet', trade: A, vault: '', running: true, paused: false, lastError: '', updated: Date.now(),
  cfg: { id: 1, low: 50, high: 70, levels: 10, usd: 20, leverage: 3, margin: 'isolated', killPrice: 0 },
  prices: [50, 52.222, 54.444, 56.667, 58.889, 61.111, 63.333, 65.556, 67.778, 70], waiting: false, stopped: false, killed: false, drift: 0,
  pairs: [0, 1, 2, 3, 4].map(i => ({ i, phase: 'B', sz: 0.38, px: null, placed: true, filled: 0, sold: 0, cycle: 2 })).concat([5, 6, 7, 8].map(i => ({ i, phase: 'S', sz: 0.32, px: null, placed: true, filled: 0.32, sold: 0, cycle: 1 }))),
  lifetime: null, closePnl: 0, live: { mid: 62, pos: 1.28, accountValue: 400, funding: 0.42, network: 'testnet', trade: A, master: A, bot: 1 },
  stats: { realized: 12.34, cycles: 17, fees: 0.81, funding: 0.42, inventory: 1.28, avgEntry: 64.1, unrealized: -2.69, net: 9.23, capitalInUse: 61, capitalIdle: 339, perDay: 1.76, perWeek: 12.34, days: 7 },
  events: [{ time: Date.now(), kind: 'cycle', msg: 'pair 3: +$0.8400' }], cycles: [],
}

const browser = await chromium.launch()
for (const [w, h, mob] of [[430, 930, true], [1400, 900, false]]) {
  console.log(`\n== ${mob ? 'phone' : 'desktop'} ==`)
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: mob })
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    const testnet = /testnet/.test(route.request().url())
    return route.fulfill({ status: 200, contentType: 'application/json', json: (testnet ? HL_TEST[b.type] : undefined) ?? HL[b.type] ?? {} })
  })
  const sent = []
  let showRunning = true
  await ctx.route(/\/api\//, (route) => {
    const u = new URL(route.request().url()), path = u.pathname
    let b = null
    try { b = JSON.parse(route.request().postData() || 'null') } catch {}
    if (path === '/api/auth/nonce') return route.fulfill({ json: { nonce: 'n1' } })
    if (path === '/api/auth/login') return route.fulfill({ json: { token: 't', exp: Date.now() + 3600_000 } })
    if (path === '/api/gridladder/status') return route.fulfill({ json: { bots: u.searchParams.get('address') === A && showRunning ? [RUNNING] : [] } })
    if (['/api/start', '/api/pause', '/api/resume', '/api/gridladder/stop'].includes(path)) { sent.push({ path, b }); return route.fulfill({ json: { ok: true } }) }
    return route.fulfill({ status: 503, contentType: 'application/json', json: { ok: false } })
  })
  const p = await ctx.newPage()
  const errs = []
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ A, B, KEY_A, KEY_B }) => {
    localStorage.clear()
    for (const [k, v] of Object.entries({ hliq_lang: 'en', hliq_lang_chosen: '1', hliq_onboard_done: '1', hliq_onboard_welcomed_v1: '1', hliq_onboard_tour_v1: '1', hliq_install_nudge_v2: '9999999999999', hliq_ann_dismissed: '["*"]' }))
      localStorage.setItem(k, v)
    localStorage.setItem('hliq_agent_key_' + A, KEY_A)
    localStorage.setItem('hliq_agent_key_' + B, KEY_B)
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: A, label: 'Alpha' }, { addr: B, label: 'Bravo' }]))
  }, { A, B, KEY_A, KEY_B })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await until('boot', () => p.evaluate(() => typeof window.__openGridLadder === 'function'))
  await p.evaluate(() => window.__openGridLadder())
  await until('the panel', () => p.evaluate(() => document.querySelectorAll('.gl-card').length === 5))

  console.log('-- five bots, testnet, the defaults --')
  const firstOpen = await p.$$eval('select[data-k="account"]', els => els.map(e => e.value))
  ok('first open gives the keyed accounts to the bots in wallet-list order', firstOpen[0] === A && firstOpen[1] === B && firstOpen[2] === '', firstOpen)
  const ranges = await p.$$eval('.gl-range', els => els.map(e => e.textContent))
  ok('five bots with the default ranges', ranges.join() === '$50–$70,$60–$80,$70–$90,$80–$100,$90–$110', ranges)
  ok('testnet is the network until someone changes it', await p.$eval('.gl-net button.on', e => e.textContent) === 'Testnet')
  await until('the running bot\'s numbers', () => p.evaluate(() => /Running/.test(document.querySelector('[data-bot="1"]')?.textContent ?? '')))
  const c1 = await p.textContent('[data-bot="1"]')
  ok('a running bot shows realized profit, cycles, holding and per-day', /\+\$12\.34/.test(c1) && /17/.test(c1) && /1\.28 @ \$64\.100/.test(c1) && /\+\$1\.76/.test(c1), c1.slice(0, 300))
  ok('the ladder totals are shown', /Net PnL/.test(await p.textContent('.gl-tiles')) && /\+\$9\.23/.test(await p.textContent('.gl-tiles')))
  // GL_SHOT=dir saves what the panel looks like, for a human to check.
  if (process.env.GL_SHOT) await p.screenshot({ path: process.env.GL_SHOT + '/gridladder-' + (mob ? 'phone' : 'desktop') + '.png', fullPage: false })
  ok('a running bot cannot be edited', await p.$eval('[data-bot="1"] input[data-k="low"]', e => e.disabled))

  console.log('-- what may not start --')
  // First open assigns the keyed accounts in order: bot 1 → Alpha, bot 2 → Bravo, the rest none.
  await p.selectOption('[data-bot="3"] select[data-k="account"]', B)
  await until('the clash', () => p.evaluate(() => /Another bot uses this account/.test(document.querySelector('[data-bot="3"]')?.textContent ?? '')))
  ok('two bots on one account are refused', await p.$eval('[data-bot="3"] button[data-act="start"]', e => e.disabled))
  await p.fill('[data-bot="3"] input[data-k="sub"]', SUB)
  await p.$eval('[data-bot="3"] input[data-k="sub"]', e => e.blur())
  await until('the clash to clear', () => p.evaluate(() => !/Another bot uses this account/.test(document.querySelector('[data-bot="3"]')?.textContent ?? '')))
  ok('a subaccount of the same account is its own account', !(await p.$eval('[data-bot="3"] button[data-act="start"]', e => e.disabled)))
  await p.fill('[data-bot="2"] input[data-k="usd"]', '10')
  await p.$eval('[data-bot="2"] input[data-k="usd"]', e => e.blur())
  await until('the minimum', () => p.evaluate(() => /minimum/.test(document.querySelector('[data-bot="2"]')?.textContent ?? '')))
  ok('$10 a level is refused: it rounds below Hyperliquid\'s $10 minimum', await p.$eval('[data-bot="2"] button[data-act="start"]', e => e.disabled), await p.textContent('[data-bot="2"] .gl-errs').catch(() => ''))
  await p.fill('[data-bot="2"] input[data-k="usd"]', '20')
  await p.$eval('[data-bot="2"] input[data-k="usd"]', e => e.blur())

  console.log('-- Start sends the bot\'s own config --')
  await until('bot 3 startable', () => p.evaluate(() => !document.querySelector('[data-bot="3"] button[data-act="start"]')?.disabled))
  await p.click('[data-bot="3"] button[data-act="start"]')
  await until('the start request', () => sent.some(s => s.path === '/api/start'))
  const st = sent.find(s => s.path === '/api/start')?.b ?? {}
  const arg = (k) => { const i = (st.args ?? []).indexOf('--' + k); return i < 0 ? null : st.args[i + 1] }
  ok('as a gridladder bot, slot L3, on the account that holds the key', st.type === 'gridladder' && st.instance === 'L3' && st.address === B && st.agentKey === KEY_B, st)
  ok('with its range, levels, size, leverage and margin', arg('low') === '70' && arg('high') === '90' && arg('levels') === '10' && arg('usd') === '20' && arg('leverage') === '3' && arg('margin') === 'isolated', st.args)
  ok('on testnet, trading the subaccount, without the mainnet flag', arg('network') === 'testnet' && arg('vault') === SUB && !(st.args ?? []).includes('--mainnet-ok'), st.args)

  console.log('-- Stop & close asks, then says so --')
  await until('bot 1 again', () => p.evaluate(() => !!document.querySelector('[data-bot="1"] button[data-act="close"]')))
  await p.click('[data-bot="1"] button[data-act="close"]')
  await until('the confirm sheet', () => p.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Stop & close' && !b.closest('.gl-card'))))
  ok('nothing is sent before it is confirmed', !sent.some(s => s.path === '/api/gridladder/stop'))
  await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Stop & close' && !b.closest('.gl-card'))?.click())
  await until('the stop request', () => sent.some(s => s.path === '/api/gridladder/stop'))
  const sp = sent.find(s => s.path === '/api/gridladder/stop')?.b ?? {}
  ok('then the stop says close, for that bot', sp.mode === 'close' && sp.instance === 'L1' && sp.address === A, sp)

  // The network is locked while any bot runs: reopen with none running.
  showRunning = false
  await p.keyboard.press('Escape')
  await p.evaluate(() => window.__openGridLadder())
  await until('nothing running', () => p.evaluate(() => !document.querySelector('.gl-net button').disabled))
  console.log('-- mainnet is off until confirmed --')
  await p.click('.gl-net button[data-net="mainnet"]')
  await until('the mainnet notice', () => p.evaluate(() => /Mainnet is off/.test(document.querySelector('.gl-body')?.textContent ?? '')))
  ok('no bot can start on mainnet while it is off', await p.$eval('[data-bot="4"]', e => /Mainnet is off/.test(e.textContent)))
  await p.click('.gl-warn button[data-mainnet]')
  await until('the app\'s own prompt', () => p.evaluate(() => [...document.querySelectorAll('input')].some(i => i.placeholder === 'MAINNET')))
  await p.fill('input[placeholder="MAINNET"]', 'mainnet please')
  await p.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Turn on')?.click())
  await new Promise(r => setTimeout(r, 300))
  ok('the wrong words do not turn it on', await p.evaluate(() => /Mainnet is off/.test(document.querySelector('.gl-body')?.textContent ?? '')))
  await p.click('.gl-net button[data-net="testnet"]')

  if (mob) ok('the phone layout does not scroll sideways', await p.evaluate(() => document.querySelector('.gl-sheet').scrollWidth <= window.innerWidth + 1), await p.evaluate(() => [document.querySelector('.gl-sheet').scrollWidth, window.innerWidth]))
  ok('no page errors', errs.length === 0, errs)
  await ctx.close()
}
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
