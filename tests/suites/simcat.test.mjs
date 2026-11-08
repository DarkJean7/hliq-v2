// Trade Simulator, Range category: the category guide, the band, follow/fade, and exits that
// can each be switched off or set per side (src/simcat.js, src/backtest.js).
//
// Asked for: "currently i can set the entry category from 1-6 but is lacking the visual of
// letting the user know what is a category 1 vs 2, vs 3, etc. also allow to turn off tp/sl
// individually. make it more visual and flexible." And, from the original script it came from:
// longs took 100/50 pips, shorts 30/30 -- one pair for both sides could not say that.
import fs from 'fs'
import { runBacktest, signals, normalise, coerceParams, classify, categoryOf, rangeBaseline, runPortfolio,
         BT_DEFAULTS, BT_FIELDS, BT_CHOICES } from '../../src/backtest.js'
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
// 3.5x green at 100, 5.2x red at 150, 8x green at 200.
const rows = withBig(300, [[100, 3.5, true], [150, 5.2, false], [200, 8, true]])

console.log(nl + '-- what a category is --')
t('a category is the whole multiple of normal, capped at 6', categoryOf(3.4) === 3 && categoryOf(6.5) === 6 && categoryOf(0.9) === 0 && categoryOf(1) === 1)
const base = rangeBaseline(rows, { baselineLookback: 200 })
t('normal comes from the candles BEFORE, so a big one is not part of its own normal', Math.abs(base[100] - 1) < 1e-9, base[100])
const cats = classify(rows, { baselineLookback: 200 })
t('the rule and the guide share it: 3.5x green is +3, 5.2x red is -5, 8x is +6', cats[100] === 3 && cats[150] === -5 && cats[200] === 6, [cats[100], cats[150], cats[200]])

console.log(nl + '-- the band --')
const fired = (p) => signals(rows, { ...BT_DEFAULTS, strategy: 'range', ...p }).map((s, i) => s ? `${i}:${s}` : null).filter(Boolean).join(' ')
t('3 and up takes all three, each its own way', fired({ entryCategory: 3 }) === '100:1 150:-1 200:1', fired({ entryCategory: 3 }))
t('up to 5 skips the 8x candle', fired({ entryCategory: 3, entryCategoryMax: 5 }) === '100:1 150:-1', fired({ entryCategory: 3, entryCategoryMax: 5 }))
t('exactly 5 takes only the 5x one', fired({ entryCategory: 5, entryCategoryMax: 5 }) === '150:-1')
t('fade trades against the candle: green opens a short', fired({ entryCategory: 3, rangeMode: 'fade' }) === '100:-1 150:1 200:-1', fired({ entryCategory: 3, rangeMode: 'fade' }))
t('a top below the start is raised to it, not inverted into an empty band', coerceParams({ entryCategory: 4, entryCategoryMax: 2 }).entryCategoryMax === 4)
t('the switches are kept as booleans', (() => { const c = coerceParams({ useTp: false, useSl: false, splitLevels: true }); return c.useTp === false && c.useSl === false && c.splitLevels === true })())
t('and default to the old behaviour: both levels on, one pair', BT_DEFAULTS.useTp === true && BT_DEFAULTS.useSl === true && BT_DEFAULTS.splitLevels === false && BT_DEFAULTS.entryCategoryMax === 6 && BT_DEFAULTS.rangeMode === 'follow')
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
const R = (p) => runBacktest(run, { strategy: 'range', entryCategory: 3, useCooldown: false, ...p })
const trail = R({ useTp: false, stopLossPct: 0.5, useTrailing: true, trailPct: 0.5 })
const tr0 = trail.trades[0]
t('no target: the trade has none', tr0 && tr0.tp === null, tr0)
t('a trail that climbed past entry closes a WIN, said to be the trail', tr0?.outcome === 'win' && tr0?.exitBy === 'trail', [tr0?.outcome, tr0?.exitBy, tr0?.exitPx])
t('and is counted as one', trail.won === 1 && trail.lost === 0, [trail.won, trail.lost])
t('it paid what the price moved, not a loss', tr0?.delta > 0, tr0?.delta)
const none = R({ useTp: false, useSl: false })
t('no target and no stop: nothing closes it, and it says unresolved rather than inventing an end', none.trades[0]?.outcome === 'open' && none.trades[0]?.sl === null && none.unresolved === 1, none.trades[0])
const withTp = R({ takeProfitPct: 2 })
t('with the target on, it closes there and says so', withTp.trades[0]?.exitBy === 'tp' && withTp.trades[0]?.outcome === 'win')
const noSl = R({ useSl: false, takeProfitPct: 50 })
t('no stop: nothing below entry closes it', noSl.trades[0]?.sl === null && noSl.trades[0]?.exitBy !== 'stop')
t('a range trade records the candle that opened it', tr0?.cat === 4 && Math.abs(tr0.mult - 4.4) < 0.01, [tr0?.cat, tr0?.mult])

