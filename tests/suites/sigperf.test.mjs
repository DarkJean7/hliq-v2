// Signals' Performance table: every window has a figure, the 1H one included.
//
// "signals 1 hour performance is not showing". The window kept only candles that STARTED inside it;
// with hourly candles a one-hour window held one, and a change needs two points. These run the real
// function against candles shaped like Hyperliquid's.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const main = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

const at = main.indexOf('function _sigPerf(coin, label) {')
const src = main.slice(at, main.indexOf('\n}\n', at) + 2)
const closes = main.slice(main.indexOf('function _sigCloses('), main.indexOf('\n}\n', main.indexOf('function _sigCloses(')) + 2)
const H = 3_600_000
const NOW = Date.UTC(2026, 10, 6, 12, 30)      // half past twelve

const perf = (raw, label, { live = 0, ext = false } = {}) => {
  const RealNow = Date.now
  Date.now = () => NOW
  try {
    return new Function('_pulseCandles', '_PULSE_TF', 'isExtMarket', 'extTwin', '_livePx', `${closes}\n${src}\nreturn _sigPerf('BTC', '${label}')`)(
      { 'BTC|1h': raw, 'BTC|1d': raw },
      [['1h', '1h', H], ['24h', '1h', 24 * H], ['All', '1d', 0]],
      () => ext, () => null, () => live)
  } finally { Date.now = RealNow }
}
const bar = (hoursAgo, o, c) => ({ t: Date.UTC(2026, 10, 6, 12) - hoursAgo * H, o: String(o), c: String(c) })

// 11:00 candle: 100 → 110. 12:00 candle: 110 → 121. Half past eleven is half way through the first.
const raw = [bar(2, 90, 100), bar(1, 100, 110), bar(0, 110, 121)]
t('1H has a figure with hourly candles', perf(raw, '1h') != null)
t('measured from the price when the window opened, part-way through its candle',
  Math.abs(perf(raw, '1h') - (121 - 105) / 105 * 100) < 1e-9, perf(raw, '1h'))
t('ending on the live price when there is one', Math.abs(perf(raw, '1h', { live: 126 }) - (126 - 105) / 105 * 100) < 1e-9, perf(raw, '1h', { live: 126 }))
t('a market younger than the window measures from its first open', Math.abs(perf(raw, '24h') - (121 - 90) / 90 * 100) < 1e-9, perf(raw, '24h'))
t('All is first close to now', Math.abs(perf(raw, 'All') - (121 - 100) / 100 * 100) < 1e-9, perf(raw, 'All'))
t('nothing traded for hours is no figure, not a stale one', perf([bar(9, 100, 110)], '1h') === null)
t('no candles yet is no figure', perf('loading', '1h') === null)

t('stale candles reload', /Date\.now\(\) - \(_pulseCandlesAt\[key\] \?\? 0\) < _PULSE_CANDLE_TTL\[iv\]/.test(main))
t('and stay on screen until the new ones arrive', /if \(!Array\.isArray\(have\)\) _pulseCandles\[key\] = 'loading'/.test(main))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
