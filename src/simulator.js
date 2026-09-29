/**
 * INSOLVENT TERMINAL — Trade Simulator, on screen
 *
 * A backtest over Hyperliquid candles: pick markets and a strategy, run it, read what it would
 * have done — against buying and holding the same markets, with the risk it took to get there.
 * The arithmetic is in backtest.js (what a strategy DID) and btstats.js (what that adds up to);
 * this is the form, the fetch, and the report.
 *
 * Lived in main.js until it was remade. It needs six things from the app — the language, where
 * to mount, the pane header, a toast, how a typed market name resolves, and how a market is
 * labelled — and all six arrive through `initSimulator(ctx)`. It cannot see `state`, and has no
 * reason to: nothing here is per-account. It never places an order and never moves money.
 *
 * Three views of one run:
 *   RUN      one strategy over the markets in the box, with the full report.
 *   COMPARE  every strategy over the same candles, ranked — the question is rarely "does this
 *            work" but "which of these works HERE".
 *   SWEEP    one setting stepped across a range. The best row is the one most likely to be
 *            luck, so the report says how its neighbours did too.
 *
 * Candles are cached per market, interval and length for ten minutes, so comparing twelve
 * strategies or sweeping twenty values costs one fetch per market, not three hundred. The
 * limiter is per IP and shared with order placement; a simulator that trips it is a simulator
 * that makes closing a real position slower.
 */
import { runBacktest, coerceParams, BT_DEFAULTS, BT_FIELDS, BT_CHOICES, BT_OVERVIEW,
         BT_STRATEGIES, BT_MODULES, BT_STRATEGY_META, BT_CATEGORIES, strategyKind,
         tokyoWindowsFor, tokyoMarkets, runPortfolio, normalise, dcaDeviations, dcaFullDeal,
         sizePosition, effLeverage, mmRate } from './backtest.js'
import { summarize, downsample, drawdownCurve, score as _simScore, buyHold } from './btstats.js'
import { replayMarks, marksUpto, stateAt as simStateAt, openPnlAt as simOpenPnl } from './simreplay.js'
import { signalChartSvg } from './sigchart.js'
import { hlPool } from './api.js'
import { fetchCandles } from './trading.js'
import { fmtUSD, fmtPrice, esc } from './format.js'

let ctx = {
  /** The app's two-language string picker. */
  T: (en) => en,
  /** Where the pane mounts: the desktop tab if it is showing, else the mobile content. */
  viewHost: () => null,
  /** The sticky title bar with a close button, shared with every full-page pane. */
  fullHeader: (title) => `<div>${esc(title)}</div>`,
  toast: () => {},
  /** A typed market name to the id the exchange has. Shared with the bot cards. */
  resolveMarketId: (s) => String(s ?? '').trim().toUpperCase(),
  /** How a market id is shown: "xyz:SMSN" reads as SMSN. */
  coinLabel: (c) => String(c ?? ''),
  /** Every perp the app knows: [{ id, name, dex, px, vol }]. Empty until markets load. */
  markets: () => [],
  /** A market's artwork, as HTML. Only asked for the handful of search results on screen. */
  icon: () => '',
  /** Ask the app to load 24h volumes. They are only fetched when some screen needs them. */
  loadMarkets: () => Promise.resolve(),
  /** A market's max leverage on Hyperliquid, or null. It sets the maintenance margin. */
  maxLeverage: () => null,
}
export function initSimulator(overrides = {}) { ctx = { ...ctx, ...overrides } }

const _T = (en, es) => ctx.T(en, es)
const _resolveMarketId = (name) => ctx.resolveMarketId(name)
const _paperToast = (m) => ctx.toast(m)

// ── STATE ─────────────────────────────────────────────────────────────────────

const SIM_KEY = 'hliq_sim'
/**
 * ONE list of markets, chosen by you, with NO default behind it.
 *
 * Reported twice. First: "the default list keeps appearing" — Tokyo's fifteen markets, loaded
 * once, sat invisibly under every strategy. Then, with a HYPE default, per-strategy lists and a
 * "set as default" button: "lets get rid of that default and just be clear". Every version had
 * the same flaw: the list on screen was one the app had chosen, by some rule you could not see.
 *
 * So the markets are chips you put there, they stay when you change strategy — comparing
 * strategies on the same markets is the point — and nothing else ever adds one. Tokyo offers
 * its fifteen as a button, and Clear all takes them away again.
 */
let _simCoin = ''                 // the chosen markets, as comma-separated market ids
let _simIv   = '1h'
let _simCount = 2000
let _simParams = { ...BT_DEFAULTS }
let _simResult = null
let _simSum = null                // btstats summary of _simResult, with its benchmark
let _simRunMeta = null            // what the result on screen was run on: { coins, iv, count, strategy }
let _simBusy = false
let _simProgress = ''
let _simError = null
// True when a box has been touched since the run that produced what is on screen. Without
// it, changing a setting and reading the numbers still displayed looks exactly like a
// setting that does nothing -- which is how "all three directions give the same output"
// happens with three correct results sitting one keystroke apart.
let _simStale = false
let _simCat = 'all'               // strategy picker filter
let _simTab = 'overview'          // result view: overview | trades | replay | markets
let _simCmp = null                // comparison board, or null
let _simCmpSort = 'roe'
let _simSweep = null              // { key, from, to, steps, rows } after a sweep
let _simSweepKey = null

try {
  const s = JSON.parse(localStorage.getItem(SIM_KEY) || '{}')
  // An empty saved list is honoured, not treated as "nothing saved". Someone who cleared the
  // markets meant to clear them.
  if (typeof s.coin === 'string') _simCoin = s.coin
  if (typeof s.iv === 'string' && s.iv) _simIv = s.iv
  if (Number.isFinite(+s.count)) _simCount = +s.count
  if (s.params && typeof s.params === 'object') _simParams = coerceParams(s.params)
  if (typeof s.cat === 'string') _simCat = s.cat
  // Saves from before the money model existed were all 'fixed' by default rather than by
  // choice. `modelV` marks a save made after position sizing became the default, so only a
  // model somebody actually picked survives the upgrade.
  if (!s.modelV && _simParams.pnlModel === 'fixed') _simParams.pnlModel = BT_DEFAULTS.pnlModel
  if (!s.modelV) _simParams.useOnePos = BT_DEFAULTS.useOnePos
  // Saves from before v3 carry lists the old defaults put there — HYPE, or a typed-out Tokyo
  // list with the prefixes someone had to remember. Nobody can tell those from a choice, which
  // is the whole complaint, so every list starts over once, empty and explicit.
  if (!(s.modelV >= 3)) _simCoin = ''
} catch {}
function _simSave() {
  try {
    localStorage.setItem(SIM_KEY, JSON.stringify({
      coin: _simCoin, iv: _simIv, count: _simCount, params: _simParams, cat: _simCat, modelV: 3 }))
  } catch {}
}

const SIM_IVS = ['1m', '5m', '15m', '1h', '4h', '8h', '1d']
const SIM_IV_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 4 * 3600e3, '8h': 8 * 3600e3, '1d': 86400e3 }
const SIM_COUNTS = [500, 1000, 2000, 5000]

// ── FORMATTING ────────────────────────────────────────────────────────────────

const money  = (v) => (v < 0 ? '-$' : '$') + fmtUSD(Math.abs(v))
const signed = (v) => (v < 0 ? '-$' : '+$') + fmtUSD(Math.abs(v))
const pct    = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : (v >= 0 ? '+' : '') + v.toFixed(d) + '%'
const num    = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(d)
const tone   = (v) => v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--fg-2)'
/** A drawdown as a fall. Under a twentieth of a percent is none, not "-0.0%". */
const ddTxt  = (v, d = 1) => !Number.isFinite(v) || v < 0.05 ? '0.0%' : '-' + v.toFixed(d) + '%'

/** Candles held, as time. "37c" means nothing to anyone who did not pick the interval. */
function _simDur(candles, iv = _simIv) {
  if (!Number.isFinite(candles)) return '—'
  const ms = candles * (SIM_IV_MS[iv] ?? 3600e3)
  const m = ms / 60e3
  if (m < 90) return Math.round(m) + 'm'
  const h = m / 60
  if (h < 48) return (h < 10 ? h.toFixed(1) : Math.round(h)) + 'h'
  return (h / 24).toFixed(h / 24 < 10 ? 1 : 0) + 'd'
}

function _simSpanText(count = _simCount, iv = _simIv) {
  const d = count * (SIM_IV_MS[iv] ?? 3600e3) / 86400e3
  return d < 2 ? `≈ ${Math.round(d * 24)}h` : `≈ ${d < 60 ? Math.round(d) + ' ' + _T('days', 'días') : (d / 30.4).toFixed(1) + ' ' + _T('months', 'meses')}`
}

const _stratLabel = (k) => (BT_STRATEGIES.find(s => s[0] === k)?.[1] ?? k)
const _stratShort = (k) => _stratLabel(k).replace(/\s*\((bot|original script|hourly windows)\)\s*$/i, '')

// ── THE MARKET PICKER ─────────────────────────────────────────────────────────
//
// Chips for what is chosen, a search for what is not. Asked for: "add a searcher and remove
// the need of adding the hip3 market like xyz: or oi: or para:". The prefix is the id the
// exchange uses and it is still what gets fetched — but nobody types it or reads it: a result
// shows the name, with the dex that listed it as a small tag, and the SAME name on two dexes
// shows as two results, because they are two different markets.

let _simMkt = null          // { at, list, by } — every perp the app knows, cached briefly
let _simMktQ = ''           // what is in the search box

/**
 * Rebuilt on every search keystroke (`fresh`), cached for a moment otherwise. HIP-3 markets
 * arrive seconds after the main dex; a longer cache meant a search made early could not find
 * NVDA for twenty seconds, which reads as NVDA not existing.
 */
function _simMarkets(fresh = false) {
  if (fresh || !_simMkt || Date.now() - _simMkt.at > 3e3 || !_simMkt.list.length) {
    let list = []
    try { list = (ctx.markets() ?? []).filter(m => m && m.id) } catch {}
    _simMkt = { at: Date.now(), list, by: Object.fromEntries(list.map(m => [m.id, m])) }
  }
  return _simMkt
}

/** A market's name as people know it: "SMSN", never "xyz:SMSN". */
function _mktName(id) {
  return _simMarkets().by[id]?.name ?? String(id ?? '').replace(/^.*:/, '')
}
/** The dex that listed it, or '' for Hyperliquid's own. */
function _mktDex(id) {
  const m = _simMarkets().by[id]
  if (m) return m.dex ?? ''
  return String(id ?? '').includes(':') ? String(id).split(':')[0] : ''
}
const _ocCoinLabel = (c) => _mktName(c)

/**
 * Markets matching a query, best first: an exact name, then names that start with it, then
 * names or dexes that contain it — and within each, the busiest market first, because the one
 * with the volume is almost always the one meant.
 */
function _simSearch(q, limit = 8) {
  const s = String(q ?? '').trim().toLowerCase().replace(/^.*:/, '')
  const { list } = _simMarkets()
  if (!s) return []
  const rank = (m) => {
    const n = m.name.toLowerCase(), id = m.id.toLowerCase().replace(/^.*:/, '')
    if (n === s || id === s) return 0
    if (n.startsWith(s) || id.startsWith(s)) return 1
    if (n.includes(s) || id.includes(s)) return 2
    if ((m.dex ?? '').toLowerCase().includes(s)) return 3
    return 9
  }
  return list.map(m => [rank(m), m]).filter(([r]) => r < 9)
    .sort((a, b) => a[0] - b[0] || (b[1].vol ?? 0) - (a[1].vol ?? 0))
    .slice(0, limit).map(([, m]) => m)
}

/**
 * The busiest markets not already chosen, offered while the search box is empty.
 *
 * Only once volumes are actually known. Reported: "instead of popular is sorted
 * alphabetically" -- with no 24h volume loaded every market tied at zero and the sort fell
 * back to the order the exchange lists them, 0G, 2Z, AAVE. An unknown ranking is not shown
 * as a ranking; nothing is offered until the volumes arrive.
 */
function _simPopular(limit = 8) {
  const have = new Set(_simCoinList())
  const list = _simMarkets().list.filter(m => (m.vol ?? 0) > 0)
  if (!list.length) { _simLoadVolumes(); return [] }
  return list.sort((a, b) => b.vol - a.vol).filter(m => !have.has(m.id)).slice(0, limit)
}

let _simVolAsked = false
function _simLoadVolumes() {
  if (_simVolAsked) return
  _simVolAsked = true
  Promise.resolve().then(() => ctx.loadMarkets()).then(() => { _simMarkets(true); _simMktPaint() }, () => {})
    // A load refused by the rate-limit breaker is retried on a later visit, not never.
    .finally(() => setTimeout(() => { _simVolAsked = false }, 30e3))
}

function _simDexTag(dex) {
  return dex ? `<span class="sim-dex">${esc(dex)}</span>` : ''
}

function _simChipsHtml() {
  const list = _simCoinList()
  if (!list.length) {
    return `<div class="sim-mkt-empty">${_T('No markets chosen. Search below to add one or several.',
      'Sin mercados. Busca abajo para añadir uno o varios.')}</div>`
  }
  return list.map(id => `<span class="sim-mchip notranslate" title="${esc(id)}">
      ${esc(_mktName(id))}${_simDexTag(_mktDex(id))}
      <button type="button" onclick="window.__simRemoveCoin('${esc(id)}')" aria-label="${_T('Remove', 'Quitar')} ${esc(_mktName(id))}">×</button>
    </span>`).join('')
}

function _simResultsHtml() {
  const q = _simMktQ.trim()
  const have = new Set(_simCoinList())
  const known = _simMarkets().list.length > 0
  if (!q) {
    const pop = _simPopular()
    if (!pop.length) return ''
    return `<div class="sim-mkt-pop"><span class="sim-lbl-u">${_T('Most traded 24h', 'Más operados 24h')}</span>${
      pop.map(m => `<button type="button" class="sim-chip sim-chip-sm notranslate" onclick="window.__simAddCoin('${esc(m.id)}')">+ ${esc(m.name)}${m.dex ? ` <span style="opacity:.6">${esc(m.dex)}</span>` : ''}</button>`).join('')}</div>`
  }
  const hits = _simSearch(q)
  if (!hits.length) {
    return `<div class="sim-mres"><div class="sim-mres-none">${known
      ? _T(`No market called “${esc(q)}”. Press Enter to try it anyway.`, `Ningún mercado “${esc(q)}”. Enter para probarlo igual.`)
      : _T('Markets are still loading — press Enter to add it as typed.', 'Cargando mercados — Enter para añadirlo tal cual.')}</div></div>`
  }
  return `<div class="sim-mres">${hits.map((m, i) => {
    const on = have.has(m.id)
    return `<button type="button" class="sim-mres-row${i === 0 ? ' first' : ''}${on ? ' on' : ''}" onmousedown="event.preventDefault()" onclick="window.__simAddCoin('${esc(m.id)}')">
      <span class="sim-mres-i">${(() => { try { return ctx.icon(m.id) ?? '' } catch { return '' } })()}</span>
      <span class="sim-mres-n notranslate">${esc(m.name)}${_simDexTag(m.dex)}</span>
      <span class="sim-mres-p mono">${Number.isFinite(m.px) && m.px > 0 ? '$' + fmtPrice(m.px) : ''}</span>
      <span class="sim-mres-a">${on ? '✓' : '+'}</span>
    </button>`
  }).join('')}</div>`
}

/**
 * Repaint the position preview from what is in the boxes right now. Collects without
 * rebuilding, so the box being typed in keeps the keyboard.
 */
function _simPreviewPaint() {
  const pv = document.getElementById('simPreview')
  if (!pv) return
  _simCollect()
  pv.innerHTML = _simPosPreview()
}

/** Repaint the chips and the search results without touching the box being typed in. */
function _simMktPaint() {
  const c = document.getElementById('simChips')
  if (c) c.innerHTML = _simChipsHtml()
  const r = document.getElementById('simMktRes')
  if (r) r.innerHTML = _simResultsHtml()
  const clr = document.getElementById('simClearCoins')
  if (clr) clr.style.display = _simCoinList().length ? '' : 'none'
  _simPreviewPaint()
}

window.__simMktSearch = function(v) {
  _simMktQ = String(v ?? '')
  _simMarkets(true)
  const r = document.getElementById('simMktRes')
  if (r) r.innerHTML = _simResultsHtml()
}

