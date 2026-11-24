/**
 * Runs the Agent Arena (src/agents.js) on the server, inside serve-prod.js.
 *
 * Each agent is a paper account of one server-owned paper owner (a secret made on first run and
 * kept in dir/secret, never in the repo), slot = the agent's id. Orders go through
 * paperHost.withStore — src/paper.js, the engine a person's paper account uses — so fees,
 * slippage and funding are the same, and the server's paper tick (serve-prod.js paperTickOnce)
 * fills the agents' stops while nothing here is running. It lives in serve-prod.js, not as a
 * strategy under server.js, so shipping it never restarts anybody's bot.
 *
 * It asks Hyperliquid for almost nothing: decisions are made from what is already on disk — the
 * Oracle's server log (24h calls) and the daily candles its logger keeps (data/oracle/<coin>.json)
 * — and the prices come from allMids, with metaAndAssetCtxs (limits and funding) at most every ten
 * minutes (paperhost.js marketFor/loadMarket). One worker runs it, by lease, like the logger.
 *
 * What it keeps (dir/state.json): per agent the last run, what it held (to tell a stop-out from
 * its own close), coins cooling down, an hourly equity curve (the paper store keeps only its
 * last 2,000 minutes), and the journal of every open, close and stop with its reason.
 * dir/summary.json is what GET /agents-data serves.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENTS, planOf, sizeFor, maxDrawdown, thin } from './agents.js'
import { marketFor } from './paperhost.js'
import { rektAgent, cleanConfig, initLearn } from './rekt.js'

const HOUR = 3600e3, DAY = 24 * HOUR
export const SUMMARY_MS = 5 * 60e3
export const LEASE_MS = 3 * 60e3
export const COOL_MS = DAY
export const JOURNAL_KEEP = 300

function readJson(f) { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return null } }
function writeJson(f, v) { const t = `${f}.${process.pid}.tmp`; writeFileSync(t, JSON.stringify(v)); renameSync(t, f) }

const sideOf = (szi) => (szi > 0 ? 'long' : 'short')

/**
 *   dir: the arena's own files; paperHost: serve-prod.js's (src/paperhost.js)
 *   post(body): Hyperliquid /info; readings(): { coin: { score, sigma, t } } — the latest 24h call
 *   oracleDir: the logger's per-market candle files
 */
export const ALL_AGENTS = [...AGENTS, rektAgent]

