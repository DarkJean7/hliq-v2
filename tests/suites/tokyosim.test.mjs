// Tokyo Partners in the Trade Simulator.
//
// The strategy never looks at price to decide — only at the hour, in New York. That is
// what makes it simulatable at all, and it is also the thing most easily got wrong: an
// off-by-one-hour window, or a UTC offset applied where a real timezone was meant, gives a
// perfectly plausible-looking result for a strategy nobody is running.
import fs from 'fs'
import { BT_STRATEGIES, BT_DEFAULTS, BT_FIELDS, BT_CHOICES, BT_TOKYO_TABLE, BT_TOKYO_ZONE,
         tokyoWindowsFor, tokyoMarkets, hhmmToMinutes, inWindow, signals, normalise,
         runBacktest, coerceParams } from '../../src/backtest.js'

const eng = fs.readFileSync('src/backtest.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- it is offered --')
t('the strategy is in the list', BT_STRATEGIES.some(s => s[0] === 'tokyo'))
t('with a description of what it actually does',
  (BT_STRATEGIES.find(s => s[0] === 'tokyo')?.[2] ?? '').length > 120)
t('which says it never reads price',
  /never looks at price/.test(BT_STRATEGIES.find(s => s[0] === 'tokyo')?.[2] ?? ''))

console.log(nl + '-- the portfolio table --')
t('all fifteen markets are in it', Object.keys(BT_TOKYO_TABLE).length === 15)
t('each has both windows and a weight',
  Object.values(BT_TOKYO_TABLE).every(r => r.long?.length === 2 && r.short?.length === 2 && r.weight > 0))

// The key is a bare ticker so a row can be found however it is typed. The exchange id is
// NOT the key: nine of these live on the xyz builder dex, where asking for candles for
// "SMSN" is a 500 and "xyz:SMSN" is the market. Loading the portfolio with the keys asked
// the API for nine markets that do not exist.
t('every row carries the id the exchange uses',
  Object.values(BT_TOKYO_TABLE).every(r => typeof r.market === 'string' && r.market))
t('the builder-dex rows carry their prefix',
  BT_TOKYO_TABLE.SMSN.market === 'xyz:SMSN' && BT_TOKYO_TABLE.SOXL.market === 'xyz:SOXL' &&
  BT_TOKYO_TABLE.SNDK.market === 'xyz:SNDK' && BT_TOKYO_TABLE.EWY.market === 'xyz:EWY')
t('the main-dex rows do not', BT_TOKYO_TABLE.ZEC.market === 'ZEC' && BT_TOKYO_TABLE.XMR.market === 'XMR')
t('nine of the fifteen are on a builder dex',
  Object.values(BT_TOKYO_TABLE).filter(r => r.market.includes(':')).length === 9)
t('tokyoMarkets returns those ids, not the keys',
  tokyoMarkets().includes('xyz:SMSN') && !tokyoMarkets().includes('SMSN'))
t('and all fifteen of them', tokyoMarkets().length === 15)
t('why the key is not the id is recorded',
  fs.readFileSync('src/backtest.js', 'utf8').includes('the bare ticker is not a market at all'))
t('every window is a real time',
  Object.values(BT_TOKYO_TABLE).every(r => [...r.long, ...r.short].every(w => Number.isFinite(hhmmToMinutes(w)))))
t('the weights add up to about 100', Math.abs(Object.values(BT_TOKYO_TABLE).reduce((a, r) => a + r.weight, 0) - 100) < 0.5)
t('a market is found by its bare ticker', tokyoWindowsFor('ZEC')?.long.join('-') === '07:00-21:00')
t('and through a builder-dex prefix', tokyoWindowsFor('xyz:SMSN')?.long.join('-') === '23:00-18:00')
t('a market not in it returns nothing, rather than a default',
  tokyoWindowsFor('DOGE') === null && tokyoWindowsFor('') === null)

console.log(nl + '-- reading the clock --')
t('a time parses', hhmmToMinutes('07:00') === 420 && hhmmToMinutes('23:59') === 1439)
t('midnight is zero, not a falsy accident', hhmmToMinutes('00:00') === 0)
t('an impossible time is rejected', !Number.isFinite(hhmmToMinutes('99:99')) && !Number.isFinite(hhmmToMinutes('24:00')))
t('so is junk', !Number.isFinite(hhmmToMinutes('7')) && !Number.isFinite(hhmmToMinutes('')) && !Number.isFinite(hhmmToMinutes(null)))

