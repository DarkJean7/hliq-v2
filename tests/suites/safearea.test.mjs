// Safe-area insets have to be ADDED to a box, never taken out of one.
//
// This shipped to production once. viewport-fit=cover made env(safe-area-inset-*) return real
// values for the first time, and .mob-v-bottom was `height: 72px` with `padding-bottom:
// env(safe-area-inset-bottom)`. box-sizing is border-box globally, so the 34px inset came out
// of the same 72px: the tab bar's controls were squeezed into 38px and rode up the screen.
//
// The rule this suite enforces: if a box has a FIXED main size and also takes an inset on that
// axis, the size must be a calc() that includes the inset. Everything that only pads an
// auto-sized box is already fine and is not checked here.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CSS = fs.readFileSync('src/style.css', 'utf8')
const HTML = fs.readFileSync('index.html', 'utf8')

/** The declaration block for a selector that starts a rule. */
function blockAt(marker) {
  const i = CSS.indexOf(marker)
  if (i < 0) return ''
  const open = CSS.indexOf('{', i), close = CSS.indexOf('}', open)
  return open < 0 || close < 0 ? '' : CSS.slice(i, close + 1)
}

console.log(nl + '-- viewport-fit=cover is OFF, and that is a decision --')
// It was on for one day so the wallpaper could reach under the status bar. On an installed
// iOS web app iOS anchored the viewport at y=0 without growing it, so the page ended 62px
// above the bottom of the screen and the tab bar had nowhere to go:
//
//     screen=402x874  inner=402x812  shortBy=62  standalone=true
//
// Every env(safe-area-inset-*) in this stylesheet goes back to reporting 0 with it off, which
// is the state all of them were written under. If it is ever switched back on, that dead strip
// comes back with it -- so this assertion is a decision to re-make deliberately, not a rule.
// Comments stripped: the one above the meta tag names the thing it is explaining.
const HTML_TAGS = HTML.replace(/<!--[\s\S]*?-->/g, '')
t('viewport-fit=cover is not set', !/viewport-fit\s*=\s*cover/.test(HTML_TAGS))
t('and what it cost is recorded next to it', HTML.includes('shortBy=62'))
// And it must be the ONLY mechanism. `black-translucent` is the legacy way to draw under the
// status bar; with both, iOS starts the web view at y=0 but keeps its HEIGHT at screen minus
// the status bar. Measured on the phone: screen=402x874 inner=402x812 shortBy=62, exactly the
// top inset, so the bottom strip of the screen was outside the document and no stylesheet
// could reach it. Three CSS fixes chased a bar that `bottom: 0` had placed correctly.
t('and it is not fighting the legacy status-bar meta',
  !/apple-mobile-web-app-status-bar-style/.test(HTML.replace(/<!--[\s\S]*?-->/g, '')))
t('with the measurement that proved it recorded', HTML.includes('shortBy=62'))

console.log(nl + '-- the bottom bar grows by the inset instead of eating it --')
const bar = blockAt('.mob-v-bottom {')
t('there is a bottom bar rule', bar.length > 0)
t('it still takes the inset', bar.includes('env(safe-area-inset-bottom)'))
t('and its height is calc()d to include it, not a flat px',
  /height:\s*calc\([^)]*env\(safe-area-inset-bottom\)/.test(bar), bar.match(/height:[^;]*/)?.[0])
// The specific regression: a bare `height: 72px` next to the padding.
t('height is not a bare pixel value', !/height:\s*\d+px\s*;/.test(bar), bar.match(/height:[^;]*/)?.[0])

