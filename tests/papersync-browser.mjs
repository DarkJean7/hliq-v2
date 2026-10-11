// Paper accounts on the server, driven through the real app (src/papersync.js + main.js glue).
// The "server" is src/paperhost.js itself, run inside this test behind /paper/sync — the real
// sync rules, no network. What is checked is the handshake the whole feature rests on:
//   the device's existing accounts are uploaded on first open;
//   the app holds the lease on the account it is running, and only that one;
//   the server advances the OTHER accounts (a resting order fills there) and the app adopts it;
//   the app advances its own account and the server receives it;
//   leaving the app hands the account back to the server.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createPaperHost, ownerOf } from '../src/paperhost.js'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
let pass = 0, fail = 0
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 500))) }
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(200)
  }
}
const until = async (label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) { try { if (await fn()) return true } catch {} if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false } await new Promise(r => setTimeout(r, 200)) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'papersync-'))
const host = createPaperHost({ dir })
let mid = '100'
const now = Date.now()
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }]
const MARGIN = { accountValue: '0', totalNtlPos: '0', totalRawUsd: '0', totalMarginUsed: '0' }
const STATE = { marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '0', withdrawable: '0', assetPositions: [], time: now }
const HL = () => ({
  clearinghouseState: STATE, spotClearinghouseState: { balances: [] }, allMids: { BTC: mid },
  frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [], userNonFundingLedgerUpdates: [],
  subAccounts: [], candleSnapshot: [], extraAgents: [], allPerpMetas: [{ universe: UNIVERSE }], outcomeMeta: {}, portfolio: [],
  meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] }, perpDexs: [null],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: mid, dayNtlVlm: '0', premium: '0', oraclePx: mid, markPx: mid, midPx: mid, impactPxs: [mid, mid] }]],
})
const order = (oid, limitPx) => ({ oid, coin: 'BTC', isBuy: true, sz: 0.5, limitPx, reduceOnly: false, isTrigger: false, triggerPx: 0, tpsl: '', timestamp: now })
const store = (orders) => JSON.stringify({ balance: 1000, positions: [], orders, fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 5000, created: now })

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL()[b.type] ?? {} })
})
const syncs = []
let down = false
await ctx.route('**/paper/sync', (route) => {
  if (down) return route.fulfill({ status: 503, contentType: 'application/json', json: { ok: false, error: 'down' } })
  const b = JSON.parse(route.request().postData() || '{}')
  syncs.push({ hold: b.hold, keys: Object.keys(b.push ?? {}) })
  const r = host.sync(b)
  return route.fulfill({ status: r.ok ? 200 : 400, contentType: 'application/json', json: r })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
// A device that already has paper accounts: the practice one with a buy resting at 90, and a
// second one ("alt1") with a buy resting at 95.
await p.evaluate(([a, b]) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_paper_v2', a)
  localStorage.setItem('hliq_paper_accts', JSON.stringify([{ slot: 'alt1', name: 'Alt', createdAt: 1 }]))
  localStorage.setItem('hliq_paper_s_alt1', b)
  localStorage.setItem('hliq_agent_key_0x0000000000000000000000000000000000000001', '0xnotakey')
}, [store([order(11, 90)]), store([order(12, 95)])])
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.__paperSync)
const secret = await p.evaluate(() => localStorage.getItem('hliq_paper_owner'))
const owner = ownerOf(secret)
const rec = () => host.read(owner)
await until('the upload', () => rec()?.kv?.hliq_paper_s_alt1)

console.log('\n-- first open: the device\'s accounts go up --')
ok('a device that has used paper gets an owner secret, kept on the device', /^[0-9a-f]{64}$/.test(secret ?? ''))
ok('its existing accounts are uploaded: both stores and the account list', !!rec()?.kv?.hliq_paper_v2?.v && !!rec()?.kv?.hliq_paper_s_alt1?.v && !!rec()?.kv?.hliq_paper_accts?.v)
ok('an agent key on the device is never sent', !JSON.stringify(rec()).includes('notakey') && !syncs.some(s => s.keys.some(k => k.startsWith('hliq_agent'))))
ok('not running a paper account: nothing is held', rec()?.lease == null)

