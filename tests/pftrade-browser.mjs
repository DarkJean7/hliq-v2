// /portfolios → Trade live (src/pftrade.js): from a basket to a running portfolio bot, driven
// for real. The bot server and Hyperliquid are both stubbed; what is checked is what the page
// SENDS — that Start launches strategies/portfolio.js on the account on screen, signed in with
// that account's own agent key, with the basket, the strategy and the budget it showed.
// Decisions the bot makes: tests/suites/pflive.test.mjs.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'
import { Wallet } from 'ethers'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPaperHost, ownerOf } from '../src/paperhost.js'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const DAY = 86_400_000
let pass = 0, fail = 0
const ok = (n, cond, got = '') => { cond ? pass++ : fail++; console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got))) }
const waitFor = async (p, label, fn, arg, ms = 20000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(120)
  }
}

const AGENT = Wallet.createRandom()
const ADDR = '0x00000000000000000000000000000000000000a1'
const ctx0 = (px) => ({ funding: '0.00001', openInterest: '1000', prevDayPx: String(px), dayNtlVlm: '5000000', premium: '0', oraclePx: String(px), markPx: String(px), midPx: String(px), impactPxs: [String(px), String(px)] })
const HL = {
  metaAndAssetCtxs: [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] }, [ctx0(100), ctx0(50)]],
  spotMetaAndAssetCtxs: [{ tokens: [{ index: 0, name: 'USDC' }, { index: 150, name: 'DRV' }], universe: [{ name: '@700', index: 700, tokens: [150, 0] }] }, [{ coin: '@700', markPx: '2', prevDayPx: '2', midPx: '2', dayNtlVlm: '50', circulatingSupply: '1000' }]],
  perpDexs: [null],
  perpConciseAnnotations: [],
}
const share = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const LINK = share({ n: 'Live basket', i: [['BTC', 50, 0], ['ETH', 30, 1], ['@700', 20, 0]], s: { period: '90', capital: 10000, lev: 2, fee: 0.045, strats: ['monthly'], bots: [], bench: false, tf: '4h', costs: false, monthDay: 15 } })

