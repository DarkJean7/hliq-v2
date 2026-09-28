/**
 * INSOLVENT TERMINAL — what a deposit would buy you
 *
 * Asked for: "i have an account with a position close to liquidation. i was wondering how much
 * capital i may need to deposit in the app to get a good liquidation price. this way an user
 * can know if the deposit would be in vain or to protect the position."
 *
 * Both directions of the same line, because that is the question in both of its forms:
 *
 *   FORWARD   I can spare $500 — where does liquidation move to?
 *   INVERSE   I want 20% of room — what does that cost?
 *
 * ── the model ──
 *
 * On a CROSS position the whole account backs the trade, so a deposit is margin. Hyperliquid's
 * own formula (Trading → Liquidations):
 *
 *     liq = price − side × margin_available / size / (1 − mf × side)
 *
 * with `mf` the maintenance fraction, side +1 long / −1 short, and margin_available for cross
 * being account value less maintenance margin required. Only `margin_available` moves when you
 * deposit, so at a fixed size the liquidation price is LINEAR in the money added:
 *
 *     long:   liq falls by  D / (size × (1 − mf))
 *     short:  liq rises by  D / (size × (1 + mf))
 *
 * ── anchored on HL's own number, not on a rebuild of it ──
 *
 * The starting point is the liquidation price the exchange reports for the position, and only
 * the CHANGE is modelled. Re-deriving the current liq from entry and margin would produce a
 * preview that disagrees with the card above it at $0 deposit, and this app has already paid
 * for the habit of rebuilding figures Hyperliquid publishes (see src/mtmbridge.js, and the
 * Net PnL that came out $420 short).
 *
 * ── what it does not do ──
 *
 * An ISOLATED position is walled off: its margin is its own, and money in the account does not
 * reach it until you add margin to that position specifically. Those are listed and marked
 * rather than silently given a number, because "your deposit would be in vain" is precisely
 * the answer the reader came for.
 *
 * Every cross position on the wallet moves together — one deposit, one shared pool — so the
 * preview is the whole book, not the one position that prompted it. And it is a snapshot: the
 * marks that set maintenance margin keep moving, and a fill or funding will shift it.
 */

import { maintFraction } from './guardplan.js'
import { fmtUSD, fmtPrice, esc } from './format.js'

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

/** A position is cross unless Hyperliquid says isolated. */
export const isCross = (p) => String((p?.leverage?.type ?? 'cross')).toLowerCase() !== 'isolated'

/**
 * Dollars of margin that move this position's liquidation price by one dollar.
 *
 * Null when the position cannot answer — a size of zero has no liquidation price to move, and
 * a made-up slope would put a confident number on a blank.
 */
export function marginPerDollar({ isLong, size, maxLev }) {
  const mf = maintFraction(num(maxLev) ?? 0)
  const s  = num(size)
  if (!(s > 0)) return null
  const v = s * (isLong ? 1 - mf : 1 + mf)
  return v > 0 ? v : null
}

/** Where liquidation lands after adding `deposit` to the account. Null if unknowable. */
export function liqAfterDeposit({ isLong, size, liq, maxLev, deposit }) {
  const per = marginPerDollar({ isLong, size, maxLev })
  const l   = num(liq)
  const d   = num(deposit) ?? 0
  if (per == null || l == null || !(l > 0)) return null
  const moved = isLong ? l - d / per : l + d / per
  // A long's liquidation cannot go below zero, and a short's cannot come back down past it.
  return Math.max(0, moved)
}

/** What it costs to put liquidation exactly at `target`. Negative means it is already past. */
export function depositForLiq({ isLong, size, liq, maxLev, target }) {
  const per = marginPerDollar({ isLong, size, maxLev })
  const l   = num(liq)
  const t   = num(target)
  if (per == null || l == null || t == null) return null
  return (isLong ? l - t : t - l) * per
}

/**
 * What it costs to hold liquidation `pct` percent away from the mark — the way the question is
 * actually asked ("how much for 20% of room?"), rather than as a price.
 */
export function depositForDistance({ isLong, size, liq, maxLev, mark, pct }) {
  const m = num(mark), p = num(pct)
  if (m == null || p == null || !(m > 0)) return null
  const target = isLong ? m * (1 - p / 100) : m * (1 + p / 100)
  return depositForLiq({ isLong, size, liq, maxLev, target })
}

