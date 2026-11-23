// The Outlook tab's maths (src/outlook.js). "3 cases chart with neutral, bullish, bearish.
// include strength/rating" and "include ... the range category ... 4h candles and a good amount
// of candles".
import fs from 'fs'
import { normCdf, vol4h, sigmaFor, touchProb, firstTouchUp, macdHist, rangeRead, factors, scoreOf, posOf, guardsOf, scenarios, outlookFor, RANGE_CANDLES, RANGE_LOOKBACK, WEIGHTS, pastSamples, pastRecord, candleScoreOf, CANDLE_FACTORS, PAST_HORIZONS, signalRecords, learnedWeights, learnedScores, weightedScore, coneRecord, pooledRecord, pooledSignals, pooledBands, pooledHalves, pooledHorizons, pooledCone, BANDS, candleIds } from '../../src/outlook.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b, e = 1e-3) => Math.abs(a - b) <= e

// A deterministic wiggle: 4h candles around `px`, range ~1% of price, alternating direction.
const H4 = 4 * 3600e3
function candles(n, { px = 100, drift = 0, range = 0.01 } = {}) {
  const out = []
  let c = px
  for (let i = 0; i < n; i++) {
    const o = c
    c = o * (1 + drift + (i % 2 ? 0.004 : -0.004) * ((i % 5) / 4 + 0.5))
    const mid = (o + c) / 2, r = mid * range * (0.8 + 0.4 * ((i * 7) % 5) / 4)
    out.push({ t: i * H4, o, c, h: Math.max(o, c, mid + r / 2), l: Math.min(o, c, mid - r / 2) })
  }
  return out
}
// The same, ending in `k` candles `mult` times normal in direction `dir`.
function endingWith(k, mult, dir, n = RANGE_CANDLES) {
  const cs = candles(n - k)
  let c = cs.at(-1).c
  for (let i = 0; i < k; i++) {
    const o = c, r = o * 0.01 * mult
    c = o + dir * r * 0.8
    cs.push({ t: cs.at(-1).t + H4, o, c, h: Math.max(o, c) + r * 0.1, l: Math.min(o, c) - r * 0.1 })
  }
  return cs
}

console.log('-- the maths --')
t('normCdf: 0 → .5, 1.96 → .975', near(normCdf(0), 0.5) && near(normCdf(1.96), 0.975, 1e-3) && near(normCdf(-1.96), 0.025, 1e-3))
t('touching a level one σ away: ~31.7%', near(touchProb(100, 100 * Math.exp(0.05), 0.05), 0.3173, 2e-3))
t('touching is symmetric in log price', near(touchProb(100, 110, 0.05), touchProb(100, 100 / 1.1, 0.05)))
t('the price you are at: certain', near(touchProb(100, 100, 0.05), 1, 1e-6))
t('no volatility, no chance figure (unknown, not 0)', touchProb(100, 110, null) === null && touchProb(100, 110, 0) === null)
t('TP and SL equally far in log price: 50/50', near(firstTouchUp(100, 110, 100 / 1.1), 0.5))
t('a nearer TP comes first more often', firstTouchUp(100, 105, 90) > 0.5)
t('a TP below the price is not a TP', firstTouchUp(100, 95, 90) === null)
t('σ scales with the square root of time', near(sigmaFor(0.01, 16), 0.02) && sigmaFor(null, 24) === null)
const v = vol4h(candles(200))
t('4h volatility from the candles', v > 0.001 && v < 0.02, v)
t('too few candles: unknown', vol4h(candles(20)) === null)
t('MACD needs 60 bars', macdHist([1, 2, 3]) === null && typeof macdHist(candles(80).map(k => k.c)).now === 'number')

