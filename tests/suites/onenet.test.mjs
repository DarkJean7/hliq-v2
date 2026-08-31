// Net PnL: one source, or a dash.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n-- the server hands back the pieces, per wallet --')
t('per-wallet settled PnL is returned', srv.includes('perWallet,'))
t('built from the same accrual the total uses',
  srv.includes('settledPnl: acc.realizedPnl + acc.funding - acc.fees'))
t('with its parts, so realized can be shown too', srv.includes('realizedPnl: acc.realizedPnl, fees: acc.fees, funding: acc.funding'))
t('only recorded for a wallet whose accrual succeeded — a failure must not read as zero',
  srv.indexOf('perWallet[String(addr).toLowerCase()]') > srv.indexOf('const acc = await pnlAccrue(addr)'))

console.log('\n-- one accessor, and it refuses rather than guesses --')
const f = grab(cli, 'function _comboPnlForWallet(addr)')
t('it exists', !!f)
t('settled comes from the server, unrealized from this device', f.includes('Number(pw.settledPnl) + u'))
t('a wallet the server has no figure for returns null', f.includes('if (!pw || !Number.isFinite(Number(pw.settledPnl))) return null'))
t('a stale snapshot returns null, using the same age limit as the total',
  f.includes('COMBO_SNAP_MAX_AGE_MS'))
t('a missing unrealized returns null rather than counting it as zero',
  f.includes('if (!Number.isFinite(u)) return null'))
t('it is inert outside the combined view', f.includes('if (!state.isAllAccounts) return null'))
t('lookup is case-insensitive', f.includes('String(addr ?? \'\').toLowerCase()'))

console.log('\n-- every combined surface uses it --')
const card = grab(cli, 'function _maCardHtml(r)')
t('the account cards do', card.includes('_comboPnlForWallet(r.addr)'))
t('and show a dash when it declines, not r.netPnl', !card.includes('fmtPnL(r.netPnl)'))
t('unrealized still renders — it is this device\'s own and always available', card.includes('fmtPnL(r.unrealizedPnl)'))
const sheet = grab(cli, 'function _mobVRenderAccounts(el)') || cli
t('the per-account rows in the accounts sheet do', cli.includes("const _rw = _comboPnlForWallet(r.addr)"))
t('and no longer print r.netPnl', !cli.includes("['Net PnL',    pnlFmt(r.netPnl)"))
const agg = grab(cli, 'function _maAggregateHtml(results)')
t('the desktop aggregate strip does — it never consulted the server at all before',
  agg.includes('_comboPnlSums()'))
t('and dashes when there is nothing authoritative', agg.includes("_cp ? fmtPnL(_cp.net)"))

console.log('\n-- no surface falls back to the per-device sum --')
t('the accounts-sheet total has no row-sum fallback',
  !cli.includes('?? vis.reduce((s, r) => s + (r.error ? 0 : r.netPnl ?? 0), 0)'))
t('it dashes instead', cli.includes('const totalNet    = _cpAll?.net ?? null'))
t('realized and fees come from the same snapshot parts',
  cli.includes('_cpAll?.parts ? _cpAll.parts.realized : null') && cli.includes('_cpAll?.parts ? _cpAll.parts.fees : null'))
t('and render as a dash when absent', cli.includes("totalNet == null ? '\u2014'"))
t('the reason is on the record where the fallback used to be',
  cli.includes('a DIFFERENT basis, not a rougher version of the same one'))

console.log('\n-- the arithmetic that makes cards sum to the header --')
// header  = sum(settled) + sum(unrealized);  card = settled_i + unrealized_i
const wallets = [
  { settled: -120.5, unreal: 40.25 },
  { settled: 88.0,   unreal: -12.75 },
  { settled: -3.25,  unreal: 0 },
]
const cards = wallets.map(w => w.settled + w.unreal)
const header = wallets.reduce((s, w) => s + w.settled, 0) + wallets.reduce((s, w) => s + w.unreal, 0)
t('the cards add up to the header exactly',
  Math.abs(cards.reduce((a, b) => a + b, 0) - header) < 1e-9)
t('and that holds with a zero-unrealized wallet', cards[2] === -3.25)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