console.log(nl + '-- windows, including the ones that cross midnight --')
t('inside a normal window', inWindow(600, '07:00', '21:00'))
t('outside one', !inWindow(60, '07:00', '21:00'))
t('the opening minute is inside', inWindow(420, '07:00', '21:00'))
t('the closing minute is NOT — the position is already out', !inWindow(1260, '07:00', '21:00'))
t('a window that crosses midnight holds overnight', inWindow(120, '16:00', '06:00'))
t('and is closed in the middle of the day', !inWindow(600, '16:00', '06:00'))
t('a zero-width window is closed, not always open', !inWindow(600, '07:00', '07:00'))
t('a broken window is closed rather than assumed', !inWindow(600, 'nonsense', '21:00'))

console.log(nl + '-- the signal is the clock, and nothing else --')
// One synthetic day of hourly candles, timestamped at each UTC hour. ZEC's windows tile
// the whole day, so every candle must be one side or the other and none flat.
const day = Array.from({ length: 24 * 7 }, (_, i) => ({
  t: Date.UTC(2026, 5, 15) + i * 3600e3, o: 100, h: 101, l: 99, c: 100,
}))
const p = coerceParams({ strategy: 'tokyo', tokyoLongFrom: '07:00', tokyoLongTo: '21:00',
                         tokyoShortFrom: '21:00', tokyoShortTo: '07:00' })
const sig = signals(normalise(day), p)
t('every candle has a side', sig.every(s => s === 1 || s === -1))
t('both sides appear', sig.includes(1) && sig.includes(-1))
// June is EDT (UTC-4), so 07:00 NY is 11:00 UTC.
const at = (utcHour) => sig[utcHour]
t('11:00 UTC is long — 07:00 in New York', at(11) === 1)
t('10:00 UTC is still short', at(10) === -1)
t('01:00 UTC is short — 21:00 New York the day before', at(1) === -1)
t('the zone is a real timezone, not a fixed offset', BT_TOKYO_ZONE === 'America/New_York')
t('why that matters is recorded', eng.includes('applying them at a fixed UTC offset'))

// Overlapping windows: the bot goes flat rather than holding both.
const overlap = signals(normalise(day), coerceParams({ strategy: 'tokyo',
  tokyoLongFrom: '00:00', tokyoLongTo: '23:59', tokyoShortFrom: '00:00', tokyoShortTo: '23:59' }))
t('overlapping windows are flat, not both', overlap.every(s => s === 0))
t('why flat and not both is recorded', eng.includes('nets to nothing while'))

console.log(nl + '-- the walk --')
// Prices that rise all day: a long inside its window wins, a short inside its own loses.
const rising = Array.from({ length: 24 * 10 }, (_, i) => ({
  t: Date.UTC(2026, 5, 15) + i * 3600e3, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i,
}))
const r = runBacktest(rising, p)
t('it trades', r.tradesMade > 5, String(r.tradesMade))
t('roughly twice a day, one per window', Math.abs(r.tradesMade - 20) <= 3, String(r.tradesMade))
t('every trade names a side', r.trades.every(x => x.side === 'long' || x.side === 'short'))
t('longs win in a market that only rises',
  r.trades.filter(x => x.side === 'long' && x.outcome !== 'open').every(x => x.outcome === 'win'))
t('shorts lose in it',
  r.trades.filter(x => x.side === 'short' && x.outcome !== 'open').every(x => x.outcome === 'loss'))
t('a position open at the end is counted, not scored',
  r.trades.filter(x => x.outcome === 'open').length <= 1)
t('there is no target or stop level on a trade',
  r.trades.every(x => x.tp === null && x.sl === null))

// The deployed bot has no stop and does not refuse to close a loser -- that is the
// difference from the Trend bot, whose refusal is the thing that shapes its results.
t('the default is no stop', BT_DEFAULTS.tokyoStopPct === 0)
const walk = grab(eng, 'function runTokyoBot')
t('and it does not refuse to close a losing side', !walk.includes('losing) continue'))
t('why that differs from the Trend bot is recorded', eng.includes('does not refuse to close a loser'))
t('a stop can still be turned on', walk.includes('const stopFrac = Math.max(0, p.tokyoStopPct'))
t('and is checked against the candle extreme', walk.includes('rows[i].l <= stopPx : rows[i].h >= stopPx'))
const stopped = runBacktest(rising, coerceParams({ ...p, strategy: 'tokyo', tokyoStopPct: 0.5 }))
t('turning it on changes the result', stopped.tradesMade !== r.tradesMade || stopped.netPnl !== r.netPnl)

