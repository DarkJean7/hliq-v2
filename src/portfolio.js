// /portfolios — build a basket of Hyperliquid assets and backtest it.
//
// Markets come from Hyperliquid in the visitor's browser and are built into rows by
// src/marketsdata.js (the /markets table's own rows, so a sector here is a sector there);
// categories from /markets-meta. Prices: candleSnapshot, one call per holding, cached for the
// visit. The arithmetic is src/pfbacktest.js; the trading strategies are the app's Trade
// Simulator (src/backtest.js). Imports nothing from the app.
import './landing.css'
import './markets.css'
import './portfolio.css'
import { buildMarkets, isStrict } from './marketsdata.js'
import { displayName } from './coinnames.js'
import { sideScroll, wasDrag } from './sidescroll.js'
import { SECTORS, SECTOR_LABEL } from './sectors.js'
import { holdingsSectors, sectorColor } from './sectoralloc.js'
import { STRATEGIES, STRATEGY_LABEL, BOT_STRATEGIES, BOT_LABEL, backtest, botRun, DAY, dayOf } from './pfbacktest.js'

const API = 'https://api.hyperliquid.xyz/info'
const $ = (id) => document.getElementById(id)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const post = (body, ms = 15_000) => fetch(API, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms),
}).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json() })

// Per-viewer conveniences only (CLAUDE.md): the draft you were editing and the portfolios you
// saved, in this browser. Reads and writes never throw; the page works without them.
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v) } catch { return d } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} },
}
const DRAFT_KEY = 'hliq_pf_draft', SAVED_KEY = 'hliq_pf_saved'

// ── formatting ───────────────────────────────────────────────────────────────
const usd = (n, dp = 0) => n == null || !Number.isFinite(n) ? '—' : (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp })
const short$ = (n) => {
  const a = Math.abs(n)
  const s = a >= 1e9 ? (a / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(0)
  return (n < 0 ? '-$' : '$') + s
}
const pct = (x, dp = 1) => x == null || !Number.isFinite(x) ? '—' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(dp)}%`
const cls = (x) => x == null ? '' : x >= 0 ? 'mk-up' : 'mk-dn'
const dateStr = (t) => new Date(t).toISOString().slice(0, 10)
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dLabel = (t) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}` }

const ICON_V = '5'
const iconHtml = (coin, sym) => `<span class="mk-ico" data-l="${esc(String(sym || '?').slice(0, 1))}"><img src="/icon/${encodeURIComponent(coin)}?v=${ICON_V}&ro=1" alt="" loading="lazy" onload="this.naturalWidth>1||this.remove()" onerror="this.remove()"></span>`

// Holdings get a palette of their own (the ring), strategies another (the lines).
const HOLD_COLORS = ['#ff8a2a', '#00e5ff', '#22e39a', '#b49cff', '#ffd23f', '#ff4d6d', '#4e8ff0', '#f28c28', '#50e3c2', '#eb2f96', '#a0d911', '#8d99ae']
const RUN_COLORS = ['#ff8a2a', '#00e5ff', '#22e39a', '#b49cff', '#ffd23f', '#ff4d6d', '#4e8ff0', '#eb2f96', '#50e3c2', '#a0d911', '#f28c28', '#9254de', '#13c2c2', '#fa541c', '#597ef7', '#d4b106']
const BENCH_COLOR = '#8d99ae'

// ── state ────────────────────────────────────────────────────────────────────
const DEFAULT = {
  name: 'Majors',
  desc: 'The four most traded perps on Hyperliquid, weighted by hand.',
  items: [{ coin: 'BTC', sym: 'BTC', kind: 'perp', w: 40, side: 'long' }, { coin: 'ETH', sym: 'ETH', kind: 'perp', w: 25, side: 'long' },
          { coin: 'SOL', sym: 'SOL', kind: 'perp', w: 15, side: 'long' }, { coin: 'HYPE', sym: 'HYPE', kind: 'perp', w: 20, side: 'long' }],
  weighting: 'custom',
  period: '365', from: null, to: null, capital: 10_000, lev: 1, fee: 0.045,
  strats: ['hold', 'monthly', 'trend'], bots: [], band: 5, trendDays: 50,
  tf: '4h', tp: 4, sl: 2, both: false, bench: true,
}
let S = { ...DEFAULT, ...store.get(DRAFT_KEY, {}) }
let focus = null           // the run whose contributions are shown, by id
let rows = [], rowById = new Map(), cats = null, meta = null
let marketsReady = false

