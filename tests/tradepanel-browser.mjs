// The desktop Trade tab's order panel and its "Trade from account" pills. Hermetic.
//
// Asked: "to reach the end of the right panel for some reason i need to reach the end of left
// first which is annoying because sometimes i have a lot of positions. make the right
// independent. also i cannot scroll the accounts from 'trade from account:'."
//
// The order column was sticky but had no height limit: taller than the window, its bottom came
// into view only when the page ran out — after every position on the left. And the pills are a
// native horizontal scroller with its scrollbar hidden, so a mouse had no way to move them.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const APP = `http://localhost:${port}/app`
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const waitFor = async (p, fn, arg, ms = 30000) => { try { await p.waitForFunction(fn, arg, { timeout: ms }); return true } catch { return false } }

// Six accounts, so the pills overflow the 340px column. Each holds a few markets, so the left
// column (positions, orders) runs far below the window.
const ACCTS = Array.from({ length: 6 }, (_, i) => ({ addr: Wallet.createRandom().address, label: ['Brrr', 'Insolvent', 'Near', 'Dark', 'Swing', 'Hedge'][i] }))
const KEYS = ACCTS.map(() => Wallet.createRandom().privateKey)
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'AVAX', 'LINK', 'ARB', 'OP', 'SUI', 'APT', 'SEI']
const PX = Object.fromEntries(COINS.map((c, i) => [c, 10 + i * 7]))
const pos = (coin, szi) => ({ type: 'oneWay', position: { coin, szi: String(szi), entryPx: String(PX[coin]), positionValue: String(Math.abs(szi) * PX[coin]), unrealizedPnl: '1',
  returnOnEquity: '0.01', liquidationPx: String(PX[coin] / 3), marginUsed: '10', maxLeverage: 20, leverage: { type: 'cross', value: 5 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })
const clearing = () => ({ marginSummary: { accountValue: '5000', totalNtlPos: '1000', totalRawUsd: '5000', totalMarginUsed: '120' },
  crossMarginSummary: { accountValue: '5000', totalNtlPos: '1000', totalRawUsd: '5000', totalMarginUsed: '120' },
  crossMaintenanceMarginUsed: '10', withdrawable: '4000', assetPositions: COINS.map((c, i) => pos(c, i % 2 ? -2 : 3)), time: Date.now() })
const meta = { universe: COINS.map(name => ({ name, szDecimals: 2, maxLeverage: 20 })) }
const ctxs = COINS.map(c => ({ markPx: String(PX[c]), midPx: String(PX[c]), funding: '0.00001', openInterest: '1', dayNtlVlm: '1', prevDayPx: String(PX[c]) }))

const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1440, height: 760 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let q = {}
  try { q = JSON.parse(route.request().postData() || '{}') } catch {}
  const json = q.type === 'clearinghouseState' ? clearing()
    : q.type === 'allMids' ? Object.fromEntries(COINS.map(c => [c, String(PX[c])]))
    : q.type === 'meta' ? meta
    : q.type === 'metaAndAssetCtxs' ? [meta, ctxs]
    : q.type === 'spotClearinghouseState' ? { balances: [] }
    : q.type === 'spotMeta' ? { tokens: [], universe: [] }
    : q.type === 'spotMetaAndAssetCtxs' ? [{ tokens: [], universe: [] }, []]
    : q.type === 'perpDexs' ? [null]
    : q.type === 'candleSnapshot' ? [] : []
  return route.fulfill({ json })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ accts, keys }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  accts.forEach((a, i) => localStorage.setItem('hliq_agent_key_' + a.addr.toLowerCase(), keys[i]))
  localStorage.setItem('savedWallets', JSON.stringify(accts))
  localStorage.setItem('hliq_multi_accounts', JSON.stringify(accts))
}, { accts: ACCTS, keys: KEYS })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, () => !!window.loadDashboard, null, 60000)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ACCTS[0].addr)
await waitFor(p, () => document.getElementById('dashboard')?.classList.contains('active'))

