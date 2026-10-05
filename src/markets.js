// /markets — every Hyperliquid asset, ranked. Rows come from src/marketsdata.js, categories
// from src/sectors.js, revenue from /markets-meta (src/llama.js). This file fetches, renders
// and handles the controls. Imports nothing from the app.
import './landing.css'
import './markets.css'
import { buildMarkets, sortRows, filterRows, summarize, onePerToken } from './marketsdata.js'
import { SECTORS, SECTOR_LABEL } from './sectors.js'

const API = 'https://api.hyperliquid.xyz/info'
const PAGE = 100
const REFRESH_MS = 90_000
const META_REFRESH_MS = 30 * 60_000

const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let rows = []
// tab: all | perp | hip3 | spot | crypto | tradfi. Strict is on by default, like Hyperliquid's.
let view = { tab: 'all', dex: null, sector: null, q: '', sort: 'vol24', asc: false, shown: PAGE, strict: true, mode: 'market' }
let loadedAt = 0
let dexInfo = { ok: 0, total: 0 }
// Each HIP-3 dex's last answer, kept across refreshes: rebuilding without them and adding them
// back one by one would make the table and the totals jump every 90 seconds.
const hip3Cache = new Map()
let last = { core: null, spot: null, list: [] }
let cats = null        // perpCategories: [[coin, category], …]
let revenue = null     // /markets-meta bySym, or null while unknown
let revState = 'loading'

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
const dash = '<span class="mk-dim">—</span>'
const chg = (c) => c == null ? dash : `<span class="${c >= 0 ? 'mk-up' : 'mk-dn'}">${c >= 0 ? '+' : ''}${c.toFixed(2)}%</span>`
const fund = (f) => f == null ? dash : `<span class="${f >= 0 ? 'mk-up' : 'mk-dn'}">${f >= 0 ? '+' : ''}${f.toFixed(4)}%</span>`
const m = (n) => n == null ? dash : money(n)

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

const rebuild = () => {
  rows = buildMarkets({ core: last.core, spot: last.spot, hip3: last.list.map(d => hip3Cache.get(d.name)).filter(Boolean), cats, revenue })
}

/**
 * Core perps, spot and the category list first, so the table is up at once; then the HIP-3
 * dexes one at a time, a beat apart. The rate limit is a bucket, and the PEAK empties it
 * (CLAUDE.md): ten weight-20 calls fired together would spend 200 of the visitor's own
 * budget at once, for no benefit over a second's patience.
 */
async function load() {
  const [core, spot, dexes, pc] = await Promise.all([
    post({ type: 'metaAndAssetCtxs' }).catch(() => null),
    post({ type: 'spotMetaAndAssetCtxs' }).catch(() => null),
    post({ type: 'perpDexs' }).catch(() => null),
    cats ? Promise.resolve(cats) : post({ type: 'perpCategories' }).catch(() => null),
  ])
  if (!core && !spot) throw new Error('Hyperliquid did not answer')
  if (Array.isArray(pc)) cats = pc
  last = { core, spot, list: (Array.isArray(dexes) ? dexes : []).filter(d => d?.name) }
  dexInfo = { ok: 0, total: last.list.length }
  rebuild(); loadedAt = Date.now(); render()
  for (const d of last.list) {
    await sleep(220)
    try {
      hip3Cache.set(d.name, { dex: d.name, label: d.fullName || d.name, data: await post({ type: 'metaAndAssetCtxs', dex: d.name }) })
      dexInfo.ok++
    } catch { /* counted as missing; the status line says so */ }
    rebuild(); render()
  }
  loadedAt = Date.now()
  render()
}

/** Revenue from our server (DefiLlama, cached there). Never from Hyperliquid's budget. */
async function loadMeta() {
  try {
    const r = await fetch('/markets-meta', { signal: AbortSignal.timeout(60_000) })
    const j = r.ok ? await r.json() : null
    if (j?.revenue && typeof j.revenue === 'object') { revenue = j.revenue; revState = 'ok' }
    else if (!revenue) revState = 'down'
  } catch { if (!revenue) revState = 'down' }
  rebuild(); render()
}

// ── render ───────────────────────────────────────────────────────────────────
function current() {
  const kind = ['perp', 'hip3', 'spot'].includes(view.tab) ? view.tab : 'all'
  const group = view.tab === 'crypto' || view.tab === 'tradfi' ? view.tab : null
  let list = filterRows(rows, { kind, group, dex: view.dex, sector: view.sector, q: view.q, strict: view.strict })
  // Revenue view: tokens with revenue only — a table of dashes ranks nothing.
  // and one row per token, since revenue belongs to the token, not to each of its markets.
  if (view.mode === 'revenue') list = onePerToken(list.filter(r => r.rev30 != null || r.rev24 != null))
  return list
}

