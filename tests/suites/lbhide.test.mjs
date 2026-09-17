// Extracts the REAL hidden-list helpers from server.js and drives them against a temp file,
// then checks the filtering/visibility rules structurally.
import fs from 'fs'
import os from 'os'
import path from 'path'

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

const tmp = path.join(os.tmpdir(), `lbhide-${Date.now()}.json`)
const api = new Function('fs', 'TMP', `
  const { existsSync, readFileSync, writeFileSync } = fs
  const LB_HIDDEN_FILE = TMP
  ${grab('function lbReadHidden()')}
  ${grab('function lbWriteHidden(')}
  ${grab('function lbSetHidden(')}
  return { lbReadHidden, lbWriteHidden, lbSetHidden }
`)(fs, tmp)

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const A = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa'
const Bd = '0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb'

// ── set / clear round-trip, case-insensitive ─────────────────────────────────
try { fs.unlinkSync(tmp) } catch {}
t('missing file reads as empty', api.lbReadHidden().length === 0)
api.lbSetHidden(A, true)
t('hide stores lowercased', api.lbReadHidden()[0] === A.toLowerCase())
t('lookup is case-insensitive', api.lbReadHidden().includes(A.toLowerCase()))
api.lbSetHidden(A.toLowerCase(), true)
t('hiding twice does not duplicate', api.lbReadHidden().length === 1)
api.lbSetHidden(Bd, true)
t('second address added', api.lbReadHidden().length === 2)
api.lbSetHidden(A.toUpperCase(), false)
t('unhide works regardless of case', !api.lbReadHidden().includes(A.toLowerCase()))
t('unhide leaves the other alone', api.lbReadHidden().includes(Bd.toLowerCase()))
api.lbSetHidden(A, false)
t('unhiding a non-hidden address is a no-op', api.lbReadHidden().length === 1)

// ── corrupt file must not throw ──────────────────────────────────────────────
fs.writeFileSync(tmp, 'not json')
t('corrupt file reads as empty', api.lbReadHidden().length === 0)
fs.writeFileSync(tmp, '{"not":"an array"}')
t('non-array reads as empty', api.lbReadHidden().length === 0)
try { fs.unlinkSync(tmp) } catch {}

// ── the visibility rules, read off the real handlers ─────────────────────────
const listH  = src.slice(src.indexOf("path === '/api/leaderboard'"), src.indexOf("GET /api/leaderboard/stats"))
const statsH = src.slice(src.indexOf("path === '/api/leaderboard/stats'"), src.indexOf("path === '/api/leaderboard/stats'") + 1400)
const hideH  = src.slice(src.indexOf("path === '/api/leaderboard/hide'"), src.indexOf("path === '/api/leaderboard/hide'") + 1800)

t('address list filters hidden for the public', listH.includes('addrs.filter(e => !hidden.has'))
t('address list flags hidden for a PIN holder', listH.includes('{ ...e, hidden: true }'))
t('stats withholds hidden unless admin', statsH.includes('isAdmin || !hidden.has'))
t('stats flags hidden rows for admin', statsH.includes('{ ...r, hidden: true }'))
t('admin is decided by the PIN header, not a query flag',
  listH.includes("(req.headers['x-lb-pin'] ?? '') === LB_PIN"))
t('an unset LB_PIN cannot make someone admin', listH.includes('LB_PIN && '))

// The route now also takes the OWNER's signature — leaving the board is a hide, and coming
// back is showing your own row. Still fails closed: no PIN and no signature is a refusal.
t('hide route fails closed with no PIN and no signature',
  hideH.includes("if (!b.signature) return json(res, LB_PIN ? 403 : 503"))
t('hide route checks the PIN before anything else is trusted',
  hideH.includes("const pinOk = !!LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN"))
t('an owner signature must be fresh', hideH.includes('Math.abs(Date.now() - ts) > 10 * 60 * 1000'))
t('and from that address, over that exact choice',
  hideH.includes('const msg = lbVisibilityMessage(b.addr, !!b.hidden, ts)')
    && hideH.includes("if (signer.toLowerCase() !== String(b.addr).toLowerCase())"))
t('hide route validates the address', hideH.includes('if (!isAddr(b.addr))'))
t('hide route coerces to boolean', hideH.includes('!!b.hidden'))

// ── hidden replaced removed ──────────────────────────────────────────────────
t('the hidden list has its own file', src.includes("LB_HIDDEN_FILE = join(__dirname, 'leaderboard-hidden.json')"))
t('and there is no removed list beside it', !src.includes('LB_REMOVED_FILE'))
t('hiding does not drop the account from the tracked list', !grab('function lbSetHidden(').includes('lbWriteList'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
