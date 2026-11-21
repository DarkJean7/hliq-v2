/**
 * Candles kept on the device, so a reload does not fetch a year of them again.
 *
 * Asked: "each time i open the app or reload and then i open oracle it fetches all the data
 * again, and it takes a while". The Analysis cache (analysis.js) lived in memory only, so every
 * reload re-read 4h, daily and weekly candles for every market on the Oracle tab — ~120 weight
 * each, one at a time, paced. Now what was read is kept in IndexedDB (too big for localStorage:
 * ~250 KB a market), shown at once on the next visit, and refreshed only from the last candle on.
 *
 * Best effort throughout: no IndexedDB (a private window, a blocked store) means it simply reads
 * from the exchange as before. Nothing here is the only copy of anything.
 */

const DB = 'hliq-candles', STORE = 'analysis', VERSION = 1
// A stored read older than this is not worth showing: start again.
export const KEEP_MS = 3 * 864e5

let dbp = null
function db() {
  if (dbp) return dbp
  dbp = new Promise((resolve) => {
    try {
      if (typeof indexedDB === 'undefined') return resolve(null)
      const r = indexedDB.open(DB, VERSION)
      r.onupgradeneeded = () => { try { r.result.createObjectStore(STORE) } catch {} }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => resolve(null)
      r.onblocked = () => resolve(null)
    } catch { resolve(null) }
  })
  return dbp
}

/** { at, candles: { '4h': [...], '1d': [...], '1w': [...] } } or null. */
export async function getCandles(coin) {
  const d = await db()
  if (!d) return null
  return new Promise((resolve) => {
    try {
      const q = d.transaction(STORE, 'readonly').objectStore(STORE).get(coin)
      q.onsuccess = () => {
        const v = q.result
        resolve(v?.at && v.candles && Date.now() - v.at < KEEP_MS ? v : null)
      }
      q.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

export async function putCandles(coin, value) {
  const d = await db()
  if (!d) return false
  return new Promise((resolve) => {
    try {
      const tx = d.transaction(STORE, 'readwrite')
      tx.objectStore(STORE).put(value, coin)
      tx.oncomplete = () => resolve(true)
      tx.onerror = () => resolve(false)
    } catch { resolve(false) }
  })
}

/**
 * Join what was kept with what was just read: by candle time, the fresh one winning (the last
 * kept candle was still forming when it was kept), oldest first, and nothing older than `from`.
 */
export function mergeCandles(kept, fresh, from = -Infinity) {
  const by = new Map()
  for (const k of kept ?? []) if (k?.t >= from) by.set(k.t, k)
  for (const k of fresh ?? []) if (k?.t >= from) by.set(k.t, k)
  return [...by.values()].sort((a, b) => a.t - b.t)
}

/**
 * Where to start reading so nothing is missed: two candles before the last one kept — the last
 * was still forming, and the one before it may have closed after it was kept. Without a kept
 * series, the whole span.
 */
export function readFrom(kept, spanStart) {
  return kept?.length >= 2 ? Math.max(spanStart, kept[kept.length - 2].t) : spanStart
}
