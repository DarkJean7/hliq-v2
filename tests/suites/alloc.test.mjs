// Pull the REAL _freeMarginUsd + _allocationSlices out of main.js and run them against
// stubbed globals, so this tests the shipped code rather than a copy of it.
//
// The wheel used to total two things: margin behind open positions, and free cash. On a real
// account that is a minority of it. Reported with the numbers attached — about $6,800 of
// combined equity against a wheel reading $2,737.75 — and the missing $4,100 was in the two
// places it could not see: margin held by resting orders, and spot tokens. So most of what is
// asserted below is that the wheel now adds up to the account.
import fs from 'fs'
import { orderMarginByCoin, spotByCoin, SLICE_DUST } from '../../src/alloc.js'
import { isSpotCoin } from '../../src/format.js'

const src = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (name) => {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`${name} not found`)
  // walk braces from the first { after the signature
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error(`${name}: unbalanced`)
}

let state = {}
let mids  = {}
const _posMarkPx  = () => 0
const _coinMaxLev = () => 10
const _lbIsOutcome = c => typeof c === 'string' && (c[0] === '+' || c[0] === '#' || /^o\d/.test(c))
const _ocSidePrice = () => 0
const _spotMid    = (c) => mids[c] ?? 0
const _maHiddenLoad = () => new Set()
const _watchSpotNameMap = null
let _allAcctLastResults = []

// Every helper the slice builder leans on, taken from the shipped source rather than
// re-implemented — a copy of _orderMarginReported here would pass while the real one was
// broken, which is the whole thing this file exists to prevent.
const NAMES = ['_freeMarginUsd', '_allocSpotMid', '_allocSpotBalances', '_allocLevOf',
               '_orderMarginReported', '_allocationSlices']
const body = NAMES.map(grab).join('\n') + '\nreturn { ' + NAMES.join(', ') + ' }'
const built = new Function(
  'state', '_posMarkPx', '_coinMaxLev', '_lbIsOutcome', '_ocSidePrice', '_spotMid',
  '_maHiddenLoad', '_allAcctLastResults', 'orderMarginByCoin', 'spotByCoin', 'SLICE_DUST',
  'isSpotCoin', '_watchSpotNameMap', body)
const call = () => built(
  new Proxy({}, { get: (_, k) => state[k] }), _posMarkPx, _coinMaxLev, _lbIsOutcome,
  _ocSidePrice, _spotMid, _maHiddenLoad, _allAcctLastResults,
  orderMarginByCoin, spotByCoin, SLICE_DUST, isSpotCoin, _watchSpotNameMap)
const _allocationSlices = () => call()._allocationSlices()

let pass = 0, fail = 0
const t = (name, cond, extra = '') => cond
  ? (pass++, console.log('  PASS', name))
  : (fail++, console.log('  FAIL', name, extra))
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

const pos = (coin, szi, marginUsed, positionValue, uPnl) => ({
  position: { coin, szi: String(szi), marginUsed: String(marginUsed),
              positionValue: String(positionValue), unrealizedPnl: String(uPnl),
              leverage: { value: '1' } },
})

// ── with positions and free cash ──────────────────────────────────────────────
state = {
  perpState: { withdrawable: '250', assetPositions: [
    pos('HYPE', 1, 510.79, 5107.95, 125.17),
    pos('PUMP', -1, 234.10, 2341.05, -954.11),
  ]},
  spotState: { balances: [{ coin: 'USDC', total: '100', hold: '40' }] },
}
let r = _allocationSlices()
t('free = perp withdrawable + unheld spot USDC', near(r.free, 310), `got ${r.free}`)
t('used = sum of position margin', near(r.used, 744.89), `got ${r.used}`)
t('total = used + free', near(r.total, 1054.89), `got ${r.total}`)
t('free slice appended', r.slices.length === 3)
t('free slice is pinned LAST', r.slices.at(-1).isFree === true)
t('free slice carries no notional/PnL', r.slices.at(-1).notional === 0 && r.slices.at(-1).uPnl === 0)
t('assets still sorted by margin desc', r.slices[0].coin === 'HYPE' && r.slices[1].coin === 'PUMP')
t('hasAny true', r.hasAny === true)
const pcts = r.slices.map(s => (s.margin / r.total) * 100)
t('percentages sum to 100', near(pcts.reduce((a, b) => a + b, 0), 100), `got ${pcts.reduce((a,b)=>a+b,0)}`)
t('HYPE share is of the NEW total (was 46.8% of margin-only)',
  Math.abs(pcts[0] - 48.42) < 0.01, `got ${pcts[0].toFixed(2)}`)

