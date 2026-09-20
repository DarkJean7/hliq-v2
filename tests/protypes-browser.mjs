// The Pro order types, in a real page.
//
// Hyperliquid's Pro list puts eight more ways to execute behind one control: Chase, Scale,
// the four Stop/Take variants, Trailing Stop and TWAP. The arithmetic is covered without a
// browser in tests/suites/protypes.test.mjs. What needs a browser is the part no single
// function's source shows: that the thing on SCREEN and the thing on the WIRE are the same
// order. A Scale that previews five rungs and signs four, a Stop Market that draws its
// trigger above the mark and sends tpsl 'tp', a TWAP whose duration box does not reach the
// payload — every one of those builds, passes the unit tests, and loses money.
//
// Hermetic: its own server and the exchange are both stubbed, so it takes seconds and cannot
// fail because Hyperliquid is having a bad morning.
//
// One gap, stated rather than hidden: the desktop ticket's Submit refuses to sign until the
// main wallet has approved the builder fee, which needs a real wallet. So submission is
// driven through window.__proSubmit — the single function BOTH tickets' buttons call. That
// both of them call it, and that the gates sit above the branch, is asserted against the
// source in tests/suites/protypes.test.mjs.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey
const AGENT = new Wallet(KEY).address
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// One HYPE market, mark 90.839, szDecimals 2 — so the price tick is a cent and every number
// below can be checked by hand.
const UNIVERSE = [{ name: 'HYPE', szDecimals: 2, maxLeverage: 40 }]
const CTX = { funding: '0', openInterest: '0', prevDayPx: '90', dayNtlVlm: '0', premium: '0',
              oraclePx: '90.839', markPx: '90.839', midPx: '90.839', impactPxs: ['90.8', '90.9'] }
const MARGIN = { accountValue: '5000', totalNtlPos: '0', totalRawUsd: '5000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '5000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: { HYPE: '90.839' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [],
  extraAgents: [{ address: AGENT, name: 'agent', validUntil: Date.now() + 8.64e7 }],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [CTX]],
  // Best bid 90.83 / best ask 90.85 — a two-tick spread, so a chase has exactly one tick of
  // room to improve on either side and the expected price is unambiguous.
  l2Book: { coin: 'HYPE', levels: [[{ px: '90.83', sz: '10', n: 1 }], [{ px: '90.85', sz: '10', n: 1 }]], time: Date.now() },
}

