// Which grid levels are still holding the lot they bought.
//
// Reported: "the grid bot is buying the same level multiple times without selling" — HYPE,
// 0xAB33…9B79, a $70–$90 long grid, 2026-11-12/13. The account carried older HYPE at an
// average entry near $79. The grid bought 5.62 at $70 (level 0); its natural exit is one level
// up at $72.22, but that closes below the average, so the profit gate placed it at $81 and $83
// instead. The only thing that kept a level from re-buying was "is there an exit resting one
// level above it" — and there was not, because the gate had moved it. So level 0 re-armed and
// bought 5.62 at $70 again: inventory 15.87 → 21.49 → 27.11, with nothing sold.
//
// A level is now held from the moment its entry fills until an exit fill releases it, wherever
// the gate put that exit. Built from the account's own fills, so it survives the restart every
// deploy causes — the in-memory order map does not, which is also why the first $70 fill was
// never even logged as a FILL.
//
// Pure: no exchange, no clock. strategies/grid.js feeds it fills.

// The level an order at `px` sat on, or -1. Same 40%-of-a-gap tolerance snapshotOrders uses.
export function levelOf(px, prices) {
  let best = -1, bestDist = Infinity
  for (let i = 0; i < prices.length; i++) {
    const d = Math.abs(prices[i] - px)
    if (d < bestDist) { bestDist = d; best = i }
  }
  if (best < 0) return -1
  const gap = prices.length < 2 ? prices[0] * 0.01
    : best >= prices.length - 1 ? prices[best] - prices[best - 1] : prices[best + 1] - prices[best]
  return bestDist <= gap * 0.4 ? best : -1
}

// held: Map levelIdx → size still held from that level's entry.
// A long grid enters with buys (side 'B'), a short with sells ('A').
export function applyFill(held, fill, { prices, isShort }) {
  const sz = Math.abs(parseFloat(fill.sz))
  const px = parseFloat(fill.px)
  if (!(sz > 0) || !(px > 0)) return held
  const isEntry = isShort ? fill.side === 'A' : fill.side === 'B'
  if (isEntry) {
    const i = levelOf(px, prices)
    if (i >= 0) held.set(i, (held.get(i) ?? 0) + sz)
    return held
  }
  // An exit releases the lot it most naturally closes: a long's sell closes the highest held
  // level below it (the one a normal grid would have paired it with), then the next one down;
  // a short's buy closes the lowest held level above it. Only if none sits on that side — an
  // exit placed the "wrong" side of a level is impossible for the bot, but a manual close is
  // not — does it fall back to the rest, nearest first.
  let left = sz
  const order = [...held.keys()].sort((a, b) => {
    const da = isShort ? prices[a] - px : px - prices[a]
    const db = isShort ? prices[b] - px : px - prices[b]
    // same side as a natural pair first (positive distance), nearest first
    if ((da > 0) !== (db > 0)) return da > 0 ? -1 : 1
    return Math.abs(da) - Math.abs(db)
  })
  for (const i of order) {
    if (left <= 0) break
    const h = held.get(i)
    const take = Math.min(h, left)
    left -= take
    if (h - take > 1e-9) held.set(i, h - take); else held.delete(i)
  }
  return held
}

export function heldFromFills(fills, opts) {
  const held = new Map()
  const coinFills = (fills ?? []).filter(f => f.coin === opts.coin).sort((a, b) => a.time - b.time)
  for (const f of coinFills) applyFill(held, f, opts)
  return held
}

// Held can never be more than the position. If it is, something closed outside the grid's
// view — a manual close, a liquidation, fills older than the window it was built from — and
// the levels farthest from where entries happen are released first (a long's highest, a
// short's lowest), so the levels next to the mark stay guarded longest.
export function clampToInventory(held, inventory, { isShort }) {
  let over = [...held.values()].reduce((s, v) => s + v, 0) - Math.max(0, inventory)
  if (over <= 1e-9) return held
  const order = [...held.keys()].sort((a, b) => isShort ? a - b : b - a)
  for (const i of order) {
    if (over <= 1e-9) break
    const h = held.get(i), take = Math.min(h, over)
    over -= take
    if (h - take > 1e-9) held.set(i, h - take); else held.delete(i)
  }
  return held
}

// Is level i holding a lot? Only while more than a quarter of it is unsold. Exits are sized off
// other levels and split where the profit gate puts them (the $70 lot above sold as 4.99 + 0.63,
// in the replay as 5.13 + 0.49), so they never match the lot exactly. Requiring every last coin
// would lock a level until a far exit — $90 — happened to fill; this frees it once most of the
// lot is sold, so the most a re-buy can run ahead of the sales is under a quarter of a lot.
export function isHeld(held, i, lotSz) {
  return (held.get(i) ?? 0) > lotSz * 0.25
}