console.log('-- the Range category, on 4h --')
t(`reads ${RANGE_CANDLES} 4h candles against the ${RANGE_LOOKBACK} before each one`, RANGE_CANDLES >= 500 && RANGE_LOOKBACK === 200)
const calm = rangeRead(candles(RANGE_CANDLES))
t('normal candles: no lean', calm && calm.v === 0 && calm.big === 0, calm)
const bull = rangeRead(endingWith(2, 3.5, +1))
t('two big green 4h candles lean up', bull && bull.v > 0 && bull.up === 2 && bull.big === 2, bull)
const bear = rangeRead(endingWith(2, 3.5, -1))
t('two big red ones lean down, as much', bear && near(bear.v, -bull.v), bear)
t('big candles mean an expanding market', rangeRead(endingWith(6, 3, +1))?.regime === 'expanding')
const huge = rangeRead(endingWith(1, 6, +1)), older = rangeRead([...endingWith(1, 6, +1, RANGE_CANDLES - 3), ...candles(3, { px: 120 }).map((k, i) => ({ ...k, t: (RANGE_CANDLES + i) * H4 }))])
t('a bigger category counts more', huge.v > rangeRead(endingWith(1, 2.5, +1)).v)
t('an older big candle counts less', older && older.v < huge.v, { older, huge })
t('the latest candle\'s category is signed', huge.last >= 8 && bear.last <= -7)
t('without a normal (too little history): unknown', rangeRead(candles(150)) === null)

console.log('-- the score --')
const c4 = endingWith(2, 3.5, +1), c1 = candles(260, { drift: 0.002 })
const price = c1.at(-1).c
const fs1 = factors({ price, c4, c1, setup: { state: 'support' }, fundingPctHr: 0.00125, ratio: 1.5 })
t('six factors when every input is there', fs1.map(f => f.id).join() === 'trend,momentum,range,levels,book,funding', fs1.map(f => f.id))
t('weights add to 100', Object.values(WEIGHTS).reduce((s, x) => s + x, 0) === 100)
const s1 = scoreOf(fs1)
t('an uptrend with big green candles at support scores bullish', s1.score > 0 && s1.lean === 'up', s1)
const fs2 = factors({ price, c4, c1, setup: null })
t('missing data is left out, not counted as neutral', fs2.length === 3 && scoreOf(fs2).coverage < 1, fs2.map(f => f.id))
t('nothing at all: no score', scoreOf([]) === null)
t('crowded longs lean down (funding is contrarian)', factors({ price, c4, c1, fundingPctHr: 0.02 }).find(f => f.id === 'funding').v === -1)
t('strength bands', scoreOf([{ w: 10, v: 0.1 }]).strength === 'neutral' && scoreOf([{ w: 10, v: 0.3 }]).strength === 'weak'
  && scoreOf([{ w: 10, v: 0.5 }]).strength === 'moderate' && scoreOf([{ w: 10, v: -0.8 }]).strength === 'strong' && scoreOf([{ w: 10, v: -0.8 }]).lean === 'down')

console.log('-- the position --')
const P = { coin: 'ETH', szi: '2', entryPx: '3000', liquidationPx: '2400', unrealizedPnl: '200', marginUsed: '600', leverage: { value: 10 } }
const pos = posOf(P)
t('a long, with its liquidation', pos.side === 'long' && pos.liq === 2400 && pos.lev === 10)
t('no position: null', posOf({ coin: 'ETH', szi: '0' }) === null && posOf(null) === null)
const orders = [
  { coin: 'ETH', orderType: 'Take Profit Market', triggerPx: '3500' }, { coin: 'ETH', orderType: 'Take Profit Market', triggerPx: '3300' },
  { coin: 'ETH', orderType: 'Stop Market', triggerPx: '2800' }, { coin: 'BTC', orderType: 'Stop Market', triggerPx: '1' },
  { coin: 'ETH', orderType: 'Limit', limitPx: '2900' },
]
const g = guardsOf(pos, orders)
t('its nearest TP and stop, from trigger orders only', g.tp === 3300 && g.sl === 2800, g)
t('in the combined view, only its own account\'s orders', guardsOf({ ...pos, acctAddr: '0xa' }, [{ coin: 'ETH', orderType: 'Stop Market', triggerPx: '2900', _acctAddr: '0xb' }]).sl === null)

