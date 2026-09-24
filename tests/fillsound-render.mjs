/**
 * What the fill sounds actually sound like, measured.
 *
 * Run by hand, not from tests/browser.mjs: it needs the DEV server, because it imports
 * src/fillsound.js as a module (a built bundle has no /src to import from), and a level is a
 * judgement call rather than a pass/fail.
 *
 *   npm run dev &
 *   node tests/fillsound-render.mjs
 *
 * Each sound is rendered through an OfflineAudioContext — the real synthesis, no audio device
 * involved — and reported as peak / RMS / length. This is how the first set was found to be
 * uneven: the bell peaked at 0.39 and the blip at 0.15, so choosing "quiet" as your sound also
 * meant choosing "might not notice it". Peaks now sit between 0.21 and 0.39, and a peak at or
 * near 1.0 would mean the sound is clipping.
 */
import { chromium } from 'playwright'

const PORT = (process.argv.find(a => a.startsWith('--port=')) ?? '').split('=')[1] || '5175'
const browser = await chromium.launch()
const page = await (await browser.newContext()).newPage()
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded' })

const rows = await page.evaluate(async () => {
  const m = await import('/src/fillsound.js')
  const out = []
  for (const k of Object.keys(m.SOUNDS)) {
    if (k === 'off') continue
    const off = new OfflineAudioContext(1, 44100 * 3, 44100)
    const real = window.AudioContext
    window.AudioContext = function () { return off }
    // The module holds on to the first context it makes, so each sound gets a fresh copy of it.
    const mod = await import('/src/fillsound.js?render=' + k)
    mod.play(k, 1)
    window.AudioContext = real
    const d = (await off.startRendering()).getChannelData(0)
    let peak = 0, sq = 0, last = 0
    for (let i = 0; i < d.length; i++) {
      const a = Math.abs(d[i])
      if (a > peak) peak = a
      sq += d[i] * d[i]
      if (a > 0.001) last = i
    }
    out.push([k, m.SOUNDS[k].label, +peak.toFixed(3), +Math.sqrt(sq / d.length).toFixed(4), +(last / 44100).toFixed(2)])
  }
  return out
})
await browser.close()

console.log('\nname      label           peak    rms     seconds')
for (const r of rows) console.log(r[0].padEnd(10) + String(r[1]).padEnd(16) + String(r[2]).padEnd(8) + String(r[3]).padEnd(8) + r[4])

const silent  = rows.filter(r => r[2] < 0.05).map(r => r[0])
const clipped = rows.filter(r => r[2] > 0.95).map(r => r[0])
if (silent.length)  console.log('\nall but silent: ' + silent.join(', '))
if (clipped.length) console.log('\nclipping: ' + clipped.join(', '))
process.exit(silent.length || clipped.length ? 1 : 0)
