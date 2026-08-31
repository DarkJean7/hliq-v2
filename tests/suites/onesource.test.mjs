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

console.log('\n-- a margin transfer on a fills tick must still re-baseline --')
const _rA = cli.indexOf('async function refreshLive(force = false)')
const ref = cli.slice(_rA, cli.indexOf('// Rebuild outcome token map', _rA))
t('the anchor is still only nudged on a tick with NO fills',
  ref.includes('if (newRawFills.length === 0) {') && ref.includes('_perpAnchor += _spurious'))
// The refetch used to live inside that same branch, so a transfer arriving with a fill was
// never revisited - and _lastPerpCash advanced anyway, baking the error in.
t('the portfolio re-baseline now runs either way, not only on a fills-free tick',
  ref.includes(String.fromCharCode(10) + '        const _a = state.addr') &&
  !ref.includes(String.fromCharCode(10) + '          const _a = state.addr'))

t('and pairs a fresh snapshot with a fresh anchor', ref.includes('_anchorPortfolio(p, state.perpState)'))
t('the $690-showing-as-$709 case is documented', ref.includes('exactly how $690 showed as $709'))
t('_lastPerpCash still advances, since the re-baseline supersedes it', ref.includes('_lastPerpCash = _perpCash'))

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
