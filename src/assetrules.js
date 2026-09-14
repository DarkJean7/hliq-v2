/**
 * INSOLVENT TERMINAL — what a market will actually let you do.
 *
 * Hyperliquid's per-asset metadata carries three constraints that the app was ignoring, and
 * ignoring them produced configurations the exchange rejects and previews that describe a
 * trade nobody could place:
 *
 *   MAX LEVERAGE   VVV allows 3×. The grid form offered 10× as its default, priced the whole
 *                  ladder at 10×, and the preview reported "$14.75 margin each · 10× cross".
 *                  `updateLeverage` at 10× is refused, the bot logs a warning and carries on,
 *                  and every margin figure on that screen was for a trade that cannot exist.
 *   ISOLATED ONLY  Some markets forbid cross entirely (`onlyIsolated`, or `marginMode` of
 *                  "strictIsolated"/"noCross"). Offering cross there is the same class of lie.
 *   DELISTED       A delisted market keeps its last mid forever. `vntl:OPENAI` still quotes
 *                  1336.2 and has not traded in a long time — reported as "the preview shows a
 *                  mark price of 1,336 which is false since its at 1,510 in reality". The
 *                  number is Hyperliquid's own; what was missing is that it is frozen.
 *
 * Pure: a universe entry in, plain facts out. The client reads it to build the form, and the
 * grid bot reads the same rules from its own meta fetch, so the two cannot disagree about what
 * a market allows.
 */

/** Hyperliquid's default when an asset does not say. Nothing on HL exceeds it. */
export const MAX_LEVERAGE_CAP = 50

/**
 * The constraints carried by one `universe[]` entry.
 *
 * Everything is defaulted rather than left undefined: a caller that cannot tell "no limit"
 * from "not loaded yet" is how 10× got offered on a 3× market in the first place. `known` says
 * which of the two this is.
 */
export function assetRules(u) {
  const lev = Number(u?.maxLeverage)
  return {
    known: !!u,
    maxLeverage: Number.isFinite(lev) && lev > 0 ? Math.floor(lev) : MAX_LEVERAGE_CAP,
    // Three different spellings of the same rule, and a market only needs to fail one.
    isolatedOnly: !!(u?.onlyIsolated || u?.marginMode === 'strictIsolated' || u?.marginMode === 'noCross'),
    delisted: !!u?.isDelisted,
  }
}

/**
 * Find a market in an allPerpMetas array.
 *
 * HIP-3 universes carry their dex prefix in the name (`vntl:OPENAI`), the main dex does not
 * (`VVV`), and a caller holds whichever spelling the rest of the app uses — so both are tried.
 * Case-insensitively, because a market typed by hand is not typed the way HL writes it.
 */
export function findUniverse(allMetas, coin) {
  const want = String(coin ?? '').toLowerCase()
  if (!want) return null
  const bare = want.includes(':') ? want.slice(want.lastIndexOf(':') + 1) : null
  for (const m of (allMetas ?? [])) {
    for (const u of (m?.universe ?? [])) {
      const n = String(u?.name ?? '').toLowerCase()
      if (n === want) return u
    }
  }
  // Only after an exact match fails everywhere: a bare "OPENAI" must not win over a real
  // `xyz:OPENAI` on another dex just because it was checked first.
  if (bare) {
    for (const m of (allMetas ?? [])) {
      for (const u of (m?.universe ?? [])) {
        if (String(u?.name ?? '').toLowerCase() === bare) return u
      }
    }
  }
  return null
}

/** The rules for a coin, looked up in an allPerpMetas array. Unknown market → unknown rules. */
export function rulesFor(allMetas, coin) {
  return assetRules(findUniverse(allMetas, coin))
}

/**
 * A leverage the market will accept: a whole number, at least 1, never above its maximum.
 *
 * A blank or unparseable request means "give me what this market allows", which is what makes
 * the form's default correct for every asset without the form knowing anything about assets.
 */
export function clampLeverage(want, maxLeverage) {
  const max = Number.isFinite(+maxLeverage) && +maxLeverage > 0
    ? Math.floor(+maxLeverage) : MAX_LEVERAGE_CAP
  const n = Math.floor(Number(want))
  if (!Number.isFinite(n) || n < 1) return max
  return Math.min(n, max)
}

/**
 * Every delisted market, lowercased, as a Set.
 *
 * Hyperliquid keeps quoting a delisted market forever — `vntl:OPENAI` still answers allMids
 * with 1336.2 — so a list built from prices cannot tell it apart from a live one. Its own UI
 * does not show it; ours did, and it was the only OPENAI anyone could find here while the real
 * one traded on another dex under a different ticker.
 *
 * Cached on the metas array itself: it is rebuilt on every market list, search keystroke and
 * picker render, and walking eleven universes each time is work for an answer that only changes
 * when the metas do.
 */
const _delistedCache = new WeakMap()
export function delistedNames(allMetas) {
  if (!Array.isArray(allMetas)) return new Set()
  const hit = _delistedCache.get(allMetas)
  if (hit) return hit
  const out = new Set()
  for (const m of allMetas) {
    for (const u of (m?.universe ?? [])) {
      if (u?.isDelisted) out.add(String(u.name).toLowerCase())
    }
  }
  _delistedCache.set(allMetas, out)
  return out
}

/**
 * A market nobody is trading: no open interest AND no volume.
 *
 * Asked for: "get rid of $0 open interest markets and $0 volume." A market with neither is one
 * you cannot get out of — the dead OPENAI listing reads "Vol $0 · OI $0" and is the obvious
 * case, but it is not the only one, and hiding them by name would have fixed one row.
 *
 * BOTH, not either: a market can legitimately have no volume today while holding real open
 * interest, and a market can turn over without anyone carrying a position. Either alone is a
 * quiet day; neither is an empty book.
 *
 * And a MISSING context is not a zero one. `_mktCtxMap` fills in after the first paint, so
 * reading absent numbers as zeroes would empty the whole list for a moment and hide every
 * market that had not been measured yet — the same "empty is not unknown" mistake that has
 * cost this codebase three separate bugs.
 */
export function hasNoActivity(ctx) {
  if (!ctx) return false
  const oi  = Number(ctx.oi)
  const vol = Number(ctx.volume)
  if (!Number.isFinite(oi) || !Number.isFinite(vol)) return false
  return oi <= 0 && vol <= 0
}

/**
 * Who deployed this market: the builder-dex prefix, or null for Hyperliquid's own.
 *
 * Asked for alongside the above — "include the deployer, in this case io is the deployer of
 * openai". It is not decoration: the deployer sets the oracle, the fees and the leverage, and
 * two dexes can list the same underlying on completely different terms.
 */
export function deployerOf(coin) {
  const s = String(coin ?? '')
  const i = s.indexOf(':')
  return i > 0 ? s.slice(0, i) : null
}

/** Cross unless the market forbids it. Returns 'isolated' | 'cross'. */
export function marginModeFor(want, rules) {
  if (rules?.isolatedOnly) return 'isolated'
  return String(want ?? '').toLowerCase() === 'isolated' ? 'isolated' : 'cross'
}
