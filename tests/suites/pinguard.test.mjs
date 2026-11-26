// A dev PIN the server stopped accepting must not empty the page (src/pinguard.js).
// "why leaderboard just showing 5 addresses", then "now real is showing 0": a device kept
// sending the replaced PIN, the server's wrong-PIN lockout refused the owner's own IP, and the
// leaderboard — public, PIN or not — came back with nothing.
import { guardFetch, checkStoredPin } from '../../src/pinguard.js'
let pass = 0, fail = 0
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(ok ? '  PASS' : '  FAIL', n, ok ? '' : `→ ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`) }
const res = (status, body) => ({ status, ok: status >= 200 && status < 300, clone() { return this }, json: async () => body })

// A server that locks anyone sending a PIN, and answers the public board without one.
const calls = []
const server = async (url, init) => {
  const pin = init?.headers && (typeof init.headers.get === 'function' ? init.headers.get('x-lb-pin') : init.headers['x-lb-pin'])
  calls.push({ url, pin: pin ?? null })
  if (pin) return res(429, { error: 'too many wrong PINs — try again later' })
  return res(200, [{ addr: '0x1' }, { addr: '0x2' }])
}
let stored = '1234', locked = 0
const f = guardFetch(server, { clearPin: () => { stored = '' }, onLocked: () => locked++ })

let r = await f('/api/leaderboard', { headers: { 'x-lb-pin': '1234' } })
t('locked out with a PIN → the board still loads, without it', [r.status, (await r.json()).length], [200, 2])
t('… sent once with the PIN, once without', calls.map(c => c.pin), ['1234', null])
t('… and the stale PIN is forgotten, the person told once', [stored, locked], ['', 1])

calls.length = 0
r = await f('/api/leaderboard', { headers: new Headers({ 'x-lb-pin': 'x' }) })
t('a Headers object works the same', [r.status, calls.map(c => c.pin)], [200, ['x', null]])

calls.length = 0
const other = async () => res(429, { error: 'too many joins, try later' })
r = await guardFetch(other, { clearPin: () => { stored = 'KEPT-CLEARED' } })('/api/leaderboard/join', { headers: { 'x-lb-pin': 'p' } })
stored = 'still'
t('a 429 for another reason is left alone', r.status, 429)
r = await f('/api/x', {})
t('a request without a PIN is untouched', calls.map(c => c.pin), [null])

// At start, with dev mode on.
const verify = (status, body = {}) => async () => res(status, body)
let pin = 'old'
const clear = () => { pin = '' }
t('the stored PIN is still right → kept', [await checkStoredPin({ fetchImpl: verify(200), getPin: () => pin, clearPin: clear }), pin], ['ok', 'old'])
t('rejected → forgotten, so it is not sent on every refresh', [await checkStoredPin({ fetchImpl: verify(403), getPin: () => pin, clearPin: clear }), pin], ['stale', ''])
pin = 'old'
t('locked → forgotten too', [await checkStoredPin({ fetchImpl: verify(429, { error: 'too many wrong PINs' }), getPin: () => pin, clearPin: clear }), pin], ['locked', ''])
pin = 'old'
t('offline is not "wrong" → kept', [await checkStoredPin({ fetchImpl: async () => { throw new Error('net') }, getPin: () => pin, clearPin: clear }), pin], ['unknown', 'old'])
t('nothing stored → nothing asked', await checkStoredPin({ fetchImpl: async () => { throw new Error('should not ask') }, getPin: () => '', clearPin: clear }), 'none')

// The app installs it before anything fetches.
import fs from 'fs'
const CLI = fs.readFileSync('src/main.js', 'utf8')
t('main.js wraps fetch with it and checks the stored PIN at start', /window\.fetch = guardFetch\(window\.fetch\.bind\(window\)/.test(CLI) && /checkStoredPin\(\{ fetchImpl: window\.fetch/.test(CLI), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
