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
  walletAddress  = null
  exchangeClient = null
  assetIndexCache = null
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
  reduceOnly = false,
  leverage   = 5,
  isIsolated = false,
}) {
  if (!exchangeClient) throw new Error('Agent key not connected')

  const { index: assetIndex, szDecimals } = await getAssetInfo(coin)

  // Set leverage (fire-and-forget errors are non-fatal for reduce-only closes)
  if (!reduceOnly) {
    await exchangeClient.updateLeverage({
      asset:   assetIndex,
      isCross: !isIsolated,
      leverage,
    })
  }

  return exchangeClient.order({
    orders: [{
      a: assetIndex,
      b: isBuy,
      p: roundPx(limitPx).toString(),
      s: roundSz(sz, szDecimals).toString(),
      r: reduceOnly,
      t: orderType,
    }],
    grouping: 'na',
  })
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
  const slippage = 0.003
  const limitPx  = isBuy
    ? markPrice * (1 + slippage)
    : markPrice * (1 - slippage)

  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:  { limit: { tif: 'Ioc' } },
    reduceOnly: true,
    leverage:   1,
    isIsolated: false,
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
 * Cancel an open order
 */
export async function cancelOrder({ coin, oid }) {
  if (!exchangeClient) throw new Error('Agent key not connected')
  const { index: assetIndex } = await getAssetInfo(coin)
  return exchangeClient.cancel({
    cancels: [{ a: assetIndex, o: oid }],
  })
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
  const errors   = statuses.filter(s => s.error).map(s => s.error)
  const filled   = statuses.filter(s => s.filled)
  const resting  = statuses.filter(s => s.resting)

  return {
    ok:      errors.length === 0,
    errors,
    filled,
    resting,
    raw:     result,
  }
}