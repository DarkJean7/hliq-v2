import { ExchangeClient, HttpTransport, InfoClient } from '@nktkas/hyperliquid'
import { ethers } from 'ethers'
import { isPaper, paperOrder, paperCancel, paperCancelMany, paperSetLeverage, paperAdjustMargin } from './paper.js'

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

// Sign a plain message with a raw agent private key (for bot-server login). Kept here
// with the other ethers usage; the caller loads the key from storage.
export async function signWithAgentKey(privateKey, message) {
  return new ethers.Wallet(privateKey).signMessage(message)
}

// The agent WALLET address a stored private key signs as. HL registers agents by this
// address, so it's what must appear in the master account's approved-agent list.
export function agentAddressOf(privateKey) {
  try { return new ethers.Wallet(privateKey).address.toLowerCase() } catch { return null }
}

// Agents currently approved ON-CHAIN for `master`, lowercased. An agent key lives in the
// browser but its approval lives on Hyperliquid — the two drift apart (a key generated on
// another device can supersede this one; a key can be stored for the wrong account). Orders
// then fail mid-action with HL's opaque "User or API Wallet 0x… does not exist".
// Cached briefly so a preflight check before every order isn't a fresh request each time.
const _agentListCache = new Map()   // master(lowercase) -> { addrs:Set, ts }
const _AGENT_LIST_TTL = 120_000
export async function fetchApprovedAgents(master, { force = false } = {}) {
  const key = String(master ?? '').toLowerCase()
  if (!key) return null
  const hit = _agentListCache.get(key)
  if (!force && hit && Date.now() - hit.ts < _AGENT_LIST_TTL) return hit.addrs
  const info = new InfoClient({ transport: new HttpTransport({ timeout: 15_000 }) })
  const list = await info.extraAgents({ user: master })
  // HL keeps EXPIRED agents in this list (each carries `validUntil`), and signing with one
  // fails the same way as an unknown agent — so treat expired as not-approved.
  const now = Date.now()
  const addrs = new Set((list ?? [])
    .filter(a => !a?.validUntil || Number(a.validUntil) > now)
    .map(a => String(a?.address ?? '').toLowerCase()).filter(Boolean))
  _agentListCache.set(key, { addrs, ts: Date.now() })
  return addrs
}
export function invalidateApprovedAgents(master) {
  if (master) _agentListCache.delete(String(master).toLowerCase())
  else _agentListCache.clear()
}

// ─── Multi-account agent keys ────────────────────────────────────────────────
// An agent key is its own wallet that acts ON BEHALF OF the master account which
// approved it, so this map is keyed by MASTER address, not the agent's address.
// The combined "All Accounts" view tags every position/order with `_acctAddr`, and
// each action routes to that account's client — never to whichever wallet happens
// to be "current".
const _agentClients = new Map()   // masterAddr(lowercase) -> ExchangeClient

export async function registerAgentKey(masterAddr, privateKey) {
  if (!masterAddr) throw new Error('registerAgentKey needs a master address')
  const wallet    = new ethers.Wallet(privateKey)
  const transport = new HttpTransport({ timeout: 60_000 })
  _agentClients.set(String(masterAddr).toLowerCase(), new ExchangeClient({ transport, wallet }))
  return wallet.address
}
export function hasAgentFor(masterAddr) {
  return !!masterAddr && _agentClients.has(String(masterAddr).toLowerCase())
}
export function clearAgentKeys() { _agentClients.clear() }

// While the combined view is active there is no meaningful "current" account, so an
// unrouted action must fail loudly instead of signing as whoever last connected.
let _strictAcct = false
export function setMultiAcctStrict(on) { _strictAcct = !!on }

// Resolve which client signs an action. `acct` = the owning master address, passed
// by the combined view. Falls back to the single connected client otherwise.
function _client(acct) {
  if (acct) {
    const c = _agentClients.get(String(acct).toLowerCase())
    if (!c) throw new Error(`No agent key for ${String(acct).slice(0, 6)}…${String(acct).slice(-4)}`)
    return c
  }
  if (_strictAcct) throw new Error('Pick an account for this action (All Accounts is active)')
  if (!exchangeClient) throw new Error('Agent key not connected')
  return exchangeClient
}

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
  _agentClients.clear()   // never leave a signer behind for another account
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

