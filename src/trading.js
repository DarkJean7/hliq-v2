import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import { ethers } from 'ethers'

let exchangeClient = null
let walletAddress  = null

// We also keep an info client to fetch asset indices
const infoTransport = new HttpTransport({ timeout: 30_000 })
const infoClient    = new InfoClient({ transport: infoTransport })

// Cache of coin → asset index
let assetIndexCache = null
let dexMetaCache    = {}   // { [dex]: { 'dex:SYM': {index, szDecimals} } }

async function getAssetInfo(coin) {
  // HIP-4 outcome markets: coin '#N' (N = 10*outcomeId + side) → asset id 100_000_000 + N.
  // (NOT 10000 + N — that's the regular-spot encoding and lands on a non-existent spot pair,
  // which HL rejects as "invalid spot".) isSpot skips leverage + builder fee (neither applies
  // to fully-collateralized binary outcome markets).
  if (coin.startsWith('#')) {
    // Outcome shares trade in WHOLE units (l2Book sizes are all integers, e.g. "26.0"),
    // so szDecimals = 0. szDecimals also drives roundPx's decimal cap; combined with the
    // 5-significant-figure cap this matches HL's outcome price tick (prices ≤5 sig figs).
    const n = parseInt(coin.slice(1))
    return { index: 100_000_000 + n, szDecimals: 0, isSpot: true, isOutcome: true }
  }
  // HIP-3 builder markets "dex:SYM" — separate universe, offset asset id:
  // 100000 + perpDexIndex*10000 + indexInDexUniverse (perpDexs[0] is the main dex).
  if (coin.includes(':')) {
    const dex = coin.split(':')[0].toLowerCase()
    if (!dexMetaCache[dex]) {
      const [dexs, meta] = await Promise.all([infoClient.perpDexs(), infoClient.meta({ dex })])
      const dexIdx = (dexs || []).findIndex(d => d && d.name === dex)
      if (dexIdx < 1) throw new Error(`Unknown perp dex: ${dex}`)
      const m = {}
      ;(meta.universe || []).forEach((u, i) => {
        m[u.name] = { index: 100000 + dexIdx * 10000 + i, szDecimals: u.szDecimals ?? 6 }
      })
      dexMetaCache[dex] = m
    }
    const info = dexMetaCache[dex][coin]
    if (!info) throw new Error(`Unknown coin: ${coin}`)
    return info
  }
  if (!assetIndexCache) {
    const meta = await infoClient.meta()
    assetIndexCache = {}
    ;(meta.universe || []).forEach((u, i) => {
      assetIndexCache[u.name] = { index: i, szDecimals: u.szDecimals ?? 6 }
    })
  }
  const info = assetIndexCache[coin]
  if (!info) throw new Error(`Unknown coin: ${coin}`)
  return info
}

export function getWalletAddress() { return walletAddress }
export function isConnected()      { return exchangeClient !== null }

export async function fetchCandles(coin, interval, startTime, endTime) {
  return infoClient.candleSnapshot({ coin, interval, startTime, ...(endTime ? { endTime } : {}) })
}

export async function fetchMarketCtxs() {
  return infoClient.metaAndAssetCtxs()
}

export async function fetchPerpCategories() {
  return infoClient.perpCategories()
}

export async function fetchSpotMeta() {
  return infoClient.spotMeta()
}

export async function fetchSpotMarketCtxs() {
  return infoClient.spotMetaAndAssetCtxs()
}

export async function fetchDexMarketCtxs(dex) {
  return infoClient.metaAndAssetCtxs({ dex })
}

/**
 * Connect an agent private key.
 * Returns the derived address on success, throws on failure.
 */
export async function connectAgentKey(privateKey) {
  // ethers v6 wallet works directly as the wallet param
  const wallet = new ethers.Wallet(privateKey)
  walletAddress = wallet.address

  const transport = new HttpTransport({ timeout: 60_000 })
  exchangeClient = new ExchangeClient({ transport, wallet })

  // Clear asset cache so it refreshes on next use
  assetIndexCache = null

  return walletAddress
}

export function disconnect() {
  walletAddress    = null
  exchangeClient   = null
  assetIndexCache  = null
  builderFeeEnabled = false
}

let builderFeeEnabled = false
export function setBuilderFeeEnabled(val) { builderFeeEnabled = val }
export function isBuilderFeeEnabled()     { return builderFeeEnabled }

export async function applyReferrer() {
  if (!exchangeClient) throw new Error('Agent key not connected')
  return exchangeClient.setReferrer({ code: 'INSOLVENTSPARTAN' })
}

export async function approveBuilderFee(signer) {
  const transport = new HttpTransport({ timeout: 60_000 })
  const client    = new ExchangeClient({ transport, wallet: signer })
  return client.approveBuilderFee({
    maxFeeRate: '0.1%',
    builder: '0x25A267e78F51A2E4Ddd6d4951b7f7Ed752891c38',
  })
}

