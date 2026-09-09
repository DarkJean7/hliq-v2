/**
 * INSOLVENT TERMINAL — backdrop themes
 *
 * The app already had a colour scheme (dark/light), a corner style, an accent hue and a
 * brightness slider. What it had no control over was the SURFACE: the near-black behind
 * every panel, which is most of what the screen actually is.
 *
 * Two things live here:
 *
 *   Presets   — a named set of surface colours. Only the greys change; the accent hue,
 *               the semantic green/red and every layout rule stay exactly where they are,
 *               so a preset cannot make a loss look like a profit.
 *   A photo   — the user's own image behind the app, downscaled and stored on the device.
 *
 * Both write CSS custom properties on <html>, the same mechanism the accent and brightness
 * controls already use, so nothing has to re-render for a change to take effect.
 *
 * Dark only, deliberately. These are dark-surface ramps; light mode overrides them with its
 * own palette further down the cascade, and a preset that half-applied over light mode
 * would produce grey text on a grey card. When light mode is on, a preset is remembered but
 * not painted -- and the settings row says so rather than silently doing nothing.
 */

const KEY_PRESET = 'hliq_backdrop'
const KEY_IMAGE  = 'hliq_backdrop_img'
const KEY_DIM    = 'hliq_backdrop_dim'

/**
 * The surface ramp, darkest to lightest, plus its two rules.
 *
 * These six are every neutral the app paints with. Anything semantic -- pos, neg, warn, the
 * accent -- is deliberately absent: a backdrop is a mood, not a re-theme, and letting a
 * preset touch the red would be letting it lie.
 */
export const BACKDROPS = [
  { id: 'midnight', name: 'Midnight', hint: 'The default — cool near-black',
    vars: { bg: '#0a0c10', panel: '#11141b', p2: '#161a23', p3: '#1c2230', rule: '#1f2533', soft: '#161b26' } },
  { id: 'carbon', name: 'Carbon', hint: 'Neutral, no blue cast',
    vars: { bg: '#0b0b0c', panel: '#141416', p2: '#1a1a1d', p3: '#222226', rule: '#2a2a2f', soft: '#1c1c20' } },
  { id: 'slate', name: 'Slate', hint: 'Lifted greys, softer contrast',
    vars: { bg: '#12151c', panel: '#1a1e27', p2: '#212632', p3: '#2a303e', rule: '#333a4a', soft: '#252b37' } },
  { id: 'ocean', name: 'Ocean', hint: 'Deep blue',
    vars: { bg: '#07101a', panel: '#0d1a28', p2: '#122234', p3: '#182d43', rule: '#1f3a55', soft: '#152840' } },
  { id: 'plum', name: 'Plum', hint: 'Deep violet',
    vars: { bg: '#0d0912', panel: '#17101f', p2: '#1e1529', p3: '#281c36', rule: '#332444', soft: '#221830' } },
  { id: 'forest', name: 'Forest', hint: 'Deep green',
    vars: { bg: '#070f0c', panel: '#0d1a15', p2: '#12231d', p3: '#182f27', rule: '#1f3d33', soft: '#152a23' } },
  { id: 'void', name: 'Void', hint: 'True black — best on OLED',
    vars: { bg: '#000000', panel: '#0a0a0a', p2: '#111111', p3: '#181818', rule: '#232323', soft: '#141414' } },
]

export function backdropById(id) {
  return BACKDROPS.find(b => b.id === id) ?? BACKDROPS[0]
}

/** Reads never throw: a browser with storage disabled gets the default, not a broken app. */
export function loadBackdrop() {
  try { return localStorage.getItem(KEY_PRESET) || 'midnight' } catch { return 'midnight' }
}
export function loadBackdropImage() {
  try { return localStorage.getItem(KEY_IMAGE) || '' } catch { return '' }
}
export function loadBackdropDim() {
  try {
    const v = parseInt(localStorage.getItem(KEY_DIM) ?? '', 10)
    return Number.isFinite(v) ? Math.min(95, Math.max(0, v)) : 62
  } catch { return 62 }
}

// #rrggbb -> rgba(). Presets are written as hex because that is what anyone editing the
// list wants to type; translucency is a rendering decision made here.
function _rgba(hex, a) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex ?? ''))
  if (!m) return hex
  const [r, g, bl] = [1, 2, 3].map(i => parseInt(m[i], 16))
  return `rgba(${r}, ${g}, ${bl}, ${a})`
}

/**
 * Paint a preset.
 *
 * `photo` makes the PANEL surfaces translucent so an uploaded image reads through them.
 * Done at the variable level rather than per card: every surface in the app already paints
 * with these three, so one change reaches every tab on both shells -- and a card added
 * next month inherits it without anyone remembering to add a rule.
 *
 * The three elevations get different alphas on purpose. --panel-3 is the raised surface
 * (menus, popovers, things that open OVER content) and stays the most solid, because a
 * dropdown you can read the table through is not a dropdown.
 */