// A shared link (#p=…) wins over the draft — it is what the visitor came to see.
function decodeShare(h) {
  try {
    const m = /[#&]p=([A-Za-z0-9_-]+)/.exec(h)
    if (!m) return null
    const j = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))))
    if (!Array.isArray(j.i)) return null
    return {
      name: String(j.n || 'Shared portfolio').slice(0, 40),
      desc: String(j.d ?? '').slice(0, 280),
      items: j.i.slice(0, 30).map(([coin, w, sh]) => ({ coin: String(coin), sym: String(coin).replace(/^.*:/, ''), kind: String(coin).includes(':') ? 'hip3' : String(coin).startsWith('@') ? 'spot' : 'perp', w: Number(w) || 0, side: sh ? 'short' : 'long' })),
      weighting: 'custom', featuredId: null,
      ...(j.s && typeof j.s === 'object' ? pickSettings(j.s) : {}),
    }
  } catch { return null }
}
const SETTING_KEYS = ['period', 'from', 'to', 'capital', 'lev', 'fee', 'strats', 'bots', 'band', 'trendDays', 'tf', 'tp', 'sl', 'both', 'bench']
const pickSettings = (o) => Object.fromEntries(SETTING_KEYS.filter(k => k in o).map(k => [k, o[k]]))
function encodeShare() {
  const j = { n: S.name, d: S.desc || undefined, i: S.items.map(i => [i.coin, +Number(i.w).toFixed(4), i.side === 'short' ? 1 : 0]), s: pickSettings(S) }
  return btoa(unescape(encodeURIComponent(JSON.stringify(j)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
const shared = decodeShare(location.hash)
if (shared) S = { ...S, ...shared }

const saveDraft = () => store.set(DRAFT_KEY, S)
/** What a holding is called on screen: Hyperliquid's own name for it (DIESEL, SAMSUNG). */
const nameOf = (i) => rowById.get(i.coin)?.label ?? displayName(i.sym)

// ── markets ──────────────────────────────────────────────────────────────────
async function loadMarkets() {
  const [core, spot, dexes, pc] = await Promise.all([
    post({ type: 'metaAndAssetCtxs' }).catch(() => null),
    post({ type: 'spotMetaAndAssetCtxs' }).catch(() => null),
    post({ type: 'perpDexs' }).catch(() => null),
    // Categories, and the names and keywords Hyperliquid's UI uses (DIESEL is xyz:HO).
    post({ type: 'perpConciseAnnotations' }).then(a => Array.isArray(a) ? a : Promise.reject()).catch(() => post({ type: 'perpCategories' })).catch(() => null),
  ])
  if (!core && !spot) throw new Error('Hyperliquid did not answer')
  if (Array.isArray(pc)) cats = pc
  mk = { core, spot, hip3: [] }
  const hip3 = mk.hip3
  rebuild()
  setStatus('markets loaded')
  // HIP-3 dexes one at a time, a beat apart: the PEAK is what spends the rate limit.
  for (const d of (Array.isArray(dexes) ? dexes : []).filter(d => d?.name)) {
    await sleep(220)
    try { hip3.push({ dex: d.name, label: d.fullName || d.name, data: await post({ type: 'metaAndAssetCtxs', dex: d.name }) }) } catch {}
    rebuild()
  }
}
// The rows are rebuilt whenever a piece arrives: each HIP-3 dex, and the categories from
// /markets-meta, which can land before or after the markets do.
let mk = null
function rebuild() {
  if (!mk) return
  rows = buildMarkets({ ...mk, cats, revenue: meta?.revenue ?? null, cg: meta?.cg ?? null, stocks: meta?.stocks ?? null, sic: meta?.sic ?? null }).filter(isStrict)
  rowById = new Map(rows.map(r => [r.coin, r]))
  marketsReady = true
  renderSectors(); renderBuilder()
}
async function loadMeta() {
  try {
    const r = await fetch('/markets-meta', { signal: AbortSignal.timeout(60_000) })
    const j = r.ok ? await r.json() : null
    if (j?.revenue) meta = { revenue: j.revenue, cg: j.cg ?? null, stocks: j.stocks ?? null, sic: j.sic ?? null }
  } catch {}
  rebuild()
}

// ── prices ───────────────────────────────────────────────────────────────────
// Daily closes for the allocation strategies: the whole history once per coin. The trading
// strategies run on finer candles, fetched for the window they need.
const daily = new Map()        // coin → [{t,o,h,l,c}]
const intraday = new Map()     // coin|tf|from|to → [{t,o,h,l,c}]
const HIST_FROM = Date.UTC(2022, 0, 1)
const TF_MS = { '1h': 3_600_000, '4h': 4 * 3_600_000, '1d': DAY }
const candles = (j) => (Array.isArray(j) ? j : []).map(k => ({ t: Number(k.t), o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c) })).filter(k => k.c > 0)

// One request per coin even when two runs overlap (a setting changed while prices loaded).
const dailyInflight = new Map()
function fetchDaily(coin) {
  if (daily.has(coin)) return Promise.resolve(daily.get(coin))
  if (!dailyInflight.has(coin)) {
    dailyInflight.set(coin, post({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: HIST_FROM, endTime: Date.now() } }, 20_000)
      .then(j => { const out = candles(j); daily.set(coin, out); return out })
      .finally(() => dailyInflight.delete(coin)))
  }
  return dailyInflight.get(coin)
}
// Up to 5000 candles a call. A 1-hour window longer than that is cut to its last 5000 and
// the page says so (see `cut`).
async function fetchIntra(coin, tf, from, to) {
  const lookback = 250 * TF_MS[tf]               // indicators read history before the window
  const start = Math.max(from - lookback, to - 4990 * TF_MS[tf])
  const k = `${coin}|${tf}|${dayOf(start)}|${dayOf(to)}`
  if (intraday.has(k)) return intraday.get(k)
  const out = candles(await post({ type: 'candleSnapshot', req: { coin, interval: tf, startTime: start, endTime: to } }, 20_000))
  intraday.set(k, out)
  return out
}

// ── builder ──────────────────────────────────────────────────────────────────
const totalW = () => S.items.reduce((a, i) => a + (Number(i.w) > 0 ? Number(i.w) : 0), 0)
const share = (i) => { const t = totalW(); return t > 0 && Number(i.w) > 0 ? Number(i.w) / t : 0 }

function applyWeighting(mode) {
  S.weighting = mode
  if (mode === 'custom') return
  const val = (i) => { const r = rowById.get(i.coin); return mode === 'equal' ? 1 : r?.[mode] ?? null }
  const known = S.items.map(val).filter(v => v > 0)
  // An asset with no figure (no market cap published for it) gets the average of the others
  // rather than zero — "not known" is not "worth nothing". The total line says which.
  const avg = known.length ? known.reduce((a, v) => a + v, 0) / known.length : 1
  const vals = S.items.map(i => { const v = val(i); return v > 0 ? v : avg })
  const sum = vals.reduce((a, v) => a + v, 0)
  S.items.forEach((i, k) => { i.w = +(100 * vals[k] / sum).toFixed(2) })
}

function addAsset(r) {
  if (!r || S.items.some(i => i.coin === r.coin) || S.items.length >= 30) return
  S.items.push({ coin: r.coin, sym: r.sym, kind: r.kind, w: S.weighting === 'custom' ? (S.items.length ? +(totalW() / S.items.length).toFixed(2) : 100) : 0, side: 'long' })
  if (S.weighting !== 'custom') applyWeighting(S.weighting)
  changed()
}

function sectorBasket(key) {
  const best = new Map()
  for (const r of rows) {
    if (!(r.tags ?? []).includes(key)) continue
    const cur = best.get(r.sym)
    if (!cur || (r.vol24 ?? 0) > (cur.vol24 ?? 0)) best.set(r.sym, r)
  }
  return [...best.values()].sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0)).slice(0, 8)
}

// Two rows, as on /markets: crypto sectors and TradFi sectors. Each scrolls sideways with the
// wheel or a drag (src/sidescroll.js) — with the scrollbar hidden, a row that only scrolled by
// touch hid everything past its edge on a desktop, TradFi included.
function renderSectors() {
  const el = $('pfSectors')
  const chip = ([k, l]) => `<button data-sector="${k}">${esc(l)}</button>`
  const live = SECTORS.filter(s => sectorBasket(s.key).length >= 2)
  const crypto = [['top', 'Top 8 by volume'], ...live.filter(s => s.group !== 'tradfi').map(s => [s.key, s.label])]
  const tradfi = live.filter(s => s.group === 'tradfi').map(s => [s.key, s.label])
  el.innerHTML = `<div class="pf-sec-group"><span>Crypto</span><div class="pf-sec-row">${crypto.map(chip).join('')}</div></div>`
    + (tradfi.length ? `<div class="pf-sec-group"><span>TradFi</span><div class="pf-sec-row">${tradfi.map(chip).join('')}</div></div>` : '')
}
sideScroll($('pfSectors'), '.pf-sec-row')

function renderBuilder() {
  $('pfName').value = S.name
  renderMode()
  if (document.activeElement !== $('pfDesc')) $('pfDesc').value = S.desc ?? ''
  $('pfWeighting').querySelectorAll('button').forEach(b => b.classList.toggle('is-on', b.dataset.w === S.weighting))
  renderGallery()
  $('pfHoldings').innerHTML = S.items.length ? S.items.map((i, k) => {
    const r = rowById.get(i.coin)
    const badge = i.kind === 'hip3' ? `<i class="mk-b mk-b--hip3">${esc(r?.dexLabel || i.coin.split(':')[0])}</i>` : i.kind === 'spot' ? '<i class="mk-b mk-b--spot">Spot</i>' : '<i class="mk-b">Perp</i>'
    const gone = marketsReady && !r ? '<small class="mk-dn">not listed now</small>' : `<small>${esc(r?.category ?? '')}</small>`
    return `<div class="pf-hold" data-k="${k}">
      <span class="pf-sw" style="background:${HOLD_COLORS[k % HOLD_COLORS.length]}"></span>
      ${iconHtml(i.coin, i.sym)}
      <div class="pf-hold-name"><b>${esc(nameOf(i))}</b>${badge}${gone}</div>
      <button class="pf-side ${i.side === 'short' ? 'is-short' : ''}" data-side="${k}" title="Long or short">${i.side === 'short' ? 'Short' : 'Long'}</button>
      <label class="pf-w"><input type="number" min="0" step="1" value="${+Number(i.w).toFixed(2)}" data-w="${k}" aria-label="Weight of ${esc(nameOf(i))}"><span>${(share(i) * 100).toFixed(1)}%</span></label>
      <button class="pf-x" data-rm="${k}" aria-label="Remove ${esc(nameOf(i))}">×</button>
    </div>`
  }).join('') : '<div class="pf-empty">Add assets above, or start from a sector.</div>'
  const t = totalW()
  const noFig = S.weighting !== 'custom' && S.weighting !== 'equal' ? S.items.filter(i => !(rowById.get(i.coin)?.[S.weighting] > 0)).map(i => i.sym) : []
  $('pfTotal').innerHTML = S.items.length
    ? `${S.items.length} holding${S.items.length === 1 ? '' : 's'} · weights are shares of ${+t.toFixed(2)}, shown as % on the right${noFig.length ? ` · <span class="mk-dim">no ${S.weighting === 'mcap' ? 'market cap' : S.weighting === 'oi' ? 'open interest' : 'volume'} for ${esc(noFig.join(', '))}: given the average</span>` : ''}`
    : ''
  renderComp()
}

