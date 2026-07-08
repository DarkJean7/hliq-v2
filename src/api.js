import { InfoClient, HttpTransport } from '@nktkas/hyperliquid'

// Single shared transport + info client
const transport = new HttpTransport({ timeout: 30_000 })
export const infoClient = new InfoClient({ transport })

// HIP-3 internal tickers that differ from HL's canonical display names.
// Keys are the prefixed HL coin names; values are what HL's own UI shows.
const HIP3_RENAMES = {
  'xyz:CL': 'WTIOIL',
}
function _hip3Rename(coin) { return HIP3_RENAMES[coin] ?? coin }
export function hip3Rename(coin) { return _hip3Rename(coin) }

// User-facing coin label: apply the rename, then drop the HIP-3 dex prefix
// (e.g. "xyz:SPCX" → "SPCX", "xyz:CL" → "WTIOIL"). Display only — never use this
// for order/close actions, which need the real prefixed coin id.
export function coinLabel(coin) { return _hip3Rename(String(coin ?? '')).replace(/.*:/, '') }

// Extract HIP-3 DEX names from allPerpMetas array (index 0 = main DEX, rest = HIP-3)
function _hip3DexNames(allMetas) {
  const dexes = new Set()
  for (let i = 1; i < allMetas.length; i++) {
    for (const u of (allMetas[i].universe ?? [])) {
      const idx = u.name.indexOf(':')
      if (idx > 0) dexes.add(u.name.slice(0, idx))
    }
  }
  return [...dexes]
}

// Fetch clearinghouseState for main DEX + all HIP-3 DEXes; merges assetPositions from all.
// Main DEX + HIP-3 DEXes are fetched in parallel. HIP-3 failures are silently skipped.
export async function fetchClearinghouseState(address, allMetas) {
  const dexes = allMetas && allMetas.length > 1 ? _hip3DexNames(allMetas) : []
  const [mainState, ...hip3States] = await Promise.all([
    infoClient.clearinghouseState({ user: address }),
    ...dexes.map(dex => infoClient.clearinghouseState({ user: address, dex }).catch(() => null)),
  ])
  if (!dexes.length) {
    // Caller skipped the HIP-3 fan-out this tick (rate-limit protection) —
    // reuse the cached HIP-3 positions so they don't flicker out of the UI.
    if (_hip3Cache.addr === address && _hip3Cache.positions.length) {
      return { ...mainState, assetPositions: [...(mainState.assetPositions ?? []), ..._hip3Cache.positions] }
    }
    return mainState
  }
  // HIP-3 clearinghouseState returns coin names WITHOUT the "dex:" prefix (e.g. "CL" not "xyz:CL").
  // Prefix them so they match allMids keys and fills (which do use the "dex:coin" convention).
  const extraPositions = hip3States.flatMap((s, i) => {
    if (!s) return []
    const dex = dexes[i]
    return (s.assetPositions ?? []).map(ap => {
      const prefixed = ap.position.coin.includes(':') ? ap.position.coin : `${dex}:${ap.position.coin}`
      return { ...ap, position: { ...ap.position, coin: _hip3Rename(prefixed) } }
    })
  })
  _hip3Cache.addr = address
  _hip3Cache.positions = extraPositions
  if (!extraPositions.length) return mainState
  return { ...mainState, assetPositions: [...(mainState.assetPositions ?? []), ...extraPositions] }
}

// Fetch frontendOpenOrders for main DEX + all HIP-3 DEXes, merged into one array.
// HIP-3 failures are silently skipped; main DEX errors propagate to caller.
// Cache of the last HIP-3 fan-out results, reused on ticks that skip the fan-out
const _hip3Cache = { addr: null, positions: [], orders: [] }

export async function fetchFrontendOpenOrders(address, allMetas) {
  const mainOrders = await infoClient.frontendOpenOrders({ user: address })
  const dexes = allMetas && allMetas.length > 1 ? _hip3DexNames(allMetas) : []
  if (!dexes.length) {
    if (_hip3Cache.addr === address && _hip3Cache.orders.length) return [...mainOrders, ..._hip3Cache.orders]
    return mainOrders
  }
  const hip3Arrays = await Promise.all(
    dexes.map(dex => infoClient.frontendOpenOrders({ user: address, dex }).catch(() => []).then(orders =>
      orders.map(o => {
        const prefixed = o.coin.includes(':') ? o.coin : `${dex}:${o.coin}`
        return { ...o, coin: _hip3Rename(prefixed) }
      })
    ))
  )
  _hip3Cache.addr = address
  _hip3Cache.orders = hip3Arrays.flat()
  return [...mainOrders, ..._hip3Cache.orders]
}

