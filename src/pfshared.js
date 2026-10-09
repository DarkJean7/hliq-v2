/**
 * Featured portfolios on /portfolios: the ones everyone sees, published by the developer.
 *
 * Stored by serve-prod.js in data/portfolios.json (GET /portfolios-data, public; writes need
 * the dev PIN, checked by the strategy server's /api/leaderboard/verify-pin). A visitor can
 * open one, change anything and test it — the page never writes back; "Save a copy" keeps
 * their version on their own device, like any portfolio they build.
 *
 * Everything that reaches the file goes through cleanPortfolio, on the server, so a request
 * with the right PIN still cannot store markup, a megabyte of text or a thousand holdings.
 * Pure: imported by the server and by tests/suites/pfbacktest.test.mjs.
 */
export const PF_FEATURED_MAX = 60
export const PF_ITEMS_MAX = 30
const COIN = /^[A-Za-z0-9:@._/-]{1,40}$/
const ID = /^[a-z0-9]{6,24}$/

const text = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)

/** A portfolio as stored, or null when it is not one. `id` is kept only when well-formed. */
export function cleanPortfolio(p) {
  if (!p || typeof p !== 'object') return null
  const name = text(p.name, 40)
  if (!name) return null
  const items = []
  for (const i of Array.isArray(p.items) ? p.items : []) {
    if (!i || !COIN.test(String(i.coin ?? ''))) continue
    const w = Number(i.w)
    if (!(Number.isFinite(w) && w > 0 && w <= 1e6)) continue
    if (items.some(x => x.coin === i.coin)) continue
    items.push({
      coin: String(i.coin), sym: text(i.sym || String(i.coin).replace(/^.*:/, ''), 40),
      kind: ['perp', 'hip3', 'spot'].includes(i.kind) ? i.kind : String(i.coin).includes(':') ? 'hip3' : String(i.coin).startsWith('@') ? 'spot' : 'perp',
      w: +w.toFixed(4), side: i.side === 'short' ? 'short' : 'long',
    })
    if (items.length >= PF_ITEMS_MAX) break
  }
  if (!items.length) return null
  return { id: ID.test(String(p.id ?? '')) ? String(p.id) : null, name, desc: text(p.desc, 280), items }
}

export const newId = () => (Date.now().toString(36) + Math.random().toString(36).slice(2, 8)).slice(0, 16)

/** Insert or replace by id (a new one gets an id and goes first). → the new list, or null when full. */
export function upsertFeatured(list, p, now = Date.now()) {
  const cur = Array.isArray(list) ? list : []
  const k = p.id ? cur.findIndex(x => x.id === p.id) : -1
  if (k >= 0) return cur.map((x, j) => j === k ? { ...p, at: x.at ?? now, updated: now } : x)
  if (cur.length >= PF_FEATURED_MAX) return null
  return [{ ...p, id: p.id || newId(), at: now, updated: now }, ...cur]
}
