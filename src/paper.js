/**
 * INSOLVENT TERMINAL — Paper Account
 *
 * A simulated perp account that behaves like a real one everywhere in the app.
 * It is selected like "All Accounts" (sentinel address `__paper__`) and then
 * synthesises the exact data shapes the dashboard already renders from —
 * clearinghouseState, frontendOpenOrders, userFills, portfolio — so every
 * screen, sort, chart and badge works with no special-casing.
 *
 * SAFETY: nothing here can reach the exchange. trading.js short-circuits to
 * this module at placeOrderRaw/cancel/leverage — the single choke point every
 * order path funnels through — so while paper mode is active no order is ever
 * signed, and no agent key is even read.
 *
 * COSTS ARE SIMULATED: taker/maker fees, adverse slippage on market orders, and
 * hourly funding — all as a rate on NOTIONAL, so they scale with position size
 * (see PAPER_COSTS). Funding uses the live per-coin rate from HL when available.
 * Not modelled: order-book depth (size doesn't move the price) and queue position
 * (a resting limit fills the moment the mark touches it, which a real one may not).
 *
 * State is localStorage, per-device. Clearing site data erases it.
 */

export const PAPER_ADDR  = '__paper__'
export const PAPER_START = 1000         // opening balance, also the reset target
const PAPER_START_LEGACY = 10000        // what accounts created before the change began with
// Independent paper stores, one per account. Two are built in: the practice account
// ('main') and the Challenge account ('challenge'), which never touch each other —
// entering the Challenge swaps to its own fresh $1,000 without wiping the practice
// account you were building up.
//
// Beyond those, a user can make as many as they like. Each is its own $1,000, its own
// positions, its own history, so one idea per account is possible without them
// contaminating each other's numbers.
const PAPER_KEYS = { main: 'hliq_paper_v2', challenge: 'hliq_paper_chal_v2' }
const PAPER_EXTRA_PREFIX = 'hliq_paper_s_'
const PAPER_LIST_KEY = 'hliq_paper_accts'
// Not a policy about how many accounts is reasonable — it is what localStorage can hold.
// Each store keeps up to 400 fills and 2,000 equity points, and the whole origin shares a
// quota of a few MB. Past this the writes start failing, and a paper account that silently
// stops saving is worse than one you were not allowed to create.
export const PAPER_MAX_ACCTS = 12

let _slot = 'main'

/** The user-made accounts: [{ slot, name, createdAt }]. The two built-ins are not in here. */
export function paperAcctList() {
  try {
    const d = JSON.parse(localStorage.getItem(PAPER_LIST_KEY) ?? 'null')
    return Array.isArray(d) ? d.filter(a => a && typeof a.slot === 'string') : []
  } catch { return [] }
}
function paperAcctSave(list) {
  try { localStorage.setItem(PAPER_LIST_KEY, JSON.stringify(list)); return true } catch { return false }
}
function extraKey(slot) { return PAPER_EXTRA_PREFIX + slot }
export function paperSlotKnown(slot) {
  return slot === 'main' || slot === 'challenge' || paperAcctList().some(a => a.slot === slot)
}
// An unknown slot falls back to the practice account rather than opening a store of its
// own: that is what makes deleting the account you are standing in survivable.
function keyFor(slot) {
  if (PAPER_KEYS[slot]) return PAPER_KEYS[slot]
  return paperSlotKnown(slot) ? extraKey(slot) : PAPER_KEYS.main
}
function paperKey() { return keyFor(_slot) }
export function paperSlot() { return _slot }
// Switch which store backs the paper account. Flushes the current in-memory state to its
// own key first, then forces the next paperStore() to load the other slot from scratch.
export function setPaperSlot(slot) {
  const next = paperSlotKnown(slot) ? slot : 'main'
  if (next === _slot) return
  if (_s) { try { localStorage.setItem(paperKey(), JSON.stringify(_s)) } catch {} }
  _slot = next
  _s = null
}

/**
 * Make another paper account. Returns its slot id, or null with a reason:
 *   'limit'  — already at PAPER_MAX_ACCTS
 *   'quota'  — the registry write failed, so the account would not survive a reload
 * The store itself is not created here; the first paperStore() on the new slot opens a
 * fresh one at PAPER_START, which is the same path a first-time user takes.
 */
export function paperAcctCreate(name) {
  const list = paperAcctList()
  if (list.length >= PAPER_MAX_ACCTS) return { slot: null, error: 'limit' }
  const slot = 'a' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36)
  const want = paperUniqueName(name) || 'Paper ' + (list.length + 2)
  list.push({ slot, name: paperUniqueName(want), createdAt: Date.now() })
  if (!paperAcctSave(list)) return { slot: null, error: 'quota' }
  return { slot, error: null }
}

/**
 * A name no other paper account is already using.
 *
 * Two accounts called "tokyo" are two accounts a person cannot tell apart -- the header
 * shows the name, and the balance is the only other thing that differs. Rather than refuse
 * the name, take it and number it, which is what a person would have done anyway.
 */
export function paperUniqueName(name, exceptSlot = null) {
  const want = String(name ?? '').trim().slice(0, 24)
  if (!want) return want
  const taken = new Set()
  for (const a of paperAcctList()) if (a.slot !== exceptSlot) taken.add(String(a.name).toLowerCase())
  // The practice account's name lives outside the registry, so it has to be added by hand.
  if (exceptSlot !== 'main') {
    try { const n = localStorage.getItem('hliq_paper_name'); if (n) taken.add(n.toLowerCase()) } catch {}
  }
  if (!taken.has(want.toLowerCase())) return want
  for (let i = 2; i < 100; i++) {
    const tryName = `${want} ${i}`.slice(0, 24)
    if (!taken.has(tryName.toLowerCase())) return tryName
  }
  return want
}

export function paperAcctRename(slot, name) {
  const list = paperAcctList()
  const row = list.find(a => a.slot === slot)
  if (!row) return false
  row.name = paperUniqueName(name, slot) || row.name
  return paperAcctSave(list)
}

/**
 * Delete a user-made account and its store. The built-ins are not deletable — 'main' is
 * where an unknown slot lands, and the Challenge account belongs to the contest, not to
 * whoever is looking at the list.
 */
