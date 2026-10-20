// Cold start on a phone — reported: "it shows the typical black screen, then a blank white, then
// the app". The launch screen (iOS: apple-touch-startup-image, one per screen size; Android: the
// manifest's background), the blank canvas before the page paints, the page's own loader and the
// app must all be the same dark, so a cold start reads as one screen.
import fs from 'fs'
import { SPLASH, BG } from '../make-splash.mjs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const htm = fs.readFileSync('index.html', 'utf8')
const manifest = JSON.parse(fs.readFileSync('public/manifest.json', 'utf8'))

const missing = SPLASH.filter(([w, h]) => !fs.existsSync(`public/splash/${w}x${h}.png`)).map(([w, h]) => `${w}x${h}`)
t('every iPhone size has its launch image', missing.length === 0, missing)
const untagged = SPLASH.filter(([w, h, dw, dh, r]) => !htm.includes(`media="(device-width: ${dw}px) and (device-height: ${dh}px) and (-webkit-device-pixel-ratio: ${r}) and (orientation: portrait)" href="/splash/${w}x${h}.png"`)).map(([w, h]) => `${w}x${h}`)
t('and the page names each one for its screen', untagged.length === 0, untagged)
t('the 402×874 iPhone (16 Pro) is covered', SPLASH.some(([, , dw, dh]) => dw === 402 && dh === 874))
t('the blank canvas before the page paints is dark, not white', htm.includes('<meta name="color-scheme" content="dark"/>'))
t('the page, its loader and the launch images share one background', htm.includes(`html,body{background:${BG}`) && htm.includes(`#init-loader{\n      position:fixed;inset:0;background:${BG}`.replace(/\n/g, htm.includes('\r\n') ? '\r\n' : '\n')))
t('and so does Android\'s launch screen (the manifest)', manifest.background_color === BG && manifest.theme_color === BG, [manifest.background_color, manifest.theme_color])

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
