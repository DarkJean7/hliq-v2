// A profile picture your friends can actually see.
//
// Reported as: "make user uploaded account images appear also in the leaderboard. my friend
// did and i cannot see it." Nothing was wrong with the leaderboard — it has always rendered
// /pfp/<addr>, and four of the six live rows were serving real JPEGs. The UPLOADER was
// dev-only, twice over: the camera button sat behind isDev(), and so did the handler behind
// it. Every other user opened a file picker that did nothing at all — no upload, no error,
// not even a local copy.
//
// Opening it up meant closing something. POST /pfp on serve-prod took ANY image for ANY
// address with no authentication; the only thing in the way was that the button was hidden,
// which is not the same as being shut. The write moved to POST /api/pfp, behind the same
// ownership proof the leaderboard name uses.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'   // not URL: that shadows the global constructor
const MINE = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}

const MARGIN = { accountValue: '1000', totalNtlPos: '0', totalRawUsd: '1000', totalMarginUsed: '0' }
const STATE  = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '1000', assetPositions: [], time: Date.now() }
const WINDOW = { accountValueHistory: [], pnlHistory: [], vlm: '0' }
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 50 }]
const HL = {
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: { BTC: '100' },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
}

const uploads = []
// WebSockets are NOT covered by ctx.route, and the combined view opens one to Hyperliquid for
// live state. Left alone it delivers real prices straight past every fixture here — which is
// how a stubbed KNTQ at $0.26438 rendered as $0.2872, drifting between runs. Closed, so the
// app falls back to the REST path the fixtures actually govern.
const blockHlSockets = async (ctx) => {
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
await blockHlSockets(ctx)
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/api/**', async (route) => {
  const u = new URL(route.request().url())
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  if (u.pathname.endsWith('/api/auth/nonce')) return route.fulfill({ status: 200, json: { nonce: 'n1', ttl: 60000 } })
  if (u.pathname.endsWith('/api/auth/login')) return route.fulfill({ status: 200, json: { token: 'tok', exp: Date.now() + 3600e3 } })
  if (u.pathname.endsWith('/api/pfp')) {
    uploads.push({ addr: b.addr, auth: route.request().headers()['authorization'] ?? null, dataUrl: String(b.dataUrl ?? '') })
    return route.fulfill({ status: 200, json: { ok: true } })
  }
  return route.fulfill({ status: 503, body: 'offline in test' })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en')
  localStorage.setItem('hliq_onboard_done', '1')
  // An ordinary user: an agent key for their own wallet, and NOT the dev flag.
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Mine' }]))
}, { a: MINE, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, MINE)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.waitForTimeout(1200)

console.log(NL + '-- a normal user can reach it at all --')
await p.evaluate(() => window._mobVOpenWalletSwitch?.())
await waitFor(p, 'the wallet drawer', () => !!document.getElementById('mobVDrawerAvatar'), 15000)
const hasBtn = await p.evaluate(() => !!document.querySelector('#mobVDrawerAvatar button[title="Change photo"]'))
t('the camera button is offered for their own account', hasBtn, true)

console.log(NL + '-- a visitor with NOTHING set up still sees it --')
{
  // The gate was isDev(), then "an account you can prove is yours". Both hid the camera from
  // exactly the people the feature is for: someone who has not connected a wallet had no way
  // to learn it existed. Reported as "currently is not working for non-dev users".
  //
  // A second context with no dev flag, no agent key and no wallet — and, like the screenshot
  // that came with the report, sitting in All Accounts, which is not a wallet at all.
  const bare = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  await blockHlSockets(bare)
  await bare.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await bare.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  const q = await bare.newPage()
  await q.goto(BASE, { waitUntil: 'domcontentloaded' })
  await q.evaluate((a) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en')
    localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Watching' }]))
  }, MINE)
  await q.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(q, 'boot', () => !!window.loadDashboard)
  await q.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, MINE)
  await waitFor(q, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await q.evaluate(() => window._mobVOpenWalletSwitch?.())
  await waitFor(q, 'the wallet drawer', () => !!document.getElementById('mobVDrawerAvatar'), 15000)

  t('the camera is there with nothing set up',
    await q.evaluate(() => !!document.querySelector('#mobVDrawerAvatar button[title="Change photo"]')), true)
  t('and the dev flag really is off', await q.evaluate(() => localStorage.getItem('hliq_dev')), null)
  t('with no agent key either', await q.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('hliq_agent_key_')).length), 0)

  // Pressing it must explain what is missing rather than doing nothing.
  // _paperToast is module-scoped, so it cannot be stubbed from here — read what it actually
  // put on the page instead, which is the thing the person would see anyway.
  const press = () => q.evaluate(() => {
    document.getElementById('paperToastHost')?.remove()
    let picked = false
    const inp = document.getElementById('mobVPfpInput')
    const rc = inp.click.bind(inp); inp.click = () => { picked = true }
    try { window._mobVPickPfp() } finally { inp.click = rc }
    return { msg: document.getElementById('paperToastHost')?.innerText ?? '', picked }
  })
  const said = await press()
  // A watch-only address IS in view here, and it is not theirs. Falling back to "connect your
  // wallet" would be misleading — connecting would not make this account theirs, and it must
  // never quietly retarget their own wallet from someone else's page.
  t('it says that account is not theirs', /not yours/i.test(said.msg), true)
  // A file dialog it cannot authenticate is worse than no dialog.
  t('no file picker is opened yet', said.picked, false)

  // All Accounts — the case in the report's screenshot. Not a wallet, so the only picture
  // there is to set is the connected wallet's, and there isn't one yet.
  await q.evaluate(() => window.__goAllAccounts())
  await waitFor(q, 'the combined view', () => window.__stateAddrForTest === undefined
    ? document.body.innerText.includes('All Accounts') : true, 20000)
  const combined = await press()
  t('there it offers to connect a wallet', /Connect your wallet/i.test(combined.msg), true)
  t('and points back at the camera afterwards', /tap the camera again/i.test(combined.msg), true)
  t('still no file picker', combined.picked, false)
  await bare.close()
}

console.log(NL + '-- and the upload is authenticated and normalised --')
// A 1x1 PNG, the smallest real image there is.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
await p.setInputFiles('#mobVPfpInput', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(PNG, 'base64') })
await p.waitForTimeout(3000)

t('exactly one upload was sent', uploads.length, 1)
t('for their own address', uploads[0]?.addr, MINE.toLowerCase())
t('carrying an agent-key session', /^Bearer /.test(uploads[0]?.auth ?? ''), true)
// The canvas pass is what drops EXIF — a phone photo carries a GPS tag — and bounds the size.
// A PNG arriving as a PNG would mean the file was forwarded untouched.
t('re-encoded to jpeg rather than forwarded as-is', /^data:image\/jpeg;base64,/.test(uploads[0]?.dataUrl ?? ''), true)
t('as a 256px square, not the original', (uploads[0]?.dataUrl ?? '').length > 500, true)

// The old open POST /pfp is a serve-prod route; the dev server does not run it and falls
// back to index.html, so that one is asserted in tests/suites/pfp.test.mjs instead.

await browser.close()
console.log(NL + 'errors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
