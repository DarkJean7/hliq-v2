// The position card's Trade and Flip buttons, driven for real.
//
// Asked for: a button to trade the card's asset, and one to reverse it — "if i have 1 long btc,
// open a 2 btc short so it closes the position and opens 1 short btc". Flip must send exactly
// ONE order: the other side, twice the size, not reduce-only, at the position's own leverage
// and margin mode, signed for the wallet that holds it. Rules: tests/suites/posflip.test.mjs.
//
// Hermetic: the exchange is stubbed by host and its sockets closed; orders are signed by a
// throwaway key and captured, never sent.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const APP  = `http://localhost:${port}/app`
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const W = Wallet.createRandom()
const KEY = W.privateKey, AGENT = W.address.toLowerCase()
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x))) }
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// 1 BTC long, 10x cross. BTC is asset 0.
const POS = { coin: 'BTC', szi: '1.0', entryPx: '90000', positionValue: '100000', unrealizedPnl: '10000', returnOnEquity: '1',
  liquidationPx: '50000', marginUsed: '10000', maxLeverage: 50, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } }
const MARGIN = { accountValue: '20000', totalNtlPos: '100000', totalRawUsd: '-80000', totalMarginUsed: '10000' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '2000', withdrawable: '10000',
  assetPositions: [{ type: 'oneWay', position: POS }], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 3600e3, '20000'], [Date.now(), '20000']], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }]
const ctx1 = (px) => ({ funding: '0', openInterest: '1', prevDayPx: px, dayNtlVlm: '1', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] })
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, total: '20000', hold: '0', entryNtl: '0' }] },
  allMids: { BTC: '100000', ETH: '3000' }, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], allPerpMetas: [{ universe: UNIVERSE }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  extraAgents: [{ address: AGENT, name: 'agent', validUntil: Date.now() + 8.64e7 }],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]), webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [ctx1('100000'), ctx1('3000')]],
  activeAssetData: { leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['10', '10'], availableToTrade: ['100000', '100000'], markPx: '100000' },
}

const browser = await chromium.launch()
const errs = []

async function run(label, opts) {
  console.log('\n-- ' + label + ' --')
  const orders = [], levs = []
  const ctx = await browser.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/offexprice**', r => r.fulfill({ status: 200, json: { prices: {} } }))
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    const a = b.action
    if (a?.type === 'order') {
      orders.push(a.orders)
      return route.fulfill({ status: 200, contentType: 'application/json',
        json: { status: 'ok', response: { type: 'order', data: { statuses: a.orders.map(o => ({ filled: { totalSz: o.s, avgPx: '100000', oid: 7 } })) } } } })
    }
    if (a?.type === 'updateLeverage') { levs.push(a); return route.fulfill({ status: 200, contentType: 'application/json', json: { status: 'ok', response: { type: 'default' } } }) }
    if (a) return route.fulfill({ status: 200, contentType: 'application/json', json: { status: 'ok', response: { type: 'default' } } })
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(label + ': ' + e.message))
  await p.goto(APP, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ a, k }) => {
    localStorage.clear()
    for (const x of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(x, '1')
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, { a: ADDR, k: KEY })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))

  if (opts.isMobile) {
    await waitFor(p, 'the mobile shell', () => !!window.mobVTab)
    await p.evaluate(() => window.mobVTab('positions'))
    await waitFor(p, 'the BTC card', () => !!document.querySelector('[data-lp-coin="BTC"]'))
    await p.click('[data-lp-coin="BTC"]')
  } else {
    await waitFor(p, 'the BTC row', () => [...document.querySelectorAll('.ov-pos-actions')].length > 0)
    await p.evaluate(() => { const a = document.querySelector('.ov-pos-actions'); if (a) a.style.display = 'flex' })
  }
  const flip = 'button[data-pos-flip]:visible', trade = 'button[data-pos-trade]:visible'
  t('the card has a Trade button', await waitFor(p, 'Trade', (s) => !!document.querySelector('button[data-pos-trade]') && [...document.querySelectorAll('button[data-pos-trade]')].some(b => b.offsetParent), null, 8000))
  t('and a Flip button', await p.locator(flip).count() > 0)

  // Flip, then back out of the confirm: nothing is sent.
  await p.locator(flip).first().click()
  await waitFor(p, 'the confirm', () => !!document.getElementById('_acY'))
  const body = await p.evaluate(() => document.getElementById('_acY')?.closest('div[role],div')?.parentElement?.innerText ?? document.body.innerText)
  t('the confirm says what will happen', /Sells 2 BTC/.test(body) && /closes your 1 BTC long/.test(body) && /opens 1 BTC short/.test(body) && /10x cross/.test(body), body.slice(0, 300))
  await p.evaluate(() => document.getElementById('_acN')?.click())
  await p.waitForTimeout(500)
  t('cancelled: no order', orders.length === 0, orders)

  await p.locator(flip).first().click()
  await waitFor(p, 'the confirm', () => !!document.getElementById('_acY'))
  await p.evaluate(() => document.getElementById('_acY').click())
  await waitFor(p, 'the order', () => true, null, 100)
  const t0 = Date.now(); while (!orders.length && Date.now() - t0 < 15000) await p.waitForTimeout(150)
  const o = orders[0]?.[0]
  t('exactly one order, of one leg', orders.length === 1 && orders[0].length === 1, orders)
  t('a SELL of 2 BTC on BTC', o && o.a === 0 && o.b === false && parseFloat(o.s) === 2, o)
  t('not reduce-only, so the second BTC opens the short', o && o.r === false, o)
  t('a market order (IOC), priced through the mark', o && o.t?.limit?.tif === 'Ioc' && parseFloat(o.p) < 100000, o)
  t('at the position\'s own 10x cross', levs.length > 0 && levs.every(l => l.leverage === 10 && l.isCross === true), levs)
  t('it says it flipped', await waitFor(p, 'toast', () => /Flipped: now 1 BTC short/.test(document.body.innerText), null, 6000))

  // Trade opens the market -- from another one, so the switch is visible.
  await p.evaluate(() => window.__selectCoin('ETH'))
  const coinIs = (c) => (document.getElementById('mktCoinName')?.textContent ?? '').trim().startsWith(c)
  t('(another market selected first)', await waitFor(p, 'ETH', coinIs, 'ETH', 5000))
  await p.locator(trade).first().click()
  if (opts.isMobile) t('Trade opens BTC in the trade view', await waitFor(p, 'trade detail', () => (document.getElementById('mktCoinName')?.textContent ?? '').trim().startsWith('BTC') && !!document.getElementById('mobChartCanvas'), null, 10000))
  else t('Trade opens BTC in the trade view', await waitFor(p, 'trade tab', () => document.getElementById('tab-trade')?.classList.contains('active') && (document.getElementById('mktCoinName')?.textContent ?? '').trim().startsWith('BTC'), null, 10000))
  await ctx.close()
}

await run('phone', { ...devices['iPhone 14 Pro'] })
await run('desktop', { viewport: { width: 1440, height: 900 } })

t('no page errors', !errs.length, errs)
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
