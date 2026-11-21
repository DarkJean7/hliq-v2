/**
 * The Outlook tab's live track record (version 2): every rating the tab shows is logged, and
 * graded once its horizon has passed — was the price higher, lower, or about the same?
 *
 * Asked as part of "do version 2": the past-accuracy line (outlook.js pastRecord) replays only
 * the signals that have history; this one grades the actual score, all six signals, as it was
 * shown, against what happened afterwards.
 *
 * Trust: the log is fed by browsers, so nothing a browser sends is believed about the market.
 * The server stamps the time and the price itself (serve-prod.js, from Hyperliquid's mids) and
 * grades with its own price at the horizon. A client sends only which coin, which horizon, the
 * score it showed and the volatility it used — and the lean is derived from the score here.
 * No address or anything else about who was looking is stored. One entry per coin, horizon and
 * hour: the first one in wins, so a page left open — or a hundred of them — counts once.
 *
 * Pure: the log is a plain object, the clock and the prices are passed in.
 */

export const OL_HOURS = [24, 168]
export const OL_MAX = 20_000                   // newest entries kept
export const OL_GRACE = 45 * 60_000             // grade within this long of the horizon, or not at all

const HOUR = 3600e3
const COIN_RE = /^[A-Za-z0-9:@._-]{1,32}$/

export const leanOf = (score) => Math.abs(score) < 15 ? 'flat' : score > 0 ? 'up' : 'down'
export const olKey = (e) => `${e.coin}|${e.hours}|${Math.floor(e.t / HOUR)}`
export const emptyLog = () => ({ v: 1, entries: [] })

/**
 * What a browser sent → { coin, hours, score, sigma }, or null if any of it is not believable.
 * The time, the price and the lean are not taken from it.
 */
export function cleanSubmission(b) {
  if (!b || typeof b !== 'object') return null
  const coin = typeof b.coin === 'string' ? b.coin.trim() : ''
  const hours = Number(b.hours), score = Number(b.score), sigma = Number(b.sigma)
  if (!COIN_RE.test(coin)) return null
  if (!OL_HOURS.includes(hours)) return null
  if (!Number.isInteger(score) || score < -100 || score > 100) return null
  if (!(sigma > 0.0005 && sigma < 1)) return null
  return { coin, hours, score, sigma }
}

/** Log a cleaned submission at the server's own `px`. Returns true when it was new. */
export function addEntry(log, sub, px, now) {
  if (!(px > 0)) return false
  const e = { coin: sub.coin, hours: sub.hours, score: sub.score, lean: leanOf(sub.score), sigma: sub.sigma, t: now, px }
  const k = olKey(e)
  if (log.entries.some(x => olKey(x) === k)) return false
  log.entries.push(e)
  if (log.entries.length > OL_MAX) log.entries.splice(0, log.entries.length - OL_MAX)
  return true
}

/** Entries whose horizon has passed and that are still waiting for a price. */
export function dueEntries(log, now) {
  return log.entries.filter(e => e.end == null && !e.expired && e.t + e.hours * HOUR <= now)
}

/**
 * Was it right? up: higher at the horizon; down: lower; flat: within one standard deviation of
 * where it was (the cone's inner band) — "neutral" is a claim too, and it can be wrong.
 */
export function hitOf(e, end) {
  const r = Math.log(end / e.px)
  return e.lean === 'up' ? r > 0 : e.lean === 'down' ? r < 0 : Math.abs(r) < e.sigma
}

/**
 * Grade what is due with `mids` ({coin: price}, the server's own). An entry whose horizon passed
 * more than OL_GRACE ago — the server was down, the market had no price — is marked expired and
 * never graded: a price from hours late is not the price at the horizon. Returns how many changed.
 */
export function gradeDue(log, mids, now) {
  let n = 0
  for (const e of dueEntries(log, now)) {
    const due = e.t + e.hours * HOUR
    const px = Number(mids?.[e.coin])
    if (px > 0 && now - due <= OL_GRACE) { e.end = px; e.hit = hitOf(e, px); e.gradedAt = now; n++ }
    else if (now - due > OL_GRACE) { e.expired = true; n++ }
  }
  return n
}

const tally = (list) => {
  const out = { n: 0, hits: 0, up: { n: 0, hits: 0 }, down: { n: 0, hits: 0 }, flat: { n: 0, hits: 0 } }
  for (const e of list) {
    out.n++; out[e.lean].n++
    if (e.hit) { out.hits++; out[e.lean].hits++ }
  }
  return out
}

/** The record for one coin and horizon, and across every coin, from graded entries only. */
export function recordOf(log, coin, hours) {
  const graded = log.entries.filter(e => e.hit != null && e.hours === hours)
  return {
    hours,
    coin: tally(graded.filter(e => e.coin === coin)),
    all: tally(graded),
    pending: log.entries.filter(e => e.coin === coin && e.hours === hours && e.end == null && !e.expired).length,
  }
}