// Send USDC on HyperCore to another address, signed by the user's CONNECTED WALLET.
//
// It has to be the main wallet, not the agent key: Hyperliquid's API wallets can trade but
// cannot move funds, so an agent-signed transfer is rejected outright. This is the one
// money-moving action in the app, and it is exactly one signature — no bridge, no chain
// switch, no gas.
//
// USDC lives in two places on HyperCore and the two have different actions:
//   perp / "Trading Account" → usdSend      (the balance shown as `withdrawable`)
//   spot                     → spotSend     (needs the token id, e.g. "USDC:0x…")
// We look at both, spend from whichever can cover it, and prefer perp because that is where
// a trader's USDC actually sits. If the perp send fails for a reason that is not a rejected
// signature and spot could have covered it, we fall back rather than making the user work
// out which pocket their money is in.
export async function sendUsdcOnCore({ from, destination, amount, signer, source = 'auto' }) {
  const amt = Number(amount)
  if (!(amt > 0)) throw new Error('Amount must be greater than zero')
  if (!/^0x[0-9a-fA-F]{40}$/.test(destination ?? '')) throw new Error('Invalid destination address')
  if (!signer) throw new Error('Connect your wallet first')

  const [perpState, spotState] = await Promise.all([
    infoClient.clearinghouseState({ user: from }).catch(() => null),
    infoClient.spotClearinghouseState({ user: from }).catch(() => null),
  ])
  const perpFree = Number(perpState?.withdrawable ?? 0)
  const spotBal  = spotState?.balances ?? []
  const usdcRow  = spotBal.find(b => String(b.coin).toUpperCase() === 'USDC')
  const spotFree = Number(usdcRow?.total ?? 0) - Number(usdcRow?.hold ?? 0)

  // `source` lets the Send sheet honour an explicit pocket choice. 'auto' keeps the
  // subscription flow's behaviour: whichever pocket can cover it, perp first.
  if (source === 'perp' && perpFree < amt)
    throw new Error(`Trading account has $${perpFree.toFixed(2)} free, and this needs $${amt.toFixed(2)}.`)
  if (source === 'spot' && spotFree < amt)
    throw new Error(`Spot has $${spotFree.toFixed(2)} free, and this needs $${amt.toFixed(2)}.`)

  if (source === 'auto' && perpFree < amt && spotFree < amt) {
    // Deliberately not split across both pockets: that would be two signatures for one
    // payment. Someone holding enough in total just needs to consolidate first, so say so
    // rather than leaving them staring at a balance that looks sufficient.
    const enoughTogether = perpFree + spotFree >= amt
    throw new Error(
      `Not enough free USDC in one place. Trading account has $${perpFree.toFixed(2)}, ` +
      `spot has $${spotFree.toFixed(2)}, and this needs $${amt.toFixed(2)}.` +
      (enoughTogether ? ' Move some between Spot and your Trading account first.' : ''))
  }

  const transport = new HttpTransport({ timeout: 60_000 })
  const client = new ExchangeClient({ transport, wallet: signer })
  const value = String(amt)

  // ONE tap must mean at most ONE signature request, so the route is decided here, from
  // balances we already have, and never retried after a prompt has been shown.
  //
  // This used to try usdSend and fall back to spotSend on failure, guarded by a check for
  // "rejected" in the error message. That guard never fired: the SDK reports a declined
  // signature as `AbstractWalletError: Failed to sign typed data with ethers wallet` and
  // hangs the real "user rejected" error off `.cause`. So cancelling in the wallet threw a
  // message that matched nothing, fell into the fallback, and immediately asked the user to
  // sign again — and on mobile the second request arrived with no deep-link nudge, so the
  // app looked frozen and got tapped again. Declining has to mean declined.
  if (source === 'perp' || (source === 'auto' && perpFree >= amt))
    return client.usdSend({ destination, amount: value })

  // The token id is "SYMBOL:0x…" and is NOT stable enough to hardcode — read it from
  // spotMeta so a token-index change cannot silently send to the wrong asset.
  const meta = await infoClient.spotMeta()
  const tok = (meta?.tokens ?? []).find(t => String(t.name).toUpperCase() === 'USDC')
  if (!tok) throw new Error('Could not resolve the USDC token on Hyperliquid')
  return client.spotSend({ destination, token: `${tok.name}:${tok.tokenId}`, amount: value })
}

