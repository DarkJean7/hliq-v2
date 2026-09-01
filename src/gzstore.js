/**
 * Gzip a string into localStorage, and back out again.
 *
 * localStorage holds about 5MB per origin and stores strings, so a large JSON blob hits
 * the ceiling long before the data is actually large. The All Accounts cache for nine
 * wallets serialises to ~4.3MB of extremely repetitive JSON — thousands of fills with the
 * same twenty keys — which is close to the worst case for storing raw and close to the
 * best case for gzip.
 *
 * Compressing beats the alternatives: raising the cap walks into the quota, and dropping
 * the heavy arrays would mean a cached row whose history is absent rather than empty,
 * which is the distinction this app has already got wrong three times. Compression keeps
 * every field intact and only changes how it is stored.
 *
 * Async because CompressionStream is. Callers await; nothing here blocks a paint.
 */

const supported = () => typeof CompressionStream === 'function' && typeof Blob === 'function'

/** Bytes → base64. Chunked: a spread of a megabyte-long array blows the call stack. */
function toB64(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  }
  return btoa(s)
}

function fromB64(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * Compress `text`. Returns the stored string, or null when this browser cannot compress —
 * null means "could not", never "empty", and the caller has to tell those apart.
 */
export async function gzipToString(text) {
  if (!supported()) return null
  const cs = new CompressionStream('gzip')
  const stream = new Blob([text]).stream().pipeThrough(cs)
  const buf = await new Response(stream).arrayBuffer()
  return toB64(new Uint8Array(buf))
}

/** Inverse. Returns null if the value is not something we wrote, or is damaged. */
export async function gunzipFromString(stored) {
  if (!stored || typeof DecompressionStream !== 'function') return null
  try {
    const ds = new DecompressionStream('gzip')
    const stream = new Blob([fromB64(stored)]).stream().pipeThrough(ds)
    return await new Response(stream).text()
  } catch { return null }
}

export const gzipSupported = supported
