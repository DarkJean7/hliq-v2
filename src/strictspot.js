/**
 * Hyperliquid's "Strict" spot list: the spot tokens its own market search shows by default.
 *
 * Asked: "make our app trade search be strict" — QUANT/USDC ($674 volume, a $29K cap) showed in
 * ours, while Hyperliquid's Strict mode hides it and shows only under All.
 *
 * Hyperliquid does not publish this list through its API (spotMeta's isCanonical marks two tokens,
 * not this set). Its web app carries it as a constant and keeps a spot market in Strict mode only
 * when the market's base token id is on it. This is that constant, mainnet, copied from their
 * bundle on 2026-10-25: 54 tokens, 64 of the 347 spot pairs. A new token they add will not show in
 * Strict here until this is refreshed — `node tests/update-strict-spot.mjs` re-reads it.
 *
 * Perps, HIP-3 and outcomes are not filtered by it: there, Hyperliquid's Strict mode only hides
 * delisted markets, which every list here already drops.
 */
export const STRICT_SPOT_AS_OF = '2026-10-25'
export const STRICT_SPOT_TOKEN_IDS = new Set([
  '0xc1fb593aeffbeb02f85e0308e9956a90',
  '0xbaf265ef389da684513d98d68edf4eae',
  '0xbb03842e1f71ed27ed8fa012b29affd4',
  '0xfcf28885456bf7e7cbe5b7a25407c5bc',
  '0x38348c17e1a18559bbda232d22007695',
  '0x0d01dc56dcaaca66ad901c959b4011ec',
  '0xe85f43e1f91e3c8cdf3acbd7e0855b8e',
  '0xbebb35d03b83a302a2aa06dbaa67dd9f',
  '0xcf548188e24a0ce3dc3b281242baafd9',
  '0x8f254b963e8468305d409b33aa137c67',
  '0xe1edd30daaf5caac3fe63569e24748da',
  '0x88102bea0bbad5f301f6e9e4dacdf979',
  '0x2e6d84f2d7ca82e6581e03523e4389f7',
  '0x84ecb2340931f6b153ff10bcfafb6726',
  '0x25faedc3f054130dbb4e4203aca63567',
  '0x49b67c39f5566535de22b29b0e51e685',
  '0x7650808198966e4285687d3deb556ccc',
  '0x1765b5a9ec8fc3cdbc209c63cac68e86',
  '0xfd61ec89811ba3cf2ae12d0ed8ef1afd',
  '0xd289c79872a9eace15cc4cadb030661f',
  '0xa043053570d42d6f553896820dfd42b6',
  '0x544e60f98a36d7b22c0fb5824b84f795',
  '0x2ff71b802a6788a052c7f1a58ec863af',
  '0xb113d34e351cf195733c98442530c099',
  '0x54e00a5988577cb0b0c9ab0cb6ef7f4b',
  '0x2c54c60600e1d786b2dfc139a38a5a99',
  '0x9cd8fd4cae61e63a10ba7615780ee520',
  '0x593494b6af79172fa983a0cf1c88e0e0',
  '0xbc8a22f25703a03101630ce6b09f4baa',
  '0x58dae745c8c5fed4012f35ef39829c2d',
  '0xbd31bd605c0a1b82c72aae3587f9061f',
  '0x9fb16485b70ac89fd8c45b1a130e1601',
  '0x83a0bf54708a0236a49f7301677ffdc2',
  '0xec43194f64d555bdaef5afb5b6c6c686',
  '0x9325025f805731935c1df7f97e654cda',
  '0xedfb8d993ee8cb935338601d8673dfcf',
  '0x1684cb225aa305ea5be44f2a79214e7e',
  '0xbf086597fdd837bfb58cf968533edaf3',
  '0x5e887f0c6c3deec190c36186bf23369f',
  '0x1c994ad3381d31c86c8c2d74ed89a365',
  '0xbe946bd7862245615d6729ec5b67cc7e',
  '0x85b8124314ae77b78b4b6f20ecd93149',
  '0x730fc3855fb77d2aa5a19dd7891dbe80',
  '0x4519b5c4a2fd0beb66306336f63c7b99',
  '0xa7e941cbc468d48b99dc6002f8f5042b',
  '0x4f49b5f025c969501c6a350f984e1725',
  '0x0896dbb30344c65b8727f41c3fe9ef62',
  '0xbf0ff526276afdfba89c41a520e154fe',
  '0x29067197b3125c8b82ad0f338e4a31b2',
  '0x6679db5a5be138456cf95b1fc7e870a5',
  '0x8e3a7531199e3f0d6e616a1f9edae9a3',
  '0xd7721f1acc95fd05516bdc5138ded7bc',
  '0xc03b5b39372b9daa292adc59a8568263',
  '0x20b8c9d2f022ffd2aea4f7962b7b1d8b',
])

/** True when a spot token (by its spotMeta `tokenId`) is on the Strict list. */
export const isStrictSpotToken = (tokenId) => STRICT_SPOT_TOKEN_IDS.has(String(tokenId ?? '').toLowerCase())

export const STRICT_LS_KEY = 'hliq_spot_strict'

/** The setting: Strict unless the person chose All. Default on, as on Hyperliquid. */
export function spotStrictOn(store = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try { return store?.getItem(STRICT_LS_KEY) !== '0' } catch { return true }
}
export function setSpotStrict(on, store = (typeof localStorage !== 'undefined' ? localStorage : null)) {
  try { store?.setItem(STRICT_LS_KEY, on ? '1' : '0') } catch {}
}

/**
 * Whether a market key passes the Strict filter. Only spot ("@N") keys are judged. `strictKeys` is
 * the set of strict spot keys built from spotMeta; EMPTY means spotMeta has not loaded, which is
 * "we do not know", not "none are strict" — so nothing is hidden then. A favourite always shows.
 */
export function passesStrict(key, { on, strictKeys, favs } = {}) {
  const k = String(key ?? '')
  if (!on || !k.startsWith('@')) return true
  if (!strictKeys || !strictKeys.size) return true
  return strictKeys.has(k) || !!favs?.includes?.(k)
}
