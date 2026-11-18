// Leaderboard → Popular, in the real app, both shells.
//
// Asked for: "a new section similar as real and paper, but for popular accounts ... public known
// entities". It must show every listed entity, sort them, open one to its source and its
// Visit / Copy / Copy-trade buttons -- and a real-board load landing late must not paint over it.
// Also: "add option to copy my own address here" -- the Accounts menu's saved wallets.
//
// Hermetic: /lb-known and Hyperliquid are stubbed.
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium, devices } from 'playwright'
import { KNOWN } from '../src/lbknown.js'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const SHOT = (process.argv.find(a => a.startsWith('--shot=')) || '').split('=')[1] || ''   // a folder for screenshots
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${n}${ok ? '' : ` → ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`}`)
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

// Numbers for all but the last entity: that one is "not in the feed" and must show dashes.
const per = (pnl, roi) => ({ d: pnl / 100, w: pnl / 10, m: pnl / 4, a: pnl })
const STATS = Object.fromEntries(KNOWN.slice(0, -1).map((k, i) => [k.addr, {
  v: 1e6 * (i + 1), p: per((i % 2 ? -1 : 1) * 1e6 * (KNOWN.length - i), 0), r: { d: 0.01, w: 0.02, m: 0.03, a: 0.5 }, x: { d: 1e6, w: 1e7, m: 1e8, a: 1e9 },
}]))
// Enough exchange for paper mode to boot; any other request type gets [] -- this test is about
// the leaderboard, not the market data.
const MIDS = { BTC: '90000', ETH: '3000', SOL: '150', HYPE: '40' }
const UNIVERSE = Object.keys(MIDS).map(name => ({ name, szDecimals: 2, maxLeverage: 20 }))
const CTX = UNIVERSE.map(u => { const px = MIDS[u.name]; return { funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] } })
const HL = { meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX], perpDexs: [null], allMids: MIDS,
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []] }
const SAVED = [{ addr: '0x' + 'ab'.repeat(20), label: 'Brrr' }, { addr: '0x' + 'cd'.repeat(20), label: 'Insolvent' }]

async function open(ctxOpts) {
  const ctx = await browser.newContext(ctxOpts)
  try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await ctx.route('**/lb-known', r => r.fulfill({ status: 200, contentType: 'application/json', json: { at: Date.now() - 120_000, stats: STATS } }))
  await ctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    return route.fulfill({ status: 200, contentType: 'application/json', json: b.type in HL ? HL[b.type] : [] })
  })
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: `http://localhost:${port}` })
  const p = await ctx.newPage()
  p.on('pageerror', e => errs.push(e.message))
  await p.goto(URL, { waitUntil: 'domcontentloaded' })
  await p.evaluate((saved) => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
    localStorage.setItem('savedWallets', JSON.stringify(saved))
  }, SAVED)
  await p.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(p, 'boot', () => !!window.__goPaper)
  await p.evaluate(() => window.__goPaper())
  await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
  return { ctx, p }
}

const board = (p) => p.evaluate(() => [...document.querySelectorAll('.lbk-row')].filter(r => r.offsetParent).map(r => ({
  addr: r.dataset.lbk, name: r.querySelector('.lbk-name .notranslate')?.textContent, main: r.querySelector('.lbk-main')?.textContent.trim() })))

const errs = []
const browser = await chromium.launch()