function card(label, value, sub = '', cls = '') {
  return `<div class="mk-card"><div class="mk-card__lbl">${label}</div><div class="mk-card__val ${cls}">${value}</div><div class="mk-card__sub">${sub}</div></div>`
}

function renderCards(list) {
  const s = summarize(list)
  const partial = view.tab !== 'perp' && view.tab !== 'spot' && dexInfo.ok < dexInfo.total
  const floor = partial ? ' <span class="mk-dim" title="Not every HIP-3 dex has answered yet">+</span>' : ''
  const mover = (r) => r ? `${esc(r.sym)} ${chg(r.chg24)}` : '—'
  // Summed once per token: PUMP's perp and its wrapped spot would otherwise count it twice.
  const revRows = onePerToken(list.filter(r => r.rev24 != null))
  const rev = revRows.reduce((a, r) => a + r.rev24, 0), revN = revRows.length
  $('mkCards').innerHTML = [
    card('Volume 24h', money(s.vol) + floor, `${s.volN} markets`),
    card('Open interest', s.oiN ? money(s.oi) + floor : '—', s.oiN ? `${s.oiN} perp markets` : 'spot has none'),
    card('Revenue 24h', revN ? money(rev) : '—', revN ? `${revN} protocol tokens · DefiLlama` : revState === 'loading' ? 'loading…' : revState === 'ok' ? 'no protocol tokens here' : 'not available'),
    card('Top gainer 24h', mover(s.gainer), s.gainer ? money(s.gainer.vol24) + ' volume' : 'min. $100K volume'),
    card('Top loser 24h', mover(s.loser), s.loser ? money(s.loser.vol24) + ' volume' : 'min. $100K volume'),
  ].join('')
}

function renderControls() {
  const base = filterRows(rows, { strict: view.strict })
  const count = (t) => t === 'all' ? base.length : t === 'crypto' || t === 'tradfi' ? base.filter(r => r.group === t).length : base.filter(r => r.kind === t).length
  for (const b of $('mkTabs').querySelectorAll('button')) {
    b.classList.toggle('is-on', b.dataset.tab === view.tab)
    b.querySelector('i').textContent = count(b.dataset.tab)
  }
  for (const b of $('mkStrict').querySelectorAll('button')) b.classList.toggle('is-on', (b.dataset.strict === '1') === view.strict)
  for (const b of $('mkMode').querySelectorAll('button')) b.classList.toggle('is-on', b.dataset.mode === view.mode)
  const sorts = view.mode === 'revenue' ? ['rev24', 'rev7', 'rev30', 'mcap'] : ['vol24', 'oi', 'mcap', 'chg24', 'funding1h', 'rev24']
  const LBL = { vol24: 'Volume', oi: 'Open interest', mcap: 'Market cap', chg24: '24h change', funding1h: 'Funding', rev24: 'Revenue 24h', rev7: 'Revenue 7d', rev30: 'Revenue 30d' }
  $('mkRankBtns').innerHTML = sorts.map(k => `<button data-sort="${k}" class="${k === view.sort ? 'is-on' : ''}">${LBL[k]}</button>`).join('')

  // Category chips: the sectors of the rows in view (tab + strict, before the sector itself),
  // with counts, only those with any. Crypto/TradFi tabs show their own group's.
  const scope = filterRows(rows, {
    kind: ['perp', 'hip3', 'spot'].includes(view.tab) ? view.tab : 'all',
    group: view.tab === 'crypto' || view.tab === 'tradfi' ? view.tab : null,
    strict: view.strict,
  })
  const n = new Map()
  for (const r of scope) for (const t of (r.tags ?? [])) n.set(t, (n.get(t) ?? 0) + 1)
  const chips = SECTORS.filter(s => n.get(s.key))
  // The group label is a button too: it switches to that tab (Crypto / TradFi).
  const groupChip = (g, label) => chips.some(s => s.group === g || s.group === 'both')
    ? `<button class="mk-sec-group${view.tab === g ? ' is-on' : ''}" data-tab="${g}" title="Show ${label} only">${label}</button>` : ''
  const chip = (s) => `<button data-sector="${s.key}" class="${view.sector === s.key ? 'is-on' : ''}">${esc(s.label)} <i>${n.get(s.key)}</i></button>`
  $('mkSectors').innerHTML = `<button data-sector="" class="${!view.sector ? 'is-on' : ''}">All categories</button>` +
    (view.tab !== 'tradfi' ? groupChip('crypto', 'Crypto') + chips.filter(s => s.group === 'crypto' || (s.group === 'both' && view.tab !== 'tradfi')).map(chip).join('') : '') +
    (view.tab !== 'crypto' ? groupChip('tradfi', 'TradFi') + chips.filter(s => s.group === 'tradfi' || (s.group === 'both' && view.tab === 'tradfi')).map(chip).join('') : '')

  // HIP-3 dex chips, by volume, only on the HIP-3 tab
  const dx = $('mkDexes')
  dx.hidden = view.tab !== 'hip3'
  if (!dx.hidden) {
    const by = new Map()
    for (const r of rows) if (r.kind === 'hip3') by.set(r.dex, { label: r.dexLabel, vol: (by.get(r.dex)?.vol ?? 0) + (r.vol24 ?? 0) })
    dx.innerHTML = `<button data-dex="" class="${!view.dex ? 'is-on' : ''}">All dexes</button>` +
      [...by.entries()].sort((a, b) => b[1].vol - a[1].vol)
        .map(([d, v]) => `<button data-dex="${esc(d)}" class="${view.dex === d ? 'is-on' : ''}">${esc(v.label)} <i>${money(v.vol)}</i></button>`).join('')
  }
}

