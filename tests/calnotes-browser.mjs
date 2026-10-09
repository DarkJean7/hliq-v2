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
const BASE = 'http://localhost:' + port + '/app'
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

// A real 1x1 JPEG. The app re-draws every picked file through a canvas, so what matters is
// that this DECODES — a made-up buffer would fail in the browser rather than in the app.
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
  // The wording gained ", or add an image" when pictures did: a picture alone is a note.
  ok('an empty note is refused', /Write a title, some text, or add an image/.test(await p.textContent('#calNoteStatus')))
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

console.log(NL + '-- the time it was written, and a picture pinned to it --')
{
  // Asked for: "i wrote a note today this morning at 10am and one at 7pm — I want them to
  // display the timestamp like if they were a message", and pictures in the same breath.
  //
  // Two notes seeded an hour apart, because one note cannot show that two of them are told
  // apart. Seeded rather than written, since the clock is what is under test.
  const t10 = new Date(); t10.setHours(10, 4, 0, 0)
  const t19 = new Date(); t19.setHours(19, 12, 0, 0)
  const seeded = [
    { id: 'aaa111', day: DAY, title: 'Morning', body: 'Plan for the open', imgs: [], created: t10.getTime(), updated: t10.getTime() },
    { id: 'bbb222', day: DAY, title: 'Evening', body: 'How it went',      imgs: [], created: t19.getTime(), updated: t19.getTime() },
  ]
  const { ctx, p } = await open({ ...devices['iPhone 14 Pro'] }, seeded)
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)
  await p.evaluate(() => window.mobVTab('calendar'))
  await waitFor(p, 'the calendar', () => !!document.querySelector('#mobCalRoot .cal-grid'))
  await waitFor(p, 'the month cards', () => document.querySelectorAll('[data-cal-notes="mobCalRoot"] .cal-note-card').length === 2)

  const times = await p.evaluate(() => [...document.querySelectorAll('[data-cal-notes="mobCalRoot"] .cal-note-time')].map(e => e.textContent.trim()))
  ok('every note carries a time', times.length === 2 && times.every(x => /\d{1,2}:\d{2}/.test(x)), times)
  ok('and the morning one is not the evening one', times[0] !== times[1], times)
  ok('to the minute, not the hour', times.some(x => /:04/.test(x)) && times.some(x => /:12/.test(x)), times)
  // The time belongs at the END of the header row, where a message puts it.
  ok('shown after the title, not before it', await p.evaluate(() => {
    const card = document.querySelector('[data-cal-notes="mobCalRoot"] .cal-note-card')
    const title = card?.querySelector('.cal-note-title')?.getBoundingClientRect()
    const time  = card?.querySelector('.cal-note-time')?.getBoundingClientRect()
    return !!(title && time && time.left > title.left)
  }))

  // ── a picture ──
  await p.click(`#mobCalRoot .cal-cell[data-key="${DAY}"]`)
  await waitFor(p, 'the day panel', () => !!document.querySelector('#mobCalDetail .cal-note-add'))
  const dayTimes = await p.evaluate(() => [...document.querySelectorAll('#mobCalDetail .cal-note-time')].map(e => e.textContent.trim()))
  ok('the day panel shows them too', dayTimes.length === 2, dayTimes)
  // The panel's own header already says which day it is. Scoped to the NOTES: the day's
  // chart row is built from the same card markup on purpose (it is the same gesture on the
  // same screen) and that one does name the day, because it is the only thing that says
  // which day the curve is of.
  ok('without repeating the date on every card', !(await p.evaluate(() =>
    [...document.querySelectorAll('#mobCalDetail .cal-day-notes .cal-note-date')].some(e => e.textContent.includes(','))
  )))

  await p.click('#mobCalDetail .cal-note-add')
  await waitFor(p, 'the editor', () => document.getElementById('calNoteSheet')?.style.display === 'flex')
  ok('the editor offers a picture', await p.evaluate(() => !!document.getElementById('calNoteAddImg')))
  await p.setInputFiles('#calNoteFile', { name: 'chart.jpg', mimeType: 'image/jpeg', buffer: JPEG })
  const thumbed = await waitFor(p, 'the thumbnail', () => {
    const t = document.querySelector('.cal-note-edit-img img')
    return !!t && (t.getAttribute('src') || '').startsWith('data:image/jpeg')
  }, null, 15000)
  ok('a picked file becomes a thumbnail', thumbed)
  // Re-drawn through a canvas, so whatever was picked is now one predictable JPEG — which
  // is what drops the EXIF a phone photo arrives with. A PNG in would come out jpeg too.
  ok('re-encoded as a jpeg before anything stores it', await p.evaluate(() =>
    (document.querySelector('.cal-note-edit-img img')?.getAttribute('src') ?? '').startsWith('data:image/jpeg')))

  // A picture alone is a note: "here is the chart" needs no title.
  await p.click('#calNoteSheet button[onclick*="__calNoteSave"]')
  await waitFor(p, 'the editor to close', () => document.getElementById('calNoteSheet')?.style.display === 'none')
  // BY ID, not "the last card": notes are ordered by when they were written, and the two
  // seeded above are timed 10:04 and 19:12 — a run before 10am writes this one FIRST.
  const noteId = await p.evaluate(() =>
    (JSON.parse(localStorage.getItem('hliq_cal_notes_v1') || '[]').find(n => (n.imgs ?? []).length) ?? {}).id ?? '')
  ok('the new note was saved', /^[a-z0-9]{6,24}$/i.test(noteId), noteId)
  const shown = await waitFor(p, 'the picture on the card', (id) =>
    !!document.querySelector(`#mobCalDetail [data-note="${id}"] .cal-note-img[src]`), noteId, 15000)
  ok('a picture alone is a note, and it shows on the card', shown)

  // The bytes are in IndexedDB and the note holds only the id — so this is the assertion
  // that the two halves really find each other again.
  ok('the note stores an id, never the bytes', await p.evaluate(() => {
    const list = JSON.parse(localStorage.getItem('hliq_cal_notes_v1') || '[]')
    const withImg = list.filter(n => (n.imgs ?? []).length)
    return withImg.length === 1 && /^[a-z0-9]{8,16}$/i.test(withImg[0].imgs[0])
  }))
  ok('and localStorage is not carrying a picture', await p.evaluate(() =>
    !(localStorage.getItem('hliq_cal_notes_v1') || '').includes('data:image')))

  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.loadDashboard)
  await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, ADDR)
  await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
  await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)
  await p.evaluate(() => window.mobVTab('calendar'))
  await waitFor(p, 'the calendar', () => !!document.querySelector('#mobCalRoot .cal-grid'))
  await p.evaluate((id) => document.querySelector(`[data-cal-notes="mobCalRoot"] [data-note="${id}"] .cal-note-head`)?.click(), noteId)
  ok('and it is still there on the next load', await waitFor(p, 'the picture again', (id) =>
    !!document.querySelector(`[data-cal-notes="mobCalRoot"] [data-note="${id}"] .cal-note-img[src^="data:image"]`), noteId, 15000))

  // Deleting the note has to take the bytes with it, or the store grows forever.
  const before = await p.evaluate(() => new Promise(res => {
    const r = indexedDB.open('hliq_img', 1)
    r.onsuccess = () => { const q = r.result.transaction('imgs').objectStore('imgs').getAllKeys(); q.onsuccess = () => res(q.result.length) }
    r.onerror = () => res(-1)
  }))
  ok('the store holds it', before === 1, before)
  await p.evaluate((id) => { window.__calNoteDelete(id, 'mobCalRoot'); window.__calNoteDelete(id, 'mobCalRoot') }, noteId)
  const swept = await waitFor(p, 'the bytes to go too', () => new Promise(res => {
    const r = indexedDB.open('hliq_img', 1)
    r.onsuccess = () => { const q = r.result.transaction('imgs').objectStore('imgs').getAllKeys(); q.onsuccess = () => res(q.result.length === 0) }
    r.onerror = () => res(false)
  }), null, 15000)
  ok('deleting the note takes the picture off the device too', swept)

  if (SHOT) await p.screenshot({ path: SHOT + '/calnotes-images.png', fullPage: true })
  await ctx.close()
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
