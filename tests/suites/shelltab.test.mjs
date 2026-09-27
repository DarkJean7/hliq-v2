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

// The desktop panels that exist, as the DOM would answer.
const html = fs.readFileSync('index.html', 'utf8')
const DESK = new Set([...html.matchAll(/id="tab-([a-z0-9-]+)"/g)].map(m => m[1]))
const deskHas = n => DESK.has(n)
const mobHas  = n => MOB_VIEWS.has(n)

console.log(nl + '-- a name both shells know passes straight through --')
{
  // Most screens are called the same thing on both sides, and that is the common case.
  const shared = ['calendar', 'trades', 'transfers', 'settings', 'leaderboard', 'portfolio',
                  'watch', 'strategies', 'performance', 'trade', 'pulse', 'allocation',
                  'simulator', 'tokens', 'outcomes', 'spot', 'accounts', 'positions']
  t('every shared screen survives the trip out', shared.every(n => toDesktop(n, deskHas) === n),
    shared.filter(n => toDesktop(n, deskHas) !== n))
  t('and the trip back', shared.every(n => toMobile(n, mobHas) === n),
    shared.filter(n => toMobile(n, mobHas) !== n))
  t('which is most of them — the map is for the few that differ',
    Object.keys(TO_DESKTOP).length + Object.keys(TO_MOBILE).length < shared.length)
}

console.log(nl + '-- and where one shell splits what the other keeps whole --')
{
  // Desktop opens on an Overview the phone does not have; the phone's home screen is the
  // positions list.
  t('desktop Overview becomes the phone home screen', toMobile('overview', mobHas) === 'positions')
  // Not the reverse: a phone on Positions means positions, and desktop has that tab.
  t('but Positions stays Positions coming back', toDesktop('positions', deskHas) === 'positions')
  t('the phone\'s own Orders screen is a table under desktop Positions', toDesktop('orders', deskHas) === 'positions')
  t('its Heatmap is a segment of desktop Allocation', toDesktop('heatmap', deskHas) === 'allocation')
  t('and What-moved is a panel of desktop Portfolio', toDesktop('attribution', deskHas) === 'portfolio')
}

console.log(nl + '-- rather than switching to a screen that is not there --')
{
  t('an unknown name lands on the desktop default', toDesktop('nonsense', deskHas) === DESK_DEFAULT)
  t('and on the phone default', toMobile('nonsense', mobHas) === MOB_DEFAULT)
  t('nothing at all is the same', toDesktop(null, deskHas) === DESK_DEFAULT && toMobile(undefined, mobHas) === MOB_DEFAULT)
  // A tab removed from index.html must not be switched to: the mapping degrades instead.
  t('a tab whose panel is gone degrades to the default', toDesktop('calendar', n => n !== 'calendar') === DESK_DEFAULT)
  t('and a mapped one degrades too', toDesktop('heatmap', n => deskHas(n) && n !== 'allocation') === DESK_DEFAULT)
  // The phone's Heatmap has no desktop panel of its own, so it only ever arrives by the map.
  t('a phone-only screen has no panel to land on directly', !deskHas('heatmap') && !deskHas('orders'))
  // Every destination the map names has to exist, or the map is the thing that breaks.
  t('every desktop the map points at is a real panel',
    Object.values(TO_DESKTOP).every(deskHas), Object.values(TO_DESKTOP).filter(n => !deskHas(n)))
  t('every phone screen the map points at is a real one',
    Object.values(TO_MOBILE).every(mobHas), Object.values(TO_MOBILE).filter(n => !mobHas(n)))
  t('and so are the two defaults', deskHas(DESK_DEFAULT) && mobHas(MOB_DEFAULT))
}

console.log(nl + '-- wired into both triggers, both ways --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8')
  t('going to the phone carries the desktop tab',
    /_mobVActiveTab = _shellToMob\(_activeTab, n => _MOB_VIEWS\.has\(n\)\)/.test(cli))
  t('and going to desktop carries the phone screen',
    /const want = _shellToDesk\(_mobVActiveTab, n => !!document\.getElementById\('tab-' \+ n\)\)/.test(cli))
  t('the Settings switch uses both', /if \(checked\) _goMobileShell\(\)\s*\n\s*else\s+_goDesktopShell\(\)/.test(cli))
  // Turning the phone is the other way in, and it used to be the one that lost your place.
  t('so does turning the phone', /if \(e\.matches\) _goDesktopShell\(\)\s*\n\s*else\s+_goMobileShell\(\)/.test(cli))
  t('the desktop side still paints every section before revealing one', /renderAll\(\)\s*\n\s*\/\/ After renderAll/.test(cli))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