window.__simMktKey = function(ev) {
  if (ev.key === 'Escape') { ev.target.value = ''; window.__simMktSearch(''); return }
  if (ev.key !== 'Enter') return
  ev.preventDefault()
  const q = _simMktQ.trim()
  if (!q) return
  const hit = _simSearch(q, 1)[0]
  // Nothing matched: take it as typed and let the resolver and the exchange decide. A market
  // listed this morning is not in a list loaded last night.
  window.__simAddCoin(hit ? hit.id : _resolveMarketId(q))
}

/**
 * Add a market — or take it away again if it is already chosen, which is what tapping a ticked
 * result means. The search clears and keeps focus, so a basket is typed one name after another
 * without reaching for the box each time.
 */
window.__simAddCoin = function(id) {
  if (!id) return
  const list = _simCoinList()
  const next = list.includes(id) ? list.filter(c => c !== id) : [...list, id]
  _simSetCoins(next)
  _simMktQ = ''
  const box = document.getElementById('simMktQ')
  if (box) { box.value = ''; box.focus() }
  _simMktPaint()
}

window.__simRemoveCoin = function(id) { _simSetCoins(_simCoinList().filter(c => c !== id)); _simMktPaint() }
window.__simClearCoins = function() { _simSetCoins([]); _simMktPaint() }

/**
 * The one place the chosen list changes. Chips and results are repainted in place rather than
 * the form rebuilt, so the search box keeps the keyboard; only Tokyo, whose windows depend on
 * the first market, needs the form redrawn.
 */
function _simSetCoins(ids) {
  _simCoin = ids.join(', ')
  if (_simResult && !_simStale) window.__simTouch()
  if (_simParams.strategy === 'tokyo') {
    window.__simStructural(() => { _simCoin = ids.join(', '); _simTokyoPrefill() })
    return
  }
  _simSave()
}

/** Read every box at once, so one run cannot use a mix of old and new values. */
function _simCollect() {
  const raw = {}
  for (const f of BT_FIELDS) raw[f.key] = document.getElementById('sim_' + f.key)?.value
  for (const c of BT_CHOICES) raw[c.key] = document.getElementById('sim_' + c.key)?.value
  raw.strategy = document.getElementById('sim_strategy')?.value
  raw.pnlModel = document.getElementById('sim_pnlModel')?.value
  // A missing switch means the field was not on screen, so the value in state stands --
  // reading a missing checkbox as false would silently turn a module off every time its
  // section happened to be hidden.
  for (const m of BT_MODULES) {
    const el = document.getElementById('sim_' + m.key)
    if (el) raw[m.key] = !!el.checked
    else raw[m.key] = _simParams[m.key]
  }
  // A box that is not on screen keeps its value too: coerceParams would otherwise hand every
  // other strategy's settings back to their defaults each time this one was collected.
  for (const f of BT_FIELDS) if (raw[f.key] == null) raw[f.key] = _simParams[f.key]
  for (const c of BT_CHOICES) if (raw[c.key] == null) raw[c.key] = String(_simParams[c.key])
  if (raw.strategy == null) raw.strategy = _simParams.strategy
  if (raw.pnlModel == null) raw.pnlModel = _simParams.pnlModel
  _simParams = coerceParams(raw)
  const cnt = parseInt(document.getElementById('sim_count')?.value ?? '', 10)
  if (Number.isFinite(cnt)) _simCount = Math.max(50, Math.min(5000, cnt))
  _simSave()
}

/**
 * The markets to simulate, from the box.
 *
 * Comma or space separated, so "ZEC, XMR NEAR" all mean the same thing -- people type both
 * and neither is wrong. Case is normalised but a builder-dex prefix is not: "xyz:SPCX" has
 * to survive intact or it names nothing.
 */
function _simCoinList() {
  return [...new Set(String(_simCoin ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim())
    .filter(Boolean)
    .map(_resolveMarketId)
    .filter(Boolean))]
}

/** The first market, which is what the single-market parts of the form still speak about. */
function _simFirstCoin() { return _simCoinList()[0] ?? 'BTC' }

/**
 * Load a market's windows from the Tokyo portfolio table.
 *
 * Only ever on an explicit action -- choosing the strategy, or changing the market while it
 * is chosen. Doing it on every render would overwrite windows the user had just typed.
 */
function _simTokyoPrefill() {
  const row = tokyoWindowsFor(_simFirstCoin())
  if (!row) return false
  _simParams = { ...(_simParams ?? {}),
    tokyoLongFrom: row.long[0],  tokyoLongTo: row.long[1],
    tokyoShortFrom: row.short[0], tokyoShortTo: row.short[1] }
  return true
}

// ── CONTROLS ──────────────────────────────────────────────────────────────────

/**
 * Show or hide one parameter's explanation.
 *
 * Toggles a class rather than re-rendering: the form holds half-typed numbers, and
 * rebuilding it to open a help panel would throw them away and take the keyboard with them.
 */
window.__simHelp = function(key) {
  const el = document.getElementById('simHelp_' + key)
  const btn = document.getElementById('simQ_' + key)
  if (!el) return
  const open = el.style.display === 'none' || !el.style.display
  el.style.display = open ? 'block' : 'none'
  if (btn) btn.classList.toggle('on', open)
}

window.__simOverview = function() {
  const el = document.getElementById('simOverview')
  if (!el) return
  const open = el.style.display === 'none' || !el.style.display
  el.style.display = open ? 'block' : 'none'
  const btn = document.getElementById('simOverviewBtn')
  if (btn) btn.textContent = open ? _T('Hide', 'Ocultar') : _T('How this works', 'Cómo funciona')
}

// Collects first, like every other structural change. It used to re-render straight from
// state, which threw away whatever was in the boxes but not yet committed — clear the market
// list, tap an interval, and the old list is painted back. That reads as the field refusing to
// be cleared, and it is really the interval button discarding the edit.
window.__simSetIv = function(v) { window.__simStructural(() => { _simIv = v }) }
window.__simSetCount = function(v) { window.__simStructural(() => { _simCount = v }) }

/**
 * Choosing a strategy, a money model or a module changes WHICH boxes exist, so these
 * re-render rather than toggling. Everything typed is collected first, so a half-filled
 * form survives the switch.
 */
window.__simStructural = function(fn) {
  _simCollect()
  fn()
  _simStale = !!_simResult
  _simSave()
  _simRender()
}
window.__simSetStrategy = function(v) {
  window.__simStructural(() => {
    // The markets stay: they are on screen as chips, and trying another strategy on the same
    // markets is the most common thing this screen is for.
    _simParams.strategy = v
    if (v !== 'tokyo') return
    // The rule is about the hour of the day, so a 4h or daily candle cannot express it:
    // one candle would span most of a window. Switch to hourly rather than run something
    // that looks like an answer.
    if (['4h', '8h', '1d'].includes(_simIv)) _simIv = '1h'
    _simTokyoPrefill()
  })
}
window.__simSetCat = function(v) { _simCat = v; _simSave(); window.__simStructural(() => {}) }

// The whole Tokyo portfolio in one tap. Each market still uses its own windows at run
// time, so this is a list of names rather than a setting.
window.__simLoadPortfolio = function() {
  window.__simStructural(() => {
    _simCoin = tokyoMarkets().join(', ')
    if (['4h', '8h', '1d'].includes(_simIv)) _simIv = '1h'
  })
}

window.__simSetModel = function(v) { window.__simStructural(() => { _simParams.pnlModel = v }) }
window.__simToggleModule = function() { window.__simStructural(() => {}) }
window.__simSetTab = function(v) { _simTab = v; _simRender() }

/**
 * A box changed. Only the staleness notice is repainted -- a full render would take the
 * keyboard away mid-number, which is the other way a form fights its user.
 */
window.__simTouch = function() {
  const span = document.getElementById('simSpan')
  const cnt = parseInt(document.getElementById('sim_count')?.value ?? '', 10)
  if (span && Number.isFinite(cnt)) span.textContent = _simSpanText(Math.max(50, Math.min(5000, cnt)))
  _simPreviewPaint()
  if (!_simResult || _simStale) return
  _simStale = true
  const el = document.getElementById('simStale')
  if (el) el.style.display = ''
  const res = document.getElementById('simResult')
  if (res) res.style.opacity = '0.45'
}

window.__simReset = function() {
  const strategy = _simParams.strategy
  _simParams = { ...BT_DEFAULTS, strategy }
  _simResult = null
  _simSum = null
  _simError = null
  _simSave()
  _simRender()
}

// ── FETCHING ──────────────────────────────────────────────────────────────────

let _simSkipped = []      // markets left out of the last run, and why
const _simCache = new Map()   // `${coin}|${iv}|${count}` -> { rows, at }
const SIM_CACHE_MS = 10 * 60e3

/**
 * Each market gets ITS OWN windows for Tokyo. Running one market's hours against another is
 * not a portfolio, it is the same rule fifteen times. Null means the market cannot be run.
 */
function _simParamsFor(coin, base) {
  // Every market carries its own max leverage, because that -- not the leverage chosen -- sets
  // its maintenance margin and so its liquidation price. Unknown stands in as 20x, and says so.
  const withLev = { ...base, maxLev: _simMaxLev(coin) ?? 20 }
  if (base.strategy !== 'tokyo') return withLev
  const row = tokyoWindowsFor(coin)
  if (!row) return null
  return { ...withLev, tokyoLongFrom: row.long[0], tokyoLongTo: row.long[1],
           tokyoShortFrom: row.short[0], tokyoShortTo: row.short[1] }
}

function _simMaxLev(coin) {
  let v = null
  try { v = +ctx.maxLeverage(coin) } catch {}
  return Number.isFinite(v) && v >= 1 ? v : null
}

/** Is this run sized the way Hyperliquid sizes -- a position with margin, leverage and a line? */
const _simHL = (p = _simParams) => p.pnlModel === 'notional' || ['grid', 'dca'].includes(strategyKind(p.strategy))

/**
 * Candles for every market in the list, from the cache where it is fresh.
 *
 * Fetched a few at a time, not all at once. Fifteen candleSnapshot calls in one burst
 * is exactly the shape that trips the per-IP limiter, and a rate-limited run reports "not enough
 * history" for markets that have plenty.
 */
async function _simLoad(coins) {
  const bars = {}
  const skipped = []
  let done = 0
  // Ask for the window the candle count implies, with room to spare -- Hyperliquid caps a
  // response at 5000 bars, and asking from a start time is the only way to choose which.
  const ms = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '1h': 3600e3, '4h': 4 * 3600e3, '8h': 8 * 3600e3, '1d': 86400e3 }[_simIv] ?? 3600e3
  const start = Date.now() - _simCount * ms * 1.2
  await hlPool(coins, async (coin) => {
    const key = `${coin}|${_simIv}|${_simCount}`
    const hit = _simCache.get(key)
    if (hit && Date.now() - hit.at < SIM_CACHE_MS) { bars[coin] = hit.rows; _simProg(++done, coins.length); return }
    let raw = null
    try { raw = await fetchCandles(coin, _simIv, start) }
    catch (e) {
      // Hyperliquid answers 500 for a coin it does not have, which as an error message
      // tells you nothing you can act on.
      const msg = String(e?.message ?? e)
      skipped.push(_mktName(coin) + (/500/.test(msg)
        ? _T(' (no such market on Hyperliquid)', ' (no existe en Hyperliquid)')
        : ' (' + msg.slice(0, 40) + ')'))
      return
    }
    if (!Array.isArray(raw) || raw.length < 60) { skipped.push(_mktName(coin) + ' (not enough history)'); return }
    // Kept, normalised exactly as the backtest sees them, so the replay can draw the run
    // over the same candles it was computed from. A trade's `i` indexes into THIS array;
    // re-normalising later or slicing differently would slide every marker.
    const rows = normalise(raw.slice(-_simCount))
    bars[coin] = rows
    _simCache.set(key, { rows, at: Date.now() })
    _simProg(++done, coins.length)
  }, 3)
  return { bars, skipped }
}

function _simProg(done, total) {
  _simProgress = total > 1 ? `${_T('Candles', 'Velas')} ${done}/${total}` : ''
  const el = document.getElementById('simProg')
  if (el) el.textContent = _simProgress
}

/**
 * One strategy over the loaded markets: a single result for one market, or the portfolio
 * replay for several. Several markets are one account, so the trades are replayed against one
 * balance in the order they closed rather than the per-market results being added up.
 */
function _simRunOn(bars, coins, params, skipped = null) {
  const runs = []
  for (const coin of coins) {
    if (!bars[coin]) continue
    const par = _simParamsFor(coin, params)
    if (!par) { skipped?.push(_mktName(coin) + ' (not in the portfolio table)'); continue }
    runs.push({ coin, result: runBacktest(bars[coin], par) })
  }
  if (!runs.length) return null
  if (runs.length === 1 && coins.length === 1) return runs[0].result
  if (_simHL(params)) {
    // Margin, refusals and liquidations are only real inside one account, so each market runs
    // as its own SUB-ACCOUNT -- the balance split between them, or each with all of it -- and
    // its trades are summed in dollars in the order they closed.
    const share = params.splitRisk === false ? 1 : runs.length
    const sub = runs.map(({ coin }) => {
      const par = _simParamsFor(coin, { ...params, startBalance: params.startBalance / share })
      return { coin, result: runBacktest(bars[coin], par) }
    })
    return runPortfolio(sub, { ...params, absolute: true })
  }
  return runPortfolio(runs, params)
}

const _simYield = () => new Promise(r => setTimeout(r, 0))

// ── REPLAY STATE ──────────────────────────────────────────────────────────────
// The run, played back over the market's own candles with its imagined fills landing as they
// happen. Same idea as the Portfolio replay, different subject: that one walks your real fills
// over your account curve, this one walks a rule's decisions over the price it was reacting to.
// The arithmetic is in src/simreplay.js; this is the playhead, the timer and the chrome.
let _simBars   = {}       // coin -> normalised rows from the last run
let _simRep    = null     // { coin, i, playing, speed } while the replay is open
let _simRepTimer = null
const SIM_REP_SPAN = 64   // candles visible at once — matches the Portfolio replay's frame

function _simRepClose() {
  if (_simRepTimer) { clearInterval(_simRepTimer); _simRepTimer = null }
  _simRep = null
}

// ── RUN ───────────────────────────────────────────────────────────────────────

window.__simRun = async function() {
  if (_simBusy) return
  _simCollect()
  // An empty box is allowed to stay empty, so a run can start with nothing to run. Checked
  // BEFORE the busy flag goes up: the body below is a try/catch with no finally, so returning
  // from inside it would leave _simBusy true and the panel stuck on "Running…" forever, with
  // every later run refused by the guard on the line above.
  if (!_simCoinList().length) {
    _simError = _T('Add at least one market to simulate — e.g. HYPE, or BTC, ETH.',
                   'Agrega al menos un mercado para simular — p. ej. HYPE, o BTC, ETH.')
    _simResult = null
    _simRender()
    return
  }
  _simBusy = true
  _simError = null
  _simResult = null
  _simSum = null
  _simSkipped = []
  _simTradePage = 1        // a new run starts at the top of its own list
  _simBars = {}            // last run's candles, for the replay
  _simRepClose()           // a replay of the previous run means nothing now
  _simStale = false
  _simProgress = ''
  _simRender()
  _simScrollToResults()
  try {
    const coins = _simCoinList()
    const { bars, skipped } = await _simLoad(coins)
    _simBars = bars
    const result = _simRunOn(bars, coins, _simParams, skipped)

    if (!result) {
      // Distinguishable from a bad rule: too little data is not a result.
      _simError = (skipped.length
        ? _T('Nothing could be simulated: ', 'No se pudo simular nada: ') + skipped.join(', ')
        : _T('Not enough candle history for that market and interval.',
             'No hay suficiente historial para ese mercado e intervalo.'))
    } else {
      _simResult = result
      const ran = coins.filter(c => bars[c] && _simParamsFor(c, _simParams))
      _simSum = summarize(result, bars, ran)
      _simRunMeta = { coins: ran, iv: _simIv, count: _simCount, strategy: _simParams.strategy }
      // Pressing Run is asking for the report. Landing on last run's sweep or ledger instead
      // reads as the run having done nothing.
      _simTab = 'overview'
    }
    _simSkipped = skipped
  } catch (e) {
    _simError = String(e?.message ?? e).slice(0, 160)
  }
  _simBusy = false
  _simRender()
}

