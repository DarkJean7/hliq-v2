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
t('the chart is cut at the current frame', cli.includes('to: i + 1,'))
t('and the reason is recorded', cli.includes('the replay cannot hint at where it is going'))
t('markers are only those that have landed', cli.includes('markersUpto(d.steps, t)'))
t('a price marker sits at the fill price, an equity one on the line',
  cli.includes("v: _repMode === 'market' ? m.px : null"))

console.log(String.fromCharCode(10) + '-- both modes, and a way in --')
t('market and account modes exist', cli.includes("window.__repSetMode") && cli.includes("_repMode === 'account'"))
// Recomputing account value from fills would miss deposits, funding and everything else.
t('account mode plays the portfolio history, not a reconstruction', cli.includes("accountValueHistory"))
t('market mode offers only markets actually traded', cli.includes('function _repCoins()'))
t('it is reached from the portfolio chart, beside Markers and Advanced',
  cli.includes('window.__openReplay()') && cli.includes('▶ Replay'))
t('on both shells, from one opener', cli.includes('window.__openReplay = function()') &&
  cli.includes("if (_isMobView()) { window.__mobMoreTab('replay'); return }"))
// The button sits on the portfolio chart, so pressing it means "replay THIS". A saved
// mode of 'market' was winning over that and landing people on a market picker.
t('the button opens on the account whatever was last chosen',
  cli.slice(cli.indexOf('window.__openReplay = function()')).slice(0, 200).includes("_repMode = 'account'"))
t('and rewinds, so it starts at the beginning',
  cli.slice(cli.indexOf('window.__openReplay = function()')).slice(0, 200).includes('_repReset()'))