export async function approveAgentKey(mainSigner, agentAddress) {
  const transport = new HttpTransport({ timeout: 60_000 })
  const client    = new ExchangeClient({ transport, wallet: mainSigner })
  return client.approveAgent({ agentAddress, agentName: 'hliq' })
}


/**
 * Core order placer — uses asset index format required by v0.32.x
 */
async function placeOrderRaw({
  coin,
  isBuy,
  sz,
  limitPx,
  orderType,
  reduceOnly    = false,
  leverage      = 5,
  isIsolated    = false,
  skipLevUpdate = false,
}) {
  if (!exchangeClient) throw new Error('Agent key not connected')

  const { index: assetIndex, szDecimals, isSpot, isOutcome } = await getAssetInfo(coin)

  // Spot/outcome assets have no leverage — calling updateLeverage on them is rejected
  // by HL ("invalid spot"). Only perps get a leverage update.
  if (!reduceOnly && !skipLevUpdate && !isSpot) {
    await exchangeClient.updateLeverage({
      asset:   assetIndex,
      isCross: !isIsolated,
      leverage,
    })
  }

  // Outcome (HIP-4) prices use a fixed 1e-5 tick (5 decimal places), NOT the
  // perp 5-significant-figure rule — roundPx would emit 6 decimals for prices
  // under 0.1 (e.g. 0.034441) and HL rejects with "not divisible by tick size".
  const pVal = isOutcome
    ? Math.round(parseFloat(limitPx) * 1e5) / 1e5
    : roundPx(limitPx, szDecimals)

  const params = {
    orders: [{
      a: assetIndex,
      b: isBuy,
      p: pVal.toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: reduceOnly,
      t: orderType,
    }],
    grouping: 'na',
  }
  // Builder fees apply to perps only — attaching one to a spot/outcome order is rejected
  // by HL ("invalid spot").
  if (builderFeeEnabled && !isSpot) {
    params.builder = { b: '0x25A267e78F51A2E4Ddd6d4951b7f7Ed752891c38', f: 100 }
  }
  return exchangeClient.order(params)
}

/**
 * Market order — aggressive IOC limit with 0.3% slippage
 */
export async function placeMarketOrder({ coin, isBuy, sz, markPrice, leverage, isIsolated }) {
  const slippage = 0.03   // 3% — wide enough to ensure IOC fills on any liquid market
  const limitPx  = isBuy
    ? markPrice * (1 + slippage)
    : markPrice * (1 - slippage)

  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:  { limit: { tif: 'Ioc' } },
    reduceOnly: false,
    leverage,
    isIsolated,
  })
}

/**
 * Outcome (HIP-4) order. `market` = aggressive IOC that crosses the spread and
 * fills now; otherwise a resting GTC limit at the exact `limitPx`. Outcome
 * markets are 1×, cross-margin, quoted 0–1; `limitPx` must already be clamped
 * to (0,1). placeOrderRaw applies the fixed 1e-5 outcome tick.
 */
export async function placeOutcomeOrder({ coin, isBuy, sz, limitPx, market = false }) {
  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:  { limit: { tif: market ? 'Ioc' : 'Gtc' } },
    reduceOnly: false,
    leverage:   1,
    isIsolated: false,
  })
}

/**
 * Limit order — GTC
 */
export async function placeLimitOrder({ coin, isBuy, sz, limitPx, leverage, isIsolated }) {
  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:  { limit: { tif: 'Gtc' } },
    reduceOnly: false,
    leverage,
    isIsolated,
  })
}

/**
 * Close position at market (reduce-only IOC)
 */
export async function closePosition({ coin, isBuy, sz, markPrice }) {
  // Fall back to a fresh mid if the caller didn't pass a valid mark (e.g. a
  // HIP-3 coin whose price wasn't in the cached mids) — avoids p=0 rejection.
  let mp = parseFloat(markPrice)
  if (!(mp > 0)) {
    const dex  = coin.includes(':') ? coin.split(':')[0].toLowerCase() : undefined
    const mids = await infoClient.allMids(dex ? { dex } : undefined).catch(() => ({}))
    mp = parseFloat(mids?.[coin] ?? 0)
    if (!(mp > 0)) throw new Error(`Could not get mark price for ${coin}`)
  }
  const slippage = 0.03
  const limitPx  = isBuy
    ? mp * (1 + slippage)
    : mp * (1 - slippage)

  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:     { limit: { tif: 'Ioc' } },
    reduceOnly:    true,   // a close must reduce-only: otherwise HL reserves margin
    leverage:      1,      // as if opening, so large closes fail on tight margin
    isIsolated:    false,
    skipLevUpdate: true,
  })
}

/**
 * Add or remove margin on an isolated position.
 * @param isLong   position side (true = long)
 * @param usdAmount positive USDC amount to move
 * @param isAdd    true = add margin, false = remove margin
 */
