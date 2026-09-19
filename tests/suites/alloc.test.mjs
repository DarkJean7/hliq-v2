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
// What the account card is showing. null = no card painted yet, which is the cold-start
// case and must leave the wheel reporting its own parts.
let _shownEquity = null
const shownAccountValue = () => _shownEquity
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
  'isSpotCoin', '_watchSpotNameMap', 'shownAccountValue', body)
const call = () => built(
  new Proxy({}, { get: (_, k) => state[k] }), _posMarkPx, _coinMaxLev, _lbIsOutcome,
  _ocSidePrice, _spotMid, _maHiddenLoad, _allAcctLastResults,
  orderMarginByCoin, spotByCoin, SLICE_DUST, isSpotCoin, _watchSpotNameMap, shownAccountValue)
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
// Helpers: the ring is four money buckets now, and the coins live inside them.
const grp   = (k) => r.groups.find(g => g.kind === k)
const items = (k) => grp(k)?.items ?? []
const item  = (k, coin) => items(k).find(i => i.coin === coin)

t('free = perp withdrawable + unheld spot USDC', near(r.free, 310), `got ${r.free}`)
t('used = sum of position margin', near(r.used, 744.89), `got ${r.used}`)
t('total = used + free', near(r.total, 1054.89), `got ${r.total}`)
t('two buckets have money in them', r.groups.length === 2)
t('and an empty one is not drawn', !grp('orders') && !grp('spot'))
t('free margin is pinned LAST', r.groups.at(-1).kind === 'free')
t('cash has nothing to open', grp('free').items.length === 0)
t('the assets are inside the positions bucket, sorted by margin desc',
  items('positions').map(i => i.coin).join(',') === 'HYPE,PUMP')
t('hasAny true', r.hasAny === true)
const pcts = r.groups.map(g => (g.value / r.total) * 100)
t('percentages sum to 100', near(pcts.reduce((a, b) => a + b, 0), 100), `got ${pcts.reduce((a,b)=>a+b,0)}`)
// The arc is the bucket, but an asset's share is still of the whole account — that is what
// makes the wheel readable against the equity card.
t('an asset share is of the NEW total (was 46.8% of margin-only)',
  Math.abs((item('positions', 'HYPE').margin / r.total) * 100 - 48.42) < 0.01)

// ── no free cash: behaviour must be exactly as before ─────────────────────────
state = { perpState: { withdrawable: '0', assetPositions: [pos('HYPE', 1, 100, 1000, 5)] },
          spotState: { balances: [] } }
r = _allocationSlices()
t('no free bucket when free = 0', r.groups.length === 1 && r.groups[0].kind === 'positions')
t('total unchanged when free = 0', near(r.total, 100))

// ── free cash but NO positions: empty state must still win ────────────────────
state = { perpState: { withdrawable: '5000', assetPositions: [] }, spotState: { balances: [] } }
r = _allocationSlices()
t('hasAny false with cash only', r.hasAny === false)

// ── negative / missing withdrawable must not produce a negative slice ─────────
state = { perpState: { withdrawable: '-12', assetPositions: [pos('X', 1, 50, 500, 0)] },
          spotState: { balances: [{ coin: 'USDC', total: '10', hold: '99' }] } }
