// /markets — every Hyperliquid asset, ranked. Rows come from src/marketsdata.js; this file
// fetches, renders and handles the controls. Imports nothing from the app.
import './landing.css'
import './markets.css'
import { buildMarkets, sortRows, filterRows, summarize } from './marketsdata.js'

const API = 'https://api.hyperliquid.xyz/info'
const PAGE = 100
const REFRESH_MS = 90_000

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let rows = []
let view = { kind: 'all', dex: null, q: '', sort: 'vol24', asc: false, shown: PAGE }
let loadedAt = 0
let dexInfo = { ok: 0, total: 0 }
// Each HIP-3 dex's last answer, kept across refreshes: rebuilding without them and adding them
// back one by one would make the table and the totals jump every 90 seconds.
const hip3Cache = new Map()

// ── formatting ───────────────────────────────────────────────────────────────
const money = (n) => {
  if (n == null) return '—'
  const a = Math.abs(n)
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T'
  if (a >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M'
  if (a >= 1e3)  return '$' + (n / 1e3).toFixed(1) + 'K'
  return '$' + n.toFixed(0)
}
const price = (p) => p == null ? '—'
  : p >= 1000 ? '$' + p.toLocaleString('en-US', { maximumFractionDigits: 2 })
  : p >= 1 ? '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
  : '$' + p.toPrecision(4)
const chg = (c) => c == null ? '<span class="mk-dim">—</span>'
  : `<span class="${c >= 0 ? 'mk-up' : 'mk-dn'}">${c >= 0 ? '+' : ''}${c.toFixed(2)}%</span>`
const fund = (f) => f == null ? '<span class="mk-dim">—</span>'
  : `<span class="${f >= 0 ? 'mk-up' : 'mk-dn'}">${f >= 0 ? '+' : ''}${f.toFixed(4)}%</span>`

// Icons come from the app's first-party cache, READ-ONLY (ro=1): this page never decides a
// coin's artwork, so it cannot cache a worse logo, or a miss, over the one the app chose.
// v must match the app's _ICON_V or the server treats the entry as stale.
const ICON_V = '5'
const iconHtml = (r) => {
  const letter = esc((r.sym || '?').slice(0, 1))
  return `<span class="mk-ico" data-l="${letter}"><img src="/icon/${encodeURIComponent(r.coin)}?v=${ICON_V}&ro=1" alt="" loading="lazy" onload="this.naturalWidth>1||this.remove()" onerror="this.remove()"></span>`
}

// ── data ─────────────────────────────────────────────────────────────────────
const post = (body) => fetch(API, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  signal: AbortSignal.timeout(10_000),
}).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

/**
 * Core perps and spot first (two calls), so the table is up in under a second; then the
 * HIP-3 dexes one at a time, a beat apart. The rate limit is a bucket, and the PEAK empties
 * it (CLAUDE.md): ten weight-20 calls fired together would spend 200 of the visitor's own
 * budget at once, for no benefit over a second's patience.
 */
async function load() {
  const [core, spot, dexes] = await Promise.all([
    post({ type: 'metaAndAssetCtxs' }).catch(() => null),
    post({ type: 'spotMetaAndAssetCtxs' }).catch(() => null),
    post({ type: 'perpDexs' }).catch(() => null),
  ])
  if (!core && !spot) throw new Error('Hyperliquid did not answer')
  const list = (Array.isArray(dexes) ? dexes : []).filter(d => d?.name)
  const hip3 = () => list.map(d => hip3Cache.get(d.name)).filter(Boolean)
  rows = buildMarkets({ core, spot, hip3: hip3() })
  dexInfo = { ok: 0, total: list.length }
  loadedAt = Date.now()
  render()
  for (const d of list) {
    await sleep(220)
    try {
      hip3Cache.set(d.name, { dex: d.name, label: d.fullName || d.name, data: await post({ type: 'metaAndAssetCtxs', dex: d.name }) })
      dexInfo.ok++
    } catch { /* counted as missing; the status line says so */ }
    rows = buildMarkets({ core, spot, hip3: hip3() })
    render()
  }
  loadedAt = Date.now()
  render()
}

// ── render ───────────────────────────────────────────────────────────────────
function card(label, value, sub = '', cls = '') {
  return `<div class="mk-card"><div class="mk-card__lbl">${label}</div><div class="mk-card__val ${cls}">${value}</div><div class="mk-card__sub">${sub}</div></div>`
}

function renderCards(list) {
  const s = summarize(list)
  const partial = view.kind !== 'perp' && view.kind !== 'spot' && dexInfo.ok < dexInfo.total
  const floor = partial ? ' <span class="mk-dim" title="Not every HIP-3 dex has answered yet">+</span>' : ''
  const mover = (r) => r ? `${esc(r.sym)} ${chg(r.chg24)}` : '—'
  $('mkCards').innerHTML = [
    card('Volume 24h', money(s.vol) + floor, `${s.volN} markets`),
    card('Open interest', s.oiN ? money(s.oi) + floor : '—', s.oiN ? `${s.oiN} perp markets` : 'spot has none'),
    card('Markets', String(s.count), `${list.filter(r => r.kind === 'perp').length} perps · ${list.filter(r => r.kind === 'hip3').length} HIP-3 · ${list.filter(r => r.kind === 'spot').length} spot`),
    card('Top gainer 24h', mover(s.gainer), s.gainer ? money(s.gainer.vol24) + ' volume' : 'min. $100K volume'),
    card('Top loser 24h', mover(s.loser), s.loser ? money(s.loser.vol24) + ' volume' : 'min. $100K volume'),
  ].join('')
}

