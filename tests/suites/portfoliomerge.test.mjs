// The combined portfolio curve must not be the sum of whoever answered first.
//
// Reported as: "this images where taken seconds apart, the spikes keep hapenning" — the
// Portfolio sheet read $6,692.38 (+152.68%) and then $6,804.30 (+$6,801.07, no percentage at
// all) within seconds, with nothing traded in between.
//
// _mergeSeries summed the wallets that had history and silently skipped the ones whose
// portfolio fetch was still out. One more wallet landing added its balance to the total AND
// moved the earliest sample back, so the baseline the percentage hangs off moved too — which
// is why the figure and its percentage jumped together, and why the percentage vanished
// entirely on one render.
//
// Not loaded is not the same as holds nothing. This is the same distinction that has now cost
// this codebase four separate user-visible bugs.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig)
  if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

// The real function, run against synthetic wallets.
const mergeSeries = new Function(`
  ${grab(cli, 'function _sampleAt(')}
  ${grab(cli, 'function _mergeSeries(')}
  return _mergeSeries
`)()

const wallet = (vals, period = 'allTime') => ({
  portfolio: [[period, { accountValueHistory: vals.map((v, i) => [1000 + i * 100, String(v)]), pnlHistory: [] }]],
})
const lastOf = (s) => (s.length ? Number(s[s.length - 1][1]) : null)

console.log(nl + '-- a wallet that has not answered stops the total --')
{
  const loaded  = [wallet([100, 200]), wallet([300, 400])]
  const pending = [wallet([100, 200]), { /* fetch still out: no portfolio at all */ }]

  t('two loaded wallets sum', lastOf(mergeSeries(loaded, 'allTime', 'accountValueHistory')) === 600,
    lastOf(mergeSeries(loaded, 'allTime', 'accountValueHistory')))
  // This used to return 200 — the half that had arrived — and the chart printed it.
  t('one still loading returns nothing, not half a total',
    mergeSeries(pending, 'allTime', 'accountValueHistory').length === 0)
  t('so the caller cannot publish a partial sum as the combined value',
    mergeSeries(pending, 'allTime', 'pnlHistory').length === 0)
}

console.log(nl + '-- but a wallet that answered and holds nothing is fine --')
{
  // The distinction that makes this usable: an EMPTY history on a wallet that did reply is a
  // real zero, not a missing fetch, and must not blank the whole chart.
  const withEmpty = [wallet([100, 200]), { portfolio: [['allTime', { accountValueHistory: [], pnlHistory: [] }]] }]
  t('an empty history is treated as zero, not as unknown',
    lastOf(mergeSeries(withEmpty, 'allTime', 'accountValueHistory')) === 200)
  // A wallet that errored is reported elsewhere and never counted here.
  const withError = [wallet([100, 200]), { error: 'HL 429' }]
  t('an errored wallet does not block the chart either',
    lastOf(mergeSeries(withError, 'allTime', 'accountValueHistory')) === 200)
  t('and an empty result set is still empty', mergeSeries([], 'allTime', 'accountValueHistory').length === 0)
}

console.log(nl + '-- the reason is recorded where the code is --')
{
  t('the two readings are written down', cli.includes('$6,692.38 and $6,804.30'))
  t('and the rule', cli.includes('Not loaded is not the same as holds nothing'))
  t('the check is on the portfolio being absent, not on the period',
    cli.includes('if (!Array.isArray(r.portfolio) || !r.portfolio.length) return []'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
