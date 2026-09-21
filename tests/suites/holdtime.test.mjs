// Average hold time on the leaderboard track record.
//
// "In the little space under avg win/loss include avg held time." A hold is one position's
// life, from the fill that opened it from flat to the fill that took it back to flat. These run
// the real module against fill sequences shaped like Hyperliquid's, including the cases that
// break a naive version: a wallet already holding something before the board's history starts,
// a flip straight from long to short, and the server's incremental refresh.
import fs from 'fs'
import { holdsStep, emptyHolds, trackRecord } from '../../src/trackrecord.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const M = 60_000, H = 3_600_000

// A Hyperliquid-shaped fill. startPosition is the SIGNED position before the fill.
let tid = 0
const fill = (coin, side, sz, startPosition, time) =>
  ({ coin, side, sz: String(sz), startPosition: startPosition == null ? undefined : String(startPosition), time, tid: ++tid })
const avg = (st) => st.n ? st.sum / st.n : null

console.log(nl + '-- one position, open to flat --')
{
  const st = holdsStep(null, [
    fill('BTC', 'B', 1, 0, 0),
    fill('BTC', 'A', 1, 1, 30 * M),
  ])
  t('one hold of thirty minutes', st.n === 1 && st.sum === 30 * M, st)
  t('nothing left open', Object.keys(st.open).length === 0)
}

console.log(nl + '-- adding and trimming are the same hold --')
{
  // Opened, added to twice, trimmed, then closed: one position, one hold, 4h long.
  const st = holdsStep(null, [
    fill('ETH', 'B', 1,   0,   0),
    fill('ETH', 'B', 2,   1,   1 * H),
    fill('ETH', 'B', 1,   3,   2 * H),
    fill('ETH', 'A', 2,   4,   3 * H),
    fill('ETH', 'A', 2,   2,   4 * H),
  ])
  t('scaling in and out does not start new holds', st.n === 1 && st.sum === 4 * H, st)
}

console.log(nl + '-- a flip closes one hold and opens the next --')
{
  const st = holdsStep(null, [
    fill('SOL', 'A', 5,  0,  0),          // short 5
    fill('SOL', 'B', 8, -5,  1 * H),      // flips to long 3
    fill('SOL', 'A', 3,  3,  3 * H),      // flat
  ])
  t('two holds: 1h short, then 2h long', st.n === 2 && st.sum === 3 * H, st)
}

console.log(nl + '-- a position we never saw open is not guessed at --')
{
  // The board reads history from its genesis date. A wallet that was already long before then
  // has its first close in view but not its open. A running sum from 0 would call that close a
  // brand-new SHORT; startPosition says otherwise.
  const st = holdsStep(null, [
    fill('HYPE', 'A', 10, 10, 5 * H),     // closes a long opened before history
    fill('HYPE', 'B', 4,  0,  6 * H),     // a fresh one
    fill('HYPE', 'A', 4,  4,  6 * H + 20 * M),
  ])
  t('only the hold we saw both ends of counts', st.n === 1 && st.sum === 20 * M, st)
}

console.log(nl + '-- incremental equals all at once --')
{
  // The server folds new fills into last refresh's state. An open that spans two refreshes has
  // to survive between them.
  const all = [
    fill('BTC', 'B', 1, 0, 0), fill('BTC', 'A', 1, 1, 2 * H),
    fill('ETH', 'B', 1, 0, 3 * H), fill('ETH', 'A', 1, 1, 9 * H),
  ]
  const once = holdsStep(null, all)
  let inc = holdsStep(emptyHolds(), all.slice(0, 3))           // ETH is open at the cut
  t('the open survives the refresh', Number.isFinite(inc.open.ETH))
  inc = holdsStep(JSON.parse(JSON.stringify(inc)), all.slice(3)) // round-tripped like the stats file
  t('and the totals match', inc.n === once.n && inc.sum === once.sum, [inc, once])
  t('the average is (2h + 6h) / 2 = 4h', avg(once) === 4 * H)
}

console.log(nl + '-- what is not a perp hold --')
{
  const st = holdsStep(null, [
    fill('@107', 'B', 5, 0, 0), fill('@107', 'A', 5, 5, H),        // spot
    fill('PURR/USDC', 'B', 5, 0, 0), fill('PURR/USDC', 'A', 5, 5, H),
    fill('#2170', 'B', 5, 0, 0), fill('#2170', 'A', 5, 5, H),      // outcome
  ])
  t('spot and outcome fills are ignored', st.n === 0, st)
  const hip3 = holdsStep(null, [fill('xyz:TSLA', 'B', 1, 0, 0), fill('xyz:TSLA', 'A', 1, 1, H)])
  t('a HIP-3 perp counts', hip3.n === 1)
  // Decimal sizes that do not sum to exactly zero in binary floating point.
  const fl = holdsStep(null, [fill('BTC', 'B', 0.1, 0, 0), fill('BTC', 'B', 0.2, 0.1, M), fill('BTC', 'A', 0.3, 0.30000000000000004, 2 * M)])
  t('float dust still reads as flat', fl.n === 1 && fl.sum === 2 * M, fl)
}

console.log(nl + '-- fills without startPosition --')
{
  const broken = holdsStep({ open: { BTC: 0 }, sum: 0, n: 0 }, [fill('BTC', 'A', 1, null, H)])
  t('a fill that cannot be placed breaks the chain rather than inventing a hold', broken.n === 0 && !('BTC' in broken.open))
  const paper = holdsStep(null, [fill('BTC', 'B', 1, null, 0), fill('BTC', 'A', 1, null, 10 * M)], { assumeFlatStart: true })
  t('a history known to start flat can be summed instead', paper.n === 1 && paper.sum === 10 * M)
  t('app-parsed sides (BUY/SELL) work too', holdsStep(null, [fill('BTC', 'BUY', 1, 0, 0), fill('BTC', 'SELL', 1, 1, M)]).n === 1)
}

console.log(nl + '-- it reaches the card --')
{
  const tr = trackRecord({ windows: {}, holds: { sum: 8 * H, n: 2 } })
  t('the record carries the average', tr.avgHoldMs === 4 * H && tr.holdCount === 2)
  t('and null when nothing has been held start to finish', trackRecord({ windows: {} }).avgHoldMs === null)

  const main = fs.readFileSync('src/main.js', 'utf8')
  const srv  = fs.readFileSync('server.js', 'utf8')
  t('the card prints it under Avg win / loss', /Avg win \/ loss[\s\S]{0,700}tr\.avgHoldMs[\s\S]{0,200}fmtHeld\(tr\.avgHoldMs\)/.test(main))
  t('the server keeps hold state across refreshes', /if \(st\.holds\) holds = holdsStep\(st\.holds, fills\)/.test(srv))
  // A row cached before this shipped would otherwise average only the trades after it.
  t('and backfills a row that predates it', /await hlFillsSince\(addr, LB_GENESIS - 1\)/.test(srv))
  t('without serving the raw state', /\.map\(\(\{ lastFillTs, lastFundingTs, windows, holds,/.test(srv))
  t('client-built and paper rows measure it too', (main.match(/holds: holdsStep\(null, /g) ?? []).length === 2)
  t('fills keep startPosition through the parser', /startPosition: f\.startPosition \?\? null/.test(fs.readFileSync('src/format.js', 'utf8')))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