// ── your portfolios ──────────────────────────────────────────────────────────
// One card per saved portfolio: its composition, and what holding it (buy & hold, 1×, the
// default fee) returned over the gallery's own timeframe — 1 year unless changed. The same
// engine and the same daily closes as the backtest below, so a card and a test of that
// portfolio over the same window agree. Clicking a card opens it in the builder.
const GAL_TF_KEY = 'hliq_pf_gallery_tf'
let galTf = String(store.get(GAL_TF_KEY, '365'))
let delArmed = null, delT
const galWindow = () => {
  const now = Date.now()
  return { from: galTf === 'max' ? HIST_FROM : dayOf(now) - Number(galTf) * DAY, to: now }
}
const galLabel = () => ({ 30: '30 days', 90: '90 days', 182: '6 months', 365: '1 year', 730: '2 years', max: 'all time' })[galTf] ?? galTf + ' days'
const sameItems = (a, b) => JSON.stringify(a.map(i => [i.coin, +Number(i.w).toFixed(4), i.side])) === JSON.stringify(b.map(i => [i.coin, +Number(i.w).toFixed(4), i.side]))
const galFailed = new Set()

function galResult(p) {
  const items = p.items.filter(i => Number(i.w) > 0).map(i => ({ key: i.coin, weight: Number(i.w), side: i.side }))
  if (!items.length) return { state: 'empty' }
  if (items.some(i => galFailed.has(i.key))) return { state: 'failed' }
  if (items.some(i => !daily.has(i.key))) return { state: 'loading' }
  const { from, to } = galWindow()
  const candles = Object.fromEntries(items.map(i => [i.key, daily.get(i.key).map(k => [k.t, k.c])]))
  const r = backtest({ candles, items, from, to, strategies: ['hold'], opts: { capital: 10_000, leverage: 1, feeBps: DEFAULT.fee * 100 } })
  if (!r.runs.length) return { state: 'failed' }
  return { state: 'ok', run: r.runs[0], start: r.start, clippedBy: r.clippedBy }
}

function spark(eq, up) {
  if (!eq || eq.length < 2) return ''
  const W = 240, H = 56, lo = Math.min(...eq), hi = Math.max(...eq), span = hi - lo || 1
  const pts = eq.map((v, i) => [(i / (eq.length - 1)) * W, H - 3 - ((v - lo) / span) * (H - 6)])
  const d = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
  const c = up ? 'var(--pos)' : 'var(--neg)'
  return `<svg class="pf-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${d}L${W},${H}L0,${H}Z" fill="${c}" opacity=".1"/><path d="${d}" fill="none" stroke="${c}" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`
}

// ── featured portfolios (src/pfshared.js, served by serve-prod.js /portfolios-data) ──────────
// Everyone sees them; only the developer can change them. "Developer" is the app's own dev
// mode — the same PIN (hliq_lb_pin), checked by the server on every write — so there is no
// second login to keep in step. A visitor who opens one can change anything and test it; the
// page never writes back, and "Save a copy" keeps their version on this device.
let featured = null                 // null until it loads (or when it could not): not "there are none"
let featuredState = 'loading'       // 'loading' | 'ok' | 'failed'
const devPin = () => { try { return localStorage.getItem('hliq_lb_pin') || '' } catch { return '' } }
const isDev = () => { try { return localStorage.getItem('hliq_dev') === '1' && !!devPin() } catch { return false } }

async function loadFeatured() {
  try {
    const r = await fetch('/portfolios-data', { signal: AbortSignal.timeout(15_000) })
    const j = r.ok ? await r.json() : null
    if (!Array.isArray(j?.portfolios)) throw new Error('none')
    featured = j.portfolios; featuredState = 'ok'
  } catch { featuredState = featured ? 'ok' : 'failed' }
  // A draft that was a featured portfolio that has since been removed is just a draft now.
  if (S.featuredId && featured && !featured.some(p => p.id === S.featuredId)) { S.featuredId = null; saveDraft() }
  renderBuilder()
  loadGalleryPrices()
}

/** POST a change to the featured list as the developer. → the new list, or throws with a reason. */
async function featuredWrite(path, body) {
  const r = await fetch('/portfolios-data/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-lb-pin': devPin() }, body: JSON.stringify(body) })
  const j = await r.json().catch(() => ({}))
  if (r.status === 403) { try { localStorage.removeItem('hliq_lb_pin') } catch {} ; throw new Error('The dev PIN was not accepted. Sign in again.') }
  if (!r.ok || !Array.isArray(j.portfolios)) throw new Error(j.error || 'Could not save right now.')
  featured = j.portfolios; featuredState = 'ok'
  return featured
}

function cardHtml(p, ref, { kind }) {
  const live = p.items.filter(i => Number(i.w) > 0)
  const tot = live.reduce((a, i) => a + Number(i.w), 0) || 1
  const editing = kind === 'featured' ? S.featuredId === p.id : !S.featuredId && p.name === S.name
  const edited = editing && (!sameItems(p.items, S.items) || (p.desc ?? '') !== (S.desc ?? ''))
  const res = galResult(p)
  const icons = live.slice(0, 5).map(i => iconHtml(i.coin, i.sym)).join('') + (live.length > 5 ? `<span class="pf-more">+${live.length - 5}</span>` : '')
  const bar = live.map((i, j) => `<i style="width:${(100 * Number(i.w) / tot).toFixed(2)}%;background:${HOLD_COLORS[j % HOLD_COLORS.length]}" title="${esc(nameOf(i))} ${(100 * Number(i.w) / tot).toFixed(1)}%"></i>`).join('')
  let body
  if (res.state === 'ok') {
    const r = res.run
    body = `<div class="pf-gc-ret ${cls(r.ret)}">${pct(r.ret)}</div>
      <div class="pf-gc-sub">${galLabel()}${res.clippedBy ? ` · since ${dLabel(res.start)}` : ''} · ${r.maxDd < -0.0005 ? `max drawdown ${(r.maxDd * 100).toFixed(1)}%` : 'no drawdown'}</div>
      ${spark(r.equity, (r.ret ?? 0) >= 0)}`
  } else if (res.state === 'loading') body = '<div class="pf-gc-ret mk-dim">…</div><div class="pf-gc-sub">loading prices</div><div class="pf-spark pf-spark--empty"></div>'
  else if (res.state === 'failed') body = '<div class="pf-gc-ret mk-dim">—</div><div class="pf-gc-sub">prices did not load for every holding</div><div class="pf-spark pf-spark--empty"></div>'
  else body = '<div class="pf-gc-ret mk-dim">—</div><div class="pf-gc-sub">no holdings with a weight</div><div class="pf-spark pf-spark--empty"></div>'
  const tag = editing ? ` · <span class="pf-gc-tag">${kind === 'featured' ? (edited ? 'open, testing changes' : 'open') : (edited ? 'editing, unsaved changes' : 'editing')}</span>` : ''
  // Delete: always on your own; on a featured one, for the developer only.
  const canDel = kind === 'local' || isDev()
  const del = canDel ? `<button class="pf-gc-del${delArmed === ref ? ' is-armed' : ''}" data-del="${ref}" aria-label="${kind === 'featured' ? 'Remove from featured' : 'Delete'} ${esc(p.name)}">${delArmed === ref ? (kind === 'featured' ? 'Remove?' : 'Delete?') : '×'}</button>` : ''
  const pub = kind === 'local' && isDev() ? `<button class="pf-gc-pub" data-pub="${ref}" title="Show this portfolio to everyone, under Featured">Publish</button>` : ''
  return `<div class="pf-gc${editing ? ' is-editing' : ''}${kind === 'featured' ? ' pf-gc--featured' : ''}" data-load="${ref}" role="button" tabindex="0" aria-label="Open ${esc(p.name)} in the builder">
    <div class="pf-gc-top">
      <div class="pf-gc-name"><b>${esc(p.name)}</b><small>${kind === 'featured' ? '<span class="pf-gc-badge">Featured</span> · ' : ''}${live.length} holding${live.length === 1 ? '' : 's'}${tag}</small></div>
      <div class="pf-gc-btns">${pub}${del}</div>
    </div>
    ${p.desc ? `<p class="pf-gc-desc">${esc(p.desc)}</p>` : ''}
    <div class="pf-gc-icons">${icons}</div>
    <div class="pf-gc-bar">${bar}</div>
    ${body}
  </div>`
}

