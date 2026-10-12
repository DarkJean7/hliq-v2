// Support and resistance zones, from data alone (no drawing, no opinion).
//
// A zone is a price band where swing points from DIFFERENT structures land together: a 4h
// pivot, a daily one and a weekly one at the same price are three independent decisions by
// the market to turn there. That agreement is what a zone is worth -- not how many times one
// timeframe brushed it, which mostly measures how long price sat nearby.
//
// Pure: candles and books in, numbers out. src/analysis.js fetches and draws. Nothing here
// reads the clock except through `now`, so tests/suites/zones.test.mjs can pin it.

export const TFS = ['4h', '1d', '1w']
export const TF_WEIGHT = { '4h': 1, '1d': 2, '1w': 3 }
// Bars each side a swing must beat. A 4h bar is noise at k=2; a weekly one at k=3 needs
// seven weeks to confirm and finds almost nothing.
export const PIVOT_K = { '4h': 3, '1d': 2, '1w': 2 }
const DAY = 864e5

/** SDK candles ({t,o,h,l,c,v} as strings) → numbers, oldest first, junk dropped. */
export function toCandles(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(k => ({ t: +k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v || 0 }))
    .filter(k => k.t > 0 && k.h > 0 && k.l > 0 && k.h >= k.l && Number.isFinite(k.c))
    .sort((a, b) => a.t - b.t)
}

/** Mean true range over the last n bars; null when there are not two bars to compare. */
export function atr(c, n = 14) {
  if (!c || c.length < 2) return null
  const from = Math.max(1, c.length - n)
  let s = 0, m = 0
  for (let i = from; i < c.length; i++) {
    s += Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)); m++
  }
  return m ? s / m : null
}

function median(xs) {
  const a = xs.filter(Number.isFinite).sort((x, y) => x - y)
  return a.length ? a[a.length >> 1] : 0
}

/**
 * Fractal swing points. A high beats every high k bars either side (strictly on the left,
 * not-lower on the right, so a flat double top is one pivot, not two). The last k bars
 * cannot be confirmed yet and are skipped.
 *
 * `react` is how far price went the other way within 3k bars, in ATRs: a pivot price turned
 * hard from is worth more than one it drifted off.
 */
export function pivots(c, k, tf, atrv) {
  const out = []
  if (!c || c.length < 2 * k + 1) return out
  const medV = median(c.map(x => x.v)) || 1
  const a = atrv > 0 ? atrv : null
  for (let i = k; i < c.length - k; i++) {
    let hi = true, lo = true
    for (let j = i - k; j <= i + k && (hi || lo); j++) {
      if (j === i) continue
      if (j < i ? c[j].h >= c[i].h : c[j].h > c[i].h) hi = false
      if (j < i ? c[j].l <= c[i].l : c[j].l < c[i].l) lo = false
    }
    if (!hi && !lo) continue
    const end = Math.min(c.length, i + 1 + 3 * k)
    const after = c.slice(i + 1, end)
    const vol = Math.min(3, c[i].v / medV)
    if (hi) {
      const low = Math.min(...after.map(x => x.l))
      out.push({ px: c[i].h, tf, side: 'high', t: c[i].t, vol, react: a ? Math.max(0, (c[i].h - low) / a) : 0 })
    }
    if (lo) {
      const high = Math.max(...after.map(x => x.h))
      out.push({ px: c[i].l, tf, side: 'low', t: c[i].t, vol, react: a ? Math.max(0, (high - c[i].l) / a) : 0 })
    }
  }
  return out
}

/** Greedy clustering on price: a pivot joins the band whose running mean is within tol. */
export function cluster(ps, tol) {
  const s = [...ps].sort((a, b) => a.px - b.px)
  const out = []
  let cur = null
  for (const p of s) {
    if (cur && p.px - cur.mean <= tol) {
      cur.items.push(p)
      cur.mean += (p.px - cur.mean) / cur.items.length
    } else {
      cur = { items: [p], mean: p.px }
      out.push(cur)
    }
  }
  return out
}

/**
 * Where the volume traded, by price: each bar's dollar volume spread evenly over its own
 * range. POC is the busiest bin; the value area is the 70% around it, grown a bin at a time
 * toward whichever neighbour traded more.
 */
