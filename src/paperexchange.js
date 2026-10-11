/**
 * A paper account as Hyperliquid, for a bot.
 *
 * strategies/portfolio.js --paper <slot> runs the EXACT bot that trades live — the point of a
 * paper run is to test that code, not a copy — against a paper account. This installs a fetch
 * in front of the bot's SDK:
 *
 *   market data (prices, candles, metadata)           → Hyperliquid, untouched
 *   the account (clearinghouseState, userFillsByTime) → the paper account
 *   orders, cancels, leverage (/exchange)             → src/paper.js on the paper account
 *
 * The account is the owner's on the server (src/paperhost.js, the same files the app syncs
 * with), so its positions show in the app under that paper account, and the server's paper
 * tick fills its stops and targets like anyone else's. Fills cost what a person's do: paper.js
 * charges them, not this file.
 *
 * Signatures are not checked — there is no exchange to check them — so the bot runs with a
 * throwaway key and the owner's secret never reaches the SDK.
 */
import { createPaperHost } from './paperhost.js'

const HL = /^https:\/\/api(\.hyperliquid|-ui\.hyperliquid)[a-z.-]*\//i

export function installPaperExchange({ secret, slot, dir, log = () => {} }) {
  const host = createPaperHost({ dir })
  const real = globalThis.fetch
  const post = async (body) => {
    const r = await real('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    return r.json()
  }
  // Asset ids → coins, as the exchange numbers them (HIP-3: 100000 + dex×10000 + index).
  let byId = null, assets = {}
  async function ids(dexes) {
    if (byId && dexes.every(d => byId.dexes.includes(d))) return byId
    const map = {}, meta0 = await post({ type: 'meta' })
    ;(meta0.universe ?? []).forEach((u, i) => { map[i] = u.name; assets[u.name] = { szDecimals: u.szDecimals, maxLeverage: u.maxLeverage } })
    const all = [...new Set([...(byId?.dexes ?? []), ...dexes])]
    if (all.length) {
      const list = await post({ type: 'perpDexs' })
      for (const d of all) {
        const di = (list ?? []).findIndex(x => x && x.name === d)
        if (di < 1) continue
        const m = await post({ type: 'meta', dex: d })
        ;(m.universe ?? []).forEach((u, i) => { const n = u.name.includes(':') ? u.name : `${d}:${u.name}`; map[100000 + di * 10000 + i] = n; assets[n] = { szDecimals: u.szDecimals, maxLeverage: u.maxLeverage } })
      }
    }
    byId = { map, dexes: all }
    return byId
  }
  // An asset id's coin, loading its builder dex's markets the first time one is traded.
  async function coinOf(id) {
    let m = (await ids([])).map
    if (m[id]) return m[id]
    if (id >= 100000) {
      const list = await post({ type: 'perpDexs' })
      const d = list?.[Math.floor((id - 100000) / 10000)]?.name
      if (d) m = (await ids([d])).map
    }
    return m[id] ?? null
  }
  let marks = {}, marksAt = 0
  async function market(coins) {
    const dexes = [...new Set(coins.filter(c => c.includes(':')).map(c => c.split(':')[0]))]
    if (Date.now() - marksAt > 2000 || coins.some(c => !(c in marks))) {
      const m = { ...(await post({ type: 'allMids' })) }
      for (const d of dexes) { try { Object.assign(m, await post({ type: 'allMids', dex: d })) } catch {} }
      marks = m; marksAt = Date.now()
    }
    return { marks, assets, funding: {} }
  }
  const ok = (j) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } })

  globalThis.fetch = async (url, init) => {
    const u = String(url?.url ?? url)
    if (!HL.test(u)) return real(url, init)
    let b = {}
    try { b = JSON.parse(init?.body ?? '{}') } catch {}
    if (u.endsWith('/exchange')) {
      const a = b.action ?? {}
      if (a.type === 'updateLeverage') {
        const coin = await coinOf(a.asset)
        if (!coin) return ok({ status: 'err', response: 'unknown asset' })
        host.withStore(secret, slot, null, (P) => P.paperSetLeverage(coin, a.leverage))
        return ok({ status: 'ok', response: { type: 'default' } })
      }
      if (a.type === 'cancel') {
        const statuses = host.withStore(secret, slot, null, (P) => (a.cancels ?? []).map(c => P.paperCancel(c.o)?.response?.data?.statuses?.[0] ?? 'success'))
        return ok({ status: 'ok', response: { type: 'cancel', data: { statuses } } })
      }
      if (a.type === 'order') {
        const m = {}
        for (const o of a.orders) m[o.a] = await coinOf(o.a)
        const coins = Object.values(m).filter(Boolean)
        const mk = await market(coins)
        const statuses = host.withStore(secret, slot, mk, (P) => a.orders.map(o => {
          const coin = m[o.a]
          if (!coin) return { error: 'unknown asset' }
          const before = P.paperStore().orders.length
          const r = P.paperOrder({ orders: [o] }, coin, {})
          const st = r?.response?.data?.statuses?.[0]
          // A paper trigger answers "waitingForTrigger"; Hyperliquid answers with its order id,
          // which a bot needs to cancel it later.
          if (st === 'waitingForTrigger') { const s = P.paperStore(); return { resting: { oid: s.orders.length > before ? s.orders[s.orders.length - 1].oid : null } } }
          return st ?? { error: 'no answer' }
        }))
        for (const s of statuses) if (s?.error) log(`[paper] order refused: ${s.error}`)
        return ok({ status: 'ok', response: { type: 'order', data: { statuses } } })
      }
      return ok({ status: 'ok', response: { type: 'default' } })
    }
    // The account's reads; everything else is market data, from Hyperliquid.
    if (b.type === 'clearinghouseState') {
      const st = host.withStore(secret, slot, await market(heldCoins()), (P) => P.paperPerpState())
      // A builder dex's state holds only that dex's markets, as Hyperliquid answers it.
      if (b.dex) st.assetPositions = st.assetPositions.filter(p => p.position.coin.startsWith(b.dex + ':'))
      else st.assetPositions = st.assetPositions.filter(p => !p.position.coin.includes(':'))
      return ok(st)
    }
    if (b.type === 'userFillsByTime' || b.type === 'userFills') {
      const fills = host.withStore(secret, slot, null, (P) => P.paperFills())
      return ok(fills.filter(f => f.time >= (b.startTime ?? 0)))
    }
    return real(url, init)
  }
  function heldCoins() {
    try { return host.withStore(secret, slot, null, (P) => P.paperStore().positions.map(p => p.coin)) } catch { return [] }
  }
  return host
}
