// The photo editor's geometry (src/imgedit.js). Asked: "when uploading a photo (user image or
// background image), it should let the user resize, etc, and preview before putting it". What
// must hold whatever the person does: the frame is always fully covered by the picture — no
// empty edge in a profile photo or a wallpaper — and zoom 1 is exactly "fills the frame".
import fs from 'fs'
import { coverScale, cropRect, clampCenter, CANCELLED } from '../../src/imgedit.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b) => Math.abs(a - b) < 1e-6
const covers = (r, W, H) => r.sx >= -1e-9 && r.sy >= -1e-9 && r.sx + r.sw <= W + 1e-9 && r.sy + r.sh <= H + 1e-9

// A landscape photo into a square avatar: zoom 1 shows the full height, centred.
const a = cropRect({ imgW: 4000, imgH: 3000, frameW: 300, frameH: 300 })
t('zoom 1 fills the frame on the short side', near(a.sh, 3000) && near(a.sw, 3000), a)
t('and starts centred', near(a.sx, 500) && near(a.sy, 0), a)

// Zoom 2 shows half as much.
const z2 = cropRect({ imgW: 4000, imgH: 3000, frameW: 300, frameH: 300, zoom: 2 })
t('zoom 2 shows half the side', near(z2.sw, 1500), z2)

// Dragged far past the edge: clamped so the frame is still covered.
const far = cropRect({ imgW: 4000, imgH: 3000, frameW: 300, frameH: 300, zoom: 2, cx: -9999, cy: 99999 })
t('dragged past an edge, the frame stays covered', covers(far, 4000, 3000), far)
t('at that edge exactly', near(far.sx, 0) && near(far.sy + far.sh, 3000), far)

// Zoom below 1 is not allowed: it would show empty space around the picture.
const under = cropRect({ imgW: 4000, imgH: 3000, frameW: 300, frameH: 300, zoom: 0.4 })
t('zoom never goes below filling the frame', near(under.sw, 3000), under)

// A portrait phone photo into a landscape wallpaper frame.
const w = cropRect({ imgW: 1170, imgH: 2532, frameW: 560, frameH: 268 })
t('a portrait photo in a landscape frame fills its width', near(w.sw, 1170) && w.sh < 2532 && covers(w, 1170, 2532), w)
t('cover scale is the larger of the two ratios', near(coverScale(1170, 2532, 560, 268), 560 / 1170))

// Every random move keeps it covered.
let ok = true
for (let i = 0; i < 500; i++) {
  const W = 200 + Math.random() * 5000, H = 200 + Math.random() * 5000
  const r = cropRect({ imgW: W, imgH: H, frameW: 100 + Math.random() * 500, frameH: 100 + Math.random() * 500,
    zoom: Math.random() * 6, cx: (Math.random() * 3 - 1) * W, cy: (Math.random() * 3 - 1) * H })
  if (!covers(r, W, H)) { ok = false; break }
}
t('500 random zooms and drags all keep the frame covered', ok)
t('clampCenter centres when the view is wider than the image', clampCenter(10, 10, 100, 100, 200, 50).cx === 50)

// Wiring: both uploads go through it, and backing out is not an error.
const cli = fs.readFileSync('src/main.js', 'utf8')
t('the profile photo is framed in it', cli.includes("editImage(file, { kind: 'avatar', outW: 256, outH: 256"))
t('so is the wallpaper, in this screen\'s shape and under its dim', cli.includes("editImage(file, { kind: 'wallpaper', outW, outH") && cli.includes('dim: Math.min(95, Math.max(25, loadBackdropDim())) / 100'))
t('cancel is its own answer, not a failure', typeof CANCELLED === 'symbol' && cli.includes('if (e === IMG_CANCELLED) return'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