export async function approveAgentKey(mainSigner, agentAddress) {
  const transport = new HttpTransport({ timeout: 60_000 })
  const client    = new ExchangeClient({ transport, wallet: mainSigner })
  // HL caps agent validity at 180 days, set by appending `valid_until <ms>` to the
  // name (the base name's 16-char limit ignores that suffix). Use the max (minus a 1h
  // clock-skew buffer so we never trip HL's "≤180 days" check) so the key is long-lived.
  const validUntil = Date.now() + 180 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000
  return client.approveAgent({ agentAddress, agentName: `hliq valid_until ${validUntil}` })
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
  acct          = null,
}) {
  // PAPER MODE — every order path in the app funnels through here, so this one
  // guard is what makes it impossible to sign a real order while simulating.
  // It sits above _client() on purpose: no agent key is resolved or read.
  if (isPaper()) {
    const { szDecimals: _sd, isOutcome: _io, isSpot: _is } = await getAssetInfo(coin)
    // The real path sets leverage in a separate call before ordering; mirror that
    // so the simulated fill uses the leverage the user actually picked.
    if (!reduceOnly && !_is) paperSetLeverage(coin, leverage)
    const _p = _io ? Math.round(parseFloat(limitPx) * 1e5) / 1e5 : roundPx(limitPx, _sd)
    return paperOrder({
      orders: [{
        a: 0, b: isBuy, p: _p.toString(), s: roundSz(sz, _sd).toString(),
        r: reduceOnly, t: orderType,
      }],
      grouping: 'na',
    }, coin, { isSpot: _is, isOutcome: _io })
  }

  const client = _client(acct)

  const { index: assetIndex, szDecimals, isSpot, isOutcome } = await getAssetInfo(coin)

  // Spot/outcome assets have no leverage — calling updateLeverage on them is rejected
  // by HL ("invalid spot"). Only perps get a leverage update.
  if (!reduceOnly && !skipLevUpdate && !isSpot) {
    await client.updateLeverage({
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
  return client.order(params)
}

/**
 * Market order — aggressive IOC limit with 3% slippage (wide enough to fill on any
 * liquid market; the IOC never rests, so unfilled remainder is simply cancelled).
 */
export async function placeMarketOrder({ coin, isBuy, sz, markPrice, leverage, isIsolated, acct = null }) {
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
    acct,
  })
}

/**
 * Outcome (HIP-4) order. `market` = aggressive IOC that crosses the spread and
 * fills now; otherwise a resting GTC limit at the exact `limitPx`. Outcome
 * markets are 1×, cross-margin, quoted 0–1; `limitPx` must already be clamped
 * to (0,1). placeOrderRaw applies the fixed 1e-5 outcome tick.
 */
export async function placeOutcomeOrder({ coin, isBuy, sz, limitPx, market = false, acct = null }) {
  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:  { limit: { tif: market ? 'Ioc' : 'Gtc' } },
    reduceOnly: false,
    leverage:   1,
    isIsolated: false,
    acct,
  })
}

/**
 * Limit order — GTC
 */
export async function placeLimitOrder({ coin, isBuy, sz, limitPx, leverage, isIsolated, acct = null }) {
  return placeOrderRaw({
    coin, isBuy, sz, limitPx,
    orderType:  { limit: { tif: 'Gtc' } },
    reduceOnly: false,
    leverage,
    isIsolated,
    acct,
  })
}

/**
 * Close position at market (reduce-only IOC)
 */
export async function closePosition({ coin, isBuy, sz, markPrice, acct = null }) {
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
    acct,
  })
}

/**
 * Add or remove margin on an isolated position.
 * @param isLong   position side (true = long)
 * @param usdAmount positive USDC amount to move
 * @param isAdd    true = add margin, false = remove margin
 */
export async function adjustIsolatedMargin({ coin, isLong, usdAmount, isAdd, acct = null }) {
  if (isPaper()) {
    const r = paperAdjustMargin(coin, usdAmount, isAdd)
    if (!r.ok) throw new Error(r.error)
    return { status: 'ok', response: { type: 'default' } }
  }
  const client = _client(acct)
  const { index: assetIndex } = await getAssetInfo(coin)
  const ntli = Math.round(Math.abs(usdAmount) * 1e6) * (isAdd ? 1 : -1)
  if (ntli === 0) throw new Error('Amount must be greater than 0')
  return client.updateIsolatedMargin({
    asset: assetIndex,
    isBuy: isLong,
    ntli,
  })
}

