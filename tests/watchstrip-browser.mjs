// The desktop watch strip opens the market you pressed, under its name.
//
// Reported: "pressing the above watch cards does not work in some markets like brentoil (maybe
// hip3 are not working). also the names of some is missing (may be spot)". Two faults:
//   - the strip only switched the Trade tab's market when the coin was in state.allMids, which
//     is the MAIN dex, so a HIP-3 card opened Trade on whatever was there before;
//   - the desktop ticket printed a spot pair by its id: HYPE showed as "@107-USDC".
// The fixture makes both true: xyz:BRENTOIL is HIP-3 and NOT in allMids (as on the real
// exchange), and the watched HYPE is the spot pair @107.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const ADDR = '0x4444444444444444444444444444444444444444'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const MARGIN = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: [], time: Date.now() }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }]
const ctx1 = (px) => ({ funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] })
const XYZ = [{ name: 'xyz:BRENTOIL', szDecimals: 2, maxLeverage: 20 }]
const SPOT = { tokens: [{ name: 'USDC', index: 0, szDecimals: 8, weiDecimals: 8 }, { name: 'HYPE', index: 150, szDecimals: 2, weiDecimals: 8 }],
  universe: [{ name: '@107', tokens: [150, 0], index: 107, isCanonical: false }] }
const WINDOW = { accountValueHistory: [[Date.now() - 36e5, '1000'], [Date.now(), '1000']], pnlHistory: [[Date.now() - 36e5, '0'], [Date.now(), '0']], vlm: '0' }
const reply = (b) => {
  switch (b.type) {
    // allMids is the main dex and spot ids — never the HIP-3 market, which is the point.
    case 'allMids': return b.dex ? { 'xyz:BRENTOIL': '106.3' } : { BTC: '82000', '@107': '80.7' }
    case 'metaAndAssetCtxs': return b.dex === 'xyz' ? [{ universe: XYZ }, [ctx1('106.3')]] : [{ universe: UNIVERSE }, [ctx1('82000')]]
    case 'meta': return b.dex === 'xyz' ? { universe: XYZ } : { universe: UNIVERSE }
    case 'perpDexs': return [null, { name: 'xyz', fullName: 'XYZ', deployer: '0x0' }]
    case 'allPerpMetas': return [{ universe: UNIVERSE }, { universe: XYZ }]
    case 'spotMeta': return SPOT
    case 'spotMetaAndAssetCtxs': return [SPOT, [{ coin: '@107', markPx: '80.7', midPx: '80.7', prevDayPx: '80', dayNtlVlm: '0', circulatingSupply: '0' }]]
    case 'clearinghouseState': return STATE
    case 'spotClearinghouseState': return { balances: [] }
    case 'portfolio': return ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW])
    case 'webData2': return { clearinghouseState: STATE, openOrders: [] }
    case 'perpCategories': return []
    case 'outcomeMeta': return {}
    case 'frontendOpenOrders': case 'userFills': case 'userFillsByTime': case 'userFunding':
    case 'userNonFundingLedgerUpdates': case 'subAccounts': case 'candleSnapshot': case 'extraAgents': return []
    default: return {}
  }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: reply(b) })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate((a) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  localStorage.setItem('hliq_watchlist', JSON.stringify(['BTC', 'xyz:BRENTOIL', '@107']))
}, ADDR)
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the watch strip', () => document.querySelectorAll('#watchTickerTrack .watch-ticker-item').length === 3)
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))

const press = async (label) => {
  await p.evaluate((l) => [...document.querySelectorAll('#watchTickerTrack .watch-ticker-item')]
    .find(x => x.querySelector('.watch-ticker-coin')?.textContent.trim() === l)?.click(), label)
  await waitFor(p, 'the Trade tab', () => document.getElementById('tab-trade')?.classList.contains('active'))
  await p.waitForTimeout(600)
  return p.evaluate(() => ({
    header: document.getElementById('mktCoinName')?.textContent.trim(),
    ticket: document.getElementById('tcsCoinInput')?.value,
    button: document.getElementById('submitBtn')?.textContent.replace(/\s+/g, ' ').trim() ?? null,
  }))
}

console.log('\n-- a HIP-3 card opens its market --')
// Start somewhere else, so staying put cannot pass for success.
await press('BTC')
const oil = await press('BRENTOIL')
t('the header is BRENTOIL, not the market that was open before', oil.header, 'BRENTOIL-USDC')
t('and so is the ticket', oil.ticket, 'BRENTOIL')

console.log('\n-- a spot card is named, not numbered --')
const hype = await press('HYPE')
t('the header says HYPE-USDC, not @107-USDC', hype.header, 'HYPE-USDC')
t('the ticket says HYPE', hype.ticket, 'HYPE')
t('and nothing on the ticket shows the id', /@107/.test(JSON.stringify(hype)), false)

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
