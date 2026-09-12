/**
 * INSOLVENT TERMINAL — when may a cached logo be replaced by a CoinGecko one?
 *
 * The icon cache in serve-prod.js stores the first candidate that answered with an image, and
 * carries an UPGRADE rule for one real problem: a coin first requested before the client's
 * CoinGecko map had loaded gets cached from Hyperliquid's fallback artwork and then sticks
 * there forever. When CoinGecko later becomes available, the better logo should replace it.
 *
 * The rule was "a CoinGecko candidate exists and what we stored is not from CoinGecko", and
 * that overrode the one thing the client knows and the server does not: `cands` arrives in
 * PRIORITY ORDER. For a tokenized-equity market the client deliberately ranks Hyperliquid's
 * and TradingView's artwork first, because CoinGecko's entry under that ticker is a wrapper
 * token — `nvda` there is "NVIDIA • Robinhood Token", whose logo is Robinhood's. So the
 * server kept fetching the correct NVIDIA mark, then promoting Robinhood's over it, and
 * "Will NVDA be above $218.33" wore Robinhood's icon. Reported as "nvda has robinhood icon".
 *
 * An upgrade is therefore only an upgrade when the client ranked CoinGecko ABOVE whatever we
 * already hold. Nothing else about the ordering is second-guessed here.
 */

const isCG = (u) => String(u ?? '').includes('coingecko')

/**
 * `cands` is the client's candidate list, best first. `storedSrc` is the URL the cached
 * artwork came from. Returns the CoinGecko URL to fetch, or null to keep what we have.
 */
export function coinGeckoUpgrade(cands, storedSrc) {
  const list = Array.isArray(cands) ? cands : []
  // Already CoinGecko: nothing to upgrade to.
  if (isCG(storedSrc)) return null
  const cgIdx = list.findIndex(isCG)
  if (cgIdx < 0) return null
  // A stored source this client no longer offers ranks last — it was chosen by an older
  // resolution, so the current list is the better authority.
  const curIdx = list.indexOf(String(storedSrc ?? ''))
  const rank = curIdx === -1 ? Infinity : curIdx
  return cgIdx < rank ? list[cgIdx] : null
}
