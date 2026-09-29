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

import { PING, ALARM, setAudioSession } from './audiosession.js'

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

// ── ringtones ────────────────────────────────────────────────────────────────
//
// Asked for: "is the wake up alarm a ring tone?? if not make it like one because the idea is
// to wake up". It was not: five harsh test tones at 8kHz, closer to a smoke detector than to
// the phone alarm people actually wake to. These are ringtones -- a melody, a struck timbre,
// a phrase that repeats -- generated at 22kHz so a marimba sounds like one and not like a
// buzzer. The harsh five stay for anyone who wants them.

const RING_RATE = 22050

/**
 * A struck bar: the fundamental plus the bright partial a marimba has at four times it, each
 * decaying on its own clock. The upper partial dies first, which is what makes the attack
 * bright and the tail round -- the difference between a mallet and a beep.
 */
function mallet(out, sr, at, freq, dur, gain = 1) {
  const i0 = Math.round(at * sr), n = Math.round(dur * sr)
  for (let k = 0; k < n && i0 + k < out.length; k++) {
    const t = k / sr
    const attack = Math.min(1, t * 400)                 // 2.5ms: no click, still a strike
    const v = Math.sin(2 * Math.PI * freq * t) * Math.exp(-t * 5)
            + 0.35 * Math.sin(2 * Math.PI * freq * 4 * t) * Math.exp(-t * 18)
            + 0.12 * Math.sin(2 * Math.PI * freq * 10 * t) * Math.exp(-t * 40)
    out[i0 + k] += v * attack * gain
  }
}

/** Scale a clip so its loudest sample sits at `peak` -- every ringtone as loud as the others. */
function normalise(out, peak = 0.95) {
  let m = 0
  for (const v of out) m = Math.max(m, Math.abs(v))
  if (m > 0) for (let i = 0; i < out.length; i++) out[i] = out[i] / m * peak
  return out
}

const NOTE = { E5: 659.25, 'G#5': 830.61, B5: 987.77, C6: 1046.5, E6: 1318.51, 'G#6': 1661.22, B6: 1975.53,
               C5: 523.25, G5: 783.99, D6: 1174.66, G6: 1567.98, C7: 2093.0 }

/**
 * The default: a marimba phrase in the shape of a modern phone alarm -- a bright rising figure,
 * answered, then a breath before it comes round again. Two seconds, so the loop seam falls in
 * the rest.
 */
function marimbaSamples(sr) {
  const out = new Float32Array(sr * 2)
  const seq = [['E6', 0], ['B5', 0.15], ['E6', 0.30], ['G#6', 0.45], ['B6', 0.60],
               ['G#6', 0.90], ['E6', 1.05], ['B5', 1.20], ['E6', 1.35]]
  for (const [n, at] of seq) mallet(out, sr, at, NOTE[n], 0.6)
  return normalise(out)
}

/**
 * An old telephone: two dual-tone bells struck twenty times a second, in the ring-ring cadence
 * everyone knows -- 0.4s on, 0.2s off, 0.4s on, then a pause. The one nobody sleeps through
 * because it has meant "pick up" their whole life.
 */
function classicSamples(sr) {
  const out = new Float32Array(sr * 2)
  const bursts = [[0, 0.4], [0.6, 1.0]]
  for (let i = 0; i < out.length; i++) {
    const t = i / sr
    if (!bursts.some(([a, b]) => t >= a && t < b)) continue
    const strike = (t * 20) % 1
    const env = Math.exp(-strike * 3)
    out[i] = (Math.sin(2 * Math.PI * 1100 * t) * 0.55 + Math.sin(2 * Math.PI * 1500 * t) * 0.45) * env
  }
  return normalise(out)
}

/** A rising chime: a major arpeggio climbing two octaves and landing high, then again. */
function risingSamples(sr) {
  const out = new Float32Array(sr * 2)
  const seq = ['C5', 'E5', 'G5', 'C6', 'E6', 'G6', 'C7']
  seq.forEach((n, k) => mallet(out, sr, k * 0.12, NOTE[n], 0.7, 0.8 + k * 0.05))
  mallet(out, sr, 0.95, NOTE.C7, 0.8)
  mallet(out, sr, 0.95, NOTE.G6, 0.8, 0.6)
  return normalise(out)
}

/** Every sound, in the order they are offered. Ringtones first: they are what people wake to. */
export const ALARM_SOUNDS = {
  ringtone: { label: 'Ringtone',      build: marimbaSamples, rate: RING_RATE },
  classic:  { label: 'Classic phone', build: classicSamples, rate: RING_RATE },
  rising:   { label: 'Rising',        build: risingSamples,  rate: RING_RATE },
  warble: { label: 'Warble', build: warbleSamples },
  siren:  { label: 'Siren',  build: sirenSamples },
  klaxon: { label: 'Klaxon', build: klaxonSamples },
  bell:   { label: 'Bell',   build: bellSamples },
  pulse:  { label: 'Pulse',  build: pulseSamples },
}