/** On a phone the report is under the form; bring it into view rather than leave it there. */
function _simScrollToResults() {
  requestAnimationFrame(() => {
    const cfg = document.querySelector('.sim-config'), res = document.getElementById('simResTop')
    if (!cfg || !res) return
    if (res.getBoundingClientRect().top > cfg.getBoundingClientRect().top + 40) {
      res.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  })
}

// ── COMPARE ───────────────────────────────────────────────────────────────────

/**
 * Every strategy, each with its own current settings, over the SAME candles and markets.
 *
 * Ranked by return over drawdown by default rather than by return: raw return ranks a 20x
 * coin-flip first, and the point of a comparison is to find what earned its result.
 */
window.__simCompare = async function() {
  if (_simBusy) return
  _simCollect()
  const coins = _simCoinList()
  if (!coins.length) { window.__simRun(); return }
  _simBusy = true
  _simError = null
  _simCmp = null
  _simProgress = ''
  _simRender()
  _simScrollToResults()
  try {
    const { bars, skipped } = await _simLoad(coins)
    const loaded = coins.filter(c => bars[c])
    if (!loaded.length) {
      _simError = _T('Nothing could be simulated: ', 'No se pudo simular nada: ') + skipped.join(', ')
    } else {
      const rows = []
      for (const [key] of BT_STRATEGIES) {
        _simProgress = `${_T('Testing', 'Probando')} ${_stratShort(key)}…`
        const pe = document.getElementById('simProg')
        if (pe) pe.textContent = _simProgress
        await _simYield()
        const params = { ..._simParams, strategy: key }
        const runnable = loaded.filter(c => _simParamsFor(c, params))
        if (!runnable.length) { rows.push({ key, na: _T('none of these markets is in its table', 'ningún mercado está en su tabla') }); continue }
        const result = _simRunOn(bars, runnable, params)
        if (!result) { rows.push({ key, na: _T('no result', 'sin resultado') }); continue }
        const sum = summarize(result, null, null)
        rows.push({ key, result, sum, coins: runnable, partial: runnable.length < loaded.length })
      }
      _simCmp = { rows, bench: buyHold(bars, loaded, _simParams.startBalance), coins: loaded,
                  iv: _simIv, count: _simCount, bars, skipped }
      _simBars = bars
    }
  } catch (e) {
    _simError = String(e?.message ?? e).slice(0, 160)
  }
  _simBusy = false
  _simRender()
}

window.__simCmpSort = function(k) { _simCmpSort = k; _simRender() }
window.__simCmpClose = function() { _simCmp = null; _simRender() }

/** Open one row of the board as a full result, without fetching or running again. */
window.__simCmpPick = function(key) {
  const row = _simCmp?.rows.find(r => r.key === key && r.result)
  if (!row) return
  _simCollect()
  _simParams = { ..._simParams, strategy: key }
  _simCoin = _simCmp.coins.join(', ')
  _simResult = row.result
  _simSum = summarize(row.result, _simCmp.bars, row.coins)
  _simRunMeta = { coins: row.coins, iv: _simCmp.iv, count: _simCmp.count, strategy: key }
  _simBars = _simCmp.bars
  _simSkipped = []
  _simStale = false
  _simTab = 'overview'
  _simRepClose()
  _simTradePage = 1
  _simSave()
  _simRender()
  requestAnimationFrame(() => document.getElementById('simResult')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
}

// ── SWEEP ─────────────────────────────────────────────────────────────────────

/** Numeric settings worth stepping for the strategy on screen. */
function _simSweepable() {
  return BT_FIELDS.filter(f => f.type !== 'time' && _simFieldVisible(f) &&
    !['startBalance', 'feePct', 'gridLower', 'gridUpper', 'winPct', 'lossPct', 'riskPct', 'sizePct'].includes(f.key))
}

function _simSweepDefaults(key) {
  const f = BT_FIELDS.find(x => x.key === key)
  const v = +_simParams[key]
  const isInt = f && Number(f.step) >= 1
  let from = v * 0.5, to = v * 1.5
  if (isInt) { from = Math.max(1, Math.round(from)); to = Math.max(from + 1, Math.round(to)) }
  else { from = +from.toFixed(3); to = +to.toFixed(3) }
  if (!(to > from)) { from = 0; to = isInt ? 10 : 1 }
  return { from, to, steps: isInt ? Math.min(12, to - from + 1) : 9 }
}

window.__simSweepKey = function(k) {
  _simSweepKey = k
  const d = _simSweepDefaults(k)
  for (const [id, v] of [['simSwFrom', d.from], ['simSwTo', d.to], ['simSwSteps', d.steps]]) {
    const el = document.getElementById(id)
    if (el) el.value = v
  }
}

window.__simSweep = async function() {
  if (_simBusy) return
  _simCollect()
  const key = document.getElementById('simSwKey')?.value || _simSweepKey
  const f = BT_FIELDS.find(x => x.key === key)
  if (!f) return
  const from = parseFloat(document.getElementById('simSwFrom')?.value)
  const to = parseFloat(document.getElementById('simSwTo')?.value)
  const steps = Math.max(2, Math.min(25, parseInt(document.getElementById('simSwSteps')?.value, 10) || 9))
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === to) {
    _paperToast(_T('Give the sweep two different ends.', 'Indica dos extremos distintos.'))
    return
  }
  const coins = _simCoinList()
  if (!coins.length) { window.__simRun(); return }
  _simSweepKey = key
  _simBusy = true
  _simError = null
  _simProgress = ''
  _simRender()
  try {
    const { bars } = await _simLoad(coins)
    const isInt = Number(f.step) >= 1
    const vals = [...new Set(Array.from({ length: steps }, (_, i) => {
      const v = from + (to - from) * i / (steps - 1)
      return isInt ? Math.round(v) : +v.toFixed(4)
    }))]
    const rows = []
    for (const v of vals) {
      const params = coerceParams({ ..._simParams, [key]: v,
        ...Object.fromEntries(BT_CHOICES.map(c => [c.key, String(_simParams[c.key])])) })
      const result = _simRunOn(bars, coins, params)
      if (result) {
        const s = summarize(result, null, null)
        rows.push({ v: params[key], result, s })
      }
      _simProgress = `${esc(f.label)} = ${v}`
      const pe = document.getElementById('simProg')
      if (pe) pe.textContent = _simProgress
      await _simYield()
    }
    _simSweep = { key, from, to, steps, rows, current: _simParams[key] }
    _simTab = 'sweep'
  } catch (e) {
    _simError = String(e?.message ?? e).slice(0, 160)
  }
  _simBusy = false
  _simRender()
}

window.__simSweepApply = function(v) {
  if (!_simSweep) return
  window.__simStructural(() => { _simParams[_simSweep.key] = v })
  _paperToast(_T('Applied — press Run to see it in full.', 'Aplicado — pulsa Ejecutar para verlo completo.'))
}

// ── FORM ──────────────────────────────────────────────────────────────────────

/** The little round "?" that opens an explanation. Same control everywhere. */
function _simQ(key) {
  return `<button id="simQ_${key}" type="button" class="sim-q" onclick="window.__simHelp('${key}')"
    aria-label="${_T('What is this?', '¿Qué es esto?')}" title="${_T('What is this?', '¿Qué es esto?')}">?</button>`
}

function _simHelpHtml(key, text) {
  return `<div id="simHelp_${key}" class="sim-help" style="display:none">${esc(text)}</div>`
}

/** The coin the form is talking about, for "0.5 BTC" rather than "0.5 coins". */
function _simCoinUnit() {
  const list = _simCoinList()
  return list.length === 1 ? _mktName(list[0]) : _T('coins', 'monedas')
}

/** A field's unit, where it depends on how orders are sized. */
function _simUnit(f) {
  if (['dcaBaseUsd', 'dcaSoUsd', 'gridUsdPerLevel'].includes(f.key)) return _simParams.orderUnit === 'coin' ? _simCoinUnit() : 'USDC'
  if (f.key === 'sizeCoin') return _simCoinUnit()
  if (f.key === 'leverage') {
    const m = _simMaxLev(_simCoinList()[0])
    return m ? `x · ${_T('max', 'máx')} ${m}x` : 'x'
  }
  return f.unit
}

function _simFieldHtml(f) {
  const v = _simParams[f.key]
  return `<label class="sim-field">
    <div class="sim-lbl">
      <span class="sim-lbl-t">${esc(f.label)}</span>
      <span class="sim-lbl-u">${esc(_simUnit(f))}</span>
      <span style="flex:1"></span>
      ${_simQ(f.key)}
    </div>
    ${f.type === 'time'
      ? `<input id="sim_${f.key}" class="sim-in" type="time" value="${esc(String(v))}" oninput="window.__simTouch()">`
      : `<input id="sim_${f.key}" class="sim-in" type="number" inputmode="decimal" step="${f.step}" value="${v}" oninput="window.__simTouch()">`}
    <div class="sim-hint">${esc(f.hint)}</div>
    ${_simHelpHtml(f.key, f.help ?? '')}
  </label>`
}

function _simChoiceHtml(c) {
  return `<label class="sim-field">
    <div class="sim-lbl">
      <span class="sim-lbl-t">${esc(c.label)}</span>
      <span style="flex:1"></span>
      ${_simQ(c.key)}
    </div>
    <select id="sim_${c.key}" class="sim-in sim-sel" onchange="window.__simTouch()">
      ${c.options.map(([k, lbl]) => `<option value="${k}"${
        String(_simParams[c.key]) === k ? ' selected' : ''}>${esc(lbl)}</option>`).join('')}
    </select>
    ${_simHelpHtml(c.key, c.help ?? '')}
  </label>`
}

/** A field belongs here if it is not tied to another strategy or to an off module. */
function _simFieldVisible(f) {
  if (f.strategy && f.strategy !== _simParams.strategy) return false
  if (f.notFor?.includes(_simParams.strategy)) return false
  const kind = strategyKind(_simParams.strategy)
  const ladder = kind === 'grid' || kind === 'dca'
  // Grid and DCA are sized by their own orders; of the position settings only leverage applies.
  if (f.key === 'leverage') return _simHL()
  if (ladder && (f.group === 'riskModel' || f.group === 'fixedModel' || f.group === 'notionalModel')) return false
  if (f.key === 'sizePct') return _simParams.pnlModel === 'notional' && _simParams.sizeMode === 'pct'
  if (f.key === 'sizeUsd') return _simParams.pnlModel === 'notional' && _simParams.sizeMode === 'usd'
  if (f.key === 'sizeCoin') return _simParams.pnlModel === 'notional' && _simParams.sizeMode === 'coin'
  // Per-fill maker and taker fees for a Hyperliquid position; one flat cost for the others.
  if (f.key === 'makerFeePct' || f.key === 'takerFeePct') return !!_simParams.useFees && _simHL()
  if (f.key === 'feePct') return !!_simParams.useFees && !_simHL()
  if (f.group === 'riskModel') return _simParams.pnlModel === 'risk'
  if (f.group === 'fixedModel') return _simParams.pnlModel === 'fixed'
  if (f.group === 'notionalModel') return _simParams.pnlModel === 'notional'
  if (f.group && f.group.startsWith('use')) return !!_simParams[f.group]
  return true
}

/** Modules describe entries, so only a strategy that sits out between trades has any. */
function _simModuleVisible(m) {
  return m.key === 'useFees' || strategyKind(_simParams.strategy) === 'signal'
}

const _simGrid = (inner) => inner ? `<div class="sim-grid2">${inner}</div>` : ''

function _simCard(n, title, inner, extra = '') {
  return `<section class="sim-card">
    <div class="sim-card-h"><span class="sim-step">${n}</span><span class="sim-card-t">${title}</span><span style="flex:1"></span>${extra}</div>
    ${inner}
  </section>`
}

/**
 * What to say about the markets being simulated, if anything.
 *
 * Speaks up in exactly two cases: one market that HAS a table row, to say the windows on
 * screen are that market's own; and several markets, where each runs its own row and any
 * without one are silently skipped -- which is the case worth interrupting for, because
 * what happened is not visible in the form.
 *
 * One market with no row says nothing. The windows are on screen and editable, so there
 * is nothing hidden to warn about.
 */
function _simTokyoNote() {
  const list = _simCoinList()
  // With several markets the windows in the form apply to ALL of them, which is only right
  // for one. Say so rather than let a portfolio run quietly use ZEC's hours for XMR.
  if (list.length > 1) {
    const inTable = list.filter(c => tokyoWindowsFor(c))
    return `<div class="sim-note" style="color:${inTable.length === list.length ? 'var(--accent)' : 'var(--warn)'}">${
      _T(`${list.length} markets — each one uses ITS OWN row from the portfolio table, not the windows below. ${
            inTable.length === list.length ? 'All of them are in it.' : `${esc(list.filter(c => !tokyoWindowsFor(c)).join(', '))} ${list.length - inTable.length === 1 ? 'is' : 'are'} not in the table and will be skipped.`}`,
         `${list.length} mercados — cada uno usa su propia fila de la cartera.`)}</div>`
  }
  const row = tokyoWindowsFor(_simFirstCoin())
  const base = String(_simFirstCoin() || '').split(':').pop().toUpperCase()
  if (row) {
    return `<div class="sim-note" style="color:var(--accent)">${
      _T(`Windows below are ${esc(base)}'s own row from the portfolio table (weight ${row.weight}%).`,
         `Las ventanas son la fila de ${esc(base)} en la cartera (peso ${row.weight}%).`)}</div>`
  }
  // One market with no row in the table: nothing to say. The windows are right there,
  // editable, and a paragraph naming all fifteen every time you type a market that is not
  // one of them is noise. The multi-market case above still warns, because there the
  // markets are silently SKIPPED rather than run on the windows you can see.
  return ''
}

/** What a DCA deal can grow to, stated beside the settings that decide it. */
function _simDcaNote() {
  const id = _simCoinList()[0]
  const px = _simMarkets().by[id]?.px
  // In coins a deal is only worth something at a price; without one there is nothing honest to say.
  if (_simParams.orderUnit === 'coin' && !(px > 0)) return ''
  const p = { ..._simParams, maxLev: _simMaxLev(id) ?? 20 }
  const full = dcaFullDeal(p, px > 0 ? px : 100)
  const over = full.margin > p.startBalance
  return `<div class="sim-note" style="color:${over ? 'var(--warn)' : 'var(--fg-2)'}">${
    _T(`A full deal is a <b>${money(full.notional)}</b> position needing <b>${money(full.margin)}</b> of margin at ${effLeverage(p)}x; the last safety order rests <b>${full.lastDev.toFixed(1)}%</b> from the base price${
        over ? ` — more margin than the ${money(p.startBalance)} balance, so the last orders will be refused` : ''}.`,
       `Un trato completo es una posición de <b>${money(full.notional)}</b> con <b>${money(full.margin)}</b> de margen a ${effLeverage(p)}x; la última orden está a <b>${full.lastDev.toFixed(1)}%</b>${
        over ? ` — más margen que el balance, así que las últimas órdenes serán rechazadas` : ''}.`)}</div>`
}

function _simStrategyCard() {
  const cur = _simParams.strategy
  const strat = BT_STRATEGIES.find(s => s[0] === cur) ?? BT_STRATEGIES[0]
  const visible = BT_STRATEGIES.filter(([k]) => _simCat === 'all' || BT_STRATEGY_META[k]?.cat === _simCat || k === cur)
  const catLbl = {
    all: _T('All', 'Todas'), trend: _T('Trend', 'Tendencia'), revert: _T('Mean reversion', 'Reversión'),
    breakout: _T('Breakout', 'Ruptura'), grid: _T('Grid & DCA', 'Grid y DCA'), clock: _T('Clock', 'Horario'),
  }
  const fields = BT_FIELDS.filter(f => f.strategy && _simFieldVisible(f)).map(_simFieldHtml).join('')
  const choices = BT_CHOICES.filter(c => c.strategy === cur).map(_simChoiceHtml).join('')
  return _simCard(2, _T('Strategy', 'Estrategia'), `
    <input type="hidden" id="sim_strategy" value="${esc(cur)}">
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">${
      BT_CATEGORIES.map(([k]) => `<button type="button" class="sim-chip sim-chip-sm${_simCat === k ? ' on' : ''}" onclick="window.__simSetCat('${k}')">${esc(catLbl[k] ?? k)}</button>`).join('')}</div>
    <div class="sim-strats">${visible.map(([k, lbl]) => {
      const m = BT_STRATEGY_META[k] ?? {}
      return `<button type="button" class="sim-strat${k === cur ? ' on' : ''}" onclick="window.__simSetStrategy('${k}')">
        <span class="sim-strat-n"><span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(_stratShort(k))}</span>${
          m.bot ? `<span class="sim-badge">BOT</span>` : ''}</span>
        <span class="sim-strat-t">${esc(m.tag ?? '')}</span>
      </button>`
    }).join('')}</div>
    <div class="sim-desc">${esc(strat[2])}</div>
    ${cur === 'tokyo' ? _simTokyoNote() : ''}
    ${fields || choices ? `<div style="margin-top:12px">${_simGrid(fields + choices)}</div>` : ''}
    ${cur === 'dca' ? _simDcaNote() : ''}`)
}

function _simDataCard() {
  const n = _simCoinList().length
  return _simCard(1, _T('Markets & data', 'Mercados y datos'), `
    <div class="sim-lbl">
      <span class="sim-lbl-t">${_T('Markets', 'Mercados')}</span>
      <span style="flex:1"></span>
      ${_simParams.strategy === 'tokyo' ? `<button type="button" class="sim-link" onclick="window.__simLoadPortfolio()">${_T('Load Tokyo’s 15', 'Cargar los 15 de Tokyo')}</button>` : ''}
      <button type="button" id="simClearCoins" class="sim-link sim-link-m" style="${n ? '' : 'display:none'}" onclick="window.__simClearCoins()">${_T('Clear all', 'Quitar todos')}</button>
    </div>
    <div id="simChips" class="sim-chips">${_simChipsHtml()}</div>
    <div class="sim-msearch">
      <span class="sim-msearch-i">⌕</span>
      <input id="simMktQ" class="sim-in" type="search" autocomplete="off" autocapitalize="characters" spellcheck="false"
        value="${esc(_simMktQ)}" placeholder="${_T('Search any market — BTC, NVDA, GOLD…', 'Busca un mercado — BTC, NVDA, GOLD…')}"
        oninput="window.__simMktSearch(this.value)" onkeydown="window.__simMktKey(event)">
    </div>
    <div id="simMktRes">${_simResultsHtml()}</div>

    <div class="sim-lbl" style="margin-top:14px"><span class="sim-lbl-t">${_T('Interval', 'Intervalo')}</span></div>
    <div class="sim-seg">${SIM_IVS.map(v => `<button type="button" class="${v === _simIv ? 'on' : ''}" onclick="window.__simSetIv('${v}')">${v}</button>`).join('')}</div>

    <div class="sim-lbl" style="margin-top:14px">
      <span class="sim-lbl-t">${_T('Candles', 'Velas')}</span>
      <span style="flex:1"></span>
      <span id="simSpan" class="sim-lbl-u">${_simSpanText()}</span>
    </div>
    <div style="display:flex;gap:6px;align-items:center">
      <input id="sim_count" class="sim-in" type="number" inputmode="numeric" step="100" value="${_simCount}" oninput="window.__simTouch()" style="flex:1;min-width:0">
      ${SIM_COUNTS.map(n => `<button type="button" class="sim-chip sim-chip-sm${n === _simCount ? ' on' : ''}" onclick="window.__simSetCount(${n})">${n >= 1000 ? n / 1000 + 'k' : n}</button>`).join('')}
    </div>`)
}

function _simExitCard() {
  const cur = _simParams.strategy
  const fields = BT_FIELDS.filter(f => !f.strategy && !f.group && f.key !== 'startBalance' && _simFieldVisible(f)).map(_simFieldHtml).join('')
  const choices = BT_CHOICES.filter(c => !c.group && !c.strategy && c.key !== 'splitRisk' && !c.notFor?.includes(cur)).map(_simChoiceHtml).join('')
  if (!fields && !choices) return ''
  return _simCard(3, _T('Entry and exit', 'Entrada y salida'), _simGrid(fields + choices))
}

/** A segmented control for one of the Hyperliquid choices, backed by a hidden input _simCollect reads. */
function _simSegChoice(key, labels = {}) {
  const c = BT_CHOICES.find(x => x.key === key)
  if (!c) return ''
  return `<input type="hidden" id="sim_${key}" value="${esc(String(_simParams[key]))}">
    <div class="sim-lbl" style="margin-top:12px">
      <span class="sim-lbl-t">${esc(c.label)}</span><span style="flex:1"></span>${_simQ(key)}
    </div>
    <div class="sim-seg">${c.options.map(([k, lbl]) => `<button type="button" class="${String(_simParams[key]) === k ? 'on' : ''}" onclick="window.__simSetChoice('${key}','${k}')">${esc(labels[k] ?? lbl)}</button>`).join('')}</div>
    ${_simHelpHtml(key, c.help ?? '')}`
}

window.__simSetChoice = function(key, v) { window.__simStructural(() => { _simParams[key] = v }) }

/**
 * What the settings above would open RIGHT NOW on the first market: its size, the margin it
 * posts, and where it would be liquidated each way. The one line that makes cross against
 * isolated, and leverage, something you can see before running anything.
 */
function _simPosPreview() {
  const id = _simCoinList()[0]
  const m = _simMarkets().by[id]
  const px = m?.px
  if (!(px > 0)) return ''
  const maxLev = _simMaxLev(id)
  const p = { ..._simParams, maxLev: maxLev ?? 20 }
  const kind = strategyKind(p.strategy)
  const line = (lbl, v, colour = '') => `<div class="sim-row"><span>${lbl}</span><span${colour ? ` style="color:${colour}"` : ''}>${v}</span></div>`
  const liqTxt = (liq) => liq == null ? `<span style="color:var(--green)">${_T('none', 'ninguna')}</span>`
    : `$${fmtPrice(liq)} <span class="sim-lbl-u">(${pct((liq / px - 1) * 100, 1)})</span>`
  const levWarn = maxLev && p.leverage > maxLev
    ? `<div class="sim-note" style="color:var(--warn);margin-top:6px">${_T(`${esc(_mktName(id))} allows ${maxLev}x at most; runs use ${maxLev}x.`, `${esc(_mktName(id))} permite ${maxLev}x como máximo.`)}</div>` : ''
  const head = `<div class="sim-sub" style="margin-top:0">${_T('If opened now on', 'Si se abriera ahora en')} <span class="notranslate">${esc(_mktName(id))}</span> · $${fmtPrice(px)}</div>`
  if (kind === 'grid' || kind === 'dca') {
    if (kind === 'dca') {
      const full = dcaFullDeal(p, px)
      return `<div class="sim-inset sim-preview">${head}
        ${line(_T('Full deal', 'Trato completo'), money(full.notional))}
        ${line(_T('Margin it needs', 'Margen necesario'), money(full.margin), full.margin > p.startBalance ? 'var(--warn)' : '')}
        ${line(_T('Maintenance', 'Mantenimiento'), (mmRate(p) * 100).toFixed(2) + '% ' + _T('of position', 'de la posición'))}
      </div>${levWarn}`
    }
    return `<div class="sim-inset sim-preview">${head}
      ${line(_T('Leverage used', 'Apalancamiento'), effLeverage(p) + 'x · ' + (p.marginMode === 'isolated' ? _T('isolated', 'aislado') : _T('cross', 'cruzado')))}
      ${line(_T('Maintenance', 'Mantenimiento'), (mmRate(p) * 100).toFixed(2) + '% ' + _T('of position', 'de la posición'))}
    </div>${levWarn}`
  }
  const L = sizePosition(p.startBalance, p, px, 1), S = sizePosition(p.startBalance, p, px, -1)
  if (L.rejected) {
    return `<div class="sim-inset sim-preview">${head}<div class="sim-note" style="color:var(--warn);margin-top:4px">${
      L.rejected === 'min' ? _T('Under Hyperliquid\'s $10 minimum — every order would be refused.', 'Bajo el mínimo de $10 — toda orden sería rechazada.')
                           : _T('More margin than the balance has — every order would be refused.', 'Más margen del que hay — toda orden sería rechazada.')}</div></div>${levWarn}`
  }
  return `<div class="sim-inset sim-preview">${head}
    ${line(_T('Position', 'Posición'), `${fmtSizeCoin(L.q)} <span class="notranslate">${esc(_mktName(id))}</span> · ${money(L.notional)}`)}
    ${line(_T('Margin posted', 'Margen'), `${money(L.margin)} <span class="sim-lbl-u">${L.lev}x</span>`)}
    ${line(_T('Liquidation if long', 'Liquidación si largo'), liqTxt(L.liq), L.liq != null ? 'var(--red)' : '')}
    ${line(_T('Liquidation if short', 'Liquidación si corto'), liqTxt(S.liq), 'var(--red)')}
  </div>${levWarn}`
}

function fmtSizeCoin(q) {
  if (!Number.isFinite(q)) return '—'
  const a = Math.abs(q)
  return a >= 1000 ? q.toFixed(0) : a >= 1 ? q.toFixed(3) : q.toPrecision(3)
}

function _simMoneyCard(n) {
  const kind = strategyKind(_simParams.strategy)
  const ladder = kind === 'grid' || kind === 'dca'
  const seg = (k, lbl) => `<button type="button" class="${_simParams.pnlModel === k ? 'on' : ''}" onclick="window.__simSetModel('${k}')">${lbl}</button>`
  const multi = _simCoinList().length > 1
  const hl = _simHL()
  const posFields = BT_FIELDS.filter(f => (f.group === 'riskModel' || f.group === 'fixedModel' || f.group === 'notionalModel') && _simFieldVisible(f))
  return _simCard(n, _T('Position & margin', 'Posición y margen'), `
    ${_simGrid(BT_FIELDS.filter(f => f.key === 'startBalance').map(_simFieldHtml).join('') +
               (multi ? BT_CHOICES.filter(c => c.key === 'splitRisk').map(_simChoiceHtml).join('') : ''))}
    ${multi && hl ? `<div class="sim-note">${_T(
      'Each market trades its own sub-account — the balance split between them, or all of it each — with its own margin and liquidations, as separate isolated wallets would.',
      'Cada mercado opera su propia subcuenta, con su propio margen y liquidaciones.')}</div>` : ''}
    ${ladder ? '' : `
    <input type="hidden" id="sim_pnlModel" value="${esc(_simParams.pnlModel)}">
    <div class="sim-lbl" style="margin-top:14px">
      <span class="sim-lbl-t">${_T('How a result is sized', 'Cómo se dimensiona')}</span>
      <span style="flex:1"></span>
      ${_simQ('pnlModel')}
    </div>
    <div class="sim-seg">
      ${seg('notional', _T('Hyperliquid', 'Hyperliquid'))}
      ${seg('fixed', _T('Fixed %', 'Fijo %'))}
      ${seg('risk', _T('Risk-based', 'Por riesgo'))}
    </div>
    ${_simHelpHtml('pnlModel', _T(
      'Hyperliquid sizes each trade as a real position: a size, a leverage, margin posted in cross or isolated, per-fill maker and taker fees, the $10 minimum, and a liquidation price computed the way the exchange computes it. Fixed adds or subtracts a flat percentage of the balance, so the size of the price move does not affect the result -- the levels decide whether you won, these settings decide by how much, and keeping them consistent is on you. Risk-based sets what a stop costs and pays a win that multiplied by the reward-to-risk the levels imply, so changing the target changes the payout by itself.',
      'Hyperliquid dimensiona cada operación como una posición real: tamaño, apalancamiento, margen cruzado o aislado, comisiones maker y taker y precio de liquidación. Fijo suma o resta un porcentaje del balance. Por riesgo dimensiona según la distancia al stop.'))}`}
    ${hl ? `
      ${_simSegChoice('marginMode')}
      ${ladder ? _simSegChoice('orderUnit', { coin: _simCoinUnit() }) : _simSegChoice('sizeMode', { coin: _simCoinUnit() })}` : ''}
    ${posFields.length ? `<div style="margin-top:12px">${_simGrid(posFields.map(_simFieldHtml).join(''))}</div>` : ''}
    ${hl ? `<div id="simPreview" style="margin-top:12px">${_simPosPreview()}</div>` : ''}`)
}

function _simModulesCard(n) {
  // A module is a switch plus whatever it reveals, so the thing it configures cannot be
  // set while it is off and quietly ignored.
  const moduleRow = (m) => {
    const on = !!_simParams[m.key]
    const inner = BT_FIELDS.filter(f => f.group === m.key).map(_simFieldHtml).join('') +
                  BT_CHOICES.filter(c => c.group === m.key).map(_simChoiceHtml).join('')
    return `<div class="sim-mod${on ? ' on' : ''}">
      <label class="sim-mod-h">
        <span style="min-width:0;flex:1">
          <span class="sim-mod-n">${esc(m.label)}</span>
          <span class="sim-mod-b">${esc(m.blurb)}</span>
        </span>
        <input id="sim_${m.key}" type="checkbox" class="sim-sw" ${on ? 'checked' : ''} onchange="window.__simToggleModule()">
      </label>
      ${on && inner ? `<div class="sim-mod-body">${_simGrid(inner)}</div>` : ''}
    </div>`
  }
  const mods = BT_MODULES.filter(_simModuleVisible)
  return _simCard(n, _T('Modules', 'Módulos'), `
    <div class="sim-hint" style="margin:-4px 0 10px">${
      strategyKind(_simParams.strategy) === 'signal'
        ? _T('Switch one off and run again to see what it was contributing.', 'Apaga uno y vuelve a ejecutar para ver qué aportaba.')
        : _T('This strategy never sits out, so the entry modules have nothing to act on.', 'Esta estrategia nunca está fuera, así que los módulos de entrada no aplican.')}</div>
    <div class="sim-mods">${mods.map(moduleRow).join('')}</div>`)
}

function _simConfigHtml() {
  const exit = _simExitCard()
  return `
    ${_simDataCard()}
    ${_simStrategyCard()}
    ${exit}
    ${_simMoneyCard(exit ? 4 : 3)}
    ${_simModulesCard(exit ? 5 : 4)}
    <div class="sim-runbar">
      <button type="button" class="sim-btn sim-btn-p" onclick="window.__simRun()" ${_simBusy ? 'disabled' : ''}>${
        _simBusy ? _T('Running…', 'Ejecutando…') : '▶ ' + _T('Run backtest', 'Ejecutar')}</button>
      <button type="button" class="sim-btn" onclick="window.__simCompare()" ${_simBusy ? 'disabled' : ''} title="${
        _T('Run every strategy on these markets and rank them', 'Ejecuta todas las estrategias y ordénalas')}">⇅ ${_T('Compare all', 'Comparar')}</button>
      <button type="button" class="sim-btn sim-btn-i" onclick="window.__simReset()" title="${_T('Defaults', 'Predeterminado')}" aria-label="${_T('Defaults', 'Predeterminado')}">↺</button>
    </div>`
}

// ── RESULTS: charts ───────────────────────────────────────────────────────────

let _simEq = null         // what the equity chart drew, for the hover readout

/**
 * The balance over the run, against holding the same markets, with the drawdown under it.
 *
 * Drawn to a fixed viewBox and stretched to the card, with non-scaling strokes so a line is
 * the same weight on a phone and a monitor. Labels are HTML beside it rather than SVG text,
 * which would shrink to nothing on a narrow screen.
 */
function _simEquityHtml(sum, startBal, stepped) {
  const pts = downsample(sum.curve, 600)
  if (pts.length < 2) return ''
  const bpts = sum.bench ? downsample(sum.bench.curve, 600) : []
  const W = 1000, H = 240, DH = 70
  const t0 = Math.min(pts[0][0], bpts[0]?.[0] ?? Infinity)
  const t1 = Math.max(pts[pts.length - 1][0], bpts[bpts.length - 1]?.[0] ?? -Infinity)
  const vals = [...pts.map(p => p[1]), ...bpts.map(p => p[1]), startBal]
  let lo = Math.min(...vals), hi = Math.max(...vals)
  const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1
  lo -= pad; hi += pad
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * W
  const y = (v) => 6 + (1 - (v - lo) / (hi - lo)) * (H - 12)
  const R = (n) => Math.round(n * 10) / 10
  let d = ''
  pts.forEach(([t, v], i) => {
    if (i && stepped) d += `H${R(x(t))}V${R(y(v))}`
    else d += `${i ? 'L' : 'M'}${R(x(t))},${R(y(v))}`
  })
  const area = `${d}V${H}H${R(x(pts[0][0]))}Z`
  const bd = bpts.map(([t, v], i) => `${i ? 'L' : 'M'}${R(x(t))},${R(y(v))}`).join('')
  const dd = drawdownCurve(pts)
  const ddMin = Math.min(-0.01, ...dd.map(p => p[1]))
  const dy = (v) => 2 + (v / ddMin) * (DH - 4)
  const ddPath = dd.map(([t, v], i) => `${i ? 'L' : 'M'}${R(x(t))},${R(dy(v))}`).join('') + `L${W},2L0,2Z`
  const end = pts[pts.length - 1][1]
  const up = end >= startBal
  _simEq = { pts, bpts, t0, t1, start: startBal }
  const when = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: '2-digit' })
  return `
    <div class="sim-eq" onpointermove="window.__simEqHover(event)" onpointerleave="window.__simEqHover(null)">
      <div class="sim-eq-legend">
        <span><i style="background:${up ? 'var(--green)' : 'var(--red)'}"></i>${_T('Strategy', 'Estrategia')}</span>
        ${bpts.length ? `<span><i class="dash"></i>${_T('Buy & hold', 'Comprar y mantener')}</span>` : ''}
        <span style="flex:1"></span>
        <span id="simEqTip" class="sim-eq-tip"></span>
      </div>
      <div style="position:relative">
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="sim-eq-svg" style="height:200px">
          <defs><linearGradient id="simEqG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${up ? 'var(--green)' : 'var(--red)'}" stop-opacity=".22"/>
            <stop offset="1" stop-color="${up ? 'var(--green)' : 'var(--red)'}" stop-opacity="0"/></linearGradient></defs>
          <line x1="0" x2="${W}" y1="${R(y(startBal))}" y2="${R(y(startBal))}" stroke="var(--border2)" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"/>
          <path d="${area}" fill="url(#simEqG)"/>
          ${bd ? `<path d="${bd}" fill="none" stroke="var(--fg-3)" stroke-width="1.3" stroke-dasharray="5 4" vector-effect="non-scaling-stroke" opacity=".85"/>` : ''}
          <path d="${d}" fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
        </svg>
        <div id="simEqLine" class="sim-eq-cross" style="display:none"></div>
        <span class="sim-eq-y" style="top:2px">${money(hi - pad)}</span>
        <span class="sim-eq-y" style="bottom:2px">${money(lo + pad)}</span>
      </div>
      <div class="sim-eq-dd">
        <svg viewBox="0 0 ${W} ${DH}" preserveAspectRatio="none" class="sim-eq-svg" style="height:56px">
          <path d="${ddPath}" fill="var(--red)" fill-opacity=".18" stroke="var(--red)" stroke-width="1.2" vector-effect="non-scaling-stroke"/>
        </svg>
        <span class="sim-eq-y" style="top:2px">${_T('Drawdown', 'Caída')}</span>
        <span class="sim-eq-y" style="bottom:2px">${ddMin.toFixed(1)}%</span>
      </div>
      <div class="sim-eq-x"><span>${esc(when(t0))}</span><span>${esc(when(t1))}</span></div>
    </div>`
}

/** The readout over the equity chart: nearest point to the pointer, and the benchmark there. */
window.__simEqHover = function(ev) {
  const tip = document.getElementById('simEqTip'), line = document.getElementById('simEqLine')
  if (!tip || !_simEq) return
  if (!ev) { tip.textContent = ''; if (line) line.style.display = 'none'; return }
  const box = ev.currentTarget.getBoundingClientRect()
  const f = Math.max(0, Math.min(1, (ev.clientX - box.left) / Math.max(1, box.width)))
  const t = _simEq.t0 + f * (_simEq.t1 - _simEq.t0)
  const near = (arr) => {
    if (!arr.length) return null
    let lo = 0, hi = arr.length - 1
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (arr[m][0] <= t) lo = m; else hi = m - 1 }
    return arr[lo]
  }
  const p = near(_simEq.pts), b = near(_simEq.bpts)
  if (!p) return
  const r = (p[1] / _simEq.start - 1) * 100
  tip.innerHTML = `${esc(new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))} · <b style="color:${tone(r)}">${money(p[1])} (${pct(r, 1)})</b>${
    b ? ` · ${_T('hold', 'mant.')} ${pct((b[1] / _simEq.start - 1) * 100, 1)}` : ''}`
  if (line) { line.style.display = ''; line.style.left = (f * 100) + '%' }
}

/** Calendar months as a heat table: the shape of a return, which a single number hides. */
function _simMonthsHtml(months) {
  if (!months?.length || months.length < 2) return ''
  const years = [...new Set(months.map(m => m.year))]
  const mon = Array.from({ length: 12 }, (_, i) => new Date(2020, i, 1).toLocaleDateString(undefined, { month: 'narrow' }))
  const cell = (m) => {
    if (!m || m.ret == null) return `<td class="sim-mo-e"></td>`
    const a = Math.min(1, Math.abs(m.ret) / 20)
    const bg = m.ret >= 0 ? `color-mix(in srgb, var(--green) ${Math.round(12 + a * 55)}%, transparent)`
                          : `color-mix(in srgb, var(--red) ${Math.round(12 + a * 55)}%, transparent)`
    return `<td style="background:${bg}" title="${m.ret.toFixed(2)}%">${Math.abs(m.ret) >= 10 ? Math.round(m.ret) : m.ret.toFixed(1)}</td>`
  }
  return `<div class="sim-sub">${_T('Monthly returns', 'Retornos mensuales')} <span class="sim-lbl-u">%</span></div>
    <div data-dragscroll class="sim-scrollx"><table class="sim-mo">
      <thead><tr><th></th>${mon.map(m => `<th>${esc(m)}</th>`).join('')}<th>${_T('Yr', 'Año')}</th></tr></thead>
      <tbody>${years.map(y => {
        const row = Array.from({ length: 12 }, (_, i) => months.find(m => m.year === y && m.month === i))
        const yr = row.filter(Boolean).reduce((a, m) => a * (1 + (m.ret ?? 0) / 100), 1)
        return `<tr><th>${String(y).slice(2)}</th>${row.map(cell).join('')}<td class="sim-mo-y" style="color:${tone(yr - 1)}">${((yr - 1) * 100).toFixed(1)}</td></tr>`
      }).join('')}</tbody>
    </table></div>`
}

function _simSpark(curve, w = 96, h = 26) {
  const pts = downsample(curve ?? [], 60)
  if (pts.length < 2) return ''
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0]
  const vs = pts.map(p => p[1]), lo = Math.min(...vs), hi = Math.max(...vs)
  const x = (t) => ((t - t0) / Math.max(1, t1 - t0)) * w
  const y = (v) => h - 2 - ((v - lo) / Math.max(1e-9, hi - lo)) * (h - 4)
  const up = vs[vs.length - 1] >= vs[0]
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;flex-shrink:0"><path d="${
    pts.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${up ? 'var(--green)' : 'var(--red)'}" stroke-width="1.5"/></svg>`
}

