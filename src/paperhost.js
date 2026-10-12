/**
 * Paper accounts on the server, so they keep trading while the app is closed.
 *
 * A paper account used to live only in the browser's localStorage: close the app and nothing
 * anywhere could fill its resting orders, trigger its stops, charge its funding or liquidate
 * it. Now every paper key is also kept here, per OWNER — a random secret the app made for
 * this device (src/papersync.js); the server never knows who the owner is, only that the
 * same secret came back.
 *
 * ONE WRITER PER STORE. Each paper account is one store (one localStorage key). The app runs
 * the account you are looking at, exactly as it always has, and holds that store's LEASE while
 * it does; the server advances every other store — the ones you are not looking at, and all of
 * them once the app is closed (the lease lapses after LEASE_MS without a sync). Nothing is ever
 * advanced by both.
 *
 * SYNC is per key, compare-and-set: each key carries the revision it was last written at, and
 * the app sends the revision it last saw. A write lands only if the app had seen the server's
 * latest; otherwise the server's version wins and is sent back (it moved while the app was
 * offline — its fills are the real ones). The first sync from a device uploads everything it
 * has, which is how existing accounts arrive. The browser's own copy is never deleted.
 *
 * The engine is src/paper.js itself — the same code the app runs — pointed at the owner's keys
 * through a localStorage stand-in. It is synchronous, so one owner at a time is safe.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import * as P from './paper.js'

import { PAPER_KEY_RE, slotOfKey } from './paperkeys.js'
export { PAPER_KEY_RE, slotOfKey }
export const LEASE_MS = 90_000
const OPS = new Set(['paperOrder', 'paperCancel', 'paperSetLeverage', 'paperAdjustMargin', 'paperDeposit', 'paperWithdraw'])                 // the app syncs every few seconds; this is a closed tab
export const MAX_VALUE = 1_500_000             // one key (a store holds ≤400 fills, ≤2,000 equity points)
export const MAX_OWNER = 8_000_000             // every key of one owner together

/** An owner's id from its secret: 64 hex characters in, a hash out. Null for anything else. */
export function ownerOf(secret) {
  if (!/^[0-9a-f]{64}$/.test(String(secret ?? ''))) return null
  return createHash('sha256').update(String(secret)).digest('hex').slice(0, 40)
}

// HIP-3 tickers the app renames, mirrored in the marks so a renamed position is priced
// (src/api.js HIP3_RENAMES; the suite checks the two agree).
export const HIP3_RENAMES = { 'xyz:CL': 'WTIOIL' }

function sleepSync(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } catch {} }

