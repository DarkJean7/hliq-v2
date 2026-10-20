/**
 * INSOLVENT TERMINAL — spending Hyperliquid's rate budget on purpose
 *
 * HL allows 1200 weight per minute per IP, shared between /info and /exchange. Overspending
 * it does not merely stall the dashboard: /exchange is in the same budget, so a chatty
 * refresh loop starves ORDER PLACEMENT. That is the harm worth engineering against.
 *
 * ── why an average is the wrong measure ──
 *
 * The limiter behaves like a bucket that refills at about 20 weight a second. 1200 spread
 * evenly across a minute never empties it; the same 1200 arriving in the first eight seconds
 * does. Measured on a cold All Accounts load with eight wallets (tests/hl-weight.mjs):
 *
 *     60-second average      992 weight/min    83% of budget   — looks fine
 *     peak in any 10s window  1240             refill over 10s is ~200
 *     98 requests, all of them inside 8.0 seconds
 *
 * The average said there was headroom while the burst was drawing six times faster than the
 * bucket refills. A fixed inter-wallet delay could not fix that either, because the right
 * delay depends on what the rest of the app has just spent — and a delay large enough for the
 * worst case makes every cold load slow for no reason.
 *
 * ── what this does instead ──
 *
 * Model the bucket, and before a burst ask how long to wait so it does not dip below a
 * RESERVE. With headroom the answer is zero and nothing slows down; under pressure the caller
 * waits exactly as long as the refill needs and no longer. The reserve is the part that
 * protects trading: the dashboard is not allowed to spend the last of the budget, so there is
 * always enough left for an order and its cancels.
 *
 * Deliberately has no idea what a request IS — it takes a number. That keeps it testable
 * without a browser and stops it growing opinions about endpoints.
 */

/** HL's documented budget, per IP, shared across /info and /exchange. */
export const HL_BUDGET = 1200
/** ...which is this much refilled every second. */
export const HL_REFILL_PER_SEC = HL_BUDGET / 60

/**
 * Weight the dashboard refuses to spend, so placing an order never has to wait for it.
 *
 * An order plus its TP/SL and a cancel or two is tens of weight, not hundreds — but the
 * reserve also has to cover the poll loops that keep running while you trade, and being
 * throttled at the moment you want out of a position is the failure that actually costs
 * money. Set high enough to be a real cushion, low enough that an 8-wallet cold load (~830
 * weight) still runs without waiting at all on a full bucket.
 */
export const HL_RESERVE = 300

/** After a 429: the share of the bucket assumed ours, and for how long. */
export const SHARE = 0.5
export const SHARE_MS = 10 * 60_000

/** HL's documented weights: 2 for these, 60 for userRole, 20 for every other info request. */
const CHEAP = new Set(['l2Book', 'allMids', 'clearinghouseState', 'orderStatus',
                       'spotClearinghouseState', 'exchangeStatus'])
export function weightOf(type) {
  if (type === 'userRole') return 60
  return CHEAP.has(type) ? 2 : 20
}

/**
 * A token bucket you can ask "how long until I may spend this".
 *
 * `now` is injectable so the tests can run a minute of behaviour instantly rather than
 * sleeping through it — a pacing bug that only shows up after 40 seconds is exactly the kind
 * nobody re-runs the test for.
 */
