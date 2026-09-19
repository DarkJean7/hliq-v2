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
} = {}) {
  let level = capacity
  let last  = now()

  const refill = () => {
    const t = now()
    if (t > last) {
      level = Math.min(capacity, level + ((t - last) / 1000) * refillPerSec)
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
      if (weight > capacity - reserve) return level >= capacity ? 0 : Math.ceil(((capacity - level) / refillPerSec) * 1000)
      const short = weight + reserve - level
      return short <= 0 ? 0 : Math.ceil((short / refillPerSec) * 1000)
    },

    /** Record a spend. Allowed to go below the reserve, and even negative: the caller may
     *  have had to proceed anyway, and the bucket must still describe reality afterwards. */
    spend(w) { refill(); level -= Number(w) || 0; return level },

    /** A 429 means the real bucket is emptier than this model thought. Believe the exchange
     *  over the model, and start again from empty. */
    drain() { refill(); level = 0; last = now() },
  }
}

/**
 * The one bucket the whole app spends from.
 *
 * A singleton because the limit is per IP: main.js and api.js hold separate transports, the
 * bots poll, the combined view fans out — and HL counts every one of them together. Two
 * budgets tracking halves of one limit would each believe it had headroom.
 */
export const hlBudget = createBudget()

/**
 * Longest an info request will ever be held back.
 *
 * Without a cap a drained bucket can ask for a sixty-second wait, and a tab that fetches on
 * open would look frozen. Past this the request goes anyway: the bucket records the overspend
 * (it is allowed to go negative), the NEXT caller waits longer for it, and if HL does throttle
 * us the 429 breaker is the mechanism built for that. Bounded latency beats a hung panel.
 */
export const HL_MAX_WAIT_MS = 10_000

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
export function meterTransport(transport, budget = hlBudget, { maxWaitMs = HL_MAX_WAIT_MS } = {}) {
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
    const ms = endpoint === 'info' ? Math.min(budget.waitFor(w), maxWaitMs) : 0
    budget.spend(w)
    if (ms > 0) await new Promise(r => setTimeout(r, ms))
    return raw(endpoint, payload, signal)
  }
  return transport
}
