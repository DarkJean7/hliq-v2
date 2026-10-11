#!/usr/bin/env node
/**
 * INSOLVENT TERMINAL — Portfolio bot
 *
 * Runs a /portfolios basket live with one strategy, the same rules the page backtests:
 *   an ALLOCATION strategy — buy & hold, rebalance monthly / weekly / on drift, DCA, the trend
 *     filter — decided in src/pflive.js; or
 *   a TRADING strategy (--strategy bot:rsi, bot:macd, …) — each holding its own sub-account,
 *     copying the trade the backtest's own engine is in on its latest candles: src/pfsignal.js.
 * Both are pure and tested; this file fetches, places and remembers.
 *
 * It trades perps on the main dex and on HIP-3 builder dexes (xyz:NVDA). Spot holdings are
 * skipped and named in the log; their weight is spread over the rest.
 *
 * The bot keeps a LEDGER of what it bought (units per market, cash left) and trades only the
 * gap between that ledger and its targets — never "the position", which the account may share
 * with manual trades or other bots. See src/pflive.js.
 *
 * Usage:
 *   node strategies/portfolio.js --address 0xMASTER --id P1 --items <base64 json> \
 *     --strategy monthly --budget 1000 [--leverage 1|max] [--margin cross|isolated] \
 *     [--monthDay 1] [--weekDay 1] [--band 0.05] [--dcaEvery 7] [--dcaBuys 8] [--dcaUpfront 0] \
 *     [--trendDays 50] [--trendBuffer 0] [--interval 5] [--fresh] [--plan]
 * The agent key comes in AGENT_KEY (never argv).
 */

import { ExchangeClient, InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { ethers } from 'ethers'
import { parseArgs } from 'node:util'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { isPaused, onPause, onResume } from './_pause.js'
import { botCloid } from '../src/cloid.js'
import { installPaperExchange } from '../src/paperexchange.js'
import { LIVE_STRATEGIES, LIVE_DEFAULTS, HL_MIN_ORDER, liveWeights, liveLeverage, freshLedger, equityOf, smaOf, decide, ordersFor, applyFill, reconcile, dayOf } from '../src/pflive.js'
import { SIGNAL_STRATEGIES, TF_MS, WARMUP, closedCandles, simOpenTrade, decideHolding, openSize, freshSubs, subFill } from '../src/pfsignal.js'

const { values: args } = parseArgs({
  options: {
    wallet: { type: 'string' }, address: { type: 'string' },
    id: { type: 'string' }, name: { type: 'string' }, items: { type: 'string' },
    strategy: { type: 'string', default: 'hold' }, budget: { type: 'string' },
    leverage: { type: 'string', default: '1' }, margin: { type: 'string', default: 'cross' },
    monthDay: { type: 'string' }, weekDay: { type: 'string' }, band: { type: 'string' },
    dcaEvery: { type: 'string' }, dcaBuys: { type: 'string' }, dcaUpfront: { type: 'string' },
    trendDays: { type: 'string' }, trendBuffer: { type: 'string' },
    // Trading strategies: the candle, both directions or only each holding's own, and the
    // strategy's own settings (base64 JSON, as the page's cards hold them).
    tf: { type: 'string', default: '4h' }, both: { type: 'boolean', default: false }, sparams: { type: 'string' },
    interval: { type: 'string' },                        // minutes between checks (5 allocation, 1 trading)
    slippage: { type: 'string', default: '1' },          // % the IOC limit may cross the mid
    fee: { type: 'string', default: '0.045' },           // % taker fee, for the ledger
    paper: { type: 'string' },                           // a paper account (its slot): trade it instead of Hyperliquid
    fresh: { type: 'boolean', default: false },          // start a new ledger even if one is saved…
    run: { type: 'string', default: '' },                // …unless it is this run's own (a restart or resume)
    resume: { type: 'boolean', default: false },
    plan: { type: 'boolean', default: false },
  },
  strict: false,
})

const PLAN = !!args.plan
function log(tag, msg) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19)
  console.log(`[${ts}] [${tag.padEnd(8)}] ${String(msg).replace(/\s+/g, ' ').slice(0, 400)}`)
}
function fail(msg) {
  if (PLAN) console.log('__PLAN__' + JSON.stringify({ ok: false, error: msg }))
  else log('ERROR', msg)
  process.exit(1)
}

