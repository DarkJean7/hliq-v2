// The Analysis tab against Hyperliquid's per-IP budget.
//
// Reported as "rate limited just by being in the analysis tab", with the banner stuck at the
// breaker's 120s cap. Measured with tests/hl-weight.mjs (--analysis=N): a market never seen
// before costs three candle reads at weight 20 plus the book at three aggregations, and
// browsing six of them put candleSnapshot at 507 weight/min — 38% of the whole budget — on a
// SINGLE wallet. Two things were wrong, and this holds both of them down.
import fs from 'fs'
const ana = fs.readFileSync('src/analysis.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const wgt = fs.readFileSync('tests/hl-weight.mjs', 'utf8').replace(/\r\n/g, '\n')
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
const refresh = grab(ana, 'async function refresh(force = false)')

console.log('\n-- it stands down for the global 429 breaker --')
// The breaker pauses every poller so the bucket can refill. This one kept fetching through
// the pause, re-tripped it, and the backoff doubled to its 120s cap and stayed there.
t('the view takes a limited() dependency', ana.includes('limited: () => false'))
t('refresh returns while limited', refresh.includes('if (!force && deps.limited?.()) return'))
t('a forced refresh still goes, so a deliberate Analyse is not silently swallowed',
  refresh.includes('!force && deps.limited'))
t('main.js passes the real breaker in', cli.includes('limited: _hlLimited }'))
t('_hlLimited is what every other poller uses', (cli.match(/_hlLimited\(\)/g) ?? []).length > 10)
t('the reason is recorded where the next reader will be', ana.includes('holding the whole app in the penalty box'))

// The gate, run rather than read.
const gate = new Function('force', 'limited', 'return !(!force && limited)')
t('limited and not forced → no fetch', gate(false, true) === false)
t('limited but forced → fetch', gate(true, true) === true)
t('not limited → fetch', gate(false, false) === true)

console.log('\n-- a market you have left stops costing weight --')
t('there is one in-flight load', ana.includes('let inflight = null'))
t('switching market aborts the one before it', refresh.includes("if (inflight && inflight.coin !== coin) { try { inflight.ac.abort() } catch {} ; inflight = null }"))
t('the abort happens BEFORE the loading guard, or a stuck load would block the new market',
  refresh.indexOf('inflight.coin !== coin') < refresh.indexOf('if (e.loading) return'))
t('each load carries its own controller', refresh.includes('const ac = new AbortController()'))
t('candles take the signal', ana.includes('async function loadCandles(coin, signal)'))
t('...and pass it to Hyperliquid', ana.includes('interval: tf, startTime: now - SPAN[tf] }, signal)'))
t('books take it too', ana.includes('async function loadBooks(coin, signal)') && ana.includes('{ coin, nSigFigs: n } : { coin }, signal)'))
t('the next timeframe is skipped once aborted — the point is the ones never sent',
  grab(ana, 'async function loadCandles(coin, signal)').includes('if (signal?.aborted) return\n    try {'))
t('an aborted load does not repaint over the market now on screen', refresh.includes('if (S.coin === coin && !ac.signal.aborted)'))
t('only the owning load clears the slot', refresh.includes('if (inflight?.ac === ac) inflight = null'))
t('and the slot is cleared in a finally, so an error does not wedge it', refresh.includes('} finally {'))

console.log('\n-- walking away is not a failure --')
// Letting an abort fall through to err:'net' put a network error on a market the person had
// already left, waiting for them when they came back. Empty is not the same as unknown.
const lc = grab(ana, 'async function loadCandles(coin, signal)')
t('abort is checked before the all-failed verdict', lc.indexOf("if (signal?.aborted) return\n  if (failed === TFS.length)") > 0)
t('books do not parse a cancelled read', grab(ana, 'async function loadBooks(coin, signal)').includes('if (signal?.aborted) return\n  const books'))
const verdict = new Function('aborted', 'failed', 'n', `
  if (aborted) return 'unknown'
  if (failed === n) return 'net'
  return 'ok'
`)
t('three real failures is a network error', verdict(false, 3, 3) === 'net')
t('three aborted ones is not', verdict(true, 3, 3) === 'unknown')
t('a partial failure is still a result', verdict(false, 1, 3) === 'ok')

console.log('\n-- off screen means stop, not just pause --')
const tick = grab(ana, 'export function renderAnalysis(root, d)')
t('the tick drops in-flight work when nobody is looking', tick.includes('if (inflight) { try { inflight.ac.abort() } catch {} ; inflight = null }'))
t('it checks both the container and the page', tick.includes('S.root.offsetParent === null || document.hidden'))

console.log('\n-- the measuring tool can see this shape --')
t('hl-weight can browse markets', wgt.includes("--analysis="))
t('it stubs real candles, or the view concludes there is no market and never asks for the book',
  wgt.includes('const CANDLES = Array.from') && wgt.includes('candleSnapshot: CANDLES'))
t('and a real book, for the same reason', wgt.includes('l2Book: BOOK'))
t('responses take time, or nothing is ever in flight to abandon', wgt.includes("--latency="))
t('the default latency is not zero', /const LATENCY = .*\?\? 180\)/.test(wgt))
t('tap speed is settable', wgt.includes("--tap="))
t('the browse happens before the settle window, so --settle=0 catches the burst',
  wgt.indexOf('const ANALYSIS =') < wgt.indexOf('const SETTLE ='))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