function renderGallery() {
  const el = $('pfGallery'), fe = $('pfFeatured')
  if (!el || !fe) return
  $('pfGalTf').querySelectorAll('button').forEach(b => b.classList.toggle('is-on', b.dataset.g === galTf))
  // Featured: unknown is not empty — "loading" and "could not load" each say so.
  fe.innerHTML = featuredState === 'loading' && !featured ? '<div class="pf-gal-empty">Loading featured portfolios…</div>'
    : featuredState === 'failed' ? '<div class="pf-gal-empty">Featured portfolios did not load. <button class="pf-btn pf-btn--ghost" data-featured-retry>Retry</button></div>'
    : featured.length ? featured.map(p => cardHtml(p, 'f:' + p.id, { kind: 'featured' })).join('')
    : `<div class="pf-gal-empty">${isDev() ? 'Nothing featured yet. Press <b>Publish</b> on one of your portfolios to show it to everyone.' : 'No featured portfolios yet.'}</div>`
  $('pfDevNote').innerHTML = isDev()
    ? 'Developer mode: you can publish, update and remove featured portfolios. <button data-dev-out>Sign out</button>'
    : 'Built by Insolvent. Open one to test it — your changes stay on your device. <button data-dev-in>Developer sign-in</button>'
  const saved = store.get(SAVED_KEY, [])
  const cards = saved.map((p, k) => cardHtml(p, 'l:' + k, { kind: 'local' }))
  cards.push(`<button class="pf-gc pf-gc--new" data-new><span>+</span>New portfolio</button>`)
  el.innerHTML = saved.length ? cards.join('')
    : `<div class="pf-gal-empty">Portfolios you save appear here as cards, with what they returned. They stay on this device. Build one below and press <b>Save</b>.</div>`
}

// Prices for every card, one coin at a time — the cards fill in as they arrive.
let galLoading = false
async function loadGalleryPrices() {
  if (galLoading) return
  galLoading = true
  try {
    const all = [...(featured ?? []), ...store.get(SAVED_KEY, [])]
    const coins = [...new Set(all.flatMap(p => p.items.filter(i => Number(i.w) > 0).map(i => i.coin)))]
    for (const c of coins) {
      if (daily.has(c) || galFailed.has(c)) continue
      try { await fetchDaily(c) } catch { galFailed.add(c) }
      renderGallery()
      await sleep(200)
    }
  } finally { galLoading = false; renderGallery() }
}

// ── composition ──────────────────────────────────────────────────────────────
function renderComp() {
  const el = $('pfComp')
  const live = S.items.map((i, k) => ({ ...i, k, s: share(i) })).filter(i => i.s > 0)
  if (!live.length) { el.innerHTML = '<div class="pf-empty">The composition appears here.</div>'; return }
  const SIZE = 220, CX = SIZE / 2, SW = 30, R = (SIZE - SW) / 2 - 2, C = 2 * Math.PI * R
  const gap = live.length > 1 ? Math.min(3, C * 0.006) : 0
  let acc = 0
  const arcs = live.map(i => {
    const len = Math.max(0.5, i.s * C - gap), off = -acc
    acc += i.s * C
    return `<circle cx="${CX}" cy="${CX}" r="${R}" fill="none" stroke="${HOLD_COLORS[i.k % HOLD_COLORS.length]}" stroke-width="${SW}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 ${CX} ${CX})"><title>${esc(nameOf(i))} ${(i.s * 100).toFixed(1)}%</title></circle>`
  }).join('')
  const longS = live.filter(i => i.side !== 'short').reduce((a, i) => a + i.s, 0)
  // Sector mix: the same categories as /markets and the app's Allocation → By sector.
  const sec = holdingsSectors(live.map(i => {
    const r = rowById.get(i.coin)
    return { id: i.coin, sym: i.sym, kind: i.kind === 'spot' ? 'spot' : 'perp', hlCat: r?.hlCat ?? null, label: i.sym,
             long: i.side === 'short' ? 0 : i.s, short: i.side === 'short' ? i.s : 0, accts: new Set() }
  }), meta ? { revenue: meta.revenue, sic: meta.sic } : null)
  el.innerHTML = `
    <div class="pf-comp-head"><div class="pf-lbl">Composition</div></div>
    ${S.desc ? `<p class="pf-comp-desc">${esc(S.desc)}</p>` : ''}
    <div class="pf-comp-body">
      <div class="pf-ring">
        <svg viewBox="0 0 ${SIZE} ${SIZE}">${arcs}</svg>
        <div class="pf-ring-c"><b>${esc(S.name || 'Portfolio')}</b><span>${live.length} holding${live.length === 1 ? '' : 's'}</span>
          <span>${longS >= 0.999 ? '100% long' : longS <= 0.001 ? '100% short' : `${(longS * 100).toFixed(0)}% long · ${((1 - longS) * 100).toFixed(0)}% short`}</span></div>
      </div>
      <div class="pf-legend">${live.slice().sort((a, b) => b.s - a.s).map(i => `
        <div class="pf-leg"><span class="pf-sw" style="background:${HOLD_COLORS[i.k % HOLD_COLORS.length]}"></span>${iconHtml(i.coin, i.sym)}
          <div><b>${esc(nameOf(i))}</b>${i.side === 'short' ? ' <i class="pf-short">short</i>' : ''}<small>${esc(rowById.get(i.coin)?.category ?? '')}</small></div>
          <span class="pf-leg-pct">${(i.s * 100).toFixed(1)}%</span></div>`).join('')}
      </div>
    </div>
    ${sec.sectors.length ? `<div class="pf-lbl" style="margin-top:14px">Sector mix</div>
      <div class="pf-secbar">${sec.sectors.map(s => `<i style="width:${(s.gross * 100).toFixed(2)}%;background:${sectorColor(s.key)}" title="${esc(s.label)} ${(s.gross * 100).toFixed(1)}%"></i>`).join('')}</div>
      <div class="pf-seclist">${sec.sectors.map(s => `<span><i style="background:${sectorColor(s.key)}"></i>${esc(s.label)} <b>${(s.gross * 100).toFixed(0)}%</b></span>`).join('')}</div>` : ''}`
}

// ── run controls ─────────────────────────────────────────────────────────────
function renderRunControls() {
  $('pfPeriod').querySelectorAll('button').forEach(b => b.classList.toggle('is-on', !S.from && b.dataset.p === String(S.period)))
  const { from, to } = windowOf()
  $('pfFrom').value = dateStr(from); $('pfTo').value = dateStr(to)
  $('pfFrom').max = $('pfTo').max = dateStr(Date.now())
  $('pfCapital').value = S.capital
  $('pfLev').querySelectorAll('button').forEach(b => b.classList.toggle('is-on', Number(b.dataset.l) === Number(S.lev)))
  $('pfFee').value = S.fee
  $('pfBench').checked = !!S.bench
  $('pfBand').value = S.band; $('pfTrendDays').value = S.trendDays
  $('pfTf').value = S.tf; $('pfTp').value = S.tp; $('pfSl').value = S.sl; $('pfBoth').checked = !!S.both
  $('pfStrats').innerHTML = STRATEGIES.map(s => `<button data-strat="${s.id}" class="${S.strats.includes(s.id) ? 'is-on' : ''}" title="${esc(s.desc)}">${esc(s.label)}</button>`).join('')
  $('pfBots').innerHTML = BOT_STRATEGIES.map(([id, l]) => `<button data-bot="${id}" class="${S.bots.includes(id) ? 'is-on' : ''}">${esc(l)}</button>`).join('')
  $('pfAllocParams').hidden = !(S.strats.includes('band') || S.strats.includes('trend'))
  $('pfBotParams').hidden = !S.bots.length
}

