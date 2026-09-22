/**
 * INSOLVENT TERMINAL — sorting the market list by several columns at once
 *
 * Asked for as "sort by OI, followed by Chg%, Volume, Price — as many as I want, in that order…
 * sorted by open interest and at the same time by volume, OI takes precedence".
 *
 * ── why not "OI, then Volume to break ties" ──
 *
 * That is what a spreadsheet does, and here it would do nothing: OI, volume, change and price
 * are continuous, so two markets essentially never tie on the first column and the second one
 * is never consulted. "OI, Volume" would sort exactly like "OI".
 *
 * So each chosen column RANKS every market (0 = worst, 1 = best, in that column's direction),
 * and the ranks are blended with weights that fall with priority: the first column counts most,
 * the second less, and so on (n, n−1, … 1). OI still leads — a market needs a high OI rank to
 * sit near the top — but a market that is also near the top on volume beats one that is high
 * on OI alone. Ranks, not raw values, because the columns are in different units: blending
 * dollars of OI with percent change would let the biggest number win outright.
 *
 * One column chosen gives exactly that column's order. Ties on the blended score fall back to
 * the first column's own value, then to the caller's tiebreak.
 *
 * Pure: no DOM, no state. tests/suites/mktsort.test.mjs.
 */

export const SORT_KEYS = ['oi', 'change', 'volume', 'price']
const isKey = (k) => SORT_KEYS.includes(k)

/**
 * Pressing a column in multi mode: not chosen → added last, descending; descending →
 * ascending; ascending → removed. So one column can be put anywhere in the order and in either
 * direction with nothing but presses.
 */
export function cycleSortKey(keys, k) {
  if (!isKey(k)) return keys ?? []
  const list = (keys ?? []).filter(x => isKey(x?.k))
  const i = list.findIndex(x => x.k === k)
  if (i < 0) return [...list, { k, dir: 'desc' }]
  if (list[i].dir === 'desc') return list.map((x, j) => (j === i ? { k, dir: 'asc' } : x))
  return list.filter((_, j) => j !== i)
}

/** A stored selection, cleaned: known columns only, each once, directions valid. */
export function cleanSortKeys(keys) {
  const seen = new Set()
  const out = []
  for (const x of Array.isArray(keys) ? keys : []) {
    if (!isKey(x?.k) || seen.has(x.k)) continue
    seen.add(x.k)
    out.push({ k: x.k, dir: x.dir === 'asc' ? 'asc' : 'desc' })
  }
  return out
}

/**
 * Each item's rank in one column, 0..1 with 1 the best in that direction. Equal values share
 * the average of their positions, so a block of zeros (spot markets have no OI) neither helps
 * nor hurts any one of them.
 */
function ranks(vals, dir) {
  const n = vals.length
  const idx = vals.map((v, i) => i)
  const val = (i) => (Number.isFinite(vals[i]) ? vals[i] : 0)
  idx.sort((a, b) => (dir === 'asc' ? val(a) - val(b) : val(b) - val(a)))
  const out = new Array(n)
  for (let s = 0; s < n;) {
    let e = s
    while (e + 1 < n && val(idx[e + 1]) === val(idx[s])) e++
    const pos = (s + e) / 2
    const r = n > 1 ? 1 - pos / (n - 1) : 1
    for (let j = s; j <= e; j++) out[idx[j]] = r
    s = e + 1
  }
  return out
}

/**
 * Sort `items` by the blended rank of `keys` ([{ k, dir }], in priority order).
 * `valueOf(item, k)` reads one column; `tiebreak(a, b)` orders anything still level.
 * Returns a new array; the input is left alone.
 */
export function multiSort(items, keys, valueOf, tiebreak = () => 0) {
  const ks = cleanSortKeys(keys)
  const list = [...(items ?? [])]
  if (!ks.length || list.length < 2) return list
  const n = ks.length
  const score = new Array(list.length).fill(0)
  ks.forEach((key, pri) => {
    const w = n - pri
    const r = ranks(list.map(it => Number(valueOf(it, key.k))), key.dir)
    for (let i = 0; i < list.length; i++) score[i] += w * r[i]
  })
  const lead = ks[0]
  const leadVal = (it) => { const v = Number(valueOf(it, lead.k)); return Number.isFinite(v) ? v : 0 }
  return list
    .map((it, i) => ({ it, s: score[i] }))
    .sort((a, b) => {
      if (b.s !== a.s) return b.s - a.s
      const d = lead.dir === 'asc' ? leadVal(a.it) - leadVal(b.it) : leadVal(b.it) - leadVal(a.it)
      return d !== 0 ? d : tiebreak(a.it, b.it)
    })
    .map(x => x.it)
}
