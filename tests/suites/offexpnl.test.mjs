// "Count in balance" moves the PnL too, not just the balance.
//
// Asked for: "lets make that when this setting 'count in balance' is on it also recalculates
// the net pnl, and all data that is based in the total amount of balance. i want to know my
// real total pnl, profit factor, etc."
//
// A holding priced live and bought for a known amount has a result — value minus cost — which
// is the same kind of number as the unrealized PnL on a spot token the account already counts.
// What it must NOT do is invent one: a holding with no price, or no cost basis, contributes
// nothing, because a missing basis read as zero books the whole holding as profit.
import fs from 'fs'
import { holdingValue, holdingsTotal } from '../../src/offex.js'
import { trackRecord } from '../../src/trackrecord.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.01) => Math.abs(a - b) < e

console.log(nl + '-- a holding has a result only when both ends are known --')
{
  // The reported holdings: HYPE up, DIME down, and EAGLE with no cost basis recorded.
  const hype = holdingValue({ amount: 17.123, cost: 700 }, { price: 97.3845 })
  t('value minus cost', near(hype.usd, 1667.51, 0.01) && near(hype.pnl, 967.51, 0.01), hype)
  const dime = holdingValue({ amount: 1617.19, cost: 98.97 }, { price: 0.05941 })
  t('a loser is a loss', dime.pnl < 0 && near(dime.pnl, -2.89, 0.01), dime)
  t('no cost basis, no PnL — not a zero one', holdingValue({ amount: 5, cost: null }, { price: 2 }).pnl === null)
  t('no price, no PnL either', holdingValue({ amount: 5, cost: 1 }, null).pnl === null)
  t('and no value to add to the balance', holdingValue({ amount: 5, cost: 1 }, null).usd === null)
}

console.log(nl + '-- the total only counts what it can price --')
{
  // Quotes are keyed the way the app keys them — by network and address (src/offex.js).
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40)
  const list = [{ token: A, amount: 10, cost: 5 }, { token: B, amount: 10, cost: 5 }]
  const half = holdingsTotal(list, { [A]: { price: 1 } })
  t('a partial total says so', half.complete === false && half.priced === 1, half)
  t('and is the floor, not a guess', near(half.usd, 10))
}

console.log(nl + '-- loss held off-exchange counts like loss held open --')
{
  // The profit factor already counts loss sitting in open positions; a holding down 40% is the
  // same fact. Winners are not netted off against it — that is openLossOf's rule.
  const windows = { A_1: 100, B_1: -10 }
  const base = trackRecord({ windows, openLoss: 0 })
  const withOffex = trackRecord({ windows, openLoss: 40 })
  t('the closed figure is untouched', near(base.profitFactor, 10) && near(withOffex.profitFactor, 10))
  t('and the open one counts the held loss', near(withOffex.profitFactorOpen, 100 / 50), withOffex.profitFactorOpen)
  t('with the switch off there is nothing to count', base.profitFactorOpen === null)
}

console.log(nl + '-- wired in, and only while the switch is on --')
{
  const ui  = fs.readFileSync('src/offexui.js', 'utf8')
  const rnd = fs.readFileSync('src/render.js', 'utf8')
  const cli = fs.readFileSync('src/main.js', 'utf8')

  t('the module reports what the holdings made', /export function pnlTotal\(\)/.test(ui))
  t('a holding it cannot price or cost is skipped, and counted as unknown',
    /if \(v\.usd == null \|\| r\.entry\.cost == null\) \{ unknown\+\+; continue \}/.test(ui))
  t('only the losers make up the open loss', /if \(\(v\.pnl \?\? 0\) < 0\) loss -= v\.pnl/.test(ui))
  t('and nothing is counted unless the switch is on',
    /const on = countInBalance\(\)/.test(ui) && /counted: on \? pnl : 0, openLoss: on \? loss : 0/.test(ui))

  // Everything downstream of the account's unrealized PnL follows from this one line.
  t('the account\'s unrealized PnL includes it', /const unrealizedPnl = perpUnrealized \+ spotUnrealized \+ offexUnrealized/.test(rnd))
  t('so Net PnL and ROE do too, without a second formula',
    /const netPnl        = realizedPnl \+ unrealizedPnl \+ netFunding - totalFees/.test(rnd))
  t('the overview tiles carry it as well', /const unrealAll = totalUnrPnl \+ offexPnl/.test(rnd) &&
    /const netPnl = totalClosedPnl \+ unrealAll \+ allTimeFunding - totalFees/.test(rnd))
  t('and say when they are including it', /incl\. off-exchange/.test(rnd))
  // The combined view's PnL comes from the server, which knows nothing about these holdings.
  t('the combined figure has it added on the client', /_cp \? _cp\.net \+ _oxPnl : netPnl/.test(cli))
  t('the profit factor counts the loss held in them',
    /openLoss: openLossOf\(state\.perpState\?\.assetPositions \?\? \[\]\) \+ _offexOpenLoss\(\)/.test(cli))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
