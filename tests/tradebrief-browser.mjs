// The analysis card on the Trade tab, on both shells. Hermetic: the exchange is stubbed.
//
// "use some of the most relevant data in the analysis tab and display that data in the trade tab on
// the selected asset ... under the user position summary (if a position is open)". It must show the
// read for the market on screen, say what the levels mean for a position held, and — because a read
// costs about 125 weight of a budget the exchange's own tab shares — not load for a market only
// passed through.
import { chromium, devices } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const ADDR = '0x' + 'a'.repeat(40)
const H4 = 4 * 3600e3, D = 864e5

// A market with a shape: swings between 90 and 110, so it has levels on both sides of 100.
function candles(iv, n) {
  const step = iv === '1h' ? 3600e3 : iv === '4h' ? H4 : iv === '1d' ? D : 7 * D
  const now = Date.now(), out = []
  for (let i = n; i > 0; i--) {
    const c = 100 + 10 * Math.sin(i / 9)
    // Volume scales with the bar, or a day's candle would carry an hour's trading and the
    // Market card's 3M window would come out smaller than its 30D one.
    out.push({ t: now - i * step, T: now - i * step + step - 1, s: 'ETH', i: iv, o: String(c - 0.4), c: String(c), h: String(c + 1.2), l: String(c - 1.6), v: String(1000 * (step / 3600e3)), n: 50 })
  }
  return out
}
const book = () => {
  const lv = (from, dir) => Array.from({ length: 20 }, (_, i) => ({ px: String(from + dir * i * 0.1), sz: '50', n: 3 }))
  return { coin: 'ETH', time: Date.now(), levels: [lv(99.9, -1), lv(100.1, 1)] }
}
const pos = { type: 'oneWay', position: { coin: 'ETH', szi: '2', entryPx: '95', positionValue: '200', unrealizedPnl: '10', returnOnEquity: '0.5', liquidationPx: '50',
  marginUsed: '20', maxLeverage: 25, leverage: { type: 'cross', value: 10 }, cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }
const clearing = () => ({ marginSummary: { accountValue: '1000', totalNtlPos: '200', totalRawUsd: '1000', totalMarginUsed: '20' },
  crossMarginSummary: { accountValue: '1000', totalNtlPos: '200', totalRawUsd: '1000', totalMarginUsed: '20' },
  crossMaintenanceMarginUsed: '5', withdrawable: '900', assetPositions: [pos], time: Date.now() })

// The account's own trades, for the My trades card: twelve ETH orders, the newest filled in three
// pieces (one trade, not three), and two BTC ones that must stay out of the ETH card.
const FILLS = (() => {
  const now = Date.now(), out = []
  const fill = (coin, oid, t, px, sz, side, dir, pnl) => ({ coin, oid, tid: oid * 10 + out.length, time: t, px: String(px), sz: String(sz), side, dir,
    closedPnl: String(pnl), fee: '0.01', feeToken: 'USDC', hash: '0x' + '0'.repeat(64), startPosition: '0', crossed: true })
  for (const [i, px] of [100, 101, 102].entries()) out.push(fill('ETH', 1, now - 60e3 - i, px, 1, 'A', 'Close Long', 5))
  for (let k = 2; k <= 12; k++) out.push(fill('ETH', k, now - k * 3600e3, 90 + k, 0.5, k % 2 ? 'B' : 'A', k % 2 ? 'Open Long' : 'Close Long', k % 2 ? 0 : -1))
  out.push(fill('BTC', 50, now - 30e3, 50000, 0.01, 'B', 'Open Long', 0), fill('BTC', 51, now - 90e3, 50100, 0.01, 'A', 'Close Long', 1))
  return out.sort((a, b) => b.time - a.time)
})()

const b = await chromium.launch()
async function open(opts) {
  const ctx = await b.newContext(opts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  const asked = []
  await ctx.route(/api\.hyperliquid\.xyz/, (route) => {
    let q = {}
    try { q = JSON.parse(route.request().postData() || '{}') } catch {}
    if (q.type === 'candleSnapshot') {
      asked.push(q.req.coin + ':' + q.req.interval)
      const iv = q.req.interval
      return route.fulfill({ json: candles(iv, iv === '4h' ? 600 : iv === '1d' ? 400 : iv === '1w' ? 120 : 800) })
    }
    const json = q.type === 'l2Book' ? book() : q.type === 'clearinghouseState' ? clearing()
      : q.type === 'allMids' ? { ETH: '100', BTC: '50000' }
      : q.type === 'meta' ? { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] }
      : q.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] }, [{ markPx: '50000', midPx: '50000', funding: '0', openInterest: '1', dayNtlVlm: '1', prevDayPx: '50000' }, { markPx: '100', midPx: '100', funding: '0', openInterest: '1', dayNtlVlm: '1', prevDayPx: '100' }]]
      : q.type === 'userFills' || q.type === 'userFillsByTime' ? FILLS
      : ['frontendOpenOrders', 'userFunding', 'userNonFundingLedgerUpdates', 'perpDexs', 'perpCategories'].includes(q.type) ? []
      : q.type === 'spotClearinghouseState' ? { balances: [] } : {}
    return route.fulfill({ json })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  // The Market card's one request. Our own server, so it is not under /api/ and the rule above
  // does not catch it -- unstubbed it would reach DefiLlama for real and the suite would stop
  // being hermetic.
  await ctx.route('**/markets-meta', (route) => route.fulfill({ json: {
    revenue: { ETH: { name: 'Ethereum', category: 'Chain', r24: 1_200_000, r7: 8_000_000, r30: 30_000_000,
                      f24: 2_400_000, f7: 16_000_000, f30: 60_000_000 } },
    cg: { ETH: ['ethereum', 210_000_000_000] },
    stocks: {}, sic: {},
  } }))
  const p = await ctx.newPage()
  await p.goto(APP, { waitUntil: 'domcontentloaded' })
  await p.evaluate(() => {
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => !!window.loadDashboard && !!window.__selectCoin, null, { timeout: 60000 })
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  return { p, asked, ctx }
}
// Analysis's own requests: 4h and weekly. Daily is read by the Signals card as well, and hourly by the chart.
const reads = (asked, coin) => asked.filter(x => x === coin + ':4h' || x === coin + ':1w').length

console.log('-- desktop --')
{
  const { p, asked, ctx } = await open({ viewport: { width: 1500, height: 950 } })
  await p.waitForFunction(() => document.getElementById('dashboard')?.classList.contains('active'), null, { timeout: 30000 })
  await p.evaluate(() => { window.__selectCoin('BTC'); window.switchTab('trade') })
  await p.waitForSelector('#deskTradeBrief .tb-card')
  // Passing through: on to ETH well inside the wait, so BTC's read is never paid for.
  await p.evaluate(() => window.__selectCoin('ETH'))
  t('a market only passed through costs nothing', reads(asked, 'BTC') === 0, asked)
  await p.waitForSelector('#deskTradeBrief .tb-h', { timeout: 20000 })
  const txt = await p.$eval('#deskTradeBrief', e => e.textContent)
  t('shows the read for the market on screen', reads(asked, 'ETH') === 2 && /Support/.test(txt) && /Resistance/.test(txt), { asked, txt })
  t('with the checks', await p.$$eval('#deskTradeBrief .tb-chk', e => e.length) >= 2)
  t('and says what the levels mean for the position held', /your long/.test(txt) && /Your liquidation/.test(txt), txt)
  t('holding a long, only the long plan', /Long plan/.test(txt) && !/Short plan/.test(txt), txt)
  t('and that it is not advice', /not advice/.test(txt))

  // "lets add also signals summary under the trade tab analysis".
  await p.waitForSelector('#deskTradeBrief .tb-perf', { timeout: 20000 })
  const cards = await p.$$eval('#deskTradeBrief > .tb-card', es => es.map(e => e.querySelector('.tb-top span').textContent))
  await p.waitForSelector('#deskTradeBrief .tf-row', { timeout: 20000 })
  const cards2 = await p.$$eval('#deskTradeBrief > .tb-card', es => es.map(e => e.querySelector('.tb-top span').textContent))
  t('the Signals card sits under the Analysis one, Market under that, and My trades last',
    JSON.stringify(cards2) === JSON.stringify(['Analysis', 'Signals', 'Market', 'My trades · ETH']), { cards, cards2 })

  // "below the new markets data, lets add the recent trades made in the selected asset. show 3,
  // as unexpanded and 10 when expanded" -- the account's own (src/tradefills.js).
  const TR = '#deskTradeBrief .tf-card'
  const rows = () => p.$$eval(TR + ' .tf-row', es => es.map(e => e.textContent.replace(/\s+/g, ' ').trim()))
  const r3 = await rows()
  t('three trades, folded', r3.length === 3, r3)
  t('newest first: the order filled in three pieces is ONE trade, at its size-weighted price', /Close long/.test(r3[0]) && /3 @ 101/.test(r3[0]) && /\+\$15\.00/.test(r3[0]), r3[0])
  t('only this market\'s trades (no BTC)', r3.every(r => !/50,?0\d\d/.test(r)), r3)
  t('an opening trade has no closed PnL: a dash, not $0', /Open long/.test(r3[2]) && /—/.test(r3[2]), r3[2])
  t('it offers ten', /Show 10/.test(await p.$eval(TR + ' [data-tb-fills-more]', e => e.textContent)))
  await p.click(TR + ' [data-tb-fills-more]')
  t('expanded: ten', (await rows()).length === 10, await rows())
  await p.click(TR + ' [data-tb-fills-more]')
  t('and folds back to three', (await rows()).length === 3)
  await p.evaluate(() => window.__selectCoin('BTC'))
  await p.waitForFunction(() => /My trades · BTC/.test(document.getElementById('deskTradeBrief')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {})
  t('another market lists its own: BTC\'s two, no toggle', (await rows()).length === 2 && !(await p.$(TR + ' [data-tb-fills-more]')), await rows())
  await p.click(TR + ' [data-tb-trades]')
  await p.waitForFunction(() => document.querySelector('.nav-tab.active')?.getAttribute('onclick')?.includes("'trades'"), null, { timeout: 5000 }).catch(() => {})
  t('All trades opens the Trades tab', await p.evaluate(() => !!document.querySelector('.nav-tab.active')?.getAttribute('onclick')?.includes("'trades'")))
  await p.evaluate(() => { window.switchTab('trade'); window.__selectCoin('ETH') })
  await p.waitForFunction(() => /My trades · ETH/.test(document.getElementById('deskTradeBrief')?.textContent ?? ''), null, { timeout: 10000 })
  // Scoped to the Signals card. These used to index #deskTradeBrief .tb-perf-c, which was every
  // window cell on the tab -- fine while Signals was the only card with a window strip, and
  // wrong the moment the Market card arrived with one of its own.
  const SIG = '#deskTradeBrief > .tb-card:nth-of-type(2)'
  const perf = await p.$$eval(SIG + ' .tb-perf-c', es => es.map(e => e.textContent.trim()))
  t('with every window, 1H included, as a percentage', perf.slice(0, 4).every(x => /^(1H|24H|7D|30D)[+-]\d+\.\d\d%$/.test(x)), perf)
  // "another row of timeframes under the current one with the longer timeframes".
  await p.waitForFunction((sel) => [...document.querySelectorAll(sel + ' .tb-perf-c')].slice(4).every(e => /%/.test(e.textContent)), SIG, { timeout: 15000 }).catch(() => {})
  const long = await p.$$eval(SIG + ' .tb-perf-c', es => es.slice(4).map(e => e.textContent.trim()))
  t('and a second row of the longer ones', long.length === 4 && long.every(x => /^(3M|6M|1Y|ALL)[+-]\d+\.\d\d%$/.test(x)), long)
  const tops = await p.$$eval(SIG + ' .tb-perf-c', es => es.map(e => Math.round(e.getBoundingClientRect().top)))
  t('under the first, not beside it', new Set(tops.slice(0, 4)).size === 1 && new Set(tops.slice(4)).size === 1 && tops[4] > tops[0], tops)
  const inds = await p.$$eval(SIG + ' .tb-ind span', es => es.map(e => e.textContent))
  t('and the indicators read', ['RSI', 'EMA', 'Bollinger', 'Volatility'].every(k => inds.some(x => x.includes(k))), inds)
  // "i would like to have the data available like volume(time frames), open interest(time
  // frames), revenue(time frame), fees(time frame), worth" -- src/trademkt.js.
  const MKT = '#deskTradeBrief > .tb-card:nth-of-type(3)'
  await p.waitForFunction((sel) => /Open interest/.test(document.querySelector(sel)?.textContent ?? ''), MKT, { timeout: 20000 })
  const mtxt = await p.$eval(MKT, e => e.textContent)
  const vols = await p.$$eval(MKT + ' .tb-perf-c', es => es.map(e => e.textContent.trim()))
  t('volume runs across six windows', vols.length === 6 && /^24H/.test(vols[0]) && /^1Y/.test(vols[5]), vols)
  t('each window is money or a dash, never a bare number', vols.every(x => /(\$|—)/.test(x)), vols)
  // A longer window cannot hold less trading than a shorter one. The short windows are summed
  // off hourly candles and the long ones off daily, so this is what catches the two series
  // being read against each other wrongly -- on live data they agree to within 2%.
  t('and a longer window never holds less than a shorter one', await p.$$eval(MKT + ' .tb-perf-c b', es => {
    const n = es.map(e => { const m = /\$([\d.]+)([KMBT]?)/.exec(e.textContent); return m ? +m[1] * ({ '': 1, K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[m[2]]) : null })
    return n.every((v, i) => v == null || i === 0 || n[i - 1] == null || v >= n[i - 1] * 0.999)
  }), vols)
  t('open interest is there', /Open interest/.test(mtxt), mtxt)
  t('with the worth of the asset', /Worth/.test(mtxt) && /\$210\.00B/.test(mtxt), mtxt)
  t('revenue over its windows', /Revenue 24h/.test(mtxt) && /Revenue 7d/.test(mtxt) && /Revenue 30d/.test(mtxt), mtxt)
  t('and fees over theirs', /Fees 24h/.test(mtxt) && /Fees 7d/.test(mtxt) && /Fees 30d/.test(mtxt), mtxt)
  t('whose revenue it is, is said', /are Ethereum's, across every chain/.test(mtxt), mtxt)
  // The whole point of reading main.js's own context and candles rather than asking again.
  t('and the card costs the exchange no extra request', reads(asked, 'ETH') === 2, asked)

  t('it sits above the positions table', await p.evaluate(() => {
    const a = document.getElementById('deskTradeBrief'), m = document.querySelector('.trade-manage-tables')
    return !!(a.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING)
  }))
  const n = asked.length
  await p.evaluate(() => window.__selectCoin('ETH'))
  await p.waitForFunction(() => /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 10000 })
  // Something NOT happening has no condition to wait on: past the card's 1.5s delay, then check.
  await p.waitForTimeout(1800)
  t('coming back within five minutes does not read it again', reads(asked, 'ETH') === 2, asked.slice(n))
  await p.click('#deskTradeBrief [data-tb-open]')
  await p.waitForFunction(() => document.getElementById('tab-analysis')?.classList.contains('active') || !!document.querySelector('.tab-panel.active #anaZ'), null, { timeout: 5000 }).catch(() => {})
  t('Full analysis opens the Analysis tab on this market', await p.evaluate(() => localStorage.getItem('hliq_ana_coin')) === 'ETH')
  await p.evaluate(() => { window.switchTab('trade') })
  await p.waitForSelector('#deskTradeBrief [data-tb-signals]', { state: 'visible', timeout: 10000 })
  await p.click('#deskTradeBrief [data-tb-signals]')
  await p.waitForFunction(() => /Pick a market/.test(document.querySelector('.tab-panel.active')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {})
  t('Full signals opens the Signals view', await p.evaluate(() => /Pick a market/.test(document.querySelector('.tab-panel.active')?.textContent ?? '')))
  await ctx.close()
}

console.log('-- phone --')
{
  const { p, ctx } = await open({ ...devices['iPhone 14 Pro'] })
  await p.waitForFunction(() => !!window.mobVGoTab && !!window._mobSelectMarket, null, { timeout: 30000 })
  await p.evaluate(() => { window.mobVGoTab('trade'); window._mobSelectMarket('ETH') })
  await p.waitForSelector('#mobTradeBrief .tb-h', { timeout: 30000 })
  const txt = await p.$eval('#mobTradeBrief', e => e.textContent)
  t('the phone shows the read too', /Support/.test(txt) && /Resistance/.test(txt), txt)
  t('with the position in it', /your long/.test(txt), txt)
  await p.waitForSelector('#mobTradeBrief .tb-perf', { timeout: 20000 })
  await p.waitForFunction(() => /Open interest/.test(document.getElementById('mobTradeBrief')?.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})
  await p.waitForSelector('#mobTradeBrief .tf-row', { timeout: 20000 })
  t('and the Signals, Market and My trades cards under it', await p.$$eval('#mobTradeBrief > .tb-card', es => es.length) === 4,
    await p.$$eval('#mobTradeBrief > .tb-card', es => es.map(e => e.querySelector('.tb-top span')?.textContent)))
  t('the phone lists three trades too', await p.$$eval('#mobTradeBrief .tf-row', es => es.length) === 3)
  await p.click('#mobTradeBrief [data-tb-fills-more]')
  t('and ten when expanded', await p.$$eval('#mobTradeBrief .tf-row', es => es.length) === 10)
  t('the phone gets the market figures too', /Open interest/.test(await p.$eval('#mobTradeBrief', e => e.textContent)))
  t('and nothing runs off the screen', await p.evaluate(() => {
    const W = document.documentElement.clientWidth
    return [...document.querySelectorAll('#mobTradeBrief *')].every(e => e.getBoundingClientRect().right <= W + 0.5)
  }))
  if (arg('shot')) { await p.locator('#mobTradeBrief > .tb-card').last().scrollIntoViewIfNeeded(); await p.screenshot({ path: arg('shot') }) }
  await ctx.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
