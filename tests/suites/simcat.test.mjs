// Trade Simulator, Range category: the category guide, the band, follow/fade, and exits that
// can each be switched off or set per side (src/simcat.js, src/backtest.js).
//
// Asked for: "currently i can set the entry category from 1-6 but is lacking the visual of
// letting the user know what is a category 1 vs 2, vs 3, etc. also allow to turn off tp/sl
// individually. make it more visual and flexible." And, from the original script it came from:
// longs took 100/50 pips, shorts 30/30 -- one pair for both sides could not say that.
import fs from 'fs'
import { runBacktest, signals, normalise, coerceParams, classify, categoryOf, rangeBaseline, runPortfolio,
         BT_DEFAULTS, BT_FIELDS, BT_CHOICES, migrateCatScale, catRange } from '../../src/backtest.js'
import { catStats, catGuideHtml, levelsHtml, catTradeStats } from '../../src/simcat.js'

const sim = fs.readFileSync('src/simulator.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

// Flat candles one dollar tall around 100, with a few big ones placed where we want them.
const flat = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 36e5, o: 100, h: 100.5, l: 99.5, c: 100 }))
function withBig(n, big) {
  const r = flat(n)
  for (const [i, range, green] of big) {
    r[i] = green ? { t: i * 36e5, o: 100 - range / 2 + 0.05, h: 100 + range / 2, l: 100 - range / 2, c: 100 + range / 2 - 0.05 }
                 : { t: i * 36e5, o: 100 + range / 2 - 0.05, h: 100 + range / 2, l: 100 - range / 2, c: 100 - range / 2 + 0.05 }
  }
  return normalise(r)
}
// 2.5x green at 100 (category 7), 4x red at 150 (8), 8x green at 200 (9). The flat ones are normal: 5.
const rows = withBig(300, [[100, 2.5, true], [150, 4, false], [200, 8, true]])

console.log(nl + '-- what a category is --')
// "lets truly make the median category the middle number category and make all categories
// selectable ... like ~9 categories". Nine, normal in the middle, edges mirrored around 1x.
t('nine categories, normal (1x) is the middle one, 5', categoryOf(1) === 5 && categoryOf(0.8) === 5 && categoryOf(1.2499) === 5 && categoryOf(1.25) === 6)
t('below normal: 4, 3, 2, 1', categoryOf(0.79) === 4 && categoryOf(0.4) === 3 && categoryOf(0.25) === 2 && categoryOf(0.1) === 1 && categoryOf(0) === 1)
t('above: 6, 7, 8, 9 -- and 9 has no ceiling', categoryOf(1.9) === 6 && categoryOf(2.5) === 7 && categoryOf(3.4) === 8 && categoryOf(5) === 9 && categoryOf(40) === 9)
t('the edges mirror each other around 1x', Math.abs(catRange(5)[0] * catRange(5)[1] - 1) < 1e-9 && Math.abs(catRange(4)[0] * catRange(6)[1] - 1) < 1e-9 && Math.abs(catRange(3)[0] * catRange(7)[1] - 1) < 1e-9 && Math.abs(catRange(2)[0] * catRange(9)[0] - 1) < 1e-9)
const base = rangeBaseline(rows, { baselineLookback: 200 })
t('normal comes from the candles BEFORE, so a big one is not part of its own normal', Math.abs(base[100] - 1) < 1e-9, base[100])
const cats = classify(rows, { baselineLookback: 200 })
t('the rule and the guide share it: 2.5x green is +7, 4x red is -8, 8x is +9, a flat one +5', cats[100] === 7 && cats[150] === -8 && cats[200] === 9 && cats[50] === 5, [cats[100], cats[150], cats[200], cats[50]])

