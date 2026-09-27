// Keeping your place across the two shells — src/shelltab.js.
//
// Reported as: "lets make the app that when in mobile mode and its changed to desktop it
// should preserve and display the same tab… its annoying changing modes and encountering
// home." The app is two shells over one state, each with its own idea of which screen is
// showing, so a switch landed on whichever one that shell had been left on — Home, in
// practice, because the other shell had been driving.
import fs from 'fs'
import { toDesktop, toMobile, TO_DESKTOP, TO_MOBILE, MOB_VIEWS, DESK_DEFAULT, MOB_DEFAULT } from '../../src/shelltab.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

// Answered from index.html itself, the way the DOM answers at runtime: which tabs the
// desktop nav offers, and which panels merely exist. They are not the same set — two panels
// have no way in at all — and that difference is the bug this suite exists for.
const html = fs.readFileSync('index.html', 'utf8')
const PANEL = new Set([...html.matchAll(/id="tab-([a-z0-9-]+)"/g)].map(m => m[1]))
const NAV   = new Set([...html.matchAll(/switchTab\('([a-z0-9]+)'/g)].map(m => m[1]))
const DESK_OPTS = { hasNav: n => NAV.has(n), hasPanel: n => PANEL.has(n) }
const mobHas  = n => MOB_VIEWS.has(n)

console.log(nl + '-- a name both shells know passes straight through --')
{
  // Most screens are called the same thing on both sides, and that is the common case.
  const shared = ['calendar', 'trades', 'transfers', 'settings', 'leaderboard', 'portfolio',
                  'watch', 'strategies', 'performance', 'trade', 'pulse', 'outcomes']
  t('every shared screen survives the trip out', shared.every(n => toDesktop(n, DESK_OPTS) === n),
    shared.filter(n => toDesktop(n, DESK_OPTS) !== n))
  t('and the trip back', shared.every(n => toMobile(n, mobHas) === n),
    shared.filter(n => toMobile(n, mobHas) !== n))
  t('which is most of them — the map is for the ones that differ',
    Object.keys(TO_DESKTOP).length + Object.keys(TO_MOBILE).length <= shared.length)
}

console.log(nl + '-- and where one shell splits what the other keeps whole --')
{
  // Desktop opens on an Overview the phone does not have; the phone's home screen is the
  // positions list.
  t('desktop Overview becomes the phone home screen', toMobile('overview', mobHas) === 'positions')
  // And back the same way. Reported: "when in mobile home when changing to desktop it
  // displays Open orders? which is not even a tab by its own" — index.html's tab-positions
  // panel is exactly that: an Open Orders panel with no nav button and nothing that opens it.
  t('and the phone home screen becomes the Overview again', toDesktop('positions', DESK_OPTS) === 'overview')
  t('not the orphan panel that shares its name', PANEL.has('positions') && !NAV.has('positions'))
  t('the phone Orders screen goes where desktop keeps orders — the Trade tab tables',
    toDesktop('orders', DESK_OPTS) === 'trade')
  t('its Spot screen too, since that desktop panel is the other orphan',
    toDesktop('spot', DESK_OPTS) === 'overview' && PANEL.has('spot') && !NAV.has('spot'))
  t('its Heatmap is a segment of desktop Allocation', toDesktop('heatmap', DESK_OPTS) === 'allocation')
  t('and What-moved is a panel of desktop Portfolio', toDesktop('attribution', DESK_OPTS) === 'portfolio')
  // All Accounts has no nav button either, but switchTab knows it, so it is named in the map
  // rather than being refused as an orphan.
  t('All Accounts is still reachable', toDesktop('accounts', DESK_OPTS) === 'accounts')
}

console.log(nl + '-- rather than switching to a screen that is not there --')
{
  t('an unknown name lands on the desktop default', toDesktop('nonsense', DESK_OPTS) === DESK_DEFAULT)
  t('and on the phone default', toMobile('nonsense', mobHas) === MOB_DEFAULT)
  t('nothing at all is the same', toDesktop(null, DESK_OPTS) === DESK_DEFAULT && toMobile(undefined, mobHas) === MOB_DEFAULT)
  // A tab dropped from the nav must not be switched to: the mapping degrades instead.
  t('a tab that left the nav degrades to the default',
    toDesktop('calendar', { hasNav: n => NAV.has(n) && n !== 'calendar', hasPanel: n => PANEL.has(n) }) === DESK_DEFAULT)
  t('and a mapped one degrades too',
    toDesktop('heatmap', { hasNav: n => NAV.has(n), hasPanel: n => PANEL.has(n) && n !== 'allocation' }) === DESK_DEFAULT)
  // The phone's Heatmap has no desktop panel of its own, so it only ever arrives by the map.
  t('a phone-only screen has no panel to land on directly', !PANEL.has('heatmap') && !PANEL.has('orders'))
  // Every destination in the map has to be a place the app can actually open — a nav button
  // in index.html, or a switchTab call somewhere in the code (which is how Allocation, All
  // Accounts and the simulator are reached). tab-positions and tab-spot have neither.
  const cliSrc = fs.readFileSync('src/main.js', 'utf8')
  const OPENED = new Set([
    ...NAV,
    ...[...cliSrc.matchAll(/switchTab\('([a-z0-9]+)'/g)].map(m => m[1]),
    // switchTab's own body names the tabs it knows how to bring to life — Accounts renders
    // the multi-account grid there and is reached from the wallet panel, not from the nav.
    ...[...cliSrc.matchAll(/if \(name === '([a-z0-9]+)'\)/g)].map(m => m[1]),
  ])
  t('nothing in the map points at an orphan',
    Object.values(TO_DESKTOP).every(n => OPENED.has(n)),
    Object.values(TO_DESKTOP).filter(n => !OPENED.has(n)))
  t('and the two orphans are still orphans', !OPENED.has('positions') && !OPENED.has('spot'))
  // Every destination the map names has to exist, or the map is the thing that breaks.
  t('every desktop the map points at is a real panel',
    Object.values(TO_DESKTOP).every(n => PANEL.has(n)), Object.values(TO_DESKTOP).filter(n => !PANEL.has(n)))
  t('every phone screen the map points at is a real one',
    Object.values(TO_MOBILE).every(mobHas), Object.values(TO_MOBILE).filter(n => !mobHas(n)))
  t('and so are the two defaults', NAV.has(DESK_DEFAULT) && mobHas(MOB_DEFAULT))
}

console.log(nl + '-- wired into both triggers, both ways --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8')
  t('going to the phone carries the desktop tab',
    /_mobVActiveTab = _shellToMob\(_activeTab, n => _MOB_VIEWS\.has\(n\)\)/.test(cli))
  t('and going to desktop carries the phone screen', /const want = _shellToDesk\(_mobVActiveTab, \{/.test(cli))
  // The nav is what says a tab is a place you can be sent to.
  t('asking the nav what counts as a destination', /hasNav:   n => !!document\.querySelector\(/.test(cli))
  t('the Settings switch uses both', /if \(checked\) _goMobileShell\(\)\s*\n\s*else\s+_goDesktopShell\(\)/.test(cli))
  // Turning the phone is the other way in, and it used to be the one that lost your place.
  t('so does turning the phone', /if \(e\.matches\) _goDesktopShell\(\{ settled: false \}\)\s*\n\s*else\s+_goMobileShell\(\)/.test(cli))
  // But a rotation does NOT reveal the tab in the rotation's own frame. Doing that left an
  // iPhone laid out at its old width and scaled up to fill the new one — too big to use, and
  // unrecoverable in an installed app, which honours user-scalable=no. _goDesktopShell has
  // the mechanism written out.
  t('and a rotation waits for the rotation to finish',
    /if \(settled\) reveal\(\)\s*\n\s*else requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => setTimeout\(reveal, 350\)\)\)/.test(cli))
  t('with the heavy part — the tab render — the only thing deferred',
    /mobVHide\(\)\s*\n\s*renderAll\(\)/.test(cli))
  t('and it gives up if the phone shell came back while it waited',
    /if \(document\.body\.classList\.contains\('is-mob-view'\)\) return/.test(cli))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
