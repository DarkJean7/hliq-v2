// Order preview cross "Est. Liq Price" (src/liqest.js) — the model against Hyperliquid's own figures. Reported: adding 5 VVV to a 5 VVV long showed
// liq $27.20 — above the $25.91 price, for a long — while Hyperliquid showed N/A for the same
// order. Fixtures are that account's state, read from HL's public API when it was reported, so
// the expected figures are Hyperliquid's own.
import fs from 'fs'
import { crossLiqPx, crossEquity, totalCrossMaint } from '../../src/liqest.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b, tol = 0.01) => Math.abs(a - b) <= tol

// The reporting account (unified): spot USDC total 756.032159, perp account value 588.920348,
// cross maintenance 242.966225. Marks back-derived from entry and unrealized PnL.
const SPOT = [{ coin: 'USDC', token: 0, total: '756.032159', hold: '523.873927' }, { coin: 'HYPE', token: 150, total: '2.01864271' }]
const DEX = [{ crossMaintenanceMarginUsed: '242.966225', assetPositions: [] }]
const eq = crossEquity({ unified: true, spotBalances: SPOT, dexStates: DEX, perpAccountValue: '588.920348' })
const cm = totalCrossMaint(DEX)
const mark = (entry, upnl, sz) => entry + upnl / sz

t('unified: collateral is the spot USDC balance, not the perp account value', near(eq, 756.032159), eq)
t('standard: the perp account value', crossEquity({ unified: false, spotBalances: SPOT, dexStates: DEX, perpAccountValue: '588.92' }) === 588.92)
t('isolated margin is not collateral for cross',
  near(crossEquity({ unified: true, spotBalances: SPOT, dexStates: [{ assetPositions: [{ position: { leverage: { type: 'isolated' }, marginUsed: '56.03' } }] }] }), 700.002159))
t('no USDC row: unknown, not zero', crossEquity({ unified: true, spotBalances: [], dexStates: DEX }) === null)

// The model reproduces Hyperliquid's own liq prices for positions as they stand.
const hype = crossLiqPx({ curSzi: 41.49, newSzi: 41.49, mark: mark(84.8706, -129.227546, 41.49), equity: eq, crossMaint: cm, mmr: 1 / 20 })
t('HYPE 41.49 @10x: HL says 68.739', near(hype?.px, 68.7391, 0.002), hype)
const sol = crossLiqPx({ curSzi: 7.15, newSzi: 7.15, mark: mark(111.1954, -36.218225, 7.15), equity: eq, crossMaint: cm, mmr: 1 / 40 })
t('SOL 7.15 @20x: HL says 32.533', near(sol?.px, 32.5326, 0.002), sol)
// ...and would NOT with the perp account value, which is what the preview used.
const solPerp = crossLiqPx({ curSzi: 7.15, newSzi: 7.15, mark: mark(111.1954, -36.218225, 7.15), equity: 588.920348, crossMaint: cm, mmr: 1 / 40 })
t('the perp account value would have put SOL $23 too close', solPerp.px > 55, solPerp)

// The report itself.
const vvv = crossLiqPx({ curSzi: 5, newSzi: 10, mark: mark(28.0564, -10.4924, 5), price: 25.913, fee: 0.06, equity: eq, crossMaint: cm, mmr: 1 / 6 })
t('adding 5 VVV to 5 VVV: N/A, as Hyperliquid shows', vvv?.none === true && vvv.px === null, vvv)

// Sanity that the old code lacked: a long's liq is never above the price, a short's never below.
const thin = crossLiqPx({ curSzi: 0, newSzi: 100, mark: 10, equity: 5, crossMaint: 0, mmr: 0.05 })
t('a long is never liquidated ABOVE the price', thin.px <= 10, thin)
const thinS = crossLiqPx({ curSzi: 0, newSzi: -100, mark: 10, equity: 5, crossMaint: 0, mmr: 0.05 })
t('a short never BELOW it', thinS.px >= 10, thinS)
const shortOk = crossLiqPx({ curSzi: 0, newSzi: -10, mark: 100, equity: 500, crossMaint: 0, mmr: 0.05 })
t('a short liq sits above the price by what the collateral covers', near(shortOk.px, (500 + 1000) / (10 * 1.05)), shortOk)
t('no equity: cannot tell (null), never a made-up price', crossLiqPx({ newSzi: 1, mark: 10, equity: null, mmr: 0.05 }) === null)

// Both previews use it — the desktop one and the mobile _orderEstimate are copies, and fixing
// one is how the same report comes in twice.
const cli = fs.readFileSync('src/main.js', 'utf8')
const calls = (cli.match(/= _crossLiqEstimate\(coin, curSzi, newSzi, price,/g) ?? []).length
t('desktop and mobile previews both call the shared estimate', calls === 2, calls)
t('both show N/A when nothing liquidates it', cli.includes("liqEl.textContent = liqNone ? 'N/A'") && cli.includes("est.liqNone ? 'N/A'"))
t('the account mode is asked of HL, once per account', cli.includes("_hlInfo({ type: 'userAbstraction', user: a })") && cli.includes('_unifiedByAddr'))
t('in All Accounts it reads the TRADE account\'s own row, not the summed totals',
  /_crossLiqEstimate[\s\S]{0,600}__getTradeAcct[\s\S]{0,300}_allAcctLastResults/.test(cli))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
