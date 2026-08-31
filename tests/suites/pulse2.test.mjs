// The paywall on copy trade, the rate-limit throttle, the long timeframes, and the charts.
import fs from 'fs'
import { sparkPath, windowSeries, feeSeries, HL_FEE_MAKER, HL_FEE_TAKER } from '../../src/ecosystem.js'
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

console.log('\n── copy trade is behind the subscription ──')
const social = grab(cli, 'function _lbSocialHtml(r)')
t('an unsubscribed user sees a lock, not a live button', social.includes('_stratsUnlocked()') && social.includes("'🔒'"))
t('and tapping it opens the paywall', social.includes('window.__subOpenPaywall()'))
t('a subscriber gets the real action', social.includes('window.__lbCopyTrade('))
const sheet = grab(cli, "window.__lbCopyTrade = function(addr = '', name = '')")
t('the sheet itself refuses too — it is reachable from Strategies Run as well',
  sheet.includes('if (!_stratsUnlocked()) { window.__subOpenPaywall?.(); return }'))
t('the gate is the FIRST thing it does, before building any form',
  sheet.indexOf('_stratsUnlocked') < sheet.indexOf('document.createElement'))
t('dev mode still unlocks it, like every other bot',
  grab(cli, 'function _stratsUnlocked()').includes('isDev()'))
t('and the server is still the real gate', srv.includes("return json(res, 402, { error: 'subscription required'"))

console.log('\n── the rate limiting the user hit ──')
t('candle requests go through a queue, not straight at HL', cli.includes('function _pulseQueue(job)'))
t('one at a time', grab(cli, 'async function _pulseQRun()').includes('const job = _pulseQ.shift()'))
t('with a gap between them, so a card open is not a burst',
  grab(cli, 'async function _pulseQRun()').includes('setTimeout(r, 250)'))
t('the queue waits instead of firing while HL is refusing',
  grab(cli, 'async function _pulseQRun()').includes('if (_hlLimited()) { await new Promise(r => setTimeout(r, 2000)); continue }'))
t('Pulse stops polling entirely during a backoff',
  grab(cli, 'async function _pulseFetch(force = false)').includes('if (_hlLimited()) return'))
t('and the ten-call dex fan-out especially', grab(cli, 'async function _pulseFetchDexes(main)').includes('if (_hlLimited()) return'))
t('the Assistance Fund is no longer re-read every minute — it moves in days',
  cli.includes('const PULSE_PROTO_TTL_MS = 10 * 60_000'))
t('but the fee bounds still refresh against live volume, from data already held',
  grab(cli, 'async function _pulseFetchProto(main, spot)').includes('afBalances: _pulseAfBalances, afPortfolio: _pulseAfPf'))
