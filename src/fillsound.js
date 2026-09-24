/**
 * INSOLVENT TERMINAL — a sound when an order fills
 *
 * Asked for: "lets add a new feature in the settings that would let the user set sound for when
 * an order gets filled." A fill is the one event worth hearing: it happens on the exchange's
 * schedule, not yours, and the screen may be on another tab when it does.
 *
 * ── why the sounds are synthesised ──
 *
 * No audio files. A sound file is a network request that can fail, a cache entry that can go
 * stale, and 30–100 KB in the bundle for something that is three sine waves. These are built
 * from oscillators at play time, so they cost nothing until they are used and cannot 404.
 *
 * ── the browser's rule about noise ──
 *
 * A page may not make a sound until the person has interacted with it, and an AudioContext
 * created before that starts 'suspended'. So the context is created lazily and `unlock()` is
 * called from the first real gesture: without it the first fill of a session would be silent
 * and every one after it fine, which reads as a bug rather than a policy.
 *
 * OFF by default — nobody's first session should make a noise they did not ask for.
 */

const KEY_SOUND = 'hliq_fill_sound'
const KEY_VOL   = 'hliq_fill_sound_vol'

/**
 * The choices. Each is a few notes: [frequency in Hz, start offset, length] in seconds, and a
 * wave shape. Kept small and plain so they read as an interface, not a ringtone.
 */
export const SOUNDS = {
  off:    { label: 'Off',    notes: [] },
  chime:  { label: 'Chime',  wave: 'sine',     notes: [[880, 0, 0.12], [1318.5, 0.09, 0.22]] },
  ding:   { label: 'Ding',   wave: 'triangle', notes: [[1568, 0, 0.28]] },
  blip:   { label: 'Blip',   wave: 'square',   notes: [[660, 0, 0.05], [990, 0.06, 0.07]] },
  coin:   { label: 'Coin',   wave: 'square',   notes: [[988, 0, 0.07], [1319, 0.07, 0.18]] },
  deep:   { label: 'Deep',   wave: 'sine',     notes: [[220, 0, 0.18], [164.8, 0.12, 0.3]] },
}

export const DEFAULT_SOUND = 'off'

/** The chosen sound, cleaned: an unknown name reads as off rather than throwing at play time. */
export function soundName(store = _ls()) {
  try {
    const v = store?.getItem(KEY_SOUND)
    return Object.hasOwn(SOUNDS, String(v)) ? String(v) : DEFAULT_SOUND
  } catch { return DEFAULT_SOUND }
}

/** 0..1. Anything unreadable is 0.6, which is audible without being startling. */
export function volume(store = _ls()) {
  try {
    const v = parseFloat(store?.getItem(KEY_VOL))
    return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.6
  } catch { return 0.6 }
}

export function setSound(name, store = _ls()) {
  const v = Object.hasOwn(SOUNDS, String(name)) ? String(name) : DEFAULT_SOUND
  try { store?.setItem(KEY_SOUND, v) } catch {}
  return v
}

export function setVolume(v, store = _ls()) {
  const n = Math.min(1, Math.max(0, parseFloat(v) || 0))
  try { store?.setItem(KEY_VOL, String(n)) } catch {}
  return n
}

export const isOn = (store = _ls()) => soundName(store) !== 'off'

const _ls = () => (typeof localStorage !== 'undefined' ? localStorage : null)

// ─── making the noise ─────────────────────────────────────────────────────────

let _ctx = null
function _audio() {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!_ctx) { try { _ctx = new AC() } catch { return null } }
  return _ctx
}

/**
 * Called from a real gesture (a tap anywhere). A context created outside one starts suspended
 * and every later play() is silently dropped.
 */
export function unlock() {
  const ctx = _audio()
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {})
  return !!ctx
}

/**
 * Play one of the sounds. Never throws: audio is a nicety, and a browser that refuses must not
 * take a fill notification down with it.
 */
export function play(name = soundName(), vol = volume()) {
  const spec = SOUNDS[name]
  if (!spec || !spec.notes.length || !(vol > 0)) return false
  const ctx = _audio()
  if (!ctx) return false
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const t0 = ctx.currentTime
    for (const [freq, at, len] of spec.notes) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = spec.wave ?? 'sine'
      osc.frequency.setValueAtTime(freq, t0 + at)
      // A short fade in and out: a square wave switched on at full volume clicks.
      gain.gain.setValueAtTime(0.0001, t0 + at)
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * 0.35), t0 + at + 0.012)
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + at + len)
      osc.connect(gain).connect(ctx.destination)
      osc.start(t0 + at)
      osc.stop(t0 + at + len + 0.02)
    }
    return true
  } catch { return false }
}

/**
 * A fill happened. Silent when the setting is off.
 *
 * `count` is how many fills arrived at once: one sound for the batch, not one per fill — an
 * order filled in six pieces is one event to a listener (src/tradegroup.js makes the same
 * point about counting them).
 */
export function playFill(count = 1) {
  if (!(count > 0) || !isOn()) return false
  return play()
}
