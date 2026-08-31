// Charts for the three Pulse header stats.
import fs from 'fs'
import { pulseSeries, windowSeries } from 'file:///C:/Users/jeank/OneDrive/Desktop/hliq-v2/src/ecosystem.js'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n── old readings stay valid ──')
// Rows recorded before OI was captured are 3 long. Reading a missing field as 0 would
// draw a cliff up from nothing on the day recording started.
const mixed = [
  [1, 100, 10],                 // before OI was recorded
  [2, 200, 20, 5000, 68.5],
  [3, 300, 30, 6000, 70],
]
const ser = pulseSeries(mixed)
t('volume uses every row, including the old short ones', ser.volume.length === 3)
t('and adds perp + spot', ser.volume[0][1] === 110 && ser.volume[2][1] === 330)
t('OI skips the rows that never carried it', ser.oi.length === 2 && ser.oi[0][0] === 2)
t('so the OI chart starts later than the volume chart, honestly',
  ser.oi[0][0] > ser.volume[0][0])
t('top 3 share likewise', ser.top3.length === 2 && ser.top3[0][1] === 68.5)
t('a zero OI reading is dropped, not charted as a real low',
  pulseSeries([[1, 1, 1, 0, 0]]).oi.length === 0)
t('malformed rows are dropped', pulseSeries([null, 'x', [1, 5, 5]]).volume.length === 1)
t('no points, no series', pulseSeries([]).oi.length === 0 && pulseSeries(null).volume.length === 0)
t('a missing spot figure does not void the volume point',
  pulseSeries([[1, 100]]).volume[0][1] === 100)

console.log('\n── the windows ──')
const now = Date.now(), H = 3600e3
const many = Array.from({ length: 500 }, (_, i) => [now - (499 - i) * H, i, 0, i * 10, 60 + i / 100])
t('24h trims to about a day', Math.abs(windowSeries(pulseSeries(many).volume, 24 * H).length - 25) <= 1)
t('All keeps everything recorded', windowSeries(pulseSeries(many).volume, 0).length === 500)

console.log('\n── the stat tiles ──')
const rend = grab(cli, 'function _pulseRenderInner(el)')
t('each of the three is tappable', (rend.match(/window\.__pulseStatPick\(/g) ?? []).length >= 1)
t('open interest, volume and top-3 all pass a key',
  rend.includes("stat('oi',") && rend.includes("stat('volume',") && rend.includes("stat('top3',"))
t('the chart renders under the tiles', rend.includes('${_pulseStatChartHtml()}'))
const pick = grab(cli, 'window.__pulseStatPick = function(which)')
t('tapping the open one closes it', pick.includes("_pulseStat === which ? '' : which"))
t('nothing is open by default — the tab stays as it was', /let _pulseStat = ''/.test(cli))

console.log('\n── the chart ──')
const sc = grab(cli, 'function _pulseStatChartHtml()')
t('it draws nothing when no stat is picked', sc.includes('if (!_pulseStat) return'))
t('an unknown key cannot crash the render', sc.includes('if (!meta) return'))
t('it reuses the same interactive chart as everything else', sc.includes('_pulseInteractiveChart('))
t('under two points it explains rather than drawing an empty box', sc.includes('Recording started'))
t('and says there is nothing to backfill', sc.includes('nothing to backfill'))
t('it reports how far back the recording goes', sc.includes("_T('recorded since'"))
t('with its own windows', sc.includes("[24 * 3600e3, '24h']") && sc.includes("[0, _T('All'"))

console.log('\n── top-3 share is a percentage, not money ──')
const ic = grab(cli, 'function _pulseInteractiveChart(pts, ')
t('the chart can format a percentage', ic.includes("pct ? (v) => v.toFixed(1) + '%'"))
t('and top-3 asks for it', cli.includes("top3:   { key: 'st3'") && /top3:[^}]*money: false/.test(cli))
t('while OI and volume stay money',
  /oi:\s*\{[^}]*money: true/.test(cli) && /volume:\s*\{[^}]*money: true/.test(cli))
t('the scrub readout honours it too',
  grab(cli, 'window.__pulseScrub = function(ev, key)').includes("d.pct ? (+best[1]).toFixed(1) + '%'"))
t('and so does the reset on release',
  grab(cli, 'window.__pulseScrubEnd = function(key)').includes("d.pct ? (+last[1]).toFixed(1) + '%'"))

console.log('\n── the server records what the charts need ──')
const poll = grab(srv, 'async function volPoll()')
t('open interest is recorded', poll.includes('const oi = ois.reduce'))
t('converted to dollars, since HL publishes it in base units',
  poll.includes("parseFloat(c?.openInterest ?? 0) * parseFloat(c?.markPx ?? 0)"))
t('and the top-3 concentration alongside it', poll.includes('const top3 ='))
t('as a share of total OI', poll.includes('oi > 0 ? (top3 / oi) * 100 : 0'))
t('a division by zero cannot produce NaN', poll.includes('oi > 0 ?'))
t('the row is APPENDED to, so old recordings survive',
  poll.includes('Math.round(perpVol), Math.round(spotVol), Math.round(oi)'))
t('and why that matters is written down', poll.includes('rows recorded before this shipped are 3 long'))
t('a bad read still lands as nothing rather than a zero', poll.includes('if (!(perpVol > 0)) return'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
