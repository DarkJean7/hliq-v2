// All-Accounts equity and Net PnL: both must come from ONE source, or the headline steps
// when it switches basis and two devices disagree.
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
const harness = (extra = '') => new Function(`
  const state = { isAllAccounts: true, fills: [] }
  const _maHiddenLoad = () => new Set()
  let _allAcctLastResults = []
  let _combinedSnap = null
  let _comboSrvLast = null
  let _comboPnlLast = null
  let _comboFillSig = null, _comboFillAt = 0
  const COMBO_SNAP_MAX_AGE_MS = 150000, COMBO_FILL_REFRESH_MS = 8000, COMBO_PNL_HOLD_MS = 20000
  // Telemetry only; the sandbox has no network and does not need it.
  const _comboPnlWatch = () => {}
  const _fetchCombinedSnap = async () => { fetches++ }
  let fetches = 0
  ${grab(cli, 'function _comboRefreshOnFills()')}
  ${grab(cli, 'function _combinedServerValue()')}
  ${grab(cli, 'function _combinedHeldValue()')}
  ${grab(cli, 'function _comboPnlSums()')}
  ${grab(cli, 'function _comboPnlHeld(nRows)')}
  return {
    setRows: (r) => { _allAcctLastResults = r },
    setSnap: (x) => { _combinedSnap = x },
    srv:  () => _combinedServerValue(),
    held: () => _combinedHeldValue(),
    sums: () => _comboPnlSums(),
    setFills: (f) => { state.fills = f },
    fetches: () => fetches,
  }
`)()

// ── 1. equity: the anchor swap on closing a position ─────────────────────────
const mk = (n, withLive = true) => Array.from({ length: n }, (_, i) => ({
  addr: '0x' + String(i).repeat(40).slice(0, 40), error: null,
  ...(withLive ? { _perpLive: 100 + i } : {}),
}))

const M = harness()
const SNAP = { accountValue: 3747.26, perpBase: 936, dayAgo: 3361, wallets: 9 }
M.setSnap(SNAP)
M.setRows(mk(9))

const live = mk(9).reduce((s, r) => s + r._perpLive, 0)
const v1 = M.srv()
t('a healthy set produces the server-anchored total',
  Math.abs(v1 - (SNAP.accountValue + (live - SNAP.perpBase))) < 1e-9, String(v1))
t('and it is held for reuse', Math.abs(M.held() - v1) < 1e-9)

// The heavy re-aggregate a close triggers used to rebuild every row without _perpLive.
M.setRows(mk(9, false))
t('a row with no live perp value still refuses to guess', M.srv() === null)
t('but the held value survives, so the headline does NOT jump to the other anchor',
  Math.abs(M.held() - v1) < 1e-9, String(M.held()))

const rows = mk(9); delete rows[4]._perpLive
M.setRows(rows)
t('one wallet short of a live tick blanks the server value', M.srv() === null)
t('the hold still covers it', M.held() != null)

M.setRows(mk(8))
t('a changed wallet count drops the hold rather than showing a stale total', M.held() === null)
t('and the server value is refused too, since the snapshot covers 9', M.srv() === null)

M.setRows(mk(9))
t('once live values return the server total comes back', Math.abs(M.srv() - v1) < 1e-9)

t('the heavy row builder emits _perpLive, so a rebuild is not a blank',
  /_portVal: _fastBase, _perpBase, _perpLive: _perpAcctVal,/.test(cli))
t('the fast WS tick still sets it too', cli.includes('r._perpLive     = perpNow'))

const bal = grab(cli, 'function _mobVRenderBalance(')
// The per-device sum was the third basis and it stepped: measured live, equity went
// $2,772.43 -> $2,973.80 and straight back, +$201.37, almost exactly the spot HYPE on those
// wallets, with leverage and margin unmoved. Up and back is a basis switch, not a market.
t('the combined view has exactly TWO bases now, not three',
  bal.includes('const _combo = state.isAllAccounts ? (_srvVal ?? _combinedHeldValue()) : null'))
t('the per-device sum is gone from the combined path',
  !bal.includes('_combinedHeldValue() ?? _rawVal'))
t('a single account still uses its own computation', bal.includes(") : _rawVal"))
t('with nothing authoritative it shows a dash rather than a third number',
  bal.includes("balEl.innerHTML = `<span style=\"color:var(--muted)\">—</span>`"))
t('and suppresses the "today" figure too, which would otherwise be computed off nothing',
  bal.includes('hist.length >= 2 && val != null'))
t('the existing spike filter tolerates 35%, so a 14% step passed straight through',
  grab(cli, 'function _comboEqFilter(val)').includes('0.35'))