export function createBudget({
  capacity = HL_BUDGET,
  refillPerSec = HL_REFILL_PER_SEC,
  reserve = HL_RESERVE,
  now = Date.now,
  startLevel = capacity,
  shareMs = SHARE_MS,
  store = null,
} = {}) {
  let level = Math.min(capacity, startLevel)
  let last  = now()
  // The limit is per IP, and this app is rarely the only thing on that IP: a phone and a
  // desktop on the same Wi-Fi, a second tab, Hyperliquid's own site. After the exchange says
  // we overspent, assume half the bucket is someone else's for a while — the model believing
  // it owned all 1200 is how two devices opening All Accounts together kept tripping it.
  let sharedUntil = 0
  const cap = () => (now() < sharedUntil ? capacity * SHARE : capacity)

  // The bucket outlives the page. Reported: "got rate limited for just entering the app" — a
  // 429 one second after load, ten wallets. Every load used to start from a model of a bucket
  // nobody had touched, while the REAL one still held what the previous page, a reload a moment
  // earlier, or another tab had just spent. With a store (localStorage in the app) the model
  // carries on from what was actually spent: a reload continues the previous page's bucket, and
  // two tabs on one device spend from one bucket instead of each believing it owns the IP.
  const pull = () => {
    if (!store) return
    let v = null
    try { v = store.load() } catch {}
    if (!v || !Number.isFinite(v.level) || !Number.isFinite(v.last) || v.last > now() + 1000) return
    level = Math.min(capacity, v.level); last = Math.min(v.last, now())
  }
  // Only what was SPENT is carried, never the "shared for ten minutes" guess a 429 sets. Carried
  // too, one 429 made every reload for ten minutes start drained at half the bucket and half
  // the refill, so a ten-wallet load crawled with prices and equity on dashes ("now the account
  // equity is not loading"). What was spent is a fact the next page should know; that guess is
  // this page's caution and dies with it.
  const push = () => { if (store) try { store.save({ level, last }) } catch {} }
  pull()

  const refill = () => {
    pull()
    const t = now()
    if (t > last) {
      level = Math.min(cap(), level + ((t - last) / 1000) * refillPerSec * (t < sharedUntil ? SHARE : 1))
      last = t
    }
  }

  return {
    /** What the bucket holds right now, after refilling for elapsed time. */
    level() { refill(); return level },

    /**
     * Milliseconds to wait before spending `w` without dipping under the reserve.
     * 0 whenever there is room, which is the common case and must cost nothing.
     */
    waitFor(w) {
      refill()
      const weight = Number(w) || 0
      // A single request bigger than the whole spendable budget can never satisfy the
      // reserve. Waiting forever would hang the load, so let it through on a full bucket
      // rather than deadlock — being slightly over is recoverable, never loading is not.
      const c = cap()
      if (weight > c - reserve) return level >= c ? 0 : Math.ceil(((c - level) / refillPerSec) * 1000)
      const short = weight + reserve - level
      return short <= 0 ? 0 : Math.ceil((short / refillPerSec) * 1000)
    },

    /** Record a spend. Allowed to go below the reserve, and even negative: the caller may
     *  have had to proceed anyway, and the bucket must still describe reality afterwards. */
    spend(w) { refill(); level -= Number(w) || 0; push(); return level },

    /** A 429 means the real bucket is emptier than this model thought. Believe the exchange
     *  over the model, and start again from empty. */
    drain() { refill(); level = 0; last = now(); sharedUntil = now() + shareMs; push() },

    /** True while the bucket is assumed shared (after a 429). */
    shared() { return now() < sharedUntil },
  }
}

/**
 * The one bucket the whole app spends from.
 *
 * A singleton because the limit is per IP: main.js and api.js hold separate transports, the
 * bots poll, the combined view fans out — and HL counts every one of them together. Two
 * budgets tracking halves of one limit would each believe it had headroom.
 */
// Starts HALF full, not full. A page load is exactly when another device or tab on the same IP
// may have just spent the bucket, and a cold All Accounts load is ~1,100 weight in its first
// ten seconds — measured by tests/hl-weight.mjs with ten wallets. From half, the first ~300
// go at once (what the overview needs first) and the rest at the refill rate.
//
// ...unless a previous page or another tab left a record, in which case that is where it starts.
const HL_BUDGET_KEY = 'hliq_hl_bucket'
const localStore = (() => {
  try {
    const ls = globalThis.localStorage
    if (!ls) return null
    return {
      load: () => JSON.parse(ls.getItem(HL_BUDGET_KEY) || 'null'),
      save: (v) => ls.setItem(HL_BUDGET_KEY, JSON.stringify(v)),
    }
  } catch { return null }
})()
export const hlBudget = createBudget({ startLevel: HL_BUDGET / 2, store: localStore })

