// Deleting a global-chat message in dev mode.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n-- only an operator can delete --')
const ep = srv.slice(srv.indexOf("path === '/api/chat/remove'"), srv.indexOf("path === '/api/chat/remove'") + 1400)
t('the endpoint exists', !!ep)
t('it takes the LB_PIN dev mode is already earned with', ep.includes("req.headers['x-lb-pin']"))
t('or an ADMIN_TOKEN bearer', ep.includes('ADMIN_TOKEN && tok === ADMIN_TOKEN'))
t('anything else is refused', ep.includes("if (!authed) return json(res, 403, { error: 'forbidden' })"))
t('a missing id is a bad request, not a silent no-op', ep.includes("return json(res, 400, { error: 'missing id' })"))
t('the id is length-capped like every other input', ep.includes(".slice(0, 40)"))
t('deleting an id that is already gone is not an error', ep.includes('return json(res, 200, { ok: true, removed: 0 })'))
t('and does not write a second tombstone',
  ep.indexOf('removed: 0') < ep.indexOf('tombs.push'))
t('why authors cannot delete their own is recorded', srv.includes('chat has no accounts, so "mine" would mean whatever name the client claimed'))

console.log('\n-- the removal reaches everyone, not just the deleter --')
// The poll is incremental, so dropping the message from the file alone would leave it on
// every screen that already had it until a full reload.
t('a tombstone is written', srv.includes('tombs.push({ id, ts: Date.now() })'))
t('the incremental poll carries the ones the caller has not seen',
  srv.includes('loadChatTombs().filter(x => Number(x.ts) > since)'))
t('a full load needs none - the message is simply absent', srv.includes('const deleted = since ?'))
t('tombstones expire, so the file cannot grow forever', srv.includes('const CHAT_TOMB_TTL  = 24 * 3600e3'))
t('and expiry is applied on read, not only on write',
  grab(srv, 'function loadChatTombs()').includes('now - Number(x.ts ?? 0) < CHAT_TOMB_TTL'))
t('the store is gitignored - it is server state', fs.readFileSync('.gitignore', 'utf8').includes('chat-deleted.json'))

console.log('\n-- the client applies them --')
const poll = grab(cli, 'async function _chatPoll(full)')
t('deleted ids are removed from the local list', poll.includes('_chatMsgs = _chatMsgs.filter(m => !drop.has(m.id))'))
t('and it repaints even when no new message arrived', poll.includes('if (full || msgs.length || gone.length)'))
// Otherwise the same tombstones arrive on every tick for a day.
t('the poll clock advances on a deletion-only tick',
  poll.includes('else if (gone.length && j.now) _chatLastTs = Math.max(_chatLastTs, Number(j.now))'))

console.log('\n-- the button --')
const ren = grab(cli, 'function _chatRender(forceBottom)')
t('it is dev-mode only', ren.includes('const _mod = isDev()'))
t('and absent otherwise', ren.includes('${_mod && m.id'))
t('an optimistic message has no id yet, so it gets none', ren.includes("!String(m.id).startsWith('tmp')"))
t('each row is addressable, so the right one disappears', ren.includes('id="chatMsg-${esc(m.id)}"'))
const del = grab(cli, 'window.__chatDelete = async function(id, btn)')
t('it re-checks dev mode before doing anything', del.includes('if (!isDev()) return'))
t('it asks first, since this cannot be undone', del.includes('_appConfirm({'))
t('and says the message goes for everyone', del.includes('It disappears for everyone'))
t('the PIN is sent as the server expects', del.includes("'x-lb-pin': _lbGetPin()"))
t('the message is dropped locally rather than waiting a poll', del.includes('_chatMsgs = _chatMsgs.filter(m => m.id !== id)'))
t('a rejected PIN says so plainly', del.includes('Dev PIN rejected'))
t('a failure restores the button', del.includes('btn.disabled = false; btn.textContent = was'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
