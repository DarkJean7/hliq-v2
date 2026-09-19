// How long a spot holding has actually been held.
//
// Asked for as "in spot cards add more data like the date purchased, time holding". A balance
// says what you have and never since when — and "+20%" is a different fact over a week than
// over four months.
//
// The naive answer, the earliest buy, is wrong in the direction that flatters: sell out and
// buy back and it still claims the original date. So the running size is walked forward and
// the period starts the last time it left zero.
import fs from 'fs'
import { holdingStart, fmtHeld, fmtWhen } from '../../src/holding.js'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const DAY = 86400000
const T0  = Date.UTC(2026, 8, 1)          // 1 Sep 2026
const buy  = (d, sz, coin = '@334') => ({ coin, dir: 'Buy',  sz: String(sz), time: T0 + d * DAY })
const sell = (d, sz, coin = '@334') => ({ coin, dir: 'Sell', sz: String(sz), time: T0 + d * DAY })

console.log(nl + '-- the period starts when the balance last left zero --')
{
  // One straightforward accumulation.
  let r = holdingStart([buy(0, 100), buy(3, 100)], ['@334'], 200)
  t('a single run starts at the first buy', r.since === T0)
  t('and knows when it was last added to', r.lastBuy === T0 + 3 * DAY)
  t('it is exact, because the fills explain the balance', r.exact === true)
  t('and it counts what it saw', r.buys === 2 && r.sells === 0)

  // Sold out, bought back. The earliest buy is 1 Sep; the holding began on the 10th.
  r = holdingStart([buy(0, 100), sell(5, 100), buy(10, 40)], ['@334'], 40)
  t('selling out and rebuying restarts it', r.since === T0 + 10 * DAY)
  t('not the original purchase', r.since !== T0)

  // Sold down but never to zero: still the same holding.
  r = holdingStart([buy(0, 100), sell(5, 60), buy(10, 40)], ['@334'], 80)
  t('trimming a position does not restart it', r.since === T0)

  // Flat right now.
  r = holdingStart([buy(0, 100), sell(5, 100)], ['@334'], 0)
  t('nothing held means no holding period', r.since === null)
}

console.log(nl + '-- and it refuses to date what it cannot explain --')
{
  // 200 held, but the fills only account for 40. The rest was transferred in or predates the
  // history this device has walked, so the holding is OLDER than anything here can show.
  let r = holdingStart([buy(10, 40)], ['@334'], 200)
  t('a balance the fills do not cover is not exact', r.exact === false)
  t('but it still offers the date it does know', r.since === T0 + 10 * DAY)

  // No fills at all — an airdrop, a bridge, a transfer in.
  r = holdingStart([], ['@334'], 200)
  t('no fills says nothing rather than guessing', r.since === null && r.exact === false)

  // Fills for a DIFFERENT coin must not leak in. Balances are keyed by token name and fills
  // by pair id, which is the mismatch that has broken the Spot tab twice.
  r = holdingStart([buy(0, 100, '@107')], ['@334'], 100)
  t('another market is not this holding', r.since === null)
  t('and either key matches, since the two sides name it differently',
    holdingStart([buy(0, 100, '@334')], ['KNTQ', '@334'], 100).since === T0)
}

console.log(nl + '-- dust is zero --')
{
  // A float remainder after selling out must not read as a still-open holding.
  const r = holdingStart([buy(0, 100), sell(5, 99.99999999), buy(10, 50)], ['@334'], 50)
  t('a rounding crumb does not keep the period alive', r.since === T0 + 10 * DAY)
}

console.log(nl + '-- the duration reads like a person wrote it --')
{
  t('under a minute', fmtHeld(30 * 1000) === 'just now')
  t('minutes', fmtHeld(42 * 60000) === '42m')
  t('hours and minutes', fmtHeld((3 * 60 + 20) * 60000) === '3h 20m')
  // "3d 0h" reads like a rounding error, so a zero unit is dropped.
  t('a whole number of hours drops the minutes', fmtHeld(5 * 3600000) === '5h')
  t('days and hours', fmtHeld(3 * DAY + 4 * 3600000) === '3d 4h')
  t('a whole number of days drops the hours', fmtHeld(3 * DAY) === '3d')
  // Past a month the hours stop mattering.
  t('months and days', /^2mo/.test(fmtHeld(70 * DAY)))
  t('nonsense is a dash, not NaN', fmtHeld(undefined) === '—' && fmtHeld(-5) === '—')
}

console.log(nl + '-- and the date anchors it --')
{
  t('a real timestamp formats', /2026/.test(fmtWhen(T0)))
  t('a missing one does not pretend', fmtWhen(null) === '—' && fmtWhen(0) === '—')
}

console.log(nl + '-- both spot cards use it, not just the one --')
{
  // A renderer here usually has a second copy for the combined view, and fixing one and
  // shipping it is how the same gap gets reported twice.
  const cli = fs.readFileSync('src/main.js', 'utf8')
  const uses = (cli.match(/_spotHeldTxt\(/g) || []).length
  t('one helper builds the text', cli.includes('function _spotHeldTxt('))
  // Its definition plus three call sites: the single-account card, the combined group card,
  // and the desktop tab. Two would mean a shell was missed.
  t('all three surfaces call it', uses === 4, String(uses))
  t('the single-account card shows it', cli.includes("_spotHeldTxt(b.coin, total)"))
  t('the combined group card shows it too', cli.includes("_spotHeldTxt(coin, total)"))
  t('and so does the desktop tab', cli.includes('_spotHeldTxt(h.coin, h.total)'))
  // Only shown when the fills can say something; a card full of dashes is worse than no row.
  t('and none of them print an empty row', (cli.match(/return h \? \[\['Held', h\]\] : \[\]/g) || []).length === 2)
  // An inexact date has to look different from one we can stand behind.
  t('an unexplained balance is marked as at-least', cli.includes("'≥ '"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
