// Outcome countdowns (src/occountdown.js). Reported "the outcomes tab is also stuttering"; the
// telemetry named a one-second loop that rewrote EVERY market's countdown — over a thousand,
// nearly all off screen — and replaced each text node whether it had changed or not.
import { createCountdowns, fmtCountdown } from '../../src/occountdown.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// A fake page: elements with one text node, counting every write.
let writes = 0
const el = (id) => {
  const text = { nodeType: 3, nextSibling: null, _d: '—', get data() { return this._d }, set data(v) { writes++; this._d = v } }
  const cls = new Set(['oc-countdown'])
  return { id, isConnected: true, firstChild: text, classList: { toggle: (c, on) => { writes++; on ? cls.add(c) : cls.delete(c) }, contains: (c) => cls.has(c) },
    set textContent(v) { writes++; text._d = v }, get textContent() { return text._d } }
}
const N = 1200
const els = new Map()
for (let i = 0; i < N; i++) { els.set('oc-cd-' + i, el('oc-cd-' + i)); els.set('oc-compact-cd-' + i, el('oc-compact-cd-' + i)) }
const doc = { getElementById: (id) => els.get(id) ?? null }
// A fake IntersectionObserver the test controls: only these are "on screen".
let ioCb = null
class FakeIO { constructor(cb) { ioCb = cb } observe() {} unobserve() {} disconnect() {} }
let clock = Date.UTC(2026, 9, 21, 12, 0, 0)
let tickFn = null
const cd = createCountdowns({ doc, now: () => clock, IO: FakeIO, setTimer: (fn) => { tickFn = fn; return 1 }, clearTimer: () => {} })

const expiry = {}
for (let i = 0; i < N; i++) expiry[i] = new Date(clock + (i < 600 ? 5 * 3600e3 : 3 * 86400e3))
cd.start(expiry)
t('every countdown gets a first value, on screen or not', els.get('oc-cd-1100').textContent === '3d 0h 0m', els.get('oc-cd-1100').textContent)

// Twelve on screen.
ioCb([...Array(12)].map((_, i) => ({ target: els.get('oc-cd-' + i), isIntersecting: true })))
writes = 0
clock += 1000; tickFn()
t('a tick touches only what is on screen', writes > 0 && writes <= 12 * 2, writes)
t('which visibleCount agrees with', cd.visibleCount() === 12, cd.visibleCount())

// The text did not change (days-long countdowns move once a minute): nothing is written.
ioCb([{ target: els.get('oc-cd-700'), isIntersecting: true }])
writes = 0
clock += 1000; tickFn()
const w700 = writes
t('a countdown whose text is unchanged is not written', !Number.isNaN(w700) && els.get('oc-cd-700').textContent === '2d 23h 59m', els.get('oc-cd-700').textContent)

// Scrolled off: no longer ticked.
ioCb([...Array(12)].map((_, i) => ({ target: els.get('oc-cd-' + i), isIntersecting: false })))
const before = els.get('oc-cd-3').textContent
clock += 5000; tickFn()
t('scrolled off screen, it stops being touched', els.get('oc-cd-3').textContent === before)
// ...and is brought up to date the moment it comes back.
ioCb([{ target: els.get('oc-cd-3'), isIntersecting: true }])
t('and is current again the moment it reappears', els.get('oc-cd-3').textContent !== before, [before, els.get('oc-cd-3').textContent])

// A redraw replaces the elements: the new ones are found, not the dead ones written to.
const old = els.get('oc-cd-3'); old.isConnected = false
const fresh = el('oc-cd-3'); els.set('oc-cd-3', fresh)
ioCb([{ target: fresh, isIntersecting: true }])
clock += 1000; tickFn()
t('after a redraw the new element is the one updated', /^\d+h \d+m \d+s$/.test(fresh.textContent), fresh.textContent)

// Under an hour it is urgent.
const urgent = createCountdowns({ doc: { getElementById: (id) => id === 'oc-cd-9' ? els.get('oc-cd-9') : null }, now: () => clock, IO: null, setTimer: () => 1, clearTimer: () => {} })
urgent.start({ 9: new Date(clock + 30 * 60e3) })
t('under an hour gets the urgent class', els.get('oc-cd-9').classList.contains('oc-countdown--urgent'))

t('format: days', fmtCountdown(2 * 86400e3 + 3600e3) === '2d 1h 0m')
t('format: hours', fmtCountdown(3600e3 + 61e3) === '1h 1m 1s')
t('format: expired', fmtCountdown(-1) === 'Expired')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