console.log('-- the three cases --')
const sc = scenarios({ pos, price: 3100, sigma: 0.05, setup: { resistance: { lo: 3200 }, support: { hi: 2000 } } })
t('bullish stops at the next resistance inside 2σ', sc.bull.px === 3200 && sc.bull.level === 'resistance', sc.bull)
t('bearish: support out of reach, so −1σ', near(sc.bear.px, 3100 * Math.exp(-0.05)) && sc.bear.level === null)
t('neutral is here, and its P&L is today\'s', sc.neutral.px === 3100 && sc.neutral.pnl === 200 && sc.neutral.change === 0)
t('each case\'s P&L is the position at that price', near(sc.bull.pnl, 2 * (3200 - 3000)))
t('neutral\'s chance is touching neither', near(sc.neutral.p, 1 - sc.bull.p - sc.bear.p))
const scLiq = scenarios({ pos: { ...pos, liq: 3000 }, price: 3100, sigma: 0.05, setup: null })
t('a case past liquidation says so, and loses the margin', scLiq.bear.liquidated && scLiq.bear.pnl === -600, scLiq.bear)
const short = posOf({ ...P, szi: '-2', liquidationPx: '3700' })
t('a short gains in the bearish case', scenarios({ pos: short, price: 3100, sigma: 0.05 }).bear.pnl > scenarios({ pos: short, price: 3100, sigma: 0.05 }).bull.pnl)

console.log('-- the whole card --')
const o = outlookFor({ position: P, price, c4, c1, setup: { state: 'resistance' }, ratio: 0.7, fundingPctHr: 0.001, orders, hours: 24 })
t('a card has its cone, score, cases and risk', o.sigma > 0 && o.score && o.cases && o.risk?.liq && o.risk.tp && o.risk.sl)
t('7 days is a wider cone than 24 hours', outlookFor({ position: P, price, c4, c1, hours: 168 }).sigma > o.sigma)
t('it says whether the lean agrees with the position', o.agrees === null || typeof o.agrees === 'boolean')
t('a flat lean neither agrees nor disagrees', outlookFor({ position: P, price, c4: candles(RANGE_CANDLES), c1: [], hours: 24 }).score?.lean !== 'flat' || outlookFor({ position: P, price, c4: candles(RANGE_CANDLES), c1: [], hours: 24 }).agrees === null)
t('no price: no cases, not made-up ones', outlookFor({ position: P, price: null, c4, c1 }).cases === null)

console.log('-- the track record: the replay --')
// A year of 4h candles and three of daily, from a seeded random walk: no signal can know where
// it goes next, so no record may claim one does.
let seed = 7
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const walk = (n, step, vol, t0 = 0) => { let c = 100; return Array.from({ length: n }, (_, i) => { const o = c; c = o * (1 + (rnd() - 0.5) * vol); return { t: t0 + i * step, o, c, h: Math.max(o, c) * 1.004, l: Math.min(o, c) * 0.996 } }) }
const Y4 = walk(2190, 4 * 3600e3, 0.03), Y1 = walk(1000, 864e5, 0.07, -635 * 864e5)
const S = pastSamples(Y4, Y1)
t('one sample a day across the year', S.length > 300 && S.length < 340, S.length)
t('each keeps its signals, its score and an outcome per horizon', S.every(x => Number.isInteger(x.s) && 'trend' in x.f && PAST_HORIZONS.every(h => h in x.out)))
// 30d added with "add more smaller and higher timeframes". 1h is not here: the candles are 4h.
t('replayed at 4h, 24h, 3d, 7d and 30d', PAST_HORIZONS.join() === '4,24,72,168,720')
const k10 = S[10], i10 = k10.i
t('a 24h outcome is six 4h candles on', Math.abs(k10.out[24].ret - Math.log(Y4[i10 + 6].c / Y4[i10].c)) < 1e-12)
t('it knows whether the cone\'s lines were touched on the way', typeof k10.out[24].up === 'boolean' && typeof k10.out[24].dn === 'boolean')
t('a horizon not over by the end of the data is unknown, not 0', S.at(-1).out[168] === null)
// Change everything after a sample's own candle: its signals must not move. If they did, it was
// reading its own future.
const cut = Y4.map((k, i) => i > i10 ? { ...k, c: k.c * 3, h: k.h * 3, l: k.l * 3, o: k.o * 3 } : k)
const Sb = pastSamples(cut, Y1)
t('no sample sees its own future', JSON.stringify(Sb.find(x => x.t === k10.t)?.f) === JSON.stringify(k10.f))

