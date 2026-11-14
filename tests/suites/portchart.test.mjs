// The Portfolio chart's time logic (src/portchart.js): 4H/8H timeframes, the stitched history
// Advanced zooms through, and the time axis. Driven in a page by tests/portchart-browser.mjs.
import fs from 'fs'
import { PERIOD_SPAN, PERIOD_WINDOW, valueAt, sliceSince, stitchHistories, timeTicks, fmtPointTime, fmtRange } from '../../src/portchart.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const MIN = 60e3, H = 60 * MIN, D = 24 * H

console.log('-- timeframes --')
t('4H and 8H exist and read the day history (HL has nothing finer)', PERIOD_SPAN['4H'] === 4 * H && PERIOD_SPAN['8H'] === 8 * H && PERIOD_WINDOW['4H'] === 'day' && PERIOD_WINDOW['8H'] === 'day')
const day = Array.from({ length: 289 }, (_, i) => [1e12 + i * 5 * MIN, String(100 + i)])
const since = 1e12 + 20 * H + 2 * MIN
const cut = sliceSince(day, since)
t('a slice starts exactly at its edge, interpolated', cut[0][0] === since && Math.abs(parseFloat(cut[0][1]) - (100 + 240.4)) < 1e-9, cut[0])
t('and keeps everything after it', cut.length === 1 + day.filter(p => p[0] >= since).length)
t('valueAt is null outside the series', valueAt(day, 0) === null && valueAt([], 5) === null)

console.log('-- stitching the four histories --')
{
  const pf = [
    ['allTime', { accountValueHistory: [[0, '5'], [100, '15'], [200, '25']], pnlHistory: [[0, '0'], [100, '10'], [200, '20']] }],
    ['month',   { accountValueHistory: [[120, '17'], [200, '26']], pnlHistory: [[120, '0'], [200, '9']] }],
    ['day',     { accountValueHistory: [[180, '24'], [190, '25'], [200, '26']], pnlHistory: [[180, '0'], [190, '1'], [200, '2']] }],
  ]
  const v = stitchHistories(pf, 'accountValueHistory')
  t('value: coarse points where nothing finer exists, the finest after', JSON.stringify(v.map(p => p[0])) === '[0,100,120,180,190,200]', v)
  t('value is absolute, so nothing is shifted', v.find(p => p[0] === 180)[1] === '24')
  const p = stitchHistories(pf, 'pnlHistory')
  const at = (tt) => parseFloat(p.find(x => x[0] === tt)[1])
  // month starts at t=120, where all-time PnL stood at 12; day starts at 180, where the
  // stitched series (month, shifted) stood at 12 + 9*(60/80) = 18.75.
  t('PnL windows each count from their own start, so each is shifted onto the last: no cliff', at(120) === 12 && Math.abs(at(180) - 18.75) < 1e-9 && Math.abs(at(200) - 20.75) < 1e-9, p)
  t('a missing window is skipped, not fatal', stitchHistories([['allTime', { accountValueHistory: [[0, '1'], [1, '2']] }]], 'accountValueHistory').length === 2)
}

console.log('-- the time axis --')
{
  const now = new Date(2026, 10, 13, 15, 37).getTime()
  const lbl = (s, w) => timeTicks(now - s, now, w).map(x => x.label)
  t('4H: hours and minutes', lbl(4 * H, 360).every(l => /^\d\d:\d\d$/.test(l)), lbl(4 * H, 360))
  const d1 = timeTicks(now - D, now, 360)
  t('1D: the new day is named by its date, without a hover', d1.some(x => x.day && x.label === 'Nov 13') && d1.some(x => !x.day && /:/.test(x.label)), d1)
  t('7D: dates', lbl(7 * D, 360).every(l => /^[A-Z][a-z]{2} \d+$/.test(l)), lbl(7 * D, 360))
  t('a year: months, and the year where it turns', lbl(400 * D, 360).includes('2026'), lbl(400 * D, 360))
  for (const [s, w] of [[H, 300], [4 * H, 360], [D, 360], [7 * D, 360], [30 * D, 360], [400 * D, 360], [D, 1400]]) {
    const ticks = timeTicks(now - s, now, w)
    t(`${s / H}h across ${w}px: labels fit (≥ the minimum gap apart) and stay in range`, ticks.length >= 1 && ticks.length <= Math.floor(w / 64) + 1 && ticks.every(k => k.t >= now - s && k.t <= now), ticks.length)
  }
  t('a point reads to the minute', fmtPointTime(now, now) === 'Nov 13, 15:37')
  t('another year carries the year', /2025/.test(fmtPointTime(new Date(2025, 0, 2).getTime(), now)))
  t('the range readout', fmtRange(now - 4 * H, now) === 'Nov 13, 11:37 – 15:37' && fmtRange(now - 10 * D, now) === 'Nov 3 – Nov 13')
}

console.log('-- wiring --')
{
  const m = fs.readFileSync('src/main.js', 'utf8')
  t('Advanced reads the stitched history, not all-time alone', m.includes("_portSeries('stitched', _mobVPortChartType)"))
  t('the inline chart offers 4H and 8H', m.includes("[['4H','4H'],['8H','8H'],['1D','1D']"))
  t('Advanced offers 1H, 4H and 8H', m.includes("[['1H', '1H'], ['4H', '4H'], ['8H', '8H']"))
  t('the inline chart places points by time, not index', m.includes('xOfT(+hist[i][0])'))
  t('both fills continue the path rather than closing on a chord', (m.match(/smoothPath\(pts, true\)/g) ?? []).length === 2)
  const css = fs.readFileSync('src/style.css', 'utf8')
  const adv = css.slice(css.indexOf('.adv-overlay {'), css.indexOf('.adv-overlay {') + 400)
  t('the Advanced overlay scrolls', /overflow-y:\s*auto/.test(adv))
  t('and a vertical swipe on its chart is the page\'s', /\.adv-canvas-wrap canvas \{[^}]*touch-action: pan-y/.test(css))
  // "scrolling in advanced mode is not smooth": blocking touch listeners made every scroll that
  // started on the chart wait for the page's JavaScript.
  t('its touch listeners never block a scroll', !/addEventListener\('touch\w+',\s*_advTouch\w+,\s*\{ passive: false \}/.test(m) && (m.match(/_advTouch\w+,\s*\{ passive: true \}/g) ?? []).length === 3)
  t('a swipe over the overview strip scrolls too', /\.adv-nav-wrap \{[^}]*touch-action: pan-y/.test(css))
  t('nothing blurs behind a control as the page scrolls', !/\.adv-zoom \{[^}]*backdrop-filter/.test(css))
  t('Replay leaves Advanced first (it opened underneath it)', m.includes('onclick="window.mobVCloseAdvChart(); window.__openReplay()"'))
  t('on the line a drag reads it, off it a drag pans', m.includes("(tc.onLine ? 'scrub' : 'pan')"))
  t('the wheel scrolls the page when it can; ctrl+wheel (a pinch) zooms', m.includes("if (!e.ctrlKey && ov && ov.scrollHeight > ov.clientHeight + 1) return"))
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
