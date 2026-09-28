// What a deposit would buy you — src/liqdeposit.js.
//
// Asked for: "i have an account with a position close to liquidation. i was wondering how much
// capital i may need to deposit in the app to get a good liquidation price. this way an user
// can know if the deposit would be in vain or to protect the position."
//
// The arithmetic is checked against Hyperliquid's own liquidation formula rather than against
// itself: an account is built, its liquidation price computed from the formula with and
// without the deposit, and the module has to produce that same move from HL's reported liq
// price alone. If the two ever disagree, the module is wrong and not the test.
import fs from 'fs'
import {
  isCross, marginPerDollar, liqAfterDeposit, depositForLiq, depositForDistance,
  distancePct, previewRows, mostAtRisk, ladder,
} from '../../src/liqdeposit.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.01) => Math.abs(a - b) < e

/**
 * Hyperliquid's own formula, transcribed from their docs, as the reference:
 *   liq = price − side × margin_available / size / (1 − mf × side)
 * with margin_available = account value − maintenance margin required, for cross.
 */
const hlLiq = ({ isLong, size, mark, accountValue, maintMargin, maxLev }) => {
  const mf = 1 / (2 * maxLev)
  const side = isLong ? 1 : -1
  return mark - side * (accountValue - maintMargin) / size / (1 - mf * side)
}

console.log(nl + '-- the same line Hyperliquid draws --')
{
  // A long that is in trouble: 0.5 BTC at $60,000, $4,000 of account value behind it.
  const acct = { isLong: true, size: 0.5, mark: 60000, accountValue: 4000, maintMargin: 375, maxLev: 40 }
  const liq0 = hlLiq(acct)
  const liq1 = hlLiq({ ...acct, accountValue: acct.accountValue + 1000 })
  const mine = liqAfterDeposit({ isLong: true, size: 0.5, liq: liq0, maxLev: 40, deposit: 1000 })
  t('a $1,000 deposit moves it exactly where HL would put it', near(mine, liq1, 0.01), { mine, liq1 })
  t('and it moves DOWN for a long', mine < liq0)
  // The reader's question in reverse: it cost this much to get there.
  t('and the inverse costs exactly that', near(depositForLiq({ isLong: true, size: 0.5, liq: liq0, maxLev: 40, target: liq1 }), 1000, 0.01))

  const sh = { isLong: false, size: 2, mark: 3000, accountValue: 2000, maintMargin: 150, maxLev: 25 }
  const s0 = hlLiq(sh), s1 = hlLiq({ ...sh, accountValue: 2500 })
  t('a short agrees too', near(liqAfterDeposit({ isLong: false, size: 2, liq: s0, maxLev: 25, deposit: 500 }), s1, 0.01))
  t('and its liquidation moves UP', s1 > s0)
}

console.log(nl + '-- what a dollar is worth, per position --')
{
  // mf = 1/80 on a 40x market, so a long needs size × 0.9875 dollars per dollar of room.
  t('a big position needs more money to move', near(marginPerDollar({ isLong: true, size: 0.5, maxLev: 40 }), 0.49375, 1e-6))
  t('a short needs a touch more', near(marginPerDollar({ isLong: false, size: 0.5, maxLev: 40 }), 0.50625, 1e-6))
  // $10 of room on half a bitcoin is about $5 — the number that answers "is this in vain?".
  t('so ten dollars of room costs about five',
    near(depositForLiq({ isLong: true, size: 0.5, liq: 50000, maxLev: 40, target: 49990 }), 4.9375, 1e-4))
  t('a flat position has no slope to give', marginPerDollar({ isLong: true, size: 0, maxLev: 40 }) === null)
  t('and no projection either', liqAfterDeposit({ isLong: true, size: 0, liq: 100, maxLev: 40, deposit: 50 }) === null)
  t('nor does one with no liquidation price', liqAfterDeposit({ isLong: true, size: 1, liq: 0, maxLev: 40, deposit: 50 }) === null)
}

console.log(nl + '-- asked as a distance, which is how people ask it --')
{
  // A long at $100 wants liquidation 20% away, so at $80.
  const d = depositForDistance({ isLong: true, size: 10, liq: 95, maxLev: 20, mark: 100, pct: 20 })
  const after = liqAfterDeposit({ isLong: true, size: 10, liq: 95, maxLev: 20, deposit: d })
  t('the deposit lands it at the distance asked for', near(after, 80, 0.01), { d, after })
  t('which is 20% from the mark', near(distancePct(100, after), 20, 0.01))
  // Already further away than the target: the answer is that it costs nothing.
  t('a target already passed costs nothing', depositForDistance({ isLong: true, size: 10, liq: 70, maxLev: 20, mark: 100, pct: 20 }) < 0)
  t('distance needs both halves', distancePct(0, 10) === null && distancePct(100, null) === null)
}

