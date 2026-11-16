// Sports in the Outcomes list (src/ocsport.js). Driven for real in tests/outcomes-browser.mjs.
import fs from 'fs'
import { sportOf, leagueOf, sportHeadHtml, sportOrder, matchTitle, SPORTS } from '../../src/ocsport.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('-- which sport, from what Hyperliquid sends (outcomeMeta, 2026-11-15) --')
t('"Basketball" is basketball', sportOf('Basketball') === 'basketball')
t('plain "Football" is the NFL in their data', sportOf('Football') === 'football' && sportOf('football') === 'football')
t('"Soccer" and "football/soccer" are soccer', sportOf('Soccer') === 'soccer' && sportOf('football/soccer') === 'soccer')
t('no sport field: the competition says it', sportOf('', 'NBA') === 'basketball' && sportOf('', 'English Premier League') === 'soccer' && sportOf(null, '2026 MLB Championship') === 'baseball')
t('nothing to go on is "more sports", not a guess', sportOf('', 'Who wins?') === 'other')
t('the league is named when it is known', leagueOf('NBA') === 'NBA' && leagueOf('UEFA Nations League') === 'Nations League' && leagueOf('2026/2027 English Premier League') === 'Premier League')
t('and null when it is not', leagueOf('Some cup') === null)

console.log('-- names and order --')
t('a match is named by its sides', matchTitle(['Ireland', 'Kosovo', 'Draw']) === 'Ireland vs Kosovo')
t('a field of many is not a match', matchTitle(['A', 'B', 'C', 'D']) === null && matchTitle(['A']) === null)
const ord = sportOrder([{ id: 'g2', close: 20 }, { id: 'fut', isEvent: true, oi: 5 }, { id: 'g1', close: 10 }, { id: 'fut2', isEvent: true, oi: 9 }])
t('futures first, biggest first; then games, soonest first', ord.map(x => x.id).join() === 'fut2,fut,g1,g2', ord.map(x => x.id))

console.log('-- the banner --')
const h = sportHeadHtml('basketball', 2, ['NBA', 'NBA', null], s => s)
t('names the sport, its leagues once each, and how many markets', /Basketball/.test(h) && />NBA</.test(h) && /2 markets/.test(h))
t('draws its own court (generic art: league marks are trademarks)', /<svg class="oc-sport-art"/.test(h) && !/<img/.test(h))
t('every sport has a colour pair and a glyph', Object.values(SPORTS).every(s => s.a && s.b && s.glyph))

console.log('-- wiring --')
const m = fs.readFileSync('src/main.js', 'utf8')
// Grouping went general (src/ocfold.js): Sports by sport, Crypto by coin — each group a folding banner.
t('Sports is laid out one sport at a time', m.includes('_ocAppendGroups(frag, cat, list)') && m.includes("sportHeadHtml(k, cs.length, cs.map(c => c.dataset.league), esc)"))
t('every sports card says which sport it is', m.includes('card.dataset.sport = sportOf(') && m.includes('data-sport="${spK}"'))
t('the 5-second price tick writes only what changed', m.includes('function _ocSetText(el, t) { if (el && el.textContent !== t)') && !/compactPct2\.textContent = /.test(m))
t('and redraws no chart that is not on screen', m.includes('if (chart && chart.canvas?.offsetParent)'))
const css = fs.readFileSync('src/style.css', 'utf8')
t('no wallpaper blur behind Outcomes cards', !/html\.has-bg-image \.oc-card,/.test(css))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
