// The liq price on the health row of the mobile position cards, in the combined view.
//
// Reported from a real phone: "the cards new added liq price is looking bad" -- the F12 phone
// view looked fine. The difference was the sort. Sorted by health the merged card's right side
// reads "Brrr 32.1%"; sorted by PnL it reads "Dark -$294.32 · Health 49%", which runs right under
// the mark column, and the liq price -- then hung absolutely under the mark -- printed on top of
// it. Now it is a slot in the row's own flow, so it cannot overlap anything. This drives both
// sorts on a merged card (two wallets holding SOL) and a single one (CRCL), at iPhone width.
//
// Hermetic: the exchange and the app's own server are stubbed, sockets closed.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { Wallet } from 'ethers'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const SHOTS = (process.argv.find(a => a.startsWith('--shots=')) || '').split('=')[1] || ''
const BASE = 'http://localhost:' + port + '/app'
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

// SOL long on both wallets at 20x cross, losing -- the shape of the report. CRCL on one only.
const MARK = { SOL: 84.3835, CRCL: 65.502 }
const pos = (coin, szi, entry, liq, lev, iso = false) => {
  const v = szi * MARK[coin], u = szi * (MARK[coin] - entry)
  return { type: 'oneWay', position: {
    coin, szi: String(szi), entryPx: String(entry), positionValue: String(v), unrealizedPnl: String(u),
    returnOnEquity: String(u / (szi * entry / lev)), liquidationPx: liq == null ? null : String(liq),
    leverage: { type: iso ? 'isolated' : 'cross', value: lev }, marginUsed: String(v / lev), maxLeverage: 20,
    cumFunding: { allTime: '0', sinceOpen: '0', sinceChange: '0' } } }
}
const POS = {
  [A1.toLowerCase()]: [pos('SOL', 12, 107.2, 71.0284, 20), pos('CRCL', 1, 95.5, 57.6416, 10, true)],
  [A2.toLowerCase()]: [pos('SOL', 13.4, 109.4, 68.0092, 20)],
}
const acct = (user) => {
  const ps = POS[user] ?? []
  const ntl = ps.reduce((a, x) => a + +x.position.positionValue, 0)
  const M = { accountValue: '1500', totalNtlPos: String(ntl), totalRawUsd: '1500', totalMarginUsed: String(ntl / 20) }
  return { marginSummary: M, crossMarginSummary: M, crossMaintenanceMarginUsed: String(ntl / 40), withdrawable: '500', assetPositions: ps, time: Date.now() }
}
const win = () => ({ accountValueHistory: [[Date.now() - 3600e3, '1500'], [Date.now(), '1500']], pnlHistory: [], vlm: '0' })
const UNIVERSE = [{ name: 'SOL', szDecimals: 2, maxLeverage: 20 }, { name: 'CRCL', szDecimals: 2, maxLeverage: 10 }]
const CTX = (c) => ({ markPx: String(MARK[c]), midPx: String(MARK[c]), oraclePx: String(MARK[c]), prevDayPx: String(MARK[c]), funding: '0', openInterest: '0', dayNtlVlm: '0' })
const reply = (body) => {
  const user = String(body?.user ?? '').toLowerCase()
  switch (body?.type) {
    case 'clearinghouseState': return acct(user)
    case 'webData2': return { clearinghouseState: acct(user), openOrders: [] }
    case 'portfolio': return ['day', 'week', 'month', 'allTime'].map(w => [w, win()])
    case 'spotClearinghouseState': return { balances: [] }
    case 'allMids': return { SOL: String(MARK.SOL), CRCL: String(MARK.CRCL) }
    case 'frontendOpenOrders': case 'openOrders': case 'userFills': case 'userFillsByTime':
    case 'userFunding': case 'userNonFundingLedgerUpdates': case 'subAccounts':
    case 'candleSnapshot': case 'extraAgents': case 'perpCategories': return []
    case 'outcomeMeta': return {}
    case 'meta': return { universe: UNIVERSE }
    case 'spotMeta': return { universe: [], tokens: [] }
    case 'metaAndAssetCtxs': return [{ universe: UNIVERSE }, UNIVERSE.map(u => CTX(u.name))]
    case 'spotMetaAndAssetCtxs': return [{ tokens: [], universe: [] }, []]
    case 'allPerpMetas': return [{ universe: UNIVERSE }]
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
  // A long-ish label is the stress case for the right-hand figure.
  localStorage.setItem('savedWallets', JSON.stringify([{ addr: a1, label: 'Brrr' }, { addr: a2, label: 'Insolvent' }]))
  localStorage.setItem('hliq_multi_accounts', JSON.stringify([{ addr: a1, label: 'Brrr' }, { addr: a2, label: 'Insolvent' }]))
}, { a1: A1, a2: A2, k: KEY })
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.loadDashboard)
await p.evaluate(() => { window.__comboRowsAfterMs = 1500 })
await p.evaluate((a) => { document.getElementById('walletInput').value = a; return window.loadDashboard() }, A1)
await waitFor(p, 'the account', () => document.getElementById('dashboard')?.classList.contains('active'))
await waitFor(p, 'the mobile shell', () => !!window.mobVTab, null, 30000)
await p.evaluate(() => window.__goAllAccounts?.())
const merged = await waitFor(p, 'the merged SOL card', () => /×2/.test(document.getElementById('mobVContent')?.textContent ?? '') && !!document.querySelector('#mobVContent .mob-liq'), null, 60000)
ok('two wallets holding SOL make a merged card with a liq price', merged, await p.evaluate(() => document.getElementById('mobVContent')?.textContent?.slice(0, 300)))