export function createPaperHost({ dir, now = () => Date.now(), log = () => {} }) {
  fs.mkdirSync(dir, { recursive: true })
  const file = (o) => path.join(dir, o + '.json')
  const read = (o) => { try { return JSON.parse(fs.readFileSync(file(o), 'utf8')) } catch { return null } }
  const write = (o, rec) => {
    const tmp = `${file(o)}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(rec))
    fs.renameSync(tmp, file(o))
  }
  // Two web workers can sync the same owner at once, and the ticking worker writes too: one
  // writer per owner at a time, by an exclusive lock directory (stale after 10 s).
  function locked(o, fn) {
    const lk = file(o) + '.lock'
    for (let i = 0; ; i++) {
      try { fs.mkdirSync(lk); break } catch {
        try { if (now() - fs.statSync(lk).mtimeMs > 10_000) { fs.rmSync(lk, { recursive: true, force: true }); continue } } catch {}
        if (i > 200) throw new Error('busy')
        sleepSync(10)
      }
    }
    try { return fn() } finally { try { fs.rmSync(lk, { recursive: true, force: true }) } catch {} }
  }
  const leased = (rec, key) => !!(rec.lease && rec.lease.key === key && rec.lease.until > now())

  /**
   * One round trip from the app.
   *   secret, client: who; hold: the store key the app is running now (or null)
   *   release: hand the lease back now (the app left paper, or closed). Holding nothing is NOT
   *   a release: another tab of the same device — /portfolios — syncs holding nothing while the
   *   app runs an account, and reading that as a release would set the server running it too.
   *   seen: { key: revision the app last had }; push: { key: value | null (deleted) }
   * → { ok, revs: { key: rev }, changed: { key: value | null }, conflicts: [key], lease }
   */
  function sync({ secret, client, hold = null, release = false, seen = {}, push = {} }) {
    const o = ownerOf(secret)
    if (!o) return { ok: false, error: 'bad owner' }
    if (!/^[a-z0-9]{8,40}$/i.test(String(client ?? ''))) return { ok: false, error: 'bad client' }
    if (hold != null && slotOfKey(hold) == null) return { ok: false, error: 'bad hold' }
    return locked(o, () => {
      const rec = read(o) ?? { kv: {}, rev: 0, created: now() }
      const fresh = !rec.rev
      const conflicts = []
      for (const [k, v] of Object.entries(push ?? {})) {
        if (!PAPER_KEY_RE.test(k)) continue
        if (v != null && (typeof v !== 'string' || v.length > MAX_VALUE)) continue
        const cur = rec.kv[k]
        // Compare-and-set: the app must have seen the latest. The very first sync of an owner
        // is the upload of what the device already had, and is taken whole.
        if (!fresh && cur && cur.rev > (Number(seen?.[k]) || 0)) { conflicts.push(k); continue }
        if (cur && cur.v === v) continue
        rec.kv[k] = { v: v ?? null, rev: ++rec.rev }
      }
      const size = Object.values(rec.kv).reduce((a, x) => a + (x.v?.length ?? 0), 0)
      if (size > MAX_OWNER) return { ok: false, error: 'too large' }
      // The lease: the store the app is running, until it says it is done with it.
      if (hold) rec.lease = { key: hold, client, until: now() + LEASE_MS }
      else if (release && rec.lease?.client === client) rec.lease = null
      rec.at = now()
      write(o, rec)
      const changed = {}
      for (const [k, x] of Object.entries(rec.kv)) if (x.rev > (Number(seen?.[k]) || 0) && !(k in (push ?? {}) && !conflicts.includes(k))) changed[k] = x.v
      return { ok: true, revs: Object.fromEntries(Object.entries(rec.kv).map(([k, x]) => [k, x.rev])), changed, conflicts, lease: rec.lease?.key ?? null }
    })
  }

  /**
   * Advance every store the app is not holding: resting orders, stops and targets, funding,
   * liquidation, the equity curve — paperTick, with the server's marks.
   *   market: { marks, assets, funding } as the app feeds them
   * → { owners, stores, events: [{ owner, slot, events }] }
   */
  function tick(market) {
    const out = { owners: 0, stores: 0, events: [] }
    let names = []
    try { names = fs.readdirSync(dir).filter(f => /^[0-9a-f]{40}\.json$/.test(f)) } catch { return out }
    P.setPaperMarks(market.marks); P.setPaperAssets(market.assets); P.setPaperFundingRates(market.funding)
    for (const f of names) {
      const o = f.slice(0, 40)
      // Cheap look first: only an owner with something to advance is locked and worked.
      const peek = read(o)
      if (!peek) continue
      const due = Object.entries(peek.kv).filter(([k, x]) => slotOfKey(k) && x.v && !leased(peek, k) && /"(positions|orders)":\[\{/.test(x.v))
      if (!due.length) continue
      out.owners++
      try {
        locked(o, () => {
          const rec = read(o)
          if (!rec) return
          const shim = {
            getItem: (k) => rec.kv[k]?.v ?? null,
            setItem: (k, v) => { if (rec.kv[k]?.v !== String(v)) rec.kv[k] = { v: String(v), rev: ++rec.rev } },
            removeItem: (k) => { if (rec.kv[k]) rec.kv[k] = { v: null, rev: ++rec.rev } },
          }
          const prev = globalThis.localStorage
          globalThis.localStorage = shim
          try {
            P.setPaperTickGate(null)
            for (const [k] of due) {
              if (leased(rec, k)) continue                  // the app took it since the look
              const slot = slotOfKey(k)
              P.paperBind(slot)
              const ev = P.paperTick()
              out.stores++
              if (ev.length) out.events.push({ owner: o, slot, events: ev })
            }
          } finally { P.paperBind('main'); globalThis.localStorage = prev }
          write(o, rec)
        })
      } catch (e) { log(`[paper] ${o}: ${e.message}`) }
    }
    return out
  }

  /** Every coin a store the server would advance holds or has an order on: what to price. */
  function dueCoins() {
    const coins = new Set()
    let names = []
    try { names = fs.readdirSync(dir).filter(f => /^[0-9a-f]{40}\.json$/.test(f)) } catch { return coins }
    for (const f of names) {
      const rec = read(f.slice(0, 40))
      for (const [k, x] of Object.entries(rec?.kv ?? {})) {
        if (!slotOfKey(k) || !x.v || leased(rec, k) || !/"(positions|orders)":\[\{/.test(x.v)) continue
        try { const st = JSON.parse(x.v); for (const p of st.positions ?? []) coins.add(p.coin); for (const q of st.orders ?? []) coins.add(q.coin) } catch {}
      }
    }
    return coins
  }

  /**
   * Run `fn(P)` against one owner's account, under the owner's lock, with src/paper.js pointed at
   * that store and fed `market`. What a paper portfolio bot trades through (src/paperexchange.js):
   * the same engine, so its fills cost what a person's do. Saved if it changed; fn's answer back.
   */
  function withStore(secret, slot, market, fn) {
    const o = ownerOf(secret)
    if (!o) throw new Error('bad owner')
    return locked(o, () => {
      const rec = read(o) ?? { kv: {}, rev: 0, created: now() }
      const shim = {
        getItem: (k) => rec.kv[k]?.v ?? null,
        setItem: (k, v) => { if (rec.kv[k]?.v !== String(v)) rec.kv[k] = { v: String(v), rev: ++rec.rev } },
        removeItem: (k) => { if (rec.kv[k]) rec.kv[k] = { v: null, rev: ++rec.rev } },
      }
      const prev = globalThis.localStorage
      globalThis.localStorage = shim
      try {
        if (market) { P.setPaperMarks(market.marks); P.setPaperAssets(market.assets); P.setPaperFundingRates(market.funding ?? {}) }
        P.setPaperTickGate(null)
        P.setPaperRemote(null)
        P.paperBind(slot)
        P.setPaperPendingLev(rec.plev?.[slot] ?? {})
        const out = fn(P)
        rec.plev = { ...(rec.plev ?? {}), [slot]: P.getPaperPendingLev() }
        write(o, rec)
        return out
      } finally { P.paperBind('main'); globalThis.localStorage = prev }
    })
  }

  /**
   * A person's own action on an account a server bot is running (src/paper.js setPaperRemote).
   * Only these, with their own arguments: the same calls the app made, applied by the same code.
   */
  function op(secret, slot, fn, args, market) {
    if (!OPS.has(fn) || !Array.isArray(args)) return { ok: false, error: 'not an action' }
    if (slotOfKey(slot === 'main' ? 'hliq_paper_v2' : slot === 'challenge' ? 'hliq_paper_chal_v2' : 'hliq_paper_s_' + slot) == null) return { ok: false, error: 'bad account' }
    return { ok: true, result: withStore(secret, slot, market, (P) => P[fn](...args)) }
  }

  return { sync, tick, dueCoins, withStore, op, read, ownerFile: file }
}

/**
 * What the app feeds paperTick, fetched the way it fetches it, for the coins that need it: the
 * mids (main and spot in one call; a HIP-3 dex only when one of its markets is held), and —
 * kept for ten minutes, as the app keeps them — each market's limits and hourly funding rate.
 * This box shares Hyperliquid's per-IP budget with the live bots, so nothing is asked for
 * that no paper account is holding.
 *   post: (body) => Hyperliquid /info answer; coins: Set; prev: the last market (its limits reused)
 */
const ORIGINAL = Object.fromEntries(Object.entries(HIP3_RENAMES).map(([k, v]) => [v, k]))
export async function loadMarket(post, coins, prev = null) {
  const want = [...coins].map(c => ORIGINAL[c] ?? c)
  const dexes = [...new Set(want.filter(c => c.includes(':')).map(c => c.split(':')[0]))]
  const marks = { ...(await post({ type: 'allMids' })) }
  for (const d of dexes) {
    try { Object.assign(marks, await post({ type: 'allMids', dex: d })) } catch { /* unpriced: skipped, not zeroed */ }
  }
  for (const [from, to] of Object.entries(HIP3_RENAMES)) if (from in marks) marks[to] = marks[from]
  let assets = prev?.assets ?? {}, funding = prev?.funding ?? {}, metaAt = prev?.metaAt ?? 0
  const missing = dexes.filter(d => !(prev?.metaDexes ?? []).includes(d))
  if (Date.now() - metaAt > 600_000 || missing.length) {
    assets = {}; funding = {}
    const addMeta = (mc) => (mc?.[0]?.universe ?? []).forEach((u, i) => {
      assets[u.name] = { index: i, szDecimals: u.szDecimals ?? 6, maxLeverage: u.maxLeverage ?? 50 }
      const f = parseFloat(mc?.[1]?.[i]?.funding)
      if (Number.isFinite(f)) funding[u.name] = f
    })
    addMeta(await post({ type: 'metaAndAssetCtxs' }))
    for (const d of dexes) { try { addMeta(await post({ type: 'metaAndAssetCtxs', dex: d })) } catch {} }
    for (const [from, to] of Object.entries(HIP3_RENAMES)) { if (assets[from]) assets[to] = assets[from]; if (from in funding) funding[to] = funding[from] }
    metaAt = Date.now()
    return { marks, assets, funding, metaAt, metaDexes: dexes }
  }
  return { marks, assets, funding, metaAt, metaDexes: prev?.metaDexes ?? [] }
}