console.log(nl + '-- content clears the bar it actually has --')
const content = blockAt('.mob-v-content {')
t('the scroll area clears the bar', /padding:[^;]*calc\([^;]*env\(safe-area-inset-bottom\)/.test(content),
  content.match(/padding:[^;]*/)?.[0])

console.log(nl + '-- the shell holds its contents clear of the status bar --')
// It deliberately does NOT go on .mob-view. That element is the scroll container
// (.mob-view.mob-view-active sets overflow-y:auto), and .mob-v-bottom is a position:fixed
// CHILD of it. On iOS a fixed child of a touch-scrolling container is laid out against the
// scroller's content box, so padding here moved the tab bar -- it opened in the wrong place
// and moved again as a scroll settled. This assertion is the reason that must not come back.
const shell = blockAt('.mob-view {')
const shellDecls = shell.replace(/\/\*[\s\S]*?\*\//g, '')
t('the scroll container carries no padding of its own', !/\bpadding[a-z-]*\s*:/.test(shellDecls),
  shellDecls.match(/\bpadding[a-z-]*\s*:[^;]*/)?.[0])
t('the first in-flow child carries the top inset instead',
  /#mobPredictHandle\s*\{[^}]*padding-top:\s*calc\([^)]*env\(safe-area-inset-top\)/.test(CSS))
t('and the handle really is that first child, which is why it goes there',
  HTML.indexOf('id="mobPredictHandle"') < HTML.indexOf('<div class="mob-v-header">'))
t('why is written down', CSS.includes('NO padding on this element'))

console.log(nl + '-- no fixed-height box quietly eats an inset --')
{
  const offenders = []
  const bare = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(bare))) {
    const sel = m[1].trim(), body = m[2]
    if (!/padding-bottom:\s*env\(safe-area-inset-bottom\)/.test(body)) continue
    // A flat height on the same box means the padding is carved out of it.
    const h = body.match(/height:\s*(\d+(?:\.\d+)?)px\s*;/)
    if (h) offenders.push(sel.split(',').pop().trim().slice(0, 40) + ' height:' + h[1] + 'px')
  }
  t('every box taking a bottom inset is free to grow', offenders.length === 0, offenders.join(' | '))
}

console.log(nl + '-- and what floats ABOVE the bar follows it up --')
{
  // The bar grew by the inset; two toasts anchored at a flat 80px and 86px did not, so on a
  // phone they land inside it. Same root cause as the bar itself, one file over: a number
  // sized for a 72px bar, written before the bar could be taller than that.
  const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  t('the price-alert toast clears the bar',
    CLI.includes('position:fixed;bottom:calc(80px + env(safe-area-inset-bottom));left:50%'))
  t('and the notification stack does too',
    CLI.includes('bottom:calc(86px + env(safe-area-inset-bottom));z-index:9999'))
  t('neither still anchors to a bare pixel value',
    !CLI.includes('position:fixed;bottom:80px;left:50%') &&
    !CLI.includes('transform:translateX(-50%);bottom:86px'))
}

console.log(nl + '-- a no-op filter must not redefine what fixed positioning means --')
{
  // `filter` on <html> makes <html> the containing block for EVERY position:fixed element in
  // the app, so `bottom: 0` stops meaning the bottom of the screen. At the default brightness
  // the filter was brightness(1) — a visual no-op doing that to the whole app anyway.
  // Gating it on "actually dimmed" was not enough: the phone runs 115%, so the filter was
  // still there and navprobe caught it holding a 0..0 box for every fixed element in the app.
  // A plain `filter:` — not backdrop-filter, which contains nothing.
  t('the brightness setting no longer paints a filter onto an ancestor',
    !/(^|[^-])filter:\s*brightness\(var\(--ui-brightness/m.test(CSS.replace(/\/\*[\s\S]*?\*\//g, '')))
  t('brightness is a pass-through layer instead',
    /\.ui-bright-layer\s*\{[\s\S]{0,400}backdrop-filter:\s*brightness/.test(CSS))
  t('it intercepts nothing', /\.ui-bright-layer\s*\{[\s\S]{0,400}pointer-events:\s*none/.test(CSS))
  t('and sits above every overlay, so modals are adjusted too',
    /\.ui-bright-layer\s*\{[\s\S]{0,400}z-index:\s*2147483000/.test(CSS))
  const CLI2 = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  t('the class is toggled from the one place that knows the value',
    CLI2.includes('function _applyBrightnessFilter(v)') &&
    CLI2.includes("el.classList.toggle('ui-dimmed', dim)"))
  // Both the startup restore and the slider, or the two disagree after a reload.
  t('applied on restore and on change', (CLI2.match(/_applyBrightnessFilter\(/g) ?? []).length === 3)
  t('why it matters is written down, with the reading that proved it',
    CSS.includes('containing block for every position:fixed descendant') &&
    CSS.includes('box=0..0'))
}

console.log(nl + '-- the bar is not inside the thing that scrolls --')
{
  const HTM = fs.readFileSync('index.html', 'utf8')
  // On iOS a position:fixed child of a touch-scrolling element is laid out against that
  // scroller, not the viewport: it lands wrong and drifts again as momentum settles.
  const shellStart = HTM.indexOf('id="mobileView"')
  const navAt = HTM.indexOf('<nav class="mob-v-bottom"')
  const shellEnd = HTM.indexOf('<!-- Bottom nav', shellStart)
  t('the tab bar is a SIBLING of the mobile shell', navAt > shellStart && navAt > shellEnd)
  t('and why is written down', HTM.includes('laid out against that scroller'))
  // It used to inherit display:none from the shell; outside it, it needs its own gate or it
  // shows up on desktop.
  // Comments stripped: this rule carries several, and they push the declaration far enough
  // down that a windowed match misses it.
  const barDecls = blockAt('.mob-v-bottom {').replace(/\/\*[\s\S]*?\*\//g, '')
  t('it is hidden until the mobile shell is up',
    /display:\s*none/.test(barDecls) &&
    CSS.includes('body.is-mob-view .mob-v-bottom { display: grid; }'), barDecls.slice(0, 90))
}

console.log(nl + '-- and the real geometry is measured, not assumed --')
{
  // This bar has been diagnosed twice from a desktop browser and "fixed" twice while the phone
  // still showed it wrong. Chromium has no safe area and does not reproduce iOS's containing
  // block, so a third desktop-verified guess would be worth no more than the first two.
  const PROBE = fs.readFileSync('src/navprobe.js', 'utf8')
  const CLI2 = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  t('there is a probe', PROBE.length > 0)
  t('it reports the gap between the bar and the bottom of the screen',
    PROBE.includes('nav bottom is ') && PROBE.includes('above the viewport bottom'))
  // The reading that actually distinguishes the causes.
  t('and what, if anything, is containing the fixed element',
    PROBE.includes('function containingBlockChain') && PROBE.includes('fixedContainedBy='))
  t('every property that can capture a fixed descendant is checked',
    ['transform', 'filter', 'backdropFilter', 'perspective', 'willChange', 'contain']
      .every(k => PROBE.includes(k)))
  t('the insets are measured rather than assumed', PROBE.includes('function readInsets'))
  t('it sends once per session', PROBE.includes('if (sent) return'))
  // Comments stripped first — the file's own header promises it sends no addresses or
  // balances, and matching that promise would pass the test for saying the words.
  t('and carries nothing from the account',
    !/addr|balance|equity|wallet|privkey/i.test(PROBE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '')))
  t('the mobile shell fires it', CLI2.includes("from './navprobe.js'") &&
    CLI2.includes('setTimeout(probeNavGeometry, 400)'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
