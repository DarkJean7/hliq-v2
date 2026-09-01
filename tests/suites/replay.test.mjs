// Replay: playing a market or the account forward with the trades landing as they happened.
//
// The arithmetic is the risky half. A replay that shows a position it did not hold, or a
// PnL that includes a trade that has not happened on screen yet, is telling the user a
// story about their money that is not true.
import fs from 'fs'
import { walkFills, stateAt, markersUpto, summarise, frameTime } from '../../src/replay.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const htm = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')
const chart = fs.readFileSync('src/sigchart.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const F = (time, side, sz, px, closedPnl = 0, fee = 0) => ({ time, side, sz, px, closedPnl, fee, coin: 'X' })

console.log(String.fromCharCode(10) + '-- the position follows the fills --')
const steps = walkFills([
  F(1, 'BUY', 2, 100), F(2, 'BUY', 2, 110), F(3, 'SELL', 1, 120, 15), F(4, 'SELL', 4, 130, 45),
])
t('opening sets the entry', steps[0].szi === 2 && steps[0].entry === 100)
t('adding blends by size, not by count', steps[1].szi === 4 && steps[1].entry === 105)
// A reduce realises part of the position; it does not re-price what is left.
t('reducing leaves the entry alone', steps[2].szi === 3 && steps[2].entry === 105)
t('flipping through zero starts a new entry at the fill', steps[3].szi === -1 && steps[3].entry === 130)
t('a fill that closes exactly to zero clears the entry',
  walkFills([F(1, 'BUY', 2, 100), F(2, 'SELL', 2, 110, 20)])[1].entry === 0)
t('unsigned sizes are handled either way', walkFills([F(1, 'BUY', -2, 100)])[0].szi === 2)
t('junk is dropped, not turned into NaN', walkFills([F(1, 'BUY', NaN, 100), F(2, 'BUY', 1, 100)]).length === 1)

console.log(String.fromCharCode(10) + '-- realised is what reached the account --')
// HL charges on the way in as well as out; counting only closedPnl overstates the result.
const fees = walkFills([F(1, 'BUY', 1, 100, 0, 0.5), F(2, 'SELL', 1, 110, 10, 0.5)])
t('fees come out of realised', Math.abs(fees[1].realized - 9) < 1e-9, fees[1].realized)
t('fees are tracked separately too', Math.abs(fees[1].fees - 1) < 1e-9)

console.log(String.fromCharCode(10) + '-- and it never reads ahead --')
// The whole feature rests on this: at any frame, only what had happened by then.
const mid = stateAt(steps, 2, 115)
t('state at a time uses only fills up to it', mid.szi === 4 && mid.trades === 2)
t('so realised is the running figure, not the final one',
  Math.abs(mid.realized) < 1e-9 && Math.abs(steps[3].realized - 60) < 1e-9)
t('unrealised is marked at the price on screen', Math.abs(mid.unrealized - 40) < 1e-9, mid.unrealized)
t('before the first fill everything is zero', stateAt(steps, 0, 100).trades === 0)
t('markers appear as they land', markersUpto(steps, 2).length === 2 && markersUpto(steps, 4).length === 4)
t('an empty history is flat, not an error', stateAt([], 5, 1).szi === 0 && markersUpto(null, 5).length === 0)

console.log(String.fromCharCode(10) + '-- the summary is a running one --')
const s = summarise(steps, 3, 120)
t('net is realised plus what is still open', Math.abs(s.net - (s.realized + s.unrealized)) < 1e-9)
t('win rate counts only closes so far', s.closes === 1 && s.wins === 1 && s.winRate === 100)
t('with no closes it is unknown, not zero', summarise(steps, 1, 100).winRate === null)

console.log(String.fromCharCode(10) + '-- the clock walks candles, not fills --')
// A market that did nothing for six hours should take six hours of replay; stepping
// fill-to-fill would skip exactly the waiting that makes a position worth watching.
const pts = [[10, 1], [20, 2], [30, 3]]
t('a frame maps to a candle time', frameTime(pts, 1) === 20)
t('and is clamped to the series', frameTime(pts, 99) === 30 && frameTime(pts, -5) === 10)
t('an empty series has no time', frameTime([], 0) === 0)

console.log(String.fromCharCode(10) + '-- drawn only as far as the playhead --')
t('the chart is cut at the current frame', cli.includes('from: 0, to: i + 1,'))
t('and the reason is recorded', cli.includes('the replay cannot hint at where it is going'))
t('markers are only those that have landed', cli.includes('markersUpto(d.steps, t)'))
t('a price marker sits at the fill price, an equity one on the line',
  cli.includes("v: _repMode === 'market' ? m.px : null"))

console.log(String.fromCharCode(10) + '-- both modes, and a way in --')
t('market and account modes exist', cli.includes("window.__repSetMode") && cli.includes("_repMode === 'account'"))
// Recomputing account value from fills would miss deposits, funding and everything else.
t('account mode plays the portfolio history, not a reconstruction', cli.includes("accountValueHistory"))
t('market mode offers only markets actually traded', cli.includes('function _repCoins()'))
t('mobile has the tab', htm.includes("window.__mobMoreTab('replay')") && /_MOBV_FULLPAGE = new Set\(\[[^\]]*'replay'/.test(cli))
t('desktop has the tab and a pane', htm.includes('id="tab-replay"') && htm.includes('id="deskReplay"') &&
  cli.includes("if (name === 'replay')     _repRender(_viewHost('deskReplay'))"))

console.log(String.fromCharCode(10) + '-- the player behaves --')
t('play, pause, seek, restart and speed all exist',
  ['__repPlay', '__repSeek', '__repRestart', '__repSpeed'].every(k => cli.includes(k)))
t('pressing play at the end starts over', cli.includes('if (_repFrame >= n - 1) _repFrame = 0'))
t('only the stage repaints per frame, never the view', cli.includes('function _repPaint()') &&
  cli.includes("el.innerHTML = _repStageHtml()"))
// A timer against a detached stage keeps waking the page for a screen nobody is on.
t('leaving stops the clock', (cli.match(/_repStop\(\)/g) || []).length >= 4 &&
  cli.includes("if (name !== 'replay') _repStop()"))
t('a new subject rewinds rather than keeping a stale frame', cli.includes('function _repReset()'))
// Candles in flight are UNKNOWN, not absent -- the mistake this app has shipped three times.
t('loading is not reported as "no history"', cli.includes("_T('Loading market history…', 'Cargando historial…')"))
t('the transport tracks the frame, not just the render', cli.includes("pos.textContent = n ? `${_repFrame + 1}/${n}` : ''"))

console.log(String.fromCharCode(10) + '-- the ledger row --')
const led = summarise(steps, 4, 130)
t('bought and sold are running totals at the prices paid',
  Math.abs(led.bought - (2 * 100 + 2 * 110)) < 1e-9 && Math.abs(led.sold - (1 * 120 + 4 * 130)) < 1e-9, [led.bought, led.sold])
t('they count only what has happened by then', summarise(steps, 1, 100).bought === 200)
t('holding is the open position at the price on screen',
  Math.abs(summarise(steps, 2, 115).holding - 4 * 115) < 1e-9)
t('a short position still counts as holding', Math.abs(led.holding - 130) < 1e-9, led.holding)
t('flat holds nothing -- a known zero, not an unknown',
  summarise(walkFills([F(1, 'BUY', 2, 100), F(2, 'SELL', 2, 110, 20)]), 2, 110).holding === 0)

console.log(String.fromCharCode(10) + '-- candles, and the axis that fits them --')
t('candles are cut to the same window as the line', chart.includes('candles.slice(lo, hi)'))
// Fitting the axis to closes alone clips the very highs and lows a candle chart is for.
t('the range covers the wicks', chart.includes('...(candleWin ?? []).flatMap(c => [+c.h, +c.l])'))
t('a doji still draws', chart.includes('const hgt = Math.max(1, Math.abs(yC - yO))'))
t('the line is dropped when candles are on', chart.includes('if (!candleWin) {'))
t('comparing two markets stays a line', chart.includes('(candles && !comparing)'))
t('the app can switch between them', cli.includes("window.__repStyle") && cli.includes("_repStyle === 'candle'"))

console.log(String.fromCharCode(10) + '-- markers say what they were --')
t('the last few are labelled', cli.includes('k >= marks.length - 4'))
t('and the label carries side and size', cli.includes("`${m.buy ? 'BUY' : 'SELL'} $${fmtUSD(m.px * m.sz)}`"))
// Trades cluster; four labels on the same pixels is a smudge rather than four facts.
t('colliding labels step clear of each other', chart.includes('placed.some(q => Math.abs(q.x - x) < 52'))
t('and are dropped rather than run off the chart', chart.includes('if (ly > 8 && ly < height - 2 && tries < 4)'))
// +null is 0, and 0 is finite -- which drew every equity marker along the bottom edge.
t('a marker with no price sits on the line, not at zero', chart.includes('const hasV = mk.v != null && Number.isFinite(+mk.v)'))

console.log(String.fromCharCode(10) + '-- the controls agree with the player --')
t('slower gears exist', cli.includes('[0.25, 0.5, 1, 2, 4, 8]'))
t('1x is a readable five steps a second', cli.includes('Math.round(1000 / (5 * _repSpeed))'))
// Reported: the lit chip stayed on the old speed while playback changed.
t('the speed chips are built by a shared function', cli.includes('function _repSpeedChips()'))
t('and every frame repaints the chrome, so a lit chip cannot go stale',
  cli.includes('function _repChrome()') && (cli.match(/_repChrome\(\)/g) || []).length >= 3)
t('so is the style toggle', cli.includes('function _repStyleChips()'))

console.log(String.fromCharCode(10) + '-- picking what to replay --')
t('markets are a shortlist of five', cli.includes('[...all.slice(0, 5), _repCoin]'))
t('with a search for the rest', cli.includes('window.__repSearch'))
t('searching repaints only the chips', cli.includes('if (row) row.innerHTML = _repCoinChips()'))
t('and a background redraw gives the keyboard back', cli.includes("const _hadSearch = _a && _a.id === 'repSearch'"))
// The same three series Portfolio offers, from the same builder, so they cannot disagree.
t('the account offers equity, cumulative and realized', cli.includes("_portSeries('allTime', _repSeries)") &&
  cli.includes("['value', 'pnl', 'realized'].includes(s.series)"))
t('an account value never marks a position', cli.includes("_repMode === 'market' ? mark : null"))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
