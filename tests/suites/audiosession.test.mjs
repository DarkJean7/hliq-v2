// Who owns the phone's audio, and for how long.
//
// Reported as "my app is acting like if it was a soundplayer app" — opening it stopped the
// music playing elsewhere and put Insolvent Trade in the lock screen's Now Playing slot,
// on a two-second track. Two seconds is the wake alarm's silence loop.
import fs from 'fs'
import { PING, ALARM, setAudioSession, audioSessionType } from '../../src/audiosession.js'
import { createAlarm } from '../../src/alarm.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const alm = fs.readFileSync('src/alarm.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const nl = String.fromCharCode(10)

globalThis.URL.createObjectURL ??= (b) => 'blob:stub/' + (b?.size ?? 0)

console.log(nl + '-- the two kinds of noise --')
// https://www.w3.org/TR/audio-session/ — "transient" is a notification ping, which plays on
// top of other audio and may duck it; "playback" is music, which does not mix at all.
t('a ping rides over the music', PING === 'transient')
t('the alarm takes the session outright', ALARM === 'playback')
t('they are not the same thing', PING !== ALARM)

console.log(nl + '-- asking a platform that has no opinion --')
// Everywhere but Safari 16.4+ there is no session API, and nothing to ask for. That is not
// a failure and must never read as one.
t('no navigator at all', setAudioSession(PING, null) === null)
t('a navigator without the API', setAudioSession(PING, {}) === null)
t('reading it back is null too, not a guess', audioSessionType({}) === null)

console.log(nl + '-- asking one that does --')
const nav = { audioSession: { type: 'auto' } }
t('the type is set', setAudioSession(ALARM, nav) === 'playback' && nav.audioSession.type === 'playback')
t('and readable afterwards', audioSessionType(nav) === 'playback')
t('and can be handed back', setAudioSession(PING, nav) === 'transient')

// A browser that does not know the value IGNORES the assignment rather than refusing it, so
// the answer has to be read back off the object. Returning the requested type would report a
// session we never got — which is the whole bug this module exists to stop.
const picky = { audioSession: { _t: 'auto', get type() { return this._t },
  set type(v) { if (v === 'playback') this._t = v } } }
t('an ignored value reports what is actually in force', setAudioSession(PING, picky) === 'auto')
t('and a known one still reports the change', setAudioSession(ALARM, picky) === 'playback')

const throws = { audioSession: { set type(_v) { throw new TypeError('nope') }, get type() { return 'auto' } } }
t('a setter that throws is null, not an exception', setAudioSession(PING, throws) === null)

console.log(nl + '-- the alarm holds it only while armed --')
const mkEl = (refuse = false) => ({
  src: '', loop: false, volume: 0, plays: 0, paused: false,
  play() { if (refuse) return Promise.reject(new Error('NotAllowedError')); this.plays++; return Promise.resolve() },
  pause() { this.paused = true },
})
const mk = (refuse = false) => {
  const el = mkEl(refuse), asked = []
  return { el, asked, alarm: createAlarm({ makeAudio: () => el, vibrate: () => {}, session: (x) => asked.push(x) }) }
}

let { alarm, asked } = mk()
t('nothing is claimed before arming', asked.length === 0)
await alarm.arm()
t('arming claims the session', asked.includes(ALARM))
t('and claims it exactly once', asked.filter(x => x === ALARM).length === 1)
alarm.fire()
t('ringing does not re-claim what it already holds', asked.filter(x => x === ALARM).length === 1)
alarm.stop()
t('and silencing it keeps it — the alarm is still armed', asked[asked.length - 1] === ALARM)
alarm.disarm()
t('disarming gives it back', asked[asked.length - 1] === PING)

;({ alarm, asked } = mk(true))
const ok = await alarm.arm()
t('a refused arm reports the refusal', ok === false)
t('and does not sit on a session it never got to use', asked[asked.length - 1] === PING)

;({ alarm, asked } = mk())
alarm.preview()
t('a preview rides over the music rather than ending it', asked[asked.length - 1] === PING)
await alarm.arm()
asked.length = 0
alarm.preview()
t('but an ARMED alarm previewing keeps what it is holding', asked.length === 0)

console.log(nl + '-- claimed before the sound starts, not after --')
// The session in force when a media element begins is the one it keeps, so asking afterwards
// leaves the keep-alive loop filed as a ping and lets iOS drop it with the screen off.
const armBody = alm.slice(alm.indexOf('async function arm()'), alm.indexOf('function disarm()'))
t('arm() asks before it plays', armBody.indexOf('askSession(ALARM)') < armBody.indexOf('await el.play()'))
t('the reason is written down', armBody.includes('the one it keeps'))

console.log(nl + '-- the app rests as a ping --')
t('main.js declares it at boot', cli.includes('_setAudioSession(_SND_PING)'))
t('and hands the switch to the alarm', cli.includes('session: (t) => _setAudioSession(t)'))

console.log(nl + '-- Test is not a decision --')
// It used to write the armed flag, so one press left the alarm on for good: re-armed on the
// first tap of every launch, holding the audio session, silencing every other app.
const test = cli.slice(cli.indexOf('window.__alarmTest = async function()'), cli.indexOf('// Sound the alarm for a price alert'))
t('testing the alarm does not remember it as armed', !test.includes('_ALARM_KEY'))
t('the toggle is still the only thing that does',
  cli.includes("localStorage.setItem(_ALARM_KEY, '1')") &&
  cli.slice(cli.indexOf('window.__alarmToggle'), cli.indexOf('window.__alarmTest')).includes("localStorage.setItem(_ALARM_KEY, '1')"))
t('and stopping a test puts the alarm back as it found it',
  test.includes('_alarmTestOnly = true') && test.includes('_alarmTestOnly = false; _alarm.disarm()'))

console.log(nl + '-- and the row says what arming costs --')
// On a line of its own, always on screen. Not in .pa-alarm-s: that line lives in the row
// whose height must not change as the alarm arms — it sits in a bottom-anchored sheet, so
// anything that grows moves every control above it mid-press (4eb60e1).
t('in English', cli.includes('While armed it holds the phone\u2019s audio, so other apps stay silent.'))
t('and in Spanish', cli.includes('retiene el audio del tel\u00e9fono'))
const stateLine = cli.slice(cli.indexOf('<div class="pa-alarm-s">'), cli.indexOf('</div>', cli.indexOf('<div class="pa-alarm-s">')))
t('on its own line, not in the one that changes with the state',
  cli.includes('<div class="pa-alarm-note">') && !/audio|holds the phone/.test(stateLine))
t('so that line still fits the two rows reserved for it', css.includes('.pa-alarm-s { min-height: 2.7em; }'))
t('and it is there armed or not', !/pa-alarm-note[^\n]*\$\{on /.test(cli))
t('styled', css.includes('.pa-alarm-note {'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
