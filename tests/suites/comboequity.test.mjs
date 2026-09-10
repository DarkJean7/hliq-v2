// The All Accounts equity bridge: a snapshot carried forward by a live delta.
//
// Reported: "when orders, positions, etc are made the account equity spikes... it reduces by
// the amount of margin. It quickly fixes by itself." Caught in telemetry (kind=eqstep) rather
// than reasoned about:
//
//     04:53  step -239.06 (5721.59 -> 5482.53)  snapMoved=1
//            snapVal=5722.67  perpBase=2631.45  livePerp=2391.31  snapAge=11s
//            worstWallet=0xaa7Ad5  worstDelta=-240.08  moved=1
//     04:54  step +154.48 -> 5721.78            perpBase=2476.09  livePerp=2476.27
//
// One wallet, -240 on the PERP side alone, recovered the instant the snapshot caught up. The
// bridge was measured on perp equity, so money moving between a wallet's spot and perp sides —
// which is what placing a position does — read as a loss for as long as the snapshot was
// stale. Measuring it on each wallet's TOTAL makes that transfer net to zero inside the row.
import fs from 'fs'
import { bridgeCombined, acctBaseFrom, reanchor, snapshotRows, ARTIFACT_TOL } from '../../src/comboequity.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

// Two wallets: $3,000 of perp and $500 of spot each. Snapshot total $7,000, perp base $6,000.
const row = (acct, perp) => ({ accountValue: acct, _perpLive: perp })
const SNAP = { accountValue: 7000, perpBase: 6000, acctBase: 7000, wallets: 2 }
const FLAT = [row(3500, 3000), row(3500, 3000)]

console.log(nl + '-- nothing moving reads as nothing moving --')
{
  const r = bridgeCombined(SNAP, FLAT)
  t('the total equals the snapshot', r && near(r.val, 7000), JSON.stringify(r))
  t('and it says which bridge produced it', r?.basis === 'total', r?.basis)
}

console.log(nl + '-- a spot/perp transfer must not move the headline --')
{
  // Placing a position moves $240 from spot into perp on ONE wallet. Its perp equity rises,
  // its spot falls, its TOTAL is unchanged. This is the reported bug, with the sign the
  // report described: the old bridge read the perp half alone.
  const moved = [row(3500, 3240), row(3500, 3000)]
  const r = bridgeCombined(SNAP, moved)
  t('the equity does not move', r && near(r.val, 7000), JSON.stringify(r))
  // And the other direction — margin released back to spot, which is the -240 in the log.
  const back = [row(3500, 2760), row(3500, 3000)]
  t('nor when it moves the other way', near(bridgeCombined(SNAP, back).val, 7000))
  // What the old formula would have said, for the record.
  const perpOnly = SNAP.accountValue + ((3240 + 3000) - SNAP.perpBase)
  t('the perp-only bridge would have reported a $240 jump', near(perpOnly, 7240), String(perpOnly))
}

console.log(nl + '-- but real profit and loss still come through --')
{
  // A position gains $50: the wallet's perp equity AND its total both rise.
  const won = [row(3550, 3050), row(3500, 3000)]
  t('a gain is carried', near(bridgeCombined(SNAP, won).val, 7050), JSON.stringify(bridgeCombined(SNAP, won)))
  const lost = [row(3410, 2910), row(3500, 3000)]
  t('and so is a loss', near(bridgeCombined(SNAP, lost).val, 6910))
  // Both at once: a transfer and a gain on the same wallet nets to just the gain.
  const both = [row(3550, 3290), row(3500, 3000)]
  t('a transfer and a gain together carry only the gain',
    near(bridgeCombined(SNAP, both).val, 7050), JSON.stringify(bridgeCombined(SNAP, both)))
}

console.log(nl + '-- the fallback, for a snapshot with no total to anchor against --')
{
  const noBase = { ...SNAP, acctBase: null }
  const r = bridgeCombined(noBase, FLAT)
  t('it still produces a figure', r && near(r.val, 7000), JSON.stringify(r))
  t('and says it used the perp bridge', r?.basis === 'perp', r?.basis)
  // Which is the old behaviour, transfer bug included — worth stating so nobody reads the
  // fallback as equally safe.
  const moved = [row(3500, 3240), row(3500, 3000)]
  t('the fallback is the OLD behaviour, transfer and all',
    near(bridgeCombined(noBase, moved).val, 7240))
}

console.log(nl + '-- a partial answer is refused, never published --')
{
  t('a row with no total falls back rather than summing a hole',
    bridgeCombined(SNAP, [row(undefined, 3000), row(3500, 3000)])?.basis === 'perp')
  t('a row with neither returns nothing at all',
    bridgeCombined(SNAP, [row(undefined, undefined), row(3500, 3000)]) === null)
  // The snapshot describes a specific set of wallets; a different set makes the anchor
  // meaningless rather than merely stale.
  t('a changed wallet set is refused', bridgeCombined(SNAP, [row(3500, 3000)]) === null)
  t('no snapshot is refused', bridgeCombined(null, FLAT) === null)
  t('a snapshot with no anchor is refused', bridgeCombined({ ...SNAP, accountValue: NaN }, FLAT) === null)
}

