// Max upside on a wallet's track record (the leaderboard's wallet card): the mirror of its max
// drawdown. Kept apart from runup.test.mjs because trackrecord.js is loaded by the strategy
// server — it ships on its own, with the bot restart that implies.
import { trackRecord } from '../../src/trackrecord.js'
let pass = 0, fail = 0
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(ok ? '  PASS' : '  FAIL', n, ok ? '' : `→ ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`) }
const r1 = (x) => x == null ? x : Math.round(x * 10) / 10

const portfolio = [['perpAllTime', {
  pnlHistory: [[1, '0'], [2, '-400'], [3, '600'], [4, '500']],
  accountValueHistory: [[1, '1000'], [2, '800'], [3, '1800'], [4, '1700']],
}]]
const tr = trackRecord({ windows: {}, portfolio })
t('+$1,000 from the low, 125% of the $800 held at the low', [tr.maxUpside.usd, r1(tr.maxUpside.pct), tr.maxUpside.troughAt, tr.maxUpside.peakAt], [1000, 125, 2, 3])
t('…beside its drawdown, which is unchanged', tr.maxDrawdown.usd, 400)
const tiny = trackRecord({ windows: {}, portfolio: [['perpAllTime', { pnlHistory: [[1, '0'], [2, '200']], accountValueHistory: [[1, '3'], [2, '203']] }]] })
t('a $3 account: the dollars, but no percentage that means nothing', [tiny.maxUpside.usd, tiny.maxUpside.pct], [200, null])
t('no PnL history: unknown', trackRecord({ windows: {}, portfolio: [] }).maxUpside, null)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
