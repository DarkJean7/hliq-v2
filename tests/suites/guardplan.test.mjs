// Where liquidation really sits once a guard has fired everything it has left.
//
// Asked for as: "add a new data that would be the 'real' liquidation price if all of the fires
// from the liq guard are fired. that way i can see the 'real' liq." The exchange's liq price
// describes the position before the guard has done anything, so a guarded position reads as
// more dangerous than it is. src/guardplan.js.
import fs from 'fs'
import { guardPlan, liqPriceFor, impliedMargin, maintFraction, liqRoom } from '../../src/guardplan.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.01) => Math.abs(a - b) < e

// The position from the report: 1.00 CRCL long, 10x isolated, entry $95.506, margin $9.59,
// and Hyperliquid's own liquidation price of $90.4729.
const CRCL = { isLong: true, size: 1, entry: 95.506, margin: 9.59, maxLev: 10 }
const HL_LIQ = 90.4729

console.log(nl + '-- the model agrees with the exchange --')
{
  t('maintenance fraction is half the reciprocal of max leverage', maintFraction(10) === 0.05 && maintFraction(0) === 0)
  const liq = liqPriceFor(CRCL)
  t('liq price lands on HL\'s own, to a few cents', near(liq, HL_LIQ, 0.05), [liq, HL_LIQ])
  // And back the other way: the margin implied by a reported liq is the margin that produced it.
  t('implied margin round-trips', near(impliedMargin({ ...CRCL, liq }), CRCL.margin, 0.01), impliedMargin({ ...CRCL, liq }))
  const short = { isLong: false, size: 1, entry: 100, margin: 10, maxLev: 10 }
  t('a short liquidates above entry', liqPriceFor(short) > 100 && near(liqPriceFor(short), 110 / 1.05), liqPriceFor(short))
  t('no size, no answer', liqPriceFor({ ...CRCL, size: 0 }) === null)
}

console.log(nl + '-- a Liq Guard adding a fixed amount per fire --')
{
  // $20 across 2 fires = $10 each. At 1 CRCL and mf 0.05, $1 of margin moves liq by
  // 1 / (1 × 0.95) = $1.0526, so each fire drops it $10.53.
  const p = guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 85, maxFires: 2, maxTotal: 20, addMode: 'fixed' })
  t('one row per fire', p.rows.length === 2, p.rows)
  t('the first fires 85% of the way from entry to liq', near(p.rows[0].px, 95.506 - 0.85 * (95.506 - HL_LIQ)), p.rows[0].px)
  t('and each fire pushes liq $10.53 lower', near(p.rows[0].liq, HL_LIQ - 10.526, 0.02) && near(p.rows[1].liq, HL_LIQ - 21.05, 0.02), p.rows.map(r => r.liq))
  t('the real liq is the last one', near(p.finalLiq, p.rows[1].liq) && p.finalLiq < HL_LIQ)
  t('and it spends exactly the cap', near(p.totalAdd, 20))
  // The second fire triggers later than the first, because liq has moved by then.
  t('later fires trigger further down', p.rows[1].px < p.rows[0].px)
}

console.log(nl + '-- what it has already done is not done twice --')
{
  const fresh = guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 85, maxFires: 2, maxTotal: 20, addMode: 'fixed' })
  // One fire already spent $10 of the $20, and the position's margin and liq already reflect it.
  const half = guardPlan({ ...CRCL, mode: 'liqguard', margin: 19.59, liq: HL_LIQ - 10.526, trigPct: 85,
                           maxFires: 2, firesUsed: 1, added: 10, maxTotal: 20, addMode: 'fixed' })
  t('only the remaining fire is projected', half.rows.length === 1 && half.firesLeft === 1)
  t('and it ends where the untouched plan ends', near(half.finalLiq, fresh.finalLiq, 0.05), [half.finalLiq, fresh.finalLiq])
  const spent = guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 85, maxFires: 2, firesUsed: 2, added: 20, maxTotal: 20 })
  t('a guard out of fires projects nothing', spent.rows.length === 0 && spent.exhausted && near(spent.finalLiq, HL_LIQ))
  const broke = guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 85, maxFires: 4, firesUsed: 0, added: 20, maxTotal: 20 })
  t('nor does one out of budget', broke.rows.length === 0 && broke.exhausted)
}