console.log(nl + '-- the band --')
const fired = (p) => signals(rows, { ...BT_DEFAULTS, strategy: 'range', ...p }).map((s, i) => s ? `${i}:${s}` : null).filter(Boolean).join(' ')
t('7 and up takes all three, each its own way', fired({ entryCategory: 7 }) === '100:1 150:-1 200:1', fired({ entryCategory: 7 }))
t('up to 8 skips the 8x candle', fired({ entryCategory: 7, entryCategoryMax: 8 }) === '100:1 150:-1', fired({ entryCategory: 7, entryCategoryMax: 8 }))
t('exactly 8 takes only the 4x one', fired({ entryCategory: 8, entryCategoryMax: 8 }) === '150:-1')
t('fade trades against the candle: green opens a short', fired({ entryCategory: 7, rangeMode: 'fade' }) === '100:-1 150:1 200:-1', fired({ entryCategory: 7, rangeMode: 'fade' }))
t('every category is selectable: a band of just 5 trades the ordinary candles', fired({ entryCategory: 5, entryCategoryMax: 5 }).split(' ').length > 250)
t('a top below the start is raised to it, not inverted into an empty band', coerceParams({ entryCategory: 4, entryCategoryMax: 2 }).entryCategoryMax === 4)
t('the switches are kept as booleans', (() => { const c = coerceParams({ useTp: false, useSl: false, splitLevels: true }); return c.useTp === false && c.useSl === false && c.splitLevels === true })())
t('and default to the old behaviour: both levels on, one pair', BT_DEFAULTS.useTp === true && BT_DEFAULTS.useSl === true && BT_DEFAULTS.splitLevels === false && BT_DEFAULTS.entryCategoryMax === 9 && BT_DEFAULTS.entryCategory === 8 && BT_DEFAULTS.rangeMode === 'follow')
// A save from the 1-6 scale keeps what it meant: "3 and up" was three-times-and-up, now 8-9.
t('an old save is moved by meaning: 3 and up becomes 8 to 9', (() => { const m = migrateCatScale({ entryCategory: 3, entryCategoryMax: 6 }); return m.entryCategory === 8 && m.entryCategoryMax === 9 && m.catScale === 9 })())
t('2 to 4 (2x to under 5x) becomes 7 to 8', (() => { const m = migrateCatScale({ entryCategory: 2, entryCategoryMax: 4 }); return m.entryCategory === 7 && m.entryCategoryMax === 8 })())
t('a save already on nine steps is left alone', migrateCatScale({ catScale: 9, entryCategory: 3 }).entryCategory === 3)
t('and the simulator migrates what it loads', sim.includes('coerceParams(migrateCatScale(s.params))'))
t('a zero target cannot be typed: off is the way to have none', coerceParams({ takeProfitPct: 0 }).takeProfitPct > 0)

console.log(nl + '-- exits --')
// A big green candle closing at 103, then a run to 106 and a pullback.
const run = normalise([
  ...flat(30),
  { t: 30 * 36e5, o: 99, h: 103.2, l: 98.8, c: 103 },
  { t: 31 * 36e5, o: 103, h: 106, l: 102.9, c: 105.9 },
  { t: 32 * 36e5, o: 105.9, h: 106, l: 104.5, c: 104.6 },
  ...Array.from({ length: 10 }, (_, k) => ({ t: (33 + k) * 36e5, o: 104.6, h: 104.8, l: 104.4, c: 104.6 })),
])
const R = (p) => runBacktest(run, { strategy: 'range', entryCategory: 8, useCooldown: false, ...p })
const trail = R({ useTp: false, stopLossPct: 0.5, useTrailing: true, trailPct: 0.5 })
const tr0 = trail.trades[0]
t('no target: the trade has none', tr0 && tr0.tp === null, tr0)
t('a trail that climbed past entry closes a WIN, said to be the trail', tr0?.outcome === 'win' && tr0?.exitBy === 'trail', [tr0?.outcome, tr0?.exitBy, tr0?.exitPx])
t('and is counted as one', trail.won === 1 && trail.lost === 0, [trail.won, trail.lost])
t('it paid what the price moved, not a loss', tr0?.delta > 0, tr0?.delta)
const none = R({ useTp: false, useSl: false })
{
  // "how is that negative when the entry was at 59.942 and current price is ~77"
  const up = normalise(Array.from({ length: 80 }, (_, i) => {
    const big = i === 30, c = i <= 30 ? 100 : 100 + (i - 30) * 0.5
    return { t: i * 36e5, o: big ? c - 4 : c, h: c + (big ? 0.5 : 0.5), l: c - (big ? 4.5 : 0.5), c }
  }))
  const o = runBacktest(up, { strategy: 'range', entryCategory: 8, useTp: false, useSl: false, useCooldown: false, baselineLookback: 20 })
  const t0 = o.trades[0], lastC = up.at(-1).c
  t('an open long in a rising market is valued at the last close, so it shows the gain', t0?.outcome === 'open' && t0.markPx === lastC && t0.delta > 0 && t0.exitPx === null, t0)
  t('but it is neither won nor lost', o.won === 0 && o.lost === 0 && o.winRate === null && o.unresolved === 1)
  t('and the balance carries it', Math.abs(o.netPnl - t0.delta) < 1e-9)
}
t('no target and no stop: nothing closes it, and it says unresolved rather than inventing an end', none.trades[0]?.outcome === 'open' && none.trades[0]?.sl === null && none.unresolved === 1, none.trades[0])
const withTp = R({ takeProfitPct: 2 })
t('with the target on, it closes there and says so', withTp.trades[0]?.exitBy === 'tp' && withTp.trades[0]?.outcome === 'win')
const noSl = R({ useSl: false, takeProfitPct: 50 })
t('no stop: nothing below entry closes it', noSl.trades[0]?.sl === null && noSl.trades[0]?.exitBy !== 'stop')
t('a range trade records the candle that opened it', tr0?.cat === 8 && Math.abs(tr0.mult - 4.4) < 0.01, [tr0?.cat, tr0?.mult])