console.log('-- the track record: what it says --')
const R = pastRecord(S, 50, 24)
t('a random walk is no better than chance', ['chance', 'thin'].includes(R.verdict), R)
t('the base rate is reported alongside', R.base > 0.3 && R.base < 0.7)
t('and the size of the move: after the reading, and on any day', typeof R.avgAfter === 'number' && typeof R.avgAll === 'number')
const sig = signalRecords(S, 24)
t('each candle signal has its own record', CANDLE_FACTORS.every(id => id in sig))
t('on a random walk none of them beats chance', CANDLE_FACTORS.every(id => ['chance', 'thin', 'none'].includes(sig[id].verdict)), sig)
const cone = coneRecord(S, 168)
t('the cone is checked: inside 1σ, and each line touched', cone.n > 300 && cone.inside > 0.5 && cone.inside < 0.9 && cone.up > 0.15 && cone.dn > 0.15, cone)
t('expected: 68% inside, 32% a touch', cone.expInside === 0.6827 && cone.expTouch === 0.3173)

// A market where TREND always calls it and momentum always calls it backwards.
const mk = (n) => Array.from({ length: n }, (_, j) => {
  const dir = j % 3 ? 1 : -1, ret = dir * 0.01
  return { t: j, i: j * 6, f: { trend: dir * 0.8, momentum: -dir * 0.8, range: 0 }, s: 0, out: Object.fromEntries(PAST_HORIZONS.map(h => [h, { ret, sigma: 0.02, up: dir > 0, dn: dir < 0 }])) }
})
const M = mk(300)
const sr = signalRecords(M, 24)
t('a signal that called it is better than chance, one that called it backwards worse', sr.trend.verdict === 'better' && sr.trend.rate === 1 && sr.momentum.verdict === 'worse', sr)
t('its edge is the average move in the called direction', sr.trend.edge > 0.9 && sr.momentum.edge < -0.9)
const lw = learnedWeights(M, 24)
t('learned: the one that works counts more, the one that does not counts less', lw.trend > 1.5 && lw.momentum < 0.5 && lw.range === 1, lw)
t('never below ×0.25 or above ×2, never flipped', Object.values(lw).every(m => m >= 0.25 && m <= 2))
t('few calls pull towards ×1', learnedWeights(mk(12), 24).trend < lw.trend)
t('learning uses only outcomes known by then', JSON.stringify(learnedWeights(M, 24, 0)) === '{"trend":1,"momentum":1,"range":1}'
  && learnedWeights(M, 24, M[5].i).trend < lw.trend)
const L = learnedScores(M, 24)
t('the learned score on each past day used only the days before it', L.get(M[0]) === weightedScore(M[0].f, null) && L.get(M[299]) !== L.get(M[0]) * 0 + weightedScore(M[299].f, null))
const lr = pastRecord(M, weightedScore(M.at(-1).f, lw), 24, x => L.get(x))
t('and graded that way, learning that helps shows as better than chance', lr.verdict === 'better', lr)
t('weighted score: the multipliers count', weightedScore({ trend: 1, momentum: -1 }, { trend: 2, momentum: 0.25 }) > weightedScore({ trend: 1, momentum: -1 }, null))
const pool = pooledRecord([S, M], 24)
t('pooled across markets: both leans, the markets counted, the cone', pool.markets === 2 && pool.up.n > 0 && pool.down.n > 0 && pool.cone.n > 0, pool)

