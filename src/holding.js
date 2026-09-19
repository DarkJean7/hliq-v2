/**
 * INSOLVENT TERMINAL — how long you have actually held something
 *
 * A spot balance says what you have, never since when. That is the question a holder asks
 * first — "am I up 20% over a week or over four months" is a different fact about the same
 * +20% — and the app could not answer it.
 *
 * The answer has to be reconstructed from fills, and the naive version is wrong in a way
 * that flatters: the EARLIEST buy is not when you started holding if you sold out in between
 * and bought back. So this walks the fills forward and watches the running size, and the
 * holding period starts the last time that size left zero. Sell everything on Monday, rebuy
 * on Friday, and it says Friday.
 *
 * ── the honest part ──
 *
 * Fills are not a complete account of a balance. Tokens arrive by transfer, by airdrop, from
 * a bridge; and a device that has not walked its whole history yet holds only part of it. So
 * whenever the fills do not add up to the balance on screen, the holding is OLDER than
 * anything they can show, and this says so with `exact: false` rather than reporting a date
 * it cannot stand behind. A confident wrong date is worse than an honest "at least".
 *
 * Spot fills are keyed by PAIR ("@334"), balances by TOKEN NAME ("KNTQ"). Callers pass the
 * keys that mean this coin; getting that mapping wrong is how the Spot tab has already shipped
 * broken twice, so this takes a list and matches any of them rather than guessing.
 */

/** Dust: a balance this far from zero is zero. Relative to the sizes involved, because a
 *  token priced in millionths and a token priced in thousands have very different "nothing". */
const epsFor = (size) => Math.max(1e-9, Math.abs(size) * 1e-6)

const isBuy = (f) => {
  const d = String(f?.dir ?? '')
  if (/buy/i.test(d)) return true
  if (/sell/i.test(d)) return false
  return String(f?.side ?? '').toUpperCase() === 'B'
}

/**
 * When the CURRENT holding of a coin began.
 *
 * `fills`  — any fills; the ones whose coin is in `keys` are used.
 * `keys`   — every name this coin goes by (its token name and its pair id).
 * `size`   — the balance held now, used to decide whether the fills explain it.
 *
 * Returns { since, lastBuy, exact, buys, sells }. `since` is null when nothing can be said.
 */
export function holdingStart(fills, keys, size) {
  const want = new Set((Array.isArray(keys) ? keys : [keys]).filter(Boolean).map(String))
  const mine = (fills ?? [])
    .filter(f => f && want.has(String(f.coin)))
    .map(f => ({ t: Number(f.time), sz: Math.abs(parseFloat(f.sz ?? 0)), buy: isBuy(f) }))
    .filter(f => Number.isFinite(f.t) && f.sz > 0)
    .sort((a, b) => a.t - b.t)

  const held = Math.abs(parseFloat(size) || 0)
  const eps  = epsFor(held || 1)
  if (!mine.length) return { since: null, lastBuy: null, exact: false, buys: 0, sells: 0 }

  let running = 0, since = null, buys = 0, sells = 0, lastBuy = null
  for (const f of mine) {
    if (f.buy) {
      // Leaving zero starts a new holding period. Adding to one already open does not.
      if (running <= eps) since = f.t
      running += f.sz
      lastBuy = f.t
      buys++
    } else {
      running -= f.sz
      sells++
      if (running <= eps) { running = 0; since = null }
    }
  }

  // Do the fills actually account for what is held? If the balance is materially larger than
  // everything they can explain, the rest arrived another way and the holding is older than
  // this date. Smaller is fine: selling more than we have records of just means our history
  // starts mid-position, and `since` is already null or late in that case.
  const exact = since != null && running >= held - Math.max(eps, held * 0.01)
  return { since, lastBuy, exact, buys, sells }
}

/**
 * A duration a person reads at a glance: "3d 4h", "17h 20m", "42m", "just now".
 *
 * Two units at most, and never a unit that is zero — "3d 0h" reads like a rounding error.
 * Past a month the hours stop mattering, so it switches to months and days.
 */
export function fmtHeld(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '—'
  const m = Math.floor(n / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return m + 'm'
  const h = Math.floor(m / 60), rm = m % 60
  if (h < 24) return rm ? `${h}h ${rm}m` : `${h}h`
  const d = Math.floor(h / 24), rh = h % 24
  if (d < 31) return rh ? `${d}d ${rh}h` : `${d}d`
  const mo = Math.floor(d / 30.44), rd = Math.round(d - mo * 30.44)
  return rd ? `${mo}mo ${rd}d` : `${mo}mo`
}

/** A short absolute date — "18 Sep 2026" — so "3d" has something to anchor to. */
export function fmtWhen(ts, locale = undefined) {
  const t = Number(ts)
  if (!Number.isFinite(t) || t <= 0) return '—'
  try {
    return new Date(t).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' })
  } catch {
    return new Date(t).toISOString().slice(0, 10)
  }
}
