// Paper accounts on the server (src/paperhost.js): sync, leases, and the server advancing a
// store with the app closed — using src/paper.js itself, as the app does.
import fs from 'fs'
import os from 'os'
import path from 'path'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = '\n'
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b))

const H = await import('../../src/paperhost.js')
const P = await import('../../src/paper.js')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paperhost-'))
let clock = 1_800_000_000_000
const host = H.createPaperHost({ dir, now: () => clock })
const SECRET = 'ab'.repeat(32), CLIENT = 'devicea1'
const store = (o = {}) => JSON.stringify({ balance: 1000, positions: [], orders: [], fills: [], equity: [], deposited: 1000, ledger: [], nextOid: 2000, created: 0, ...o })

console.log(nl + '-- owners and keys --')
t('an owner is a 64-hex secret, hashed; anything else is refused', H.ownerOf(SECRET)?.length === 40 && H.ownerOf('short') === null && H.ownerOf(SECRET) !== SECRET.slice(0, 40))
t('only paper keys are synced', H.PAPER_KEY_RE.test('hliq_paper_v2') && H.PAPER_KEY_RE.test('hliq_paper_s_abc123') && H.PAPER_KEY_RE.test('hliq_paper_accts') && !H.PAPER_KEY_RE.test('hliq_agent_key_0xabc') && !H.PAPER_KEY_RE.test('hliq_paper_lb_secret'))
t('a store key names its account', H.slotOfKey('hliq_paper_v2') === 'main' && H.slotOfKey('hliq_paper_chal_v2') === 'challenge' && H.slotOfKey('hliq_paper_s_xyz') === 'xyz' && H.slotOfKey('hliq_paper_accts') === null)
const api = fs.readFileSync(new URL('../../src/api.js', import.meta.url), 'utf8')
t('the renamed HIP-3 tickers match the app\'s (src/api.js)', Object.entries(H.HIP3_RENAMES).every(([k, v]) => api.includes(`'${k}': '${v}'`)) && (api.match(/^\s+'[a-z]+:[A-Z0-9]+': '/gm) ?? []).length === Object.keys(H.HIP3_RENAMES).length)

console.log(nl + '-- sync --')
{
  const up = host.sync({ secret: SECRET, client: CLIENT, push: { hliq_paper_v2: store(), hliq_paper_accts: '[]', hliq_agent_key_0x1: 'SECRET KEY' } })
  t('the first sync uploads what the device has', up.ok && up.revs.hliq_paper_v2 > 0 && up.revs.hliq_paper_accts > 0)
  t('and never takes a key that is not a paper account\'s (an agent key stays on the device)', !('hliq_agent_key_0x1' in up.revs) && !fs.readFileSync(host.ownerFile(H.ownerOf(SECRET)), 'utf8').includes('SECRET KEY'))
  const r1 = up.revs.hliq_paper_v2
  const w = host.sync({ secret: SECRET, client: CLIENT, seen: { hliq_paper_v2: r1 }, push: { hliq_paper_v2: store({ balance: 900 }) } })
  t('a write from a device that saw the latest lands', w.ok && w.revs.hliq_paper_v2 > r1 && !w.conflicts.length)
  const stale = host.sync({ secret: SECRET, client: CLIENT, seen: { hliq_paper_v2: r1 }, push: { hliq_paper_v2: store({ balance: 5 }) } })
  t('one from a device that had NOT seen it is refused, and the server\'s version is sent back', stale.conflicts.join() === 'hliq_paper_v2' && JSON.parse(stale.changed.hliq_paper_v2).balance === 900)
  const pull = host.sync({ secret: SECRET, client: 'deviceb22', seen: {} })
  t('a fresh device pulls everything', JSON.parse(pull.changed.hliq_paper_v2).balance === 900 && pull.changed.hliq_paper_accts === '[]')
  const quiet = host.sync({ secret: SECRET, client: CLIENT, seen: pull.revs })
  t('nothing new: nothing sent', quiet.ok && !Object.keys(quiet.changed).length)
  const del = host.sync({ secret: SECRET, client: CLIENT, seen: pull.revs, push: { hliq_paper_accts: null } })
  const seenB = host.sync({ secret: SECRET, client: 'deviceb22', seen: pull.revs })
  t('a deletion travels as a deletion', del.ok && 'hliq_paper_accts' in seenB.changed && seenB.changed.hliq_paper_accts === null)
  t('a bad owner or client is refused', !host.sync({ secret: 'x', client: CLIENT }).ok && !host.sync({ secret: SECRET, client: '!' }).ok)
}

console.log(nl + '-- the server advances what the app is not running --')
{
  const S2 = 'cd'.repeat(32)
  const resting = store({ orders: [{ oid: 7, coin: 'BTC', isBuy: true, sz: 1, limitPx: 90, reduceOnly: false, isTrigger: false, triggerPx: 0, tpsl: '', timestamp: 0 }] })
  host.sync({ secret: S2, client: CLIENT, push: { hliq_paper_v2: resting, hliq_paper_s_alt1: resting } })
  const market = { marks: { BTC: '89' }, assets: { BTC: { szDecimals: 5, maxLeverage: 40 } }, funding: {} }
  t('it prices only what is held or ordered', [...host.dueCoins()].join() === 'BTC')
  // The app is running the main account: it holds that lease.
  host.sync({ secret: S2, client: CLIENT, hold: 'hliq_paper_v2' })
  // Another tab of the same device (/portfolios) syncs holding nothing: that is not a release.
  host.sync({ secret: S2, client: CLIENT })
  t('a sync holding nothing does NOT release the app\'s lease (only an explicit release does)', host.read(H.ownerOf(S2)).lease?.key === 'hliq_paper_v2')
  const tk = host.tick(market)
  const rec = host.read(H.ownerOf(S2))
  const main = JSON.parse(rec.kv.hliq_paper_v2.v), alt = JSON.parse(rec.kv.hliq_paper_s_alt1.v)
  t('a resting buy at 90 fills on the server when BTC trades at 89 — in the account the app is NOT running', alt.positions[0]?.coin === 'BTC' && alt.positions[0].szi === 1 && alt.positions[0].entryPx === 90 && !alt.orders.length, alt)
  t('the account the app holds is left to the app', main.orders.length === 1 && !main.positions.length)
  t('the fill is recorded as the app records it (maker fee, its own price)', alt.fills[0]?.px === '90' && near(Number(alt.fills[0].fee), 90 * 1.5e-4) && tk.events.some(e => e.slot === 'alt1'))
  // The app closes: no sync for longer than the lease. Now the server advances the main one too.
  clock += H.LEASE_MS + 1000
  host.tick(market)
  const main2 = JSON.parse(host.read(H.ownerOf(S2)).kv.hliq_paper_v2.v)
  t('once the lease lapses (app closed), the server advances that account too', main2.positions[0]?.szi === 1 && !main2.orders.length)
  // A stop on the position, hit: the stop fills and the position is closed.
  const withStop = JSON.parse(host.read(H.ownerOf(S2)).kv.hliq_paper_v2.v)
  withStop.orders.push({ oid: 9, coin: 'BTC', isBuy: false, sz: 1, limitPx: 0, reduceOnly: true, isTrigger: true, triggerPx: 80, tpsl: 'sl', timestamp: 0 })
  const r = host.read(H.ownerOf(S2))
  host.sync({ secret: S2, client: CLIENT, seen: Object.fromEntries(Object.entries(r.kv).map(([k, x]) => [k, x.rev])), push: { hliq_paper_v2: JSON.stringify(withStop) } })
  host.tick({ ...market, marks: { BTC: '79' } })
  const main3 = JSON.parse(host.read(H.ownerOf(S2)).kv.hliq_paper_v2.v)
  t('a stop is triggered on the server: closed at the mark less slippage, as in the app', !main3.positions.length && main3.fills[0]?.dir === 'Close Long' && near(Number(main3.fills[0].px), 79 * (1 - 3e-4)), main3.fills[0])
  t('the leased-then-released account keeps its revisions moving (the app will pull them)', host.read(H.ownerOf(S2)).kv.hliq_paper_v2.rev > r.kv.hliq_paper_v2.rev)
  // Liquidation with the app closed: a 40× long that falls through its maintenance.
  const lev = store({ balance: 100, positions: [{ coin: 'BTC', szi: 40, entryPx: 100, margin: 100, leverage: 40, isIsolated: true }] })
  const S3 = 'ef'.repeat(32)
  host.sync({ secret: S3, client: CLIENT, push: { hliq_paper_v2: lev } })
  host.tick({ ...market, marks: { BTC: '97' } })
  const liq = JSON.parse(host.read(H.ownerOf(S3)).kv.hliq_paper_v2.v)
  t('an isolated position past its liquidation price is liquidated with the app closed', !liq.positions.length && near(liq.balance, 0), liq)
  t('nothing left to advance: nothing to price', ![...host.dueCoins()].includes('ETH'))
}

console.log(nl + '-- a person\'s own actions on an account a server bot runs (/paper/op) --')
{
  const S4 = '9a'.repeat(32)
  host.sync({ secret: S4, client: CLIENT, push: { hliq_paper_s_cp1: store() } })
  const mk = { marks: { BTC: '100' }, assets: { BTC: { szDecimals: 4, maxLeverage: 40 } }, funding: {} }
  // Two separate requests, as the server's two workers would take them: the leverage set by
  // the first is kept with the account for the second.
  t('setting leverage is an action', host.op(S4, 'cp1', 'paperSetLeverage', ['BTC', 7], mk).ok)
  const o = host.op(S4, 'cp1', 'paperOrder', [{ orders: [{ b: true, p: '101', s: '1', r: false, t: { limit: { tif: 'Ioc' } } }] }, 'BTC', {}], mk)
  const acct = JSON.parse(host.read(H.ownerOf(S4)).kv.hliq_paper_s_cp1.v)
  t('an order lands in that account, at the leverage set a request earlier', o.ok && acct.positions[0]?.szi === 1 && acct.positions[0].leverage === 7, acct.positions)
  t('only the app\'s own actions are taken: nothing else, and nothing named otherwise', !host.op(S4, 'cp1', 'paperReset', [], mk).ok && !host.op(S4, 'cp1', 'constructor', [], mk).ok && !host.op(S4, 'cp1', 'paperOrder', 'x', mk).ok)
  // The app's side: on a server-run account, each action is also sent.
  const sent = []
  const mem = {}
  const prevLS = globalThis.localStorage
  globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v) }, removeItem: k => { delete mem[k] } }
  mem.hliq_paper_s_cp1 = store()
  P.setPaperMarks({ BTC: '100' }); P.paperBind('cp1')
  P.setPaperRemote((slot) => (slot === 'cp1' ? (x) => sent.push(x) : null))
  P.paperSetLeverage('BTC', 3)
  P.paperOrder({ orders: [{ b: true, p: '101', s: '0.5', r: false, t: { limit: { tif: 'Ioc' } } }] }, 'BTC')
  t('on a server-run account the app still applies an order at once, and sends it, in order', P.paperStore().positions[0]?.szi === 0.5 && sent.map(x => x.fn).join() === 'paperSetLeverage,paperOrder' && sent[1].args[1] === 'BTC', sent)
  P.paperBind('main')
  sent.length = 0
  P.paperOrder({ orders: [{ b: true, p: '101', s: '0.1', r: false, t: { limit: { tif: 'Ioc' } } }] }, 'BTC')
  t('on an account the app runs itself, nothing is sent', !sent.length)
  P.setPaperRemote(null); globalThis.localStorage = prevLS
}

