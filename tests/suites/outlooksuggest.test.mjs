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

console.log('-- wiring --')
const view = fs.readFileSync('src/outlookview.js', 'utf8')
t('the lean always comes from the 4h set', /const p4 = pastAt\(coin, raw, 4\)/.test(view) && /hours: 4, mult: p4\.mult, sigmaScale: p4\.scale/.test(view))
t('its record is the learned 4h score\'s, on this market', /pastRecord\(p4\.samples, learned4, 4, x => p4\.learned\.get\(x\)\)/.test(view))
t('each account gets its own actions', /actionsFor\(L, outs\[i\], setup\)/.test(view))
t('it says it is not financial advice', /not financial advice/.test(view))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
