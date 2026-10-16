/**
 * Grid Ladder — one bot's runner: the engine (src/gridladder.js) against an exchange adapter
 * and a store. The same code runs live (strategies/gridladder.js), in dry-run and in the
 * backtester (src/gridsim.js), so what the tests prove is what trades.
 *
 * Every action is serialised through one queue, so a socket fill, a timer tick and a full
 * reconcile can never interleave and each read what the other was about to change.
 *
 * Two paths keep the book right:
 *
 *   FAST  a fill or an order update from the socket is applied and only the orders it implies
 *         are placed — one request, no reads. The pairs' `placed` cloids are the local view of
 *         the book.
 *   FULL  at start, after every reconnect and on a timer: read the exchange's open orders
 *         FIRST, then its fills since the last one we applied, apply those, then diff. The
 *         order of those two reads is what makes a restart safe: an order that filled between
 *         them is still in the open list (kept), and one missing from it has its fill in the
 *         fill list (applied) — so a filled order is never mistaken for a cancelled one and
 *         bought twice.
 *
 * Fills are applied exactly once: the store records each trade id in the same transaction as
 * the state it changed, so a fill seen on the socket and again in a reconcile counts once.
 */
import {
  validateBot, gridChanged, freshState, armIfWaiting, inventoryNeeded, settleInventory, planReconcile,
  markPlaced, repriceAfterCross, bboFromError, isCrossReject, applyFill, inventoryOf, killed, botStats,
  ladderCloid, parseLadderCloid, newRunId, roundPx, roundSz,
} from './gridladder.js'

const FILL_LOOKBACK_MS = 5 * 60_000
const REJECT_BACKOFF_MS = 60_000

