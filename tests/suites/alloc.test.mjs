// Pull the REAL _freeMarginUsd + _allocationSlices out of main.js and run them against
// stubbed globals, so this tests the shipped code rather than a copy of it.
import fs from 'fs'

const src = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (name) => {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found`)
  // walk braces from the first { after the signature
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`${name}: unbalanced`)
}

let state = {}
const _posMarkPx = () => 0
const body = `${grab('_freeMarginUsd')}\n${grab('_allocationSlices')}\nreturn { _freeMarginUsd, _allocationSlices }`
const { _allocationSlices } = new Function('state', '_posMarkPx', body)(
  new Proxy({}, { get: (_, k) => state[k] }), _posMarkPx)

let pass = 0, fail = 0
const t = (name, cond, extra = '') => cond
  ? (pass++, console.log('  PASS', name))
  : (fail++, console.log('  FAIL', name, extra))
const near = (a, b) => Math.abs(a - b) < 1e-6

const pos = (coin, szi, marginUsed, positionValue, uPnl) => ({
  position: { coin, szi: String(szi), marginUsed: String(marginUsed),
              positionValue: String(positionValue), unrealizedPnl: String(uPnl),
              leverage: { value: '1' } },
})

// ── with positions and free cash ──────────────────────────────────────────────
state = {
  perpState: { withdrawable: '250', assetPositions: [
    pos('HYPE', 1, 510.79, 5107.95, 125.17),
    pos('PUMP', -1, 234.10, 2341.05, -954.11),
  ]},
  spotState: { balances: [{ coin: 'USDC', total: '100', hold: '40' }] },
}
let r = _allocationSlices()
t('free = perp withdrawable + unheld spot USDC', near(r.free, 310), `got ${r.free}`)
t('used = sum of position margin', near(r.used, 744.89), `got ${r.used}`)
t('total = used + free', near(r.total, 1054.89), `got ${r.total}`)
t('free slice appended', r.slices.length === 3)
t('free slice is pinned LAST', r.slices.at(-1).isFree === true)
t('free slice carries no notional/PnL', r.slices.at(-1).notional === 0 && r.slices.at(-1).uPnl === 0)
t('assets still sorted by margin desc', r.slices[0].coin === 'HYPE' && r.slices[1].coin === 'PUMP')
t('hasPositions true', r.hasPositions === true)
const pcts = r.slices.map(s => (s.margin / r.total) * 100)
t('percentages sum to 100', near(pcts.reduce((a, b) => a + b, 0), 100), `got ${pcts.reduce((a,b)=>a+b,0)}`)
t('HYPE share is of the NEW total (was 46.8% of margin-only)',
  Math.abs(pcts[0] - 48.42) < 0.01, `got ${pcts[0].toFixed(2)}`)

// ── no free cash: behaviour must be exactly as before ─────────────────────────
state = { perpState: { withdrawable: '0', assetPositions: [pos('HYPE', 1, 100, 1000, 5)] },
          spotState: { balances: [] } }
r = _allocationSlices()
t('no free slice when free = 0', r.slices.length === 1 && !r.slices[0].isFree)
t('total unchanged when free = 0', near(r.total, 100))

// ── free cash but NO positions: empty state must still win ────────────────────
state = { perpState: { withdrawable: '5000', assetPositions: [] }, spotState: { balances: [] } }
r = _allocationSlices()
t('hasPositions false with cash only', r.hasPositions === false)

// ── negative / missing withdrawable must not produce a negative slice ─────────
state = { perpState: { withdrawable: '-12', assetPositions: [pos('X', 1, 50, 500, 0)] },
          spotState: { balances: [{ coin: 'USDC', total: '10', hold: '99' }] } }
r = _allocationSlices()
t('negative withdrawable clamps to 0 (no free slice)', r.free === 0 && r.slices.length === 1)

// ── spot USDC fully on hold contributes nothing ───────────────────────────────
state = { perpState: { withdrawable: '0', assetPositions: [pos('X', 1, 50, 500, 0)] },
          spotState: { balances: [{ coin: 'USDC', total: '80', hold: '80' }] } }
r = _allocationSlices()
t('held spot USDC is not free', r.free === 0)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