// Fetch allMids for main DEX + all HIP-3 DEXes, merged into one object.
// Never throws — HIP-3 failures are silently skipped.
export async function fetchAllMids(allMetas) {
  const mainMids = await infoClient.allMids()
  if (!allMetas || allMetas.length <= 1) return mainMids
  const dexes = _hip3DexNames(allMetas)
  if (!dexes.length) return mainMids
  const hip3Arr = await Promise.all(dexes.map(dex => infoClient.allMids({ dex }).catch(() => ({}))))
  const merged = Object.assign({}, mainMids, ...hip3Arr)
  // Mirror renamed keys so mark price lookups still work after position coin rename
  for (const [from, to] of Object.entries(HIP3_RENAMES)) {
    if (from in merged) merged[to] = merged[from]
  }
  return merged
}


/**
 * Fetch all-time fills via sequential pagination.
 * userFillsByTime caps at 2000 per request — page forward until < 2000 returned.
 * Returns raw HL fill objects sorted newest-first.
 */
async function fetchAllFunding(address, startTime) {
  const all  = []
  const seen = new Set()

  while (true) {
    const batch = await infoClient.userFunding({ user: address, startTime }).catch(() => [])
    if (!batch.length) break

    for (const f of batch) {
      // Funding hashes are always 0x000...0 — use composite key instead
      const key = `${f.time}_${f.delta?.coin}_${f.delta?.usdc}`
      if (!seen.has(key)) { seen.add(key); all.push(f) }
    }

    if (batch.length < 500) break

    const maxTime = Math.max(...batch.map(f => f.time))
    startTime = maxTime + 1
  }

  return all.sort((a, b) => b.time - a.time)
}

/**
 * Load all read-only account data in parallel where possible.
 * On mobile, history is limited to 90 days to keep load times fast.
 */
export async function loadAccountData(address, onStep, { mobile = false } = {}) {
  const GENESIS   = 1667260800000
  const NINETY_D  = Date.now() - 90 * 24 * 60 * 60 * 1000
  const fillsFrom = mobile ? NINETY_D : GENESIS

  // Fire all 7 calls simultaneously — none depend on each other
  onStep(1, 'active')
  onStep(2, 'active')
  onStep(3, 'active')
  const [perpState, spotState, openOrders, fills, portfolio, allMetas, allMids, outcomeMeta] = await Promise.all([
    infoClient.clearinghouseState({ user: address }),
    infoClient.spotClearinghouseState({ user: address }),
    infoClient.frontendOpenOrders({ user: address }),
    infoClient.userFillsByTime({ user: address, startTime: fillsFrom, reversed: true })
      .catch(() => infoClient.userFills({ user: address })),
    infoClient.portfolio({ user: address }),
    infoClient.allPerpMetas(),
    infoClient.allMids(),
    infoClient.outcomeMeta().catch(() => null),
  ])
  onStep(1, 'done')
  onStep(2, 'done')
  onStep(3, 'done')

  const meta = { universe: allMetas.flatMap(m => m.universe ?? []) }

  // HIP-3 DEX mids deferred — don't block render, caller patches state.allMids in background
  const hip3Promise = Promise.all(
    _hip3DexNames(allMetas).map(dex => infoClient.allMids({ dex }).catch(() => ({})))
  ).then(arr => Object.assign({}, allMids, ...arr))

  return { perpState, spotState, openOrders, fills, portfolio, meta, allMetas, allMids, hip3Promise, outcomeMeta }
  // funding + webData deferred — call loadFundingData() separately
}

export async function loadFundingData(address, { mobile = false } = {}) {
  const GENESIS  = 1667260800000
  const NINETY_D = Date.now() - 90 * 24 * 60 * 60 * 1000
  const fillsFrom = mobile ? NINETY_D : GENESIS
  const [funding, webData] = await Promise.all([
    fetchAllFunding(address, fillsFrom).catch(e => {
      console.warn('Funding fetch failed:', e.message)
      return []
    }),
    infoClient.webData2({ user: address }).catch(e => {
      console.warn('webData2 fetch failed:', e.message)
      return null
    }),
  ])
  return { funding, webData }
}

/**
 * Build a coin → asset index map from meta
 */
export function buildAssetMap(meta) {
  const map = {}
  ;(meta.universe || []).forEach((u, i) => {
    map[u.name] = { index: i, szDecimals: u.szDecimals ?? 6, maxLeverage: u.maxLeverage ?? 50 }
  })
  return map
}

/**
 * Aggregate fill stats per coin
 */
export function aggregateFillsByCoin(fills) {
  const map = {}
  for (const f of fills) {
    const coin = _hip3Rename(f.coin)
    if (!map[coin]) {
      map[coin] = { coin, trades: 0, volume: 0, closedPnl: 0, fees: 0 }
    }
    map[coin].trades++
    map[coin].volume    += f.notional
    map[coin].closedPnl += f.closedPnl
    map[coin].fees      += f.fee
  }
  return Object.values(map).sort((a, b) => b.volume - a.volume)
}