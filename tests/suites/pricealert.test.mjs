// Price alerts fired server-side, driven against the real checkPriceAlerts.
import fs from 'fs'
const srv = fs.readFileSync('notify-server.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const wf  = fs.readFileSync('.github/workflows/deploy.yml', 'utf8').replace(/\r\n/g, '\n')

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

let sent = []
let saved = null
let mids = { BTC: '100000', HYPE: '75' }
let midsThrow = false

const M = new Function('webpush', 'hlInfo', 'saveSubs', 'console', `
  ${grab(srv, 'function sanitizeAlerts(list)')}
  ${srv.slice(srv.indexOf('const PA_DEVICE_AWAKE_MS'), srv.indexOf('async function checkPriceAlerts'))}
  ${grab(srv, 'async function checkPriceAlerts(subs)')}
  return { checkPriceAlerts, sanitizeAlerts, PA_DEVICE_AWAKE_MS }
`)(
  { sendNotification: async (_s, p) => { sent.push(JSON.parse(p)) } },
  async () => { if (midsThrow) throw new Error('HL down'); return mids },
  (s) => { saved = s },
  { log() {}, warn() {} },
)

const mkSub = (over = {}) => ({
  subscription: { endpoint: 'https://push.example/abc' },
  priceAlerts: [{ id: 'a1', coin: 'BTC', dir: 'above', price: 90000 }],
  seenAt: 0,
  ...over,
})

const run = async (subs) => { sent = []; saved = null; await M.checkPriceAlerts(subs); return subs }

// ── the whole point: it fires when the app is NOT open ───────────────────────
let subs = [mkSub()]
await run(subs)
t('an alert fires when the device has not checked in', sent.length === 1, JSON.stringify(sent))
t('the notification names the coin and the level',
  /BTC/.test(sent[0]?.title ?? '') && /90000/.test(sent[0]?.title ?? ''))
t('it shares the tag the in-app one uses, so they replace rather than stack',
  sent[0]?.tag === 'hliq-price-a1')
t('a fired alert is removed from the watch list', subs[0].priceAlerts.length === 0)
t('and remembered, so the app can show it as triggered', subs[0].paFired.includes('a1'))
t('the change is persisted', saved !== null)

// ── it must NOT fire while the app is awake and firing for itself ────────────
subs = [mkSub({ seenAt: Date.now() })]
await run(subs)
t('a device that just checked in handles its own alerts', sent.length === 0)
t('and the alert stays armed', subs[0].priceAlerts.length === 1)

subs = [mkSub({ seenAt: Date.now() - 10 * 60_000 })]
await run(subs)
t('a device quiet for ten minutes is treated as asleep', sent.length === 1)

// ── the conditions ───────────────────────────────────────────────────────────
subs = [mkSub({ priceAlerts: [{ id: 'b', coin: 'BTC', dir: 'above', price: 200000 }] })]
await run(subs)
t('an unmet "above" does not fire', sent.length === 0 && subs[0].priceAlerts.length === 1)

subs = [mkSub({ priceAlerts: [{ id: 'c', coin: 'BTC', dir: 'below', price: 200000 }] })]
await run(subs)
t('a met "below" fires', sent.length === 1)

subs = [mkSub({ priceAlerts: [{ id: 'd', coin: 'NOSUCH', dir: 'above', price: 1 }] })]
await run(subs)
t('a coin with no price is left alone, not treated as a hit',
  sent.length === 0 && subs[0].priceAlerts.length === 1)

subs = [mkSub({ mutedUntil: Date.now() + 60_000 })]
await run(subs)
t('mute is honoured', sent.length === 0 && subs[0].priceAlerts.length === 1)

// ── failure must never lose an alert ─────────────────────────────────────────
midsThrow = true
subs = [mkSub()]
await run(subs)
t('Hyperliquid being down fires nothing and disarms nothing',
  sent.length === 0 && subs[0].priceAlerts.length === 1)
midsThrow = false

const M2 = new Function('webpush', 'hlInfo', 'saveSubs', 'console', `
  ${grab(srv, 'function sanitizeAlerts(list)')}
  ${srv.slice(srv.indexOf('const PA_DEVICE_AWAKE_MS'), srv.indexOf('async function checkPriceAlerts'))}
  ${grab(srv, 'async function checkPriceAlerts(subs)')}
  return { checkPriceAlerts }
`)(
  { sendNotification: async () => { throw new Error('boom') } },
  async () => mids, () => {}, { log() {}, warn() {} },
)
subs = [mkSub()]
await M2.checkPriceAlerts(subs)
t('a failed push keeps the alert armed for the next pass', subs[0].priceAlerts.length === 1)
t('and does not claim it fired', !(subs[0].paFired ?? []).length)

// ── input hardening (this is user-supplied JSON) ─────────────────────────────
const ok = M.sanitizeAlerts([{ id: 'x', coin: 'BTC', dir: 'above', price: 1 }])
t('a valid alert survives', ok.length === 1)
t('a missing id is dropped', M.sanitizeAlerts([{ coin: 'BTC', dir: 'above', price: 1 }]).length === 0)
t('a non-numeric price is dropped', M.sanitizeAlerts([{ id: 'x', coin: 'BTC', price: 'abc' }]).length === 0)
t('a negative price is dropped', M.sanitizeAlerts([{ id: 'x', coin: 'BTC', price: -5 }]).length === 0)
t('a hostile coin string is dropped',
  M.sanitizeAlerts([{ id: 'x', coin: '../../etc/passwd\n', price: 1 }]).length === 0)
t('dir defaults to above rather than undefined',
  M.sanitizeAlerts([{ id: 'x', coin: 'BTC', price: 1 }])[0].dir === 'above')
t('the list is capped', M.sanitizeAlerts(Array.from({ length: 500 },
  (_, i) => ({ id: 'i' + i, coin: 'BTC', dir: 'above', price: 1 }))).length === 50)
t('a non-array is not a crash', M.sanitizeAlerts(null).length === 0)

// ── wiring ───────────────────────────────────────────────────────────────────
t('price alerts run before the health fan-out', srv.indexOf('checkPriceAlerts(subs)') < srv.indexOf('const allAddrs'))
t('a price failure cannot skip the health checks',
  grab(srv, 'async function checkAndNotify()').includes("catch (e) { console.warn('[price] check failed:"))
t('allMids is fetched without a user field, which HL rejects',
  grab(srv, 'async function checkPriceAlerts(subs)').includes("hlInfo({ type: 'allMids' })"))
t('the heartbeat endpoint exists', srv.includes("app.post('/notify/seen'"))
t('subscribing hands back what fired while the app was away', srv.includes('firedIds: prev?.paFired ?? []'))

t('the client sends its armed alerts', cli.includes('const priceAlerts = _paLoad().filter(a => a && !a.fired && a.coin)'))
t('editing an alert re-syncs it to the server',
  grab(cli, 'function _paSave(a)').includes('_registerPushDebounced()'))
t('a hidden tab does not claim to be watching',
  grab(cli, 'async function _paHeartbeat()').includes("document.visibilityState !== 'visible'"))
t('alerts fired while away are marked locally, not re-notified',
  cli.includes('function _paMarkFired(ids)') && cli.includes('a.fired = true'))
t('and acknowledged so they are not replayed forever', cli.includes('ackFired: _paPendingAck'))

t('CI finally ships notify-server.js', wf.includes('rsync -azc -i notify-server.js'))
t('and restarts hliq-notify only when it changed',
  /syncnotify\.outputs\.changed == 'yes'[\s\S]{0,120}pm2 restart hliq-notify/.test(wf))
t('bouncing notify does not touch the bots', !/hliq-notify[\s\S]{0,80}hliq-strat/.test(wf))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
