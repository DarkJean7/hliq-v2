import fs from 'fs'
import { computeStress, computeUnprotected, stressHtml } from '../../src/exposure.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e
const fmtUSD = (v, d = 2) => Number(v).toFixed(d)

// mark is derived as positionValue/|szi|, so pick numbers that make it exact.
const pos = (coin, szi, mark, liq) => ({ position: {
  coin, szi: String(szi), positionValue: String(Math.abs(szi) * mark),
  liquidationPx: liq == null ? '0' : String(liq), unrealizedPnl: '0',
} })
const acct = (label, positions) => ({ label, addr: '0x' + label, accountValue: 1000, positions })

// ── direction matters: a drop threatens longs, a rise threatens shorts ───────
{
  // long at 100, liq 90  → 10% drop liquidates
  // short at 100, liq 110 → 10% rise liquidates
  const st = computeStress([acct('A', [pos('LONGC', 1, 100, 90)]), acct('B', [pos('SHRTC', -1, 100, 110)])])
  const down10 = st.scenarios.find(s => s.pct === 10 && s.dir < 0)
  const up10   = st.scenarios.find(s => s.pct === 10 && s.dir > 0)
  t('a 10% DROP liquidates the long', down10 && down10.coins.includes('LONGC'))
  t('the drop does NOT touch the short', down10 && !down10.coins.includes('SHRTC'))
  t('a 10% RISE liquidates the short', up10 && up10.coins.includes('SHRTC'))
  t('the rise does NOT touch the long', up10 && !up10.coins.includes('LONGC'))
  t('nothing breaks at 5%', !st.scenarios.some(s => s.pct === 5))
}

// ── distance-to-liquidation and the headline ─────────────────────────────────
{
  const st = computeStress([
    acct('A', [pos('NEAR_', 1, 100, 95)]),    // 5% away
    acct('B', [pos('FAR__', 1, 100, 50)]),    // 50% away
  ])
  t('worst is the nearest leg', st.worst.coin === 'NEAR_')
  t('distance is correct', near(st.worst.dist, 5), `${st.worst.dist}`)
  t('nearest list is sorted', st.nearest[0].coin === 'NEAR_' && st.nearest[1].coin === 'FAR__')
  const s5 = st.scenarios.find(s => s.pct === 5 && s.dir < 0)
  t('the 5% scenario catches only the near one', s5 && s5.count === 1 && s5.coins[0] === 'NEAR_')
  const s20 = st.scenarios.find(s => s.pct === 20 && s.dir < 0)
  t('20% still does not reach the far one', s20 && s20.count === 1)
}

// ── shorts: distance is measured upward ──────────────────────────────────────
{
  const st = computeStress([acct('A', [pos('S', -2, 50, 60)])])   // 20% up to liq
  t('short distance measured upward', near(st.worst.dist, 20), `${st.worst.dist}`)
  t('short appears in the RISE scenario', st.scenarios.some(s => s.dir > 0 && s.pct === 20))
  t('short never appears in a DROP scenario', !st.scenarios.some(s => s.dir < 0))
}

// ── aggregation across wallets ───────────────────────────────────────────────
{
  const st = computeStress([
    acct('W1', [pos('HYPE', 1, 100, 92)]),
    acct('W2', [pos('HYPE', 2, 100, 93)]),
    acct('W3', [pos('SOL', 1, 100, 40)]),
  ])
  const s10 = st.scenarios.find(s => s.pct === 10 && s.dir < 0)
  t('two wallets listed at 10%', s10 && s10.wallets.length === 2, JSON.stringify(s10?.wallets))
  t('coin deduped', s10 && s10.coins.length === 1 && s10.coins[0] === 'HYPE')
  t('notional summed', s10 && near(s10.notional, 100 + 200), `${s10?.notional}`)
  t('unaffected wallet excluded', s10 && !s10.wallets.includes('W3'))
}

// ── robustness ───────────────────────────────────────────────────────────────
{
  t('no rows', computeStress([]).legs === 0)
  t('undefined rows', computeStress(undefined).legs === 0)
  const st = computeStress([acct('A', [
    pos('A1', 0, 100, 90),          // closed
    pos('A2', 1, 100, null),        // no liq price reported
    pos('A3', 1, 100, 90),          // real
  ])])
  t('closed positions skipped', st.legs === 2)
  t('positions with no liq price are counted as unpriced, not assumed safe', st.unpriced === 1)
  t('unpriced excluded from scenarios', st.scenarios.every(s => !s.coins.includes('A2')))
  t('errored wallets excluded', computeStress([{ error: 'x', positions: [pos('Z', 1, 100, 90)] }]).legs === 0)
}

// ── unprotected positions ────────────────────────────────────────────────────
{
  const rows = [acct('A', [pos('HYPE', 1, 100, 90), pos('SOL', -1, 50, 60)])]
  const none = computeUnprotected(rows, new Set())
  t('with no trigger orders, everything is unprotected', none.positions.length === 2)
  t('notional summed', near(none.notional, 150), `${none.notional}`)
  t('sorted by size desc', none.positions[0].coin === 'HYPE')
  const some = computeUnprotected(rows, new Set(['HYPE']))
  t('a protected coin drops out', some.positions.length === 1 && some.positions[0].coin === 'SOL')
  t('protection matching is case-insensitive',
    computeUnprotected(rows, new Set(['SOL'])).positions.every(p => p.coin !== 'SOL'))
  t('closed positions are not reported as unprotected',
    computeUnprotected([acct('A', [pos('X', 0, 100, 90)])], new Set()).positions.length === 0)
}

// ── render ───────────────────────────────────────────────────────────────────
{
  const rows = [acct('<img src=x>', [pos('HYPE', 1, 100, 92)])]
  const html = stressHtml(computeStress(rows), computeUnprotected(rows, new Set()), fmtUSD)
  t('renders', typeof html === 'string' && html.length > 100)
  t('escapes wallet labels', !html.includes('<img src=x>') && html.includes('&lt;img'))
  t('states the caveat', /does not model cross-margin/.test(html))
  t('shows the closest-to-liquidation headline', /Closest to liquidation/.test(html))
  t('empty when there are no positions at all', stressHtml(computeStress([]), computeUnprotected([], new Set()), fmtUSD) === '')
  const safe = [acct('A', [pos('X', 1, 100, 10)])]   // 90% away
  t('says so when nothing liquidates within 30%',
    /No position liquidates/.test(stressHtml(computeStress(safe), computeUnprotected(safe, new Set(['X'])), fmtUSD)))
}

// ── wiring ───────────────────────────────────────────────────────────────────
{
  const m = fs.readFileSync('src/main.js', 'utf8')
  t('exposure view renders the stress block', /_mobVRenderExposure[\s\S]{0,600}stressHtml\(/.test(m))
  t('protected coins come from trigger orders only', /_protectedCoins[\s\S]{0,500}Take Profit/.test(m))
  t('a plain limit order does not count as protection',
    /_protectedCoins[\s\S]{0,500}\(isTp \|\| isSl\)/.test(m))
  t('alert badge counts unfired alerts only', /_alertCountByCoin[\s\S]{0,400}a\?\.fired/.test(m))
  t('alert badge memo is invalidated on save', /_paSave[\s\S]{0,160}_paCoinCounts = null/.test(m))
  t('bell icon rendered when an alert exists', /alerts \? '🔔' : ''/.test(m))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