// ── no free cash: behaviour must be exactly as before ─────────────────────────
state = { perpState: { withdrawable: '0', assetPositions: [pos('HYPE', 1, 100, 1000, 5)] },
          spotState: { balances: [] } }
r = _allocationSlices()
t('no free slice when free = 0', r.slices.length === 1 && !r.slices[0].isFree)
t('total unchanged when free = 0', near(r.total, 100))

// ── free cash but NO positions: empty state must still win ────────────────────
state = { perpState: { withdrawable: '5000', assetPositions: [] }, spotState: { balances: [] } }
r = _allocationSlices()
t('hasAny false with cash only', r.hasAny === false)

// ── negative / missing withdrawable must not produce a negative slice ─────────
state = { perpState: { withdrawable: '-12', assetPositions: [pos('X', 1, 50, 500, 0)] },
          spotState: { balances: [{ coin: 'USDC', total: '10', hold: '99' }] } }
r = _allocationSlices()
t('negative withdrawable clamps to 0 (no free slice)', r.free === 0 && r.slices.length === 1)

// ── spot USDC fully on hold contributes nothing ───────────────────────────────
state = { perpState: { withdrawable: '0', assetPositions: [pos('X', 1, 50, 500, 0)] },
          spotState: { balances: [{ coin: 'USDC', total: '80', hold: '80' }] } }
r = _allocationSlices()
t('held spot USDC is not free', r.free === 0)

console.log('\n-- margin held by resting orders is money too --')
{
  // The exact shape of the reported gap: a position, a stack of resting orders, and almost
  // nothing withdrawable. Before this, the wheel showed the position margin and called the
  // rest of the account missing.
  const ord = (coin, side, sz, px, extra = {}) => ({ coin, side, sz: String(sz), limitPx: String(px), ...extra })
  state = {
    perpState: {
      withdrawable: '1.98',
      marginSummary: { accountValue: '980.30', totalMarginUsed: '268.27' },
      assetPositions: [pos('ZRO', -100, 268.27, 2682.7, -40)],
    },
    spotState: { balances: [] },
    openOrders: [
      ord('HYPE', 'B', 6.51, 92.102),
      ord('HYPE', 'B', 6.66, 90.033),
      ord('SOL',  'B', 4.7,  112.29),
      ord('ZRO',  'B', 91.1, 1.0465, { reduceOnly: true }),   // closes, posts nothing
      ord('ZRO',  'A', 50,   1.2,    { isPositionTpsl: true }),
    ],
  }
  r = _allocationSlices()
  // accountValue - totalMarginUsed - withdrawable. That residual IS the reserved margin, and
  // on a live wallet it agreed with the per-order sum to the cent over 18 orders.
  t('the account residual is what the total comes to', near(r.orders, 980.30 - 268.27 - 1.98, 1e-9), `got ${r.orders}`)
  t('and the wheel totals the whole account', near(r.total, r.used + r.orders + r.spot + r.free, 1e-9))
  const hype = r.slices.find(s => s.coin === 'HYPE')
  const sol  = r.slices.find(s => s.coin === 'SOL')
  t('a coin with orders and no position gets a slice', !!hype && !!sol)
  t('and it is attributed, not lumped', hype.ordMargin > 0 && sol.ordMargin > 0)
  t('the reserve splits by notional', hype.ordMargin > sol.ordMargin, `${hype.ordMargin} vs ${sol.ordMargin}`)
  t('an orders-only coin reports no position', hype.longs === 0 && hype.shorts === 0)
  t('the order count is on the slice', hype.ordCount === 2 && sol.ordCount === 1)
  // A reduce-only order closes something that already exists, and a position TP/SL is the
  // same. Counting either would inflate the reserve by the whole size of every stop resting.
  const zro = r.slices.find(s => s.coin === 'ZRO')
  t('reduce-only and TP/SL post no margin of their own', !(zro.ordMargin > 0), String(zro.ordMargin))
  t('a position keeps its own margin', near(zro.margin, 268.27))
}

