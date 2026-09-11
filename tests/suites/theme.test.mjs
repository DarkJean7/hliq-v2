// Backdrop themes: the surface palette, and the user's own photo behind the app.
//
// Two things are worth guarding here. A preset must only ever move the NEUTRALS -- the
// moment one can reach --pos or --neg, a backdrop can make a loss look like a profit, which
// is the one thing a cosmetic feature must never do. And an uploaded photo must be
// re-encoded before it is stored: localStorage is a few MB for the whole origin and this app
// already keeps paper accounts, device bots and a cached All-Accounts snapshot in it, so a
// raw phone photo would not merely fail to save, it would evict what people care about.
import fs from 'fs'
import { BACKDROPS, backdropById, loadBackdrop, applyBackdrop,
         loadBackdropDim, saveBackdropDim } from '../../src/theme.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const SRC = fs.readFileSync('src/theme.js', 'utf8')
const CSS = fs.readFileSync('src/style.css', 'utf8')
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const HTM = fs.readFileSync('index.html', 'utf8')

// A DOM stub: enough for applyBackdrop, which only ever touches documentElement.style.
const props = new Map()
globalThis.document = { documentElement: { style: {
  setProperty: (k, v) => props.set(k, v),
  removeProperty: (k) => props.delete(k),
} } }
const store = new Map()
globalThis.localStorage = {
  getItem: k => store.has(k) ? store.get(k) : null,
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
}

