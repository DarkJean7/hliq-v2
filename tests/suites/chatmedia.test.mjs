// Stickers and pictures in the global chat: what the server accepts, what it writes, and
// what happens to the bytes when a message goes. src/stickers.js, server.js, serve-prod.js.
import fs from 'fs'
import { STICKERS, isSticker, stickerChar, stickerLabel } from '../../src/stickers.js'

const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const sp  = fs.readFileSync('serve-prod.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

console.log(nl + '-- a sticker is a name, not a file --')
{
  t('there are enough to choose from', STICKERS.length >= 24)
  t('each has an id, a glyph and a label', STICKERS.every(s => s.id && s.char && s.label))
  t('ids are unique', new Set(STICKERS.map(s => s.id)).size === STICKERS.length)
  t('ids are plain — they travel in JSON and land in an onclick', STICKERS.every(s => /^[a-z0-9]{2,12}$/.test(s.id)))
  t('a known name is one of ours', isSticker('rocket') && isSticker(STICKERS[STICKERS.length - 1].id))
  t('anything else is not', !isSticker('nope') && !isSticker('') && !isSticker(null) && !isSticker('<img src=x>'))
  // A name we do not know must draw nothing, not a blank box that never explains itself.
  t('an unknown name draws nothing', stickerChar('nope') === '' && stickerLabel('nope') === '')
  t('a known one draws its glyph', stickerChar('rocket').length > 0)
}

console.log(nl + '-- one list, both sides --')
{
  // Two lists would drift, and a message carrying a name one side knows and the other does
  // not is a row that is blank forever.
  t('the server imports it rather than keeping its own', srv.includes("import { isSticker }") && srv.includes("from './src/stickers.js'"))
  t('and validates against it', /const sticker = isSticker\(b\.sticker\) \? b\.sticker : null/.test(srv))
  t('the client draws the picker from the same list', cli.includes("import { STICKERS, isSticker, stickerChar, stickerLabel }"))
  t('and refuses to render a name that is not in it', cli.includes('m.sticker && isSticker(m.sticker)'))
}

console.log(nl + '-- what the chat accepts --')
{
  const at   = srv.indexOf("POST /api/chat { name, text, addr?, img?, sticker? }")
  const post = srv.slice(at, srv.indexOf("POST /api/chat/remove", at))
  t('a data url that is not an image is refused', post.includes('if (!isImageDataUrl(b.img)'))
  // The client's canvas has exactly one output, so the chat takes exactly one format.
  // Accepting a png would mean writing bytes nothing re-drew into a served directory.
  t('and so is a png, which the writer would then refuse anyway',
    post.includes("!String(b.img).startsWith('data:image/jpeg;base64,')") && post.includes("error: 'expected a jpeg data url'"))
  t('one that is too big is refused with 413', /413, \{ error: 'image too large' \}/.test(post))
  // Pictures cost far more than messages and are rarer, so they get their own, meaner limit
  // on top of the 15/min the room already had.
  t('pictures have a limit of their own', post.includes('chatImgAllowed(ip)') && /hits\.length >= 12/.test(srv))
  t('and it is per hour, not per minute', /const now = Date\.now\(\), win = 3600_000/.test(srv))
  t('the message limit still applies to every message', post.includes('if (!chatAllowed(ip))'))
  // "Here is the chart" needs no caption.
  t('a picture alone is a message', post.includes("if (!text && !img && !sticker) return json(res, 400, { error: 'empty message' })"))
  t('and text still cannot be empty on its own', post.includes("error: 'empty message'"))
}

console.log(nl + '-- what it writes --')
{
  // The client re-draws every file through a canvas, whose only output is a JPEG. This is
  // what makes that true of what ARRIVED, into a directory the web server serves.
  t('the magic bytes are checked, not the claim', /buf\[0\] !== 0xFF \|\| buf\[1\] !== 0xD8 \|\| buf\[2\] !== 0xFF/.test(srv))
  t('the bytes go to disk under their own id', srv.includes("writeFileSync(join(CHAT_IMG_DIR, id + '.jpg'), buf)"))
  // chat.json is rewritten in full on every message; base64 in a row would make each
  // message a multi-megabyte write.
  t('and NOT into chat.json', /msg  = \{ id: [^}]*img, sticker, ts: Date\.now\(\) \}/.test(srv) && !/img: b\.img/.test(srv))
  t('the reason is written down', srv.includes('rewritten in full on every message'))
  t('a picture that will not write does not take the message with it', srv.includes("if (!img) return json(res, 400, { error: 'could not read that image' })"))
}