export function createAgentRunner({ dir, paperHost, post, readings = () => ({}), oracleDir, now = () => Date.now(), log = console, agents = ALL_AGENTS, rng = Math.random }) {
  mkdirSync(dir, { recursive: true })
  const SECRET = join(dir, 'secret'), STATE = join(dir, 'state.json'), SUMMARY = join(dir, 'summary.json'), LEASE = join(dir, 'lease')
  // Rekt-01's settings (src/rekt.js), written by POST /agents-config in dev mode, read every run.
  const CONFIG = join(dir, 'rekt-config.json')
  const configOf = () => cleanConfig(readJson(CONFIG) ?? {})
  function saveConfig(c) { const cfg = cleanConfig(c); writeJson(CONFIG, cfg); return cfg }
  let secret = null
  function secretOf() {
    if (secret) return secret
    try { secret = readFileSync(SECRET, 'utf8').trim() } catch {}
    if (!/^[0-9a-f]{64}$/.test(secret ?? '')) {
      secret = randomBytes(32).toString('hex')
      writeFileSync(SECRET, secret, { mode: 0o600 })
    }
    return secret
  }
  const emptyState = () => ({ started: now(), agents: {} })
  const agentState = (st, id) => (st.agents[id] ??= { last: 0, held: [], cool: {}, curve: [], journal: [] })

  function holdLease() {
    try {
      const t = now(), mine = String(process.pid)
      if (existsSync(LEASE)) {
        const who = readFileSync(LEASE, 'utf8').trim()
        if (who !== mine && t - statSync(LEASE).mtimeMs < LEASE_MS) return false
      }
      writeFileSync(LEASE, mine)
      return true
    } catch { return false }
  }

  // Daily candles of every market the logger keeps; re-read at most hourly (they change daily).
  let dailyCache = null
  function daily() {
    if (dailyCache && now() - dailyCache.at < HOUR) return dailyCache.map
    const map = {}
    let names = []
    try { names = readdirSync(oracleDir).filter(f => f.endsWith('.json') && f !== 'state.json') } catch {}
    for (const f of names) {
      const m = readJson(join(oracleDir, f))
      if (m?.coin && m.candles?.['1d']?.length) map[m.coin] = m.candles['1d']
    }
    dailyCache = { at: now(), map }
    return map
  }

  let market = null
  async function marketWith(coins) {
    market = await marketFor(post, new Set(['BTC', ...coins]), market, now())
    return market
  }

  /** What the store holds now, and journal lines for positions that left without the agent closing them. */
  function reconcile(P, a, as) {
    const t = now()
    const pos = P.paperStore().positions.filter(p => p.szi)
    const heldNow = pos.map(p => ({ coin: p.coin, side: sideOf(p.szi), openedAt: as.held.find(h => h.coin === p.coin)?.openedAt ?? t }))
    for (const h of as.held) {
      if (heldNow.some(x => x.coin === h.coin && x.side === h.side)) continue
      // Gone while nothing here closed it: the stop (or liquidation) on the server tick.
      const f = P.paperFills().filter(x => x.coin === h.coin && x.time >= (h.openedAt ?? 0) && Number(x.closedPnl))
      const pnl = f.length ? Number(f[0].closedPnl) - Number(f[0].fee || 0) : null
      as.journal.push({ t, kind: 'stop', coin: h.coin, side: h.side, px: f.length ? Number(f[0].px) : null, pnl, why: 'stop hit' })
      if (as.learn) a.onClose?.(as.learn, h.coin, pnl)
      as.cool[h.coin] = t + COOL_MS
    }
    as.held = heldNow
    return heldNow
  }

  function order(P, coin, isBuy, sz, { reduce = false, trigger = null } = {}) {
    const mark = P.paperMark(coin)
    const o = trigger
      ? { a: 0, b: isBuy, p: trigger * (isBuy ? 1.05 : 0.95), s: sz, r: true, t: { trigger: { isMarket: true, triggerPx: trigger, tpsl: 'sl' } } }
      : { a: 0, b: isBuy, p: mark * (isBuy ? 1.1 : 0.9), s: sz, r: reduce, t: { limit: { tif: 'Ioc' } } }
    const st = P.paperOrder({ orders: [o] }, coin)?.response?.data?.statuses?.[0]
    return st?.error ? { error: st.error } : { ok: true, px: Number(st?.filled?.avgPx) || mark }
  }

  /** One agent's run: look, decide, close what it no longer wants, open what it does. */
  function run(a, as, ctxBase, mk) {
    const t = now()
    return paperHost.withStore(secretOf(), a.id, mk, (P) => {
      const held = reconcile(P, a, as)
      for (const [c, u] of Object.entries(as.cool)) if (u <= t) delete as.cool[c]
      if (a.stateful) as.learn ??= initLearn(t)
      const wanted = a.decide({ ...ctxBase, now: t, held, cool: as.cool, learn: as.learn, config: ctxBase.config, equity: P.paperEquity(), rng })
      if (wanted == null) { if (as.journal.at(-1)?.kind !== 'skip') as.journal.push({ t, kind: 'skip', why: 'data missing: nothing changed' }); return }
      const { close, open } = planOf(held, wanted)
      for (const h of close) {
        const p = P.paperStore().positions.find(x => x.coin === h.coin)
        if (!p) continue
        const before = P.paperFills().length
        const r = order(P, h.coin, p.szi < 0, Math.abs(p.szi), { reduce: true })
        if (r.error) { as.journal.push({ t, kind: 'error', coin: h.coin, why: r.error }); continue }
        const f = P.paperFills().slice(0, P.paperFills().length - before)
        const pnl = f.reduce((s, x) => s + Number(x.closedPnl || 0) - Number(x.fee || 0), 0)
        as.journal.push({ t, kind: 'close', coin: h.coin, side: h.side, px: r.px, pnl, why: wanted.find(w => w.coin === h.coin)?.why ?? 'no longer qualifies' })
        if (as.learn) a.onClose?.(as.learn, h.coin, pnl)
        as.cool[h.coin] = t + COOL_MS
      }
      // Closed here, not stopped: the next reconcile must not read them as stop-outs.
      as.held = as.held.filter(h => !close.includes(h))
      // Cancel stops left behind by a close (the tick would, a minute later).
      for (const o of [...P.paperStore().orders]) if (o.reduceOnly && !P.paperStore().positions.some(p => p.coin === o.coin)) P.paperCancel(o.oid)
      const equity = P.paperEquity()
      for (const w of open) {
        const px = P.paperMark(w.coin)
        const asset = mk.assets?.[w.coin]
        if (!(px > 0) || !asset) { as.journal.push({ t, kind: 'error', coin: w.coin, why: 'no price' }); continue }
        const lev = Math.min(w.lev ?? a.lev, asset.maxLeverage ?? a.lev)
        // 2% left over for the fee and the slippage: at 1× the whole equity is not enough margin.
        // An agent may size it itself (Rekt-01 sizes by the most its stop may lose).
        const sz = w.notional != null ? sizeFor(w.notional, 1, 1, px, asset.szDecimals) : sizeFor(equity * 0.98, lev, a.max, px, asset.szDecimals)
        if (!(sz > 0)) continue
        P.paperSetLeverage(w.coin, lev)
        const isBuy = w.side === 'long'
        const r = order(P, w.coin, isBuy, sz)
        if (r.error) { as.journal.push({ t, kind: 'error', coin: w.coin, why: r.error }); continue }
        let stop = null
        if (w.stopPct) {
          stop = r.px * (isBuy ? 1 - w.stopPct / 100 : 1 + w.stopPct / 100)
          order(P, w.coin, !isBuy, sz, { trigger: stop })
        }
        as.journal.push({ t, kind: 'open', coin: w.coin, side: w.side, px: r.px, sz, lev, stop, why: w.why })
        if (as.learn) a.onOpen?.(as.learn, w, { t, equity })
      }
      reconcile(P, a, as)
    })
  }

  /** The board: every agent's account now, its curve and its journal → dir/summary.json. */
  function summarize(st, mk) {
    const t = now()
    const cfg = configOf()
    const rows = []
    for (const a of agents) {
      const as = agentState(st, a.id)
      const acct = paperHost.withStore(secretOf(), a.id, mk, (P) => {
        reconcile(P, a, as)
        const ps = P.paperPerpState()
        return {
          equity: P.paperEquity(), deposited: P.paperDeposited(),
          positions: ps.assetPositions.map(({ position: p }) => ({ coin: p.coin, szi: Number(p.szi), entryPx: Number(p.entryPx), mark: P.paperMark(p.coin), upnl: Number(p.unrealizedPnl), lev: p.leverage?.value ?? null, value: Number(p.positionValue) })),
          stops: P.paperStore().orders.filter(o => o.isTrigger).map(o => ({ coin: o.coin, px: o.triggerPx })),
        }
      })
      const lastPt = as.curve.at(-1)
      if (!lastPt || t - lastPt[0] >= HOUR) as.curve.push([t, acct.equity])
      const closed = as.journal.filter(j => (j.kind === 'close' || j.kind === 'stop') && Number.isFinite(j.pnl))
      const curve = [...as.curve, [t, acct.equity]]
      rows.push({
        id: a.id, name: a.name, color: a.color, blurb: a.blurb, lev: a.levOf?.(cfg) ?? a.lev, max: a.maxOf?.(cfg) ?? a.max, every: a.every, baseline: !!a.baseline,
        ...(a.personal ? { personal: true, hidden: !cfg.arena, config: cfg, learn: a.describe(as.learn ?? initLearn(t), cfg) } : {}),
        equity: acct.equity, start: acct.deposited, ret: (acct.equity / acct.deposited - 1) * 100,
        maxDD: maxDrawdown(curve), trades: closed.length, wins: closed.filter(j => j.pnl > 0).length,
        positions: acct.positions, stops: acct.stops, last: as.last, next: as.last + a.every,
        curve: thin(curve, 400), journal: as.journal.slice(-80).reverse(),
      })
    }
    writeJson(SUMMARY, { at: t, started: st.started, agents: rows })
  }

  let busy = false, lastSummary = 0
  async function tick() {
    if (busy || !holdLease()) return
    busy = true
    try {
      const st = readJson(STATE) ?? emptyState()
      const t = now()
      const due = agents.filter(a => t - agentState(st, a.id).last >= a.every)
      if (!due.length && t - lastSummary < SUMMARY_MS) return
      const needDaily = due.some(a => a.id !== 'oracle' && a.id !== 'hodl')
      const ctxBase = {
        config: configOf(),
        readings: due.some(a => a.id === 'oracle' || a.stateful) ? readings() : {},
        daily: needDaily ? daily() : {},
      }
      const heldCoins = agents.flatMap(a => agentState(st, a.id).held.map(h => h.coin))
      const mk = await marketWith(heldCoins)
      ctxBase.funding = mk.funding ?? {}
      ctxBase.marks = mk.marks ?? {}
      for (const a of due) {
        const as = agentState(st, a.id)
        try { run(a, as, ctxBase, mk) } catch (e) { as.journal.push({ t, kind: 'error', why: String(e.message).slice(0, 200) }); log.warn?.(`[agents] ${a.id}: ${e.message}`) }
        as.last = t
        if (as.journal.length > JOURNAL_KEEP) as.journal = as.journal.slice(-JOURNAL_KEEP)
      }
      // Coins just opened need their prices for the board.
      const mk2 = due.length ? await marketWith(agents.flatMap(a => agentState(st, a.id).held.map(h => h.coin))) : mk
      summarize(st, mk2)
      lastSummary = t
      writeJson(STATE, st)
    } catch (e) {
      log.warn?.('[agents] tick failed:', e.message)
    } finally { busy = false }
  }

  return { tick, secret: secretOf, summaryFile: SUMMARY, configOf, saveConfig, _state: () => readJson(STATE) }
}

/** The latest 24h call per market from the Oracle's log entries ({ coin, hours, score, sigma, t }). */
export function latestReadings(entries, hours = 24) {
  const out = {}
  for (const e of entries ?? []) {
    if (e?.hours !== hours || !Number.isFinite(e.score)) continue
    if (!out[e.coin] || e.t > out[e.coin].t) out[e.coin] = { score: e.score, sigma: e.sigma, t: e.t }
  }
  return out
}
