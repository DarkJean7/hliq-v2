// Paper sync (src/papersync.js): leaving the app hands its account back to the server — even when
// a routine sync is already on its way. That release used to be dropped (`if (busy) return`),
// leaving the account leased to an app that was gone until the lease expired; the browser test
// caught it on a slow CI runner, where a timer sync overlapped the hide (2026-10-16).
import { startPaperSync } from '../../src/papersync.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), key: i => [...m.keys()][i] ?? null, get length() { return m.size } } }

const calls = []
let gate = null
const fetchImpl = async (url, opts) => {
  const body = JSON.parse(opts.body)
  calls.push(body)
  if (gate) await gate                                   // hold the first request open
  return { json: async () => ({ ok: true, revs: {}, changed: {}, lease: body.hold }) }
}
let release
gate = new Promise(r => { release = r })
const s = startPaperSync({ holdKey: () => 'hliq_paper_v2', storage: mem(), fetchImpl, every: () => 1e9 })
await new Promise(r => setTimeout(r, 10))               // the first (timer) sync is now in flight, holding
t('a sync is in flight, holding the account', calls.length === 1 && calls[0].hold === 'hliq_paper_v2')
await s.syncNow({ release: true })                      // the app is hidden mid-sync
t('the release is not sent on top of it', calls.length === 1)
gate = null; release()
for (let i = 0; i < 50 && calls.length < 2; i++) await new Promise(r => setTimeout(r, 10))
t('it is sent the moment that sync lands — not dropped', calls.length === 2 && calls[1].hold === null && calls[1].release === true, calls.map(c => [c.hold, c.release]))
s.stop()

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