console.log(nl + '-- and what it throws away --')
{
  // The feed keeps 300 messages; without this the directory keeps every picture ever posted.
  t('a picture no retained message points at is deleted', srv.includes('function sweepChatImgs(list)'))
  t('the sweep runs when one arrives', /if \(img\) sweepChatImgs\(list\)/.test(srv))
  t('and when the operator deletes a message', /saveChat\(keep\)\s*\n\s*\/\/[^\n]*\n\s*sweepChatImgs\(keep\)/.test(srv))
  t('it only ever unlinks a .jpg in that one directory',
    /if \(!f\.endsWith\('\.jpg'\)\) continue/.test(srv) && srv.includes('unlinkSync(join(CHAT_IMG_DIR, f))'))
  t('a missing directory is not an error', srv.includes('if (!existsSync(CHAT_IMG_DIR)) return'))
}

console.log(nl + '-- serving them --')
{
  const route = sp.slice(sp.indexOf('Global-chat pictures'), sp.indexOf('Coin icon cache/proxy'))
  t('reads only, like /pfp/', route.includes("if (req.method !== 'GET')"))
  // The id pattern has no dot and no slash, so the path cannot be walked out of.
  t('the id is the path validation', /\/\^\[a-z0-9\]\{8,24\}\$\/\.test\(id\)/.test(route))
  t('a bad id is 400 and reads nothing', /res\.writeHead\(400\)\.end\(\); return/.test(route))
  // These are the one thing on this origin a stranger put there. A browser that sniffed
  // one as HTML would be running it on our domain.
  t('served as an image and nothing else', route.includes("'Content-Type': 'image/jpeg'") && route.includes("'X-Content-Type-Options': 'nosniff'"))
  t('and sandboxed on top of that', route.includes("'Content-Security-Policy': \"default-src 'none'; sandbox\""))
  t('the reason is written down', route.includes('sniffed'))
}

console.log(nl + '-- the composer --')
{
  t('a sticker button and a picture button', cli.includes('window.__chatStickers()') && cli.includes("document.getElementById('chatFile').click()"))
  t('the file input takes pictures only', cli.includes('id="chatFile" accept="image/*"'))
  // Staging a sticker behind Send is a step no chat app makes you take.
  t('a sticker sends itself', /window\.__chatSticker = function\(id\) \{[\s\S]{0,200}window\.__chatSend\(id\)/.test(cli))
  t('a picture waits, with a way to take it off again', cli.includes('window.__chatDropImg()') && cli.includes('function _chatSetPending'))
  t('only one picture is pending at a time', /let _chatPendingImg = null/.test(cli))
  const openChat = cli.slice(cli.indexOf('window.__openChat = function()'), cli.indexOf('window.__closeChat = function()'))
  t('and opening the room starts with nothing attached', openChat.includes('_chatPendingImg = null'))
  t('a sent picture opens full screen', cli.includes('window.__imgView('))
  t('sharing the calendar viewer\'s markup rather than a second one', cli.includes("ov.className = 'img-view'") && css.includes('.img-view {'))
}

console.log(nl + '-- drawn as media, not as text --')
{
  t('a sticker is big enough to read as one', /\.chat-sticker \{[^}]*font-size: 52px/.test(css))
  t('a picture is bounded so one message cannot own the feed', /\.chat-img \{[^}]*max-width: min\(260px, 72%\)/.test(css))
  t('an optimistic row shows what it is uploading, not a gap', cli.includes('m.imgData ? m.imgData'))
  t('and a stored one is read back by id from the server', cli.includes("'/chatimg/' + m.img"))
  t('an id from a message is checked before it becomes a url', /\/\^\[a-z0-9\]\{8,24\}\$\/\.test\(m\.img\)/.test(cli))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