console.log(nl + '-- a deposit does not reach an isolated position --')
{
  const pos = (coin, szi, liq, mark, type) => ({ position: {
    coin, szi: String(szi), entryPx: String(mark), liquidationPx: String(liq),
    positionValue: String(Math.abs(szi) * mark), maxLeverage: 20, leverage: { type, value: 10 },
  } })
  const rows = previewRows([
    pos('ETH', 10, 2700, 3000, 'cross'),
    pos('BTC', 0.1, 55000, 60000, 'isolated'),
  ], 1000)
  const eth = rows.find(r => r.coin === 'ETH'), btc = rows.find(r => r.coin === 'BTC')
  t('the cross one moves', eth.cross && eth.newLiq < eth.liq)
  // This is the answer the question came for: "would the deposit be in vain?"
  t('the isolated one does not', !btc.cross && btc.newLiq === btc.liq)
  t('and it is not given a made-up slope', btc.perDollar === null)
  t('isolated is read off the leverage type', isCross({ leverage: { type: 'cross' } }) && !isCross({ leverage: { type: 'isolated' } }))
  t('an unlabelled position is treated as cross, as HL does', isCross({}) && isCross(null) === true)
}

console.log(nl + '-- the whole book moves, closest to the edge first --')
{
  const pos = (coin, szi, liq, mark) => ({ position: {
    coin, szi: String(szi), entryPx: String(mark), liquidationPx: String(liq),
    positionValue: String(Math.abs(szi) * mark), maxLeverage: 20, leverage: { type: 'cross', value: 5 },
  } })
  const rows = previewRows([pos('SOL', 100, 120, 150), pos('ETH', 10, 2900, 3000), pos('BTC', 0.1, 30000, 60000)], 500)
  t('every cross position is projected, not just one', rows.every(r => r.newLiq != null))
  t('the one nearest liquidation is first', rows[0].coin === 'ETH', rows.map(r => r.coin))
  t('and the safest is last', rows.at(-1).coin === 'BTC', rows.map(r => r.coin))
  t('mostAtRisk agrees', mostAtRisk(rows).coin === 'ETH')
  t('a flat position is not a position', previewRows([pos('XRP', 0, 1, 2)]).length === 0)
  t('nothing at all is an empty book', previewRows(null).length === 0 && mostAtRisk([]) === null)
}

console.log(nl + '-- the ladder both ways --')
{
  const row = previewRows([{ position: {
    coin: 'ETH', szi: '10', entryPx: '3000', liquidationPx: '2900', positionValue: '30000',
    maxLeverage: 20, leverage: { type: 'cross', value: 5 },
  } }], 0)[0]
  const l = ladder(row)
  t('each step says where liquidation lands', l.steps.length === 5 && l.steps[0].liq < row.liq)
  t('and how far away that is', l.steps.every(s => s.dist > 0))
  t('a bigger deposit buys more room', l.steps[4].dist > l.steps[0].dist)
  t('each target says what it costs', l.targets.every(x => x.deposit > 0))
  t('and a nearer target costs less', l.targets[0].deposit < l.targets.at(-1).deposit)
  // 3.33% of room is already held, so 10%/20%/30%/50% all cost something; a target already
  // met is dropped rather than shown as a negative price.
  const safe = previewRows([{ position: {
    coin: 'ETH', szi: '10', entryPx: '3000', liquidationPx: '1000', positionValue: '30000',
    maxLeverage: 20, leverage: { type: 'cross', value: 5 },
  } }], 0)[0]
  t('a position already past every target offers none', ladder(safe).targets.length === 0)
  t('an isolated row has no ladder at all', ladder({ cross: false }).steps.length === 0)
}

console.log(nl + '-- built on the app\'s own maintenance fraction --')
{
  const src = fs.readFileSync('src/liqdeposit.js', 'utf8')
  t('it imports it rather than restating it', /import \{ maintFraction \} from '\.\/guardplan\.js'/.test(src))
  // The starting point is HL's own liquidation price. Rebuilding it from entry and margin
  // would disagree with the card above it at a $0 deposit, which is the habit this codebase
  // keeps paying for (src/mtmbridge.js, and a Net PnL that came out $420 short).
  t('and anchors on the exchange\'s own liq price', /liq: num\(p\.liquidationPx\)|const liq    = num\(p\.liquidationPx\)/.test(src))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
