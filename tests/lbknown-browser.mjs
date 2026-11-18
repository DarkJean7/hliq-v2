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

// Live rows for all but the last entity: that one has no data and must show as such, not as $0.
// Values rise with the index; net PnL alternates sign, so value order and PnL order differ.
const pos = (coin, szi, upnl) => ({ position: { coin, szi: String(szi), entryPx: '10', positionValue: String(Math.abs(szi) * 12), unrealizedPnl: String(upnl), liquidationPx: '5', leverage: { type: 'cross', value: 3 }, returnOnEquity: '0.2', marginUsed: '1000' } })
const ROWS = Object.fromEntries(KNOWN.map((k, i) => [k.addr, i === KNOWN.length - 1 ? null : (() => {
  const net = (i % 2 ? -1 : 1) * 1e6 * (KNOWN.length - i), unreal = 2e5 * (i + 1)
  return { addr: k.addr, accountValue: 1e6 * (i + 1) + 5e6, netPnl: net, unrealizedPnl: unreal, realizedPnl: net - unreal,
    periods: { d: net / 100, w: net / 10, m: net / 4, a: net }, totalVolume: 1e9, positions: [pos('HYPE', 1000 * (i + 1), unreal)], openOrders: [], outcomes: [] }
})()]))
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
  await ctx.route('**/lb-known', r => r.fulfill({ status: 200, contentType: 'application/json', json: { at: Date.now() - 120_000, rows: ROWS } }))
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

const errs = []
const browser = await chromium.launch()
const named = KNOWN.filter(k => ROWS[k.addr])
const byValue = [...named].sort((a, b) => ROWS[b.addr].accountValue - ROWS[a.addr].accountValue).map(k => k.addr)
const byNet = [...named].sort((a, b) => ROWS[b.addr].netPnl - ROWS[a.addr].netPnl).map(k => k.addr)

console.log('\n-- desktop --')
{
  const { ctx, p } = await open({ viewport: { width: 1500, height: 950 } })
  await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
  await p.evaluate(() => window.switchTab('leaderboard'))
  await waitFor(p, 'the mode bar', () => /Popular/.test(document.getElementById('leaderboardRoot')?.textContent ?? ''))
  t('Popular sits between Real and Paper', await p.evaluate(() => [...document.querySelectorAll('#leaderboardRoot .lb-toolbar button')].map(b => b.textContent.trim()).filter(x => /Real|Popular|Paper/.test(x)).slice(0, 3)), ['Real', '⭐ Popular', '📝 Paper'])
  await p.evaluate(() => window.__lbDeskMode('popular'))
  await waitFor(p, 'the rows', () => document.querySelectorAll('#leaderboardRoot .lb-table tr.lb-row').length > 0)
  const rows = () => p.evaluate(() => [...document.querySelectorAll('#leaderboardRoot tr.lb-row')].map(r => ({
    label: r.querySelector('.lb-label')?.textContent.trim(), val: r.querySelector('.lb-val')?.textContent.trim(),
    uid: (r.getAttribute('onclick') ?? '').match(/'(lbx-[^']+)'/)?.[1] })))
  const d0 = await rows()
  t('every known entity is a Real-board row', d0.length, KNOWN.length)
  t('the one without data says so instead of $0', d0.some(r => r.label === KNOWN.at(-1).name && /Error|—/.test(r.val)), true)
  await p.evaluate(() => window.__lbSort('value'))
  const dv = await p.evaluate(() => [...document.querySelectorAll('#leaderboardRoot tr.lb-row')].map(r => r.querySelector('.lb-val')?.textContent.trim()))
  t('sorting by value, highest first, with the Real board sort bar', dv[0], '$' + ROWS[byValue[0]].accountValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
  const first = (await rows())[0]
  await p.evaluate((uid) => window.__lbToggle(uid, document.querySelector('tr.lb-row[onclick*="' + uid + '"]')), first.uid)
  const x = await p.evaluate((uid) => {
    const el = document.getElementById(uid)
    return el && { shown: el.style.display !== 'none', src: el.querySelector('.lbk-why a')?.href ?? '', blank: el.querySelector('.lbk-why a')?.target,
      periods: el.querySelectorAll('.lbk-per').length, visit: /Visit/.test(el.textContent), copy: /Copy trade/.test(el.textContent),
      pos: /HYPE/.test(el.textContent), remove: /Remove|Rename|Unhide|🙈/.test(el.textContent) }
  }, first.uid)
  t('a row opens', x?.shown, true)
  t('to its source link, in a new tab', !!x && x.src.startsWith('https://') && x.blank === '_blank', true)
  t('its PnL for 24h / 7d / 30d / All', x?.periods, 4)
  t('its positions and Visit / Copy trade, as on the Real board', [x?.pos, x?.visit, x?.copy], [true, true, true])
  t('and no remove / rename / hide (they are not on the real board)', x?.remove, false)
  await p.evaluate(() => window.__lbSort('roe'))

  // A real-board load landing after the switch must not replace Popular.
  await p.evaluate(() => window.__lbDeskMode('real'))
  await p.evaluate(() => window.__lbDeskMode('popular'))
  await p.waitForTimeout(800)
  t('switching back and forth leaves Popular showing', await p.evaluate(() => /known accounts/.test(document.querySelector('#leaderboardRoot .lb-count')?.textContent ?? '')), true)
  if (SHOT) await p.locator('#leaderboardRoot').screenshot({ path: SHOT + '/lbk-desktop.png' })

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
  t('Popular sits between Real and Paper', await p.evaluate(() => [...document.querySelectorAll('#mobVContent button')].map(b => b.textContent.trim()).filter(x => /^(Real|⭐ Popular|📝 Paper)$/.test(x))), ['Real', '⭐ Popular', '📝 Paper'])
  await p.evaluate(() => window._mobVLbMode('popular'))
  await waitFor(p, 'the rows', () => document.querySelectorAll('#mobVContent .mob-v-row').length > 0)
  const names = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .mob-v-row .mob-v-row-name')].map(e => e.textContent.trim()))
  t('every known entity is a Real-board row', names.length, KNOWN.length)
  t('no "My name" / "Add me" -- these are not our users', await p.evaluate(() => /My name|Add me/.test(document.getElementById('mobVContent').textContent)), false)
  await p.evaluate(() => window._mobVLbSort('net'))
  const nets = await p.evaluate(() => [...document.querySelectorAll('#mobVContent .mob-v-row .mob-v-row-val')].map(e => e.textContent.trim()))
  t('the sort chips re-sort Popular (by net PnL), the no-data row last', nets[0].startsWith('+$') && nets.at(-1) === '—', true)
  t('it fits the phone, no sideways scroll', await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const id = 'lb-' + byNet[0].slice(2, 10)
  await p.evaluate((id) => window._mobVToggleRow(id), id)
  t('a row opens to its source and periods', await p.evaluate((id) => { const el = document.getElementById('mrd-' + id); return !!el && el.style.display !== 'none' && el.querySelectorAll('.lbk-per').length === 4 && !!el.querySelector('.lbk-why a') }, id), true)
  if (SHOT) await p.screenshot({ path: SHOT + '/lbk-phone.png' })
  await ctx.close()
}

t('no page errors', errs, [])
await browser.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
