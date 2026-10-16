/**
 * A tab opened before a deploy asks for the OLD chunk names when it lazy-loads a screen. Old
 * chunks are now kept on the server for two weeks (.github/workflows/deploy.yml), but a tab older
 * than that — or any miss — would still show "Failed to fetch dynamically imported module".
 * The cure is the new version of the page, so a missing chunk reloads it, ONCE: a flag in
 * sessionStorage stops a chunk that is genuinely broken from reloading forever.
 */
const FLAG = 'hliq_stale_chunk_reload'

export const isStaleChunk = (e) =>
  /dynamically imported module|Importing a module script failed|error loading dynamically imported|Unable to preload CSS/i.test(String(e?.message ?? e ?? ''))

/** Reload for a stale chunk if we have not just done so. Returns whether it is reloading. */
export function reloadForStaleChunk(e, { storage = sessionStorage, reload = () => location.reload(), now = Date.now() } = {}) {
  if (!isStaleChunk(e)) return false
  let last = 0
  try { last = +storage.getItem(FLAG) || 0 } catch {}
  if (now - last < 60_000) return false          // reloaded a minute ago and it is still missing: report it
  try { storage.setItem(FLAG, String(now)) } catch {}
  reload()
  return true
}

/** Vite fires this for every lazy import whose chunk (or its CSS) fails to load. */
export function installStaleChunkReload(target = window) {
  target.addEventListener('vite:preloadError', (ev) => { if (reloadForStaleChunk(ev.payload ?? ev)) ev.preventDefault?.() })
}