export function applyBackdrop(id, { light = false, photo = false } = {}) {
  const el = document.documentElement
  const b  = backdropById(id)
  const set = (k, v) => v ? el.style.setProperty(k, v) : el.style.removeProperty(k)
  // Light mode keeps its own palette. Clearing rather than skipping matters: toggling from
  // dark-with-a-preset to light would otherwise leave the dark ramp painted over it.
  const v = light ? {} : b.vars
  set('--bg', v.bg)
  set('--panel',   photo ? _rgba(v.panel, .55) : v.panel)
  set('--panel-2', photo ? _rgba(v.p2, .62)    : v.p2)
  set('--panel-3', photo ? _rgba(v.p3, .78)    : v.p3)
  set('--rule', v.rule);  set('--rule-soft', v.soft)
  return b
}

export function saveBackdrop(id) {
  try { localStorage.setItem(KEY_PRESET, backdropById(id).id); return true } catch { return false }
}

/**
 * Paint the user's photo, or take it away.
 *
 * The image goes on a FIXED layer behind everything rather than on `body`, so it does not
 * scroll with the content and does not repeat: a background that slides around under a
 * table of numbers is the fastest way to make a terminal unreadable.
 *
 * `dim` is a scrim over the photo, not a filter on it. Panels are semi-transparent in this
 * mode so the picture reads through them, which is the whole point -- and a photo with a
 * bright patch would otherwise put white text on white. The scrim is what keeps every
 * number legible regardless of what was uploaded, so it has a floor.
 */
export function applyBackdropImage(dataUrl, dim = 62) {
  const el = document.documentElement
  if (!dataUrl) {
    el.style.removeProperty('--app-bg-image')
    el.classList.remove('has-bg-image')
    return false
  }
  el.style.setProperty('--app-bg-image', `url("${dataUrl}")`)
  el.style.setProperty('--app-bg-dim', String(Math.min(95, Math.max(25, dim)) / 100))
  el.classList.add('has-bg-image')
  return true
}

export function saveBackdropDim(dim) {
  try { localStorage.setItem(KEY_DIM, String(dim)); return true } catch { return false }
}

/**
 * A file the user picked, shrunk to something a browser can actually store.
 *
 * localStorage is a few MB for the whole origin and this app already keeps paper accounts,
 * device bots and a cached All-Accounts snapshot in it. A phone photo is 3-8 MB; storing one
 * raw would not merely fail, it would evict the things people care about. So it is drawn to
 * a canvas at a bounded width and re-encoded as JPEG.
 *
 * Resolves { ok, dataUrl, bytes } or { ok: false, error } -- never throws, because every
 * caller here is a click handler and an unhandled rejection in one is a silent no-op.
 */
export function readBackdropFile(file, { maxW = 1600, quality = 0.72 } = {}) {
  return new Promise((resolve) => {
    if (!file) return resolve({ ok: false, error: 'no file' })
    if (!/^image\//.test(file.type || '')) return resolve({ ok: false, error: 'not an image' })
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, maxW / (img.naturalWidth || maxW))
        const w = Math.max(1, Math.round((img.naturalWidth || maxW) * scale))
        const h = Math.max(1, Math.round((img.naturalHeight || maxW) * scale))
        const c = document.createElement('canvas')
        c.width = w; c.height = h
        c.getContext('2d').drawImage(img, 0, 0, w, h)
        // JPEG, not PNG: a photo as PNG is several times larger for no visible gain, and
        // size is the whole constraint here.
        const dataUrl = c.toDataURL('image/jpeg', quality)
        resolve({ ok: true, dataUrl, bytes: Math.round(dataUrl.length * 0.75), w, h })
      } catch (e) {
        resolve({ ok: false, error: e?.message || 'could not read that image' })
      } finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); resolve({ ok: false, error: 'could not decode that image' }) }
    img.src = url
  })
}

/**
 * Store the image. Reports quota failure rather than swallowing it: a wallpaper that
 * vanishes on reload with no explanation is worse than one that was refused.
 */
export function saveBackdropImage(dataUrl) {
  try {
    if (!dataUrl) { localStorage.removeItem(KEY_IMAGE); return { ok: true } }
    localStorage.setItem(KEY_IMAGE, dataUrl)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: /quota/i.test(e?.name || e?.message || '')
      ? 'That image is too large to store on this device. Try a smaller one.'
      : (e?.message || 'could not save') }
  }
}

/** Everything, at startup. Called before first paint so nothing flashes the old surface. */
export function restoreTheme({ light = false } = {}) {
  const img = loadBackdropImage()
  applyBackdrop(loadBackdrop(), { light, photo: !!img })
  applyBackdropImage(img, loadBackdropDim())
}
