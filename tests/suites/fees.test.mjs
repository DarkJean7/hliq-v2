// What "after fees" counts, and the USDC value on a history row.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

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

// The arithmetic the summary line does, driven directly.
const calc = new Function('fills', 'funding', `
  const closes = fills.filter(f => Number(f.closedPnl) !== 0)
  const realized = closes.reduce((a, f) => a + Number(f.closedPnl), 0)
  const fees     = (fills ?? []).reduce((a, f) => a + Number(f.fee ?? 0), 0)
  const net      = realized - fees
  const fund = (funding ?? [])
    .filter(x => String(x.coin ?? '').toUpperCase() === String(fills?.[0]?.coin ?? '').toUpperCase())
    .reduce((a, x) => a + Number(x.usdc ?? 0), 0)
  const wins = closes.filter(f => Number(f.closedPnl) - Number(f.fee ?? 0) > 0).length
  return { realized, fees, net, fund, wins, closed: closes.length }
`)

// One round trip: buy (opens, no closedPnl, but a REAL fee), sell (closes).
const round = [
  { coin: 'HYPE', closedPnl: 0,  fee: 2 },
  { coin: 'HYPE', closedPnl: 100, fee: 3 },
]
console.log('\n── "after fees" must mean every fee ──')
const r = calc(round, [])
t('realized is the gross closed PnL', r.realized === 100)
// The bug: only the closing fill's fee was subtracted, so the entry fee vanished and the
// figure claimed $97 was kept when $95 was.
t('the ENTRY fee is counted, not just the exit fee', r.fees === 5, String(r.fees))
t('so the net is 100 − 5, not 100 − 3', r.net === 95, String(r.net))
t('an opening fill contributes fee but no realized PnL', calc([round[0]], []).realized === 0)
t('and is not counted as a closed trade', calc(round, []).closed === 1)
t('a fee-free fill does not break the sum', calc([{ coin: 'X', closedPnl: 10 }], []).net === 10)
t('a coin never traded nets zero rather than NaN', calc([], []).net === 0)

console.log('\n── funding is shown apart, because it is not a fee ──')
const fund = [{ coin: 'HYPE', usdc: -19.27 }, { coin: 'SOL', usdc: 5 }]
t('only this coin\'s funding counts', calc(round, fund).fund === -19.27)
t('case does not split a coin from its funding',
  calc([{ coin: 'hype', closedPnl: 1, fee: 0 }], fund).fund === -19.27)
t('funding is NOT folded into the after-fees figure', calc(round, fund).net === 95)
t('a coin with no funding rows reports zero', calc([{ coin: 'ZZZ', closedPnl: 1 }], fund).fund === 0)
t('funding paid and received both count, by sign',
  calc([{ coin: 'A', closedPnl: 1 }], [{ coin: 'A', usdc: -3 }, { coin: 'A', usdc: 8 }]).fund === 5)

console.log('\n── the summary line ──')
const sc = grab(cli, 'function _scTradesHtml(fills, funding = [])')
t('every fee on the coin is summed, not just the closes',
  sc.includes('const fees     = (fills ?? []).reduce((a, f) => a + Number(f.fee ?? 0), 0)'))
t('the label says "after fees" — it is a result, not a subtraction of one fee',
  sc.includes("_T('after fees'"))
t('the parts are shown so the number can be checked',
  sc.includes("_T('realized'") && sc.includes("_T('fees'"))
t('funding appears only when there is any', sc.includes('fund !== 0 ?'))
t('and is labelled as funding, not as a fee', sc.includes("_T('funding', 'financiación')"))
t('the win count still judges a trade on its own fees', sc.includes('Number(f.closedPnl) - Number(f.fee ?? 0) > 0'))
t('why entry fees were missing is written down', sc.includes('charges on the way IN as well as on the way out'))

// The spot/perp rule moved to format.js (isSpotCoin) so History and the Calendar share
// one implementation. calspot.test.mjs drives the real exported function; scraping it
// out of main.js here would only re-test a one-line delegation.

console.log('\n── history: the USDC value of a fill ──')
const hist = cli.slice(cli.indexOf('const _isSpot   = _isSpotFill(f.coin)'), cli.indexOf('const btn = (dir, disabled)'))
t('the fill\'s notional is computed', hist.includes('const _ntl      = Number(f.notional ?? 0) || (_sz * (parseFloat(f.px) || 0))'))
t('and shown under the size @ price line', hist.includes("_isSpot ? '$' + fmtUSD(_ntl)"))
t('ONLY on spot — a perp keeps its PnL in that slot',
  hist.includes("pnl !== 0 ? (pnl >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(pnl))"))
t('and a perp with no closed PnL is a dash again, not a notional', hist.includes(": '—'}</span>"))
t('the spot check is by market id, computed once per row', hist.includes('const _isSpot   = _isSpotFill(f.coin)'))
t('a closing perp fill keeps its share button', hist.includes('trade-share-btn'))
t('a missing notional falls back to size x price rather than NaN',
  hist.includes('|| (_sz * (parseFloat(f.px) || 0))'))

// 0.2 HYPE @ $81.092 = $16.22, the case from the report.
const ntl = new Function('f', `
  const _sz = parseFloat(f.sz) || 0
  const _ntl = Number(f.notional ?? 0) || (_sz * (parseFloat(f.px) || 0))
  return _ntl`)
t('0.2 @ $81.092 reads as $16.22', Math.abs(ntl({ sz: '0.2', px: '81.092' }) - 16.2184) < 1e-6)
t('a supplied notional wins over recomputing it', ntl({ sz: '1', px: '2', notional: 99 }) === 99)
t('a zero-size fill is zero, not NaN', ntl({ sz: '0', px: '5' }) === 0)
t('junk yields zero rather than NaN', ntl({ sz: 'x', px: 'y' }) === 0)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
