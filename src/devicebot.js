/**
 * INSOLVENT TERMINAL — Device Bots
 *
 * Run a bot you wrote yourself, on your own machine, in your own browser.
 *
 * WHY A WORKER, AND NOT JUST eval()
 * ---------------------------------
 * The agent private key for every saved wallet lives in this page's localStorage. Any
 * script running in the page can read it. So "paste a bot file and run it" in the main
 * context would mean: paste a file from Discord, and it can take your key and empty the
 * account before you finish reading the code.
 *
 * A Web Worker cannot reach localStorage at all — the API simply does not exist there —
 * and has no DOM, no window, and no access to this module's variables. So the bot runs in
 * a box that never contains the key. It cannot sign anything. It can only ASK, by posting
 * an intent back, and the main thread decides whether to carry it out.
 *
 * WHAT THE BOX DOES NOT STOP
 * --------------------------
 * A Worker can still call fetch(). A hostile file could send whatever it is given to a
 * server of its choosing — that is market data, your position on the one coin it runs on,
 * and your account equity. It cannot send your key, because it never has it. Anyone
 * running a file they did not write should know that much, so the install screen says it
 * rather than burying it.
 *
 * THE LIMITS ARE THE REAL SAFETY
 * ------------------------------
 * Isolation stops key theft. It does not stop a buggy loop from placing four hundred
 * orders. Every intent is checked here, in the main thread, against limits the user set
 * when installing the bot: one coin, a maximum order value, a maximum number of orders per
 * minute, and a cap on resting orders. A bot cannot widen its own limits — they are not in
 * the worker.
 */

// One bot's saved definition. `code` is the file's text, verbatim.
export const DEVBOT_KEY = 'hliq_device_bots'

export function devBotsLoad() {
  try { return JSON.parse(localStorage.getItem(DEVBOT_KEY)) || [] } catch { return [] }
}
export function devBotsSave(list) {
  try { localStorage.setItem(DEVBOT_KEY, JSON.stringify(list)) } catch {}
}

/**
 * The harness that wraps a user's file inside the worker.
 *
 * Their file defines `onTick(ctx)` — as a bare function declaration, or by assigning
 * `self.onTick`. It may return an intent, an array of them, or nothing. Anything it
 * throws is reported as a log line rather than killing the bot, because a bot that dies
 * silently on one bad tick is worse than one that says so and keeps going.
 */
const RUNNER = `
'use strict'
let __onTick = null
let __ticks = 0

function log(...a) {
  self.postMessage({ t: 'log', level: 'info', msg: a.map(String).join(' ') })
}

self.onmessage = (e) => {
  const m = e.data
  if (m.t === 'load') {
    try {
      // The file runs once, here, to define its handler.
      ;(0, eval)(m.code)
      __onTick = (typeof onTick === 'function') ? onTick
               : (typeof self.onTick === 'function') ? self.onTick : null
      if (!__onTick) {
        self.postMessage({ t: 'fatal', msg: 'No onTick(ctx) function found. Define: function onTick(ctx) { ... }' })
        return
      }
      self.postMessage({ t: 'ready' })
    } catch (err) {
      self.postMessage({ t: 'fatal', msg: 'Could not load: ' + (err && err.message ? err.message : String(err)) })
    }
    return
  }
  if (m.t === 'tick') {
    if (!__onTick) return
    __ticks++
    let out
    try {
      out = __onTick(m.ctx)
    } catch (err) {
      // A throw is a bug in one tick, not a reason to stop the bot.
      self.postMessage({ t: 'log', level: 'error', msg: 'tick ' + __ticks + ' threw: ' + (err && err.message ? err.message : String(err)) })
      return
    }
    const intents = out == null ? [] : (Array.isArray(out) ? out : [out])
    self.postMessage({ t: 'intents', intents, tick: __ticks })
  }
}
`

// A starting point that does nothing dangerous and shows the shape of the thing.
export const DEVBOT_TEMPLATE = `// Runs on YOUR device, in a sandbox with no access to your keys.
// Called once per tick with the current state of the one market you chose.
//
// ctx = {
//   coin, mark, tick,          // market you selected + its mark price
//   position: { szi, entryPx, unrealizedPnl } | null,
//   openOrders: [ { oid, isBuy, sz, limitPx } ],
//   equity,                    // account value in USDC
//   candles: [ { t, o, h, l, c, v } ]   // recent 1h candles, oldest first
// }
//
// Return an intent, an array of them, or nothing:
//   { type: 'market', isBuy: true,  usd: 25 }
//   { type: 'limit',  isBuy: false, usd: 25, px: 70000 }
//   { type: 'cancel', oid: 12345 }
//   { type: 'close' }
//
// log(...) writes to this bot's log panel.

function onTick(ctx) {
  if (!ctx.candles || ctx.candles.length < 20) return

  const closes = ctx.candles.map(k => Number(k.c))
  const sma20  = closes.slice(-20).reduce((a, b) => a + b, 0) / 20

  // Example only: hold a small long while price is above its 20-candle average.
  const long = ctx.position && Number(ctx.position.szi) > 0

  if (ctx.mark > sma20 && !long) {
    log('mark', ctx.mark.toFixed(2), '> sma20', sma20.toFixed(2), '— opening')
    return { type: 'market', isBuy: true, usd: 20 }
  }
  if (ctx.mark < sma20 && long) {
    log('mark below sma20 — closing')
    return { type: 'close' }
  }
}
`