export const DEFAULT_ALARM = 'ringtone'

/** Samples for one of them. An unknown name is the default rather than silence: this is the
 *  one sound in the app where falling back to nothing is the worst possible answer. */
export function alarmSamples(kind = DEFAULT_ALARM, sampleRate) {
  // Called as alarmSamples(8000) by older code and by the first version of the tests.
  if (typeof kind === 'number') { sampleRate = kind; kind = DEFAULT_ALARM }
  const spec = ALARM_SOUNDS[kind] ?? ALARM_SOUNDS[DEFAULT_ALARM]
  return spec.build(sampleRate ?? spec.rate ?? SAMPLE_RATE)
}

/** The rate a sound is built at -- the ringtones need more than a beep does. */
export function alarmRate(kind = DEFAULT_ALARM) {
  return (ALARM_SOUNDS[kind] ?? ALARM_SOUNDS[DEFAULT_ALARM]).rate ?? SAMPLE_RATE
}

/** A sound as a WAV clip, at its own rate. */
function alarmWav(kind) { return encodeWav(alarmSamples(kind), alarmRate(kind)) }

/**
 * The first seconds of ringing: the sound repeated with its level rising from about a third
 * to full, the way a phone alarm swells. Baked into the samples rather than set on the
 * element, because iOS ignores a page setting an audio element's volume -- a ramp done that
 * way would be full volume from the first note on the phones that matter most.
 */
export const RAMP_SECONDS = 8
export function rampSamples(kind = DEFAULT_ALARM) {
  const one = alarmSamples(kind)
  const sr = alarmRate(kind)
  const reps = Math.max(1, Math.round(RAMP_SECONDS * sr / one.length))
  const out = new Float32Array(one.length * reps)
  for (let i = 0; i < out.length; i++) {
    const g = 0.35 + 0.65 * (i / out.length)
    out[i] = one[i % one.length] * g
  }
  return out
}

// ── controller ───────────────────────────────────────────────────────────────

/**
 * Deliberately a factory over module state: the tests drive it with a stub element, and
 * the app has exactly one instance.
 */
export function createAlarm({ makeAudio, vibrate, onChange, session, sound = DEFAULT_ALARM } = {}) {
  const mk = makeAudio ?? (() => new Audio())
  // Taking the audio session is the loud, visible half of arming: other apps stop, and the
  // lock screen starts calling us a music player. It belongs to the armed alarm and to
  // nothing else, so it is claimed in arm() and given back in disarm(). src/audiosession.js.
  const askSession = session ?? setAudioSession
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
    if (!alarmUrl)  alarmUrl  = url(alarmWav(kind))
    el = el ?? mk()
    el.loop = true
    el.src = silentUrl
    el.volume = 0.02          // inaudible, but a real level: some platforms treat 0 as muted
    // BEFORE play(): the session in force when a media element starts is the one it keeps,
    // so asking afterwards would leave this loop filed as a ping and let iOS drop it.
    askSession(ALARM)
    try {
      await el.play()
    } catch (e) {
      askSession(PING)        // refused — do not sit on the session we did not get to use
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
    askSession(PING)
    notify()
  }

  /** Ring. Safe to call repeatedly — a second trigger must not restart or stack. */
  function fire() {
    if (ringing) return true
    // Firing without arming cannot work: no gesture has been given, so play() is refused.
    if (!armed) return false
    ringing = true
    // Swell first, then ring at full for as long as it takes. The same element all the way
    // through: it is the one the page was allowed to play, and swapping its source from
    // `ended` is the same move fire() itself makes from a background callback.
    el.src = url(encodeWav(rampSamples(kind), alarmRate(kind)))
    el.loop = false
    el.volume = 1
    el.onended = () => {
      el.onended = null
      if (!ringing) return
      el.src = alarmUrl
      el.loop = true
      play(el)
    }
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
    if (el) el.onended = null
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
    alarmUrl = url(alarmWav(kind))
    // Changed while ringing: straight to the new one at full -- someone choosing at 4am is awake.
    if (ringing && el) { el.onended = null; el.src = alarmUrl; el.loop = true; play(el) }
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
    // Hearing one is not arming one: a preview rides over whatever is playing instead of
    // ending it. An alarm already armed keeps the session it is holding.
    if (!armed) askSession(PING)
    el = el ?? mk()
    el.loop = false
    el.src = url(alarmWav(spec))
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