// ── the pooled section's own figures ("add more data/signals ... I mean the pooled section") ──
{
  const B = [S, M]
  console.log('\n-- pooled: each signal across every market --')
  const ps = pooledSignals(B, 24)
  t('every signal with history gets a record', candleIds(24).every(id => ps[id] && typeof ps[id].n === 'number'), ps)
  t('a signal that called it counts as better than chance, one that called it backwards worse',
    ps.trend.verdict === 'better' && ps.momentum.verdict === 'worse', { t: ps.trend, m: ps.momentum })
  t('its edge is the average move in the called direction', ps.trend.edge > 0 && ps.momentum.edge < 0)
  // `markets` counts the ones that actually made calls, not the ones handed in: a market whose
  // signal never crossed CALL_AT has nothing to contribute and must not inflate the count.
  const withTrend = [S, M].filter(x => (signalRecords(x, 24).trend?.n ?? 0) > 0).length
  t('and it says how many markets actually contributed calls', ps.trend.markets === withTrend, [ps.trend.markets, withTrend])
  t('a market that made no calls is not counted as one that did', pooledSignals([M, []], 24).trend.markets === 1)
  // Pooling ADDS the calls: one market's record cannot be the pooled one.
  t('calls add across markets', ps.trend.n === signalRecords(S, 24).trend.n + signalRecords(M, 24).trend.n,
    [ps.trend.n, signalRecords(S, 24).trend.n, signalRecords(M, 24).trend.n])

  console.log('\n-- pooled: the reading bands --')
  const pb = pooledBands(B, 24)
  t('one row per band, in order', pb.length === BANDS.length && pb.map(b => b.band).join() === BANDS.map(b => b.id).join(), pb.map(b => b.band))
  t('every day lands in exactly one band', pb.reduce((a, b) => a + b.n, 0) === S.filter(x => x.out[24]).length + M.filter(x => x.out[24]).length,
    pb.map(b => b.n))
  t('a band with no days is not a 0% one, it is nothing', pooledBands([[]], 24).every(b => b.n === 0 && b.verdict === 'none'))

  console.log('\n-- pooled: both halves, and every horizon --')
  const ph = pooledHalves(B, 24)
  t('two halves', ph.length === 2 && ph.every(x => x && x.n > 0), ph)
  t('together they are every directional call', ph[0].n + ph[1].n === pool.up.n + pool.down.n, [ph[0].n, ph[1].n, pool.up.n + pool.down.n])
  t('too little history: no halves at all, rather than two empty ones', pooledHalves([mk(2)], 24) === null)

  const hz = pooledHorizons(B)
  t('one row per horizon', hz.length === PAST_HORIZONS.length && hz.map(x => x.h).join() === PAST_HORIZONS.join())
  t('the 24h row is the same calls pooledRecord counted', hz.find(x => x.h === 24).n === pool.up.n + pool.down.n)

  console.log('\n-- pooled: the cone, with both its lines --')
  const pc = pooledCone(B, 24)
  t('it agrees with the cone the summary line shows', pc.n === pool.cone.n && Math.abs(pc.inside - pool.cone.inside) < 1e-9, [pc.inside, pool.cone.inside])
  t('and adds the two lines the summary did not have', pc.up != null && pc.dn != null && pc.markets === 2, pc)
  t('no history, no cone', pooledCone([[], []], 24) === null)

  console.log('\n-- pooling does not let one market speak for the others --')
  // A market that only ever went up makes "bullish" look right on its own terms. Chance is each
  // market's OWN base rate weighted by the calls it made there, so the pooled figure is measured
  // against the market it came from rather than against the whole basket's drift.
  const drift = Array.from({ length: 200 }, (_, j) => ({ t: j, i: j * 6, f: { trend: 0.8, momentum: 0.8, range: 0 }, s: 0,
    out: Object.fromEntries(PAST_HORIZONS.map(h => [h, { ret: 0.01, sigma: 0.02, up: true, dn: false }])) }))
  const withDrift = pooledSignals([M, drift], 24)
  t('a one-way market cannot drag a signal past chance on its own',
    withDrift.trend.chance > 0.6, withDrift.trend.chance)
  t('its own base rate is what its calls are judged against', signalRecords(drift, 24).trend.chance > 0.9,
    signalRecords(drift, 24).trend.chance)
}
t('no samples: no record, not a 0% one', pastRecord([], 40, 24) === null && coneRecord([], 24) === null)
t('the past record replays only the signals with history', CANDLE_FACTORS.join() === 'trend,momentum,range'
  && candleScoreOf([{ id: 'trend', w: 25, v: 1 }, { id: 'book', w: 10, v: -1 }]).score === 100)
const om = outlookFor({ position: P, price, c4, c1, hours: 24, mult: { trend: 2, momentum: 0.25, range: 1 } })
t('the card\'s score takes the learned multipliers; its coverage does not', om.factors.find(f => f.id === 'trend').m === 2 && om.score.coverage <= 1)

