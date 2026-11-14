// "Hide small balances" for the Spot list.
//
// Asked for: "add the option to hide small spot amounts. currently kntq is irrelevant" — 0.013
// KNTQ worth $0.00 sat between USDC and HYPE on every look at the tab.
//
// A holding is small only when its value is KNOWN and under the line. No price (a market not
// quoting yet) is not the same as worthless: that row stays, because hiding it would hide a
// holding we simply cannot value.
//
// Used by the mobile Spot tab (single account and All Accounts) and the desktop Overview's Spot
// tab, so all three agree on what is hidden.

export const SMALL_SPOT_USD = 1
const KEY = 'hliq_spot_hide_small'

export function isSmallSpot(usd, px) {
  return px > 0 && Number.isFinite(usd) && usd < SMALL_SPOT_USD
}

export function hideSmallOn() {
  try { return localStorage.getItem(KEY) === '1' } catch { return false }
}
export function setHideSmall(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch {}
}

// Splits rows by smallness. `value(row)` → { usd, px }.
export function splitSmall(rows, value) {
  const keep = [], small = []
  for (const r of rows) {
    const { usd, px } = value(r)
    ;(isSmallSpot(usd, px) ? small : keep).push(r)
  }
  return { keep, small }
}

// The chip above the list. Only drawn when there is something small to hide — otherwise it is a
// control with nothing to do. `onclick` is the inline handler to run.
export function hideSmallBar({ smallCount, on, onclick }) {
  if (!smallCount) return ''
  const n = on ? `<span class="spot-small-n">${smallCount} hidden</span>` : ''
  return `<div class="spot-small-bar"><button class="pc-chip${on ? ' on' : ''}" data-spot-hide-small onclick="${onclick}" aria-pressed="${on}">` +
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-2.2 3.2M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7a9.8 9.8 0 0 0 5.4-1.6"/></svg>` +
    `Hide small (&lt; $${SMALL_SPOT_USD})</button>${n}</div>`
}
