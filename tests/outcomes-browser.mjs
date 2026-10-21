// Outcomes: market chips, and countdowns that do not stall the page.
//
// Asked: "the outcomes tab is also stuttering. lets also add like similar as our watch cards, but
// in outcomes for the available markets just similar as the image of outcome.xyz. that would
// allow to just see the outcomes available in the selected market".
//
//   chips       one per underlying with a live outcome; pressing one shows only its outcomes, and
//               pressing it again (or All markets) shows everything
//   countdowns  the scroll-jank telemetry named a one-second loop rewriting EVERY market's
//               countdown (12,218 nodes in a four-second scroll). They now change text in place,
//               only when it changed, only on screen — so a tick replaces no elements at all.
//
// The fixture is a slice of Hyperliquid's live outcomeMeta (2026-10-21): the BTC/ETH/SOL/HYPE
// daily binaries, the BTC range question with its legs, and two sports outcomes with no
// underlying. Expiries are moved a few hours ahead so every countdown is live during the run.
//
// Run:  npm run test:browser        (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i

const SOON = (() => { const d = new Date(Date.now() + 5 * 3600e3), p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}` })()
const live = (desc) => desc.replace(/expiry:\d{8}-\d{4}/, 'expiry:' + SOON)
const YN = [{ name: 'Yes' }, { name: 'No' }]
const OUTCOME_META = {
  outcomes: [
    { outcome: 14730, name: 'Recurring', description: live('class:priceBinary|underlying:SOL|expiry:20261021-0600|targetPrice:104.5|period:1d'), sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14729, name: 'Recurring', description: live('class:priceBinary|underlying:ETH|expiry:20261021-0600|targetPrice:2395.7|period:1d'), sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14731, name: 'Recurring', description: live('class:priceBinary|underlying:HYPE|expiry:20261021-0600|targetPrice:78.658|period:1d'), sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14726, name: 'Recurring', description: live('class:priceBinary|underlying:BTC|expiry:20261021-0600|targetPrice:81697|period:1d'), sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14734, name: 'Recurring Named Outcome', description: 'index:0', sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14735, name: 'Recurring Named Outcome', description: 'index:1', sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14736, name: 'Recurring Named Outcome', description: 'index:2', sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14733, name: 'Recurring Fallback', description: 'other', sideSpecs: YN, quoteToken: 'USDC' },
    { outcome: 14200, name: 'template:sportsContestParticipant2', description: 'participant:Lyon', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
    { outcome: 1488, name: 'template:sportsTournamentParticipant', description: 'participant:Buffalo Bills', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
  ],
  questions: [{ question: 485, name: 'Recurring', description: live('class:priceBucket|underlying:BTC|expiry:20261021-0600|priceThresholds:80063,83330|period:1d'),
    fallbackOutcome: 14733, namedOutcomes: [14734, 14735, 14736], settledNamedOutcomes: [] }],
  deployers: [], feeScale: '1.0',
}
const MIDS = { BTC: '82000', ETH: '2400', SOL: '105', HYPE: '80' }
for (const o of OUTCOME_META.outcomes) { MIDS['#' + (o.outcome * 10)] = '0.5'; MIDS['#' + (o.outcome * 10 + 1)] = '0.5' }
// The markets paper mode needs to start at all.
const UNIVERSE = ['BTC', 'ETH', 'SOL', 'HYPE'].map(name => ({ name, szDecimals: 2, maxLeverage: 20 }))
const CTX = UNIVERSE.map(u => { const px = MIDS[u.name]; return { funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] } })
const BASE = {
  meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX], perpDexs: [null],
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, []],
}

let pass = 0, fail = 0
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  ok ? pass++ : fail++
  console.log('  ' + (ok ? 'PASS ' : 'FAIL ') + n + ' → ' + JSON.stringify(got) + (ok ? '' : ' (wanted ' + JSON.stringify(want) + ')'))
}
const waitFor = async (p, label, fn, arg, ms = 25000) => {
  const t0 = Date.now()
  for (;;) {
    try { if (await p.evaluate(fn, arg)) return true } catch {}
    if (Date.now() - t0 > ms) { console.log('  (timed out waiting for ' + label + ')'); return false }
    await p.waitForTimeout(150)
  }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
try { await ctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
await ctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
await ctx.route(HL_HOST, (route) => {
  let b = {}
  try { b = JSON.parse(route.request().postData() || '{}') } catch {}
  const json = b.type === 'outcomeMeta' ? OUTCOME_META : b.type === 'allMids' ? MIDS
    : b.type in BASE ? BASE[b.type]
    : ['candleSnapshot', 'perpCategories', 'userFills', 'frontendOpenOrders', 'allPerpMetas'].includes(b.type) ? [] : {}
  return route.fulfill({ status: 200, contentType: 'application/json', json })
})
const p = await ctx.newPage()
const errs = []
p.on('pageerror', e => errs.push(e.message))

await p.goto(URL, { waitUntil: 'domcontentloaded' })
await p.evaluate(() => {
  localStorage.clear()
  localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
  localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
})
await p.reload({ waitUntil: 'domcontentloaded' })
await waitFor(p, 'boot', () => !!window.__goPaper)
await p.evaluate(() => window.__goPaper())
await waitFor(p, 'the dashboard', () => document.getElementById('dashboard')?.classList.contains('active'))
await p.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
await p.evaluate(() => window.switchTab('outcomes'))
await waitFor(p, 'the outcome cards', () => document.querySelectorAll('#ocGrid .oc-card').length >= 4)

console.log('\n-- a chip per market that has outcomes --')
const chips = await p.evaluate(() => [...document.querySelectorAll('#ocUnds .oc-und')].map(b => b.dataset.und))
t('All markets comes first', chips[0], 'all')
t('then each underlying with a live outcome', [...chips.slice(1)].sort(), ['BTC', 'ETH', 'HYPE', 'SOL'])
const shown = () => p.evaluate(() => [...document.querySelectorAll('#ocGrid .oc-card')].filter(c => c.style.display !== 'none').map(c => c.dataset.und || '-'))

console.log('\n-- pressing one shows just its outcomes --')
const all = await shown()
await p.evaluate(() => window.__ocSetUnd('HYPE'))
const hype = await shown()
t('only HYPE outcomes', hype.length > 0 && hype.every(u => u === 'HYPE'), true)
t('and the chip says so', await p.evaluate(() => document.querySelector('#ocUnds .oc-und-active')?.dataset.und), 'HYPE')
// Trending and the section headings list everything; over one chosen market they would not.
t('Trending and the section headings step aside, as for a category', await p.evaluate(() =>
  [...document.querySelectorAll('#ocGrid .oc-sec-head, #ocGrid .oc-hot-scroll')].every(e => e.style.display === 'none')), true)
await p.evaluate(() => window.__ocSetUnd('HYPE'))
t('pressing it again shows everything', (await shown()).length, all.length)
await p.evaluate(() => window.__ocSetUnd('BTC'))
t('BTC brings its binary and its range market', (await shown()).every(u => u === 'BTC') && (await shown()).length >= 2, true)
await p.evaluate(() => window.__ocSetUnd('all'))

console.log('\n-- countdowns tick without replacing anything --')
const counts = await p.evaluate(() => new Promise((res) => {
  const grid = document.getElementById('ocGrid')
  let list = 0, text = 0
  const mo = new MutationObserver((ms) => { for (const m of ms) { if (m.type === 'childList' && m.target.id?.startsWith?.('oc-cd-')) list++; if (m.type === 'characterData') text++ } })
  mo.observe(grid, { childList: true, characterData: true, subtree: true })
  setTimeout(() => { mo.disconnect(); res({ list, text }) }, 3200)
}))
t('three seconds of ticking replaced no countdown nodes', counts.list, 0)
t('while the countdowns did change', counts.text > 0, true)
t('and they show time left, not a dash', await p.evaluate(() => /\d+h \d+m \d+s/.test(document.querySelector('[id^="oc-cd-"]')?.textContent ?? '')), true)

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