function windowOf() {
  const now = Date.now()
  if (S.from) return { from: Date.parse(S.from + 'T00:00:00Z'), to: S.to ? Math.min(now, Date.parse(S.to + 'T00:00:00Z') + DAY - 1) : now }
  const days = S.period === 'max' ? Math.ceil((now - HIST_FROM) / DAY) : Number(S.period)
  return { from: dayOf(now) - days * DAY, to: now }
}

// ── running ──────────────────────────────────────────────────────────────────
let runSeq = 0, last = null
function setStatus(t) { $('pfStatusText').textContent = t }

async function run() {
  const my = ++runSeq
  const items = S.items.filter(i => Number(i.w) > 0).map(i => ({ key: i.coin, weight: Number(i.w), side: i.side }))
  const res = $('pfResults')
  if (!items.length) { res.innerHTML = '<div class="pf-card pf-empty">Add at least one holding with a weight to test it.</div>'; last = null; return }
  if (!S.strats.length && !S.bots.length) { res.innerHTML = '<div class="pf-card pf-empty">Pick at least one strategy above.</div>'; last = null; return }
  const { from, to } = windowOf()
  const need = [...new Set([...items.map(i => i.key), ...(S.bench ? ['BTC'] : [])])]
  const failed = []
  const todo = need.filter(c => !daily.has(c))
  for (const [n, coin] of todo.entries()) {
    if (my !== runSeq) return
    setStatus(`loading prices ${n + 1}/${todo.length}…`)
    res.classList.add('is-busy')
    try { await fetchDaily(coin); await sleep(150) } catch { failed.push(coin) }
  }
  if (my !== runSeq) return
  const candles = Object.fromEntries(need.filter(c => daily.has(c)).map(c => [c, daily.get(c).map(k => [k.t, k.c])]))
  const opts = { capital: Number(S.capital) || 10_000, leverage: Number(S.lev) || 1, feeBps: (Number(S.fee) || 0) * 100, band: (Number(S.band) || 5) / 100, trendDays: Math.max(2, Number(S.trendDays) || 50) }
  const r = backtest({ candles, items, from, to, strategies: S.strats, opts, bench: S.bench ? 'BTC' : null })
  if (failed.some(c => items.some(i => i.key === c)) || r.missing.length) {
    res.classList.remove('is-busy')
    const names = [...new Set([...failed, ...r.missing])].filter(c => items.some(i => i.key === c)).map(c => rowById.get(c)?.sym ?? c)
    res.innerHTML = `<div class="pf-card pf-empty">No price history came back for ${esc(names.join(', '))}. <button class="pf-btn" id="pfRetry">Retry</button></div>`
    $('pfRetry')?.addEventListener('click', () => { failed.forEach(c => daily.delete(c)); run() })
    setStatus('prices did not load'); last = null
    return
  }
  if (!r.days.length) { res.classList.remove('is-busy'); res.innerHTML = '<div class="pf-card pf-empty">No days in that window have a price for every holding. Try a later start.</div>'; last = null; return }
  // Trading strategies: finer candles, over the same days the allocation runs use.
  const runs = r.runs.map(x => ({ ...x, label: STRATEGY_LABEL[x.id] }))
  let cut = false
  if (S.bots.length) {
    const ohlc = {}
    const tf = S.tf in TF_MS ? S.tf : '4h'
    const end = r.days[r.days.length - 1] + DAY - 1
    let k = 0
    for (const i of items) {
      if (my !== runSeq) return
      const key = `${i.key}|${tf}`
      setStatus(`loading ${tf} candles ${++k}/${items.length}…`)
      try {
        const all = tf === '1d' ? await fetchDaily(i.key) : await fetchIntra(i.key, tf, r.start, end)
        // Indicators warm up on the history before the window; trades start inside it.
        ohlc[i.key] = all.filter(c => c.t <= end)
        if (tf !== '1d' && all.length && all[0].t > r.start) cut = true
        if (tf !== '1d') await sleep(150)
      } catch { ohlc[i.key] = [] }
    }
    if (my !== runSeq) return
    for (const id of S.bots) {
      // Warm-up candles before the window would trade too; the run begins at the window's start.
      const win = Object.fromEntries(Object.entries(ohlc).map(([c, v]) => [c, v.filter(x => x.t >= r.start)]))
      runs.push({ ...botRun(win, items, r.days, id, { capital: opts.capital, leverage: opts.leverage, feeBps: opts.feeBps, tp: Number(S.tp) || 4, sl: Number(S.sl) || 2, both: !!S.both }), label: BOT_LABEL[id] })
    }
  }
  runs.forEach((x, i) => { x.color = RUN_COLORS[i % RUN_COLORS.length] })
  last = { ...r, runs, cut, opts, from, to, items }
  if (!runs.some(x => x.id === focus)) focus = runs.slice().sort((a, b) => b.final - a.final)[0]?.id ?? null
  res.classList.remove('is-busy')
  setStatus(`tested ${dLabel(r.days[0])} → ${dLabel(r.days[r.days.length - 1])}`)
  renderResults()
}

// ── results ──────────────────────────────────────────────────────────────────
function niceMax(v) { const p = 10 ** Math.floor(Math.log10(Math.max(1e-9, v))); for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p }

function lineChart(series, days, { h = 300, fmt = short$, minZero = false, signed = false } = {}) {
  const W = Math.max(300, $('pfResults').clientWidth - 2)
  const pad = { l: 58, r: 14, t: 12, b: 26 }
  const iw = W - pad.l - pad.r, ih = h - pad.t - pad.b
  const vals = series.flatMap(s => s.v)
  let lo = Math.min(...vals), hi = Math.max(...vals)
  if (minZero) lo = Math.min(0, lo)
  if (signed) { hi = 0; lo = Math.min(lo, -0.01) }
  if (hi === lo) { hi += 1; lo -= 1 }
  const span = hi - lo
  lo -= signed ? span * 0.05 : span * 0.06; hi += signed ? 0 : span * 0.06
  const x = (i) => pad.l + (days.length > 1 ? i / (days.length - 1) : 0.5) * iw
  const y = (v) => pad.t + (1 - (v - lo) / (hi - lo)) * ih
  const ticks = 5
  const grid = Array.from({ length: ticks + 1 }, (_, k) => lo + (hi - lo) * k / ticks)
    .map(v => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="pf-grid"/><text x="${pad.l - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="pf-axis">${fmt(v)}</text>`).join('')
  const xt = [0, Math.floor(days.length / 3), Math.floor(2 * days.length / 3), days.length - 1].filter((v, i, a) => a.indexOf(v) === i)
    .map((i, k, a) => `<text x="${x(i).toFixed(1)}" y="${h - 6}" text-anchor="${k === 0 ? 'start' : k === a.length - 1 ? 'end' : 'middle'}" class="pf-axis">${MON[new Date(days[i]).getUTCMonth()]} '${String(new Date(days[i]).getUTCFullYear()).slice(2)}</text>`).join('')
  const lines = series.map(s => {
    const d = s.v.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('')
    const dim = focus && s.id !== focus && s.id !== '__bench' ? ' pf-dim' : ''
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.id === focus ? 2.4 : 1.6}" ${s.dash ? 'stroke-dasharray="5 4"' : ''} class="pf-line${dim}" data-id="${esc(s.id)}"/>`
  }).join('')
  return { svg: `<svg viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" class="pf-svg">${grid}${xt}${lines}<line class="pf-cross" y1="${pad.t}" y2="${pad.t + ih}" x1="-10" x2="-10"/><rect class="pf-hit" x="${pad.l}" y="${pad.t}" width="${iw}" height="${ih}"/></svg>`, x, pad, iw }
}

