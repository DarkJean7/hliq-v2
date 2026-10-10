/**
 * INSOLVENT TERMINAL — the /portfolios gallery card, computed once instead of per visitor
 *
 * Reported as "each time i enter the portfolios in the landing page the performance seems
 * that is being calculated per device instead of server side". It was: /portfolios-data sent
 * the portfolio DEFINITIONS and nothing else, and every browser then fetched a daily candle
 * history per holding straight from Hyperliquid and ran the backtest itself. The caches were
 * plain `new Map()`s at module scope, so they died with the page — every open started over,
 * for every visitor, for data that is identical for all of them.
 *
 * ── why this file exists rather than the arithmetic living on each side ──
 *
 * The server now computes what the cards show, and the client still computes a card the
 * server has no answer for. Two implementations of "what the card says" would disagree the
 * first time either changed, and the disagreement would be a number on a public page. So
 * BOTH sides call galBacktest() here, with the same options, and there is one definition of
 * a gallery result.
 *
 * ── the API budget, which is the reason for the shape of all this ──
 *
 * 22 featured portfolios reference 102 distinct markets. A candleSnapshot is weight 20, so
 * one full refresh is 2,040 — above the whole 1,200/minute budget, and the server shares its
 * IP with the trading bots, where /exchange is spent. CLAUDE.md: being throttled as you try
 * to close a position is the failure that costs money.
 *
 * So the server never refreshes "the list". It refreshes ONE market per tick, the stalest one
 * past its day-old TTL, and stops. 102 markets at one a minute is a full pass in under two
 * hours at 20 weight/minute — under 2% of the budget, invisible beside the bots. A cold cache
 * fills over the same couple of hours instead of in one burst, and until a market is in it the
 * browser answers for that card the way it always did.
 */
import { backtest } from './pfbacktest.js'

/** The windows the gallery offers, as its buttons name them. 'max' is from HIST_FROM. */
export const WINDOWS = ['30', '90', '182', '365', '730', 'max']
/** The first day any history is asked for — the same instant src/portfolio.js uses. */
export const HIST_FROM = Date.UTC(2022, 0, 1)
export const DAY = 86400000
/** The gallery's fee, in basis points. One number, so the two sides cannot price differently. */
export const GAL_FEE_BPS = 4.5
export const GAL_CAPITAL = 10_000

const dayOf = (t) => Math.floor(t / DAY) * DAY

/** The window a button means, as { from, to }. */
export function windowOf(tf, now = Date.now()) {
  return { from: tf === 'max' ? HIST_FROM : dayOf(now) - Number(tf) * DAY, to: now }
}

/**
 * The gallery's own backtest: buy at the weights and hold, 1x, no bench.
 *
 * Called by the server to precompute and by the browser to fill a gap, so a card shows the
 * same number whichever answered. `candles` is { key: [[t, close], …] }.
 */
export function galBacktest(candles, items, from, to, extra = {}) {
  // `extra.funding` ({ key: fundingInfo }, src/pffunding.js): a card holding perps pays (or
  // earns) their funding, as holding them would. Passed by both sides, like everything here.
  return backtest({
    candles, items, from, to,
    strategies: ['hold'],
    opts: { capital: GAL_CAPITAL, leverage: 1, feeBps: GAL_FEE_BPS, funding: extra.funding ?? null },
  })
}

/** Every market a set of portfolios needs a price for — weights of zero do not count. */
export function coinsOf(portfolios) {
  const out = new Set()
  for (const p of Array.isArray(portfolios) ? portfolios : []) {
    for (const i of (p?.items ?? [])) if (Number(i?.w) > 0 && i.coin) out.add(String(i.coin))
  }
  return [...out]
}

/**
 * A market id as a filename. HL ids carry ':' and '@', which are not filename characters.
 *
 * A leading dot is escaped as well as the separators. The separators are what a traversal
 * needs, so '../x' was already safe — but '..' is all dots and came through untouched, and a
 * name that may not begin with a dot also cannot be mistaken for the lock file or for any
 * other dotfile in that directory.
 */
export const coinFile = (coin) =>
  String(coin ?? '').replace(/[^A-Za-z0-9._-]/g, (c) => '~' + c.charCodeAt(0).toString(16))
                    .replace(/^\./, '~2e')