// Shorts with their own pair: the 4x red candle.
const sh = runBacktest(rows, { strategy: 'range', entryCategory: 8, entryCategoryMax: 8, splitLevels: true, shortTpPct: 0.3, shortSlPct: 0.3, takeProfitPct: 1, stopLossPct: 0.5 })
const s0 = sh.trades[0]
t('a short takes the short pair', s0?.side === 'short' && Math.abs((s0.entry - s0.tp) / s0.entry * 100 - 0.3) < 1e-9 && Math.abs((s0.sl - s0.entry) / s0.entry * 100 - 0.3) < 1e-9, s0)
const lg = runBacktest(rows, { strategy: 'range', entryCategory: 7, entryCategoryMax: 7, splitLevels: true, shortTpPct: 0.3, takeProfitPct: 1 }).trades[0]
t('a long keeps the long pair', lg?.side === 'long' && Math.abs((lg.tp - lg.entry) / lg.entry * 100 - 1) < 1e-9, lg)
// Risk-based, no stop: still sized as if the stop were there, so the portfolio can re-book it.
const rk = R({ pnlModel: 'risk', useFees: false, useSl: false, useTp: false, useTimeExit: true, timeExitCandles: 2 })
t('risk-based with no stop still prices the move against the stop it was sized on', rk.trades[0]?.riskDist > 0 && Number.isFinite(rk.trades[0]?.delta) && rk.trades[0].delta !== 0, rk.trades[0])
const pf = runPortfolio([{ coin: 'X', result: rk }], { pnlModel: 'risk', useFees: false })
t('and so does the shared-balance replay', Math.abs(pf.trades[0].delta - rk.trades[0].delta) < 1e-6, [pf.trades[0]?.delta, rk.trades[0]?.delta])