function renderResults() {
  const L = last
  if (!L) return
  const res = $('pfResults')
  const all = [...L.runs, ...(L.bench ? [{ ...L.bench, id: '__bench', label: 'BTC, held', color: BENCH_COLOR, dash: true }] : [])]
  const notes = []
  if (L.clippedBy) notes.push(`Starts ${dLabel(L.start)}: ${esc(rowById.get(L.clippedBy)?.sym ?? L.clippedBy)} was listed then, and a basket can only be bought once all of it trades.`)
  if (L.cut) notes.push(`The trading strategies use the most recent 5,000 ${esc(S.tf)} candles, which start after the window does. Choose 4-hour or daily candles to cover all of it.`)
  const liq = all.filter(x => x.liquidated)
  if (liq.length) notes.push(`Liquidated: ${liq.map(x => `${esc(x.label)} on ${dLabel(x.liquidated)}`).join('; ')}.`)
  const openN = L.runs.reduce((a, x) => a + (x.open ?? 0), 0)
  if (openN) notes.push(`${openN} trade${openN === 1 ? ' was' : 's were'} still open when the window ended and ${openN === 1 ? 'is' : 'are'} not counted.`)

  const eq = lineChart(all.map(s => ({ id: s.id, color: s.color, dash: s.dash, v: s.equity })), L.days)
  const dd = lineChart(all.map(s => ({ id: s.id, color: s.color, dash: s.dash, v: s.dd })), L.days, { h: 150, fmt: (v) => (v * 100).toFixed(0) + '%', signed: true })
  const best = L.runs.slice().sort((a, b) => b.final - a.final)[0]
  const f = all.find(x => x.id === focus) ?? best
  const contrib = f ? Object.entries(f.pnlBy).map(([k, v]) => ({ k, v, sym: rowById.get(k)?.label ?? displayName(k) })).sort((a, b) => b.v - a.v) : []
  const cmax = Math.max(1e-9, ...contrib.map(c => Math.abs(c.v)))
  const tradesOf = (x) => x.id === '__bench' ? '1' : x.trades != null && x.won != null ? `${x.trades}${x.won + x.lost ? ` · ${Math.round(100 * x.won / (x.won + x.lost))}% won` : ''}` : x.rebalances != null ? `${x.rebalances} rebal.` : '—'

  res.innerHTML = `
    ${notes.length ? `<div class="pf-notes">${notes.map(n => `<p>${n}</p>`).join('')}</div>` : ''}
    <div class="mk-cards pf-cards">
      <div class="mk-card"><div class="mk-card__lbl">Best</div><div class="mk-card__val">${esc(best?.label ?? '—')}</div><div class="mk-card__sub ${cls(best?.ret)}">${pct(best?.ret)} · ${usd(best?.final)}</div></div>
      <div class="mk-card"><div class="mk-card__lbl">Window</div><div class="mk-card__val">${L.days.length - 1} days</div><div class="mk-card__sub">${dLabel(L.days[0])} → ${dLabel(L.days[L.days.length - 1])}</div></div>
      <div class="mk-card"><div class="mk-card__lbl">Capital</div><div class="mk-card__val">${usd(L.opts.capital)}</div><div class="mk-card__sub">${L.opts.leverage}× · fee ${(L.opts.feeBps / 100).toFixed(3)}% a trade</div></div>
      ${L.bench ? `<div class="mk-card"><div class="mk-card__lbl">BTC, held</div><div class="mk-card__val ${cls(L.bench.ret)}">${pct(L.bench.ret)}</div><div class="mk-card__sub">max drawdown ${pct(L.bench.maxDd)}</div></div>` : ''}
    </div>
    <div class="pf-card pf-chart-card">
      <div class="pf-chart-head"><div class="pf-lbl">Value</div><div class="pf-key">${all.map(s => `<button data-focus="${esc(s.id)}" class="${s.id === focus ? 'is-on' : ''}"><i style="background:${s.color}${s.dash ? ';opacity:.6' : ''}"></i>${esc(s.label)}</button>`).join('')}</div></div>
      <div class="pf-chart" id="pfEq">${eq.svg}<div class="pf-tip" id="pfTip" hidden></div></div>
      <div class="pf-lbl" style="margin-top:10px">Drawdown <small>below the highest value so far</small></div>
      <div class="pf-chart" id="pfDd">${dd.svg}</div>
    </div>
    <div class="mk-table-wrap pf-table-wrap" data-dragscroll>
      <table class="mk-table pf-table">
        <thead><tr><th class="mk-c-asset">Strategy</th><th>Final value</th><th>Return</th><th>Annualised</th><th>Max drawdown</th><th>Volatility</th><th>Sharpe</th><th>Best day</th><th>Worst day</th><th>Trades</th><th>Fees</th></tr></thead>
        <tbody>${all.map(x => `<tr data-focus="${esc(x.id)}" class="${x.id === focus ? 'is-focus' : ''}">
          <td class="mk-c-asset"><span class="pf-runname"><i style="background:${x.color}"></i>${esc(x.label)}</span></td>
          <td>${usd(x.final)}</td><td class="${cls(x.ret)}">${pct(x.ret)}</td><td class="${cls(x.cagr)}">${x.cagr == null ? '<span class="mk-dim" title="Only over a year or more">—</span>' : pct(x.cagr)}</td>
          <td class="mk-dn">${pct(x.maxDd)}</td><td>${x.vol ? (x.vol * 100).toFixed(0) + '%' : '—'}</td><td>${x.sharpe == null ? '—' : x.sharpe.toFixed(2)}</td>
          <td class="${cls(x.best)}">${pct(x.best)}</td><td class="${cls(x.worst)}">${pct(x.worst)}</td><td>${tradesOf(x)}</td><td>${x.fees == null ? '<span class="mk-dim" title="Included in the result">in result</span>' : usd(x.fees, 2)}</td>
        </tr>`).join('')}</tbody>
      </table>
    </div>
    ${f && f.id !== '__bench' ? `<div class="pf-card pf-contrib">
      <div class="pf-lbl">What each holding added <small>${esc(f.label)} — tap a strategy to switch</small></div>
      ${contrib.map(c => `<div class="pf-cbar"><span class="pf-cname">${esc(c.sym)}</span><span class="pf-ctrack"><i class="${c.v >= 0 ? 'up' : 'dn'}" style="width:${(50 * Math.abs(c.v) / cmax).toFixed(1)}%"></i></span><span class="pf-cval ${cls(c.v)}">${c.v >= 0 ? '+' : ''}${usd(c.v)}</span></div>`).join('')}
      ${f.fees ? `<div class="pf-cbar"><span class="pf-cname mk-dim">Fees</span><span class="pf-ctrack"><i class="dn" style="width:${(50 * f.fees / cmax).toFixed(1)}%"></i></span><span class="pf-cval mk-dn">-${usd(f.fees)}</span></div>` : ''}
    </div>` : ''}`

  // Hover: a crosshair and every line's value on that day.
  const box = $('pfEq'), tip = $('pfTip'), svg = box.querySelector('svg'), cross = svg.querySelector('.pf-cross')
  const at = (e) => {
    const rect = svg.getBoundingClientRect()
    const px = (e.clientX - rect.left) * (svg.viewBox.baseVal.width / rect.width)
    const i = Math.max(0, Math.min(L.days.length - 1, Math.round((px - eq.pad.l) / eq.iw * (L.days.length - 1))))
    const cx = eq.x(i)
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx)
    tip.hidden = false
    tip.innerHTML = `<b>${dLabel(L.days[i])}</b>` + all.slice().sort((a, b) => b.equity[i] - a.equity[i]).map(s => `<div><i style="background:${s.color}"></i>${esc(s.label)}<span>${usd(s.equity[i])}</span></div>`).join('')
    const left = (cx / svg.viewBox.baseVal.width) * rect.width
    tip.style.left = Math.min(Math.max(0, left + 14), rect.width - tip.offsetWidth - 4) + 'px'
    if (left + 14 + tip.offsetWidth > rect.width) tip.style.left = Math.max(0, left - tip.offsetWidth - 14) + 'px'
  }
  svg.querySelector('.pf-hit').addEventListener('pointermove', at)
  svg.querySelector('.pf-hit').addEventListener('pointerdown', at)
  svg.querySelector('.pf-hit').addEventListener('pointerleave', () => { tip.hidden = true; cross.setAttribute('x1', -10); cross.setAttribute('x2', -10) })
}

