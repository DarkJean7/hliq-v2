/**
 * INSOLVENT TERMINAL — putting wallets on the public leaderboard, automatically.
 *
 * Asked for: "all wallets addresses that are in my app connected or/and have agent keys …
 * automatically add to the leaderboard", after trying it as an ordinary user and failing —
 * "i connected the wallet, reloaded, etc."
 *
 * Why that failed, in the order it was found:
 *
 *   PERP-ONLY EQUITY.  Both the client pre-check and the server's $10 floor read the PERP
 *                      account value. A unified account keeps its USDC in spot: one of the
 *                      owner's wallets holds $494.69, all of it spot, and reads $0.00 in perps.
 *                      The client never asked; the server would have refused.
 *   MARKED BEFORE ASKED. An address was written to the "tried" set before the request went
 *                      out. Any failure — a 429, the floor, a restart — was never retried on
 *                      that device, however many times it reloaded.
 *   ONE WALLET.        Only the account being viewed was ever posted. Wallets that run bots
 *                      from this app, but are not the one on screen, were never asked about.
 *
 * And one more, found when a bot wallet of the owner's still would not join:

 *   THE REMOVED LIST.  The server refused automatic joins for any address ever taken off the
 *                      board, and this module then remembered that refusal as final. The list
 *                      is gone — hiding replaced it (server.js): an owner who leaves is HIDDEN,
 *                      which a rejoin cannot undo, and a dev removal just deletes the row.
 *
 * What still holds: hliq_lb_optout on this device suppresses every automatic post.
 *
 * Pure apart from the `storage` and `fetch` it is handed, so the suite can drive it.
 */

export const LB_MIN_EQUITY = 10
// v3: v1 recorded failures as done; v2 recorded "blocked" (the removed list) as done. A new
// key means every device asks again, once — which is what brings those wallets back.
export const JOINED_KEY    = 'hliq_lb_autojoined_v3'
export const COOLDOWN_KEY  = 'hliq_lb_join_cooldown'
// An address the server turned down (never traded, under $10) is asked again later, not on
// every load: each ask spends one of the IP's 30 hourly joins.
export const UNFUNDED_RETRY_MS = 6 * 60 * 60 * 1000
export const THROTTLED_RETRY_MS = 10 * 60 * 1000

import { keyedAddresses, isRealAddr } from './agentkeys.js'
export { isRealAddr }

/**
 * Has the server decided? Only then is the address remembered.
 *   added / already  — it is on the board (possibly hidden, which is its owner's choice)
 *   invalid address  — it never will be
 * "blocked" is not an answer any more; an old server that still sends it is asked again.
 * Everything else (429, 5xx, a network error, "needs $10") is a "not now".
 */
export function isSettled(status, body) {
  if (status === 200 && body && (body.added || body.already)) return true
  if (status === 400 && /invalid address/i.test(String(body?.error ?? ''))) return true
  return false
}

/**
 * The wallets that are this user's in this app: any address with an agent key saved here,
 * and any wallet connected right now. Lowercased, de-duplicated.
 *
 * Which addresses have a key is agentkeys.js's question, not this file's — it used to be
 * answered here with a second copy of the storage layout, which is one more place to get it
 * wrong. The bare legacy key names no address and is skipped there, as is anything stored
 * against a non-account.
 */
export function ownedAddresses(storage, connected = []) {
  const out = new Set(keyedAddresses(storage))
  for (const a of connected ?? []) if (isRealAddr(a)) out.add(String(a).toLowerCase())
  return [...out]
}

export function createJoiner({ storage, fetch, now = () => Date.now() }) {
  const inflight = new Set()
  const readJSON = (k, d) => { try { return JSON.parse(storage.getItem(k)) ?? d } catch { return d } }
  const writeJSON = (k, v) => { try { storage.setItem(k, JSON.stringify(v)) } catch {} }

  const joined   = () => new Set(readJSON(JOINED_KEY, []))
  const cooldown = () => readJSON(COOLDOWN_KEY, {})

  function remember(key) {
    const s = joined(); s.add(key)
    writeJSON(JOINED_KEY, [...s].slice(-400))
    const c = cooldown(); delete c[key]; writeJSON(COOLDOWN_KEY, c)
  }
  function coolFor(key, ms) {
    const c = cooldown(); c[key] = now() + ms
    // Keep the map from growing without bound on a device that looks up many wallets.
    for (const [k, until] of Object.entries(c)) if (until < now()) delete c[k]
    writeJSON(COOLDOWN_KEY, c)
  }

  /**
   * Ask the server to list `addr`. Resolves to `{ status, hidden?, error? }`, status being:
   *   'added' | 'already' — settled, never asked again from this device
   *   'retry'   — not now; asked again later (error says why)
   *   'skip' | 'optout' | 'known' | 'cooling' — nothing was sent
   *
   * `equity` is accepted for older callers and ignored: the server decides eligibility, and a
   * $0 wallet with a trading history is eligible now, so no balance is too small to ask about.
   *
   * `fresh` is a person pressing "Add me": ask even if this device already knows the answer
   * (they want to hear whether the row is hidden), and ignore the opt-out and cooldowns.
   */
  async function join(addr, equity = null, { fresh = false } = {}) {
    const done = (status, error, extra) => ({ status, ...(error ? { error } : {}), ...(extra ?? {}) })
    if (!isRealAddr(addr)) return done('skip')
    if (!fresh && storage.getItem('hliq_lb_optout') === '1') return done('optout')
    const key = String(addr).toLowerCase()
    if (!fresh && joined().has(key)) return done('known')
    if (!fresh && (cooldown()[key] ?? 0) > now()) return done('cooling')
    if (inflight.has(key)) return done('known')
    inflight.add(key)
    try {
      const r = await fetch('/api/leaderboard/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addr }),
      })
      const body = await r.json().catch(() => null)
      if (isSettled(r.status, body)) {
        remember(key)
        return done(body.added ? 'added' : 'already', null, { hidden: !!body.hidden })
      }
      // A person asking in person is told, but not locked out of pressing it again.
      if (!fresh) {
        if (r.status === 429) coolFor(key, THROTTLED_RETRY_MS)
        else if (r.status === 400) coolFor(key, UNFUNDED_RETRY_MS)
      }
      return done('retry', body?.error ?? `HTTP ${r.status}`)
    } catch {
      return done('retry', 'network')
    } finally {
      inflight.delete(key)
    }
  }

  /** Join every owned wallet, one after another. Settled ones cost nothing. */
  async function joinAll(addrs, { gapMs = 1500, sleep = (ms) => new Promise(r => setTimeout(r, ms)) } = {}) {
    const out = {}
    for (const a of addrs ?? []) {
      const res = await join(a)
      out[String(a).toLowerCase()] = res
      // Only pause after a real request; skipped addresses cost nothing to walk past.
      const sent = ['added', 'already', 'retry'].includes(res.status)
      if (sent && gapMs) await sleep(gapMs)
    }
    return out
  }

  return { join, joinAll }
}