// Shorts with their own pair: a 5.2x red candle closing near 97.45.
const sh = runBacktest(rows, { strategy: 'range', entryCategory: 5, entryCategoryMax: 5, splitLevels: true, shortTpPct: 0.3, shortSlPct: 0.3, takeProfitPct: 1, stopLossPct: 0.5 })
const s0 = sh.trades[0]
t('a short takes the short pair', s0?.side === 'short' && Math.abs((s0.entry - s0.tp) / s0.entry * 100 - 0.3) < 1e-9 && Math.abs((s0.sl - s0.entry) / s0.entry * 100 - 0.3) < 1e-9, s0)
const lg = runBacktest(rows, { strategy: 'range', entryCategory: 3, entryCategoryMax: 3, splitLevels: true, shortTpPct: 0.3, takeProfitPct: 1 }).trades[0]
t('a long keeps the long pair', lg?.side === 'long' && Math.abs((lg.tp - lg.entry) / lg.entry * 100 - 1) < 1e-9, lg)
// Risk-based, no stop: still sized as if the stop were there, so the portfolio can re-book it.
const rk = R({ pnlModel: 'risk', useFees: false, useSl: false, useTp: false, useTimeExit: true, timeExitCandles: 2 })
t('risk-based with no stop still prices the move against the stop it was sized on', rk.trades[0]?.riskDist > 0 && Number.isFinite(rk.trades[0]?.delta) && rk.trades[0].delta !== 0, rk.trades[0])
const pf = runPortfolio([{ coin: 'X', result: rk }], { pnlModel: 'risk', useFees: false })
t('and so does the shared-balance replay', Math.abs(pf.trades[0].delta - rk.trades[0].delta) < 1e-6, [pf.trades[0]?.delta, rk.trades[0]?.delta])

console.log(nl + '-- the guide --')
const st = catStats(rows, { ...BT_DEFAULTS, strategy: 'range', entryCategory: 3 })
t('it counts the run\'s own candles per category, by colour', st.counts[3].green === 1 && st.counts[5].red === 1 && st.counts[6].green === 1, st.counts)
t('and how many the band would trade, each way', st.longs === 2 && st.shorts === 1, [st.longs, st.shorts])
t('normal is the latest baseline, in the market\'s dollars', Math.abs(st.normal - 1) < 0.1, st.normal)
t('too few candles is unknown, not zero', catStats(rows.slice(0, 5), BT_DEFAULTS) === null)
const g = catGuideHtml(st, { ...BT_DEFAULTS, entryCategory: 3, entryCategoryMax: 5 }, { label: 'HYPE', iv: '1h' })
t('seven candles, one per category', (g.match(/data-cat="/g) ?? []).length === 7)
t('the band is lit: 3, 4 and 5', (g.match(/simcat-col on/g) ?? []).length === 3 && /data-cat="6"/.test(g) && !/simcat-col on[^"]*" data-cat="6"/.test(g))
t('a candle can be tapped to start the band there, except "under 1x"', /__simCatPick\(3\)/.test(g) && !/__simCatPick\(0\)/.test(g))
t('each says its size in dollars and how many happened', /Category 3: 3–4× normal · at least \$/.test(g) && /1 candles \(1 green, 0 red\)/.test(g))
t('the band in words, with real sizes', /Your band, <b>3× to 5×<\/b>/.test(g) && /▲ 2 long/.test(g))
const g0 = catGuideHtml(null, BT_DEFAULTS, { label: 'HYPE' })
t('with no candles yet it explains instead of showing zeros', /Run once/.test(g0) && !/qualified/.test(g0))

console.log(nl + '-- how many of each --')
// "display how many of each candle are. like how many of each category"
t('each candle carries its count on screen, not only in a tooltip', (g.match(/class="simcat-c"/g) ?? []).length === 7 && /class="simcat-c">1</.test(g))
const tb = g.slice(g.indexOf('simcat-tbl'))
t('and a table has every category as a row', (tb.match(/<tr class="(on)?"/g) ?? []).length === 7, (tb.match(/<tr class="(on)?"/g) ?? []).length)
t('green, red and total add up to the candles judged', st.counts.reduce((a, c) => a + c.green + c.red, 0) === st.judged && tb.includes(`<td class="n">${st.judged.toLocaleString()}</td>`))
t('it scrolls sideways on a phone rather than being cut off', /class="simcat-tbl" data-dragscroll/.test(g))
t('without a run it says the trades table is coming', !g.includes('data-tbl="trades"') && /Run it and a second table/.test(g))
const ran = runBacktest(rows, { strategy: 'range', entryCategory: 3, useCooldown: false, useOnePos: false })
const ts = catTradeStats(ran.trades)
t('trades are tallied by the candle that opened them', ts[3].n === 1 && ts[5].n === 1 && ts[6].n === 1 && ts[0].n === 0, ts.map(c => c.n))
t('with their profit', Math.abs(ts.reduce((a, c) => a + c.pnl, 0) - ran.trades.reduce((a, t) => a + t.delta, 0)) < 1e-9)
t('another strategy\'s trades have no category, so there is nothing to tally', catTradeStats([{ outcome: 'win', delta: 5 }]) === null)
const g2 = catGuideHtml(st, { ...BT_DEFAULTS, entryCategory: 3 }, { label: 'HYPE', trades: ran.trades })
const tt = g2.slice(g2.indexOf('data-tbl="trades"'))
// Two narrow tables, not one wide one: in the desktop settings column nine columns scrolled the
// trade figures -- the answer -- out of view.
t('after a run a second table: trades, won, lost, win rate and PnL per category',
  g2.includes('data-tbl="trades"') && /Trades<\/th><th class="g">Won<\/th><th class="r">Lost<\/th>\s*<th>Win rate<\/th><th>PnL<\/th>/.test(tt) && !/Run it and a second table/.test(g2))
t('it lists the categories in the band or that traded', (tt.match(/<tr class="(on)?"/g) ?? []).length === 4, (tt.match(/<tr class="(on)?"/g) ?? []).length)
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
