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
 * FULL CAPABILITY WITHOUT THE KEY
 * -------------------------------
 * A bot can do everything a built-in one can. It reads any public Hyperliquid /info
 * endpoint through api.info(), and it places any trading action through api.exchange() —
 * order, cancel, modify, updateLeverage, twapOrder. Those are SIGNED BY THE MAIN THREAD:
 * the bot writes the action, the app holds the key.
 *
 * That is deliberately better than handing the key over, not a lesser version of it. An
 * agent key can trade but cannot withdraw or transfer, so signing-on-request gives up
 * nothing a bot could otherwise do — and it leaves nothing in the sandbox worth stealing.
 * The one thing it blocks that a raw key would allow is approving ANOTHER agent for the
 * account, which is an escalation no bot has a reason to want.
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

/**
 * The bot's own settings, written in the app rather than edited into the file.
 *
 * A file full of `const RIESGO = 0.03` at the top means changing the risk is a code edit,
 * and a code edit on a running bot is a re-install. So a bot declares its knobs, the user
 * fills them in on the card, and they arrive as ctx.config.params.
 *
 * The format is one `key = value` per line, because that is what people type without being
 * taught a format. JSON was the obvious alternative and was rejected: a missing brace turns
 * the whole settings block into nothing, silently, and the bot falls back to its defaults
 * without saying why.
 *
 *   riesgo = 0.03            → 0.03      (number)
 *   usarPesos = false        → false     (boolean)
 *   entrada = 07:00          → '07:00'   (string — only a finite number becomes a number)
 *   # a comment, ignored
 *
 * Nothing here can widen a limit. The caps live in the main thread and are checked after
 * the bot has spoken; params are the bot's own settings, not the app's.
 */
export function parseBotParams(text) {
  const out = {}
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('//')) continue
    // Split on the FIRST separator only, or `entrada = 07:00` would lose its minutes.
    let i = line.indexOf('=')
    if (i < 0) i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    let val = line.slice(i + 1).trim()
    if (!key) continue
    // A trailing comment is what someone writes when they are explaining a number to
    // themselves; it should not end up as part of the value.
    const c = val.search(/\s+(?:#|\/\/)/)
    if (c >= 0) val = val.slice(0, c).trim()
    if (/^".*"$/.test(val) || /^'.*'$/.test(val)) { out[key] = val.slice(1, -1); continue }
    if (val === 'true' || val === 'false') { out[key] = val === 'true'; continue }
    if (val === '') { out[key] = ''; continue }
    const n = Number(val)
    out[key] = Number.isFinite(n) ? n : val
  }
  return out
}

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
let __seq = 0
const __waiting = new Map()

function log(...a) {
  self.postMessage({ t: 'log', level: 'info', msg: a.map(String).join(' ') })
}

// Ask the main thread for something and wait for the answer. This is the whole reason a
// bot can be as capable as a built-in one without ever holding a key: it does not sign,
// it asks, and the side that holds the key decides.
function __req(kind, payload) {
  const id = ++__seq
  return new Promise((resolve, reject) => {
    __waiting.set(id, { resolve, reject })
    self.postMessage({ t: 'req', id, kind, payload })
  })
}

const api = {
  // Any read-only Hyperliquid /info request. Public data; no key involved.
  info: (payload) => __req('info', payload),
  candles: (coin, interval, startTime, endTime) => __req('info', {
    type: 'candleSnapshot',
    req: { coin, interval, startTime, endTime: endTime ?? Date.now() },
  }),
  // Any trading action the exchange client supports — order, cancel, modify,
  // updateLeverage, twapOrder and so on. Signed by the app, not here.
  exchange: (method, args) => __req('exchange', { method, args }),
  order:    (args) => __req('exchange', { method: 'order', args }),
  cancel:   (args) => __req('exchange', { method: 'cancel', args }),
  modify:   (args) => __req('exchange', { method: 'modify', args }),
}
self.api = api