console.log(nl + '-- the guide --')
const st = catStats(rows, { ...BT_DEFAULTS, strategy: 'range', entryCategory: 7 })
t('it counts the run\'s own candles per category, by colour', st.counts[6].green === 1 && st.counts[7].red === 1 && st.counts[8].green === 1 && st.counts[4].green > 250, st.counts)
t('and how many the band would trade, each way', st.longs === 2 && st.shorts === 1, [st.longs, st.shorts])
t('normal is the latest baseline, in the market\'s dollars', Math.abs(st.normal - 1) < 0.1, st.normal)
t('too few candles is unknown, not zero', catStats(rows.slice(0, 5), BT_DEFAULTS) === null)
const g = catGuideHtml(st, { ...BT_DEFAULTS, entryCategory: 7, entryCategoryMax: 8 }, { label: 'HYPE', iv: '1h' })
t('nine candles, the middle one marked as normal', (g.match(/data-cat="/g) ?? []).length === 9 && /simcat-col mid" data-cat="5"/.test(g))
t('the band is lit: 7 and 8', (g.match(/simcat-col on/g) ?? []).length === 2 && !/simcat-col on[^"]*" data-cat="9"/.test(g))
t('every candle can be tapped to start the band there, the smallest too', /__simCatPick\(1\)/.test(g) && /__simCatPick\(5\)/.test(g) && /__simCatPick\(9\)/.test(g))
t('each says its range, its size in dollars and how many happened', /Category 7: 2–3× normal · from \$/.test(g) && /Category 5 \(normal\): \.8–1\.25×/.test(g) && /1 candles \(1 green, 0 red\)/.test(g))
t('the band in words, with real sizes', /Your band, <b>categories 7–8<\/b> \(2–5× normal\)/.test(g) && /▲ 2 long/.test(g))
t('and how the market splits around normal', /smaller than normal \(1–4\) · <b>[\d.]+%<\/b> normal \(5\)/.test(g))
const g0 = catGuideHtml(null, BT_DEFAULTS, { label: 'HYPE' })
t('with no candles yet it explains instead of showing zeros', /Run once/.test(g0) && !/qualified/.test(g0))

console.log(nl + '-- how many of each --')
// "display how many of each candle are. like how many of each category"
t('each candle carries its count on screen, not only in a tooltip', (g.match(/class="simcat-c"/g) ?? []).length === 9 && /class="simcat-c">1</.test(g))
const tb = g.slice(g.indexOf('simcat-tbl'))
t('and a table has every category as a row', (tb.slice(0, tb.indexOf('</tbody>')).match(/<tr class="[^"]*" onclick/g) ?? []).length === 9, (tb.match(/<tr class="[^"]*" onclick/g) ?? []).length)
t('green, red and total add up to the candles judged', st.counts.reduce((a, c) => a + c.green + c.red, 0) === st.judged && tb.includes(`<td class="n">${st.judged.toLocaleString()}</td>`))
t('it scrolls sideways on a phone rather than being cut off', /class="simcat-tbl" data-dragscroll/.test(g))
t('without a run it says the trades table is coming', !g.includes('data-tbl="trades"') && /Run it and a second table/.test(g))
t('every row is tappable, the smallest category too', /__simCatPick\(1\)/.test(tb) && /__simCatPick\(9\)/.test(tb))

// "profit factor not showing": 5 wins and no loss is unbounded -- infinity, not a dash.
t('a run with wins and no losing trade shows profit factor as infinity', sim.includes("t.profitFactor.toFixed(2) : _simPfNoLoss(t) ? '∞' : '—'") && sim.includes('(t?.grossLoss ?? 0) === 0'))

console.log(nl + '-- median baseline --')
// "would the median not be more accurate?" -- for "a typical candle", yes; offered beside the
// average rather than replacing it, since the original script used the average.
const skew = normalise(Array.from({ length: 60 }, (_, i) => {
  const r = i % 10 === 9 ? 10 : 1                 // nine quiet candles, then one ten times bigger
  return { t: i * 36e5, o: 100, h: 100 + r / 2, l: 100 - r / 2, c: 100 }
}))
const bMean = rangeBaseline(skew, { baselineLookback: 20 })
const bMed = rangeBaseline(skew, { baselineLookback: 20, baselineKind: 'median' })
t('the average is pulled up by the spikes', Math.abs(bMean[40] - 1.9) < 1e-9, bMean[40])
t('the median is the typical candle', bMed[40] === 1, bMed[40])
t('median uses only candles BEFORE: the same null start as the average', bMed.findIndex(v => v != null) === bMean.findIndex(v => v != null), [bMed.findIndex(v => v != null), bMean.findIndex(v => v != null)])
const one = normalise(Array.from({ length: 40 }, (_, i) => { const r = i === 30 ? 10 : 1; return { t: i * 36e5, o: 100, h: 100 + r / 2, l: 100 - r / 2, c: 100 } }))
const oMean = rangeBaseline(one, { baselineLookback: 20 }), oMed = rangeBaseline(one, { baselineLookback: 20, baselineKind: 'median' })
t('one spike lifts the average for the candles after it, not the median', oMean[31] > oMean[30] * 1.4 && oMed[31] === oMed[30], [oMean[30], oMean[31], oMed[30], oMed[31]])
t('an even window averages its two middle candles', rangeBaseline(normalise([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((k, i) => ({ t: i * 36e5, o: 100, h: 100 + k + 1, l: 100, c: 100 }))), { baselineLookback: 200, baselineKind: 'median' })[10] === 5.5)
t('lookback 0 is the whole sample, the same look-ahead caveat', new Set(rangeBaseline(skew, { baselineLookback: 0, baselineKind: 'median' })).size === 1)
t('the choice is offered, average first and default', BT_DEFAULTS.baselineKind === 'mean' && coerceParams({ baselineKind: 'median' }).baselineKind === 'median' && coerceParams({ baselineKind: 'mode' }).baselineKind === 'mean')
const cMean = classify(skew, { baselineLookback: 20 }), cMed = classify(skew, { baselineLookback: 20, baselineKind: 'median' })
t('against the inflated average an ordinary candle reads as small (4); against the median it is normal (5)', cMean[40] === 4 && cMed[40] === 5, [cMean[40], cMed[40]])
const gMed = catGuideHtml(catStats(skew, { ...BT_DEFAULTS, baselineLookback: 20, baselineKind: 'median' }), { ...BT_DEFAULTS, baselineKind: 'median' }, {})
t('the guide says median when it is one', /the <b>median<\/b>/.test(gMed) && />median<\/text>/.test(gMed))
t('and with the average it says why most candles are under 1x', /pull the average up/.test(g))
const ran = runBacktest(rows, { strategy: 'range', entryCategory: 7, useCooldown: false, useOnePos: false })
const ts = catTradeStats(ran.trades)
t('trades are tallied by the candle that opened them', ts[6].n === 1 && ts[7].n === 1 && ts[8].n === 1 && ts[4].n === 0, ts.map(c => c.n))
t('with their profit', Math.abs(ts.reduce((a, c) => a + c.pnl, 0) - ran.trades.reduce((a, t) => a + t.delta, 0)) < 1e-9)
t('another strategy\'s trades have no category, so there is nothing to tally', catTradeStats([{ outcome: 'win', delta: 5 }]) === null)
const g2 = catGuideHtml(st, { ...BT_DEFAULTS, entryCategory: 7 }, { label: 'HYPE', trades: ran.trades })
const tt = g2.slice(g2.indexOf('data-tbl="trades"'))
// Two narrow tables, not one wide one: in the desktop settings column nine columns scrolled the
// trade figures -- the answer -- out of view.
t('after a run a second table: trades, won, lost, win rate and PnL per category',
  g2.includes('data-tbl="trades"') && /Trades<\/th><th class="g">Won<\/th><th class="r">Lost<\/th>\s*<th>Win rate<\/th><th>PnL<\/th>/.test(tt) && !/Run it and a second table/.test(g2))
t('it lists the categories in the band or that traded', (tt.match(/<tr class="[^"]*" onclick/g) ?? []).length === 3, (tt.match(/<tr class="[^"]*" onclick/g) ?? []).length)
t('neither table is wider than six columns', [...g2.matchAll(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/g)].every(m => (m[1].match(/<th/g) ?? []).length <= 6))
t('the simulator only hands it a Range run on this market', /_simResult\?\.params\?\.strategy === 'range' && \(_simRunMeta\?\.coins \?\? \[\]\)\.includes\(coin\)/.test(sim))

console.log(nl + '-- the levels --')
const lv = levelsHtml({ ...BT_DEFAULTS })
t('the ratio and the break-even win rate', /2\.0 : 1/.test(lv) && /<b>33%<\/b>/.test(lv), lv.slice(0, 300))
const lv2 = levelsHtml({ ...BT_DEFAULTS, splitLevels: true, shortTpPct: 0.3, shortSlPct: 0.3 })
t('per side when shorts have their own: 1 : 1 needs half', /Longs/.test(lv2) && /Shorts/.test(lv2) && /1\.0 : 1/.test(lv2) && /<b>50%<\/b>/.test(lv2))
const lv3 = levelsHtml({ ...BT_DEFAULTS, useTp: false, useSl: false })
t('neither level and nothing else to close it: a warning, not silence', /only a liquidation or the end of the data/.test(lv3))
t('the trail is enough to quiet it', !/only a liquidation/.test(levelsHtml({ ...BT_DEFAULTS, useTp: false, useSl: false, useTrailing: true })))

console.log(nl + '-- on screen --')
t('the form has the new fields and the follow/fade choice', ['entryCategoryMax', 'shortTpPct', 'shortSlPct'].every(k => BT_FIELDS.some(f => f.key === k)) && BT_CHOICES.some(c => c.key === 'rangeMode'))
t('the switches are read with the form', /SIM_EXIT_SWITCHES = \['useTp', 'useSl', 'splitLevels'\]/.test(sim) && /for \(const k of SIM_EXIT_SWITCHES\)/.test(sim))
t('a switch sits in a div, so tapping the hint cannot flip it', /function _simSwitchedFieldHtml[\s\S]{0,400}<div class="sim-field/.test(sim))
t('the guide shows for Range and repaints as you type', /cur === 'range' \? `<div id="simCatGuide">/.test(sim) && /_simVisualsPaint\(\)/.test(sim))
t('its stylesheet is loaded', /import '\.\/simcat\.css'/.test(sim))
t('a trade row says how it closed and the candle that opened it', /_SIM_EXIT_BY\[t\.exitBy\]/.test(sim) && /t\.mult\.toFixed\(1\)/.test(sim))
t('a level that was off is recorded as off', /p\.useTp === false \? _T\('off'/.test(sim))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
