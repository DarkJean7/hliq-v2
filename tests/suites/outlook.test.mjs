// The Outlook tab's maths (src/outlook.js). "3 cases chart with neutral, bullish, bearish.
// include strength/rating" and "include ... the range category ... 4h candles and a good amount
// of candles".
import fs from 'fs'
import { normCdf, vol4h, sigmaFor, touchProb, firstTouchUp, macdHist, rangeRead, factors, scoreOf, posOf, guardsOf, scenarios, outlookFor, RANGE_CANDLES, RANGE_LOOKBACK, WEIGHTS } from '../../src/outlook.js'

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

console.log('-- wiring --')
const main = fs.readFileSync('src/main.js', 'utf8'), html = fs.readFileSync('index.html', 'utf8'), ana = fs.readFileSync('src/analysis.js', 'utf8')
const view = fs.readFileSync('src/outlookview.js', 'utf8')
t('a home tab on the phone', /id="mobVTab-outlook"/.test(html) && /_mobVActiveTab === 'outlook'/.test(main))
t('a tab on desktop', /switchTab\('outlook',this\)/.test(html) && /id="tab-outlook"/.test(html) && /name === 'outlook'/.test(main))
t('positions are unknown until loaded, not empty', /positions: \(\) => state\.perpState \? \(state\.perpState\.assetPositions \?\? \[\]\) : null/.test(main))
t('candles come from the Analysis cache', /export function analysisRaw/.test(ana) && /ensureAnalysis\(due\)/.test(view))
t('markets load one at a time, and not again for 15 minutes', /const RELOAD_MS = 15 \* 60e3/.test(view) && /for \(;;\)/.test(view))
t('the footer says it is not a prediction', /Not a prediction/.test(view))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
