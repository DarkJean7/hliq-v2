// The three reported flickers, each driven against the real code.
import fs from 'fs'
const api = fs.readFileSync('src/api.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

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

// ── 1. HIP-3 positions vanishing when one dex call fails ─────────────────────
// Two HIP-3 dexes, each holding a position. Fail one, and its row must survive.
const ADDR = '0x1111111111111111111111111111111111111111'
const metas = [
  { universe: [{ name: 'BTC' }] },
  { universe: [{ name: 'xyz:SPCX' }] },
  { universe: [{ name: 'flx:GOLD' }] },
]
let failDex = null
let calls = []
const infoClient = {
  clearinghouseState: async ({ dex }) => {
    calls.push(dex ?? 'main')
    if (!dex) return { assetPositions: [{ position: { coin: 'BTC', szi: '1' } }] }
    if (dex === failDex) throw new Error('HL 429')
    return { assetPositions: [{ position: { coin: dex === 'xyz' ? 'SPCX' : 'GOLD', szi: '2' } }] }
  },
}
const M = new Function('infoClient', `
  const HL_FAN_CONCURRENCY = 4
  const _hip3Rename = (c) => c
  ${grab(api, 'async function _pool(')}
  ${grab(api, 'function _hip3DexNames(')}
  ${grab(api, 'export async function fetchClearinghouseState(').replace('export ', '')}
  // The real cache and its accessor, not a stand-in: the bug WAS in the cache.
  const _hip3Cache = new Map()
  const HIP3_CACHE_MAX = 32
  ${grab(api, 'function _hip3For(')}
  return { fetchClearinghouseState, _hip3Cache }
`)(infoClient)

const coins = (st) => (st.assetPositions ?? []).map(p => p.position.coin).sort()

let st = await M.fetchClearinghouseState(ADDR, metas)
t('a healthy fan-out returns main + every HIP-3 position',
  JSON.stringify(coins(st)) === JSON.stringify(['BTC', 'flx:GOLD', 'xyz:SPCX']), JSON.stringify(coins(st)))

failDex = 'xyz'
st = await M.fetchClearinghouseState(ADDR, metas)
t('a dex that 429s keeps its last-known position instead of dropping the row',
  JSON.stringify(coins(st)) === JSON.stringify(['BTC', 'flx:GOLD', 'xyz:SPCX']), JSON.stringify(coins(st)))

failDex = 'flx'
st = await M.fetchClearinghouseState(ADDR, metas)
t('the OTHER dex failing is covered the same way',
  JSON.stringify(coins(st)) === JSON.stringify(['BTC', 'flx:GOLD', 'xyz:SPCX']), JSON.stringify(coins(st)))

// A dex that ANSWERS with nothing really has nothing — that must retire the cache, or a
// closed position would haunt the UI forever.
failDex = null
infoClient.clearinghouseState = async ({ dex }) => {
  if (!dex) return { assetPositions: [{ position: { coin: 'BTC', szi: '1' } }] }
  if (dex === 'xyz') return { assetPositions: [] }              // genuinely closed
  return { assetPositions: [{ position: { coin: 'GOLD', szi: '2' } }] }
}
st = await M.fetchClearinghouseState(ADDR, metas)
t('a dex that answers "no positions" DOES clear them — closing must stick',
  JSON.stringify(coins(st)) === JSON.stringify(['BTC', 'flx:GOLD']), JSON.stringify(coins(st)))

t('the cache is per dex, not one shared list', api.includes('entry.byDex[dex]'))

// ── 1b. one wallet's fan-out evicting another's cache ────────────────────────
// The reported "equity spikes randomly for a few seconds and fixes itself", in single
// accounts as well as the combined view. The cache used to be ONE slot with an `addr`
// field, so any call for a different wallet emptied it — the combined view fans ten
// wallets through here, and a leaderboard row does it while a single account is open.
// The next tick that skips the fan-out then found the slot belonging to someone else and
// returned the main dex ALONE. That is not "no HIP-3 positions", it is "we did not look",
// and the account value dropped by exactly the HIP-3 portion until the next fan-out.
const WA = '0xAAAA000000000000000000000000000000000001'
const WB = '0xBBBB000000000000000000000000000000000002'
infoClient.clearinghouseState = async ({ user, dex }) => {
  if (!dex) return { assetPositions: [{ position: { coin: 'BTC', szi: '1' } }] }
  // Only wallet WA holds anything on a HIP-3 dex.
  if (user !== WA) return { assetPositions: [] }
  return { assetPositions: [{ position: { coin: dex === 'xyz' ? 'SPCX' : 'GOLD', szi: '2' } }] }
}

st = await M.fetchClearinghouseState(WA, metas)                    // WA fans, and is cached
t('wallet A fans and holds two HIP-3 positions',
  JSON.stringify(coins(st)) === JSON.stringify(['BTC', 'flx:GOLD', 'xyz:SPCX']), JSON.stringify(coins(st)))

await M.fetchClearinghouseState(WB, metas)                         // WB fans — used to evict WA

st = await M.fetchClearinghouseState(WA, null)                     // WA, on a tick that skips the fan
t('a skipped fan-out still finds A’s own positions after B was fetched',
  JSON.stringify(coins(st)) === JSON.stringify(['BTC', 'flx:GOLD', 'xyz:SPCX']), JSON.stringify(coins(st)))

st = await M.fetchClearinghouseState(WB, null)
t('and B, which genuinely holds none, is still told nothing',
  JSON.stringify(coins(st)) === JSON.stringify(['BTC']), JSON.stringify(coins(st)))

t('every wallet keeps its own entry', M._hip3Cache.has(WA.toLowerCase()) && M._hip3Cache.has(WB.toLowerCase()))
t('and addresses are matched case-insensitively',
  (await M.fetchClearinghouseState(WA.toLowerCase(), null)).assetPositions.length === 3)

// Bounded, or a long session across many wallets grows it without limit.
for (let i = 0; i < 40; i++) await M.fetchClearinghouseState('0xc' + String(i).padStart(39, '0'), null)
t('the cache is capped', M._hip3Cache.size <= 32, M._hip3Cache.size)

// ── 2. the account avatar rebuilt on every 5s render ─────────────────────────
const A = new Function(`
  const _mobVAvatarHtml = (addr, size) => '<img src="/pfp/' + addr + '" width="' + size + '">'
  ${grab(cli, 'function _avatarSet(')}
  return _avatarSet
`)()
let writes = 0
const el = { _html: '', dataset: {}, set innerHTML(v) { writes++; this._html = v }, get innerHTML() { return this._html } }
A(el, ADDR, 50)
t('the first render draws the avatar', writes === 1)
for (let i = 0; i < 20; i++) A(el, ADDR, 50)      // twenty 5s ticks
t('twenty further ticks rebuild it zero times', writes === 1, `${writes} writes`)
A(el, '0x3333333333333333333333333333333333333333', 50)
t('switching account does redraw it', writes === 2)
A(el, '0x3333333333333333333333333333333333333333', 24)
t('a different size redraws it too', writes === 3)
delete el.dataset.avatarKey
A(el, '0x3333333333333333333333333333333333333333', 24)
t('clearing the key forces a redraw, which is how an upload takes effect', writes === 4)
t('the upload path really does clear it',
  cli.includes("delete avatarEl.dataset.avatarKey"))
t('nothing writes the avatar container directly any more',
  !/avatarEl\.innerHTML = _mobVAvatarHtml/.test(cli))

// ── 3. Net PnL computed from a 14-day window ─────────────────────────────────
const load = cli.slice(cli.indexOf('const applyFills = ('), cli.indexOf('// 2d. outcomeMeta'))
t('fill coverage is tracked', load.includes('state.fillsFull = full'))
t('the fast 14-day paint is marked partial',
  /applyFills\(recent\)(?!\s*,)/.test(load) && !load.includes('applyFills(recent, true)'))
t('only the all-time fetch marks coverage full', load.includes('applyFills(full, true)'))
t('a late partial response cannot clobber the full history',
  load.includes('if (state.fillsFull && !full) return'))

const bal = grab(cli, 'function _mobVRenderBalance(')
t('Net PnL is not printed from a partial single-account history',
  bal.includes('state.fillsFull !== false'))
// HL's own figure joins the short-circuits: it needs no fill history either.
t('unrealized PnL is unaffected — it needs no fill history, so both gates short-circuit on it',
  bal.includes('!_pnlNet || state.isAllAccounts || _hlPnl != null || state.fillsFull !== false')
    && bal.includes('_pnlMissing = _pnlNet &&'))
t('an empty slot shows a dash rather than staying blank', bal.includes("upEl.textContent = '—'"))
t('a previously correct value is left alone rather than overwritten with a wrong one',
  bal.includes("} else if (upEl && !upEl.textContent.trim()) {"))

// ── 4. dev mode toggled off then on left the switch lying ────────────────────
const dev = grab(cli, 'function _applyDevMode()')
t('the MOBILE switch is resynced too, not just the desktop one',
  dev.includes("getElementById('mobDevModeToggle')") && dev.includes('mchk.checked = on'))
t('the mobile switch actually has that id to find', cli.includes("'mobDevModeToggle'"))
t('changing dev mode repaints the Strats tab instead of needing a reload',
  dev.includes("_mobVActiveTab === 'strategies'") && dev.includes('_mobVRenderContent()'))
t('the desktop run row is refreshed too', dev.includes('updateAllStrategyButtons()'))

const tgl = grab(cli, 'window.toggleDevMode = async function(wantOn)')
t('cancelling the PIN says so rather than silently reverting',
  tgl.includes('Dev mode not activated'))
t('every failure path resyncs the switches — one that does not leaves a lying toggle',
  (tgl.match(/_applyDevMode\(\)/g) ?? []).length >= 5)
t('only a verified PIN sets the flag',
  tgl.indexOf('status !== 200') < tgl.indexOf("setItem('hliq_dev', '1')"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