/**
 * A running bot: its worker, its limits, its log, and the rate state the limits need.
 *
 * `deps` is how the main thread keeps control of everything that touches money:
 *   deps.snapshot()        → the ctx handed to the bot each tick
 *   deps.market(intent)    → place a market order
 *   deps.limit(intent)     → place a limit order
 *   deps.cancel(oid)       → cancel one order
 *   deps.close()           → close the position
 *   deps.onChange()        → tell the UI something happened
 * None of those are reachable from inside the worker.
 */
export class DeviceBot {
  constructor(def, deps) {
    this.def = def
    this.deps = deps
    this.worker = null
    this.timer = null
    this.log = []
    this.ready = false
    this.stopped = false
    this.sentAt = []          // timestamps of orders actually sent, for the per-minute cap
    this.blocked = 0
  }

  say(level, msg) {
    this.log.unshift({ ts: Date.now(), level, msg: String(msg).slice(0, 400) })
    if (this.log.length > 200) this.log.length = 200
    this.deps.onChange?.()
  }

  start() {
    if (this.worker) return
    this.stopped = false
    let url
    try {
      const blob = new Blob([RUNNER], { type: 'text/javascript' })
      url = URL.createObjectURL(blob)
      this.worker = new Worker(url)
    } catch (e) {
      this.say('error', 'Could not start a sandbox: ' + e.message)
      return
    }
    // The blob URL is only needed until the worker has loaded from it.
    setTimeout(() => { try { URL.revokeObjectURL(url) } catch {} }, 5000)

    this.worker.onmessage = (e) => this._onMessage(e.data)
    this.worker.onerror = (e) => {
      this.say('error', 'Sandbox error: ' + (e.message || 'unknown'))
      e.preventDefault?.()
    }
    this.worker.postMessage({ t: 'load', code: this.def.code })
    this.say('info', 'Loading ' + this.def.name)
  }

  stop() {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.worker) { try { this.worker.terminate() } catch {} this.worker = null }
    this.ready = false
    this.say('info', 'Stopped')
  }

  _onMessage(m) {
    if (!m || this.stopped) return
    if (m.t === 'fatal') { this.say('error', m.msg); this.stop(); return }
    if (m.t === 'log')   { this.say(m.level === 'error' ? 'error' : 'info', m.msg); return }
    if (m.t === 'ready') {
      this.ready = true
      this.say('info', 'Running · ' + this.def.coin + ' · max $' + this.def.maxUsd + '/order · ' + this.def.maxPerMin + ' orders/min')
      const period = Math.max(5, Number(this.def.everySec) || 15) * 1000
      this.timer = setInterval(() => this._tick(), period)
      this._tick()
      return
    }
    if (m.t === 'intents') this._execute(m.intents ?? [])
  }

  _tick() {
    if (!this.worker || !this.ready) return
    let ctx
    try { ctx = this.deps.snapshot(this.def) } catch (e) { this.say('error', 'No market data: ' + e.message); return }
    if (!ctx) return
    this.worker.postMessage({ t: 'tick', ctx })
  }

  // How many orders were sent in the last 60s.
  _recentSends() {
    const cut = Date.now() - 60_000
    this.sentAt = this.sentAt.filter(t => t >= cut)
    return this.sentAt.length
  }

  /**
   * Every limit is enforced HERE, where the bot cannot reach them.
   *
   * A refusal is logged and the intent dropped — never queued. A bot that meant to send
   * one order and sent sixty should be stopped by the cap, not have the sixty arrive a
   * minute later.
   */
  _check(it, ctx) {
    if (!it || typeof it !== 'object') return 'not an intent'
    const type = String(it.type ?? '')
    if (!['market', 'limit', 'cancel', 'close'].includes(type)) return `unknown intent "${type}"`

    if (type === 'cancel' || type === 'close') return null   // reducing risk is never capped

    const usd = Number(it.usd)
    if (!Number.isFinite(usd) || usd <= 0) return 'order needs a positive usd amount'
    if (usd > this.def.maxUsd) return `order $${usd.toFixed(2)} over the $${this.def.maxUsd} per-order limit you set`

    if (this._recentSends() >= this.def.maxPerMin) return `rate limit: ${this.def.maxPerMin} orders/min reached`

    const resting = (ctx?.openOrders?.length ?? 0)
    if (type === 'limit' && resting >= (this.def.maxOpen ?? 20)) return `already ${resting} resting orders, limit ${this.def.maxOpen ?? 20}`

    if (type === 'limit') {
      const px = Number(it.px)
      if (!Number.isFinite(px) || px <= 0) return 'limit order needs a positive px'
    }
    return null
  }

  async _execute(intents) {
    if (this.stopped || !intents.length) return
    let ctx = null
    try { ctx = this.deps.snapshot(this.def) } catch {}
    for (const it of intents.slice(0, 10)) {          // one tick cannot fire more than 10
      const why = this._check(it, ctx)
      if (why) { this.blocked++; this.say('warn', 'Blocked — ' + why); continue }
      try {
        const r = await this.deps.execute(this.def, it)
        if (r?.ok === false) { this.say('error', 'Rejected: ' + (r.error ?? 'unknown')); continue }
        if (it.type === 'market' || it.type === 'limit') this.sentAt.push(Date.now())
        this.say('info', 'Sent ' + it.type + (it.isBuy != null ? (it.isBuy ? ' buy' : ' sell') : '') +
          (it.usd ? ' $' + Number(it.usd).toFixed(2) : '') + (it.px ? ' @ ' + it.px : ''))
      } catch (e) {
        this.say('error', 'Failed: ' + (e?.message ?? String(e)))
      }
    }
    this.deps.onChange?.()
  }
}
