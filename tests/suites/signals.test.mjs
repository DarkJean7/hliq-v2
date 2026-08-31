// Signals: per-market performance, an indicator reading, and your own notes.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (sig) => {
  const i = cli.indexOf(sig); if (i < 0) return ''
  let j = cli.indexOf('{', i), d = 0
  for (; j < cli.length; j++) { if (cli[j] === '{') d++; else if (cli[j] === '}') { d--; if (!d) return cli.slice(i, j + 1) } }
  return ''
}
const fn = (sig, ret) => new Function(grab(sig) + '\n return ' + ret)()

console.log(String.fromCharCode(10) + '-- three sections, like Allocation --')
t('the segment state persists', cli.includes("localStorage.getItem('hliq_pulse_seg')"))
t('there are exactly three', cli.includes("tab('signals', _T('Signals', 'Señales'))}${tab('pulse', 'Pulse')}${tab('analysis'"))
t('Pulse keeps its own body under the header', cli.includes("el.innerHTML = _pulseSegHeader() + `<div style=\"padding:2px 0 90px\">"))
t('Analysis is handed a container rather than a rebuilt one', cli.includes("let host = el.querySelector('#pulseSegBody')"))
t('why that matters is recorded', cli.includes('must not tear down live chart iframes'))
t('Signals asks for the exchange data itself', cli.includes('  _pulseFetch()\n  // Candidate markets'))
t('why it must is recorded', cli.includes('Signals skips _pulseRenderInner'))

console.log(String.fromCharCode(10) + '-- the maths refuses to guess --')
const sma = fn('function _sma(a, n)', '_sma')
const ema = fn('function _ema(a, n)', '_ema')
const rsi = fn('function _rsi(a, n = 14)', '_rsi')
const sd  = fn('function _stdev(a)', '_stdev')
t('SMA of a flat series is that value', sma([5,5,5,5], 4) === 5)
t('SMA refuses a short series', sma([1,2], 5) === null)
t('EMA refuses a short series', ema([1,2], 5) === null)
t('EMA of a flat series is that value', Math.abs(ema([3,3,3,3,3,3], 3) - 3) < 1e-9)
// A 14-period RSI over 9 candles is not a weak signal, it is not an RSI.
t('RSI refuses a short series', rsi([1,2,3], 14) === null)
t('RSI of a pure uptrend is 100', rsi([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], 14) === 100)
t('RSI of a pure downtrend is 0', rsi([15,14,13,12,11,10,9,8,7,6,5,4,3,2,1], 14) === 0)
t('RSI of a flat series is 50', rsi(new Array(20).fill(7), 14) === 50)
t('RSI stays inside 0..100', [rsi([1,3,2,5,4,7,6,9,8,11,10,13,12,15,14], 14)].every(v => v >= 0 && v <= 100))
t('stdev of identical values is 0', sd([2,2,2,2]) === 0)
t('stdev needs two points', sd([1]) === null)
t('stdev is the sample one', Math.abs(sd([2,4,4,4,5,5,7,9]) - 2.13809) < 1e-4)

console.log(String.fromCharCode(10) + '-- a window with no history is not 0% --')
const perf = new Function('closes', `
  const c = closes
  if (!c || c.length < 2) return null
  return (c[c.length - 1] - c[0]) / c[0] * 100`)
t('two points give a real move', Math.abs(perf([100, 110]) - 10) < 1e-9)
t('one point is null, not zero', perf([100]) === null)
t('no candles is null', perf(null) === null)
t('a dash is shown for null rather than 0%', cli.includes("if (v == null) return `<span style=\"color:var(--fg-3)\">—</span>`"))

console.log(String.fromCharCode(10) + '-- the indicators report, they do not advise --')
const ind = cli.slice(cli.indexOf('const _SIG_INDICATORS = {'), cli.indexOf('window.__sigSetCoin'))
for (const k of ['rsi:', 'ema:', 'sma:', 'boll:', 'vol:', 'ma200w:']) t(`${k} exists`, ind.includes(k))
t('every one has a label and a plain-language blurb',
  (ind.match(/label:/g) || []).length === 6 && (ind.match(/blurb:/g) || []).length === 6)
// The line that keeps this honest: a reading is not a recommendation.
t('no indicator tells the user to buy or sell', !/\b(buy now|sell now|you should (buy|sell)|strong buy|strong sell)\b/i.test(ind))
t('the disclaimer is on the card itself',
  cli.includes('This says what it currently reads, not what to do about it'))
t('and the reasoning is recorded at the top', cli.includes('dressing one up as a recommendation'))
t('RSI states it can stay extreme in a trend', ind.includes('can sit at an extreme for a long time'))
t('EMA states that crossovers lag', ind.includes('they lag by construction'))
t('SMA distance denies mean reversion is implied', ind.includes('not that it must revert'))
t('volatility states it has no direction', ind.includes('not direction'))
t('each returns null when it cannot be computed', (ind.match(/return null/g) || []).length >= 6)

console.log(String.fromCharCode(10) + '-- comparison, like the Watch tab --')
t('a second market can be chosen', cli.includes('window.__sigSetCmp'))
t('it cannot be the same as the first', cli.includes("_sigCmp = (c && c !== _sigCoin) ? c : null"))
t('its candles are loaded too', cli.includes('if (_sigCmp)  _pulseLoadCandles(_sigCmp)'))
t('it gets its own performance row', cli.includes('${_sigCmp ? perfRow(_sigCmp) : \'\'}'))
t('and its own indicator reading beside the first', cli.includes('const cmpReading ='))

