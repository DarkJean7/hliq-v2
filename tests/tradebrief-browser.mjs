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
  const step = iv === '4h' ? H4 : iv === '1d' ? D : 7 * D
  const now = Date.now(), out = []
  for (let i = n; i > 0; i--) {
    const c = 100 + 10 * Math.sin(i / 9)
    out.push({ t: now - i * step, T: now - i * step + step - 1, s: 'ETH', i: iv, o: String(c - 0.4), c: String(c), h: String(c + 1.2), l: String(c - 1.6), v: '1000', n: 50 })
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
      return route.fulfill({ json: candles(iv, iv === '4h' ? 600 : iv === '1d' ? 400 : iv === '1w' ? 120 : 300) })
    }
    const json = q.type === 'l2Book' ? book() : q.type === 'clearinghouseState' ? clearing()
      : q.type === 'allMids' ? { ETH: '100', BTC: '50000' }
      : q.type === 'meta' ? { universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] }
      : q.type === 'metaAndAssetCtxs' ? [{ universe: [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }, { name: 'ETH', szDecimals: 4, maxLeverage: 25 }] }, [{ markPx: '50000', midPx: '50000', funding: '0', openInterest: '1', dayNtlVlm: '1', prevDayPx: '50000' }, { markPx: '100', midPx: '100', funding: '0', openInterest: '1', dayNtlVlm: '1', prevDayPx: '100' }]]
      : ['frontendOpenOrders', 'userFills', 'userFillsByTime', 'userFunding', 'userNonFundingLedgerUpdates', 'perpDexs', 'perpCategories'].includes(q.type) ? []
      : q.type === 'spotClearinghouseState' ? { balances: [] } : {}
    return route.fulfill({ json })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
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
const reads = (asked, coin) => asked.filter(x => x === coin + ':4h' || x === coin + ':1d' || x === coin + ':1w').length

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
  t('shows the read for the market on screen', reads(asked, 'ETH') === 3 && /Support/.test(txt) && /Resistance/.test(txt), { asked, txt })
  t('with the checks', await p.$$eval('#deskTradeBrief .tb-chk', e => e.length) >= 2)
  t('and says what the levels mean for the position held', /your long/.test(txt) && /Your liquidation/.test(txt), txt)
  t('holding a long, only the long plan', /Long plan/.test(txt) && !/Short plan/.test(txt), txt)
  t('and that it is not advice', /not advice/.test(txt))
  t('it sits above the positions table', await p.evaluate(() => {
    const a = document.getElementById('deskTradeBrief'), m = document.querySelector('.trade-manage-tables')
    return !!(a.compareDocumentPosition(m) & Node.DOCUMENT_POSITION_FOLLOWING)
  }))
  const n = asked.length
  await p.evaluate(() => window.__selectCoin('ETH'))
  await p.waitForFunction(() => /\$/.test(document.getElementById('deskChartHero')?.textContent ?? ''), null, { timeout: 10000 })
  // Something NOT happening has no condition to wait on: past the card's 1.5s delay, then check.
  await p.waitForTimeout(1800)
  t('coming back within five minutes does not read it again', reads(asked, 'ETH') === 3, asked.slice(n))
  await p.click('#deskTradeBrief [data-tb-open]')
  await p.waitForFunction(() => document.getElementById('tab-analysis')?.classList.contains('active') || !!document.querySelector('.tab-panel.active #anaZ'), null, { timeout: 5000 }).catch(() => {})
  t('Full analysis opens the Analysis tab on this market', await p.evaluate(() => localStorage.getItem('hliq_ana_coin')) === 'ETH')
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
  t('and nothing runs off the screen', await p.evaluate(() => {
    const W = document.documentElement.clientWidth
    return [...document.querySelectorAll('#mobTradeBrief *')].every(e => e.getBoundingClientRect().right <= W + 0.5)
  }))
  if (arg('shot')) { await p.locator('#mobTradeBrief').scrollIntoViewIfNeeded(); await p.screenshot({ path: arg('shot') }) }
  await ctx.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
