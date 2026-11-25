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
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENTS, planOf, sizeFor, maxDrawdown, thin } from './agents.js'
import { marketFor } from './paperhost.js'
import { rektAgent, cleanConfig, initLearn } from './rekt.js'
import { tradeWindows } from './tradegroup.js'
import { trackRecord, openLossOf, holdsStep } from './trackrecord.js'
import { posHealthPct } from './posgroup.js'
import { agentName } from './paperboard.js'

/** Rekt-01's controls (POST /agents-control, dev mode): what each sets its status to. */
export const CONTROLS = { start: 'running', pause: 'paused', stop: 'stopped', restart: 'running', clear: null }

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
  // The agents' rows on the paper leaderboard, and their trades for its Visit view (src/paperboard.js).
  const BOARD = join(dir, 'board.json')
  // Rekt-01's settings (src/rekt.js), written by POST /agents-config in dev mode, read every run.
  const CONFIG = join(dir, 'rekt-config.json')
  const configOf = () => cleanConfig(readJson(CONFIG) ?? {})
  // The settings form does not carry the status: the controls own it, so a save never un-stops it.
  function saveConfig(c) { const cfg = cleanConfig({ ...c, status: configOf().status }); writeJson(CONFIG, cfg); return cfg }
  // A control is queued for the worker holding the lease — the only one that may touch state.json
  // and the paper store — and the status written now, so the board says it at once.
  const COMMANDS = join(dir, 'rekt-commands.json')
  function control(action) {
    if (!Object.hasOwn(CONTROLS, action)) throw new Error('unknown control')
    const q = readJson(COMMANDS)
    writeJson(COMMANDS, [...(Array.isArray(q) ? q : []), { action, t: now() }].slice(-20))
    const status = CONTROLS[action]
    const cfg = status ? cleanConfig({ ...configOf(), status }) : configOf()
    writeJson(CONFIG, cfg)
    return cfg
  }
  function takeCommands() {
    if (!existsSync(COMMANDS)) return []
    const work = COMMANDS + '.work'
    try { renameSync(COMMANDS, work) } catch { return [] }
    const q = readJson(work)
    try { unlinkSync(work) } catch {}
    return Array.isArray(q) ? q : []
  }
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

  /**
   * Close everything at the mark and cancel its stops: stop, restart. Not the agent's choice, so
   * the trade teaches its stop/hold arms nothing and the coin does not cool down.
   */
  function flatten(a, as, mk, why) {
    const t = now()
    return paperHost.withStore(secretOf(), a.id, mk, (P) => {
      reconcile(P, a, as)
      for (const p of [...P.paperStore().positions].filter(x => x.szi)) {
        const before = P.paperFills().length
        const r = order(P, p.coin, p.szi < 0, Math.abs(p.szi), { reduce: true })
        if (r.error) { as.journal.push({ t, kind: 'error', coin: p.coin, why: r.error }); continue }
        const f = P.paperFills().slice(0, P.paperFills().length - before)
        as.journal.push({ t, kind: 'close', coin: p.coin, side: sideOf(p.szi), px: r.px, pnl: f.reduce((s, x) => s + Number(x.closedPnl || 0) - Number(x.fee || 0), 0), why })
        if (as.learn?.open) delete as.learn.open[p.coin]
      }
      for (const o of [...P.paperStore().orders]) P.paperCancel(o.oid)
      as.held = []
    })
  }

  /** One queued control, applied by the leased worker. Status is already in the config. */
  function applyCommand(st, { action, t }, mk) {
    const a = agents.find(x => x.personal)
    if (!a) return
    const as = agentState(st, a.id)
    if (action === 'clear') {
      // A clean slate: a fresh $1,000 paper account, no record, nothing learned.
      paperHost.withStore(secretOf(), a.id, mk, (P) => P.paperReset())
      st.agents[a.id] = { last: 0, held: [], cool: {}, curve: [], journal: [{ t, kind: 'note', why: 'track cleared: a fresh $1,000 and nothing learned' }], learn: initLearn(t) }
      return
    }
    if (action === 'stop' || action === 'restart') flatten(a, as, mk, action === 'stop' ? 'stopped by you' : 'restarted by you')
    if (action === 'restart') as.cool = {}
    as.journal.push({ t, kind: 'note', why: { start: 'started by you', pause: 'paused by you: keeps what it holds, opens nothing new', stop: 'stopped by you: holds nothing until started', restart: 'restarted by you: closed everything, deciding afresh' }[action] })
    // Start and restart act now, not at the end of the hour.
    if (action === 'start' || action === 'restart') as.last = 0
  }

  /**
   * One agent as a paper-board row — the fields and the track record main.js _lbPaperPayload
   * posts for a person's account, from the same modules, so the board and its Visit view render
   * it with no special case.
   */
  function boardRow(P, a) {
    const s = P.paperStore()
    const pos = P.paperPerpState().assetPositions
    const fills = s.fills ?? []
    const closed = fills.filter(f => parseFloat(f.closedPnl ?? 0) !== 0)
    const track = trackRecord({
      windows: tradeWindows(closed), portfolio: P.paperPortfolio(),
      lastFillAt: fills.reduce((m, f) => Math.max(m, +f.time || 0), 0) || null,
      openLoss: openLossOf(pos), holds: holdsStep(null, fills),
    })
    const health = pos.map(({ position: p }) => posHealthPct(p.szi, p.entryPx, p.liquidationPx, P.paperMark(p.coin))).filter(Number.isFinite)
    return {
      row: {
        name: agentName(a.name), agent: true, agentId: a.id,
        equity: P.paperEquity(), pnl: P.paperPnl(), trades: track.trades, wins: track.wins, track,
        unrealizedPnl: pos.reduce((x, ap) => x + parseFloat(ap.position?.unrealizedPnl ?? 0), 0),
        realizedPnl: closed.reduce((x, f) => x + parseFloat(f.closedPnl ?? 0), 0),
        volume: fills.reduce((x, f) => x + Math.abs(parseFloat(f.sz ?? 0)) * parseFloat(f.px ?? 0), 0),
        healthPct: health.length ? Math.min(...health) : 100,
        positions: pos, openOrders: P.paperOpenOrders(), created: s.created ?? null,
      },
      fills: fills.slice(0, 200).map(f => ({ coin: f.coin, tid: f.tid, time: f.time, side: f.side, px: f.px, sz: f.sz, closedPnl: f.closedPnl, fee: f.fee, startPosition: f.startPosition ?? null, dir: f.dir })),
    }
  }

  /** The board: every agent's account now, its curve and its journal → dir/summary.json. */
  function summarize(st, mk) {
    const t = now()
    const cfg = configOf()
    const rows = [], boards = []
    for (const a of agents) {
      const as = agentState(st, a.id)
      const acct = paperHost.withStore(secretOf(), a.id, mk, (P) => {
        reconcile(P, a, as)
        const ps = P.paperPerpState()
        return {
          equity: P.paperEquity(), deposited: P.paperDeposited(),
          // What a position row on the Trade screen shows. liq null is HL's "cannot be liquidated on
          // price alone", not zero; funding is the cashflow (+ received), HL's sinceOpen negated.
          positions: ps.assetPositions.map(({ position: p }) => ({ coin: p.coin, szi: Number(p.szi), entryPx: Number(p.entryPx), mark: P.paperMark(p.coin), upnl: Number(p.unrealizedPnl), lev: p.leverage?.value ?? null, value: Number(p.positionValue),
            liq: p.liquidationPx == null ? null : Number(p.liquidationPx), margin: Number(p.marginUsed), cross: p.leverage?.type !== 'isolated', funding: -Number(p.cumFunding?.sinceOpen ?? 0) })),
          cash: Number(ps.withdrawable),
          stops: P.paperStore().orders.filter(o => o.isTrigger).map(o => ({ coin: o.coin, px: o.triggerPx, tp: o.tpsl === 'tp' })),
          board: boardRow(P, a),
        }
      })
      boards.push({ id: a.id, hidden: a.personal ? !cfg.arena : false, row: { ...acct.board.row, updated: t }, fills: acct.board.fills })
      const lastPt = as.curve.at(-1)
      if (!lastPt || t - lastPt[0] >= HOUR) as.curve.push([t, acct.equity])
      const closed = as.journal.filter(j => (j.kind === 'close' || j.kind === 'stop') && Number.isFinite(j.pnl))
      const curve = [...as.curve, [t, acct.equity]]
      rows.push({
        id: a.id, name: a.name, color: a.color, blurb: a.blurb, lev: a.levOf?.(cfg) ?? a.lev, max: a.maxOf?.(cfg) ?? a.max, every: a.every, baseline: !!a.baseline,
        ...(a.personal ? { personal: true, hidden: !cfg.arena, config: cfg, learn: a.describe(as.learn ?? initLearn(t), cfg) } : {}),
        equity: acct.equity, start: acct.deposited, ret: (acct.equity / acct.deposited - 1) * 100,
        maxDD: maxDrawdown(curve), trades: closed.length, wins: closed.filter(j => j.pnl > 0).length,
        realized: closed.reduce((x, j) => x + j.pnl, 0), cash: Number.isFinite(acct.cash) ? acct.cash : null,
        positions: acct.positions, stops: acct.stops, last: as.last, next: as.last + a.every,
        curve: thin(curve, 400), journal: as.journal.slice(-80).reverse(),
      })
    }
    writeJson(SUMMARY, { at: t, started: st.started, agents: rows })
    writeJson(BOARD, { at: t, agents: boards })
  }

  let busy = false, lastSummary = 0
  async function tick() {
    if (busy || !holdLease()) return
    busy = true
    try {
      const st = readJson(STATE) ?? emptyState()
      const t = now()
      const cmds = takeCommands()
      if (!cmds.length && !agents.some(a => t - agentState(st, a.id).last >= a.every) && t - lastSummary < SUMMARY_MS) return
      if (cmds.length) {
        const m0 = await marketWith(agents.flatMap(a => agentState(st, a.id).held.map(h => h.coin)))
        for (const c of cmds) { try { applyCommand(st, c, m0) } catch (e) { log.warn?.(`[agents] control ${c.action}: ${e.message}`) } }
      }
      const due = agents.filter(a => t - agentState(st, a.id).last >= a.every)
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

  return { tick, secret: secretOf, summaryFile: SUMMARY, boardFile: BOARD, configOf, saveConfig, control, _state: () => readJson(STATE) }
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
