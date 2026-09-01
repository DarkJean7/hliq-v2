// The Signals chart, and the picker in front of it.
import fs from 'fs'
import { signalChartSvg, indicatorLayers, rebase, smaSeries, emaSeries, rsiSeries } from '../../src/sigchart.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const t0 = Date.now() - 250 * 3600e3
const main = Array.from({ length: 250 }, (_, i) => [t0 + i * 3600e3, 78000 + Math.sin(i / 9) * 1800 + i * 7])
const cmp  = Array.from({ length: 250 }, (_, i) => [t0 + i * 3600e3, 81 + Math.cos(i / 7) * 4 + i * 0.02])
const vals = main.map(p => p[1])
const money = (v) => '$' + v.toFixed(0)
const bad = (s) => /NaN|undefined|Infinity/.test(s)

console.log(String.fromCharCode(10) + '-- the maths --')
t('SMA is null until it has its window', smaSeries([1, 2, 3, 4], 3).slice(0, 2).every(v => v === null))
t('and correct once it does', smaSeries([1, 2, 3, 4], 3)[2] === 2)
t('EMA is null until its window too', emaSeries([1, 2, 3, 4], 3)[1] === null)
t('RSI is bounded 0-100', rsiSeries(vals, 14).filter(v => v != null).every(v => v >= 0 && v <= 100))
t('RSI is null before it can be computed', rsiSeries(vals, 14).slice(0, 14).every(v => v === null))
t('a flat series gives RSI 100, not NaN', rsiSeries(new Array(40).fill(5), 14).filter(v => v != null).every(Number.isFinite))
t('rebase starts at zero', rebase(main)[0][1] === 0)
t('rebase refuses a zero base rather than dividing by it', rebase([[1, 0], [2, 5]]).length === 0)

console.log(String.fromCharCode(10) + '-- two markets are compared in percent, never in price --')
// BTC at 78,000 and HYPE at 81 on one axis makes HYPE a flat line along the bottom, which
// looks like a fact about the market and is really a fact about the axis.
const both = signalChartSvg({ main, cmp, mainLabel: 'BTC', cmpLabel: 'HYPE', fmtPrice: money })
t('the axis switches to percent', both.hi.includes('%') && both.lo.includes('%'))
t('both markets are in the legend', both.legend.includes('BTC') && both.legend.includes('HYPE'))
t('a single market keeps price', signalChartSvg({ main, mainLabel: 'BTC', fmtPrice: money }).hi.startsWith('$'))

console.log(String.fromCharCode(10) + '-- every indicator draws something --')
for (const [k, kind] of [['ema', 'overlays'], ['sma', 'overlays'], ['boll', 'overlays'],
                         ['ma200w', 'overlays'], ['rsi', 'sub'], ['vol', 'sub']]) {
  const layers = indicatorLayers(k, vals)
  t(`${k} produces ${kind}`, kind === 'sub' ? !!layers.sub : (layers.overlays ?? []).length > 0)
  const r = signalChartSvg({ main, cmp, indicator: k, vals, mainLabel: 'BTC', cmpLabel: 'HYPE', fmtPrice: money })
  t(`${k} renders without a bad number`, !bad(r.svg) && !r.empty)
}
// An oscillator sharing the price axis would flatten to a line; it gets its own panel.
t('RSI gets its own panel', (signalChartSvg({ main, indicator: 'rsi', vals, fmtPrice: money }).svg.match(/<svg/g) || []).length === 2)
t('a moving average does not', (signalChartSvg({ main, indicator: 'sma', vals, fmtPrice: money }).svg.match(/<svg/g) || []).length === 1)
t('overlays are named in the legend', signalChartSvg({ main, indicator: 'ema', vals, mainLabel: 'BTC', fmtPrice: money }).legend.includes('EMA 21'))

console.log(String.fromCharCode(10) + '-- it refuses rather than drawing nonsense --')
t('too few points is empty, not a flat line', signalChartSvg({ main: [[1, 2]] }).empty)
t('a flat series still renders', !bad(signalChartSvg({ main: main.map(([tt]) => [tt, 5]), fmtPrice: money }).svg))
t('non-numeric points are dropped', !bad(signalChartSvg({
  main: [...main, [NaN, 5], [1, null]], fmtPrice: money }).svg))

console.log(String.fromCharCode(10) + '-- wired into Signals --')
t('the chart is drawn from the same series as the reading', cli.includes('vals: series ?? [],'))
// An SMA(200) of hourly candles is not a 200-week average of anything.
t('the weekly indicator gets weekly points', cli.includes('const mainPts = ind.weekly ? _sigWeeklyPoints(_sigCoin)'))
t('and so does the compared market', cli.includes('ind.weekly ? _sigWeeklyPoints(_sigCmp)'))
t('the card holds its height so choosing an indicator does not jump the page', /min-height:2\d\dpx/.test(cli))

console.log(String.fromCharCode(10) + '-- the picker is a shortlist plus search --')
t('five, not twenty-four', cli.includes('allCoins.slice(0, 5)'))
t('the selection stays visible even outside the top five', cli.includes("[...allCoins.slice(0, 5), _sigCoin, _sigCmp].filter(Boolean)"))
t('search matches the name shown, not just the raw id', cli.includes("String(_ocCoinLabel(c) ?? c).toUpperCase().includes(q)"))
// Two markets can render under one name; two identical chips are a choice nobody can make.
t('markets sharing a display name are de-duplicated', cli.includes('if (seen.has(lbl)) return false'))
t('one definition of the chips, shared by render and search', cli.includes('function _sigChipRows()') &&
  cli.includes('${_sigChipRows().market}') && cli.includes('${_sigChipRows().compare}'))

