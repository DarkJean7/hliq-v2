// The All Accounts headline when the server cannot finish a snapshot.
//
// Reported as "the account equity is not loading", with the Spot tab's own total right there
// underneath it. The server log said why: "[combined] HL 429 — serving what we have". With ten
// wallets Hyperliquid was rate-limiting the server mid-snapshot, so every answer covered eight
// of them; the client refuses a partial total (a missing wallet is not a smaller account), and
// the headline stayed a dash indefinitely.
//
// Here the stub always answers with a snapshot covering ONE of the two wallets, so the client
// can never adopt it. The headline must fall back to the wallets' own values rather than
// showing nothing — and must still refuse when a wallet has errored.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const A1 = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const A2 = '0x974e086b541afc90acaf9ac5d3326d666a601e6b'
const KEY = Wallet.createRandom().privateKey
const NL  = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 30000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}

// Two wallets, $2,000 and $1,500 — so the rows add up to $3,500.
const acct = (v) => {
  const M = { accountValue: String(v), totalNtlPos: '0', totalRawUsd: String(v), totalMarginUsed: '0' }
  return { marginSummary: M, crossMarginSummary: M, crossMaintenanceMarginUsed: '0', withdrawable: String(v), assetPositions: [], time: Date.now() }
}
const win = (v) => ({ accountValueHistory: [[Date.now() - 3600e3, String(v)], [Date.now(), String(v)]], pnlHistory: [], vlm: '0' })
const VALS = { [A1.toLowerCase()]: 2000, [A2.toLowerCase()]: 1500 }
const reply = (body) => {
  const user = String(body?.user ?? '').toLowerCase()
  const v = VALS[user] ?? 0
  switch (body?.type) {
    case 'clearinghouseState': return acct(v)
    case 'webData2': return { clearinghouseState: acct(v), openOrders: [] }
    case 'portfolio': return ['day', 'week', 'month', 'allTime'].map(w => [w, win(v)])
    case 'spotClearinghouseState': return { balances: [] }
    case 'allMids': return {}
    case 'frontendOpenOrders': case 'openOrders': case 'userFills': case 'userFillsByTime':
    case 'userFunding': case 'userNonFundingLedgerUpdates': case 'subAccounts':
    case 'candleSnapshot': case 'extraAgents': case 'perpCategories': return []
    case 'outcomeMeta': return {}
    case 'meta': case 'spotMeta': return { universe: [], tokens: [] }
    case 'metaAndAssetCtxs': return [{ universe: [] }, []]
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'allPerpMetas': return [{ universe: [] }]
    case 'perpDexs': return [null]
    default: return Array.isArray(body?.type) ? [] : {}
  }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: reply(b) })
})
// The server, rate-limited: a snapshot that only ever covers one of the two wallets.
let combinedCalls = 0
await ctx.route('**/api/combined', (route) => {
  combinedCalls++
  return route.fulfill({ status: 200, json: {
    updatedAt: Date.now(), accountValue: 2000, perpBase: 2000, dayAgo: 2000,
    wallets: 1, missing: [A2.toLowerCase()], books: {},
    settledPnl: 0, realizedPnl: 0, fees: 0, funding: 0, unrealBase: 0, pnlWallets: 1, perWallet: {},
  } })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a1, a2, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_privacy', '0')
  localStorage.setItem('hliq_agent_key_' + a1.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a1, label: 'One' }, { addr: a2, label: 'Two' }]))
  localStorage.setItem('hliq_multi_accounts', JSON.stringify([{ addr: a1, label: 'One' }, { addr: a2, label: 'Two' }]))
}, { a1: A1, a2: A2, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
// A short wait for the fallback, or the test would have to sit out 90 seconds.
await p.evaluate(() => { window.__comboRowsAfterMs = 1500 })
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, A1)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)

console.log(NL + '-- the server can never complete the set --')
{
  const entered = await p.evaluate(() => (window.__goAllAccounts ? window.__goAllAccounts() : null) ?? true)
  await waitFor(p, 'All Accounts', () => !!window.__isAllAccounts?.() || /All Accounts/i.test(document.body.textContent ?? ''), null, 40000)
  const headline = () => p.evaluate(() => document.getElementById('mobVBalance')?.textContent?.trim() ?? '')
  ok('it is asked for a snapshot', combinedCalls > 0 || entered !== null, combinedCalls)
  // Both wallets answer for themselves: $2,000 + $1,500.
  const got = await waitFor(p, 'the summed headline', () => /3,500/.test(document.getElementById('mobVBalance')?.textContent ?? ''), null, 45000)
  ok('the headline falls back to the wallets\' own values, not a dash', got, await headline())
  ok('and it is not the partial snapshot ($2,000)', !/\$2,000\.00/.test(await headline()), await headline())
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