console.log('-- the record, in detail --')
const O2 = await import('../../src/outlook.js')
const bt = O2.bandTable(S, 24)
t('every reading band, strongest bearish to strongest bullish', bt.map(b => b.band).join() === 'sbear,bear,neutral,bull,sbull', bt?.map(b => b.band))
t('the bands cover every day exactly once', bt.reduce((s, b) => s + b.n, 0) === S.filter(x => x.out[24]).length)
t('each with its own chance and move after', bt.every(b => b.base > 0 && b.base < 1 && (!b.n || typeof b.avgAfter === 'number')))
t('a score belongs to one band', O2.bandOfScore(-50).id === 'sbear' && O2.bandOfScore(-20).id === 'bear' && O2.bandOfScore(0).id === 'neutral' && O2.bandOfScore(15).id === 'bull' && O2.bandOfScore(40).id === 'sbull')
const hv = O2.halvesRecord(S, 20, 24)
t('the same reading in each half of the year', hv.length === 2 && hv.every(x => x === null || typeof x.n === 'number'))
const like = O2.recentLike(S, 20, 24)
t('the last days that read like today, newest first', like.length > 0 && like.length <= 8 && like.every((x, i) => !i || x.t < like[i - 1].t) && like.every(x => typeof x.hit === 'boolean'))
t('…each one in the same band as today', like.every(x => O2.bandOfScore(x.s).id === O2.bandOfScore(20).id))
const wt = O2.weightsOverTime(M, 24)
t('how the learned weights moved: a quarter, a half, three quarters, now', wt.length === 4 && wt.every((w, i) => !i || w.t > wt[i - 1].t) && wt.every((w, i) => !i || w.m.trend >= wt[i - 1].m.trend) && wt.every(w => w.m.trend <= 2 && w.m.momentum >= 0.25), wt.map(w => w.m.trend))
const md = O2.moveDistribution(S, 24)
t('moves in σ against what a normal distribution expects', md.length === 5 && Math.abs(md.reduce((s, b) => s + b.expect, 0) - 1) < 1e-6 && Math.abs(md.reduce((s, b) => s + b.share, 0) - 1) < 1e-9)
t('no replay: no detail, not zeros', O2.bandTable([], 24) === null && O2.moveDistribution([], 24) === null && O2.recentLike([], 20, 24).length === 0)

console.log('-- wiring --')
const main = fs.readFileSync('src/main.js', 'utf8'), html = fs.readFileSync('index.html', 'utf8'), ana = fs.readFileSync('src/analysis.js', 'utf8')
const view = fs.readFileSync('src/outlookview.js', 'utf8')
t('a home tab on the phone', /id="mobVTab-outlook"/.test(html) && /_mobVActiveTab === 'outlook'/.test(main))
t('a tab on desktop', /switchTab\('outlook',this\)/.test(html) && /id="tab-outlook"/.test(html) && /name === 'outlook'/.test(main))
t('positions are unknown until loaded, not empty', /positions: \(\) => state\.perpState \? \(state\.perpState\.assetPositions \?\? \[\]\) : null/.test(main))
t('candles come from the Analysis cache', /export function analysisRaw/.test(ana) && /ensureAnalysis\(due\)/.test(view))
t('markets load one at a time, and not again for 15 minutes', /const RELOAD_MS = 15 \* 60e3/.test(view) && /for \(;;\)/.test(view))
t('the footer says it is not a prediction', /Not a prediction/.test(view))
// "group same assets cards together with all individual and account data including account name"
// The card now takes the whole item, so it can leave its sort keys on it (sortCards).
t('one card per market: positions are grouped by coin', view.includes('groups.get(p.coin).push(p)') && view.includes('function cardHtml(item, ctx) {') && view.includes('const { coin, ps, raw, price, state } = item'))
t('a single-account view names its account too', /acctName: \(\) => state\.addr === PAPER_ADDR/.test(main) && /nameOf = \(p\) => p\._acct \?\? ctx\.acctName\?\.\(\)/.test(view))
t('the card weighs the candle signals by how they did on that market', /mult: past\.mult/.test(view) && /learnedWeights\(e\.samples, h\)/.test(view))
t('the replay is once per market load, shared by every horizon', /pastSamples\(raw\.candles\['4h'\], raw\.candles\['1d'\]\)/.test(view))
// "when i visit the oracle section and exit it redirects me again to oracle"
t('a redraw after the tab was left draws nothing; only opening the tab builds it', view.includes('if (!onScreen(host) && !fromRender) return') && view.includes('paint(!tick, true)'))
t('and loading for it stops once it is left', view.includes('if (!onScreen(last?.host)) return'))
t('only a full read is reported to the live record', /if \(\(o\.score\?\.coverage \?\? 0\) >= 0\.9\) logRating/.test(view))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
