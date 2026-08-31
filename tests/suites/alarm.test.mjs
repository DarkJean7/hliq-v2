// The wake alarm, driven for real against a stub audio element.
import fs from 'fs'
import { encodeWav, silenceSamples, alarmSamples, createAlarm }
  from 'file:///C:/Users/jeank/OneDrive/Desktop/hliq-v2/src/alarm.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const sw  = fs.readFileSync('public/sw.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

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
t('looping, so it does not stop after one second', el.loop === true)
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

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