// ── 2. Net PnL: server-anchored, bridged on live unrealized ──────────────────
// Nine wallets holding $10 unrealized each. The server saw $50 when it built the
// snapshot, so the live figure must carry the $40 difference.
// Each wallet holds $14 unrealized (main dex + a HIP-3 dex).
const wal = (n, opts = {}) => Array.from({ length: n }, (_, i) => ({
  addr: '0x' + String(i).repeat(40).slice(0, 40), error: null,
  unrealizedPnl: 14,
  ...(i === opts.noNet ? {} : { netPnl: 999 }),      // deliberately wrong per-row values
}))
const SNAP9 = { wallets: 9, pnlWallets: 9, settledPnl: -400, netPnl: -168, unrealBase: 50,
                realizedPnl: 1800, funding: -150, fees: 2050, updatedAt: Date.now() }

const P = harness()
P.setRows(wal(9))
P.setSnap(SNAP9)
const r1 = P.sums()
// settled from the server, live unrealized from here. Nothing has to line up.
t('Net PnL is the settled total plus live unrealized',
  Math.abs(r1.net - (-400 + 126)) < 1e-9, JSON.stringify(r1))
t('two devices with different local caches therefore agree', r1.net !== 9 * 999)
t('unrealized shown is the full figure, main + HIP-3', Math.abs(r1.unreal - 126) < 1e-9)

// THE BUG: unrealBase came from a plain clearinghouseState (main dex only) while the live
// figure includes HIP-3, so the old bridge moved by the HIP-3 unrealized whenever a HIP-3
// position appeared or briefly dropped out — with equity, anchored on main-dex perp value,
// barely moving.
t('the old unrealBase bridge is gone from the client',
  !grab(cli, 'function _comboPnlSums()').includes('unrealBase'))
t('Net PnL moves exactly as much as the unrealized beside it, and no more',
  (() => {
    const A = harness(); A.setSnap(SNAP9); A.setRows(wal(9))
    const before = A.sums()
    const bumped = wal(9).map(r => ({ ...r, unrealizedPnl: r.unrealizedPnl + 5 }))
    A.setRows(bumped)
    const after = A.sums()
    return Math.abs((after.net - before.net) - (after.unreal - before.unreal)) < 1e-9
  })())

// A snapshot short a wallet must not be used, and must NOT fall through to the row sum:
// the row sum is a different, per-device basis, and offering it just guarantees a step
// change when the real figure lands seconds later.
P.setSnap({ ...SNAP9, pnlWallets: 8 })
t('a snapshot that could not price every wallet falls back to the HELD server figure',
  Math.abs(P.sums().net - r1.net) < 1e-9, JSON.stringify(P.sums()))

P.setSnap({ ...SNAP9, wallets: 8, pnlWallets: 8 })
t('a snapshot for a different wallet set is refused too',
  Math.abs(P.sums().net - r1.net) < 1e-9)

// Cold: nothing from the server yet. The row sum must NOT be shown.
const R = harness()
R.setRows(wal(9))
R.setSnap(null)
t('with no server figure at all it reports nothing, rather than a per-device row sum',
  R.sums() === null)
t('the row sum is gone from the function entirely',
  !grab(cli, 'function _comboPnlSums()').includes('net += Number(r.netPnl)'))

// The hold only ever carries a SERVER-derived value forward.
const Q = harness()
Q.setRows(wal(9))
Q.setSnap(SNAP9)
const qv = Q.sums().net
Q.setSnap(null)
t('a server figure once seen is held when the snapshot goes away',
  Math.abs(Q.sums().net - qv) < 1e-9)
Q.setRows(wal(8))
t('but not across a change in wallet count', Q.sums() === null)

t('the card prefers the server figure over the recomputed one',
  bal.includes('const _cp = _comboPnlSums()') && bal.includes('_cp ? _cp.net : netPnl'))
t('and in the combined view with nothing to show it shows a dash, not a third basis',
  bal.includes('const _pnlMissing = _pnlNet && state.isAllAccounts && !_cp')
    && bal.includes('!_pnlMissing &&'))
t('the single-account fills gate does not leak into the combined view',
  bal.includes('!_pnlNet || state.isAllAccounts || state.fillsFull !== false'))
t('the combined summary sheet shows the SAME figure as the headline',
  cli.includes('const _cpAll      = _comboPnlSums()') && cli.includes('const totalNet    = _cpAll?.net ?? null'))

// ── every combined-view TOTAL must come from the one source ──────────────────
// The Portfolio tab was the last holdout: it re-derived Net PnL from the merged
// per-device fills, and in the combined view state.funding is [] so it had no funding at
// all. That is how it read +$45.92 while the header read -$283.
t('the Portfolio tab defers to the combined figure',
  cli.includes('const _cpP = state.isAllAccounts ? _comboPnlSums() : null')
    && cli.includes('if (_cpP) netPnl = _cpP.net'))
