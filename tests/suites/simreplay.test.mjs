// Watching a simulated run happen, and a market box that stays cleared.
//
// Three asks in one: "allow the user to clear the markets list (currently when i try it changes
// to default) and change default to just 'Hype' only, but allow lists. also add like a 'replay'
// mode similar as the one we have in portfolio tab, but instead this replay would simulate
// where we would have buy/sell in the assets charts."
//
// The replay's arithmetic is src/simreplay.js and is tested here for real. Its one rule is that
// nothing may appear before it happened: a replay whose chart already shows a trade still in
// the future is not a replay, it is a spoiler, and seeing the rule decide with only what it had
// is the entire point of watching one.
import fs from 'fs'
import { replayMarks, marksUpto, balanceAt, openAt, stateAt, openPnlAt } from '../../src/simreplay.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

// A resolved trade and an open one, in the shape backtest.js emits.
const win  = { i: 5,  time: 100, side: 'long',  entry: 10, exitAt: 200, exitPx: 11, outcome: 'win',  delta:  50 }
const loss = { i: 20, time: 300, side: 'short', entry: 20, exitAt: 400, exitPx: 21, outcome: 'loss', delta: -30 }
const open = { i: 40, time: 500, side: 'long',  entry: 30, outcome: 'open', delta: 0 }
const all  = [win, loss, open]

console.log(nl + '-- a round turn is two marks, not one --')
{
  const m = replayMarks([win])
  t('an entry and an exit', m.length === 2, m)
  t('the entry sits at the fill price', m[0].t === 100 && m[0].v === 10 && m[0].kind === 'entry')
  t('the exit sits at its own', m[1].t === 200 && m[1].v === 11 && m[1].kind === 'exit')
  // Marking both ends of a trade the same way draws two triangles pointing the same direction
  // for one round turn, which reads as two entries.
  t('a long opens with a buy and closes with a sell', m[0].buy === true && m[1].buy === false)
  const s = replayMarks([loss])
  t('and a short is the other way round', s[0].buy === false && s[1].buy === true)
  t('the exit carries what the trade made', s[1].delta === -30)
}
{
  // The data ran out while it was still open. Inventing an exit would report a close the rule
  // never made.
  const m = replayMarks([open])
  t('an unresolved trade has no exit mark', m.length === 1 && m[0].kind === 'entry')
  t('marks come out in time order',
    replayMarks(all).every((m, i, a) => i === 0 || a[i - 1].t <= m.t))
  t('junk is skipped rather than drawn at NaN',
    replayMarks([null, { time: 'x' }, win]).length === 2)
  t('nothing at all is not a crash', replayMarks().length === 0 && replayMarks(null).length === 0)
}

console.log(nl + '-- nothing appears before it happened --')
{
  const m = replayMarks(all)
  t('at the very start, nothing is on the chart', marksUpto(m, 0).length === 0)
  t('the first entry appears on its own candle', marksUpto(m, 100).length === 1)
  t('its exit is still the future one frame before', marksUpto(m, 199).length === 1)
  t('and lands on the frame it happened', marksUpto(m, 200).length === 2)
  t('by the end everything that happened is there', marksUpto(m, 9e9).length === 5)
}

console.log(nl + '-- the balance counts what is CLOSED, and only that --')
{
  t('before anything closes it is the starting balance', balanceAt(all, 150, 1000) === 1000)
  t('a closed win is added on its exit', balanceAt(all, 200, 1000) === 1050)
  t('a closed loss comes off', balanceAt(all, 400, 1000) === 1020)
  // The open trade's entry is at t=500 and its delta is 0, but the principle is what matters:
  // an unrealised profit is a price on a screen that can still go the other way, and counting
  // it would make the balance jump at the one moment nothing has been earned.
  t('an open trade contributes nothing', balanceAt(all, 9e9, 1000) === 1020)
  t('a trade that closes later is not counted early', balanceAt([win], 199, 1000) === 1000)
  t('no trades is just the start', balanceAt([], 9e9, 500) === 500)
}

console.log(nl + '-- what is in flight at the playhead --')
{
  t('nothing before the first entry', openAt(all, 50) === null)
  t('the first trade, once it opens', openAt(all, 150) === win)
  t('nothing again after it closes', openAt(all, 250) === null)
  t('the second one while it runs', openAt(all, 350) === loss)
  t('and the unresolved one stays open forever', openAt(all, 9e9) === open)
}

