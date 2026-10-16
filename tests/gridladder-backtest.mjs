// Grid Ladder backtest on real Hyperliquid HYPE data.
//
//   npm run gridladder-backtest                       the three regimes + the last 90 days
//   npm run gridladder-backtest -- --days=45          regime window length
//   npm run gridladder-backtest -- --usd=30 --lev=2   override every bot's $/level and leverage
//   npm run gridladder-backtest -- --json=out.json    also write the full result
//
// Candles: Hyperliquid serves the most recent 5000 per interval, so 1h covers ~208 days and 4h
// all of HYPE's history. Each window is run on 1h candles when it is inside that span, 4h when
// not. Funding is the market's own hourly history. The regimes are picked from the data
// (src/gridbacktest.js pickRegimes), and the ladder is FITTED to each window's opening price —
// the default ranges are absolute ($50–$110), and a window from a year when HYPE traded at $25
// would otherwise test five bots that never place an order. The last 90 days run as configured.
import { writeFileSync } from 'node:fs'
import { backtestLadder, fitLadder, pickRegimes } from '../src/gridbacktest.js'
import { DEFAULT_LADDER } from '../src/gridladder.js'

const arg = (k, d) => { const a = process.argv.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d }
const DAYS = +arg('days', 30), USD = arg('usd'), LEV = arg('lev'), JSON_OUT = arg('json')
const API = 'https://api.hyperliquid.xyz/info'
const post = async (body) => {
  for (let k = 0; k < 5; k++) {
    const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (r.status === 429) { await new Promise(s => setTimeout(s, 2000 * (k + 1))); continue }
    if (!r.ok) throw new Error(`${body.type}: HTTP ${r.status}`)
    return r.json()
  }
  throw new Error(`${body.type}: rate limited`)
}
const candles = async (interval) => (await post({ type: 'candleSnapshot', req: { coin: 'HYPE', interval, startTime: 0, endTime: Date.now() } }))
  .map(c => ({ t: c.t, o: +c.o, h: +c.h, l: +c.l, c: +c.c }))
async function fundingFrom(start) {
  const out = []
  let t = start
  for (let k = 0; k < 80; k++) {
    const page = await post({ type: 'fundingHistory', coin: 'HYPE', startTime: t })
    if (!page.length) break
    out.push(...page.map(f => ({ time: f.time, fundingRate: +f.fundingRate })))
    const last = page.at(-1).time
    if (page.length < 500 || last <= t) break
    t = last + 1
  }
  return out
}

const meta = (await post({ type: 'meta' })).universe.find(u => u.name === 'HYPE')
const [c1h, c4h] = [await candles('1h'), await candles('4h')]
console.log(`HYPE: szDecimals ${meta.szDecimals}, max ${meta.maxLeverage}× · ${c4h.length} 4h candles from ${new Date(c4h[0].t).toISOString().slice(0, 10)} · ${c1h.length} 1h candles from ${new Date(c1h[0].t).toISOString().slice(0, 10)}`)
const funding = await fundingFrom(c4h[0].t)
console.log(`funding: ${funding.length} hourly rates`)

const bots = DEFAULT_LADDER.map(b => ({ ...b, ...(USD ? { usd: +USD } : {}), ...(LEV ? { leverage: +LEV } : {}) }))
const reg = pickRegimes(c4h, DAYS)
const windows = [
  ['trending', reg.trending, true], ['choppy', reg.choppy, true], ['crash', reg.crash, true],
  ['last 90 days (as configured)', { from: Date.now() - 90 * 86_400_000, to: Date.now() }, false],
]

const usd = (v) => (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2)
const pct = (v) => (v >= 0 ? '+' : '') + (v * 100).toFixed(1) + '%'
const results = []
for (const [name, w, fit] of windows) {
  if (!w) continue
  const src = w.from >= c1h[0].t ? c1h : c4h
  const cs = src.filter(c => c.t >= w.from && c.t <= w.to)
  if (cs.length < 10) { console.log(`\n${name}: not enough candles`); continue }
  const ladder = fit ? fitLadder(bots, cs[0].o) : bots
  const t0 = Date.now()
  const r = await backtestLadder({ candles: cs, funding: funding.filter(f => f.time >= w.from - 3_600_000 && f.time <= w.to), bots: ladder, szDecimals: meta.szDecimals, maxLeverage: meta.maxLeverage })
  results.push({ name, fitted: fit, interval: src === c1h ? '1h' : '4h', ...r, curve: undefined })
  console.log(`\n── ${name} · ${new Date(r.from).toISOString().slice(0, 10)} → ${new Date(r.to).toISOString().slice(0, 10)} · ${src === c1h ? '1h' : '4h'} candles · HYPE ${r.startPx} → ${r.endPx}${fit ? ' · ladder fitted to the open' : ''} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
  console.log(`  capital ${usd(r.capital)} → ${usd(r.final)}  ${pct(r.ret)}   max drawdown ${(r.maxDrawdown * 100).toFixed(1)}%`)
  console.log(`  grid profit ${usd(r.realized)} over ${r.cycles} cycles · fees ${usd(r.fees)} · funding paid ${usd(r.funding)}${r.liquidations ? ` · ${r.liquidations} bot(s) LIQUIDATED` : ''}`)
  console.log(`  holding the same capital in HYPE: ${usd(r.hold.pnl)} ${pct(r.hold.ret)}   → ladder ${r.pnl >= r.hold.pnl ? 'beat' : 'lagged'} holding by ${usd(Math.abs(r.pnl - r.hold.pnl))}`)
  for (const b of r.bots) console.log(`    bot ${b.id} ${b.range.padEnd(15)} ${usd(b.pnl).padStart(9)}  realized ${usd(b.realized).padStart(8)}  ${String(b.cycles).padStart(4)} cycles  holds ${b.inventory.toFixed(2)}${b.liquidated ? `  LIQUIDATED @ ${b.liquidated.px.toFixed(3)}` : ''}`)
}
if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(results, null, 2)); console.log(`\nwrote ${JSON_OUT}`) }
