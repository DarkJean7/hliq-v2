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
 * What still holds, on purpose:
 *
 *   REMOVAL WINS.      An account that removed itself stays off. Its owner holds its agent key
 *                      in this app, so auto-joining "every wallet with a key" without this
 *                      rule would put it straight back on the next reload — "Remove me" could
 *                      never work for the very people it exists for. ➕ Add me clears it.
 *   OPT-OUT WINS.      hliq_lb_optout on this device suppresses every automatic post.
 *
 * Pure apart from the `storage` and `fetch` it is handed, so the suite can drive it.
 */

export const LB_MIN_EQUITY = 10
// v2: v1 recorded failures as done. A new key means every device asks again, once.
export const JOINED_KEY    = 'hliq_lb_autojoined_v2'
export const COOLDOWN_KEY  = 'hliq_lb_join_cooldown'
// An address the server turned down for being unfunded is asked again later, not on every
// load: each ask spends one of the IP's 30 hourly joins.
export const UNFUNDED_RETRY_MS = 6 * 60 * 60 * 1000
export const THROTTLED_RETRY_MS = 10 * 60 * 1000

const ADDR = /^0x[0-9a-fA-F]{40}$/
export const isRealAddr = (a) => ADDR.test(String(a ?? ''))

/**
 * Has the server decided? Only then is the address remembered.
 *   added / already  — it is on the board
 *   blocked          — it removed itself; asking again changes nothing
 *   invalid address  — it never will be
 * Everything else (429, 5xx, a network error, "needs $10") is a "not now".
 */
export function isSettled(status, body) {
  if (status === 200 && body && (body.added || body.already || body.blocked)) return true
  if (status === 400 && /invalid address/i.test(String(body?.error ?? ''))) return true
  return false
}

/**
 * The wallets that are this user's in this app: any address with an agent key saved here,
 * and any wallet connected right now. Lowercased, de-duplicated.
 *
 * Agent keys live under `hliq_agent_key_<address>`. The bare legacy `hliq_agent_key` names
 * no address and is ignored, as is `hliq_agent_key___all_accounts__`, a junk key an old
 * build wrote.
 */
export function ownedAddresses(storage, connected = []) {
  const out = new Set()
  const n = Number(storage?.length) || 0
  for (let i = 0; i < n; i++) {
    const k = storage.key(i)
    const m = /^hliq_agent_key_(0x[0-9a-fA-F]{40})$/.exec(k ?? '')
    if (m && storage.getItem(k)) out.add(m[1].toLowerCase())
  }
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
   * Ask the server to list `addr`. Resolves to `{ status, error? }`, status being:
   *   'added' | 'already' | 'blocked' — settled, never asked again from this device
   *   'retry'   — not now; asked again later (error says why)
   *   'skip' | 'optout' | 'dust' | 'known' | 'cooling' — nothing was sent
   *
   * `equity` is the account's TOTAL value when the caller has it (perp + spot), or null.
   * Unknown is not small: null is still asked.
   */
  async function join(addr, equity = null, { force = false } = {}) {
    const done = (status, error) => (error ? { status, error } : { status })
    if (!isRealAddr(addr)) return done('skip')
    if (!force && storage.getItem('hliq_lb_optout') === '1') return done('optout')
    if (equity != null && !(equity >= LB_MIN_EQUITY)) return done('dust')
    const key = String(addr).toLowerCase()
    if (!force && joined().has(key)) return done('known')
    if (!force && (cooldown()[key] ?? 0) > now()) return done('cooling')
    if (inflight.has(key)) return done('known')
    inflight.add(key)
    try {
      const r = await fetch('/api/leaderboard/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(force ? { addr, force: true } : { addr }),
      })
      const body = await r.json().catch(() => null)
      if (isSettled(r.status, body)) {
        remember(key)
        return done(body.added ? 'added' : body.blocked ? 'blocked' : 'already')
      }
      // A forced add is the user asking in person: tell them, but do not lock them out of
      // pressing it again.
      if (!force) {
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
      const sent = ['added', 'already', 'blocked', 'retry'].includes(res.status)
      if (sent && gapMs) await sleep(gapMs)
    }
    return out
  }

  return { join, joinAll }
}
