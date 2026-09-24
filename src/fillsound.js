/**
 * INSOLVENT TERMINAL — a sound when an order fills
 *
 * Asked for: "let the user set sound for when an order gets filled", then "better sounds… the
 * app is about trading, the sounds should be more related to that area". So they are the noises
 * a trading floor actually makes: the opening bell, a cash register, the tape printing, the
 * gavel that ends an auction, a desk phone, a quiet confirmation blip.
 *
 * ── why they are synthesised ──
 *
 * No audio files. A file is a network request that can fail, a cache entry that can go stale,
 * and tens of kilobytes in the bundle for something that is a handful of oscillators. These are
 * built at play time, so they cost nothing until used and cannot 404.
 *
 * ── what makes them sound like objects rather than beeps ──
 *
 * A struck bell is not a sine wave. Each sound is LAYERS: partials at inharmonic ratios (a real
 * bell's overtones are not whole multiples, which is why it rings rather than hums), a noise
 * transient for the strike itself, and per-layer decay — the high partials die first, as they
 * do in metal. A pitch that slides (`to`) is what separates a register's ka-CHING from two
 * unrelated dings.
 *
 * ── the browser's rule about noise ──
 *
 * A page may not make a sound until the person has interacted with it, and a context created
 * before that starts 'suspended'. So it is created lazily and `unlock()` is called from the
 * first gesture: without it the first fill of a session would be silent and every one after it
 * fine, which reads as a bug rather than a policy.
 *
 * OFF by default — nobody's first session should make a noise they did not ask for.
 */

const KEY_SOUND = 'hliq_fill_sound'
const KEY_VOL   = 'hliq_fill_sound_vol'

/**
 * A layer is `{ f, to?, at, dur, g, wave?, type? }`:
 *   f    — frequency in Hz (the centre frequency for a noise layer)
 *   to   — glide to this frequency across the layer, for a ring or a drop
 *   at   — when it starts, in seconds from the top of the sound
 *   dur  — how long it takes to decay to silence
 *   g    — its share of the volume
 *   type — 'noise' for a band-passed burst (a strike, a key, tape); oscillator otherwise
 */
export const SOUNDS = {
  off: { label: 'Off', icon: '🔇', layers: [] },

  // The opening bell: a struck brass bell, partials at a real bell's inharmonic ratios.
  bell: {
    label: 'Opening bell',
    icon: '🔔',
    layers: [
      { type: 'noise', f: 3200, at: 0, dur: 0.05, g: 0.5 },
      { f: 660,  at: 0,     dur: 1.5,  g: 1 },
      { f: 1320, at: 0,     dur: 1.1,  g: 0.5 },
      { f: 1979, at: 0,     dur: 0.7,  g: 0.28 },
      { f: 2640, at: 0.002, dur: 0.45, g: 0.16 },
      { f: 3818, at: 0.004, dur: 0.3,  g: 0.09 },
    ],
  },

  // A cash register: the key, then the drawer's bell ringing up.
  register: {
    label: 'Ka-ching',
    icon: '💰',
    layers: [
      { type: 'noise', f: 2400, at: 0,    dur: 0.04, g: 0.6 },
      { f: 1046, at: 0,    dur: 0.18, g: 0.75 },
      { f: 1568, at: 0.07, dur: 0.55, g: 0.9 },
      { f: 2093, at: 0.07, dur: 0.4,  g: 0.4 },
      { f: 3136, at: 0.08, dur: 0.25, g: 0.18 },
    ],
  },

  // Ticker tape: the type bar striking, twice, the way a tape prints a print.
  ticker: {
    label: 'Ticker tape',
    icon: '📈',
    layers: [
      { type: 'noise', f: 1800, at: 0,    dur: 0.03, g: 1.35 },
      { f: 520, to: 380, at: 0,    dur: 0.05, g: 0.75, wave: 'square' },
      { type: 'noise', f: 2100, at: 0.085, dur: 0.03, g: 1.05 },
      { f: 560, to: 400, at: 0.085, dur: 0.05, g: 0.6, wave: 'square' },
    ],
  },

  // The gavel that closes an auction: wood, not metal — a low knock with no ring.
  gavel: {
    label: 'Gavel',
    icon: '🔨',
    layers: [
      { type: 'noise', f: 900, at: 0, dur: 0.06, g: 1.3 },
      { f: 180, to: 120, at: 0,     dur: 0.16, g: 1.17 },
      { f: 300, to: 220, at: 0.005, dur: 0.1,  g: 0.455 },
    ],
  },

  // The desk phone on the far side of the floor.
  desk: {
    label: 'Desk phone',
    icon: '☎️',
    layers: [
      { f: 1046, at: 0,    dur: 0.1, g: 1.19, wave: 'triangle' },
      { f: 1318, at: 0.05, dur: 0.1, g: 1.19, wave: 'triangle' },
      { f: 1046, at: 0.16, dur: 0.1, g: 0.935, wave: 'triangle' },
      { f: 1318, at: 0.21, dur: 0.2, g: 0.935, wave: 'triangle' },
    ],
  },

  // Filled, and nothing more: the quiet one, for a desk running bots all day.
  fill: {
    label: 'Fill blip',
    icon: '✅',
    layers: [
      { f: 880,  at: 0,    dur: 0.06, g: 1.02, wave: 'triangle' },
      { f: 1318, at: 0.05, dur: 0.14, g: 1.19, wave: 'triangle' },
    ],
  },
}

export const DEFAULT_SOUND = 'off'