t('and is no longer a More-list destination', !htm.includes("window.__mobMoreTab('replay')"))
t('but the view itself is still a full page', /_MOBV_FULLPAGE = new Set\(\[[^\]]*'replay'/.test(cli))
t('desktop has the tab and a pane', htm.includes('id="tab-replay"') && htm.includes('id="deskReplay"') &&
  cli.includes("if (name === 'replay')     _repRender(_viewHost('deskReplay'))"))

console.log(String.fromCharCode(10) + '-- the player behaves --')
t('play, pause, seek, restart and speed all exist',
  ['__repPlay', '__repSeek', '__repRestart', '__repSpeed'].every(k => cli.includes(k)))
t('pressing play at the end starts over', cli.includes('if (_repFrame >= n - 1) _repFrame = 0'))
t('only the stage repaints per frame, never the view', cli.includes('function _repPaint()') &&
  cli.includes("el.innerHTML = _repStageHtml()"))
// A timer against a detached stage keeps waking the page for a screen nobody is on.
t('leaving stops the clock', (cli.match(/_repStop\(\)/g) || []).length >= 3 &&
  cli.includes("if (name !== 'replay') _repLeave()"))
t('a new subject rewinds rather than keeping a stale frame', cli.includes('function _repReset()'))
// Candles in flight are UNKNOWN, not absent -- the mistake this app has shipped three times.
t('loading is not reported as "no history"', cli.includes("_T('Loading market history…', 'Cargando historial…')"))
t('the transport tracks the frame, not just the render', cli.includes('pos.textContent = n ?'))

console.log(String.fromCharCode(10) + '-- the ledger row --')
const led = summarise(steps, 4, 130)
t('bought and sold carry token amounts as well as dollars',
  led.boughtSz === 4 && led.soldSz === 5, [led.boughtSz, led.soldSz])
t('and the view leads with the tokens', cli.includes("stat(_T('Bought', 'Comprado'), tok(s.boughtSz), 'var(--green)', money(s.bought))"))
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
t('the last few are labelled', cli.includes("k < marks.length - 4 ? ''"))
t('and no longer states the notional, which was never the question',
  !cli.includes('$${fmtUSD(m.px * m.sz)}'))
// Trades cluster; four labels on the same pixels is a smudge rather than four facts.
t('colliding labels step clear of each other', chart.includes('placed.some(q => Math.abs(q.x - x) < 52'))
t('and are dropped rather than run off the chart', chart.includes('if (ly > 8 && ly < plotH - 2 && tries < 4)'))
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

console.log(String.fromCharCode(10) + '-- a window that slides rather than grows --')
// Growing from the first frame squeezes every candle thinner as it plays, so the chart is
// least readable exactly when there is most to see.
t('a fixed number of candles stays on screen', cli.includes('const REP_SPAN = 64'))
t('the window ends at the playhead and starts a span back',
  cli.includes('from: Math.max(0, i + 1 - span), to: i + 1,'))
t('and never runs past it', !cli.includes('to: i + 2') && cli.includes('to: i + 1,'))
t('the expanded chart shows more of the same', cli.includes('const span = big ? Math.round(REP_SPAN * 1.6) : REP_SPAN'))

console.log(String.fromCharCode(10) + '-- a marker says what the trade made --')
// Notional says how much was moved, which is not what a replay is watched to answer.
t('a close is labelled with its realised PnL', cli.includes("`${m.net >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(m.net))}`"))
t('an open has no PnL to state, so it says which way it went',
  cli.includes("(m.buy ? _T('BUY', 'COMPRA') : _T('SELL', 'VENTA'))"))
t('and the marker carries the netted figure', fs.readFileSync('src/replay.js', 'utf8').includes('net: s.closedPnl - s.fee'))

console.log(String.fromCharCode(10) + '-- the chart opens --')
t('there is a way to open it', cli.includes('window.__repExpand'))
t('it is the same stage at a larger size', cli.includes('_repStageHtml(true)'))
t('and the same clock, not a second player', cli.includes("const btn2 = document.getElementById('repPlayBtn2')"))
// _repStop also runs when playback reaches the end; finishing must not close the chart
// you were watching it on.
t('finishing a replay does not close it', !/function _repStop\(\)[\s\S]{0,120}repFullSheet/.test(cli))
t('but leaving the view does', cli.includes('function _repLeave()') && cli.includes("if (name !== 'replay') _repLeave()"))

console.log(String.fromCharCode(10) + '-- the counter cannot exceed its own total --')
// Reported as 168/167: the frame is held across a rebuild, and a shorter series left the
// counter reading one past the end.
t('the displayed frame is clamped', cli.includes('`${Math.min(_repFrame + 1, n)}/${n}`'))

console.log(String.fromCharCode(10) + '-- a null mark is not a price of zero --')
// Reported: "PnL so far" read +$45,854 beside a realised figure of +$1,981. Account mode
// passes mark = null precisely because an account VALUE cannot mark a position -- and
// +null is 0, which is finite, so unrealised became szi * (0 - entry): the whole position
// valued at nothing. On a short that is a large POSITIVE number.
const openShort = walkFills([F(1, 'BUY', 2, 100, 0, 0.1), F(2, 'SELL', 5, 110, 20, 0.1)])
const acct = summarise(openShort, 2, null)
t('with no mark there is no unrealised', acct.unrealized === 0)
t('so net is exactly realised', Math.abs(acct.net - acct.realized) < 1e-9, [acct.net, acct.realized])
t('and nothing is held at a price of nothing', acct.holding === 0)
t('a real mark still marks', Math.abs(summarise(openShort, 2, 120).unrealized - (-3 * (120 - 110))) < 1e-9)
t('and a genuine zero price is still honoured', summarise(openShort, 2, 0).unrealized !== 0)
t('the check asks whether a mark was given', fs.readFileSync('src/replay.js', 'utf8').includes('const hasMark = mark != null && Number.isFinite(+mark)'))

console.log(String.fromCharCode(10) + '-- volume, fees and funding, profit factor --')
const full = walkFills([F(1, 'BUY', 1, 100), F(2, 'SELL', 1, 110, 10), F(3, 'BUY', 1, 100), F(4, 'SELL', 1, 95, -5)])
const fs2 = summarise(full, 4, 95, [{ time: 2, usdc: -1.5 }, { time: 9, usdc: -99 }])
t('volume is everything moved, either way', fs2.volume === 405, fs2.volume)
t('funding counts only what has been paid by now', fs2.funding === -1.5, fs2.funding)
// Funding is charged on a position over time, so it cannot come from the fills at all.
t('funding not loaded is unknown, not zero', summarise(full, 4, 95).funding === null)
t('and the view dashes it rather than printing $0.00', cli.includes("_T('funding —', 'financ. —')"))
t('the app passes null when it has not loaded', cli.includes('Array.isArray(state.funding) ? state.funding : null'))
t('profit factor is gross won over gross lost', fs2.profitFactor === 2, fs2.profitFactor)
// A ratio with nothing underneath is not infinity, it is a question that cannot be answered.
t('nothing lost yet is unknown, not infinity', summarise(full, 2, 110).profitFactor === null)
t('it is netted of fees, like every other figure here',
  summarise(walkFills([F(1, 'BUY', 1, 100), F(2, 'SELL', 1, 110, 10, 20)]), 2, 110).profitFactor === 0)
t('all three are on screen', ['Volume', 'Fees', 'Profit factor'].every(k => cli.includes(`_T('${k}'`)))

console.log(String.fromCharCode(10) + '-- the expand control has its own space --')
// Floating it in the top-right corner put it on top of the PnL, which is the number the
// screen exists to show.
t('it is inline in the header, not floating over it', !cli.includes('position:absolute;top:8px;right:8px') &&
  cli.includes("${big ? '' : `<button onclick=\"window.__repExpand(true)\""))
t('and is hidden once the chart is already open', cli.includes("${big ? '' :"))

console.log(String.fromCharCode(10) + '-- the headline describes the chart --')
// Reported: it read +$897 then +$1,323 while the line fell. Both figures were correct and
// neither belonged there -- the headline came from the fills (realised, net of fees) while
// the chart drew the account mark-to-market PnL. Closing winners while open positions
// bleed lifts one and drops the other, so they genuinely diverge. Portfolio said +$531.87,
// the replay's own axis said $531.87, and the headline said +$1,981.35.
t('account mode reads the series at the playhead, not the fills',
  cli.includes("_repSeries === 'value'") && cli.includes('{ value: signed(mark), tone: tone(mark),'))
t('and never s.net, which is a different measure', !/color:\$\{tone\(s\.net\)\}[\s\S]{0,80}signed\(s\.net\)/.test(cli))
t('market mode keeps realised plus open, which is what its chart means',
  cli.includes("? { value: signed(s.net), tone: tone(s.net), label: _T('PnL so far'"))
t('each series is labelled for what it is', cli.includes("_T('Account value', 'Valor de la cuenta')") &&
  cli.includes("_T('Acc. PnL so far'") && cli.includes("_T('Realized so far'"))
// An account value is a balance, not a profit; calling it "PnL so far" would be a lie.
t('equity is not called a PnL', cli.includes("{ value: money(mark), tone: 'var(--fg)', label: _T('Account value'"))

console.log(String.fromCharCode(10) + '-- a minus sign belongs outside the dollars --')
// An account PnL chart spends half its life below zero, and every axis label read
// "$-2,148.07".
t('the chart formatter signs before the symbol',
  cli.includes("fmtPrice: (v) => (v < 0 ? '-$' : '$') + fmtUSD(Math.abs(v)),"))
t('as does the stat formatter', cli.includes("const money = (v) => (v < 0 ? '-$' : '$') + fmtUSD(Math.abs(v))"))

console.log(String.fromCharCode(10) + '-- it loads on its own --')
// Reported: the chart sat on "Loading market history" until you switched to My account and
// back. The candle fetch told only Pulse it had finished, so nothing repainted the player.
t('the fetch tells the replay too', cli.includes("if (_viewOpen('replay')) _repCandlesArrived()"))
t('which rebuilds the series and repaints', cli.includes('function _repCandlesArrived()') &&
  cli.includes('_repData = _repBuild()'))
// The frame count only exists once the data does.
t('and moves the scrub range with it', cli.includes("for (const id of ['repScrub', 'repScrub2'])"))
t('without a full render, which would take the keyboard away',
  !/function _repCandlesArrived\(\)[\s\S]{0,400}_repRender\(/.test(cli))
t('and does nothing when the player is not on screen', cli.includes("if (!document.getElementById('repStage')) return"))

console.log(String.fromCharCode(10) + '-- candles for the account, honestly derived --')
// A market has real OHLC from the exchange. An account has a SAMPLED VALUE, and there is
// no open, high or low hiding inside one sample -- so they are grouped, and each group
// reports the range the account actually reached.
t('account candles are grouped from samples', cli.includes('function _repAcctCandles(points, target = 80)'))
t('open and close come from the ends of a group',
  cli.includes('candles.push({ t, o: vs[0], c: vs[vs.length - 1], h: Math.max(...vs), l: Math.min(...vs) })'))
t('the line is the candle closes, so the two views cannot drift',
  cli.includes('line.push([t, vs[vs.length - 1]])') && cli.includes('points: grouped ? grouped.points : points,'))
t('too little history falls back to the line', cli.includes('return candles.length >= 3 ? { candles, points: line } : null'))
t('grouping happens only in candle mode, so the line keeps every sample',
  cli.includes("const grouped = _repStyle === 'candle' ? _repAcctCandles(points) : null"))
t('and the toggle is offered in both modes', !cli.includes("if (_repMode !== 'market') return ''"))
t('candles no longer require market mode', cli.includes("const useCandles = _repStyle === 'candle' && !!d.candles"))
// Grouping changes the frame count, so an index would land somewhere else entirely.
t('switching style holds the position in time, not in frames',
  cli.includes('const at = _repData?.points?.[_repFrame]?.[0] ?? null') &&
  cli.includes('for (let i = 0; i < pts.length; i++) if (+pts[i][0] <= at) best = i'))

console.log(String.fromCharCode(10) + '-- and a way back --')
// The header close drops to the home screen, which is not where you came from.
t('there is a back button', cli.includes('window.__replayBack') && cli.includes("← ${_T('Portfolio', 'Cartera')}"))
t('it returns to the portfolio, where Replay is opened from',
  cli.includes("if (_isMobView()) { window.__mobMoreTab('portfolio'); return }"))
t('and stops the player on the way out', cli.includes('window.__replayBack = function() {') &&
  cli.slice(cli.indexOf('window.__replayBack')).slice(0, 120).includes('_repLeave()'))

console.log(String.fromCharCode(10) + '-- it reads like a chart --')
// A price axis, dates, and the line every other price is judged against.
t('the plot gives up a strip for each axis', chart.includes('const AX_W = axis ? 42 : 0') &&
  chart.includes('const AX_H = axis ? 13 : 0'))
t('and the scales use what is left', chart.includes('const plotH = height - AX_H') &&
  chart.includes('(plotW - PAD * 2)'))
t('five price ticks down the right', chart.includes('for (let g = 0; g <= 4; g++)'))
// More would crowd a phone; fewer leaves the span unreadable, which is what the axis is for.
t('three dates along the bottom', chart.includes("[[0, 'start'], [0.5, 'middle'], [1, 'end']]"))
// toLocaleDateString with hour options prints the whole date AND the time.
t('a short span shows times, not a full datetime', chart.includes('new Date(t).toLocaleTimeString(undefined, { hour:'))
// "$78,240.00" does not fit a 42px gutter and spilled back over the candles.
t('the axis can take a compact formatter', chart.includes('(fmtAxis ?? fmtPrice)') &&
  cli.includes('fmtAxis:') && cli.includes('fmtCompact(Math.abs(v))'))

console.log(String.fromCharCode(10) + '-- the entry line --')
t('the open position gets a line and a tag', chart.includes("stroke=\"var(--orange,#f59e0b)\" stroke-width=\"0.9\" stroke-dasharray=\"3 3\""))
t('drawn only when it is actually in view', chart.includes('if (ey >= y0 && ey <= y1)'))
t('and never on a percent chart, where a price means nothing',
  chart.includes('if (entry != null && Number.isFinite(+entry) && !comparing)'))
t('the app passes the entry only while a position is open',
  cli.includes("entry: _repMode === 'market' && s.szi !== 0 ? s.entry : null,"))

console.log(String.fromCharCode(10) + '-- markers and the strip --')
// A triangle points at a price from beside it, which becomes a hedge of arrows when trades
// cluster; a dot sits on the price it happened at.
t('trades are dots here', chart.includes('if (dotMarkers)') && cli.includes('dotMarkers: true,'))
t('but Signals keeps its triangles', chart.includes('const tri = mk.buy ?'))
t('a strip says what is on screen before you read it',
  cli.includes('const metaBits = ') && cli.includes("_T('PERP', 'PERP')") && cli.includes("' SPAN'") === false)
t('including the span, in whole days or hours', cli.includes("spanMs >= 86400e3 ? Math.round(spanMs / 86400e3) + 'D SPAN'"))
t('and the position, when there is one', cli.includes("s.szi !== 0 ? `${s.szi > 0 ? _T('LONG', 'LARGO')"))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