export function paperAcctDelete(slot) {
  if (slot === 'main' || slot === 'challenge') return false
  const list = paperAcctList()
  if (!list.some(a => a.slot === slot)) return false
  // Leave the account we are standing in before erasing it, or the in-memory state would
  // be flushed straight back into the key we just removed.
  if (_slot === slot) { _slot = 'main'; _s = null }
  try { localStorage.removeItem(extraKey(slot)) } catch {}
  return paperAcctSave(list.filter(a => a.slot !== slot))
}

/** Every selectable paper account, in display order. */
export function paperAccounts() {
  return [
    { slot: 'main', name: null, builtin: true },
    ...paperAcctList().map(a => ({ slot: a.slot, name: a.name, builtin: false })),
  ]
}
export function paperAcctName(slot) {
  return paperAcctList().find(a => a.slot === slot)?.name ?? null
}
const DEFAULT_MAX_LEV = 50

// ─── TRADING COSTS ────────────────────────────────────────────────────────────
// Every cost below is a RATE APPLIED TO NOTIONAL (size × price), so it scales with
// position size automatically — a 10x bigger position pays 10x the fee, slippage
// and funding. Rates mirror Hyperliquid's published defaults.
export const PAPER_COSTS = {
  takerBps:   4.5,   // 0.045% — market / IOC orders that cross the book
  makerBps:   1.5,   // 0.015% — resting limit orders that get filled
  spotBps:    7.0,   // 0.07%  — spot & outcome trades
  slipBps:    3.0,   // 0.03%  — adverse price move on market orders only
  fundingHrs: 1,     // funding settles hourly, as on HL
}
// Fallback hourly funding rate when the live per-coin rate isn't loaded yet.
// 0.00125%/hr ≈ 11%/yr, HL's common baseline.
const DEFAULT_FUNDING_HOURLY = 0.0000125

const bps = (n) => n / 10_000

// Live per-coin hourly funding rates, pushed in from the dashboard. Falls back to
// the default above for any coin not present.
let _fundingRates = {}
export function setPaperFundingRates(map) { if (map) _fundingRates = map }
export function paperFundingRate(coin) {
  const r = parseFloat(_fundingRates?.[coin])
  return Number.isFinite(r) ? r : DEFAULT_FUNDING_HOURLY
}
const MAX_FILLS  = 400
const MAX_EQ_PTS = 2000

// ─── MODE ─────────────────────────────────────────────────────────────────────
let _active = false
export function isPaper() { return _active }
export function setPaper(on) { _active = !!on }

// Live marks, pushed in by the dashboard's existing price poll.
let _marks = {}
export function setPaperMarks(mids) { if (mids) _marks = mids }
export function paperMark(coin) { return parseFloat(_marks?.[coin] ?? 0) || 0 }

// Per-asset metadata (maxLeverage, szDecimals) from the real asset map, so paper
// uses each market's ACTUAL limits rather than one hardcoded guess.
let _assets = {}
export function setPaperAssets(map) { if (map) _assets = map }
export function paperMaxLev(coin) {
  return parseFloat(_assets?.[coin]?.maxLeverage) || DEFAULT_MAX_LEV
}
/**
 * Maintenance margin fraction — HL's rule is half the max leverage, i.e.
 * 1/(2·maxLeverage). A 40× asset maintains at 1.25%, a 3× asset at 16.7%.
 * The old flat 0.5% was wrong for every asset except 100× ones and made
 * liquidation prices (and the maintenance-margin readout) too optimistic.
 */
export function paperMmf(coin) { return 1 / (2 * paperMaxLev(coin)) }

// ─── STORE ────────────────────────────────────────────────────────────────────
function blank() {
  const now = Date.now()
  return {
    balance:   PAPER_START,   // realised cash
    positions: [],            // { coin, szi, entryPx, margin, leverage, isIsolated }
    orders:    [],            // { oid, coin, isBuy, sz, limitPx, reduceOnly, isTrigger, triggerPx, tpsl, timestamp }
    fills:     [],            // HL-shaped raw fills (newest first)
    equity:    [],            // [ts, equity] samples for the portfolio chart
    // Cost basis. PnL is equity − net deposits, so topping the account up with
    // more paper money never counts as profit (and can't inflate the leaderboard).
    deposited: PAPER_START,
    ledger:    [{ time: now, delta: { type: 'deposit', usdc: String(PAPER_START) } }],
    nextOid:   1000,
    created:   now,
  }
}

let _s = null

export function paperStore() {
  if (_s) return _s
  try {
    const raw = JSON.parse(localStorage.getItem(paperKey()) ?? 'null')
    if (raw && Number.isFinite(raw.balance) && Array.isArray(raw.positions)) {
      _s = { ...blank(), ...raw }
      // Accounts created before deposits existed have no cost basis recorded. They
      // all started at the old opening balance, so seed it from that — using the new
      // (lower) default would show them a large phantom profit.
      if (!Number.isFinite(raw.deposited)) {
        _s.deposited = PAPER_START_LEGACY
        _s.ledger = raw.ledger ?? [{ time: raw.created ?? Date.now(), delta: { type: 'deposit', usdc: String(PAPER_START_LEGACY) } }]
      }
      return _s
    }
  } catch {}
  _s = blank()
  return _s
}

// A failed save used to be swallowed silently, which was survivable while there was one
// paper account and no way to fill the quota. With several it is reachable, and the
// failure looks exactly like nothing happening: you trade, the numbers move, and the next
// reload has none of it. So it is recorded, and the app says so.
let _saveFailed = false
export function paperSaveFailed() { return _saveFailed }
export function clearPaperSaveFailed() { _saveFailed = false }

export function paperSave() {
  try { localStorage.setItem(paperKey(), JSON.stringify(_s)); _saveFailed = false; return true }
  catch (e) { _saveFailed = true; return false }
}

export function paperReset() {
  _s = blank()
  paperSave()
  return _s
}

// ─── MATH ─────────────────────────────────────────────────────────────────────
const posOf   = (s, coin) => s.positions.find(p => p.coin === coin)
const uPnlOf  = (p, mark) => (mark - p.entryPx) * p.szi          // szi is signed
const notOf   = (p, mark) => Math.abs(p.szi) * mark