async function run(label, opts) {
  console.log('\n-- ' + label + ' --')
  const browser = await chromium.launch()
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    if (b.type === 'candleSnapshot') {
      const { startTime, endTime } = b.req, out = []
      for (let t = Math.floor(startTime / DAY) * DAY; t <= endTime && out.length < 2000; t += DAY) out.push({ t, T: t + DAY - 1, o: '100', h: '100', l: '100', c: '100', v: '1', n: 1 })
      return route.fulfill({ status: 200, contentType: 'application/json', json: out })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  // The bot server.
  const sent = []
  let running = false, paused = false, paperRun = null
  // The paper server: src/paperhost.js itself behind /paper/sync.
  const host = createPaperHost({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'pftrade-paper-')) })
  await ctx.route('**/paper/sync', (route) => { const r = host.sync(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', json: r }) })
  await ctx.route(/\/api\/(auth|plan|start|stop|pause|resume|status|paper)/, async (route) => {
    const u = new URL(route.request().url()), path = u.pathname
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    sent.push({ path, body: b, auth: route.request().headers().authorization ?? '' })
    const j = (x, status = 200) => route.fulfill({ status, contentType: 'application/json', json: x })
    if (path === '/api/auth/nonce') return j({ nonce: 'n1' })
    if (path === '/api/auth/login') return j({ token: 'tok-' + b.address, exp: Date.now() + 3600e3 })
    const bot = (b.args ?? []).includes('bot:rsi')
    if (path === '/api/plan') return j({ ok: true, rows: [{ coin: 'BTC', w: 0.625, lev: 2, maxLev: 40, isolated: false, px: 100, usd: 250, ...(bot ? { now: { side: 'long', since: Date.UTC(2026, 9, 10, 8) } } : {}) }, { coin: 'ETH', w: -0.375, lev: 2, maxLev: 25, isolated: false, px: 50, usd: 150, ...(bot ? { now: null } : {}) }, { coin: '@700', w: 0.2, lev: 1, maxLev: 1, isolated: false, spot: true, px: 2, usd: 40, ...(bot ? { now: null } : {}) }], skipped: [], tooSmall: [], missing: [], margin: 200, free: 1000, spotNeed: 40, spotFree: 5, resumes: false, held: null })
    if (path === '/api/paper/plan') {
      // Positions at 2×: BTC 62.5% and ETH 37.5% of budget × 2. DCA in 8 buys at a $100 budget
      // makes ETH's buy a $9.38 order: under $10, as the bot would say.
      const a = b.args ?? [], budget = Number(a[a.indexOf('--budget') + 1]), dca = a[a.indexOf('--strategy') + 1] === 'dca'
      const buys = Number(a[a.indexOf('--dcaBuys') + 1]) || 8
      const rows = [{ coin: 'BTC', w: 0.625, lev: 2, maxLev: 40, isolated: false, px: 100, usd: budget * 1.25 }, { coin: 'ETH', w: -0.375, lev: 2, maxLev: 25, isolated: false, px: 50, usd: budget * 0.75 }]
      return j({ ok: true, rows, skipped: ['@700'], tooSmall: rows.filter(r => r.usd / (dca ? buys : 1) < 10).map(r => r.coin), missing: [], margin: budget, free: 1234, resumes: true, held: { BTC: 1 } })
    }
    if (path === '/api/paper/start') { paperRun = { slot: b.slot, instance: b.instance, owner: '0x' + ownerOf(b.secret) }; return j({ ok: true }) }
    if (path === '/api/paper/stop') { paperRun = null; return j({ ok: true }) }
    if (path === '/api/start') { running = true; return j({ ok: true }) }
    if (path === '/api/stop') { running = false; return j({ ok: true }) }
    if (path === '/api/pause') { paused = true; return j({ ok: true }) }
    if (path === '/api/resume') { paused = false; return j({ ok: true }) }
    if (path === '/api/status' && paperRun && u.searchParams.get('address') === paperRun.owner) {
      const k = 'portfolio:' + paperRun.instance
      return j({ _instances: { [k]: true }, _paused: {}, _configs: { [k]: { type: 'portfolio', instance: paperRun.instance, args: ['--strategy', 'bot:rsi', '--paper', paperRun.slot] } },
        _portfolios: { [paperRun.instance]: { name: 'Live basket', strategy: 'bot:rsi', budget: 500, equity: 490, units: {}, fees: 0.4, reason: 'waiting for the next entry' } } })
    }
    if (path === '/api/status' && u.searchParams.get('address') !== ADDR) return j({ _configs: {} })
    if (path === '/api/status') {
      const inst = sent.find(s => s.path === '/api/start')?.body.instance ?? ''
      return j(running ? { portfolio: true, _instances: { ['portfolio:' + inst]: true }, _paused: paused ? { ['portfolio:' + inst]: true } : {},
        _configs: { ['portfolio:' + inst]: { type: 'portfolio', instance: inst, args: [] } },
        _portfolios: { [inst]: { name: 'Live basket', strategy: 'monthly', budget: 200, equity: 210, units: { BTC: 2.5, ETH: -3 }, fees: 0.18, reason: 'next rebalance on day 15' } } } : { _configs: {} })
    }
    return j({})
  })
  const p = await ctx.newPage()
  const errors = []
  p.on('pageerror', e => errors.push(e.message))
  await p.goto(`http://localhost:${port}/portfolios#p=${LINK}`, { waitUntil: 'domcontentloaded' })
  await waitFor(p, 'the basket', () => window.__pf?.state?.items?.length === 3)

  // No agent key on this device: the sheet says where to get one, and offers nothing to start.
  await p.click('#pfTrade')
  ok('without an agent key the sheet offers paper: the practice account and a new one, and says where to set up a key for real money', await p.inputValue('#pfTrAcct') === 'paper:new' && (await p.$$eval('#pfTrAcct option', os => os.map(o => o.value))).join() === 'paper:main,paper:new' && await p.locator('.pf-sheet a[href="/app"]').count() === 1)
  ok('a new paper account asks for its starting balance', await p.isVisible('#pfTrStartBal'))
  await p.keyboard.press('Escape')
  ok('Escape closes it', await p.locator('.pf-sheet').count() === 0)

  // The app saved a key for this account (seeded after load, as the app would have).
  // …and the name it was given there, saved checksummed as the app saves it.
  await p.evaluate(([a, k]) => { localStorage.setItem('hliq_agent_key_' + a, k); localStorage.setItem('savedWallets', JSON.stringify([{ addr: a.toUpperCase().replace('0X', '0x'), label: 'Main' }])) }, [ADDR, AGENT.privateKey])
  await p.click('#pfTrade')
  ok('the account with a key is offered, by the name it was given in the app', await p.inputValue('#pfTrAcct') === ADDR && /^Main · 0x0000/.test((await p.textContent('#pfTrAcct option')).trim()))
  ok('the strategy is the one tested, and says its settings (day 15)', await p.getAttribute('#pfTrStrat .is-on', 'data-s') === 'monthly' && /day 15/.test(await p.textContent('#pfTrStratNote')))
  ok('a long spot holding is traded, not skipped', !/skipped/i.test(await p.textContent('.pf-sheet')))
  ok('Start waits for a preview', await p.isDisabled('#pfTrStart'))
  await p.fill('#pfTrBudget', '200')
  await p.click('#pfTrPreview')
  await waitFor(p, 'the preview', () => !!document.querySelector('.pf-tr-tbl'))
  const plan = sent.find(s => s.path === '/api/plan')
  ok('the preview is the bot\'s own, asked with this account\'s key and token', plan && plan.body.type === 'portfolio' && plan.body.agentKey === AGENT.privateKey && plan.auth === 'Bearer tok-' + ADDR, plan)
  const login = sent.find(s => s.path === '/api/auth/login')
  ok('signed in by the agent key, as the app does', login && Wallet.prototype.constructor && (await import('ethers')).verifyMessage(`Insolvent Trade — bot control login\nAccount: ${ADDR}\nNonce: n1`, login.body.signature).toLowerCase() === AGENT.address.toLowerCase())
  ok('the preview lists each market with its leverage and size', /BTC.*62\.5%.*2×.*\$250/s.test(await p.textContent('.pf-tr-tbl')))
  ok('spot is shown at 1×, as spot', /DRV.*1× spot.*\$40\.00/s.test(await p.textContent('.pf-tr-tbl')))
  ok('short of spot USDC: it says what spot needs, what is there, and that the agent key cannot move it', /SPOT balance: about \$40\.00 needed, \$5\.00 there/.test(await p.textContent('#pfTrPlan')) && /agent key cannot move funds/.test(await p.textContent('#pfTrPlan')))
  if (process.env.PF_SHOT) await p.screenshot({ path: process.env.PF_SHOT + '-' + label + '-sheet.png' })
  ok('and Start still waits for the acknowledgement', await p.isDisabled('#pfTrStart'))
  await p.check('#pfTrAck')
  await p.click('#pfTrStart')
  await waitFor(p, 'started', () => !document.querySelector('.pf-sheet'))
  const start = sent.find(s => s.path === '/api/start')
  const a = start?.body.args ?? []
  const arg = (k) => a[a.indexOf(k) + 1]
  const items = JSON.parse(Buffer.from(arg('--items') ?? '', 'base64').toString() || '[]')
  ok('Start launches the portfolio bot on this account', start && start.body.type === 'portfolio' && start.body.address === ADDR && start.body.agentKey === AGENT.privateKey && /^L-/.test(start.body.instance), start?.body)
  ok('with the basket (the short as a short), the strategy, the budget and the page\'s leverage', items.length === 3 && items[1].side === 'short' && arg('--strategy') === 'monthly' && arg('--budget') === '200' && arg('--leverage') === '2' && arg('--monthDay') === '15' && !a.includes('--fresh'), a)

  // Running.
  await waitFor(p, 'the running card', () => !document.getElementById('pfLiveSec').hidden && /\+5\.00%/.test(document.getElementById('pfLive').textContent))
  if (process.env.PF_SHOT) await p.locator('#pfLiveSec').screenshot({ path: process.env.PF_SHOT + '-' + label + '-live.png' })
  ok('the running card names the account', /Rebalance monthly · Main/.test(await p.textContent('#pfLive')))
  ok('the running portfolio shows what it is worth against its budget', /\$210\.00 of \$200\.00/.test(await p.textContent('#pfLive')) && /day 15/.test(await p.textContent('#pfLive')))
  await p.click('#pfLive [data-live="pause"]')
  await waitFor(p, 'paused', () => /paused/.test(document.getElementById('pfLive').textContent))
  ok('pause goes to the server for that bot', sent.some(s => s.path === '/api/pause' && s.body.instance === start.body.instance && s.auth))
  await p.click('#pfLive [data-live="stop"]')
  ok('stop asks first, and says positions stay open', /positions stay open/i.test(await p.textContent('#pfLive [data-live="stop"]')) && !sent.some(s => s.path === '/api/stop'))
  await p.click('#pfLive [data-live="stop"]')
  await waitFor(p, 'stopped', () => document.getElementById('pfLiveSec').hidden)
  ok('the second press stops it', sent.some(s => s.path === '/api/stop' && s.body.type === 'portfolio'))
  // A trading strategy: RSI on every holding, with its own settings from its card.
  await p.evaluate(() => { window.__pf.state.bots = ['rsi']; window.__pf.state.botParams = { rsi: { rsiLen: 9, slOff: true } } })
  await p.click('#pfTrade')
  ok('a trading strategy picked on the page is the sheet default', await p.getAttribute('#pfTrStrat .is-on', 'data-s') === 'bot:rsi' && /replays the backtest/.test(await p.textContent('#pfTrStratNote')))
  await p.click('#pfTrPreview')
  await waitFor(p, 'the bot preview', () => /waits for the next entry/.test(document.querySelector('.pf-tr-tbl')?.textContent ?? ''))
  ok('the preview says where the strategy stands on each market, and that a trade already open is not joined', /in a long since .*waits for the next entry/.test(await p.textContent('.pf-tr-tbl')) && /waiting for an entry/.test(await p.textContent('.pf-tr-tbl')))
  await p.check('#pfTrAck')
  await p.click('#pfTrStart')
  await waitFor(p, 'started again', () => !document.querySelector('.pf-sheet'))
  const st2 = sent.filter(x => x.path === '/api/start').pop()
  const a2 = st2?.body.args ?? [], g2 = (k) => a2[a2.indexOf(k) + 1]
  ok('Start sends the trading strategy, its candle and its own settings', g2('--strategy') === 'bot:rsi' && g2('--tf') === '4h' && JSON.parse(Buffer.from(g2('--sparams') ?? '', 'base64').toString() || '{}').rsiLen === 9, a2)
  // Paper: no wallet needed. A new paper account funded with the budget, run by the same bot.
  await p.click('#pfTrade')
  await p.selectOption('#pfTrAcct', 'paper:new')
  await p.fill('#pfTrStartBal', '2000')
  ok('Paper says what it is where it is acknowledged: simulated money', /simulated money/.test(await p.textContent('#pfTrAckText')) && await p.isVisible('#pfTrPaperNote'))
  await p.fill('#pfTrBudget', '500')
  await p.click('#pfTrPreview')
  await waitFor(p, 'the paper preview', () => !!document.querySelector('.pf-tr-tbl'))
  const pplan = sent.find(x => x.path === '/api/paper/plan')
  ok('the preview is the paper bot\'s, asked as the paper owner: no agent key, no sign-in', pplan && /^[0-9a-f]{64}$/.test(pplan.body.secret) && !pplan.body.agentKey && !pplan.auth, pplan?.body)
  ok('a paper run never offers to carry on old positions; a new account has its starting balance free', await p.locator('#pfTrCarry').count() === 0 && /Free on this account: \$2,000/.test(await p.textContent('#pfTrPlan')))
  await p.check('#pfTrAck')
  await p.click('#pfTrStart')
  await waitFor(p, 'the paper start', () => !document.querySelector('.pf-sheet'), undefined, 15000)
  const pst = sent.find(x => x.path === '/api/paper/start')
  const accts = await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_paper_accts') || '[]'))
  const mine = accts.find(a => a.slot === pst?.body.slot)
  ok('Start makes a paper account named after the portfolio, tagged as the bot\'s', !!mine && /^PF · Live basket/.test(mine.name) && mine.bot === pst.body.instance, [accts, pst?.body])
  const rec = host.read(ownerOf(pst.body.secret))
  ok('funded with the starting balance chosen, and on the server before the bot is started', JSON.parse(rec.kv['hliq_paper_s_' + pst.body.slot].v).balance === 2000 && rec.kv.hliq_paper_accts.v.includes(pst.body.slot))
  const pa = pst.body.args
  ok('the bot starts fresh on it, with the strategy and budget shown', pa.includes('--fresh') && pa[pa.indexOf('--strategy') + 1] === 'bot:rsi' && pa[pa.indexOf('--budget') + 1] === '500' && !pa.includes('--paper'), pa)
  await waitFor(p, 'the paper card', () => /PAPER/.test(document.getElementById('pfLive')?.textContent ?? ''))
  ok('the running paper portfolio is listed, tagged PAPER, under its paper account', /PAPER/.test(await p.textContent('#pfLive')) && /PF · Live basket/.test(await p.textContent('#pfLive')))
  const stopBtn = '#pfLive [data-live="stop"]:not([data-paper=""])'
  await p.click(stopBtn)
  await p.click(stopBtn)
  await waitFor(p, 'the paper stop', () => !/PAPER/.test(document.getElementById('pfLive')?.textContent ?? ''))
  ok('stopping it goes to /api/paper/stop, and hands the account back (untagged)', sent.some(x => x.path === '/api/paper/stop' && x.body.instance === pst.body.instance) && await p.evaluate((sl) => !JSON.parse(localStorage.getItem('hliq_paper_accts')).find(a => a.slot === sl).bot, pst.body.slot))
  // An existing paper account: the practice one. Tagged while the bot runs it, untagged after.
  await p.click('#pfTrade')
  await p.selectOption('#pfTrAcct', 'paper:main')
  ok('an existing paper account needs no starting balance, and says the bot will hold it', await p.isHidden('#pfTrStartBal') && /stop the bot to trade it by hand/.test(await p.textContent('#pfTrPaperNote')))
  await p.click('#pfTrPreview')
  await waitFor(p, 'the main preview', () => !!document.querySelector('.pf-tr-tbl'))
  ok('its preview shows what that account has free, from the server', /Free on this account: \$1,234/.test(await p.textContent('#pfTrPlan')))
  await p.check('#pfTrAck')
  await p.click('#pfTrStart')
  await waitFor(p, 'the main start', () => !document.querySelector('.pf-sheet'), undefined, 15000)
  const mst = sent.filter(x => x.path === '/api/paper/start').pop()
  ok('the bot is started on the practice account, which is marked as the bot\'s', mst?.body.slot === 'main' && await p.evaluate(() => localStorage.getItem('hliq_paper_pf_mainbot')) === mst.body.instance)
  await waitFor(p, 'its card', () => /PAPER/.test(document.getElementById('pfLive')?.textContent ?? ''))
  await p.click('#pfLive [data-live="stop"]:not([data-paper=""])')
  await p.click('#pfLive [data-live="stop"]:not([data-paper=""])')
  await waitFor(p, 'its stop', () => !/PAPER/.test(document.getElementById('pfLive')?.textContent ?? ''))
  ok('stopped, it is the practice account again', await p.evaluate(() => localStorage.getItem('hliq_paper_pf_mainbot')) === null)

  // Too small: DCA in 8 buys of a $100 budget. The message says what the order is, and fixes it.
  await p.click('#pfTrade')
  await p.selectOption('#pfTrAcct', 'paper:new')
  await p.click('#pfTrStrat [data-s="dca"]')
  await p.fill('#pfTrBudget', '100')
  await p.click('#pfTrPreview')
  await waitFor(p, 'the too-small preview', () => !!document.querySelector('[data-fix]'))
  const warn = await p.textContent('#pfTrPlan')
  ok('too small: it says the order each buy would be, and its margin, and that the minimum is on value', /In 8 buys, each buy of the smallest holding is an order of about \$9\.38 \(about \$4\.69 of margin at 2×\)/.test(warn) && /size × price, whatever the margin/.test(warn), warn)
  ok('Start stays off', await p.isDisabled('#pfTrStart'))
  ok('and it offers the two fixes: the budget that works, and the most buys that work', (await p.$$eval('[data-fix]', bs => bs.map(b => b.dataset.fix))).join() === 'budget:110,buys:7')
  await p.click('[data-fix="budget:110"]')
  await waitFor(p, 'the fixed preview', () => !!document.querySelector('.pf-tr-tbl') && !document.querySelector('[data-fix]'))
  ok('one click sets the budget and previews again: nothing too small now', await p.inputValue('#pfTrBudget') === '110' && !/minimum/.test(await p.textContent('#pfTrPlan')))
  await p.keyboard.press('Escape')
  ok('no page errors', !errors.length, errors)
  await browser.close()
}

await run('desktop', { viewport: { width: 1280, height: 900 } })
await run('mobile', { viewport: { width: 430, height: 930 }, isMobile: true, hasTouch: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
