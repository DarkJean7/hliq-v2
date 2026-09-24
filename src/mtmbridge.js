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

/**
 * ── what a fixed book cannot do, and why the headline still stepped ──
 *
 * Reported as "when a position open/closes the account equity spikes", and it is the same
 * failure at both ends of a trade:
 *
 *   CLOSING — mtmDelta stops accruing a coin the moment it leaves the live positions. But the
 *             price move it had accrued since the snapshot did not evaporate; closing is
 *             exactly what makes it REAL. Carrying $180 of gain on a short and then closing it
 *             took the headline down $180 until the next snapshot, and the drop had nothing to
 *             do with the trade's result.
 *   OPENING — a position opened after the snapshot is not in the book, so the market moving it
 *             counts as nothing until the next snapshot lands and it all arrives at once.
 *
 * So the book is advanced as positions are observed, rather than fixed at the snapshot:
 *
 *   · a size that SHRINKS banks the closed part at the last mark seen — realized, permanent,
 *     and it stays in the carry until a new snapshot replaces the whole state;
 *   · a size that GROWS keeps the entry at the size-weighted mark of the old and the new, so
 *     Σ size × (mark now − mark) still describes the whole holding exactly;
 *   · a coin that APPEARS joins at the mark it is first seen at, which is what opening it did
 *     to the account: nothing at that instant, and every tick after it counts;
 *   · a FLIP is both — the old side is banked, the new side joins at the current mark.
 *
 * What it still cannot see is the fee, and the gap between the last mark observed and the
 * price the fill actually got. Both are small and both are corrected by the next snapshot —
 * which is the whole contract of this file: a bridge that drifts by cents rather than one that
 * steps by hundreds.
 */

/** A state from whatever the caller has: a state, a bare book (persisted by an older
 *  version, or handed over by the server), or nothing. */
function asState(s) {
  if (!s || typeof s !== 'object') return null
  if (s.book && typeof s.book === 'object') {
    return { book: s.book, realized: Number(s.realized) || 0, marks: s.marks && typeof s.marks === 'object' ? s.marks : {} }
  }
  return { book: s, realized: 0, marks: {} }        // a bare book: nothing banked yet
}

/** A fresh state from the positions held when a snapshot was read. */
export function bookState(assetPositions) {
  const book = mtmBook(assetPositions)
  return { book, realized: 0, marks: Object.fromEntries(Object.entries(book).map(([c, v]) => [c, v[1]])) }
}

/**
 * The state after seeing `live`. Returns a NEW state; the old one is left alone, so a caller
 * that decides not to trust this reading can keep what it had.
 *
 * `live` null or not an array means "not observed this tick" — the state is returned unchanged
 * rather than treated as an account with nothing in it, which would bank every open position
 * as closed (empty is not the same as unknown).
 */
export function advanceBook(prev, live) {
  const s = asState(prev)
  if (!s) return null
  if (!Array.isArray(live)) return s
  const now = mtmBook(live)
  const book = {}, marks = { ...s.marks }
  let realized = s.realized

  for (const [coin, v] of Object.entries(s.book)) {
    const [sz, mark] = v ?? []
    if (!Number.isFinite(sz) || !Number.isFinite(mark)) continue
    const n = now[coin]
    // Gone, or flipped to the other side: all of it was closed. At the last mark seen, which
    // is at most one tick old — the fill happened near it.
    if (!n || Math.sign(n[0]) !== Math.sign(sz)) {
      // A flip still shows a mark, so use it; a coin that is simply gone is valued at the
      // last mark seen for it, at most one tick old.
      const last = n ? n[1] : (Number.isFinite(marks[coin]) ? marks[coin] : mark)
      realized += sz * (last - mark)
      continue
    }
    const [liveSz, markNow] = n
    if (Math.abs(liveSz) < Math.abs(sz)) {
      realized += (sz - liveSz) * (markNow - mark)   // the part that just became real
      book[coin] = [liveSz, mark]
    } else if (Math.abs(liveSz) > Math.abs(sz)) {
      // Added to: one entry at the size-weighted mark, which is exact for the pair.
      book[coin] = [liveSz, (sz * mark + (liveSz - sz) * markNow) / liveSz]
    } else {
      book[coin] = [sz, mark]
    }
  }
  // Opened since: it joins at the mark it is first seen at, so it contributes nothing now and
  // everything after. A flipped coin arrives here too, its old side already banked above.
  for (const [coin, n] of Object.entries(now)) {
    if (!book[coin]) book[coin] = [n[0], n[1]]
  }
  for (const [coin, n] of Object.entries(now)) marks[coin] = n[1]
  return { book, realized, marks }
}

/**
 * The whole carry: what price has done to what is still held, plus what closing banked.
 *
 * Null when the live positions are unknown — the caller holds its last figure rather than
 * publishing a snapshot with the price moves stripped out.
 */
export function mtmCarry(state, live) {
  const s = asState(state)
  if (!s) return null
  const d = mtmDelta(s.book, live)
  return d == null ? null : s.realized + d
}