/**
 * Liquidation price.
 *
 * ISOLATED — only that position's own margin backs it, so it liquidates when the
 * loss eats that margin down to maintenance.
 *
 * CROSS — the WHOLE account backs it. It liquidates when total account equity
 * falls to total maintenance margin, which means a cross position on a
 * well-funded account can be far safer (or effectively unliquidatable) versus the
 * isolated figure. Using the isolated formula for cross positions, as this did
 * originally, reports a liquidation price that is much too close to the mark.
 *
 * Solving equity(P) = maintenance(P) for this coin's price, holding others fixed:
 *   equity + (P − mark)·szi = maintOther + |szi|·P·mmf
 *   ⇒ P = (maintOther − equity + mark·szi) / (szi·(1 − sign(szi)·mmf))
 */
export function paperLiqPx(p, s = null) {
  const sz = Math.abs(p.szi)
  if (!(sz > 0)) return 0
  const mmf = paperMmf(p.coin)
  const dir = p.szi > 0 ? 1 : -1

  if (p.isIsolated) {
    return Math.max(0, p.entryPx - dir * (p.margin - sz * p.entryPx * mmf) / sz)
  }

  const store = s ?? paperStore()
  const mark  = paperMark(p.coin) || p.entryPx
  const equity = paperEquity()
  // Maintenance owed by every OTHER cross position (their prices don't move here).
  let maintOther = 0
  for (const q of store.positions) {
    if (q === p || q.coin === p.coin || q.isIsolated) continue
    const qm = paperMark(q.coin) || q.entryPx
    maintOther += Math.abs(q.szi) * qm * paperMmf(q.coin)
  }

  const denom = p.szi * (1 - dir * mmf)
  if (!denom) return 0
  const liq = (maintOther - equity + mark * p.szi) / denom
  if (!Number.isFinite(liq) || liq <= 0) return 0        // can't be liquidated on price alone
  // A long liquidates BELOW the mark and a short ABOVE it; anything else means the
  // account is already underwater, which the tick's own check handles.
  if (dir > 0 && liq > mark) return mark
  if (dir < 0 && liq < mark) return mark
  return liq
}

/** Cash + unrealised PnL. */
/**
 * Perp collateral: realised cash plus open-position PnL. This is what backs margin
 * — spot tokens and outcome shares are NOT usable as perp collateral.
 */
function paperCollateral() {
  const s = paperStore()
  let eq = s.balance
  for (const p of s.positions) {
    const m = paperMark(p.coin)
    if (m > 0) eq += uPnlOf(p, m)
  }
  return eq
}

/**
 * Total account value = perp collateral + the market value of spot/outcome holdings.
 *
 * The spot term was missing, so buying $200 of spot deducted the cash and then showed
 * nothing in return: equity dropped by the full purchase and a holding that doubled
 * still read as a loss. Every downstream figure inherited it — PnL, the portfolio
 * chart, and the paper leaderboard.
 */
export function paperEquity() {
  return paperCollateral() + paperSpotValue()
}

const marginUsed = (s) => s.positions.reduce((a, p) => a + p.margin, 0)

/**
 * Free collateral available to open new risk. Deliberately based on perp collateral,
 * NOT total equity — spot holdings are assets but can't back a perp position, so
 * counting them here would hand out buying power the account doesn't have.
 */
export function paperWithdrawable() {
  return Math.max(0, paperCollateral() - marginUsed(paperStore()))
}

/** Net paper money put in — the cost basis PnL is measured against. */
export function paperDeposited() { return paperStore().deposited ?? PAPER_START }

/** All-time PnL: what the account is worth minus what was funded into it. */
export function paperPnl() { return paperEquity() - paperDeposited() }

/** Add paper money. Appears in Transfers as a deposit and raises the cost basis. */
export function paperDeposit(usd) {
  const amt = parseFloat(usd)
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'Enter an amount' }
  if (amt > 1e9) return { ok: false, error: 'That is more paper money than the simulation allows' }
  const s = paperStore()
  s.balance   += amt
  s.deposited += amt
  // Lift the PAST equity samples by the same amount so the curve has no step at the
  // deposit. Without this the dashboard's "today" figure reads a $5,000 top-up as a
  // $5,000 gain (it measures the change in account value), which is wildly misleading
  // — the latest point is still true equity, only the history is rebased.
  s.equity = (s.equity ?? []).map(([t, v]) => [t, v + amt])
  s.ledger.unshift({ time: Date.now(), delta: { type: 'deposit', usdc: String(amt) } })
  paperSave()
  return { ok: true, amount: amt }
}

/** Remove paper money. Capped at free collateral so it can't strand open positions. */
export function paperWithdraw(usd) {
  const amt  = parseFloat(usd)
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, error: 'Enter an amount' }
  const free = paperWithdrawable()
  if (amt > free + 1e-9) return { ok: false, error: `Only ${free.toFixed(2)} is free to withdraw` }
  const s = paperStore()
  s.balance   -= amt
  s.deposited -= amt          // lowering the basis keeps PnL honest across withdrawals
  s.equity = (s.equity ?? []).map(([t, v]) => [t, v - amt])   // rebase, same as deposit
  s.ledger.unshift({ time: Date.now(), delta: { type: 'withdraw', usdc: String(amt) } })
  paperSave()
  return { ok: true, amount: amt }
}

/** userNonFundingLedgerUpdates — what the Transfers tab renders. */
export function paperLedger() { return paperStore().ledger ?? [] }

/** userFunding — raw HL shape, so parseFunding() consumes it unchanged. */
export function paperFundingHistory() { return paperStore().funding ?? [] }

/**
 * Accrue funding on open perp positions. Settles hourly like Hyperliquid, and the
 * charge is rate × NOTIONAL, so it scales with position size and keeps costing while
 * the position stays open.
 *
 * Sign follows HL exactly (verified against userFunding): a long pays when the rate
 * is positive, so its cashflow is negative. `fundingPaid` on the position mirrors
 * HL's cumFunding.sinceOpen, which is the amount PAID (positive = paid).
 *
 * `force` runs a tick immediately regardless of the clock — used by the debug panel,
 * since waiting an hour to see it work is not a reasonable test.
 */