// ── RESULTS: sections ─────────────────────────────────────────────────────────

/**
 * Per-market rows under a portfolio result.
 *
 * The numbers come from the SHARED run, not from each market's own -- so they add up to
 * the total above them. Rows taken from separate single-market runs would each describe a
 * different hypothetical account and sum to something that never happened.
 */
function _simMarketsHtml(r) {
  if (!Array.isArray(r.byMarket) || r.byMarket.length < 2) return ''
  const hold = (coin) => {
    const rows = _simBars[coin]
    return rows?.length > 1 ? (rows[rows.length - 1].c / rows[0].c - 1) * 100 : null
  }
  return `
    <div class="sim-lbl" style="margin-bottom:8px">
      <span class="sim-sub" style="margin:0">${_T('By market', 'Por mercado')}</span>
      <span style="flex:1"></span>
      <span class="sim-lbl-u">${r.splitRisk
        ? _T('risk split ' + r.byMarket.length + ' ways', 'riesgo repartido entre ' + r.byMarket.length)
        : _T('each at full risk', 'cada uno a riesgo completo')}</span>
    </div>
    <div class="sim-table">
      <div class="sim-tr sim-th">
        <span style="flex:1">${_T('Market', 'Mercado')}</span>
        <span class="c">${_T('Trades', 'Ops')}</span><span class="c">${_T('Win', 'Acierto')}</span>
        <span class="c">${_T('Hold', 'Mant.')}</span><span class="c w">${_T('Net', 'Neto')}</span>
      </div>
      ${r.byMarket.map(m => { const h = hold(m.coin); return `
        <div class="sim-tr">
          <span class="notranslate" style="flex:1;font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(_ocCoinLabel(m.coin))}</span>
          <span class="c">${m.trades}</span>
          <span class="c">${m.winRate == null ? '—' : m.winRate.toFixed(0) + '%'}</span>
          <span class="c" style="color:${tone(h ?? 0)}">${pct(h, 1)}</span>
          <span class="c w mono" style="color:${tone(m.netPnl)}">${signed(m.netPnl)}</span>
        </div>`}).join('')}
    </div>
    <div class="sim-hint" style="margin-top:8px">${
      _T('One account, not one per market: every trade was applied to the same balance in the order it closed, so these add up to the total above. Hold is what buying that market alone did.',
         'Una sola cuenta: cada operación se aplicó al mismo balance en el orden en que cerró, así que estas filas suman el total de arriba.')}</div>`
}