r = _allocationSlices()
t('negative withdrawable clamps to 0 (no free bucket)', r.free === 0 && r.groups.length === 1)

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
  const g = (k) => r.groups.find(x => x.kind === k)
  const it = (k, c) => (g(k)?.items ?? []).find(x => x.coin === c)
  // accountValue - totalMarginUsed - withdrawable. That residual IS the reserved margin, and
  // on a live wallet it agreed with the per-order sum to the cent over 18 orders.
  t('the account residual is what the bucket comes to', near(r.orders, 980.30 - 268.27 - 1.98, 1e-9), `got ${r.orders}`)
  t('orders are a bucket of their own, in the ring and the list', !!g('orders'))
  t('and the wheel totals the whole account', near(r.total, r.used + r.orders + r.spot + r.free, 1e-9))
  t('a coin with orders and no position is inside it', !!it('orders', 'HYPE') && !!it('orders', 'SOL'))
  t('the reserve splits by notional', it('orders', 'HYPE').margin > it('orders', 'SOL').margin)
  t('the order count travels with it', it('orders', 'HYPE').count === 2 && it('orders', 'SOL').count === 1)
  // A reduce-only order closes something that already exists, and a position TP/SL is the
  // same. Counting either would inflate the reserve by the whole size of every stop resting.
  t('reduce-only and TP/SL post no margin of their own', !it('orders', 'ZRO'))
  // The position bucket is untouched by any of it: its number is margin the POSITION posted.
  t('a position keeps its own margin, apart from the reserve', near(it('positions', 'ZRO').margin, 268.27))
  t('and the two buckets do not overlap', near(r.used, 268.27))
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
  const og = r.groups.find(g => g.kind === 'orders')
  t('the bucket is still there', !!og)
  t('worth what the account said', near(og.value, 390))
  t('with one row saying it is not attributed yet', og.items.length === 1 && og.items[0].unattributed === true)
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
  const sg = r.groups.find(g => g.kind === 'spot')
  t('spot is counted', near(r.spot, 3.81743312 * 93.5695 + 199.8656 * 0.28223, 1e-6), `got ${r.spot}`)
  t('and reaches the total', near(r.total, r.used + r.orders + r.spot + r.free, 1e-9))
  t('one row per token', sg.items.length === 2)
  // USDC is cash and is already counted as free margin; a second row for it would be the
  // same dollars twice.
  t('USDC is not one of them', !sg.items.some(i => i.coin === 'USDC'))
  t('a dust balance is left off the wheel', !sg.items.some(i => i.coin === 'DUST'))
  t('a spot row carries its token amount', near(sg.items.find(i => i.coin === 'HYPE').size, 3.81743312))
  t('with a cost basis it shows PnL', near(sg.items.find(i => i.coin === 'HYPE').uPnl, 3.81743312 * 93.5695 - 300, 1e-6))
  t('without one it claims none', sg.items.find(i => i.coin === 'KNTQ').uPnl === 0)
  // The same coin held as a perp position AND as spot is two different things in two
  // different places, so it appears once in each bucket and never merged.
  t('spot HYPE does not merge into the HYPE position',
    !!sg.items.find(i => i.coin === 'HYPE') &&
    !!r.groups.find(g => g.kind === 'positions').items.find(i => i.coin === 'HYPE'))

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
    { addr: '0xa', label: 'One', spotBalances: [{ coin: 'KNTQ', total: '100' }], _orderMargin: 40 },
    { addr: '0xb', label: 'Two', spotBalances: [{ coin: 'KNTQ', total: '40' }],  _orderMargin: 37 },
    { addr: '0xc', label: 'Bad', error: 'rate limited', spotBalances: [{ coin: 'KNTQ', total: '999' }] },
  ]
  state = {
    isAllAccounts: true,
    perpState: { withdrawable: '5', _orderMargin: 77, assetPositions: [], marginSummary: {} },
    spotState: { balances: [] },
    openOrders: [],
  }
  r = _allocationSlices()
  const sg = r.groups.find(g => g.kind === 'spot')
  t('a wallet\'s spot tokens reach the wheel', near(r.spot, 140 * 0.25), `got ${r.spot}`)
  t('the same token on two wallets is one row', sg.items.length === 1)
  t('tagged with the accounts holding it', [...sg.items[0].accts].sort().join(',') === 'One,Two')
  t('a wallet that errored is left out', !near(r.spot, (140 + 999) * 0.25))
  // The single-wallet residual cannot work here: this accountValue is the sum of wallet
  // TOTALS, so it already contains spot. Each row carries its own and _aggPerpState sums them.
  t('reserved margin comes from the summed rows', near(r.orders, 77))

  // And a wallet that has not reported one yet must not drag the sum to zero — the bug that
  // made orders vanish from the ring and the breakdown entirely. Unknown, not none.
  state.perpState._orderMargin = null
  r = _allocationSlices()
  t('an unknown reserve falls back to the orders themselves, not to nothing', r.orders === 0)
  state.openOrders = [{ coin: 'SOL', side: 'B', sz: '10', limitPx: '100', _acctAddr: '0xa' }]
  r = _allocationSlices()
  t('and with orders visible it reports them', r.orders > 0, `got ${r.orders}`)
  mids = {}
  _allAcctLastResults = []
}

console.log('\n-- the wheel agrees with the account card --')
{
  // Reported as "why does allocation total equity not match the account equity": $6,814.39 in
  // the wheel against $6,880.03 on the card. Both were honest — the card is a server snapshot
  // carried forward by a perp delta, the wheel is the sum of live parts — and two honest
  // constructions of one quantity land a fraction of a percent apart. On screen that is just
  // two different numbers for the same thing.
  const setup = (shown) => {
    _shownEquity = shown
    state = {
      perpState: { withdrawable: '100', marginSummary: { accountValue: '500', totalMarginUsed: '200' },
                   assetPositions: [pos('BTC', 1, 200, 2000, 0)] },
      spotState: { balances: [] },
      openOrders: [],
    }
    return _allocationSlices()
  }

  // Parts: 200 positions + 200 orders (500-200-100) + 0 spot + 100 free = 500.
  let r = setup(null)
  t('with no card painted yet it reports its own parts', near(r.total, 500) && near(r.free, 100), JSON.stringify({ t: r.total, f: r.free }))

  // The card says 512. The extra 12 is not committed to anything, so it is cash.
  r = setup(512)
  t('the total is the number the card shows', near(r.total, 512), String(r.total))
  t('and the remainder lands in free margin', near(r.free, 112), String(r.free))
  t('the other three buckets are untouched', near(r.used, 200) && near(r.orders, 200) && r.spot === 0)

  // Below the reported free margin is just as legitimate — HL's withdrawable is a floor, and
  // a snapshot half a second old can sit either side of the live parts.
  r = setup(488)
  t('it works downward too', near(r.total, 488) && near(r.free, 88), JSON.stringify({ t: r.total, f: r.free }))

  // The guard is the point. Absorbing a small unattributed amount into cash is right;
  // absorbing a large one would hide a real bug in one of the other buckets behind a
  // plausible total. Past 5% the wheel reports its parts and the two numbers disagree
  // VISIBLY, which is the correct signal.
  r = setup(900)
  t('a big disagreement is not absorbed', near(r.total, 500) && near(r.free, 100), JSON.stringify({ t: r.total, f: r.free }))
  t('so the mismatch stays visible rather than being papered over', r.total !== 900)

  // Parts exceeding the card would make free negative, which is not a slice.
  r = setup(350)
  t('free never goes negative', r.free >= 0 && near(r.total, 500), JSON.stringify({ t: r.total, f: r.free }))

  _shownEquity = null
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