const COLS = {
  market:  [['price', 'Price'], ['chg24', '24h'], ['vol24', 'Volume 24h'], ['oi', 'Open interest'], ['mcap', 'Market cap'], ['funding1h', 'Funding 1h']],
  revenue: [['rev24', 'Revenue 24h'], ['rev7', 'Revenue 7d'], ['rev30', 'Revenue 30d'], ['mcap', 'Market cap'], ['chg24', '24h']],
}
const cellFor = (k, r) => k === 'price' ? price(r.price) : k === 'chg24' ? chg(r.chg24) : k === 'funding1h' ? fund(r.funding1h) : m(r[k])

function renderTable(list) {
  const cols = COLS[view.mode]
  $('mkHead').innerHTML = `<th class="mk-c-rank">#</th><th class="mk-c-asset">Asset</th>` +
    cols.map(([k, l]) => `<th data-sort="${k}" class="${k === view.sort ? 'is-on' : ''}" data-dir="${k === view.sort ? (view.asc ? '▴' : '▾') : ''}">${l}</th>`).join('') +
    `<th class="mk-c-cat">Category</th>`
  const sorted = sortRows(list, view.sort, view.asc)
  const page = sorted.slice(0, view.shown)
  const badge = (r) => r.kind === 'hip3' ? `<em class="mk-b mk-b--hip3">${esc(r.dexLabel)}</em>`
    : r.kind === 'spot' ? `<em class="mk-b mk-b--spot">Spot${r.wrapped ? ' · ' + esc(r.wrapped) : ''}</em>`
    : `<em class="mk-b">Perp${r.maxLev ? ' · ' + r.maxLev + 'x' : ''}</em>`
  const catCell = (r) => {
    const extra = (r.tags ?? []).map(t => SECTOR_LABEL[t]).filter(l => l && l !== r.category).slice(0, 2)
    return `<td class="mk-c-cat">${r.category ? `<button class="mk-cat" data-cat="${esc((r.tags ?? [])[0] ?? '')}">${esc(r.category)}</button>` : dash}${extra.map(l => `<span class="mk-tag">${esc(l)}</span>`).join('')}</td>`
  }
  const sub = (r) => view.mode === 'revenue' && r.revName ? r.revName : (r.name && r.name !== r.sym ? r.name : '')
  $('mkBody').innerHTML = page.length ? page.map((r, i) => `<tr>
      <td class="mk-c-rank">${i + 1}</td>
      <td class="mk-c-asset"><div class="mk-asset">${iconHtml(r)}<div><b>${esc(r.sym)}</b>${badge(r)}${sub(r) ? `<small>${esc(sub(r))}</small>` : ''}</div></div></td>
      ${cols.map(([k]) => `<td>${cellFor(k, r)}</td>`).join('')}
      ${catCell(r)}
    </tr>`).join('')
    : `<tr><td colspan="${cols.length + 3}" class="mk-empty">${!rows.length ? 'Loading markets from Hyperliquid…'
        : view.mode === 'revenue' && revState !== 'ok' ? (revState === 'loading' ? 'Loading revenue from DefiLlama…' : 'Revenue is not available right now.')
        : 'Nothing matches.'}</td></tr>`
  $('mkMore').hidden = sorted.length <= view.shown
  $('mkMore').textContent = `Show more (${sorted.length - view.shown} left)`
}

