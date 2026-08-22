import { InfoClient, HttpTransport, SubscriptionClient, WebSocketTransport } from '@nktkas/hyperliquid'

// Single shared transport + info client
const transport = new HttpTransport({ timeout: 30_000 })
export const infoClient = new InfoClient({ transport })

// Lazy WebSocket subscription client — used for live price (allMids) pushes so we don't
// poll HL over REST for prices (which burns the weight budget). Auto-reconnects.
let _subsClient = null
export function subsClient() {
  if (!_subsClient) _subsClient = new SubscriptionClient({ transport: new WebSocketTransport() })
  return _subsClient
}

// HIP-3 internal tickers that differ from HL's canonical display names.
// Keys are the prefixed HL coin names; values are what HL's own UI shows.
const HIP3_RENAMES = {
  'xyz:CL': 'WTIOIL',
}
function _hip3Rename(coin) { return HIP3_RENAMES[coin] ?? coin }
export function hip3Rename(coin) { return _hip3Rename(coin) }

// Bounded-concurrency map, preserving input order.
//
// The HIP-3 fan-outs fired one request per dex through Promise.all. With ~9 dexes
// that's a 9-wide burst per call site, and several call sites tick together — enough
// to blow HL's burst bucket and 429 even though the average rate is modest. Capping
// in-flight requests flattens the spike without making the data any less fresh.
const HL_FAN_CONCURRENCY = 3
export async function hlPool(items, fn, limit = HL_FAN_CONCURRENCY) { return _pool(items, fn, limit) }
async function _pool(items, fn, limit = HL_FAN_CONCURRENCY) {
  const out = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

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
  const mainState  = await infoClient.clearinghouseState({ user: address })
  const hip3States = await _pool(dexes, dex =>
    infoClient.clearinghouseState({ user: address, dex }).catch(() => null))
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
  //
  // Cached PER DEX, and a failed dex falls back to its own last-known positions.
  //
  // This is the HIP-3 flicker. Each dex is a separate call every 5s, they share HL's 1200
  // weight/min budget with everything else, and one of them 429ing or timing out returned
  // null — which flatMap turned into "no positions on that dex", identical to genuinely
  // holding none. The row vanished, and the old single `positions` cache was then
  // overwritten with the incomplete set, so there was nothing to fall back to either. Next
  // tick it came back. Only a dex that ANSWERS can retire its cached positions; one that
  // could not be reached keeps them.
  if (_hip3Cache.addr !== address) { _hip3Cache.addr = address; _hip3Cache.byDex = {} }
  const extraPositions = dexes.flatMap((dex, i) => {
    const s = hip3States[i]
    if (!s) return _hip3Cache.byDex[dex] ?? []
    const mapped = (s.assetPositions ?? []).map(ap => {
      const prefixed = ap.position.coin.includes(':') ? ap.position.coin : `${dex}:${ap.position.coin}`
      return { ...ap, position: { ...ap.position, coin: _hip3Rename(prefixed) } }
    })
    _hip3Cache.byDex[dex] = mapped
    return mapped
  })
  _hip3Cache.positions = extraPositions
  if (!extraPositions.length) return mainState
  return { ...mainState, assetPositions: [...(mainState.assetPositions ?? []), ...extraPositions] }
}

// Fetch frontendOpenOrders for main DEX + all HIP-3 DEXes, merged into one array.
// HIP-3 failures are silently skipped; main DEX errors propagate to caller.
// Cache of the last HIP-3 fan-out results, reused on ticks that skip the fan-out
const _hip3Cache = { addr: null, positions: [], orders: [], byDex: {} }

export async function fetchFrontendOpenOrders(address, allMetas) {
  const mainOrders = await infoClient.frontendOpenOrders({ user: address })
  const dexes = allMetas && allMetas.length > 1 ? _hip3DexNames(allMetas) : []
  if (!dexes.length) {
    if (_hip3Cache.addr === address && _hip3Cache.orders.length) return [...mainOrders, ..._hip3Cache.orders]
    return mainOrders
  }
  const hip3Arrays = await _pool(dexes, dex =>
    infoClient.frontendOpenOrders({ user: address, dex }).catch(() => []).then(orders =>
      orders.map(o => {
        const prefixed = o.coin.includes(':') ? o.coin : `${dex}:${o.coin}`
        return { ...o, coin: _hip3Rename(prefixed) }
      })
    ))
  _hip3Cache.addr = address
  _hip3Cache.orders = hip3Arrays.flat()
  return [...mainOrders, ..._hip3Cache.orders]
}

