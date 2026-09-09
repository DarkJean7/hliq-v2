// Every full-screen surface either shows the backdrop photo, or says why it does not.
//
// This bug was reported three times, one container at a time: .main hid the photo on
// desktop, then .mob-view hid it on the mobile home, then #mobPredictOverlay hid it in
// Outcomes. Each fix was correct and each left the next one waiting to be found, because
// the set was being discovered by use rather than enumerated.
//
// So this suite enumerates it. Any rule that fills the viewport AND paints var(--bg) must
// be one of three things: a SHELL that is cleared, an OVERLAY that paints the photo itself,
// or listed below as deliberately solid with a reason.
//
// The shell/overlay split is the fourth report, and it is a distinction the first version of
// this suite did not make. Nothing sits behind a shell, so clearing it reveals the photo. An
// overlay sits on top of the app -- clearing it revealed the Portfolio tab through the
// Advanced chart, two sets of controls and two copies of the equity figure stacked on each
// other. An overlay has to be opaque to what is beneath it AND still show the wallpaper,
// which means painting the picture on itself.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CSS = fs.readFileSync('src/style.css', 'utf8')

// Surfaces that MUST stay opaque over a photo, and why. Adding to this list is a decision;
// it should be an uncomfortable one, which is why each entry carries its reason.
const SOLID_ON_PURPOSE = {
  '.mob-v-bottom': 'the bottom nav is chrome and must stay legible over any photo',
  '.alarm-ov':     'a 4am liquidation alarm is not the place for a wallpaper',
  '.pin-modal-input': 'an input, not a container — it fills with --bg by design',
  '.oc-card-close':   'a button, not a container — a see-through close control is a bad target',
}

/** The declaration block whose selector list starts at `marker`, selectors included. */
function blockAt(marker) {
  const i = CSS.indexOf(marker)
  if (i < 0) return ''
  const open = CSS.indexOf('{', i)
  const close = CSS.indexOf('}', open)
  return open < 0 || close < 0 ? '' : CSS.slice(i, close + 1)
}

// The shells: cleared, so body::before shows through them.
const shells = blockAt('html.has-bg-image, html.has-bg-image body,')
// The overlays: they paint the photo on themselves. Two blocks — an expanded outcome card
// is only an overlay on mobile, so it is scoped, and above 768px it is an ordinary card.
const overlays = blockAt('html.has-bg-image #mobPredictOverlay,') +
                 blockAt('html.has-bg-image .oc-card.oc-expanded {')
const covered = shells + overlays

console.log(nl + '-- the photo layer is still wired --')
t('there is a rule that clears the shells', shells.length > 0)
t('html and body are cleared', shells.includes('html.has-bg-image body,'))
t('and it really does clear them', /background:\s*transparent\s*!important/.test(shells))

console.log(nl + '-- overlays paint the photo instead of being cleared --')
t('there is an overlay rule', overlays.length > 0)
t('it paints the picture', overlays.includes('var(--app-bg-image)'))
t('dimmed the same as the shell behind it', overlays.includes('var(--app-bg-dim'))
t('anchored to the viewport, so it lines up with that shell',
  overlays.includes('background-attachment: fixed'))
t('and it is OPAQUE — an overlay that is cleared shows the tab underneath it',
  !/background:\s*transparent/.test(overlays) && overlays.includes('background-color: var(--bg)'))
// The expanded outcome card is full-screen only below 768px. Painting the viewport-aligned
// photo on the desktop 440px card would line it up exactly with the wallpaper behind it and
// leave nothing but a shadow to say a card was open.
t('the outcome card gets it only where it is actually full-screen',
  /@media \(max-width: 768px\) \{\s*html\.has-bg-image \.oc-card\.oc-expanded/.test(CSS))
// The specific report: the Advanced chart drawn over Portfolio, with Portfolio's own
// controls and figures showing through it.
t('why is written down', CSS.includes('Nothing sits behind a SHELL'))

console.log(nl + '-- every full-screen --bg surface is accounted for --')
{
  // Selectors whose block paints the ground colour AND covers the viewport.
  const offenders = []
  // Comments must go first: a /* ... */ sitting above a rule is part of the text
  // between two braces, so leaving them in makes every selector look like prose.
  const bare_css = CSS.replace(/\/\*[\s\S]*?\*\//g, '')
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(bare_css))) {
    const sel = m[1].trim(), body = m[2]
    if (!/background(-color)?\s*:\s*var\(--bg\)/.test(body)) continue
    // Full-screen: positioned over everything, or one of the shell containers by name.
    const fullScreen = /position:\s*fixed/.test(body) || /inset:\s*0/.test(body) ||
                       /overlay|shell|\.mob-view|screen|sheet|\.main\b/i.test(sel)
    if (!fullScreen) continue
    // Take the last selector on the line — the one the rule actually names.
    const names = sel.split(',').map(s => s.replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter(Boolean)
    for (const n of names) {
      const key = Object.keys(SOLID_ON_PURPOSE).find(k => n.includes(k))
      if (key) continue                                  // solid on purpose
      const bare = n.replace(/^.*\s/, '')                // last token of a descendant chain
      if (covered.includes(bare) || covered.includes(n)) continue
      // has-bg-image's own rules paint --bg deliberately: that IS the scrim.
      if (n.includes('has-bg-image')) continue
      offenders.push(n.slice(0, 70))
    }
  }
  t('nothing full-screen paints over the photo unaccounted for',
    offenders.length === 0, [...new Set(offenders)].join(' | '))
}

console.log(nl + '-- the ones reported, one at a time, are all covered --')
// Which half each belongs in is the point. A shell in the overlay list would paint the
// photo twice and come out double-dimmed; an overlay in the shell list is the Advanced-chart
// bug all over again.
for (const [what, sel, where] of [
  ['desktop content area', '.main', shells],
  ['the mobile shell', '.mob-view', shells],
  ['the mobile full-tab view', 'mob-tab-full .mob-v-content', shells],
  ['Predictions', '#mobPredictOverlay', overlays],
  ['an expanded outcome card', '.oc-card.oc-expanded', overlays],
  ['the advanced chart', '.adv-overlay', overlays],
  ['sub-sheets', '.sub-sheet', overlays],
]) t(`${what} shows the photo`, where.includes(sel), sel)

console.log(nl + '-- and the deliberate exceptions carry their reason --')
for (const [sel, why] of Object.entries(SOLID_ON_PURPOSE)) {
  if (sel === '.pin-modal-input' || sel === '.oc-card-close') continue   // controls, not containers
  t(`${sel} is documented as solid on purpose`, CSS.includes(sel) && CSS.includes(why.slice(0, 30)), why)
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