function renderStatus() {
  const age = loadedAt ? Math.round((Date.now() - loadedAt) / 1000) : null
  const dex = dexInfo.total && dexInfo.ok < dexInfo.total ? ` · HIP-3 ${dexInfo.ok}/${dexInfo.total} dexes` : ''
  $('mkStatusText').textContent = age == null ? 'loading…' : `live · updated ${age < 5 ? 'just now' : age + 's ago'}${dex}`
}

function render() {
  const list = current()
  renderControls()
  renderCards(list)
  renderTable(list)
  renderStatus()
}

// ── controls ─────────────────────────────────────────────────────────────────
const set = (patch) => { view = { ...view, ...patch, shown: PAGE }; render() }
$('mkTabs').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) set({ tab: b.dataset.tab, dex: null, sector: null }) })
$('mkStrict').addEventListener('click', e => { const b = e.target.closest('button[data-strict]'); if (b) set({ strict: b.dataset.strict === '1' }) })
$('mkMode').addEventListener('click', e => {
  const b = e.target.closest('button[data-mode]'); if (!b) return
  set({ mode: b.dataset.mode, sort: b.dataset.mode === 'revenue' ? 'rev24' : 'vol24', asc: false })
})
$('mkDexes').addEventListener('click', e => { const b = e.target.closest('button[data-dex]'); if (b) set({ dex: b.dataset.dex || null }) })
$('mkSectors').addEventListener('click', e => {
  if (dragged) return                                   // the end of a drag is not a click
  const g = e.target.closest('button[data-tab]')
  if (g) return set({ tab: g.dataset.tab, dex: null, sector: null })
  const b = e.target.closest('button[data-sector]'); if (b) set({ sector: b.dataset.sector || null })
})

/**
 * Sideways rows without a scrollbar: the mouse wheel scrolls them, and so does dragging with
 * the mouse. Touch already swipes natively, so only a mouse pointer starts a drag. A drag that
 * moved more than a few pixels swallows the click it ends on, or letting go over a chip would
 * select it.
 */
let dragged = false
function sideScroll(el) {
  el.addEventListener('wheel', e => {
    if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return
    el.scrollLeft += e.deltaY
    e.preventDefault()
  }, { passive: false })
  let x0 = null, s0 = 0
  el.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return
    x0 = e.clientX; s0 = el.scrollLeft; dragged = false
  })
  window.addEventListener('pointermove', e => {
    if (x0 == null) return
    const dx = e.clientX - x0
    if (!dragged && Math.abs(dx) > 5) { dragged = true; el.classList.add('is-dragging') }
    if (dragged) el.scrollLeft = s0 - dx
  })
  window.addEventListener('pointerup', () => {
    if (x0 == null) return
    x0 = null; el.classList.remove('is-dragging')
    setTimeout(() => { dragged = false }, 0)          // after the click this drag ends on
  })
}
sideScroll($('mkSectors'))
sideScroll($('mkCards'))
// A category in the table is a shortcut to that filter.
$('mkBody').addEventListener('click', e => { const b = e.target.closest('button[data-cat]'); if (b && b.dataset.cat) { set({ sector: b.dataset.cat }); $('mkSectors').scrollIntoView({ behavior: 'smooth', block: 'center' }) } })
const setSort = (key) => {
  // Same column again flips direction; a new one starts from the top.
  set(key === view.sort ? { asc: !view.asc } : { sort: key, asc: false })
}
$('mkRankBtns').addEventListener('click', e => { const b = e.target.closest('button[data-sort]'); if (b) setSort(b.dataset.sort) })
$('mkHead').addEventListener('click', e => { const th = e.target.closest('th[data-sort]'); if (th) setSort(th.dataset.sort) })
let qt
$('mkSearch').addEventListener('input', e => { clearTimeout(qt); qt = setTimeout(() => set({ q: e.target.value }), 120) })
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
loadMeta()
setInterval(() => { if (!document.hidden) run() }, REFRESH_MS)
setInterval(() => { if (!document.hidden) loadMeta() }, META_REFRESH_MS)
setInterval(() => { if (!document.hidden) renderStatus() }, 5_000)