console.log(nl + '-- the app\'s side: the tick gate --')
{
  const mem = {}
  globalThis.localStorage = { getItem: k => mem[k] ?? null, setItem: (k, v) => { mem[k] = String(v) }, removeItem: k => { delete mem[k] } }
  mem.hliq_paper_v2 = store({ orders: [{ oid: 7, coin: 'BTC', isBuy: true, sz: 1, limitPx: 90, reduceOnly: false, isTrigger: false, triggerPx: 0, tpsl: '', timestamp: 0 }] })
  P.paperBind('main'); P.setPaperMarks({ BTC: '89' }); P.setPaperAssets({ BTC: { szDecimals: 5, maxLeverage: 40 } })
  P.setPaperTickGate(key => key !== 'hliq_paper_v2')
  t('without its lease the app does not advance the store (the server is)', P.paperTick().length === 0 && JSON.parse(mem.hliq_paper_v2).orders.length === 1)
  P.setPaperTickGate(() => true)
  t('with it, it does, exactly as before', P.paperTick().length === 1 && P.paperStore().positions[0]?.szi === 1)
  P.setPaperTickGate(null)
  // A portfolio bot's account: the app refuses manual trading on it, with the reason.
  mem.hliq_paper_accts = JSON.stringify([{ slot: 'bot1', name: 'PF · X', createdAt: 1 }])
  t('an account is tagged as a bot\'s, and untagged', P.paperAcctTag('bot1', 'L-ABC') && P.paperAcctBot('bot1') === 'L-ABC' && P.paperAcctTag('bot1', null) && P.paperAcctBot('bot1') === null)
  P.paperAcctTag('bot1', 'L-ABC')
  P.setPaperReadOnly((slot) => (P.paperAcctBot(slot) ? 'run by a bot' : null))
  P.paperBind('bot1')
  const refused = P.paperOrder({ orders: [{ b: true, p: '100', s: '1', r: false, t: { limit: { tif: 'Ioc' } } }] }, 'BTC')
  t('manual orders on it are refused, saying why', refused.response.data.statuses[0].error === 'run by a bot' && !P.paperDeposit(5).ok && !P.paperAdjustMargin('BTC', 1, true).ok)
  P.paperBind('main')
  t('other accounts trade as before', !P.paperOrder({ orders: [{ b: true, p: '100', s: '0.1', r: false, t: { limit: { tif: 'Ioc' } } }] }, 'BTC').response.data.statuses[0].error)
  P.setPaperReadOnly(null)
  t('the store key for an account', P.paperStoreKey('main') === 'hliq_paper_v2' && P.paperStoreKey('abc') === 'hliq_paper_s_abc')
}