console.log(nl + '-- topping up to a target leverage --')
{
  const p = guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 85, maxFires: 3, maxTotal: 100,
                        addMode: 'target', targetLev: 5 })
  t('it fires', p.rows.length > 0, p.rows)
  // At the trigger price the position is down; the top-up restores 5x on what it is worth then.
  const px = p.rows[0].px
  const loss = (px - CRCL.entry) * CRCL.size
  t('the first top-up restores the target leverage', near(p.rows[0].add, (CRCL.size * px) / 5 - (CRCL.margin + loss), 0.02), p.rows[0])
  t('liq ends further away than a smaller guard would put it', p.finalLiq < HL_LIQ)
  t('and never spends past the cap', p.totalAdd <= 100 + 1e-6)
}

console.log(nl + '-- a Lev Brake cuts size instead --')
{
  const p = guardPlan({ ...CRCL, mode: 'levbrake', liq: HL_LIQ, trigPct: 70, maxFires: 2, reducePct: 50 })
  t('each fire halves the position', near(p.rows[0].size, 0.5) && near(p.rows[1].size, 0.25), p.rows.map(r => r.size))
  t('the margin stays with it, so liq moves away', p.rows[0].liq < HL_LIQ && p.finalLiq < p.rows[0].liq, p.rows.map(r => r.liq))
  t('and the final size is reported', near(p.finalSize, 0.25))
  // A short's liquidation is above it, so its brake moves liq UP.
  const s = guardPlan({ isLong: false, size: 1, entry: 100, margin: 10, maxLev: 10, mode: 'levbrake',
                        liq: 109.52, trigPct: 70, maxFires: 1, reducePct: 50 })
  t('a short brakes the other way', s.rows[0].liq > 109.52, s.rows)
}

console.log(nl + '-- nothing to say is said as nothing --')
{
  t('no liq price, no projection', guardPlan({ ...CRCL, mode: 'liqguard', liq: 0, trigPct: 85, maxFires: 2, maxTotal: 20 }).rows.length === 0)
  t('no trigger, no projection', guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 0, maxFires: 2, maxTotal: 20 }).rows.length === 0)
  t('a liq guard with no budget does nothing', guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 85, maxFires: 2, maxTotal: 0 }).rows.length === 0)
  t('and the liq it reports back is the one it was given', near(guardPlan({ ...CRCL, mode: 'liqguard', liq: HL_LIQ, trigPct: 0 }).finalLiq, HL_LIQ))
  t('room to liquidation is a percentage of the mark', near(liqRoom(90, 100), 10) && liqRoom(0, 100) === null)
}

console.log(nl + '-- on the card, and one copy of the arithmetic --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8')
  t('the card asks for the guarded liq', /\.\.\._guardedLiqCell\(p, liqPx\),/.test(cli))
  // Its own account's status, or the owning wallet's asked for separately — but never a
  // projection from defaults while the real config is still unknown.
  t('only when a guard is armed for this position, with its config known',
    /const g = serverStatus\?\._guards\?\.\[key\] \?\? _guardCfgFor\(mode, p\.coin, owner, key\)/.test(cli) && /if \(!g\) continue/.test(cli))
  t('another wallet’s guard is fetched, not guessed', /_guardFetchOwnerState\(mode, coin, owner, key\)/.test(cli))
  t('the desktop rows read the same figure', /window\.__guardedLiq = function\(p\)/.test(cli))
  t('a dry run is not a projection', /if \(live\['dry-run'\]\) continue/.test(cli))
  t('the modal draws the same plan from the same module',
    (cli.match(/guardPlan\(\{ mode: '(liqguard|levbrake)'/g) ?? []).length === 2)
  t('and the old inline liq walk is gone', !/const newLiq = long \? liq - add \* slope/.test(cli))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