// HIP-3 dex mids ONLY (main-dex mids come from the WS/allMids feed, which does not
// cover HIP-3 dexes). Pass the filtered fan-metas so only the account's active dexes
// are hit — allMids({dex}) is weight-2, so 1–2 active dexes is cheap. Keys come back
// already "dex:coin" prefixed, matching position coin ids. Returns {} when none.
export async function fetchHip3Mids(allMetas) {
  const dexes = (allMetas && allMetas.length > 1) ? _hip3DexNames(allMetas) : []
  if (!dexes.length) return {}
  const arr = await _pool(dexes, dex => infoClient.allMids({ dex }).catch(() => ({})))
  const merged = Object.assign({}, ...arr)
  for (const [from, to] of Object.entries(HIP3_RENAMES)) {
    if (from in merged) merged[to] = merged[from]
  }
  return merged
}

// Fetch allMids for main DEX + all HIP-3 DEXes, merged into one object.
// Never throws — HIP-3 failures are silently skipped.
export async function fetchAllMids(allMetas) {
  const mainMids = await infoClient.allMids()
  if (!allMetas || allMetas.length <= 1) return mainMids
  const dexes = _hip3DexNames(allMetas)
  if (!dexes.length) return mainMids
  const hip3Arr = await _pool(dexes, dex => infoClient.allMids({ dex }).catch(() => ({})))
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
export async function fetchAllFunding(address, startTime = 1667260800000, { info = infoClient, maxPages = 60 } = {}) {
  const all  = []
  const seen = new Set()

  for (let page = 0; page < maxPages; page++) {
    const batch = await info.userFunding({ user: address, startTime }).catch(() => [])
    if (!Array.isArray(batch) || !batch.length) break

    for (const f of batch) {
      // Funding hashes are always 0x000...0 — use composite key instead
      const key = `${f.time}_${f.delta?.coin}_${f.delta?.usdc}`
      if (!seen.has(key)) { seen.add(key); all.push(f) }
    }

    if (batch.length < 500) break

    const maxTime = Math.max(...batch.map(f => f.time))
    if (maxTime + 1 <= startTime) break   // no forward progress — bail
    startTime = maxTime + 1
  }

  return all.sort((a, b) => b.time - a.time)
}

/**
 * Fetch a user's fills across an unbounded window via sequential time-paging.
 * userFillsByTime returns at most 2000 fills per response, so a single call
 * silently truncates once an account crosses ~2000 lifetime fills. We page
 * forward by time until a short page (< 2000) proves we've reached the end.
 *
 * Dedupe key is `tid` (the unique per-fill trade id) — NEVER `hash`, which HL
 * returns as 0x000…0 for many fills, so hash-keying would collapse distinct
 * fills into one. Returns raw HL fill objects sorted newest-first.
 *
 * @param {string} address
 * @param {{ startTime?: number, info?: object, maxPages?: number }} [opts]
 */
export async function fetchAllFills(address, { startTime = 1667260800000, info = infoClient, maxPages = 60 } = {}) {
  const all  = []
  const seen = new Set()
  let cursor = startTime
  for (let page = 0; page < maxPages; page++) {
    const batch = await info.userFillsByTime({ user: address, startTime: cursor }).catch(() => [])
    if (!Array.isArray(batch) || !batch.length) break
    for (const f of batch) {
      const key = f.tid ?? `${f.time}_${f.oid}_${f.px}_${f.sz}_${f.dir}`
      if (!seen.has(key)) { seen.add(key); all.push(f) }
    }
    if (batch.length < 2000) break
    const maxTime = Math.max(...batch.map(f => f.time))
    if (maxTime + 1 <= cursor) break   // no forward progress — bail rather than loop forever
    cursor = maxTime + 1
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
    fetchAllFills(address, { startTime: fillsFrom })
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
  const hip3Promise = _pool(_hip3DexNames(allMetas), dex => infoClient.allMids({ dex }).catch(() => ({})))
    .then(arr => Object.assign({}, allMids, ...arr))

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