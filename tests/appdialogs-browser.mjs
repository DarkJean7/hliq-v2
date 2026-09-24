// The app's own dialogs, and the sound on fill, in a real page.
//
// Reported with a screenshot of the browser's own box: "insolvent.trade says — Close all 4 open
// positions at market price?". A native dialog cannot be styled, blocks the page, and carries
// the domain rather than the app. The rules live in tests/suites/appdialogs.test.mjs; what
// needs a browser is that pressing the thing that used to raise one now raises the app's sheet,
// that answering it still does the work, and that the Settings row remembers a chosen sound.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 20000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const MARGIN = { accountValue: '2000', totalNtlPos: '0', totalRawUsd: '2000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0',
                 withdrawable: '2000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [[Date.now() - 3600e3, '2000'], [Date.now(), '2000']], pnlHistory: [], vlm: '0' }
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] },
  allMids: {}, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [{ universe: [] }], outcomeMeta: {}, perpDexs: [null], perpCategories: [],
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []], spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))

const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
// Anything native would stop the page dead here; Playwright auto-dismisses and we record it.
const natives = []
p.on('dialog', async (d) => { natives.push(d.type() + ': ' + d.message()); await d.dismiss().catch(() => {}) })

await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }, { addr: '0x974e086b541afc90acaf9ac5d3326d666a601e6b', label: 'Two' }]))
}, { a: ADDR, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))

const sheet = () => p.evaluate(() => {
  const d = [...document.querySelectorAll('div[role="alertdialog"], div[role="dialog"]')]
    .concat([...document.querySelectorAll('body > div')].filter(e => /z-index:\s*100080/.test(e.getAttribute('style') ?? '')))
  return d.length ? d.map(e => e.textContent.replace(/\s+/g, ' ').trim()).join(' | ') : ''
})

console.log(NL + '-- a notice is the app, not the browser --')
{
  await p.evaluate(() => { window.__appAlert('Could not start\n\nThe server is unreachable.'); return true })
  await waitFor(p, 'the sheet', () => /Could not start/.test(document.body.textContent ?? ''))
  const txt = await sheet()
  ok('it opens in the page', /Could not start/.test(txt), txt.slice(0, 120))
  ok('the first line is the heading and the rest the body', /Could not start[\s\S]*server is unreachable/.test(txt))
  ok('and nothing native was raised', natives.length === 0, natives)
  await p.click('#_aaY')
  await p.waitForTimeout(150)
  ok('OK dismisses it', !/Could not start/.test(await sheet()))
}

console.log(NL + '-- removing a wallet asks, and the answer is honoured --')
{
  const count = () => p.evaluate(() => JSON.parse(localStorage.getItem('savedWallets') || '[]').length)
  ok('two wallets to start with', (await count()) === 2)
  await p.evaluate(() => { window.__removeWallet('0x974e086b541afc90acaf9ac5d3326d666a601e6b'); return true })
  await waitFor(p, 'the confirm sheet', () => /Remove/.test(document.body.textContent ?? ''))
  ok('it asks first', /Remove/.test(await sheet()), (await sheet()).slice(0, 120))
  await p.click('#_acN')                                  // Cancel
  await p.waitForTimeout(200)
  ok('cancelling keeps the wallet', (await count()) === 2)

  await p.evaluate(() => { window.__removeWallet('0x974e086b541afc90acaf9ac5d3326d666a601e6b'); return true })
  await waitFor(p, 'the confirm sheet', () => !!document.querySelector('#_acY'))
  await p.click('#_acY')                                  // Remove
  await waitFor(p, 'the wallet to go', () => JSON.parse(localStorage.getItem('savedWallets') || '[]').length === 1)
  ok('confirming removes it', (await count()) === 1)
  ok('still nothing native', natives.length === 0, natives)
}

console.log(NL + '-- the sound on fill --')
{
  await p.evaluate(() => window.mobVTab('settings'))
  await waitFor(p, 'settings', () => /Sound on fill/.test(document.getElementById('mobVContent')?.textContent ?? ''))
  ok('the setting is in Settings', /Sound on fill/.test(await p.evaluate(() => document.getElementById('mobVContent')?.textContent ?? '')))
  ok('and starts off', await p.evaluate(() => localStorage.getItem('hliq_fill_sound')) === null)

  await p.evaluate(() => window.__setFillSound('chime'))
  await p.waitForTimeout(150)
  ok('choosing one is remembered', await p.evaluate(() => localStorage.getItem('hliq_fill_sound')) === 'chime')
  await p.evaluate(() => window.__setFillVolume(0.3))
  ok('so is the volume', await p.evaluate(() => localStorage.getItem('hliq_fill_sound_vol')) === '0.3')
  // Playing must never throw, whatever the browser decides about audio.
  ok('playing is safe to call', await p.evaluate(() => { try { window.__testFillSound(); return true } catch { return false } }))
  await p.evaluate(() => window.__setFillSound('nonsense'))
  ok('an unknown choice falls back to off', await p.evaluate(() => localStorage.getItem('hliq_fill_sound')) === 'off')
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
if (natives.length) { fail++; console.log('  FAIL native dialogs → ' + JSON.stringify(natives.slice(0, 3))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
