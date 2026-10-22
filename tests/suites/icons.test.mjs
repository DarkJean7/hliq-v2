// The app icon is the full >insolvent. wordmark (tests/make-icons.mjs). Asked: "lets change the app
// icon, like the mobile home icon from just "in" to the full word "insolvent". just as similar as
// the "discover" credit card icon where they just display the full name".
import fs from 'fs'
import { ICONS } from '../make-icons.mjs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const pngSize = (f) => { const b = fs.readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)] }

const wrong = ICONS.filter(([f, s]) => !fs.existsSync('public/' + f) || pngSize('public/' + f).join() !== `${s},${s}`).map(([f]) => f)
t('every icon exists at the size it says', wrong.length === 0, wrong)

const m = JSON.parse(fs.readFileSync('public/manifest.json', 'utf8'))
const mask = m.icons.find(i => i.purpose === 'maskable')
// Android crops a maskable icon to a circle or squircle; the regular one would lose its ends.
t('the maskable icon is its own file, with the word inside the safe circle', mask?.src.startsWith('/pwa-maskable-512.png') && ICONS.find(i => i[0] === 'pwa-maskable-512.png')[3] <= 0.7, mask)
t('and the regular ones are not marked maskable', m.icons.filter(i => i.src.startsWith('/pwa-512x512.png')).every(i => !i.purpose))

// One version everywhere, so no page keeps showing the old icon from cache.
const pages = ['index.html', 'landing.html', 'markets.html', 'portfolio.html', 'src/main.js']
const vers = new Set()
for (const f of [...pages, 'public/manifest.json']) for (const x of fs.readFileSync(f, 'utf8').matchAll(/(?:apple-touch-icon|pwa-[\w-]+|favicon)\.png\?v=(\d+)/g)) vers.add(x[1])
t('every page and the manifest ask for the same icon version', vers.size === 1, [...vers])

// The loading page showed the icon above the wordmark; with the icon now the word, that read twice.
const html = fs.readFileSync('index.html', 'utf8')
t('the loader shows the wordmark once, not the icon above it too', !html.includes('class="il-icon"') && html.includes('class="il-word'))
t('and the launch-screen script waits for the wordmark', fs.readFileSync('tests/make-splash.mjs', 'utf8').includes("waitForSelector('#init-loader .il-word')"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
