// The Outlook card's suggestion (src/outlooksuggest.js). "i want something to act as a
// suggestion ... with all the signals it should be inclined to something. for example ... mean
// reversal". The lean comes from the tested 4h set; conviction needs the market's own record too.
import fs from 'fs'
import { leanOf, actionsFor } from '../../src/outlooksuggest.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// A 4h reading: the two fades pulling down hard (stretched up), trend mildly up.
const stretchedUp = { score: { score: -45, lean: 'down' }, factors: [
  { id: 'trend', w: 25, v: 0.3 }, { id: 'range', w: 20, v: 0 },
  { id: 'rev3d', w: 15, v: -1, x: { move: 0.062 } }, { id: 'bbFade', w: 15, v: -0.9, x: { sd: 2.1 } },
] }
const trendUp = { score: { score: 50, lean: 'up' }, factors: [{ id: 'trend', w: 25, v: 1 }, { id: 'range', w: 20, v: 0.8 }, { id: 'rev3d', w: 15, v: 0 }, { id: 'bbFade', w: 15, v: -0.1, x: { sd: 0.3 } }] }
const quiet = { score: { score: 5, lean: 'flat' }, factors: [{ id: 'trend', w: 25, v: 0.1 }] }

console.log('-- the lean --')
const better = { verdict: 'better', n: 80, rate: 0.6, base: 0.5 }, chance = { verdict: 'chance', n: 80, rate: 0.52, base: 0.5 }
const L1 = leanOf(stretchedUp, better)
t('stretched up, the fades carry it: a pullback, by mean reversion', L1.kind === 'pullback' && L1.lean === 'down', L1)
t('it knows how stretched: the 3-day move and the sd', L1.stretch.move3d === 0.062 && L1.stretch.sd === 2.1)
t('a stretched-down reading is a bounce', leanOf({ score: { score: 45, lean: 'up' }, factors: stretchedUp.factors.map(f => ({ ...f, v: -f.v })) }, better).kind === 'bounce')
t('trend carrying it is a trend lean, not a reversion', leanOf(trendUp, better).kind === 'trend-up')
t('nothing to lean on: none, no edge', leanOf(quiet, better).kind === 'none' && leanOf(quiet, better).conviction === 0)

console.log('-- conviction is earned twice --')
t('a strong reading the market\'s record backs: high', L1.conviction === 3)
t('the same reading where the record says chance: low, however loud', leanOf(stretchedUp, chance).conviction === 1)
t('no record at all: low', leanOf(stretchedUp, null).conviction === 1)
t('a weak reading the record backs: medium at most', leanOf({ ...stretchedUp, score: { score: -25, lean: 'down' } }, better).conviction === 2)
t('no score: no edge', leanOf(null, better).conviction === 0)

console.log('-- untested horizons --')
t('untested: a strong reading the record backs is still only Low', leanOf(stretchedUp, better, false).conviction === 1 && leanOf(stretchedUp, better, true).conviction === 3)
t('untested: the lean itself is still shown', leanOf(stretchedUp, better, false).lean === 'down' && leanOf(stretchedUp, better, false).tested === false)
t('untested and quiet: still no edge, not Low', leanOf(quiet, better, false).conviction === 0)
const { TESTED_HORIZONS, HORIZONS } = await import('../../src/outlook.js')
const research = JSON.parse(fs.readFileSync('tests/research/signal-results.json', 'utf8'))
t('the tested horizons are where the research found a signal set that passed', JSON.stringify(TESTED_HORIZONS) === JSON.stringify([...new Set(research.results.filter(r => r.pass).map(r => r.h))].sort((x, y) => x - y)))
t('six horizons, 1h to 30d', Object.values(HORIZONS).join() === '1,4,24,72,168,720')

console.log('-- what it means for a position --')
const out = (side, { upnl = 50, liq = null, tp = null, sl = null } = {}) => ({
  pos: { side, upnl }, cases: { bear: { px: 95 }, bull: { px: 105 }, neutral: { px: 100 } },
  risk: { liq, tp, sl },
})
const setup = { support: { lo: 92, hi: 93 }, resistance: { lo: 108, hi: 109 } }
const ids = (a) => a.map(x => x.id).join()
t('a long in profit into a pullback, no stop: a stop, and take some off', ids(actionsFor(L1, out('long'), setup)) === 'setStop,takeSome', actionsFor(L1, out('long'), setup))
t('the stop goes beyond the case against it (or the level past it), not inside the normal range',
  Math.abs(actionsFor(L1, out('long'), setup)[0].px - 92 * 0.995) < 1e-9)