export function paperAccrueFunding(force = false) {
  const s = paperStore()
  const now = Date.now()
  const every = PAPER_COSTS.fundingHrs * 3600_000
  if (!s.lastFundingAt) { s.lastFundingAt = now; paperSave(); if (!force) return [] }

  const periods = force ? 1 : Math.floor((now - s.lastFundingAt) / every)
  if (periods < 1) return []

  const events = []
  for (const p of s.positions) {
    const mark = paperMark(p.coin)
    if (!(mark > 0)) continue
    const rate     = paperFundingRate(p.coin)
    const notional = Math.abs(p.szi) * mark
    // Long pays a positive rate; short receives it.
    const paid = (p.szi > 0 ? 1 : -1) * notional * rate * periods
    if (!Number.isFinite(paid) || paid === 0) continue

    s.balance      -= paid                      // cashflow = −paid
    p.fundingPaid   = (p.fundingPaid ?? 0) + paid
    s.funding       = s.funding ?? []
    s.funding.unshift({ time: now, delta: {
      type: 'funding', coin: p.coin,
      usdc: String(-paid),                      // signed cashflow: + = received
      szi: String(p.szi), fundingRate: String(rate),
    } })
    events.push(`${p.coin} funding ${paid > 0 ? '-' : '+'}$${Math.abs(paid).toFixed(4)}`)
  }
  if (s.funding && s.funding.length > 500) s.funding.length = 500
  s.lastFundingAt = force ? s.lastFundingAt : s.lastFundingAt + periods * every
  paperSave()
  return events
}

// ─── FILLS ────────────────────────────────────────────────────────────────────
function recordFill(s, { coin, px, sz, isBuy, closedPnl, dir, oid, fee = 0 }) {
  s.fills.unshift({
    coin, px: String(px), sz: String(Math.abs(sz)),
    side: isBuy ? 'B' : 'A',
    time: Date.now(),
    closedPnl: String(closedPnl ?? 0),
    dir, oid: oid ?? null, tid: `p${s.nextOid++}`,
    hash: '', fee: String(fee), feeToken: 'USDC',
    crossed: true,
  })
  if (s.fills.length > MAX_FILLS) s.fills.length = MAX_FILLS
}

/** Human direction label, matching the strings the History/badge UI expects. */
function dirLabel(prevSzi, newSzi) {
  if (prevSzi === 0)                    return newSzi > 0 ? 'Open Long' : 'Open Short'
  if (newSzi === 0)                     return prevSzi > 0 ? 'Close Long' : 'Close Short'
  if (Math.sign(prevSzi) !== Math.sign(newSzi))
    return prevSzi > 0 ? 'Long > Short' : 'Short > Long'
  return Math.abs(newSzi) > Math.abs(prevSzi)
    ? (newSzi > 0 ? 'Open Long' : 'Open Short')
    : (newSzi > 0 ? 'Close Long' : 'Close Short')
}

// ─── CORE FILL ────────────────────────────────────────────────────────────────
/**
 * Apply a fill of `sz` (unsigned) at `px` on `coin`. Handles opening, adding,
 * reducing, closing and flipping, updating realised cash on any reduction.
 * Returns { ok, error? }.
 */
export function paperFill({ coin, isBuy, sz, px, leverage = 5, isIsolated = false, reduceOnly = false, oid = null, feeBps = PAPER_COSTS.takerBps }) {
  const s = paperStore()
  sz = Math.abs(parseFloat(sz) || 0)
  px = parseFloat(px) || 0
  if (!(sz > 0)) return { ok: false, error: 'Invalid size' }
  if (!(px > 0)) return { ok: false, error: `No price for ${coin}` }

  const p        = posOf(s, coin)
  const prevSzi  = p?.szi ?? 0
  const deltaSzi = isBuy ? sz : -sz
  let   newSzi   = prevSzi + deltaSzi

  if (reduceOnly) {
    // Never let a reduce-only fill open the other side.
    if (prevSzi === 0) return { ok: false, error: 'No position to reduce' }
    if (Math.sign(deltaSzi) === Math.sign(prevSzi)) return { ok: false, error: 'Reduce-only would increase position' }
    if (Math.abs(deltaSzi) > Math.abs(prevSzi)) {
      sz     = Math.abs(prevSzi)
      newSzi = 0
    }
  }

  let realised = 0

  if (prevSzi !== 0 && Math.sign(deltaSzi) !== Math.sign(prevSzi)) {
    // Reducing: realise PnL on the closed portion.
    const closedSz = Math.min(sz, Math.abs(prevSzi))
    realised = (px - p.entryPx) * closedSz * Math.sign(prevSzi)
    s.balance += realised
    const frac = closedSz / Math.abs(prevSzi)
    p.margin  -= p.margin * frac
  }

  if (newSzi === 0) {
    if (p) s.positions.splice(s.positions.indexOf(p), 1)
  } else if (prevSzi === 0 || Math.sign(newSzi) !== Math.sign(prevSzi)) {
    // Fresh position, or a flip — the remainder opens at this price.
    const openSz = Math.abs(newSzi)
    const margin = (openSz * px) / Math.max(1, leverage)
    if (margin > paperWithdrawable() + 1e-9) {
      return { ok: false, error: `Not enough margin ($${paperWithdrawable().toFixed(2)} free)` }
    }
    if (p) { p.szi = newSzi; p.entryPx = px; p.margin = margin; p.leverage = leverage; p.isIsolated = isIsolated }
    else   s.positions.push({ coin, szi: newSzi, entryPx: px, margin, leverage, isIsolated })
  } else if (Math.abs(newSzi) > Math.abs(prevSzi)) {
    // Adding to the same side — average the entry, add margin.
    const addSz  = Math.abs(deltaSzi)
    const margin = (addSz * px) / Math.max(1, leverage)
    if (margin > paperWithdrawable() + 1e-9) {
      return { ok: false, error: `Not enough margin ($${paperWithdrawable().toFixed(2)} free)` }
    }
    p.entryPx  = (p.entryPx * Math.abs(prevSzi) + px * addSz) / Math.abs(newSzi)
    p.szi      = newSzi
    p.margin  += margin
    p.leverage = leverage
  } else {
    // Pure reduction — position shrinks, entry unchanged.
    p.szi = newSzi
    // Anything left below one size tick is dust that can never be traded away
    // (the next close rounds to zero), so treat the position as flat and release
    // its remaining margin instead of showing a phantom 0.00001 position forever.
    const tick = Math.pow(10, -(_assets?.[coin]?.szDecimals ?? 6))
    if (Math.abs(p.szi) < tick) {
      s.balance += p.margin      // return the leftover margin
      s.positions.splice(s.positions.indexOf(p), 1)
      newSzi = 0
    }
  }

  // Fee is a % of the notional traded, so it scales with position size.
  const fee = sz * px * bps(feeBps)
  s.balance -= fee

  recordFill(s, { coin, px, sz, isBuy, closedPnl: realised, dir: dirLabel(prevSzi, newSzi), oid, fee })
  paperSave()
  return { ok: true, fee }
}

