// Analysis → Support & resistance: the engine (src/zones.js) and the view's guarantees (src/analysis.js).
import fs from 'fs'
import { toCandles, atr, pivots, cluster, volumeProfile, buildZones, parseBooks, bookMid, wallFor, bookReach, bookRatio } from '../../src/zones.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const read = f => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const DAY = 864e5
// A bar from a mid price and a half-range.
const bar = (i, mid, half = 1, v = 100, step = DAY) => ({ t: i * step, o: mid, h: mid + half, l: mid - half, c: mid, v })

console.log('\n-- candles --')
{
  const c = toCandles([{ t: '2', o: '1', h: '2', l: '0.5', c: '1.5', v: '3' }, { t: '1', o: '1', h: '0', l: '1', c: '1', v: '1' }, { t: '0', o: 'x', h: '1', l: '1', c: '1' }])
  t('strings become numbers, a high below its low is dropped, a zero time is dropped', c.length === 1 && c[0].h === 2, c)
  t('not an array is empty, not a throw', toCandles(null).length === 0)
  t('ATR needs two bars to compare', atr([bar(0, 10)]) === null && Math.abs(atr([bar(0, 10), bar(1, 10)]) - 2) < 1e-9)
}

console.log('\n-- swing points --')
{
  // A peak at 20 (bar 5) and a trough at 5 (bar 12) in an otherwise flat 10 market.
  const mids = Array.from({ length: 20 }, (_, i) => i === 5 ? 20 : i === 12 ? 5 : 10)
  const c = mids.map((m, i) => bar(i, m))
  const ps = pivots(c, 2, '1d', 2)
  const hi = ps.find(p => p.side === 'high'), lo = ps.find(p => p.side === 'low')
  t('the peak is a high pivot', hi && hi.px === 21 && hi.t === 5 * DAY, ps)
  t('the trough is a low pivot', lo && lo.px === 4 && lo.t === 12 * DAY, ps)
  t('a flat stretch makes no pivots of its own', ps.length === 2, ps.length)
  t('reaction is measured in ATRs: from 21 down to 9 is 6 ATR at ATR 2', Math.abs(hi.react - 6) < 1e-9, hi.react)
  // The last k bars cannot be confirmed: a spike on the final bar is not a pivot yet.
  const tail = [...c.slice(0, 18), bar(18, 10), bar(19, 30)]
  t('an unconfirmed spike at the end is not a pivot', !pivots(tail, 2, '1d', 2).some(p => p.t === 19 * DAY))
  // Double top: two equal highs side by side are one pivot, not two.
  const dbl = [10, 10, 10, 20, 20, 10, 10, 10].map((m, i) => bar(i, m))
  t('a flat double top is one pivot', pivots(dbl, 2, '1d', 2).filter(p => p.side === 'high').length === 1)
}

console.log('\n-- clustering and scoring --')
{
  const cl = cluster([{ px: 100 }, { px: 100.5 }, { px: 103 }, { px: 99.8 }], 1)
  t('prices within tolerance share a zone; the rest start their own', cl.length === 2 && cl[0].items.length === 3, cl.map(x => x.items.length))

  // Three timeframes that all turned at ~120, and a 4h-only level at ~80; price 100.
  const flat = (n, step, extra) => Array.from({ length: n }, (_, i) => bar(i, extra[i] ?? 100, 1, 100, step))
  const peaks = (n, at, lvl) => Object.fromEntries(at.map(i => [i, lvl]))
  const c4 = flat(120, DAY / 6, { ...peaks(120, [20, 60], 119), ...peaks(120, [40, 90], 81) })
  const c1 = flat(60, DAY, peaks(60, [15, 40], 119))
  const cw = flat(20, 7 * DAY, peaks(20, [8], 119))
  const r = buildZones({ candles: { '4h': c4, '1d': c1, '1w': cw }, price: 100, now: 60 * DAY })
  const top = r.zones.find(z => z.px > 110), low = r.zones.find(z => z.px < 90)
  t('the level every timeframe turned at is one zone, 3 of 3', top && top.confluence === 3 && top.tfs.join() === '4h,1d,1w', top)
  t('it is resistance: price is below it', top.kind === 'resistance' && top.dist > 0)
  t('the 4h-only level is 1 of 3, and support', low && low.confluence === 1 && low.kind === 'support', low)
  t('agreement across timeframes outscores one timeframe', top.score > low.score, [top.score, low.score])
  t('scores are 0–100', r.zones.every(z => z.score >= 0 && z.score <= 100))
  t('touches are a share of 4h candles', top.touches >= 0 && top.touches <= 1)
  t('each timeframe reports what it was given', r.counts['4h'].candles === 120 && r.counts['1w'].candles === 20)
  // The low built from troughs is plain support; a support built from old PEAKS is a flip.
  const flipped = buildZones({ candles: { '4h': c4, '1d': c1, '1w': cw }, price: 130, now: 60 * DAY }).zones.find(z => z.px > 110)
  t('a zone made of old highs that price is now above is support, marked flip', flipped.kind === 'support' && flipped.flip)
  t('one inside the band is "at" price, neither', buildZones({ candles: { '4h': c4, '1d': c1, '1w': cw }, price: top.px, now: 60 * DAY }).zones.find(z => z.px > 110).kind === 'at')
  t('no price, no zones', buildZones({ candles: { '4h': c4 }, price: 0 }) === null)
  t('a missing timeframe contributes nothing rather than breaking', buildZones({ candles: { '4h': c4 }, price: 100 }).counts['1w'].candles === 0)
}

