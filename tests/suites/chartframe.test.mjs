// How tall a chart should be — src/chartframe.js.
//
// Reported against the calendar's month chart: "i dont want the 0 to be in the middle unless
// is needed because the account have been down. in my case it havent." A September up $2,523
// and never red was drawn from −$5,000 to +$5,000, the line crawling along the top third.
//
// The cause was not the data. Chart.js's `maxTicksLimit` does not cap labels on a range: it
// picks a tick spacing coarse enough to fit that many, then grows the range out to a multiple
// of it. Three labels over $2,578 of data bought a $10,000 axis — asking for FEWER labels
// made the frame worse.
import fs from 'fs'
import { frameFor } from '../../src/chartframe.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.51) => Math.abs(a - b) < e
const pts = (...ys) => ys.map((y, i) => ({ x: i, y }))

console.log(nl + '-- a month that only went up --')
{
  // The reported one: a fifty-dollar wobble in the first hour, then $2,528 of profit.
  const f = frameFor(pts(0, -50, 900, 2528))
  t('zero is on the floor, not in the middle', f.min === 0, f)
  t('and the top is the month plus a margin', near(f.max, 2528 * 1.08, 5), f)
  // Which is the whole point: the line gets the whole card.
  t('so the line fills the frame', (2528 - 0) / (f.max - f.min) > 0.9, f)
}

console.log(nl + '-- a month that did go down --')
{
  const f = frameFor(pts(0, -800, 1200, 2000))
  t('zero is in frame with room under it', f.min < -800 && f.max > 2000, f)
  t('and it sits where the month put it, not at the middle',
    Math.abs((0 - f.min) / (f.max - f.min) - 0.5) > 0.1, (0 - f.min) / (f.max - f.min))
  const red = frameFor(pts(0, -300, -1500))
  t('a month that only lost has zero on the ceiling', red.max === 0 && red.min < -1500, red)
}

console.log(nl + '-- an account value is not read against zero --')
{
  // $9,800 to $10,300 is a 5% move. Framed from zero it is a flat line at the top of the
  // card; framed on itself it is the shape of the month, which is what the chart is for.
  const f = frameFor(pts(9800, 10050, 10300), { kind: 'value' })
  t('the frame hugs the data', f.min > 9000 && f.max < 11000, f)
  t('and does not reach for zero', f.min > 9700, f)
  t('with a little air at both ends', f.min < 9800 && f.max > 10300, f)
}

console.log(nl + '-- the awkward ones --')
{
  t('nothing to measure: null, not a made-up frame', frameFor([]) === null && frameFor(null) === null)
  const flat = frameFor(pts(500, 500, 500))
  t('a flat line still gets a frame with height', flat.max > flat.min, flat)
  const zero = frameFor(pts(0, 0))
  t('and so does a line of zeroes', zero.max > zero.min, zero)
  t('non-numbers are ignored', frameFor([{ x: 1, y: 10 }, { x: 2, y: NaN }, { x: 3, y: 20 }]).max > 20)
  // An outlier the reader cannot even see must not set the scale.
  const off = frameFor([{ x: 1, y: 100 }, { x: 2, y: 200 }, { x: 99, y: 99999 }], { xMin: 0, xMax: 10 })
  t('a point outside the window does not stretch the frame', off.max < 1000, off)
  t('unless the window leaves nothing to measure',
    frameFor([{ x: 99, y: 500 }], { xMin: 0, xMax: 10 }).max > 500)
}

console.log(nl + '-- wired in --')
{
  const cht = fs.readFileSync('src/charts.js', 'utf8')
  t('the chart asks for the frame', /const frame = frameFor\(data, \{ kind, xMin, xMax \}\)/.test(cht))
  // Both paths: switching Value → Accum. reuses the canvas, and a frame left over from
  // $6,000 of account value cannot hold $560 of PnL.
  t('on a redraw as well as on a new chart',
    /if \(frame\) Object\.assign\(ch\.options\.scales\.y, \{ min: yMin, max: yMax \}\)/.test(cht) &&
    /if \(frame\) \{ options\.scales\.y\.min = yMin; options\.scales\.y\.max = yMax \}/.test(cht))
  // With min and max set, Chart.js labels the bounds themselves — which is how the axis came
  // to read "-$256.68" under a "$0".
  t('and the labels stay round numbers', /includeBounds = false/.test(cht))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