export function volumeProfile(c, nBins = 80) {
  if (!c || !c.length) return null
  const lo = Math.min(...c.map(x => x.l)), hi = Math.max(...c.map(x => x.h))
  if (!(hi > lo)) return null
  const step = (hi - lo) / nBins
  const bins = new Array(nBins).fill(0)
  for (const k of c) {
    const usd = k.v * (k.h + k.l + k.c) / 3
    if (!(usd > 0)) continue
    const span = Math.max(k.h - k.l, step * 1e-6)
    const a = Math.max(0, Math.floor((k.l - lo) / step)), b = Math.min(nBins - 1, Math.floor((k.h - lo) / step))
    for (let i = a; i <= b; i++) {
      const bl = lo + i * step, bh = bl + step
      const part = k.h === k.l ? 1 : Math.max(0, Math.min(bh, k.h) - Math.max(bl, k.l)) / span
      bins[i] += usd * part
    }
  }
  const total = bins.reduce((s, x) => s + x, 0)
  if (!(total > 0)) return null
  let poc = 0
  for (let i = 1; i < nBins; i++) if (bins[i] > bins[poc]) poc = i
  let a = poc, b = poc, acc = bins[poc]
  while (acc < total * 0.7 && (a > 0 || b < nBins - 1)) {
    const left = a > 0 ? bins[a - 1] : -1, right = b < nBins - 1 ? bins[b + 1] : -1
    if (right >= left) acc += bins[++b]; else acc += bins[--a]
  }
  const mid = i => lo + (i + 0.5) * step
  return {
    lo, hi, step, bins, total,
    poc: mid(poc), val: lo + a * step, vah: lo + (b + 1) * step,
    /** Dollar volume traded inside [x, y]. */
    within(x, y) {
      let s = 0
      for (let i = 0; i < nBins; i++) {
        const bl = lo + i * step, bh = bl + step
        const ov = Math.min(bh, y) - Math.max(bl, x)
        if (ov > 0) s += bins[i] * ov / step
      }
      return s
    },
  }
}

const clamp = (x, a, b) => Math.min(b, Math.max(a, x))

/**
 * Every zone, scored 0–100.
 *
 * candles: { '4h': [...], '1d': [...], '1w': [...] } from toCandles (a missing timeframe is
 * an empty array and simply contributes nothing — `counts` says so).
 */
export function buildZones({ candles, price, now = Date.now() }) {
  const c4 = candles['4h'] ?? [], c1 = candles['1d'] ?? []
  if (!(price > 0)) return null
  const atrD = atr(c1) ?? (atr(c4) != null ? atr(c4) * Math.sqrt(6) : null) ?? price * 0.03
  const tol = clamp(0.25 * atrD, 0.0025 * price, 0.02 * price)
  const counts = {}
  const all = []
  for (const tf of TFS) {
    const c = candles[tf] ?? []
    const ps = pivots(c, PIVOT_K[tf], tf, atr(c))
    counts[tf] = { candles: c.length, pivots: ps.length }
    all.push(...ps)
  }
  const vp = volumeProfile(c4)
  const zones = cluster(all, tol).map(cl => {
    const it = cl.items
    const wsum = it.reduce((s, p) => s + TF_WEIGHT[p.tf], 0)
    const center = it.reduce((s, p) => s + p.px * TF_WEIGHT[p.tf], 0) / wsum
    let lo = Math.min(...it.map(p => p.px)), hi = Math.max(...it.map(p => p.px))
    lo = Math.min(lo, center - tol / 2); hi = Math.max(hi, center + tol / 2)
    const tfs = TFS.filter(tf => it.some(p => p.tf === tf))
    const highs = it.filter(p => p.side === 'high').length
    const last = Math.max(...it.map(p => p.t))
    const touches = c4.length ? c4.filter(k => k.l <= hi && k.h >= lo).length / c4.length : null
    // How busy this band was compared with an average band of the same width.
    const density = vp ? (vp.within(lo, hi) / vp.total) / ((hi - lo) / (vp.hi - vp.lo)) : null
    const react = it.reduce((s, p) => s + p.react, 0) / it.length
    const vol = it.reduce((s, p) => s + p.vol, 0) / it.length
    const tfScore = tfs.reduce((s, tf) => s + TF_WEIGHT[tf], 0) / 6
    const score = Math.round(
      35 * tfScore +
      20 * clamp(Math.log2(1 + it.length) / Math.log2(9), 0, 1) +
      15 * clamp(react / 3, 0, 1) +
      10 * Math.exp(-Math.max(0, now - last) / (120 * DAY)) +
      10 * clamp(vol / 2, 0, 1) +
      10 * (density == null ? 0 : clamp(density / 2, 0, 1)))
    const kind = price > hi ? 'support' : price < lo ? 'resistance' : 'at'
    // Built from the other side's swings: an old ceiling price has since gone through.
    const flip = (kind === 'support' && highs > it.length - highs) || (kind === 'resistance' && highs < it.length - highs)
    return {
      px: center, lo, hi, kind, flip, tfs, confluence: tfs.length, pivots: it.length, highs,
      touches, density, react, last, score: clamp(score, 0, 100), dist: (center - price) / price,
    }
  })
  return { zones, price, tol, atrD, counts, profile: vp && { poc: vp.poc, vah: vp.vah, val: vp.val } }
}

