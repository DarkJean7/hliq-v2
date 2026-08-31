// availableToTrade is COLLATERAL, not openable notional.
import fs from 'fs'
const grid = fs.readFileSync('strategies/grid.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

console.log('\n-- what the live API actually says --')
// Measured on 0x84Ce at 20x: availableToTrade 430.307977, maxTradeSzs 88.64, mark 97.091.
const availableToTrade = 430.307977, maxTradeSz = 88.64, mark = 97.091, lev = 20
t('maxTradeSzs x mark is the NOTIONAL', Math.abs(maxTradeSz * mark - 8605) < 5, String(maxTradeSz * mark))
t('and availableToTrade x leverage reproduces it', Math.abs(availableToTrade * lev - maxTradeSz * mark) < 15,
  String(availableToTrade * lev))
t('so availableToTrade is the MARGIN behind that notional, not the notional',
  Math.abs(availableToTrade - (maxTradeSz * mark) / lev) < 1)

console.log('\n-- the bug that produced "your capital $11.91" --')
// capital = availableToTrade / LEVERAGE is not margin and not notional; comparing it to a
// real margin requirement is out by the leverage factor.
const budget = (capitalLike, perOrder, levels) => {
  let b = capitalLike, placed = 0
  for (let i = 0; i < levels; i++) { if (b + 1e-9 < perOrder) break; b -= perOrder; placed++ }
  return placed
}
const perOrder = 194.40 / 20            // $9.72 of margin per level
t('the old basis placed almost nothing', budget(238.27 / 20, perOrder, 5) === 1)
t('the real margin places every level', budget(238.27, perOrder, 5) === 5)
t('and the requirement was never the problem', 5 * perOrder < 238.27)

console.log('\n-- the fix --')
t('a correctly-named margin figure exists', grid.includes('let freeMargin, capital, capSrc, marginAvail'))
t('it is availableToTrade itself in the unified branch', grid.includes('marginAvail = availNtl'))
t('and withdrawable + spot USDC in the legacy one', grid.includes('marginAvail = capital     //'))
t('the plan budgets entries against it', grid.includes('let _budget = marginAvail'))
t('reports it as the capital', grid.includes('capital: marginAvail'))
t('and decides "fits" with it', grid.includes('fits: requiredMargin <= marginAvail'))
t('the measurement is on the record so the comment cannot drift back',
  grid.includes('88.64 x 97.091 = $8,605') && grid.includes('430.31 x 20 = $8,606'))

console.log('\n-- live sizing is deliberately untouched --')
// capital x LEVERAGE cancels the division, so auto-size produces the same orders it did
// before. Changing that would resize every auto-sized grid, which is not a preview fix.
t('auto-size still uses `capital`, not marginAvail',
  grid.includes('ORDER_USD = Math.floor(capital * LEVERAGE * SIZE_PCT / buyLevelCnt * 100) / 100'))
t('capital is still availableToTrade / leverage in that branch',
  grid.includes('capital     = freeMargin') && grid.includes('freeMargin  = LEVERAGE > 0 ? availNtl / LEVERAGE : availNtl'))
t('so capital x leverage is exactly availableToTrade again',
  Math.abs((availableToTrade / lev) * lev - availableToTrade) < 1e-9)
t('the margin cap still divides by leverage, which is correct for margin',
  grid.includes('const requiredMargin = ORDER_USD * buyLevelCnt / LEVERAGE'))

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
console.log(String.fromCharCode(10) + '-- the half-gap clearance around the mark --')
// Measured: mark 96.9705, range 87.273-106.670, 10 levels -> gap 2.1552, half 1.0776.
// The nearest buy sits at 95.8940 and must be below 95.8929 to qualify: short by a tenth
// of a cent. That is not a coincidence - an auto range is mark +/-10% with an even level
// count, so the mark lands EXACTLY midway between the two middle levels and both start on
// the line.
const gMark = 96.9705, lo = 87.273, hi = 106.670, n = 10
const gap = (hi - lo) / (n - 1)
const eligible = (px) => px < gMark - gap / 2
t('the clearance is half a level', Math.abs(gap / 2 - 1.0776) < 0.001)
t('the nearest buy misses by under a cent', !eligible(95.8940) && (gMark - gap / 2) - 95.8940 < 0.01)
t('the next one down is comfortably in', eligible(93.7390))
t('and the mark really does land midway between the two middle levels',
  Math.abs((lo + 4 * gap + gap / 2) - gMark) < 0.01)

console.log(String.fromCharCode(10) + '-- so it is shown as waiting, not refused --')
t('the label says it waits on price', cli.includes("_T('waits for price'"))
t('it is flagged as a soon-to-place state', cli.includes('loud: false, soon: true'))
t('and is not struck through like a real refusal',
  cli.includes("const strike = live || why?.soon ? '' : ';text-decoration:line-through'"))
t('the counts add up: everything not placed now is held back',
  fs.readFileSync('strategies/grid.js', 'utf8').includes("o.blocked && o.blocked !== 'resting'"))
t('with its own tally', fs.readFileSync('strategies/grid.js', 'utf8').includes("nearMark:  orders.filter(o => o.blocked === 'near').length"))
t('the banner explains why the clearance exists', cli.includes('cannot flip between entry and exit on ordinary noise'))
t('and why an auto range always starts on that line', cli.includes('centres the mark exactly between two levels'))
t('a near-mark-only banner is not painted as an error', cli.includes('const bad = short.length || inv.length'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
