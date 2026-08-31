import fs from 'fs'
import { computeCompare, compareChartSvg, compareLegendHtml, compareSpread, compareColor }
  from '../../src/compare.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

const mk = (closes, t0 = 1000, step = 100) => closes.map((c, i) => ({ t: t0 + i * step, c: String(c) }))

// ── the core claim: assets at wildly different prices become comparable ──────
{
  // BTC 78000 -> 85800 (+10%), HYPE 76 -> 79.8 (+5%)
  const d = computeCompare({ BTC: mk([78000, 81000, 85800]), HYPE: mk([76, 77, 79.8]) }, ['BTC', 'HYPE'])
  t('both series survive', d.series.length === 2)
  t('BTC change is +10%', near(d.series.find(s => s.coin === 'BTC').change, 10))
  t('HYPE change is +5%', near(d.series.find(s => s.coin === 'HYPE').change, 5))
  t('best performer sorted first', d.series[0].coin === 'BTC')
  t('every series starts at 0%', d.series.every(s => near(s.pts[0].v, 0)))
  t('shared axis spans both, not just the big number', d.max <= 10.001 && d.min >= -0.001, `${d.min}..${d.max}`)
  const sp = compareSpread(d)
  t('spread is best minus worst', near(sp.spread, 5))
  t('spread names both ends', sp.best.coin === 'BTC' && sp.worst.coin === 'HYPE')
}

// ── negatives and mixed direction ────────────────────────────────────────────
{
  const d = computeCompare({ A: mk([100, 90]), B: mk([100, 120]) }, ['A', 'B'])
  t('loser is negative', near(d.series.find(s => s.coin === 'A').change, -10))
  t('winner is positive', near(d.series.find(s => s.coin === 'B').change, 20))
  t('axis covers both signs', d.min < 0 && d.max > 0)
  const svg = compareChartSvg(d)
  t('zero baseline drawn when the range crosses 0', svg.includes('stroke-dasharray="3 3"'))
}
{
  // Every series is normalised to start at 0%, so zero is ALWAYS inside the range and the
  // baseline should always draw — it is the line performance is measured against.
  const d = computeCompare({ A: mk([100, 110]), B: mk([100, 120]) }, ['A', 'B'])
  t('baseline drawn even when every series is up', compareChartSvg(d).includes('stroke-dasharray'))
  t('min is pinned at the common 0% start', Math.abs(d.min) < 1e-9, String(d.min))
}

// ── robustness ───────────────────────────────────────────────────────────────
{
  t('no coins', computeCompare({}, []).series.length === 0)
  t('undefined input', computeCompare(undefined, undefined).series.length === 0)
  t('single candle is unusable (no baseline to change from)',
    computeCompare({ A: mk([100]) }, ['A']).series.length === 0)
  t('missing coin skipped', computeCompare({ A: mk([1, 2]) }, ['A', 'GONE']).series.length === 1)
  t('zero/negative closes filtered', computeCompare({ A: [{ t: 1, c: '0' }, { t: 2, c: '0' }] }, ['A']).series.length === 0)
  const flat = computeCompare({ A: mk([100, 100, 100]) }, ['A'])
  t('a flat series does not collapse the axis', flat.max - flat.min >= 0.5)
  t('flat series renders without NaN', !/NaN/.test(compareChartSvg(flat)))
  const unsorted = computeCompare({ A: [{ t: 300, c: '110' }, { t: 100, c: '100' }] }, ['A'])
  t('candles are sorted before normalising', near(unsorted.series[0].change, 10))
  t('empty data renders nothing rather than a broken svg', compareChartSvg(computeCompare({}, [])) === '')
}

// ── svg sanity ───────────────────────────────────────────────────────────────
{
  const d = computeCompare({ A: mk([100, 105, 103]), B: mk([50, 52, 60]) }, ['A', 'B'])
  const svg = compareChartSvg(d, { width: 340, height: 200 })
  t('one path per series', (svg.match(/<path /g) || []).length === 2)
  // Two end-dots plus two hidden hover-dots now; count the end-dots specifically.
  t('end dot per series', (svg.match(/<circle (?!class="cmp-hd")/g) || []).length === 2)
  t('hover dots added alongside', (svg.match(/class="cmp-hd"/g) || []).length === 2)
  t('no NaN coordinates', !/NaN/.test(svg))
  const coords = [...svg.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].flatMap(m => [Number(m[1]), Number(m[2])])
  t('all x within viewBox', coords.filter((_, i) => i % 2 === 0).every(v => v >= 0 && v <= 340))
  t('all y within viewBox', coords.filter((_, i) => i % 2 === 1).every(v => v >= 0 && v <= 200))
  t('colour is stable per coin', compareColor('BTC') === compareColor('BTC'))
  t('different coins get different colours', compareColor('BTC') !== compareColor('HYPE'))
  const leg = compareLegendHtml(d)
  t('legend shows a percentage per series', (leg.match(/%/g) || []).length >= 2)
  t('legend escapes labels',
    !compareLegendHtml(computeCompare({ '<b>': mk([1, 2]) }, ['<b>'])).includes('<b>x'))
}

// ── wiring ───────────────────────────────────────────────────────────────────
{
  const m = fs.readFileSync('src/main.js', 'utf8')
  t('Advanced button exists in Watch', m.includes('window.__openWatchAdvanced()'))
  t('overlay uses the shared sheet layer', /_CMP_OVERLAY[\s\S]{0,600}z-index:100055/.test(m))
  t('overflow-x pinned (mobile scroll trap)', /_CMP_OVERLAY[\s\S]{0,600}overflow-x:hidden/.test(m))
  t('reuses the Watch candle cache', /_cmpFetch[\s\S]{0,900}_watchCandleCache/.test(m))
  t('only fetches what is missing or stale', /_cmpFetch[\s\S]{0,900}WATCH_CACHE_TTL/.test(m))
  t('respects the global 429 breaker', /_cmpFetch[\s\S]{0,200}_hlLimited\(\)/.test(m))
  t('reuses the Watch timeframe config', m.includes('WATCH_TF_CONFIG[_cmpTf]'))
  t('default selection is capped', m.includes('loadWatchlist().slice(0, 4)'))
  t('close handler exported', m.includes('window.__closeWatchAdvanced'))
  t('states the %-not-price caveat in the UI', m.includes('percent change from the start of the window'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