// ── the order book ──────────────────────────────────────────────────────────

/**
 * l2Book responses at several aggregations, finest first → parsed books with their reach.
 * A level is { px, sz, n } numbers; `step` is the bucket size (the finest gap seen).
 */
export function parseBooks(raws) {
  const out = []
  for (const r of raws ?? []) {
    const lv = r?.levels
    if (!Array.isArray(lv) || lv.length < 2) continue
    const p = side => (side ?? []).map(x => ({ px: +x.px, sz: +x.sz, n: +x.n || 0 })).filter(x => x.px > 0 && x.sz > 0)
    const bids = p(lv[0]), asks = p(lv[1])
    if (!bids.length || !asks.length) continue
    const gaps = [...bids.slice(1).map((x, i) => bids[i].px - x.px), ...asks.slice(1).map((x, i) => x.px - asks[i].px)].filter(g => g > 0)
    out.push({ bids, asks, lo: bids[bids.length - 1].px, hi: asks[asks.length - 1].px, step: gaps.length ? Math.min(...gaps) : 0 })
  }
  return out
}

export function bookMid(books) {
  const b = books?.[0]
  return b ? (b.bids[0].px + b.asks[0].px) / 2 : null
}

/** The resting orders inside a zone, from the finest book that reaches it and can resolve it. */
export function wallFor(zone, books) {
  for (const b of books ?? []) {
    if (zone.lo < b.lo || zone.hi > b.hi) continue
    if (b.step > (zone.hi - zone.lo)) continue
    let usd = 0, n = 0
    for (const x of [...b.bids, ...b.asks]) if (x.px >= zone.lo && x.px <= zone.hi) { usd += x.px * x.sz; n += x.n }
    return { usd, orders: n, perOrder: n ? usd / n : null }
  }
  return null   // outside the book: not "no orders", just not visible from here
}

/** How far the widest book reaches, as a fraction of mid, on its shorter side. */
export function bookReach(books) {
  const mid = bookMid(books)
  if (!mid) return null
  return Math.max(...books.map(b => Math.min((mid - b.lo) / mid, (b.hi - mid) / mid)))
}

/** Bid $ ÷ ask $ within ±pct of mid, from the finest book that reaches that far on both sides. */
export function bookRatio(books, pct = 0.02) {
  const mid = bookMid(books)
  if (!mid) return null
  const lo = mid * (1 - pct), hi = mid * (1 + pct)
  const b = books.find(x => x.lo <= lo && x.hi >= hi) ?? books[books.length - 1]
  const sum = (side, ok) => side.filter(x => ok(x.px)).reduce((s, x) => s + x.px * x.sz, 0)
  const bid = sum(b.bids, px => px >= lo), ask = sum(b.asks, px => px <= hi)
  return ask > 0 ? { ratio: bid / ask, bid, ask, pct } : null
}
