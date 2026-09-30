// Pictures a person adds: how big they are allowed to get, what an id looks like, and which
// stored bytes nothing points at any more. src/imgstore.js.
import fs from 'fs'
import {
  fitDims, newImgId, isImgId, cleanImgIds, orphanIds, dataUrlBytes, isImageDataUrl,
  MAX_EDGE, JPEG_Q, MAX_NOTE_IMGS, MAX_BYTES, CHAT_IMG_MAX_BYTES, CHAT_MAX_EDGE,
} from '../../src/imgstore.js'

const src = fs.readFileSync('src/imgstore.js', 'utf8').replace(/\r\n/g, '\n')
const cal = fs.readFileSync('src/calnotes.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

console.log(nl + '-- the size it is drawn at --')
{
  t('a big photo comes down to the long edge', JSON.stringify(fitDims(4000, 3000)) === JSON.stringify({ w: 1280, h: 960 }))
  t('portrait too, on ITS long edge', JSON.stringify(fitDims(3000, 4000)) === JSON.stringify({ w: 960, h: 1280 }))
  t('the shape is kept', (() => { const d = fitDims(1920, 1080); return Math.abs(d.w / d.h - 1920 / 1080) < 0.01 })())
  // Upscaling adds bytes and no detail.
  t('a small one is left alone, not blown up', JSON.stringify(fitDims(320, 200)) === JSON.stringify({ w: 320, h: 200 }))
  t('exactly at the limit is left alone', fitDims(MAX_EDGE, 400).w === MAX_EDGE)
  // A canvas of zero height throws; a panorama must not become one.
  t('a sliver keeps at least one pixel', fitDims(4000, 3).h === 1)
  t('nothing in, nothing out', JSON.stringify(fitDims(0, 0)) === JSON.stringify({ w: 0, h: 0 }))
  t('junk in is not NaN out', JSON.stringify(fitDims('x', null)) === JSON.stringify({ w: 0, h: 0 }))
  t('the chat draws smaller than a note — it is read in a feed', CHAT_MAX_EDGE < MAX_EDGE)
}

console.log(nl + '-- ids --')
{
  t('an id is short and plain', isImgId(newImgId()))
  t('two are different', newImgId() !== newImgId())
  t('nothing else is an id', !isImgId('') && !isImgId('../../etc/passwd') && !isImgId(null) && !isImgId('a'))
  t('a list keeps order and drops duplicates',
    JSON.stringify(cleanImgIds(['aaaaaaaa', 'bbbbbbbb', 'aaaaaaaa'])) === JSON.stringify(['aaaaaaaa', 'bbbbbbbb']))
  t('and things that are not ids', JSON.stringify(cleanImgIds(['aaaaaaaa', 'x', 5, null])) === JSON.stringify(['aaaaaaaa']))
  t('and is capped', cleanImgIds(Array.from({ length: 30 }, (_, i) => 'id' + String(i).padStart(6, '0'))).length === MAX_NOTE_IMGS)
  t('a non-list is an empty list, not a crash', JSON.stringify(cleanImgIds('nope')) === JSON.stringify([]))
}

console.log(nl + '-- what nothing points at any more --')
{
  t('a picture no note refers to is an orphan',
    JSON.stringify(orphanIds(['aaaaaaaa', 'bbbbbbbb'], ['aaaaaaaa'])) === JSON.stringify(['bbbbbbbb']))
  t('one that is referred to is not', orphanIds(['aaaaaaaa'], ['aaaaaaaa']).length === 0)
  t('nothing stored, nothing to sweep', orphanIds([], ['aaaaaaaa']).length === 0)
  // "We did not look" is not "there is none" — CLAUDE.md's most expensive rule. A sweep
  // that read the notes as an empty list would delete every picture on the device.
  t('a caller passing junk for the live list deletes nothing it should keep',
    JSON.stringify(orphanIds(['aaaaaaaa'], null)) === JSON.stringify(['aaaaaaaa']))
  t('the sweep asks the notes for what is in use, not the other way round',
    /const inUse = loadNotes\(.*\)\.flatMap\(n => n\.imgs \?\? \[\]\)/.test(cal))
}

console.log(nl + '-- how big it ended up --')
{
  t('four base64 characters are three bytes', dataUrlBytes('data:image/jpeg;base64,AAAA') === 3)
  t('padding is not counted', dataUrlBytes('data:image/jpeg;base64,AAA=') === 2 && dataUrlBytes('data:image/jpeg;base64,AA==') === 1)
  t('something that is not a data url is zero', dataUrlBytes('nope') === 0 && dataUrlBytes(null) === 0)
}

console.log(nl + '-- what counts as a picture --')
{
  t('a jpeg data url', isImageDataUrl('data:image/jpeg;base64,/9j/4AAQ'))
  t('png and webp too', isImageDataUrl('data:image/png;base64,iVBOR') && isImageDataUrl('data:image/webp;base64,UklGR'))
  // The chat writes what arrives into a directory the web server serves.
  t('an svg is NOT — it is a document that can carry script', !isImageDataUrl('data:image/svg+xml;base64,PHN2Zz4='))
  t('nor a bare url', !isImageDataUrl('https://example.com/x.jpg'))
  t('nor html dressed as one', !isImageDataUrl('data:text/html;base64,PGI+'))
  t('nor a data url with markup smuggled after the base64', !isImageDataUrl('data:image/jpeg;base64,AAAA<script>'))
}

console.log(nl + '-- one ceiling, both sides of the wire --')
{
  t('the chat is stricter than a note', CHAT_IMG_MAX_BYTES < MAX_BYTES)
  // Two constants would drift, and the failure is a picture that uploads and is refused
  // with nothing on screen to say which side said no.
  t('server.js imports the client\'s number rather than keeping its own',
    srv.includes("import { isImageDataUrl, dataUrlBytes, CHAT_IMG_MAX_BYTES }") &&
    srv.includes("dataUrlBytes(b.img) > CHAT_IMG_MAX_BYTES"))
  t('and the client checks it before sending', fs.readFileSync('src/main.js', 'utf8').includes('_imgBytes(data) > CHAT_IMG_MAX_BYTES'))
  t('quality is set once, not per call site', /export const JPEG_Q/.test(src) && JPEG_Q > 0 && JPEG_Q < 1)
}

console.log(nl + '-- the re-draw, and why --')
{
  // The same reason the profile-picture upload draws through a canvas: it drops EXIF,
  // including the GPS tag a phone photo carries.
  t('every file goes through a canvas', src.includes("canvas.toDataURL('image/jpeg'"))
  t('the reason is written down', src.includes('GPS'))
  // A transparent PNG flattened onto nothing comes out black where the page would show
  // the panel behind it.
  t('transparency lands on white, not black', src.includes("ctx.fillStyle = '#ffffff'"))
  t('a file it cannot read is null, not a throw', src.includes('img.onerror = () => resolve(null)'))
}

console.log(nl + '-- notes keep ids, never bytes --')
{
  // localStorage is ~5MB shared with the agent keys, whose loss is the most expensive bug
  // in CLAUDE.md. Two phone photos would spend most of that budget.
  t('the bytes are in IndexedDB', src.includes("const DB_NAME = 'hliq_img'") && src.includes('indexedDB'))
  t('and the reason is written down', src.includes('agent keys'))
  t('calnotes stores ids only', /const imgs  = cleanImgIds\(n\.imgs, MAX_NOTE_IMGS\)/.test(cal))
  t('no device without IndexedDB is broken by it, it just has no pictures',
    src.includes('if (!factory) return Promise.resolve(null)'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
