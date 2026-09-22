/**
 * INSOLVENT TERMINAL — carrying an equity snapshot forward by price, and by nothing else
 *
 * Every equity figure is HL's portfolio value (exact, measured live — its last point is one or
 * two seconds old) carried forward to "now" until the next snapshot lands. The carry used to be
 * the change in PERP EQUITY, or in the rows' own totals:
 *
 *     value = snapshot + (live perp equity − perp equity when the snapshot was taken)
 *
 * Perp equity moves for reasons that are not money: Hyperliquid moves USDC between the spot and
 * perp sides to fund a position or reserve an order, a bot tops up its margin, a row is rebuilt,
 * a cache refreshes. Each of those got its own detector — src/perpcash.js, reanchor() and
 * acctBase in src/comboequity.js — and each detector opened the next hole. The eqstep telemetry
 * for 2026-09-21 is five of them in forty minutes:
 *
 *     13:32  step −569  acctBase=7122.83 while the rows summed 6563.53 — the base was sampled
 *                       from rows in a transient state, and every tick carried that error
 *     13:34  step −430  liveShift −429.77 → 0: a row rebuilt, its transfer shift reset, and
 *                       reanchor() read the reset as a perp move and absorbed nothing
 *     13:40  step −1009 acctBase=7607.61 against 6595.32 live, for a whole snapshot period
 *
 * Each one put itself right when the next snapshot arrived. The snapshot was never the problem;
 * the carry was.
 *
 * The only thing that changes an account's value between two snapshots at any size is PRICE
 * acting on what is held:
 *
 *     value = snapshot + Σ size × (mark now − mark at the snapshot)
 *
 * A transfer, a reserve, a rebuilt row or a refreshed cache moves no position and no mark, so
 * nothing here can see it. Measured against HL's own figure on three wallets over two minutes,
 * this tracked within about a dollar. HIP-3 positions are included, because HL's portfolio value
 * includes them: over the same run a wallet's move was its main-dex PnL plus its HIP-3 PnL.
 *
 * What it does not see until the next snapshot, all of it small and none of it a spike:
 *   - fees and the fill-vs-mark slippage on a trade;
 *   - the PnL of inventory added since the snapshot. The size used is the smaller of the
 *     snapshot's and the live one, same direction, so a close stops accruing the moment it
 *     happens, and a flip counts nothing;
 *   - spot token prices (the old bridge did not carry those either).
 */

const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

/**
 * The positions and their marks, as a plain object `{ coin: [szi, mark] }` — plain so it
 * survives JSON (the combined snapshot comes from the server, and a row's history is persisted).
 * Accepts either shape HL returns: `{ position: {...} }` or the bare position.
 *
 * The mark is `positionValue / |szi|`, the same figure HL values the account at. Main-dex and
 * HIP-3 ("dex:COIN") alike.
 */
export function mtmBook(assetPositions) {
  const book = {}
  for (const ap of assetPositions ?? []) {
    const p = ap?.position ?? ap
    const szi = num(p?.szi), pv = num(p?.positionValue)
    if (!p?.coin || !szi || pv == null) continue
    book[p.coin] = [szi, Math.abs(pv) / Math.abs(szi)]
  }
  return book
}

/** Two books as one, the later one winning a coin both carry. */
export function mergeBooks(...books) {
  return Object.assign({}, ...books.filter(b => b && typeof b === 'object'))
}

/**
 * How much the account has made or lost on price since the book was taken.
 *
 * `book`   — from mtmBook() at snapshot time.
 * `live`   — the current positions (either shape), or null when they are not known.
 *
 * Null when either side is missing — not zero. The caller holds its last figure rather than
 * publishing a snapshot with the price moves stripped out (empty is not the same as unknown).
 */
export function mtmDelta(book, live) {
  if (!book || typeof book !== 'object' || !Array.isArray(live)) return null
  const now = mtmBook(live)
  let d = 0
  for (const [coin, v] of Object.entries(book)) {
    const [a, markThen] = v ?? []
    const n = now[coin]
    if (!n || !Number.isFinite(a) || !Number.isFinite(markThen)) continue   // closed since: stopped accruing
    const [b, markNow] = n
    if (Math.sign(a) !== Math.sign(b)) continue                             // flipped: nothing of the old one is left
    const sz = Math.sign(a) * Math.min(Math.abs(a), Math.abs(b))
    d += sz * (markNow - markThen)
  }
  return d
}
