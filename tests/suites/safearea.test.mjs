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

console.log(nl + '-- the insets are switched on at all --')
// env() silently returns 0 without this, which is why 19 uses of it sat dead in this file and
// the header carried a hardcoded 52px instead.
t('viewport-fit=cover is set', /viewport-fit\s*=\s*cover/.test(HTML))

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

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