self.onmessage = (e) => {
  const m = e.data
  if (m.t === 'res') {
    const w = __waiting.get(m.id)
    if (!w) return
    __waiting.delete(m.id)
    if (m.error) w.reject(new Error(m.error)); else w.resolve(m.value)
    return
  }
  if (m.t === 'load') {
    try {
      // The file is run inside a FUNCTION scope, not the worker's global one, and \`api\`
      // and \`log\` are passed in as arguments rather than left lying around as globals.
      //
      // That is what makes the format collision-proof. Evaluated globally, a file that
      // declared its own \`log\` would silently replace ours, and one that declared
      // \`const api\` would die on "Identifier 'api' has already been declared" — an error
      // pointing at our harness for something the author did nothing wrong to cause. Here
      // a bot may declare any name it likes; the worst it can do is shadow a helper it
      // then chose not to use.
      //
      // The trailing return is separated by a real newline, not a semicolon: a file whose
      // last line is a // comment would otherwise swallow it.
      const factory = new Function('api', 'log',
        m.code + String.fromCharCode(10) +
        ';return typeof onTick === "function" ? onTick : (typeof self.onTick === "function" ? self.onTick : null)')
      __onTick = factory(api, log)
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
    const n = __ticks
    // onTick may be async — a bot that awaits api.info() or api.order() is the normal
    // case now, not an exotic one. A rejected promise is reported like a throw.
    Promise.resolve()
      .then(() => __onTick(m.ctx))
      .then((out) => {
        const intents = out == null ? [] : (Array.isArray(out) ? out : [out])
        self.postMessage({ t: 'intents', intents, tick: n })
      })
      .catch((err) => {
        // A throw is a bug in one tick, not a reason to stop the bot.
        self.postMessage({ t: 'log', level: 'error', msg: 'tick ' + n + ' threw: ' + (err && err.message ? err.message : String(err)) })
      })
  }
}
`

// A starting point that does nothing dangerous and shows the shape of the thing.
export const DEVBOT_TEMPLATE = `// Runs on YOUR device, in a sandbox with no access to your keys.
// Called once per tick with the current state of the one market you chose.
//
// ctx = {
//   coin, mark, tick,          // your home market + its mark price
//   position: { szi, entryPx, unrealizedPnl } | null,   // in the home market
//   openOrders: [ { oid, isBuy, sz, limitPx } ],        // in the home market
//   equity, paper,
//   candles: [ { t, o, h, l, c, v } ],  // recent 1h candles, oldest first.
//                                       // OFTEN EMPTY on the first few ticks while
//                                       // history loads — check .length, or use
//                                       // api.candles() below, which always fetches.
//
//   // the whole account, if you want more than one market:
//   mids:      { BTC: '78000', ... },
//   positions: [ { coin, szi, entryPx, unrealizedPnl, leverage, liquidationPx, marginUsed } ],
//   orders:    [ { oid, coin, isBuy, sz, limitPx } ],
//   margin:    { accountValue, totalMarginUsed, withdrawable },
//
//   // your settings from the bot's card, so a knob is a form field, not a code edit:
//   config: { coin, maxUsd, maxPerMin, maxOpen, everySec, leverage, dry,
//             params: { ... }   // whatever you typed in Settings, as key = value lines
//           }
// }
//
// THE EASY WAY — return an intent, an array of them, or nothing:
//   { type: 'market', isBuy: true,  usd: 25 }
//   { type: 'limit',  isBuy: false, usd: 25, px: 70000 }
//   { type: 'cancel', oid: 12345 }
//   { type: 'close' }
//
// THE FULL WAY — onTick can be async, and api.* gives you the whole exchange:
//   await api.info({ type: 'l2Book', coin: 'BTC' })     any public /info request
//   await api.candles('ETH', '15m', Date.now() - 864e5)
//   await api.order({ orders: [...], grouping: 'na' })  any order the SDK accepts
//   await api.cancel({ cancels: [{ a: 0, o: 123 }] })
//   await api.exchange('updateLeverage', { asset: 0, isCross: true, leverage: 5 })
//
// api.* is signed by the app, not by this file — your key is never in here. Actions that
// move funds, and approving another agent, are refused; an agent key cannot do them anyway.
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
 *   deps.snapshot(def, bot) → the ctx handed to the bot each tick. The instance is passed
 *                            because a preview runs on a THROWAWAY bot that is not in the
 *                            app's registry, so looking one up by id there would report a
 *                            preview as a live run.
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

  /**
   * `dry` runs the bot for real against live data, with every route to the exchange
   * disabled: intents are logged as "would send" instead of executed, and api.exchange()
   * answers with a fake acknowledgement instead of signing. Reads stay real, because a
   * preview fed fake market data would be previewing a different bot.
   *
   * This is a truer dry run than the built-in bots get. Theirs re-runs the strategy on the
   * server with --plan and reports the orders it would open with; this runs the actual
   * file, on the actual account state, and shows what it actually decides — the only thing
   * that differs is that nothing leaves the machine.
   */
  start(dry = false) {
    if (this.worker) return
    this.dry = !!dry
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

  /**
   * Run exactly one tick, collect what the bot decided, and stop.
   *
   * The built-in bots answer "what would you do?" with a sheet you read and dismiss. A dry
   * run left going in the background answers the same question but hides the answer in a
   * log, which is not the same thing at all. This gives the question a return value.
   *
   * Resolves once the worker reports the tick's intents — including an empty list, which
   * is a real answer ("nothing right now") and must not look like a hang.
   */
  previewOnce(ms = 15000) {
    return new Promise((resolve) => {
      this._previewIntents = []
      this._previewDone = false
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearInterval(poll)
        const out = { intents: this._previewIntents, log: this.log.slice(), timedOut: !this._previewDone }
        this.stop()
        resolve(out)
      }
      const started = Date.now()
      const poll = setInterval(() => {
        if (this._previewDone || this.stopped || Date.now() - started > ms) finish()
      }, 150)
      this.start(true)
    })
  }

  stop() {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    if (this.worker) { try { this.worker.terminate() } catch {} this.worker = null }
    this.ready = false
    this.say('info', 'Stopped')
  }

  async _onMessage(m) {
    if (!m || this.stopped) return
    if (m.t === 'req') {
      // The bot asked for something. The answer comes from the main thread, which is the
      // only side that can read a key or reach the exchange.
      let value = null, error = null
      try { value = await this.deps.request(this.def, m.kind, m.payload, this) }
      catch (e) { error = e?.message ?? String(e) }
      if (!this.stopped && this.worker) this.worker.postMessage({ t: 'res', id: m.id, value, error })
      return
    }
    if (m.t === 'fatal') { this.say('error', m.msg); this.stop(); return }
    if (m.t === 'log')   { this.say(m.level === 'error' ? 'error' : 'info', m.msg); return }
    if (m.t === 'ready') {
      this.ready = true
      this.say('info', (this.dry ? 'DRY RUN — nothing will be sent · ' : 'Running · ')
        + this.def.coin + ' · max $' + this.def.maxUsd + '/order · ' + this.def.maxPerMin + ' orders/min')
      const period = Math.max(5, Number(this.def.everySec) || 15) * 1000
      this.timer = setInterval(() => this._tick(), period)
      this._tick()
      return
    }
    if (m.t === 'intents') {
      // An empty list is a real answer — "nothing this tick" — so a preview must settle on
      // it rather than sit there looking like it hung.
      if (this._previewIntents) { this._previewIntents.push(...(m.intents ?? [])); this._previewDone = true }
      this._execute(m.intents ?? [])
    }
  }

  _tick() {
    if (!this.worker || !this.ready) return
    let ctx
    try { ctx = this.deps.snapshot(this.def, this) } catch (e) { this.say('error', 'No market data: ' + e.message); return }
    if (!ctx) return
    this.worker.postMessage({ t: 'tick', ctx })
  }

  // Called by the bridge when a raw api.exchange() call places orders, so the rate cap
  // governs BOTH routes. Without this a bot could sidestep it entirely by using
  // api.order() instead of returning an intent — which would make the cap decorative.
  noteSend() { this.sentAt.push(Date.now()) }
  rateBlocked() { return this.def.maxPerMin > 0 && this._recentSends() >= this.def.maxPerMin }

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
    // 0 means the user deliberately switched a limit off, which is different from a
    // missing value meaning "use the default".
    if (this.def.maxUsd > 0 && usd > this.def.maxUsd) return `order $${usd.toFixed(2)} over the $${this.def.maxUsd} per-order limit you set`

    if (this.rateBlocked()) return `rate limit: ${this.def.maxPerMin} orders/min reached`

    const resting = (ctx?.openOrders?.length ?? 0)
    const cap = this.def.maxOpen ?? 20
    if (type === 'limit' && cap > 0 && resting >= cap) return `already ${resting} resting orders, limit ${cap}`

    if (type === 'limit') {
      const px = Number(it.px)
      if (!Number.isFinite(px) || px <= 0) return 'limit order needs a positive px'
    }
    return null
  }

  async _execute(intents) {
    if (this.stopped || !intents.length) return
    let ctx = null
    try { ctx = this.deps.snapshot(this.def, this) } catch {}
    for (const it of intents.slice(0, 10)) {          // one tick cannot fire more than 10
      const why = this._check(it, ctx)
      if (why) { this.blocked++; this.say('warn', 'Blocked — ' + why); continue }
      if (this.dry) {
        // Checked first, THEN reported — so a preview also shows you which intents your
        // limits would have refused, not just the ones that would have gone through.
        this.say('info', 'Would send ' + it.type + (it.isBuy != null ? (it.isBuy ? ' buy' : ' sell') : '') +
          (it.usd ? ' $' + Number(it.usd).toFixed(2) : '') + (it.px ? ' @ ' + it.px : ''))
        continue
      }
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