/**
 * TP / SL trigger order
 */
export async function placeTriggerOrder({ coin, isBuy, sz, triggerPx, tpsl, acct = null }) {
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
    acct,
  })
}

/**
 * Modify an order.
 * - Trigger (TP/SL): cancel old then place replacement (HL modify/batchModify reject triggers).
 * - Regular limit orders: atomic modify (throws on failure).
 */
export async function modifyOrderPrice({ coin, oid, isBuy, sz, newPx, tpsl, isTrigger, acct = null }) {
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

  // Paper: no atomic modify — cancel and re-place, same as the trigger path above.
  if (isPaper()) {
    paperCancel(oid)
    return placeLimitOrder({ coin, isBuy, sz, limitPx: newPx, leverage: 5, isIsolated: false })
  }

  const { index: assetIndex, szDecimals } = await getAssetInfo(coin)
  return _client(acct).modify({
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
export async function cancelOrder({ coin, oid, acct = null }) {
  if (isPaper()) return paperCancel(oid)
  if (!exchangeClient) throw new Error('Agent key not connected')
  const { index: assetIndex } = await getAssetInfo(coin)
  return _client(acct).cancel({ cancels: [{ a: assetIndex, o: parseInt(oid) }] })
}

/**
 * Batch-cancel multiple orders in a single API call
 */
export async function cancelOrders(orders, acct = null) {
  if (isPaper()) return paperCancelMany((orders ?? []).map(o => ({ oid: o.oid })))
  // One cancel payload is signed by ONE account. Refuse a mixed batch rather than
  // silently signing everything with whichever client we happen to resolve.
  const accts = new Set(orders.map(o => (o._acctAddr ?? '').toLowerCase()).filter(Boolean))
  if (accts.size > 1) throw new Error('Cannot cancel orders from multiple accounts in one batch')
  const client = _client(acct ?? [...accts][0] ?? null)
  const cancels = await Promise.all(
    orders.map(async ({ coin, oid }) => {
      const { index: assetIndex } = await getAssetInfo(coin)
      return { a: assetIndex, o: parseInt(oid) }
    })
  )
  return client.cancel({ cancels })
}

// ─── PRECISION HELPERS ────────────────────────────────────────────────────────
function roundSz(n, szDecimals = 6) {
  const factor = Math.pow(10, szDecimals)
  // Scale, then strip binary-float noise BEFORE flooring. Plain
  // Math.floor(0.03795 * 1e5) is Math.floor(3794.9999999999995) = 3794, so a
  // "close 100%" order came out one tick short and left a dust position behind
  // that never went away. toPrecision(12) restores the intended 3795 while still
  // flooring anything genuinely below the tick.
  const scaled = parseFloat((parseFloat(n) * factor).toPrecision(12))
  return Math.floor(scaled) / factor
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
/**
 * What the Send sheet should say, as a pure decision — the sheet only paints the result.
 *
 * Order matters and is not alphabetical: it walks the blockers in the order the user can
 * actually clear them. Typing a bad address while disconnected must say "connect", not
 * "invalid address", because connecting is the step in front of them.
 *
 * @returns {{ok: boolean, label: string, msg: string, danger: boolean}}
 */
export function sendValidate({ connected, dest = '', amount, perpFree = 0, spotFree = 0, source = 'perp', self = '' }) {
  const amt   = Number(amount)
  const free  = source === 'perp' ? perpFree : spotFree
  const other = source === 'perp' ? spotFree : perpFree
  const valid = /^0x[0-9a-fA-F]{40}$/.test(dest)
  const isSelf = valid && !!self && dest.toLowerCase() === self.toLowerCase()

  if (!connected)  return { ok: false, label: 'connect',  msg: '',           danger: false }
  if (!dest)       return { ok: false, label: 'nodest',   msg: '',           danger: false }
  if (!valid)      return { ok: false, label: 'baddest',  msg: 'badformat',  danger: true }
  if (isSelf)      return { ok: false, label: 'selfdest', msg: 'self',       danger: true }
  if (!(amt > 0))  return { ok: false, label: 'noamt',    msg: '',           danger: false }
  if (amt > free)  return { ok: false, label: 'nofunds',  msg: other >= amt ? 'switch' : 'short', danger: true }
  return { ok: true, label: 'send', msg: 'irreversible', danger: false }
}