t('opening the tab no longer warms market data for cards nobody opened',
  !/mob-tab-full'\)\n\s*\/\/ Market caps come/.test(cli))
t('market caps load on first expand, through the same queue',
  grab(cli, 'function _pulseLoadCandles(coin)').includes('_pulseQueue(() => _pulseEnsureCaps())'))
t('and cost ONE spot call rather than the ten-dex market-data fan-out',
  (grab(cli, 'async function _pulseEnsureCaps()').match(/await fetch/g) ?? []).length === 1)
t('the volume chart reads OUR server, spending no HL budget',
  grab(cli, 'async function _pulseFetchVolume()').includes("fetch('/api/pulse/volume')"))

console.log('\n── 3M, 1y and all-time ──')
t('all seven windows are offered', ['1h', '24h', '7d', '30d', '3M', '1y', 'All'].every(k => cli.includes(`'${k}',`)))
t('long windows use DAILY candles — a year of hourly is 8,760 points and HL caps at 5,000',
  /\['1y',\s*'1d'/.test(cli) && /\['3M',\s*'1d'/.test(cli))
t('short windows stay hourly', /\['1h',\s*'1h'/.test(cli) && /\['30d',\s*'1h'/.test(cli))
t('so a card is two requests, not seven', (grab(cli, 'function _pulseLoadCandles(coin)').match(/fetchCandles\(/g) ?? []).length === 1)
t('each interval is cached separately', cli.includes("const key = coin + '|' + iv"))
t('"all time" starts from a real date — HL rejects a 0 start',
  grab(cli, 'function _pulseLoadCandles(coin)').includes('Date.UTC(2023, 0, 1)'))
t('and All measures from the first candle actually returned, not a fixed cutoff',
  cli.includes('_pulseChangeFrom(pts, Date.now() - (+pts[0]?.t || 0))'))

console.log('\n── sparkPath ──')
const rising = [[1, 10], [2, 20], [3, 30]]
const sp = sparkPath(rising, 300, 60)
t('a series becomes a path', sp.line.startsWith('M') && sp.line.includes('L'))
t('the area closes back to the baseline', sp.area.endsWith('Z'))
t('one point is not a chart', sparkPath([[1, 5]]) === null)
t('nor is none', sparkPath([]) === null && sparkPath(null) === null)
t('the change is first→last', Math.abs(sp.changePct - 200) < 1e-9, String(sp.changePct))
t('a flat series centres instead of dividing by zero',
  /,30\.0/.test(sparkPath([[1, 7], [2, 7]], 300, 60).line))
t('the y-range is the data, not 0→max — a $2.6B–$3.7B fund must show shape',
  sparkPath([[1, 2.6e9], [2, 3.7e9]]).min === 2.6e9)
t('non-numeric points are dropped rather than breaking the path',
  sparkPath([[1, 10], [2, 'x'], [3, 30]]).line.split('L').length === 2)
t('a descending series still charts', sparkPath([[1, 30], [2, 10]]).changePct < 0)

console.log('\n── windowSeries ──')
const now = Date.now(), D = 86400e3
const yr = Array.from({ length: 400 }, (_, i) => [now - (399 - i) * D, i])
t('7d keeps about a week', [7, 8].includes(windowSeries(yr, 7 * D).length), String(windowSeries(yr, 7 * D).length))
t('0 means everything', windowSeries(yr, 0).length === 400)
t('a window longer than the history keeps all of it', windowSeries(yr, 9999 * D).length === 400)
t('junk in, empty out', windowSeries(null, D).length === 0)

console.log('\n── feeSeries ──')
const vol = [[1, 1e9, 2e8], [2, 2e9, 0]]
const fs2 = feeSeries(vol)
t('perp and spot volume are added before the rate applies',
  fs2.vol[0][1] === 1.2e9 && fs2.vol[1][1] === 2e9)
t('the low bound is the maker rate', fs2.low[0][1] === 1.2e9 * HL_FEE_MAKER)
t('the high bound is the taker rate', fs2.high[0][1] === 1.2e9 * HL_FEE_TAKER)
t('so the chart is a RANGE — the mix is not published, and one line would invent it',
  fs2.high[0][1] > fs2.low[0][1])
t('a missing spot figure does not poison the sum', feeSeries([[1, 1e9]]).vol[0][1] === 1e9)
t('malformed rows are dropped', feeSeries([null, 'x', [1, 1e9, 0]]).vol.length === 1)

console.log('\n── the charts ──')
t('the fund chart uses history that came free with a call already made',
  grab(cli, 'function _pulseAfChartHtml()').includes('accountValueHistory'))
t('with the four windows HL returns',
  grab(cli, 'function _pulseAfChartHtml()').includes("[['day', '24h'], ['week', '7d'], ['month', '30d'], ['allTime'"))
t('and says plainly it is VALUE, not revenue — it moves with the HYPE price',
  cli.includes("Fund <b>value</b>, not revenue"))
t('the fee chart draws a band, not a line', grab(cli, 'function _pulseFeeChartHtml()').includes('band: fs.high'))
t('it has its own windows including 1y and all', grab(cli, 'function _pulseFeeChartHtml()').includes("[365 * 24 * 3600e3, '1y']"))
t('with no history it says so instead of drawing an empty box',
  grab(cli, 'function _pulseFeeChartHtml()').includes('Recording started'))
t('and states why there is nothing to backfill',
  cli.includes('Hyperliquid publishes no historical volume, so there is nothing to backfill'))
t('the caption reports how far back the record really goes',
  grab(cli, 'function _pulseFeeChartHtml()').includes("_T('recorded since'"))

console.log('\n── the server recorder ──')
t('there is an endpoint', srv.includes("path === '/api/pulse/volume'"))
t('it reports since, so the UI cannot imply more history than exists',
  srv.includes('since: points[0]?.[0] ?? 0'))
t('readings are hourly', srv.includes('const VOL_POLL_MS = 60 * 60 * 1000'))
t('seeded on boot so a fresh install is not empty for an hour', srv.includes('setTimeout(() => volPoll(), 8000)'))
t('a failed read is not stored as a zero that would dent the chart',
  grab(srv, 'async function volPoll()').includes('if (!(perpVol > 0)) return'))
t('a second reading in the same hour replaces rather than appends',
  grab(srv, 'async function volPoll()').includes('if (last && Math.floor(last[0] / VOL_POLL_MS) === hour) points.pop()'))
t('and the estimation shortcut was rejected on the record',
  srv.includes("Hyperliquid's coin mix a year ago was nothing like today's"))

const compact = new Function('points', `
  const VOL_MAX = 2000
  ${grab(srv, 'function volCompact(points)').replace('function volCompact(points) {', '').slice(0, -1)}
`)
const hourly = Array.from({ length: 24 * 40 }, (_, i) => [now - (24 * 40 - 1 - i) * 3600e3, i, 0])
const kept = compact(hourly)
t('recent hours are kept at full detail', kept.filter(p => p[0] >= now - 14 * D).length === 14 * 24)
t('older readings collapse to one a day', kept.filter(p => p[0] < now - 14 * D).length <= 27, String(kept.length))
t('the file stays bounded', compact(Array.from({ length: 9000 }, (_, i) => [now - i * 60e3, i, 0])).length <= 2000)
t('and the store is gitignored, since it is server state',
  fs.readFileSync('.gitignore', 'utf8').includes('pulse-volume.json'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
