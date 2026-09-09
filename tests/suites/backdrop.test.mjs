// Every full-screen surface either shows the backdrop photo, or says why it does not.
//
// This bug was reported three times, one container at a time: .main hid the photo on
// desktop, then .mob-view hid it on the mobile home, then #mobPredictOverlay hid it in
// Outcomes. Each fix was correct and each left the next one waiting to be found, because
// the set was being discovered by use rather than enumerated.
//
// So this suite enumerates it. Any rule that fills the viewport AND paints var(--bg) must
// be one of two things: cleared when a photo is set, or listed below as deliberately solid
// with a reason. A new overlay added next month is a red test, not a fourth report.
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

// The block that clears surfaces when a photo is set.
const cleared = (() => {
  const i = CSS.indexOf('html.has-bg-image, html.has-bg-image body,')
  if (i < 0) return ''
  return CSS.slice(i, CSS.indexOf('}', i) + 1) + CSS.slice(i, i + 3000)
})()

console.log(nl + '-- the photo layer is still wired --')
t('there is a rule that clears surfaces for a photo', cleared.length > 0)
t('html and body are cleared', cleared.includes('html.has-bg-image body,'))

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
      if (cleared.includes(bare) || cleared.includes(n)) continue
      // has-bg-image's own rules paint --bg deliberately: that IS the scrim.
      if (n.includes('has-bg-image')) continue
      offenders.push(n.slice(0, 70))
    }
  }
  t('nothing full-screen paints over the photo unaccounted for',
    offenders.length === 0, [...new Set(offenders)].join(' | '))
}

console.log(nl + '-- the ones reported, one at a time, are all covered --')
for (const [what, sel] of [
  ['desktop content area', '.main'],
  ['the mobile shell', '.mob-view'],
  ['Predictions', '#mobPredictOverlay'],
  ['an expanded outcome card', '.oc-card.oc-expanded'],
  ['the advanced chart', '.adv-overlay'],
  ['sub-sheets', '.sub-sheet'],
]) t(`${what} shows the photo`, cleared.includes(sel), sel)

console.log(nl + '-- and the deliberate exceptions carry their reason --')
for (const [sel, why] of Object.entries(SOLID_ON_PURPOSE)) {
  if (sel === '.pin-modal-input' || sel === '.oc-card-close') continue   // controls, not containers
  t(`${sel} is documented as solid on purpose`, CSS.includes(sel) && CSS.includes(why.slice(0, 30)), why)
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
