// Liquidation estimates use the market's own maintenance rate, not a flat 0.5%.
// Reported: "liquidation price does not match" — ARM (HIP-3, 10× max), 1 ARM at 10× isolated:
// the ticket said $230.46, Hyperliquid $240.92.
import fs from 'fs'
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// Hyperliquid: maintenance = half the initial margin at max leverage.
const mmrOf = (maxLev) => 1 / (2 * maxLev)
const isoLongLiq = (entry, size, margin, mmr) => (entry * size - margin) / (size * (1 - mmr))
const arm = isoLongLiq(254.785, 1, 25.48, mmrOf(10))
const flat = isoLongLiq(254.785, 1, 25.48, 0.005)
t('ARM with its own rate (5%) lands within 0.5% of Hyperliquid\'s $240.92', Math.abs(arm / 240.92 - 1) < 0.005, arm)
t('the flat 0.5% was the $230.46 on the ticket, ~4% too far from entry', Math.abs(flat - 230.46) < 0.02 && flat < 240.92 * 0.97, flat)

t('one helper, 1 / (2 × max leverage), from the HIP-3-aware max', /function _mmrOf\(coin\) \{\n  const m = Number\(_coinMaxLev\(coin\)\)\n  return m > 0 \? 1 \/ \(2 \* m\) : 0\.01\n\}/.test(CLI))
t('the desktop preview, the phone ticket and the grid plan all use it', (CLI.match(/const mmr = _mmrOf\(coin\)/g) || []).length === 2 && CLI.includes('const _MMR = _mmrOf(plan.coin)'))
t('no flat 0.005 maintenance rate is left', !/const (mmr|_MMR) = 0\.005/.test(CLI))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
