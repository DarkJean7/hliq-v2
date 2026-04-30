import { InfoClient, HttpTransport } from '@nktkas/hyperliquid'

// Single shared transport + info client
const transport = new HttpTransport()
export const infoClient = new InfoClient({ transport })

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

// Fetch allMids for main DEX + all HIP-3 DEXes, merged into one object.
// Never throws — HIP-3 failures are silently skipped.
export async function fetchAllMids(allMetas) {
  const mainMids = await infoClient.allMids()
  if (!allMetas || allMetas.length <= 1) return mainMids
  const dexes = _hip3DexNames(allMetas)
  if (!dexes.length) return mainMids
  const hip3Arr = await Promise.all(dexes.map(dex => infoClient.allMids({ dex }).catch(() => ({}))))
  return Object.assign({}, mainMids, ...hip3Arr)
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
  const [perpState, spotState, openOrders, fills, portfolio, allMetas, allMids] = await Promise.all([
    infoClient.clearinghouseState({ user: address }),
    infoClient.spotClearinghouseState({ user: address }),
    infoClient.frontendOpenOrders({ user: address }),
    infoClient.userFillsByTime({ user: address, startTime: fillsFrom, reversed: true })
      .catch(() => infoClient.userFills({ user: address })),
    infoClient.portfolio({ user: address }),
    infoClient.allPerpMetas(),
    infoClient.allMids(),
  ])
  onStep(1, 'done')
  onStep(2, 'done')
  onStep(3, 'done')

  const meta = { universe: allMetas.flatMap(m => m.universe ?? []) }

  // HIP-3 DEX mids deferred — don't block render, caller patches state.allMids in background
  const hip3Promise = Promise.all(
    _hip3DexNames(allMetas).map(dex => infoClient.allMids({ dex }).catch(() => ({})))
  ).then(arr => Object.assign({}, allMids, ...arr))

  return { perpState, spotState, openOrders, fills, portfolio, meta, allMetas, allMids, hip3Promise }
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
    if (!map[f.coin]) {
      map[f.coin] = { coin: f.coin, trades: 0, volume: 0, closedPnl: 0, fees: 0 }
    }
    map[f.coin].trades++
    map[f.coin].volume    += f.notional
    map[f.coin].closedPnl += f.closedPnl
    map[f.coin].fees      += f.fee
  }
  return Object.values(map).sort((a, b) => b.volume - a.volume)
}