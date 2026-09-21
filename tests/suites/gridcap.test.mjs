// The grid bot's margin cap.
//
// Reported: "i had a grid bot in short that was capped max margin at $100. regardless the
// position had $150 in margin and it even had 3 more orders waiting to add more"
// (0x01A4…D6D7, ADA, 10x cross, 2026-09-21). The bot's own log and the account's fills show
// the whole chain, and these tests are built from those numbers:
//
//   07:58  a deploy restarts the bot server; the grid restarts and re-centres on the new mark
//   07:59  the previous run's four entry sells no longer sit on a level — filed as FOREIGN —
//          and the new run places four entries of its own on top: two ladders
//   08:33  a fill takes margin to $107.46; the cap trips and cancels the FOUR GRID entries,
//          not the four orphans
//   09:25  orphan @ $0.23851 fills   → $126
//   12:24  orphan @ $0.24463 fills   → $147, two more orphans still resting
import fs from 'fs'
import { orderMargin, isEntry, capPlan, fitsCap } from '../../src/gridcap.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.01) => Math.abs(a - b) < e

const LEV = 10, CAP = 100

console.log(nl + '-- what counts --')
{
  t('an order\'s margin is its notional over leverage', near(orderMargin({ sz: 719, px: 0.23851 }, LEV), 17.149))
  t('a short grid\'s entries are sells', isEntry({ side: 'sell' }, true) && !isEntry({ side: 'buy' }, true))
  t('a long grid\'s are buys', isEntry({ side: 'buy' }, false) && !isEntry({ side: 'sell' }, false))
  // A reduce-only order can only shrink the position, whatever side it is on.
  t('reduce-only is never an entry', !isEntry({ side: 'sell', reduceOnly: true }, true))
}

console.log(nl + '-- the incident, replayed --')
{
  // 07:59: 3,853 ADA short at ~$0.2325 → $89.58 of margin. The new run's four entries at
  // $171.52 notional each → $17.15 of margin each.
  const posMargin = 3853 * 0.2325 / LEV
  const own = [0.2387, 0.2449, 0.2511, 0.2573].map((px, k) => ({ oid: 'g' + k, side: 'sell', px, sz: 171.52 / px }))

  // The OLD check: position margin alone. $89.58 < $100, so every entry stays.
  t('the old check saw no problem at all', posMargin < CAP, posMargin)

  const plan = capPlan({ cap: CAP, leverage: LEV, posMargin, own, others: [], markPx: 0.2325 })
  t('the committed figure is position + resting entries', near(posMargin + 4 * 17.152, 158.19), posMargin + 4 * 17.152)
  t('which is over the cap, so entries are cancelled', plan.cancel.length > 0)
  t('until what is committed fits', plan.committed <= CAP + 0.01, plan.committed)
  t('farthest from the mark first', plan.cancel[0].oid === 'g3', plan.cancel.map(o => o.oid))
  // $89.58 + one more lot is $106.73 — over. So all four go, and no new one fits either.
  t('here that is all four', plan.cancel.length === 4)
  t('and a new lot does not fit the headroom', !fitsCap({ cap: CAP, headroom: plan.headroom, margin: 17.15 }), plan.headroom)

  // With more room, the near entries survive.
  const roomy = capPlan({ cap: CAP, leverage: LEV, posMargin: 40, own, others: [], markPx: 0.2325 })
  t('with room for three, the three nearest stay', roomy.cancel.length === 1 && roomy.cancel[0].oid === 'g3', roomy.cancel.map(o => o.oid))
  t('and the committed total ends under the cap', roomy.committed <= CAP + 0.01, roomy.committed)
}

console.log(nl + '-- orders a person placed --')
{
  // A manual entry on the same coin adds to the same position, so it spends the budget — but
  // the cap governs the bot, and the bot does not cancel its owner's orders.
  const manual = [{ oid: 'm1', side: 'sell', px: 0.24, sz: 2000 }]      // $48 of margin
  const own = [{ oid: 'g0', side: 'sell', px: 0.2387, sz: 718 }]
  const plan = capPlan({ cap: CAP, leverage: LEV, posMargin: 60, own, others: manual, markPx: 0.2325 })
  // $60 of position + $48 manual is already $108 before the bot owns anything: it gives up its
  // own entry, cannot (and must not) touch the manual one, and has no room for another.
  t('a manual entry is counted — the bot gives up its own', plan.cancel.map(o => o.oid).join() === 'g0', plan)
  t('but never cancelled', !plan.cancel.some(o => o.oid === 'm1'))
  t('so the bot has no room left to add', near(plan.committed, 108) && plan.headroom === 0, plan)
}

console.log(nl + '-- no cap --')
{
  const plan = capPlan({ cap: 0, leverage: LEV, posMargin: 500, own: [{ oid: 'g', side: 'sell', px: 1, sz: 1000 }], markPx: 1 })
  t('nothing is cancelled', plan.cancel.length === 0 && plan.headroom === Infinity)
  t('and anything fits', fitsCap({ cap: 0, headroom: 0, margin: 1e9 }))
}

console.log(nl + '-- the bot uses it --')
{
  const g = fs.readFileSync('strategies/grid.js', 'utf8')
  // The orphans: this bot's own entries that sit on no level are cancelled on sight.
  t('orphaned entries of its own are cancelled', /for \(const e of foreign\) \{\s*if \(e\.bot === 'grid' && isEntry\(e, IS_SHORT\)\)/.test(g))
  t('the snapshot knows who placed each order', /bot: cloidBot\(o\.cloid\)/.test(g))
  // The budget: position PLUS resting entries.
  t('the cap budgets committed margin', /capPlan\(\{ cap: TOTAL_MARGIN, leverage: LEVERAGE, posMargin: posMarginUsed, own, others, markPx \}\)/.test(g))
  t('manual entries are counted, not cancelled', /const others = foreign\.filter\(e => !e\.cancelled && e\.bot !== 'grid' && isEntry\(e, IS_SHORT\)\)/.test(g))
  t('and every new entry must fit what is left', /if \(!fitsCap\(\{ cap: TOTAL_MARGIN, headroom: capHeadroom, margin: entryM \}\)\) \{ capSkipped\+\+; continue \}/.test(g))
  t('headroom shrinks as entries are placed', /capHeadroom -= entryM/.test(g))
  // A long's entries are below the mark: nearest is the HIGHEST index.
  t('entries are placed nearest the mark first', /const entryIdxs = \[\.\.\.PRICES\.keys\(\)\]\s*if \(!IS_SHORT\) entryIdxs\.reverse\(\)/.test(g))
  t('the scan log says what is committed', /margin committed \$\$\{capCommitted\.toFixed\(2\)\} \/ cap/.test(g))
  // The hard stop is still there for the case budgeting cannot prevent: price moving against
  // the position raises its margin with no fill at all.
  t('the hard stop at the cap is kept', /TOTAL_MARGIN > 0 && posMarginUsed >= TOTAL_MARGIN/.test(g))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
