// Desktop sorts the way the phone does. Hermetic: the exchange is stubbed.
//
// "lets make desktop pnl and every sort match the same mobile behaviour". On the phone's screenshot,
// PnL ▲ read: UNI −$27.08 first ("Top PnL · Near +$0.12"), then XRP −$2.35. A coin on several accounts
// sits where its first account lands, and the row names that account. Desktop now reads the same.
import { chromium } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const A1 = '0x' + '1'.repeat(40), A2 = '0x' + '2'.repeat(40)
const P = (coin, szi, pnl, val) => ({ type: 'oneWay', position: { coin, szi: String(szi), entryPx: '10', positionValue: String(val), unrealizedPnl: String(pnl), returnOnEquity: '0.1',
  liquidationPx: '1', marginUsed: '5', maxLeverage: 10, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } })
const POSITIONS = {
  [A1]: [P('UNI', 1, 0.12, 10), P('XRP', 1, -2.35, 20)],
  [A2]: [P('UNI', 1, -27.2, 30)],
}
const O = (coin, side, px, sz, oid) => ({ coin, side, limitPx: String(px), triggerPx: '0.0', sz: String(sz), origSz: String(sz), oid, timestamp: 1, orderType: 'Limit', reduceOnly: false, isTrigger: false, tif: 'Gtc' })
const ORDERS = { [A1]: [O('XRP', 'A', 2, 5, 1), O('BTC', 'B', 90, 1, 2), O('ETH', 'B', 3, 9, 3)], [A2]: [] }
const sum = { accountValue: '1000', totalNtlPos: '60', totalRawUsd: '1000', totalMarginUsed: '15' }
const WIN = { accountValueHistory: [[Date.now() - 864e5, '1000'], [Date.now(), '1000']], pnlHistory: [[Date.now() - 864e5, '0'], [Date.now(), '0']], vlm: '0' }

const reply = (q) => {
  switch (q.type) {
    case 'clearinghouseState': return q.dex ? { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: [], time: Date.now() }
      : { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: '1', withdrawable: '900', assetPositions: POSITIONS[q.user] ?? [], time: Date.now() }
    case 'frontendOpenOrders': return q.dex ? [] : ORDERS[q.user] ?? []
    case 'spotClearinghouseState': return { balances: [] }
    case 'allMids': return { UNI: '10', XRP: '10', BTC: '100', ETH: '4' }
    case 'portfolio': return ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, WIN])
    case 'userFills': case 'userFillsByTime': case 'userFunding': case 'userNonFundingLedgerUpdates': case 'candleSnapshot': case 'perpCategories': case 'perpConciseAnnotations': return []
    case 'metaAndAssetCtxs': return [{ universe: [] }, []]
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'allPerpMetas': return [{ universe: [] }]
    case 'perpDexs': return [null]
    default: return {}
  }
}

const b = await chromium.launch()
const ctx = await b.newContext({ viewport: { width: 1500, height: 950 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(/api\.hyperliquid\.xyz/, (route) => {
  let q = {}
  try { q = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: reply(q) })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(APP, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ A1, A2 }) => {
  localStorage.clear()
  for (const k of ['hliq_onboard_done', 'hliq_lang_chosen', 'hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2']) localStorage.setItem(k, '1')
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*'])); localStorage.setItem('hliq_privacy', '0')
  const list = JSON.stringify([{ addr: A1, label: 'Near' }, { addr: A2, label: 'Brrr' }])
  localStorage.setItem('savedWallets', list); localStorage.setItem('hliq_multi_accounts', list)
}, { A1, A2 })
await p.reload({ waitUntil: 'domcontentloaded' })
await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 60000 })
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, A1)
await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
await p.evaluate(() => window.__goAllAccounts?.())
await p.waitForFunction(() => document.querySelector('#ovPosBody .ov-pos-grouprow'), null, { timeout: 60000 })