let walletKey = process.env.AGENT_KEY || args.wallet
if (!walletKey) fail('agent key not provided')
// PAPER: the same bot, trading a paper account (src/paperexchange.js). What arrives in AGENT_KEY
// is then the paper owner's secret, never a wallet key; the SDK signs with a throwaway one,
// since nothing checks a paper order's signature.
const PAPER = args.paper ? String(args.paper) : null
if (PAPER) {
  if (!/^[a-z0-9]{1,40}$/.test(PAPER)) fail('bad paper account')
  if (!/^[0-9a-f]{64}$/.test(walletKey)) fail('paper runs need the paper owner')
  installPaperExchange({ secret: walletKey, slot: PAPER, dir: process.env.PAPER_DIR || path.join(process.cwd(), 'data', 'paper'), log: (m) => log('PAPER', m) })
  walletKey = ethers.Wallet.createRandom().privateKey
}
const ID = String(args.id ?? '').toUpperCase()
if (!/^[A-Z0-9_-]{1,40}$/.test(ID)) fail('a portfolio id is required')
const NAME = String(args.name ?? ID).slice(0, 40)
const STRATEGY = String(args.strategy)
// A trading strategy is 'bot:<id>' — the allocation and trading lists share names (trend, dca).
const BOT = STRATEGY.startsWith('bot:') ? STRATEGY.slice(4) : null
if (BOT ? !SIGNAL_STRATEGIES.includes(BOT) : !LIVE_STRATEGIES.includes(STRATEGY)) fail(`unknown strategy "${STRATEGY}"`)
const BUDGET = Number(args.budget)
if (!(BUDGET >= HL_MIN_ORDER)) fail(`a budget of at least $${HL_MIN_ORDER} is required`)
let ITEMS
try { ITEMS = JSON.parse(Buffer.from(String(args.items ?? ''), 'base64').toString('utf8')) } catch { fail('the holdings could not be read') }
if (!Array.isArray(ITEMS) || !ITEMS.length) fail('the portfolio has no holdings')
const LEV = String(args.leverage) === 'max' ? 'max' : Math.max(1, Math.round(Number(args.leverage) || 1))
const ISOLATED = String(args.margin) === 'isolated'
const num = (k, scale = 1) => (args[k] != null && Number.isFinite(Number(args[k])) ? Number(args[k]) * scale : LIVE_DEFAULTS[k])
const PARAMS = { monthDay: num('monthDay'), weekDay: num('weekDay'), band: num('band'), dcaEvery: num('dcaEvery'), dcaBuys: num('dcaBuys'), dcaUpfront: num('dcaUpfront'), trendDays: num('trendDays'), trendBuffer: num('trendBuffer') }
const CHECK_MS = Math.max(1, Number(args.interval) || (BOT ? 1 : 5)) * 60_000
const TF = TF_MS[args.tf] ? args.tf : '4h'
const BOTH = !!args.both
let SPARAMS = {}
if (args.sparams) { try { SPARAMS = JSON.parse(Buffer.from(String(args.sparams), 'base64').toString('utf8')) ?? {} } catch { fail('the strategy settings could not be read') } }
const SLIP = Math.min(0.05, Math.max(0.001, (Number(args.slippage) || 1) / 100))
const FEE = Math.max(0, Number(args.fee) || 0.045) / 100
const RUN = String(args.run ?? '').slice(0, 40)

const { weights: W, skipped: SKIPPED } = liveWeights(ITEMS)
const COINS = Object.keys(W)
if (!COINS.length) fail('nothing here the bot can trade: spot holdings are not supported yet')

const transport = new HttpTransport()
const info = new InfoClient({ transport })
const exchange = new ExchangeClient({ transport, wallet: new ethers.Wallet(walletKey) })
const QUERY_ADDR = args.address ?? new ethers.Wallet(walletKey).address
const dexOf = (c) => (c.includes(':') ? c.split(':')[0].toLowerCase() : '')
const DEXES = [...new Set(COINS.map(dexOf))]