// Switching one side off is how a long-only version of the same table is tested.
const longOnly = runBacktest(rising, coerceParams({ ...p, strategy: 'tokyo',
  tokyoShortFrom: '00:00', tokyoShortTo: '00:00' }))
t('closing the short window halves the trades', longOnly.tradesMade < r.tradesMade, `${longOnly.tradesMade} vs ${r.tradesMade}`)
t('and leaves only longs', longOnly.trades.every(x => x.side === 'long'))

console.log(nl + '-- the form --')
t('the four windows are fields',
  ['tokyoLongFrom', 'tokyoLongTo', 'tokyoShortFrom', 'tokyoShortTo']
    .every(k => BT_FIELDS.some(f => f.key === k && f.strategy === 'tokyo')))
t('they render as times, not numbers',
  BT_FIELDS.filter(f => f.key.startsWith('tokyo') && f.key !== 'tokyoStopPct').every(f => f.type === 'time'))
t('the view honours that', cli.includes(`f.type === 'time'`) && cli.includes('type="time"'))
t('each explains itself', BT_FIELDS.filter(f => f.key.startsWith('tokyo')).every(f => (f.help ?? '').length > 80))
t('the stop field says the real bot has none',
  /has NO stop/.test(BT_FIELDS.find(f => f.key === 'tokyoStopPct')?.help ?? ''))
t('target and stop percentages are hidden for it',
  BT_FIELDS.filter(f => ['takeProfitPct', 'stopLossPct'].includes(f.key))
    .every(f => f.notFor?.includes('tokyo')))
t('so is the both-levels-in-one-candle question, which cannot arise',
  BT_CHOICES.find(c => c.key === 'ambiguous')?.notFor?.includes('tokyo'))

console.log(nl + '-- a time is not a number --')
// parseFloat('07:00') is 7 and parseFloat('99:99') is 99: a silently different window
// rather than a rejected one.
t('the numeric coercion skips time fields', eng.includes("if (f.type === 'time') continue"))
t('a valid time survives', coerceParams({ tokyoLongFrom: '04:30' }).tokyoLongFrom === '04:30')
t('an invalid one falls back to the default, not to a number',
  coerceParams({ tokyoLongFrom: '99:99' }).tokyoLongFrom === BT_DEFAULTS.tokyoLongFrom)
t('and neither does a bare number become a window',
  coerceParams({ tokyoLongTo: '7' }).tokyoLongTo === BT_DEFAULTS.tokyoLongTo)
t('why is recorded', eng.includes("parseFloat is happy to say '07:00' is 7"))

console.log(nl + '-- the market decides the windows --')
t('choosing the strategy loads them', grab(cli, 'window.__simSetStrategy = function').includes('_simTokyoPrefill()'))
t('so does changing the market', cli.includes('window.__simCoinChanged = function'))
t('but only on a committed change, not every keystroke', cli.includes('onchange="window.__simCoinChanged()"'))
t('the prefill never runs on a plain render',
  grab(cli, 'function _simTokyoPrefill').includes('return false') &&
  cli.includes('would overwrite windows the user had just typed'))
// One market with no table row says nothing: the windows are on screen and editable, so
// there is nothing hidden. The note is for what the form CANNOT show -- several markets,
// where each runs its own row and any without one are skipped without appearing anywhere.
t('the note exists', cli.includes('function _simTokyoNote'))
t('a single market with no row is not nagged about',
  /nothing to say[\s\S]*return ''\s*\}/.test(grab(cli, 'function _simTokyoNote')))
t('why silence is right there is recorded', cli.includes('nothing hidden to warn about'))
t('but several markets still warn about the ones being skipped',
  grab(cli, 'function _simTokyoNote').includes('will be skipped'))
t('a daily candle cannot express an hourly rule, so the interval is moved',
  grab(cli, 'window.__simSetStrategy = function').includes("['4h', '1d'].includes(_simIv)"))
t('and that is explained', cli.includes('one candle would span most of a window'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