/**
 * Longest an info request will ever be held back.
 *
 * Without a cap a drained bucket can ask for a sixty-second wait, and a tab that fetches on
 * open would look frozen. Past this the request goes anyway: the bucket records the overspend
 * (it is allowed to go negative), the NEXT caller waits longer for it, and if HL does throttle
 * us the 429 breaker is the mechanism built for that. Bounded latency beats a hung panel.
 */
export const HL_MAX_WAIT_MS = 10_000
/** ...except the heavy history reads (weight 20+: portfolio, fills, funding, ledger), which can
 *  wait longer: nothing on screen is waiting for them the way it waits for a balance, and
 *  letting them through at ten seconds is what made a ten-wallet cold load burst anyway. */
export const HL_MAX_WAIT_HEAVY_MS = 30_000

/**
 * Pace and meter every request a transport makes.
 *
 * Wrapping `request` is what makes the reserve mean something: estimating a per-wallet cost
 * and pacing only the wallet fan left the metas, the HIP-3 dex probes and every poll loop
 * unaccounted, so the model thought it had spent 670 while the wire carried 1196. Measured at
 * the funnel there is nothing to undercount.
 *
 * ORDER PLACEMENT IS NEVER DELAYED. /exchange shares the same budget, so it is metered — the
 * model has to stay honest — but it does not wait. Throttling the dashboard to protect
 * trading is the entire point; throttling trading to protect the dashboard would invert it.
 */
export function meterTransport(transport, budget = hlBudget, { maxWaitMs = HL_MAX_WAIT_MS, maxWaitHeavyMs = HL_MAX_WAIT_HEAVY_MS } = {}) {
  if (!transport || typeof transport.request !== 'function' || transport.__metered) return transport
  const raw = transport.request.bind(transport)
  transport.__metered = true
  transport.request = async (endpoint, payload, signal) => {
    const w = weightOf(payload?.type)
    // Ask AND claim in the same step, before awaiting anything.
    //
    // Spending after the wait is a check-then-act race, and this code path is almost entirely
    // concurrent: one wallet's fan fires six requests through Promise.all, so all six read the
    // same level, all six conclude there is headroom, and all six go at once. Measured, that
    // let 1118 weight through in ten seconds against a bucket meant to stop at 900. Claiming
    // the weight up front means the second request sees what the first took and queues behind
    // it, which is the whole point of the model.
    const ms = endpoint === 'info' ? Math.min(budget.waitFor(w), w >= 20 ? maxWaitHeavyMs : maxWaitMs) : 0
    budget.spend(w)
    if (ms > 0) await new Promise(r => setTimeout(r, ms))
    return raw(endpoint, payload, signal)
  }
  return transport
}

/**
 * A metered POST to Hyperliquid's public /info, for the reads that do not go through an SDK
 * transport (the chart's candles, the history drawdown, the game's sparklines).
 *
 * They used to call fetch directly, so the bucket never saw them: a cold load drew a candle
 * window the model did not know about on top of a wallet fan it thought it had paced. Same
 * rule as meterTransport — claim the weight before waiting — and the same Response back, so a
 * call site changes nothing but the function it calls.
 */
export async function hlInfo(body, { budget = hlBudget, url = 'https://api.hyperliquid.xyz/info', signal } = {}) {
  const w = weightOf(body?.type)
  const ms = Math.min(budget.waitFor(w), w >= 20 ? HL_MAX_WAIT_HEAVY_MS : HL_MAX_WAIT_MS)
  budget.spend(w)
  if (ms > 0) await new Promise(r => setTimeout(r, ms))
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}), signal })
}