console.log('-- the order panel scrolls on its own --')
await p.evaluate(() => window.__goAllAccounts?.())
await waitFor(p, () => /All Accounts|combined/i.test(document.body.textContent ?? ''), null, 40000)
await p.evaluate(() => window.switchTab('trade'))
await waitFor(p, () => document.querySelectorAll('#tradeAcctPills [data-acct]').length === 6, null, 40000)
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
// The combined view's "Combining all accounts" loader covers the page until every wallet has answered.
await waitFor(p, () => { const o = document.getElementById('allAcctLoader'); return !o || getComputedStyle(o).display === 'none' }, null, 40000)
const col = await p.$eval('.trade-order-col', e => { const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return { oy: cs.overflowY, pos: cs.position, h: r.height, sh: e.scrollHeight, ch: e.clientHeight, vh: innerHeight } })
t('the order panel is no taller than the window', col.h <= col.vh, col)
t('and scrolls on its own', /auto|scroll/.test(col.oy) && col.pos === 'sticky', col)
// The app scrolls an inner element (<main>), not the document: find whatever scrolls the panel's column.
const SC = `(() => { const c = document.querySelector('.trade-order-col'); for (let n = c.parentElement; n; n = n.parentElement) if (/(auto|scroll)/.test(getComputedStyle(n).overflowY)) return n; return document.scrollingElement })()`
const page = await p.evaluate((SC) => { const sc = eval(SC); return sc.scrollHeight - sc.clientHeight }, SC)
t('(the left column really is long: the page scrolls)', page > 300, page)
// Scroll the panel, not the page: its bottom — the submit button — comes into view with the page still at the top.
// Scroll the page just enough for the panel to stick (the market header above it goes out of view),
// as a person does on the way down. From there the panel scrolls by itself.
await p.evaluate((SC) => { eval(SC).scrollTop = 400 }, SC)
await p.waitForTimeout(150)
const pageMax = await p.evaluate((SC) => { const sc = eval(SC); return sc.scrollHeight - sc.clientHeight }, SC)
const box = await p.$eval('.trade-order-col', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + Math.min(r.height, innerHeight - r.top) / 2 } })
await p.mouse.move(box.x, box.y)
for (let i = 0; i < 12; i++) await p.mouse.wheel(0, 300)
await p.waitForTimeout(300)
const after = await p.evaluate((SC) => {
  const c = document.querySelector('.trade-order-col'), btn = document.getElementById('tradeSubmitBtn')
  const r = btn.getBoundingClientRect()
  return { colTop: c.scrollTop, colMax: c.scrollHeight - c.clientHeight, pageY: eval(SC).scrollTop, btnBottom: Math.round(r.bottom), vh: innerHeight }
}, SC)
t('a wheel over the panel scrolls the panel to its end…', after.colMax <= 0 || after.colTop >= after.colMax - 2, after)
t('…and its last button is on screen, with the page nowhere near its end', after.btnBottom <= after.vh && after.pageY < pageMax - 300, { ...after, pageMax })

console.log('-- the account pills move with a mouse --')
// The picker is redrawn when the combined load lands; wait for the six to be back.
t('(the picker shows the six accounts)', await waitFor(p, () => document.querySelectorAll('#tradeAcctPills [data-acct]').length === 6, null, 30000), await p.evaluate(() => document.getElementById('tradeAcctPicker')?.innerHTML.slice(0, 200)))
const pills = await p.$eval('#tradeAcctPills', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, over: e.scrollWidth - e.clientWidth } })
t('(six accounts do not fit the panel)', pills.over > 20, pills)
await p.evaluate(() => document.querySelector('#tradeAcctPills')?.scrollIntoView({ block: 'center' }))
const pb = await p.$eval('#tradeAcctPills', e => { const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })
await p.mouse.move(pb.x, pb.y)
await p.mouse.wheel(0, 400)
await p.waitForTimeout(200)
const wl = await p.$eval('#tradeAcctPills', e => e.scrollLeft)
t('a mouse wheel scrolls them sideways', wl > 0, wl)
await p.$eval('#tradeAcctPills', e => { e.scrollLeft = 0 })
await p.mouse.move(pb.x + 100, pb.y)
await p.mouse.down()
await p.mouse.move(pb.x - 60, pb.y, { steps: 8 })
await p.mouse.up()
const dl = await p.$eval('#tradeAcctPills', e => e.scrollLeft)
t('and so does dragging them', dl > 0, dl)
// A drag is not a click: no account was picked by it. A plain click still picks one.
const picked = await p.evaluate(() => [...document.querySelectorAll('#tradeAcctPills [data-acct]')].find(b => /accent/.test(b.style.color))?.textContent.trim())
t('the drag did not pick an account', /Brrr$/.test(picked ?? ''), picked)
await p.evaluate(() => document.querySelector('#tradeAcctPills [data-acct]:nth-child(3)')?.scrollIntoView({ inline: 'center' }))
await p.click('#tradeAcctPills [data-acct]:nth-child(3)')
const picked2 = await p.evaluate(() => [...document.querySelectorAll('#tradeAcctPills [data-acct]')].find(b => /accent/.test(b.style.color))?.textContent.trim())
t('a click still picks one', /Near$/.test(picked2 ?? ''), picked2)

t('no page errors', errs.length === 0, errs)
await b.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
