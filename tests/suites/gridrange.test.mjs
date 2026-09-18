// A grid with no entry levels is not a grid.
//
// Reported as: "why the grid bot is not working properly when an order is already placed."
// An INJ short, average entry $6.6512, mark $6.6582 — one tenth of one percent against it.
// The plan came back with ZERO sells, nine buys, and one rung parked in the dead zone. It
// could buy back the 5 INJ it held and then nothing, ever, unless price came back.
//
// The cause was the auto-range. With a position open it anchors the ENTRY end of the ladder
// to the average entry — a short's UPPER, a long's LOWER — so that every exit closes past
// that average. The moment the mark drifts the wrong side of it, the whole ladder is on the
// wrong side of the mark and no level can hold an entry.
//
// Both directions had it. The long was checked rather than assumed: mark $6.30 against an
// average of $6.6512 gave 0 entries and 10 exits, the same shape mirrored.
//
// The cap was never what kept exits safe — exitProfitable() refuses to close past the average
// on its own — so opening the entry end costs nothing there. What it does mean is the grid
// adds to a position currently going against it, which for a short is selling ABOVE its
// average and for a long is buying BELOW it: in both cases the average improves.
import fs from 'fs'

const src = fs.readFileSync('strategies/grid.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

/** The range resolution and the dead-grid check, run exactly as grid.js runs them. */
function plan({ short, avg, mark, levels = 10, band = 0.12 }) {
  const roundPx = (x) => +x.toPrecision(5)
  let UPPER, LOWER
  if (short) { UPPER = roundPx(avg); LOWER = roundPx(Math.min(avg, mark) * (1 - band)) }
  else       { LOWER = roundPx(avg); UPPER = roundPx(Math.max(avg, mark) * (1 + band)) }
  const anchored = short ? UPPER : LOWER
  // Dead = no level can hold an entry. NOT "the mark crossed the bound" — see the block below.
  const endGap = () => (UPPER - LOWER) / Math.max(1, levels - 1)
  const dead = () => short ? UPPER <= mark + endGap() * 0.5 : LOWER >= mark - endGap() * 0.5
  if (dead()) {
    if (short) UPPER = roundPx(Math.max(UPPER, mark * (1 + band)))
    else       LOWER = roundPx(Math.min(LOWER, mark * (1 - band)))
    for (let p = 0; p < 3; p++) {
      const g = (UPPER - LOWER) / Math.max(1, levels - 1)
      if (short ? UPPER > mark + g * 1.5 : LOWER < mark - g * 1.5) break
      if (short) UPPER = roundPx(mark + g * 2.5)
      else       LOWER = roundPx(mark - g * 2.5)
    }
  }
  const gap = (UPPER - LOWER) / Math.max(1, levels - 1)
  let entries = 0, exits = 0, deadZone = 0
  for (let i = 0; i < levels; i++) {
    const px = LOWER + i * gap
    if (short ? px > mark + gap / 2 : px < mark - gap / 2) entries++
    else if (short ? px < mark - gap / 2 : px > mark + gap / 2) exits++
    else deadZone++
  }
  return { LOWER, UPPER, gap, entries, exits, deadZone, opened: (short ? UPPER : LOWER) !== anchored }
}

console.log(nl + '-- the reported case --')
{
  // The numbers off the screenshot: 10 levels, $6.6512 average, $6.667 mark. Clearing the
  // dead zone alone gave 2 sells against 7 buys, and the report was "is not supposed to place
  // 4 short orders, 5 buy orders?" — correct: half the ladder should be able to open.
  const p = plan({ short: true, avg: 6.6512, mark: 6.667 })
  t('four sells, as expected', p.entries === 4, p)
  t('five buys', p.exits === 5, p.exits)
  t('and one rung in the dead zone', p.deadZone === 1, p.deadZone)
  t('the ladder is no longer lopsided', Math.abs(p.entries - p.exits) <= 1, p)
  t('the range was opened above the mark', p.UPPER > 6.667 && p.opened, p.UPPER)
  // The bottom is untouched: exits still close below the average, which is the whole point
  // of anchoring there.
  t('the bottom is still anchored under the average', p.LOWER < 6.6512, p.LOWER)
  // ~4.6 INJ a rung at these prices, so the short it can build is ~18 INJ on top of the 5
  // already held — the size the report expected, rather than the 9.7 the timid fix allowed.
  const ORDER_USD = 33.1
  let sz = 0
  for (let i = 0; i < 10; i++) { const px = p.LOWER + i * p.gap; if (px > 6.667 + p.gap / 2) sz += ORDER_USD / px }
  t('and it can build a real short, not a token one', sz > 15 && sz < 22, +sz.toFixed(1))
}

console.log(nl + '-- and the mark does not have to leave the range for it to be dead --')
{
  // The second miss, and the reason this took three passes. "Dead" was first written as
  // `mark >= UPPER`, which reads like the same thing and is not: at avg $6.6512 and mark
  // $6.6324 the mark was INSIDE the range, the check never fired, and the top level was still
  // $0.0255 short of clearing the dead zone. Zero sells, again, on a position in profit.
  const p = plan({ short: true, avg: 6.6512, mark: 6.6324 })
  t('a mark inside the range can still leave nothing placeable', p.opened, p)
  t('and it is opened up too', p.entries === 4, p)
  // The bound test would have said this grid was fine.
  t('the old bound test would have missed it', 6.6324 < 6.6512)
  t('the test is about levels, not bounds',
    src.includes('const _dead = () => IS_SHORT ? UPPER <= markPx + _endGap() * 0.5'))
  t('why, in the code', src.includes('not "the mark crossed the bound"'))
}

console.log(nl + '-- and the long, which had the same flaw mirrored --')
{
  const p = plan({ short: false, avg: 6.6512, mark: 6.30 })
  t('a long under water gets the same even split', p.entries === 4 && p.exits === 5, p)
  t('the range was opened below the mark', p.LOWER < 6.30 && p.opened, p.LOWER)
  t('the top is still anchored above the average', p.UPPER > 6.6512, p.UPPER)
}

console.log(nl + '-- a healthy grid is left exactly alone --')
{
  // This is the part that matters most: the fix must be invisible to a grid that was working.
  const s = plan({ short: true,  avg: 6.6512, mark: 6.30 })
  const l = plan({ short: false, avg: 6.6512, mark: 7.00 })
  t('a short whose mark is inside its range is untouched', !s.opened && s.entries === 3 && s.exits === 6, s)
  t('a long whose mark is inside its range is untouched',  !l.opened && l.entries === 3 && l.exits === 6, l)
  t('their bounds are the anchored ones', s.UPPER === 6.6512 && l.LOWER === 6.6512, { s: s.UPPER, l: l.LOWER })
}

console.log(nl + '-- however far it has run --')
{
  // Widening over a FIXED level count also widens the gap, so headroom measured with the old
  // gap buys barely one level. The loop is what makes this hold at any distance.
  for (const [label, args] of [
    ['short, mark under avg', { short: true,  avg: 6.6512, mark: 6.6324 }],
    ['short, 0.1% against', { short: true,  avg: 6.6512, mark: 6.6582 }],
    ['short, 20% against',  { short: true,  avg: 6.6512, mark: 8.00 }],
    ['short, 2x against',   { short: true,  avg: 6.6512, mark: 13.30 }],
    ['long, 5% against',    { short: false, avg: 6.6512, mark: 6.30 }],
    ['long, 25% against',   { short: false, avg: 6.6512, mark: 5.00 }],
    ['long, half',          { short: false, avg: 6.6512, mark: 3.33 }],
  ]) {
    const p = plan(args)
    t(label + ' still has entries', p.entries >= 2, p)
  }
}

console.log(nl + '-- it is the code that does this, not just this test --')
{
  // Was `markPx >= UPPER`. Restated: that tested the wrong thing, and the block above says why.
  t('the dead-grid check exists', src.includes('const _dead = () => IS_SHORT ? UPPER <= markPx + _endGap() * 0.5'))
  t('the entry side gets the same band, measured from the mark',
    src.includes('if (IS_SHORT) UPPER = roundPx(Math.max(UPPER, markPx * (1 + PROFIT_BAND)))') &&
    src.includes('else          LOWER = roundPx(Math.min(LOWER, markPx * (1 - PROFIT_BAND)))'))
  t('with a floor that clears the dead zone by a level and a half',
    src.includes('IS_SHORT ? UPPER > markPx + _gap * 1.5 : LOWER < markPx - _gap * 1.5'))
  t('and it iterates, because widening also widens the gap', src.includes('for (let _pass = 0; _pass < 3; _pass++)'))
  t('it only fires when the grid would otherwise be dead', src.includes('if (_dead()) {'))
  t('it says so in the log, naming the bound it moved', src.includes('is above the anchored top') && src.includes('is below the anchored bottom'))
  // The safety this looked like it was providing lives somewhere else, and still does.
  t('exits are still refused past the average, independently',
    src.includes('if (!exitProfitable(PRICES[i], avgEntry)) continue'))
  t('why the cap was not the safety is written down', src.includes('exitProfitable() refuses to close past the'))
  t('and the report is recorded in its own words',
    src.includes('is not supposed to place 4 short orders, 5 buy orders?'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