/** How far liquidation sits from the mark, as a percentage of the mark. Null if unknowable. */
export function distancePct(mark, liq) {
  const m = num(mark), l = num(liq)
  if (m == null || l == null || !(m > 0) || !(l > 0)) return null
  return Math.abs(m - l) / m * 100
}

/**
 * One row per position: what it is now, and what `deposit` makes of it.
 *
 * `positions` are HL's assetPositions in either shape. Isolated ones come back with
 * `cross: false` and no projection — the deposit does not reach them.
 */
export function previewRows(positions, deposit = 0) {
  const rows = []
  for (const ap of positions ?? []) {
    const p = ap?.position ?? ap
    const szi = num(p?.szi)
    if (!p?.coin || szi == null || szi === 0) continue
    const isLong = szi > 0
    const size   = Math.abs(szi)
    const liq    = num(p.liquidationPx)
    const mark   = num(p.positionValue) != null && size > 0 ? Math.abs(num(p.positionValue)) / size : num(p.entryPx)
    const maxLev = num(p.maxLeverage) ?? num(p.leverage?.value) ?? 1
    const cross  = isCross(p)
    const newLiq = cross ? liqAfterDeposit({ isLong, size, liq, maxLev, deposit }) : liq
    rows.push({
      coin: p.coin, isLong, size, mark, liq, maxLev, cross,
      acct: p._acctAddr ?? null,
      newLiq,
      distNow: distancePct(mark, liq),
      distNew: distancePct(mark, newLiq),
      perDollar: cross ? marginPerDollar({ isLong, size, maxLev }) : null,
    })
  }
  // What a deposit can actually help first, and within that the closest to liquidation —
  // which is the one the question is about. An isolated position is on the list to say the
  // money would not reach it, and that belongs under the answer rather than inside it.
  return rows.sort((a, b) =>
    (a.cross === b.cross ? 0 : a.cross ? -1 : 1) || (a.distNow ?? 1e9) - (b.distNow ?? 1e9))
}

/** The position a deposit is most urgently for, or null when nothing is cross. */
export function mostAtRisk(rows) {
  return (rows ?? []).find(r => r.cross && r.distNow != null) ?? null
}

/**
 * The whole answer for one position, in the words the question was asked in: what each of a
 * few deposits buys, and what a few targets cost.
 *
 * `steps` are dollar amounts, `targets` are distances in percent. Both are filtered to what is
 * meaningful: a target the position has already passed costs nothing to reach.
 */
export function ladder(row, steps = [100, 250, 500, 1000, 2500], targets = [10, 20, 30, 50]) {
  if (!row?.cross || row.liq == null || row.perDollar == null) return { steps: [], targets: [] }
  const { isLong, size, liq, maxLev, mark } = row
  return {
    steps: steps.map(d => ({
      deposit: d,
      liq: liqAfterDeposit({ isLong, size, liq, maxLev, deposit: d }),
      dist: distancePct(mark, liqAfterDeposit({ isLong, size, liq, maxLev, deposit: d })),
    })),
    targets: targets
      .map(pct => ({ pct, deposit: depositForDistance({ isLong, size, liq, maxLev, mark, pct }) }))
      .filter(t => t.deposit != null && t.deposit > 0),
  }
}


// ── the sheet ─────────────────────────────────────────────────────────────────

/** Presets, in the order they are offered. */
export const STEPS = [100, 250, 500, 1000, 2500]

const money = (v) => '$' + fmtUSD(Math.abs(v))
const px    = (v) => (v > 0 ? '$' + fmtPrice(v) : '—')

/**
 * The projected price at the same scale as the one it replaces.
 *
 * fmtPrice picks its decimals from the magnitude of each number on its own, so a pair meant
 * to be read against each other came out "$2,900.00 → $2,848.718". Whatever the exchange's
 * own price shows, the projection matches it.
 */
function pxLike(v, ref) {
  if (!(v > 0)) return '—'
  const shown = fmtPrice(ref)
  const dot = shown.indexOf('.')
  const dec = dot < 0 ? 0 : shown.length - dot - 1
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
}

/**
 * One position's line: where liquidation is, where the deposit puts it, and how much room
 * that buys. Isolated positions say why nothing moved instead of showing an unchanged number
 * as though it were an answer.
 */
