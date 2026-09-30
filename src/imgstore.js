/**
 * INSOLVENT TERMINAL — pictures a person adds
 *
 * Two places take one: a calendar note (kept on this device) and a global-chat message (sent
 * to the server). Both go through the same door, because both need the same two things done
 * to a file before anything else touches it.
 *
 * ── every picture is re-drawn ──
 *
 * A picked file is never stored or uploaded as it arrived. It is drawn into a canvas and
 * re-encoded as one predictable JPEG. That is not compression for its own sake:
 *
 *   • It DROPS EXIF, including the GPS tag a phone photo carries. A screenshot of a position
 *     posted to a public chatroom should not also say where the person was standing. The
 *     profile-picture upload already does this for the same reason; this is that rule, shared.
 *   • It BOUNDS the size before storage or the network sees it. A modern phone photo is 3-6MB;
 *     at 1280px and quality 0.72 the same picture is 120-350KB.
 *
 * ── where a note's pictures live ──
 *
 * IndexedDB, NOT localStorage. localStorage is one ~5MB budget shared by everything this app
 * keeps on a device — including the agent keys, whose loss CLAUDE.md records as the most
 * expensive bug in this repo. Two phone photos would eat most of that budget and the failure
 * would not be "the note lost its picture", it would be a quota error on whatever wrote next.
 * So the note keeps only the IDs, which are 16 bytes each, and the bytes live in a store with
 * its own budget.
 *
 * The pure half — sizes, ids, which stored pictures no note refers to any more — takes its
 * inputs as arguments and is tested in node: tests/suites/imgstore.test.mjs.
 */

// ── the rules ────────────────────────────────────────────────────────────────

/** Longest edge, in pixels, after the re-draw. Enough to read a chart screenshot on a phone. */
export const MAX_EDGE = 1280
/** JPEG quality. 0.72 is where a screenshot stops shrinking and starts smearing. */
export const JPEG_Q = 0.72
/** How many pictures one calendar note may carry. */
export const MAX_NOTE_IMGS = 6
/** The biggest re-drawn picture we will keep or send, in bytes. Chat's server checks again. */
export const MAX_BYTES = 700_000
/**
 * The chat's own ceiling, lower than a note's because a note costs one device its own disk
 * and a chat message costs the server's, once, for everyone. Exported so server.js checks
 * the same number the client enforced — two constants would drift and the failure would be
 * a picture that uploads and is refused, with nothing on screen to say which side said no.
 */
export const CHAT_IMG_MAX_BYTES = 500_000
/** Longest edge for a chat picture. Smaller than a note's: it is read in a scrolling feed. */
export const CHAT_MAX_EDGE = 1100

/**
 * The size to draw at: the same shape, with the longest edge at `max`. A picture already
 * smaller than `max` is left alone rather than blown up — upscaling adds bytes and no detail.
 */
export function fitDims(w, h, max = MAX_EDGE) {
  const W = Math.max(0, Math.round(Number(w) || 0))
  const H = Math.max(0, Math.round(Number(h) || 0))
  if (!W || !H) return { w: 0, h: 0 }
  const long = Math.max(W, H)
  if (long <= max) return { w: W, h: H }
  const k = max / long
  // Never round a dimension down to zero: a 4000x3 panorama is still two pixels tall.
  return { w: Math.max(1, Math.round(W * k)), h: Math.max(1, Math.round(H * k)) }
}

/** An id for one stored picture. Same shape as a note's id, and checked the same way. */
export const newImgId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 10)).slice(0, 16)

/** Ours, or something else's. Anything unrecognised is dropped rather than looked up. */
export const isImgId = (id) => typeof id === 'string' && /^[a-z0-9]{8,16}$/i.test(id)

/** A record's id list, cleaned: ids only, no duplicates, capped. */
export function cleanImgIds(ids, max = MAX_NOTE_IMGS) {
  const out = []
  for (const id of Array.isArray(ids) ? ids : []) {
    if (!isImgId(id) || out.includes(id)) continue
    out.push(id)
    if (out.length >= max) break
  }
  return out
}

/**
 * Stored pictures nothing points at any more — a note deleted, or an image removed while
 * editing one. Deleting a note has to take its pictures with it, or the store grows forever
 * with bytes no screen will ever show again.
 */
export function orphanIds(storedIds, inUseIds) {
  const live = new Set(Array.isArray(inUseIds) ? inUseIds : [])
  return (Array.isArray(storedIds) ? storedIds : []).filter(id => !live.has(id))
}

/** Roughly how many bytes a base64 data URL carries. Four characters carry three bytes. */
export function dataUrlBytes(dataUrl) {
  const s = String(dataUrl ?? '')
  const i = s.indexOf(',')
  if (i < 0) return 0
  const b64 = s.slice(i + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor(b64.length * 3 / 4) - pad)
}

