// Stickers and pictures in the global chat, in a real page: pick one, send it, see it drawn
// as media rather than as text — and watch what actually goes over the wire.
//
// The rules are covered in tests/suites/chatmedia.test.mjs; this is the round trip, and the
// half that suite cannot see: that the file picked is re-encoded before it is uploaded, that
// a sticker sends itself, and that the message body carries the fields server.js reads.
//
// Hermetic: the exchange is stubbed, and /api/chat is stubbed HERE rather than proxied — the
// room is shared and live, and a test must never post to it.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/app'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
/** Wait for something in THIS process — a request the app made — rather than in the page. */
const waitHere = async (label, fn, ms = 15000) => {
  const t0 = Date.now()
  while (!fn()) {
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await new Promise(r => setTimeout(r, 100))
  }
  return true
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
  clearinghouseState: STATE,
  spotClearinghouseState: { balances: [{ coin: 'USDC', token: 0, total: '500', hold: '0', entryNtl: '0' }] },
  allMids: {}, frontendOpenOrders: [], userFills: [], userFillsByTime: [], userFunding: [],
  userNonFundingLedgerUpdates: [], subAccounts: [], candleSnapshot: [], extraAgents: [],
  allPerpMetas: [], outcomeMeta: {},
  portfolio: ['day', 'week', 'month', 'allTime'].map(w => [w, WINDOW]),
  webData2: { clearinghouseState: STATE, openOrders: [] },
  meta: { universe: [] }, spotMeta: { tokens: [], universe: [] },
  metaAndAssetCtxs: [{ universe: [] }, []],
}

// A real 1x1 JPEG — it has to DECODE, because the app re-draws every picked file.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy' +
  'MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA' +
  'AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA' +
  'AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3' +
  'ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm' +
  'p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA' +
  'AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx' +
  'BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK' +
  'U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3' +
  'uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii' +
  'gD//2Q==', 'base64')

const errs = []
const browser = await chromium.launch()
const ctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
})

// The catch-alls go on FIRST: Playwright tries the most recently added matching route, so
// a generic '**/api/**' registered after '**/api/chat' would swallow the room and hand the
// app a 503 with nothing to say why.
await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))

// The stub room. `posted` is what the app actually sent — the point of this test.
const posted = []
let room = []
await ctx.route('**/api/chat', async (route) => {
  const req = route.request()
  if (req.method() === 'GET') {
    return route.fulfill({ status: 200, json: { messages: room, deleted: [], now: Date.now() } })
  }
  let b = {}
  try { b = JSON.parse(req.postData() || '{}') } catch {}
  posted.push(b)
  // Answer the way server.js does: the picture becomes an ID, never an echo of the bytes.
  const msg = { id: 'm' + posted.length, name: b.name, addr: b.addr ?? null, text: b.text ?? '',
                img: b.img ? 'srvimg0' + posted.length : null, sticker: b.sticker ?? null, ts: Date.now() }
  room = [...room, msg]
  return route.fulfill({ status: 200, json: { ok: true, message: msg } })
})
// What serve-prod.js serves for a stored picture.
await ctx.route('**/chatimg/**', (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: JPEG }))

const p = await ctx.newPage()
p.on('pageerror', e => errs.push(e.message))
await p.goto(BASE, { waitUntil: 'domcontentloaded' })
await p.evaluate(({ a, k }) => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1')
  ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
  localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
  localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
  localStorage.setItem('hliq_chat_name', 'tester')
}, { a: ADDR, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))

console.log(NL + '-- the room opens with a way to send both --')
await p.evaluate(() => window.__openChat())
await waitFor(p, 'the chat', () => !!document.getElementById('chatInput'))
ok('a sticker button and a picture button', await p.evaluate(() =>
  document.querySelectorAll('#globalChatOverlay .chat-icon-btn').length === 2))
ok('and nothing is attached yet', await p.evaluate(() => document.getElementById('chatPending')?.hidden === true))
ok('the sticker grid starts closed', await p.evaluate(() => document.getElementById('chatStickers')?.hidden === true))