function rowHtml(r, deposit) {
  const moved = r.cross && deposit > 0 && r.newLiq != null && Math.abs(r.newLiq - r.liq) > 1e-9
  const dist  = (d) => (d == null ? '—' : d.toFixed(1) + '%')
  const side  = r.isLong ? 'long' : 'short'
  return `<div class="liqd-row">
    <div class="liqd-row-head">
      <span class="liqd-coin">${esc(r.coin)}</span>
      <span class="liqd-side ${r.isLong ? 'pos' : 'neg'}">${side}</span>
      ${r.cross ? '' : '<span class="liqd-iso">isolated</span>'}
    </div>
    ${r.cross ? `<div class="liqd-liqs">
      <span class="${moved ? 'liqd-from' : ''}">${px(r.liq)}</span>
      ${moved ? `<span class="liqd-arrow">&rarr;</span><span class="liqd-to">${pxLike(r.newLiq, r.liq)}</span>` : ''}
    </div>
    <div class="liqd-dist">${dist(r.distNow)}${moved ? ' &rarr; ' + dist(r.distNew) : ''} from the mark${
      r.perDollar ? ` &middot; ${money(r.perDollar)} per $1 of room` : ''}</div>`
    : `<div class="liqd-liqs"><span>${px(r.liq)}</span></div>
       <div class="liqd-dist liqd-warn">A deposit does not reach this one &mdash; add margin to the position itself.</div>`}
  </div>`
}

/**
 * The whole sheet.
 *
 * `rows` from previewRows(), `deposit` the amount being tried. `target` is the row the
 * costings are about — the one nearest liquidation unless the reader opened the sheet from a
 * particular card.
 */
export function sheetHtml(rows, deposit = 0, { coin = null, walletLabel = '' } = {}) {
  const cross = (rows ?? []).filter(r => r.cross)
  const focus = (coin && (rows ?? []).find(r => r.coin === coin && r.cross)) || mostAtRisk(rows)
  const l = focus ? ladder(focus) : { steps: [], targets: [] }

  const chips = STEPS.map(v =>
    `<button class="liqd-chip${Math.abs(deposit - v) < 1e-9 ? ' on' : ''}" onclick="window.__liqDepSet(${v})">+$${v >= 1000 ? (v / 1000) + 'k' : v}</button>`).join('')

  const costs = l.targets.length ? `<div class="liqd-costs">
    <div class="liqd-costs-title">To hold ${esc(focus.coin)} that far from the mark</div>
    ${l.targets.map(x => `<button class="liqd-cost" onclick="window.__liqDepSet(${x.deposit.toFixed(2)})">
        <span class="liqd-cost-pct">${x.pct}%</span>
        <span class="liqd-cost-amt">${money(x.deposit)}</span>
      </button>`).join('')}
  </div>` : (focus ? `<div class="liqd-costs-none">${esc(focus.coin)} already sits further from liquidation than any of these targets.</div>` : '')

  return `<div class="liqd-head">
      <div>
        <div class="liqd-title">What would a deposit do?</div>
        <div class="liqd-sub">${cross.length} cross position${cross.length === 1 ? '' : 's'}${
          walletLabel ? ' &middot; ' + esc(walletLabel) : ''}</div>
      </div>
      <button class="liqd-x" onclick="window.__liqDepClose()">&#10005;</button>
    </div>
    <div class="liqd-amt-wrap">
      <span class="liqd-amt-cur">$</span>
      <input id="liqDepAmt" class="liqd-amt" type="number" inputmode="decimal" min="0" step="any"
             placeholder="0.00" value="${deposit > 0 ? deposit.toFixed(2) : ''}"
             oninput="window.__liqDepSet(this.value, true)">
      <button class="liqd-clear" onclick="window.__liqDepSet(0)">Clear</button>
    </div>
    <div class="liqd-chips">${chips}</div>
    <div class="liqd-rows">${(rows ?? []).length
      ? (rows ?? []).map(r => rowHtml(r, deposit)).join('')
      : '<div class="liqd-empty">No open positions on this wallet.</div>'}</div>
    ${costs}
    <div class="liqd-foot">An estimate, from Hyperliquid\'s own liquidation price for each
      position. Cross positions share the account, so one deposit moves all of them together.
      Marks keep moving, and a fill or funding will shift these again.</div>`
}
