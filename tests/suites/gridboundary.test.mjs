// The grid's take-profit boundary has to actually be a profit.
//
// Reported as "can you check why my account closed my short???". It was not the exchange and
// not a stop: the grid bot market-closed a 229.7 ZRO short at $1.6317 against an average
// entry of $1.0923, realising -$123.89. The order carried the grid's own cloid (b07 + 03),
// was reduceOnly IOC priced at mark x 1.01 — closeAtBoundary's formula exactly — and was
// placed and filled in the same millisecond.
//
// How the boundary got onto the wrong side of the average entry: the range is re-derived on
// every start, centred on the MARK, and a restart strips stored bounds. The short was built
// around $1.09 over 17-20 September; ZRO then ran to $1.86; a deploy restarted hliq-strat at
// 04:57 UTC on 30 September; the new range came out ~$1.637-$2.08. Thirty hours later the
// mark drifted down through $1.637 and the "take profit at the bottom" rule fired 50% above
// the entry.
//
// Every other exit in that file is gated by exitProfitable(). This one was not.
import fs from 'fs'

const src = fs.readFileSync('strategies/grid.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const PROFIT_BUFFER = 0.0005

/** exitProfitable, exactly as grid.js defines it. */
function exitProfitable(short, px, avgEntry) {
  if (!(avgEntry > 0)) return true
  return short ? px <= avgEntry * (1 - PROFIT_BUFFER)
               : px >= avgEntry * (1 + PROFIT_BUFFER)
}

/** The gate closeAtBoundary now applies. True = close the position. */
function wouldClose({ short, markPx, avgEntry, openSz = 1 }) {
  if (openSz <= 0) return 'stopped'
  if (!(avgEntry > 0) || !exitProfitable(short, markPx, avgEntry)) return false
  return true
}

console.log(nl + '-- the trade that was reported --')
{
  // The real numbers, to the cent.
  const ZRO = { short: true, avgEntry: 1.0923, openSz: 229.7 }
  t('the close that cost $123.89 is refused now', wouldClose({ ...ZRO, markPx: 1.6316 }) === false)
  t('and anywhere above the average entry is refused', wouldClose({ ...ZRO, markPx: 1.1 }) === false)
  t('including a hair above it, where the fees alone lose money',
    wouldClose({ ...ZRO, markPx: 1.0923 }) === false)
  // What the rule was always FOR: the short really is in profit at the bottom of its range.
  t('a real take-profit still closes', wouldClose({ ...ZRO, markPx: 1.00 }) === true)
  t('clearing the fee buffer is what makes it one',
    wouldClose({ ...ZRO, markPx: 1.0923 * (1 - PROFIT_BUFFER) }) === true)
}

console.log(nl + '-- a long grid, mirrored --')
{
  const L = { short: false, avgEntry: 121.14, openSz: 4.36 }
  t('cashing out below the average is refused', wouldClose({ ...L, markPx: 108.0 }) === false)
  t('and at the average, where fees decide it', wouldClose({ ...L, markPx: 121.14 }) === false)
  t('a real one closes', wouldClose({ ...L, markPx: 140 }) === true)
}

console.log(nl + '-- an unknown average is a refusal, not a free pass --')
{
  // exitProfitable answers TRUE for a missing basis, because a resting order has nothing to
  // lose by being placed. Closing the WHOLE position on a basis we could not read is a
  // different thing, and it is how the reported loss happened.
  t('exitProfitable alone would have allowed it', exitProfitable(true, 1.6316, 0) === true)
  t('the boundary gate does not', wouldClose({ short: true, markPx: 1.6316, avgEntry: 0 }) === false)
  t('nor for a long', wouldClose({ short: false, markPx: 108, avgEntry: 0 }) === false)
  t('and the source says why', src.includes('closing on an unknown basis is not allowed'))
}

console.log(nl + '-- a refusal leaves the ladder alone --')
{
  const fn = src.slice(src.indexOf('async function closeAtBoundary'), src.indexOf('// ─── RECONCILE'))
  // Cancelling first and refusing second would tear the grid down on every later cycle and
  // never build it again: reconcile returns straight after the boundary check.
  t('the position is read BEFORE anything is cancelled',
    fn.indexOf('info.clearinghouseState') < fn.indexOf("cancelOid(e.oid, 'boundary hit')"))
  // The FIRST cancel is the empty-position branch, which has nothing to lose. The one that
  // matters is the cancel on the closing path, right before "Cancelled N open grid order(s)".
  const closeCancel = fn.indexOf("cancelOid(e.oid, 'boundary hit')\n  log('CLOSE', `Cancelled")
  t('the gate is before the cancel on the CLOSING path',
    closeCancel > 0 && fn.indexOf('!exitProfitable(markPx, avgEntry)') < closeCancel)
  t('and a refusal returns rather than closing', /return false\n  \}/.test(fn))
  t('the gate reads the average off the position', fn.includes("const avgEntry  = parseFloat(pos?.position?.entryPx ?? 0)"))
  t('a refusal is logged, but not once a cycle', fn.includes("_boundaryHeldAt") && fn.includes('900_000'))
}

console.log(nl + '-- and the caller only stops when it really closed --')
{
  t('a long grid', src.includes('if (!IS_SHORT && markPx >= UPPER) { if (await closeAtBoundary(markPx, levelOrders)) return }'))
  t('a short grid', src.includes('if (IS_SHORT  && markPx <= LOWER) { if (await closeAtBoundary(markPx, levelOrders)) return }'))
  // The old form threw the rest of the cycle away whatever happened, so a refusal would have
  // left the grid doing nothing at all for as long as the mark stayed past the boundary.
  t('the unconditional return is gone', !/await closeAtBoundary\(markPx, levelOrders\); return/.test(src))
}

console.log(nl + '-- the empty-position path still stops the grid --')
{
  t('nothing open means the grid is done', wouldClose({ short: true, markPx: 1.0, avgEntry: 1.09, openSz: 0 }) === 'stopped')
  t('and it cancels what is left before it goes',
    /if \(openSz <= 0\) \{\n\s*for \(const e of levelOrders\.values\(\)\) await cancelOid/.test(src))
}

console.log(nl + '-- the reason is written down where the next person will look --')
{
  t('the trade is named in the source', src.includes('229.7 ZRO short') && src.includes('$1.0923'))
  t('and so is how the boundary moved', src.includes('a restart strips'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