/**
 * Every trade the run took, so a result can be checked rather than believed.
 *
 * A summary says a rule won 47% of the time; it cannot say whether the entries were where
 * you would have taken them, or whether one outlier carried the whole number. This is the
 * ledger behind the figures: when it opened, at what price, when and where it closed, and
 * what that did to the balance.
 *
 * Newest first, in pages, because a fifteen-market portfolio run produces a couple of
 * thousand of them and rendering that at once locks the phone for seconds.
 */
let _simTradePage = 1
// 'new' = newest first, 'old' = oldest first. Not a sort on a chosen timestamp: it keeps
// or reverses the order the engine produced, which is the order the trades ACTED on the
// balance. Sorting by open time instead would put the deltas out of sequence, so the
// running result they describe would stop adding up down the page.
let _simTradeOrder = 'new'
const _SIM_TRADES_PER_PAGE = 50

window.__simMoreTrades = function() {
  _simTradePage++
  _simRender()
}
// Flipping the order keeps however many rows are already loaded, so it shows the same
// number from the other end rather than collapsing back to the first page.
window.__simTradeOrder = function() {
  _simTradeOrder = _simTradeOrder === 'new' ? 'old' : 'new'
  _simRender()
}

function _simTradesHtml(r) {
  const all = (r?.trades ?? [])
  if (!all.length) return `<div class="sim-empty-s">${_T('No trades in this run.', 'Sin operaciones en esta ejecución.')}</div>`
  const when   = (t) => t ? new Date(t).toLocaleString(undefined,
    { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—'
  const outCol = { win: 'var(--green)', loss: 'var(--red)', open: 'var(--warn)' }

  // Newest first by default: the end of a run is what you are usually checking.
  const ordered = _simTradeOrder === 'old' ? [...all] : [...all].reverse()
  const shown = ordered.slice(0, _simTradePage * _SIM_TRADES_PER_PAGE)
  const multi = Array.isArray(r.byMarket) && r.byMarket.length > 1

  const row = (t) => {
    const held = t.heldFor != null ? _simDur(t.heldFor, _simRunMeta?.iv) : ''
    return `<div class="sim-trade">
      <span class="sim-trade-s" style="color:${t.side === 'long' ? 'var(--green)' : 'var(--red)'}">${t.side === 'long' ? '↑' : '↓'}</span>
      <span style="min-width:0;flex:1">
        <span class="mono">${fmtPrice(t.entry)}</span>
        <span style="color:var(--muted)"> → </span>
        <span class="mono">${t.exitPx != null ? fmtPrice(t.exitPx) : '—'}</span>
        ${multi ? `<span class="notranslate" style="color:var(--accent);font-weight:700;margin-left:5px">${esc(_ocCoinLabel(t.coin ?? ''))}</span>` : ''}
        ${t.so ? `<span class="sim-badge" style="margin-left:5px">${t.so} SO</span>` : ''}
        ${Number.isFinite(t.q) ? `<span class="sim-lbl-u" style="margin-left:5px">${fmtSizeCoin(t.q)}</span>` : ''}
        <span style="display:block;color:var(--muted);font-size:10px;margin-top:2px">${
          esc(when(t.time))}${t.exitAt ? ' → ' + esc(when(t.exitAt)) : ''}${held ? ' · ' + held : ''}${
          t.liqPx ? ` · <span style="color:var(--red)">liq $${fmtPrice(t.liqPx)}</span>` : ''}${
          t.mae > 0 ? ` · ${_T('worst', 'peor')} -${t.mae.toFixed(1)}%` : ''}</span>
      </span>
      <span style="flex-shrink:0;text-align:right">
        <span class="mono" style="font-weight:700;color:${tone(t.delta ?? 0)}">${
          Number.isFinite(t.delta) ? signed(t.delta) : '—'}</span>
        <span style="display:block;font-size:9.5px;text-transform:uppercase;letter-spacing:.05em;color:${outCol[t.outcome] ?? 'var(--muted)'}">${esc(t.liq ? _T('liquidated', 'liquidada') : t.outcome)}</span>
      </span>
    </div>`
  }

  return `
    <div class="sim-lbl" style="margin-bottom:8px">
      <span class="sim-sub" style="margin:0">${_T('Every trade', 'Cada operación')} <span class="sim-lbl-u">${all.length}</span></span>
      <span style="flex:1"></span>
      <button type="button" class="sim-chip sim-chip-sm" onclick="window.__simTradeOrder()">${
        _simTradeOrder === 'old' ? _T('Oldest first ↑', 'Más antiguas ↑') : _T('Newest first ↓', 'Más recientes ↓')}</button>
    </div>
    <div class="sim-table">
      <div class="sim-tr sim-th">
        <span style="width:12px;flex-shrink:0"></span>
        <span style="flex:1">${_T('Entry → exit', 'Entrada → salida')}</span>
        <span style="flex-shrink:0">${_T('Result', 'Resultado')}</span>
      </div>
      ${shown.map(row).join('')}
    </div>
    ${shown.length < ordered.length ? `<button type="button" class="sim-btn" style="width:100%;margin-top:8px" onclick="window.__simMoreTrades()">${
      _T(`Show ${Math.min(_SIM_TRADES_PER_PAGE, ordered.length - shown.length)} more · ${shown.length} of ${ordered.length}`,
         `Ver ${Math.min(_SIM_TRADES_PER_PAGE, ordered.length - shown.length)} más · ${shown.length} de ${ordered.length}`)}</button>` : ''}
    <div class="sim-hint" style="margin-top:8px">${
      _T('The result column is what each trade did to the balance at the time, so the same rule pays more when the balance is bigger.',
         'El resultado es lo que cada operación hizo al balance en ese momento, así que la misma regla paga más cuando el balance es mayor.')}</div>`
}

// ── REPLAY ────────────────────────────────────────────────────────────────────

/**
 * The trades belonging to one market.
 *
 * A portfolio run replays every market's trades against ONE balance, so its trade list is a
 * single sequence with a `coin` on each row; a one-market run has no such field because there
 * is nothing to tell apart. Filtering on a field that does not exist would return nothing and
 * draw an empty replay over a run that made forty trades.
 */
function _simRepTrades(coin) {
  const all = _simResult?.trades ?? []
  return all.some(t => t?.coin) ? all.filter(t => t.coin === coin) : all
}

/** Markets from the last run that have candles kept for them. */
function _simRepCoins() {
  const ran = _simRunMeta?.coins ?? Object.keys(_simBars)
  return ran.filter(c => (_simBars[c]?.length ?? 0) > 3)
}

window.__simReplayOpen = function(coin) {
  const coins = _simRepCoins()
  const pick = coins.includes(coin) ? coin : coins[0]
  if (!pick) return
  // Starts at the first frame and PAUSED. A replay that begins playing the moment it opens has
  // already shown you something before you were looking at it.
  _simRep = { coin: pick, i: 0, playing: false, speed: 1 }
  _simTab = 'replay'
  _simRender()
}

window.__simReplayClose = function() { _simRepClose(); _simRender() }

window.__simReplayMarket = function(coin) {
  if (!_simRep) return
  const was = _simRep.playing
  _simRepStop()
  _simRep = { ..._simRep, coin, i: 0, playing: false }
  if (was) window.__simReplayPlay()
  else _simRender()
}

function _simRepStop() {
  if (_simRepTimer) { clearInterval(_simRepTimer); _simRepTimer = null }
  if (_simRep) _simRep.playing = false
}

window.__simReplayPlay = function() {
  if (!_simRep) return
  if (_simRep.playing) { _simRepStop(); _simRender(); return }
  const rows = _simBars[_simRep.coin] ?? []
  // Restart from the beginning rather than sitting on the last frame doing nothing.
  if (_simRep.i >= rows.length - 1) _simRep.i = 0
  _simRep.playing = true
  _simRepTimer = setInterval(() => {
    if (!_simRep) return _simRepStop()
    const n = (_simBars[_simRep.coin] ?? []).length
    if (_simRep.i >= n - 1) { _simRepStop(); _simRepPaint(); return }
    _simRep.i++
    _simRepPaint()
  }, Math.max(16, Math.round(90 / (_simRep.speed || 1))))
  _simRender()
}

window.__simReplaySpeed = function(v) {
  if (!_simRep) return
  const playing = _simRep.playing
  _simRepStop()
  _simRep.speed = Math.max(0.25, Math.min(16, parseFloat(v) || 1))
  if (playing) window.__simReplayPlay()
  else _simRender()
}

window.__simReplaySeek = function(v) {
  if (!_simRep) return
  const rows = _simBars[_simRep.coin] ?? []
  _simRep.i = Math.max(0, Math.min(rows.length - 1, parseInt(v, 10) || 0))
  _simRepPaint()
}

window.__simReplayStep = function(d) {
  if (!_simRep) return
  _simRepStop()
  const rows = _simBars[_simRep.coin] ?? []
  _simRep.i = Math.max(0, Math.min(rows.length - 1, _simRep.i + (d | 0)))
  _simRender()
}

/**
 * Repaint just the replay, not the whole tab.
 *
 * A frame lands every ~90ms at 1×. Re-rendering the simulator from the top at that rate would
 * rebuild every input on the screen thirty times a second, which throws away focus, closes the
 * help popovers and makes the settings unusable while a replay is running.
 */
function _simRepPaint() {
  const el = document.getElementById('simReplayBody')
  if (!el) { _simRender(); return }
  el.innerHTML = _simRepBodyHtml()
  const sk = document.getElementById('simRepSeek')
  if (sk && _simRep) sk.value = String(_simRep.i)
  // The counter sits OUTSIDE the repainted body, next to the scrubber, so it has to be told
  // as well — otherwise it reads "1/2000" while the playhead is three quarters of the way in.
  const ct = document.getElementById('simRepCount')
  if (ct && _simRep) ct.textContent = (_simRep.i + 1) + '/' + ((_simBars[_simRep.coin] ?? []).length || 1)
}

/** The stake an open trade is marked against, for the running line beside the replay. */
function _simRepStakeFrac() {
  const p = _simResult?.params ?? {}
  if (p.pnlModel === 'notional') return (p.sizePct ?? 100) / 100 * Math.max(1, p.leverage ?? 1)
  return (p.riskPct ?? 0) / 100
}

function _simRepBodyHtml() {
  if (!_simRep) return ''
  const rows = _simBars[_simRep.coin] ?? []
  if (rows.length < 4) return `<div class="sim-empty-s">${
    _T('No candles kept for this market.', 'No hay velas guardadas para este mercado.')}</div>`
  const i     = Math.max(0, Math.min(rows.length - 1, _simRep.i))
  const t     = +rows[i].t
  const px    = +rows[i].c
  const start = _simResult?.startBalance ?? 0
  const trades = _simRepTrades(_simRep.coin)
  const marks  = marksUpto(replayMarks(trades), t)
  const st     = simStateAt(trades, t, start)

  const chart = signalChartSvg({
    main: rows.map(r => [r.t, r.c]),
    candles: rows,
    grid: true,
    // Ordinal, like the Portfolio replay: candles are one slot each, so a window that is
    // partly in the future still draws the revealed ones at their true width instead of
    // stretching four of them across the frame.
    ordinal: true,
    // Ends AT the playhead. The axis only ever scales to what has been revealed, so the
    // chart cannot hint at where price is about to go.
    from: i + 1 - SIM_REP_SPAN, to: i + 1,
    mainLabel: esc(_ocCoinLabel(_simRep.coin)),
    fmtPrice: (v) => '$' + fmtPrice(v),
    height: 190,
    // Only the last few are labelled: forty labels over sixty candles is a wall of text.
    // An exit says what it made, an entry says which way it went.
    markers: marks.map((m, k) => ({
      t: m.t, v: m.v, buy: m.buy,
      label: k < marks.length - 3 ? ''
        : m.kind === 'exit'
          ? `${(m.delta ?? 0) >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(m.delta ?? 0))}`
          : (m.side === 'long' ? _T('LONG', 'LARGO') : _T('SHORT', 'CORTO')),
    })),
  })

  const when = new Date(t).toLocaleString(undefined,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const stat = (label, value, colour = '') => `<div style="min-width:66px">
    <div class="sim-kpi-l">${label}</div>
    <div class="mono" style="font-size:13px;font-weight:800;margin-top:2px;${colour ? `color:${colour}` : ''}">${value}</div>
  </div>`

  // What is open RIGHT NOW, marked to the revealed close. Unrealised on purpose: it is not in
  // the balance beside it, and saying so is the difference between a replay and a highlight
  // reel.
  const op = st.open
  const openPnl = !op ? null
    : Number.isFinite(op.q) ? (op.side === 'long' ? 1 : -1) * op.q * (px - op.entry)
    : simOpenPnl(op, px, start, _simRepStakeFrac())
  const openTxt = !op ? '—'
    : `${op.side === 'long' ? _T('LONG', 'LARGO') : _T('SHORT', 'CORTO')} @ $${fmtPrice(op.entry)}`

  return `
    <div class="sim-inset" style="overflow:hidden;padding:0">
      ${chart.svg
        ? `<div style="padding:4px 2px 0">${chart.svg}</div>`
        : `<div class="sim-empty-s" style="height:190px;display:flex;align-items:center;justify-content:center">${
            _T('Not enough of this market to draw yet.', 'Aún no hay suficiente para dibujar.')}</div>`}
      <div style="display:flex;flex-wrap:wrap;gap:14px;padding:9px 12px 11px;border-top:1px solid var(--border)">
        ${stat(_T('At', 'En'), esc(when))}
        ${stat(_T('Price', 'Precio'), '$' + fmtPrice(px))}
        ${stat(_T('Balance', 'Balance'), money(st.balance), tone(st.netPnl))}
        ${stat(_T('Net', 'Neto'), signed(st.netPnl), tone(st.netPnl))}
        ${stat(_T('Closed', 'Cerradas'), `${st.closed}`)}
        ${stat(_T('W / L', 'G / P'), `${st.won} / ${st.lost}`)}
        ${stat(_T('Open', 'Abierta'), openTxt, op ? tone(openPnl ?? 0) : '')}
        ${op && openPnl != null ? stat(_T('Unrealised', 'No realizado'), signed(openPnl), tone(openPnl)) : ''}
      </div>
    </div>`
}

/** The replay panel: the opener, or the player once it is open. */
function _simReplayHtml() {
  if (!_simResult) return ''
  const coins = _simRepCoins()
  if (!coins.length) return ''
  if (!_simRep) {
    return `<div class="sim-empty-s" style="padding:26px 10px">
      <button type="button" class="sim-btn sim-btn-p" onclick="window.__simReplayOpen('${esc(coins[0])}')">▶ ${_T('Replay this run', 'Reproducir esta ejecución')}</button>
      <div style="margin-top:8px">${_T('Play the candles forward and watch where the rule would have bought and sold.',
           'Reproduce las velas y observa dónde la regla habría comprado y vendido.')}</div></div>`
  }
  const rows = _simBars[_simRep.coin] ?? []
  const last = Math.max(0, rows.length - 1)
  const spd  = _simRep.speed
  const spdBtn = (v) => `<button type="button" class="sim-chip sim-chip-sm${spd === v ? ' on' : ''}" onclick="window.__simReplaySpeed(${v})">${v}×</button>`

  return `
    <div class="sim-lbl" style="margin-bottom:6px">
      <span class="sim-sub" style="margin:0">${_T('Replay', 'Reproducción')}</span>
      ${coins.length > 1 ? `<select class="sim-in sim-sel" style="width:auto;padding:4px 8px" onchange="window.__simReplayMarket(this.value)">
        ${coins.map(c => `<option value="${esc(c)}" ${c === _simRep.coin ? 'selected' : ''}>${esc(_ocCoinLabel(c))}</option>`).join('')}
      </select>` : ''}
      <span style="flex:1"></span>
      <button type="button" onclick="window.__simReplayClose()" aria-label="${_T('Close replay', 'Cerrar')}" class="sim-x">×</button>
    </div>
    <div id="simReplayBody">${_simRepBodyHtml()}</div>
    <div style="display:flex;align-items:center;gap:7px;margin-top:8px">
      <button type="button" class="sim-btn sim-btn-i" onclick="window.__simReplayStep(-1)" title="${_T('Back one candle', 'Una vela atrás')}">◀</button>
      <button type="button" class="sim-btn sim-btn-p" style="padding:7px 16px" onclick="window.__simReplayPlay()">${_simRep.playing ? '❚❚' : '▶'}</button>
      <button type="button" class="sim-btn sim-btn-i" onclick="window.__simReplayStep(1)" title="${_T('Forward one candle', 'Una vela adelante')}">▶</button>
      <input id="simRepSeek" type="range" min="0" max="${last}" value="${_simRep.i}"
        oninput="window.__simReplaySeek(this.value)" style="flex:1;min-width:0;accent-color:var(--accent)">
      <span id="simRepCount" class="mono" style="font-size:10.5px;color:var(--muted);min-width:62px;text-align:right">${_simRep.i + 1}/${last + 1}</span>
    </div>
    <div style="display:flex;gap:6px;margin-top:8px;justify-content:flex-end">${[0.5, 1, 2, 4, 8].map(spdBtn).join('')}</div>`
}

// ── RESULTS: compare board ────────────────────────────────────────────────────

function _simCmpHtml() {
  const c = _simCmp
  if (!c) return ''
  const ok = c.rows.filter(r => r.result)
  const key = {
    roe: (r) => r.result.roe ?? -Infinity,
    score: (r) => _simScore(r.result.roe, r.sum.maxDD) ?? -Infinity,
    sharpe: (r) => r.sum.risk.sharpe ?? -Infinity,
    pf: (r) => r.sum.trades.profitFactor ?? -Infinity,
    dd: (r) => -(r.sum.maxDD ?? Infinity),
  }[_simCmpSort] ?? ((r) => r.result.roe ?? -Infinity)
  const sorted = [...ok].sort((a, b) => key(b) - key(a))
  const sortBtn = (k, lbl) => `<button type="button" class="sim-chip sim-chip-sm${_simCmpSort === k ? ' on' : ''}" onclick="window.__simCmpSort('${k}')">${lbl}</button>`
  const markets = c.coins.map(_ocCoinLabel).join(', ')
  return `<section class="sim-card sim-cmp">
    <div class="sim-card-h">
      <span class="sim-card-t">${_T('Strategy comparison', 'Comparación de estrategias')}</span>
      <span style="flex:1"></span>
      <button type="button" class="sim-x" onclick="window.__simCmpClose()" aria-label="${_T('Close', 'Cerrar')}">×</button>
    </div>
    <div class="sim-hint" style="margin:-6px 0 10px"><span class="notranslate">${esc(markets.length > 60 ? c.coins.length + ' ' + _T('markets', 'mercados') : markets)}</span> · ${esc(c.iv)} · ${c.count.toLocaleString()} ${_T('candles', 'velas')} · ${
      _T('each strategy with its own current settings', 'cada estrategia con sus ajustes actuales')}</div>
    <div data-dragscroll class="sim-scrollx" style="margin-bottom:10px">
      <span class="sim-lbl-u" style="align-self:center;margin-right:2px">${_T('Rank by', 'Ordenar')}</span>
      ${sortBtn('roe', _T('Return', 'Retorno'))}${sortBtn('score', _T('Return ÷ DD', 'Retorno ÷ DD'))}${sortBtn('sharpe', 'Sharpe')}${sortBtn('pf', _T('Profit factor', 'F. beneficio'))}${sortBtn('dd', _T('Smallest DD', 'Menor DD'))}
    </div>
    <div class="sim-table">
      ${c.bench ? `<div class="sim-tr sim-cmp-bench">
        <span class="sim-cmp-rk">—</span>
        <span class="sim-cmp-n"><b>${_T('Buy & hold', 'Comprar y mantener')}</b><span class="sim-hint">${_T('the bar to beat', 'la marca a superar')}</span></span>
        <span class="sim-cmp-v" style="color:${tone(c.bench.retPct)}">${pct(c.bench.retPct, 1)}</span>
        <span class="sim-cmp-d">${ddTxt(c.bench.maxDD)}</span>
      </div>` : ''}
      ${sorted.map((r, i) => {
        const beat = c.bench && r.result.tradesMade > 0 && r.result.roe != null && r.result.roe > c.bench.retPct
        const t = r.sum.trades
        return `<button type="button" class="sim-tr sim-cmp-row${r.key === _simParams.strategy ? ' cur' : ''}" onclick="window.__simCmpPick('${r.key}')">
          <span class="sim-cmp-rk">${i + 1}</span>
          <span class="sim-cmp-n">
            <b>${esc(_stratShort(r.key))}${BT_STRATEGY_META[r.key]?.bot ? ' <span class="sim-badge">BOT</span>' : ''}${beat ? ` <span class="sim-badge sim-badge-g">${_T('BEATS HOLD', 'SUPERA')}</span>` : ''}</b>
            <span class="sim-hint">${r.result.tradesMade} ${_T('trades', 'ops')} · ${_T('win', 'acierto')} ${r.result.winRate == null ? '—' : r.result.winRate.toFixed(0) + '%'} · PF ${num(t.profitFactor)} · Sharpe ${num(r.sum.risk.sharpe)}${r.partial ? ' · ' + _T('some markets skipped', 'mercados omitidos') : ''}</span>
          </span>
          ${_simSpark(r.sum.curve)}
          <span class="sim-cmp-v" style="color:${tone(r.result.roe ?? 0)}">${pct(r.result.roe, 1)}</span>
          <span class="sim-cmp-d">${ddTxt(r.sum.maxDD ?? 0)}</span>
        </button>`
      }).join('')}
      ${c.rows.filter(r => !r.result).map(r => `<div class="sim-tr" style="opacity:.55">
        <span class="sim-cmp-rk">·</span><span class="sim-cmp-n"><b>${esc(_stratShort(r.key))}</b><span class="sim-hint">${esc(r.na)}</span></span></div>`).join('')}
    </div>
    <div class="sim-hint" style="margin-top:8px">${_T(
      'Tap a row to open its full report. Every strategy ran on the same candles; the drawdown column is the worst fall from a peak. A strategy that tops this board on one market and one period has earned a second test, not a deployment.',
      'Toca una fila para ver su informe. Todas usaron las mismas velas; la columna de caída es la peor desde un máximo.')}</div>
  </section>`
}

// ── RESULTS: sweep ────────────────────────────────────────────────────────────

function _simSweepHtml() {
  const opts = _simSweepable()
  if (!opts.length) return `<div class="sim-empty-s">${_T('Nothing to sweep for this strategy.', 'Nada que barrer en esta estrategia.')}</div>`
  const key = opts.some(f => f.key === _simSweepKey) ? _simSweepKey : opts[0].key
  const d = _simSweepDefaults(key)
  const sw = _simSweep && _simSweep.key === key ? _simSweep : null
  let table = ''
  if (sw?.rows.length) {
    const best = sw.rows.reduce((a, r) => (r.result.roe ?? -Infinity) > (a.result.roe ?? -Infinity) ? r : a, sw.rows[0])
    const maxAbs = Math.max(1, ...sw.rows.map(r => Math.abs(r.result.roe ?? 0)))
    // How the best value's neighbours did. A peak with cliffs either side is a value fitted to
    // this history; a plateau is a setting that works.
    const bi = sw.rows.indexOf(best)
    const nb = [sw.rows[bi - 1], sw.rows[bi + 1]].filter(Boolean)
    const nbAvg = nb.length ? nb.reduce((a, r) => a + (r.result.roe ?? 0), 0) / nb.length : null
    const fragile = nbAvg != null && best.result.roe > 0 && nbAvg < best.result.roe * 0.4
    table = `
      <div class="sim-note" style="color:${fragile ? 'var(--warn)' : 'var(--fg-2)'}">${fragile
        ? _T(`The best value is a spike: its neighbours made ${pct(nbAvg, 1)} on average against its ${pct(best.result.roe, 1)}. That is a setting fitted to this stretch of history, not an edge.`,
             `El mejor valor es un pico: sus vecinos hicieron ${pct(nbAvg, 1)} de media frente a ${pct(best.result.roe, 1)}.`)
        : _T('Look for a plateau, not a peak: a value whose neighbours did nearly as well is a setting that works; a lone spike is luck.',
             'Busca una meseta, no un pico: un valor cuyos vecinos también funcionan es fiable; un pico aislado es suerte.')}</div>
      <div class="sim-table" style="margin-top:10px">
        <div class="sim-tr sim-th"><span class="c" style="width:58px;text-align:left">${esc(BT_FIELDS.find(f => f.key === key)?.label ?? key)}</span>
          <span style="flex:1"></span><span class="c">${_T('Return', 'Retorno')}</span><span class="c">DD</span><span class="c">${_T('Trades', 'Ops')}</span><span class="c" style="width:52px"></span></div>
        ${sw.rows.map(r => `<div class="sim-tr${r === best ? ' sim-best' : ''}">
          <span class="c mono" style="width:58px;text-align:left;font-weight:700">${r.v}${r.v === sw.current ? ' •' : ''}</span>
          <span style="flex:1;min-width:40px"><span class="sim-bar"><i style="${(r.result.roe ?? 0) >= 0
            ? `left:50%;width:${Math.min(50, Math.abs(r.result.roe ?? 0) / maxAbs * 50)}%;background:var(--green)`
            : `right:50%;width:${Math.min(50, Math.abs(r.result.roe ?? 0) / maxAbs * 50)}%;background:var(--red)`}"></i></span></span>
          <span class="c mono" style="color:${tone(r.result.roe ?? 0)}">${pct(r.result.roe, 1)}</span>
          <span class="c mono">${ddTxt(r.s.maxDD ?? 0)}</span>
          <span class="c mono">${r.result.tradesMade}</span>
          <span class="c" style="width:52px"><button type="button" class="sim-chip sim-chip-sm" onclick="window.__simSweepApply(${r.v})">${_T('Use', 'Usar')}</button></span>
        </div>`).join('')}
      </div>`
  }
  return `
    <div class="sim-hint" style="margin-bottom:10px">${_T(
      'Step one setting across a range on the same candles and see what it was worth. • marks the current value.',
      'Recorre un ajuste en un rango con las mismas velas. • marca el valor actual.')}</div>
    <div class="sim-grid2" style="grid-template-columns:2fr 1fr 1fr 1fr">
      <label class="sim-field"><div class="sim-lbl"><span class="sim-lbl-t">${_T('Setting', 'Ajuste')}</span></div>
        <select id="simSwKey" class="sim-in sim-sel" onchange="window.__simSweepKey(this.value)">${
          opts.map(f => `<option value="${f.key}"${f.key === key ? ' selected' : ''}>${esc(f.label)}${f.strategy ? '' : ' · ' + esc(f.unit)}</option>`).join('')}</select></label>
      <label class="sim-field"><div class="sim-lbl"><span class="sim-lbl-t">${_T('From', 'Desde')}</span></div>
        <input id="simSwFrom" class="sim-in" type="number" step="any" value="${sw ? sw.from : d.from}"></label>
      <label class="sim-field"><div class="sim-lbl"><span class="sim-lbl-t">${_T('To', 'Hasta')}</span></div>
        <input id="simSwTo" class="sim-in" type="number" step="any" value="${sw ? sw.to : d.to}"></label>
      <label class="sim-field"><div class="sim-lbl"><span class="sim-lbl-t">${_T('Steps', 'Pasos')}</span></div>
        <input id="simSwSteps" class="sim-in" type="number" min="2" max="25" value="${sw ? sw.steps : d.steps}"></label>
    </div>
    <button type="button" class="sim-btn sim-btn-p" style="width:100%;margin-top:10px" onclick="window.__simSweep()" ${_simBusy ? 'disabled' : ''}>${_T('Run sweep', 'Ejecutar barrido')}</button>
    ${table}`
}

// ── RESULTS: overview ─────────────────────────────────────────────────────────

function _simKpi(label, value, sub = '', colour = '') {
  return `<div class="sim-kpi">
    <div class="sim-kpi-l">${label}</div>
    <div class="sim-kpi-v"${colour ? ` style="color:${colour}"` : ''}>${value}</div>
    ${sub ? `<div class="sim-kpi-s">${sub}</div>` : ''}
  </div>`
}

const _row = (label, value, colour = '') =>
  `<div class="sim-row"><span>${label}</span><span${colour ? ` style="color:${colour}"` : ''}>${value}</span></div>`

/** The furthest any single trade went against its entry, before whatever closed it. */
function _simWorst(r) {
  const m = (r.trades ?? []).map(t => t.mae).filter(v => Number.isFinite(v))
  return m.length ? Math.max(...m) : null
}

function _simStatsHtml(r, s) {
  const t = s.trades, k = s.risk
  const iv = _simRunMeta?.iv
  const perDay = k.spanDays > 0 ? r.tradesMade / k.spanDays : null
  const blocks = []
  blocks.push(`<div class="sim-inset"><div class="sim-sub">${_T('Returns', 'Retornos')}</div>
    ${_row(_T('Starting balance', 'Balance inicial'), money(r.startBalance))}
    ${_row(_T('Ending balance', 'Balance final'), money(r.balance), tone(r.netPnl))}
    ${_row(_T('Net PnL', 'PnL neto'), signed(r.netPnl), tone(r.netPnl))}
    ${_row(_T('Return', 'Retorno'), pct(r.roe), tone(r.roe ?? 0))}
    ${_row(_T('Annualised', 'Anualizado'), k.cagr == null ? `<span title="${esc(_T('Needs at least 30 days', 'Necesita al menos 30 días'))}">—</span>` : pct(k.cagr, 1), tone(k.cagr ?? 0))}
    ${_row(_T('Buy & hold', 'Comprar y mantener'), s.bench ? pct(s.bench.retPct) : '—', tone(s.bench?.retPct ?? 0))}
    ${_row(_T('Edge over holding', 'Ventaja sobre mantener'), s.edge == null ? '—' : (s.edge >= 0 ? '+' : '') + s.edge.toFixed(2) + ' pp', tone(s.edge ?? 0))}
    ${_row(_T('Peak balance', 'Balance máximo'), money(r.peak))}
  </div>`)
  blocks.push(`<div class="sim-inset"><div class="sim-sub">${_T('Risk', 'Riesgo')}</div>
    ${_row(_T('Max drawdown', 'Caída máxima'), ddTxt(s.maxDD, 2), s.maxDD > 0 ? 'var(--red)' : '')}
    ${_row(_T('Hold max drawdown', 'Caída máx. mantener'), s.bench ? ddTxt(s.bench.maxDD, 2) : '—')}
    ${_row('Sharpe', num(k.sharpe), tone(k.sharpe ?? 0))}
    ${_row('Sortino', num(k.sortino), tone(k.sortino ?? 0))}
    ${_row(_T('Calmar (annual ÷ DD)', 'Calmar (anual ÷ DD)'), num(k.calmar))}
    ${_row(_T('Volatility (annual)', 'Volatilidad (anual)'), k.volatility == null ? '—' : k.volatility.toFixed(1) + '%')}
    ${_row(_T('Best / worst day', 'Mejor / peor día'), k.bestDay == null ? '—' : `<span style="color:var(--green)">${pct(k.bestDay, 1)}</span> / <span style="color:var(--red)">${pct(k.worstDay, 1)}</span>`)}
    ${_row(_T('Time in market', 'Tiempo en mercado'), s.exposure == null ? '—' : s.exposure.toFixed(0) + '%')}
  </div>`)
  if (!r.grid) blocks.push(`<div class="sim-inset"><div class="sim-sub">${_T('Trades', 'Operaciones')}</div>
    ${_row(_T('Trades', 'Operaciones'), `${r.tradesMade}${perDay != null ? ` <span class="sim-lbl-u">· ${perDay >= 1 ? perDay.toFixed(1) : (perDay * 7).toFixed(1)}/${perDay >= 1 ? _T('day', 'día') : _T('wk', 'sem')}</span>` : ''}`)}
    ${_row(_T('Won / lost', 'Ganadas / perdidas'), `${r.won} / ${r.lost}`)}
    ${_row(_T('Win rate', 'Aciertos'), r.winRate == null ? '—' : r.winRate.toFixed(1) + '%')}
    ${_row(_T('Profit factor', 'Factor de beneficio'), t.profitFactor == null ? '—' : t.profitFactor.toFixed(2), t.profitFactor == null ? '' : tone(t.profitFactor - 1))}
    ${_row(_T('Expectancy / trade', 'Esperanza / op.'), t.expectancy == null ? '—' : signed(t.expectancy), tone(t.expectancy ?? 0))}
    ${_row(_T('Avg win / avg loss', 'Media gan. / pérd.'), `${t.avgWin == null ? '—' : signed(t.avgWin)} / ${t.avgLoss == null ? '—' : signed(t.avgLoss)}`)}
    ${_row(_T('Payoff ratio', 'Ratio de pago'), num(t.payoff))}
    ${_row(_T('Largest win / loss', 'Mayor gan. / pérd.'), `${t.largestWin == null ? '—' : signed(t.largestWin)} / ${t.largestLoss == null ? '—' : signed(t.largestLoss)}`)}
    ${_row(_T('Max streak W / L', 'Racha máx. G / P'), `${t.maxConsecWins} / ${t.maxConsecLosses}`)}
    ${_row(_T('Avg time held', 'Tiempo medio'), r.avgHeld ? _simDur(r.avgHeld, iv) : '—')}
    ${_row(_T('Longs', 'Largos'), t.long.n ? `${t.long.n} · <span style="color:${tone(t.long.net)}">${signed(t.long.net)}</span>` : '—')}
    ${_row(_T('Shorts', 'Cortos'), t.short.n ? `${t.short.n} · <span style="color:${tone(t.short.net)}">${signed(t.short.net)}</span>` : '—')}
    ${_row(_T('Unresolved', 'Sin resolver'), `${r.unresolved}`)}
    ${_simHL(r.params) ? _row(_T('Liquidations', 'Liquidaciones'), `${t.liquidations}`, t.liquidations ? 'var(--red)' : '') : ''}
    ${_simHL(r.params) ? _row(_T('Orders refused', 'Órdenes rechazadas'), `${r.refused ?? 0}`, r.refused ? 'var(--warn)' : '') : ''}
    ${_simWorst(r) != null ? _row(_T('Worst move against a trade', 'Peor movimiento en contra'), '-' + _simWorst(r).toFixed(2) + '%') : ''}
  </div>`)
  if (r.grid) blocks.push(`<div class="sim-inset"><div class="sim-sub">${_T('Grid', 'Cuadrícula')}</div>
    ${_row(_T('Range', 'Rango'), `${money(r.grid.lower)} - ${money(r.grid.upper)}`)}
    ${_row(_T('Levels', 'Niveles'), `${r.grid.levels}`)}
    ${_row(_T('Time in range', 'Tiempo en rango'), r.grid.inRangePct == null ? '—' : r.grid.inRangePct.toFixed(0) + '%')}
    ${_row(_T('Cycles completed', 'Ciclos completados'), `${r.grid.cycles}`)}
    ${_row(_T('Earned from cycles', 'Ganado en ciclos'), signed(r.grid.realized), tone(r.grid.realized))}
    ${_row(_T('Fees', 'Comisiones'), r.grid.fees ? '-' + money(r.grid.fees) : money(0), r.grid.fees ? 'var(--red)' : '')}
    ${_row(_T('Still holding', 'Aún en posición'), r.grid.inventorySize > 0
      ? `${r.grid.inventorySize.toFixed(4)} @ ${money(r.grid.inventoryCost / r.grid.inventorySize)}`
      : _T('nothing', 'nada'))}
    ${_row(_T('Worth now', 'Valor actual'), money(r.grid.inventoryValue))}
    ${_row(_T('Open position PnL', 'PnL de la posición'), signed(r.grid.unrealized), tone(r.grid.unrealized))}
    ${_row(_T('Leverage', 'Apalancamiento'), `${r.grid.lev ?? 1}x ${r.params.marginMode === 'isolated' ? _T('isolated', 'aislado') : _T('cross', 'cruzado')}`)}
    ${_row(_T('Most margin posted', 'Máx. margen'), money(r.grid.maxMargin ?? 0))}
    ${_row(_T('Liquidations', 'Liquidaciones'), `${r.grid.liquidations ?? 0}`, r.grid.liquidations ? 'var(--red)' : '')}
    ${_row(_T('Closest to liquidation', 'Más cerca de liquidación'), r.grid.closestLiq == null ? _T('never at risk', 'nunca en riesgo') : r.grid.closestLiq.toFixed(1) + '%')}
    ${r.grid.liqNow ? _row(_T('Liquidation price now', 'Liquidación ahora'), '$' + fmtPrice(r.grid.liqNow), 'var(--red)') : ''}
  </div>`)
  if (r.dca) {
    const hist = r.dca.soHist.map((n, k) => n ? `${k}:${n}` : '').filter(Boolean).join(' · ')
    blocks.push(`<div class="sim-inset"><div class="sim-sub">DCA</div>
      ${_row(_T('Deals closed', 'Tratos cerrados'), `${r.dca.deals}`)}
      ${_row(_T('Earned from deals', 'Ganado en tratos'), signed(r.dca.realized), tone(r.dca.realized))}
      ${_row(_T('Fees', 'Comisiones'), '-' + money(r.dca.fees), 'var(--red)')}
      ${_row(_T('Most safety orders used', 'Máx. órdenes usadas'), `${r.dca.maxSo} / ${r.dca.soCount}`, r.dca.maxSo === r.dca.soCount && r.dca.soCount ? 'var(--warn)' : '')}
      ${_row(_T('Deals by orders used', 'Tratos por órdenes'), hist || '—')}
      ${_row(_T('Largest deal', 'Mayor trato'), money(r.dca.maxDeployed))}
      ${_row(_T('Most margin posted', 'Máx. margen'), money(r.dca.maxMargin ?? 0))}
      ${_row(_T('Liquidations', 'Liquidaciones'), `${r.dca.liquidations ?? 0}`, r.dca.liquidations ? 'var(--red)' : '')}
      ${_row(_T('Closest to liquidation', 'Más cerca de liquidación'), r.dca.closestLiq == null ? _T('never at risk', 'nunca en riesgo') : r.dca.closestLiq.toFixed(1) + '%', r.dca.closestLiq != null && r.dca.closestLiq < 5 ? 'var(--warn)' : '')}
      ${_row(_T('Full deal would be', 'Trato completo'), `${money(r.dca.maxPossible)} · ${_T('margin', 'margen')} ${money(r.dca.maxPossibleMargin ?? r.dca.maxPossible)}`)}
      ${_row(_T('Open deal', 'Trato abierto'), r.dca.openCost ? `${money(r.dca.openCost)} · ${r.dca.openSo} SO` : _T('none', 'ninguno'))}
      ${_row(_T('Open deal PnL', 'PnL del trato abierto'), signed(r.dca.unrealized), tone(r.dca.unrealized))}
    </div>`)
  }
  return `<div class="sim-stats">${blocks.join('')}</div>`
}

function _simOverviewHtml(r, s) {
  const stepped = !(Array.isArray(r.curve) && r.curve.length)
  return `
    <div class="sim-inset" style="padding:10px 10px 8px">${_simEquityHtml(s, r.startBalance, stepped)}</div>
    ${_simStatsHtml(r, s)}
    ${s.months.length > 1 ? `<div class="sim-inset">${_simMonthsHtml(s.months)}</div>` : ''}`
}

/** The settings that produced the numbers, stated on the result itself. */
function _simUsedBits(r) {
  const p = r.params
  const kind = strategyKind(p.strategy)
  const bits = []
  for (const f of BT_FIELDS) {
    if (f.strategy !== p.strategy) continue
    bits.push(`${f.label.toLowerCase()} ${p[f.key]}`)
  }
  for (const c of BT_CHOICES) if (c.strategy === p.strategy) bits.push(c.options.find(o => o[0] === String(p[c.key]))?.[1] ?? '')
  if (kind === 'signal' && p.strategy !== 'volbreak') bits.push(`${_T('TP', 'TP')} ${p.takeProfitPct}% / ${_T('SL', 'SL')} ${p.stopLossPct}%`)
  if (kind === 'signal') {
    const dirLbl = { both: _T('both ways', 'ambos'), long: _T('long only', 'solo largos'), short: _T('short only', 'solo cortos') }[p.useDirection ? p.direction : 'both']
    bits.push(dirLbl)
    if (p.useCooldown) bits.push(`${_T('cooldown', 'espera')} ${p.cooldownCandles}`)
    if (p.useOnePos) bits.push(_T('one at a time', 'una a la vez'))
    if (p.useTrendFilter) bits.push(`${_T('trend', 'tendencia')} ${p.trendMa}`)
    if (p.useTrailing) bits.push(`${_T('trail', 'trail')} ${p.trailPct}%`)
    if (p.useTimeExit) bits.push(`${_T('exit after', 'salir tras')} ${p.timeExitCandles}`)
    bits.push(p.ambiguous === 'win' ? _T('ties → target', 'empates → objetivo') : _T('ties → stop', 'empates → stop'))
  }
  const hl = _simHL(p)
  if (hl) {
    const size = kind === 'grid' || kind === 'dca'
      ? (p.orderUnit === 'coin' ? _T('orders in coins', 'órdenes en monedas') : _T('orders in USDC', 'órdenes en USDC'))
      : p.sizeMode === 'usd' ? `$${fmtUSD(p.sizeUsd)} ${_T('per trade', 'por op.')}`
      : p.sizeMode === 'coin' ? `${p.sizeCoin} ${_T('coins per trade', 'monedas por op.')}`
      : `${p.sizePct}% ${_T('of balance', 'del balance')}`
    bits.push(size, `${p.leverage}x ${p.marginMode === 'isolated' ? _T('isolated', 'aislado') : _T('cross', 'cruzado')}`)
    bits.push(p.useFees ? `${_T('maker', 'maker')} ${p.makerFeePct}% / ${_T('taker', 'taker')} ${p.takerFeePct}%` : _T('no fees', 'sin comisiones'))
  } else {
    bits.push(p.pnlModel === 'risk' ? `${_T('risk', 'riesgo')} ${p.riskPct}%` : `+${p.winPct}% / -${p.lossPct}%`)
    bits.push(p.useFees ? `${_T('fees', 'comis.')} ${p.feePct}%` : _T('no fees', 'sin comisiones'))
  }
  return bits.filter(Boolean)
}

function _simResultHtml() {
  if (_simBusy) return `<section class="sim-card sim-busy"><span class="sim-spin"></span>
    <div><div style="font-weight:800">${_T('Running…', 'Ejecutando…')}</div><div id="simProg" class="sim-hint">${esc(_simProgress)}</div></div></section>`
  if (_simError) return `<section class="sim-card" style="border-color:var(--red);color:var(--red);font-size:12.5px">${esc(_simError)}</section>`
  if (!_simResult) {
    if (_simCmp) return ''
    return `<section class="sim-card sim-empty">
      <div class="sim-empty-i">◎</div>
      <div style="font-size:15px;font-weight:800">${_T('No run yet', 'Aún sin ejecutar')}</div>
      <div class="sim-hint" style="max-width:420px;margin:6px auto 0">${_T(
        'Pick markets and a strategy, then press Run. You get the balance against buying and holding, drawdown, Sharpe, profit factor, monthly returns, every trade, and a candle-by-candle replay.',
        'Elige mercados y una estrategia y pulsa Ejecutar. Verás el balance frente a mantener, la caída, Sharpe, factor de beneficio, retornos mensuales, cada operación y una repetición.')}</div>
      <div style="display:flex;gap:8px;justify-content:center;margin-top:14px;flex-wrap:wrap">
        <button type="button" class="sim-btn sim-btn-p" onclick="window.__simRun()">▶ ${_T('Run', 'Ejecutar')} ${esc(_stratShort(_simParams.strategy))}</button>
        <button type="button" class="sim-btn" onclick="window.__simCompare()">⇅ ${_T(`Compare all ${BT_STRATEGIES.length}`, `Comparar las ${BT_STRATEGIES.length}`)}</button>
      </div>
    </section>`
  }
  const r = _simResult
  const s = _simSum ?? summarize(r)
  const meta = _simRunMeta ?? { coins: _simCoinList(), iv: _simIv, count: _simCount, strategy: r.params.strategy }
  const when = (t) => t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

  // Stated, not buried: both change the result more than most of the boxes above do.
  const caveats = [
    r.grid && r.grid.inventorySize > 0
      ? _T('The grid ended holding a position. That is where a grid loses -- the cycles above are all profitable by construction, so read the net, not the count.',
           'La cuadrícula terminó con posición abierta. Ahí es donde pierde: los ciclos son rentables por construcción.')
      : '',
    r.grid && r.params.gridSameCandle === 'allow'
      ? _T('Round trips inside one candle were counted. A candle cannot say whether it went down then up, so some of those cycles may never have happened.',
           'Se contaron ciclos dentro de una misma vela, cuyo orden no se puede conocer.')
      : '',
    r.dca && r.dca.openCost > 0 && r.dca.unrealized < 0
      ? _T(`A DCA deal was still open and underwater when the data ended (${signed(r.dca.unrealized)}). That is where a DCA bot loses -- every closed deal above is a win by construction.`,
           `Un trato DCA seguía abierto y en pérdida al final (${signed(r.dca.unrealized)}). Ahí es donde pierde un DCA.`)
      : '',
    r.dca && r.dca.maxPossible > r.startBalance
      ? _T(`A full deal (${money(r.dca.maxPossible)}) is larger than the balance. A real account would need leverage for it -- or the last safety orders would simply fail.`,
           `Un trato completo (${money(r.dca.maxPossible)}) supera el balance.`)
      : '',
    r.params.strategy === 'range' && r.params.baselineLookback === 0
      ? _T('Baseline uses the whole sample, including candles after each trade. Not a result anyone could have traded.',
           'La base usa toda la muestra, incluidas velas posteriores a cada operación.')
      : '',
    r.params.ambiguous === 'win' && strategyKind(r.params.strategy) === 'signal'
      ? _T('Candles that covered both levels were counted as wins. The order inside a candle is unknowable.',
           'Las velas que tocaron ambos niveles cuentan como ganadas.')
      : '',
    s.trades.liquidations > 0
      ? _T(`${s.trades.liquidations} position${s.trades.liquidations === 1 ? ' was' : 's were'} liquidated (${r.params.marginMode === 'isolated' ? 'isolated' : 'cross'}, ${r.params.leverage}x). ${
            r.params.marginMode === 'isolated' ? 'Each cost its own margin.' : 'In cross each took the account down to maintenance margin.'}`,
           `${s.trades.liquidations} posición(es) liquidadas.`)
      : '',
    (r.refused ?? 0) > 0
      ? _T(`${r.refused} order${r.refused === 1 ? ' was' : 's were'} refused, as Hyperliquid would refuse them: under the $10 minimum, or more margin than the account had.`,
           `${r.refused} orden(es) rechazadas: bajo el mínimo de $10 o sin margen suficiente.`)
      : '',
    (r.dca?.soRefused ?? 0) > 0
      ? _T(`${r.dca.soRefused} time${r.dca.soRefused === 1 ? '' : 's'} a deal ran out of margin for its next safety order and had to sit.`,
           `${r.dca.soRefused} vez/veces un trato se quedó sin margen para su siguiente orden.`)
      : '',
    _simHL(r.params) && (_simRunMeta?.coins ?? []).some(c => _simMaxLev(c) != null && r.params.leverage > _simMaxLev(c))
      ? _T(`Leverage was capped at each market's own maximum: ${(_simRunMeta?.coins ?? []).filter(c => r.params.leverage > (_simMaxLev(c) ?? Infinity)).map(c => `${_mktName(c)} ${_simMaxLev(c)}x`).join(', ')}.`,
           'El apalancamiento se limitó al máximo de cada mercado.')
      : '',
    _simHL(r.params) && (_simRunMeta?.coins ?? []).some(c => _simMaxLev(c) == null)
      ? _T('A market\'s max leverage was not known, so its maintenance margin assumed 20x.', 'No se conocía el apalancamiento máximo de un mercado; se asumió 20x.')
      : '',
    r.halted ? _T('The run halted after the losing streak set under Modules.', 'La ejecución se detuvo tras la racha de pérdidas.') : '',
    r.unresolved > 0 && !r.grid && !r.dca
      ? _T(`${r.unresolved} trade${r.unresolved === 1 ? '' : 's'} never hit either level before the data ended.`,
           `${r.unresolved} operación(es) no alcanzaron ningún nivel antes del final.`)
      : '',
  ].filter(Boolean)

  const usedBits = [..._simUsedBits(r)]
  const multi = meta.coins.length > 1
  const tabs = [
    ['overview', _T('Overview', 'Resumen')],
    ['trades', _T('Trades', 'Operaciones') + ` <span class="sim-lbl-u">${r.tradesMade}</span>`],
    ...(multi ? [['markets', _T('Markets', 'Mercados')]] : []),
    ['replay', _T('Replay', 'Repetición')],
    ['sweep', _T('Sweep', 'Barrido')],
  ]
  const tab = tabs.some(([k]) => k === _simTab) ? _simTab : 'overview'
  const body = tab === 'trades' ? _simTradesHtml(r)
    : tab === 'markets' ? _simMarketsHtml(r)
    : tab === 'replay' ? _simReplayHtml()
    : tab === 'sweep' ? _simSweepHtml()
    : _simOverviewHtml(r, s)
  const wr = r.winRate
  const t = s.trades

  return `
    <div id="simStale" class="sim-stale" style="display:${_simStale ? '' : 'none'}">${
      _T('Settings changed since this run. Press Run backtest to see what they do.',
         'Los ajustes cambiaron desde esta ejecución. Pulsa Ejecutar para verlos.')}</div>
    <section id="simResult" class="sim-card" style="opacity:${_simStale ? '0.45' : '1'}">
      <div class="sim-res-h">
        <div style="min-width:0">
          <div class="sim-res-t">${esc(_stratShort(r.params.strategy))}${BT_STRATEGY_META[r.params.strategy]?.bot ? ' <span class="sim-badge">BOT</span>' : ''}</div>
          <div class="sim-hint"><span class="notranslate">${esc(meta.coins.map(_ocCoinLabel).join(', '))}</span> · ${esc(meta.iv)} · ${r.candles.toLocaleString()} ${_T('candles', 'velas')} · ${esc(when(r.from))} → ${esc(when(r.to))}</div>
        </div>
      </div>
      <div class="sim-used mono">${usedBits.map(esc).join(' <span style="opacity:.45">·</span> ')}</div>
      <div class="sim-kpis">
        ${_simKpi(_T('Net PnL', 'PnL neto'), signed(r.netPnl), pct(r.roe), tone(r.netPnl))}
        ${_simKpi(_T('vs buy & hold', 'vs mantener'), s.edge == null ? '—' : (s.edge >= 0 ? '+' : '') + s.edge.toFixed(1) + ' pp',
          s.bench ? _T('hold', 'mantener') + ' ' + pct(s.bench.retPct, 1) : '', tone(s.edge ?? 0))}
        ${_simKpi(_T('Max drawdown', 'Caída máx.'), ddTxt(s.maxDD), s.risk.calmar != null ? 'Calmar ' + num(s.risk.calmar) : '', s.maxDD > 0 ? 'var(--red)' : '')}
        ${_simKpi(_T('Win rate', 'Aciertos'), wr == null ? '—' : wr.toFixed(1) + '%', r.grid || (r.dca && wr == null)
          ? _T('100% by construction', '100% por diseño') : `${r.won}W · ${r.lost}L`)}
        ${_simKpi(_T('Profit factor', 'F. beneficio'), t.profitFactor == null ? '—' : t.profitFactor.toFixed(2),
          t.expectancy == null ? '' : signed(t.expectancy) + ' / ' + _T('trade', 'op'), t.profitFactor == null ? '' : tone(t.profitFactor - 1))}
        ${_simKpi('Sharpe', num(s.risk.sharpe), 'Sortino ' + num(s.risk.sortino), tone(s.risk.sharpe ?? 0))}
        ${_simKpi(_T('Trades', 'Operaciones'), `${r.tradesMade}`, r.avgHeld ? _T('avg ', 'media ') + _simDur(r.avgHeld, meta.iv) : '')}
        ${_simKpi(_T('Time in market', 'En mercado'), s.exposure == null ? '—' : s.exposure.toFixed(0) + '%', s.risk.cagr != null ? pct(s.risk.cagr, 0) + ' ' + _T('/yr', '/año') : '')}
      </div>
      ${caveats.length ? `<div class="sim-caveats">${caveats.map(c => `<div>${esc(c)}</div>`).join('')}</div>` : ''}
      ${_simSkipped.length ? `<div class="sim-caveats">${_T('Left out: ', 'Omitidos: ')}${esc(_simSkipped.join(', '))}</div>` : ''}
      ${r.tradesMade === 0 ? `<div class="sim-note">${
        _T('The rule never fired. Loosen its trigger, use more candles, or try a shorter interval.',
           'La regla nunca se activó. Relaja el disparador, usa más velas o un intervalo menor.')}</div>` : ''}
      <div data-dragscroll class="sim-tabs">${tabs.map(([k, lbl]) =>
        `<button type="button" class="sim-tab${k === tab ? ' on' : ''}" onclick="window.__simSetTab('${k}')">${lbl}</button>`).join('')}</div>
      <div>${body}</div>
    </section>`
}

// ── RENDER ────────────────────────────────────────────────────────────────────

function _simRender(el) {
  const host = el ?? ctx.viewHost('deskSim')
  if (!host) return
  // The form's own scroll survives a rebuild: on a wide screen the settings scroll inside
  // their column, and every structural change rebuilds it.
  const cfgScroll = host.querySelector('.sim-config')?.scrollTop ?? 0
  host.innerHTML = `<div class="sim-root">${ctx.fullHeader(_T('Trade Simulator', 'Simulador'))}
    <div class="sim-wrap">
      <div class="sim-intro">
        <div class="sim-hint" style="flex:1;font-size:12px">${
          _T('Replay a rule over past Hyperliquid candles. Nothing is placed and no money moves.',
             'Prueba una regla sobre velas pasadas de Hyperliquid. No se coloca nada ni se mueve dinero.')}</div>
        <button id="simOverviewBtn" type="button" class="sim-chip" onclick="window.__simOverview()">${
          _T('How this works', 'Cómo funciona')}</button>
      </div>
      <div id="simOverview" class="sim-card" style="display:none;margin-bottom:14px">
        ${BT_OVERVIEW.map(([title, body]) => `<div style="margin-bottom:10px">
          <div style="font-size:12px;font-weight:800;color:var(--fg);margin-bottom:3px">${esc(title)}</div>
          <div class="sim-hint" style="font-size:11.5px;line-height:1.55">${esc(body)}</div>
        </div>`).join('')}
        <div class="sim-hint" style="border-top:1px solid var(--border);padding-top:8px">${
          _T('Every box has a ? that explains what it does.', 'Cada casilla tiene un ? que la explica.')}</div>
      </div>
      <div class="sim-layout">
        <aside class="sim-config">${_simConfigHtml()}</aside>
        <div class="sim-results" id="simResTop">
          ${_simCmpHtml()}
          ${_simResultHtml()}
        </div>
      </div>
    </div>
  </div>`
  const cfg = host.querySelector('.sim-config')
  if (cfg && cfgScroll) cfg.scrollTop = cfgScroll
}

export { _simRender as renderSimulator }