console.log('\n-- volume profile --')
{
  // Most volume at 50, a little at 60.
  const c = [...Array(10)].map((_, i) => bar(i, 50, 0.5, 1000)).concat([bar(10, 60, 0.5, 10)])
  const vp = volumeProfile(c, 20)
  t('POC is where the volume traded', Math.abs(vp.poc - 50) < 1, vp.poc)
  t('the value area holds it', vp.val <= 50 && vp.vah >= 50 && vp.vah < 60)
  t('volume inside a band is measured, and the whole range is the total', Math.abs(vp.within(vp.lo, vp.hi) - vp.total) / vp.total < 1e-9)
  t('nothing to profile is null, not zero', volumeProfile([]) === null)
}

console.log('\n-- the order book --')
{
  const lv = (px, sz, n) => ({ px: String(px), sz: String(sz), n })
  const fine = { levels: [[lv(99.9, 10, 2), lv(99.8, 10, 3)], [lv(100.1, 10, 1), lv(100.2, 5, 1)]] }
  const coarse = { levels: [[lv(99, 100, 20), lv(98, 50, 10), lv(90, 500, 40)], [lv(101, 100, 20), lv(102, 20, 5), lv(110, 300, 30)]] }
  const books = parseBooks([fine, null, coarse])
  t('an unreadable aggregation is skipped, the rest kept in order', books.length === 2 && books[0].step < books[1].step)
  t('mid is the finest book\'s', Math.abs(bookMid(books) - 100) < 1e-9)
  const z = { lo: 90, hi: 91.5 }
  const w = wallFor(z, books)
  t('a zone only the coarse book reaches is read from it', w && w.usd === 90 * 500 && w.orders === 40 && w.perOrder === 90 * 500 / 40, w)
  t('a zone beyond every book is null — not "no orders"', wallFor({ lo: 50, hi: 52 }, books) === null)
  t('a band narrower than a bucket is not read from that book', wallFor({ lo: 98.95, hi: 99.05 }, [books[1]]) === null)
  t('reach is the widest book\'s shorter side', Math.abs(bookReach(books) - 0.10) < 1e-9, bookReach(books))
  const r = bookRatio(books, 0.002)
  t('bid/ask within ±pct uses the finest book that reaches', r && Math.abs(r.ratio - (99.9 * 10 + 99.8 * 10) / (100.1 * 10 + 100.2 * 5)) < 1e-9, r)
  t('no book, no ratio', bookRatio([]) === null)
}

console.log('\n-- the view --')
{
  const a = read('src/analysis.js'), css = read('src/analysis.css'), th = read('src/theme.js'), m = read('src/main.js')
  t('it reads through the METERED client, not trading.js\'s unpaced one', a.includes("import { infoClient } from './api.js'") && !a.includes("from './trading.js'"))
  t('candles are fetched one at a time, not in a burst', a.includes('for (const tf of TFS) {') && a.includes('await infoClient.candleSnapshot'))
  t('nothing is fetched while it is off screen', a.includes("S.root.offsetParent !== null && !document.hidden"))
  t('a failed timeframe is unknown, never "no market"', a.includes("if (!failed && TFS.every(tf => !out[tf].length)) { e.err = 'none'; return }"))
  t('"beyond the book" is said, not a zero', a.includes("beyond the book"))
  t('surfaces are solid: the view paints its own ground', css.includes('.ana-view { background: var(--bg)'))
  t('and pins the panels back to opaque while a photo has cleared them', css.includes('html.panels-clear .ana-view { --panel: var(--panel-o)'))
  t('theme.js publishes the opaque copies and the class', th.includes("set('--panel-o',   clear ? v.panel : null)") && th.includes("el.classList?.toggle('panels-clear', clear)"))
  t('--panel-1, which nothing defined, is defined inside the view', css.includes('--panel-1: var(--panel)'))
  t('main.js mounts it above the charts', m.includes("renderAnalysis(host.querySelector('#anaZ')") && m.includes('<div id="pulseSegBody" class="ana-view">'))
  t('and the charts get a section heading, not a second page title', m.includes("const _sub = el.id === 'anaCharts'"))
  // On a phone the shell wiped the pane with "Loading…" on every tick until Pulse's own data
  // landed — which Analysis never fetches — so a selected zone and the zoom vanished.
  t('the phone shell only shows the Pulse placeholder for Pulse', m.includes("if (!_pulseData && _pulseSeg === 'pulse') el.innerHTML"))
  t('and a rebuilt view keeps the selected zone and zoom', a.includes('if (prev && prev.coin === S.coin) { S.sel = prev.sel; S.view = prev.view; S.tf = prev.tf }'))
  t('a row takes you to the chart; a chart label to its row', a.includes("S.root.querySelector('.ana-chart')?.scrollIntoView") && a.includes('row?.scrollIntoView'))
  t('the selected zone is always inside the fitted price range', a.includes('if (sel) { lo = Math.min(lo, sel.lo); hi = Math.max(hi, sel.hi) }'))
  t('the wheel zooms the chart, not the page', a.includes('{ passive: false }') && a.includes('ev.preventDefault()'))
  t('a vertical swipe on a phone still scrolls the page', fs.readFileSync('src/analysis.css', 'utf8').includes('touch-action: pan-y'))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
