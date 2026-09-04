// Per-trade drawdown: pairing fills into round trips, and the worst point of each.
//
// Realised PnL says where a trade finished. This says where it was at its worst, which the
// fill history cannot show on its own -- fills record the moments you acted, never the
// ground between them.
//
// The pairing is the half that goes quietly wrong: a flip through zero, a scale-in, a
// partial close. Every one of those produces a plausible-looking number if you get it
// wrong, so they are all driven here with hand-checked arithmetic.
import { pairTrades, maxAdverse, intervalFor, drawdownFor } from '../../src/drawdown.js'
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, eps = 1e-6) => Number.isFinite(a) && Math.abs(a - b) < eps

const fill = (coin, side, sz, px, time, extra = {}) =>
  ({ coin, side, sz, px, time, closedPnl: 0, fee: 0, ...extra })

console.log(nl + '-- a simple round trip --')
{
  const trips = pairTrades([
    fill('BTC', 'BUY', 1, 100, 1000),
    fill('BTC', 'SELL', 1, 120, 2000, { closedPnl: 20 }),
  ])
  t('one trade comes out', trips.length === 1, String(trips.length))
  const x = trips[0]
  t('it is a long', x.side === 'LONG', x.side)
  t('with the entry price', near(x.entryPx, 100), String(x.entryPx))
  t('the exit price', near(x.exitPx, 120), String(x.exitPx))
  t('both times', x.entryTime === 1000 && x.exitTime === 2000, [x.entryTime, x.exitTime].join())
  t('the size', near(x.size, 1), String(x.size))
  t('and the realised PnL it was given', near(x.closedPnl, 20), String(x.closedPnl))
  t('it is not still open', x.open === false)
}

console.log(nl + '-- a short --')
{
  const [x] = pairTrades([
    fill('ETH', 'SELL', 2, 200, 1000),
    fill('ETH', 'BUY', 2, 180, 2000, { closedPnl: 40 }),
  ])
  t('is recognised as a short', x.side === 'SHORT', x.side)
  t('with its entry', near(x.entryPx, 200), String(x.entryPx))
}

console.log(nl + '-- scaling in --')
{
  // 1 @ 100 and 3 @ 200 is 4 at a weighted 175, not at 100 and not at 150.
  const [x] = pairTrades([
    fill('BTC', 'BUY', 1, 100, 1000),
    fill('BTC', 'BUY', 3, 200, 1500),
    fill('BTC', 'SELL', 4, 210, 2000, { closedPnl: 140 }),
  ])
  t('entry is size-weighted, not the first tick', near(x.entryPx, 175), String(x.entryPx))
  t('size is the whole position', near(x.size, 4), String(x.size))
  t('and it starts at the FIRST fill', x.entryTime === 1000, String(x.entryTime))
  t('three fills are counted', x.fills === 3, String(x.fills))
}

console.log(nl + '-- scaling out keeps one trade until flat --')
{
  const trips = pairTrades([
    fill('BTC', 'BUY', 4, 100, 1000),
    fill('BTC', 'SELL', 1, 110, 1500, { closedPnl: 10 }),
    fill('BTC', 'SELL', 3, 120, 2000, { closedPnl: 60 }),
  ])
  t('a partial close does not end the trade', trips.length === 1, String(trips.length))
  t('it ends when the position reaches zero', trips[0].exitTime === 2000, String(trips[0].exitTime))
  t('and it carries the whole realised PnL', near(trips[0].closedPnl, 70), String(trips[0].closedPnl))
}