// ── markets: asset id, size decimals, max leverage, isolated-only ──
const META = {}
async function loadMeta() {
  const builders = DEXES.filter(Boolean)
  const dexs = builders.length ? await info.perpDexs() : []
  for (const dex of DEXES) {
    const m = dex ? await info.meta({ dex }) : await info.meta()
    const di = dex ? (dexs ?? []).findIndex(d => d && d.name === dex) : 0
    if (dex && di < 1) throw new Error(`unknown builder dex ${dex}`)
    ;(m.universe ?? []).forEach((u, i) => {
      const name = dex && !u.name.includes(':') ? `${dex}:${u.name}` : u.name
      META[name] = { index: dex ? 100000 + di * 10000 + i : i, szDecimals: u.szDecimals ?? 4, maxLev: u.maxLeverage ?? 1, onlyIsolated: !!u.onlyIsolated || /strictIsolated|noCross/i.test(String(u.marginMode ?? '')), delisted: !!u.isDelisted }
    })
  }
  const bad = COINS.filter(c => !META[c] || META[c].delisted)
  if (bad.length) throw new Error(`not tradable on Hyperliquid: ${bad.join(', ')}`)
}
const levBy = () => Object.fromEntries(COINS.map(c => [c, liveLeverage(LEV, META[c].maxLev)]))

async function prices() {
  const px = {}
  for (const dex of DEXES) {
    const mids = dex ? await info.allMids({ dex }) : await info.allMids()
    for (const c of COINS) if (dexOf(c) === dex) {
      const v = Number(mids[c] ?? mids[c.split(':')[1]])
      if (v > 0) px[c] = v
    }
  }
  return px
}

/** Net position per market, as the exchange has it; only markets that were read. */
async function held() {
  const out = {}
  let free = 0
  for (const dex of DEXES) {
    const s = dex ? await info.clearinghouseState({ user: QUERY_ADDR, dex }) : await info.clearinghouseState({ user: QUERY_ADDR })
    if (!dex) free = Number(s.withdrawable ?? 0)
    for (const c of COINS) if (dexOf(c) === dex) out[c] = 0
    for (const ap of s.assetPositions ?? []) {
      const n = dex && !ap.position.coin.includes(':') ? `${dex}:${ap.position.coin}` : ap.position.coin
      if (n in out) out[n] = Number(ap.position.szi ?? 0)
    }
  }
  return { held: out, free }
}

const sma = {}
let smaDay = null
async function averages(now) {
  if (STRATEGY !== 'trend' || smaDay === dayOf(now)) return
  const n = Math.max(2, Math.round(PARAMS.trendDays))
  for (const c of COINS) {
    try {
      const cs = await info.candleSnapshot({ coin: c, interval: '1d', startTime: now - (n + 3) * 86_400_000, endTime: now })
      // Completed days only, plus today's price, as the backtest's daily close does.
      const closes = cs.filter(k => Number(k.T ?? k.t) < dayOf(now)).map(k => Number(k.c))
      sma[c] = closes.length ? { closes } : null
    } catch (e) { log('WARN', `${c}: daily candles did not load (${e.message})`) }
  }
  smaDay = dayOf(now)
}
const smaNow = (px) => Object.fromEntries(COINS.map(c => [c, sma[c] ? smaOf([...sma[c].closes, px[c]], Math.round(PARAMS.trendDays)) : null]))

// ── the ledger on disk, so a restart carries on rather than buying everything again ──
const STATE_FILE = path.join(process.cwd(), '.portfolio-state.json')
const KEY = `${String(QUERY_ADDR).toLowerCase()}:${ID}`
const readAll = () => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
function save(ledger, extra = {}) {
  try {
    const all = readAll()
    all[KEY] = { ...ledger, name: NAME, strategy: STRATEGY, coins: COINS, skipped: SKIPPED, ...extra, at: Date.now() }
    writeFileSync(STATE_FILE, JSON.stringify(all))
  } catch (e) { log('WARN', `could not save the ledger: ${e.message}`) }
}

// Hyperliquid's price tick: at most 5 significant figures and (6 − size decimals) decimals.
const tickPx = (x, szDecimals) => { const sig = Number(Number(x).toPrecision(5)), dec = Math.max(0, 6 - szDecimals); return Math.round(sig * 10 ** dec) / 10 ** dec }

