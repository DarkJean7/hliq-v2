// A fake Hyperliquid for running a real bot process end to end: preloaded with
//   node --import ./tests/fakehl.mjs strategies/portfolio.js …
// it replaces fetch, so the bot's SDK talks to this file instead of the exchange, and speeds up
// the clock (FAKE_SPEED× — a 4-hour candle passes in seconds). IOC orders fill at the mid;
// trigger orders rest and fill when the price crosses them; positions and fills are kept, and
// every exchange action is appended to FAKE_LOG as a JSON line for the driver to check.
// Driver: tests/pfbot-e2e.mjs. Prices: FAKE_PRICES = { coin: [[hoursAfterT0, price], …] }, a
// step function from FAKE_T0 (before the first step: the first price).
import fs from 'node:fs'

const SPEED = Number(process.env.FAKE_SPEED || 900)
const T0 = Number(process.env.FAKE_T0)
const START = Number(process.env.FAKE_START || T0)
const PRICES = JSON.parse(process.env.FAKE_PRICES || '{}')
const LOG = process.env.FAKE_LOG
const H = 3_600_000

// The clock starts at the bot's FIRST request, not at process start: loading the SDK takes a
// second or more, and at 900× that used to burn a quarter of a virtual hour before the bot had
// looked at anything — more on a loaded machine, which is how a short run could end before the
// bot had saved its ledger at all.
const realNow = Date.now.bind(Date)
let REAL0 = null
Date.now = () => START + (REAL0 == null ? 0 : (realNow() - REAL0) * SPEED)
const rt = globalThis.setTimeout
globalThis.setTimeout = (fn, ms, ...a) => rt(fn, Math.max(0, (Number(ms) || 0) / SPEED), ...a)

const priceAt = (coin, t) => {
  const steps = PRICES[coin] ?? [[0, 100]]
  let p = steps[0][1]
  for (const [h, v] of steps) if (t >= T0 + h * H) p = v
  return p
}
// A coin named "@N" is a SPOT pair (asset id 10000 + N): its base token is "TKN<N>", 2 size
// decimals; balances, not positions; bought with the spot USDC balance (FAKE_SPOT_USDC).
const isSpot = (c) => c.startsWith('@')
const universe = Object.keys(PRICES).filter(c => !isSpot(c)).map(name => ({ name, szDecimals: 4, maxLeverage: 20 }))
const spotPairs = Object.keys(PRICES).filter(isSpot).map(c => ({ name: c, index: Number(c.slice(1)) }))
const tokenOf = (c) => 'TKN' + c.slice(1)
// The exchange outlives the bot: FAKE_STATE keeps positions, fills and resting orders across a
// restart, as Hyperliquid would.
const STATE = process.env.FAKE_STATE
const saved = STATE && fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : {}
const pos = saved.pos ?? {}, fills = saved.fills ?? [], resting = saved.resting ?? []
const spotBal = saved.spotBal ?? { USDC: Number(process.env.FAKE_SPOT_USDC ?? 100000) }
let oid = saved.oid ?? 1000
const persist = () => { if (STATE) fs.writeFileSync(STATE, JSON.stringify({ pos, fills, resting, oid, spotBal })) }
const journal = (o) => { if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...o }) + '\n') }
const fill = (coin, isBuy, sz, px) => {
  const before = pos[coin] ?? 0, after = before + (isBuy ? sz : -sz)
  pos[coin] = after
  const dir = before === 0 || Math.sign(after) === Math.sign(before) && Math.abs(after) > Math.abs(before) ? (isBuy ? 'Open Long' : 'Open Short') : (isBuy ? 'Close Short' : 'Close Long')
  fills.push({ coin, px: String(px), sz: String(sz), side: isBuy ? 'B' : 'A', time: Date.now(), dir, startPosition: String(before), closedPnl: '0', hash: '0x0', oid: ++oid, crossed: true, fee: '0', tid: oid, feeToken: 'USDC' })
}
// Resting stops and targets fill when the price reaches them (checked on every request).
const sweep = () => {
  for (const o of [...resting]) {
    const px = priceAt(o.coin, Date.now())
    const hit = o.tpsl === 'tp' ? (o.isBuy ? px <= o.trig : px >= o.trig) : (o.isBuy ? px >= o.trig : px <= o.trig)
    if (!hit) continue
    resting.splice(resting.indexOf(o), 1)
    const have = Math.abs(pos[o.coin] ?? 0)
    const sz = Math.min(o.sz, have)
    if (sz > 0) { fill(o.coin, o.isBuy, sz, o.trig); journal({ ev: 'triggered', coin: o.coin, tpsl: o.tpsl, px: o.trig, sz }) }
  }
}