export function createRunner({ key, botId, cfg, ex, store, log = () => {}, now = () => Date.now(), rand = Math.random }) {
  let st = null, meta = null, paused = false, lastMid = 0
  let chain = Promise.resolve()
  const serial = (fn) => {
    const p = chain.then(fn)
    chain = p.catch(e => { log('ERROR', e?.message ?? String(e)); store.event(key, 'error', e?.message ?? String(e)) })
    return p
  }
  const event = (kind, msg) => { log(kind.toUpperCase(), msg); store.event(key, kind, msg) }
  const ours = (o) => { const c = parseLadderCloid(o.cloid); return !!c && c.bot === botId }

  /** Apply fills once each, booking cycles, in one store transaction with the new state. */
  function ingest(fills) {
    const list = (fills ?? []).filter(f => f && f.cloid && f.tid != null).sort((a, b) => (+a.time - +b.time) || (+a.tid - +b.tid))
    if (!list.length) return []
    const results = []
    store.applyFills(key, list, (f) => {
      const r = applyFill(st, f)
      if (r.kind === 'cycle') event('cycle', `pair ${r.pair}: +$${r.profit.toFixed(4)} (bought ${r.cycleDone.buyPx.toFixed(4)}, sold ${r.cycleDone.sellPx.toFixed(4)})`)
      results.push(r)
      return r
    }, () => st)
    return results
  }

  /** Place a batch; a post-only order that would cross is re-priced to the touch and tried once more. */
  async function placeAll(orders, depth = 0) {
    if (!orders.length) return
    const res = await ex.place(orders.map(o => ({ ...o, tif: 'Alo' })))
    const retry = []
    let bbo = null
    for (let k = 0; k < orders.length; k++) {
      const o = orders[k], r = res[k] ?? {}
      if (r.resting || r.filled) { markPlaced(st, o); continue }
      const err = r.error ?? 'no status'
      if (isCrossReject(err) && depth < 2) {
        bbo = bboFromError(err) ?? bbo ?? await ex.bbo()
        const n = repriceAfterCross(st, o, bbo)
        if (n) { retry.push(n); event('reprice', `pair ${o.pair} ${o.isBuy ? 'buy' : 'sell'} ${o.px} would cross (bbo ${bbo?.bid}@${bbo?.ask}) → ${n.px}`) }
      } else {
        // Not a crossing: margin, a halted market, a re-price that keeps crossing. Back off this
        // pair until the next full reconcile instead of retrying it on every price tick.
        const p = st.pairs[o.pair]; if (p) p.errAt = now()
        event('reject', `pair ${o.pair} ${o.isBuy ? 'buy' : 'sell'} ${o.sz} @ ${o.px}: ${err}`)
      }
    }
    store.save(key, st)
    if (retry.length) await placeAll(retry, depth + 1)
  }

  /** The start-up inventory: one aggregated taker buy for every pair above the price. */
  async function buyInventory(mid) {
    const need = roundSz(inventoryNeeded(st), st.szDecimals)
    if (!(need > 0)) return settleInventory(st)
    const b = await ex.bbo()
    const cloid = ladderCloid(st.run, st.bot, 0, 'I', 0, 0)
    st.inventoryBuy = { cloid, sz: need, done: false }
    store.save(key, st)
    const px = roundPx(Math.max(b.ask || mid, mid) * 1.01, st.szDecimals, 'up')
    event('inventory', `buying ${need} ${'HYPE'} for ${st.pairs.filter(p => p.phase === 'I').length} pairs above $${mid} (limit ${px}, Ioc)`)
    const [r] = await ex.place([{ cloid, isBuy: true, px, sz: need, reduceOnly: false, tif: 'Ioc' }])
    if (r?.error) event('reject', `inventory buy: ${r.error}`)
    ingest(await ex.fillsSince(st.lastFillTime - FILL_LOOKBACK_MS))
    settleInventory(st)        // pairs it did not cover rest as buys (re-priced if above the market)
    store.save(key, st)
  }

  async function fullReconcile(reason) {
    // Order matters — see the header. Open orders first, then fills.
    const open = (await ex.openOrders()).filter(ours)
    ingest(await ex.fillsSince((st.lastFillTime ?? 0) - FILL_LOOKBACK_MS))
    const mid = lastMid = await ex.mid()
    if (killed(st, mid)) return kill(mid)
    if (st.stopped) return
    if (armIfWaiting(st, mid)) event('arm', `price ${mid} is inside ${st.prices[0]}–${st.prices.at(-1)}: laying out ${st.pairs.length} pairs`)
    // The start-up buy is placed ONCE per run. If a previous process recorded it and died
    // before settling, its fills were applied above; buying again would double the inventory.
    if (st.pairs.some(p => p.phase === 'I')) { if (!st.inventoryBuy) await buyInventory(mid); else settleInventory(st) }
    const mine = [], strays = []
    for (const o of open) (parseLadderCloid(o.cloid).run === st.run ? mine : strays).push(o)
    for (const p of st.pairs) p.errAt = 0      // a full reconcile retries everything once
    const plan = planReconcile(st, mid, mine, { paused })
    const cancel = [...plan.cancel, ...strays.map(o => o.cloid)]
    if (cancel.length) { await ex.cancel(cancel); event('cancel', `${cancel.length} order(s) not in the plan (${reason})`) }
    await placeAll(plan.place)
    // The account is the bot's own, so its position should be what the bot thinks it holds.
    const pos = await ex.position().catch(() => null)
    const inv = inventoryOf(st).sz
    st.drift = pos ? +(+pos.szi - inv).toFixed(st.szDecimals) : null
    if (st.drift) event('drift', `exchange position ${pos.szi} vs bot inventory ${inv.toFixed(st.szDecimals)}`)
    st.lastReconcile = now()
    store.save(key, st)
  }

  /** The fast path: place what the local view of the book is missing. No reads. */
  async function fastPlace() {
    if (!st || st.stopped || st.waiting) return
    const local = st.pairs.filter(p => p.placed).map(p => ({ cloid: p.placed }))
    const plan = planReconcile(st, lastMid, local, { paused })
    await placeAll(plan.place.filter(o => !(st.pairs[o.pair]?.errAt > now() - REJECT_BACKOFF_MS)))
  }

  async function kill(mid) {
    event('kill', `price ${mid} hit the kill price ${st.cfg.killPrice}: cancelling and closing`)
    await stopNow('close')
    st.killed = true
    store.save(key, st)
  }

  async function stopNow(mode) {
    const open = (await ex.openOrders()).filter(ours)
    if (open.length) await ex.cancel(open.map(o => o.cloid))
    ingest(await ex.fillsSince((st.lastFillTime ?? 0) - FILL_LOOKBACK_MS))
    // Cancelled ids are spent: the next placement of each pair goes under the next attempt.
    for (const p of st.pairs) if (p.placed) { p.placed = null; p.attempt++; p.px = null }
    if (mode === 'close') {
      const pos = await ex.position()
      const sz = roundSz(Math.max(0, +pos?.szi || 0), st.szDecimals)
      if (sz > 0) {
        const b = await ex.bbo()
        const px = roundPx((b.bid || lastMid) * 0.99, st.szDecimals, 'down')
        const [r] = await ex.place([{ cloid: ladderCloid(st.run, st.bot, 0, 'C', st.cycles % 2 ** 32, 0), isBuy: false, px, sz, reduceOnly: true, tif: 'Ioc' }])
        if (r?.error) event('reject', `close: ${r.error}`)
        const fills = (await ex.fillsSince(st.lastFillTime - FILL_LOOKBACK_MS))
        const inv = inventoryOf(st)
        ingest(fills)
        const sold = fills.filter(f => parseLadderCloid(f.cloid)?.side === 'C' && parseLadderCloid(f.cloid)?.run === st.run)
        const soldSz = sold.reduce((s, f) => s + +f.sz, 0), got = sold.reduce((s, f) => s + +f.px * +f.sz, 0)
        // What closing the held inventory made or lost against its cost (outside the grid's cycles).
        if (soldSz > 0) {
          st.closePnl = (st.closePnl ?? 0) + got - (inv.avg ?? 0) * Math.min(soldSz, inv.sz) - sold.reduce((s, f) => s + +f.fee, 0)
          event('close', `sold ${soldSz.toFixed(st.szDecimals)} at ~${(got / soldSz).toFixed(4)} (held at avg ${inv.avg?.toFixed(4) ?? '—'})`)
        }
      }
      // A closed bot starts from nothing next time, under a new run id: its old cloids are spent.
      st.pairs = []; st.waiting = true; st.needsFresh = true
    }
    st.stopped = true
    store.save(key, st)
    event('stop', mode === 'close' ? 'stopped: orders cancelled, position closed' : 'stopped: orders cancelled, position kept')
  }

  return {
    /** Load or create the state, set leverage, then a full reconcile. Throws on a bad config. */
    start: () => serial(async () => {
      meta = await ex.meta()
      const errs = validateBot(cfg, meta)
      if (errs.length) throw new Error(errs.join(' '))
      const mid = lastMid = await ex.mid()
      const prev = store.load(key)
      if (prev && !prev.needsFresh && !gridChanged(prev, cfg)) {
        st = prev
        st.cfg = { ...st.cfg, leverage: cfg.leverage, margin: cfg.margin, killPrice: cfg.killPrice }
        st.stopped = false; st.killed = false
        event('resume', `resuming run ${st.run}: ${st.cycles} cycles, $${st.realized.toFixed(4)} realized`)
      } else {
        if (prev && inventoryOf(prev).sz > 0 && !prev.needsFresh)
          throw new Error('The grid (range, levels or size) changed while the bot still holds inventory. Stop and close it first, or put the old grid back.')
        const lifetime = prev ? {
          realized: (prev.lifetime?.realized ?? 0) + prev.realized + (prev.closePnl ?? 0),
          cycles: (prev.lifetime?.cycles ?? 0) + prev.cycles, fees: (prev.lifetime?.fees ?? 0) + prev.fees,
        } : undefined
        st = freshState({ bot: botId, cfg, szDecimals: meta.szDecimals, mid, run: newRunId(rand), now: now() })
        if (lifetime) st.lifetime = lifetime
        event('start', `new run ${st.run}: ${st.prices.length} levels ${st.prices[0]}–${st.prices.at(-1)}, $${cfg.usd}/level, ${cfg.leverage}× ${cfg.margin}` + (st.waiting ? ` — price ${mid} is outside, waiting` : ''))
      }
      await ex.setLeverage(+cfg.leverage, cfg.margin === 'isolated')
      store.save(key, st)
      await fullReconcile('start')
    }),
    reconcile: (reason = 'timer') => serial(() => st && fullReconcile(reason)),
    /** Fills from the socket. */
    onFills: (fills) => serial(async () => { if (!st) return; if (ingest(fills).length) await fastPlace() }),
    /** Order updates from the socket: a cancelled or rejected order of ours is re-placed. */
    onOrderUpdates: (ups) => serial(async () => {
      if (!st) return
      let gone = false
      for (const u of ups ?? []) {
        const c = u?.order?.cloid, s = String(u?.status ?? '')
        if (!c || s === 'open' || s === 'filled' || s === 'triggered') continue
        const p = st.pairs.find(q => q.placed === c)
        if (p) { p.placed = null; p.attempt++; p.px = null; gone = true; event('gone', `pair ${p.i} order ${s}`) }
      }
      if (gone) { store.save(key, st); await fastPlace() }
    }),
    /** A price tick: kill switch, arming, and orders held back while out of range. */
    tick: (mid) => serial(async () => {
      if (!st || !(mid > 0)) return
      lastMid = mid
      if (st.stopped) return
      if (killed(st, mid)) return kill(mid)
      if (st.waiting) return fullReconcile('price entered range')
      await fastPlace()
    }),
    pause: () => serial(async () => { paused = true; if (st) { st.paused = true; store.save(key, st) } event('pause', 'paused: orders stay, nothing new is placed') }),
    resume: () => serial(async () => { paused = false; if (st) { st.paused = false; store.save(key, st) } event('resume', 'resumed'); if (st) await fullReconcile('resume') }),
    stop: (mode = 'cancel') => serial(() => st && stopNow(mode)),
    stats: (extra = {}) => (st ? botStats(st, { mid: lastMid, ...extra }) : null),
    get state() { return st },
    get paused() { return paused },
    idle: () => chain,
  }
}

/** A store that keeps everything in memory, with the same contract as the SQLite one. */
export function memoryStore() {
  const states = new Map(), fills = new Map(), cycles = [], events = []
  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)))
  return {
    load: (key) => clone(states.get(key)) ?? null,
    save: (key, st) => { states.set(key, clone(st)) },
    applyFills(key, list, apply, getState) {
      const seen = fills.get(key) ?? new Set()
      for (const f of list) {
        if (seen.has(String(f.tid))) continue
        seen.add(String(f.tid))
        const r = apply(f)
        if (r?.cycleDone) cycles.push({ key, ...r.cycleDone })
      }
      fills.set(key, seen)
      states.set(key, clone(getState()))
    },
    event: (key, kind, msg) => { events.push({ key, kind, msg }); if (events.length > 2000) events.shift() },
    cycles: (key) => cycles.filter(c => c.key === key),
    events: (key) => events.filter(e => !key || e.key === key),
  }
}