// ─── SPOT + OUTCOMES ──────────────────────────────────────────────────────────
// Both are fully collateralized holdings rather than margined positions: buying
// spends USDC for units, selling returns USDC. Outcome (HIP-4) shares behave
// identically — they just trade 0–1 — so one code path serves both, and both
// surface through spotClearinghouseState, which is where the app already looks
// for spot balances AND outcome holdings.
//
// SIMPLIFICATION: paper keeps ONE USDC pool. Real Hyperliquid splits perp and
// spot wallets with transfers between them; here a spot buy draws on the same
// cash that backs perp margin. Everything else behaves the same.
function balOf(s, coin) {
  s.balances = s.balances ?? {}
  return s.balances[coin]
}

function paperFillSpot({ coin, isBuy, sz, px, oid = null }) {
  const s = paperStore()
  s.balances = s.balances ?? {}
  sz = Math.abs(parseFloat(sz) || 0)
  px = parseFloat(px) || 0
  if (!(sz > 0)) return { ok: false, error: 'Invalid size' }
  if (!(px > 0)) return { ok: false, error: `No price for ${coin}` }

  const cost = sz * px
  const fee  = cost * bps(PAPER_COSTS.spotBps)   // % of notional — scales with size
  const cur  = balOf(s, coin) ?? { total: 0, entryNtl: 0 }

  if (isBuy) {
    // Spot has no leverage, so the full notional PLUS the fee must be free cash.
    if (cost + fee > paperWithdrawable() + 1e-9) {
      return { ok: false, error: `Not enough free USDC ($${paperWithdrawable().toFixed(2)})` }
    }
    s.balance     -= cost + fee
    // The fee is part of what the position cost you, so it belongs in the basis —
    // otherwise a token bought and instantly sold would look break-even.
    cur.entryNtl  += cost + fee
    cur.total     += sz
    s.balances[coin] = cur
    recordFill(s, { coin, px, sz, isBuy: true, closedPnl: 0, dir: 'Buy', oid, fee })
  } else {
    if (sz > cur.total + 1e-9) return { ok: false, error: `You hold ${cur.total} ${coin}` }
    // Realised PnL on a sale is proceeds minus the average cost of the units sold.
    const avg      = cur.total > 0 ? cur.entryNtl / cur.total : 0
    const realised = (px - avg) * sz - fee
    s.balance    += cost - fee
    cur.total    -= sz
    cur.entryNtl  = Math.max(0, cur.entryNtl - avg * sz)
    if (cur.total <= 1e-12) delete s.balances[coin]
    else s.balances[coin] = cur
    recordFill(s, { coin, px, sz, isBuy: false, closedPnl: realised, dir: 'Sell', oid, fee })
  }

  paperSave()
  return { ok: true, fee }
}

// ─── OUTCOME SETTLEMENT ───────────────────────────────────────────────────────
// Outcome coins encode "#<outcome><side>" — id = outcome*10 + side, so "#7391"
// is outcome 739, side 1. HL's {type:'settledOutcome',outcome:N} returns
// `settleFraction`, the payout for SIDE 0; a binary market's side 1 is paid
// 1 − settleFraction. An unresolved market returns no settleFraction.
const isOutcomeCoin = (c) => typeof c === 'string' && (c[0] === '#' || c[0] === '+')

export function outcomeIdOf(coin) {
  const n = parseInt(String(coin).slice(1), 10)
  if (!Number.isFinite(n)) return null
  return { outcome: Math.floor(n / 10), side: n % 10 }
}

// outcome id → resolved payout map, or null while still open. Settled results are
// terminal so they're cached forever; open ones are re-checked on later passes.
const _settleCache = new Map()

/**
 * Settle any held outcome shares whose market has resolved: pay out
 * shares × payout, drop the holding, and record it as a fill so History and PnL
 * both reflect it. `fetchSettled(outcomeId)` returns HL's settledOutcome JSON.
 * Returns human-readable event strings.
 */
export async function paperSettleOutcomes(fetchSettled) {
  const s = paperStore()
  s.balances = s.balances ?? {}
  const held = Object.keys(s.balances).filter(isOutcomeCoin)
  if (!held.length) return []

  const events = []
  for (const coin of held) {
    const info = outcomeIdOf(coin)
    if (!info) continue

    let res = _settleCache.get(info.outcome)
    if (res === undefined) {
      try { res = await fetchSettled(info.outcome) } catch { res = null }
      const frac = parseFloat(res?.settleFraction)
      // Only cache a genuine settlement; an open market must stay re-checkable.
      if (Number.isFinite(frac)) _settleCache.set(info.outcome, { frac, sides: res?.spec?.sideSpecs?.length ?? 2 })
      else { _settleCache.delete(info.outcome); continue }
      res = _settleCache.get(info.outcome)
    }
    if (!res) continue

    const bal = s.balances[coin]
    if (!bal || !(bal.total > 0)) continue

    // Binary markets are the only shape HL uses here; anything else would need a
    // per-side payout vector, so leave it alone rather than guess.
    if (res.sides !== 2) continue
    const payout = info.side === 0 ? res.frac : 1 - res.frac

    const shares   = bal.total
    const proceeds = shares * payout
    const avg      = shares > 0 ? bal.entryNtl / shares : 0
    const realised = proceeds - bal.entryNtl

    s.balance += proceeds
    delete s.balances[coin]
    // Cancel any resting orders on a market that no longer trades.
    s.orders = s.orders.filter(o => o.coin !== coin)

    recordFill(s, {
      coin, px: payout, sz: shares, isBuy: false,
      closedPnl: realised, dir: 'Settlement', oid: null,
    })
    events.push(
      `${coin} settled at ${payout.toFixed(2)} — ${shares} share${shares === 1 ? '' : 's'}` +
      ` → ${proceeds.toFixed(2)} (${realised >= 0 ? '+' : ''}${realised.toFixed(2)}, avg ${avg.toFixed(3)})`
    )
  }

  if (events.length) paperSave()
  return events
}

