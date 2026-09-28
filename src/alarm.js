// ─── WAKE ALARM ───────────────────────────────────────────────────────────────
//
// A price alert that actually wakes someone, without keeping the screen on.
//
// The obvious approach — a Wake Lock so the page cannot be suspended — costs 15-30% of a
// battery over a night, because the display dominates everything else. Instead the page
// holds an ordinary <audio> element looping near-silence. That keeps the media session
// alive with the screen off, which is how web alarm clocks work, and costs about as much
// as playing music quietly.
//
// Playing through a media element (rather than the Notification sound) is the other half:
// media ignores the ringer/silent switch, so the alarm is audible on a phone set to silent.
// It does NOT defeat Do Not Disturb — nothing on the web can — but DND silences
// notifications and calls, not media already playing.
//
// Both the silence and the alarm are generated here as WAV data, so there is no binary
// asset to ship, cache-bust, or have go missing at 4am.

// ── WAV encoding ─────────────────────────────────────────────────────────────
const SAMPLE_RATE = 8000        // plenty for a beep; keeps the data URI small

/** Build a mono 16-bit PCM WAV from samples in [-1, 1]. Returns a Blob. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buf  = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buf)
  const str  = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  str(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)            // PCM header size
  view.setUint16(20, 1, true)             // format = PCM
  view.setUint16(22, 1, true)             // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)             // block align
  view.setUint16(34, 16, true)            // bits per sample
  str(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

/**
 * Near-silence, not true silence. Some platforms treat an all-zero stream as nothing
 * playing and reclaim the media session — the one thing this whole approach depends on.
 * A hair above zero is inaudible but unmistakably a stream.
 */
export function silenceSamples(seconds = 2, sampleRate = SAMPLE_RATE) {
  const n = Math.round(seconds * sampleRate)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (i % 2 ? 1 : -1) * 1e-4
  return out
}

// ── the sounds ───────────────────────────────────────────────────────────────
//
// Five, because one is not a choice and the right alarm is the one that wakes YOU: a warble
// that a light sleeper will hear is not what gets someone out of deep sleep, and a klaxon at
// 3am in a shared bed is a different kind of problem. All harsh on purpose — a gentle sound
// is the wrong tool — and all generated here as samples, so there is still no audio file to
// ship, cache-bust or have go missing at 4am.
//
// 8kHz sampling means nothing above ~3.5kHz, which is fine: the ear is most sensitive around
// 2-4kHz and that is where these sit.

/** One second of two tones alternating eight times a second. The original. */
function warbleSamples(sr) {
  const out = new Float32Array(sr)
  for (let i = 0; i < sr; i++) {
    const t = i / sr
    const slot = Math.floor(t * 8) % 2
    const freq = slot ? 1320 : 880
    const phase = (t * 8) % 1
    // Fade in/out inside each beep to avoid clicks, silent for the last quarter.
    const env = phase > 0.75 ? 0 : Math.min(1, phase * 12, (0.75 - phase) * 12)
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.9
  }
  return out
}

/**
 * An ambulance sweep, 600Hz up to 1500 and back over two seconds. Continuous — no gaps for
 * a half-asleep brain to file it away as something outside.
 */
function sirenSamples(sr) {
  const n = sr * 2
  const out = new Float32Array(n)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const f = 1050 + 450 * Math.sin(2 * Math.PI * t / 2)
    phase += 2 * Math.PI * f / sr
    out[i] = Math.sin(phase) * 0.9
  }
  return out
}

/**
 * A ship's klaxon: a low blast with its harmonics, twice a second. The lowest of the five,
 * and the one that carries through a wall.
 */
function klaxonSamples(sr) {
  const out = new Float32Array(sr)
  for (let i = 0; i < sr; i++) {
    const t = i / sr
    const phase = (t * 2) % 1
    const env = phase > 0.62 ? 0 : Math.min(1, phase * 25, (0.62 - phase) * 25)
    const f = 320
    // Odd harmonics, squared off — the buzz that makes a horn a horn rather than a tone.
    const v = Math.sin(2 * Math.PI * f * t)
            + 0.55 * Math.sin(2 * Math.PI * f * 3 * t)
            + 0.30 * Math.sin(2 * Math.PI * f * 5 * t)
            + 0.18 * Math.sin(2 * Math.PI * f * 7 * t)
    // Driven past the clamp on purpose: a squared-off horn is harsher than a clean one, and
    // the clipping is what makes it read as a klaxon rather than as a low tone.
    out[i] = Math.max(-1, Math.min(1, v * 0.85)) * env * 0.95
  }
  return out
}

/** An old telephone bell: two struck tones ringing ten times a second. */
function bellSamples(sr) {
  const out = new Float32Array(sr)
  for (let i = 0; i < sr; i++) {
    const t = i / sr
    const phase = (t * 10) % 1
    const env = Math.exp(-phase * 4)          // struck, then ringing down into the next strike
    out[i] = (Math.sin(2 * Math.PI * 1046 * t) * 0.6 + Math.sin(2 * Math.PI * 1480 * t) * 0.4) * env * 0.95
  }
  return out
}

/**
 * A smoke-alarm triplet: three hard 3kHz beeps, then silence long enough that the next set
 * lands as a new alarm rather than as a drone. The hardest of the five to sleep through.
 */
function pulseSamples(sr) {
  const n = sr * 2
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    const cyc = t % 2                          // a triplet, then a rest
    let v = 0
    for (let k = 0; k < 3; k++) {
      const start = k * 0.22
      const d = cyc - start
      if (d < 0 || d > 0.15) continue
      const env = Math.min(1, d * 60, (0.15 - d) * 60)
      v = Math.sin(2 * Math.PI * 3000 * t) * env
    }
    out[i] = v * 0.95
  }
  return out
}

