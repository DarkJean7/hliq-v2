#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Grid Ladder bot (one rung of the ladder)
 *
 * One long-only arithmetic grid on the HYPE perp, in its own Hyperliquid account. The ladder is
 * five of these processes, spawned and supervised by server.js like every other bot (encrypted
 * key, auto-resume after a deploy, pause/resume by signal), each in its own account so one
 * bot's error, margin call or crash cannot touch another's.
 *
 * The strategy is src/gridladder.js, sequenced by src/gridrunner.js, persisted by
 * strategies/_gridstore.js (SQLite). This file is only the Hyperliquid adapter and the wiring:
 * the socket (fills, order updates, best bid/offer), the timers, and the signals.
 *
 *   node strategies/gridladder.js --address 0xMASTER [--vault 0xSUBACCOUNT] --bot 1 \
 *     --low 50 --high 70 [--levels 10] [--usd 20] [--leverage 3] [--margin isolated] \
 *     [--kill 0] [--network testnet|dry|mainnet] [--mainnet-ok]
 *
 * NETWORK: testnet by default. Mainnet needs BOTH --network mainnet AND --mainnet-ok, which the
 * panel only sends after the owner has turned mainnet on and confirmed it. dry runs the real
 * runner against src/gridsim.js, priced from live mainnet mids: no orders leave this process.
 *
 * STOPPING: server.js writes the stop mode (stop / close) to the store, then SIGTERMs. A
 * SIGTERM without one is a deploy or a restart: the bot just exits and its orders stay on the
 * book — the next process picks them up by cloid.
 */
import { ExchangeClient, InfoClient, HttpTransport, WebSocketTransport, SubscriptionClient } from '@nktkas/hyperliquid'
import { ethers } from 'ethers'
import { parseArgs } from 'node:util'
import { isPaused, onPause, onResume } from './_pause.js'
import { createRunner } from '../src/gridrunner.js'
import { createSimExchange } from '../src/gridsim.js'
import { LADDER_COIN } from '../src/gridladder.js'
import { sqliteStore, ladderKey } from './_gridstore.js'

const { values: args } = parseArgs({
  options: {
    address: { type: 'string' }, vault: { type: 'string', default: '' }, wallet: { type: 'string' },
    bot: { type: 'string', default: '1' },
    low: { type: 'string' }, high: { type: 'string' }, levels: { type: 'string', default: '10' },
    usd: { type: 'string', default: '20' }, leverage: { type: 'string', default: '3' }, margin: { type: 'string', default: 'isolated' },
    kill: { type: 'string', default: '0' },
    network: { type: 'string', default: 'testnet' }, 'mainnet-ok': { type: 'boolean', default: false },
    'dry-cash': { type: 'string', default: '1000' },
    db: { type: 'string' }, plan: { type: 'boolean', default: false },
  },
  strict: false,
})

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const BOT = parseInt(args.bot, 10)
const log = (tag, msg) => console.log(`[${ts()}] [L${BOT}] [${tag}] ${msg}`)
const die = (msg) => { console.error(`[${ts()}] [L${BOT}] [FATAL] ${msg}`); process.exit(1) }

const NETWORK = String(args.network).toLowerCase()
if (!['testnet', 'mainnet', 'dry'].includes(NETWORK)) die(`unknown network "${args.network}"`)
if (NETWORK === 'mainnet' && !args['mainnet-ok']) die('Mainnet is off for the Grid Ladder. Turn it on in the panel (it sends --mainnet-ok) or run on testnet.')
if (!Number.isInteger(BOT) || BOT < 1 || BOT > 15) die('--bot must be 1–15')
const MASTER = String(args.address ?? '').toLowerCase()
const VAULT = String(args.vault ?? '').toLowerCase()
const ADDR_RE = /^0x[0-9a-f]{40}$/
if (!ADDR_RE.test(MASTER)) die('--address is required')
if (VAULT && !ADDR_RE.test(VAULT)) die('--vault must be an address')
const TRADE = VAULT || MASTER                    // the account that holds the position
const cfg = {
  id: BOT, low: +args.low, high: +args.high, levels: parseInt(args.levels, 10), usd: +args.usd,
  leverage: parseInt(args.leverage, 10), margin: String(args.margin), killPrice: +args.kill || 0,
}
if (args.plan) { console.log(JSON.stringify({ plan: cfg })); process.exit(0) }

const KEY = process.env.AGENT_KEY || args.wallet
if (!KEY && NETWORK !== 'dry') die('agent key not provided')

const store = sqliteStore(args.db || undefined)
const key = ladderKey(NETWORK, TRADE, BOT)

