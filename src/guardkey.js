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
