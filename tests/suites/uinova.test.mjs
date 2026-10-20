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
// The one exception: hiding the new look's OWN controls (menu button, scrim, quick actions —
// src/uinova.js) when it is off. It touches nothing of the classic UI.
const ownOnly = (s) => /^html:not\(\.ui-nova\) :is\((\.nova-[a-z-]+(, )?)+\)$/.test(s)
const loose = selectors.filter(s => !s.startsWith('html.ui-nova') && !ownOnly(s))
t('every rule is scoped to html.ui-nova — with it off, Classic is untouched', loose.length === 0, loose)

t('it is loaded with the app', cli.includes("import './uinova.css'"))
t('the class is set before first paint, from this device\'s choice', /localStorage\.getItem\('hliq_ui'\) === 'nova'\) document\.documentElement\.classList\.add\('ui-nova'\)/.test(htm))
t('Settings has the switch on desktop', htm.includes('id="uiVersionSeg"') && htm.includes("__onUiVersion('classic')") && htm.includes("__onUiVersion('nova')"))
t('and on the phone', cli.includes("window.__onUiVersion('nova');_mobVRenderContent()") && cli.includes("window.__onUiVersion('classic');_mobVRenderContent()"))
t('switching remembers the choice and flips the one class', /window\.__onUiVersion = function[\s\S]{0,300}classList\.toggle\('ui-nova', nova\)[\s\S]{0,120}localStorage\.setItem\('hliq_ui'/.test(cli))

// Its own palette — but only where nothing else owns the colours: dark, with no wallpaper. A photo
// keeps its translucent panels (src/theme.js), light mode keeps its own, and the accent hue and the
// profit/loss colours are never touched. (Reported after the first pass: "it barely changed".)
const colourRules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .filter(m => /--(bg|panel|panel-2|panel-3|fg|fg-2|fg-3|fg-4|rule|rule-soft|accent|accent-h|pos|neg)\s*:/.test(m[2])).map(m => m[1].trim())
t('colours are set only for dark without a wallpaper', colourRules.length === 1 && colourRules[0] === 'html.ui-nova:not(.has-bg-image) body:not(.light-mode)', colourRules)
t('and never the accent or the profit/loss colours', !/--(accent|accent-h|pos|neg)\s*:/.test(css))
// And nothing that was solid turns see-through: the only surfaces it clears are the page-sized
// containers, so the glow behind the page shows — never a card, a sheet or a menu.
const cleared = [...css.matchAll(/([^{}]+)\{[^{}]*background(-color)?\s*:\s*transparent[^{}]*\}/g)].map(m => m[1].trim())
// The page containers (for the glow); the stat strip's container, whose tiles are each solid now
// (it used to be one surface whose colour drew the dividers); and the topbar and status bar,
// which are rows of the layout grid, not overlays — nothing scrolls underneath them.
const allowed = [/\.main, #mobileView/, /^html\.ui-nova \.ov-stat-strip$/, /^html\.ui-nova \.topbar$/, /^html\.ui-nova \.statusbar$/]
t('only the page containers, the stat strip and the two bars are made clear — never a card, sheet or menu',
  cleared.length === allowed.length && cleared.every(c => allowed.some(re => re.test(c))), cleared)
t('and not over a wallpaper, which is its own picture', /html\.ui-nova:not\(\.has-bg-image\)/.test(css))

// The Focus layout (chosen: "no sidebar, menu button instead, one centered column").
const js = fs.readFileSync('src/uinova.js', 'utf8')
t('Focus: desktop only, no sidebar column, the sidebar slides in from a menu button', /@media \(min-width: 881px\)/.test(css) && /grid-template-areas: "topbar" "main" "statusbar"/.test(css) && /nova-nav-open \.sidebar \{ transform: none; \}/.test(css))
t('the sidebar panel is solid, as every menu here is', /\.sidebar \{[^}]*background-color: var\(--panel-3-o, var\(--panel-3\)\)/.test(css))
t('the quick actions are the app\'s own handlers', ['mobVDeposit', 'mobVWithdraw', 'mobVSend', '__ovGoTrade'].every(f => js.includes(`'${f}'`)))
t('they are re-added when the overview is redrawn, watching only the overview', js.includes("doc.getElementById('overviewStats')") && js.includes('new MutationObserver(place).observe(host'))
t('main.js starts it', cli.includes('installNovaChrome()') && cli.includes("from './uinova.js'"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
