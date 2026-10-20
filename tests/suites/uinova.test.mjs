// The new interface (src/uinova.css) — "lets make a new version that is toggable in the settings.
// i want to try a new look without losing the current one".
// The promise is that with it off NOTHING changes, so every rule must be scoped to html.ui-nova.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const css = fs.readFileSync('src/uinova.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const htm = fs.readFileSync('index.html', 'utf8')
const cli = fs.readFileSync('src/main.js', 'utf8')

// Every selector of every rule, split on commas outside parentheses.
const selectors = []
for (const m of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
  let depth = 0, cur = ''
  for (const ch of m[1]) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { selectors.push(cur.trim()); cur = '' } else cur += ch }
  if (cur.trim()) selectors.push(cur.trim())
}
t('the stylesheet has rules', selectors.length > 30, selectors.length)
const loose = selectors.filter(s => !s.startsWith('html.ui-nova'))
t('every rule is scoped to html.ui-nova — with it off, Classic is untouched', loose.length === 0, loose)

t('it is loaded with the app', cli.includes("import './uinova.css'"))
t('the class is set before first paint, from this device\'s choice', /localStorage\.getItem\('hliq_ui'\) === 'nova'\) document\.documentElement\.classList\.add\('ui-nova'\)/.test(htm))
t('Settings has the switch on desktop', htm.includes('id="uiVersionSeg"') && htm.includes("__onUiVersion('classic')") && htm.includes("__onUiVersion('nova')"))
t('and on the phone', cli.includes("window.__onUiVersion('nova');_mobVRenderContent()") && cli.includes("window.__onUiVersion('classic');_mobVRenderContent()"))
t('switching remembers the choice and flips the one class', /window\.__onUiVersion = function[\s\S]{0,300}classList\.toggle\('ui-nova', nova\)[\s\S]{0,120}localStorage\.setItem\('hliq_ui'/.test(cli))

// Colours are not its business: backdrops, wallpapers, light/dark and the accent carry over.
t('it never redefines a colour token', !/--(bg|panel|panel-2|panel-3|fg|fg-2|fg-3|accent|pos|neg)\s*:/.test(css))
// And nothing that was solid turns see-through: the only surfaces it clears are the page-sized
// containers, so the glow behind the page shows — never a card, a sheet or a menu.
const cleared = [...css.matchAll(/([^{}]+)\{[^{}]*background(-color)?\s*:\s*transparent[^{}]*\}/g)].map(m => m[1].trim())
t('only the page containers are made clear', cleared.length === 1 && /\.main, #mobileView/.test(cleared[0]), cleared)
t('and not over a wallpaper, which is its own picture', /html\.ui-nova:not\(\.has-bg-image\)/.test(css))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
