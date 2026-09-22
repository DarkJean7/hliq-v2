// Calendar notes, in a real page: press a day, write a note, see it as a collapsed card under
// the calendar, open it, edit it, delete it — on mobile and on desktop. Rules are covered in
// tests/suites/calnotes.test.mjs; this is the round trip.
//
// Hermetic: the exchange is stubbed, and there are no fills, so every day is a QUIET day —
// which is the case that matters most, since a quiet day used to be impossible to press.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
//       CALNOTES_SHOT=<dir> to save screenshots of both shells.
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const BASE = 'http://localhost:' + port + '/'
const ADDR = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const KEY  = Wallet.createRandom().privateKey
const NL   = String.fromCharCode(10)
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const SHOT = process.env.CALNOTES_SHOT || ''

let pass = 0, fail = 0
const ok = (n, cond, got = '') => {
  cond ? pass++ : fail++
  console.log('  ' + (cond ? 'PASS ' : 'FAIL ') + n + (cond ? '' : ' → ' + JSON.stringify(got)))
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
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
const blockHlSockets = async (c) => { try { await c.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {} }

// Today's key, the way the calendar builds it (local time), and the header the note carries.
const now = new Date()
const DAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
const DATE_LABEL = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`

const errs = []
const browser = await chromium.launch()

async function open(ctxOpts, notes = null) {
  const ctx = await browser.newContext(ctxOpts)
  await blockHlSockets(ctx)
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: HL[b.type] ?? {} })
  })
  await ctx.route('**/api/**', (route) => route.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/offexprice**', (route) => route.fulfill({ status: 200, json: { prices: {} } }))
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.evaluate(({ a, k, notes }) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1')
    ;['hliq_onboard_welcomed_v1', 'hliq_onboard_tour_v1', 'hliq_install_nudge_v2'].forEach(x => localStorage.setItem(x, '1'))
    localStorage.setItem('hliq_ann_dismissed', JSON.stringify(['*']))
    localStorage.setItem('hliq_agent_key_' + a.toLowerCase(), k)
    localStorage.setItem('savedWallets', JSON.stringify([{ addr: a, label: 'Main' }]))
    if (notes) localStorage.setItem('hliq_cal_notes_v1', JSON.stringify(notes))
  }, { a: ADDR, k: KEY, notes })
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  return { ctx, p }
}

const cardsText = (p, root) => p.evaluate((r) => document.querySelector(`[data-cal-notes="${r}"]`)?.textContent ?? '', root)

console.log(NL + '-- mobile: write a note on a quiet day --')
{
  const { ctx, p } = await open({ ...devices['iPhone 14 Pro'] })
  const openCal = async () => {
    await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)
    await p.evaluate(() => window.mobVTab('calendar'))
    await waitFor(p, 'the calendar', () => !!document.querySelector('#mobCalRoot .cal-grid'))
  }
  await openCal()
  ok('no notes yet: nothing under the calendar', (await cardsText(p, 'mobCalRoot')).trim() === '')

  // Today has no trades — it used to be a dead square.
  await p.click(`#mobCalRoot .cal-cell[data-key="${DAY}"]`)
  await waitFor(p, 'the day panel', () => /No activity/.test(document.getElementById('mobCalDetail')?.textContent ?? ''))
  const panel = await p.textContent('#mobCalDetail')
  ok('a quiet day opens', /No activity on this day/.test(panel), panel.slice(0, 120))
  ok('offering, quietly, to write a note', /\+ Add note/.test(panel))
  ok('and nothing opened on its own', await p.evaluate(() => (document.getElementById('calNoteSheet')?.style.display ?? 'none') === 'none'))

  await p.click('#mobCalDetail .cal-note-add')
  await waitFor(p, 'the editor', () => document.getElementById('calNoteSheet')?.style.display === 'flex')
  ok('the editor carries the date', (await p.textContent('#calNoteSheet')).includes(DATE_LABEL))
  await p.click('#calNoteSheet button[onclick*="__calNoteSave"]')
  ok('an empty note is refused', /Write a title or some text/.test(await p.textContent('#calNoteStatus')))
  await p.fill('#calNoteTitle', 'Stuck to the plan')
  await p.fill('#calNoteBody', 'Took the ADA short off at the level.\nNo revenge trades.')
  await p.click('#calNoteSheet button[onclick*="__calNoteSave"]')
  await waitFor(p, 'the editor to close', () => document.getElementById('calNoteSheet')?.style.display === 'none')

  const dayPanel = await p.textContent('#mobCalDetail')
  ok('the day panel shows it', /Notes[\s\S]*Stuck to the plan/.test(dayPanel), dayPanel.slice(0, 200))
  ok('the day is marked on the grid', await p.evaluate((d) => document.querySelector(`#mobCalRoot .cal-cell[data-key="${d}"]`)?.classList.contains('cal-has-note'), DAY))
  const under = await cardsText(p, 'mobCalRoot')
  ok('and it is a card under the calendar, with its header', under.includes('Stuck to the plan') && under.includes(DATE_LABEL), under)
  ok('the cards sit below the day panel', await p.evaluate(() => {
    const d = document.getElementById('mobCalDetail'), b = document.querySelector('[data-cal-notes="mobCalRoot"]')
    return !!(d && b && (d.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING))
  }))

  ok('with the same 16px gutter as the day panel', await p.evaluate(() => {
    const c = document.querySelector('[data-cal-notes="mobCalRoot"] .cal-note-card')?.getBoundingClientRect()
    const d = document.getElementById('mobCalDetail')?.getBoundingClientRect()
    return !!(c && d && Math.abs(c.left - d.left) <= 1 && Math.abs(c.right - d.right) <= 1 && c.left >= 15)
  }))

  // Close the day, then a fresh load: kept, and collapsed.
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await openCal()
  await waitFor(p, 'the card', () => /Stuck to the plan/.test(document.querySelector('[data-cal-notes="mobCalRoot"]')?.textContent ?? ''))
  const card = () => p.evaluate(() => document.querySelector('[data-cal-notes="mobCalRoot"] .cal-note-card')?.textContent ?? '')
  ok('kept across a reload', /Stuck to the plan/.test(await card()))
  ok('collapsed: header only', !/No revenge trades/.test(await card()), await card())

  await p.click('[data-cal-notes="mobCalRoot"] .cal-note-head')
  await waitFor(p, 'the note to open', () => /No revenge trades/.test(document.querySelector('[data-cal-notes="mobCalRoot"] .cal-note-card')?.textContent ?? ''))
  ok('pressing it opens the note', /Took the ADA short off at the level\.\s*No revenge trades\./.test(await card()), await card())
  if (SHOT) await p.screenshot({ path: SHOT + '/calnotes-mobile.png', fullPage: false })

  await p.click('[data-cal-notes="mobCalRoot"] .cal-note-actions button:not(.del)')
  await waitFor(p, 'the editor', () => document.getElementById('calNoteSheet')?.style.display === 'flex')
  ok('editing opens it filled in', (await p.inputValue('#calNoteTitle')) === 'Stuck to the plan')
  await p.fill('#calNoteBody', 'Edited: one clean trade.')
  await p.click('#calNoteSheet button[onclick*="__calNoteSave"]')
  await waitFor(p, 'the edit', () => /one clean trade/.test(document.querySelector('[data-cal-notes="mobCalRoot"]')?.textContent ?? ''))
  ok('an edit replaces the note, not adds one', await p.evaluate(() => JSON.parse(localStorage.getItem('hliq_cal_notes_v1')).length) === 1)

  await p.click('[data-cal-notes="mobCalRoot"] .cal-note-actions .del')
  ok('delete asks once more, in place', /Press again/.test(await p.textContent('[data-cal-notes="mobCalRoot"] .cal-note-actions .del')))
  await p.click('[data-cal-notes="mobCalRoot"] .cal-note-actions .del')
  await waitFor(p, 'the card to go', () => !document.querySelector('[data-cal-notes="mobCalRoot"] .cal-note-card'))
  ok('and then it is gone', (await cardsText(p, 'mobCalRoot')).trim() === '')
  ok('along with the marker', await p.evaluate((d) => !document.querySelector(`#mobCalRoot .cal-cell[data-key="${d}"]`)?.classList.contains('cal-has-note'), DAY))
  await ctx.close()
}

console.log(NL + '-- desktop: the same notes, the same way --')
{
  const seeded = [{ id: 'deskno1', day: DAY, title: 'Desk note', body: 'Written on the phone.', created: 1, updated: 1 }]
  const { ctx, p } = await open({ viewport: { width: 1440, height: 950 } }, seeded)
  await waitFor(p, 'the tab switcher', () => typeof window.switchTab === 'function')
  await p.evaluate(() => window.switchTab('calendar', null))
  await waitFor(p, 'the calendar', () => !!document.querySelector('#calendarRoot .cal-grid'))
  await waitFor(p, 'the card', () => /Desk note/.test(document.querySelector('[data-cal-notes="calendarRoot"]')?.textContent ?? ''))
  const under = await cardsText(p, 'calendarRoot')
  ok('the month\'s notes are cards under the calendar', /Notes · /.test(under) && under.includes('Desk note') && under.includes(DATE_LABEL), under)
  ok('the day is marked', await p.evaluate((d) => document.querySelector(`#calendarRoot .cal-cell[data-key="${d}"]`)?.classList.contains('cal-has-note'), DAY))
  await p.click(`#calendarRoot .cal-cell[data-key="${DAY}"]`)
  await waitFor(p, 'the day panel', () => /Desk note/.test(document.getElementById('calDetail')?.textContent ?? ''))
  const panel = await p.textContent('#calDetail')
  ok('pressing the day shows its notes, and the option to add another', /Notes[\s\S]*Desk note[\s\S]*\+ Add note/.test(panel), panel.slice(0, 200))
  if (SHOT) await p.screenshot({ path: SHOT + '/calnotes-desktop.png', fullPage: true })
  await ctx.close()
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
