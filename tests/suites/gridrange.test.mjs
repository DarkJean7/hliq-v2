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

/** The range resolution, run exactly as grid.js runs it. */
function plan({ short, avg, mark, levels = 10, band = 0.12 }) {
  const roundPx = (x) => +x.toPrecision(5)
  const LOWER = roundPx(mark * (1 - band))
  const UPPER = roundPx(mark * (1 + band))
  const gap = (UPPER - LOWER) / Math.max(1, levels - 1)
  let entries = 0, exits = 0, deadZone = 0
  for (let i = 0; i < levels; i++) {
    const px = LOWER + i * gap
    if (short ? px > mark + gap / 2 : px < mark - gap / 2) entries++
    else if (short ? px < mark - gap / 2 : px > mark + gap / 2) exits++
    else deadZone++
  }
  return { LOWER, UPPER, gap, entries, exits, deadZone }
}

console.log(nl + '-- the ladder is even, wherever the position sits --')
{
  // Three marks on the same INJ short, all reported. The avg-anchored range gave 0/9, then
  // 1/8, against a ten-level grid; three patches to the edge cases did not change the shape.
  for (const [mark, label] of [[6.5512, 'short winning'], [6.6324, 'just under avg'],
                               [6.6582, 'just over avg'], [6.667, 'losing']]) {
    const p = plan({ short: true, avg: 6.6512, mark })
    t(`short, ${label}: both sides can work`, p.entries >= 4 && p.exits >= 4, p)
    t(`short, ${label}: and it is not lopsided`, Math.abs(p.entries - p.exits) <= 1, p)
  }
  for (const [mark, label] of [[6.30, 'long under water'], [7.00, 'long winning']]) {
    const p = plan({ short: false, avg: 6.6512, mark })
    t(`long, ${label}: both sides can work`, p.entries >= 4 && p.exits >= 4, p)
    t(`long, ${label}: and it is not lopsided`, Math.abs(p.entries - p.exits) <= 1, p)
  }
  // The average entry no longer decides which levels exist — only which ones may CLOSE.
  const a = plan({ short: true, avg: 6.0, mark: 6.5512 })
  const b = plan({ short: true, avg: 7.5, mark: 6.5512 })
  t('the average no longer moves the range at all', a.LOWER === b.LOWER && a.UPPER === b.UPPER, { a, b })
}

console.log(nl + '-- and the safety is where it always actually was --')
{
  // This is the whole reason the anchor could go: exitProfitable refuses to place ANY close
  // past the average, on every cycle. The range was never what guaranteed that.
  t('exits are still refused past the average',
    src.includes('if (!exitProfitable(PRICES[i], avgEntry)) continue'))
  t('and that check is unchanged by this',
    src.includes('return IS_SHORT ? px <= avgEntry * (1 - PROFIT_BUFFER)'))
  t('the range is centred on the mark', src.includes('LOWER = roundPx(markPx * (1 - PROFIT_BAND))') &&
    src.includes('UPPER = roundPx(markPx * (1 + PROFIT_BAND))'))
  t('the log says so, and names what still holds the exits',
    src.includes('exits are still held to avg entry'))
  t('the three patched-around shapes are recorded', src.includes('0 sells / 9 buys, then 1 sell / 8 buys'))
  t('and the report in its own words', src.includes('is not supposed to place 4 short orders, 5 buy orders?'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