console.log(nl + '-- the running scoreboard --')
{
  const early = stateAt(all, 150, 1000)
  t('nothing has resolved yet', early.closed === 0 && early.won === 0 && early.lost === 0)
  // 0% would read as "it lost every time", which at frame one is a claim about a rule that has
  // not finished a trade yet.
  t('so the win rate is unknown, not zero', early.winRate === null)
  t('and the net is flat', early.netPnl === 0)
  const mid = stateAt(all, 250, 1000)
  t('one win in', mid.closed === 1 && mid.won === 1 && mid.winRate === 100 && mid.netPnl === 50)
  const late = stateAt(all, 9e9, 1000)
  t('both resolved trades counted', late.closed === 2 && late.won === 1 && late.lost === 1)
  t('the win rate is over the resolved ones', late.winRate === 50)
  t('and the open trade is reported alongside', late.open === open)
}

console.log(nl + '-- the open trade, marked to the revealed price --')
{
  // Long at 10, price 11: up 10%. Short at 20, price 21: down 5%.
  t('a long gains when price rises', openPnlAt(win, 11, 1000, 0.02) > 0)
  t('a short loses when price rises', openPnlAt(loss, 21, 1000, 0.02) < 0)
  t('a short gains when price falls', openPnlAt(loss, 19, 1000, 0.02) > 0)
  t('it scales with the stake', Math.abs(openPnlAt(win, 11, 1000, 0.02) - 2) < 1e-9)
  t('no trade means nothing to report', openPnlAt(null, 11, 1000, 0.02) === null)
  t('and neither does a missing price', openPnlAt(win, NaN, 1000, 0.02) === null)
}

console.log(nl + '-- the market box keeps what you put in it, including nothing --')
{
  // Reported: clearing it put the old list straight back.
  t('an empty box is collected as empty, not ignored',
    CLI.includes("if (el) _simCoin = String(el.value ?? '').trim()"))
  t('and an empty saved list is honoured on reload',
    CLI.includes("if (typeof s.coin === 'string') _simCoin = s.coin"))
  // The interval buttons re-rendered straight from state, which threw away an uncommitted edit
  // — clear the box, tap 4h, and the old list is painted back.
  t('changing the interval collects first, like every other control',
    CLI.includes('window.__simSetIv = function(v) { window.__simStructural(() => { _simIv = v }) }'))
  t('the default is one market', /let _simCoin = 'HYPE'/.test(CLI))
  t('but the box still takes a list', CLI.includes('.split(/[,\\s]+/)'))
  // "Not enough candle history" for an empty box sends someone looking for a data problem.
  t('running with nothing says so plainly', CLI.includes('Add at least one market to simulate'))
  // The body of __simRun is a try/catch with no finally, so a return from inside it would
  // leave _simBusy true and the panel stuck on "Running…" for the rest of the session.
  t('and that check runs BEFORE the busy flag goes up',
    CLI.indexOf('Add at least one market to simulate') < CLI.indexOf('_simBusy = true'))
  t('why is written down', CLI.includes('stuck on "Running…" forever'))
}

console.log(nl + '-- and the replay is wired to the run it describes --')
{
  t('the run keeps its candles, normalised as the backtest saw them',
    CLI.includes('const rows = normalise(bars.slice(-_simCount))') && CLI.includes('_simBars[coin] = rows'))
  t('a new run drops the old replay', CLI.includes('_simRepClose()           // a replay of the previous run means nothing now'))
  t('closing it clears the timer', CLI.includes('if (_simRepTimer) { clearInterval(_simRepTimer); _simRepTimer = null }'))
  // The window ends AT the playhead, so the axis only ever scales to what has been revealed.
  t('the chart never draws past the playhead', CLI.includes('from: i + 1 - SIM_REP_SPAN, to: i + 1'))
  t('and it draws candles, on an ordinal axis like the portfolio replay',
    /_simRepBodyHtml[\s\S]{0,2500}candles: rows,[\s\S]{0,400}ordinal: true/.test(CLI))
  t('markers come from the run, cut to the playhead',
    CLI.includes('const marks  = marksUpto(replayMarks(trades), t)'))
  // A portfolio run has one trade list with a coin on each row; a single-market run has no such
  // field, and filtering on it would draw an empty replay over a run that made forty trades.
  t('a one-market run is not filtered into nothing',
    CLI.includes("return all.some(t => t?.coin) ? all.filter(t => t.coin === coin) : all"))
  // 90ms a frame: re-rendering the whole tab that often would rebuild every input on screen.
  t('a frame repaints only the replay', CLI.includes("const el = document.getElementById('simReplayBody')"))
  t('including the counter beside the scrubber', CLI.includes("document.getElementById('simRepCount')"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