function info(b) {
  const now = Date.now()
  switch (b.type) {
    case 'meta': return { universe, marginTables: [], collateralToken: 0 }
    case 'spotMeta': return { tokens: [{ index: 0, name: 'USDC', szDecimals: 8 }, ...spotPairs.map(p => ({ index: p.index + 1, name: tokenOf(p.name), szDecimals: 2 }))], universe: spotPairs.map(p => ({ name: p.name, index: p.index, tokens: [p.index + 1, 0] })) }
    case 'spotClearinghouseState': return { balances: Object.entries(spotBal).map(([coin, total]) => ({ coin, token: 0, total: String(total), hold: '0', entryNtl: '0' })) }
    case 'perpDexs': return [null]
    case 'allMids': return Object.fromEntries(Object.keys(PRICES).map(c => [c, String(priceAt(c, now))]))
    case 'clearinghouseState': return {
      assetPositions: Object.entries(pos).filter(([, s]) => s).map(([coin, s]) => ({ type: 'oneWay', position: { coin, szi: String(s), entryPx: '0', unrealizedPnl: '0' } })),
      withdrawable: '100000', marginSummary: { accountValue: '100000', totalMarginUsed: '0', totalNtlPos: '0', totalRawUsd: '100000' }, crossMarginSummary: { accountValue: '100000', totalMarginUsed: '0', totalNtlPos: '0', totalRawUsd: '100000' }, crossMaintenanceMarginUsed: '0', time: now }
    case 'candleSnapshot': {
      const { coin, interval, startTime, endTime } = b.req
      const ms = { '1h': H, '4h': 4 * H, '1d': 24 * H }[interval]
      const out = []
      for (let t = Math.floor(startTime / ms) * ms; t <= Math.min(endTime, now); t += ms) {
        const o = priceAt(coin, t), c = priceAt(coin, Math.min(t + ms - 1, now))
        out.push({ t, T: t + ms - 1, s: coin, i: interval, o: String(o), c: String(c), h: String(Math.max(o, c) + 0.5), l: String(Math.min(o, c) - 0.5), v: '1', n: 1 })
      }
      return out
    }
    case 'userFillsByTime': return fills.filter(f => f.time >= (b.startTime ?? 0))
    default: return {}
  }
}

function exchange(b) {
  const a = b.action ?? {}
  if (a.type === 'updateLeverage') { journal({ ev: 'leverage', asset: a.asset, isCross: a.isCross, leverage: a.leverage }); return { status: 'ok', response: { type: 'default' } } }
  if (a.type === 'cancel') {
    for (const c of a.cancels ?? []) { const i = resting.findIndex(o => o.oid === Number(c.o)); if (i >= 0) { resting.splice(i, 1); journal({ ev: 'cancel', oid: Number(c.o) }) } }
    return { status: 'ok', response: { type: 'cancel', data: { statuses: (a.cancels ?? []).map(() => 'success') } } }
  }
  if (a.type === 'order') {
    const statuses = a.orders.map(o => {
      const isBuy = !!o.b, sz = Number(o.s)
      if (o.a >= 10000 && o.a < 100000) {
        const coin = '@' + (o.a - 10000)
        if (o.t?.trigger) return { error: 'no trigger orders on spot here' }
        const mid = priceAt(coin, Date.now()), lim = Number(o.p), tk = tokenOf(coin)
        if (isBuy ? lim < mid : lim > mid) return { error: 'Order could not immediately match' }
        if (isBuy && (spotBal.USDC ?? 0) < sz * mid * 1.0007) { journal({ ev: 'spot-refused', coin, isBuy, sz, why: 'usdc' }); return { error: 'Insufficient spot balance' } }
        if (!isBuy && (spotBal[tk] ?? 0) < sz - 1e-9) { journal({ ev: 'spot-refused', coin, isBuy, sz, why: 'balance' }); return { error: 'Insufficient spot balance' } }
        spotBal.USDC = (spotBal.USDC ?? 0) + (isBuy ? -1 : 1) * sz * mid - sz * mid * 0.0007
        spotBal[tk] = Math.round(((spotBal[tk] ?? 0) + (isBuy ? sz : -sz)) * 1e8) / 1e8
        fills.push({ coin, px: String(mid), sz: String(sz), side: isBuy ? 'B' : 'A', time: Date.now(), dir: isBuy ? 'Buy' : 'Sell', startPosition: '0', closedPnl: '0', hash: '0x0', oid: ++oid, crossed: true, fee: String(sz * mid * 0.0007), tid: oid, feeToken: 'USDC' })
        journal({ ev: 'ioc', coin, isBuy, sz, px: mid, spot: true, reduceOnly: !!o.r, cloid: o.c })
        return { filled: { totalSz: String(sz), avgPx: String(mid), oid } }
      }
      const coin = universe[o.a]?.name
      if (o.t?.trigger) {
        const r = { oid: ++oid, coin, isBuy, sz, trig: Number(o.t.trigger.triggerPx), tpsl: o.t.trigger.tpsl, reduceOnly: !!o.r, cloid: o.c }
        resting.push(r); journal({ ev: 'trigger', ...r })
        return { resting: { oid: r.oid } }
      }
      const mid = priceAt(coin, Date.now()), lim = Number(o.p)
      if (isBuy ? lim < mid : lim > mid) { journal({ ev: 'ioc-miss', coin, isBuy, sz }); return { error: 'Order could not immediately match' } }
      const have = pos[coin] ?? 0
      const take = o.r ? Math.min(sz, Math.abs(have)) : sz
      if (o.r && (!have || Math.sign(have) === (isBuy ? 1 : -1))) return { error: 'Reduce only order would increase position' }
      fill(coin, isBuy, take, mid)
      journal({ ev: 'ioc', coin, isBuy, sz: take, px: mid, reduceOnly: !!o.r, cloid: o.c })
      return { filled: { totalSz: String(take), avgPx: String(mid), oid: oid } }
    })
    return { status: 'ok', response: { type: 'order', data: { statuses } } }
  }
  return { status: 'ok', response: { type: 'default' } }
}

globalThis.fetch = async (url, init) => {
  if (REAL0 == null) REAL0 = realNow()
  const b = JSON.parse(init?.body ?? '{}')
  sweep()
  const out = String(url).endsWith('/exchange') ? exchange(b) : info(b)
  persist()
  return new Response(JSON.stringify(out), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
