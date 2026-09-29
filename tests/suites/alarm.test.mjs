// The wake alarm, driven for real against a stub audio element.
import fs from 'fs'
import { encodeWav, silenceSamples, alarmSamples, alarmRate, rampSamples, createAlarm, ALARM_SOUNDS, DEFAULT_ALARM }
  from '../../src/alarm.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const sw  = fs.readFileSync('public/sw.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const nl = String.fromCharCode(10)

// Node has no Blob URL; the module only needs these two to exist.
globalThis.URL.createObjectURL ??= (b) => 'blob:stub/' + (b?.size ?? 0)

// ── WAV encoding ─────────────────────────────────────────────────────────────
const wav = encodeWav(alarmSamples())
t('the alarm encodes to a real WAV blob', wav.size > 1000 && wav.type === 'audio/wav')
const head = Buffer.from(await encodeWav(new Float32Array(8)).arrayBuffer())
t('it carries a RIFF/WAVE header', head.slice(0, 4).toString() === 'RIFF' && head.slice(8, 12).toString() === 'WAVE')
t('mono 16-bit', head.readUInt16LE(22) === 1 && head.readUInt16LE(34) === 16)
t('the data length matches the sample count', head.readUInt32LE(40) === 16)

const sil = silenceSamples(1)
t('the keep-alive track is inaudible', Math.max(...sil.map(Math.abs)) < 0.001)
// True digital silence gets some platforms to reclaim the media session, which is the one
// thing this design depends on.
t('but is NOT digital silence', sil.some(v => v !== 0))

const al = alarmSamples()
t('the alarm is loud', Math.max(...al.map(Math.abs)) > 0.8)
t('it pulses rather than droning', al.some(v => Math.abs(v) < 0.01) && al.some(v => Math.abs(v) > 0.8))
t('and it clips nothing', Math.max(...al.map(Math.abs)) <= 1)

// ── controller ───────────────────────────────────────────────────────────────
const mkStub = (refuse = false) => {
  const el = {
    src: '', loop: false, volume: 0, plays: 0, paused: false,
    play() { if (refuse) return Promise.reject(new Error('NotAllowedError')); el.plays++; return Promise.resolve() },
    pause() { el.paused = true },
  }
  return el
}
let buzzes = []
const mk = (refuse) => { const el = mkStub(refuse); return { el, alarm: createAlarm({ makeAudio: () => el, vibrate: (p) => buzzes.push(p) }) } }

let { el, alarm } = mk()
t('starts disarmed', !alarm.isArmed() && !alarm.isRinging())
t('firing before arming fails rather than pretending', alarm.fire() === false)

t('arming succeeds', await alarm.arm() === true)
t('and starts playing', el.plays === 1 && el.loop === true)
t('at an inaudible but non-zero volume', el.volume > 0 && el.volume < 0.1)

const quietSrc = el.src
buzzes = []
t('fire() rings', alarm.fire() === true)
t('it swaps to the alarm track', el.src !== quietSrc)
t('at full volume', el.volume === 1)
// It swells first -- a phone alarm's crescendo, baked into the samples because iOS ignores a
// page setting an element's volume -- and then loops at full for as long as it takes.
const rampSrc = el.src
t('it swells first, then hands over', el.loop === false && typeof el.onended === 'function')
el.onended()
t('looping at full after the swell, so it does not stop', el.loop === true && el.src !== rampSrc && el.src !== quietSrc)
t('and vibrates', buzzes.length > 0)

const before = el.plays
t('a second trigger does not restart it', alarm.fire() === true && el.plays === before)

alarm.stop()
t('stop silences it', !alarm.isRinging())
t('but stays armed — one alert must not disarm the night', alarm.isArmed() === true)
t('and goes back to the quiet track', el.src === quietSrc && el.volume < 0.1)
t('a later alert can still ring', alarm.fire() === true && alarm.isRinging())

alarm.disarm()
t('disarm stops and unarms', !alarm.isArmed() && !alarm.isRinging())
t('and pauses the element, so nothing keeps playing', el.paused === true)

// The autoplay policy refusing is the failure that matters — it must be visible.
;({ el, alarm } = mk(true))
t('a refused play reports failure', await alarm.arm() === false)
t('and does not claim to be armed', alarm.isArmed() === false)

// ── wiring ───────────────────────────────────────────────────────────────────
t('arming happens inside the click handler, as the autoplay policy requires',
  /window\.__alarmToggle = async function\(on\)[\s\S]{0,600}await _alarm\.arm\(\)/.test(cli))
t('a refusal is surfaced to the user rather than silently ignored',
  cli.includes('would not let the alarm start its audio'))
t('a local price alert rings it', cli.includes('_alarmOnPriceAlert()'))
t('so does a pushed one, via the service worker',
  cli.includes("e.data?.type === 'price-alert'") && sw.includes("type: 'price-alert'"))
t('the worker only wakes the page for PRICE alerts, not every push',
  sw.includes("String(data.tag || '').startsWith('hliq-price-')"))
t('a price notification stays on screen until acknowledged',
  sw.includes('requireInteraction: String(data.tag'))
t('the worker still shows its notification as well as waking the page',
  sw.includes('showNotification') && sw.includes('Promise.all'))
t('the service worker cache was bumped, or the old worker would linger',
  sw.includes("hliq-v2-assets-v13"))