t('a long under water into a pullback: do not add, a better price may come', ids(actionsFor(L1, out('long', { upnl: -20, sl: { px: 90 } }), setup)) === 'dontAdd' && actionsFor(L1, out('long', { upnl: -20, sl: { px: 90 } }), setup)[0].px === 95)
t('a short into the same pullback: hold, and a target if it has none', ids(actionsFor(L1, out('short'), setup)) === 'hold,setTarget,addOnDip' && actionsFor(L1, out('short'), setup)[1].px === 93)
t('with a take-profit already, no target suggested', !ids(actionsFor(L1, out('short', { tp: { px: 90 } }), setup)).includes('setTarget'))
t('liquidation within reach comes first, whatever the lean', actionsFor(L1, out('short', { liq: { px: 104, sig: 1.5, p: 0.2 } }), setup)[0].id === 'cutRisk'
  && actionsFor(leanOf(quiet, better), out('long', { liq: { px: 96, sig: 2, p: 0.1 } }), setup).map(x => x.id).join() === 'cutRisk,noEdge')
t('a far liquidation is not mentioned', !ids(actionsFor(L1, out('short', { liq: { px: 160, sig: 12, p: 0.0001 } }), setup)).includes('cutRisk'))
t('no lean: stick to the plan', ids(actionsFor(leanOf(quiet, better), out('long'), setup)) === 'noEdge')
t('a bounce read on a long: adding into the dip fits', ids(actionsFor(leanOf({ score: { score: 45, lean: 'up' }, factors: stretchedUp.factors.map(f => ({ ...f, v: -f.v })) }, better), out('long'), setup)).includes('addOnDip'))

console.log('-- a market watched, not held --')
const { ideaFor, sortCards, ORACLE_SORTS } = await import('../../src/outlooksuggest.js')
const free = { pos: null, cases: { bear: { px: 95 }, bull: { px: 105 }, neutral: { px: 100 } }, risk: null }
const ip = ideaFor(L1, free, setup)[0]
t('a pullback read on a market not held: the idea is a short, stop above, target below', ip.id === 'entryIdea' && ip.side === 'short' && Math.abs(ip.stop - 109 * 1.005) < 1e-9 && ip.target === 93, ip)
const bl = ideaFor(leanOf(trendUp, better), free, setup)[0]
t('a lean up: a long, stop below the case against it, target the next resistance', bl.side === 'long' && Math.abs(bl.stop - 92 * 0.995) < 1e-9 && bl.target === 108, bl)
t('no lean: nothing to enter on', ideaFor(leanOf(quiet, better), free, setup)[0].id === 'noEdge')
t('a market with no position gets no position actions', actionsFor(L1, free, setup).length === 0)

console.log('-- sorting ("add sorts") --')
const cards = [
  { keys: { score: -50, conviction: 1, pnl: 10, risk: 3, name: 'SOL' } },
  { keys: { score: 20, conviction: 2, pnl: null, risk: null, name: 'ARB' } },
  { keys: null, coin: 'still loading' },
  { keys: { score: 70, conviction: 1, pnl: -40, risk: 1.5, name: 'ETH' } },
]
const by = (k) => sortCards(cards, k).map(c => c.keys?.name ?? '…').join()
t('every sort is offered', ORACLE_SORTS.join() === 'default,strong,bull,bear,conviction,pnl,risk,az')
t('default keeps the order given', by('default') === 'SOL,ARB,ETH,…')
t('strongest signal first, either way', by('strong') === 'ETH,SOL,ARB,…')
t('most bullish first', by('bull') === 'ETH,ARB,SOL,…')
t('most bearish first', by('bear') === 'SOL,ARB,ETH,…')
t('conviction, then strength', by('conviction') === 'ARB,ETH,SOL,…')
t('P&L, a market not held last', by('pnl') === 'SOL,ETH,ARB,…')
t('liquidation risk: nearest first, none in range last', by('risk') === 'ETH,SOL,ARB,…')
t('A–Z', by('az') === 'ARB,ETH,SOL,…')
t('a card still loading keeps its place at the end', sortCards(cards, 'bull').at(-1).coin === 'still loading')

console.log('-- wiring --')
const view = fs.readFileSync('src/outlookview.js', 'utf8')
// "build it": the suggestion reads the horizon on screen, and is capped where it is untested.
t('the lean reads the horizon on screen, not always 4h', view.includes('const h = o.hours') && view.includes('const p4 = pastAt(coin, raw, h)') && view.includes('hours: h, mult: p4.mult, sigmaScale: p4.scale'))
t('its record is the learned score at that horizon, on this market', view.includes('pastRecord(p4.samples, learned4, h, x => p4.learned.get(x))'))
t('whether the horizon is tested decides the cap', view.includes('leanOf(o4, rec4, TESTED_HORIZONS.includes(h))'))
t('and the box says when it is untested', view.includes('Untested at ${HZ[L.hours]}: no signal set has beaten chance at this timeframe'))
t('each account gets its own actions', /actionsFor\(L, outs\[i\], setup\)/.test(view))
t('it says it is not financial advice', /not financial advice/.test(view))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
