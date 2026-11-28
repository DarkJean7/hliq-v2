// Max upside: the mirror of max drawdown, wherever the app shows one.
// "in the whole app we have some instances where it displays the max drawdown, lets also include
// max upside". The largest climb from a low to a LATER high — never a high before the low.
// (A wallet's track record has its own suite, trackupside.test.mjs: trackrecord.js is loaded by
// the strategy server, so it ships on its own.)
import { maxRunupPct, maxRunupUsd } from '../../src/runup.js'
import { maxAdverse } from '../../src/drawdown.js'
let pass = 0, fail = 0
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(ok ? '  PASS' : '  FAIL', n, ok ? '' : `→ ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`) }
const r1 = (x) => x == null ? x : Math.round(x * 10) / 10

// ── an equity curve, in percent of the low ──
t('100 → 80 → 120: the climb is from the low, +50%', r1(maxRunupPct([[1, 100], [2, 80], [3, 120]])), 50)
t('a high BEFORE the low is not a climb: 150 → 100 → 110 is +10%', r1(maxRunupPct([[1, 150], [2, 100], [3, 110]])), 10)
t('a curve that only fell has no upside — 0, not unknown', maxRunupPct([[1, 100], [2, 90], [3, 80]]), 0)
t('fewer than two points is unknown', maxRunupPct([[1, 100]]), null)
t('{ x, y } and bare numbers read the same', [r1(maxRunupPct([{ x: 1, y: 100 }, { x: 2, y: 80 }, { x: 3, y: 120 }])), r1(maxRunupPct([100, 80, 120]))], [50, 50])
t('non-finite points are skipped', r1(maxRunupPct([[1, 100], [2, NaN], [3, 80], [4, 120]])), 50)

// ── a PnL curve, in dollars and when ──
const u = maxRunupUsd([[1, 0], [2, -300], [3, 200], [4, 100]])
t('PnL 0 → −300 → +200: +$500, from the low to the high', [u.rise, u.from, u.to], [500, 2, 3])
t('a PnL curve that only fell: $0', maxRunupUsd([[1, 0], [2, -50]]).rise, 0)

// ── one trade: its best point, from the same candles as its worst ──
const candles = [{ t: 0, l: 99, h: 101 }, { t: 60e3, l: 95, h: 104 }, { t: 120e3, l: 97, h: 112 }]
const long = maxAdverse({ side: 'LONG', entryPx: 100, entryTime: 0, exitTime: 180e3, size: 2 }, candles)
t('a long: worst −5% at the low, best +12% at the high, $24 on 2', [long.pct, r1(long.up.pct), r1(long.up.usd), long.up.px], [-5, 12, 24, 112])
const short = maxAdverse({ side: 'SHORT', entryPx: 100, entryTime: 0, exitTime: 180e3, size: 1 }, candles)
t('a short: best is the LOWEST low, +5%', [r1(short.up.pct), short.up.px], [5, 95])
const never = maxAdverse({ side: 'LONG', entryPx: 120, entryTime: 0, exitTime: 180e3, size: 1 }, candles)
t('a trade that never got above its entry: upside exactly 0', never.up.pct, 0)
t('no candles is still unknown, not zero', maxAdverse({ side: 'LONG', entryPx: 100, entryTime: 0, exitTime: 1 }, []), null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
