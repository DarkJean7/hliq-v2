// Outcome volume, open interest and topic icons (src/ocstats.js). Asked: "add a filter by open
// interest, volume, etc. by default sort by open interest. in trending should be the markets with
// more open interest ... can we also have the more icons for like nba, football, etc".
import fs from 'fs'
import { outcomeStats, eventStats, fmtUsdShort, topicGlyph } from '../../src/ocstats.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// Shaped like spotMetaAndAssetCtxs: [meta, ctxs]. Outcome 2550 (Dodgers) has two sides.
const SPOT = [{ tokens: [], universe: [] }, [
  { coin: 'BTC', dayNtlVlm: '999999', circulatingSupply: '1' },          // not an outcome
  { coin: '#25500', dayNtlVlm: '25', circulatingSupply: '120000' },       // Yes
  { coin: '#25501', dayNtlVlm: '9', circulatingSupply: '2000' },          // No
  { coin: '#25510', dayNtlVlm: '100', circulatingSupply: '50000' },
  { coin: '#25511', dayNtlVlm: '700', circulatingSupply: '400' },
]]
const st = outcomeStats(SPOT)
t('only outcome sides are read', st.size === 2 && !st.has(NaN), [...st.keys()])
// Hyperliquid's market list counts the Yes side's volume — checked to the dollar against it.
t('volume is the Yes side\'s, as Hyperliquid shows it', st.get(2550).vol === 25 && st.get(2551).vol === 100, st.get(2550))
t('open interest is the contracts outstanding (the larger side)', st.get(2550).oi === 120000 && st.get(2551).oi === 50000)
t('accepts the contexts array on its own too', outcomeStats(SPOT[1]).get(2550).vol === 25)
t('nothing to read: an empty map, not a throw', outcomeStats(null).size === 0)
const ev = eventStats([2550, 2551, 9999], st)
t('an event is its legs added up', ev.vol === 125 && ev.oi === 170000, ev)
t('an event with no known leg is unknown, not zero', eventStats([1, 2], st) === null)
t('money reads short', fmtUsdShort(1.1e6) === '$1.1M' && fmtUsdShort(783100) === '$783.1k' && fmtUsdShort(420) === '$420')

const g = (...p) => topicGlyph(...p)?.glyph
t('NBA is a basketball', g('NBA Regular Season: Cleveland Cavaliers v Brooklyn Nets') === '🏀')
t('the NFL is an American football', g('template:sportsTournamentWinner', 'USA National Football League (NFL)', 'football') === '🏈')
t('the leagues are a football', g('English Premier League', 'football/soccer') === '⚽' && g('UEFA Champions League') === '⚽')
t('baseball', g('MLB Championship', 'baseball') === '⚾')
t('an award is a trophy, not a football', g("template:awardWinner", "Ballon d'Or", 'Soccer') === '🏆')
t('a rate decision is the central bank', g('template:policyRateDecision', "Federal Reserve's Open Market Committee") === '🏛️')
t('nothing known: no guess', topicGlyph('something else entirely') === null)

const cli = fs.readFileSync('src/main.js', 'utf8')
t('open interest is the default sort', cli.includes('<option value="oi" selected>Open interest</option>'))
t('with volume beside it', cli.includes('<option value="vol">Volume (24h)</option>'))
t('sorting keeps the sections (and Trending) instead of flattening the page', cli.includes("if (el.classList.contains('oc-card')) run.push(el)") && !cli.includes("Headings would now sit above whatever happened to land under them"))
t('Trending is the markets with the most open interest', cli.includes('.sort((a, b) => oiOf(b) - oiOf(a)).slice(0, 10)'))
// Ten: at six the NBA championship (seventh) was cut off.
t('an outcome position shows its market\'s face, not a letter avatar', cli.includes("if (typeof coin === 'string' && (coin[0] === '#' || coin[0] === '+')) return _ocCoinIcon(coin)") && cli.includes('if (info?.u) return _coinIconHtml(info.u)') && cli.includes('const tg = ocTopicGlyph(info?.sp, info?.cmp, name)'))
// Hyperliquid files its NFL games under a sport of plain "football"; soccer is "Soccer" or "football/soccer".
t('a sport of plain "football" is the NFL', g('football', 'Green Bay Packers vs Detroit Lions') === '🏈' && g('Football', 'NFL') === '🏈')
t('"football/soccer" and "Soccer" stay soccer', g('football/soccer', 'English Premier League') === '⚽' && g('Soccer', 'Spanish La Liga') === '⚽')
t('the Ballon d\'Or ("France Football") is still a trophy', g("template:awardWinner", "Ballon d'Or", 'France Football') === '🏆')
// 80 live markets — every NBA game, total, spread and IPO — were hidden for being named "template:…".
t('a template market is hidden only when it cannot be phrased as a question', cli.includes("&& /^(template:|Recurring)/.test(_buildFullQuestion(d, o.name)?.line1 || 'template:')) hidden.add(id)"))
t('a market is searchable by its league, sport and teams', cli.includes('full.competition, full.sport, full.stage, full.season,') && cli.includes('full.participantA, full.participantB, full.company].filter(Boolean).join'))
t('the Trending strip is not a page swipe', cli.includes("scroller.className = 'oc-hot-scroll no-swipe'") && /_SWIPE_BLOCKED_SEL = '[^']*\.oc-hot-scroll'/.test(cli))
t('an event card is found by its title, not only its legs', cli.includes("card.dataset.q += ' ' + [title, sub, qd.competition, qd.sport"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