console.log(nl + '-- a flip through zero is two trades --')
{
  // Long 2, then sell 5: closes the long and opens a 3 short in one fill.
  const trips = pairTrades([
    fill('SOL', 'BUY', 2, 100, 1000),
    fill('SOL', 'SELL', 5, 90, 2000, { closedPnl: -20 }),
    fill('SOL', 'BUY', 3, 80, 3000, { closedPnl: 30 }),
  ])
  t('two trades come out of three fills', trips.length === 2, String(trips.length))
  const long = trips.find(x => x.side === 'LONG')
  const short = trips.find(x => x.side === 'SHORT')
  t('the long is closed at the flip', long && long.exitTime === 2000, String(long?.exitTime))
  t('the short opens at the same fill', short && short.entryTime === 2000, String(short?.entryTime))
  t('the short is sized by the remainder', near(short?.size, 3), String(short?.size))
  t('and priced at the fill that opened it', near(short?.entryPx, 90), String(short?.entryPx))
  t('the short closes later', short && short.exitTime === 3000, String(short?.exitTime))
}

console.log(nl + '-- markets do not bleed into each other --')
{
  const trips = pairTrades([
    fill('BTC', 'BUY', 1, 100, 1000),
    fill('ETH', 'BUY', 1, 50, 1100),
    fill('BTC', 'SELL', 1, 110, 2000),
    fill('ETH', 'SELL', 1, 40, 2100),
  ])
  t('one trade per market', trips.length === 2, String(trips.length))
  t('and each keeps its own prices',
    trips.every(x => (x.coin === 'BTC' && near(x.entryPx, 100)) || (x.coin === 'ETH' && near(x.entryPx, 50))),
    JSON.stringify(trips.map(x => [x.coin, x.entryPx])))
}

console.log(nl + '-- an open position is not a finished trade --')
{
  const [x] = pairTrades([fill('BTC', 'BUY', 1, 100, 1000)])
  t('it is reported as open', x.open === true)
  t('with no exit time', x.exitTime === null, String(x.exitTime))
  t('and no exit price', x.exitPx === null, String(x.exitPx))
}

console.log(nl + '-- fills that make no sense are skipped, not guessed at --')
{
  const trips = pairTrades([
    fill('BTC', 'BUY', 0, 100, 1000),
    fill('BTC', 'BUY', 1, NaN, 1100),
    { coin: null, side: 'BUY', sz: 1, px: 1, time: 1200 },
    fill('BTC', 'BUY', 1, 100, 1300),
  ])
  t('only the usable one survives', trips.length === 1 && near(trips[0].entryPx, 100),
    JSON.stringify(trips.map(x => x.entryPx)))
  t('and an empty list is fine', pairTrades([]).length === 0)
  t('as is nothing at all', pairTrades(null).length === 0)
}

console.log(nl + '-- the worst point of a trade --')
{
  const trip = { coin: 'BTC', side: 'LONG', size: 2, entryPx: 100, entryTime: 1000, exitTime: 5000 }
  const candles = [
    { t: 1000, h: 105, l: 98 },
    { t: 2000, h: 102, l: 80 },   // the worst
    { t: 3000, h: 130, l: 120 },
    { t: 5000, h: 140, l: 135 },
  ]
  const d = maxAdverse(trip, candles)
  t('a long is measured against the LOW', near(d.px, 80), String(d.px))
  t('the percentage is from the entry', near(d.pct, -20), String(d.pct))
  t('the dollars are at the size held', near(d.usd, -40), String(d.usd))
  t('and it says when', d.at === 2000, String(d.at))
}
{
  const trip = { coin: 'BTC', side: 'SHORT', size: 1, entryPx: 100, entryTime: 1000, exitTime: 5000 }
  const d = maxAdverse(trip, [{ t: 2000, h: 130, l: 90 }, { t: 3000, h: 110, l: 95 }])
  t('a short is measured against the HIGH', near(d.px, 130), String(d.px))
  t('and its loss is a rise', near(d.pct, -30) && near(d.usd, -30), [d.pct, d.usd].join())
}
{
  // A trade that never went against you has a drawdown of zero. That is an answer.
  const trip = { coin: 'BTC', side: 'LONG', size: 1, entryPx: 100, entryTime: 1000, exitTime: 3000 }
  const d = maxAdverse(trip, [{ t: 2000, h: 130, l: 101 }])
  t('a trade that never went red is zero, not null', d && near(d.pct, 0) && near(d.usd, 0),
    JSON.stringify(d))
}
{
  // Candles outside the trade's life must not count: the worst tick of the WEEK is not
  // the worst tick of a trade that lasted an hour.
  // Real timestamps: 1m bars, a trade lasting ten minutes, and a crash an hour earlier.
  const T = Date.UTC(2026, 0, 1, 12, 0)
  const M = 60_000
  const trip = { coin: 'BTC', side: 'LONG', size: 1, entryPx: 100, entryTime: T, exitTime: T + 10 * M }
  const d = maxAdverse(trip, [
    { t: T - 60 * M, h: 100, l: 10 },     // an hour before the trade
    { t: T - 59 * M, h: 100, l: 12 },
    { t: T + 2 * M,  h: 105, l: 95 },     // inside it
    { t: T + 40 * M, h: 100, l: 20 },     // long after it closed
  ])
  t('prices from outside the trade are ignored', near(d.px, 95), String(d.px))
  t('and the bar containing the entry still counts',
    near(maxAdverse(trip, [{ t: T - M, h: 100, l: 88 }, { t: T + M, h: 100, l: 99 }]).px, 88))
}