/** Total USDC value of spot + outcome holdings at current marks. */
export function paperSpotValue() {
  const s = paperStore()
  let v = 0
  for (const [coin, b] of Object.entries(s.balances ?? {})) {
    const m = paperMark(coin)
    v += (m > 0 ? m : (b.total > 0 ? b.entryNtl / b.total : 0)) * b.total
  }
  return v
}

// ─── ORDER ENTRY (called by trading.js when paper mode is on) ────────────────
/**
 * Mimics `client.order(params)`. `params` is the raw HL order payload, so the
 * return value must be HL-shaped too — parseOrderResult reads it unchanged.
 */
export function paperOrder(params, coin, meta = {}) {
  const s  = paperStore()
  const spotLike = !!(meta.isSpot || meta.isOutcome)
  const o  = params?.orders?.[0] ?? {}
  const sz = parseFloat(o.s ?? 0)
  const px = parseFloat(o.p ?? 0)
  const isBuy = !!o.b
  const t = o.t ?? {}

  const err = (m) => ({ status: 'ok', response: { type: 'order', data: { statuses: [{ error: m }] } } })

  const mark = paperMark(coin)
  if (!(mark > 0)) return err(`No live price for ${coin} — paper trading needs a mark`)

  // Trigger (TP/SL) — always rests until the mark crosses it.
  if (t.trigger) {
    const trig = parseFloat(t.trigger.triggerPx ?? 0)
    if (!(trig > 0)) return err('Invalid trigger price')
    s.orders.push({
      oid: s.nextOid++, coin, isBuy, sz: Math.abs(sz), limitPx: px,
      reduceOnly: !!o.r, isTrigger: true, triggerPx: trig,
      tpsl: t.trigger.tpsl ?? '', timestamp: Date.now(),
    })
    paperSave()
    return { status: 'ok', response: { type: 'order', data: { statuses: ['waitingForTrigger'] } } }
  }

  const tif = t.limit?.tif ?? 'Gtc'
  const lev = _pendingLev[coin] ?? 5

  // Spot and outcome markets settle as balances; perps as margined positions.
  const doFill = (atPx, feeBps) => spotLike
    ? paperFillSpot({ coin, isBuy, sz, px: atPx })
    : paperFill({ coin, isBuy, sz, px: atPx, leverage: lev, reduceOnly: !!o.r, feeBps })

  // Market orders cross the spread, so they fill WORSE than mark — buys pay up,
  // sells receive less. Proportional to price, so the cost scales with size.
  const slipped = isBuy
    ? mark * (1 + bps(PAPER_COSTS.slipBps))
    : mark * (1 - bps(PAPER_COSTS.slipBps))

  // IOC crossing the mark (or any market order) fills instantly — at the slipped
  // price, charged the taker fee.
  const crosses = isBuy ? px >= mark : px <= mark
  if (tif === 'Ioc') {
    if (!crosses) return err('IOC did not cross — no fill')
    const r = doFill(slipped, PAPER_COSTS.takerBps)
    if (!r.ok) return err(r.error)
    return {
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(sz), avgPx: String(slipped), oid: s.nextOid++ } }] } },
    }
  }

  // GTC that already crosses fills immediately; otherwise it rests.
  if (crosses) {
    // A limit order priced through the market is aggressive too — same cost as a market order.
    const r = doFill(slipped, PAPER_COSTS.takerBps)
    if (!r.ok) return err(r.error)
    return {
      status: 'ok',
      response: { type: 'order', data: { statuses: [{ filled: { totalSz: String(sz), avgPx: String(slipped), oid: s.nextOid++ } }] } },
    }
  }

  const oid = s.nextOid++
  s.orders.push({
    oid, coin, isBuy, sz: Math.abs(sz), limitPx: px, spot: spotLike,
    reduceOnly: !!o.r, isTrigger: false, triggerPx: 0, tpsl: '', timestamp: Date.now(),
  })
  paperSave()
  return { status: 'ok', response: { type: 'order', data: { statuses: [{ resting: { oid } }] } } }
}

// Leverage is set in a separate call before the order; remember it per coin so
// the fill uses what the user actually picked.
const _pendingLev = {}
export function paperSetLeverage(coin, leverage) {
  _pendingLev[coin] = Math.max(1, parseInt(leverage) || 1)
  const p = posOf(paperStore(), coin)
  if (p) {
    // Re-levering an open position re-prices its margin requirement, like HL.
    const mark = paperMark(coin) || p.entryPx
    p.leverage = _pendingLev[coin]
    p.margin   = (Math.abs(p.szi) * mark) / p.leverage
    paperSave()
  }
  return { status: 'ok', response: { type: 'default' } }
}

export function paperCancel(oid) {
  const s = paperStore()
  const i = s.orders.findIndex(o => o.oid === parseInt(oid))
  if (i < 0) return { status: 'ok', response: { type: 'cancel', data: { statuses: ['error: order not found'] } } }
  s.orders.splice(i, 1)
  paperSave()
  return { status: 'ok', response: { type: 'cancel', data: { statuses: ['success'] } } }
}

export function paperCancelMany(list) {
  for (const c of list ?? []) paperCancel(c.o ?? c.oid)
  return { status: 'ok', response: { type: 'cancel', data: { statuses: (list ?? []).map(() => 'success') } } }
}