export async function adjustIsolatedMargin({ coin, isLong, usdAmount, isAdd }) {
  if (!exchangeClient) throw new Error('Agent key not connected')
  const { index: assetIndex } = await getAssetInfo(coin)
  const ntli = Math.round(Math.abs(usdAmount) * 1e6) * (isAdd ? 1 : -1)
  if (ntli === 0) throw new Error('Amount must be greater than 0')
  return exchangeClient.updateIsolatedMargin({
    asset: assetIndex,
    isBuy: isLong,
    ntli,
  })
}

/**
 * TP / SL trigger order
 */
export async function placeTriggerOrder({ coin, isBuy, sz, triggerPx, tpsl }) {
  const slippage = 0.01
  const limitPx  = isBuy
    ? triggerPx * (1 + slippage)
    : triggerPx * (1 - slippage)

  const { szDecimals } = await getAssetInfo(coin)   // tick rule needs szDecimals

  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType: {
      trigger: {
        triggerPx: roundPx(triggerPx, szDecimals).toString(),
        isMarket:  true,
        tpsl,
      },
    },
    reduceOnly: true,
    leverage:   1,
    isIsolated: false,
  })
}

/**
 * Modify an order.
 * - Trigger (TP/SL): cancel old then place replacement (HL modify/batchModify reject triggers).
 * - Regular limit orders: atomic modify (throws on failure).
 */
export async function modifyOrderPrice({ coin, oid, isBuy, sz, newPx, tpsl, isTrigger }) {
  if (!exchangeClient) throw new Error('Agent key not connected')

  if (isTrigger && tpsl) {
    // Cancel existing order first (ignore "already gone" errors)
    try {
      const res    = await cancelOrder({ coin, oid: parseInt(oid) })
      const parsed = parseOrderResult(res)
      const gone   = parsed.errors.some(e => /never placed|already cancel|filled/i.test(e))
      if (!parsed.ok && !gone) throw new Error(parsed.errors.join(', '))
    } catch (e) {
      if (!/never placed|already cancel|filled/i.test(e.message)) throw e
    }
    return placeTriggerOrder({ coin, isBuy, sz, triggerPx: newPx, tpsl })
  }

  const { index: assetIndex, szDecimals } = await getAssetInfo(coin)
  return exchangeClient.modify({
    oid: parseInt(oid),
    order: {
      a: assetIndex,
      b: isBuy,
      p: roundPx(newPx, szDecimals).toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: false,
      t: { limit: { tif: 'Gtc' } },
    },
  })
}

/**
 * Cancel an open order
 */
export async function cancelOrder({ coin, oid }) {
  if (!exchangeClient) throw new Error('Agent key not connected')
  const { index: assetIndex } = await getAssetInfo(coin)
  return exchangeClient.cancel({ cancels: [{ a: assetIndex, o: parseInt(oid) }] })
}

/**
 * Batch-cancel multiple orders in a single API call
 */
export async function cancelOrders(orders) {
  if (!exchangeClient) throw new Error('Agent key not connected')
  const cancels = await Promise.all(
    orders.map(async ({ coin, oid }) => {
      const { index: assetIndex } = await getAssetInfo(coin)
      return { a: assetIndex, o: parseInt(oid) }
    })
  )
  return exchangeClient.cancel({ cancels })
}

// ─── PRECISION HELPERS ────────────────────────────────────────────────────────
function roundSz(n, szDecimals = 6) {
  const factor = Math.pow(10, szDecimals)
  return Math.floor(parseFloat(n) * factor) / factor
}

// HL perp price tick: at most 5 significant figures AND at most (6 - szDecimals)
// decimal places. The old magnitude-based rounding gave e.g. 218.618 (6 sig figs)
// which HL rejects ("not divisible by tick size") — common on HIP-3 stocks.
function roundPx(n, szDecimals = 6) {
  const f = parseFloat(n)
  if (!(f > 0)) return 0
  const sig    = parseFloat(f.toPrecision(5))        // ≤5 significant figures
  const maxDec = Math.max(0, 6 - szDecimals)          // perp decimal-place cap
  const factor = Math.pow(10, maxDec)
  return Math.round(sig * factor) / factor
}

/**
 * Parse SDK order response and extract statuses
 */
export function parseOrderResult(result) {
  const statuses = result?.response?.data?.statuses ?? []
  const errors   = statuses.filter(s => s && typeof s === 'object' && s.error).map(s => s.error)
  const filled   = statuses.filter(s => s && typeof s === 'object' && s.filled)
  const resting  = statuses.filter(s => s && typeof s === 'object' && s.resting)
  const waiting  = statuses.filter(s => s === 'waitingForFill' || s === 'waitingForTrigger')

  return {
    ok:      errors.length === 0,
    errors,
    filled,
    resting,
    waiting,
    raw:     result,
  }
}