async function order(c, isBuy, sz, reduceOnly, mid) {
  const { index, szDecimals } = META[c]
  const p = tickPx(isBuy ? mid * (1 + SLIP) : mid * (1 - SLIP), szDecimals)
  const r = await exchange.order({ orders: [{ c: botCloid(process.env.HLIQ_BOT), a: index, b: isBuy, p: String(p), s: String(sz), r: reduceOnly, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' })
  const st = r?.response?.data?.statuses?.[0] ?? {}
  if (st.error) throw new Error(st.error)
  return { filled: Number(st.filled?.totalSz ?? 0), avgPx: Number(st.filled?.avgPx ?? 0) }
}

async function setLeverage() {
  const lb = levBy()
  for (const c of COINS) {
    const cross = !(ISOLATED || META[c].onlyIsolated)
    try { await exchange.updateLeverage({ asset: META[c].index, isCross: cross, leverage: lb[c] }) }
    catch (e) { log('WARN', `${c}: leverage not set (${e.message}); the market's current setting applies`) }
  }
}

let ledger
async function tick() {
  const now = Date.now()
  const px = await prices()
  const h = await held()
  const rc = reconcile(ledger, h.held)
  for (const f of rc.fixed) log('RECONCILE', `${f.coin}: the account holds less than the ledger (${f.from} → ${f.to}); closed outside the bot, so the ledger follows`)
  ledger = rc.ledger
  await averages(now)
  const d = decide({ strategy: STRATEGY, params: PARAMS, weights: W, ledger, px, levBy: levBy(), now, sma: smaNow(px) })
  if (d.trendOn) ledger = { ...ledger, trendOn: d.trendOn, lastEval: now }
  const eq = equityOf(ledger, px)
  if (!d.due) { log('HOLD', `${d.reason} · equity ${eq == null ? '?' : '$' + eq.toFixed(2)}`); save(ledger, { equity: eq, reason: d.reason }); return }
  log('REBAL', d.reason)
  if (d.release) ledger = { ...ledger, reserve: ledger.reserve - d.release, cash: ledger.cash + d.release }
  const szDec = Object.fromEntries(COINS.map(c => [c, META[c].szDecimals]))
  const { orders, tooSmall } = ordersFor(ledger.units, d.targets, px, szDec)
  if (tooSmall.length) log('SKIP', `under $${HL_MIN_ORDER}, left as they are: ${tooSmall.join(', ')}`)
  let failed = 0
  for (const o of orders) {
    try {
      const f = await order(o.coin, o.isBuy, o.sz, o.reduceOnly, px[o.coin])
      if (f.filled > 0) {
        ledger = applyFill(ledger, o.coin, o.isBuy ? f.filled : -f.filled, f.avgPx || px[o.coin], FEE)
        log('FILL', `${o.isBuy ? 'BUY ' : 'SELL'} ${f.filled} ${o.coin} @ $${f.avgPx}${o.reduceOnly ? ' (reduce-only)' : ''}`)
      } else { failed++; log('WARN', `${o.coin}: order did not fill; retrying next check`) }
    } catch (e) { failed++; log('ERROR', `${o.coin}: ${e.message}`) }
    save(ledger)
  }
  // A rebalance counts as done only when every order went through; otherwise the next check
  // tries again rather than waiting a month.
  if (!failed) ledger = { ...ledger, lastRebal: now, dcaDone: ledger.dcaDone + (STRATEGY === 'dca' ? 1 : 0) }
  else if (d.release) ledger = { ...ledger, reserve: ledger.reserve + d.release, cash: ledger.cash - d.release }
  const eq2 = equityOf(ledger, px)
  save(ledger, { equity: eq2, reason: d.reason })
  log('EQUITY', `$${eq2 == null ? '?' : eq2.toFixed(2)} of $${BUDGET} · fees $${ledger.fees.toFixed(2)}`)
}

// ── trading strategies: each holding a sub-account copying the backtest's trade ──────────
// Stops and targets rest on the exchange as reduce-only trigger orders, so they fill inside a
// candle as the backtest assumes, and keep protecting the position if the bot is stopped.
async function trigger(c, isBuy, sz, level, kind) {
  const { index, szDecimals } = META[c]
  const trig = tickPx(level, szDecimals)
  const lim = tickPx(isBuy ? trig * (1 + 3 * SLIP) : trig * (1 - 3 * SLIP), szDecimals)
  const r = await exchange.order({ orders: [{ c: botCloid(process.env.HLIQ_BOT), a: index, b: isBuy, p: String(lim), s: String(sz), r: true, t: { trigger: { isMarket: true, triggerPx: String(trig), tpsl: kind } } }], grouping: 'na' })
  const st = r?.response?.data?.statuses?.[0] ?? {}
  if (st.error) throw new Error(st.error)
  return st.resting?.oid ?? null
}
async function cancelTriggers(c, tr) {
  for (const oid of [tr.tpOid, tr.slOid]) if (oid) { try { await exchange.cancel({ cancels: [{ a: META[c].index, o: Number(oid) }] }) } catch { /* already filled or gone */ } }
}
/** The average price the exchange closed a trade at, from the account's fills since it opened. */
async function exitPrice(c, tr) {
  try {
    const fills = await info.userFillsByTime({ user: QUERY_ADDR, startTime: tr.openedAt })
    const closeSide = tr.side === 'long' ? 'A' : 'B'
    let q = 0, v = 0
    for (const fl of fills ?? []) {
      if (fl.coin !== c || fl.side !== closeSide || !/^Close/.test(fl.dir ?? '')) continue
      const take = Math.min(Number(fl.sz), tr.sz - q)
      if (take <= 0) break
      q += take; v += take * Number(fl.px)
    }
    return q > 0 ? v / q : null
  } catch { return null }
}
const sim = {}                                   // coin → { bar, trade } — the replay, once per closed candle
// What a holding's sub-account is worth: its cash plus its open trade at the price. NOT its cash
// alone — with a trade open that is negative (the position was bought on margin), and the replay,
// handed a negative balance, refuses the very trade it is in, so the bot closed it a candle later.
// Caught by tests/pfbot-e2e.mjs.
function subEquity(c, px) {
  const sub = ledger.subs[c], tr = sub?.trade
  const v = (sub?.cash ?? 0) + (tr ? (tr.side === 'long' ? 1 : -1) * tr.sz * (px[c] ?? tr.entry) : 0)
  return Math.max(1, v)
}
function settle(c, exitPx, why) {
  const sub = ledger.subs[c], tr = sub.trade
  const signed = tr.side === 'long' ? -tr.sz : tr.sz
  ledger = applyFill(ledger, c, signed, exitPx, FEE)
  const after = subFill(sub, signed, exitPx, FEE)
  ledger.subs = { ...ledger.subs, [c]: { ...after, trade: null, lastTime: tr.time } }
  const pnl = (tr.side === 'long' ? 1 : -1) * tr.sz * (exitPx - tr.entry)
  log('CLOSE', `${c} ${tr.side} ${tr.sz} @ $${exitPx} (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}): ${why}`)
}
async function signalTick() {
  const now = Date.now()
  const px = await prices()
  const h = await held()
  const lb = levBy()
  // 1. Closed by the exchange — its stop or target filled — or by hand: settle and wait.
  for (const c of COINS) {
    const tr = ledger.subs[c]?.trade
    if (!tr || !(c in h.held)) continue
    const have = h.held[c], want = tr.side === 'long' ? tr.sz : -tr.sz
    if (Math.sign(have) === Math.sign(want) && Math.abs(have) >= Math.abs(want) * 0.999) continue
    if (Math.sign(have) === Math.sign(want) && Math.abs(have) > 0) {
      ledger.subs[c] = { ...ledger.subs[c], trade: { ...tr, sz: Math.abs(have) } }
      log('RECONCILE', `${c}: the account holds ${Math.abs(have)} of this trade's ${tr.sz}; the bot manages what is left`)
      continue
    }
    await cancelTriggers(c, tr)
    settle(c, (await exitPrice(c, tr)) ?? px[c], 'closed on the exchange (its stop or target, or by hand)')
  }
  // 2. The replay, once per closed candle per holding.
  const bar = Math.floor(now / TF_MS[TF])
  for (const c of COINS) {
    if (sim[c]?.bar === bar) continue
    try {
      const cs = await info.candleSnapshot({ coin: c, interval: TF, startTime: now - (WARMUP + 2) * TF_MS[TF], endTime: now })
      const side = W[c] < 0 ? 'short' : 'long'
      const t = simOpenTrade(closedCandles(cs, TF, now), BOT, SPARAMS, { bal: subEquity(c, px), side, both: BOTH, lev: lb[c], margin: ISOLATED ? 'isolated' : 'cross', feeBps: FEE * 1e4 })
      sim[c] = { bar, trade: t }
    } catch (e) { log('WARN', `${c}: candles did not load (${e.message}); trying again next check`) }
    await new Promise(r => setTimeout(r, 250))                 // gentle on the shared rate limit
  }
  // 3. Copy it.
  for (const c of COINS) {
    const acts = decideHolding({ sim: sim[c]?.trade, cur: ledger.subs[c], startedAt: ledger.startedAt, tf: TF, now })
    for (const a of acts) {
      const sub = ledger.subs[c]
      if (a.do === 'close' && sub.trade) {
        const tr = sub.trade
        await cancelTriggers(c, tr)
        try {
          const fl = await order(c, tr.side !== 'long', tr.sz, true, px[c])
          if (fl.filled > 0) settle(c, fl.avgPx || px[c], 'the strategy closed it')
          else log('WARN', `${c}: close did not fill; trying again next check`)
        } catch (e) { log('ERROR', `${c}: close: ${e.message}`) }
      }
      if (a.do === 'open' && !ledger.subs[c].trade) {
        const t = a.trade, long = t.side === 'long'
        const sz = openSize(ledger.subs[c].cash, lb[c], px[c], META[c].szDecimals)
        if (sz * px[c] < HL_MIN_ORDER) {
          log('SKIP', `${c}: ${t.side} signal, but $${(sz * px[c]).toFixed(2)} is under Hyperliquid's $${HL_MIN_ORDER} minimum`)
          ledger.subs[c] = { ...ledger.subs[c], lastTime: t.time }
          continue
        }
        try {
          const fl = await order(c, long, sz, false, px[c])
          if (!(fl.filled > 0)) { log('WARN', `${c}: ${t.side} entry did not fill; trying again next check`); continue }
          const entry = fl.avgPx || px[c]
          ledger = applyFill(ledger, c, long ? fl.filled : -fl.filled, entry, FEE)
          const after = subFill(ledger.subs[c], long ? fl.filled : -fl.filled, entry, FEE)
          // The backtest's levels moved by however far the fill was from its entry price.
          const shift = entry - t.entry
          const tr = { time: t.time, side: t.side, sz: fl.filled, entry, openedAt: now - 60_000, tpOid: null, slOid: null,
            tp: t.tp != null ? t.tp + shift : null, sl: t.sl != null ? t.sl + shift : null }
          try { if (tr.tp) tr.tpOid = await trigger(c, !long, tr.sz, tr.tp, 'tp') } catch (e) { log('WARN', `${c}: target not placed (${e.message}); the bot closes it when the strategy does`) }
          try { if (tr.sl) tr.slOid = await trigger(c, !long, tr.sz, tr.sl, 'sl') } catch (e) { log('WARN', `${c}: stop not placed (${e.message})`) }
          ledger.subs = { ...ledger.subs, [c]: { ...after, trade: tr, lastTime: t.time } }
          log('OPEN', `${c} ${t.side} ${tr.sz} @ $${entry}${tr.tp ? ` · target $${tr.tp.toPrecision(5)}` : ''}${tr.sl ? ` · stop $${tr.sl.toPrecision(5)}` : ''}`)
        } catch (e) { log('ERROR', `${c}: entry: ${e.message}`) }
      }
    }
    save(ledger)
  }
  const open = COINS.filter(c => ledger.subs[c]?.trade)
  const eq = equityOf(ledger, px)
  const reason = open.length ? `in ${open.length} trade${open.length === 1 ? '' : 's'}: ${open.map(c => `${c} ${ledger.subs[c].trade.side}`).join(', ')}` : 'waiting for the next entry'
  save(ledger, { equity: eq, reason })
}

async function plan() {
  await loadMeta()
  const px = await prices()
  const h = await held()
  const lb = levBy()
  const saved = readAll()[KEY]
  // The fully invested book (for DCA, where the buys lead): what each holding becomes.
  const rows = COINS.map(c => ({ coin: c, w: W[c], lev: lb[c], maxLev: META[c].maxLev, isolated: ISOLATED || META[c].onlyIsolated, px: px[c] ?? null,
    usd: Math.abs(W[c]) * BUDGET * lb[c] }))
  const missing = rows.filter(r => !r.px).map(r => r.coin)
  // DCA's first buy is the smallest slice there will be: check that, not the whole.
  const slice = STRATEGY === 'dca' ? (PARAMS.dcaUpfront + (1 - PARAMS.dcaUpfront) / Math.max(1, Math.round(PARAMS.dcaBuys))) : 1
  const tooSmall = rows.filter(r => r.usd * slice < HL_MIN_ORDER).map(r => r.coin)
  const resumes = !!(saved && saved.units && Object.keys(saved.units).length && saved.strategy === STRATEGY)   // what a launch WITHOUT --fresh carries on from
  // A trading strategy: where the replay stands on each market right now. A trade it is
  // already in is not joined — the bot waits for the next entry — and the preview says so.
  if (BOT) {
    const now = Date.now()
    for (const r of rows) {
      try {
        const cs = await info.candleSnapshot({ coin: r.coin, interval: TF, startTime: now - (WARMUP + 2) * TF_MS[TF], endTime: now })
        const t = simOpenTrade(closedCandles(cs, TF, now), BOT, SPARAMS, { bal: BUDGET * Math.abs(r.w), side: r.w < 0 ? 'short' : 'long', both: BOTH, lev: r.lev, margin: ISOLATED ? 'isolated' : 'cross', feeBps: FEE * 1e4 })
        r.now = t ? { side: t.side, since: t.time } : null
      } catch { r.now = undefined }
    }
  }
  console.log('__PLAN__' + JSON.stringify({ ok: true, rows, skipped: SKIPPED, tooSmall, missing, margin: BUDGET, free: h.free, resumes, held: resumes ? saved.units : null, strategy: STRATEGY, budget: BUDGET }))
}

async function run() {
  if (PLAN) { try { await plan() } catch (e) { fail(e.message) } process.exit(0) }
  if (BOT) log('START', `Trading strategy ${BOT} on ${TF} candles${BOTH ? ', both directions' : ''}; each holding is its own sub-account. Trades the strategy is already in are not joined: it waits for the next entry.`)
  log('START', `Portfolio "${NAME}" (${ID}) · ${STRATEGY} · budget $${BUDGET} · leverage ${LEV}${LEV === 'max' ? '' : '×'} ${ISOLATED ? 'isolated' : 'cross'}`)
  log('START', `${COINS.length} markets: ${COINS.map(c => `${c} ${(W[c] * 100).toFixed(1)}%`).join(', ')}`)
  if (SKIPPED.length) log('START', `skipped (spot, not tradable by a bot yet): ${SKIPPED.join(', ')}`)
  await loadMeta()
  // --fresh is the person asking to start over, once. Every launch carries a --run id, and a
  // restart or a resume (deploy, reboot) re-sends the same arguments — so a saved ledger from
  // THIS run is always carried on, and --fresh can never buy everything a second time.
  const saved = readAll()[KEY]
  const carry = saved && saved.units && saved.strategy === STRATEGY && (!args.fresh || (RUN && saved.run === RUN)) && (!BOT || saved.subs)
  ledger = carry ? saved : { ...freshLedger(BUDGET, STRATEGY, Date.now()), run: RUN, ...(BOT ? { subs: freshSubs(W, BUDGET) } : {}) }
  // A holding added to the basket since the ledger was saved starts with its share.
  if (BOT) for (const c of COINS) if (!ledger.subs[c]) ledger.subs[c] = { cash: BUDGET * Math.abs(W[c]), trade: null, lastTime: null }
  log('START', ledger === saved ? `carrying on from the saved ledger (${Object.keys(ledger.units).length} positions)` : 'new ledger')
  await setLeverage()
  save(ledger)
  for (;;) {
    if (!isPaused()) { try { await (BOT ? signalTick() : tick()) } catch (e) { log('ERROR', e.message) } }
    await new Promise(r => setTimeout(r, CHECK_MS))
  }
}
onPause(() => log('PAUSE', 'paused: no orders until resumed'))
onResume(() => log('RESUME', 'resumed'))
process.on('SIGTERM', () => { log('STOP', `stopped; positions stay open${BOT ? ', with their stops and targets resting on the exchange,' : ''} and the ledger is kept`); process.exit(0) })
run().catch(e => fail(e.message))