// ctx.route does NOT cover WebSockets, and the app opens one to Hyperliquid for live state.
// Without this the page gets real prices straight past every fixture.
const blockHlSockets = async (c) => { try { await c.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {} }

const signed = []          // every /exchange action this test caused
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1440, height: 950 } })
await blockHlSockets(ctx)
await ctx.route(HL_HOST, (route) => {
  const url = route.request().url()
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  if (url.endsWith('/exchange')) {
    const a = b.action ?? {}
    signed.push(a)
    if (a.type === 'order') {
      return route.fulfill({ status: 200, json: { status: 'ok', response: { type: 'order', data: {
        statuses: (a.orders ?? []).map((_, i) => ({ resting: { oid: 1000 + i } })) } } } })
    }
    if (a.type === 'twapOrder') {
      return route.fulfill({ status: 200, json: { status: 'ok', response: { type: 'twapOrder', data: { status: { running: { twapId: 77 } } } } } })
    }
    if (a.type === 'cancel') {
      return route.fulfill({ status: 200, json: { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } } })
    }
    return route.fulfill({ status: 200, json: { status: 'ok', response: { type: 'default' } } })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  // The language picker and the announcement both sit on top of the ticket, and a modal that
  // intercepts pointer events makes every click below it time out with no useful message.
  localStorage.setItem('hliq_lang_chosen', '1')
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('agentKey', k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
}, { a: ADDR, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => window.switchTab('trade'))
await waitFor(p, 'the ticket', () => !!document.getElementById('otype-pro'))
await p.evaluate(() => window.__selectCoin('HYPE'))
await waitFor(p, 'an agent client', () => window.__canTradeUI?.() === true)
await p.waitForTimeout(400)

// Size is entered in COINS so every assertion below is about the number that was typed, not
// about a division by a price that might have drifted.
const setSize = async (n) => {
  await p.evaluate((v) => {
    window.setSizeMode('coin')
    const el = document.getElementById('sizeInput')
    el.value = String(v)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, n)
}
const setField = async (key, v) => {
  await p.evaluate(({ k, x }) => {
    const el = document.querySelector('#proFieldsDesk [data-pf="' + k + '"]')
    el.value = String(x)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, { k: key, x: v })
  await p.waitForTimeout(80)
}
const preview = () => p.evaluate(() => document.querySelector('#proFieldsDesk [data-pf-preview]')?.textContent?.trim() ?? null)
const submit  = async () => {
  await p.evaluate(() => window.__proSubmit(document.getElementById('tradeStatus')))
  await p.waitForTimeout(250)
}
const lastOrder = () => signed.filter(a => a.type === 'order').at(-1)

console.log(NL + '-- the Pro control --')
{
  await p.click('#otype-pro')
  await p.waitForTimeout(150)
  const items = await p.evaluate(() => [...document.querySelectorAll('#proMenu [data-pt]')].map(e => e.dataset.pt))
  t('the menu lists every advanced type, then Learn More', items,
    ['chase', 'scale', 'stopLimit', 'stopMarket', 'takeLimit', 'takeMarket', 'trailingStop', 'twap', '__learn'])

  await p.click('#proMenu [data-pt="scale"]')
  await p.waitForTimeout(200)
  const tabs = await p.evaluate(() => ({
    pro:   document.getElementById('otype-pro').textContent.trim(),
    proOn: document.getElementById('otype-pro').classList.contains('active'),
    mktOn: document.getElementById('otype-market').classList.contains('active'),
    fields: document.getElementById('proFieldsDesk').style.display,
    btn:   document.getElementById('tradeSubmitBtn').textContent.trim(),
  }))
  t('the button names the chosen type', tabs.pro, 'Scale ▾')
  t('and is the active tab', [tabs.proOn, tabs.mktOn], [true, false])
  ok('the fields appear', tabs.fields !== 'none', tabs.fields)
  t('the submit button says what it will do', tabs.btn, 'Buy · Scale')

  // Picking a plain tab has to leave Pro mode, or the highlighted tab and the button
  // disagree about what pressing it does.
  await p.click('#otype-market')
  await p.waitForTimeout(150)
  const back = await p.evaluate(() => ({
    pro: document.getElementById('otype-pro').textContent.trim(),
    mkt: document.getElementById('otype-market').classList.contains('active'),
    fields: document.getElementById('proFieldsDesk').style.display,
  }))
  t('Market takes it back', [back.pro, back.mkt, back.fields], ['Pro ▾', true, 'none'])
}

console.log(NL + '-- About Order Types --')
{
  await p.click('#otype-pro'); await p.waitForTimeout(120)
  await p.click('#proMenu [data-pt="__learn"]'); await p.waitForTimeout(250)
  const nav = await p.evaluate(() => [...document.querySelectorAll('#proLearnNav [data-lt]')].map(e => e.dataset.lt))
  t('every type is explained, Market and Limit included', nav,
    ['market', 'limit', 'chase', 'scale', 'stopLimit', 'stopMarket', 'takeLimit', 'takeMarket', 'trailingStop', 'twap'])

  await p.click('#proLearnNav [data-lt="stopMarket"]'); await p.waitForTimeout(150)
  const body = await p.evaluate(() => document.getElementById('proLearnBody').textContent)
  ok('it quotes Hyperliquid on the type', /activated when the price reaches/.test(body), body.slice(0, 120))
  ok('and says what this terminal does', /HOW THIS TERMINAL DOES IT/.test(body))
  ok('and draws it', await p.evaluate(() => !!document.querySelector('#proLearnBody svg')))

  // The drawing has to change with the side. A stop for a long sits above the mark and a
  // stop for a short below it, and that is the single thing people get backwards.
  const long = await p.evaluate(() => document.querySelector('#proLearnBody svg').outerHTML)
  await p.click('#proLearnBody [data-ls="short"]'); await p.waitForTimeout(150)
  const short = await p.evaluate(() => document.querySelector('#proLearnBody svg').outerHTML)
  ok('the drawing flips with the side', long !== short)
  ok('a long is marked B and a short S', /">B<\/text>/.test(long) && /">S<\/text>/.test(short))

  // The CTA is not a dead end — it closes onto the type it was explaining.
  await p.click('#proLearnUse'); await p.waitForTimeout(200)
  t('Place a … Order selects that type', await p.evaluate(() => document.getElementById('otype-pro').textContent.trim()), 'Stop Market ▾')
  t('and closes the modal', await p.evaluate(() => document.getElementById('proLearnOverlay').style.display), 'none')
}

console.log(NL + '-- a stop that could never fire is refused --')
{
  const before = signed.length
  await setSize(2)
  // Buying HYPE at 90.839, a STOP is a breakout: it belongs ABOVE the mark. Below it, HL
  // would trigger it the instant it landed.
  await setField('triggerPx', 85)
  const msg = await preview()
  ok('the ticket says which way it has to point', /above the mark/.test(msg ?? ''), msg)
  await submit()
  t('and nothing was signed', signed.length - before, 0)

  await setField('triggerPx', 95)
  ok('the right side reads back as an instruction', /When the mark reaches \$95/.test(await preview() ?? ''), await preview())
  await submit()
  const o = lastOrder()
  t('one trigger order went out', [o.type, o.orders.length], ['order', 1])
  t('as a stop, at market, on the trigger typed', [o.orders[0].t.trigger.tpsl, o.orders[0].t.trigger.isMarket, o.orders[0].t.trigger.triggerPx], ['sl', true, '95'])
  t('for the size on the ticket, buying', [o.orders[0].s, o.orders[0].b], ['2', true])
  // A trigger MARKET order still carries a limit price, and it has to be THROUGH the trigger
  // or the "market" order rests instead of filling.
  ok('with slippage headroom past the trigger', parseFloat(o.orders[0].p) > 95, o.orders[0].p)
}

console.log(NL + '-- a take points the other way --')
{
  await p.evaluate(() => window.__proMenu(document.getElementById('otype-pro')))
  await p.waitForTimeout(120)
  await p.click('#proMenu [data-pt="takeMarket"]')
  await p.waitForTimeout(200)
  // The trigger price typed for the stop is carried over — it is a field this type has too.
  t('the trigger carried over', await p.evaluate(() => document.querySelector('#proFieldsDesk [data-pf="triggerPx"]').value), '95')
  // A successful submit clears the size box, exactly as the plain ticket does.
  t('the size box was cleared by the fill', await p.evaluate(() => document.getElementById('sizeInput').value), '')
  await setSize(2)
  ok('but the trigger is now on the wrong side', /below the mark/.test(await preview() ?? ''), await preview())
  await setField('triggerPx', 85)
  await submit()
  const o = lastOrder()
  t('a take buy goes out as tp', o.orders[0].t.trigger.tpsl, 'tp')
}

console.log(NL + '-- a scale is one batch, and it adds up --')
{
  await p.evaluate(() => window.__proMenu(document.getElementById('otype-pro')))
  await p.waitForTimeout(120)
  await p.click('#proMenu [data-pt="scale"]')
  await p.waitForTimeout(200)
  await setSize(4)
  await setField('scaleStartPx', 90)
  await setField('scaleEndPx', 86)
  await setField('scaleCount', 5)
  await setField('scaleSkew', 1)

  // Every row but the last — the last is the "average if all fill" footer.
  const rungs = await p.evaluate(() => [...document.querySelectorAll('#proFieldsDesk [data-pf-ladder] > div > div')].slice(0, -1).map(d => d.textContent.trim()))
  t('the ladder is previewed rung by rung', rungs.length, 5)
  ok('from the first price to the last', /\$90/.test(rungs[0]) && /\$86/.test(rungs[4]), rungs)

  const before = signed.filter(a => a.type === 'order').length
  await submit()
  t('it is ONE signed action, not five', signed.filter(a => a.type === 'order').length - before, 1)
  const o = lastOrder()
  t('carrying all five orders', o.orders.length, 5)
  t('at the prices on screen', o.orders.map(x => x.p), ['90', '89', '88', '87', '86'])
  // The size on the ticket is the size that gets placed. A ladder that quietly placed more
  // than was typed because a skew moved is the failure worth a browser test.
  t('summing to the size that was typed', o.orders.reduce((s, x) => s + parseFloat(x.s), 0), 4)
  t('all resting, all buys', [o.orders.every(x => x.t.limit.tif === 'Gtc'), o.orders.every(x => x.b)], [true, true])

  const status = await p.evaluate(() => document.getElementById('tradeStatus').textContent.trim())
  ok('and it says what it did', /5 orders resting/.test(status), status)
}

console.log(NL + '-- a TWAP is the exchange\'s own action --')
{
  await p.evaluate(() => window.__proMenu(document.getElementById('otype-pro')))
  await p.waitForTimeout(120)
  await p.click('#proMenu [data-pt="twap"]')
  await p.waitForTimeout(200)

  await setSize(0.5)     // ~$45 — under HL's $100 floor
  ok('an undersized TWAP is refused', /at least \$100/.test(await preview() ?? ''), await preview())
  await setSize(4)
  await setField('twapMinutes', 3)
  ok('and one that is too short', /at least 5 minutes/.test(await preview() ?? ''), await preview())

  await setField('twapMinutes', 45)
  ok('a workable one reads back as a schedule', /90 suborders/.test(await preview() ?? ''), await preview())
  const before = signed.length
  await submit()
  const a = signed.slice(before).find(x => x.type === 'twapOrder')
  ok('a twapOrder action was signed', !!a, signed.slice(before).map(x => x.type))
  t('with the duration from the box, nested under twap', [a?.twap?.m, a?.twap?.s, a?.twap?.b], [45, '4', true])
}

console.log(NL + '-- a chase posts inside the spread and never crosses --')
{
  await p.evaluate(() => window.__proMenu(document.getElementById('otype-pro')))
  await p.waitForTimeout(120)
  await p.click('#proMenu [data-pt="chase"]')
  await p.waitForTimeout(200)
  await setSize(1)
  await submit()
  const o = lastOrder()
  // HYPE has szDecimals 2, so around $90 the tick is a TENTH of a cent: five significant
  // figures (90.831) bites before the six-minus-szDecimals decimal cap. One tick inside the
  // best bid of 90.83 is therefore 90.831 — still well below the 90.85 ask, which is what
  // matters, because a post-only order at or through the ask is rejected outright rather
  // than repriced, and a chase that keeps being rejected never rests and never fills.
  t('post-only, one tick inside the bid', [o.orders[0].t.limit.tif, o.orders[0].p], ['Alo', '90.831'])
  ok('and strictly inside the spread', parseFloat(o.orders[0].p) > 90.83 && parseFloat(o.orders[0].p) < 90.85, o.orders[0].p)
  ok('and it says it is running in this tab', await p.evaluate(() =>
    /CHASING/.test(document.getElementById('proFieldsDesk').textContent)))

  await p.evaluate(() => document.querySelector('#proFieldsDesk [data-pf-stopchase]').click())
  await p.waitForTimeout(400)
  ok('stopping it cancels the resting order', signed.some(a => a.type === 'cancel'), signed.map(a => a.type))
  ok('and clears the strip', await p.evaluate(() =>
    !/CHASING/.test(document.getElementById('proFieldsDesk').textContent)))
}

console.log(NL + '-- a trailing stop needs a position --')
{
  await p.evaluate(() => window.__proMenu(document.getElementById('otype-pro')))
  await p.waitForTimeout(120)
  await p.click('#proMenu [data-pt="trailingStop"]')
  await p.waitForTimeout(200)
  const msg = await preview()
  ok('the ticket says so rather than failing on submit', /open one first/.test(msg ?? ''), msg)
  const before = signed.length
  await submit()
  t('and signs nothing', signed.length - before, 0)
}

console.log(NL + '-- the mobile ticket has the same control --')
{
  const mctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  await blockHlSockets(mctx)
  await mctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    if (route.request().url().endsWith('/exchange')) return route.fulfill({ status: 200, json: { status: 'ok', response: { type: 'default' } } })
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await mctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  const mp = await mctx.newPage()
  await mp.goto(BASE, { waitUntil: 'domcontentloaded' })
  await mp.evaluate(({ a, k }) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  // The language picker and the announcement both sit on top of the ticket, and a modal that
  // intercepts pointer events makes every click below it time out with no useful message.
  localStorage.setItem('hliq_lang_chosen', '1')
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
    localStorage.setItem('agentKey', k)
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  }, { a: ADDR, k: KEY })
  await mp.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(mp, 'boot', () => !!window.loadDashboard)
  await mp.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(mp, 'the mobile shell', () => !!window._mobOpenOrderSheet, 30000)
  await mp.evaluate(() => { window.__selectCoin?.('HYPE'); window._mobOpenOrderSheet('long') })
  await waitFor(mp, 'the mobile trade form', () => !!document.getElementById('mobTradeOrderTypePro'), 30000)

  ok('the Pro button is there', await mp.evaluate(() => !!document.getElementById('mobTradeOrderTypePro')))
  await mp.evaluate(() => window.__proMenu(document.getElementById('mobTradeOrderTypePro')))
  await mp.waitForTimeout(150)
  ok('and opens the same menu', await mp.evaluate(() => document.querySelectorAll('#proMenu [data-pt]').length === 9))
  await mp.click('#proMenu [data-pt="scale"]')
  await mp.waitForTimeout(250)
  // The same renderer paints both shells. If this container is empty while the desktop one
  // fills, the mobile ticket has been painted into a node the last render threw away.
  ok('the fields render into the MOBILE container', await mp.evaluate(() =>
    /Size skew/.test(document.getElementById('proFieldsMob')?.textContent ?? '')),
    await mp.evaluate(() => (document.getElementById('proFieldsMob')?.textContent ?? '').slice(0, 60)))
  t('and the button names the type', await mp.evaluate(() => document.getElementById('mobTradeOrderTypePro').textContent.trim()), 'Scale ▾')
  await mctx.close()
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