// ── wiring ───────────────────────────────────────────────────────────────────
let runT
function changed({ rerun = true } = {}) {
  // Edited: it is your draft now. A share link left in the address bar would put the shared
  // basket back over your changes on the next reload.
  if (/[#&]p=/.test(location.hash)) history.replaceState(null, '', location.pathname)
  saveDraft()
  renderBuilder()
  renderRunControls()
  if (rerun) { clearTimeout(runT); runT = setTimeout(run, 450) }
}

$('pfName').addEventListener('input', e => { S.name = e.target.value.slice(0, 40); saveDraft(); renderComp(); renderGallery() })
$('pfDesc').addEventListener('input', e => { S.desc = e.target.value.slice(0, 280); saveDraft(); renderComp(); renderGallery() })
$('pfWeighting').addEventListener('click', e => { const b = e.target.closest('button[data-w]'); if (!b) return; applyWeighting(b.dataset.w); changed() })
$('pfSectors').addEventListener('click', e => {
  if (wasDrag()) return                                 // the end of a drag is not a click
  const b = e.target.closest('button[data-sector]'); if (!b) return
  const k = b.dataset.sector
  const list = k === 'top' ? [...new Map(rows.slice().sort((a, b) => (b.vol24 ?? 0) - (a.vol24 ?? 0)).map(r => [r.sym, r])).values()].slice(0, 8) : sectorBasket(k)
  S.items = list.map(r => ({ coin: r.coin, sym: r.sym, kind: r.kind, w: 1, side: 'long' }))
  S.featuredId = null
  S.name = k === 'top' ? 'Top 8 by volume' : `${SECTOR_LABEL[k]} basket`
  // A starting description, saying what the basket is; yours to rewrite.
  S.desc = k === 'top' ? 'The 8 most traded markets on Hyperliquid today.' : `The 8 most traded ${SECTOR_LABEL[k]} markets on Hyperliquid today.`
  applyWeighting(S.weighting === 'custom' ? 'equal' : S.weighting)
  changed()
})
$('pfHoldings').addEventListener('input', e => {
  const k = e.target.dataset.w; if (k == null) return
  S.items[Number(k)].w = Math.max(0, Number(e.target.value) || 0)
  S.weighting = 'custom'
  saveDraft()
  // Update the shares in place: re-rendering the list would steal the focus from the box being typed in.
  $('pfHoldings').querySelectorAll('.pf-hold').forEach(row => { row.querySelector('.pf-w span').textContent = (share(S.items[Number(row.dataset.k)]) * 100).toFixed(1) + '%' })
  $('pfWeighting').querySelectorAll('button').forEach(b => b.classList.remove('is-on'))
  renderComp()
  clearTimeout(runT); runT = setTimeout(run, 700)
})
$('pfHoldings').addEventListener('change', e => { if (e.target.dataset.w != null) changed({ rerun: false }) })
$('pfHoldings').addEventListener('click', e => {
  const rm = e.target.closest('[data-rm]'), sd = e.target.closest('[data-side]')
  if (rm) { S.items.splice(Number(rm.dataset.rm), 1); if (S.weighting !== 'custom') applyWeighting(S.weighting); changed() }
  if (sd) { const i = S.items[Number(sd.dataset.side)]; i.side = i.side === 'short' ? 'long' : 'short'; changed() }
})

// Search: the most traded matches first.
const sug = $('pfSuggest')
let sugList = []
$('pfSearch').addEventListener('input', e => {
  const q = e.target.value.trim().toLowerCase()
  if (!q) { sug.hidden = true; return }
  // Ticker or display name, anywhere in it: "oil" finds BRENTOIL, WTIOIL (xyz:CL) and USOIL.
  // Exact names first, then names that start with it, then the rest; most traded first within each.
  const names = (r) => [r.sym, r.label ?? '', r.name ?? '', ...(r.keywords ?? [])].map(x => x.toLowerCase())
  const rank = (r) => { const n = names(r); return n.some(x => x === q) ? 0 : n.some(x => x.startsWith(q)) ? 1 : 2 }
  sugList = rows.filter(r => names(r).some(x => x.includes(q)) || r.coin.toLowerCase() === q)
    .sort((a, b) => rank(a) - rank(b) || (b.vol24 ?? 0) - (a.vol24 ?? 0)).slice(0, 8)
  sug.innerHTML = sugList.length ? sugList.map((r, k) => `<button data-sug="${k}" ${S.items.some(i => i.coin === r.coin) ? 'disabled' : ''}>${iconHtml(r.coin, r.sym)}<b>${esc(r.label ?? r.sym)}</b>${r.kind === 'hip3' ? `<i class="mk-b mk-b--hip3">${esc(r.dexLabel)}</i>` : r.kind === 'spot' ? '<i class="mk-b mk-b--spot">Spot</i>' : '<i class="mk-b">Perp</i>'}<small>${esc(r.category ?? '')}</small><span>${short$(r.vol24 ?? 0)} vol</span></button>`).join('')
    : `<div class="pf-empty">${marketsReady ? 'Nothing on Hyperliquid matches.' : 'Markets are still loading…'}</div>`
  sug.hidden = false
})
$('pfSearch').addEventListener('keydown', e => { if (e.key === 'Enter' && sugList[0]) { addAsset(sugList[0]); e.target.value = ''; sug.hidden = true } if (e.key === 'Escape') sug.hidden = true })
sug.addEventListener('click', e => { const b = e.target.closest('[data-sug]'); if (!b) return; addAsset(sugList[Number(b.dataset.sug)]); $('pfSearch').value = ''; sug.hidden = true; $('pfSearch').focus() })
document.addEventListener('click', e => { if (!e.target.closest('.pf-add')) sug.hidden = true })

// Saving and sharing.
const localSave = () => {
  const saved = store.get(SAVED_KEY, [])
  const name = (S.name || 'Portfolio').trim()
  const entry = { name, desc: (S.desc ?? '').trim(), items: S.items.map(i => ({ ...i })), at: Date.now() }
  const k = saved.findIndex(p => p.name === name)
  if (k >= 0) saved[k] = entry; else saved.unshift(entry)
  store.set(SAVED_KEY, saved.slice(0, 30))
}
$('pfSave').addEventListener('click', async () => {
  // A featured portfolio: the developer updates it for everyone; anyone else keeps a copy.
  if (S.featuredId && isDev()) {
    try {
      await featuredWrite('save', { portfolio: { id: S.featuredId, name: S.name, desc: S.desc, items: S.items } })
      flash($('pfSave'), 'Updated for everyone')
    } catch (e) { flash($('pfSave'), 'Not saved'); setNote(e.message) }
    renderBuilder(); return
  }
  localSave()
  const wasFeatured = !!S.featuredId
  S.featuredId = null; saveDraft()
  flash($('pfSave'), wasFeatured ? 'Saved to yours' : 'Saved')
  renderBuilder()
  loadGalleryPrices()
})
$('pfShare').addEventListener('click', async () => {
  const url = location.origin + '/portfolios#p=' + encodeShare()
  history.replaceState(null, '', '#p=' + encodeShare())
  try { await navigator.clipboard.writeText(url); flash($('pfShare'), 'Link copied') } catch { flash($('pfShare'), 'Link in the address bar') }
})
$('pfNew').addEventListener('click', () => { S.items = []; S.name = 'My portfolio'; S.desc = ''; S.weighting = 'equal'; S.featuredId = null; history.replaceState(null, '', location.pathname); changed() })

const openPortfolio = (p, featuredId = null) => {
  S.name = p.name; S.desc = p.desc ?? ''; S.items = p.items.map(i => ({ ...i })); S.weighting = 'custom'; S.featuredId = featuredId
  changed()
  $('pfBuilderSec').scrollIntoView({ behavior: 'smooth', block: 'start' })
}
const armDelete = (ref) => {
  if (delArmed === ref) return true
  delArmed = ref; clearTimeout(delT); delT = setTimeout(() => { delArmed = null; renderGallery() }, 3000); renderGallery()
  return false
}
async function galleryClick(e) {
  const saved = store.get(SAVED_KEY, [])
  if (e.target.closest('[data-featured-retry]')) { featuredState = 'loading'; renderGallery(); loadFeatured(); return }
  if (e.target.closest('[data-dev-in]')) { devSignIn(); return }
  if (e.target.closest('[data-dev-out]')) { try { localStorage.removeItem('hliq_dev') } catch {} ; renderBuilder(); return }
  const del = e.target.closest('[data-del]')
  if (del) {
    // Two taps: the first arms it, the second acts. A card is easy to brush past.
    const ref = del.dataset.del
    if (!armDelete(ref)) return
    delArmed = null
    if (ref.startsWith('f:')) {
      try { await featuredWrite('delete', { id: ref.slice(2) }); if (S.featuredId === ref.slice(2)) S.featuredId = null } catch (err) { setNote(err.message) }
      renderBuilder(); return
    }
    saved.splice(Number(ref.slice(2)), 1); store.set(SAVED_KEY, saved); renderGallery()
    return
  }
  const pub = e.target.closest('[data-pub]')
  if (pub) {
    const p = saved[Number(pub.dataset.pub.slice(2))]
    if (!p) return
    pub.disabled = true; pub.textContent = 'Publishing…'
    try { await featuredWrite('save', { portfolio: { name: p.name, desc: p.desc, items: p.items } }); setNote(`"${p.name}" is now featured for everyone.`) }
    catch (err) { setNote(err.message) }
    renderBuilder(); loadGalleryPrices(); return
  }
  if (e.target.closest('[data-new]')) { $('pfNew').click(); $('pfBuilderSec').scrollIntoView({ behavior: 'smooth', block: 'start' }); $('pfName').select(); return }
  const card = e.target.closest('[data-load]')
  if (!card) return
  const ref = card.dataset.load
  if (ref.startsWith('f:')) { const p = (featured ?? []).find(x => x.id === ref.slice(2)); if (p) openPortfolio(p, p.id) }
  else { const p = saved[Number(ref.slice(2))]; if (p) openPortfolio(p) }
}
for (const id of ['pfGallery', 'pfFeatured', 'pfDevNote']) {
  $(id).addEventListener('click', galleryClick)
  $(id).addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-load]')) { e.preventDefault(); e.target.click() } })
}
$('pfGalTf').addEventListener('click', e => {
  const b = e.target.closest('button[data-g]'); if (!b) return
  galTf = b.dataset.g; store.set(GAL_TF_KEY, galTf)
  renderGallery(); loadGalleryPrices()
})

// The app's dev mode, entered here too: the PIN is checked by the server before it is kept.
async function devSignIn() {
  const pin = (window.prompt('Developer PIN') ?? '').trim()
  if (!pin) return
  try {
    const r = await fetch('/api/leaderboard/verify-pin', { method: 'POST', headers: { 'x-lb-pin': pin } })
    if (!r.ok) { setNote(r.status === 403 ? 'That PIN was not accepted.' : 'Could not check the PIN right now.'); return }
    localStorage.setItem('hliq_lb_pin', pin); localStorage.setItem('hliq_dev', '1')
    setNote('Developer mode on.')
  } catch { setNote('Could not check the PIN right now.') }
  renderBuilder()
}
// One line under the builder's name for what Save will do, and for anything that went wrong.
let noteMsg = '', noteT
function setNote(msg) { noteMsg = msg; clearTimeout(noteT); noteT = setTimeout(() => { noteMsg = ''; renderMode() }, 6000); renderMode() }
function renderMode() {
  const el = $('pfMode')
  if (!el) return
  const dev = isDev()
  $('pfSave').textContent = S.featuredId ? (dev ? 'Update featured' : 'Save a copy') : 'Save'
  const base = S.featuredId
    ? (dev ? 'Featured portfolio. <b>Update featured</b> publishes your changes to everyone.'
           : 'Featured portfolio. Change anything and test it: nothing here changes it for anyone else. <b>Save a copy</b> keeps your version on this device.')
    : ''
  el.innerHTML = [base, noteMsg ? esc(noteMsg) : ''].filter(Boolean).join(' · ')
  el.hidden = !el.innerHTML
}

function flash(btn, text) { const t0 = btn.textContent; btn.textContent = text; btn.disabled = true; setTimeout(() => { btn.textContent = t0; btn.disabled = false }, 1400) }

// Run settings.
$('pfPeriod').addEventListener('click', e => { const b = e.target.closest('button[data-p]'); if (!b) return; S.period = b.dataset.p; S.from = S.to = null; changed() })
$('pfFrom').addEventListener('change', e => { if (e.target.value) { S.from = e.target.value; S.to = $('pfTo').value || null; changed() } })
$('pfTo').addEventListener('change', e => { if (e.target.value) { S.from = $('pfFrom').value; S.to = e.target.value; changed() } })
$('pfLev').addEventListener('click', e => { const b = e.target.closest('button[data-l]'); if (!b) return; S.lev = Number(b.dataset.l); changed() })
const num = (id, key, min, max) => $(id).addEventListener('change', e => { const v = Number(e.target.value); if (Number.isFinite(v)) { S[key] = Math.min(max, Math.max(min, v)); changed() } })
num('pfCapital', 'capital', 100, 1e9); num('pfFee', 'fee', 0, 1); num('pfBand', 'band', 1, 50); num('pfTrendDays', 'trendDays', 5, 200)
num('pfTp', 'tp', 0.1, 100); num('pfSl', 'sl', 0.1, 100)
$('pfTf').addEventListener('change', e => { S.tf = e.target.value; changed() })
$('pfBench').addEventListener('change', e => { S.bench = e.target.checked; changed() })
$('pfBoth').addEventListener('change', e => { S.both = e.target.checked; changed() })
$('pfStrats').addEventListener('click', e => { const b = e.target.closest('[data-strat]'); if (!b) return; const id = b.dataset.strat; S.strats = S.strats.includes(id) ? S.strats.filter(x => x !== id) : [...S.strats, id]; changed() })
$('pfBots').addEventListener('click', e => { const b = e.target.closest('[data-bot]'); if (!b) return; const id = b.dataset.bot; S.bots = S.bots.includes(id) ? S.bots.filter(x => x !== id) : [...S.bots, id]; changed() })
$('pfResults').addEventListener('click', e => { const b = e.target.closest('[data-focus]'); if (!b) return; focus = b.dataset.focus; renderResults() })
let rw = 0
window.addEventListener('resize', () => { if (innerWidth !== rw) { rw = innerWidth; clearTimeout(runT); runT = setTimeout(renderResults, 150) } })

// Nav (same behaviour as the landing)
const nav = $('lnNav'), burger = $('lnBurger')
burger?.addEventListener('click', () => burger.setAttribute('aria-expanded', String(nav.classList.toggle('is-open'))))
for (const a of document.querySelectorAll('[data-launch]')) a.addEventListener('click', () => { try { localStorage.setItem('hliq_app_entered', '1') } catch {} })

// ── go ───────────────────────────────────────────────────────────────────────
renderBuilder()
renderRunControls()
run()
loadFeatured()
loadMeta()
loadMarkets().catch(() => setStatus('Hyperliquid did not answer — reload to try again'))
window.__pf = { get state() { return S }, get last() { return last } }     // tests/portfolio-browser.mjs