/** A data URL this app is willing to draw. Anything else is not shown, not stored, not sent. */
export const isImageDataUrl = (s) => typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s)

// ── the re-draw ──────────────────────────────────────────────────────────────

/**
 * A picked File in, one JPEG data URL out — or null, for a file that is not a picture this
 * browser can decode. Null is an answer, not an error: the caller says so on screen.
 */
export function downscaleFile(file, { maxEdge = MAX_EDGE, quality = JPEG_Q } = {}) {
  return new Promise((resolve) => {
    if (typeof FileReader === 'undefined' || typeof document === 'undefined' || !file) return resolve(null)
    const reader = new FileReader()
    reader.onerror = () => resolve(null)
    reader.onload = (e) => {
      const img = new Image()
      img.onerror = () => resolve(null)
      img.onload = () => {
        try {
          const { w, h } = fitDims(img.naturalWidth || img.width, img.naturalHeight || img.height, maxEdge)
          if (!w || !h) return resolve(null)
          const canvas = document.createElement('canvas')
          canvas.width = w; canvas.height = h
          const ctx = canvas.getContext('2d')
          // A transparent PNG flattened onto nothing comes out with black where the page
          // would have shown the panel behind it. White is what a printed picture would be.
          ctx.fillStyle = '#ffffff'
          ctx.fillRect(0, 0, w, h)
          ctx.drawImage(img, 0, 0, w, h)
          resolve(canvas.toDataURL('image/jpeg', quality))
        } catch { resolve(null) }
      }
      img.src = e.target?.result
    }
    reader.readAsDataURL(file)
  })
}

// ── the store ────────────────────────────────────────────────────────────────

const DB_NAME = 'hliq_img'
const DB_VER  = 1
const STORE   = 'imgs'

/** The IndexedDB handle, opened once. Null where there is no IndexedDB — every call then
 *  answers "no" rather than throwing, and a note simply shows its text. */
let _dbPromise = null
function db(factory = (typeof indexedDB !== 'undefined' ? indexedDB : null)) {
  if (!factory) return Promise.resolve(null)
  if (_dbPromise) return _dbPromise
  _dbPromise = new Promise((resolve) => {
    let req
    try { req = factory.open(DB_NAME, DB_VER) } catch { return resolve(null) }
    req.onupgradeneeded = () => {
      try { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' }) } catch {}
    }
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror   = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return _dbPromise
}

function tx(handle, mode) {
  try { return handle.transaction(STORE, mode).objectStore(STORE) } catch { return null }
}

/** Store one picture and answer with its id, or null if the device would not keep it. */
export async function putImage(dataUrl, id = newImgId()) {
  if (!isImageDataUrl(dataUrl)) return null
  const handle = await db()
  if (!handle) return null
  return new Promise((resolve) => {
    const st = tx(handle, 'readwrite')
    if (!st) return resolve(null)
    let req
    try { req = st.put({ id, data: dataUrl, ts: Date.now() }) } catch { return resolve(null) }
    req.onsuccess = () => resolve(id)
    req.onerror   = () => resolve(null)
  })
}

/** One picture back, or null — which is "we do not have it", not "it is blank". */
export async function getImage(id) {
  if (!isImgId(id)) return null
  const handle = await db()
  if (!handle) return null
  return new Promise((resolve) => {
    const st = tx(handle, 'readonly')
    if (!st) return resolve(null)
    let req
    try { req = st.get(id) } catch { return resolve(null) }
    req.onsuccess = () => resolve(req.result?.data ?? null)
    req.onerror   = () => resolve(null)
  })
}

/** Every id the store holds. Used with orphanIds to find what nothing points at. */
export async function allImageIds() {
  const handle = await db()
  if (!handle) return []
  return new Promise((resolve) => {
    const st = tx(handle, 'readonly')
    if (!st) return resolve([])
    let req
    try { req = st.getAllKeys() } catch { return resolve([]) }
    req.onsuccess = () => resolve((req.result ?? []).filter(isImgId))
    req.onerror   = () => resolve([])
  })
}

/** Throw some away. Never throws: losing a picture must not take a delete down with it. */
export async function deleteImages(ids) {
  const list = (Array.isArray(ids) ? ids : []).filter(isImgId)
  if (!list.length) return 0
  const handle = await db()
  if (!handle) return 0
  return new Promise((resolve) => {
    const st = tx(handle, 'readwrite')
    if (!st) return resolve(0)
    let done = 0
    for (const id of list) {
      try { const r = st.delete(id); r.onsuccess = () => { if (++done === list.length) resolve(done) }; r.onerror = () => { if (++done === list.length) resolve(done) } }
      catch { if (++done === list.length) resolve(done) }
    }
  })
}