console.log('\n-- reserved margin nothing explains is still shown --')
{
  // The orders list lags the clearinghouse state by a tick, and in the combined view by up to
  // five minutes. Folding an unexplained reserve into free margin would say it is spendable,
  // which is the exact lie this change exists to undo.
  state = {
    perpState: { withdrawable: '10', marginSummary: { accountValue: '500', totalMarginUsed: '100' },
                 assetPositions: [pos('BTC', 1, 100, 1000, 0)] },
    spotState: { balances: [] },
    openOrders: [],
  }
  r = _allocationSlices()
  t('it gets its own slice', r.slices.some(s => s.isOrders))
  t('worth what the account said', near(r.orders, 390))
  t('free margin stays what can actually be withdrawn', near(r.free, 10))
  t('and it is not counted twice', near(r.total, 100 + 390 + 10))
}

console.log('\n-- spot holdings are part of the account --')
{
  mids = { HYPE: 93.5695, KNTQ: 0.28223 }
  state = {
    perpState: { withdrawable: '0', marginSummary: { accountValue: '100', totalMarginUsed: '100' },
                 assetPositions: [pos('HYPE', 1, 100, 1000, 0)] },
    spotState: { balances: [
      { coin: 'USDC', total: '50', hold: '50' },
      { coin: 'HYPE', total: '3.81743312', entryNtl: '300' },
      { coin: 'KNTQ', total: '199.8656' },
      { coin: 'DUST', total: '0.0000001' },
    ]},
    openOrders: [],
  }
  r = _allocationSlices()
  t('spot is counted', near(r.spot, 3.81743312 * 93.5695 + 199.8656 * 0.28223, 1e-6), `got ${r.spot}`)
  t('and reaches the total', near(r.total, r.used + r.orders + r.spot + r.free, 1e-9))
  const spotSlices = r.slices.filter(s => s.isSpot)
  t('one slice per token', spotSlices.length === 2)
  // USDC is cash and is already counted as free margin; a second slice for it would be the
  // same dollars twice.
  t('USDC is not one of them', !spotSlices.some(s => s.coin === 'USDC'))
  t('a dust balance is left off the wheel', !spotSlices.some(s => s.coin === 'DUST'))
  t('a spot slice carries its token amount', near(spotSlices.find(s => s.coin === 'HYPE').size, 3.81743312))
  t('with a cost basis it shows PnL', near(spotSlices.find(s => s.coin === 'HYPE').uPnl, 3.81743312 * 93.5695 - 300, 1e-6))
  t('without one it claims none', spotSlices.find(s => s.coin === 'KNTQ').uPnl === 0)
  // The same coin held as a perp position AND as spot is two different things in two
  // different places, so it is two slices.
  t('spot HYPE does not merge into the HYPE position',
    r.slices.filter(s => s.coin === 'HYPE').length === 2)

  // An account holding nothing but spot used to get "no open positions to allocate".
  state = { perpState: { withdrawable: '0', assetPositions: [] },
            spotState: { balances: [{ coin: 'KNTQ', total: '100' }] }, openOrders: [] }
  t('a spot-only account is not an empty one', _allocationSlices().hasAny === true)
  mids = {}
}

console.log('\n-- All Accounts reads the rows, not state.spotState --')
{
  // Real spot tokens are kept OFF state.spotState in the combined view (they would
  // double-count into its free-margin sum) and live on each wallet's row instead. A renderer
  // that only reads state is how the Spot tab shipped broken twice.
  mids = { KNTQ: 0.25 }
  _allAcctLastResults = [
    { addr: '0xa', label: 'One', spotBalances: [{ coin: 'KNTQ', total: '100' }] },
    { addr: '0xb', label: 'Two', spotBalances: [{ coin: 'KNTQ', total: '40' }] },
    { addr: '0xc', label: 'Bad', error: 'rate limited', spotBalances: [{ coin: 'KNTQ', total: '999' }] },
  ]
  state = {
    isAllAccounts: true,
    perpState: { withdrawable: '5', _orderMargin: 77, assetPositions: [], marginSummary: {} },
    spotState: { balances: [] },
    openOrders: [],
  }
  r = _allocationSlices()
  t('a wallet\'s spot tokens reach the wheel', near(r.spot, 140 * 0.25), `got ${r.spot}`)
  t('the same token on two wallets is one slice', r.slices.filter(s => s.isSpot).length === 1)
  t('tagged with the accounts holding it',
    [...r.slices.find(s => s.isSpot).accts].sort().join(',') === 'One,Two')
  t('a wallet that errored is left out', !near(r.spot, (140 + 999) * 0.25))
  // The single-wallet residual cannot work here: this accountValue is the sum of wallet
  // TOTALS, so it already contains spot. Each row carries its own and _aggPerpState sums them.
  t('reserved margin comes from the summed rows', near(r.orders, 77))
  mids = {}
  _allAcctLastResults = []
}

