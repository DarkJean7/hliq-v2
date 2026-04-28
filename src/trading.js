import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import { ethers } from 'ethers'

let exchangeClient = null
let walletAddress  = null

// We also keep an info client to fetch asset indices
const infoTransport = new HttpTransport()
const infoClient    = new InfoClient({ transport: infoTransport })

// Cache of coin → asset index
let assetIndexCache = null

async function getAssetInfo(coin) {
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

/**
 * Connect an agent private key.
 * Returns the derived address on success, throws on failure.
 */
export async function connectAgentKey(privateKey) {
  // ethers v6 wallet works directly as the wallet param
  const wallet = new ethers.Wallet(privateKey)
  walletAddress = wallet.address

  const transport = new HttpTransport()
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
  const transport = new HttpTransport()
  const client    = new ExchangeClient({ transport, wallet: signer })
  return client.approveBuilderFee({
    maxFeeRate: '0.1%',
    builder: '0x25A267e78F51A2E4Ddd6d4951b7f7Ed752891c38',
  })
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

  const { index: assetIndex, szDecimals } = await getAssetInfo(coin)

  if (!reduceOnly && !skipLevUpdate) {
    await exchangeClient.updateLeverage({
      asset:   assetIndex,
      isCross: !isIsolated,
      leverage,
    })
  }

  const params = {
    orders: [{
      a: assetIndex,
      b: isBuy,
      p: roundPx(limitPx).toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: reduceOnly,
      t: orderType,
    }],
    grouping: 'na',
  }
  if (builderFeeEnabled) {
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
  const slippage = 0.03
  const limitPx  = isBuy
    ? markPrice * (1 + slippage)
    : markPrice * (1 - slippage)

  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:     { limit: { tif: 'Ioc' } },
    reduceOnly:    false,
    leverage:      1,
    isIsolated:    false,
    skipLevUpdate: true,
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

  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType: {
      trigger: {
        triggerPx: roundPx(triggerPx).toString(),
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
      p: roundPx(newPx).toString(),
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

// ─── PRECISION HELPERS ────────────────────────────────────────────────────────
function roundSz(n, szDecimals = 6) {
  const factor = Math.pow(10, szDecimals)
  return Math.floor(parseFloat(n) * factor) / factor
}

function roundPx(n) {
  const f = parseFloat(n)
  if (f >= 10000) return Math.round(f * 10) / 10
  if (f >= 1000)  return Math.round(f * 100) / 100
  if (f >= 1)     return Math.round(f * 1000) / 1000
  return parseFloat(f.toPrecision(5))
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