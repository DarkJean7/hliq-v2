// Which signals actually call these markets? (Outlook, "do 1")
//
// Replays every candidate in src/outlooksignals.js — and the three signals already in the score —
// over a year of REAL 4h candles across many markets, at 4h / 24h / 3d / 7d, and prints which ones
// beat chance pooled AND in both halves of the year. Only those belong in the score.
//
// It reads Hyperliquid from THIS machine's IP — the one you trade from — so it is paced at about 8
// weight a second (~40% of the 1,200/min budget), backs off on a 429, and caches every answer in
// tests/.research-cache so a second run costs nothing. ~95 weight a market for candles, ~135 more
// for two months of funding with --funding.
//
//   npm run research:signals                         20 liquid markets, 24h and the rest
//   npm run research:signals -- --coins=SOL,ARB,HYPE --funding
//   npm run research:signals -- --out=tests/research/signal-results.json
//
// Not part of `npm test`: it needs the network, and its answer is a decision, not a regression.
import fs from 'fs'
import path from 'path'
import { pastSamples, vol4h, PAST_HORIZONS, CANDLE_FACTORS } from '../src/outlook.js'
import { CANDIDATES, readCandidates, scoreSignal } from '../src/outlooksignals.js'

const arg = (k, d) => process.argv.find(a => a.startsWith(`--${k}=`))?.split('=')[1] ?? d
const has = (k) => process.argv.includes(`--${k}`)
const COINS = arg('coins', 'BTC,ETH,SOL,HYPE,XRP,DOGE,SUI,AVAX,LINK,ARB,OP,APT,SEI,TIA,INJ,WIF,ENA,NEAR,LTC,BNB').split(',').map(s => s.trim()).filter(Boolean)
const FUNDING = has('funding')
const OUT = arg('out', '')
const CACHE = path.join('tests', '.research-cache')
const PACE = 8          // weight per second
const DAY = 864e5

fs.mkdirSync(CACHE, { recursive: true })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
let spent = 0
async function info(body, weight) {
  for (let tries = 0; ; tries++) {
    const r = await fetch('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (r.status === 429) { if (tries > 4) throw new Error('rate limited'); console.log('  429 — waiting 30s'); await sleep(30_000); continue }
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    const w = weight(j)
    spent += w
    await sleep(w / PACE * 1000)
    return j
  }
}
async function cached(name, get) {
  const f = path.join(CACHE, name.replace(/[^a-z0-9._-]/gi, '_') + '.json')
  try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); if (Date.now() - d.at < 12 * 3600e3) return d.data } catch {}
  const data = await get()
  fs.writeFileSync(f, JSON.stringify({ at: Date.now(), data }))
  return data
}
const candles = (coin, iv, days) => cached(`${coin}-${iv}-${days}`, () => info(
  { type: 'candleSnapshot', req: { coin, interval: iv, startTime: Date.now() - days * DAY, endTime: Date.now() } },
  (j) => 20 + Math.ceil((Array.isArray(j) ? j.length : 0) / 60))
  .then(j => (Array.isArray(j) ? j : []).map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c })).filter(k => k.c > 0)))
async function funding(coin, days) {
  return cached(`${coin}-funding-${days}`, async () => {
    const out = []
    let from = Date.now() - days * DAY
    for (let k = 0; k < 10; k++) {
      const j = await info({ type: 'fundingHistory', coin, startTime: from }, (j) => 20 + Math.ceil((Array.isArray(j) ? j.length : 0) / 20))
      if (!Array.isArray(j) || !j.length) break
      for (const x of j) out.push({ t: +x.time, rate: +x.fundingRate })
      const last = +j.at(-1).time
      if (j.length < 500 || last <= from) break
      from = last + 1
    }
    return out
  })
}

// ── replay ──────────────────────────────────────────────────────────────────
const ids = [...CANDLE_FACTORS, ...Object.keys(CANDIDATES).filter(id => FUNDING || !CANDIDATES[id].needs)]
const rows = Object.fromEntries(ids.map(id => [id, Object.fromEntries(PAST_HORIZONS.map(h => [h, []]))]))
let markets = 0
console.log(`\nReplaying ${COINS.length} markets, a year of 4h candles each${FUNDING ? ', with two months of funding' : ''} …`)
for (const coin of COINS) {
  try {
    const c4 = await candles(coin, '4h', 365), c1 = await candles(coin, '1d', 1000)
    const fund = FUNDING ? await funding(coin, 60) : null
    if (c4.length < 400) { console.log(`  ${coin}: only ${c4.length} 4h candles, skipped`); continue }
    const S = pastSamples(c4, c1)
    if (!S.length) continue
    const mid = S[Math.floor(S.length / 2)].t
    for (const x of S) {
      const v4 = vol4h(c4.slice(Math.max(0, x.i - 180), x.i + 1))
      const cand = readCandidates(c4, x.i, v4, { funding: fund }, ids.filter(id => CANDIDATES[id]))
      const vals = { ...x.f, ...cand }
      for (const id of ids) {
        if (vals[id] == null) continue
        for (const h of PAST_HORIZONS) if (x.out[h]) rows[id][h].push({ v: vals[id], ret: x.out[h].ret, half: x.t < mid ? 0 : 1 })
      }
    }
    markets++
    console.log(`  ${coin}: ${S.length} days   (weight spent so far ${spent})`)
  } catch (e) { console.log(`  ${coin}: ${e.message}`) }
}

// ── verdict ─────────────────────────────────────────────────────────────────
const pct = (x) => x == null ? '   —' : (x * 100).toFixed(1).padStart(5) + '%'
const num = (x, d = 1) => x == null || !Number.isFinite(x) ? '—' : x.toFixed(d)
const results = []
for (const h of PAST_HORIZONS) {
  console.log(`\n── ${h}h ─────────────────────────────────────────────────────────────────────────`)
  console.log('signal          calls   right  chance      z   edge(bps)     t   1st half   2nd half   PASS')
  for (const id of ids) {
    const r = scoreSignal(rows[id][h], h)
    results.push({ id, h, ...r })
    if (!r.n) { console.log(`${id.padEnd(14)}     0`); continue }
    const half = (x) => x.n ? `${pct(x.rate)}/${pct(x.chance).trim()}` : '—'
    console.log(`${id.padEnd(14)} ${String(r.n).padStart(6)}  ${pct(r.rate)}  ${pct(r.chance)}  ${num(r.z).padStart(5)}  ${num(r.edgeBps).padStart(9)}  ${num(r.t).padStart(5)}  ${half(r.halves[0]).padStart(10)}  ${half(r.halves[1]).padStart(10)}   ${r.pass ? 'YES' : ''}`)
  }
}
const winners = results.filter(r => r.pass)
console.log(`\n${markets} markets · ${spent} weight spent`)
console.log(winners.length ? `Earned a place: ${winners.map(w => `${w.id} @ ${w.h}h`).join(', ')}` : 'No signal beat chance pooled and in both halves.')
if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), coins: COINS, markets, funding: FUNDING, results: results.map(({ halves, ...r }) => ({ ...r, halves })) }, null, 1))
  console.log(`Saved ${OUT}`)
}
