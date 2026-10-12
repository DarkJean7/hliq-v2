/**
 * Bots on a paper account — Copy Trade, Grid, DCA, Trend, … — run by the server.
 *
 * A paper account has no wallet and no agent key, and needs neither: the server starts the SAME
 * bot that trades live with --paper <account> (strategies/_paperpreload.js), and the bot trades
 * the paper account through src/paperexchange.js. It keeps running with the app closed.
 * Authorised by the paper owner's secret (src/papersync.js), at /api/paper/*; the bot's address is
 * 0x + the first 40 hex of sha256(secret), as the server makes it.
 *
 * While a server bot runs on an account, the server is that account's only writer. A person's own
 * orders there still happen at once in the app — the same paper.js — and are sent, in order, to be
 * applied on the server (/paper/op); until they are, the app neither sends nor replaces that
 * account's copy (pendingKeys), so the screen does not jump back.
 */
import { slotOfKey } from './paperkeys.js'

const storeKey = (slot) => (slot === 'main' ? 'hliq_paper_v2' : slot === 'challenge' ? 'hliq_paper_chal_v2' : 'hliq_paper_s_' + slot)

/** 0x + the first 40 hex of sha256(secret): the paper owner's bot address. */
export async function paperOwnerAddr(secret) {
  if (!/^[0-9a-f]{64}$/.test(secret ?? '')) return null
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return '0x' + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}

/** The paper account each running bot trades, from its arguments (--paper <slot>). */
export function paperSlotOfArgs(args) {
  const a = args ?? [], i = a.indexOf('--paper')
  return i >= 0 && a[i + 1] ? String(a[i + 1]) : null
}

/**
 *   secret(): the paper owner's secret; slot(): the paper account on screen
 *   onOpsDone(slot): the server has applied every queued action for that account (sync now)
 */
export function createPaperBots({ secret, slot, onOpsDone = () => {}, onOpFailed = () => {}, fetchImpl = (...a) => fetch(...a), retryMs = [1000, 3000, 8000] }) {
  const call = async (act, body) => {
    const r = await fetchImpl('/api/paper/' + act, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: secret(), ...body }) })
    const j = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : { ok: false, error: (await r.text()).slice(0, 200) || 'the bot server did not answer' }
    return { status: r.status, ...j }
  }
  // Actions on server-run accounts, one queue per account so they land in the order made.
  const queues = new Map(), pending = new Set()
  // One action to the server, retried while the SERVER is the problem (unreachable, or 5xx —
  // Hyperliquid refusing its price fetch). A refusal from paper itself (not an action, a bad
  // account) is final. Treating every answer as success is what put closed positions back on
  // screen: the server had refused the close, the app synced, and its copy won.
  async function deliver(sl, fn, args) {
    let error = 'the paper server did not answer'
    for (let i = 0; ; i++) {
      try {
        const r = await fetchImpl('/paper/op', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: secret(), slot: sl, fn, args }) })
        const j = await r.json().catch(() => null)
        if (r.ok && j?.ok === true) return true
        error = j?.error || 'HTTP ' + r.status
        if (r.status < 500 && j) break
      } catch (e) { error = e?.message || error }
      if (i >= retryMs.length) break
      await new Promise(res => setTimeout(res, retryMs[i]))
    }
    try { onOpFailed(sl, fn, error) } catch {}
    return false
  }
  function send(sl) {
    return ({ fn, args }) => {
      const key = storeKey(sl)
      pending.add(key)
      const prev = queues.get(sl) ?? Promise.resolve()
      const next = prev.then(() => deliver(sl, fn, args))
      queues.set(sl, next)
      next.then(() => {
        if (queues.get(sl) !== next) return            // more were queued behind it
        queues.delete(sl); pending.delete(key)
        try { onOpsDone(sl) } catch {}
      })
    }
  }
  return {
    start: (type, args, instance) => call('start', { type, slot: slot(), args, instance }),
    stop: (type, instance) => call('stop', { type, instance }),
    pause: (type, instance) => call('pause', { type, instance }),
    resume: (type, instance) => call('resume', { type, instance }),
    send,
    pendingKeys: () => pending,
    /**
     * → { status: the paper account's bots in the shape checkServer gives the app (serverStatus),
     *     slots: every paper account with a server bot on it }, or null when the server did not say.
     */
    async status() {
      const addr = await paperOwnerAddr(secret())
      if (!addr) return { status: { ok: true, _configs: {}, _instances: {}, _paused: {} }, slots: new Set() }
      let s
      try { s = await (await fetchImpl('/api/status?address=' + addr)).json() } catch { return null }
      const cur = slot(), out = { ok: true, _configs: {}, _instances: {}, _paused: {}, _portfolios: s._portfolios ?? {} }
      const slots = new Set()
      for (const [k, c] of Object.entries(s._configs ?? {})) {
        const sl = paperSlotOfArgs(c.args)
        if (!sl) continue
        slots.add(sl)
        if (sl !== cur) continue
        out[c.type] = true; out._configs[k] = c; out._instances[k] = true
        if (s._paused?.[k]) out._paused[k] = true
      }
      return { status: out, slots }
    },
    storeKeyOf: storeKey,
    slotOfKey,
  }
}