console.log(nl + '-- no path is not the same as no drawdown --')
t('no candles returns null', maxAdverse({ side: 'LONG', entryPx: 100, entryTime: 1, exitTime: 2 }, []) === null)
t('and so does a missing entry', maxAdverse({ side: 'LONG', entryPx: 0 }, [{ t: 1, h: 1, l: 1 }]) === null)
t('and no trade at all', maxAdverse(null, [{ t: 1, h: 1, l: 1 }]) === null)

console.log(nl + '-- the candle interval suits the window --')
t('a minutes-long trade gets 1m', intervalFor(30 * 60_000) === '1m')
t('a few hours gets 5m', intervalFor(10 * 3_600_000) === '5m')
t('a few days gets 1h', intervalFor(3 * 24 * 3_600_000) === '1h')
t('a month gets 4h', intervalFor(30 * 24 * 3_600_000) === '4h')
t('a year gets 1d', intervalFor(365 * 24 * 3_600_000) === '1d')

console.log(nl + '-- fetching is one trade at a time, and cached --')
{
  let calls = 0
  const fetcher = async () => { calls++; return [{ t: 1500, h: 100, l: 50 }] }
  const trip = { coin: 'BTC', side: 'LONG', size: 1, entryPx: 100, entryTime: 1000, exitTime: 2000 }
  const a = await drawdownFor(trip, fetcher)
  const b = await drawdownFor(trip, fetcher)
  t('it computes the drawdown', a && near(a.pct, -50), JSON.stringify(a))
  t('and the second read costs no request', calls === 1, String(calls))
  t('the cached answer is the same', b && near(b.pct, a.pct))
}
{
  // A failed fetch must not be cached as zero, or one rate-limited moment freezes a wrong
  // number in place for the session.
  let calls = 0
  const boom = async () => { calls++; throw new Error('rate limited') }
  const trip = { coin: 'ETH', side: 'LONG', size: 1, entryPx: 100, entryTime: 1000, exitTime: 2000 }
  t('a failed fetch returns null', (await drawdownFor(trip, boom)) === null)
  await drawdownFor(trip, boom)
  t('and is retried rather than cached', calls === 2, String(calls))
}

console.log(nl + '-- the reasoning is written down --')
const src = fs.readFileSync('src/drawdown.js', 'utf8')
t('why netting and not FIFO', src.includes('Netting, not FIFO lot matching'))
t('why the entry is weighted', src.includes('not against its first tick'))
t('why an open position has no drawdown', src.includes('reporting an unfinished number'))
t('why empty candles are null and not zero', src.includes('we did' + nl + ' * not look'))
t('why it fetches one at a time', src.includes('is how the limiter gets tripped'))
t('and that the usd figure is an approximation for a scaled position',
  src.includes('It is an approximation'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