console.log('\n-- the health ring is the way in, and it has to work --')
{
  const CSS = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')
  const RND = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')
  const HTM = fs.readFileSync('index.html', 'utf8')
  const at = src.indexOf('window.__openAllocation')
  const fn = src.slice(at, src.indexOf('\n}', at) + 2)

  // The dead click. It guarded on a visible `.sidebar-item[data-tab="allocation"]` before it
  // would switch the desktop tab — and that row was DELETED when the sidebar was trimmed,
  // because the ring became the way in. The guard could never pass, so every press fell
  // through to the mobile navigator and did nothing at all.
  t('there is no Allocation row in the sidebar any more', !/data-tab="allocation"/.test(HTM))
  t('so opening it must not require one', !/item && item\.offsetParent !== null/.test(fn))
  t('the tab panel is what it checks', fn.includes("document.getElementById('tab-allocation')"))
  t('and it switches the desktop tab directly', fn.includes("switchTab('allocation', null)"))
  t('highlighting a sidebar row only if one happens to exist',
    fn.includes("if (item && typeof setSidebarActive === 'function')"))
  t('mobile still has its own path', fn.includes("window.mobVGoTab('allocation')"))
  t('why it was dead is written down', src.includes('the guard could never pass'))

  // The caption sat inside a flex ROW, so it reserved width even at opacity 0 and pushed the
  // donut off centre — then appeared beside it on hover rather than under it.
  t('the ring has no caption beside it', !RND.includes('ov-ring-cta') && !CSS.includes('.ov-ring-cta'))
  t('the wrap is still a centring flex box', /\.ov-ring-wrap \{[^}]*justify-content: center/.test(CSS))
  t('the ring says it is pressable without words',
    /\.ov-ring-wrap\.health-open:hover \{ background/.test(CSS) &&
    RND.includes('role="button"') && RND.includes('tabindex="0"'))
  t('and answers the keyboard, since it claims to be a button',
    RND.includes("event.key==='Enter'") && RND.includes('window.__openAllocation()'))
  t('why the caption went is written down', CSS.includes('reserved width even while'))
}

console.log('\n-- a shared pane has to know which shell it is in --')
{
  // Two reports from the desktop Allocation tab: pressing × "opens like a weird mobile app
  // version", and Exposure / What moved do nothing.
  //
  // Same root. These renderers mount in a desktop tab AND in the mobile shell, but their
  // controls all reached for #mobVContent and gated on _mobVActiveTab. On desktop the pane is
  // #deskAlloc and _mobVActiveTab is something else, so the view state changed and nothing
  // redrew. The close button called mobVHome(), which calls mobVShow() — so × did not close
  // anything, it switched the app into the mobile shell, which at desktop widths renders as a
  // phone mock-up.
  t('closing is shell-aware', src.includes('window.__paneClose = function'))
  t('and switches a desktop tab rather than showing the phone shell',
    /__paneClose[\s\S]{0,420}switchTab\(deskTab, null\)/.test(src))
  t('falling back to mobVHome only on the mobile shell',
    /__paneClose[\s\S]{0,700}window\.mobVHome\(\)/.test(src))
  t('no pane header still closes straight into the mobile shell',
    !/aria-label="Close"[^>]*onclick="window\.mobVHome\(\)"/.test(src) &&
    !/onclick="window\.mobVHome\(\)"[^>]*aria-label="Close"/.test(src))

  t('repainting is shell-aware too', src.includes('function _allocRepaint()'))
  t('it prefers the desktop pane when that is the one on screen',
    /_allocRepaint\(\)[\s\S]{0,320}getElementById\('deskAlloc'\)/.test(src))
  // Every control that changes what the Allocation screen shows.
  for (const fn of ['__attrSetPeriod', '__attrSetMode', '__allocSetView', '__expToggleAsset']) {
    const at = src.indexOf('window.' + fn)
    const body = at < 0 ? '' : src.slice(at, src.indexOf('\n}', at) + 2)
    t(`${fn} repaints through it`, body.includes('_allocRepaint()'), body.slice(0, 110))
    t(`${fn} no longer hardcodes the mobile host`, !body.includes("getElementById('mobVContent')"))
  }
  t('why is written down', src.includes('renders as a phone mock-up'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
