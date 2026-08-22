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

/**
 * A rising two-tone warble, harsh on purpose — a gentle sound is the wrong tool for waking
 * someone. One second of pattern, looped by the element.
 */
export function alarmSamples(sampleRate = SAMPLE_RATE) {
  const n = sampleRate
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate
    // Alternate 880/1320 Hz every 125ms, with a short envelope so each beep has an edge.
    const slot = Math.floor(t * 8) % 2
    const freq = slot ? 1320 : 880
    const phase = (t * 8) % 1
    // Fade in/out inside each beep to avoid clicks, silent for the last quarter.
    const env = phase > 0.75 ? 0 : Math.min(1, phase * 12, (0.75 - phase) * 12)
    out[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.9
  }
  return out
}

// ── controller ───────────────────────────────────────────────────────────────

/**
 * Deliberately a factory over module state: the tests drive it with a stub element, and
 * the app has exactly one instance.
 */
export function createAlarm({ makeAudio, vibrate, onChange } = {}) {
  const mk = makeAudio ?? (() => new Audio())
  let el = null
  let armed = false
  let ringing = false
  let silentUrl = null
  let alarmUrl  = null
  let buzzTimer = null

  const url = (blob) => URL.createObjectURL(blob)
  const notify = () => { try { onChange?.({ armed, ringing }) } catch {} }

  /**
   * MUST be called from a user gesture — the autoplay policy will not let a page start
   * audio otherwise, and an alarm that silently failed to arm is worse than none.
   * Returns false if playback was refused, so the caller can say so rather than lie.
   */
  async function arm() {
    if (armed) return true
    if (!silentUrl) silentUrl = url(encodeWav(silenceSamples()))
    if (!alarmUrl)  alarmUrl  = url(encodeWav(alarmSamples()))
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
    try { el.play() } catch {}
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
    if (el && armed) { el.src = silentUrl; el.volume = 0.02; el.loop = true; try { el.play() } catch {} }
    notify()
  }

  return {
    arm, disarm, fire, stop,
    isArmed:   () => armed,
    isRinging: () => ringing,
  }
}