console.log('\n-- in paper: the app runs its account, the server the others --')
await p.evaluate(() => window.__goPaper('main'))
await until('the lease', () => rec()?.lease?.key === 'hliq_paper_v2')
ok('entering paper takes the lease on that account', rec()?.lease?.key === 'hliq_paper_v2')
await waitFor(p, 'the gate', () => window.__paperSync.state().leased === 'hliq_paper_v2')
// The server's tick, with BTC at 89: alt1's buy at 95 fills there; main's is the app's to fill.
const tk = host.tick({ marks: { BTC: '89' }, assets: { BTC: { szDecimals: 5, maxLeverage: 40 } }, funding: {} })
ok('the server fills the account the app is NOT running', JSON.parse(rec().kv.hliq_paper_s_alt1.v).positions[0]?.entryPx === 95 && tk.events.some(e => e.slot === 'alt1'))
ok('and leaves the one it is running alone', JSON.parse(rec().kv.hliq_paper_v2.v).orders.length === 1)
await waitFor(p, 'the app adopts alt1', () => JSON.parse(localStorage.getItem('hliq_paper_s_alt1') || '{}').positions?.[0]?.entryPx === 95)
ok('the app receives it on the next sync', await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_paper_s_alt1')).positions[0].szi) === 0.5)
// Now BTC trades at 89 in the app too: the app fills its own account, and sends it up.
mid = '89'
await waitFor(p, 'the app fills main', () => JSON.parse(localStorage.getItem('hliq_paper_v2') || '{}').positions?.[0]?.entryPx === 90, undefined, 40000)
ok('the app fills its own account itself, as it always did', await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_paper_v2')).positions[0]?.szi) === 0.5)
await until('main up', () => JSON.parse(rec().kv.hliq_paper_v2.v).positions?.[0]?.entryPx === 90)
ok('and the server gets it', JSON.parse(rec().kv.hliq_paper_v2.v).positions[0]?.entryPx === 90 && JSON.parse(rec().kv.hliq_paper_v2.v).fills.length === 1)

console.log('\n-- leaving --')
await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')) })
await until('release', () => rec()?.lease == null)
ok('hiding the app hands its account back to the server at once', rec()?.lease == null)
await p.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }) })

console.log('\n-- a portfolio bot\'s paper account --')
// /portfolios tags an account it made for a bot. Opened in the app, it is shown but never held.
await p.evaluate(() => { const l = JSON.parse(localStorage.getItem('hliq_paper_accts')); l[0].bot = 'L-TEST'; localStorage.setItem('hliq_paper_accts', JSON.stringify(l)) })
await until('the tag up', () => rec()?.kv?.hliq_paper_accts?.v?.includes('L-TEST'))
await p.evaluate(() => window.__goPaper('alt1'))
await p.waitForTimeout(7000)
ok('the app does not take the lease on a bot\'s account: the server keeps running it', rec()?.lease?.key !== 'hliq_paper_s_alt1' && await p.evaluate(() => window.__paperSync.gate('hliq_paper_s_alt1')) === false)
// The flip-flop that was reported: a stale copy of the bot's account (another tab's memory,
// a flush on switching) lands in this tab's storage. It must NEVER go up — the server's copy
// comes back instead — or the account flips between the bot's book and the stale one.
const before = rec().kv.hliq_paper_s_alt1
await p.evaluate(() => localStorage.setItem('hliq_paper_s_alt1', JSON.stringify({ balance: 1, positions: [{ coin: 'ADA', szi: -100, entryPx: 1, margin: 10, leverage: 10, isIsolated: false }], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1, created: 0 })))
await waitFor(p, 'the server copy back', (v) => localStorage.getItem('hliq_paper_s_alt1') === v, before.v, 20000)
if (process.env.PS_DEBUG) console.log('DBG', JSON.stringify(syncs.slice(-4)), await p.evaluate(() => localStorage.getItem('hliq_paper_s_alt1').slice(0, 90)), (before.v ?? '').slice(0, 90))
ok('a stale copy of an account the app is not running is replaced by the server\'s', await p.evaluate((v) => localStorage.getItem('hliq_paper_s_alt1') === v, before.v))
ok('and was never sent: the server\'s copy is untouched', rec().kv.hliq_paper_s_alt1.rev === before.rev && rec().kv.hliq_paper_s_alt1.v === before.v)
await p.evaluate(() => window.__goPaper('main'))

console.log('\n-- the server cannot be reached --')
down = true
await waitFor(p, 'offline', () => window.__paperSync.state().online === false, undefined, 20000)
ok('the app runs paper on its own, as before', await p.evaluate(() => window.__paperSync.gate('hliq_paper_v2')) === true)
down = false

ok('no page errors', !errs.length, errs)
await browser.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
