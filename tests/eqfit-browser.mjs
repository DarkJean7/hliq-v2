// The phone's equity card: the balance never runs under the chart, and its change reads the same way.
// Hermetic: the exchange is stubbed.
//
// "make sure the chart does not draw above the equity. also fix the 24hr change to match the equity
// format." $338.14K and $4,123.93 both ran under the sparkline beside them, and a $22,731.59 change
// wrapped onto two lines under a balance written in K.
import { chromium, devices } from 'playwright'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const APP = `http://localhost:${arg('port', '5175')}/app`
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const ADDR = '0x' + 'b'.repeat(40)
const DAY = 864e5
const b = await chromium.launch()

async function open(equity, device) {
  // A day ago it was worth 6.3% more, so "today" is a large fall.
  const start = equity * 1.063, now = Date.now()
  const hist = Array.from({ length: 40 }, (_, i) => {
    const at = now - (39 - i) * 3600e3
    return [at, String(start + (equity - start) * (i / 39))]
  })
  const win = { accountValueHistory: hist, pnlHistory: hist.map(([x]) => [x, '0']), vlm: '0' }
  const sum = { accountValue: String(equity), totalNtlPos: '0', totalRawUsd: String(equity), totalMarginUsed: '0' }
  const ctx = await b.newContext(device)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route(/api\.hyperliquid\.xyz/, (route) => {
    let q = {}
    try { q = JSON.parse(route.request().postData() || '{}') } catch {}
    const json = q.type === 'clearinghouseState' ? { marginSummary: sum, crossMarginSummary: sum, crossMaintenanceMarginUsed: '0', withdrawable: String(equity), assetPositions: [], time: now }
      : q.type === 'spotClearinghouseState' ? { balances: [] }
      : q.type === 'allMids' ? { BTC: '50000' }
      : q.type === 'portfolio' ? ['day', 'week', 'month', 'allTime', 'perpDay', 'perpWeek', 'perpMonth', 'perpAllTime'].map(w => [w, win])
      : ['frontendOpenOrders', 'userFills', 'userFillsByTime', 'userFunding', 'userNonFundingLedgerUpdates', 'perpDexs', 'perpCategories', 'candleSnapshot'].includes(q.type) ? []
      : {}
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
  await p.waitForFunction(() => !!window.loadDashboard, null, { timeout: 60000 })
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await p.waitForFunction(() => /\$\d/.test(document.getElementById('mobVBalance')?.textContent ?? ''), null, { timeout: 30000 })
  return { p, ctx }
}

// The number's right edge against the chart's left edge, measured on screen.
const measure = (p) => p.evaluate(() => {
  const num = document.querySelector('#mobVBalance [data-eq-num]').getBoundingClientRect()
  const spark = document.getElementById('mobVSpark').getBoundingClientRect()
  const ch = document.getElementById('mobVChange')
  return { right: num.right, sparkLeft: spark.left, text: document.getElementById('mobVBalance').textContent.trim(), font: parseFloat(getComputedStyle(document.getElementById('mobVBalance')).fontSize),
    change: ch.textContent.trim(), changeH: ch.getBoundingClientRect().height, changeRight: ch.getBoundingClientRect().right, viewW: document.documentElement.clientWidth }
})

const phones = { 'iPhone SE (320)': { ...devices['iPhone SE'] }, 'iPhone 14 Pro (393)': { ...devices['iPhone 14 Pro'] } }
const cases = [[4123.93, 'a four-figure balance'], [99999.99, 'the widest exact figure'], [338140, 'a balance in K'], [1234567, 'a balance in M']]
for (const [name, device] of Object.entries(phones)) {
  console.log(`-- ${name} --`)
  for (const [equity, label] of cases) {
    const { p, ctx } = await open(equity, device)
    const m = await measure(p)
    t(`${label}: ${m.text} stays clear of the chart`, m.right <= m.sparkLeft + 0.5, m)
    t(`and is still readable (${m.font}px)`, m.font >= 22, m.font)
    if (equity === 338140) {
      await p.waitForFunction(() => /today/.test(document.getElementById('mobVChange')?.textContent ?? ''), null, { timeout: 15000 })
      const c = await measure(p)
      t(`its change reads in K too: ${c.change}`, /\$\d+\.\d\dK/.test(c.change), c.change)
      t('on one line', c.changeH < 34, c.changeH)
      if (arg('shot') && name.includes('393')) await p.waitForTimeout(4000)   // the startup splash
      if (arg('shot') && name.includes('393')) await p.screenshot({ path: arg('shot'), clip: { x: 0, y: 0, width: 393, height: 340 } })
    }
    if (equity === 4123.93) {
      await p.waitForFunction(() => /today/.test(document.getElementById('mobVChange')?.textContent ?? ''), null, { timeout: 15000 })
      const c = await measure(p)
      t(`a small balance keeps its change exact: ${c.change}`, /\$\d+\.\d\d ·/.test(c.change), c.change)
    }
    await ctx.close()
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
await b.close()
process.exit(fail ? 1 : 0)
