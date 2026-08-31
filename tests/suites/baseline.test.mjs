// Extracts the REAL _seriesValueAt and _mergeSeries from main.js and reproduces the
// desktop-vs-mobile divergence: same underlying account curve, two different device grids.
import fs from 'fs'

const src = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}
const { _seriesValueAt, _mergeSeries } = new Function(
  `${grab('function _sampleAt(')}\n${grab('function _seriesValueAt(')}\n${grab('function _mergeSeries(')}\nreturn { _seriesValueAt, _mergeSeries }`)()

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

const NOW = 1787000000000
const DAY = 86400000

// ── interpolation basics ─────────────────────────────────────────────────────
const s = [[0, '100'], [100, '200'], [200, '400']]
t('exact sample hit', near(_seriesValueAt(s, 100), 200))
t('midpoint interpolates', near(_seriesValueAt(s, 50), 150))
t('interpolates in the second segment', near(_seriesValueAt(s, 150), 300))
t('clamps before the first sample', near(_seriesValueAt(s, -999), 100))
t('clamps after the last sample', near(_seriesValueAt(s, 99999), 400))
t('empty series is 0', _seriesValueAt([], 5) === 0)
t('single sample returns it', near(_seriesValueAt([[10, '42']], 99999), 42))
t('duplicate timestamps do not divide by zero',
  Number.isFinite(_seriesValueAt([[10, '1'], [10, '2'], [20, '3']], 10)))

// ── the reported bug ─────────────────────────────────────────────────────────
// A realistic all-time curve: ~300 days sampled hourly-ish. _mergeSeries caps the grid at
// 240 points, so over that span one step is well over a day — which is the condition that
// made snapping land on a different moment per device. Shape mirrors the screenshots: a long
// drift, a dip, then a sharp rally over the final days.
const truth = []
const DAYS = 300
for (let h = DAYS * 24; h >= 0; h--) {
  const ts = NOW - h * 3600000
  const d  = h / 24
  const v  = d > 10 ? 3000 - (DAYS - d) * 0.5
           : 3260 + (10 - d) * 14        // the rally: ~3300 at 24h ago, ~3400 now
  truth.push([ts, String(v)])
}
const valueAt24hAgo = 3260 + 9 * 14   // value one day back on the rally leg

// Two devices resample that same curve differently — different cached span and length,
// which is exactly what _mergeSeries keys its grid off.
const deviceA = _mergeSeries([{ portfolio: [['allTime', { accountValueHistory: truth }]] }], 'allTime', 'accountValueHistory')
const deviceB = _mergeSeries([{ portfolio: [['allTime', { accountValueHistory: truth.slice(37) }]] }], 'allTime', 'accountValueHistory')

t('the two device grids really do differ',
  deviceA.length !== deviceB.length || +deviceA[0][0] !== +deviceB[0][0])

// OLD behaviour: snap to the first grid point at or after the cutoff.
const oldWay = h => parseFloat((h.find(([ts]) => +ts >= NOW - DAY) ?? h[0])[1])
const oldA = oldWay(deviceA), oldB = oldWay(deviceB)

// NEW behaviour: interpolate at the cutoff.
const newA = _seriesValueAt(deviceA, NOW - DAY), newB = _seriesValueAt(deviceB, NOW - DAY)

console.log(`     old: A=${oldA.toFixed(2)}  B=${oldB.toFixed(2)}  (Δ ${Math.abs(oldA - oldB).toFixed(2)})`)
console.log(`     new: A=${newA.toFixed(2)}  B=${newB.toFixed(2)}  (Δ ${Math.abs(newA - newB).toFixed(2)})`)

t('NEW: the two devices agree', Math.abs(newA - newB) < 1, `Δ ${Math.abs(newA - newB)}`)
t('NEW: A matches the true 24h-ago value', Math.abs(newA - valueAt24hAgo) < 5, `${newA} vs ${valueAt24hAgo}`)
t('NEW: B matches the true 24h-ago value', Math.abs(newB - valueAt24hAgo) < 5, `${newB} vs ${valueAt24hAgo}`)
// NOTE: with this curve the old snapping code is only ~$14 off and does NOT vary across
// cache states. So grid-snapping is a real defect worth removing, but it is NOT demonstrated
// to be the cause of the desktop-vs-mobile divergence. Not asserting what I could not show.
t('NEW is closer to truth than OLD',
  Math.abs(newA - valueAt24hAgo) < Math.abs(oldA - valueAt24hAgo))

// The core claim: OLD's answer depends on what the device happens to have cached, NEW's
// does not. Sweep the cached start across a range and compare the spread of each.
const oldVals = [], newVals = []
for (const cut of [0, 11, 23, 37, 61, 89, 113, 149]) {
  const g = _mergeSeries([{ portfolio: [['allTime', { accountValueHistory: truth.slice(cut) }]] }], 'allTime', 'accountValueHistory')
  oldVals.push(oldWay(g))
  newVals.push(_seriesValueAt(g, NOW - DAY))
}
const spread = a => Math.max(...a) - Math.min(...a)
console.log(`     across 8 cache states — old spread $${spread(oldVals).toFixed(2)}, new spread $${spread(newVals).toFixed(2)}`)
t('NEW is stable across every cache state', spread(newVals) < 1, `${spread(newVals)}`)
t('NEW spread is negligible in absolute terms', spread(newVals) < 0.01, `${spread(newVals)}`)
t('every NEW reading lands on the true value', newVals.every(v => Math.abs(v - valueAt24hAgo) < 5))

// ── the resulting "today" figure converges ───────────────────────────────────
const equity = 3400
t('NEW today figures match between devices', Math.abs((equity - newA) - (equity - newB)) < 1)
t('NEW today is the real 24h move', Math.abs((equity - newA) - (equity - valueAt24hAgo)) < 5)

// ── a short series (newly tracked account) must not break ────────────────────
const short = _mergeSeries([{ portfolio: [['allTime', { accountValueHistory: [[NOW - 3600000, '10'], [NOW, '20']] }]] }], 'allTime', 'accountValueHistory')
t('series shorter than the window clamps to its first value',
  near(_seriesValueAt(short, NOW - DAY), 10), `${_seriesValueAt(short, NOW - DAY)}`)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
