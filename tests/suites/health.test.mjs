// Account health, the way Hyperliquid computes it.
//
// Reported side by side with Hyperliquid's own Unified Account Summary: we showed Health 89.1%
// while HL showed a Unified Account Ratio of 16.10%, which is 83.9%.
//
// We were computing `1 − crossMaintenanceMarginUsed / portfolioValue`. BOTH halves were wrong,
// and both in the direction that flatters — the one direction a liquidation gauge must not be
// wrong in.
//
// Measured live on that account at the time of the fix:
//
//   main dex maintenance      133.73
//   xyz  dex maintenance        7.66      <- we counted none of this
//   spot USDC balance         903.95      <- the collateral that actually backs the positions
//   portfolio value         1,211.55      <- what we were dividing by, incl. ~$354 of HYPE
//
//   ours: 1 − 133.73 / 1211.55 = 88.96%       HL: 1 − 141.39 / 903.95 = 84.36%
//
// The algorithm below is transcribed from `computeUnifiedAccountRatio` in Hyperliquid's docs.
import fs from 'fs'
import { unifiedAccountRatio, accountHealth, healthClass, approxHealth, USDC_TOKEN } from '../../src/health.js'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

const iso = (m) => ({ position: { leverage: { type: 'isolated' }, marginUsed: String(m) } })
const cross = (m) => ({ position: { leverage: { type: 'cross' }, marginUsed: String(m) } })

console.log(nl + '-- it reproduces the live account it was written against --')
{
  const dexes = [
    { crossMaintenanceMarginUsed: 133.73, assetPositions: [] },   // main
    { crossMaintenanceMarginUsed: 7.66,  assetPositions: [] },    // xyz
  ]
  const spot = [{ token: 0, total: '903.945571' }, { token: 150, total: '3.7874533' }]
  t('the ratio matches what Hyperliquid reported', near(unifiedAccountRatio(dexes, spot) * 100, 15.6424, 0.01),
    (unifiedAccountRatio(dexes, spot) * 100).toFixed(4))
  t('so health is 84.36, not 88.96', near(accountHealth(dexes, spot), 84.3576, 0.01),
    accountHealth(dexes, spot).toFixed(4))
  // The old formula, kept as the counter-example so the regression is unmissable.
  t('the old formula is the number that was wrong', near(approxHealth(133.73, 1211.55), 88.9623, 0.01))
}

console.log(nl + '-- the numerator is every dex, not just the main one --')
{
  const spot = [{ token: 0, total: '1000' }]
  const mainOnly = [{ crossMaintenanceMarginUsed: 100, assetPositions: [] }]
  const both = [...mainOnly, { crossMaintenanceMarginUsed: 50, assetPositions: [] }]
  t('main alone', near(unifiedAccountRatio(mainOnly, spot), 0.10))
  // A builder-dex position has its own maintenance margin, and leaving it out understates
  // risk by exactly that much.
  t('a builder dex adds to it', near(unifiedAccountRatio(both, spot), 0.15))
  t('which is worse health, not better', accountHealth(both, spot) < accountHealth(mainOnly, spot))
}

console.log(nl + '-- the denominator is the collateral, not the account --')
{
  // The account holds $1,000 of USDC and $500 of some token. Only the USDC backs a
  // USDC-collateralised position; holding HYPE does not stop you being liquidated.
  const dexes = [{ crossMaintenanceMarginUsed: 200, assetPositions: [] }]
  const spot  = [{ token: 0, total: '1000' }, { token: 150, total: '5' }]
  t('only the collateral token counts', near(unifiedAccountRatio(dexes, spot), 0.20))
  // Isolated positions have locked their margin away where cross positions cannot reach it.
  const withIso = [{ crossMaintenanceMarginUsed: 200, assetPositions: [iso(200), cross(999)] }]
  t('isolated margin is subtracted from what is available', near(unifiedAccountRatio(withIso, spot), 200 / 800))
  t('cross margin is not', near(unifiedAccountRatio([{ crossMaintenanceMarginUsed: 200, assetPositions: [cross(500)] }], spot), 0.20))
}

