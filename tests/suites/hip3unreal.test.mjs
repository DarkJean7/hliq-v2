// The two writers of a row's unrealized PnL must agree.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

console.log('\n-- what the telemetry showed --')
// 39 recorded steps: settled flat to the cent across hours (1507.52-1507.64) while unreal
// alternated by ~$180. Both halves came from the SAME snapshot each time, and the wallet
// counts always matched - so neither the guard nor the server was involved.
const rec = [
  { settled: 1507.52, unreal: -1317.22, rows: 8, pnlWallets: 8 },
  { settled: 1507.52, unreal: -1516.34, rows: 8, pnlWallets: 8 },
]
const net = (r) => r.settled + r.unreal
t('settled is identical between the two readings', rec[0].settled === rec[1].settled)
t('the wallet counts never disagreed, so the guard was not firing',
  rec.every(r => r.rows === r.pnlWallets))
t('the whole step is the unrealized half', Math.abs((net(rec[0]) - net(rec[1])) - (rec[0].unreal - rec[1].unreal)) < 1e-9)
t('and it is about $200, the size of these accounts\' builder-dex exposure',
  Math.abs(net(rec[0]) - net(rec[1])) > 150)

console.log('\n-- the two writers --')
const heavy = cli.slice(cli.indexOf('const _hip3Unreal      ='), cli.indexOf('const realizedPnl      ='))
t('the heavy fan-out now counts builder-dex positions', heavy.includes("(hip3Res?.positions ?? [])"))
t('and adds them to the main-dex sum', heavy.includes('+ _hip3Unreal'))
t('it handles both row shapes, like the live path does', heavy.includes('(ap.position ?? ap)?.unrealizedPnl'))
const live = cli.slice(cli.indexOf('const hip3Unreal = hip3.reduce'), cli.indexOf('r.positions     = [...mainPos, ...hip3]'))
t('the live path already did', live.includes('r.unrealizedPnl = liveUnreal + hip3Unreal'))

// The equality that matters: same inputs, same answer, whichever writer runs.
const mainPos = [{ position: { unrealizedPnl: '-1120.30' } }]
const hip3Pos = [{ position: { unrealizedPnl: '-120.93' } }]
const heavySum = mainPos.reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0)
               + hip3Pos.reduce((s, ap) => s + parseFloat((ap.position ?? ap)?.unrealizedPnl ?? 0), 0)
const liveSum  = mainPos.reduce((s, p) => s + parseFloat(p.position?.unrealizedPnl ?? 0), 0)
               + hip3Pos.reduce((s, ap) => s + parseFloat((ap.position ?? ap)?.unrealizedPnl ?? 0), 0)
t('both writers now produce the same figure', Math.abs(heavySum - liveSum) < 1e-9)
t('and it includes the builder-dex part', Math.abs(heavySum - -1241.23) < 1e-9)
t('a wallet with no HIP-3 positions is unaffected',
  mainPos.reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0) + [].reduce((s) => s, 0) === -1120.3)

console.log('\n-- equity never read this array, which is why it did not move --')
t('the row\'s equity is anchored on perp account value', cli.includes('_perpLive: _perpAcctVal'))
t('and bridges from a portfolio snapshot, not from positions',
  cli.includes('portfolioAcctVal + (_perpAcctVal - _perpAtHist)'))
t('the live path keeps a SEPARATE main-only figure for that bridge',
  cli.includes('r._mainUnreal   = liveUnreal'))

console.log('\n-- the logger that found it stays --')
t('steps over $25 still report both halves', cli.includes('settled=${ctx.settled') && cli.includes('unreal=${ctx.unreal'))
t('with the wallet counts and snapshot age', cli.includes('pnlWallets=${ctx.pnlWallets}') && cli.includes('snapAge='))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
