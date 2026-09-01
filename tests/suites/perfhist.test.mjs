// The per-market trade history behind a Bot Performance card. The maths matters more than
// the markup here: this list is the explanation for a number shown elsewhere, so if the
// two disagree, one of them is lying about money.
import fs from 'fs'
import { collapseFills, summarise, historyHtml } from '../../src/perfhistory.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const F = (oid, time, side, sz, px, pnl, fee, tid = null) =>
  ({ oid, tid, time, timeStr: 'ts', coin: 'X', side, dir: side === 'BUY' ? 'Open Long' : 'Close Long',
     sz, px, closedPnl: pnl, fee })

console.log(String.fromCharCode(10) + '-- one order is one trade --')
// HL splits an order across fills. Six rows for one trade reads as six times the activity.
const split = [F(1, 100, 'BUY', 2, 10, 0, 0.1), F(1, 105, 'BUY', 2, 12, 0, 0.1), F(2, 200, 'SELL', 4, 15, 20, 0.2)]
let rows = collapseFills(split)
t('partial fills collapse by order id', rows.length === 2, rows.length)
t('sizes add up', rows.find(r => r.side === 'BUY').sz === 4)
t('price is size-weighted, not averaged', rows.find(r => r.side === 'BUY').px === 11)
t('fees add up', Math.abs(rows.find(r => r.side === 'BUY').fee - 0.2) < 1e-9)
t('the fill count survives for the badge', rows.find(r => r.side === 'BUY').n === 2)
t('an order is stamped when it started', rows.find(r => r.side === 'BUY').time === 100)

console.log(String.fromCharCode(10) + '-- fills without an order id stay separate --')
// hash comes back 0x0...0 for many HL fills, so tid is the fallback -- never hash, and
// never a shared constant, which would merge unrelated trades into one row.
const noOid = [F(null, 300, 'SELL', 1, 9, 3, 0.05, 'a'), F(null, 301, 'SELL', 1, 9, 4, 0.05, 'b')]
t('two id-less fills are two rows', collapseFills(noOid).length === 2)

console.log(String.fromCharCode(10) + '-- the totals are the card\'s totals --')
const s = summarise(rows)
t('realized is gross', s.realized === 20)
t('net is after fees', Math.abs(s.net - 19.6) < 1e-9, s.net)
t('fees are counted once, not per fill', Math.abs(s.fees - 0.4) < 1e-9, s.fees)
t('volume uses the weighted price', Math.abs(s.volume - (4 * 11 + 4 * 15)) < 1e-9, s.volume)
t('win rate counts closes only', s.closes === 1 && s.wins === 1)
t('newest first', rows[0].time > rows[1].time)

console.log(String.fromCharCode(10) + '-- the sheet says what happened --')
const fmt = { money: v => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2), size: v => String(v),
              price: v => '$' + v, t: (en) => en }
const html = historyHtml('X', split, ['Grid Bot'], fmt)
t('it names the bot that runs the market', html.includes('Grid Bot'))
t('it shows the net, not the gross', html.includes('$19.60'))
t('a multi-fill order says so', html.includes('2 fills'))
t('an entry shows a dash, not a break-even zero', html.includes('>—<'))
t('and it says fills were merged', html.includes('Partial fills of one order'))
t('an empty market says so instead of rendering nothing',
  historyHtml('X', [], [], fmt).includes('No trades recorded'))

console.log(String.fromCharCode(10) + '-- wired to both layouts --')
t('desktop cards open it', cli.includes(`<div class="perf-market-card" onclick="window.__perfCoinTrades('\${esc(c)}')"`))
t('mobile cards open it', cli.includes(`onclick="window.__perfCoinTrades('\${esc(c)}')" style="margin:0 4px 10px;cursor:pointer"`))
t('the handler reads the same fills the card is drawn from', cli.includes('const fills = _perfData?.fillsByCoin?.[c]'))
// Empty is not unknown: no entry means the data was never built, and a sheet claiming
// "no trades" would be a different statement from "we have not looked".
t('missing data opens nothing, empty data opens a sheet', cli.includes('if (!fills) return'))
t('it knows which bot runs the market', cli.includes('_perfLastBotStats = botStats'))

console.log(String.fromCharCode(10) + '-- Bot Performance is a full page --')
t('it is in the full-page set', /_MOBV_FULLPAGE = new Set\(\[[^\]]*'performance'/.test(cli))
t('so it gets the header with a way back', cli.includes("const _hd = _mobVFullHeader(_T('Bot Performance'"))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