console.log('\n-- desktop --')
{
  const { ctx, p } = await open({ viewport: { width: 1500, height: 950 } })
  await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
  await p.evaluate(() => window.switchTab('leaderboard'))
  await waitFor(p, 'the mode bar', () => /Popular/.test(document.getElementById('leaderboardRoot')?.textContent ?? ''))
  await p.evaluate(() => window.__lbDeskMode('popular'))
  await waitFor(p, 'the rows with numbers', () => document.querySelectorAll('#leaderboardRoot .lbk-row').length > 0 && !document.querySelector('#leaderboardRoot .lbk-status'))
  const rows = await board(p)
  t('every known entity is listed', rows.length, KNOWN.length)
  t('ranked by all-time PnL, the entity without numbers last', rows[rows.length - 1].name, KNOWN[KNOWN.length - 1].name)
  t('which shows a dash, not $0', rows[rows.length - 1].main, '—')
  t('and the leader is the biggest PnL', rows[0].main.startsWith('+$'), true)
  // By address: two rows are both "Abraxas Capital".
  const want = KNOWN.filter(k => STATS[k.addr]).sort((a, b) => STATS[b.addr].p.a - STATS[a.addr].p.a).map(k => k.addr)
  t('in descending order of all-time PnL', rows.slice(0, -1).map(r => r.addr), want)

  await p.evaluate(() => window.__lbKnownSet('sort', 'value'))
  const byVal = await board(p)
  t('sorting by value reorders it', byVal[0].name, KNOWN[KNOWN.length - 2].name)
  await p.evaluate(() => window.__lbKnownSet('sort', 'pnl'))

  await p.locator('#leaderboardRoot .lbk-row').first().click()
  const x = await p.evaluate(() => {
    const el = document.querySelector('#leaderboardRoot .lbk-x')
    return el && { src: el.querySelector('.lbk-why a')?.href ?? '', blank: el.querySelector('.lbk-why a')?.target,
      grid: el.querySelectorAll('.lbk-grid > span').length, visit: /Visit/.test(el.textContent), copy: /Copy trade/.test(el.textContent) }
  })
  t('a row opens to its source link, in a new tab', !!x && /^https:\/\//.test(x.src) && x.blank === '_blank', true)
  t('with every period (a blank corner, then 4 rows × 4 cells)', x?.grid, 17)
  t('and Visit / Copy trade, as on the Real board', [x?.visit, x?.copy], [true, true])
  if (SHOT) await p.locator('#leaderboardRoot').screenshot({ path: `${SHOT}/lbk-desktop.png` })

  // A real-board load landing after the switch must not replace Popular.
  await p.evaluate(() => window.__lbDeskMode('real'))
  await p.evaluate(() => window.__lbDeskMode('popular'))
  await p.waitForTimeout(800)
  t('switching back and forth leaves Popular showing', await p.evaluate(() => !!document.querySelector('#leaderboardRoot .lbk')), true)

  console.log('\n-- desktop: copy your own address from the Accounts menu --')
  const btns = await p.evaluate(() => [...document.querySelectorAll('.ws-wallet-row .ws-addr-copy')].map(b => b.closest('.ws-wallet-row').dataset.wsAddr))
  t('each saved wallet has a copy button', btns, SAVED.map(w => w.addr))
  await p.evaluate(() => document.querySelector('.ws-wallet-row .ws-addr-copy').click())
  await waitFor(p, 'the clipboard', async () => (await navigator.clipboard.readText()).startsWith('0x'), null, 4000)
  t('it copies that wallet\'s full address', await p.evaluate(() => navigator.clipboard.readText()), SAVED[0].addr)
  t('without switching to it', await p.evaluate(() => document.getElementById('walletInput')?.value ?? ''), '')
  await ctx.close()
}

console.log('\n-- phone --')
{
  const { ctx, p } = await open({ ...devices['iPhone 14 Pro'] })
  await waitFor(p, 'the mobile shell', () => !!window.mobVGoTab)
  await p.evaluate(() => window.mobVGoTab('leaderboard'))
  await waitFor(p, 'the mode bar', () => /Popular/.test(document.getElementById('mobVContent')?.textContent ?? ''))
  await p.evaluate(() => window._mobVLbMode('popular'))
  await waitFor(p, 'the rows', () => document.querySelectorAll('#mobVContent .lbk-row').length > 0 && !document.querySelector('#mobVContent .lbk-status'))
  t('every known entity is listed', (await board(p)).length, KNOWN.length)
  const fit = await p.evaluate(() => { const r = document.querySelector('#mobVContent .lbk-row').getBoundingClientRect(); return r.right <= innerWidth + 0.5 && document.documentElement.scrollWidth <= innerWidth })
  t('rows fit the phone, no sideways scroll', fit, true)
  await p.evaluate(() => window.__lbKnownSet('period', 'd'))
  if (SHOT) { await p.locator('#mobVContent .lbk-row').nth(1).click(); await p.screenshot({ path: `${SHOT}/lbk-phone.png`, fullPage: false }) }
  t('the 24h chip is the one lit', await p.evaluate(() => [...document.querySelectorAll('#mobVContent .lbk-chip.on')].map(b => b.textContent)), ['24h', 'PnL'])
  await ctx.close()
}

t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