console.log(nl + '-- the worst collateral token governs --')
{
  // Two books settling in different tokens. You are liquidated on the one that runs out
  // first, so an average would hide the case the gauge exists to show.
  const dexes = [
    { crossMaintenanceMarginUsed: 100, assetPositions: [], collateralToken: 0 },   // 10% of 1000
    { crossMaintenanceMarginUsed: 90,  assetPositions: [], collateralToken: 7 },   // 90% of 100
  ]
  const spot = [{ token: 0, total: '1000' }, { token: 7, total: '100' }]
  t('it takes the max, not the mean', near(unifiedAccountRatio(dexes, spot), 0.90))
  t('so health reflects the book about to go', near(accountHealth(dexes, spot), 10))
}

console.log(nl + '-- and it refuses to invent a number --')
{
  // "No collateral found" is not "perfectly healthy". Rendering 100% for it is how a gauge
  // lies at the worst possible moment.
  t('no spot balance for the collateral token is unknown', unifiedAccountRatio([{ crossMaintenanceMarginUsed: 100, assetPositions: [] }], []) === null)
  t('and so is no dex state at all', unifiedAccountRatio([], [{ token: 0, total: '100' }]) === null)
  t('health is null too, not 100', accountHealth([{ crossMaintenanceMarginUsed: 100, assetPositions: [] }], []) === null)
  t('unknown gets its own colour, never green', healthClass(null) === 'muted')
  // Zero collateral with margin outstanding is liquidatable, not healthy.
  t('zero available collateral is not healthy',
    unifiedAccountRatio([{ crossMaintenanceMarginUsed: 100, assetPositions: [] }], [{ token: 0, total: '0' }]) === null)
  // Over 100% means maintenance exceeds collateral. Clamped to 0, not negative.
  t('a liquidatable account reads zero, not a negative',
    accountHealth([{ crossMaintenanceMarginUsed: 200, assetPositions: [] }], [{ token: 0, total: '100' }]) === 0)
  t('USDC is token 0', USDC_TOKEN === 0)
}

console.log(nl + '-- the bands --')
{
  t('healthy', healthClass(84.36) === 'pos')
  t('warning', healthClass(45) === 'warn')
  t('danger', healthClass(12) === 'neg')
}

console.log(nl + '-- every surface computes it the same way --')
{
  // A renderer here usually has a second copy for the combined view, and health has three:
  // the account stats, the portfolio panel, and the per-wallet rows.
  const rnd = fs.readFileSync('src/render.js', 'utf8')
  const cli = fs.readFileSync('src/main.js', 'utf8')
  const api = fs.readFileSync('src/api.js', 'utf8')

  t('computeAcctStats uses it', rnd.includes('accountHealth(_dexStates, spotState?.balances)'))
  t('so does the portfolio panel', rnd.includes('accountHealth(_dexStates2, spotState?.balances)'))
  t('and the combined view fan-out', cli.includes('_hlHealth(_dexSt, spotState?.balances)'))
  t('and its 12-second live tick', cli.includes('_hlHealth(_dexSt, r._spotBals)'))
  // Nothing should be left dividing maintenance margin by the portfolio value.
  t('no surface still divides by the portfolio value',
    !/1 - maintMargin \/ _marginBase/.test(cli) && !/1 - maint \/ hBase/.test(cli))

  // The per-dex maintenance figures have to survive the fetch, or the numerator is main-only
  // again however good the formula is.
  t('the fetch keeps every dex state', api.includes('_dexStates: _dexStates(mainState'))
  // A dex that did not answer keeps its last known figure. Zero maintenance margin reads as
  // "nothing at risk there", which is the empty-is-not-unknown mistake on a risk gauge.
  t('a dex that did not answer is not counted as zero', api.includes('priorMaint.get(dex)'))
  t('and the live tick reuses the last fan rather than dropping to main-only',
    cli.includes('const _prevDex  = Array.isArray(r._dexStates)'))
  t('why that matters is written down', cli.includes('jump upward every 12 seconds'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
