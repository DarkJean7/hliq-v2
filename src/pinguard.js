/**
 * INSOLVENT TERMINAL — a dev PIN the server no longer accepts must not break the app.
 *
 * The operator PIN was replaced (2026-11-26) and the server started counting wrong PINs, five
 * per IP per hour, then refusing every request that carries one (server.js pinLocked). A device
 * still holding the old PIN sends it with every leaderboard refresh. Five refreshes locked the
 * owner's own IP, and the board — which answers anyone, PIN or not — came back empty: "why
 * leaderboard just showing 5 addresses", then "now real is showing 0".
 *
 * Two parts, both on this side, so they need no server change:
 *   1. A request refused as a PIN lockout (429) is sent again WITHOUT the PIN, and the stored
 *      PIN is forgotten: a public page must still load for someone whose PIN is wrong.
 *   2. With dev mode on, the stored PIN is checked once at start. One the server rejects is
 *      forgotten at once — one wrong guess instead of one per refresh — and the person is asked
 *      for the new one.
 *
 * Pure apart from what it is handed, so the suite can drive it.
 */

const HDR = 'x-lb-pin'

const sentPin = (init) => {
  const h = init?.headers
  if (!h) return false
  if (typeof h.get === 'function') return !!h.get(HDR)
  return Object.keys(h).some(k => k.toLowerCase() === HDR && h[k])
}
const withoutPin = (init) => {
  const h = init.headers
  if (typeof h.get === 'function') { const n = new Headers(h); n.delete(HDR); return { ...init, headers: n } }
  return { ...init, headers: Object.fromEntries(Object.entries(h).filter(([k]) => k.toLowerCase() !== HDR)) }
}
const isLockout = async (r) => {
  if (r.status !== 429) return false
  try { return /wrong PIN/i.test((await r.clone().json())?.error ?? '') } catch { return false }
}

/** Wrap `fetch` so a PIN lockout never empties a page. Returns the wrapped function. */
export function guardFetch(fetchImpl, { clearPin, onLocked = () => {} }) {
  return async function guarded(input, init) {
    const r = await fetchImpl(input, init)
    if (!sentPin(init) || !(await isLockout(r))) return r
    clearPin()
    onLocked()
    return fetchImpl(input, withoutPin(init))
  }
}

/**
 * At start, with dev mode on: is the stored PIN still the server's? Resolves to
 * 'ok' | 'none' (nothing stored) | 'stale' (rejected and forgotten) | 'locked' | 'unknown'.
 * Never treats "could not ask" as "wrong" — offline keeps the PIN.
 */
export async function checkStoredPin({ fetchImpl, getPin, clearPin }) {
  const pin = getPin()
  if (!pin) return 'none'
  let r
  try { r = await fetchImpl('/api/leaderboard/verify-pin', { method: 'POST', headers: { [HDR]: pin } }) }
  catch { return 'unknown' }
  if (r.ok) return 'ok'
  if (r.status === 403) { clearPin(); return 'stale' }
  if (await isLockout(r)) { clearPin(); return 'locked' }
  return 'unknown'
}