// ── the exchange ─────────────────────────────────────────────────────────────
const mainnetInfo = new InfoClient({ transport: new HttpTransport({ timeout: 20_000 }) })
let ex, ws = null, sim = null
if (NETWORK === 'dry') {
  const mids = await mainnetInfo.allMids()
  sim = createSimExchange({ szDecimals: 2, maxLeverage: 10, mid: +mids[LADDER_COIN], cash: +args['dry-cash'] || 1000, time: Date.now() })
  const meta = (await mainnetInfo.meta()).universe.find(u => u.name === LADDER_COIN)
  sim.meta = async () => ({ szDecimals: meta.szDecimals, maxLeverage: meta.maxLeverage })
  ex = sim
  ex.account = async () => ({ pos: sim.pos, accountValue: await sim.accountValue() })
  // A dry run's book lives in this process. Picked up again after a restart it would disagree
  // with the store, so a dry bot always starts a fresh run (its lifetime totals carry over).
  const prev = store.load(key)
  if (prev) { prev.needsFresh = true; prev.pairs = []; store.save(key, prev) }
} else {
  const isTestnet = NETWORK === 'testnet'
  const transport = new HttpTransport({ isTestnet, timeout: 30_000 })
  const info = new InfoClient({ transport })
  const wallet = new ethers.Wallet(KEY)
  const exch = new ExchangeClient({ transport, wallet, ...(VAULT ? { defaultVaultAddress: VAULT } : {}) })
  const metaAll = await info.meta()
  const asset = metaAll.universe.findIndex(u => u.name === LADDER_COIN)
  if (asset < 0) die(`${LADDER_COIN} is not listed on ${NETWORK}`)
  const m = metaAll.universe[asset]
  // Every batch returns one status per order. The SDK throws when any of them is an error, but
  // keeps the response, so the orders that DID go through are not lost with the one that did not.
  const statuses = async (fn) => {
    try { return (await fn())?.response?.data?.statuses ?? [] }
    catch (e) { const s = e?.response?.response?.data?.statuses; if (Array.isArray(s)) return s; throw e }
  }
  ex = {
    meta: async () => ({ szDecimals: m.szDecimals, maxLeverage: m.maxLeverage }),
    mid: async () => +(await info.allMids())[LADDER_COIN],
    bbo: async () => { const b = await info.l2Book({ coin: LADDER_COIN }); return { bid: +b?.levels?.[0]?.[0]?.px || 0, ask: +b?.levels?.[1]?.[0]?.px || 0 } },
    openOrders: async () => (await info.frontendOpenOrders({ user: TRADE })).filter(o => o.coin === LADDER_COIN)
      .map(o => ({ oid: o.oid, cloid: o.cloid ?? null, px: +o.limitPx, sz: +o.sz, isBuy: o.side === 'B', reduceOnly: !!o.reduceOnly })),
    fillsSince: async (t) => (await info.userFillsByTime({ user: TRADE, startTime: Math.max(0, Math.floor(t)) })).filter(f => f.coin === LADDER_COIN),
    position: async () => { const s = await info.clearinghouseState({ user: TRADE }); const p = s.assetPositions.find(a => a.position.coin === LADDER_COIN)?.position; return { szi: +(p?.szi ?? 0), entryPx: +(p?.entryPx ?? 0) } },
    accountValue: async () => {
      const [perp, spot] = await Promise.all([info.clearinghouseState({ user: TRADE }), info.spotClearinghouseState({ user: TRADE }).catch(() => null)])
      const usdc = +(spot?.balances?.find(b => b.coin === 'USDC')?.total ?? 0)
      return +perp.marginSummary.accountValue + usdc
    },
    // One read for the panel's position and account value (perp + spot USDC on a unified account).
    account: async () => {
      const [perp, spot] = await Promise.all([info.clearinghouseState({ user: TRADE }), info.spotClearinghouseState({ user: TRADE }).catch(() => null)])
      const p = perp.assetPositions.find(a => a.position.coin === LADDER_COIN)?.position
      return { pos: +(p?.szi ?? 0), accountValue: +perp.marginSummary.accountValue + +(spot?.balances?.find(b => b.coin === 'USDC')?.total ?? 0) }
    },
    funding: async (since) => -(await info.userFunding({ user: TRADE, startTime: Math.max(0, Math.floor(since)) }))
      .filter(f => f.delta?.coin === LADDER_COIN).reduce((s, f) => s + +f.delta.usdc, 0),
    setLeverage: (lev, isolated) => exch.updateLeverage({ asset, isCross: !isolated, leverage: lev }),
    place: async (list) => {
      try {
        return await statuses(() => exch.order({
          orders: list.map(o => ({ a: asset, b: o.isBuy, p: String(o.px), s: String(o.sz), r: !!o.reduceOnly, t: { limit: { tif: o.tif } }, c: o.cloid })),
          grouping: 'na',
        }))
      } catch (e) {
        // Unknown outcome (timeout, network). The cloids are deterministic, so the next full
        // reconcile finds whatever did land and keeps it rather than placing it again.
        setTimeout(() => runner.reconcile('unknown order outcome'), 3_000)
        return list.map(() => ({ error: e?.message ?? String(e) }))
      }
    },
    cancel: async (cloids) => {
      try { return await statuses(() => exch.cancelByCloid({ cancels: cloids.map(cloid => ({ asset, cloid })) })) }
      catch (e) { return cloids.map(() => ({ error: e?.message ?? String(e) })) }
    },
  }
  ws = new WebSocketTransport({ isTestnet })
}