// Top-level rows: a merged row's per-account rows sit inside it, hidden until it is opened.
const markets = () => p.$$eval('#ovPosBody .ov-pos-mkt b', es => es.filter(e => !e.closest('.ov-pos-group-body')).map(e => e.textContent))
const arrow = () => p.$$eval('#ovPosBody .ov-pos-head .ov-sort', es => { const on = es.find(e => e.querySelector('.ov-sort-arr:not(.ov-sort-idle)')); return on ? on.textContent.trim() : null })
const feat = () => p.$$eval('#ovPosBody .ov-pos-grouprow .ov-pos-feat', es => es.map(e => e.textContent.trim()).join(' · '))

console.log('-- PnL, the phone\'s default --')
t('opens on PnL ▼', /^PnL▼/i.test(await arrow() ?? ''), await arrow())
t('lowest first: UNI, for the account at −$27', (await markets()).join() === 'UNI,XRP', await markets())
t('the merged row names it: Lowest PnL · Brrr', /Lowest PnL · Brrr/.test(await feat()), await feat())

console.log('-- pressed: biggest first --')
await p.evaluate(() => window.__ovSortPos('pnl'))
t('PnL ▲', /^PnL▲/i.test(await arrow() ?? ''), await arrow())
// The phone's screenshot exactly: UNI's total is −$27.08 and it still leads, because Near is +$0.12.
t('UNI still leads, because one of its accounts is up', (await markets()).join() === 'UNI,XRP', await markets())
t('and the row says which: Top PnL · Near', /Top PnL · Near/.test(await feat()), await feat())
t('with that account\'s health', /\d+% health/.test(await feat()), await feat())

console.log('-- every column starts where the phone does --')
await p.evaluate(() => window.__ovSortPos('size'))
t('a new column starts on ▼', /▼/.test(await arrow() ?? ''), await arrow())
t('value: lowest first', (await markets()).join() === 'UNI,XRP' && /Lowest value · Near/.test(await feat()), [await markets(), await feat()])
await p.evaluate(() => window.__ovSortPos('size'))
t('flipped: the biggest position first', /Top value · Brrr/.test(await feat()), await feat())
await p.evaluate(() => window.__ovSortPos('health'))
t('on any other column it shows the riskiest account', /Worst health/.test(await feat()), await feat())
await p.evaluate(() => window.__ovSortPos('market'))
t('names read A→Z on the first press', (await markets()).join() === 'UNI,XRP' && /▼/.test(await arrow() ?? ''), [await markets(), await arrow()])
await p.evaluate(() => window.__ovSortPos('market'))
t('and Z→A on the second', (await markets()).join() === 'XRP,UNI', await markets())

console.log('-- orders --')
await p.evaluate(() => window.__ovSetPosTab('orders'))
await p.waitForFunction(() => document.querySelector('#ovPosBody .ov-ord-head'), null, { timeout: 15000 })
const ordCoins = () => p.$$eval('#ovPosBody .ov-pos-mkt b', es => es.map(e => e.textContent))
t('open on coin A→Z, as the phone does', (await ordCoins()).join() === 'BTC,ETH,XRP', await ordCoins())
await p.evaluate(() => window.__ovSortOrd('price'))
t('price, first press: high to low', (await ordCoins()).join() === 'BTC,ETH,XRP', await ordCoins())
await p.evaluate(() => window.__ovSortOrd('price'))
t('then low to high', (await ordCoins()).join() === 'XRP,ETH,BTC', await ordCoins())
await p.evaluate(() => window.__ovSortOrd('side'))
t('type: buys first, by coin within them', (await ordCoins()).join() === 'BTC,ETH,XRP', await ordCoins())

t('no page errors', !errs.length, errs)
await p.evaluate(() => window.__ovSetPosTab('positions'))
await p.evaluate(() => window.__ovSortPos('pnl'))
// The market column is narrow: this label wrapped onto three lines and stretched the row.
const lineH = await p.$$eval('#ovPosBody .ov-pos-grouprow .ov-pos-feat', es => es.map(e => e.getBoundingClientRect().height))
t('the label is two lines, neither wrapping', lineH.length === 2 && lineH.every(h => h < 20), lineH)
if (arg('shot')) { await p.evaluate(() => window.__ovSetPosTab('positions')); await p.evaluate(() => { window.__ovSortPos('pnl') }); await p.screenshot({ path: arg('shot') }) }
console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
