// Leverage and maintenance count every dex, not only the main one (src/render.js allDexNotional,
// allDexMaint).
//
// Reported: Leverage 0.09× here, 1.80× on Hyperdash, for a $1,815 account trading HIP-3, with
// Maint. "—". marginSummary.totalNtlPos and crossMaintenanceMarginUsed are the MAIN dex's only;
// the HIP-3 book was left out of both.
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b))
// render.js touches the page at import: the smallest stub that lets it load (as caltransfers does).
globalThis.window = {}
globalThis.document = { getElementById: () => null, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null }
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
const R = await import('../../src/render.js')

// The reported shape: $1,815 of equity, $160 on the main dex, $3,107 on xyz.
const pos = (coin, szi, positionValue) => ({ type: 'oneWay', position: { coin, szi: String(szi), positionValue: String(positionValue), marginUsed: '0', unrealizedPnl: '0', entryPx: '1' } })
const perpState = {
  marginSummary: { accountValue: '1815', totalNtlPos: '160', totalMarginUsed: '16' },
  crossMaintenanceMarginUsed: '2',
  withdrawable: '660',
  assetPositions: [pos('BTC', 0.002, 160), pos('xyz:NVDA', 5, 1157), pos('xyz:CL', -20, 1950)],
  _dexStates: [{ crossMaintenanceMarginUsed: '2', assetPositions: [] }, { crossMaintenanceMarginUsed: '77.5', assetPositions: [] }],
}
t('notional is every dex\'s positions: $160 + $1,157 + $1,950', near(R.allDexNotional(perpState), 3267))
t('maintenance is every dex\'s: $2 + $77.50', near(R.allDexMaint(perpState), 79.5))
const st = R.computeAcctStats(perpState, { balances: [] }, [], [], [], {})
t('so leverage is 1.80× on $1,815, as Hyperliquid and Hyperdash have it — not 0.09×', near(st.accountLeverage, 3267 / 1815, 1e-3) && st.accountLeverage.toFixed(2) === '1.80', st.accountLeverage)
t('and Maint. is the $79.50 at stake, not nothing', near(st.maintMargin, 79.5))
// Without the per-dex figures (an older cached state) it falls back to the main dex's.
t('falls back to the main dex\'s figures when the merged ones are not there', R.allDexNotional({ marginSummary: { totalNtlPos: '50' }, assetPositions: [] }) === 50 && R.allDexMaint({ crossMaintenanceMarginUsed: '3' }) === 3)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
