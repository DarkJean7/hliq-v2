// Nothing asks with the browser's own box any more, and a fill can make a sound.
//
// Reported with a screenshot of "insolvent.trade says — Close all 4 open positions at market
// price?": the native alert/confirm/prompt are grey system boxes with the domain in them, they
// block the page, and on a phone they read as the site demanding something. The app already
// had themed confirm and prompt sheets; the alert was missing and most call sites had never
// been converted.
//
// And: "add a new feature in the settings that would let the user set sound for when an order
// gets filled" — src/fillsound.js.
import fs from 'fs'
import { SOUNDS, DEFAULT_SOUND, soundName, volume, setSound, setVolume, isOn } from '../../src/fillsound.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }

const FILES = ['src/main.js', 'src/game.js', 'src/onboard.js', 'src/calnotes.js', 'src/offexui.js', 'src/render.js']

console.log(nl + '-- no native dialogs are left --')
{
  // Not preceded by a dot or word character, so `window.__appAlert` and the word "alert" in
  // "price alert" do not count. The only survivors allowed are the app's own helpers.
  const native = /(^|[^.\w])(alert|confirm|prompt)\s*\(/
  for (const f of FILES) {
    const bad = fs.readFileSync(f, 'utf8').split('\n')
      .map((l, i) => [i + 1, l])
      .filter(([, l]) => native.test(l) && !/_app(Alert|Confirm|Prompt)|__app(Alert|Confirm|Prompt)|\/\/|\*/.test(l))
    t(f + ' asks through the app, not the browser', bad.length === 0, bad.slice(0, 3))
  }
}

console.log(nl + '-- the three sheets exist and match each other --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8')
  t('there is an app alert now', /function _appAlert\(msg, opts = \{\}\)/.test(cli))
  t('it is a sheet like the other two, not a box',
    (cli.match(/border-radius:20px 20px 0 0/g) ?? []).length >= 3)
  t('the first line becomes the heading, as the old messages were written',
    /const title = opts\.title \?\? \(lines\[0\] \|\| 'Notice'\)/.test(cli))
  t('its text is escaped, since these carry error strings', /\$\{esc\(body\)\}/.test(cli))
  t('and it is reachable from the other modules', /window\.__appAlert = _appAlert/.test(cli))
  // A confirm that is awaited needs its caller to be async; the ones that were not, now are.
  for (const fn of ['window.__panelRemove = async function', 'window.__removeWallet = async function',
                    'window.__maRemove = async function', 'window.__paperResetAcct = async function',
                    'window.__paperAcctDelete = async function', 'window._mobVEditTpSl = async function',
                    'window.__exportSettings = async function']) {
    t(fn.split(' ')[0].replace('window.', '') + ' awaits its answer', cli.includes(fn))
  }
  t('the dangerous ones are marked as such', (cli.match(/danger: true/g) ?? []).length >= 7)
}

console.log(nl + '-- the fill sound --')
{
  t('off by default — no session starts making noise', DEFAULT_SOUND === 'off' && soundName(mem()) === 'off')
  t('off really is silent', SOUNDS.off.layers.length === 0 && !isOn(mem()))
  t('there are sounds to choose from', Object.keys(SOUNDS).length >= 5)
  // A sound is layers now, not a line of beeps: a bell's inharmonic partials and a noise
  // transient for the strike are what make it a bell rather than a tone.
  t('each is a label, an icon and some layers',
    Object.values(SOUNDS).every(s => s.label && s.icon && Array.isArray(s.layers)))
  t('and they are about trading, not a phone keypad',
    ['bell', 'register', 'ticker', 'gavel'].every(k => SOUNDS[k]))

  const st = mem()
  t('a choice is remembered', setSound('bell', st) === 'bell' && soundName(st) === 'bell' && isOn(st))
  // The first set was chime/ding/blip/coin/deep. Anyone who had picked one keeps a sound
  // instead of being silently switched off the day the names changed.
  t('a sound chosen under the old names still plays',
    setSound('chime', st) === 'bell' && setSound('coin', st) === 'register' && setSound('deep', st) === 'gavel')
  t('an unknown name reads as off rather than throwing later', setSound('../evil', st) === 'off' && soundName(st) === 'off')
  t('volume is kept in range', setVolume(2, st) === 1 && setVolume(-1, st) === 0 && setVolume(0.4, st) === 0.4)
  t('and has a sensible default', volume(mem()) === 0.6)
  t('a broken store does not take the app down', soundName(null) === 'off' && volume(null) === 0.6)
}

console.log(nl + '-- wired to the fills, and to Settings --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8')
  const snd = fs.readFileSync('src/fillsound.js', 'utf8')
  const html = fs.readFileSync('index.html', 'utf8')
  t('it plays where a NEW fill is detected', /if \(_fresh\.length && state\.fillsFull !== false\) \{ try \{ _playFillSound/.test(cli))
  t('one sound for the batch, not one per piece of a filled order', /playFill\(count = 1\)/.test(snd))
  t('the sounds are made, not downloaded', /createOscillator\(\)/.test(snd) && !/[.](mp3|wav|ogg)[^a-z]/.test(snd))
  t('audio is unlocked by the first gesture, or the first fill would be silent',
    /window\.addEventListener\('pointerdown', _unlockOnce/.test(cli) && /export function unlock\(\)/.test(snd))
  t('choosing a sound plays it', /if \(v !== 'off'\) _playSound\(v\)/.test(cli))
  t('Test says something when nothing is chosen', /Pick a sound first/.test(cli))
  t('the desktop row is there', /id="fillSoundBox"/.test(html))
  t('and is filled in from the stored setting', /_syncFillSoundUI\(\)/.test(cli))
  t('the mobile row is there too', /Sound on fill/.test(cli))
  // One builder for both shells — the rule about a renderer's second copy applies to a
  // settings control as much as to a position row.
  t('both shells render the same picker', /export function pickerHtml/.test(snd) &&
    (cli.match(/_fillPickerHtml\(/g) ?? []).length >= 2)
  // Nothing in either shell builds <option>s any more — the picker emits buttons. (The words
  // "<select>" do appear in fillsound.js, in the comment explaining what it replaced.)
  t('and it is pills, not a browser dropdown', /class="snd-pill/.test(snd) &&
    !/<option/.test(snd) && !/__setFillSound\(this\.value\)/.test(cli + html) &&
    !/id="fillSoundSel"/.test(html))
  t('the picker carries no ids, since both shells are in the DOM at once', !/ id="/.test(snd))
  t('a pill selects and previews in one tap', /onclick="window\.__setFillSound\('\$\{k\}'\)"/.test(snd))
  t('nothing plays unless a sound was chosen', /if \(!\(count > 0\) \|\| !isOn\(\)\) return false/.test(snd))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
