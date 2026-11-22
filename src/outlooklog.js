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
 * slot (OL_CADENCE): the first one in wins, so a page left open — or a hundred of them — counts once.
 *
 * The server also logs every main-dex perp on its own (oraclelogger.js): "log every coin
 * automatically even if nobody opens it". That is ~190 markets × six horizons, so the log keeps
 * only what the tab shows — every call still waiting, and the newest OL_KEEP graded per market and
 * horizon — and folds the older ones into running totals (`stats`) before dropping them. The
 * record is totals + what is kept, so nothing graded stops counting.
 *
 * Pure: the log is a plain object, the clock and the prices are passed in.
 */

export const OL_HOURS = [1, 4, 24, 72, 168, 720]
export const OL_MAX = 80_000                   // a ceiling only: compact() keeps it far below
export const OL_KEEP = 30                       // graded calls kept per coin and horizon, the detail's log
// Hours between two calls on the same coin and horizon. Hourly for 1h; a 30-day call every hour
// would be 720 overlapping copies of one bet, so the long horizons are sampled daily.
export const OL_CADENCE = { 1: 1, 4: 4, 24: 4, 72: 24, 168: 24, 720: 24 }
export const OL_GRACE = 45 * 60_000             // grade within this long of the horizon, or not at all

const HOUR = 3600e3
const COIN_RE = /^[A-Za-z0-9:@._-]{1,32}$/

export const leanOf = (score) => Math.abs(score) < 15 ? 'flat' : score > 0 ? 'up' : 'down'
export const olKey = (e) => `${e.coin}|${e.hours}|${Math.floor(e.t / (HOUR * (OL_CADENCE[e.hours] ?? 1)))}`
export const emptyLog = () => ({ v: 2, entries: [], stats: {} })

// The keys already logged, kept beside the log so adding two thousand entries is not two thousand
// scans of forty thousand. Rebuilt whenever the entries changed under it (compact, a fresh read).
const keyIdx = new WeakMap()
function keysOf(log) {
  let x = keyIdx.get(log)
  if (!x || x.entries !== log.entries || x.n !== log.entries.length) {
    x = { entries: log.entries, n: log.entries.length, set: new Set(log.entries.map(olKey)) }
    keyIdx.set(log, x)
  }
  return x
}

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
  const k = olKey(e), idx = keysOf(log)
  if (idx.set.has(k)) return false
  log.entries.push(e); idx.set.add(k); idx.n++
  if (log.entries.length > OL_MAX) compact(log, OL_MAX)
  return true
}

/** Already logged for this coin, horizon and slot? Lets a server answer a duplicate without the lock. */
export function hasEntry(log, sub, now) { return keysOf(log).set.has(olKey({ coin: sub.coin, hours: sub.hours, t: now })) }

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
    if (px > 0 && now - due <= OL_GRACE) { e.end = px; e.hit = hitOf(e, px); e.inside = Math.abs(Math.log(px / e.px)) < e.sigma; e.gradedAt = now; n++ }
    else if (now - due > OL_GRACE) { e.expired = true; n++ }
  }
  return n
}

const zero = () => ({ n: 0, hits: 0, inside: 0, up: { n: 0, hits: 0 }, down: { n: 0, hits: 0 }, flat: { n: 0, hits: 0 } })
const addTally = (out, b) => {
  if (!b) return out
  out.n += b.n; out.hits += b.hits; out.inside += b.inside ?? 0
  for (const l of ['up', 'down', 'flat']) { out[l].n += b[l]?.n ?? 0; out[l].hits += b[l]?.hits ?? 0 }
  return out
}
const tally = (list, base = null) => {
  // inside: graded entries that ended within the cone's 1σ — the cone checked live (~68% if right).
  const out = addTally(zero(), base)
  for (const e of list) {
    out.n++; out[e.lean].n++; if (e.inside) out.inside++
    if (e.hit) { out.hits++; out[e.lean].hits++ }
  }
  return out
}

/** Fold one finished entry (graded or expired) into the running totals for its coin and horizon. */
function fold(stats, e) {
  const k = `${e.coin}|${e.hours}`
  const st = stats[k] ??= { ...zero(), since: null, logged: 0, expired: 0 }
  st.logged++
  st.since = st.since == null ? e.t : Math.min(st.since, e.t)
  if (e.expired) st.expired++
  else if (e.hit != null) {
    st.n++; st[e.lean].n++; if (e.inside) st.inside++
    if (e.hit) { st.hits++; st[e.lean].hits++ }
  }
}

/**
 * Keep every call still waiting and the newest OL_KEEP finished ones per coin and horizon; fold
 * the rest into `stats` and drop them. `max` is the hard ceiling, oldest finished first. Returns
 * whether anything changed.
 */
export function compact(log, max = OL_MAX) {
  log.stats ??= {}
  const finished = (e) => e.hit != null || e.expired
  const seen = new Map(), drop = new Set()
  for (let i = log.entries.length - 1; i >= 0; i--) {
    const e = log.entries[i]
    if (!finished(e)) continue
    const k = `${e.coin}|${e.hours}`, n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    if (n > OL_KEEP) drop.add(i)
  }
  let over = log.entries.length - drop.size - max
  for (let i = 0; over > 0 && i < log.entries.length; i++) if (!drop.has(i)) { drop.add(i); over-- }
  if (!drop.size) return false
  const kept = []
  log.entries.forEach((e, i) => { if (!drop.has(i)) kept.push(e); else if (finished(e)) fold(log.stats, e) })
  log.entries = kept
  return true
}

/** The record for one coin and horizon, and across every coin: graded only, totals + kept. */
export function recordOf(log, coin, hours) {
  const stats = log.stats ?? {}
  const graded = log.entries.filter(e => e.hit != null && e.hours === hours)
  const mine = log.entries.filter(e => e.coin === coin && e.hours === hours)
  const waiting = mine.filter(e => e.end == null && !e.expired)
  const mineSt = stats[`${coin}|${hours}`] ?? null
  const hzSt = Object.entries(stats).filter(([k]) => k.endsWith(`|${hours}`)).map(([, v]) => v)
  const firstT = (xs, sts) => {
    const ts = [...xs.map(e => e.t), ...sts.map(s => s?.since).filter(t => t != null)]
    return ts.length ? Math.min(...ts) : null
  }
  return {
    hours,
    coin: tally(graded.filter(e => e.coin === coin), mineSt),
    all: tally(graded, hzSt.reduce(addTally, zero())),
    pending: waiting.length,
    // When this coin's log at this horizon began, and how much of it there is — "since when the
    // test started reading". null, not 0, when nothing was ever logged: we have no start.
    since: firstT(mine, [mineSt]),
    allSince: firstT(log.entries.filter(e => e.hours === hours), hzSt),
    logged: mine.length + (mineSt?.logged ?? 0),
    expired: mine.filter(e => e.expired).length + (mineSt?.expired ?? 0),
    // The log itself, newest first: the last thirty graded calls, and the ten waiting soonest-made.
    recent: graded.filter(e => e.coin === coin).slice(-30).reverse()
      .map(e => ({ t: e.t, score: e.score, lean: e.lean, px: e.px, end: e.end, hit: e.hit, inside: e.inside ?? null })),
    waiting: waiting.slice(-10).reverse()
      .map(e => ({ t: e.t, score: e.score, lean: e.lean, px: e.px, due: e.t + hours * HOUR })),
  }
}
