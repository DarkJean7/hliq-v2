/**
 * INSOLVENT TERMINAL — what the page asks iOS to do with its audio
 *
 * Reported as "my app is acting like if it was a soundplayer app": opening it stopped
 * whatever was playing elsewhere, and the lock screen carried Insolvent Trade in the Now
 * Playing slot with a two-second track. That track is the wake alarm's near-silence loop
 * (src/alarm.js), which is two seconds long. Nothing else in the app is two seconds long.
 *
 * A page does not get a say in this by default. iOS files every sound a page makes under one
 * AUDIO SESSION, and the session decides whether a sound mixes with the music already
 * playing, ducks it, or stops it outright — and whether the ringer switch silences it. A
 * media element with no session declared is filed as PLAYBACK, which is the rule for a music
 * app: it takes the Now Playing controls and it stops everything else, permanently. That is
 * right for the wake alarm at 4am and wrong for a fill chime.
 *
 * So the page declares what kind of noise it is about to make:
 *
 *   TRANSIENT — a notification ping. Plays over the music, ducking it for a moment rather
 *               than ending it, and is not silenced by the ringer switch. This is what a
 *               fill chime and an alert are. It is the app's resting state.
 *   PLAYBACK  — takes the audio session away from every other app and keeps it. The wake
 *               alarm holds this WHILE ARMED, because that is the whole trick: a media
 *               element that owns the session goes on running with the screen off and is
 *               audible on a phone set to silent.
 *
 * The alarm switches to PLAYBACK when it arms and back to TRANSIENT when it disarms, so the
 * takeover lasts exactly as long as the feature that needs it — not from the moment the app
 * opens.
 *
 * Types and their meanings: https://www.w3.org/TR/audio-session/ — Safari 16.4 and later.
 * Everywhere else `navigator.audioSession` is missing and there is nothing to ask for, which
 * is not a failure: those platforms already mix by default.
 */

/** A notification ping: over the music, not instead of it. The resting state. */
export const PING  = 'transient'

/** Ours alone, until we give it back. Only the wake alarm, only while armed. */
export const ALARM = 'playback'

/**
 * Ask for `type`. Returns the type in force afterwards, or null where the platform has no
 * opinion to give — a caller must not read null as failure, only as "not iOS".
 *
 * `nav` is injectable so this is testable without a browser; the app never passes it.
 */
export function setAudioSession(type, nav = (typeof navigator !== 'undefined' ? navigator : null)) {
  const s = nav && nav.audioSession
  if (!s) return null
  try {
    s.type = type
    // Read it back: assigning an enum value the browser does not know is ignored rather than
    // refused, and silently keeping the old session is exactly the bug this module exists to
    // stop. The caller gets the truth.
    return s.type ?? null
  } catch { return null }
}

/** What is in force right now, or null where there is no session API. */
export function audioSessionType(nav = (typeof navigator !== 'undefined' ? navigator : null)) {
  const s = nav && nav.audioSession
  if (!s) return null
  try { return s.type ?? null } catch { return null }
}