/**
 * Which market to refresh next: the stalest one that is past the TTL, or null when none is.
 *
 * `at` of 0 (never fetched) sorts first, so a cold cache fills in the order the list is given
 * rather than at random. Returning ONE is the whole pacing strategy — see the budget note at
 * the top of this file.
 */
export function stalest(coins, atOf, ttl, now = Date.now()) {
  let pick = null, oldest = Infinity
  for (const c of coins ?? []) {
    const at = Number(atOf(c)) || 0
    if (now - at < ttl) continue
    if (at < oldest) { oldest = at; pick = c }
  }
  return pick
}

/**
 * A sparkline's worth of points, keeping its shape honest.
 *
 * The card draws a 240px SVG, so a thousand points is a thousand ways to send bytes nobody can
 * see. Thinning by taking every Nth would quietly clip the high and the low — the two points a
 * reader actually looks for — so first, last, min and max are kept by index and the rest are
 * spread evenly between them.
 */
/**
 * How many points a sparkline is sent with. The SVG is 240px wide, so 48 is a point every
 * five pixels — past that the extra numbers are bytes nobody can see, and this answer is on
 * a public landing page that is often opened on a phone.
 */
export const SPARK_POINTS = 48

/** Four significant figures. The sparkline is 56px tall; the 15 digits a float prints are
 *  not shape, they are payload. ret and maxDd keep enough for the way the card prints them. */
export const round4 = (v) => (Number.isFinite(v) ? Number(v.toPrecision(6)) : v)

export function thin(values, n = SPARK_POINTS) {
  const v = (Array.isArray(values) ? values : []).filter(Number.isFinite)
  if (v.length <= n || n < 4) return v
  const keep = new Set([0, v.length - 1])
  let lo = 0, hi = 0
  for (let i = 1; i < v.length; i++) { if (v[i] < v[lo]) lo = i; if (v[i] > v[hi]) hi = i }
  keep.add(lo); keep.add(hi)
  for (let i = 0; i < n; i++) keep.add(Math.round((i / (n - 1)) * (v.length - 1)))
  return [...keep].sort((a, b) => a - b).map(i => v[i])
}

/**
 * A backtest result as the card needs it, and no larger. Returns null for a run that did not
 * happen — which the caller must read as "no answer", not as a flat card.
 */
export function packResult(r, sparkPoints = SPARK_POINTS) {
  const run = r?.runs?.[0]
  if (!run) return null
  return {
    state: 'ok',
    run: { ret: round4(run.ret), maxDd: round4(run.maxDd), equity: thin(run.equity, sparkPoints).map(round4) },
    start: r.start ?? null,
    clippedBy: r.clippedBy ?? null,
    joined: r.joined ?? [],
    days: Math.max(0, (r.days?.length ?? 1) - 1),
  }
}

/**
 * Every window of every portfolio the prices allow, as { [id]: { [tf]: packed } }.
 *
 * A portfolio with a market missing from `closes` is LEFT OUT rather than entered as null:
 * absent means "the server has no answer", and the browser then works that card out for
 * itself. An entry of null would be a claim that there is nothing to show.
 */
export function buildPerf(portfolios, closes, now = Date.now(), sparkPoints = SPARK_POINTS, funding = null) {
  const out = {}
  for (const p of Array.isArray(portfolios) ? portfolios : []) {
    const items = (p?.items ?? []).filter(i => Number(i?.w) > 0)
      .map(i => ({ key: i.coin, weight: Number(i.w), side: i.side }))
    if (!items.length || items.some(i => !closes?.[i.key]?.length)) continue
    const mine = Object.fromEntries(items.map(i => [i.key, closes[i.key]]))
    const per = {}
    for (const tf of WINDOWS) {
      const { from, to } = windowOf(tf, now)
      const fund = funding ? Object.fromEntries(items.filter(i => funding[i.key]).map(i => [i.key, funding[i.key]])) : null
      const packed = packResult(galBacktest(mine, items, from, to, { funding: fund }), sparkPoints)
      if (packed) per[tf] = packed
    }
    if (Object.keys(per).length) out[p.id] = per
  }
  return out
}