/**
 * The first set of sounds were generic — chime, ding, blip, coin, deep. Anyone who had picked
 * one keeps a sound rather than being silently switched off when the names changed.
 */
const ALIASES = { chime: 'bell', ding: 'bell', blip: 'fill', coin: 'register', deep: 'gavel' }

const _ls = () => (typeof localStorage !== 'undefined' ? localStorage : null)

/** A stored name, cleaned: an unknown one reads as off rather than throwing at play time. */
export function soundName(store = _ls()) {
  try {
    const raw = String(store?.getItem(KEY_SOUND) ?? '')
    const v = ALIASES[raw] ?? raw
    return Object.hasOwn(SOUNDS, v) ? v : DEFAULT_SOUND
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
  const want = ALIASES[String(name)] ?? String(name)
  const v = Object.hasOwn(SOUNDS, want) ? want : DEFAULT_SOUND
  try { store?.setItem(KEY_SOUND, v) } catch {}
  return v
}

export function setVolume(v, store = _ls()) {
  const n = Math.min(1, Math.max(0, parseFloat(v) || 0))
  try { store?.setItem(KEY_VOL, String(n)) } catch {}
  return n
}

export const isOn = (store = _ls()) => soundName(store) !== 'off'

// ─── the control ──────────────────────────────────────────────────────────────

/**
 * The Settings control, as markup, built HERE so both shells get the same one.
 *
 * It was a bare browser `<select>`, which is the one thing on the page that looks like it
 * belongs to the operating system rather than the app. It is now a row of pills: every sound
 * visible without opening anything, and tapping one both selects it and plays it — picking a
 * sound from a list of names you cannot hear is guessing.
 *
 * Desktop and mobile Settings are separate shells and a duplicated renderer here would drift
 * (CLAUDE.md has a whole rule about the second copy). One function, called from both.
 */
export function pickerHtml(current = soundName(), vol = volume()) {
  const pills = Object.entries(SOUNDS).map(([k, s]) => `
    <button type="button" class="snd-pill${k === current ? ' on' : ''}" data-snd="${k}"
            onclick="window.__setFillSound('${k}')" title="${s.label}">
      <span class="snd-pill-ico">${s.icon}</span>${s.label}
    </button>`).join('')
  // No ids: both shells are in the DOM at once (one of them hidden), so an id here would be
  // in the document twice and getElementById would keep answering with the hidden one.
  return `<div class="snd-picker">
    <div class="snd-opts">${pills}</div>
    <div class="snd-foot">
      <span class="snd-vol-ico">🔈</span>
      <input type="range" class="snd-vol" min="0" max="100" step="5"
             value="${Math.round(vol * 100)}" title="Volume"
             oninput="window.__setFillVolume(this.value / 100)">
      <button type="button" class="snd-test" onclick="window.__testFillSound()">▶ Test</button>
    </div>
  </div>`
}

// ─── making the noise ─────────────────────────────────────────────────────────

let _ctx = null
let _noiseBuf = null

function _audio() {
  if (typeof window === 'undefined') return null
  const AC = window.AudioContext || window.webkitAudioContext
  if (!AC) return null
  if (!_ctx) { try { _ctx = new AC() } catch { return null } }
  return _ctx
}

/** Half a second of white noise, made once and reused — the strike in every percussive layer. */
function _noise(ctx) {
  if (_noiseBuf) return _noiseBuf
  const len = Math.floor(ctx.sampleRate * 0.5)
  const buf = ctx.createBuffer(1, len, ctx.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1
  _noiseBuf = buf
  return buf
}

/**
 * Called from a real gesture. A context created outside one starts suspended and every later
 * play() is silently dropped.
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
  const spec = SOUNDS[ALIASES[name] ?? name]
  if (!spec || !spec.layers.length || !(vol > 0)) return false
  const ctx = _audio()
  if (!ctx) return false
  try {
    if (ctx.state === 'suspended') ctx.resume().catch(() => {})
    const t0 = ctx.currentTime + 0.01
    // One gain for the whole sound, so the layers keep their balance at any volume and the
    // total can never clip however many of them a sound has.
    const out = ctx.createGain()
    out.gain.value = Math.min(1, vol) * 0.45
    out.connect(ctx.destination)

    for (const L of spec.layers) {
      const at   = t0 + (L.at ?? 0)
      const dur  = L.dur ?? 0.2
      const gain = ctx.createGain()
      const peak = Math.max(0.0005, (L.g ?? 1) * 0.5)
      // Struck, not switched on: a few milliseconds of attack, then an exponential tail —
      // which is how a real bell or a knock decays, and what stops a square wave clicking.
      gain.gain.setValueAtTime(0.0001, at)
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.006)
      gain.gain.exponentialRampToValueAtTime(0.0001, at + dur)

      if (L.type === 'noise') {
        const src = ctx.createBufferSource()
        src.buffer = _noise(ctx)
        // Band-passed so the burst reads as a strike on THAT object rather than as static.
        const bp = ctx.createBiquadFilter()
        bp.type = 'bandpass'
        bp.frequency.value = L.f ?? 2000
        bp.Q.value = 1.2
        src.connect(bp).connect(gain).connect(out)
        src.start(at)
        src.stop(at + dur + 0.02)
      } else {
        const osc = ctx.createOscillator()
        osc.type = L.wave ?? 'sine'
        osc.frequency.setValueAtTime(L.f, at)
        if (L.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, L.to), at + dur)
        osc.connect(gain).connect(out)
        osc.start(at)
        osc.stop(at + dur + 0.02)
      }
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