/** Isolated-margin add/remove. Moves cash between free collateral and the position. */
export function paperAdjustMargin(coin, usd, isAdd) {
  const s = paperStore()
  const p = posOf(s, coin)
  if (!p) return { ok: false, error: 'No position' }
  const amt = Math.abs(parseFloat(usd) || 0)
  if (isAdd) {
    if (amt > paperWithdrawable() + 1e-9) return { ok: false, error: 'Not enough free margin' }
    p.margin += amt
  } else {
    p.margin = Math.max(0, p.margin - amt)
  }
  const mark = paperMark(coin) || p.entryPx
  p.leverage = p.margin > 0 ? (Math.abs(p.szi) * mark) / p.margin : p.leverage
  paperSave()
  return { ok: true }
}

// ─── TICK: resting fills, triggers, liquidation ──────────────────────────────
/**
 * Advance the simulation against fresh marks. Returns a list of human-readable
 * events so the caller can toast them. Must run on every price refresh — not
 * just while a paper screen is open — or navigating away would freeze the book.
 */
export function paperTick() {
  const s = paperStore()
  const events = []
  let dirty = false   // set by silent mutations that still must be persisted

  // 1. Resting limit orders fill when the mark reaches them.
  for (const o of [...s.orders]) {
    const mark = paperMark(o.coin)
    if (!(mark > 0)) continue

    if (o.isTrigger) {
      const pos = posOf(s, o.coin)
      // Drop protective orders whose position is gone — checked BEFORE the trigger
      // test, because an unhit TP/SL would otherwise linger in the Orders tab
      // forever after the position closed (only hit orders were being cleaned up).
      // This is also what cancels the sibling when one half of a TP/SL pair fires.
      if (o.reduceOnly && !pos) { s.orders.splice(s.orders.indexOf(o), 1); dirty = true; continue }

      // TP/SL arm on the mark crossing the trigger, then fill at the mark.
      const hit = o.tpsl === 'tp'
        ? (o.isBuy ? mark <= o.triggerPx : mark >= o.triggerPx)
        : (o.isBuy ? mark >= o.triggerPx : mark <= o.triggerPx)
      if (!hit) continue
      if (!pos) { s.orders.splice(s.orders.indexOf(o), 1); continue }   // nothing left to protect
      const sz = Math.min(o.sz, Math.abs(pos.szi))
      // A fired trigger becomes a market order: adverse slippage + taker fee.
      const fillPx = o.isBuy ? mark * (1 + bps(PAPER_COSTS.slipBps)) : mark * (1 - bps(PAPER_COSTS.slipBps))
      const r  = paperFill({ coin: o.coin, isBuy: o.isBuy, sz, px: fillPx, reduceOnly: true, oid: o.oid, feeBps: PAPER_COSTS.takerBps })
      s.orders.splice(s.orders.indexOf(o), 1)
      if (r.ok) events.push(`${o.coin} ${o.tpsl === 'tp' ? 'take-profit' : 'stop-loss'} filled @ ${mark}`)
      continue
    }

    const crosses = o.isBuy ? mark <= o.limitPx : mark >= o.limitPx
    if (!crosses) continue
    const lev = posOf(s, o.coin)?.leverage ?? _pendingLev[o.coin] ?? 5
    // A resting order that gets filled provided liquidity — maker fee, and it fills
    // at its own limit price, so no slippage.
    const r   = o.spot
      ? paperFillSpot({ coin: o.coin, isBuy: o.isBuy, sz: o.sz, px: o.limitPx, oid: o.oid })
      : paperFill({ coin: o.coin, isBuy: o.isBuy, sz: o.sz, px: o.limitPx, leverage: lev, reduceOnly: o.reduceOnly, oid: o.oid, feeBps: PAPER_COSTS.makerBps })
    s.orders.splice(s.orders.indexOf(o), 1)
    events.push(r.ok ? `${o.coin} limit filled @ ${o.limitPx}` : `${o.coin} limit cancelled — ${r.error}`)
  }

  // 2a. ISOLATED positions liquidate individually against their own margin.
  for (const p of [...s.positions]) {
    if (!p.isIsolated) continue
    const mark = paperMark(p.coin)
    if (!(mark > 0)) continue
    const liq = paperLiqPx(p, s)
    if ((p.szi > 0 && mark <= liq) || (p.szi < 0 && mark >= liq)) {
      const sz = Math.abs(p.szi)
      s.balance -= p.margin                       // that position's margin is gone
      s.positions.splice(s.positions.indexOf(p), 1)
      recordFill(s, {
        coin: p.coin, px: liq, sz, isBuy: p.szi < 0,
        closedPnl: -p.margin, dir: p.szi > 0 ? 'Close Long' : 'Close Short', oid: null,
      })
      s.orders = s.orders.filter(o => o.coin !== p.coin || !o.reduceOnly)
      events.push(`${p.coin} LIQUIDATED (isolated) — lost $${p.margin.toFixed(2)}`)
    }
  }

  // 2b. CROSS positions share the account, so they liquidate together the moment
  // total equity drops below total cross maintenance — not one-by-one on a
  // per-position margin figure that doesn't back them.
  const cross = s.positions.filter(p => !p.isIsolated && paperMark(p.coin) > 0)
  if (cross.length) {
    const maint = cross.reduce((a, p) => a + Math.abs(p.szi) * paperMark(p.coin) * paperMmf(p.coin), 0)
    if (paperEquity() < maint) {
      for (const p of cross) {
        const mark = paperMark(p.coin)
        const sz   = Math.abs(p.szi)
        const pnl  = uPnlOf(p, mark)
        s.balance += pnl                          // realise the loss at the mark
        s.positions.splice(s.positions.indexOf(p), 1)
        recordFill(s, {
          coin: p.coin, px: mark, sz, isBuy: p.szi < 0,
          closedPnl: pnl, dir: p.szi > 0 ? 'Close Long' : 'Close Short', oid: null,
        })
        s.orders = s.orders.filter(o => o.coin !== p.coin || !o.reduceOnly)
      }
      events.push(`Cross account LIQUIDATED — equity fell below $${maint.toFixed(2)} maintenance`)
    }
  }

  // 3. Funding accrues on open positions (hourly, % of notional).
  const fundEvents = paperAccrueFunding()
  if (fundEvents.length) { events.push(...fundEvents); dirty = true }

  // 4. Sample the equity curve (once a minute is plenty for the chart).
  const eq   = paperEquity()
  const last = s.equity[s.equity.length - 1]
  if (!last || Date.now() - last[0] > 60_000) {
    s.equity.push([Date.now(), eq])
    if (s.equity.length > MAX_EQ_PTS) s.equity.shift()
    dirty = true
  }

  // Persist on ANY change, not just ones that produced a user-visible event.
  // Cancelling an orphaned TP/SL and appending an equity sample are both silent,
  // so gating the save on `events.length` left them in memory only — the UI looked
  // right until a reload brought the stale orders back and dropped the curve.
  if (dirty || events.length) paperSave()
  return events
}