t('its Realized and Net Funding rows come from the same place',
  cli.includes('const dispRealized = _cpP?.parts ? _cpP.parts.realized : realizedPnl')
    && cli.includes('const dispFunding  = _cpP?.parts ? _cpP.parts.funding  : netFunding'))
t('so the funding row is no longer hidden by the combined view emptying state.funding',
  cli.includes('${dispFunding !== 0 ?'))
t('the settled parts travel with the figure',
  (() => {
    const A = harness(); A.setSnap(SNAP9); A.setRows(wal(9))
    const r = A.sums()
    return r.parts && r.parts.realized === 1800 && r.parts.funding === -150 && r.parts.fees === 2050
  })())
t('and the hold carries them too, so a blip does not blank the rows',
  (() => {
    const A = harness(); A.setSnap(SNAP9); A.setRows(wal(9)); A.sums()
    A.setSnap(null)
    return A.sums()?.parts?.realized === 1800
  })())
t('a single account is untouched — it keeps its own computation',
  cli.includes('state.isAllAccounts ? _comboPnlSums() : null'))

// ── 3. the server side ───────────────────────────────────────────────────────
t('the server accrues realized PnL, fees and funding per wallet',
  srv.includes('async function pnlAccrue(addr)'))
t('incrementally, not a full re-pull every refresh',
  grab(srv, 'async function pnlAccrue(addr)').includes('hlFillsSince(addr, st.lastFillTs)'))
t('and persisted, so a restart does not re-page every history',
  srv.includes('combined-pnl.json') && grab(srv, 'async function pnlAccrue(addr)').includes('pnlWrite(all)'))
t('funding is accrued from its own cursor',
  grab(srv, 'async function pnlAccrue(addr)').includes('startTime: st.lastFundingTs + 1'))
t('the snapshot carries a SETTLED total, with no unrealized in it to disagree about',
  srv.includes('settledPnl: realizedPnl + funding - fees'))
t('the old netPnl field is kept so an older cached client is not broken',
  srv.includes('netPnl: realizedPnl + unrealBase + funding - fees'))
const cc = grab(srv, 'async function computeCombined(addrs)')
t('a PnL failure costs the wallet its PnL, not its equity contribution', cc.includes("console.warn('[pnl]'"))
t('a rate limit aborts rather than silently under-counting', cc.includes('if (e.rateLimited) throw e'))
t('pnlWallets is counted so the client can tell a partial snapshot', cc.includes('pnlWallets++'))

// ── the settled half must describe the same instant as the unrealized half ───
// Unrealized is live; settled only moved on the 60s snapshot. Every grid close therefore
// understated Net PnL by the realized amount until the next refresh, and with grids cycling
// constantly it slid monotonically away while equity went wherever the market went.
const F = harness()
F.setSnap(SNAP9)
F.setRows(wal(9))
F.setFills([{ time: 1 }, { time: 2 }])
F.sums()                                  // first call just records the fingerprint
const before = F.fetches()
F.sums()
t('no fills, no extra fetch', F.fetches() === before)
F.setFills([{ time: 3 }, { time: 1 }, { time: 2 }])
F.sums()
t('a new fill forces the settled half to be refetched', F.fetches() === before + 1)
F.setFills([{ time: 4 }, { time: 3 }, { time: 1 }, { time: 2 }])
F.sums()
t('a burst of fills does not fire a burst of requests', F.fetches() === before + 1)

// Stale beyond the cap: a dash beats a number drifting further from the truth each second.
const G = harness()
G.setRows(wal(9))
G.setSnap({ ...SNAP9, updatedAt: Date.now() - 200_000 })
t('a stale snapshot is not shown', G.sums() === null)
G.setSnap({ ...SNAP9, updatedAt: Date.now() - 10_000 })
t('a fresh one is', G.sums() !== null)
t('the cap is on the snapshot age, not the wallet count',
  grab(cli, 'function _comboPnlSums()').includes('COMBO_SNAP_MAX_AGE_MS'))

// The equity hold is a FROZEN number, not a bridge — so it needs the same age cap Net PnL
// has, or a gap shows an equity that quietly stopped tracking the market.
const H = harness()
H.setSnap(SNAP)
H.setRows(mk(9))
H.srv()                                    // establishes the hold
t('the hold is usable while fresh', H.held() != null)
t('the hold records when it was taken', grab(cli, 'function _combinedServerValue()').includes('at: Date.now()'))
t('and it expires on the same cap as Net PnL',
  grab(cli, 'function _combinedHeldValue()').includes('COMBO_SNAP_MAX_AGE_MS'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
