// Which grid levels are still holding their lot (src/gridheld.js).
//
// Reported: "the grid bot is buying the same level multiple times without selling" — HYPE,
// $70–$90 long grid, 10 levels, average entry ~$79.5 from older lots. It bought 5.62 at $70,
// the profit gate put the exit at $81/$83 instead of $72.22, and with nothing resting at $72.22
// the bot took $70 to be free and bought it again: 15.87 → 21.49 → 27.11 HYPE, nothing sold.
// The end-to-end replay against the real script is tests/gridheld-sim.mjs.
import fs from 'fs'
import { levelOf, applyFill, heldFromFills, clampToInventory, isHeld } from '../../src/gridheld.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const step = 20 / 9
const P = Array.from({ length: 10 }, (_, i) => Math.round((70 + i * step) * 1000) / 1000)   // 70, 72.222, … 90
const L = { prices: P, isShort: false, coin: 'HYPE' }
const f = (side, px, sz, time) => ({ coin: 'HYPE', side, px: String(px), sz: String(sz), time })

console.log(nl + '-- levels --')
t('an order on a level maps to it', levelOf(70, P) === 0 && levelOf(81.111, P) === 5)
t('a price between levels maps to none', levelOf(71.1, P) === -1)

console.log(nl + '-- the report --')
{
  const h = new Map()
  applyFill(h, f('B', 70, 5.62, 1), L)
  t('a $70 buy holds level 0', isHeld(h, 0, 5.62))
  applyFill(h, f('A', 81.111, 2, 2), L)
  t('a third of it sold does not free it', isHeld(h, 0, 5.62), [...h])
  applyFill(h, f('A', 83.333, 2.99, 3), L)
  t('most of it sold, wherever the gate put it: free (exit chunks never match a lot exactly)', !isHeld(h, 0, 5.62), [...h])
  applyFill(h, f('A', 85.556, 0.63, 4), L)
  t('and the rest sold: nothing left on it', !h.has(0), [...h])
}

console.log(nl + '-- an ordinary grid behaves as before --')
{
  const h = heldFromFills([f('B', 72.222, 5.45, 1), f('B', 70, 5.62, 2), f('A', 72.222, 5.62, 3)], L)
  t('the sell one level up frees the level below it', !isHeld(h, 0, 5.62) && isHeld(h, 1, 5.45), [...h])
  const h2 = heldFromFills([f('B', 72.222, 5.45, 1), f('A', 74.444, 5.45, 2)], L)
  t('a full cycle leaves nothing held', h2.size === 0, [...h2])
}

console.log(nl + '-- what does not count --')
{
  const h = heldFromFills([f('B', 71.1, 3, 1), { ...f('B', 70, 5, 2), coin: 'SOL' }], L)
  t('fills off the levels, or on another coin, hold nothing', h.size === 0, [...h])
  t('a rounding remainder does not lock a level', !isHeld(new Map([[0, 0.01]]), 0, 5.62))
}

console.log(nl + '-- held can never exceed the position --')
{
  const h = new Map([[0, 5.62], [1, 5.45], [3, 5.2]])
  clampToInventory(h, 11, L)
  t('a long releases its highest levels first', !h.has(3) && isHeld(h, 0, 5.62) && isHeld(h, 1, 5.45), [...h])
  clampToInventory(h, 0, L)
  t('a closed position frees everything', h.size === 0, [...h])
}

console.log(nl + '-- short grids, mirrored --')
{
  const S = { prices: P, isShort: true, coin: 'HYPE' }
  const h = heldFromFills([f('A', 90, 4.4, 1), f('A', 87.778, 4.5, 2), f('B', 87.778, 4.4, 3)], S)
  t('a cover one level down frees the level above it', !isHeld(h, 9, 4.4) && isHeld(h, 8, 4.5), [...h])
  const c = new Map([[9, 4.4], [5, 4.9]])
  clampToInventory(c, 4.5, S)
  t('a short releases its lowest levels first', isHeld(c, 9, 4.4) && !isHeld(c, 5, 4.9), [...c])
}

console.log(nl + '-- wired into the bot --')
{
  const src = fs.readFileSync('strategies/grid.js', 'utf8').replace(/\r\n/g, '\n')
  const rec = src.slice(src.indexOf('async function reconcile()'), src.indexOf('// ─── MAIN'))
  t('a held level places no new entry', /isHeld\(heldLots, i, entrySzAt\(i, szDecimals\)\)\) continue/.test(rec))
  t('and nothing is entered before the held levels are known', /heldUpto < 0 \|\| isHeld/.test(rec))
  t('new fills are read BEFORE the entries, not after', rec.indexOf('await updateRealized()') > 0 && rec.indexOf('await updateRealized()') < rec.indexOf('── ENTRIES'))
  t('built from fills, so a restart does not forget', /heldFromFills\(fills/.test(src))
  t('orders from a previous run are adopted for fill logging', /trackedOids\.has\(e\.oid\)\) trackedOids\.set/.test(rec))
  // reconcile() declares its own `held` string for the SCAN line; a module-level `held` used
  // inside it would hit the temporal dead zone and throw on every cycle.
  t('the module state does not share a name with reconcile\'s locals', !/^let held\b/m.test(src))
}

console.log(nl + '-- and a deploy actually runs it --')
{
  // A bot reads src/gridheld.js when hliq-strat spawns it. The restart gate hashed only what
  // server.js imports, so a change to this module alone would have shipped to disk and sat there.
  const wf = fs.readFileSync('.github/workflows/deploy.yml', 'utf8')
  t('CI hashes what the bot scripts import, not only server.js', /node serverdeps\.mjs server\.js strategies\/\*\.js/.test(wf))
}

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
