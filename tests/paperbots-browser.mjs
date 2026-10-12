// Bots on a paper account run on the server, with no agent key (src/paperbots.js + main.js).
//
// Reported: "paper accounts are asking for agent keys for things like copy trade, strategy bots
// when they dont even have one, and dont need one." Copy Trade looked up an agent key for the
// paper account, found none, and refused; other bots said they did not simulate on paper.
//
// Driven through the real app, against src/paperhost.js itself behind /paper/sync and a stubbed
// bot server that records what it is asked: Copy Trade and a strategy bot start from a paper
// account with no key; the account then becomes the server's to write (the app lets go of it);
// and Stop goes to the paper bot server.
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
const ok = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x).slice(0, 400))) }
const until = async (label, fn, ms = 25000) => {
  const t0 = Date.now()
  for (;;) { try { if (await fn()) return true } catch {} if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false } await new Promise(r => setTimeout(r, 200)) }
}
const UNIVERSE = [{ name: 'BTC', szDecimals: 5, maxLeverage: 40 }]
const HL = {
  allMids: { BTC: '100' }, meta: { universe: UNIVERSE }, spotMeta: { tokens: [], universe: [] }, perpDexs: [null], allPerpMetas: [{ universe: UNIVERSE }],
  metaAndAssetCtxs: [{ universe: UNIVERSE }, [{ funding: '0', openInterest: '0', prevDayPx: '100', dayNtlVlm: '0', premium: '0', oraclePx: '100', markPx: '100', midPx: '100', impactPxs: ['100', '100'] }]],
  candleSnapshot: [], outcomeMeta: {}, clearinghouseState: { assetPositions: [], marginSummary: { accountValue: '0' } },
}
const TRADER = '0x1111111111111111111111111111111111111111'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperbots-'))
const host = createPaperHost({ dir })
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})
await ctx.route('**/paper/sync', (route) => { const r = host.sync(JSON.parse(route.request().postData() || '{}')); return route.fulfill({ status: 200, contentType: 'application/json', json: r }) })
// The bot server: records what it is asked; a started bot shows in the owner's status.
const asked = []
const running = new Map()
await ctx.route(/\/api\//, async (route) => {
  const u = new URL(route.request().url())
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  asked.push({ path: u.pathname, body: b })
  const j = (x, status = 200) => route.fulfill({ status, contentType: 'application/json', json: x })
  if (u.pathname === '/api/paper/start') { running.set(b.type + ':' + b.instance, { type: b.type, instance: b.instance, args: [...b.args, '--paper', b.slot] }); return j({ ok: true }) }
  if (u.pathname === '/api/paper/stop') { running.delete(b.type + ':' + b.instance); return j({ ok: true }) }
  if (u.pathname === '/api/status') {
    const out = { _configs: {}, _instances: {}, _paused: {} }
    for (const [k, c] of running) { const key = c.type + ':' + c.instance; out._configs[key] = { type: c.type, instance: c.instance, args: c.args }; out._instances[key] = true; out[c.type] = true }
    return j(out)
  }
  return j({ ok: false, error: 'offline in test' }, 503)
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))
await p.goto(`http://localhost:${port}/app`, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_paper_v2', JSON.stringify({ balance: 1000, positions: [], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 1000, created: Date.now() }))
})
await p.reload({ waitUntil: 'domcontentloaded' })
await until('boot', () => p.evaluate(() => !!window.__goPaper))
await p.evaluate(() => window.__goPaper('main'))
const secret = await p.evaluate(() => localStorage.getItem('hliq_paper_owner'))
const rec = () => host.read(ownerOf(secret))
await until('the lease', () => rec()?.lease?.key === 'hliq_paper_v2')

console.log('\n-- Copy Trade from a paper account --')
await p.evaluate((t) => window.__lbCopyTrade(t, 'Trader'), TRADER)
await until('the sheet', () => p.evaluate(() => !!document.getElementById('ct-go')))
await p.click('#ct-go')
await until('the copy start', () => asked.some(a => a.path === '/api/paper/start' && a.body.type === 'copytrade'))
const ct = asked.find(a => a.path === '/api/paper/start' && a.body.type === 'copytrade')
ok('Copy Trade starts on the paper bot server: no agent key asked for, none sent', !!ct && !ct.body.agentKey && /^[0-9a-f]{64}$/.test(ct.body.secret) && ct.body.slot === 'main', ct?.body)
ok('following the trader, at the size on the sheet', ct.body.args.includes('--target') && ct.body.args[ct.body.args.indexOf('--target') + 1] === TRADER && ct.body.args.includes('--scale'))
ok('never through the real-money start', !asked.some(a => a.path === '/api/start'))
ok('and no "no agent key" message', !/no agent key/i.test(await p.evaluate(() => document.body.innerText)))

console.log('\n-- the account is now the server\'s to write --')
await until('the release', () => rec()?.lease == null, 20000)
ok('the app lets go of the account a server bot is running (the server writes it now)', rec()?.lease == null)

console.log('\n-- a strategy bot, and Stop --')
await p.evaluate(() => window.runStrategy('grid'))
await until('the grid start', () => asked.some(a => a.path === '/api/paper/start' && a.body.type === 'grid'))
const gs = asked.find(a => a.path === '/api/paper/start' && a.body.type === 'grid')
ok('a strategy bot (Grid) starts on the paper bot server too, with its own settings', !!gs && !gs.body.agentKey && gs.body.args.includes('--coin'), gs?.body)
await p.evaluate((i) => window.stopStrategy('grid', i), gs.body.instance)
await until('the grid stop', () => asked.some(a => a.path === '/api/paper/stop' && a.body.type === 'grid'), 10000)
ok('Stop goes to the paper bot server, for that bot', asked.some(a => a.path === '/api/paper/stop' && a.body.type === 'grid' && a.body.instance === gs.body.instance))
ok('no page errors', !errs.length, errs)

await browser.close()
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