function renderTabs() {
  for (const b of $('mkTabs').querySelectorAll('button')) {
    const k = b.dataset.kind
    b.classList.toggle('is-on', k === view.kind)
    b.querySelector('i').textContent = k === 'all' ? rows.length : rows.filter(r => r.kind === k).length
  }
  for (const b of $('mkRank').querySelectorAll('button')) b.classList.toggle('is-on', b.dataset.sort === view.sort)
  // HIP-3 dex chips, by volume, only on the HIP-3 tab
  const dx = $('mkDexes')
  dx.hidden = view.kind !== 'hip3'
  if (!dx.hidden) {
    const by = new Map()
    for (const r of rows) if (r.kind === 'hip3') by.set(r.dex, { label: r.dexLabel, vol: (by.get(r.dex)?.vol ?? 0) + (r.vol24 ?? 0) })
    const chips = [...by.entries()].sort((a, b) => b[1].vol - a[1].vol)
    dx.innerHTML = `<button data-dex="" class="${!view.dex ? 'is-on' : ''}">All dexes</button>` +
      chips.map(([d, v]) => `<button data-dex="${esc(d)}" class="${view.dex === d ? 'is-on' : ''}">${esc(v.label)} <i>${money(v.vol)}</i></button>`).join('')
  }
}

function renderTable(list) {
  const sorted = sortRows(list, view.sort, view.asc)
  const page = sorted.slice(0, view.shown)
  const badge = (r) => r.kind === 'hip3' ? `<em class="mk-b mk-b--hip3">${esc(r.dexLabel)}</em>`
    : r.kind === 'spot' ? `<em class="mk-b mk-b--spot">Spot${r.wrapped ? ' · ' + esc(r.wrapped) : ''}</em>`
    : `<em class="mk-b">Perp${r.maxLev ? ' · ' + r.maxLev + 'x' : ''}</em>`
  $('mkBody').innerHTML = page.length ? page.map((r, i) => `<tr>
      <td class="mk-c-rank">${i + 1}</td>
      <td class="mk-c-asset"><div class="mk-asset">${iconHtml(r)}<div><b>${esc(r.sym)}</b>${badge(r)}${r.name && r.name !== r.sym ? `<small>${esc(r.name)}</small>` : ''}</div></div></td>
      <td>${price(r.price)}</td>
      <td>${chg(r.chg24)}</td>
      <td>${money(r.vol24)}</td>
      <td>${r.oi == null ? '<span class="mk-dim">—</span>' : money(r.oi)}</td>
      <td>${r.mcap == null ? '<span class="mk-dim">—</span>' : money(r.mcap)}</td>
      <td>${fund(r.funding1h)}</td>
    </tr>`).join('')
    : `<tr><td colspan="8" class="mk-empty">${rows.length ? 'Nothing matches.' : 'Loading markets from Hyperliquid…'}</td></tr>`
  $('mkMore').hidden = sorted.length <= view.shown
  $('mkMore').textContent = `Show more (${sorted.length - view.shown} left)`
  for (const th of $('mkTable').querySelectorAll('th[data-sort]')) {
    const on = th.dataset.sort === view.sort
    th.classList.toggle('is-on', on)
    th.dataset.dir = on ? (view.asc ? '▴' : '▾') : ''
  }
}

function renderStatus() {
  const age = loadedAt ? Math.round((Date.now() - loadedAt) / 1000) : null
  const dex = dexInfo.total && dexInfo.ok < dexInfo.total ? ` · HIP-3 ${dexInfo.ok}/${dexInfo.total} dexes` : ''
  $('mkStatusText').textContent = age == null ? 'loading…' : `live · updated ${age < 5 ? 'just now' : age + 's ago'}${dex}`
}

function render() {
  const list = filterRows(rows, view)
  renderTabs()
  renderCards(list)
  renderTable(list)
  renderStatus()
}

// ── controls ─────────────────────────────────────────────────────────────────
$('mkTabs').addEventListener('click', e => {
  const b = e.target.closest('button[data-kind]'); if (!b) return
  view = { ...view, kind: b.dataset.kind, dex: null, shown: PAGE }
  render()
})
$('mkDexes').addEventListener('click', e => {
  const b = e.target.closest('button[data-dex]'); if (!b) return
  view = { ...view, dex: b.dataset.dex || null, shown: PAGE }
  render()
})
const setSort = (key) => {
  // Same column again flips direction; a new one starts from the top.
  view = key === view.sort ? { ...view, asc: !view.asc } : { ...view, sort: key, asc: false }
  view.shown = PAGE
  render()
}
$('mkRank').addEventListener('click', e => { const b = e.target.closest('button[data-sort]'); if (b) setSort(b.dataset.sort) })
$('mkTable').querySelector('thead').addEventListener('click', e => { const th = e.target.closest('th[data-sort]'); if (th) setSort(th.dataset.sort) })
let qt
$('mkSearch').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => { view = { ...view, q: e.target.value, shown: PAGE }; render() }, 120) })
$('mkMore').addEventListener('click', () => { view.shown += PAGE; render() })

// Nav (same behaviour as the landing)
const nav = $('lnNav'), burger = $('lnBurger')
burger?.addEventListener('click', () => burger.setAttribute('aria-expanded', String(nav.classList.toggle('is-open'))))
for (const a of document.querySelectorAll('[data-launch]')) {
  a.addEventListener('click', () => { try { localStorage.setItem('hliq_app_entered', '1') } catch {} })
}

// ── go ───────────────────────────────────────────────────────────────────────
render()
const run = () => load().catch(() => {
  $('mkStatusText').textContent = rows.length ? 'Hyperliquid did not answer — showing the last update' : 'Hyperliquid did not answer — retrying'
})
run()
setInterval(() => { if (!document.hidden) run() }, REFRESH_MS)
setInterval(() => { if (!document.hidden) renderStatus() }, 5_000)