// ─── SYNTHESIS: the shapes the dashboard already renders ─────────────────────
/** clearinghouseState */
export function paperPerpState() {
  const s      = paperStore()
  const equity = paperEquity()
  const mUsed  = marginUsed(s)
  let   ntl    = 0
  // Maintenance is summed PER POSITION at that asset's own rate — a 3× market
  // maintains far more than a 40× one, so a single blended rate is always wrong.
  let   maint  = 0

  const assetPositions = s.positions.map(p => {
    const mark = paperMark(p.coin) || p.entryPx
    const sz   = Math.abs(p.szi)
    const pv   = sz * mark
    const upnl = uPnlOf(p, mark)
    ntl   += pv
    maint += pv * paperMmf(p.coin)
    return {
      type: 'oneWay',
      position: {
        coin:            p.coin,
        szi:             String(p.szi),
        entryPx:         String(p.entryPx),
        positionValue:   String(pv),
        unrealizedPnl:   String(upnl),
        returnOnEquity:  String(p.margin > 0 ? upnl / p.margin : 0),
        marginUsed:      String(p.margin),
        maxLeverage:     paperMaxLev(p.coin),
        // HL sends null when a position can't be liquidated on price alone (a cross
        // position on a well-funded account). Match that rather than sending "0",
        // so every downstream guard behaves exactly as it does for a real account.
        liquidationPx:   (() => { const l = paperLiqPx(p, s); return l > 0 ? String(l) : null })(),
        leverage:        { type: p.isIsolated ? 'isolated' : 'cross', value: p.leverage, rawUsd: String(p.margin) },
        // sinceOpen = amount PAID (HL's convention; the UI negates it to a cashflow)
        cumFunding:      { allTime: String(p.fundingPaid ?? 0), sinceOpen: String(p.fundingPaid ?? 0), sinceChange: String(p.fundingPaid ?? 0) },
      },
    }
  })

  const summary = {
    accountValue:    String(equity),
    totalNtlPos:     String(ntl),
    totalRawUsd:     String(equity),
    totalMarginUsed: String(mUsed),
  }

  return {
    assetPositions,
    marginSummary:      summary,
    crossMarginSummary: summary,
    crossMaintenanceMarginUsed: String(maint),
    withdrawable:       String(paperWithdrawable()),
    time:               Date.now(),
  }
}

/** frontendOpenOrders */
export function paperOpenOrders() {
  return paperStore().orders.map(o => ({
    coin:        o.coin,
    oid:         o.oid,
    side:        o.isBuy ? 'B' : 'A',
    limitPx:     String(o.limitPx),
    sz:          String(o.sz),
    origSz:      String(o.sz),
    timestamp:   o.timestamp,
    reduceOnly:  o.reduceOnly,
    isTrigger:   o.isTrigger,
    triggerPx:   String(o.triggerPx ?? 0),
    triggerCondition: o.isTrigger ? (o.tpsl === 'tp' ? 'Take Profit' : 'Stop Loss') : 'N/A',
    orderType:   o.isTrigger ? (o.tpsl === 'tp' ? 'Take Profit Market' : 'Stop Market') : 'Limit',
    isPositionTpsl: o.isTrigger && o.reduceOnly,
    tif:         o.isTrigger ? null : 'Gtc',
    cloid:       null,
  }))
}

/** Raw fills, newest first (parseFills-ready). */
export function paperFills() { return paperStore().fills }

/** portfolio — the [period, data] pair list the charts expect. */
export function paperPortfolio() {
  const s   = paperStore()
  const eq  = paperEquity()
  const now = Date.now()
  let hist  = s.equity.length ? [...s.equity] : [[s.created ?? now, s.deposited ?? PAPER_START]]
  hist.push([now, eq])

  // PnL is equity minus net deposits, so funding the account isn't counted as profit.
  const basis = s.deposited ?? PAPER_START
  const pnl = hist.map(([t, v]) => [t, v - basis])
  const win = (ms) => {
    const cut = now - ms
    const h   = hist.filter(([t]) => t >= cut)
    const p   = pnl.filter(([t]) => t >= cut)
    return {
      accountValueHistory: h.length ? h : hist.slice(-2),
      pnlHistory:          p.length ? p : pnl.slice(-2),
      vlm: '0',
    }
  }
  return [
    ['day',       win(24 * 3600e3)],
    ['week',      win(7 * 24 * 3600e3)],
    ['month',     win(30 * 24 * 3600e3)],
    ['allTime',   { accountValueHistory: hist, pnlHistory: pnl, vlm: '0' }],
    ['perpDay',   win(24 * 3600e3)],
    ['perpWeek',  win(7 * 24 * 3600e3)],
    ['perpMonth', win(30 * 24 * 3600e3)],
    ['perpAllTime', { accountValueHistory: hist, pnlHistory: pnl, vlm: '0' }],
  ]
}

/**
 * spotClearinghouseState. Carries BOTH spot tokens and outcome shares, which is
 * where the app already reads each of them from.
 */
export function paperSpotState() {
  const s = paperStore()
  const balances = Object.entries(s.balances ?? {})
    .filter(([, b]) => b.total > 1e-12)
    .map(([coin, b]) => ({
      coin,
      token:    0,
      total:    String(b.total),
      hold:     '0',
      entryNtl: String(b.entryNtl ?? 0),
    }))
  return { balances }
}
