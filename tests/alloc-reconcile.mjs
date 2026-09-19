// Does the allocation wheel add up to the real account?
//
//   npm run alloc-reconcile -- 0xabc… 0xdef…        (one or more wallets)
//
// NOT part of `npm test` and not part of the browser gate: it talks to Hyperliquid and, with
// more than one address, to insolvent.trade. tests/allocation-browser.mjs proves the
// arithmetic against fixtures; this answers the different question of whether the four
// buckets still add up to a real account with real HIP-3 positions, real resting orders and
// real spot tokens in it. tests/hl-weight.mjs is the precedent for keeping a network tool
// here rather than in a scratch folder that dies with the session.
//
// Reported as: "the whole all accounts equity is ~6,8k but in allocation it totals to just
// ~2,7k. the missing equity is in orders, spot. add them." Run against the eight wallets it
// was reported on, the old two-bucket wheel came to $2,827 — the ~2.7k in the report — while
// the account was worth $6,890. With orders and spot counted, and HIP-3 fanned the way the
// app fans it, the four buckets came to $6,891.62 against an authoritative $6,890.38.
//
// The gap it CANNOT close is HIP-3 withdrawable: fetchClearinghouseState merges builder-dex
// positions into the main state but not their free margin, so nothing in the app counts it.
// Measured at $1.15 across eight wallets, which is why it is documented rather than fixed.
import { orderMarginByCoin, spotByCoin, SLICE_DUST } from '../src/alloc.js'
import { isSpotCoin } from '../src/format.js'

const ADDRS = process.argv.slice(2).filter(a => /^0x[0-9a-fA-F]{40}$/.test(a))
if (!ADDRS.length) {
  console.error('usage: npm run alloc-reconcile -- 0xADDR [0xADDR …]')
  process.exit(2)
}

const post = async (b) => (await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
})).json()
const n   = x => Number(x ?? 0)
const usd = (x, w = 10) => x.toFixed(2).padStart(w)

const [mids, sm, meta, dexes] = await Promise.all([
  post({ type: 'allMids' }), post({ type: 'spotMeta' }), post({ type: 'meta' }),
  post({ type: 'perpDexs' }).catch(() => []),
])
const pairOf = {}
for (const u of (sm.universe ?? [])) { const tk = (sm.tokens ?? [])[u.tokens[0]]; if (tk) pairOf[tk.name] = u.name }
const maxLev = {}
for (const u of (meta.universe ?? [])) maxLev[u.name] = n(u.maxLeverage) || 1
const spotMid = (c) => n(mids[pairOf[c]] ?? mids[c])
const h3Dexes = (dexes || []).filter(d => d && d.name).map(d => d.name)

const T = { pos: 0, ord: 0, spot: 0, free: 0, h3free: 0 }
const rows = []

for (const A of ADDRS) {
  const [cs, spot, ords] = await Promise.all([
    post({ type: 'clearinghouseState', user: A }),
    post({ type: 'spotClearinghouseState', user: A }),
    post({ type: 'frontendOpenOrders', user: A }),
  ])
  const ms  = cs.marginSummary ?? {}
  const pos = (cs.assetPositions ?? []).reduce((s, ap) => s + Math.abs(n(ap.position?.marginUsed)), 0)
  const wd  = n(cs.withdrawable)
  // accountValue - totalMarginUsed - withdrawable. What the row carries as _orderMargin.
  const ordSaid = Math.max(0, n(ms.accountValue) - pos - wd)

  // The app fans the builder dexes and merges their positions into the same arrays, so a
  // reconciliation that skips them understates by exactly that margin — which is most of
  // what looked like a 2% error the first time this was run.
  let h3Pos = 0, h3Ord = 0, h3Free = 0
  for (const dex of h3Dexes) {
    const c = await post({ type: 'clearinghouseState', user: A, dex }).catch(() => null)
    const av = n(c?.marginSummary?.accountValue)
    if (!(av > 0.01)) continue
    const pm = (c?.assetPositions ?? []).reduce((s, ap) => s + Math.abs(n(ap.position?.marginUsed)), 0)
    const w  = n(c?.withdrawable)
    h3Pos += pm; h3Free += w; h3Ord += Math.max(0, av - pm - w)
  }

  const levOf = (coin) => {
    const p = (cs.assetPositions ?? []).find(ap => ap.position?.coin === coin)
    return n(p?.position?.leverage?.value) || maxLev[coin] || 50
  }
  const by    = orderMarginByCoin(ords, levOf, c => isSpotCoin(c, null))
  const est   = [...by.values()].filter(v => !v.cash && !String(v.coin).includes(':'))
    .reduce((s, v) => s + v.margin, 0)
  const scale = (ordSaid > SLICE_DUST && est > SLICE_DUST) ? ordSaid / est : 1
  const ord   = ([...by.values()].reduce((s, v) =>
    s + ((!v.cash && !String(v.coin).includes(':')) ? v.margin * scale : v.margin), 0) || ordSaid) + h3Ord

  const usdc = (spot.balances ?? []).find(b => b.coin === 'USDC')
  const free = Math.max(0, wd) + Math.max(0, n(usdc?.total) - n(usdc?.hold))
  const sv   = [...spotByCoin((spot.balances ?? []), spotMid).values()]
    .filter(h => h.usd > SLICE_DUST).reduce((s, h) => s + h.usd, 0)

  const p = pos + h3Pos
  T.pos += p; T.ord += ord; T.spot += sv; T.free += free; T.h3free += h3Free
  rows.push({ A, pos: p, ord, spot: sv, free, sum: p + ord + sv + free })
}

console.log('')
console.log('  wallet     positions     orders       spot       free          total')
for (const r of rows) {
  console.log('  ' + r.A.slice(0, 8) + ' ' + usd(r.pos) + ' ' + usd(r.ord) + ' ' +
              usd(r.spot) + ' ' + usd(r.free) + '   =  ' + usd(r.sum))
}
const wheel = T.pos + T.ord + T.spot + T.free
console.log('')
console.log('  in positions ' + usd(T.pos))
console.log('  in orders    ' + usd(T.ord))
console.log('  spot         ' + usd(T.spot))
console.log('  free         ' + usd(T.free))
console.log('  WHEEL TOTAL  ' + usd(wheel))
// What the wheel would have shown before orders and spot were counted — the number in the
// bug report. Kept in the output so the regression is obvious if either ever drops out again.
console.log('  (two buckets ' + usd(T.pos + T.free) + '  <- what was reported as wrong)')

if (ADDRS.length > 1) {
  const combined = await (await fetch('https://insolvent.trade/api/combined', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ addrs: ADDRS }),
  })).json().catch(() => null)
  const srv = n(combined?.accountValue)
  if (srv > 0) {
    console.log('')
    console.log('  server says  ' + usd(srv))
    console.log('  difference   ' + usd(wheel - srv) + '   ' + ((wheel - srv) / srv * 100).toFixed(2) + '%')
    console.log('  of which HIP-3 free margin, which nothing counts: ' + usd(T.h3free))
  }
}