// Reported: "i closed the paper account positions and they are staying open". The server
// refetched every price for every action, Hyperliquid answered 429, the close was refused —
// and the app took the refusal for success, synced, and the server's copy put them back.
console.log(nl + '-- an action is priced even when Hyperliquid refuses --')
{
  let calls = 0
  const ok = async (b) => { calls++; return b.type === 'allMids' ? { BTC: '101' } : [{ universe: [{ name: 'BTC', szDecimals: 5 }] }, [{ funding: '0' }]] }
  const busy = async () => { calls++; throw new Error('HTTP 429') }
  const now = Date.now()
  const prev = { marks: { BTC: '100' }, assets: {}, funding: {}, metaAt: now, metaDexes: [], marksAt: now - 5_000 }
  t('recent prices that cover the coin are reused: nothing fetched', (await H.marketFor(busy, new Set(['BTC']), prev, now)) === prev && calls === 0)
  const older = { ...prev, marksAt: now - 60_000 }
  const got = await H.marketFor(ok, new Set(['BTC']), older, now)
  t('older ones are refreshed when Hyperliquid answers', got.marks.BTC === '101' && got.marksAt >= now)
  t('and kept when it refuses, up to two minutes old', (await H.marketFor(busy, new Set(['BTC']), older, now)) === older)
  let threw = null
  try { await H.marketFor(busy, new Set(['BTC']), { ...prev, marksAt: now - 600_000 }, now) } catch (e) { threw = e.message }
  t('past that, the action is refused rather than priced at a stale mark', threw === 'HTTP 429')
  threw = null
  try { await H.marketFor(busy, new Set(['ETH']), prev, now) } catch (e) { threw = e.message }
  t('a coin it has no price for at all is never guessed', threw === 'HTTP 429')
}

