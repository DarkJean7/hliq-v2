// Horizontal pill strips that could not scroll on mobile.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

console.log('\n-- the trap --')
// An !important mobile rule rewrites inline overflow-x:auto to visible unless the element
// carries data-dragscroll. Proven in the browser: without it computed overflowX is
// "visible", with it "auto" — so an un-opted strip can never scroll, however wide.
t('the killer rule still exists and still excludes opted-in strips',
  css.includes('[style*="overflow-x:auto"]:not([data-dragscroll])'))
t('and it is documented as the cause', css.includes('silently makes them unscrollable'))

console.log('\n-- every real strip now opts in --')
const strips = cli.split('\n').filter(l => /overflow-x:auto/.test(l) && /display:flex/.test(l))
t('there are strips to check', strips.length >= 4, String(strips.length))
for (const l of strips) {
  const id = (l.match(/id="([^"]+)"/) ?? [])[1] ?? (l.match(/padding:([^;]+);/) ?? [])[1] ?? 'strip'
  t(`"${id}" carries data-dragscroll`, l.includes('data-dragscroll'), l.trim().slice(0, 90))
}
t('the account picker specifically', cli.includes('<div id="stratAcctPills" data-dragscroll'))
t('and it can shrink inside its flex column instead of forcing the row wider',
  cli.includes('id="stratAcctPills" data-dragscroll style="display:flex;gap:6px;min-width:0;overflow-x:auto'))
t('the coin picker too', cli.includes('<div id="mobCoinPickerPills" data-dragscroll'))

console.log('\n-- the desktop table wrapper is deliberately NOT opted in --')
// That wrapper holds a min-width:760px table, which is exactly what the rule exists to flatten.
const tbl = cli.split('\n').find(l => l.includes('<div style="overflow-x:auto">'))
t('it is still plain', !!tbl && !tbl.includes('data-dragscroll'))
t('and the reason is written down', cli.includes('exactly the case the !important rule exists to flatten'))

console.log('\n-- the attribute now does something on its own --')
t('CSS backs it with real touch scrolling', css.includes('[data-dragscroll] {') && css.includes('-webkit-overflow-scrolling: touch'))
t('scrollbars stay hidden', css.includes('[data-dragscroll]::-webkit-scrollbar { display: none; }'))
t('and the note explains why it was added', css.includes('For a\n     long time nothing did'))

console.log('\n-- the JS handler drives it where iOS will not --')
const _dhStart = cli.indexOf('function initDragScroll()')
const dh = cli.slice(_dhStart, cli.indexOf('window.__tradeAcctPickerHtml = function()', _dhStart))
t('it targets the attribute', dh.includes("closest?.('[data-dragscroll]')"))
t('it locks an axis before hijacking anything', dh.includes("axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'"))
t('a vertical drag is released so the page still scrolls', dh.includes("if (axis === 'y') { el = null; return }"))
t('a small jitter does not commit to an axis', dh.includes('Math.abs(dx) < 6 && Math.abs(dy) < 6'))
t('listeners are passive — it never blocks native scrolling', (dh.match(/passive: true/g) ?? []).length >= 4)
t('dragging a strip does not fire the tab-swipe gesture',
  cli.includes('_SWIPE_BLOCKED_SEL') && cli.includes('[data-dragscroll]'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