console.log(nl + '-- the base is measured the same way as the delta --')
{
  t('acctBase sums the rows own totals', acctBaseFrom(FLAT) === 7000)
  t('and refuses a partial sum', acctBaseFrom([row(undefined, 1), row(2, 2)]) === null)
  t('an empty set sums to zero, not null', acctBaseFrom([]) === 0)
}

console.log(nl + '-- a move the perp side does not explain is not profit --')
{
  // Bridging on totals fixed the transfer and exposed a second sensitivity: a row's
  // accountValue is itself derived from a cached portfolio snapshot, so it also steps when
  // that cache fills, and when a close rebuilds the row. From eqstep, right after the first
  // fix: +156.15 on the total while the perp side moved -0.97, put straight back by the next
  // snapshot. Real profit moves both together, because the position lives on the perp side.
  const prev = snapshotRows([row(3500, 3000), row(3500, 3000)].map((r, i) => ({ ...r, addr: 'w' + i })))
  const R = (i, acct, perp) => ({ addr: 'w' + i, accountValue: acct, _perpLive: perp })

  // A row settles 159 higher with its perp unmoved: absorbed into the anchor, not published.
  {
    const r = reanchor(prev, [R(0, 3659, 3000), R(1, 3500, 3000)], 7000)
    t('the unexplained move is folded into the anchor', near(r.acctBase, 7159), String(r.acctBase))
    t('and it is reported, with the wallet', near(r.absorbed, 159) && r.worst?.addr === 'w0', JSON.stringify(r.worst))
    // Which is the whole point: bridged against the new anchor, the headline does not move.
    t('so the headline stays put',
      near(bridgeCombined({ ...SNAP, acctBase: r.acctBase }, [R(0, 3659, 3000), R(1, 3500, 3000)]).val, 7000))
  }

  // Real profit: total and perp move together, so nothing is absorbed.
  {
    const r = reanchor(prev, [R(0, 3550, 3050), R(1, 3500, 3000)], 7000)
    t('a genuine gain is left alone', r.absorbed === 0 && near(r.acctBase, 7000), JSON.stringify(r))
    t('and reaches the headline',
      near(bridgeCombined({ ...SNAP, acctBase: r.acctBase }, [R(0, 3550, 3050), R(1, 3500, 3000)]).val, 7050))
  }

  // A closed position: the perp side is continuous (unrealised becomes realised) while the
  // row is rebuilt and its total jumps by the notional. Absorbed.
  {
    const r = reanchor(prev, [R(0, 3500 - 394, 3000), R(1, 3500, 3000)], 7000)
    t('a close does not move the equity', near(r.absorbed, -394) &&
      near(bridgeCombined({ ...SNAP, acctBase: r.acctBase }, [R(0, 3106, 3000), R(1, 3500, 3000)]).val, 7000))
  }

  // Spot tokens do drift with the market between ticks; absorbing that would be worse than
  // letting a small one through.
  {
    const r = reanchor(prev, [R(0, 3500 + ARTIFACT_TOL - 0.5, 3000), R(1, 3500, 3000)], 7000)
    t('a small unexplained drift is left alone', r.absorbed === 0, String(r.absorbed))
    t('the tolerance is generous on purpose, and says why', ARTIFACT_TOL >= 5 &&
      fs.readFileSync('src/comboequity.js', 'utf8').includes('spot token holdings do drift'))
  }

  // Nothing to compare against yet, and rows that cannot answer.
  {
    t('the first tick absorbs nothing', reanchor(null, [R(0, 9999, 1)], 7000).absorbed === 0)
    t('an unknown wallet is skipped', reanchor(prev, [R(9, 9999, 1)], 7000).absorbed === 0)
    t('a row with no numbers is skipped',
      reanchor(prev, [R(0, undefined, 3000)], 7000).absorbed === 0)
    t('no anchor means nothing to re-anchor', reanchor(prev, [R(0, 3659, 3000)], null).absorbed === 0)
  }

  t('snapshotRows keys by wallet', snapshotRows([R(0, 1, 2)]).get('w0').acct === 1)
}

console.log(nl + '-- it is wired in --')
{
  const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  t('main.js imports it', CLI.includes("from './comboequity.js'"))
  t('the snapshot records what the rows added up to when it was adopted',
    CLI.includes('acctBase: visible.length === addrs.length ? acctBaseFrom(visible) : null'))
  t('and the headline is bridged through it', CLI.includes('const bridged = bridgeCombined(_combinedSnap, rows)'))
  t('a refusal holds rather than guessing', CLI.includes('if (!bridged) return null'))
  // The watcher already reports the halves; it should say which bridge produced them.
  t('the eqstep record names the basis', CLI.includes('basis=${ctx.basis}'))
  t('the bridge re-anchors before it publishes',
    CLI.includes('const _re = reanchor(_comboPrevRows, rows, _combinedSnap.acctBase)') &&
    CLI.includes('_comboPrevRows = snapshotRows(rows)'))
  // The watcher was reading _perpLive, which stopped being the quantity the bridge rides on
  // the moment it moved to totals -- which is why the log said worstDelta=-0.97 while the
  // headline moved 156.
  t('and the watcher measures what the bridge actually uses',
    CLI.includes('const now = parseFloat(r.accountValue)') &&
    CLI.includes('worstAcctDelta=') && CLI.includes('absorbed='))
  t('the reason lives with the code', fs.readFileSync('src/comboequity.js', 'utf8').includes('worstDelta=-240.08'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
