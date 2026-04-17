import { InfoClient, HttpTransport } from '@nktkas/hyperliquid'

// Single shared transport + info client
const transport = new HttpTransport()
export const infoClient = new InfoClient({ transport })


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

  // Steps 1 & 2 are independent — fetch in parallel
  onStep(1, 'active')
  onStep(2, 'active')
  const [perpState, spotState] = await Promise.all([
    infoClient.clearinghouseState({ user: address }),
    infoClient.spotClearinghouseState({ user: address }),
  ])
  onStep(1, 'done')
  onStep(2, 'done')

  onStep(3, 'active')
  const [openOrders, fills, portfolio, allMetas, allMids] = await Promise.all([
    infoClient.frontendOpenOrders({ user: address }),
    infoClient.userFillsByTime({ user: address, startTime: fillsFrom, reversed: true })
      .catch(() => infoClient.userFills({ user: address })),
    infoClient.portfolio({ user: address }),
    infoClient.allPerpMetas(),
    infoClient.allMids(),
  ])
  const meta = { universe: allMetas.flatMap(m => m.universe ?? []) }
  onStep(3, 'done')

  // Step 4: funding + webData2 in parallel
  onStep(4, 'active')
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
  onStep(4, 'done')

  return { perpState, spotState, openOrders, fills, portfolio, funding, meta, allMetas, allMids, webData }
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