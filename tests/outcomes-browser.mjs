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
import { chromium, devices } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5175'
const URL  = `http://localhost:${port}/app`
const HL_HOST = /^https?:\/\/[a-z0-9.-]*hyperliquid[a-z0-9.-]*\.xyz\//i
const SHOT = (process.argv.find(a => a.startsWith('--shot=')) || '').split('=')[1] || ''   // a folder for a screenshot

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
    // The NFL winner market, as Hyperliquid lists it: a question whose legs are the teams.
    { outcome: 1487, name: 'template:sportsTournamentParticipant', description: 'participant:Kansas City Chiefs', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
    { outcome: 1486, name: 'template:sportsTournamentFallback', description: 'other', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
    // Games, shaped as Hyperliquid sends them (outcomeMeta, 2026-11-15): two NBA games, and a
    // soccer match whose QUESTION names both sides and whose legs are the teams and a draw.
    { outcome: 33713, name: 'template:sportsContestWinner', description: 'competition:NBA|contestType:Game|officialSource:National Basketball Association (NBA)|participantA:Washington Wizards|participantB:Houston Rockets|resolutionDeadline:20271123-0000|scheduledStart:20271116-0000|season:2026/2027|shortNameA:WAS|shortNameB:HOU|sport:Basketball',
      sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }], quoteToken: 'USDC', venue: 'out' },
    { outcome: 33714, name: 'template:sportsContestWinner', description: 'competition:NBA|contestType:Game|officialSource:National Basketball Association (NBA)|participantA:Los Angeles Lakers|participantB:Charlotte Hornets|resolutionDeadline:20271120-0000|scheduledStart:20271113-0000|season:2026/2027|shortNameA:LAL|shortNameB:CHA|sport:Basketball',
      sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }], quoteToken: 'USDC', venue: 'out' },
    { outcome: 33723, name: 'template:sportsContestParticipant2', description: 'participant:Ireland', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
    { outcome: 33724, name: 'template:sportsContestParticipant2', description: 'participant:Kosovo', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
    { outcome: 35423, name: 'template:sportsContestDraw2', description: '', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
    { outcome: 35424, name: 'template:sportsContestFallback', description: 'other', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' },
  ],
  questions: [{ question: 485, name: 'Recurring', description: live('class:priceBucket|underlying:BTC|expiry:20261021-0600|priceThresholds:80063,83330|period:1d'),
    fallbackOutcome: 14733, namedOutcomes: [14734, 14735, 14736], settledNamedOutcomes: [] },
    { question: 200, name: 'template:sportsTournamentWinner', description: 'competition:USA National Football League (NFL)|officialSource:NFL|resolutionDeadline:20270221-1200|season:2027|sport:football',
      fallbackOutcome: 1486, namedOutcomes: [1487, 1488], settledNamedOutcomes: [] },
    { question: 901, name: 'template:sportsContestResult', description: 'competition:UEFA Nations League|contestType:Match|officialSource:Union of European Football Associations|participantA:Ireland|participantB:Kosovo|resolutionDeadline:20271124-1945|sport:Soccer',
      fallbackOutcome: 35424, namedOutcomes: [33723, 33724, 35423], settledNamedOutcomes: [] }],
  deployers: [], feeScale: '1.0',
}
// "why the missing space": a tall NBA futures card (eight teams) beside short game cards left a
// hole under the games. Four more games, and the futures question, so the grid has a tall card to
// flow around.
{
  const NBA = (id, a, b, sa, sb, day) => ({ outcome: id, name: 'template:sportsContestWinner', quoteToken: 'USDC', venue: 'out',
    description: `competition:NBA|contestType:Game|participantA:${a}|participantB:${b}|resolutionDeadline:202711${day}-0000|shortNameA:${sa}|shortNameB:${sb}|sport:Basketball`,
    sideSpecs: [{ name: 'template:{shortNameA}' }, { name: 'template:{shortNameB}' }] })
  OUTCOME_META.outcomes.push(NBA(33801, 'Boston Celtics', 'Dallas Mavericks', 'BOS', 'DAL', 25), NBA(33802, 'Miami Heat', 'Orlando Magic', 'MIA', 'ORL', 26),
    NBA(33803, 'Utah Jazz', 'San Antonio Spurs', 'UTA', 'SAS', 27), NBA(33804, 'Toronto Raptors', 'New York Knicks', 'TOR', 'NYK', 28))
  const teams = ['Cleveland Cavaliers', 'San Antonio Spurs', 'Oklahoma City Thunder', 'Miami Heat', 'Philadelphia 76ers', 'Boston Celtics', 'New York Knicks', 'Denver Nuggets']
  teams.forEach((t, i) => OUTCOME_META.outcomes.push({ outcome: 34000 + i, name: 'template:sportsTournamentParticipant', description: 'participant:' + t, sideSpecs: YN, quoteToken: 'USDC', venue: 'out' }))
  OUTCOME_META.outcomes.push({ outcome: 34099, name: 'template:sportsTournamentFallback', description: 'other', sideSpecs: YN, quoteToken: 'USDC', venue: 'out' })
  OUTCOME_META.questions.push({ question: 950, name: 'template:sportsTournamentWinner', description: 'competition:NBA|officialSource:NBA|resolutionDeadline:20270630-1200|season:2026/2027|sport:Basketball',
    fallbackOutcome: 34099, namedOutcomes: teams.map((_, i) => 34000 + i), settledNamedOutcomes: [] })
}
const MIDS = { BTC: '82000', ETH: '2400', SOL: '105', HYPE: '80' }
for (const o of OUTCOME_META.outcomes) { MIDS['#' + (o.outcome * 10)] = '0.5'; MIDS['#' + (o.outcome * 10 + 1)] = '0.5' }
// The markets paper mode needs to start at all.
const UNIVERSE = ['BTC', 'ETH', 'SOL', 'HYPE'].map(name => ({ name, szDecimals: 2, maxLeverage: 20 }))
const CTX = UNIVERSE.map(u => { const px = MIDS[u.name]; return { funding: '0', openInterest: '0', prevDayPx: px, dayNtlVlm: '0', premium: '0', oraclePx: px, markPx: px, midPx: px, impactPxs: [px, px] } })
const BASE = {
  meta: { universe: UNIVERSE }, metaAndAssetCtxs: [{ universe: UNIVERSE }, CTX], perpDexs: [null],
  // Every market's 24h volume (Yes side) and contracts outstanding, the way spotMetaAndAssetCtxs
  // carries outcome sides: "#<id×10+side>". Open interest order: NFL event > SOL > HYPE > ETH > BTC.
  spotMeta: { tokens: [], universe: [] }, spotMetaAndAssetCtxs: [{ tokens: [], universe: [] }, [
    ...[[14730, 9000, 300], [14731, 7000, 2500], [14729, 5000, 90], [14726, 3000, 21439], [1487, 40000, 500], [1488, 30000, 400], [1486, 1000, 10]]
      .flatMap(([id, oi, vol]) => [{ coin: '#' + id * 10, dayNtlVlm: String(vol), circulatingSupply: String(oi), markPx: '0.5' },
                                   { coin: '#' + (id * 10 + 1), dayNtlVlm: '7777', circulatingSupply: String(Math.round(oi / 10)), markPx: '0.5' }])]],
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

// "lets make the outcomes markets be unextended initially. both in mobile and desktop. so the user
// can see all types of outcomes markets"
console.log('\n-- sections start folded --')
{
  await p.evaluate(() => { document.getElementById('ocSearchInput').value = ''; window.__ocSetUnd('all'); window.__ocSetCat('all') })
  const st = () => p.evaluate(() => ({
    heads: [...document.querySelectorAll('#ocGrid .oc-sec-head[data-sec]')].filter(h => h.offsetParent).map(h => h.dataset.sec),
    shut: [...document.querySelectorAll('#ocGrid .oc-sec-head[data-sec]')].every(h => h.classList.contains('oc-sec-shut')),
    cards: [...document.querySelectorAll('#ocGrid > .oc-card')].filter(c => c.offsetParent).length,
    banners: [...document.querySelectorAll('#ocGrid > .oc-sport-head')].filter(c => c.offsetParent).length,
  }))
  const s0 = await st()
  t('every kind of market is listed by its heading', ['crypto', 'sports'].every(c => s0.heads.includes(c)), true)
  t('and every one starts folded: no cards, no sport banners', [s0.shut, s0.cards, s0.banners], [true, 0, 0])
  if (SHOT) await p.screenshot({ path: `${SHOT}/outcomes-folded.png` })
  t('Trending still shows above them', await p.evaluate(() => !!document.querySelector('.oc-hot-scroll')?.offsetParent), true)
  await p.click('#ocGrid .oc-sec-head[data-sec="crypto"]')
  const s1 = await p.evaluate(() => [...document.querySelectorAll('#ocGrid > .oc-card')].filter(c => c.offsetParent).map(c => c.dataset.cat))
  t('tapping a heading opens just that section', s1.length > 0 && s1.every(c => c === 'crypto'), true)
  t('and says so to a screen reader', await p.evaluate(() => document.querySelector('#ocGrid .oc-sec-head[data-sec="crypto"]').getAttribute('aria-expanded')), 'true')
  await p.click('#ocGrid .oc-sec-head[data-sec="crypto"]')
  t('tapping it again folds it', (await st()).cards, 0)
  await p.evaluate(() => { const q = document.getElementById('ocSearchInput'); q.value = 'lakers'; window.__ocFilter() })
  t('a search finds markets in folded sections', await p.evaluate(() => [...document.querySelectorAll('#ocGrid > .oc-card')].filter(c => c.offsetParent).length) > 0, true)
  await p.evaluate(() => { const q = document.getElementById('ocSearchInput'); q.value = ''; window.__ocFilter() })
  await p.evaluate(() => window.__ocSetCat('sports'))
  t('choosing a category shows its markets, folded or not', await p.evaluate(() => [...document.querySelectorAll('#ocGrid > .oc-card[data-cat="sports"]')].filter(c => c.offsetParent).length) > 0, true)
  await p.evaluate(() => window.__ocSetCat('all'))
  // A Trending card points into a section; pressing it opens that section so its card is there.
  await p.evaluate(() => document.querySelector('.oc-hot-card')?.click())
  t('a Trending card opens the section its market is in', await p.evaluate(() => document.querySelectorAll('#ocGrid .oc-sec-head.oc-sec-shut').length < document.querySelectorAll('#ocGrid .oc-sec-head[data-sec]').length), true)
  await p.evaluate(() => window.__ocCloseExpanded?.())
  // The rest of this file reads cards: open every section.
  await p.evaluate(() => document.querySelectorAll('#ocGrid .oc-sec-head[data-sec]').forEach(h => window.__ocToggleSec(h.dataset.sec, true)))
}

// "add a filter by open interest, volume, etc. by default sort by open interest. in trending should
// be the markets with more open interest ... similar as outcome.xyz ... icons for like nba, football"
console.log('\n-- open interest leads, volume shows, sports get their icon --')
const shownIn = (cat) => p.evaluate((c) => [...document.querySelectorAll(`#ocGrid > .oc-card[data-cat="${c}"]`)]
  .filter(x => x.offsetParent && !x.classList.contains('oc-grouped') && !x.classList.contains('oc-junk')).map(x => x.dataset.und), cat)
await p.evaluate(() => { document.getElementById('ocSearchInput').value = ''; window.__ocSetUnd('all'); window.__ocSetCat('all') })
t('the default sort is open interest', await p.evaluate(() => document.getElementById('ocSortSel').value), 'oi')
t('Trending is the markets with the most open interest, first to last', await p.evaluate(() =>
  [...document.querySelectorAll('.oc-hot-card .oc-hot-q')].map(e => e.textContent.trim().split(' ').slice(0, 2).join(' '))),
  ['2027 USA', 'Will SOL', 'Will HYPE', 'Will ETH', 'Will BTC'])
t('within a section, the largest market comes first', (await shownIn('crypto')).slice(0, 2), ['SOL', 'HYPE'])
t('and the section headings stay', await p.evaluate(() => [...document.querySelectorAll('#ocGrid .oc-sec-head')].every(h => h.style.display !== 'none')), true)
t('volume is the Yes side\'s, as Hyperliquid counts it', await p.evaluate(() => document.querySelector('#oc-card-14726 .oc-compact-vol')?.textContent), '$21.4k Vol.')
await p.selectOption('#ocSortSel', 'vol')
t('sorting by volume puts the most traded first', (await shownIn('crypto'))[0], 'BTC')
await p.selectOption('#ocSortSel', 'oi')
await p.evaluate(() => { const q = document.getElementById('ocSearchInput'); q.value = 'nfl'; window.__ocFilter() })
const nfl = await p.evaluate(() => [...document.querySelectorAll('#ocGrid > .oc-card')]
  .filter(c => c.style.display !== 'none' && c.offsetParent && !c.classList.contains('oc-grouped') && !c.classList.contains('oc-junk'))
  .map(c => ({ t: c.querySelector('.oc-evt-title, .oc-compact-q')?.textContent.trim(), ic: c.querySelector('.oc-compact-icon')?.textContent.trim() })))
t('an event is found by its title ("also missing new markets": mlb found nothing)', nfl.map(x => x.t), ['2027 USA National Football League (NFL)'])
t('with the sport\'s icon', nfl[0]?.ic, '🏈')
await p.evaluate(() => { const q = document.getElementById('ocSearchInput'); q.value = ''; window.__ocFilter() })
t('the Trending strip is not a page swipe (it opened the More panel)', await p.evaluate(() => document.querySelector('.oc-hot-scroll').classList.contains('no-swipe')), true)

// "make popular sports like nba, mlb, futboll more eye captive" / "i selected nba finals and it
// kind of be lost with all types of cards. at the right unrelated sports, more to the right more
// nba stuff" / "scrolling in the desktop outcomes is not smooth".
console.log('\n-- Sports: one sport at a time, under its own banner --')
await p.evaluate(() => { document.getElementById('ocSearchInput').value = ''; window.__ocSetUnd('all'); window.__ocSetCat('sports') })
const runs = await p.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('#ocGrid > *')) {
    if (el.classList.contains('oc-sport-head')) out.push({ head: el.dataset.sport, cards: [] })
    else if (el.classList.contains('oc-card') && el.dataset.cat === 'sports' && el.offsetParent && out.length) out.at(-1).cards.push(el.dataset.sport)
  }
  return out
})
t('a banner per sport, the most markets first', runs.map(r => r.head), ['basketball', 'football', 'soccer'])
if (SHOT) {
  await p.evaluate(() => document.querySelector('.oc-sport-head')?.scrollIntoView({ block: 'start' }))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${SHOT}/outcomes-sports.png` })
  // Back to the top: the countdown check below watches on-screen countdowns, and the sports
  // ones (days away) only change once a minute.
  await p.evaluate(() => { document.getElementById('ocGrid').scrollIntoView({ block: 'start' }); document.querySelector('.main')?.scrollTo?.(0, 0); window.scrollTo(0, 0) })
}
t('and under each banner only that sport — no NFL between two NBA games', runs.every(r => r.cards.length > 0 && r.cards.every(s => s === r.head)), true)
t('the banners show with Sports chosen, which is when they help', await p.evaluate(() => [...document.querySelectorAll('.oc-sport-head')].every(h => h.style.display !== 'none')), true)
t('the basketball banner names its league', await p.evaluate(() => document.querySelector('.oc-sport-head[data-sport="basketball"] .oc-sport-leagues')?.textContent), 'NBA')
t('and carries its drawn court', await p.evaluate(() => !!document.querySelector('.oc-sport-head[data-sport="basketball"] svg.oc-sport-art')), true)
// Rows, not columns, and no holes: the futures card first, games beside it, more games right
// under those -- not below the futures card's full height.
const nba = await p.evaluate(() => {
  const r = (el) => el.getBoundingClientRect()
  const h = r(document.querySelector('.oc-sport-head[data-sport="basketball"]'))
  const evt = document.querySelector('#ocGrid > .oc-card.oc-event[data-sport="basketball"]')
  const games = [...document.querySelectorAll('#ocGrid > .oc-card[data-sport="basketball"]:not(.oc-event)')].filter(c => c.offsetParent).map(r)
  const e = r(evt)
  // For every game: the nearest card above it in the same column, and the space between them.
  const all = [...document.querySelectorAll('#ocGrid > .oc-card[data-sport="basketball"]')].filter(c => c.offsetParent).map(r)
  const gaps = games.map(g => {
    const above = all.filter(o => Math.abs(o.left - g.left) < 2 && o.bottom <= g.top + 1).sort((a, b) => b.bottom - a.bottom)[0]
    return above ? Math.round(g.top - above.bottom) : Math.round(g.top - h.bottom)
  })
  return { firstRow: games.filter(g => Math.abs(g.top - e.top) < 2).length, under: Math.round(e.top - h.bottom), tall: e.height > games[0].height * 1.5, maxGap: Math.max(...gaps) }
})
t('the futures card starts the sport, right under its banner', nba.under >= 0 && nba.under < 40, true)
t('the games fill the rest of its row', nba.firstRow >= 2, true)
t('the futures card is the tall one', nba.tall, true)
console.log('     ', JSON.stringify(nba))
t('and no game sits under a hole: each starts right below the card above it', nba.maxGap <= 20, true)
// A sort works inside each sport: its banner ends one run of cards and starts the next.
await p.selectOption('#ocSortSel', 'soon')
t('a sort reorders a sport within its own block', await p.evaluate(() => [...document.querySelectorAll('#ocGrid > .oc-card[data-sport="basketball"]:not(.oc-event):not(.oc-grouped)')].map(c => c.id)),
  ['oc-card-33714', 'oc-card-33713', 'oc-card-33801', 'oc-card-33802', 'oc-card-33803', 'oc-card-33804'])
t('and keeps every sport under its banner', await p.evaluate(() => {
  let cur = null, ok = true
  for (const el of document.querySelectorAll('#ocGrid > *')) {
    if (el.classList.contains('oc-sport-head')) cur = el.dataset.sport
    else if (el.classList.contains('oc-sec-head')) cur = null
    else if (cur && el.classList.contains('oc-card') && el.offsetParent && el.dataset.sport !== cur) ok = false
  }
  return ok
}), true)
await p.selectOption('#ocSortSel', 'oi')
t('a soccer match is named by its teams, not "Sports Contest Result"', await p.evaluate(() =>
  document.querySelector('.oc-card.oc-event[data-sport="soccer"] .oc-evt-title')?.textContent), 'Ireland vs Kosovo')
await p.evaluate(() => { const q = document.getElementById('ocSearchInput'); q.value = 'lakers'; window.__ocFilter() })
t('a search puts the cards in one run, so the banners step aside', await p.evaluate(() => [...document.querySelectorAll('.oc-sport-head')].every(h => h.style.display === 'none')), true)
await p.evaluate(() => { const q = document.getElementById('ocSearchInput'); q.value = ''; window.__ocSetCat('all') })
// Over a wallpaper, Outcomes cards are not blurred: dozens of blur layers re-rendered on every
// scrolled frame were the stalls in the scroll-jank reports.
t('no wallpaper blur behind an Outcomes card', await p.evaluate(() => {
  document.documentElement.classList.add('has-bg-image')
  const v = getComputedStyle(document.querySelector('#ocGrid .oc-card')).backdropFilter
  document.documentElement.classList.remove('has-bg-image')
  return v
}), 'none')

// "are you still destroying and rebuilding the cards??" — the scroll-jank reports showed every
// refresh rewriting the Overview and Positions panels (ordersTbody, overviewStats) behind this page.
console.log('\n-- panels behind this tab are not redrawn, and catch up on return --')
{
  const hits = () => p.evaluate(() => new Promise((res) => {
    const els = ['overviewStats', 'ordersTbody'].map(id => document.getElementById(id)).filter(Boolean)
    let n = 0
    const mo = new MutationObserver((ms) => { n += ms.length })
    els.forEach(el => mo.observe(el, { childList: true, subtree: true, characterData: true }))
    window.__renderAccountSection()
    setTimeout(() => { mo.disconnect(); res({ n, watched: els.length }) }, 300)
  }))
  const behind = await hits()
  t('a refresh while Outcomes is open does not touch the Overview behind it', behind.watched > 0 && behind.n === 0, true)
  const back = await p.evaluate(() => new Promise((res) => {
    const el = document.getElementById('overviewStats')
    let n = 0
    const mo = new MutationObserver((ms) => { n += ms.length })
    mo.observe(el, { childList: true, subtree: true, characterData: true })
    window.switchTab('overview')
    setTimeout(() => { mo.disconnect(); res(n) }, 300)
  }))
  t('and going back to Overview draws it once, from the latest data', back > 0, true)
  await p.evaluate(() => window.switchTab('outcomes'))
  await waitFor(p, 'the outcome cards again', () => document.querySelectorAll('#ocGrid .oc-card').length >= 4)
}

console.log('\n-- a price tick writes only what changed --')
await p.waitForTimeout(5500)   // let the first tick land: it fills in values that were still "—"
const writes = await p.evaluate(() => new Promise((res) => {
  const grid = document.getElementById('ocGrid')
  const seen = {}
  const mo = new MutationObserver((ms) => { for (const m of ms) {
    const el = m.target.nodeType === 3 ? m.target.parentElement : m.target
    const id = el?.id || el?.closest?.('[id]')?.id || '?'
    if (/^oc-(compact-)?cd-/.test(id)) continue
    const k = m.type + ':' + id.replace(/\d+/g, 'N') + (m.attributeName ? '@' + m.attributeName : '')
    seen[k] = (seen[k] || 0) + 1
  } })
  mo.observe(grid, { childList: true, characterData: true, subtree: true, attributes: true })
  setTimeout(() => { mo.disconnect(); res(seen) }, 11000)   // two 5-second ticks at unchanged prices
}))
t('two ticks at unchanged prices rewrite nothing on the cards', writes, {})

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

// The phone: the same list, in the Predictions sheet. Folded there too.
console.log('\n-- the phone: sections start folded too --')
{
  const mctx = await browser.newContext({ ...devices['iPhone 14 Pro'] })
  try { await mctx.routeWebSocket(/hyperliquid/i, ws => ws.close()) } catch {}
  await mctx.route('**/api/**', r => r.fulfill({ status: 503, body: 'offline in test' }))
  await mctx.route(HL_HOST, (route) => {
    let b = {}
    try { b = JSON.parse(route.request().postData() || '{}') } catch {}
    const json = b.type === 'outcomeMeta' ? OUTCOME_META : b.type === 'allMids' ? MIDS
      : b.type in BASE ? BASE[b.type]
      : ['candleSnapshot', 'perpCategories', 'userFills', 'frontendOpenOrders', 'allPerpMetas'].includes(b.type) ? [] : {}
    return route.fulfill({ status: 200, contentType: 'application/json', json })
  })
  const m = await mctx.newPage()
  m.on('pageerror', e => errs.push('mobile: ' + e.message))
  await m.goto(URL, { waitUntil: 'domcontentloaded' })
  await m.evaluate(() => {
    localStorage.clear()
    localStorage.setItem('hliq_lang', 'en'); localStorage.setItem('hliq_onboard_done', '1')
    localStorage.setItem('hliq_lang_chosen', '1'); localStorage.setItem('hliq_onboard_welcomed_v1', '1')
  })
  await m.reload({ waitUntil: 'domcontentloaded' })
  await waitFor(m, 'boot', () => !!window.__goPaper)
  await m.evaluate(() => window.__goPaper())
  await waitFor(m, 'the mobile shell', () => !!window.__openPredictions)
  await m.evaluate(() => document.querySelectorAll('#annModal, #langChooseModal, #onboardSheet').forEach(e => e.remove()))
  await m.evaluate(() => window.__openPredictions())
  await waitFor(m, 'the sheet headings', () => document.querySelectorAll('#mobPredictBody .oc-sec-head[data-sec]').length >= 2)
  const ms = await m.evaluate(() => ({
    heads: document.querySelectorAll('#mobPredictBody .oc-sec-head[data-sec]').length,
    shut: [...document.querySelectorAll('#mobPredictBody .oc-sec-head[data-sec]')].every(h => h.classList.contains('oc-sec-shut')),
    cards: [...document.querySelectorAll('#mobPredictBody #ocGrid > .oc-card')].filter(c => c.offsetParent).length,
  }))
  t('every section is a folded heading, no cards', [ms.shut, ms.cards], [true, 0])
  await m.evaluate(() => document.querySelector('#mobPredictBody .oc-sec-head[data-sec="crypto"]').click())
  t('a tap opens one', await m.evaluate(() => [...document.querySelectorAll('#mobPredictBody #ocGrid > .oc-card')].filter(c => c.offsetParent).every(c => c.dataset.cat === 'crypto')
    && [...document.querySelectorAll('#mobPredictBody #ocGrid > .oc-card')].some(c => c.offsetParent)), true)
  // Not placed by the desktop masonry: the phone's list is a column.
  t('and the phone keeps its column (no desktop row spans)', await m.evaluate(() => [...document.querySelectorAll('#mobPredictBody #ocGrid > *')].every(el => !el.style.gridRowEnd)), true)
  await mctx.close()
}

await browser.close()
console.log('\nerrors: ' + (errs.length ? JSON.stringify(errs.slice(0, 3)) : 'none'))
console.log(pass + ' passed, ' + (fail + errs.length) + ' failed')
process.exit(fail || errs.length ? 1 : 0)