const runner = createRunner({ key, botId: BOT, cfg, ex, store, log })

// ── live numbers for the panel, written with the state ───────────────────────
// Budgeted: Hyperliquid limits by IP and this server runs every bot. One account read a minute,
// funding (weight 20) every ten, the price from the socket — about 90 weight a minute for all
// five bots, reconciles included.
let fundingCache = { at: 0, v: 0 }, lastMid = 0
async function writeLive() {
  const st = runner.state
  if (!st) return
  try {
    if (Date.now() - fundingCache.at > 10 * 60_000) fundingCache = { at: Date.now(), v: await ex.funding(st.startedAt) }
    const mid = lastMid || await ex.mid()
    const { pos, accountValue } = await ex.account()
    const funding = fundingCache.v
    const openBuyNotional = st.pairs.filter(p => p.placed && p.phase === 'B').reduce((s, p) => s + (p.px ?? st.prices[p.i]) * (p.sz - p.filled), 0)
    st.live = { mid, pos, accountValue, funding, openBuyNotional, at: Date.now(), network: NETWORK, trade: TRADE, master: MASTER, vault: VAULT, bot: BOT, paused: runner.paused }
    store.save(key, st)
  } catch (e) { log('WARN', `live numbers: ${e.message}`) }
}

// ── stopping ─────────────────────────────────────────────────────────────────
let exiting = false
process.on('SIGTERM', async () => {
  if (exiting) return
  exiting = true
  const ctl = store.control(key)
  if (ctl && Date.now() - ctl.at < 10 * 60_000 && (ctl.cmd === 'stop' || ctl.cmd === 'close')) {
    log('STOP', ctl.cmd === 'close' ? 'cancelling and closing' : 'cancelling, keeping the position')
    try { await runner.stop(ctl.cmd === 'close' ? 'close' : 'cancel'); await runner.idle() }
    catch (e) { log('ERROR', `stop: ${e.message}`) }
    store.clearControl(key)
  } else log('EXIT', 'restart: orders stay on the book and are picked up by cloid')
  process.exit(0)
})
onPause(() => runner.pause())
onResume(() => runner.resume())

// ── run ──────────────────────────────────────────────────────────────────────
try { await runner.start() } catch (e) { die(e.message) }
if (isPaused()) await runner.pause()
log('START', `${NETWORK} · ${VAULT ? 'subaccount ' + VAULT : 'account ' + MASTER} · ${cfg.low}–${cfg.high} · ${cfg.levels} levels · $${cfg.usd}/level · ${cfg.leverage}× ${cfg.margin}${cfg.killPrice ? ' · kill ' + cfg.killPrice : ''}`)

const afterKill = () => { if (runner.state?.killed) { log('KILL', 'kill price hit — position closed, bot stopped'); process.exit(0) } }

if (NETWORK === 'dry') {
  // Live mainnet prices drive the simulated book: every crossing fills, the runner hears it.
  sim.onFills(f => runner.onFills(f))
  sim.onOrderUpdates(u => runner.onOrderUpdates(u))
  setInterval(async () => {
    try { const mid = +(await mainnetInfo.allMids())[LADDER_COIN]; if (mid > 0) { lastMid = mid; sim.setMid(mid, Date.now()); await runner.tick(mid); afterKill() } }
    catch (e) { log('WARN', `price: ${e.message}`) }
  }, 5_000)
} else {
  const subs = new SubscriptionClient({ transport: ws })
  let lastTick = 0, opened = 0
  await subs.userFills({ user: TRADE }, (d) => {
    if (d?.isSnapshot) return                       // the reconcile reads history itself
    const fills = (d?.fills ?? []).filter(f => f.coin === LADDER_COIN)
    if (fills.length) runner.onFills(fills).then(afterKill)
  })
  await subs.orderUpdates({ user: TRADE }, (ups) => runner.onOrderUpdates((ups ?? []).filter(u => u?.order?.coin === LADDER_COIN).map(u => ({ ...u, order: { ...u.order, cloid: u.order?.cloid } }))))
  await subs.bbo({ coin: LADDER_COIN }, (d) => {
    const bid = +d?.bbo?.[0]?.px, ask = +d?.bbo?.[1]?.px
    if (!(bid > 0 && ask > 0) || Date.now() - lastTick < 2_000) return
    lastTick = Date.now()
    lastMid = (bid + ask) / 2
    runner.tick(lastMid).then(afterKill)
  })
  // Every reconnect after the first: what happened while the socket was down is read back.
  ws.socket.addEventListener('open', () => { if (opened++ > 0) { log('WS', 'reconnected — reconciling'); runner.reconcile('reconnect') } })
  opened = 1
}

// The socket carries fills and cancels as they happen; this catches anything it missed.
setInterval(() => runner.reconcile('timer').then(afterKill), 5 * 60_000)
setInterval(writeLive, 60_000)
writeLive()