t('ringing takes over the whole screen', cli.includes('alarm-ov') && css.includes('.alarm-ov {'))
t('the armed state survives a reload being recorded', cli.includes("localStorage.setItem(_ALARM_KEY, '1')"))
t('there is a way to hear it before trusting it', cli.includes('window.__alarmTest'))

// "add more and better wake alarm sounds" — one sound is not a choice, and the right alarm
// is the one that wakes YOU: a warble a light sleeper hears is not what gets someone out of
// deep sleep, and a klaxon at 3am in a shared bed is a different problem.
console.log(nl + '-- five of them, all built to wake someone --')
{
  const names = Object.keys(ALARM_SOUNDS)
  t('there are several to choose from', names.length >= 5, names)
  t('each has a label', Object.values(ALARM_SOUNDS).every(v => v.label && typeof v.build === 'function'))
  t('the default is one of them', !!ALARM_SOUNDS[DEFAULT_ALARM])
  for (const k of names) {
    const smp = alarmSamples(k)
    let peak = 0, sum = 0
    for (const v of smp) { const a = Math.abs(v); if (a > peak) peak = a; sum += v * v }
    const rms = Math.sqrt(sum / smp.length)
    // Loud: an alarm at conversation level is not an alarm. And a whole number of seconds,
    // because the element loops it and a seam mid-beep reads as a fault.
    t(`${k} is loud`, peak > 0.85, peak)
    t(`${k} is not just a click`, rms > 0.1, rms)
    // At its own rate: the ringtones are built at 22kHz, a beep never needed more than 8.
    t(`${k} loops cleanly`, Math.abs(smp.length % alarmRate(k)) === 0, smp.length)
  }
  // An unknown name must not fall back to silence — the one place in the app where nothing
  // is the worst possible answer.
  t('an unknown sound is the default, never silence', alarmSamples('nonsense').length === alarmSamples(DEFAULT_ALARM).length)
  t('and the old call shape still works', alarmSamples(8000).length % 8000 === 0 && alarmSamples(8000).length > 0)
  // Asked for: "is the wake up alarm a ring tone?? if not make it like one".
  t('the default is a ringtone, not a test tone', DEFAULT_ALARM === 'ringtone' && ALARM_SOUNDS.ringtone.rate >= 22050)
  t('there is a classic phone ring too', !!ALARM_SOUNDS.classic)
  const ramp = rampSamples(DEFAULT_ALARM)
  const peakOf = (a) => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  const tenth = Math.floor(ramp.length / 10)
  t('the swell starts softer than it ends', peakOf(ramp.slice(0, tenth)) < peakOf(ramp.slice(-tenth)) * 0.6,
    [peakOf(ramp.slice(0, tenth)), peakOf(ramp.slice(-tenth))])
  t('and lasts several seconds', ramp.length / alarmRate(DEFAULT_ALARM) >= 6)
}

console.log(nl + '-- choosing one --')
{
  const el = mkStub()
  const a  = createAlarm({ makeAudio: () => el, vibrate: () => {} })
  t('it starts on the default', a.sound() === DEFAULT_ALARM)
  t('and takes another', a.setSound('klaxon') === 'klaxon' && a.sound() === 'klaxon')
  t('but refuses one that does not exist', a.setSound('nope') === 'klaxon')
  // Hearing one must not require arming first: that was the old Test button's problem.
  t('a preview plays without arming', a.preview('siren') === true && !a.isArmed())
  t('and does not leave the alarm ringing', !a.isRinging())
}

// Asked for as if it were new — "can we also have like loud alarms for price targets... i may
// be sleeping" — because the control lived in desktop Settings only. It is on the phone now:
// in its Settings, and in the sheet where an alert is actually set.
const alarmSrc = fs.readFileSync('src/alarm.js', 'utf8')
t('the phone can arm it too', (cli.match(/data-wake-alarm/g) ?? []).length >= 2)
t('including from the sheet that sets the alert', /data-wake-alarm style="margin-top:14px"/.test(cli))
t('one renderer fills every host', /querySelectorAll\('#wakeAlarmRow, \[data-wake-alarm\]'\)/.test(cli))
// The notification needs permission. The alarm is audio the page is already playing, and it
// is the half that wakes someone: it used to be skipped along with the notification.
t('a declined notification no longer silences the alarm',
  /const canNotify = notifPermission\(\) === 'granted'/.test(cli) && /if \(canNotify\) showNotif\(/.test(cli))
// Arming needs a gesture, so a reload cannot restore it by itself — but it must not pretend
// the alarm is still set either.
t('an alarm dropped by a reload is re-armed by the next tap',
  /function _alarmRestore\(\)/.test(cli) && /window\.addEventListener\('pointerdown', rearm, \{ once: true \}\)/.test(cli))
t('and says so until it is', /tap anywhere to arm it again/.test(cli))
// play() returns a promise, so `try { el.play() } catch {}` caught nothing: swapping the
// source while one is in flight rejects, which is exactly what stopping the alarm does.
t('the play is caught as a promise', /e\.play\(\)\?\.catch\(\(\) => \{\}\)/.test(alarmSrc))
// Comments stripped: the doc comment above the helper quotes the old line it replaced.
t('and nothing calls play bare any more',
  !/try \{ el\.play\(\) \} catch/.test(alarmSrc.replace(/\/\*[\s\S]*?\*\//g, '')))
t('while arming still awaits it, which is where a refusal must be caught',
  /await el\.play\(\)/.test(alarmSrc))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
