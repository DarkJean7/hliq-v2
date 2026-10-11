/**
 * The app's half of paper accounts on the server (src/paperhost.js has the rules).
 *
 * Every few seconds: send the paper keys that changed here, receive the ones that changed
 * there, and hold the lease on the account the app is running — so the server leaves that one
 * to the app and advances all the others, and all of them once the app is closed. Nothing about
 * trading in the app changes: it reads and writes localStorage exactly as before, and this file
 * moves those keys to and from the server around it.
 *
 * The OWNER is a random secret made here once and kept on this device. It is the only thing
 * that ties the server's copy to you; clearing site data loses it, as it always lost the
 * accounts themselves.
 *
 * Until the first sync has answered, the app does not advance a store (the server may have
 * moved it while the app was closed, and those fills are the real ones). If the server cannot
 * be reached, the app runs the account on its own, as it always did, and the next sync
 * reconciles: whatever the server advanced in the meantime wins.
 */
import { PAPER_KEY_RE } from './paperkeys.js'

const OWNER_KEY = 'hliq_paper_owner', CLIENT_KEY = 'hliq_paper_client', SEEN_KEY = 'hliq_paper_seen'

function hex(n) {
  const a = new Uint8Array(n)
  crypto.getRandomValues(a)
  return [...a].map(b => b.toString(16).padStart(2, '0')).join('')
}
const getJson = (st, k, d) => { try { return JSON.parse(st.getItem(k) ?? 'null') ?? d } catch { return d } }

/** Whether this device has ever had a paper account: only then is there anything to sync. */
export function hasPaper(st = localStorage) {
  try { for (let i = 0; i < st.length; i++) if (PAPER_KEY_RE.test(st.key(i) ?? '')) return true } catch {}
  return false
}

/**
 *   holdKey(): the store key the app is running now, or null
 *   onAdopt(keys): the server sent newer values for these keys (already written to storage)
 *   every(active): ms between syncs — quick while an account is held, slow otherwise
 * → { gate(key), syncNow(), stop(), state() }
 */
export function startPaperSync({ holdKey, onAdopt = () => {}, storage = localStorage, fetchImpl = (...a) => fetch(...a), every = (active) => (active ? 5_000 : 30_000), url = '/paper/sync' }) {
  let secret = storage.getItem(OWNER_KEY)
  if (!/^[0-9a-f]{64}$/.test(secret ?? '')) { secret = hex(32); try { storage.setItem(OWNER_KEY, secret) } catch {} }
  let client = storage.getItem(CLIENT_KEY)
  if (!/^[a-z0-9]{8,40}$/.test(client ?? '')) { client = hex(8); try { storage.setItem(CLIENT_KEY, client) } catch {} }
  let seen = getJson(storage, SEEN_KEY, {})
  // What the server has, as far as this tab knows: a key whose value differs from this has
  // changed here and is sent. Empty at start, so the first sync sends everything once.
  const sent = new Map()
  // null: not answered yet (hold still); true: in touch; false: unreachable (run locally).
  let online = null, leased = null, busy = false, timer = null, stopped = false
  // What this tab held at its last sync: letting go of it is a release, holding nothing never was.
  let held = null

  const scan = () => {
    const out = {}
    try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && PAPER_KEY_RE.test(k)) out[k] = storage.getItem(k) } } catch {}
    return out
  }

  async function syncNow({ release = false } = {}) {
    if (busy || stopped) return
    busy = true
    const hold = release ? null : (holdKey() ?? null)
    const letGo = !!held && !hold
    try {
      const cur = scan()
      const push = {}
      for (const [k, v] of Object.entries(cur)) if (sent.get(k) !== v) push[k] = v
      for (const k of sent.keys()) if (!(k in cur) && sent.get(k) != null) push[k] = null
      const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: release,
        body: JSON.stringify({ secret, client, hold, release: letGo, seen, push }) })
      const j = await r.json()
      if (!j?.ok) throw new Error(j?.error ?? 'sync refused')
      for (const [k, v] of Object.entries(push)) if (!j.conflicts?.includes(k)) sent.set(k, v)
      const adopted = []
      for (const [k, v] of Object.entries(j.changed ?? {})) {
        if (!PAPER_KEY_RE.test(k)) continue
        try { if (v == null) storage.removeItem(k); else storage.setItem(k, v) } catch { continue }
        sent.set(k, v)
        adopted.push(k)
      }
      seen = j.revs ?? seen
      try { storage.setItem(SEEN_KEY, JSON.stringify(seen)) } catch {}
      online = true
      leased = j.lease ?? null
      held = hold
      if (adopted.length) { try { onAdopt(adopted) } catch {} }
    } catch {
      online = false
    } finally { busy = false }
  }

  // Checked every second against the CURRENT cadence, so entering paper speeds the syncs up at
  // once instead of after a wait chosen while the app was on a real account (30 s).
  let last = 0
  const loop = async () => {
    if (stopped) return
    if (Date.now() - last >= every(!!holdKey())) { last = Date.now(); await syncNow() }
    timer = setTimeout(loop, 1000)
  }
  loop()
  // Leaving: hand the account back to the server now rather than a lease-length later.
  const onHide = () => { if (document.visibilityState === 'hidden') syncNow({ release: true }) }
  try { document.addEventListener('visibilitychange', onHide); addEventListener('pagehide', () => syncNow({ release: true })) } catch {}

  return {
    /** May the app advance this store now? Only while it holds the lease — or when offline. */
    gate: (key) => (online === false ? true : online === true && leased === key),
    syncNow,
    stop() { stopped = true; clearTimeout(timer) },
    state: () => ({ online, leased, owner: secret.slice(0, 6) }),
  }
}
