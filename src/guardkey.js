/**
 * INSOLVENT TERMINAL — is this guard already armed, and under what key?
 *
 * A Liq Guard or Lev Brake runs on the bot server under an instance key like
 * `liqguard:BTC` or, for a HIP-3 market, `liqguard:hype2:CHIP`. The guard modal has to answer
 * one question before it can render: is one already running for this position? If it gets that
 * wrong it shows the blank Arm form, and there is then no way to edit or disarm the guard that
 * is plainly running — reported exactly that way.
 *
 * It used to answer with `instances[`${mode}:${coin.toUpperCase()}`]`, which misses twice:
 *
 *   CASE      Instance keys carry the market AS WRITTEN. A HIP-3 asset is `hype2:CHIP`, so the
 *             uppercased lookup asks for `liqguard:HYPE2:CHIP` and finds nothing.
 *   OWNERSHIP `instances` describes the ONE account currently selected. In the combined view
 *             that is usually not the wallet holding this position; the per-wallet record is
 *             the only one that knows.
 *
 * The position card's shield badge already handled both. The modal did not, so the badge said
 * armed while the modal said not — which is how the bug was found. This is that logic, pulled
 * out so both can share it and so it can be tested without a browser: the two status objects
 * are module locals in main.js and cannot be stubbed from a driven page.
 */

/**
 * `mode` is 'liqguard' | 'levbrake'. `acct` is the wallet that owns the position, or null.
 * `instances` is serverStatus._instances (an object keyed by instance key); `byWallet` is
 * _maBotStatus (address -> array of instance keys).
 *
 * Returns the key AS THE SERVER WROTE IT, because that is what the caller needs to look up
 * the guard's config and counters — or null when nothing is armed.
 */
export function armedGuardKey(mode, coin, acct, { instances, byWallet } = {}) {
  if (!mode || coin == null || coin === '') return null
  const want = `${mode}:${String(coin)}`.toLowerCase()
  const findIn = (keys) => {
    if (!Array.isArray(keys)) return null
    for (const k of keys) if (String(k).toLowerCase() === want) return k
    return null
  }

  // The owning wallet's own list first. In the combined view it is the only record that
  // describes THIS position's account rather than whichever one happens to be selected.
  if (acct && byWallet) {
    const mine = findIn(byWallet[String(acct).toLowerCase()])
    if (mine) return mine
  }
  return findIn(Object.keys(instances ?? {}))
}

/**
 * What an armed guard has already spent, against what it was allowed.
 *
 * Editing a guard is a decision about whether to give it more room, and that decision is
 * unanswerable without this: a guard that has used all four of its fires, or all $40 of its
 * cap, will not act again no matter what the rest of the form says. Returned as numbers so
 * the caller formats and translates; `null` means NOT KNOWN — the counters live with the
 * owning wallet, and a view that cannot see them must not print 0, which would read as
 * "it has never fired".
 *
 * `maxFires` and `cap` are whatever is in the FORM, not what the guard was armed with: the
 * user may be raising them right now, and the point of the line is to show that raising them
 * buys room.
 */
export function firedSummary(fires, added, { maxFires, cap } = {}) {
  if (fires == null || added == null) return null
  const f  = Number(fires) || 0
  const a  = Number(added) || 0
  // 0 and blank both mean "no limit set", which is not the same as a limit of zero.
  const mf = Number(maxFires) > 0 ? Math.floor(Number(maxFires)) : null
  const c  = Number(cap)      > 0 ? Number(cap)                  : null
  return {
    fires: f, added: a, maxFires: mf, cap: c,
    firesLeft: mf == null ? null : Math.max(0, mf - f),
    addLeft:   c  == null ? null : Math.max(0, c  - a),
    used: f > 0,
    // Out of room on EITHER limit: the guard is armed but inert until one is raised.
    exhausted: (mf != null && f >= mf) || (c != null && a >= c),
  }
}