console.log(NL + '-- a sticker sends itself --')
{
  await p.click('#globalChatOverlay .chat-icon-btn')
  const opened = await waitFor(p, 'the sticker grid', () =>
    document.getElementById('chatStickers')?.hidden === false &&
    document.querySelectorAll('#chatStickers button').length >= 24)
  ok('the grid opens with every sticker', opened)
  await p.click('#chatStickers button[title="Rocket"]')
  ok('the grid closes again', await waitFor(p, 'it to close', () => document.getElementById('chatStickers')?.hidden === true))
  ok('it posted at once — no Send to press', await waitHere('the post', () => posted.length === 1), posted)
  ok('carrying the NAME, not a file', posted[0]?.sticker === 'rocket' && !posted[0]?.img, posted[0])
  ok('and no text — a sticker is the message', posted[0]?.text === '', posted[0])
  ok('drawn as a sticker, not as an emoji someone typed', await waitFor(p, 'the sticker', () =>
    !!document.querySelector('#chatScroll .chat-sticker')))
  ok('at sticker size', await p.evaluate(() => {
    const el = document.querySelector('#chatScroll .chat-sticker')
    return el ? parseFloat(getComputedStyle(el).fontSize) >= 40 : false
  }))
}

console.log(NL + '-- a picture waits for Send, and is re-drawn before it goes --')
{
  await p.setInputFiles('#chatFile', { name: 'chart.png', mimeType: 'image/png', buffer: JPEG })
  const staged = await waitFor(p, 'the pending strip', () =>
    document.getElementById('chatPending')?.hidden === false &&
    (document.querySelector('#chatPending img')?.src ?? '').startsWith('data:image/jpeg'), null, 15000)
  ok('it is shown before it is sent', staged)
  ok('and can be taken off again', await p.evaluate(() => { window.__chatDropImg(); return document.getElementById('chatPending')?.hidden === true }))

  await p.setInputFiles('#chatFile', { name: 'chart.png', mimeType: 'image/png', buffer: JPEG })
  await waitFor(p, 'the pending strip again', () => document.getElementById('chatPending')?.hidden === false, null, 15000)
  await p.fill('#chatInput', 'my entry')
  await p.click('#globalChatOverlay button[onclick*="__chatSend"]')
  const two = await waitHere('the second post', () => posted.length === 2)
  ok('one message carries both the caption and the picture', two && posted[1]?.text === 'my entry' && !!posted[1]?.img, posted[1])
  // The file went in as a PNG. Everything this app uploads has been through a canvas first,
  // which is what drops the EXIF a phone photo carries — a public room must not publish
  // where someone was standing.
  ok('re-encoded as a jpeg, whatever was picked', String(posted[1]?.img ?? '').startsWith('data:image/jpeg;base64,'), String(posted[1]?.img).slice(0, 30))
  ok('and it is smaller than the wire budget', (posted[1]?.img ?? '').length < 700_000)
  ok('the strip is cleared once it is gone', await p.evaluate(() => document.getElementById('chatPending')?.hidden === true))
  ok('the caption box too', await p.evaluate(() => document.getElementById('chatInput')?.value === ''))
  ok('and the picture is drawn in the feed', await waitFor(p, 'the picture', () =>
    !!document.querySelector('#chatScroll .chat-img')))
}

console.log(NL + '-- what a reader gets --')
{
  // A fresh reader has the server's copy: an ID, not the bytes. This is the path every
  // other person in the room takes.
  await p.evaluate(() => window.__closeChat())
  await p.evaluate(() => window.__openChat())
  const byId = await waitFor(p, 'the stored picture', () => {
    const el = document.querySelector('#chatScroll .chat-img')
    return !!el && /\/chatimg\/srvimg0\d$/.test(el.getAttribute('src') ?? '')
  }, null, 15000)
  ok('a stored picture is read back by id from the server', byId)
  ok('and the sticker survives the round trip', await p.evaluate(() =>
    !!document.querySelector('#chatScroll .chat-sticker')))
  await p.click('#chatScroll .chat-img')
  ok('pressing it opens it full screen', await waitFor(p, 'the viewer', () => !!document.getElementById('imgView')))
  await p.click('#imgView')
  ok('and pressing again closes it', await waitFor(p, 'it to close', () => !document.getElementById('imgView')))
}

console.log(NL + '-- an empty box still sends nothing --')
{
  const before = posted.length
  await p.click('#globalChatOverlay button[onclick*="__chatSend"]')
  await p.waitForTimeout(600)
  ok('nothing attached, nothing typed, nothing sent', posted.length === before, posted.length)
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