console.log(String.fromCharCode(10) + '-- notes --')
t('notes are per market', cli.includes('(all[_sigCoin] ??= []).unshift({ ts: Date.now()'))
t('newest first', cli.includes('.unshift('))
t('they are capped so the store cannot grow forever', cli.includes('all[_sigCoin].slice(0, 50)'))
t('and each note is length-capped', cli.includes('txt.slice(0, 600)'))
t('an empty note is not saved', cli.includes('if (!txt || !_sigCoin) return'))
t('a note can be deleted', cli.includes('window.__sigDelNote'))
t('note text is escaped', cli.includes('white-space:pre-wrap">${esc(n.text)}'))
t('the empty state explains why notes are worth keeping', cli.includes('outlasts any reading above it'))
t('the selected market, compare, indicator and timeframe all persist',
  ['SIG_KEY_COIN', 'SIG_KEY_CMP', 'SIG_KEY_IND', "'hliq_sig_tf'"].every(k => cli.includes(k)))

console.log(String.fromCharCode(10) + '-- the market picker offers a real choice --')
t('it ranks the full row set, not the short leaderboard', cli.includes('.sort((a, b) => (b.oi ?? 0) - (a.oi ?? 0))'))
t('why topOi was not enough is recorded', cli.includes('rather than the same five'))
t('the chip strips can be dragged', (cli.match(/data-dragscroll style="display:flex;gap:6px;overflow-x:auto/g) || []).length >= 3)

console.log(String.fromCharCode(10) + '-- the performance table can actually scroll --')
// It had overflow-x:auto with no data-dragscroll, and the global overflow-x killer strips
// scrolling from exactly that, so the last columns were simply unreachable.
t('the wrapper opts into drag-scrolling', cli.includes('<div data-dragscroll style="border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:11px 12px;margin-top:12px;overflow-x:auto">'))

console.log(String.fromCharCode(10) + '-- 200-week average --')
t('it exists', cli.includes('ma200w: {'))
t('it is fed weekly closes, not the chosen timeframe', cli.includes('weekly: true'))
t('the caller honours that', cli.includes('const series    = ind.weekly ? _sigWeeklyCloses(_sigCoin)'))
t('and so does the compare series', cli.includes('ind.weekly ? _sigWeeklyCloses(_sigCmp)'))
t('weeks are bucketed by UTC week, not every-7th-candle', cli.includes('Math.floor((t - 345600000) / 604800000)'))
t('a short history is stated, not averaged anyway', cli.includes('a 200-week average needs 200'))
t('it says WHY the history is short', cli.includes("Hyperliquid's own price data starts in 2023"))
t('and shows how far along it is', cli.includes('head: `${w.length}/200`'))
t('the limitation is recorded in the code', cli.includes("which Hyperliquid's own data does not yet reach"))

const wk = new Function('raw', `
  const byWeek = new Map()
  for (const k of raw) {
    const t = +k.t, c = parseFloat(k.c)
    if (!Number.isFinite(t) || !Number.isFinite(c)) continue
    const w = Math.floor((t - 345600000) / 604800000)
    byWeek.set(w, c)
  }
  return [...byWeek.entries()].sort((a,b)=>a[0]-b[0]).map(e=>e[1])`)
const day = 86400000
const mk = (n, f) => Array.from({length:n}, (_,i) => ({ t: Date.UTC(2024,0,1) + i*day, c: String(f(i)) }))
t('7 daily candles collapse to about one week', wk(mk(7, i => 100 + i)).length <= 2)
t('70 days give about ten weeks', Math.abs(wk(mk(70, i => 100 + i)).length - 10) <= 1)
t('the LAST close of a week wins', wk(mk(7, i => 100 + i)).slice(-1)[0] === 106)
t('junk candles are skipped', wk([{t:'x',c:'y'},...mk(7,i=>100+i)]).length <= 2)

console.log(String.fromCharCode(10) + '-- the indicator card flips to a detailed explanation --')
t('every indicator can explain itself', (cli.match(/    detail\(/g) || []).length === 6)
t('the flip is not persisted', cli.includes('let _sigFlipped = false') && !cli.includes("localStorage.setItem('hliq_sig_flip"))
t('why not is recorded', cli.includes('something you read once, not a mode to sit in'))
t('the back names how the number is worked out', cli.includes("_T('How it is worked out', 'Cómo se calcula')"))
t('shows the underlying levels as rows', cli.includes('detail.rows.map(([k, v])'))
t('says where it sits right now', cli.includes("_T('Where it sits now', 'Dónde está ahora')"))
t('and carries the caveat in its own colour', cli.includes("_T('Worth knowing', 'Conviene saber')") && css.includes('.sig-caveat b { color: var(--orange'))
t('only the visible face sizes the card', css.includes('.sig-card.sig-flipped .sig-front { position: absolute; inset: 0; }'))
t('the turn respects reduced motion', css.includes('@media (prefers-reduced-motion: reduce) { .sig-flip { transition: none; } }'))
t('EMA detail shows both averages and the price', cli.includes("_T('Fast (9)', 'Rápida (9)')") && cli.includes("_T('Slow (21)', 'Lenta (21)')"))
t('Bollinger detail shows all three band levels',
  cli.includes("_T('Upper band', 'Banda superior')") && cli.includes("_T('Lower band', 'Banda inferior')"))
t('volatility detail converts to a per-day figure', cli.includes("_T('Per day', 'Por día')"))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