console.log(nl + '-- and the app does not take a refusal for success --')
{
  const { createPaperBots } = await import('../../src/paperbots.js')
  const answers = [{ status: 503, j: { ok: false, error: 'HTTP 429' } }, { status: 503, j: { ok: false, error: 'HTTP 429' } }, { status: 200, j: { ok: true, result: {} } }]
  let n = 0, done = 0, failed = []
  const fetchImpl = async () => { const a = answers[Math.min(n++, answers.length - 1)]; return { ok: a.status < 300, status: a.status, json: async () => a.j } }
  const B = createPaperBots({ secret: () => 'x', slot: () => 's1', fetchImpl, retryMs: [1, 1, 1], onOpsDone: () => done++, onOpFailed: (...a) => failed.push(a) })
  B.send('s1')({ fn: 'paperOrder', args: [{}, 'BTC'] })
  t('while it is being delivered the account is pending: the server copy does not overwrite it', B.pendingKeys().size === 1)
  await new Promise(r => setTimeout(r, 50))
  t('a server refusal (5xx) is retried until it lands', n === 3 && !failed.length && done === 1, { n, failed })
  t('and only then is the account released to sync', B.pendingKeys().size === 0)
  n = 0; done = 0; failed = []
  answers.length = 0; answers.push({ status: 503, j: { ok: false, error: 'HTTP 429' } })
  B.send('s1')({ fn: 'paperOrder', args: [{}, 'BTC'] })
  await new Promise(r => setTimeout(r, 50))
  t('if it never lands, it says so (with why) instead of letting the action quietly undo itself', failed.length === 1 && failed[0][1] === 'paperOrder' && /429/.test(failed[0][2]) && n === 4, { n, failed })
  n = 0; failed = []
  answers.length = 0; answers.push({ status: 400, j: { ok: false, error: 'not an action' } })
  B.send('s1')({ fn: 'nope', args: [] })
  await new Promise(r => setTimeout(r, 50))
  t('a refusal from paper itself is final: not retried', n === 1 && failed.length === 1 && failed[0][2] === 'not an action', { n, failed })
}

fs.rmSync(dir, { recursive: true, force: true })
console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
