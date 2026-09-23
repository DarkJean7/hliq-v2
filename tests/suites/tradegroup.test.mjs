// One order is one trade.
//
// Reported with two screenshots: an account that had opened ONE short on USELESS and closed it
// showed "14 trades · 0% win" in the Scoreboard header and "6 CLOSED · 0/6 WON" underneath.
// Hyperliquid fills one order in as many pieces as the book needs, and every one of those
// pieces was being counted as a trade. See src/tradegroup.js.
import fs from 'fs'
import { tradeKey, groupTrades, countTrades, closedTrades, tradeWindows } from '../../src/tradegroup.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

// The reported close, as HL reported it: one order, six pieces, one minute, one price band.
const CLOSE = [
  [0.32911, -3.01, 300], [0.32915, -3.22, 320], [0.32916, -4.95, 490],
  [0.32930, -3.26, 320], [0.32931, -3.26, 320], [0.32932, -1.83, 180],
].map(([px, pnl, sz], i) => ({
  oid: 77_001, tid: 900 + i, coin: 'USELESS', dir: 'Close Short', time: 1_758_557_000_000 + i,
  px, sz, closedPnl: pnl, fee: 0.03, notional: px * sz,
}))
const OPEN = Array.from({ length: 8 }, (_, i) => ({
  oid: 77_000, tid: 800 + i, coin: 'USELESS', dir: 'Open Short', time: 1_758_550_000_000 + i,
  px: 0.32921, sz: 149, closedPnl: 0, fee: 0.02, notional: 0.32921 * 149,
}))

console.log(nl + '-- the reported account --')
{
  const all = [...OPEN, ...CLOSE]
  t('fourteen fills', all.length === 14)
  t('are two trades', countTrades(all) === 2, countTrades(all))
  t('one of which closed something', closedTrades(all).length === 1, closedTrades(all).length)
  const g = closedTrades(all)[0]
  t('the close keeps the whole order\'s result', near(g.closedPnl, -19.53, 0.01), g.closedPnl)
  t('and all of its fees', near(g.fee, 0.18, 0.001), g.fee)
  t('it remembers how many pieces it took', g.fills === 6, g.fills)
  t('its price is the volume-weighted average', g.px > 0.32911 && g.px < 0.32932, g.px)
  t('and its size is the whole close', near(g.sz, 1930), g.sz)
  t('the win rate is measured over one trade, not six', Object.keys(tradeWindows(all)).length === 1)
  t('and that trade lost', Object.values(tradeWindows(all))[0] < 0)
}

console.log(nl + '-- what makes two fills one trade --')
{
  const f = (o) => ({ oid: o, coin: 'BTC', time: 1, px: 1, sz: 1, closedPnl: 1, fee: 0 })
  t('the order id', tradeKey(f(5)) === tradeKey(f(5)) && tradeKey(f(5)) !== tradeKey(f(6)))
  // oids repeat across wallets, so the account is part of the key.
  t('per account — oids repeat across wallets',
    tradeKey({ ...f(5), _acctAddr: '0xA' }) !== tradeKey({ ...f(5), _acctAddr: '0xB' }))
  // HL sends hash 0x0…0 for many fills; keying on it would merge unrelated orders.
  t('never the hash', !tradeKey({ ...f(5), hash: '0x0' }).includes('0x0'))
  t('no oid falls back to the trade id', tradeKey({ tid: 9, coin: 'BTC' }) !== tradeKey({ tid: 10, coin: 'BTC' }))
  t('and with neither, each fill stands alone',
    tradeKey({ coin: 'BTC', time: 1, px: 2 }) !== tradeKey({ coin: 'BTC', time: 2, px: 2 }))
}

console.log(nl + '-- two real trades stay two --')
{
  // The hour bucket this replaces merged these: same coin, same hour, two separate orders.
  const a = { oid: 1, coin: 'HYPE', dir: 'Close Long', time: 1000, px: 40, sz: 1, closedPnl: 5, fee: 0.1 }
  const b = { oid: 2, coin: 'HYPE', dir: 'Close Long', time: 1000 + 5 * 60_000, px: 41, sz: 1, closedPnl: -2, fee: 0.1 }
  t('two orders in the same hour are two trades', countTrades([a, b]) === 2)
  const w = Object.values(tradeWindows([a, b]))
  t('one won and one lost', w.filter(n => n > 0).length === 1 && w.filter(n => n < 0).length === 1, w)
  t('an opening order is a trade but never a closed one',
    countTrades([{ oid: 3, coin: 'HYPE', closedPnl: 0, time: 1, px: 1, sz: 1 }]) === 1 &&
    closedTrades([{ oid: 3, coin: 'HYPE', closedPnl: 0, time: 1, px: 1, sz: 1 }]).length === 0)
  t('nothing in, nothing out', countTrades([]) === 0 && countTrades(undefined) === 0 && groupTrades(null).length === 0)
  t('newest last', groupTrades([b, a]).map(g => g.oid).join() === '1,2')
}

console.log(nl + '-- every place that counts trades uses it --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8')
  const rnd = fs.readFileSync('src/render.js', 'utf8')
  t('the Scoreboard header', /\$\{s\.trades\} \$\{s\.trades === 1 \?/.test(cli))
  t('the per-coin stats', /trades: countTrades\(coinFills\)/.test(rnd))
  t('the closed-trade list is one row per order', /const closes = closedTrades\(fills \?\? \[\]\)/.test(cli))
  t('the win rate and track record on the account view', /const windows = tradeWindows\(fills\)/.test(cli))
  t('the per-wallet rows behind All Accounts', /const _windows = tradeWindows\(fills\)/.test(cli))
  t('the performance tab', /return \{ trades: countTrades\(fl\)/.test(cli))
  t('the paper board, so both boards measure the same thing', /const windows = tradeWindows\(closed\)/.test(cli))
  t('and the challenge payload', /trades:        countTrades\(closed\)/.test(cli))
  // The leaderboard posts what the client counted, so this is the whole of it.
  t('no hour buckets are left', !/_\{0,2\}windows\[.*Math\.floor\(\+?f\.time \/ (3600000|ONE_HOUR)\)/.test(cli), (cli.match(/Math\.floor\(\+?f\.time \/ (3600000|ONE_HOUR)\)/g) ?? []).slice(0, 3))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