// Every liq slot against everything else on its own row: no two boxes may overlap.
const overlaps = () => p.evaluate(() => {
  const bad = []
  for (const slot of document.querySelectorAll('#mobVContent .mob-liq-slot')) {
    const row = slot.parentElement, S = slot.getBoundingClientRect()
    for (const sib of row.children) {
      if (sib === slot) continue
      const R = sib.getBoundingClientRect()
      if (S.left < R.right - 0.5 && R.left < S.right - 0.5 && S.top < R.bottom - 0.5 && R.top < S.bottom - 0.5)
        bad.push(`${slot.textContent.trim()} × ${sib.textContent.trim().slice(0, 40)}`)
    }
    if (S.right > row.getBoundingClientRect().right + 0.5) bad.push('runs off its row: ' + slot.textContent.trim())
  }
  return bad
})
const solCard = () => p.evaluate(() => {
  const card = [...document.querySelectorAll('#mobVContent [data-lp-coin="SOL"]')][0]
  const slot = card?.parentElement?.querySelector('.mob-liq-slot'), mark = card?.querySelector('[id^="pos-mark-"]')
  if (!slot || !mark) return null
  const L = slot.getBoundingClientRect(), M = mark.getBoundingClientRect()
  return { text: slot.textContent.replace(/\s+/g, ' ').trim(), dx: Math.round(Math.abs((L.left + L.right) / 2 - (M.left + M.right) / 2)) }
})

console.log(NL + '-- sorted by PnL (the phone in the report) --')
await p.evaluate(() => { window._mobVSortPos('unrl') })
await waitFor(p, 'the PnL summary', () => /Lowest PnL|Top PnL/i.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 15000)
const o1 = await overlaps()
ok('the liq price overlaps nothing on its row', o1.length === 0, o1)
const s1 = await solCard()
ok('the merged card shows the liquidation nearest the mark: $71.0284', /Liq \$71\.0284/.test(s1?.text ?? ''), s1)
// "when sort by pnl is selected stop showing the health in the card so instead is the pnl"
const pnlRow = await p.evaluate(() => [...document.querySelectorAll('#mobVContent [data-lp-coin="SOL"]')][0]?.parentElement?.querySelector('.mob-liq-slot')?.parentElement?.textContent.replace(/\s+/g, ' ').trim())
ok('sorted by PnL the row says the PnL, not the health', /PnL/i.test(pnlRow ?? '') && /-\$[\d,.]+/.test(pnlRow ?? '') && !/Health/i.test(pnlRow ?? ''), pnlRow)
if (SHOTS) {
  await p.evaluate(() => [...document.querySelectorAll('#mobVContent [data-lp-coin="SOL"]')][0]?.parentElement?.scrollIntoView({ block: 'center' }))
  const box = await p.evaluate(() => { const r = [...document.querySelectorAll('#mobVContent [data-lp-coin="SOL"]')][0].parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 220) } })
  await p.screenshot({ path: `${SHOTS}/poscardliq-pnl.png`, clip: box })
}

console.log(NL + '-- a live tick moves one account\'s PnL --')
{
  // "pnl is not matching": the merged card read "HYPE +$0.10" over a HYPE card reading +$0.00.
  // The featured figure was set at render and never ticked; the per-account cards did. Move
  // Brrr's SOL into profit (same size, so it is a tick, not a rebuild) and the merged card must
  // follow -- figure AND which account leads.
  const feat = () => p.evaluate(() => {
    const fv = document.querySelector('[id^="pos-fval-g-"]'), fa = document.querySelector('[id^="pos-facct-g-"]')
    return fv && fa ? { acct: fa.textContent.trim(), val: fv.textContent.trim() } : null
  })
  const card = (addr) => p.evaluate((a) => document.getElementById('pos-upnl-SOL-' + a.slice(2, 8))?.textContent.trim() ?? null, addr)
  const before = await feat()
  POS[A1.toLowerCase()][0] = pos('SOL', 12, 80.0, 50.0, 20)      // was entry 107.2: now +$52.60
  const moved = await waitFor(p, 'Brrr\'s card to tick into profit', (a) => /^\+\$52\.6/.test(document.getElementById('pos-upnl-SOL-' + a.slice(2, 8))?.textContent.trim() ?? ''), A1, 45000)
  ok('the account\'s own card ticks', moved, await card(A1))
  const f = await feat(), byAcct = { Brrr: await card(A1), Insolvent: await card(A2) }
  ok('and the merged card names the same figure that account\'s card shows', !!f && byAcct[f.acct] === f.val, { before, after: f, cards: byAcct })
}

console.log(NL + '-- sorted by health --')
await p.evaluate(() => { window._mobVSortPos('health') })
await waitFor(p, 'the health summary', () => /Worst health/i.test(document.getElementById('mobVContent')?.textContent ?? ''), null, 15000)
const o2 = await overlaps()
ok('still overlaps nothing', o2.length === 0, o2)
const s2 = await solCard()
// "ok but under mark price": with a short right-hand figure the slot sits under the mark.
ok('and with the short figure it sits under the mark price', s2 && s2.dx < 30, s2)
if (SHOTS) {
  const box = await p.evaluate(() => { const r = [...document.querySelectorAll('#mobVContent [data-lp-coin="SOL"]')][0].parentElement.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: Math.min(r.height, 220) } })
  await p.screenshot({ path: `${SHOTS}/poscardliq-health.png`, clip: box })
}

if (errs.length) { fail++; console.log('  FAIL page errors → ' + JSON.stringify(errs.slice(0, 4))) }
console.log(NL + `${pass} passed, ${fail} failed`)
await browser.close()
process.exit(fail ? 1 : 0)