console.log(String.fromCharCode(10) + '-- and it stays where you left it --')
t('changing an indicator restores scroll', cli.includes('function _sigRerender()') && cli.includes('scroller.scrollTop = vy'))
t('and the horizontal chip strips', cli.includes('strips.forEach((e, i) => { if (lefts[i] != null) e.scrollLeft = lefts[i] })'))
t('searching repaints only the chips, never the whole view', cli.includes('if (mk) mk.innerHTML = rows.market'))
// Candle fetches land mid-word and redraw the view; without this the keyboard vanishes.
t('a background redraw gives the keyboard back', cli.includes("const _hadSearch = _act && _act.id === 'sigSearch'"))
t('with the caret where it was', cli.includes('back.setSelectionRange(_caret, _caret)'))
t('the Pulse handlers were left alone', (cli.match(/_pulseRender\(_viewHost\('deskPulse'\)\)/g) || []).length >= 6)

console.log(String.fromCharCode(10) + '-- the window --')
const full = signalChartSvg({ main, indicator: 'sma', vals, fmtPrice: money })
const zoom = signalChartSvg({ main, indicator: 'sma', vals, fmtPrice: money, from: 150, to: 250 })
t('a window cuts the series', zoom.meta.from === 150 && zoom.meta.to === 250, zoom.meta)
t('the full chart reports the whole range', full.meta.from === 0 && full.meta.to === main.length)
t('a silly window is clamped, not obeyed', (() => {
  const m = signalChartSvg({ main, fmtPrice: money, from: -99, to: 1e6 }).meta
  return m.from === 0 && m.to === main.length
})())
t('a window too small to draw is widened', (() => {
  const m = signalChartSvg({ main, fmtPrice: money, from: main.length - 1, to: main.length }).meta
  return m.to - m.from >= 3
})())

// The reason indicators are computed before the cut: an average that restarted at the left
// edge of the window would say something different depending on how far you had zoomed.
t('indicators are computed over all history, then cut',
  fs.readFileSync('src/sigchart.js', 'utf8').includes('const fullVals = vals.length ? vals : full.map(p => +p[1])') &&
  fs.readFileSync('src/sigchart.js', 'utf8').includes('o.vals[lo + i]'))
t('an SMA still draws deep into a zoom, where a windowed one could not exist',
  (signalChartSvg({ main, indicator: 'sma', vals, fmtPrice: money, from: 380, to: 400 }).svg.match(/<path/g) || []).length >= 2)
t('the sub panel is cut to the same window', fs.readFileSync('src/sigchart.js', 'utf8').includes('sub.vals[lo + i]'))
// Two series need not share a candle count; aligning by position would slide one against
// the other the moment either had a gap.
t('the compared market is cut by time, not by index',
  fs.readFileSync('src/sigchart.js', 'utf8').includes('cmp.filter(p => +p[0] >= meta.t0 && +p[0] <= meta.t1)'))
t('and rebases to the visible left edge', signalChartSvg({
  main, cmp, fmtPrice: money, from: 200, to: 260 }).lo.includes('%'))

console.log(String.fromCharCode(10) + '-- reading and moving it --')
t('a drag reads values off the chart', cli.includes('window.__sigScrub = function(ev)'))
t('and puts the crosshair where the finger is', cli.includes("cross.style.left = (frac * 100).toFixed(2)"))
t('the readout names both markets when comparing', cli.includes('_sigLast.comparing ? _sigAt(_sigLast.cmp, t) : null'))
t('releasing restores the hint', cli.includes('window.__sigScrubEnd = function()'))
t('pinch zooms', cli.includes('window.__sigTouchStart') && cli.includes('window.__sigTouchMove'))
t('two fingers sliding pans', cli.includes('window.__sigPan(-slide)'))
// A gesture is one thing or the other; doing both at once feels broken.
t('a gesture is a zoom or a pan, never both', cli.includes("if (Math.abs(ratio - 1) > 0.06)") && cli.includes('} else if (Math.abs(slide) > 0.02) {'))
t('a wheel zooms, for a mouse', cli.includes('window.__sigWheel = function(ev)'))
t('zoom keeps at least a few candles on screen', cli.includes('Math.max(8, Math.min(m.n, Math.round(span / factor)))'))
t('and never scrolls past either end', cli.includes('from = Math.max(0, Math.min(m.n - next, from))'))
t('there is a way back out', cli.includes('window.__sigZoomReset') && cli.includes("_T('Reset', 'Restablecer')"))

console.log(String.fromCharCode(10) + '-- it does not fight the page --')
// A chart that swallows vertical scrolling is the thing that makes an embed hostile on a
// phone; only a two-finger gesture belongs to the chart.
t('vertical scrolling still belongs to the page', cli.includes("touch-action:pan-y"))
t('zooming repaints only the chart, not the view', cli.includes('function _sigChartRepaint()') &&
  cli.includes('if (card) card.innerHTML = _sigChartInner()'))
t('a new market or timeframe opens zoomed out', cli.includes('_sigCoin = c || null; _sigViewReset()') &&
  cli.includes('_sigTf = l; _sigViewReset()'))
t('but adding a comparison keeps the window you are reading', cli.includes('// Deliberately keeps the zoom'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
