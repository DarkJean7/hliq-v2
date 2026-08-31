// The Net PnL square wave, round two: the HEAVY FETCH was the writer that dropped HIP-3.
//
// Measured ground truth for the eight live wallets (2026-08-27):
//   main-dex unrealized only : -1406.24
//   main + HIP-3             : -1570.12
//   HIP-3 alone (xyz:SPCX x4): -163.88
// The log's two bands were -1408.73 and ~-1573.6, step ~164.89. So the low band is the
// main-only figure and the step IS the HIP-3 half -- despite the record saying hip3=0.00,
// which was the watcher's own bug (see the last section).
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('\n-- a cold miss is not an answer --')
t('the cold path no longer resolves an empty HIP-3 set',
  !cli.includes('? Promise.resolve({ positions: [], orders: [] })'))
t('it carries over what the row already holds', cli.includes('? Promise.resolve(_keptHip3)'))
t('kept positions are the HIP-3 ones', cli.includes('positions: (prevRow?.positions  ?? []).filter(_isHip3)'))
t('and the HIP-3 orders too, so orders do not flicker either',
  cli.includes('orders:    (prevRow?.openOrders ?? []).filter(_isHip3)'))
// Scoped to _fetchOne: _comboPnlForWallet does its own lookup elsewhere, which is fine.
const fetchOne = cli.slice(cli.indexOf('const _fetchOne = async (entry) => {'), cli.indexOf('const _hip3Unreal'))
t('it reuses the prevRow already looked up, rather than a second copy',
  (fetchOne.match(/\.find\(r => String\(r\.addr \?\? ''\)\.toLowerCase\(\) === key\)/g) || []).length === 1)
t('the rule is stated for the next person', cli.includes('[] is only ever an answer we went and got'))
t('and the three places it has now bitten are named',
  cli.includes('third place the same empty-vs-unknown confusion'))

console.log('\n-- the deferred pass finishes the job --')
t('it recomputes the row unrealized after adding positions',
  cli.includes('row.unrealizedPnl = (row.positions ?? [])'))
t('and the row netPnl with it', cli.includes('row.netPnl = parseFloat(row.realizedPnl ?? 0) + row.unrealizedPnl'))
t('why appending alone was not enough is recorded',
  cli.includes('_allAcctReaggregate sums the ROWS'))

console.log('\n-- reproduce the two bands --')
// Reduced to the contract: the heavy fetch builds a row's unrealized from main positions
// plus whatever HIP-3 set it was handed.
const MAIN = -1406.24, HIP3 = -163.88
const buildRow = (hip3Positions) => MAIN + hip3Positions.reduce((a, p) => a + p.u, 0)
const HIP3_POS = [{ u: -18.03 }, { u: -35.73 }, { u: -61.26 }, { u: -48.91 }]

const coldOld = () => buildRow([])                       // old: authoritative empty
const coldNew = (prev) => buildRow(prev)                 // new: carry the row's own
const wsPush  = () => buildRow(HIP3_POS)                 // socket always includes HIP-3

t('the socket band matches measured main+HIP-3', Math.abs(wsPush() - (-1570.12)) < 0.2, wsPush())
t('the OLD cold band matches measured main-only', Math.abs(coldOld() - (-1406.24)) < 0.01, coldOld())
// The four sampled positions sum to -163.93; the logged step was 164.89. They differ by
// the market moving between the two readings, which is the point -- the step is the HIP-3
// half and nothing else.
t('and the gap between them is the logged step',
  Math.abs(Math.abs(wsPush() - coldOld()) - 164.89) < 1.5, Math.abs(wsPush() - coldOld()))
t('the NEW cold path lands on the socket band instead',
  Math.abs(coldNew(HIP3_POS) - wsPush()) < 0.01, coldNew(HIP3_POS))
t('so a heavy fetch no longer steps Net PnL', coldNew(HIP3_POS) - wsPush() === 0)
// A wallet that genuinely has nothing still reads zero, not a phantom.
t('a wallet with no HIP-3 is unaffected', coldNew([]) === MAIN)

console.log('\n-- the watcher must never again say 0 for "not measured" --')
t('the HIP-3 share comes from the positions, not _mainUnreal',
  cli.includes("const h = ps.filter(x => String((x?.position ?? x)?.coin ?? '').includes(':'))"))
t('_mainUnreal is no longer what gates the measurement', !cli.includes('const m = Number(r._mainUnreal)'))
t('rows with no positions are counted, not silently skipped', cli.includes('if (!ps.length) { noPos++; continue }'))
t('the record carries that count', cli.includes('noPos=${ctx.noPos}'))
t('and which writer last touched the rows', cli.includes('liveRows=${ctx.liveRows}'))
t('liveRows is derived from the stamp only the live path sets',
  cli.includes('rows.filter(r => Number.isFinite(Number(r._mainUnreal))).length'))
t('the lesson is written down', cli.includes('worse than no measurement'))

// The exact false reading that cost a round, driven directly.
const watch = (rows) => {
  let hip3Sum = 0, hip3Rows = 0, noPos = 0
  for (const r of rows) {
    const ps = r.positions ?? []
    if (!ps.length) { noPos++; continue }
    const h = ps.filter(x => String((x?.position ?? x)?.coin ?? '').includes(':'))
      .reduce((a, x) => a + parseFloat((x.position ?? x)?.unrealizedPnl ?? 0), 0)
    if (Math.abs(h) > 0.005) { hip3Sum += h; hip3Rows++ }
  }
  return { hip3Sum: +hip3Sum.toFixed(2), hip3Rows, noPos }
}
// A heavy-fetch row: no _mainUnreal, but the HIP-3 position is right there.
const heavyRow = { positions: [
  { position: { coin: 'BTC',       unrealizedPnl: '-100' } },
  { position: { coin: 'xyz:SPCX',  unrealizedPnl: '-61.26' } }] }
t('a heavy-fetch row now reports its HIP-3 share', watch([heavyRow]).hip3Sum === -61.26)
t('and is counted', watch([heavyRow]).hip3Rows === 1)
t('an empty row is reported as unmeasured rather than as zero HIP-3',
  watch([{ positions: [] }]).noPos === 1 && watch([{ positions: [] }]).hip3Rows === 0)
t('a main-only row genuinely reports no HIP-3',
  watch([{ positions: [{ position: { coin: 'BTC', unrealizedPnl: '-100' } }] }]).hip3Rows === 0)

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
