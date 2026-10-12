/**
 * A paper account as Hyperliquid, for a bot.
 *
 * Any bot run with --paper <slot> (strategies/_paperpreload.js; strategies/portfolio.js installs
 * it itself) is the EXACT bot that trades live — the point of a paper run is to test that code,
 * not a copy — trading a paper account. This installs a fetch in front of its SDK:
 *
 *   market data (prices, candles, metadata), and any OTHER
 *   account's reads (the trader a copy bot follows)       → Hyperliquid, untouched
 *   the paper account's own reads (positions, orders,
 *   fills, order status, spot, per-coin leverage)         → the paper account
 *   orders, cancels, leverage, isolated margin (/exchange) → src/paper.js on the paper account
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

/**
 *   secret, slot: the paper owner and account; dir: the server's paper data
 *   addr: the bot's account address (0x + the owner's hash). Reads for that user are the paper
 *         account's; reads for anyone else go to Hyperliquid. Without it, every account read is.
 */
export function installPaperExchange({ secret, slot, dir, addr = null, log = () => {} }) {
  if (globalThis.__paperExchange) return globalThis.__paperExchange
  const host = createPaperHost({ dir })
  const real = globalThis.fetch
  const mine = (b) => !addr || String(b.user ?? '').toLowerCase() === String(addr).toLowerCase()
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
  // Spot: asset id 10000 + pair index; a pair's balance is held under its base token's name.
  let spot = null
  async function spotMeta() {
    if (spot) return spot
    const sm = await post({ type: 'spotMeta' })
    const tok = Object.fromEntries((sm.tokens ?? []).map(t => [t.index, t]))
    const byId = {}, tokenOf = {}
    for (const u of sm.universe ?? []) {
      const base = tok[u.tokens?.[0]]
      if (!base) continue
      byId[10000 + u.index] = u.name; tokenOf[u.name] = base.name
      assets[u.name] = { szDecimals: base.szDecimals, maxLeverage: 1 }
    }
    spot = { byId, tokenOf, isSpot: (c) => c in tokenOf }
    return spot
  }
  // An asset id's coin, loading its builder dex's markets the first time one is traded.
  async function coinOf(id) {
    if (id >= 10000 && id < 100000) return (await spotMeta()).byId[id] ?? null
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
      if (a.type === 'updateIsolatedMargin') {
        const coin = await coinOf(a.asset)
        const usd = Math.abs(Number(a.ntli) || 0) / 1e6
        const r = coin ? host.withStore(secret, slot, await market([coin]), (P) => P.paperAdjustMargin(coin, usd, Number(a.ntli) > 0)) : { ok: false, error: 'unknown asset' }
        return ok(r.ok ? { status: 'ok', response: { type: 'default' } } : { status: 'err', response: r.error })
      }
      // Paper keeps one pool of cash for perps and spot: moving USDC between them is nothing.
      if (a.type === 'usdClassTransfer') return ok({ status: 'ok', response: { type: 'default' } })
      if (a.type === 'cancel') {
        const statuses = host.withStore(secret, slot, null, (P) => (a.cancels ?? []).map(c => P.paperCancel(c.o)?.response?.data?.statuses?.[0] ?? 'success'))
        return ok({ status: 'ok', response: { type: 'cancel', data: { statuses } } })
      }
      if (a.type === 'order') {
        const m = {}
        for (const o of a.orders) m[o.a] = await coinOf(o.a)
        const coins = Object.values(m).filter(Boolean)
        const mk = await market(coins)
        const sp = coins.some(c => c.startsWith('@') || c.includes('/')) ? await spotMeta() : null
        const statuses = host.withStore(secret, slot, mk, (P) => a.orders.map(o => {
          const coin = m[o.a]
          if (!coin) return { error: 'unknown asset' }
          const before = P.paperStore().orders.length
          // Spot settles as a balance, paid in full — paper.js's spot path, at its spot fee.
          const r = P.paperOrder({ orders: [o] }, coin, sp?.isSpot(coin) ? { isSpot: true } : {})
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
    if (!mine(b)) return real(url, init)
    if (b.type === 'clearinghouseState') {
      const st = host.withStore(secret, slot, await market(heldCoins()), (P) => P.paperPerpState())
      // A builder dex's state holds only that dex's markets, as Hyperliquid answers it.
      if (b.dex) st.assetPositions = st.assetPositions.filter(p => p.position.coin.startsWith(b.dex + ':'))
      else st.assetPositions = st.assetPositions.filter(p => !p.position.coin.includes(':'))
      return ok(st)
    }
    // Spot balances as Hyperliquid names them (by token), and the account's USDC: paper keeps one
    // pool of cash, so what is free there is what spot can spend.
    if (b.type === 'spotClearinghouseState') {
      const sp = await spotMeta()
      const out = host.withStore(secret, slot, null, (P) => ({ bal: P.paperSpotState().balances, free: P.paperWithdrawable() }))
      const balances = out.bal.map(x => ({ ...x, coin: sp.tokenOf[x.coin] ?? x.coin }))
      balances.push({ coin: 'USDC', token: 0, total: String(out.free), hold: '0', entryNtl: '0' })
      return ok({ balances })
    }
    if (b.type === 'userFillsByTime' || b.type === 'userFills') {
      const fills = host.withStore(secret, slot, null, (P) => P.paperFills())
      return ok(fills.filter(f => f.time >= (b.startTime ?? 0) && f.time <= (b.endTime ?? Infinity)))
    }
    // Resting orders, as Hyperliquid lists them (a builder dex lists only its own).
    if (b.type === 'openOrders' || b.type === 'frontendOpenOrders') {
      const oo = host.withStore(secret, slot, null, (P) => P.paperOpenOrders())
      return ok(oo.filter(o => (b.dex ? String(o.coin).startsWith(b.dex + ':') : !String(o.coin).includes(':'))))
    }
    // One order's state: resting, filled (its oid is on a fill), or not known.
    if (b.type === 'orderStatus') {
      const oid = Number(b.oid)
      const r = host.withStore(secret, slot, null, (P) => ({ open: P.paperOpenOrders().find(o => o.oid === oid), fill: P.paperFills().find(f => Number(f.oid) === oid) }))
      if (r.open) return ok({ status: 'order', order: { order: r.open, status: 'open', statusTimestamp: r.open.timestamp } })
      if (r.fill) return ok({ status: 'order', order: { order: { coin: r.fill.coin, oid, side: r.fill.side, limitPx: r.fill.px, sz: '0', origSz: r.fill.sz, timestamp: r.fill.time }, status: 'filled', statusTimestamp: r.fill.time } })
      return ok({ status: 'unknownOid' })
    }
    // A coin's leverage and what the account can trade there (guards and grids read it).
    if (b.type === 'activeAssetData') {
      const mk = await market([b.coin])
      const px = Number(mk.marks[b.coin]) || 0
      const r = host.withStore(secret, slot, mk, (P) => {
        const p = P.paperStore().positions.find(x => x.coin === b.coin)
        return { lev: p?.leverage ?? 5, iso: !!p?.isIsolated, free: P.paperWithdrawable() }
      })
      const can = px > 0 ? String(r.free * r.lev / px) : '0'
      return ok({ user: b.user, coin: b.coin, leverage: { type: r.iso ? 'isolated' : 'cross', value: r.lev }, maxTradeSzs: [can, can], availableToTrade: [can, can], markPx: String(px) })
    }
    return real(url, init)
  }
  globalThis.__paperExchange = host
  function heldCoins() {
    try { return host.withStore(secret, slot, null, (P) => [...P.paperStore().positions.map(p => p.coin), ...Object.keys(P.paperStore().balances ?? {})]) } catch { return [] }
  }
  return host
}
