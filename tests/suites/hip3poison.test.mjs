// The Net PnL square wave: a WS event that never mentioned the builder dexes was recorded
// as "this wallet holds nothing on any of them", and _lbFetchHip3 believed it.
//
// Evidence this reproduces (client-errors.json, kind=pnlstep, 2026-08-27):
//   step 166.91 (-26.37 -> 140.54)  settled=1544.14 unreal=-1403.60 rows=8 wallets=8
//   step 167.65 (-4.24  -> 163.41)  settled=1544.14 unreal=-1380.73 rows=8 wallets=8
//   step 166.67 (-0.94  -> 165.73)  settled=1544.14 unreal=-1378.42 rows=8 wallets=8
// settled flat to the cent, every wallet count unchanged, unrealized alternating by a
// constant. Not a wallet dropping out -- a quantity inside one wallet's unrealized.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('\n-- the guard covers BOTH consumers of the event --')
t('applying live state still distinguishes "none" from "not mentioned"',
  cli.includes('if (_applyAcctLiveCs(r, mainSt, sawHip3 ? hip3Pos : null)) _acctWsSchedulePaint()'))
t('and so does the dex-discovery cache now',
  cli.includes('if (sawHip3) _hip3WsDexes.set(key, { dexes: hip3Dexes, positions: hip3Pos, ts: Date.now() })'))
t('it is NOT written unconditionally any more',
  !/\n\s*_hip3WsDexes\.set\(key,/.test(cli))
t('the failure mode is written down', cli.includes('the second door the same ambiguity walked through'))
t('and so is why ageing out beats saving the calls',
  cli.includes('Never trade correctness for the call saving here'))

console.log('\n-- reproduce the square wave, then show the fix flattens it --')
// The two collaborators, reduced to their contract: the socket handler decides what to
// record, the fetcher decides whether to call out.
const mk = (guarded) => {
  const store = new Map()
  const onEvent = (key, states) => {
    const hip3Pos = [], hip3Dexes = []
    let sawHip3 = false
    for (const [dex, st] of states) {
      if (!dex) continue
      sawHip3 = true
      let has = false
      for (const ap of (st?.assetPositions ?? [])) {
        if (parseFloat(ap.position?.szi ?? 0) === 0) continue
        has = true; hip3Pos.push(ap)
      }
      if (has) hip3Dexes.push(dex)
    }
    if (!guarded || sawHip3) store.set(key, { dexes: hip3Dexes, positions: hip3Pos, ts: Date.now() })
  }
  // _lbFetchHip3's fast path: a fresh reading with no dexes means "no calls at all".
  const fetchHip3 = (key) => {
    const known = store.get(key)
    if (known && Date.now() - known.ts < 90_000) return { positions: known.positions, fanned: false }
    return { positions: [{ position: { unrealizedPnl: '-166.00' } }], fanned: true }  // the REST fan finds them
  }
  return { onEvent, fetchHip3 }
}

const FULL = [['', { assetPositions: [] }], ['xyz', { assetPositions: [
  { position: { szi: '1', unrealizedPnl: '-166.00' } }] }]]
const MAIN_ONLY = [['', { assetPositions: [] }]]
const unreal = (r) => r.positions.reduce((a, ap) => a + parseFloat(ap.position.unrealizedPnl), 0)

for (const guarded of [false, true]) {
  const { onEvent, fetchHip3 } = mk(guarded)
  onEvent('w', FULL)                       // a complete event: HIP-3 recorded
  const a = unreal(fetchHip3('w'))
  onEvent('w', MAIN_ONLY)                  // main-dex-only event arrives
  const b = unreal(fetchHip3('w'))
  const label = guarded ? 'FIXED' : 'BROKEN'
  if (!guarded) {
    t(`${label}: a main-dex-only event erases the HIP-3 half`, a === -166 && b === 0, { a, b })
    t(`${label}: which is the ~166 step from the log`, Math.abs(a - b) === 166, { a, b })
  } else {
    t(`${label}: the HIP-3 half survives a main-dex-only event`, a === -166 && b === -166, { a, b })
    t(`${label}: so Net PnL does not step`, a - b === 0, { a, b })
  }
}

// The other half of the contract: a wallet that GENUINELY holds nothing must still be
// recorded, or the fix would just restore the ten-call fan for everyone.
{
  const { onEvent, fetchHip3 } = mk(true)
  onEvent('w', [['', { assetPositions: [] }], ['xyz', { assetPositions: [] }]])
  const r = fetchHip3('w')
  t('a genuinely empty builder dex is still cached (no fan)', r.fanned === false && r.positions.length === 0)
}
// And a wallet we have never heard about must fan, not assume.
{
  const { fetchHip3 } = mk(true)
  t('an unknown wallet falls back to the fan', fetchHip3('never-seen').fanned === true)
}
// A reading only stands while it is fresh, and stops standing the moment the feed does.
t('the TTL is what expires a reading, and it is 90s', cli.includes('const _HIP3_WS_TTL = 90_000'))
t('freshness is actually checked before trusting one', cli.includes('Date.now() - v.ts < _HIP3_WS_TTL'))
t('stopping the socket drops every reading immediately', cli.includes('_hip3WsDexes.clear()'))

console.log('\n-- the logger can prove it next time in one read --')
t('unrealized is split into its HIP-3 share', cli.includes('hip3=${ctx.hip3?.toFixed?.(2)} hip3Rows=${ctx.hip3Rows}'))
// The first version of this split derived the share from r._mainUnreal. Only
// _applyAcctLiveCs sets that, so heavy-fetch rows were all skipped and the record read
// hip3=0.00 -- which read as proof HIP-3 was uninvolved at the exact moment it was the
// whole cause. See hip3cold.test.mjs. It now reads the positions, which are always there.
t('the share is derived from the positions, which every row has',
  cli.includes("const h = ps.filter(x => String((x?.position ?? x)?.coin ?? '').includes(':'))"))
t('a row with no positions is reported as unmeasured, not as zero HIP-3',
  cli.includes('if (!ps.length) { noPos++; continue }'))
t('and near-zero shares do not inflate the row count', cli.includes('if (Math.abs(h) > 0.005)'))
t('why the split was added is recorded', cli.includes('Split unrealized into its main-dex and HIP-3 halves'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
