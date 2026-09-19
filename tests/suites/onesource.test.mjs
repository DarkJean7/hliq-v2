// The equity spike and the Net PnL flicker.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n-- an event that never mentioned HIP-3 must not erase it --')
// `hip3Override ?? fallback` never fell back: the handler always passed an array, so [] was
// taken as "no HIP-3 positions" even when the event only carried the main dex.
const apply = new Function('override', 'existing', `
  const r = { positions: existing }
  const hip3 = override ?? (r.positions ?? []).filter(ap => String((ap.position ?? ap)?.coin ?? '').includes(':'))
  return hip3.reduce((s, ap) => s + parseFloat((ap.position ?? ap)?.unrealizedPnl ?? 0), 0)
`)
const held = [
  { position: { coin: 'xyz:SPCX', unrealizedPnl: '-120.50' } },
  { position: { coin: 'BTC', unrealizedPnl: '10' } },
]
t('an event WITH hip3 states is authoritative, even when empty', apply([], held) === 0)
t('an event WITHOUT them keeps what the row had', Math.abs(apply(null, held) - -120.5) < 1e-9)
t('and only the prefixed coins count as HIP-3', apply(null, held) !== -110.5)
t('a real override replaces it', apply([{ position: { coin: 'xyz:GOLD', unrealizedPnl: '5' } }], held) === 5)

const _wsA = cli.indexOf('let sawHip3 = false')
const ws = cli.slice(_wsA - 900, cli.indexOf('_acctWsSchedulePaint()', _wsA) + 40)
t('the handler distinguishes the two cases', ws.includes('let sawHip3 = false'))
t('and passes null when it learned nothing', ws.includes('sawHip3 ? hip3Pos : null'))
t('the flag is set from the dex entries themselves', ws.includes('sawHip3 = true'))
t('why it matters is on the record', ws.includes('exactly the shape of the reported flicker'))

console.log('\n-- a margin transfer is caught on EVERY tick, not just a fills tick --')
const _rA = cli.indexOf('async function refreshLive(force = false)')
const ref = cli.slice(_rA, cli.indexOf('// Rebuild outcome token map', _rA))
// This used to hang off `if (_fillsTick)`, because "did fills arrive" was the only way it
// could tell a transfer from a trade. Fills are fetched every 3rd tick at best and every 6th
// on a tab that is not showing them, so a transfer stood uncorrected for up to thirty seconds
// - reported as equity spiking with a fake value and then fixing itself. The correction was
// right; the delay was the bug. What tells them apart is whether a position changed SIZE, and
// that is on the clearinghouse state every tick already fetches.
t('the reconcile no longer waits for a fills tick', !/if \(_fillsTick\) \{[\s\S]{0,400}_perpAnchor/.test(ref))
t('it is keyed on the positions instead', ref.includes('cashSample(perpState.marginSummary?.accountValue, perpState.assetPositions)'))
t('a transfer moves the anchor so the headline does not move', ref.includes("_move.kind === 'transfer'") && ref.includes('_perpAnchor += _move.delta'))
t('a fill re-reads the snapshot rather than guessing the split', ref.includes("_move.kind === 'trade'"))
t('and pairs a fresh snapshot with a fresh anchor', ref.includes('_anchorPortfolio(p, state.perpState)'))
// A snapshot that landed THIS tick was already paired with THIS perp state, so shifting it by
// a delta measured against the previous tick would push it straight back off.
t('a snapshot that just landed is left alone', ref.includes("_move.kind === 'transfer' && !freshPortfolio"))
t('the re-read is throttled, since a bot fills continuously', ref.includes('Date.now() - _reanchorAt > 8000'))
t('the sample advances either way', ref.includes('if (_sample) _lastPerpCash = _sample'))

console.log('\n-- the bridge itself is unchanged --')
// equity = snapshot + (perpNow - anchor). The fix is about WHEN the pair is refreshed,
// never about the formula, which is validated against the single-account view.
t('the anchor is still stamped with the perp value seen at fetch time',
  grab(cli, 'function _anchorPortfolio(portfolio, perpState)').includes("perpState.marginSummary.accountValue"))
t('snapshot and anchor are still written together', cli.includes('state.portfolio = _anchorPortfolio(freshPortfolio, perpState)'))

console.log('\n-- and the combined figure still has one source --')
t('per-wallet Net PnL comes from the server settled half', cli.includes('function _comboPnlForWallet(addr)'))
t('the total refuses a per-device row sum', cli.includes('const totalNet    = _cpAll?.net ?? null'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