console.log(nl + '-- the presets are well formed --')
t('there are several', BACKDROPS.length >= 5, String(BACKDROPS.length))
t('ids are unique', new Set(BACKDROPS.map(b => b.id)).size === BACKDROPS.length)
t('every one has a name and a hint', BACKDROPS.every(b => b.name && b.hint))
t('and all six surface values',
  BACKDROPS.every(b => ['bg', 'panel', 'p2', 'p3', 'rule', 'soft'].every(k => /^#[0-9a-f]{6}$/i.test(b.vars[k]))),
  JSON.stringify(BACKDROPS.find(b => !/^#[0-9a-f]{6}$/i.test(b.vars?.bg))?.id ?? ''))
t('midnight is the default and is first', BACKDROPS[0].id === 'midnight')
t('an unknown id falls back rather than throwing', backdropById('nope').id === 'midnight')
t('and so does no id at all', backdropById(undefined).id === 'midnight')

console.log(nl + '-- a preset moves the neutrals and NOTHING else --')
{
  props.clear()
  applyBackdrop('ocean')
  const keys = [...props.keys()].sort()
  t('it sets exactly the six surface variables',
    keys.join(',') === '--bg,--panel,--panel-2,--panel-3,--rule,--rule-soft', keys.join(','))
  t('with the values the preset declares',
    props.get('--bg') === backdropById('ocean').vars.bg, props.get('--bg'))
  // The guard that matters: a cosmetic control must not be able to recolour a number.
  for (const forbidden of ['--pos', '--neg', '--warn', '--accent', '--accent-h']) {
    t(`it cannot touch ${forbidden}`, !props.has(forbidden))
  }
  t('and the module never names them', !/--pos|--neg|--warn|--accent/.test(SRC))
}

console.log(nl + '-- light mode is not half-painted --')
{
  props.clear()
  applyBackdrop('ocean', { light: true })
  t('every surface variable is CLEARED, not skipped', props.size === 0, JSON.stringify([...props]))
  // Skipping would leave the previous dark ramp painted over the light palette, which is
  // grey text on a grey card. Clearing hands the cascade back to light mode's own values.
  t('why is recorded', SRC.includes('leave the dark ramp painted'))
}

console.log(nl + '-- storage reads never throw --')
{
  const real = globalThis.localStorage
  globalThis.localStorage = { getItem() { throw new Error('disabled') }, setItem() { throw new Error('disabled') }, removeItem() {} }
  t('a blocked read still returns a usable preset', loadBackdrop() === 'midnight')
  t('and a usable dim', loadBackdropDim() === 62, String(loadBackdropDim()))
  t('a blocked write reports failure rather than throwing', saveBackdropDim(50) === false)
  globalThis.localStorage = real
}
t('the dim is clamped to a readable floor', SRC.includes('Math.max(25'))
t('and a photo is never stored raw', SRC.includes("toDataURL('image/jpeg'"))
t('the size limit is justified, not arbitrary', SRC.includes('would evict the things people care about'))
t('quota failure is reported, not swallowed', SRC.includes('too large to store on this device'))

console.log(nl + '-- the photo layer cannot make the app unreadable --')
t('it is fixed, not scrolling with the content', /has-bg-image body::before[\s\S]{0,160}position: fixed/.test(CSS))
t('why a scrolling one is unusable is recorded', CSS.includes('sliding') && CSS.includes('unreadable'))
t('a scrim sits over it', /has-bg-image body::after[\s\S]{0,160}--app-bg-dim/.test(CSS))
t('the shell surfaces get out of its way', CSS.includes('html.has-bg-image .main'))
// No trailing comma: .mob-view is now the LAST selector in the cleared list. The full-tab
// content pane used to follow it there, and that was the bug — it is an overlay over the Home
// tab, not a shell, so it moved to the list that paints the photo on itself. See backdrop.test.
t('including the mobile shell itself', /html\.has-bg-image \.mob-view\s*[,{]/.test(CSS)),
// .mob-view covers the whole mobile screen. Clearing only the full-tab view left the
// photo visible on desktop and invisible on the surface that matters most.
// These joined a longer group when the remaining full-screen overlays were added, so the
// rule no longer ends right after them. backdrop.test.mjs owns the completeness check now.
t('and its full-tab views', CSS.includes('mob-tab-full .mob-v-content') &&
  CSS.includes('mob-strats-full .mob-v-content'))
t('but not every use of --bg, which would erase inputs',
  CSS.includes('would make them vanish into the picture'))

console.log(nl + '-- it is wired into the app --')
t('the module is imported', CLI.includes("from './theme.js'"))
t('and restored at startup with the other appearance prefs',
  CLI.includes('restoreTheme({ light: isLight })'))
t('switching colour scheme repaints it',
  CLI.includes('applyBackdrop(loadBackdrop(), { light: isLight, photo:'))
// Panels are translucent only while a photo is set, so adding or removing one has to
// repaint the ramp -- otherwise removing an image leaves see-through cards over a colour.
t('and so does adding or removing a photo',
  CLI.includes('photo: true })') && CLI.includes('photo: false })'))
t('translucency is done at the variable level, not per card',
  /--panel',   photo \?/.test(fs.readFileSync('src/theme.js', 'utf8')))
t('so a card added later inherits it',
  fs.readFileSync('src/theme.js', 'utf8').includes('without anyone remembering to add a rule'))
t('the raised surface stays the most solid',
  fs.readFileSync('src/theme.js', 'utf8').includes('is not a dropdown'))
t('and blur is listed by container, not applied to every row',
  CSS.includes('is a scroll-jank machine'))
t('opening Settings builds the swatches', CLI.includes('_syncBackdropUI()'))
t('the swatch row is generated from BACKDROPS, not written out twice',
  CLI.includes('BACKDROPS.map(b =>') && !HTM.includes('data-bd='))
t('Settings has a Backdrop row', HTM.includes('id="backdropSwatches"'))
t('and an upload that accepts images only', /accept="image\/\*"/.test(HTM))
t('with a Remove and a Dim control', HTM.includes('id="backdropClearBtn"') && HTM.includes('id="backdropDimSlider"'))
t('re-picking the same file still fires', CLI.includes("input.value = ''"))

// Shipped desktop-only the first time. Mobile is the primary surface, so the presets
// applied there and there was no way to change them -- worth its own assertion.
t('the mobile settings has the swatches too',
  CLI.includes("window.__onBackdropPick('${b.id}');_mobVRenderContent()"))
t('and its own upload, remove and dim',
  CLI.includes('window.__onBackdropFile(this).then') &&
  CLI.includes("window.__onBackdropClear();_mobVRenderContent()") &&
  CLI.includes('window.__onBackdropDim(this.value)'))
t('the mobile row says when a preset is dormant', CLI.includes('_mobIsLight()'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