/** Every sound, in the order they are offered. */
export const ALARM_SOUNDS = {
  warble: { label: 'Warble', build: warbleSamples },
  siren:  { label: 'Siren',  build: sirenSamples },
  klaxon: { label: 'Klaxon', build: klaxonSamples },
  bell:   { label: 'Bell',   build: bellSamples },
  pulse:  { label: 'Pulse',  build: pulseSamples },
}

export const DEFAULT_ALARM = 'warble'

/** Samples for one of them. An unknown name is the default rather than silence: this is the
 *  one sound in the app where falling back to nothing is the worst possible answer. */
export function alarmSamples(kind = DEFAULT_ALARM, sampleRate = SAMPLE_RATE) {
  // Called as alarmSamples(8000) by older code and by the first version of the tests.
  if (typeof kind === 'number') { sampleRate = kind; kind = DEFAULT_ALARM }
  const spec = ALARM_SOUNDS[kind] ?? ALARM_SOUNDS[DEFAULT_ALARM]
  return spec.build(sampleRate)
}

// ── controller ───────────────────────────────────────────────────────────────

/**
 * Deliberately a factory over module state: the tests drive it with a stub element, and
 * the app has exactly one instance.
 */
export function createAlarm({ makeAudio, vibrate, onChange, sound = DEFAULT_ALARM } = {}) {
  const mk = makeAudio ?? (() => new Audio())
  let el = null
  let armed = false
  let ringing = false
  let silentUrl = null
  let alarmUrl  = null
  let buzzTimer = null
  let kind = ALARM_SOUNDS[sound] ? sound : DEFAULT_ALARM

  const url = (blob) => URL.createObjectURL(blob)
  /**
   * play() returns a PROMISE, so `try { el.play() } catch {}` catches nothing: swapping the
   * source while a play is in flight rejects with "The play() request was interrupted by a
   * new load request", which is exactly what stopping the alarm does. Harmless, and it was
   * surfacing as an unhandled rejection — noise in the console at 4am, and in the error
   * telemetry the rest of the time.
   */
  const play = (e) => { try { e.play()?.catch(() => {}) } catch {} }
  const notify = () => { try { onChange?.({ armed, ringing }) } catch {} }

  /**
   * MUST be called from a user gesture — the autoplay policy will not let a page start
   * audio otherwise, and an alarm that silently failed to arm is worse than none.
   * Returns false if playback was refused, so the caller can say so rather than lie.
   */
  async function arm() {
    if (armed) return true
    if (!silentUrl) silentUrl = url(encodeWav(silenceSamples()))
    if (!alarmUrl)  alarmUrl  = url(encodeWav(alarmSamples(kind)))
    el = el ?? mk()
    el.loop = true
    el.src = silentUrl
    el.volume = 0.02          // inaudible, but a real level: some platforms treat 0 as muted
    try {
      await el.play()
    } catch (e) {
      return false
    }
    armed = true
    notify()
    return true
  }

  function disarm() {
    stop()
    armed = false
    if (el) { try { el.pause() } catch {} }
    notify()
  }

  /** Ring. Safe to call repeatedly — a second trigger must not restart or stack. */
  function fire() {
    if (ringing) return true
    // Firing without arming cannot work: no gesture has been given, so play() is refused.
    if (!armed) return false
    ringing = true
    el.src = alarmUrl
    el.loop = true
    el.volume = 1
    play(el)
    if (vibrate) {
      const buzz = () => { try { vibrate([600, 300, 600, 300, 600, 900]) } catch {} }
      buzz()
      buzzTimer = setInterval(buzz, 3300)
    }
    notify()
    return true
  }

  /** Silence it but STAY armed — one alert firing must not disarm the night's alarm. */
  function stop() {
    if (buzzTimer) { clearInterval(buzzTimer); buzzTimer = null }
    try { vibrate?.(0) } catch {}
    if (!ringing) return
    ringing = false
    if (el && armed) { el.src = silentUrl; el.volume = 0.02; el.loop = true; play(el) }
    notify()
  }

  /**
   * Choose the sound. Rebuilds the clip, and if it is ringing right now, swaps to it —
   * changing the sound while it rings is how someone picks one at 4am.
   */
  function setSound(next) {
    if (!ALARM_SOUNDS[next] || next === kind) return kind
    kind = next
    alarmUrl = url(encodeWav(alarmSamples(kind)))
    if (ringing && el) { el.src = alarmUrl; el.loop = true; play(el) }
    notify()
    return kind
  }

  /**
   * Hear one WITHOUT arming, and without the full-screen takeover: a few seconds, once.
   *
   * Picking an alarm you have never heard is guessing, and the old Test could only be reached
   * after arming. Returns false if playback was refused, so the caller can say so.
   */
  function preview(next = kind) {
    const spec = ALARM_SOUNDS[next] ? next : kind
    el = el ?? mk()
    el.loop = false
    el.src = url(encodeWav(alarmSamples(spec)))
    el.volume = 1
    try { const r = el.play(); r?.catch?.(() => {}); } catch { return false }
    // Back to holding the media session open, if this alarm is meant to stay armed.
    if (armed) setTimeout(() => { if (!ringing && el) { el.src = silentUrl; el.volume = 0.02; el.loop = true; play(el) } }, 2200)
    return true
  }

  return {
    arm, disarm, fire, stop, setSound, preview,
    sound:     () => kind,
    isArmed:   () => armed,
    isRinging: () => ringing,
  }
}
