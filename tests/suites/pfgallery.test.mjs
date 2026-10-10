// The /portfolios gallery card, computed once on the server instead of once per visitor.
//
// Reported as "each time i enter the portfolios in the landing page the performance seems
// that is being calculated per device instead of server side". It was: /portfolios-data sent
// the definitions only, and every browser fetched a daily history per holding from
// Hyperliquid and ran every backtest itself, out of caches that died with the page.
//
// What these fix in place is the two things that make the fix safe rather than fast:
// the two sides cannot price a card differently, and the server cannot spend the bots' API
// budget to do it.
import fs from 'fs'
import {
  WINDOWS, HIST_FROM, SPARK_POINTS, GAL_FEE_BPS, GAL_CAPITAL,
  windowOf, galBacktest, coinsOf, coinFile, stalest, thin, round4, packResult, buildPerf,
} from '../../src/pfgallery.js'

const gal = fs.readFileSync('src/pfgallery.js', 'utf8').replace(/\r\n/g, '\n')
const sp  = fs.readFileSync('serve-prod.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/portfolio.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const DAY = 86400000

console.log(nl + '-- one definition of a gallery card, not two --')
{
  // Two implementations of "what the card says" would disagree the first time either
  // changed, and the disagreement would be a number on a public page.
  t('the server calls the shared backtest', sp.includes("from './src/pfgallery.js'") && gal.includes('export function galBacktest'))
  t('and so does the browser', cli.includes("import { galBacktest } from './pfgallery.js'") && cli.includes('const r = galBacktest(candles, items, from, to)'))
  t('neither keeps its own fee', gal.includes('export const GAL_FEE_BPS') && GAL_FEE_BPS === 4.5 && GAL_CAPITAL === 10_000)
  t('and the browser no longer builds its own options', !/strategies: \['hold'\], opts: \{ capital: 10_000/.test(cli))
  // The window arithmetic has to be the same too, or the two price different spans.
  const now = Date.UTC(2026, 9, 9, 13, 30)
  const dayOf = (x) => Math.floor(x / DAY) * DAY
  t('a numbered window is whole days back from today', windowOf('365', now).from === dayOf(now) - 365 * DAY)
  t('"max" reaches back to the first day there is any history', windowOf('max', now).from === HIST_FROM)
  t('and every window ends now', WINDOWS.every(w => windowOf(w, now).to === now))
}

console.log(nl + '-- the packed card says the same as the full one --')
{
  // A synthetic market that rises, dips hard, and recovers — so ret, maxDd and the sparkline
  // all have something to be wrong about.
  const t0 = Date.UTC(2025, 0, 1)
  const price = (i) => 100 * (1 + 0.004 * i) * (i > 120 && i < 180 ? 0.55 : 1)
  const closes = { AAA: Array.from({ length: 400 }, (_, i) => [t0 + i * DAY, price(i)]),
                   BBB: Array.from({ length: 400 }, (_, i) => [t0 + i * DAY, 50 + i * 0.1]) }
  const items = [{ key: 'AAA', weight: 0.6 }, { key: 'BBB', weight: 0.4 }]
  const now = t0 + 399 * DAY
  const full = galBacktest(closes, items, windowOf('365', now).from, now)
  const packed = packResult(full)
  t('a run becomes a card', packed?.state === 'ok')
  t('the return is the run\'s own, to six figures', packed.run.ret === round4(full.runs[0].ret))
  t('and so is the drawdown', packed.run.maxDd === round4(full.runs[0].maxDd))
  t('a card with no run is null, not a flat card', packResult({ runs: [] }) === null && packResult(null) === null)
  // The card prints maxDd to one decimal of a percent and ret through pct(): six significant
  // figures is far more than either can show.
  t('rounding cannot change what is printed',
    (packed.run.maxDd * 100).toFixed(1) === (full.runs[0].maxDd * 100).toFixed(1))
}

console.log(nl + '-- the sparkline keeps its shape --')
{
  t('a short series is left alone', thin([1, 2, 3], 48).length === 3)
  const v = Array.from({ length: 1000 }, (_, i) => Math.sin(i / 40) * 100 + i)
  const out = thin(v, 48)
  t('a long one is cut to about the asked-for size', out.length <= 52 && out.length >= 48, out.length)
  // Taking every Nth would quietly clip the high and the low, which are the two points a
  // reader actually looks at.
  t('the high survives the cut', Math.max(...out) === Math.max(...v))
  t('and so does the low', Math.min(...out) === Math.min(...v))
  t('the ends are still the ends', out[0] === v[0] && out.at(-1) === v.at(-1))
  t('and it stays in order', out.every((x, i) => i === 0 || v.indexOf(x) >= v.indexOf(out[i - 1])))
  t('48 points over a 240px svg is a point every five pixels', SPARK_POINTS === 48)
}

console.log(nl + '-- which markets, and which one next --')
{
  const ps = [{ id: 'a', items: [{ coin: 'BTC', w: 0.5 }, { coin: 'ETH', w: 0.5 }] },
              { id: 'b', items: [{ coin: 'BTC', w: 1 }, { coin: 'SOL', w: 0 }] }]
  t('every market with a weight, once', coinsOf(ps).sort().join() === 'BTC,ETH')
  t('a weight of zero is not a market to price', !coinsOf(ps).includes('SOL'))
  t('nothing in, nothing out', coinsOf(null).length === 0 && coinsOf([{}]).length === 0)

  // HL ids carry ':' and '@', which are not filename characters — and '..' and '/' must not
  // survive into a path this server reads.
  t('a plain ticker is its own name', coinFile('BTC') === 'BTC')
  t('a builder perp is escaped', !coinFile('xyz:NVDA').includes(':'))
  t('and a spot market id', !coinFile('@700').includes('@'))
  t('nothing can walk out of the directory',
    !coinFile('../../etc/passwd').includes('/') && !coinFile('../x').includes('/'))
  // '..' is all dots, so the separator escape alone left it untouched.
  t('and a name cannot be all dots, nor begin with one',
    coinFile('..') !== '..' && !coinFile('.lock').startsWith('.'))
  t('two different markets cannot land on one file', coinFile('A:B') !== coinFile('A-B') && coinFile('@1') !== coinFile('@2'))
}

console.log(nl + '-- the pacing, which is the whole reason for the design --')
{
  // 102 markets x weight 20 is 2,040 against a 1,200/minute budget, on the IP the bots use.
  const now = 1_000_000_000
  const TTL = 22 * 3600e3
  const at = { A: now - 1000, B: now - TTL - 5000, C: now - TTL - 90_000 }
  t('the stalest past the TTL is next', stalest(['A', 'B', 'C'], c => at[c], TTL, now) === 'C')
  t('one at a time — never a list', typeof stalest(['A', 'B', 'C'], c => at[c], TTL, now) === 'string')
  t('nothing stale means nothing fetched', stalest(['A'], () => now, TTL, now) === null)
  t('never fetched sorts first', stalest(['A', 'D'], c => at[c] ?? 0, TTL, now) === 'D')
  t('an empty list asks for nothing', stalest([], () => 0, TTL, now) === null && stalest(null, () => 0, TTL, now) === null)

  t('the server fetches exactly one market a tick', /const coin = stalest\(coins, pfcAt, PFC_TTL\)\s*\n\s*if \(!coin\) return/.test(sp))
  t('at most one a minute', /const PFC_TICK = 60_000/.test(sp))
  t('and at most once a day per market', /const PFC_TTL  = 22 \* 3600e3/.test(sp))
  // serve-prod runs as a cluster; every worker holds this timer.
  t('one worker fetches, not all of them', sp.includes('PFC_LOCK') && /Date\.now\(\) - statSync\(PFC_LOCK\)\.mtimeMs < PFC_LOCK_TTL/.test(sp))
  t('and it lets the lock go even when the fetch threw', /finally \{\s*\n\s*try \{ if \(readFileSync\(PFC_LOCK/.test(sp))
  // A market that answers with nothing is still recorded, or it is chosen again next tick
  // and starves every market behind it.
  t('a market that answered with nothing is still stamped', /writeAtomic\(join\(PFC_DIR, coinFile\(coin\) \+ '\.json'\), JSON\.stringify\(\{ coin, at: Date\.now\(\), closes \}\)\)/.test(sp))
  t('the reason is written down', sp.includes('starves every market behind it'))
  t('and why it is a trickle at all', sp.includes('2,040 weight') && sp.includes('shares its IP with the bots') === false && sp.includes('shares its Hyperliquid IP with the bots'))
}

console.log(nl + '-- absent is not empty --')
{
  const t0 = Date.UTC(2025, 0, 1)
  const closes = { AAA: Array.from({ length: 200 }, (_, i) => [t0 + i * DAY, 100 + i]) }
  const ps = [{ id: 'have', items: [{ coin: 'AAA', w: 1 }] },
              { id: 'missing', items: [{ coin: 'AAA', w: 0.5 }, { coin: 'ZZZ', w: 0.5 }] },
              { id: 'nothing', items: [{ coin: 'AAA', w: 0 }] }]
  const perf = buildPerf(ps, closes, t0 + 199 * DAY)
  t('a portfolio the prices cover is answered', !!perf.have && WINDOWS.every(w => perf.have[w]))
  // The browser reads a missing id as "work it out yourself". An entry of null would be a
  // claim that there is nothing to show — the empty-is-not-unknown rule, on a public page.
  t('one with a market we have no price for is ABSENT, not null',
    !('missing' in perf) && perf.missing === undefined)
  t('and one with no weighted holding is absent too', !('nothing' in perf))
  t('the reason is written down', gal.includes('absent means "the server has no answer"'))
}

console.log(nl + '-- what the browser does with it --')
{
  // Per price mode since the Price data buttons: an answer is used only for the mode on screen.
  t('the server\'s answer is used as it is, with nothing fetched — for the mode on screen',
    /const ready = galPerfSrc === srcMode\(\) \? galPerf\?\.\[p\.id\]\?\.\[String\(galTf\)\] : null\s*\n\s*if \(ready\) return ready/.test(cli))
  t('and a card it cannot answer still falls through to the old path',
    cli.includes("if (items.some(i => galFailed.has(srcMode() + '|' + i.key))) return { state: 'failed' }"))
  // On a warm cache this is every featured portfolio, so the page makes no HL calls at all.
  t('prices are only fetched for cards the server did not answer',
    /\.filter\(p => !\(galPerfSrc === srcMode\(\) && galPerf\?\.\[p\.id\]\)\)/.test(cli))
  t('perf is read off the response', /galPerf = \(j\.perf && typeof j\.perf === 'object'\) \? j\.perf : \{\}/.test(cli))
  t('and the route sends it, for the mode asked', /return send\(200, \{ portfolios: pfRead\(\), perf, asOf, src: /.test(sp) && sp.includes('pfPerfNow(mode)'))
  t('a failed build still serves the portfolios', /let perf = \{\}, asOf = 0/.test(sp) && /catch \(e\) \{ console\.warn\('\[portfolios\] perf failed/.test(sp))
  t('publishing a portfolio rebuilds the cards, in every mode', /pfCache = null\s*\n\s*pfPerfBy\.clear\(\)/.test(sp))
  t('and so does a new price, Hyperliquid or outside', /pfcMem\.delete\(coin\)\s*\n\s*pfPerfBy\.clear\(\)/.test(sp) && /pfxMem\.delete\(key\)\s*\n\s*pfPerfBy\.clear\(\)/.test(sp))
  // A window is measured from "now", so a build kept for a day would quietly slide.
  t('the build does not outlive the day it was measured in', /Date\.now\(\) - hit\.at < 3600e3/.test(sp))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
