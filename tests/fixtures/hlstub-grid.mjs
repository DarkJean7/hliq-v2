// A fake Hyperliquid for running strategies/grid.js end to end (tests/gridheld-sim.mjs).
// Loaded with `node --import`; replaces fetch. The test steers it through a control file:
//   { mark, fills: [{ id, px }] }  — each new fill id fills the resting order at that price.
// Every order, cancel and fill is appended to the events file as one JSON line.
import fs from 'node:fs'

const CTL = process.env.HLSTUB_CTL, EV = process.env.HLSTUB_EV
const S = JSON.parse(process.env.HLSTUB_INIT)   // { coin, szi, entryPx, mark, fills: [] }
const open = new Map()                           // oid → order
const filled = new Set(), doneFills = new Set()
let nextOid = 1000 + Math.floor(Math.random() * 1e6)
const ev = (o) => fs.appendFileSync(EV, JSON.stringify(o) + '\n')
const ctl = () => { try { return JSON.parse(fs.readFileSync(CTL, 'utf8')) } catch { return { mark: S.mark } } }

function tick() {
  const c = ctl()
  for (const f of c.fills ?? []) {
    if (doneFills.has(f.id)) continue
    const o = [...open.values()].find(o => Math.abs(o.px - f.px) < 1e-9)
    if (!o) continue
    doneFills.add(f.id); open.delete(o.oid); filled.add(o.oid)
    const sz = o.sz, px = o.px, buy = o.side === 'B'
    const newSzi = S.szi + (buy ? sz : -sz)
    if (buy) S.entryPx = (S.szi * S.entryPx + sz * px) / newSzi
    S.szi = newSzi
    S.fills.push({ coin: S.coin, px: String(px), sz: String(sz), side: o.side, time: Date.now(), closedPnl: buy ? '0' : String((px - S.entryPx) * sz), fee: '0', oid: o.oid })
    ev({ kind: 'fill', side: o.side, px, sz })
  }
  return c
}

const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'content-type': 'application/json' } })
globalThis.fetch = async (url, init = {}) => {
  const body = JSON.parse(init.body ?? '{}')
  const c = tick()
  if (String(url).endsWith('/exchange')) {
    const a = body.action ?? {}
    if (a.type === 'order') {
      const statuses = a.orders.map(o => {
        const oid = nextOid++
        open.set(oid, { oid, side: o.b ? 'B' : 'A', px: parseFloat(o.p), sz: parseFloat(o.s), cloid: o.c, reduceOnly: !!o.r })
        ev({ kind: 'order', side: o.b ? 'B' : 'A', px: parseFloat(o.p), sz: parseFloat(o.s), reduceOnly: !!o.r })
        return { resting: { oid } }
      })
      return ok({ status: 'ok', response: { type: 'order', data: { statuses } } })
    }
    if (a.type === 'cancel') {
      for (const x of a.cancels) { const o = open.get(x.o); open.delete(x.o); ev({ kind: 'cancel', side: o?.side, px: o?.px }) }
      return ok({ status: 'ok', response: { type: 'cancel', data: { statuses: a.cancels.map(() => 'success') } } })
    }
    return ok({ status: 'ok', response: { type: 'default' } })
  }
  const mark = c.mark
  const MARGIN = { accountValue: '2000', totalNtlPos: String(S.szi * mark), totalRawUsd: '2000', totalMarginUsed: '50' }
  switch (body.type) {
    case 'allMids': return ok({ [S.coin]: String(mark) })
    case 'meta': return ok({ universe: [{ name: S.coin, szDecimals: 2, maxLeverage: 10 }] })
    case 'perpDexs': return ok([null])
    case 'clearinghouseState': return ok({ marginSummary: MARGIN, crossMarginSummary: MARGIN, crossMaintenanceMarginUsed: '5', withdrawable: '1500', time: Date.now(),
      assetPositions: S.szi ? [{ type: 'oneWay', position: { coin: S.coin, szi: String(S.szi), entryPx: String(S.entryPx), marginUsed: String(Math.abs(S.szi) * mark / 10), leverage: { type: 'cross', value: 10 } } }] : [] })
    case 'spotClearinghouseState': return ok({ balances: [{ coin: 'USDC', token: 0, total: '2000', hold: '0', entryNtl: '0' }] })
    case 'activeAssetData': return ok({ user: body.user, coin: S.coin, leverage: { type: 'cross', value: 10 }, maxTradeSzs: ['1000', '1000'], availableToTrade: ['15000', '15000'], markPx: String(mark) })
    case 'openOrders': case 'frontendOpenOrders':
      return ok([...open.values()].map(o => ({ coin: S.coin, side: o.side, limitPx: String(o.px), sz: String(o.sz), oid: o.oid, timestamp: 0, origSz: String(o.sz), cloid: o.cloid, reduceOnly: o.reduceOnly })))
    case 'orderStatus': return ok({ status: 'order', order: { status: filled.has(body.oid) ? 'filled' : 'canceled', order: {}, statusTimestamp: 0 } })
    case 'userFillsByTime': return ok(S.fills.filter(f => f.time >= (body.startTime ?? 0)))
    default: return ok({})
  }
}
