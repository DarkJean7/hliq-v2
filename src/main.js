import './style.css'
window.__build = typeof __HLIQ_BUILD__ !== 'undefined' ? __HLIQ_BUILD__ : ''
const _il = document.getElementById('init-loader')
if (_il) _il.remove()
import { InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { loadAccountData, loadFundingData, buildAssetMap, infoClient, fetchAllMids, fetchFrontendOpenOrders, fetchClearinghouseState, hip3Rename, coinLabel } from './api.js'
const _transport = new HttpTransport({ timeout: 30_000 })
import {
  renderOverview,
  renderSpot,
  renderOrders,
  renderTrades,
  renderPortfolioStats,
  renderMarkets,
  renderTokenDetail,
  renderCoinCard,
  computeCoinStats,
  renderManageTables,
  renderPnLCalendar,
  calDayClick,
  renderTransfers,
  ledgerAmount,
  skeletonStatCards,
  skeletonRows,
  setSortOrd,
  setSortMPos,
  setSortMOrd,
  setTradesPage,
  getTradesPage,
  renderSummaryCards,
  computeAcctStats,
  aggregateByHash,
} from './render.js'
import { renderCharts, destroyCharts, setPnlChartType, renderAcctCharts, destroyAcctCharts, setAcctPnlChartType, zoomAcctChartsToPeriod, renderMobTradeChart, updateMobTradeChartData, destroyMobTradeChart, resetMobTradeChart, renderPerfChart, destroyPerfCharts } from './charts.js'
import 'hammerjs'
import Chart from 'chart.js/auto'
import zoomPlugin from 'chartjs-plugin-zoom'
import annotationPlugin from 'chartjs-plugin-annotation'
Chart.register(zoomPlugin, annotationPlugin)

// ── Custom candle drawing plugin ──────────────────────────────────────────────
const _candlePlugin = {
  id: 'hlCandles',
  afterDatasetsDraw(chart) {
    if (!chart._candleMode || !chart._candleData || !chart._candleData.length) return
    const ctx    = chart.ctx
    const meta   = chart.getDatasetMeta(0)
    const yScale = chart.scales.y
    const area   = chart.chartArea
    const n      = Math.min(chart._candleData.length, meta.data.length)
    if (!n) return
    const candleW = n >= 2 && meta.data[1]
      ? Math.max(1, (meta.data[1].x - meta.data[0].x) * 0.7)
      : Math.max(1, (area.right - area.left) / n * 0.7)
    const halfW = candleW / 2
    const xs = chart.scales.x
    const xmin = xs ? xs.min : -Infinity, xmax = xs ? xs.max : Infinity
    ctx.save()
    ctx.beginPath(); ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); ctx.clip()
    for (let i = 0; i < n; i++) {
      const d = chart._candleData[i]; if (!d) continue
      if (d.x < xmin || d.x > xmax) continue   // only draw candles in view
      const x = meta.data[i].x
      const o = parseFloat(d.o), c = parseFloat(d.c)
      const h = parseFloat(d.h), l = parseFloat(d.l)
      const col = c >= o ? '#00e5a0' : '#ff4d6d'
      const yO = yScale.getPixelForValue(o), yC = yScale.getPixelForValue(c)
      const yH = yScale.getPixelForValue(h), yL = yScale.getPixelForValue(l)
      ctx.strokeStyle = col; ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, yH); ctx.lineTo(x, yL); ctx.stroke()
      ctx.fillStyle = col
      ctx.fillRect(x - halfW, Math.min(yO, yC), candleW, Math.max(1, Math.abs(yO - yC)))
    }
    ctx.restore()
  },
}

// ── Mark dot plugin — sits at the tip of the last visible data point ──────────
const _markDotPlugin = {
  id: 'markDot',
  afterDraw(chart) {
    const dot = document.getElementById('markDot')
    if (!dot) return
    const meta = chart.getDatasetMeta(0)
    if (!meta?.data?.length) { dot.style.display = 'none'; return }
    const last = meta.data[meta.data.length - 1]
    const area = chart.chartArea
    if (!last || !area || last.x < area.left || last.x > area.right ||
        last.y < area.top  || last.y > area.bottom) {
      dot.style.display = 'none'; return
    }
    dot.style.left    = last.x + 'px'
    dot.style.top     = last.y + 'px'
    const _core = dot.querySelector('.mark-dot-core')
    const _ring = dot.querySelector('.mark-dot-ring')
    if (_core) _core.style.background = _chartDotColor
    if (_ring) _ring.style.background = _chartDotColor === '#00e5a0' ? 'rgba(0,229,160,0.5)' : 'rgba(255,77,109,0.5)'
    dot.style.display = 'flex'
  },
}
// ── Y-axis price box labels (replaces default muted tick text) ────────────────
function _rrect(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}
const _yPriceBoxPlugin = {
  id: 'yPriceBoxes',
  afterDraw(chart) {
    const yScale = chart.scales.y
    const area   = chart.chartArea
    if (!yScale || !area || !yScale.ticks?.length) return
    // Chart.js already applies ctx.scale(dpr,dpr) — draw in CSS pixels directly
    const ctx  = chart.ctx
    ctx.save()
    ctx.font         = '600 9px "JetBrains Mono", monospace'
    ctx.textBaseline = 'middle'
    ctx.textAlign    = 'left'
    const padX = 5, boxH = 15, r = 3
    for (const tick of yScale.ticks) {
      const v = tick.value
      const y = yScale.getPixelForValue(v)
      if (y < area.top || y > area.bottom) continue
      const label = v >= 1000
        ? v.toLocaleString('en-US', { maximumFractionDigits: 0 })
        : v >= 1 ? v.toFixed(2) : v.toPrecision(4)
      const tw = ctx.measureText(label).width
      const bx = area.right + 4
      _rrect(ctx, bx, y - boxH / 2, tw + padX * 2, boxH, r)
      ctx.fillStyle = 'rgba(18,18,30,0.9)'; ctx.fill()
      ctx.strokeStyle = 'rgba(255,255,255,0.13)'; ctx.lineWidth = 0.5; ctx.stroke()
      ctx.fillStyle = '#9999bb'
      ctx.fillText(label, bx + padX, y)
    }
    ctx.restore()
  },
}
Chart.register(_candlePlugin, _markDotPlugin, _yPriceBoxPlugin)
import {
  connectAgentKey,
  disconnect,
  isConnected,
  getWalletAddress,
  placeMarketOrder,
  placeLimitOrder,
  placeOutcomeOrder,
  placeTriggerOrder,
  closePosition,
  adjustIsolatedMargin,
  cancelOrder,
  cancelOrders,
  modifyOrderPrice,
  parseOrderResult,
  approveBuilderFee,
  approveAgentKey,
  setBuilderFeeEnabled,
  isBuilderFeeEnabled,
  applyReferrer,
  fetchCandles,
  fetchMarketCtxs,
  fetchPerpCategories,
  fetchSpotMeta,
  fetchSpotMarketCtxs,
  fetchDexMarketCtxs,
} from './trading.js'
import {
  getDiscoveredWallets,
  getMainAddress,
  isMainWalletConnected,
  getMainSigner,
  connectWallet,
  connectWalletSilent,
  disconnectMainWallet,
  onWalletDisconnect,
  generateAgentWallet,
  ensureChain,
  getHlSigner,
} from './wallet.js'
import { deposit, withdraw, getUsdcBalance } from './defi.js'
import { fmtUSD, fmtPrice, fmtSize, fmtPnL, fmtCompact, esc, parseFills, parseFunding } from './format.js'
import {
  initRisk, updateAccountValue, computeLossStreak,
  maybeSendLiqNotification, checkLiquidation,
  isPaused, resume, getRiskState,
  setThresholds, requestNotifications, notifPermission, showNotif,
} from './risk.js'

// ─── STATE ────────────────────────────────────────────────────────────────────
const INITIAL_STATE = () => ({
  addr:           null,
  perpState:      null,
  spotState:      null,
  openOrders:     [],
  ocTokenMap:     {},   // '#N' → { name: question, side: 'Yes'/'No' }
  fills:          [],
  funding:        [],
  portfolio:      [],
  allMids:        {},
  assetMap:       {},
  webData:        null,
  sessionStart:   null,
  subAccounts:    [],
  selectedCoin:   null,
  tradeSide:      'long',
  orderType:      'market',
  leverage:       parseInt(localStorage.getItem('hliq_leverage')) || 5,   // persist across markets/sessions
  isIsolated:     localStorage.getItem('hliq_isolated') === '1',
  sizeMode:       'usd',   // 'usd' or 'coin'
  editingPos:     null,
  closingPos:     null,
  currentPeriod:  'day',
  ledger:         [],
  calMonth:       new Date().getMonth(),
  calYear:        new Date().getFullYear(),
  transferFilter: 'all',
})
let state = INITIAL_STATE()
window.__getState = () => state

// Performance tab chart state (interactive cumulative-PnL charts)
let _perfType   = 'accum'   // 'accum' (net: realized − fees + funding) | 'realized' (gross closed PnL)
let _perfPeriod = 'All'     // '1D' | '1W' | '1M' | 'All'
let _perfData   = null      // { coins, marketCoins, fillsByCoin, fundByCoin }

// ─── STEP LABELS ─────────────────────────────────────────────────────────────
const STEP_LABELS = [
  'Perp positions & margin',
  'Spot balances',
  'Orders, fills, portfolio & prices',
]

function setStep(n, status) {
  const el = document.getElementById('step' + n)
  if (!el) return
  el.className   = 'load-step ' + status
  el.textContent = (status === 'done' ? '✓ ' : '→ ') + STEP_LABELS[n - 1]
}

// ─── RECENT ADDRESSES ────────────────────────────────────────────────────────
const RECENT_ADDRS_KEY = 'hliq_recent_addrs'
const MAX_RECENT       = 5

function pushRecentAddr(addr) {
  let recent = []
  try { recent = JSON.parse(localStorage.getItem(RECENT_ADDRS_KEY)) || [] } catch {}
  recent = [addr, ...recent.filter(a => a.toLowerCase() !== addr.toLowerCase())].slice(0, MAX_RECENT)
  localStorage.setItem(RECENT_ADDRS_KEY, JSON.stringify(recent))
  renderRecentAddrs()
}

function renderRecentAddrs() {
  const el = document.getElementById('recentAddrsRow')
  if (!el) return
  let recent = []
  try { recent = JSON.parse(localStorage.getItem(RECENT_ADDRS_KEY)) || [] } catch {}
  if (!recent.length) { el.innerHTML = ''; return }
  el.innerHTML = `
    <div class="recent-addrs-row">
      <span class="recent-addrs-label">Recent</span>
      ${recent.map(a => {
        const label = WM.getLabel(a)
        const short = a.slice(0, 6) + '…' + a.slice(-4)
        return `<button class="btn-recent-addr" title="${esc(a)}"
          onclick="window.__quickLoad('${esc(a)}')">${esc(label || short)}</button>`
      }).join('')}
    </div>`
}

// ─── i18n ─────────────────────────────────────────────────────────────────────
const _LANG_NAMES = { en:'English', es:'Español (LatAm)', pt:'Português', fr:'Français', de:'Deutsch', zh:'中文', ja:'日本語', ko:'한국어', ru:'Русский', it:'Italiano', tr:'Türkçe', ar:'العربية' }
// Map a UI language code to the actual translation locale. Spanish → Latin American (es-419)
// rather than Spain's generic 'es'. Used as both the API langpair and the cache key.
const _xlLang = l => (l === 'es' ? 'es-419' : l)
let _i18nCache  = {}
let _currentLang = 'en'
const _origNodes = new Map()   // textNode → original full textContent

function _i18nLoadCache() {
  // _g = Google-translate cache version (higher quality than the old MyMemory cache)
  try { _i18nCache = JSON.parse(localStorage.getItem('hliq_i18n_g') || '{}') } catch { _i18nCache = {} }
}

function _i18nShouldSkip(text) {
  if (!text || text.length < 2) return true
  // pure numbers / symbols / prices / tickers
  if (/^[\d\s$%+\-.,/:°()\[\]{}~*@#^&|<>]+$/.test(text)) return true
  if (/^0x[0-9a-fA-F]{6,}/.test(text)) return true       // wallet addresses
  if (/^[A-Z][A-Z0-9]{1,5}(-[A-Z0-9]+)?$/.test(text)) return true  // BTC, ETH-PERP
  if (/^\$?[\d,]+\.?\d*[kKmMbB%]?$/.test(text)) return true         // $1,234 / 5.6k
  if (/^\d+[dhms]\s/.test(text)) return true                         // 5d 3h countdown
  return false
}

async function _i18nBatchFetch(texts, lang) {
  const L = _xlLang(lang)
  const toFetch = texts.filter(t => !_i18nCache[L]?.[t])
  if (!toFetch.length) return
  // Batch into ≤400-char chunks joined by \n
  let batch = [], len = 0
  const send = async b => {
    if (!b.length) return
    try {
      // Google Translate's public endpoint — far better quality than MyMemory. Lines are
      // joined by \n; the response keeps those boundaries, so split back 1:1.
      const q = b.join('\n')
      const r = await fetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(L)}&dt=t&q=${encodeURIComponent(q)}`)
      const j = await r.json()
      const parts = (j?.[0] || []).map(s => s?.[0] ?? '').join('').split('\n')
      if (!_i18nCache[L]) _i18nCache[L] = {}
      if (parts.length === b.length) b.forEach((orig, i) => { if (parts[i] && parts[i] !== orig) _i18nCache[L][orig] = parts[i] })
    } catch {}
  }
  for (const t of toFetch) {
    if (len + t.length + 1 > 400) { await send(batch); batch = []; len = 0 }
    batch.push(t); len += t.length + 1
  }
  await send(batch)
  localStorage.setItem('hliq_i18n_g', JSON.stringify(_i18nCache))
}

async function _translateDOM(lang) {
  if (lang === 'en') {
    for (const [node, orig] of _origNodes) node.textContent = orig
    _origNodes.clear()
    return
  }

  // Collect all translatable text nodes
  const nodes = []
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName
      if (!tag || ['SCRIPT','STYLE','INPUT','TEXTAREA','CANVAS'].includes(tag)) return NodeFilter.FILTER_REJECT
      // skip elements that update every second (prices, countdowns)
      if (node.parentElement?.closest('.oc-countdown, .topbar-price, .pos-liq, [id^="oc-cd-"], [id^="oc-chance-"]')) return NodeFilter.FILTER_REJECT
      const text = (_origNodes.get(node) ?? node.textContent).trim()
      if (_i18nShouldSkip(text)) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let n; while (n = walker.nextNode()) nodes.push(n)

  // Unique originals not yet cached
  const originals = nodes.map(n => (_origNodes.get(n) ?? n.textContent).trim())
  const unique = [...new Set(originals.filter(t => !_i18nShouldSkip(t)))]
  await _i18nBatchFetch(unique, lang)

  // Apply to DOM
  const L = _xlLang(lang)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    const origFull = _origNodes.get(node) ?? node.textContent
    const origTrim = origFull.trim()
    const t = _i18nCache[L]?.[origTrim]
    if (!t || t === origTrim) continue
    if (!_origNodes.has(node)) _origNodes.set(node, origFull)
    node.textContent = origFull.replace(origTrim, t)
  }
}

async function _applyLang(lang) {
  _currentLang = lang
  document.querySelectorAll('.lang-chip').forEach(b => b.classList.toggle('active', b.dataset.lang === lang))
  const nameEl = document.getElementById('langCurrentName')
  if (nameEl) nameEl.textContent = _LANG_NAMES[lang] || lang
  document.documentElement.lang = lang
  await _translateDOM(lang)
}

window.__setLang = function(lang) {
  localStorage.setItem('hliq_lang', lang)
  _applyLang(lang)
}

// ─── WALLET MANAGER ──────────────────────────────────────────────────────────
const WM = {
  load()              { return JSON.parse(localStorage.getItem('savedWallets') || '[]') },
  save(list)          {
    localStorage.setItem('savedWallets', JSON.stringify(list))
    // Wallet list changed — re-sync the push subscription so removed
    // accounts stop alerting and new ones start (no-op if notifs are off)
    try { _registerPushDebounced() } catch {}
  },
  getLabel(addr)      { return this.load().find(w => w.addr === addr)?.label ?? null },
  upsert(addr, label) {
    const list = this.load()
    const ex   = list.find(w => w.addr === addr)
    if (ex) ex.label = label; else list.push({ addr, label })
    this.save(list)
  },
  remove(addr) { this.save(this.load().filter(w => w.addr !== addr)) },
}

function renderSavedWallets() {
  const el = document.getElementById('savedWalletsRow')
  if (!el) return
  const list = WM.load()
  if (!list.length) { el.innerHTML = ''; return }
  el.innerHTML = `
    <div class="saved-wallets-row">
      <span class="saved-wallets-label">Saved wallets</span>
      ${list.map(w => `
        <button class="btn-wallet-chip" onclick="window.__quickLoad('${esc(w.addr)}')">
          ${esc(w.label)}
        </button>
        <button class="btn-wallet-chip-del" title="Remove" onclick="window.__removeWallet('${esc(w.addr)}')">✕</button>
      `).join('')}
    </div>`
}

function renderWalletStrip(addr) {
  const el = document.getElementById('walletStrip')
  if (!el) return
  const short   = addr.slice(0, 8) + '...' + addr.slice(-6)
  const label   = WM.getLabel(addr)
  const list    = WM.load()
  const isSaved = !!label
  const subs    = state.subAccounts ?? []

  const totalAccounts = list.length + subs.length
  const badgeHtml     = totalAccounts > 0 ? `<span class="ws-count">${totalAccounts}</span>` : ''

  // ── Saved wallet rows ──
  const walletRowsHtml = list.map(w => {
    const isCurrent = w.addr.toLowerCase() === addr.toLowerCase()
    const wShort    = w.addr.slice(0, 8) + '...' + w.addr.slice(-6)
    return `
      <div class="ws-wallet-row${isCurrent ? ' ws-wallet-current' : ''}"
           data-ws-addr="${esc(w.addr)}"
           onclick="window.__switchWallet('${esc(w.addr)}')">
        <div class="ws-wallet-row-info">
          <span class="ws-wallet-row-name">${esc(w.label)}</span>
          <span class="ws-wallet-row-addr">${wShort}</span>
        </div>
        <div class="ws-wallet-row-acts" onclick="event.stopPropagation()">
          <button class="ws-row-btn"     title="Rename" onclick="window.__panelRename('${esc(w.addr)}')">✎</button>
          <button class="ws-row-btn del" title="Remove" onclick="window.__panelRemove('${esc(w.addr)}')">✕</button>
        </div>
      </div>`
  }).join('')

  // ── Sub-accounts section ──
  const subsHtml = subs.length ? `
    <div class="ws-panel-divider"></div>
    <div class="ws-panel-section">
      <div class="ws-panel-section-label">Sub-accounts</div>
      <div class="ws-sub-pills">
        ${subs.map(s => {
          const subShort = s.subAccountUser.slice(0, 6) + '…' + s.subAccountUser.slice(-4)
          const isActive = s.subAccountUser.toLowerCase() === addr.toLowerCase()
          return `<button class="ws-sub-pill${isActive ? ' active-sub' : ''}"
            onclick="window.__quickLoad('${esc(s.subAccountUser)}')">
            ${esc(s.name || subShort)}
          </button>`
        }).join('')}
      </div>
    </div>` : ''

  // ── Save unsaved wallet ──
  const saveRowHtml = !isSaved ? `
    <div class="ws-panel-divider"></div>
    <div class="ws-panel-save-row">
      <input class="ws-panel-input" id="wsPanelNameInput" placeholder="Name this wallet…"
        onkeydown="if(event.key==='Enter')window.__panelSave()" />
      <button class="ws-panel-save-btn" onclick="window.__panelSave()">Save</button>
    </div>` : ''

  el.innerHTML = `
    <div class="ws-bar">
      <div class="ws-identity">
        ${label ? `<div class="ws-name">${esc(label)}</div>` : ''}
        <div class="ws-addr"><span>${short}</span></div>
      </div>

      <div class="ws-actions">
        <div class="ws-switcher-wrap" id="wsSwitcherWrap">
          <button class="ws-switcher-btn" id="wsSwitcherBtn" onclick="window.__toggleWalletPanel()">
            Accounts ${badgeHtml} <span class="ws-chevron">▾</span>
          </button>
          <div class="ws-panel" id="wsPanel">
            ${list.length ? `
              <div class="ws-panel-section">
                <div class="ws-panel-section-label">Saved Wallets</div>
                ${walletRowsHtml}
              </div>` : ''}
            ${saveRowHtml}
            ${subsHtml}
          </div>
        </div>
        <button class="ws-btn ws-retry-btn" id="wsRetryBtn" onclick="window.__retryRefresh()" title="Force reload all data"><span class="ws-retry-icon">↺</span> Reload</button>
        <button class="ws-btn" onclick="downloadJSON()">⬇ JSON</button>
        <button class="ws-btn" onclick="downloadCSV()">⬇ CSV</button>
        <button class="ws-btn" onclick="resetDashboard()">← New</button>
      </div>
    </div>`
}

window.__quickLoad = function(addr) {
  document.getElementById('walletInput').value = addr
  loadDashboard()
}
window.__switchWallet = function(addr) {
  if (!addr) return
  document.getElementById('walletInput').value = addr
  loadDashboard()
}
// ── Wallet panel actions ──────────────────────────────────────────────────────
function _positionWsPanel() {
  const btn   = document.getElementById('wsSwitcherBtn')
  const panel = document.getElementById('wsPanel')
  if (!btn || !panel) return
  const rect = btn.getBoundingClientRect()
  panel.style.top  = (rect.bottom + 6) + 'px'
  panel.style.left = Math.max(4, rect.right - 280) + 'px'
}

function _reopenWsPanel() {
  _positionWsPanel()
  document.getElementById('wsPanel')?.classList.add('open')
  document.getElementById('wsSwitcherBtn')?.classList.add('open')
}

window.__toggleWalletPanel = function() {
  const panel = document.getElementById('wsPanel')
  const btn   = document.getElementById('wsSwitcherBtn')
  if (!panel) return
  const isOpen = panel.classList.toggle('open')
  btn?.classList.toggle('open', isOpen)
  if (isOpen) _positionWsPanel()
}

window.__panelRename = function(addr) {
  const row = document.querySelector(`[data-ws-addr="${addr}"]`)
  if (!row) return
  const nameSpan = row.querySelector('.ws-wallet-row-name')
  if (!nameSpan) return
  const current = WM.getLabel(addr) ?? ''
  const safeId  = 'ren_' + addr.slice(2, 10)
  nameSpan.outerHTML = `<input class="ws-panel-rename-input" id="${safeId}"
    value="${esc(current)}"
    onblur="window.__panelRenameSave('${esc(addr)}', this.value)"
    onkeydown="if(event.key==='Enter')this.blur();if(event.key==='Escape')window.__panelRenameSave('${esc(addr)}', null)" />`
  document.getElementById(safeId)?.select()
}

window.__panelRenameSave = function(addr, label) {
  if (label !== null && label.trim()) WM.upsert(addr, label.trim())
  renderWalletStrip(state.addr)
  renderSavedWallets()
  _reopenWsPanel()
}

window.__panelRemove = function(addr) {
  WM.remove(addr)
  if (state.addr && addr.toLowerCase() === state.addr.toLowerCase()) {
    resetDashboard()
  } else {
    renderWalletStrip(state.addr)
    renderSavedWallets()
    _reopenWsPanel()
  }
}

window.__panelSave = function() {
  const input = document.getElementById('wsPanelNameInput')
  const label = input?.value?.trim()
  if (!label) return
  WM.upsert(state.addr, label)
  renderWalletStrip(state.addr)
  renderSavedWallets()
  _reopenWsPanel()
}

window.__removeWallet = function(addr) {
  WM.remove(addr)
  if (state.addr === addr) resetDashboard()
  else renderSavedWallets()
}

// Market metadata is identical for every account and its fan-out over ~9 perp
// dexes takes ~8s. Cache it for the whole session so account *switches* never
// re-pay that cost — only the per-account calls gate the first paint.
let _metaCache = null   // { allMetas, assetMap, perpNames, allMids }

// ─── BOOT SPLASH ──────────────────────────────────────────────────────────────
let _bootShownAt = 0
function _showBootSplash(addr) {
  const el = document.getElementById('bootSplash')
  if (!el) return
  const w = document.getElementById('bootWallet')
  if (w && addr) w.textContent = addr.slice(0, 6) + '…' + addr.slice(-6)
  const p = document.getElementById('bootPos'); if (p) p.textContent = 'positions'
  el.classList.remove('hide')
  // Replay the boot-log line reveal on every show (e.g. account switch)
  el.querySelectorAll('.boot-line').forEach(l => { l.style.animation = 'none'; void l.offsetWidth; l.style.animation = '' })
  el.classList.add('show')
  _bootShownAt = Date.now()
}
function _hideBootSplash() {
  const el = document.getElementById('bootSplash')
  if (!el || !el.classList.contains('show')) return
  const wait = Math.max(0, 1400 - (Date.now() - _bootShownAt))   // min on-screen time
  setTimeout(() => {
    el.classList.add('hide')
    setTimeout(() => el.classList.remove('show', 'hide'), 480)
  }, wait)
}
function _bootSetPos(n) {
  const p = document.getElementById('bootPos')
  if (p) p.textContent = n === 1 ? '1 position' : `${n} positions`
}

// ─── LOAD DASHBOARD ──────────────────────────────────────────────────────────
async function loadDashboard() {
  const addr = document.getElementById('walletInput').value.trim()

  if (!addr || !addr.startsWith('0x') || addr.length < 42) {
    showError('Please enter a valid 0x wallet address (42+ characters).')
    return
  }
  localStorage.setItem('walletAddr', addr)

  _showBootSplash(addr)   // full-screen boot sequence until account data lands
  setTimeout(_hideBootSplash, 12000)   // safety: never let the splash get stuck

  document.getElementById('loadBtn').disabled = true
  document.getElementById('errorBox').classList.remove('active')
  document.getElementById('inputArea').style.display = 'none'

  const isMobile = window.innerWidth <= 768

  // Immediately switch to mobile view to avoid flash of desktop UI
  if (isMobile) {
    const _appEl = document.querySelector('.app')
    if (_appEl) _appEl.style.display = 'none'
    const _mvEl = document.getElementById('mobileView')
    if (_mvEl) { _mvEl.style.display = ''; _mvEl.classList.add('mob-view-active') }
    const _mcEl = document.getElementById('mobVContent')
    if (_mcEl) _mcEl.innerHTML = '<div class="mob-v-empty" style="padding:32px 16px">Loading…</div>'
    const _balEl = document.getElementById('mobVBalance')
    if (_balEl) _balEl.textContent = '—'
  }

  // Seed state with safe empty defaults so renders don't crash before data arrives
  state = {
    ...state, addr,
    perpState:   { assetPositions: [], withdrawable: '0', marginSummary: {} },
    spotState:   { balances: [] },
    openOrders:  [], fills: [], funding: [],
    portfolio:   null, allMids: {}, assetMap: {}, allMetas: [],
    webData:     null, sessionStart: Date.now(),
  }
  _lastPerpCash = null   // reset transfer detector — a switch isn't a transfer

  // Explicitly hide loading overlay and show dashboard shell immediately
  document.getElementById('loadingOverlay').classList.remove('active')
  document.getElementById('dashboard').classList.add('active')
  document.body.classList.add('is-data-loading')

  pushRecentAddr(addr)
  _szSyncSlider()
  _disconnectAgentKeyUI()
  _resetMainWalletUI()
  restoreAgentKey(addr)
  restoreWalletForAddr(addr)
  serverStatus = {}
  checkServer()

  if (liveTimer)    clearInterval(liveTimer)
  if (sessionTimer) clearInterval(sessionTimer)
  if (midsTimer)    clearInterval(midsTimer)   // was leaking one per account switch
  liveTimer    = setInterval(refreshLive, 5000)
  sessionTimer = setInterval(tickSessionUptime, 1000)
  midsTimer    = setInterval(() => {
    if (state.allMetas) fetchAllMids(state.allMetas).then(m => { state.allMids = m }).catch(() => {})
  }, 60000)

  try {
    // ── Phase 1: account value first ──────────────────────────────────────────
    // Only the two per-account calls (~0.8s) gate the first paint. allPerpMetas
    // fans out over ~9 dexes (~8s) and is identical for every account, so it's
    // cached for the session and never blocks account value on a switch.
    const [perpState, spotState] = await Promise.all([
      infoClient.clearinghouseState({ user: addr }),
      infoClient.spotClearinghouseState({ user: addr }),
    ])

    if (_metaCache) {
      _perpNames = _metaCache.perpNames
      state = { ...state, perpState, spotState, allMids: _metaCache.allMids ?? {}, assetMap: _metaCache.assetMap, allMetas: _metaCache.allMetas }
    } else {
      state = { ...state, perpState, spotState }
    }

    renderAll()
    renderMobileView()
    _bootSetPos((perpState.assetPositions ?? []).filter(p => parseFloat(p.position?.szi ?? 0) !== 0).length)

    const _wdrawEl = document.getElementById('withdrawAvail')
    if (_wdrawEl) {
      const _perpWdraw = parseFloat(state.perpState?.withdrawable ?? 0)
      const _spotUSDC  = (state.spotState?.balances ?? []).find(b => b.coin === 'USDC')
      const _spotFree  = _spotUSDC ? Math.max(0, parseFloat(_spotUSDC.total ?? 0) - parseFloat(_spotUSDC.hold ?? 0)) : 0
      _withdrawAvailable = _perpWdraw + _spotFree
      _wdrawEl.textContent = `Available: ${_withdrawAvailable.toFixed(2)} USDC`
    }
    initRisk(totalPerpEquity(perpState))
    updateRiskUI()

    // ── Market metadata + mids: reuse the session cache, else fetch once ───────
    const metasReady = _metaCache
      ? Promise.resolve(_metaCache.allMetas)
      : Promise.all([infoClient.allPerpMetas(), infoClient.allMids()]).then(([allMetas, allMids]) => {
          const meta  = { universe: allMetas.flatMap(m => m.universe ?? []) }
          const names = new Set()
          for (const dex of allMetas) for (const u of (dex.universe ?? [])) names.add(u.name)
          const assetMap = buildAssetMap(meta)
          _perpNames = [...names]
          _metaCache = { allMetas, assetMap, perpNames: [...names], allMids }
          if (state.addr === addr) {
            state = { ...state, allMids: { ...allMids, ...state.allMids }, assetMap, allMetas }
            renderAll()
            renderMobileView()
          }
          return allMetas
        }).catch(() => null)

    // Once metas are available (cache or fresh), do the HIP-3 fan-out in background
    metasReady.then(allMetas => {
      if (state.addr !== addr || !allMetas) return
      fetchAllMids(allMetas).then(merged => {
        if (state.addr === addr) state.allMids = merged
      }).catch(() => {})
      fetchClearinghouseState(addr, allMetas).then(merged => {
        if (state.addr !== addr) return
        const extra = (merged.assetPositions ?? []).slice((perpState.assetPositions ?? []).length)
        if (!extra.length) return
        state.perpState = { ...state.perpState, assetPositions: [...(state.perpState.assetPositions ?? []), ...extra] }
        renderPositionSection()
        renderMobileView()
      }).catch(() => {})
    })

    // ── Phase 2: deferred data, split so each piece paints as soon as it lands ─
    const GENESIS = 1667260800000

    // 2a. Open orders → positions/orders tables
    fetchFrontendOpenOrders(addr, state.allMetas).catch(() => []).then(openOrders => {
      if (state.addr !== addr) return
      state.openOrders = openOrders
      renderPositionSection()
    })

    // 2b. Portfolio → account value + chart (single light call)
    infoClient.portfolio({ user: addr }).catch(() => null).then(portfolio => {
      if (state.addr !== addr || !portfolio) return
      state.portfolio = _anchorPortfolio(portfolio, state.perpState)
      renderAccountSection()
    })

    // 2c. Fills: a recent window first for a fast first paint, then the full
    //     history in the background so all-time totals/calendar fill in without
    //     blocking the initial render (this was the heaviest call on load).
    const applyFills = (rawFills) => {
      if (state.addr !== addr) return
      const fills = parseFills(rawFills).map(f => ({ ...f, coin: hip3Rename(f.coin) }))
      state.fills = fills
      const FIRST_FILL_KEY = 'hliq_first_fill_' + addr
      if (fills.length > 0) localStorage.setItem(FIRST_FILL_KEY, fills[fills.length - 1].time)
      const cachedFirstFill = localStorage.getItem(FIRST_FILL_KEY)
      state.firstFillTime = cachedFirstFill ? parseInt(cachedFirstFill) : null
      computeLossStreak(fills)
      updateRiskUI()
      renderAccountSection()
      _refreshVisitedSection('trades')
      _refreshVisitedSection('calendar')
      updateMobileView(true)
      document.body.classList.remove('is-data-loading')
      _hideBootSplash()
    }
    const RECENT_MS = 14 * 24 * 60 * 60 * 1000
    infoClient.userFillsByTime({ user: addr, startTime: Date.now() - RECENT_MS, reversed: true })
      .catch(() => [])
      .then(recent => {
        applyFills(recent)
        // Full history in the background (idle) — backfills all-time totals
        setTimeout(() => {
          infoClient.userFillsByTime({ user: addr, startTime: GENESIS, reversed: true })
            .catch(() => infoClient.userFills({ user: addr }).catch(() => []))
            .then(full => { if (Array.isArray(full) && full.length) applyFills(full) })
        }, 600)
      })
      .catch(e => { console.warn('Phase 2 fills failed:', e.message); document.body.classList.remove('is-data-loading'); _hideBootSplash() })

    // 2d. outcomeMeta only labels '#N' outcome orders — fetch it idle; the
    //     Predictions tab loads its own copy when opened.
    setTimeout(() => {
      infoClient.outcomeMeta().catch(() => null).then(m => {
        if (state.addr === addr && m) { _buildOcTokenMap(m); renderPositionSection() }
      })
    }, 1500)

    // Funding + webData in background
    loadFundingData(addr, { mobile: isMobile }).then(({ funding, webData }) => {
      if (state.addr !== addr) return
      state.funding = parseFunding(funding)
      state.webData = webData ?? null
      renderAccountSection()
    }).catch(e => console.warn('Background funding load failed:', e.message))

    if (!isMobile) fetchAllTimeVolume(addr)
    setTimeout(() => { fetchLedger(addr); fetchSubAccounts(addr) }, 4000)

  } catch (e) {
    console.error(e)
    document.getElementById('dashboard').classList.remove('active')
    document.getElementById('inputArea').style.display = ''
    document.getElementById('loadBtn').disabled = false
    document.body.classList.remove('is-data-loading')
    _hideBootSplash()
    showError('Failed to load account: ' + e.message)
  }
}

// ─── RENDER SECTIONS ──────────────────────────────────────────────────────────
function renderAccountSection() {
  const { perpState, spotState, fills, funding, portfolio, allMids, openOrders, ledger } = state
  renderOverview({ perpState, spotState, fills, funding, openOrders, allMids, portfolio, webData: state.webData, sessionStart: state.sessionStart, firstFillTime: state.firstFillTime ?? null, ledger: ledger ?? [], addr: state.addr })
  renderPortfolioStats({ perpState, spotState, fills, funding, portfolio, webData: state.webData })
  renderSummaryCards(fills, perpState, spotState, portfolio)
}

function renderPositionSection() {
  const { perpState, spotState, openOrders, allMids } = state
  renderSpot(spotState, state.ocTokenMap)
  renderOrders(openOrders, perpState, state.ocTokenMap)
  renderOutcomePositions()
}

function renderHistorySection() {
  renderTrades(state.fills)
  renderPnLCalendar(state.fills, state.calMonth, state.calYear, state.ledger)
  renderTransfers(state.ledger, state.transferFilter, state.addr)
}

function renderMarketSection() {
  const { fills, allMids, perpState, openOrders } = state
  renderMarkets({ fills, allMids, perpState })
  renderManageTables(perpState, openOrders, allMids)
  populateCoinDropdown()
  updateTradeBalance()
  _updateAvailDisplay()
}

// ─── LAZY TAB RENDERING ───────────────────────────────────────────────────────
// Heavy, full-history-dependent tabs (trades table, calendar, transfers) are not
// rendered at load — only when first opened. overview + positions render eagerly.
const _renderedTabs = new Set(['overview', 'positions'])

function _renderLazyTab(name) {
  switch (name) {
    case 'trades':    renderTrades(state.fills); break
    case 'calendar':  renderPnLCalendar(state.fills, state.calMonth, state.calYear, state.ledger); break
    case 'transfers': renderTransfers(state.ledger, state.transferFilter, state.addr); break
  }
}

// Render a deferred tab the first time it's opened.
function _ensureTabRendered(name) {
  if (_renderedTabs.has(name)) return
  _renderedTabs.add(name)
  try { _renderLazyTab(name) } catch (e) { console.error('lazy tab render', name, e) }
}

// Re-render a deferred tab only if it's already been shown (background data update).
function _refreshVisitedSection(name) {
  if (_renderedTabs.has(name)) { try { _renderLazyTab(name) } catch (e) { console.error(e) } }
}

// ─── RENDER ALL ───────────────────────────────────────────────────────────────
function renderAll() {
  renderWalletStrip(state.addr)
  restoreAssetLists(state.addr)

  if (state.fills.length > 0 || state.webData) {
    renderAccountSection()
  } else {
    // Fills not loaded yet — show skeleton to avoid flash of zeros
    const el = document.getElementById('overviewStats')
    if (el) el.innerHTML =
      `<div class="overview-hero-row">${skeletonStatCards(4)}</div>` +
      `<div class="overview-perf-row">${skeletonStatCards(12)}</div>`
  }
  renderPositionSection()
  // History (trades/calendar/transfers) and market/trade tabs render lazily on
  // first visit — see _ensureTabRendered in switchTab. The trade tab's dropdown
  // and balance still need to exist for quick-trade flows, so prime them once.
  try { populateCoinDropdown(); updateTradeBalance(); _updateAvailDisplay() } catch {}
  updateWatchTicker()
  _updateSidebarAccount()

  setTimeout(() => renderChartPeriod('day'), 80)
}

function _updateMobTabCounts(posCount, ordCount) {
  const mobPos = document.getElementById('mobPosCount')
  const mobOrd = document.getElementById('mobOrdCount')
  if (mobPos) mobPos.textContent = posCount  ?? 0
  if (mobOrd) mobOrd.textContent = ordCount ?? 0
  const isOutcome = c => typeof c === 'string' && (c[0] === '+' || c[0] === '#' || /^o\d/.test(c))
  const _bals = (state.spotState?.balances ?? []).filter(b => parseFloat(b.total) > 0)
  const mobOc = document.getElementById('mobOcCount')
  if (mobOc) {
    const ocCount = _bals.filter(b => isOutcome(b.coin)).length
    mobOc.textContent = ocCount
    mobOc.style.display = ocCount > 0 ? '' : 'none'
  }
  const mobSpot = document.getElementById('mobSpotCount')
  if (mobSpot) {
    const spCount = _bals.filter(b => !isOutcome(b.coin)).length
    mobSpot.textContent = spCount
    mobSpot.style.display = spCount > 0 ? '' : 'none'
  }
}

function _updateSidebarAccount() {
  const { perpState, addr } = state
  if (!perpState?.marginSummary) return
  // Sidebar "Orders" item shows the open-order count (positions now live on Overview)
  const sb = document.getElementById('sidebarPosCount')
  if (sb) sb.textContent = (state.openOrders ?? []).length
  const sbAddr = document.getElementById('statusbarAddr')
  if (sbAddr && addr) sbAddr.textContent = addr.slice(0, 6) + '...' + addr.slice(-4)
}

function totalPerpEquity(perpState) {
  return computeAcctStats(perpState, state.spotState, state.fills, state.portfolio).accountValue
}

// ─── RISK UI ──────────────────────────────────────────────────────────────────
function updateRiskUI() {
  const el = document.getElementById('riskPanel')
  if (!el) return
  // Don't rebuild while the user is typing in a threshold input — the 5s
  // refresh was wiping edits mid-keystroke ("settings don't work")
  if (el.contains(document.activeElement) && document.activeElement?.tagName === 'INPUT') return

  const risk = getRiskState()
  const liq  = state.perpState ? checkLiquidation(state.perpState, state.allMids) : null

  const drawdownColor = risk.drawdownPct >= risk.thresholds.maxDrawdownPct
    ? 'var(--red)' : risk.drawdownPct >= risk.thresholds.maxDrawdownPct * 0.6
    ? 'var(--yellow)' : 'var(--green)'

  const streakColor = risk.lossStreak >= risk.thresholds.maxLossStreak
    ? 'var(--red)' : risk.lossStreak >= risk.thresholds.maxLossStreak - 2
    ? 'var(--yellow)' : 'var(--text)'

  const liqColor = !liq ? 'var(--muted)'
    : liq.bufferPct <= risk.thresholds.liqWarningPct ? 'var(--red)'
    : liq.bufferPct <= risk.thresholds.liqWarningPct * 2 ? 'var(--yellow)'
    : 'var(--green)'

  const _notifPerm = notifPermission()
  const notifBtnLabel = _notifPerm === 'granted'   ? '✓ Notifications On'
    : _notifPerm === 'denied'    ? '✗ Blocked — allow in browser settings'
    : _notifPerm === 'insecure'  ? '✗ Requires HTTPS'
    : _notifPerm === 'unsupported' ? '✗ Not supported on this browser'
    : 'Enable Alerts'
  const notifBtnDisabled = (_notifPerm === 'denied' || _notifPerm === 'insecure' || _notifPerm === 'unsupported') ? 'disabled' : ''
  const notifHint = _notifPerm === 'denied'
    ? 'Open your browser\'s site settings and set Notifications to "Allow", then refresh.'
    : _notifPerm === 'insecure'
    ? 'Browser notifications require a secure connection (HTTPS). The app is currently on HTTP.'
    : _notifPerm === 'unsupported'
    ? 'Your browser does not support web notifications.'
    : ''

  el.innerHTML = `
    <div class="risk-status-bar ${risk.paused ? 'risk-paused' : 'risk-active'}">
      <span class="risk-status-dot"></span>
      <span class="risk-status-label">${risk.paused ? 'TRADING PAUSED' : 'TRADING ACTIVE'}</span>
      ${risk.paused ? `<span class="risk-pause-reason">${esc(risk.pauseReason ?? '')}</span>` : ''}
      ${risk.paused ? `<button class="btn-risk-resume" onclick="window.__resumeRisk()">Resume</button>` : ''}
    </div>

    <div class="risk-metrics">
      <div class="risk-metric">
        <div class="risk-metric-label">Session Drawdown</div>
        <div class="risk-metric-value" style="color:${drawdownColor}">${risk.drawdownPct > 0 ? '−' : ''}${risk.drawdownPct.toFixed(2)}%</div>
        <div class="risk-metric-sub">Now $${fmtUSD(risk.currentValue ?? 0)} · Start $${fmtUSD(risk.sessionStartValue ?? 0)} · Limit ${risk.thresholds.maxDrawdownPct}%</div>
      </div>
      <div class="risk-metric">
        <div class="risk-metric-label">Loss Streak</div>
        <div class="risk-metric-value" style="color:${streakColor}">${risk.lossStreak}</div>
        <div class="risk-metric-sub">Consecutive losses · Limit ${risk.thresholds.maxLossStreak}</div>
      </div>
      <div class="risk-metric">
        <div class="risk-metric-label">Nearest Liq.</div>
        <div class="risk-metric-value" style="color:${liqColor}">
          ${liq ? liq.bufferPct.toFixed(1) + '%' : '—'}
        </div>
        <div class="risk-metric-sub">${liq ? `${liq.coin} ${liq.side} · liq $${fmtPrice(liq.liqPx)} · mark $${fmtPrice(liq.markPx)} · alert ${risk.thresholds.liqWarningPct}%` : 'No open positions'}</div>
      </div>
    </div>

    <div class="risk-thresholds">
      <div class="risk-threshold-title">Thresholds</div>
      <div class="risk-threshold-row">
        <label class="risk-threshold-label">Max Drawdown %</label>
        <input class="risk-threshold-input" id="riskDrawdownInput" type="number" min="1" max="100"
          value="${risk.thresholds.maxDrawdownPct}" oninput="window.__applyThresholds()" />
        <span class="risk-threshold-hint">Pauses trading when your account drops this % from its session peak.</span>
      </div>
      <div class="risk-threshold-row">
        <label class="risk-threshold-label">Max Loss Streak</label>
        <input class="risk-threshold-input" id="riskStreakInput" type="number" min="1" max="50"
          value="${risk.thresholds.maxLossStreak}" oninput="window.__applyThresholds()" />
        <span class="risk-threshold-hint">Pauses after this many consecutive losing closed trades in a row.</span>
      </div>
      <div class="risk-threshold-row">
        <label class="risk-threshold-label">Liq. Warning %</label>
        <input class="risk-threshold-input" id="riskLiqInput" type="number" min="1" max="100"
          value="${risk.thresholds.liqWarningPct}" oninput="window.__applyThresholds()" />
        <span class="risk-threshold-hint">Sends a browser notification when your nearest liquidation is within this % buffer.</span>
      </div>
      <button class="btn-risk-notif" onclick="window.__enableNotifs()" ${notifBtnDisabled}>
        ${notifBtnLabel}
      </button>
      ${notifHint ? `<div class="risk-notif-hint">${notifHint}</div>` : ''}
    </div>`
}

window.__resumeRisk = function () {
  resume()
  updateRiskUI()
  updateSubmitBtn()
}

window.__applyThresholds = function () {
  const drawdown = parseFloat(document.getElementById('riskDrawdownInput')?.value)
  const streak   = parseInt(document.getElementById('riskStreakInput')?.value)
  const liq      = parseFloat(document.getElementById('riskLiqInput')?.value)
  setThresholds({
    maxDrawdownPct: isNaN(drawdown) ? undefined : drawdown,
    maxLossStreak:  isNaN(streak)   ? undefined : streak,
    liqWarningPct:  isNaN(liq)      ? undefined : liq,
  })
  localStorage.setItem('hliq_risk_thresholds', JSON.stringify(getRiskState().thresholds))
}

// Restore persisted thresholds on startup (they were resetting every reload)
try { const _rt = JSON.parse(localStorage.getItem('hliq_risk_thresholds') || 'null'); if (_rt) setThresholds(_rt) } catch {}

window.__enableNotifs = function () {
  requestNotifications().then(() => updateRiskUI())
}

// ─── LIVE REFRESH ─────────────────────────────────────────────────────────────
let liveTimer    = null
let sessionTimer = null
let midsTimer    = null
let refreshFailCount    = 0
let _refreshInProgress  = false

function _updateRetryBtn(mode) {   // mode: null | 'error' | 'retrying'
  const btn = document.getElementById('wsRetryBtn')
  if (!btn) return
  btn.classList.toggle('ws-retry-error',    mode === 'error')
  btn.classList.toggle('ws-retry-spinning', mode === 'retrying')
}

function updateRefreshBanner() {
  const banner = document.getElementById('refreshErrorBanner')
  if (!banner) return
  if (refreshFailCount < 12) {
    banner.classList.remove('active')
    _updateRetryBtn(null)
    return
  }
  banner.classList.add('active')
  banner.innerHTML = `⚠ Live data paused — connection lost. <button class="refresh-error-retry" onclick="window.__retryRefresh()">Retry now</button>`
  _updateRetryBtn('error')
}

const _pollInterval = () => 5000

function _restartLiveTimer() {
  if (liveTimer) clearInterval(liveTimer)
  liveTimer = setInterval(refreshLive, _pollInterval())
  refreshLive()
}

window.__retryRefresh = async function(btn) {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null }
  refreshFailCount   = 0
  _refreshInProgress = false
  // Clear render caches so everything is force-redrawn on next tick
  _lastPosHash = null; _lastOrdHash = null; _lastAcctHash = null
  _updateRetryBtn('retrying')
  updateRefreshBanner()
  // Mobile has no #wsRetryBtn — spin the tapped icon so the user sees it working.
  const icon = btn?.querySelector?.('svg')
  const stopSpin = () => { if (icon) icon.style.animation = '' }
  if (icon) icon.style.animation = 'spin 0.8s linear infinite'
  // Failsafe: the HTTP transport has no hard timeout, so a dropped/slow connection can
  // leave refreshLive() pending forever. Stop the spinner after 12s no matter what so
  // the button never gets stuck (the live timer keeps retrying in the background).
  const failsafe = setTimeout(stopSpin, 12000)
  liveTimer = setInterval(refreshLive, _pollInterval())
  try { await refreshLive() } catch {} finally { clearTimeout(failsafe); stopSpin() }
}

// Header reload button — full app refresh: nudge the service worker for the
// latest build, then hard-reload the page so everything re-initialises.
window._mobVAppReload = async function(btn) {
  const icon = btn?.querySelector?.('svg')
  if (icon) icon.style.animation = 'spin 0.8s linear infinite'
  try {
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations()
      await Promise.all(regs.map(r => r.update().catch(() => {})))
    }
  } catch {}
  location.reload()
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (liveTimer) { clearInterval(liveTimer); liveTimer = null }
  } else if (state.addr) {
    refreshFailCount = 0
    updateRefreshBanner()
    setTimeout(_restartLiveTimer, 300)
  }
})

// iOS bfcache restore — fires when page is shown from back/forward cache
window.addEventListener('pageshow', (e) => {
  if (e.persisted && state.addr) {
    refreshFailCount = 0
    _lastPosHash = null; _lastOrdHash = null; _lastAcctHash = null
    setTimeout(_restartLiveTimer, 300)
  }
})

// Fallback for mobile browsers that don't reliably fire visibilitychange
window.addEventListener('focus', () => {
  if (!liveTimer && state.addr) {
    refreshFailCount = 0
    updateRefreshBanner()
    setTimeout(_restartLiveTimer, 300)
  }
})

function tickSessionUptime() {
  const el = document.getElementById('statSessionUptime')
  if (!el || !state.sessionStart) return
  const ms  = Date.now() - state.sessionStart
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  el.textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`
}

// Fetch all-time volume via sequential pagination — same pattern as funding.
// userFillsByTime caps at 2000 per request; we page forward until < 2000 returned.
// Only updates #statTotalVolume — touches nothing else.
async function fetchAllTimeVolume(addr) {
  try {
    const info  = new InfoClient({ transport: _transport })
    // Pre-seed seen with hashes already in state so we don't double-count
    const seen  = new Set(state.fills.map(f => f.hash).filter(Boolean))
    let   volume    = state.fills.reduce((s, f) => s + f.notional, 0)
    let   fillCount = state.fills.length
    // Start from HL launch — userFillsByTime handles pre-account dates fine
    let startTime = 1667260800000

    while (true) {
      const batch = await info.userFillsByTime({ user: addr, startTime })
        .catch(() => [])
      if (!batch.length) break

      for (const f of batch) {
        if (seen.has(f.hash)) continue
        seen.add(f.hash)
        volume    += parseFloat(f.sz) * parseFloat(f.px)
        fillCount++
      }

      if (batch.length < 2000) break

      const maxTime = Math.max(...batch.map(f => f.time))
      startTime = maxTime + 1
    }

    if (!fillCount) return
    const el = document.getElementById('statTotalVolume')
    if (el) el.textContent = '$' + fmtCompact(volume)
  } catch (e) {
    console.warn('All-time volume fetch failed:', e.message)
  }
}

async function fetchLedger(addr) {
  // Show skeleton while the ledger loads
  const summaryEl = document.getElementById('transfersSummary')
  const cardsEl   = document.getElementById('transfersCards')
  if (summaryEl) summaryEl.innerHTML = skeletonStatCards(4)
  if (cardsEl)   cardsEl.innerHTML   = `<div class="txfr-cards-skeleton">${skeletonStatCards(6)}</div>`

  try {
    const info   = new InfoClient({ transport: _transport })
    const ledger = await info.userNonFundingLedgerUpdates({ user: addr, startTime: 1667260800000 })
    state.ledger = ledger ?? []
    _refreshVisitedSection('transfers')
    _refreshVisitedSection('calendar')
    renderAccountSection()  // refresh Total Deposited card in overview
  } catch (e) {
    console.warn('Ledger fetch failed:', e.message)
    renderTransfers([], state.transferFilter)
  }
}

async function fetchSubAccounts(addr) {
  try {
    const info = new InfoClient({ transport: _transport })
    const subs = await info.subAccounts({ user: addr }).catch(() => null)
    if (!subs?.length) return
    state.subAccounts = subs
    renderWalletStrip(state.addr)
  } catch (e) {
    console.warn('Sub-accounts fetch failed:', e.message)
  }
}

// Fingerprints for skip-render optimization
let _lastPosHash  = null
let _lastOrdHash  = null
let _lastAcctHash = null
let _lastPerpCash = null   // perp balance minus uPnL — used to catch spot↔perp transfers
const _cancelledOids = new Set()  // oids removed optimistically, filtered from refreshes

function _fingerprint(obj) {
  try { return JSON.stringify(obj) } catch (e) { return null }
}

const _domCache = {}
function _dom(id) {
  return _domCache[id] || (_domCache[id] = document.getElementById(id))
}

let _refreshTick  = 0
let _activeTab    = 'overview'
let _lbTabTimer   = null
let _maTabTimer   = null
let _lbLastFetch  = 0
let _lbFetching   = false
let _maLastFetch  = 0

// Stamp the perp account value seen at portfolio-fetch time onto the snapshot
// so renders can add the live perp-equity delta between (1/min) refetches.
function _anchorPortfolio(portfolio, perpState) {
  if (Array.isArray(portfolio) && perpState?.marginSummary)
    portfolio._perpAnchor = parseFloat(perpState.marginSummary.accountValue ?? 0)
  return portfolio
}

// HIP-3 dexes the wallet currently has positions/orders in — these get fanned
// out every tick so their orders/positions stay as fresh as crypto (instead of
// flickering on the once-a-minute full fan-out).
function _activeDexSet() {
  const s = new Set()
  for (const ap of (state.perpState?.assetPositions ?? [])) {
    const c = ap.position?.coin
    if (c && c.includes(':')) s.add(c.split(':')[0].toLowerCase())
  }
  for (const o of (state.openOrders ?? [])) {
    if (o.coin && o.coin.includes(':')) s.add(o.coin.split(':')[0].toLowerCase())
  }
  return s
}

// allMetas filtered for the fan-out: full set on discovery ticks, else only the
// active dexes (or null when there's no HIP-3 activity → skip fan-out entirely).
function _fanMetas(full) {
  if (full || !state.allMetas) return state.allMetas
  const active = _activeDexSet()
  if (!active.size) return null
  const filtered = state.allMetas.filter((m, i) =>
    i === 0 || active.has(((m.universe?.[0]?.name) || '').split(':')[0].toLowerCase()))
  return filtered.length > 1 ? filtered : null
}

async function refreshLive() {
  if (_refreshInProgress) return
  _refreshInProgress = true
  // Pin the account this tick is for. If the user switches accounts while these
  // fetches are in flight, the results belong to the OLD account and must be
  // discarded — otherwise they clobber the new account's perpState/portfolio and
  // flash the wrong account value for a few seconds (most visible on mobile).
  const _reqAddr = state.addr
  try {
    const info = new InfoClient({ transport: _transport })
    _refreshTick++

    // Latest known fill timestamp — used to fetch only new fills
    const latestFillTs = state.fills.length > 0
      ? state.fills.reduce((m, f) => Math.max(m, f.time), 0)
      : Date.now() - 60 * 1000

    const shouldFetchOutcomeMeta = _refreshTick === 1 || _refreshTick % 60 === 0
    const _needsPrices = !['history', 'transfers', 'settings', 'leaderboard', 'accounts'].includes(_activeTab)
    const shouldRefreshSpot      = _refreshTick === 1 || _refreshTick % 12 === 0
    const shouldRefreshPortfolio = _refreshTick === 1 || _refreshTick % 12 === 0
    // Active HIP-3 dexes fan out every tick (so orders/positions stay fresh);
    // the full set is fanned every 12th tick to discover newly-used dexes.
    const _fullFan  = _refreshTick === 1 || _refreshTick % 12 === 0
    const _fanMeta  = _fanMetas(_fullFan)
    const [perpState, openOrders, mainMids, newRawFills, freshOutcomeMeta, freshSpot, freshPortfolio] = await Promise.all([
      fetchClearinghouseState(state.addr, _fanMeta),
      fetchFrontendOpenOrders(state.addr, _fanMeta),
      _needsPrices ? info.allMids() : Promise.resolve({}),
      // Fetch only fills newer than what we already have (startTime is exclusive on HL)
      info.userFillsByTime({ user: state.addr, startTime: latestFillTs + 1 })
        .catch(() => []),
      shouldFetchOutcomeMeta  ? info.outcomeMeta().catch(() => null)                              : Promise.resolve(null),
      shouldRefreshSpot       ? info.spotClearinghouseState({ user: state.addr }).catch(() => null) : Promise.resolve(null),
      shouldRefreshPortfolio  ? info.portfolio({ user: state.addr }).catch(() => null)             : Promise.resolve(null),
    ])
    // Account switched mid-flight — this tick's data is for the old account.
    // Drop it entirely so it can't overwrite the freshly-loaded account.
    if (state.addr !== _reqAddr) return

    if (freshSpot)      state.spotState = freshSpot
    if (freshPortfolio) state.portfolio = _anchorPortfolio(freshPortfolio, perpState)

    state.perpState  = perpState
    state.openOrders = openOrders.filter(o => !_cancelledOids.has(o.oid))

    // Catch spot↔perp transfers (e.g. a bot's margin top-up on start): they move
    // money into the perp balance without changing the unified account value, so
    // the live perp-delta would otherwise spike it. perp "cash" = accountValue −
    // uPnL stays flat under pure PnL, but jumps on a transfer/deposit. When it
    // jumps (and it isn't a fill), shift the anchor so the value stays continuous.
    {
      const _uPnl    = (perpState.assetPositions ?? []).reduce((s, p) => s + parseFloat(p.position?.unrealizedPnl ?? 0), 0)
      const _perpVal = parseFloat(perpState.marginSummary?.accountValue ?? 0)
      const _perpCash = _perpVal - _uPnl
      if (_lastPerpCash != null && Math.abs(_perpCash - _lastPerpCash) > 0.01) {
        // The only LEGIT account-value change on a tick is realized PnL − fees from any
        // new fills. Anything beyond that — isolated margin moving into/out of a bucket,
        // a spot↔perp transfer, or HL transiently mis-reporting equity right after an
        // order — is a reshuffle that must NOT move the displayed value. Shift the anchor
        // by that spurious part so opening/editing/closing a position doesn't spike.
        const _legit    = newRawFills.reduce((s, f) => s + parseFloat(f.closedPnl ?? 0) - parseFloat(f.fee ?? 0), 0)
        const _spurious = (_perpCash - _lastPerpCash) - _legit
        if (Math.abs(_spurious) > 0.01 && state.portfolio && state.portfolio._perpAnchor != null) {
          state.portfolio._perpAnchor += _spurious
        }
        // Re-baseline exactly from HL in the background. On a fill the block below already
        // refetches the portfolio, so only do it here for the no-fill (transfer) case.
        if (newRawFills.length === 0) {
          const _a = state.addr
          info.portfolio({ user: _a }).catch(() => null).then(p => {
            if (p && state.addr === _a) { state.portfolio = _anchorPortfolio(p, state.perpState); renderAccountSection() }
          })
        }
      }
      _lastPerpCash = _perpCash
    }

    // Rebuild outcome token map so '#N' coins resolve correctly in open orders,
    // then refresh the History table so any newly-resolved outcome names appear.
    if (freshOutcomeMeta) { _buildOcTokenMap(freshOutcomeMeta); _refreshVisitedSection('trades') }

    // Merge fresh prices only when on a price-displaying tab; otherwise reuse cached values
    if (_needsPrices) state.allMids = { ...state.allMids, ...mainMids }
    const allMids    = state.allMids

    // Auto-select BTC on first data load if no coin chosen yet
    if (!state.selectedCoin && allMids['BTC']) {
      window.__selectCoin('BTC')
    }

    // Merge new fills if any arrived
    if (newRawFills.length > 0) {
      const newFills = parseFills(newRawFills).map(f => ({ ...f, coin: hip3Rename(f.coin) }))
      state.fills = [...newFills, ...state.fills]
      computeLossStreak(state.fills)
      _refreshVisitedSection('trades')
      if (_activeTab === 'tokens') renderMarkets({ fills: state.fills, allMids, perpState })
      // New trade detected — refresh portfolio chart data in background, then
      // re-baseline the anchor exactly and re-render the account card so the value
      // settles on the authoritative number (no lingering spike).
      const _addr = state.addr
      info.portfolio({ user: _addr }).catch(() => null).then(p => {
        if (p && state.addr === _addr) { state.portfolio = _anchorPortfolio(p, state.perpState); renderChartPeriod(state.currentPeriod); renderAccountSection() }
      })
    }

    const posCount = (perpState.assetPositions ?? []).filter(p => parseFloat(p.position?.szi ?? 0) !== 0).length
    const _pcEl = _dom('posCount');    if (_pcEl) _pcEl.textContent = posCount
    const _pcb  = _dom('posCountBig'); if (_pcb)  _pcb.textContent = posCount
    const _ocEl = _dom('ordCount');    if (_ocEl) _ocEl.textContent = state.openOrders.length
    const _ocb  = _dom('ordCountBig'); if (_ocb)  _ocb.textContent = state.openOrders.length
    _updateMobTabCounts(posCount, state.openOrders.length)

    // Re-render account section only when key values change
    const _acctHash = `${perpState.marginSummary?.accountValue}|${state.fills.length}|${(perpState.assetPositions ?? []).reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0).toFixed(4)}`
    if (_acctHash !== _lastAcctHash) { renderAccountSection(); _lastAcctHash = _acctHash }
    updateTradeBalance()
    _updateAvailDisplay()

    const posHash  = _fingerprint(perpState.assetPositions)
    const ordHash  = _fingerprint(openOrders)
    const posChanged = posHash !== _lastPosHash
    const ordChanged = ordHash !== _lastOrdHash
    if (posChanged) { _lastPosHash = posHash }
    if (ordChanged) { renderOrders(openOrders, perpState, state.ocTokenMap); renderOutcomePositions(); _lastOrdHash = ordHash }
    if (posChanged || ordChanged) { renderManageTables(perpState, openOrders, allMids); _refreshChartLines(); _refreshMobChartLines() }

    updateAccountValue(totalPerpEquity(perpState))
    // Health & liquidation push notifications are sent SERVER-SIDE ONLY (hliq-notify),
    // which checks all tracked wallets with a streak guard. The client used to also fire
    // these for the loaded account, which could double-send or false-trigger on transient
    // partial-refresh data — so it no longer does. (Price alerts stay client-side: they're
    // a local, user-defined feature the server doesn't track.)
    _checkPriceAlerts(state.allMids)
    updateRiskUI()
    if (isPaused()) updateSubmitBtn()

    refreshFailCount = 0
    updateRefreshBanner()
    updateWatchTicker()
    if (state.selectedCoin) updateChartStats(state.selectedCoin)
    updateMobileView()

  } catch (e) {
    refreshFailCount++
    console.warn('Live refresh failed:', e.message)
    updateRefreshBanner()
    if (/429|too many/i.test(e.message)) {
      // Back off for 30s on rate-limit
      clearInterval(liveTimer)
      liveTimer = setTimeout(() => {
        liveTimer = setInterval(refreshLive, 5000)
      }, 30000)
    }
  } finally {
    _refreshInProgress = false
  }
}

// ─── PORTFOLIO CHARTS ─────────────────────────────────────────────────────────
function renderChartPeriod(period) {
  state.currentPeriod = period
  document.querySelectorAll('.chart-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period)
  })
  if (!state.portfolio?.length) return
  renderCharts(state.portfolio, period, state.fills ?? [])
}

// ─── AGENT KEY ────────────────────────────────────────────────────────────────
async function connectAgentKeyUI() {
  const keyVal   = document.getElementById('privateKeyInput').value.trim()
  const statusEl = document.getElementById('apiConnectStatus')
  const dotEl    = document.getElementById('apiStatusDot')

  if (!keyVal || !keyVal.startsWith('0x') || keyVal.length < 66) {
    statusEl.textContent = '✗ Invalid key — must be 0x followed by 64 hex characters.'
    statusEl.style.color = 'var(--red)'
    return
  }

  try {
    const addr = await connectAgentKey(keyVal)
    dotEl.classList.add('connected')
    statusEl.innerHTML = `✓ Connected: <span style="color:var(--accent)">${addr.slice(0, 6)}...${addr.slice(-4)}</span>`
    statusEl.style.color = 'var(--green)'
    if (state.addr) localStorage.setItem(_agentKeyForAddr(state.addr), keyVal)
    else localStorage.setItem('hliq_agent_key', keyVal)
    const stratInput = document.getElementById('agentKey')
    if (stratInput) stratInput.value = keyVal
    applyReferrer().catch(() => {})
    updateSubmitBtn()
    updateTradeBalance()
  } catch (e) {
    statusEl.textContent = '✗ ' + e.message
    statusEl.style.color = 'var(--red)'
    dotEl.classList.remove('connected')
  }
}

// ─── MAIN WALLET ──────────────────────────────────────────────────────────────
function openWalletPicker() {
  const list    = document.getElementById('walletPickerList')
  const wallets = getDiscoveredWallets()
  const isMob   = /iPhone|iPad|Android/i.test(navigator.userAgent)
  const appUrl  = encodeURIComponent(window.location.href)

  let html = wallets.map(w => `
    <button class="wallet-picker-btn" onclick="window.__pickWallet('${w.info.rdns}')">
      <img src="${w.info.icon}" width="28" height="28" style="border-radius:6px" onerror="this.style.display='none'"/>
      <span>${w.info.name}</span>
    </button>
  `).join('')

  if (wallets.length === 0 && !isMob) {
    html = `<p style="font-size:11px;color:var(--muted);text-align:center;padding:8px 0 4px">No wallet extensions detected in this browser.</p>`
  }

  const wcSep = (wallets.length > 0)
    ? `<div style="font-size:10px;color:var(--muted);text-align:center;margin:10px 0 6px;letter-spacing:.05em">OR SCAN WITH ANY WALLET</div>`
    : ''
  html += `
    ${wcSep}
    <button class="wallet-picker-btn" onclick="window.__pickWallet('walletconnect')">
      <svg width="28" height="28" viewBox="0 0 32 32" fill="none" style="border-radius:6px;background:#3b99fc;padding:4px">
        <path d="M9.6 12.8c3.5-3.5 9.3-3.5 12.8 0l.4.4a.4.4 0 010 .6l-1.4 1.4a.2.2 0 01-.3 0l-.6-.6c-2.4-2.4-6.4-2.4-8.8 0l-.6.6a.2.2 0 01-.3 0L9.4 13.8a.4.4 0 010-.6l.2-.4zm15.8 3l1.2 1.2a.4.4 0 010 .6l-5.6 5.6a.4.4 0 01-.6 0l-4-4a.1.1 0 00-.2 0l-4 4a.4.4 0 01-.6 0L5.4 17.6a.4.4 0 010-.6l1.2-1.2a.4.4 0 01.6 0l4 4a.1.1 0 00.2 0l4-4a.4.4 0 01.6 0l4 4a.1.1 0 00.2 0l4-4a.4.4 0 01.6 0z" fill="white"/>
      </svg>
      <span>WalletConnect <span style="color:var(--muted);font-size:10px">— Uniswap, Phantom &amp; 300+ wallets</span></span>
    </button>
  `

  list.innerHTML = html
  document.getElementById('walletPickerModal').style.display = 'flex'
}

window.__pickWallet = async function(rdns) {
  document.getElementById('walletPickerModal').style.display = 'none'
  const statusEl = document.getElementById('mainWalletStatus')
  const dotEl    = document.getElementById('mainWalletDot')
  const btn      = document.getElementById('mainWalletBtn')
  statusEl.textContent = 'Connecting...'
  statusEl.style.color = 'var(--muted)'
  try {
    const addr = await connectWallet(rdns)
    if (state.addr) localStorage.setItem(_walletRdnsForAddr(state.addr), rdns)
    try {
      statusEl.textContent = 'Approving...'
      await ensureChain('0xa4b1')   // Arbitrum — needed to sign HL user actions
      const feeResult = await approveBuilderFee(getHlSigner())
      console.log('approveBuilderFee result:', JSON.stringify(feeResult))
      setBuilderFeeEnabled(true)
    } catch (e) {
      console.error('approveBuilderFee failed:', e)
      setBuilderFeeEnabled(false)
    }
    dotEl.classList.add('connected')
    statusEl.innerHTML = `✓ <span style="color:var(--accent)">${addr.slice(0,6)}...${addr.slice(-4)}</span> · Connected`
    statusEl.style.color = 'var(--green)'
    btn.textContent = 'Disconnect'
    btn.onclick = disconnectMainWalletUI
    _updateAutoGenBtnVisibility()   // wallet now connected → auto-gen buttons relabel
    window.__updateDepositPreview()
    window.__updateWithdrawPreview()
    refreshDefiBalances()
  } catch (e) {
    const msg = /proposal expired/i.test(e.message) ? 'Session expired — please reconnect'
              : /rejected|denied|cancel/i.test(e.message) ? 'Connection rejected'
              : e.message
    statusEl.textContent = '✗ ' + msg
    statusEl.style.color = 'var(--red)'
    dotEl.classList.remove('connected')
  }
}

function disconnectMainWalletUI() {
  if (state.addr) localStorage.removeItem(_walletRdnsForAddr(state.addr))
  disconnectMainWallet()
  setBuilderFeeEnabled(false)
  const dotEl = document.getElementById('mainWalletDot')
  const statusEl = document.getElementById('mainWalletStatus')
  const btn = document.getElementById('mainWalletBtn')
  dotEl.classList.remove('connected')
  statusEl.textContent = 'Connect to enable builder fee'
  statusEl.style.color = 'var(--muted)'
  btn.textContent = 'Connect Wallet'
  btn.onclick = openWalletPicker
  _updateAutoGenBtnVisibility()   // wallet gone → buttons relabel to "Connect wallet"
}

onWalletDisconnect(disconnectMainWalletUI)

window.connectMainWalletUI  = openWalletPicker
window.closeWalletPicker    = () => { document.getElementById('walletPickerModal').style.display = 'none' }
window.__sortOrders         = (key) => { if (!state.perpState) return; setSortOrd(key); renderOrders(state.openOrders, state.perpState, state.ocTokenMap) }
window.__sortMPos           = (key) => { if (!state.perpState) return; setSortMPos(key); renderManageTables(state.perpState, state.openOrders, state.allMids) }
window.__sortMOrd           = (key) => { if (!state.perpState) return; setSortMOrd(key); renderManageTables(state.perpState, state.openOrders, state.allMids) }
window.__tradesPrevPage = () => { if (!state.fills) return; setTradesPage(Math.max(0, getTradesPage() - 1)); renderTrades(state.fills) }
window.__tradesNextPage = () => { if (!state.fills) return; setTradesPage(getTradesPage() + 1); renderTrades(state.fills) }

// ─── DEPOSIT / WITHDRAW ───────────────────────────────────────────────────────
let _depositDest = 'perps'

// Prefer element inside open mobile defi modal; fall back to global (desktop) element
function _defiEl(id) {
  const mob = document.getElementById('mobDefiModal')
  return (mob && mob.querySelector('#' + id)) || document.getElementById(id)
}

window.__setDepositDest = function(dest) {
  _depositDest = dest
  document.getElementById('depDest-perps').classList.toggle('active', dest === 'perps')
  document.getElementById('depDest-spot').classList.toggle('active', dest === 'spot')
  window.__updateDepositPreview()
}

let _usdcBalance      = null
let _withdrawAvailable = 0

window.__setDepositMax = function() {
  if (!_usdcBalance) return
  const el = _defiEl('depositAmount')
  if (el) { el.value = Math.floor(_usdcBalance * 100) / 100; window.__updateDepositPreview() }
}

window.__setWithdrawMax = function() {
  if (!_withdrawAvailable) return
  const el = _defiEl('withdrawAmount')
  if (el) { el.value = Math.floor(_withdrawAvailable * 100) / 100; window.__updateWithdrawPreview() }
}

window.__updateDepositPreview = function() {
  const amount  = parseFloat(_defiEl('depositAmount')?.value)
  const preview = _defiEl('depositPreview')
  const warning = _defiEl('depositWarning')
  const btn     = _defiEl('depositBtn')
  if (!preview) return

  const connected = isMainWalletConnected()
  const mobBanner = _defiEl('mobWalletBanner')
  if (mobBanner) mobBanner.style.display = connected ? 'none' : ''

  if (!connected) {
    btn.textContent = 'Connect Wallet'
    btn.disabled    = false
    btn.onclick     = () => window.__mobConnectWallet()
    preview.style.opacity = '0.4'
    warning.style.display = 'none'
    return
  }
  btn.onclick = () => window.__executeDeposit()
  if (!amount || amount <= 0) {
    preview.style.opacity = '0.4'
    warning.style.display = 'none'
    btn.disabled = true
    btn.textContent = 'Enter amount'
    return
  }
  if (amount < 5) {
    warning.style.display = 'block'
    warning.textContent   = '⚠ Minimum deposit is 5 USDC. Deposits below this amount will be permanently lost.'
    preview.style.opacity = '0.4'
    btn.disabled = true
    btn.textContent = 'Amount too low'
    return
  }
  if (_usdcBalance !== null && amount > _usdcBalance) {
    warning.style.display = 'block'
    warning.textContent   = `⚠ Insufficient balance. You have ${_usdcBalance.toFixed(2)} USDC on Arbitrum.`
    preview.style.opacity = '0.4'
    btn.disabled = true
    btn.textContent = 'Insufficient balance'
    return
  }
  warning.style.display = 'none'
  preview.style.opacity = '1'
  _defiEl('dp-send').textContent    = `${amount.toFixed(2)} USDC`
  _defiEl('dp-receive').textContent = `${amount.toFixed(2)} USDC`
  _defiEl('dp-dest').textContent    = _depositDest === 'perps' ? 'Perps Account' : 'Spot Account'
  btn.disabled    = false
  btn.textContent = 'Deposit'
}

window.__updateWithdrawPreview = function() {
  const amount  = parseFloat(_defiEl('withdrawAmount')?.value)
  const dest    = _defiEl('withdrawDest')?.value.trim()
  const preview = _defiEl('withdrawPreview')
  const warning = _defiEl('withdrawWarning')
  const btn     = _defiEl('withdrawBtn')
  if (!preview) return

  const connected = isMainWalletConnected()
  const mobBanner = _defiEl('mobWalletBanner')
  if (mobBanner) mobBanner.style.display = connected ? 'none' : ''

  if (!connected) {
    btn.textContent = 'Connect Wallet'
    btn.disabled    = false
    btn.onclick     = () => window.__mobConnectWallet()
    preview.style.opacity = '0.4'
    warning.style.display = 'none'
    return
  }
  btn.onclick = () => window.__executeWithdraw()
  if (!amount || amount <= 0) {
    preview.style.opacity = '0.4'
    warning.style.display = 'none'
    btn.disabled = true
    btn.textContent = 'Enter amount'
    return
  }
  const receive = amount - 1
  if (receive <= 0) {
    warning.style.display = 'block'
    warning.textContent   = '⚠ Amount must be greater than the $1 withdrawal fee.'
    preview.style.opacity = '0.4'
    btn.disabled = true
    btn.textContent = 'Amount too low'
    return
  }
  if (!dest || !dest.startsWith('0x') || dest.length !== 42) {
    warning.style.display = 'none'
    preview.style.opacity = '0.4'
    btn.disabled = true
    btn.textContent = 'Enter destination'
    return
  }
  warning.style.display = 'none'
  preview.style.opacity = '1'
  _defiEl('wp-amount').textContent  = `${amount.toFixed(2)} USDC`
  _defiEl('wp-receive').textContent = `${receive.toFixed(2)} USDC`
  _defiEl('wp-dest').textContent    = `${dest.slice(0,8)}...${dest.slice(-6)}`
  btn.disabled    = false
  btn.textContent = 'Withdraw'
}

window.__useConnectedAddress = function() {
  const addr = getMainAddress()
  if (!addr) return
  const el = _defiEl('withdrawDest')
  if (el) { el.value = addr; window.__updateWithdrawPreview() }
}

window.__executeDeposit = async function() {
  const amount   = parseFloat(_defiEl('depositAmount').value)
  const statusEl = _defiEl('depositStatus')
  const btn      = _defiEl('depositBtn')
  btn.disabled = true
  try {
    const hash = await deposit({
      amount,
      destination: _depositDest,
      onStep: msg => { statusEl.innerHTML = `<span style="color:var(--muted)">${msg}</span>` },
    })
    statusEl.innerHTML = `<span style="color:var(--green)">✓ Deposit confirmed · <a href="https://arbiscan.io/tx/${hash}" target="_blank" rel="noopener" style="color:var(--accent)">View on Arbiscan</a></span>`
    _defiEl('depositAmount').value = ''
    window.__updateDepositPreview()
    refreshDefiBalances()
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`
    btn.disabled = false
    window.__updateDepositPreview()
  }
}

window.__executeWithdraw = async function() {
  const amount   = parseFloat(_defiEl('withdrawAmount').value)
  const dest     = _defiEl('withdrawDest').value.trim()
  const statusEl = _defiEl('withdrawStatus')
  const btn      = _defiEl('withdrawBtn')
  btn.disabled = true
  statusEl.innerHTML = '<span style="color:var(--muted)">Confirm in wallet...</span>'
  try {
    await withdraw({ amount, destination: dest })
    statusEl.innerHTML = `<span style="color:var(--green)">✓ Withdrawal submitted — arrives on Arbitrum in ~1 min</span>`
    _defiEl('withdrawAmount').value = ''
    window.__updateWithdrawPreview()
    refreshDefiBalances()
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`
    btn.disabled = false
    window.__updateWithdrawPreview()
  }
}

async function refreshDefiBalances() {
  const bal = await getUsdcBalance()
  _usdcBalance = bal
  const balEl = _defiEl('depositUsdcBal')
  if (balEl) balEl.textContent = bal !== null ? `${bal.toFixed(2)} USDC on Arbitrum` : '—'
  window.__updateDepositPreview()
}

// ─── TRADE BALANCE ────────────────────────────────────────────────────────────
// The agent wallet holds no funds — margin always lives in the master (state.addr) wallet.
let _tradePerpState = null  // refreshed clearinghouseState for the loaded wallet

function _renderTradeAccountStats(ps) {
  if (!ps?.marginSummary) return
  const val   = parseFloat(ps.marginSummary?.accountValue ?? 0)
  const wdraw = parseFloat(ps.withdrawable ?? 0)
  document.getElementById('tradeBalance').textContent      = '$' + fmtUSD(val)
  document.getElementById('tradeWithdrawable').textContent = '$' + fmtUSD(wdraw)
}

async function updateTradeBalance() {
  // Always render from the latest perpState so the header shows data without needing an agent key
  _renderTradeAccountStats(_tradePerpState ?? state.perpState)
  _updateAvailDisplay()

  if (!isConnected()) return
  const addr = state.addr
  if (!addr) return
  try {
    const info = new InfoClient({ transport: _transport })
    const s    = await info.clearinghouseState({ user: addr })
    // Account switched while this fetch was in flight — its balance/positions
    // belong to the old account. Discard so the trade tab never shows A's data
    // (balance, liq lines, size estimates) while B is loaded.
    if (state.addr !== addr) return
    _tradePerpState = s
    _renderTradeAccountStats(s)
    _updateAvailDisplay()
  } catch { /* non-critical */ }
}

// ─── COIN DROPDOWN ────────────────────────────────────────────────────────────
function populateCoinDropdown() {
  renderCoinDropdownItems('')
}

// ─── MARKET DROPDOWN STATE ────────────────────────────────────────────────────
let _mktCtxMap     = {}   // coin → { oi, volume, change24h, funding, markPx, ... }
let _mktCatMap     = {}   // coin → category string
let _spotNameMap   = {}   // @N / 'TOKEN/USDC' → display name
let _spotPairToAt  = {}   // 'TOKEN/USDC' → '@N'  (used to deduplicate allMids entries)
let _spotCommunityKeys = new Set()  // @N keys with deployerTradingFeeShare == 0 (real community tokens)
let _mktCtxReady   = false
let _mktHip3Ready = false  // separate gate so HIP-3 ctx is fetched once allMetas is available
let _dropSort    = 'oi'
let _dropCat     = 'all'
let _dropType    = 'all'
// Actual category strings returned by perpCategories (lowercase, API is case-inconsistent)
const _TRADFI_CATS_LC = new Set(['stocks','commodities','indices','fx','metals','energy','preipo','rates'])
const _isTradFiCat = cat => !!cat && _TRADFI_CATS_LC.has(cat.toLowerCase())
// Display labels for raw category strings from the API
const _CAT_LABEL = { stocks:'Stocks', commodities:'Commodities', indices:'Indices', fx:'FX', FX:'FX', preipo:'Pre-IPO', crypto:'Crypto', metals:'Metals', energy:'Energy', rates:'Rates' }

// Main DEX TradFi perps that perpCategories doesn't cover (only HIP-3 DEXes are in that API)
const _MAIN_DEX_TRADFI_CATS = { 'SPX': 'indices' }
// Hardcoded coin base names for commodities subcategories (HL uses "commodities" for all of them)
const _METALS_BASES  = new Set(['GOLD','SILVER','PALLADIUM','PLATINUM','GOLDJM','SILVERJM','PAXG','GLDMINE'])
const _ENERGY_BASES  = new Set(['OIL','GAS','NATGAS','USOIL','WTI','BRENTOIL','CL','USENERGY'])

function _buildCtxEntry(c) {
  const mark = parseFloat(c.markPx ?? 0)
  const prev = parseFloat(c.prevDayPx ?? 0)
  return {
    oi:              parseFloat(c.openInterest ?? 0) * mark,
    volume:          parseFloat(c.dayNtlVlm ?? 0),
    change24:        prev > 0 ? (mark - prev) / prev * 100 : 0,
    change24Abs:     mark - prev,
    funding:         parseFloat(c.funding ?? 0) * 100,
    markPx:          mark,
    oraclePx:        parseFloat(c.oraclePx ?? 0),
    nextFundingTime: c.nextFundingTime ? parseInt(c.nextFundingTime) : null,
    prevDayPx:       prev,
  }
}

async function _ensureMarketData() {
  if (_mktCtxReady && _mktHip3Ready) return

  if (!_mktCtxReady) {
    // Use allSettled so any single failure doesn't block the rest
    const [mktR, catR, spotR, spotCtxR] = await Promise.allSettled([
      fetchMarketCtxs(), fetchPerpCategories(), fetchSpotMeta(), fetchSpotMarketCtxs()
    ])
    if (mktR.status === 'fulfilled') {
      const [meta, ctxs] = mktR.value
      _mktCtxMap = {}
      ;(meta.universe ?? []).forEach((u, i) => {
        const c = ctxs[i]
        if (!c) return
        _mktCtxMap[u.name] = _buildCtxEntry(c)
      })
      _mktCtxReady = true
    } else { console.warn('[hliq] fetchMarketCtxs failed:', mktR.reason) }

    if (catR.status === 'fulfilled') {
      _mktCatMap = {}
      for (const [coin, cat] of (catR.value ?? [])) _mktCatMap[coin] = cat
      // perpCategories only covers HIP-3 DEXes; inject known main DEX TradFi coins
      Object.assign(_mktCatMap, _MAIN_DEX_TRADFI_CATS)
    } else { console.warn('[hliq] fetchPerpCategories failed:', catR.reason) }

    if (spotR.status === 'fulfilled') {
      _spotNameMap  = {}
      _spotPairToAt = {}
      _spotCommunityKeys = new Set()
      const { tokens = [], universe = [] } = spotR.value ?? {}
      for (const u of universe) {
        const base    = tokens[u.tokens?.[0]]
        const display = base?.name ?? u.name
        const atKey   = `@${u.index}`
        _spotNameMap[u.name] = display    // 'PURR/USDC' → 'PURR'
        _spotNameMap[atKey]  = display    // '@0' → 'PURR'
        _spotPairToAt[u.name] = atKey     // 'PURR/USDC' → '@0'
        // Only community-created tokens (deployerTradingFeeShare == 0) belong in the Spot filter.
        // Protocol-deployed synthetic assets (stocks, ETFs, wrapped tokens) use feeShare == 1.0.
        if (parseFloat(base?.deployerTradingFeeShare ?? '0') === 0) _spotCommunityKeys.add(atKey)
      }
    } else { console.warn('[hliq] fetchSpotMeta failed:', spotR.reason) }

    if (spotCtxR.status === 'fulfilled') {
      const [, spotCtxs] = spotCtxR.value ?? [null, []]
      // spotCtxs is NOT index-parallel to universe — match via c.coin.
      // HL uses two key formats: '@N' (index) or 'TOKEN/USDC' (pair name).
      // Populate BOTH so the @N entry (only format shown in the list) always has data.
      for (const c of (spotCtxs ?? [])) {
        const key = c?.coin
        if (!key || key.startsWith('#')) continue
        const mark  = parseFloat(c.markPx ?? 0) || parseFloat(state.allMids?.[key] ?? 0)
        const prev  = parseFloat(c.prevDayPx ?? 0)
        const entry = {
          oi: 0, marketCap: parseFloat(c.circulatingSupply ?? 0) * mark,
          volume: parseFloat(c.dayNtlVlm ?? 0),
          change24: prev > 0 ? (mark - prev) / prev * 100 : 0,
          change24Abs: mark - prev, funding: 0,
          markPx: mark, oraclePx: 0, nextFundingTime: null, prevDayPx: prev,
        }
        _mktCtxMap[key] = entry
        const atKey = _spotPairToAt[key]   // if key is 'PURR/USDC', also set '@0'
        if (atKey && atKey !== key) _mktCtxMap[atKey] = entry
      }

      // Deduplicate _spotCommunityKeys: multiple @N keys can share the same display name
      // (e.g. 4 different HYPE tokens). Keep only the highest-market-cap key per name,
      // and require the winner to have mktCap > $100K or dayNtlVlm > 0 to filter dead tokens.
      const _bestByName = {}
      for (const k of _spotCommunityKeys) {
        const name = _spotNameMap[k]
        if (!name) continue
        const ctx = _mktCtxMap[k]
        const mktCap = ctx?.marketCap ?? 0
        const vol    = ctx?.volume   ?? 0
        if (!_bestByName[name] || mktCap > (_mktCtxMap[_bestByName[name]]?.marketCap ?? 0)) {
          _bestByName[name] = k
        }
        // If same mktCap (both 0), prefer lower index (earlier, more canonical)
        if (mktCap === (_mktCtxMap[_bestByName[name]]?.marketCap ?? 0)) {
          const existingIdx = parseInt(_bestByName[name].slice(1))
          const thisIdx     = parseInt(k.slice(1))
          if (thisIdx < existingIdx) _bestByName[name] = k
        }
      }
      _spotCommunityKeys = new Set(
        Object.values(_bestByName).filter(k => {
          const ctx = _mktCtxMap[k]
          return (ctx?.marketCap ?? 0) > 100_000 || (ctx?.volume ?? 0) > 0
        })
      )
    } else { console.warn('[hliq] fetchSpotMarketCtxs failed:', spotCtxR.reason) }

    // Fetch HIP-3 DEX ctx using DEX names from perpCategories — no wallet needed.
    // metaAndAssetCtxs({dex}) returns coin names WITH prefix (e.g. 'flx:TSLA'),
    // so u.name is the correct allMids key directly.
    if (!_mktHip3Ready && catR.status === 'fulfilled') {
      const hip3Dexes = new Set()
      for (const [coin] of (catR.value ?? [])) {
        const ci = coin.indexOf(':')
        if (ci > 0) hip3Dexes.add(coin.slice(0, ci))
      }
      if (hip3Dexes.size > 0) {
        const hip3DexArr = [...hip3Dexes]
        const hip3Results = await Promise.allSettled(hip3DexArr.map(dex => fetchDexMarketCtxs(dex)))
        hip3DexArr.forEach((dex, i) => {
          const r = hip3Results[i]
          if (r.status !== 'fulfilled') return
          const [meta2, ctxs2] = r.value
          ;(meta2.universe ?? []).forEach((u, j) => {
            const c2 = ctxs2[j]
            if (!c2) return
            _mktCtxMap[u.name] = _buildCtxEntry(c2)
          })
        })
      }
      _mktHip3Ready = true
    }
  }
}

// ─── FAVORITES ────────────────────────────────────────────────────────────────
function loadFavCoins()     { try { return JSON.parse(localStorage.getItem('favCoins') || '[]') } catch { return [] } }
function saveFavCoins(favs) { localStorage.setItem('favCoins', JSON.stringify(favs)) }
function isFav(coin)        { return loadFavCoins().includes(coin) }

window.__toggleFav = function(coin, e) {
  e.stopPropagation()
  const favs = loadFavCoins()
  const idx  = favs.indexOf(coin)
  if (idx >= 0) favs.splice(idx, 1)
  else favs.unshift(coin)
  saveFavCoins(favs)
  renderCoinDropdownItems(document.getElementById('coinDropdownSearch').value)
}
window.__dropSort = function(s) {
  _dropSort = s
  document.querySelectorAll('.mkt-th-sort').forEach(th => th.classList.toggle('active', th.dataset.col === s))
  renderCoinDropdownItems(document.getElementById('coinDropdownSearch')?.value ?? '')
}
window.__dropCat  = function(c) { _dropCat  = c; renderCoinDropdownItems(document.getElementById('coinDropdownSearch')?.value ?? '') }
window.__dropType = function(t) {
  _dropType = t; _dropCat = 'all'
  document.querySelectorAll('.mkt-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === t))
  renderCoinDropdownItems(document.getElementById('coinDropdownSearch')?.value ?? '')
}

function _coinColor(coin) {
  let h = 0
  for (let i = 0; i < coin.length; i++) h = (h * 31 + coin.charCodeAt(i)) % 360
  return `hsl(${h},62%,48%)`
}

// ─── COINGECKO ICON MAP ───────────────────────────────────────────────────────
// symbol.toLowerCase() → image URL, loaded from CoinGecko and cached 24h in localStorage

let _cgIconMap = null
window.__cgIconMap = () => _cgIconMap

// TradingView public S3 CDN — symbol → path (appended with --big.svg)
const _TV_BASE = 'https://s3-symbol-logo.tradingview.com/'
const _TV_LOGOS = {
  // US mega-caps & popular stocks
  'aapl':'apple','tsla':'tesla','nvda':'nvidia','msft':'microsoft',
  'amzn':'amazon','meta':'meta-platforms','googl':'alphabet','goog':'alphabet',
  'nflx':'netflix','coin':'coinbase','pltr':'palantir','mstr':'microstrategy',
  'hood':'robinhood','gme':'gamestop','amc':'amc-networks','snap':'snap',
  'f':'ford','gm':'general-motors','rivn':'rivian','lcid':'lucid-group',
  'nio':'nio','xpev':'xpeng','baba':'alibaba','jd':'jd-com',
  'shop':'shopify','sq':'block','pypl':'paypal','uber':'uber',
  'lyft':'lyft','roku':'roku','abnb':'airbnb','intc':'intel',
  'amd':'advanced-micro-devices','orcl':'oracle','crm':'salesforce','adbe':'adobe',
  'nke':'nike','dis':'walt-disney','v':'visa','ma':'mastercard',
  'jpm':'jpmorgan-chase','gs':'goldman-sachs','bac':'bank-of-america',
  'wfc':'wells-fargo','c':'citigroup','rblx':'roblox','dkng':'draftkings',
  'upst':'upstart','afrm':'affirm','sofi':'sofi',
  'meli':'mercadolibre','grab':'grab','se':'sea-limited','mgm':'mgm-resorts',
  'tsm':'taiwan-semiconductor','asml':'asml',
  'nvs':'novartis','rhhby':'roche','bmy':'bristol-myers-squibb',
  'pfe':'pfizer','mrna':'moderna','jnj':'johnson-and-johnson',
  'abbv':'abbvie','lly':'eli-lilly','unh':'unitedhealth','cvs':'cvs-health',
  // Semiconductors
  'mu':'micron-technology','avgo':'broadcom','arm':'arm',
  'qcom':'qualcomm','txn':'texas-instruments',
  'mchp':'microchip-technology','klac':'kla-tencor','lam':'lam-research','amat':'applied-materials',
  'on':'on-semiconductor','swks':'skyworks-solutions','qrvo':'qorvo',
  // Tech / enterprise
  'csco':'cisco','crwd':'crowdstrike','snow':'snowflake',
  'net':'cloudflare-inc','ddog':'datadog','zs':'zscaler','okta':'okta',
  'twlo':'twilio','team':'atlassian','now':'servicenow','hubs':'hubspot',
  'wday':'workday','splk':'splunk','panw':'palo-alto-networks',
  // Consumer / retail
  'wmt':'walmart','tgt':'target','sbux':'starbucks','mcd':'mcdonalds',
  'ko':'coca-cola','pep':'pepsico','cost':'costco-wholesale','hd':'home-depot',
  'low':'lowe-s',
  // Energy / industrial
  'xom':'exxon','cvx':'chevron','bp':'bp','shel':'shell',
  'ba':'boeing','cat':'caterpillar','ge':'ge-aerospace','hon':'honeywell',
  'rtx':'raytheon','lmt':'lockheed-martin','noc':'northrop-grumman',
  // Finance / other
  'berk':'berkshire-hathaway','blk':'blackrock','schw':'schwab',
  'ms':'morgan-stanley','axp':'american-express','t':'at-and-t','vz':'verizon',
  'cmcsa':'comcast',
  // ETFs — only GLD has a confirmed working TV CDN path
  'gld':'spdr-gold-trust',
  // Private / pre-IPO
  'spacex':'spacex','spcx':'spacex',
  // XYZ DEX stocks with confirmed TV CDN logos
  'sndk':'sandisk','bb':'blackberry','smsn':'samsung','crcl':'circle',
  // US indexes — require indices/ subdirectory prefix on TV CDN
  'spx':'indices/s-and-p-500','sp500':'indices/s-and-p-500',
  'ndx':'indices/nasdaq-100','nasdaq100':'indices/nasdaq-100',
  'rut':'indices/russell-2000','russell2000':'indices/russell-2000',
  'vix':'indices/volatility-s-and-p-500',
  // European indexes
  'dax':'indices/dax',
  'ftse':'indices/uk-100','ftse100':'indices/uk-100',
  'cac':'indices/cac-40','cac40':'indices/cac-40',
  'stoxx50':'indices/euro-stoxx-50','estx50':'indices/euro-stoxx-50',
  'ibex':'indices/ibex-35','ibex35':'indices/ibex-35',
  'mib':'indices/ftse-mib',
  // Asian indexes
  'nky':'indices/japan-225','n225':'indices/japan-225','nikkei':'indices/japan-225',
  'hsi':'indices/hang-seng','hangseng':'indices/hang-seng',
  'asx200':'indices/asx-200','xjo':'indices/asx-200',
  // Commodities — precious metals
  'gold':'metal/gold','xau':'metal/gold',
  'silver':'metal/silver','xag':'metal/silver',
  'platinum':'metal/platinum','xpt':'metal/platinum',
  'palladium':'metal/palladium','xpd':'metal/palladium',
  'copper':'metal/copper','xcu':'metal/copper',
  // Commodities — energy
  'oil':'crude-oil','wti':'crude-oil','crude':'crude-oil',
  'cl':'crude-oil','wtioil':'crude-oil',
  'brent':'crude-oil','ukoil':'crude-oil','brentoil':'crude-oil',
  'natgas':'natural-gas','ng':'natural-gas','gas':'natural-gas',
  // Commodities — agriculture
  'wheat':'wheat','corn':'corn',
  'soy':'soybean','soybean':'soybean',
  'sugar':'sugar','coffee':'coffee',
  'cotton':'cotton',
}

// HIP-3 DEX prefix → fallback domain when symbol has no TV mapping
const _HIP3_DEX_DOMAINS = {
  'xyz':'trade.xyz',
  'trade':'trade.xyz',
}

// Market display name overrides: bare ticker (no prefix) → user-facing name.
// Looked up after stripping any dex: prefix so it works regardless of key case/format.
const _MKT_DISPLAY = { 'CL': 'WTIOIL' }
function _mktDisplay(coin) { return _MKT_DISPLAY[coin.replace(/.*:/, '')] ?? null }

// Forex currency → ISO 3166-1 alpha-2 country code for flagcdn.com
const _FOREX_FLAGS = {
  'jpy':'jp','eur':'eu','gbp':'gb','chf':'ch','aud':'au','cad':'ca',
  'mxn':'mx','brl':'br','krw':'kr','inr':'in','ngn':'ng','try':'tr',
  'cny':'cn','hkd':'hk','sgd':'sg','nzd':'nz','sek':'se','nok':'no',
  'dkk':'dk','pln':'pl','czk':'cz','huf':'hu','zar':'za','ils':'il',
}

function _tradFiIconUrl(sym) {
  const cc = _FOREX_FLAGS[sym]
  if (cc) return `https://flagcdn.com/w80/${cc}.png`
  const tv = _TV_LOGOS[sym]
  if (tv) return `${_TV_BASE}${tv}--big.svg`
  return null
}

function _cgLetterAvatar(coin) {
  const letter = coin.replace(/.*:/, '').replace(/[-/@].*/, '').charAt(0).toUpperCase()
  return `<span style="display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:${_coinColor(coin)};font-size:0.6em;font-weight:700;color:#fff">${letter}</span>`
}

;(function _initCGIconMap() {
  // Load from cache synchronously so icons work immediately on repeat visits
  try {
    const raw = localStorage.getItem('cg_icon_map')
    const age = Date.now() - parseInt(localStorage.getItem('cg_icon_map_at') || '0')
    const ver = localStorage.getItem('cg_icon_map_ver')
    if (raw && ver === '2' && age < 24 * 3600 * 1000) { _cgIconMap = JSON.parse(raw); return }
  } catch {}

  // Fetch top 1000 coins from CoinGecko (4 pages × 250) + supplemental HL ecosystem tokens
  _cgIconMap = {} // empty map while loading — renders letter avatars until ready
  const _HL_SUPPLEMENT_IDS = 'staked-hype,kinetic-staked-hype,usdh-2,purr-2,hfun,hyperliquid-2'
  Promise.all([
    ...[1, 2, 3, 4].map(p =>
      fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&per_page=250&page=${p}&sparkline=false`)
        .then(r => r.ok ? r.json() : []).catch(() => [])
    ),
    fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${_HL_SUPPLEMENT_IDS}&sparkline=false`)
      .then(r => r.ok ? r.json() : []).catch(() => []),
  ]).then(pages => {
    const map = {}
    for (const c of pages.flat()) {
      if (c.symbol && c.image) map[c.symbol.toLowerCase()] = c.image.replace('/large/', '/small/')
    }
    _cgIconMap = map
    window.__cgIconMap = () => _cgIconMap
    localStorage.setItem('cg_icon_map', JSON.stringify(map))
    localStorage.setItem('cg_icon_map_at', Date.now().toString())
    localStorage.setItem('cg_icon_map_ver', '2')
  }).catch(() => {})
})()

// Coins whose remote artwork failed to load — render a letter avatar directly on
// subsequent renders so frequently-refreshed lists (Watch tab) don't re-fetch the
// dead URL and visibly blink the broken image → avatar on every refresh cycle.
const _iconFailed = new Set()

window.__coinImgErr = function(img, coin) {
  // One-step fallback chain: if a data-alt URL is present try it first,
  // then give up to a letter avatar.
  const alt = img?.dataset?.alt
  if (alt) { img.removeAttribute('data-alt'); img.src = alt; return }
  const p = img?.parentElement
  if (!p) return
  if (coin) _iconFailed.add(coin)
  p.innerHTML = _cgLetterAvatar(coin)
}

// Hyperliquid's own icon CDN — covers HL-native listings (k-prefixed thousand
// coins, low-caps, spot tokens) that CoinGecko's top-1000 misses. Missing icons
// return the SPA's HTML with a 200, which an <img> still treats as a load error,
// so the onerror fallback chain works.
function _hlIconUrl(base) {
  return `https://app.hyperliquid.xyz/coins/${/^k[A-Z]/.test(base) ? base.slice(1) : base}.svg`
}

function _coinIconHtml(coin, style = '') {
  // Prediction-market codes have no token artwork — return a static letter
  // avatar (no <img>) so the icon doesn't blink retrying a 404 image.
  // Orders use "#N", spot holdings of the outcome use "+N" (same number).
  if (typeof coin === 'string' && (coin[0] === '#' || coin[0] === '+')) {
    return _cgLetterAvatar(state.ocTokenMap?.['#' + coin.slice(1)]?.name || coin)
  }
  // Already known to have no artwork — skip the <img> entirely (no blink on re-render)
  if (_iconFailed.has(coin)) return _cgLetterAvatar(coin)
  const isTradFi = coin.includes(':') || _isTradFiCat(_mktCatMap[coin])
  let raw = coin.replace(/.*:/, '').replace(/[-/].*/, '')
  // Resolve @N spot index tokens and TOKEN/USDC pair names to the real token name
  let isSpot = false
  if (raw.startsWith('@') || coin.includes('/')) {
    const spotName = _spotNameMap[coin]
    if (spotName) { raw = spotName; isSpot = true }
    else return _cgLetterAvatar(raw || coin)
  }
  const sym = raw.toLowerCase()
  // HIP-3 markets: HL hosts artwork under the full prefixed name
  // (coins/xyz:TSLA.svg) — covers stocks, indices, and synthetics (108/161).
  // Fallback: TradFi map / CoinGecko (crypto on HIP-3 dexes) / TV ticker guess.
  if (coin.includes(':')) {
    const hlUrl = `https://app.hyperliquid.xyz/coins/${encodeURIComponent(coin)}.svg`
    const alt   = _tradFiIconUrl(sym) ?? _cgIconMap?.[sym] ?? `${_TV_BASE}${sym}--big.svg`
    return `<img src="${hlUrl}" data-alt="${alt}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;${style}" onerror="window.__coinImgErr(this,'${coin}')">`
  }
  if (!isTradFi) {
    // k-prefixed coins (kPEPE = 1000×PEPE) match CoinGecko under the base symbol
    const kBase = /^k[A-Z]/.test(raw) ? raw.slice(1).toLowerCase() : null
    const cgUrl = _cgIconMap?.[sym] ?? (kBase ? _cgIconMap?.[kBase] : null)
    const hlUrl = _hlIconUrl(raw)
    // CoinGecko first — colorful artwork. HL's CDN (monochrome glyphs) is the
    // fallback covering k-coins / low-caps that CoinGecko's top-1000 misses.
    const src = cgUrl ?? hlUrl
    const alt = cgUrl ? hlUrl : null
    return `<img src="${src}"${alt ? ` data-alt="${alt}"` : ''} style="width:100%;height:100%;border-radius:50%;object-fit:cover;${style}" onerror="window.__coinImgErr(this,'${coin}')">`
  }
  const tfUrl = _tradFiIconUrl(sym)
  if (tfUrl) return `<img src="${tfUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;${style}" onerror="window.__coinImgErr(this,'${coin}')">`
  // For HIP-3 DEX coins with no exact mapping, try the ticker directly on TV CDN.
  // If the ticker URL 404s the error handler falls back to a clean letter avatar.
  if (isTradFi) {
    const tickerUrl = `${_TV_BASE}${sym}--big.svg`
    return `<img src="${tickerUrl}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;${style}" onerror="window.__coinImgErr(this,'${coin}')">`
  }
  return _cgLetterAvatar(sym || coin)
}
window._coinIconHtml = _coinIconHtml   // reused by the desktop overview (render.js)

function updateCoinHeader(coin) {
  const nameEl = document.getElementById('mktCoinName')
  const iconEl = document.getElementById('mktCoinIcon')
  const levEl  = document.getElementById('mktCoinLev')
  if (!nameEl) return
  if (!coin) {
    nameEl.textContent = 'Select market'
    if (iconEl) { iconEl.textContent = '—'; iconEl.style.background = 'var(--bg3)' }
    if (levEl)  levEl.style.display = 'none'
    return
  }
  nameEl.textContent = (_mktDisplay(coin) ?? coin) + '-USDC'
  if (iconEl) {
    iconEl.innerHTML = _coinIconHtml(coin)
    iconEl.style.background = 'transparent'
  }
  const lev = state.assetMap?.[coin]?.maxLeverage
  if (levEl) { levEl.textContent = lev ? lev + 'x' : ''; levEl.style.display = lev ? 'inline-flex' : 'none' }

  // Also update trade card search bar
  const tcsInput = document.getElementById('tcsCoinInput')
  const tcsIcon  = document.getElementById('tcsCoinIcon')
  if (tcsInput) tcsInput.value = coin ?? ''
  if (tcsIcon)  {
    if (coin) { tcsIcon.innerHTML = _coinIconHtml(coin); tcsIcon.style.background = 'transparent' }
    else      { tcsIcon.textContent = '—'; tcsIcon.style.background = 'var(--bg3)' }
  }
}

// ─── TRADE CARD COIN SEARCH ───────────────────────────────────────────────────
window._tcsFilter = function(q = '') {
  const results = document.getElementById('tcsResults')
  if (!results) return
  const lq = q.toLowerCase()
  const mids = state.allMids ?? {}
  const entries = Object.entries(mids)
    .filter(([c]) => !q || c.toLowerCase().includes(lq))
    .sort((a, b) => {
      const d = _mktCtxMap[b[0]]?.oi ?? 0
      return d - (_mktCtxMap[a[0]]?.oi ?? 0)
    })
    .slice(0, 12)
  if (!entries.length) { results.style.display = 'none'; return }
  results.style.display = 'block'
  results.innerHTML = entries.map(([coin, px]) => {
    const ch  = _mktCtxMap[coin]?.change24 ?? null
    const cls = ch === null ? '' : ch >= 0 ? 'pos' : 'neg'
    const chStr = ch !== null ? `<span class="${cls}" style="font-size:10px">${ch >= 0 ? '+' : ''}${ch.toFixed(2)}%</span>` : ''
    return `<div class="tcs-result-item" onmousedown="window._tcsSelect('${coin}')">
      <span class="tcs-ri-coin">${esc(coin)}</span>
      <span class="tcs-ri-px">${chStr}&nbsp;&nbsp;$${fmtPrice(parseFloat(px))}</span>
    </div>`
  }).join('')
}

window._tcsFocus = function() {
  const inp = document.getElementById('tcsCoinInput')
  if (inp) inp.select()
  window._tcsFilter('')
}

window._tcsBlur = function() {
  setTimeout(() => {
    const results = document.getElementById('tcsResults')
    if (results) results.style.display = 'none'
    const inp  = document.getElementById('tcsCoinInput')
    const coin = state.selectedCoin
    if (inp) inp.value = coin ?? ''
  }, 150)
}

window._tcsSelect = function(coin) {
  window.__selectCoin(coin)
  const results = document.getElementById('tcsResults')
  if (results) results.style.display = 'none'
}

// ─── AVAILABLE BALANCE DISPLAY ────────────────────────────────────────────────
// Available = accountValue − totalMarginUsed (initial margin + open-order reservations).
// activeAssetData.availableToTrade is [min, max]:
//   min = available when adding to / opening in the same direction as existing position
//   max = available when going opposing (freed margin from reducing existing position included)
let _availCache = { min: 0, max: 0, coin: null }
let _availFetching = false
let _availTimer   = null

// Use max when going opposing to an existing position, min otherwise
function _availEffective() {
  const coin = state.selectedCoin
  if (coin && isConnected()) {
    const ps      = (_tradePerpState ?? state.perpState)
    const selPos  = (ps?.assetPositions ?? []).find(ap => ap.position?.coin === coin)?.position
    const selSzi  = parseFloat(selPos?.szi ?? 0)
    const opposing = selSzi !== 0 && (
      (state.tradeSide === 'short' && selSzi > 0) ||
      (state.tradeSide === 'long'  && selSzi < 0)
    )
    if (opposing) return _availCache.max
  }
  return _availCache.min
}

function _updateAvailEl() {
  const el = document.getElementById('mobTradeAvailAmt')
  if (el) el.textContent = `$${fmtUSD(_availEffective(), 2)}`
}

async function _fetchAvail() {
  if (!isConnected() || _availFetching) return
  const coin = state.selectedCoin
  const addr = state.addr
  if (!addr || !coin) return
  _availFetching = true
  try {
    const data = await infoClient.activeAssetData({ user: addr, coin })
    const min  = Math.max(0, parseFloat(data.availableToTrade?.[0] ?? 0))
    const max  = Math.max(0, parseFloat(data.availableToTrade?.[1] ?? 0))
    _availCache = { min, max, coin }
    _updateAvailEl()
    _updateAvailDisplay()
  } catch {} finally { _availFetching = false }
}

function _startAvailTimer() {
  _stopAvailTimer()
  _fetchAvail()
  _availTimer = setInterval(_fetchAvail, 5000)
}

function _stopAvailTimer() {
  if (_availTimer) { clearInterval(_availTimer); _availTimer = null }
}

function _tradeAvail() {
  if (isConnected()) {
    const avail = _availEffective()
    return { avail, maxNotional: avail * (state.leverage ?? 1) }
  }
  // Fallback formula when watching (no agent connected)
  const ps = state.perpState
  if (!ps) return { avail: 0, maxNotional: 0 }
  const ms      = ps.marginSummary ?? {}
  const cms     = ps.crossMarginSummary ?? {}
  const acctVal = parseFloat(ms.accountValue ?? 0)
  const posUsed = parseFloat(cms.totalMarginUsed ?? ms.totalMarginUsed ?? 0)
  const avail   = Math.max(0, acctVal - posUsed)
  return { avail, maxNotional: avail * (state.leverage ?? 1) }
}

function _updateAvailDisplay() {
  const el   = document.getElementById('availDisplay')
  const hint = document.getElementById('availHint')
  if (!state.perpState) {
    if (el)   el.textContent   = '—'
    if (hint) hint.textContent = 'Max: —'
    return
  }
  const { avail, maxNotional } = _tradeAvail()

  if (el)   el.textContent   = '$' + fmtUSD(avail) + ' USDC'
  if (hint) hint.textContent = maxNotional > 0 ? `Max: $${fmtUSD(maxNotional)} at ${state.leverage}x` : 'Max: —'
}

function _fmtCompactNum(n) {
  if (n >= 1e9) return '$' + (n/1e9).toFixed(2) + 'B'
  if (n >= 1e6) return '$' + (n/1e6).toFixed(1) + 'M'
  if (n >= 1e3) return '$' + (n/1e3).toFixed(0) + 'K'
  return '$' + n.toFixed(0)
}

function _fmtTablePx(p) {
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (p >= 10)   return p.toFixed(4)
  if (p >= 1)    return p.toFixed(4)
  return p.toPrecision(5)
}


function _fmtTableDollar(n) {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function _fmtK(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K'
  return n.toFixed(0)
}

function renderCoinDropdownItems(query) {
  const list     = document.getElementById('coinDropdownList')
  const catTabsEl= document.getElementById('mktCatTabs')
  if (!list) return
  const q    = (query ?? '').toLowerCase().trim()
  const favs = loadFavCoins()

  // Update column header sort indicator
  document.querySelectorAll('.mkt-th-sort').forEach(th => th.classList.toggle('active', th.dataset.col === _dropSort))

  // Type-based filtering
  let entries = Object.entries(state.allMids)
  if (q) entries = entries.filter(([k]) => k.toLowerCase().includes(q) || (k + '-USDC').toLowerCase().includes(q) || (_mktDisplay(k) ?? '').toLowerCase().includes(q))

  if (_dropType === 'spot') {
    if (catTabsEl) catTabsEl.innerHTML = ''
    list.innerHTML = `<tr class="mkt-empty-row"><td colspan="6">Spot markets not available</td></tr>`
    return
  }
  if (_dropType === 'perps') { /* all — same as all */ }
  if (_dropType === 'crypto')    entries = entries.filter(([k]) => !_isTradFiCat(_mktCatMap[k]))
  if (_dropType === 'tradfi')    entries = entries.filter(([k]) =>  _isTradFiCat(_mktCatMap[k]))
  if (_dropType === 'hip3')      entries = entries.filter(([k]) => k.includes(':'))
  if (_dropType === 'prelaunch') entries = entries.filter(([k]) => _mktCatMap[k]?.toLowerCase() === 'preipo')

  // Category sub-tabs — derived from filtered entries
  const availCats = [...new Set(entries.map(([k]) => _mktCatMap[k]).filter(Boolean))].sort()
  if (catTabsEl) {
    catTabsEl.innerHTML = ['all', ...availCats].map(c =>
      `<button class="mkt-cat-btn ${_dropCat===c?'active':''}" onclick="window.__dropCat('${esc(c)}')">${c==='all'?'All':esc(c)}</button>`
    ).join('')
  }

  // Category filter
  if (_dropCat !== 'all') entries = entries.filter(([k]) => _mktCatMap[k] === _dropCat)

  // Sort
  const sortVal = ([coin, px]) => {
    const d = _mktCtxMap[coin]
    if (_dropSort === 'price')   return parseFloat(px)
    if (!d) return 0
    if (_dropSort === 'oi')      return d.oi
    if (_dropSort === 'volume')  return d.volume
    if (_dropSort === 'change')  return Math.abs(d.change24)
    if (_dropSort === 'funding') return Math.abs(d.funding)
    return 0
  }
  if (_dropType === 'trending') {
    entries = [...entries].sort((a, b) => ((_mktCtxMap[b[0]]?.volume ?? 0) - (_mktCtxMap[a[0]]?.volume ?? 0)))
  } else {
    entries = [...entries].sort((a, b) => sortVal(b) - sortVal(a))
  }

  if (entries.length === 0) {
    list.innerHTML = `<tr class="mkt-empty-row"><td colspan="6">No markets found</td></tr>`
    return
  }

  const row = ([coin, px]) => {
    const d       = _mktCtxMap[coin]
    const mark    = d?.markPx || parseFloat(px)
    const ch      = d?.change24 ?? 0
    const chAbs   = d?.change24Abs ?? 0
    const chCls   = ch >= 0 ? 'pos' : 'neg'
    const chSign  = ch >= 0 ? '+' : ''
    const fund    = d?.funding ?? 0
    const fundCls = fund >= 0 ? 'pos' : 'neg'
    const fundSign= fund >= 0 ? '+' : ''
    const vol     = d?.volume ?? 0
    const oi      = d?.oi ?? 0
    const lev     = state.assetMap?.[coin]?.maxLeverage
    const active  = state.selectedCoin === coin ? 'active' : ''
    const fav     = favs.includes(coin) ? 'active' : ''
    const col     = _coinColor(coin)
    return `<tr class="mkt-row ${active}" onclick="window.__selectCoin('${coin}')">
      <td class="mkt-td-symbol">
        <button class="coin-fav-btn ${fav}" onclick="window.__toggleFav('${coin}',event)">★</button>
        <div class="mkt-sym-icon" style="background:transparent;overflow:hidden">${_coinIconHtml(coin)}</div>
        <span class="mkt-sym-name">${_mktDisplay(coin) ?? hip3Rename(coin).replace(/.*:/, '')}-USDC</span>
        ${lev ? `<span class="mkt-sym-lev">${lev}x</span>` : ''}
      </td>
      <td class="mkt-td-num">${_fmtTablePx(mark)}</td>
      <td class="mkt-td-num ${chCls}">${chSign}${_fmtTablePx(Math.abs(chAbs))} / ${chSign}${ch.toFixed(2)}%</td>
      <td class="mkt-td-num ${fundCls}">${fundSign}${Math.abs(fund).toFixed(4)}%</td>
      <td class="mkt-td-num">${_fmtTableDollar(vol)}</td>
      <td class="mkt-td-num">${_fmtTableDollar(oi)}</td>
    </tr>`
  }

  const favEntries   = !q ? entries.filter(([k]) => favs.includes(k))  : []
  const otherEntries = !q ? entries.filter(([k]) => !favs.includes(k)) : entries

  const favSection = favEntries.length > 0
    ? `<tr class="mkt-section-row"><td colspan="6">⭐ Favorites</td></tr>` + favEntries.map(row).join('') +
      `<tr class="mkt-section-row"><td colspan="6">All Markets</td></tr>`
    : ''

  list.innerHTML = favSection + otherEntries.slice(0, 500).map(row).join('')
}

window.__selectCoin = function (coin) {
  state.selectedCoin = coin
  const price      = parseFloat(state.allMids[coin] ?? 0)
  const assetInfo  = state.assetMap[coin]
  const maxLev     = assetInfo?.maxLeverage ?? 50

  updateCoinHeader(coin)
  document.getElementById('coinDropdown').classList.remove('open')

  // Cap leverage to this asset's max
  const slider = document.getElementById('levSlider')
  slider.max = maxLev
  if (state.leverage > maxLev) {
    state.leverage = maxLev
    slider.value   = maxLev
    document.getElementById('levDisplay').textContent = maxLev + 'x'
  }

  updateSizeModeLabel()
  _szSyncSlider()
  _startAvailTimer()
  _updateAvailDisplay()

  if (state.orderType !== 'market') {
    document.getElementById('limitPriceInput').value = price.toString()
  }
  updateOrderSummary()
  updateSubmitBtn()
  loadTradeChart(coin)
}

window.toggleCoinDropdown = function () {
  const dd = document.getElementById('coinDropdown')
  dd.classList.toggle('open')
  if (dd.classList.contains('open')) {
    const inp = document.getElementById('coinDropdownSearch')
    if (inp) inp.value = ''
    _ensureMarketData().then(() => {
      renderCoinDropdownItems('')
      if (state.selectedCoin) updateChartStats(state.selectedCoin)
    })
    renderCoinDropdownItems('')
    setTimeout(() => document.getElementById('coinDropdownSearch')?.focus(), 50)
  }
}

window.filterCoinDropdown = function () {
  renderCoinDropdownItems(document.getElementById('coinDropdownSearch').value)
}

document.addEventListener('click', e => {
  // Close coin dropdown
  const wrap = document.getElementById('coinSelectorWrap')
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('coinDropdown')?.classList.remove('open')
  }
  // Close wallet panel
  const wsWrap = document.getElementById('wsSwitcherWrap')
  if (wsWrap && !wsWrap.contains(e.target)) {
    document.getElementById('wsPanel')?.classList.remove('open')
    document.getElementById('wsSwitcherBtn')?.classList.remove('open')
  }
})

// ─── SIDE ─────────────────────────────────────────────────────────────────────
function setSide(side) {
  state.tradeSide = side
  document.getElementById('sideBtn-long').className  = 'side-btn' + (side === 'long'  ? ' active-long'  : '')
  document.getElementById('sideBtn-short').className = 'side-btn' + (side === 'short' ? ' active-short' : '')
  _updateAvailDisplay()
  updateOrderSummary()
  updateSubmitBtn()
}

// ─── ORDER TYPE ───────────────────────────────────────────────────────────────
function setOrderType(type) {
  state.orderType = type
  ;['market', 'limit', 'stop'].forEach(t => {
    document.getElementById('otype-' + t).classList.toggle('active', t === type)
  })
  document.getElementById('limitPriceField').style.display = type === 'market' ? 'none' : ''
  document.getElementById('stopPriceField').style.display  = type === 'stop'   ? ''     : 'none'

  if (type !== 'market' && state.selectedCoin) {
    const price = parseFloat(state.allMids[state.selectedCoin] ?? 0)
    if (price > 0 && !document.getElementById('limitPriceInput').value) {
      document.getElementById('limitPriceInput').value = price.toString()
    }
  }
  updateOrderSummary()
}

// ─── LEVERAGE ─────────────────────────────────────────────────────────────────
function updateLevDisplay() {
  const v = parseInt(document.getElementById('levSlider').value)
  state.leverage = v
  document.getElementById('levDisplay').textContent = v + 'x'
  _szSyncSlider()
  _updateAvailDisplay()
  updateOrderSummary()
}

function setLev(n) {
  state.leverage = n
  document.getElementById('levSlider').value = n
  document.getElementById('levDisplay').textContent = n + 'x'
  _szSyncSlider()
  _updateAvailDisplay()
  updateOrderSummary()
}

// ─── MARGIN MODE ──────────────────────────────────────────────────────────────
function setMarginMode(isIsolated) {
  state.isIsolated = isIsolated
  document.getElementById('marginCross').classList.toggle('active', !isIsolated)
  document.getElementById('marginIsolated').classList.toggle('active', isIsolated)
  _updateAvailDisplay()
  try { updateOrderSummary() } catch {}        // refresh est. liq price for the new mode
}

// ─── SIZE MODE (USD / COIN) ───────────────────────────────────────────────────
function setSizeMode(mode) {
  state.sizeMode = mode
  document.getElementById('sizeBtn-usd').classList.toggle('active',  mode === 'usd')
  document.getElementById('sizeBtn-coin').classList.toggle('active', mode === 'coin')
  updateSizeModeLabel()
  _szSyncSlider()
  updateOrderSummary()
}

function updateSizeModeLabel() {
  const coin  = state.selectedCoin
  const label = document.getElementById('sizeModeLabel')
  if (label) label.textContent = state.sizeMode === 'usd' ? 'Size (USD)' : `Size (${coin ?? 'Coin'})`
}

// ─── SIZE SLIDER ──────────────────────────────────────────────────────────────
// Sync slider + label from the current sizeInput value
function _szSyncSlider() {
  const { maxNotional: maxPos } = _tradeAvail()
  const rawVal = parseFloat(document.getElementById('sizeInput').value) || 0
  const mktPx  = state.selectedCoin ? parseFloat(state.allMids?.[state.selectedCoin] ?? 0) : 0
  const usdVal = state.sizeMode === 'usd' ? rawVal : rawVal * (mktPx > 0 ? mktPx : 0)
  const pct    = maxPos > 0 ? Math.min(100, Math.round(usdVal / maxPos * 100)) : 0
  const slider = document.getElementById('szPctSlider')
  const label  = document.getElementById('szPctLabel')
  if (slider) slider.value = pct
  if (label)  label.textContent = pct + ' %'
}

// Slider moved → update sizeInput value
window._szFromSlider = function() {
  const pct    = parseInt(document.getElementById('szPctSlider').value) / 100
  const { maxNotional: maxPos } = _tradeAvail()
  const mktPx  = state.selectedCoin ? parseFloat(state.allMids?.[state.selectedCoin] ?? 0) : 0
  const label  = document.getElementById('szPctLabel')
  if (label) label.textContent = Math.round(pct * 100) + ' %'
  const inp = document.getElementById('sizeInput')
  if (state.sizeMode === 'usd') {
    inp.value = maxPos > 0 ? (maxPos * pct).toFixed(2) : ''
  } else if (mktPx > 0 && maxPos > 0) {
    inp.value = ((maxPos * pct) / mktPx).toFixed(4)
  }
  updateOrderSummary()
}

// ─── SIZE PRESETS ─────────────────────────────────────────────────────────────
function setSizePct(pct) {
  const slider = document.getElementById('szPctSlider')
  const label  = document.getElementById('szPctLabel')
  if (slider) slider.value = Math.round(pct * 100)
  if (label)  label.textContent = Math.round(pct * 100) + ' %'
  const { maxNotional: maxPos } = _tradeAvail()
  const mktPx  = state.selectedCoin ? parseFloat(state.allMids?.[state.selectedCoin] ?? 0) : 0
  const inp    = document.getElementById('sizeInput')
  if (state.sizeMode === 'usd') {
    inp.value = maxPos > 0 ? (maxPos * pct).toFixed(2) : ''
  } else if (mktPx > 0 && maxPos > 0) {
    inp.value = ((maxPos * pct) / mktPx).toFixed(4)
  }
  updateOrderSummary()
}

// ─── FILL MARK PRICE ─────────────────────────────────────────────────────────
function fillMarketPrice() {
  if (!state.selectedCoin) return
  document.getElementById('limitPriceInput').value = parseFloat(state.allMids[state.selectedCoin] ?? 0).toString()
  updateOrderSummary()
}

// ─── ORDER SUMMARY ────────────────────────────────────────────────────────────
function updateOrderSummary() {
  const coin    = state.selectedCoin
  const rawVal  = parseFloat(document.getElementById('sizeInput').value) || 0
  const limitPx = parseFloat(document.getElementById('limitPriceInput').value) || 0
  const mktPx   = coin ? parseFloat(state.allMids[coin] ?? 0) : 0
  const price   = state.orderType === 'market' ? mktPx : limitPx

  let sizeUSD, coinSz
  if (state.sizeMode === 'coin') {
    coinSz  = rawVal
    sizeUSD = price > 0 ? coinSz * price : 0
  } else {
    sizeUSD = rawVal
    coinSz  = price > 0 && sizeUSD > 0 ? sizeUSD / price : 0
  }

  const margin = state.leverage > 0 ? sizeUSD / state.leverage : 0

  document.getElementById('sum-coin').textContent   = coin ?? '—'
  document.getElementById('sum-side').textContent   = state.tradeSide.toUpperCase()
  document.getElementById('sum-type').textContent   = state.orderType.charAt(0).toUpperCase() + state.orderType.slice(1)
  document.getElementById('sum-price').textContent  = price   > 0 ? '$' + fmtPrice(price)  : '—'
  document.getElementById('sum-size').textContent   = sizeUSD > 0 ? '$' + fmtUSD(sizeUSD)  : '—'
  document.getElementById('sum-coins').textContent  = coinSz  > 0 ? fmtSize(coinSz) + (coin ? ' ' + coin : '') : '—'
  document.getElementById('sum-lev').textContent    = state.leverage + 'x'
  document.getElementById('sum-lev-row').textContent = state.leverage + 'x'
  document.getElementById('sum-margin').textContent = margin  > 0 ? '$' + fmtUSD(margin)   : '—'

  _updateAvailDisplay()

  // Funding rate (8h) from market context map
  const ctx     = _mktCtxMap[coin]
  const fundVal = ctx?.funding ?? null
  const sumFund = document.getElementById('sum-fund')
  if (sumFund) {
    if (fundVal !== null && coin) {
      const sign = fundVal >= 0 ? '+' : ''
      const cls  = fundVal >= 0 ? 'pos' : 'neg'
      sumFund.innerHTML = `<span class="${cls}">${sign}${Math.abs(fundVal).toFixed(4)}%</span>`
    } else {
      sumFund.textContent = '—'
    }
  }

  // Estimated fee: ~0.05% taker (market/stop), ~0.02% maker (limit)
  const feeRate = state.orderType === 'limit' ? 0.0002 : 0.00045
  const estFee  = sizeUSD * feeRate
  document.getElementById('sum-fee').textContent = estFee > 0 ? '-$' + fmtUSD(estFee) : '—'

  _szSyncSlider()
  updatePositionPreview({ coin, coinSz, price, margin })
}

// ─── POSITION PREVIEW ────────────────────────────────────────────────────────
// Calculates what your position will look like after this order executes.
// Handles adding, reducing, and flipping.

function updatePositionPreview({ coin, coinSz, price, margin }) {
  const previewEl = document.getElementById('posPreview')
  const curRow    = document.getElementById('ppCurrentRow')

  if (!coin || coinSz <= 0 || price <= 0) {
    if (previewEl) previewEl.style.display = 'none'
    return
  }

  // Find existing open position for this coin
  const existingPos = (state.perpState?.assetPositions ?? [])
    .find(p => p.position.coin === coin)?.position

  const curSzi    = parseFloat(existingPos?.szi           ?? 0)   // signed: + long, - short
  const curEntry  = parseFloat(existingPos?.entryPx       ?? 0)
  const curPnl    = parseFloat(existingPos?.unrealizedPnl ?? 0)
  const curMargin = parseFloat(existingPos?.marginUsed    ?? 0)
  const curHlLiq  = parseFloat(existingPos?.liquidationPx ?? 0)

  // Signed size of the new order
  const orderSzi = state.tradeSide === 'long' ? coinSz : -coinSz
  const newSzi   = curSzi + orderSzi

  // New average entry price
  let newEntry
  if (newSzi === 0) {
    newEntry = 0  // full close
  } else if (curSzi === 0 || curEntry === 0) {
    newEntry = price  // fresh position
  } else if (Math.sign(curSzi) === Math.sign(orderSzi)) {
    // Adding to position — weighted average
    newEntry = (Math.abs(curSzi) * curEntry + Math.abs(orderSzi) * price)
             / (Math.abs(curSzi) + Math.abs(orderSzi))
  } else {
    // Reducing / flipping — entry unchanged until past zero
    if (Math.abs(orderSzi) <= Math.abs(curSzi)) {
      newEntry = curEntry  // partial reduce, entry stays
    } else {
      newEntry = price  // flipped to opposite side
    }
  }

  // New margin: existing + added margin (approximate)
  const newMargin = curMargin + margin

  // Show current position row if there is one
  if (existingPos && Math.abs(curSzi) > 0) {
    curRow.style.display = 'flex'
    const curSide = curSzi > 0 ? 'long' : 'short'
    document.getElementById('pp-cur-badge').textContent  = curSide.toUpperCase()
    document.getElementById('pp-cur-badge').className    = `badge badge-${curSide}`
    document.getElementById('pp-cur-size').textContent   = fmtSize(Math.abs(curSzi)) + ' ' + coin
    document.getElementById('pp-cur-entry').textContent  = '$' + fmtPrice(curEntry)
    const pnlEl = document.getElementById('pp-cur-pnl')
    pnlEl.textContent  = (curPnl >= 0 ? '+' : '') + fmtPnL(curPnl).text
    pnlEl.className    = 'pos-preview-cur-pnl ' + (curPnl >= 0 ? 'pos' : 'neg')
  } else {
    curRow.style.display = 'none'
  }

  // Fill in projected values
  const newSideStr = newSzi > 0 ? 'LONG' : newSzi < 0 ? 'SHORT' : 'CLOSED'
  const newSizeEl  = document.getElementById('pp-new-size')
  if (newSzi === 0) {
    newSizeEl.textContent = 'CLOSED'
    newSizeEl.style.color = 'var(--muted)'
  } else {
    newSizeEl.textContent = fmtSize(Math.abs(newSzi)) + ' ' + coin + '  (' + newSideStr + ')'
    newSizeEl.style.color = newSzi > 0 ? 'var(--green)' : 'var(--red)'
  }

  document.getElementById('pp-new-entry').textContent  = newEntry > 0  ? '$' + fmtPrice(newEntry)  : '—'
  const liqEl = document.getElementById('pp-new-liq')

  // Estimate projected liq price.
  // For adding to an existing position: curHlLiq already encodes the full cross-margin
  // account equity, so we use it as an anchor rather than re-deriving from scratch.
  //   LONG add:  newLiq = (newPrice×newSz + curHlLiq×curSz×(1−mmr)) / (totalSz×(1−mmr))
  //   SHORT add: same shape but (1+mmr)
  // mmr = 0.005 (HL baseline maintenance margin rate)
  const mmr = 0.005
  let newLiqPx = 0
  const absCurSzi = Math.abs(curSzi)
  const absNewSzi = Math.abs(newSzi)

  if (newSzi === 0) {
    newLiqPx = 0
  } else if (absCurSzi > 0 && curHlLiq > 0 && Math.sign(curSzi) === Math.sign(newSzi)) {
    // Adding to existing position — anchor off current HL liq
    const orderSz = coinSz
    if (newSzi > 0) {
      newLiqPx = (price * orderSz + curHlLiq * absCurSzi * (1 - mmr)) / (absNewSzi * (1 - mmr))
    } else {
      newLiqPx = (price * orderSz + curHlLiq * absCurSzi * (1 + mmr)) / (absNewSzi * (1 + mmr))
    }
    if (newLiqPx < 0) newLiqPx = 0
  } else if (absCurSzi === 0 || curHlLiq === 0) {
    // Fresh position. Cross is backed by the whole account equity; isolated is backed
    // ONLY by the margin posted for this position (notional / leverage), which puts the
    // liq price much closer to entry — so the two modes must use different backing.
    const notional = absNewSzi * newEntry
    const backing  = state.isIsolated
      ? margin
      : parseFloat(state.perpState?.marginSummary?.accountValue ?? 0)
    if (backing > 0 && notional > 0) {
      newLiqPx = newSzi > 0
        ? (notional - backing) / (absNewSzi * (1 - mmr))
        : (notional + backing) / (absNewSzi * (1 + mmr))
      if (newLiqPx < 0) newLiqPx = 0
    }
  } else {
    // Reducing or flipping — fall back to current HL liq as rough estimate
    newLiqPx = curHlLiq
  }

  liqEl.textContent = newLiqPx > 0 ? '$' + fmtPrice(newLiqPx) : (newSzi === 0 ? '—' : '—')
  const liqDist = newLiqPx > 0 && price > 0 ? Math.abs(newLiqPx - price) / price : 1
  liqEl.className = liqDist < 0.05 ? 'neg' : liqDist < 0.1 ? '' : 'pos-preview-liq-safe'
  document.getElementById('pp-new-margin').textContent = newMargin > 0 ? '$' + fmtUSD(newMargin) : '$' + fmtUSD(margin)

  previewEl.style.display = 'block'
}

// ─── TRADE CHART ──────────────────────────────────────────────────────────────
let _tradeChart        = null
let _chartTf           = '1h'
let _chartMode         = 'line'
let _chartDotColor     = '#00e5a0'
let _chartPanCleanup   = null
let _crosshairCleanup  = null
let _chartAllLabels    = []
let _chartAllData      = []
let _chartAllCandles   = []
let _chartViewStart    = 0
let _chartViewEnd      = 0
let _chartYMin         = 0
let _chartYMax         = 0
let _chartFmtLabel     = null
let _chartCurrentCoin  = null
let _chartCurrentTf    = null
let _chartEarliestTs   = null
let _chartLoadingMore  = false
let _chartYPanned      = false

function _setupCrosshair(chart, fmtLbl) {
  const mainCanvas = chart.canvas
  const overlay    = document.getElementById('chartCrosshair')
  if (!overlay) return () => {}

  function sync() {
    overlay.width  = mainCanvas.width
    overlay.height = mainCanvas.height
    overlay.style.width  = mainCanvas.style.width  || mainCanvas.offsetWidth  + 'px'
    overlay.style.height = mainCanvas.style.height || mainCanvas.offsetHeight + 'px'
  }
  sync()

  const oc = overlay.getContext('2d')
  const dpr = window.devicePixelRatio || 1

  function draw(e) {
    sync()
    oc.clearRect(0, 0, overlay.width, overlay.height)
    const rect = mainCanvas.getBoundingClientRect()

    // cursor in CSS pixels (matches chart.chartArea which is also CSS pixels)
    const mxCss = e.clientX - rect.left
    const myCss = e.clientY - rect.top
    const area = chart.chartArea
    if (!area || mxCss < area.left || mxCss > area.right || myCss < area.top || myCss > area.bottom) return

    // physical pixels for drawing on the unscaled overlay canvas
    const mx = mxCss * dpr
    const my = myCss * dpr
    const aL = area.left   * dpr,  aR = area.right  * dpr
    const aT = area.top    * dpr,  aB = area.bottom * dpr

    oc.save()

    // Dashed crosshair lines
    oc.strokeStyle = 'rgba(255,255,255,0.35)'
    oc.lineWidth   = dpr
    oc.setLineDash([4 * dpr, 4 * dpr])
    oc.beginPath(); oc.moveTo(mx, aT); oc.lineTo(mx, aB); oc.stroke()
    oc.beginPath(); oc.moveTo(aL, my); oc.lineTo(aR, my); oc.stroke()
    oc.setLineDash([])

    const fontPx = Math.round(9 * dpr)
    oc.font = `600 ${fontPx}px "JetBrains Mono", monospace`

    // Price label on right Y-axis (in CSS px coords → physical for drawing)
    const price    = chart.scales.y.getValueForPixel(myCss)
    const priceStr = price >= 1000
      ? price.toLocaleString('en-US', { maximumFractionDigits: 0 })
      : price >= 1 ? price.toFixed(4) : price.toPrecision(5)
    const pw = oc.measureText(priceStr).width
    const ph = fontPx + 6 * dpr
    const px = 6 * dpr
    oc.fillStyle = 'rgba(0,0,0,0.85)'
    oc.fillRect(aR + 2 * dpr, my - ph / 2, pw + px * 2, ph)
    oc.fillStyle = '#ffffff'
    oc.textAlign    = 'left'
    oc.textBaseline = 'middle'
    oc.fillText(priceStr, aR + 2 * dpr + px, my)

    // Date label + dot — meta.data coords are in CSS pixels
    const meta = chart.getDatasetMeta(0)
    if (meta?.data?.length) {
      let closest = 0, minDist = Infinity
      for (let i = 0; i < meta.data.length; i++) {
        const d = Math.abs(meta.data[i].x - mxCss)   // compare in CSS px
        if (d < minDist) { minDist = d; closest = i }
      }
      // Black dot at nearest data point (convert CSS→physical)
      const pt = meta.data[closest]
      if (pt && pt.y >= area.top && pt.y <= area.bottom) {
        oc.beginPath(); oc.arc(pt.x * dpr, pt.y * dpr, 4 * dpr, 0, Math.PI * 2)
        oc.fillStyle = '#000'; oc.fill()
        oc.strokeStyle = 'rgba(255,255,255,0.45)'; oc.lineWidth = dpr; oc.stroke()
      }
      const viewCandles = _chartAllCandles.slice(_chartViewStart, _chartViewEnd)
      const cd = viewCandles[closest]
      if (cd && fmtLbl) {
        const dateStr = fmtLbl(cd.t)
        const dw = oc.measureText(dateStr).width
        const dh = fontPx + 6 * dpr
        const dpx = 6 * dpr
        const dbx = Math.max(aL, Math.min(mx - dw / 2 - dpx, aR - dw - dpx * 2))
        oc.fillStyle = 'rgba(0,0,0,0.85)'
        oc.fillRect(dbx, aB + 2 * dpr, dw + dpx * 2, dh)
        oc.fillStyle = '#ffffff'
        oc.textAlign    = 'left'
        oc.textBaseline = 'top'
        oc.fillText(dateStr, dbx + dpx, aB + 2 * dpr + 3 * dpr)
      }
    }

    oc.restore()
  }

  function clear() { oc.clearRect(0, 0, overlay.width, overlay.height) }

  function onTouch(e) {
    if (!e.touches.length) return
    e.preventDefault()
    draw({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY })
  }

  mainCanvas.addEventListener('mousemove',  draw)
  mainCanvas.addEventListener('mouseleave', clear)
  mainCanvas.addEventListener('touchmove',  onTouch, { passive: false })
  mainCanvas.addEventListener('touchend',   clear)
  return () => {
    mainCanvas.removeEventListener('mousemove',  draw)
    mainCanvas.removeEventListener('mouseleave', clear)
    mainCanvas.removeEventListener('touchmove',  onTouch)
    mainCanvas.removeEventListener('touchend',   clear)
    clear()
  }
}

function _chartSetView(start, end) {
  const total  = _chartAllLabels.length
  const minWin = Math.min(30, total)
  end   = Math.min(total, end)
  start = Math.max(0, start)
  if (end - start < minWin) {
    if (start === 0) end = minWin
    else start = Math.max(0, end - minWin)
  }
  _chartViewStart = start
  _chartViewEnd   = end
  _tradeChart.data.labels           = _chartAllLabels.slice(start, end)
  _tradeChart.data.datasets[0].data = _chartAllData.slice(start, end)
  _tradeChart._candleData           = _chartAllCandles.slice(start, end)

  // Auto-scale Y to visible price range (unless user manually panned Y)
  if (!_chartYPanned) {
    const vd = _chartAllData.slice(start, end)
    const vc = _chartAllCandles.slice(start, end)
    let yMin = Infinity, yMax = -Infinity
    for (const v of vd) { if (isFinite(v)) { if (v < yMin) yMin = v; if (v > yMax) yMax = v } }
    for (const c of vc) {
      if (!c) continue
      const l = parseFloat(c.l), h = parseFloat(c.h)
      if (isFinite(l) && l < yMin) yMin = l
      if (isFinite(h) && h > yMax) yMax = h
    }
    if (isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
      const pad = (yMax - yMin) * 0.08
      _tradeChart.options.scales.y.min = yMin - pad
      _tradeChart.options.scales.y.max = yMax + pad
    }
  }

  _tradeChart.update('none')

  // Fetch older history when user reaches the left edge
  if (start === 0) _loadMoreHistory()
}

async function _loadMoreHistory() {
  if (_chartLoadingMore || !_chartCurrentCoin || !_chartCurrentTf || !_chartEarliestTs) return
  _chartLoadingMore = true
  try {
    const lookback = _TF_LOOKBACK[_chartCurrentTf] ?? 5 * 24 * 60 * 60 * 1000
    const endTs    = _chartEarliestTs
    const startTs  = endTs - lookback
    const more     = await fetchCandles(_chartCurrentCoin, _chartCurrentTf, startTs, endTs - 1)
    if (!more || more.length === 0) return

    const tf = _chartCurrentTf
    const _fp = (ts) => {
      const d  = new Date(ts)
      const dd = String(d.getDate()).padStart(2, '0')
      const mo = String(d.getMonth() + 1).padStart(2, '0')
      const HH = String(d.getHours()).padStart(2, '0')
      const MM = String(d.getMinutes()).padStart(2, '0')
      return { date: `${dd}/${mo}/${d.getFullYear()}`, time: `${HH}:${MM}` }
    }
    const fmtAxisLbl = (ts) => {
      const { date, time } = _fp(ts)
      return (tf === '1w' || tf === '1d') ? date : [date, time]
    }

    const newLabels  = more.map(c => fmtAxisLbl(c.t))
    const newData    = more.map(c => parseFloat(c.c))
    const prepend    = newLabels.length

    _chartAllLabels  = [...newLabels,  ..._chartAllLabels]
    _chartAllData    = [...newData,    ..._chartAllData]
    _chartAllCandles = [...more,       ..._chartAllCandles]
    _chartEarliestTs = more[0].t

    // Shift view window to keep the same visible candles after prepend
    _chartViewStart += prepend
    _chartViewEnd   += prepend
    _tradeChart.data.labels           = _chartAllLabels.slice(_chartViewStart, _chartViewEnd)
    _tradeChart.data.datasets[0].data = _chartAllData.slice(_chartViewStart, _chartViewEnd)
    _tradeChart._candleData           = _chartAllCandles.slice(_chartViewStart, _chartViewEnd)
    _tradeChart.update('none')
  } catch (e) {
    console.warn('[hliq] loadMoreHistory failed:', e)
  } finally {
    _chartLoadingMore = false
  }
}

function _setupChartPan(chart) {
  const canvas = chart.canvas
  let dragging = false, lastX = 0, lastY = 0, panAxis = 'x'
  let pinchDist = null

  function doPanX(clientX) {
    const dx = clientX - lastX
    lastX = clientX
    if (dx === 0) return
    const viewLen = _chartViewEnd - _chartViewStart
    const pxWidth = canvas.offsetWidth || 600
    const shift   = Math.round((dx / pxWidth) * viewLen * -1)
    if (shift === 0) return
    _chartSetView(_chartViewStart + shift, _chartViewEnd + shift)
  }

  function doPanY(clientY) {
    const dy = clientY - lastY
    lastY = clientY
    if (dy === 0) return
    const sc  = chart.options.scales.y
    const rng = (sc.max ?? _chartYMax) - (sc.min ?? _chartYMin)
    const h   = (chart.chartArea?.bottom ?? 300) - (chart.chartArea?.top ?? 0)
    const shift = (dy / h) * rng
    _chartYPanned = true
    sc.min = (sc.min ?? _chartYMin) + shift
    sc.max = (sc.max ?? _chartYMax) + shift
    chart.update('none')
  }

  function doZoomX(pxX, factor) {
    const viewLen   = _chartViewEnd - _chartViewStart
    const pxWidth   = canvas.offsetWidth || 600
    const cursorPct = Math.max(0, Math.min(1, pxX / pxWidth))
    const newLen    = Math.max(10, Math.min(_chartAllLabels.length, Math.round(viewLen * factor)))
    const anchor    = _chartViewStart + cursorPct * viewLen
    const newStart  = Math.round(anchor - cursorPct * newLen)
    _chartSetView(newStart, newStart + newLen)
  }

  function doZoomY(pxY, factor) {
    const sc   = chart.options.scales.y
    const area = chart.chartArea ?? {}
    const h    = (area.bottom ?? 300) - (area.top ?? 0)
    const pct  = Math.max(0, Math.min(1, (pxY - (area.top ?? 0)) / h))
    const yMin = sc.min ?? _chartYMin
    const yMax = sc.max ?? _chartYMax
    const rng  = yMax - yMin
    const anchor = yMax - pct * rng
    const newRng = rng * factor
    _chartYPanned = true
    sc.min = anchor - (1 - pct) * newRng
    sc.max = anchor + pct * newRng
    chart.update('none')
  }

  const md = e => {
    dragging = true
    lastX = e.clientX; lastY = e.clientY
    panAxis = e.shiftKey ? 'y' : 'x'
  }
  const mm = e => {
    if (!dragging) return
    if (panAxis === 'y') doPanY(e.clientY)
    else doPanX(e.clientX)
  }
  const mu = () => { dragging = false }
  const wh = e => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) doZoomY(e.offsetY, e.deltaY > 0 ? 1.1 : 0.91)
    else doZoomX(e.offsetX, e.deltaY > 0 ? 1.15 : 0.87)
  }
  const db = () => {
    _chartYPanned = false
    _chartSetView(0, _chartAllLabels.length)
  }

  // Touch: single-finger X/Y pan, two-finger X pinch-zoom
  const ts = e => {
    if (e.touches.length === 1) {
      dragging = true
      lastX = e.touches[0].clientX; lastY = e.touches[0].clientY
      panAxis = 'x'
      pinchDist = null
    } else if (e.touches.length === 2) {
      dragging = false
      pinchDist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      )
    }
  }
  const tm = e => {
    if (e.touches.length === 1 && dragging) {
      e.preventDefault()
      const dx = e.touches[0].clientX - lastX
      const dy = e.touches[0].clientY - lastY
      // After some vertical movement, switch to Y-pan
      if (panAxis === 'x' && Math.abs(dy) > Math.abs(dx) * 1.8 && Math.abs(dy) > 8) panAxis = 'y'
      if (panAxis === 'y') doPanY(e.touches[0].clientY)
      else doPanX(e.touches[0].clientX)
      lastY = e.touches[0].clientY
    } else if (e.touches.length === 2 && pinchDist !== null) {
      e.preventDefault()
      const dist = Math.hypot(
        e.touches[1].clientX - e.touches[0].clientX,
        e.touches[1].clientY - e.touches[0].clientY
      )
      const midX = ((e.touches[0].clientX + e.touches[1].clientX) / 2) - canvas.getBoundingClientRect().left
      doZoomX(midX, pinchDist / dist)
      pinchDist = dist
    }
  }
  const te = () => { dragging = false; pinchDist = null }

  canvas.addEventListener('mousedown',  md)
  window.addEventListener('mousemove',  mm)
  window.addEventListener('mouseup',    mu)
  canvas.addEventListener('wheel',      wh, { passive: false })
  canvas.addEventListener('dblclick',   db)
  canvas.addEventListener('touchstart', ts, { passive: true })
  canvas.addEventListener('touchmove',  tm, { passive: false })
  window.addEventListener('touchend',   te, { passive: true })

  _chartPanCleanup = () => {
    canvas.removeEventListener('mousedown',  md)
    window.removeEventListener('mousemove',  mm)
    window.removeEventListener('mouseup',    mu)
    canvas.removeEventListener('wheel',      wh)
    canvas.removeEventListener('dblclick',   db)
    canvas.removeEventListener('touchstart', ts)
    canvas.removeEventListener('touchmove',  tm)
    window.removeEventListener('touchend',   te)
  }
}
const _TF_LOOKBACK = {
  '1m':  2*60*60*1000,       '5m':  10*60*60*1000,
  '15m': 30*60*60*1000,      '30m': 60*60*60*1000,
  '1h':  5*24*60*60*1000,    '4h':  20*24*60*60*1000,
  '8h':  40*24*60*60*1000,   '1d':  120*24*60*60*1000,
  '1w':  365*24*60*60*1000,
}

function _buildChartAnnotations(coin) {
  const annotations = {}
  const pos = (state.perpState?.assetPositions ?? [])
    .find(p => p.position.coin === coin)?.position
  if (!pos) return annotations

  const entryPx = parseFloat(pos.entryPx      ?? 0)
  const liqPx   = parseFloat(pos.liquidationPx ?? 0)
  const isLong  = parseFloat(pos.szi) > 0

  const line = (value, color, label) => ({
    type: 'line', scaleID: 'y', value,
    borderColor: color, borderWidth: 1.5, borderDash: [4, 3],
    adjustScaleRange: false,
    label: {
      display: true, content: label,
      backgroundColor: color, color: '#000',
      font: { family: 'JetBrains Mono', size: 10, weight: '700' },
      padding: { x: 6, y: 2 }, borderRadius: 4,
      position: 'end',
    },
  })

  if (entryPx > 0) annotations.entry = line(entryPx, '#f5c518', `Entry $${fmtPrice(entryPx)}`)
  if (liqPx   > 0) annotations.liq   = line(liqPx,   '#ff4d6d', `Liq $${fmtPrice(liqPx)}`)

  // TP / SL from open orders
  for (const o of (state.openOrders ?? [])) {
    if (o.coin !== coin) continue
    const orderType = o.orderType ?? ''
    const isTp = orderType.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl = orderType.startsWith('Stop')        || o.triggerCondition === 'sl'
    const px   = parseFloat(o.triggerPx ?? o.limitPx ?? 0)
    if (isTp && px > 0) annotations.tp = line(px, '#00e5a0', `TP $${fmtPrice(px)}`)
    if (isSl && px > 0) annotations.sl = line(px, '#ff8c42', `SL $${fmtPrice(px)}`)
  }

  return annotations
}

let _deskChartTf        = '1h'
let _deskLWChart        = null
let _deskLWRO           = null
let _deskCandleSeries   = null
let _deskPriceLines     = []
let _deskPriceLinesInfo = []  // rich metadata for drag interactions
let _deskDragState      = null
let _deskCandleWs       = null
let _deskChartEventsBound = false


function _updateHLTradePanel(coin) {
  const iframe = document.getElementById('hlTradePanel')
  if (!iframe || !coin) return
  const apiCoin = coin.includes(':') ? coin.split(':')[1] : coin
  const url = `https://app.hyperliquid.xyz/trade/${apiCoin}`
  if (iframe.src !== url) iframe.src = url
}

async function loadTradeChart(coin, tf) {
  if (tf) {
    _mobChartTf = tf
    document.querySelectorAll('.chart-tf-btn').forEach(b =>
      b.classList.toggle('active', b.textContent.toLowerCase() === tf.toLowerCase())
    )
  }
  if (!coin) return
  updateCoinHeader(coin)
  updateChartStats(coin)

  // Reuse the mobile trade-chart engine (Chart.js + overlays/crosshair) on the desktop canvas
  _mobRenderTradeChart(coin, _mobChartTf, 'deskChartCanvas', 'deskChartHero')
}

function _refreshChartLines(coin) {
  if (!_deskCandleSeries) return
  const activeCoin = coin || state.selectedCoin
  if (!activeCoin) return

  for (const pl of _deskPriceLines) {
    try { _deskCandleSeries.removePriceLine(pl) } catch {}
  }
  _deskPriceLines     = []
  _deskPriceLinesInfo = []

  const ps = (isConnected() && _tradePerpState) ? _tradePerpState : state.perpState
  const posEntry = (ps?.assetPositions ?? []).find(ap => ap.position?.coin === activeCoin)
  const pos = posEntry?.position

  if (pos && parseFloat(pos.szi ?? 0) !== 0) {
    const entryPx = parseFloat(pos.entryPx ?? 0)
    const liqPx   = parseFloat(pos.liquidationPx ?? 0)
    if (entryPx > 0) {
      const pl = _deskCandleSeries.createPriceLine({ price: entryPx, color: '#f5c518', lineWidth: 1.5, lineStyle: 0, axisLabelVisible: true, title: 'Entry' })
      _deskPriceLines.push(pl)
      _deskPriceLinesInfo.push({ line: pl, draggable: false })
    }
    if (liqPx > 0) {
      const pl = _deskCandleSeries.createPriceLine({ price: liqPx, color: '#ff4d6d', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Liq' })
      _deskPriceLines.push(pl)
      _deskPriceLinesInfo.push({ line: pl, draggable: false })
    }
  }

  for (const o of (state.openOrders ?? [])) {
    if (o.coin !== activeCoin) continue
    const orderType = o.orderType ?? ''
    const isTp = orderType.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl = orderType.startsWith('Stop')        || o.triggerCondition === 'sl'
    const px   = parseFloat(o.triggerPx ?? 0) > 0 ? parseFloat(o.triggerPx) : parseFloat(o.limitPx ?? 0)
    if (!px) continue
    let color, title, style
    if (isTp)      { color = '#00e5a0'; title = 'TP'; style = 2 }
    else if (isSl) { color = '#ff8c42'; title = 'SL'; style = 2 }
    else           { color = o.side === 'B' ? '#26a69a' : '#ef5350'; title = o.side === 'B' ? 'Buy' : 'Sell'; style = 1 }
    const pl = _deskCandleSeries.createPriceLine({ price: px, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })
    _deskPriceLines.push(pl)
    _deskPriceLinesInfo.push({
      line: pl, draggable: true,
      price: px, title, color,
      oid: o.oid, coin: o.coin,
      isBuy: o.side === 'B',
      sz: parseFloat(o.sz ?? 0),
      tpsl: isTp ? 'tp' : isSl ? 'sl' : '',
      isTrigger: !!(isTp || isSl),
    })
  }
}

// ─── DRAGGABLE TP/SL PRICE LINES ─────────────────────────────────────────────

function _deskChartPointerDown(e) {
  if (!_deskCandleSeries || !_deskLWChart || e.button !== 0) return
  const rect = e.currentTarget.getBoundingClientRect()
  const offsetY = e.clientY - rect.top
  let closest = null, closestDist = 8
  for (const info of _deskPriceLinesInfo) {
    if (!info.draggable) continue
    const lineY = _deskCandleSeries.priceToCoordinate(info.price)
    if (lineY == null) continue
    const dist = Math.abs(offsetY - lineY)
    if (dist < closestDist) { closest = info; closestDist = dist }
  }
  if (closest) {
    _deskDragState = { info: closest, origPrice: closest.price, moved: false }
    e.stopPropagation()
    e.preventDefault()
  }
}

function _deskChartPointerMove(e) {
  if (!_deskCandleSeries || !_deskLWChart) return
  const rect = e.currentTarget.getBoundingClientRect()
  const offsetY = e.clientY - rect.top
  if (_deskDragState) {
    const newPrice = _deskLWChart.priceScale('right').coordinateToPrice(offsetY)
    if (newPrice != null && newPrice > 0) {
      _deskDragState.info.price = newPrice
      _deskDragState.info.line.applyOptions({ price: newPrice })
      _deskDragState.moved = true
    }
    e.stopPropagation()
    e.currentTarget.style.cursor = 'ns-resize'
    return
  }
  let nearLine = false
  for (const info of _deskPriceLinesInfo) {
    if (!info.draggable) continue
    const lineY = _deskCandleSeries.priceToCoordinate(info.price)
    if (lineY != null && Math.abs(offsetY - lineY) < 8) { nearLine = true; break }
  }
  e.currentTarget.style.cursor = nearLine ? 'ns-resize' : ''
}

function _deskChartPointerUp() {
  if (!_deskDragState) return
  const { info, origPrice, moved } = _deskDragState
  _deskDragState = null
  const container = document.getElementById('deskChartWidget')
  if (container) container.style.cursor = ''
  if (!moved || Math.abs(info.price - origPrice) / (origPrice || 1) < 0.0001) {
    info.line.applyOptions({ price: origPrice })
    info.price = origPrice
    return
  }
  _deskCommitDraggedLine(info, origPrice)
}

async function _deskCommitDraggedLine(info, origPrice) {
  if (!isConnected()) {
    info.line.applyOptions({ price: origPrice })
    info.price = origPrice
    return
  }
  try {
    await modifyOrderPrice({ coin: info.coin, oid: info.oid, isBuy: info.isBuy, sz: info.sz, newPx: info.price, tpsl: info.tpsl, isTrigger: info.isTrigger })
    _showChartToast(`${info.title} → $${fmtPrice(info.price)}`)
    setTimeout(refreshLive, 1000)
  } catch (err) {
    _showChartToast(`Failed to update ${info.title}`)
    info.line.applyOptions({ price: origPrice })
    info.price = origPrice
  }
}

function _showChartToast(msg) {
  let t = document.getElementById('_chartToast')
  if (!t) {
    t = document.createElement('div')
    t.id = '_chartToast'
    t.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:#1e222d;color:#e0e3eb;padding:7px 16px;border-radius:8px;font-size:13px;z-index:9999;pointer-events:none;opacity:0;transition:opacity .2s;white-space:nowrap;box-shadow:0 2px 12px rgba(0,0,0,.4)'
    document.body.appendChild(t)
  }
  t.textContent = msg
  t.style.opacity = '1'
  clearTimeout(t._hideTimer)
  t._hideTimer = setTimeout(() => { t.style.opacity = '0' }, 2000)
}

// Double-click resets view (handled inside _setupChartPan via the db handler)

window.__chartSetTf = function(tf) {
  _chartRange = null
  document.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'))
  if (state.selectedCoin) loadTradeChart(state.selectedCoin, tf)
}
window.__chartResetZoom = function() {
  if (_tradeChart && _chartAllLabels.length) _chartSetView(0, _chartAllLabels.length)
}
window.__chartSetMode = function(mode) {
  if (_chartMode === mode) return
  _chartMode = mode
  document.querySelectorAll('.chart-mode-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.mode === mode)
  )
  if (state.selectedCoin) loadTradeChart(state.selectedCoin)
}

const _RANGE_CFG = {
  '1d': { tf: '1m',  ms: 1   * 24 * 3600 * 1000 },
  '5d': { tf: '15m', ms: 5   * 24 * 3600 * 1000 },
  '1m': { tf: '1h',  ms: 30  * 24 * 3600 * 1000 },
  '3m': { tf: '4h',  ms: 90  * 24 * 3600 * 1000 },
  '6m': { tf: '1d',  ms: 180 * 24 * 3600 * 1000 },
  '1y': { tf: '1d',  ms: 365 * 24 * 3600 * 1000 },
  '5y': { tf: '1w',  ms: 5 * 365 * 24 * 3600 * 1000 },
}
let _chartRange = null

window.__chartSetRange = function(range) {
  _chartRange = range
  document.querySelectorAll('.chart-range-btn').forEach(b => b.classList.toggle('active', b.textContent.toLowerCase() === range))
  const cfg = _RANGE_CFG[range]
  if (!cfg || !state.selectedCoin) return
  _TF_LOOKBACK[cfg.tf] = cfg.ms
  loadTradeChart(state.selectedCoin, cfg.tf)
}

// ─── CHART STATS BAR ──────────────────────────────────────────────────────────
let _fundingCdInterval = null

function _fmtHdrPx(p) {
  if (!p || p <= 0) return '—'
  if (p >= 1000) return p.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (p >= 10)   return p.toFixed(4)
  if (p >= 1)    return p.toFixed(4)
  return p.toPrecision(5)
}
function _fmtHdrChgAbs(abs, p) {
  if (p >= 1000) return Math.round(abs).toLocaleString('en-US')
  if (p >= 10)   return abs.toFixed(4)
  if (p >= 1)    return abs.toFixed(4)
  return abs.toPrecision(4)
}
function _fmtHdrDollar(n) {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function updateChartStats(coin) {
  const el = document.getElementById('tradeChartStats')
  if (!el) return
  if (!coin) { el.innerHTML = ''; return }

  const d   = _mktCtxMap[coin]
  const mid = parseFloat(state.allMids?.[coin] ?? 0)
  const mark    = d?.markPx   || mid
  const oracle  = d?.oraclePx || 0
  const ch      = d?.change24 ?? 0
  const chAbs   = d?.change24Abs ?? 0
  const chCls   = ch >= 0 ? 'pos' : 'neg'
  const chSign  = ch >= 0 ? '+' : ''
  const vol     = d?.volume ?? 0
  const oi      = d?.oi ?? 0
  const fund    = d?.funding ?? 0
  const fundCls = fund >= 0 ? 'pos' : 'neg'
  const fundSign= fund >= 0 ? '+' : ''
  const nft     = d?.nextFundingTime

  function stat(label, val) {
    return `<div class="cs-stat"><span class="cs-label">${label}</span><span class="cs-val">${val}</span></div>`
  }

  el.innerHTML =
    stat('Mark',     _fmtHdrPx(mark)) +
    stat('Oracle',   oracle > 0 ? `<span class="cs-oracle">${_fmtHdrPx(oracle)}</span>` : '—') +
    stat('24h Change', `<span class="${chCls}">${chSign}${_fmtHdrChgAbs(Math.abs(chAbs), mark)} / ${chSign}${ch.toFixed(2)}%</span>`) +
    stat('24h Volume', _fmtHdrDollar(vol)) +
    stat('Open Interest', _fmtHdrDollar(oi)) +
    `<div class="cs-stat" id="csFundStat"><span class="cs-label">Funding / Countdown</span><span class="cs-val"><span class="${fundCls}">${fundSign}${Math.abs(fund).toFixed(4)}%</span><span class="cs-cd" id="csFundCd">${nft ? _fmtCd(nft) : ''}</span></span></div>`

  if (_fundingCdInterval) clearInterval(_fundingCdInterval)
  if (nft) {
    _fundingCdInterval = setInterval(() => {
      const cdEl = document.getElementById('csFundCd')
      if (!cdEl) { clearInterval(_fundingCdInterval); return }
      const s = _fmtCd(nft)
      cdEl.textContent = s
      if (!s) clearInterval(_fundingCdInterval)
    }, 1000)
  }
}

function _fmtCd(nft) {
  const ms = nft - Date.now()
  if (ms <= 0) return '00:00:00'
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

// ─── SUBMIT BUTTON ────────────────────────────────────────────────────────────
function updateSubmitBtn() {
  const btn = document.getElementById('tradeSubmitBtn')
  if (!isConnected()) {
    btn.disabled = false
    btn.textContent = isMainWalletConnected() ? '⚡ Auto-generate agent key to trade' : '🔗 Connect wallet to trade'
    btn.className = 'btn-trade-long'
    return
  }
  if (riskMgmtEnabled && isPaused()) {
    btn.disabled = true; btn.textContent = '⛔ Risk limit hit — see Settings → Risk Management'; btn.className = 'btn-trade-long'
    return
  }
  if (newsPaused) {
    btn.disabled = true; btn.textContent = '⛔ News pause active — see Strategies → News Pause'; btn.className = 'btn-trade-long'
    return
  }
  if (!state.selectedCoin) {
    btn.disabled = true; btn.textContent = 'Select a market'; btn.className = 'btn-trade-long'
    return
  }
  btn.disabled = false
  if (state.tradeSide === 'long') {
    btn.className = 'btn-trade-long'; btn.textContent = `▲ Buy / Long  ${state.selectedCoin}`
  } else {
    btn.className = 'btn-trade-short'; btn.textContent = `▼ Sell / Short  ${state.selectedCoin}`
  }
}

// ─── SUBMIT ORDER ─────────────────────────────────────────────────────────────
async function submitOrder() {
  const statusEl = document.getElementById('tradeStatus')
  if (!isConnected()) { window.__quickConnectAgent(); return }
  if (!isBuilderFeeEnabled()) { showTradeStatus(statusEl, 'error', '✗ Builder fee not approved — reconnect your main wallet to enable trading.'); return }
  if (!state.selectedCoin) { showTradeStatus(statusEl, 'error', 'Select a market first.'); return }
  if (riskMgmtEnabled && isPaused()) {
    const r = getRiskState()
    showTradeStatus(statusEl, 'error', '⛔ Trading paused — ' + (r.pauseReason ?? 'risk limit hit') + '. Resume in Settings → Risk Management.')
    return
  }
  if (newsPaused) {
    showTradeStatus(statusEl, 'error', '⛔ News pause active — clear the alert in Strategies → News Pause.')
    return
  }

  const coin    = state.selectedCoin
  const isBuy   = state.tradeSide === 'long'
  const rawVal  = parseFloat(document.getElementById('sizeInput').value)
  const limitPx = parseFloat(document.getElementById('limitPriceInput').value)
  const stopPx  = parseFloat(document.getElementById('stopPriceInput').value)
  const tpPx    = parseFloat(document.getElementById('tpInput').value)
  const slPx    = parseFloat(document.getElementById('slInput').value)
  const mktPx   = parseFloat(state.allMids[coin] ?? 0)

  if (!rawVal || rawVal <= 0)      { showTradeStatus(statusEl, 'error', 'Enter a valid position size.'); return }
  if (mktPx <= 0)                  { showTradeStatus(statusEl, 'error', 'Cannot fetch mark price for ' + coin + '.'); return }
  if (state.orderType === 'limit' && (!limitPx || limitPx <= 0)) { showTradeStatus(statusEl, 'error', 'Enter a valid limit price.'); return }
  if (state.orderType === 'stop'  && (!stopPx  || stopPx  <= 0)) { showTradeStatus(statusEl, 'error', 'Enter a valid trigger price.'); return }

  const coinSz = state.sizeMode === 'coin' ? rawVal : rawVal / mktPx
  document.getElementById('tradeSubmitBtn').disabled = true
  showTradeStatus(statusEl, 'pending', 'Signing and submitting order...')

  try {
    let result
    if (state.orderType === 'market') {
      result = await placeMarketOrder({ coin, isBuy, sz: coinSz, markPrice: mktPx, leverage: state.leverage, isIsolated: state.isIsolated })
    } else if (state.orderType === 'limit') {
      result = await placeLimitOrder({ coin, isBuy, sz: coinSz, limitPx, leverage: state.leverage, isIsolated: state.isIsolated })
    } else {
      result = await placeMarketOrder({ coin, isBuy, sz: coinSz, markPrice: stopPx, leverage: state.leverage, isIsolated: state.isIsolated })
    }

    const parsed = parseOrderResult(result)
    if (!parsed.ok) {
      showTradeStatus(statusEl, 'error', '✗ ' + parsed.errors.join(', '))
      document.getElementById('tradeSubmitBtn').disabled = false
      updateSubmitBtn(); return
    }

    let msg = '✓ Order placed!'
    if (parsed.filled.length > 0) {
      const f = parsed.filled[0]
      msg = `✓ Filled ${fmtSize(f.totalSz ?? coinSz)} ${coin} @ $${fmtPrice(f.avgPx ?? mktPx)}`
    } else if (parsed.resting.length > 0) {
      msg = `✓ Limit order resting (OID: ${parsed.resting[0].oid})`
    }
    showTradeStatus(statusEl, 'success', msg)

    if (tpPx > 0) {
      try { await placeTriggerOrder({ coin, isBuy: !isBuy, sz: coinSz, triggerPx: tpPx, tpsl: 'tp' }); msg += ' · TP set' } catch(e) { msg += ' · TP failed' }
      showTradeStatus(statusEl, 'success', msg)
    }
    if (slPx > 0) {
      try { await placeTriggerOrder({ coin, isBuy: !isBuy, sz: coinSz, triggerPx: slPx, tpsl: 'sl' }); msg += ' · SL set' } catch(e) { msg += ' · SL failed' }
      showTradeStatus(statusEl, 'success', msg)
    }

    document.getElementById('sizeInput').value = ''
    document.getElementById('tpInput').value   = ''
    document.getElementById('slInput').value   = ''
    setTimeout(refreshLive, 1500)

  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
  }

  document.getElementById('tradeSubmitBtn').disabled = false
  updateSubmitBtn()
}

// ─── CLOSE MODAL ──────────────────────────────────────────────────────────────
function _closeColor() {
  return state.closingPos?.side === 'LONG' ? 'var(--green)' : 'var(--red)'
}

function _updateCloseDisplay() {
  const pos = state.closingPos
  if (!pos) return
  const color   = _closeColor()
  const pct     = parseInt(document.getElementById('closeSlider').value)
  const closeSz = Math.abs(pos.szi) * pct / 100
  document.getElementById('closePctDisplay').textContent  = pct + '%'
  document.getElementById('closePctDisplay').style.color  = color
  document.getElementById('closeSzDisplay').textContent   = fmtSize(closeSz) + ' ' + coinLabel(pos.coin)
  document.getElementById('closeValDisplay').textContent  = '$' + fmtUSD(closeSz * pos.mktPx)
  document.querySelectorAll('.close-preset-btn').forEach(b => b.classList.toggle('active', parseInt(b.textContent) === pct))
  const slider = document.getElementById('closeSlider')
  slider.style.setProperty('--slider-color', color)
  slider.style.background = `linear-gradient(to right, ${color} 0%, ${color} ${pct}%, var(--border2) ${pct}%)`
}

window.__onCloseSlider = function () { _updateCloseDisplay() }
window.__setClosePct   = function (pct) {
  document.getElementById('closeSlider').value = pct
  _updateCloseDisplay()
}

// ─── EDIT POSITION SLIDERS ────────────────────────────────────────────────────
function _tpslCalcPrice(pctInput, isTp) {
  const pos = state.editingPos
  if (!pos || pctInput === 0) return null
  const { isLong, entryPx, leverage } = pos
  // Convert ROI% → price% if in roi mode
  const pct = pos[isTp ? 'tpMode' : 'slMode'] === 'roi' ? pctInput / leverage : pctInput
  if (isTp) return isLong ? entryPx * (1 + pct / 100) : entryPx * (1 - pct / 100)
  else       return isLong ? entryPx * (1 - pct / 100) : entryPx * (1 + pct / 100)
}

function _tpslCalcPct(price, isTp) {
  const pos = state.editingPos
  if (!pos || price <= 0) return 0
  const { entryPx, leverage } = pos
  const pricePct = Math.abs((price - entryPx) / entryPx * 100)
  const mode = pos[isTp ? 'tpMode' : 'slMode']
  return mode === 'roi' ? pricePct * leverage : pricePct
}

function _tpslUpdatePnl(isTp) {
  const pos    = state.editingPos
  const usdEl  = document.getElementById(isTp ? 'tpslTpUsd' : 'tpslSlUsd')
  const pnlEl  = document.getElementById(isTp ? 'tpslTpPnl' : 'tpslSlPnl')
  const echoEl = document.getElementById(isTp ? 'tpslTpPctEcho' : 'tpslSlPctEcho')
  const pctEl  = document.getElementById(isTp ? 'tpslTpPct' : 'tpslSlPct')
  if (!pos || !pnlEl) return
  const usdPrice = parseFloat(usdEl?.value) || 0
  const pctVal   = parseFloat(pctEl?.value) || 0
  if (echoEl) echoEl.textContent = pctVal > 0 ? pctVal.toFixed(2) : '0.00'
  // P&L uses effective size (partial support)
  const szPct = pos[isTp ? 'tpSzPct' : 'slSzPct'] ?? 100
  const effectiveSz = Math.abs(pos.szi) * szPct / 100
  if (usdPrice > 0 && pos.entryPx > 0) {
    const pnl = (usdPrice - pos.entryPx) * effectiveSz * (pos.isLong ? 1 : -1)
    pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + Math.abs(pnl).toFixed(2)
    pnlEl.style.color = pnl >= 0 ? 'var(--green)' : 'var(--red)'
  } else {
    pnlEl.textContent = '—'
    pnlEl.style.color = ''
  }
}

window.__tpslSync = function(side, from) {
  const isTp  = side === 'tp'
  const pctEl = document.getElementById(isTp ? 'tpslTpPct' : 'tpslSlPct')
  const usdEl = document.getElementById(isTp ? 'tpslTpUsd' : 'tpslSlUsd')
  if (from === 'pct') {
    const px = _tpslCalcPrice(parseFloat(pctEl.value) || 0, isTp)
    usdEl.value = px ? px.toFixed(5) : ''
  } else {
    const pct = _tpslCalcPct(parseFloat(usdEl.value) || 0, isTp)
    pctEl.value = pct > 0 ? pct.toFixed(2) : ''
  }
  _tpslUpdatePnl(isTp)
}

window.__tpslTab = function(tab) {
  const isPartial = tab === 'partial'
  document.getElementById('tpslTabEntire').classList.toggle('active', !isPartial)
  document.getElementById('tpslTabPartial').classList.toggle('active', isPartial)
  document.querySelectorAll('.tpsl-partial-only').forEach(el => {
    el.style.display = isPartial ? '' : 'none'
  })
  if (state.editingPos) state.editingPos.activeTab = tab
  _tpslUpdatePnl(true)
  _tpslUpdatePnl(false)
}

window.__tpslToggleMode = function(side) {
  const isTp   = side === 'tp'
  const modeKey = isTp ? 'tpMode' : 'slMode'
  const pos    = state.editingPos
  if (!pos) return
  const newMode = (pos[modeKey] === 'roi') ? 'pct' : 'roi'
  pos[modeKey]  = newMode
  const lbl = newMode === 'roi' ? 'ROI %' : 'Price %'
  document.getElementById(isTp ? 'tpslTpModeLbl' : 'tpslSlModeLbl').textContent = lbl
  document.getElementById(isTp ? 'tpslTpPctLbl'  : 'tpslSlPctLbl').textContent  = isTp ? 'TP' : 'SL'
  // Recalculate pct display from current USD price
  const usdEl = document.getElementById(isTp ? 'tpslTpUsd' : 'tpslSlUsd')
  const usd   = parseFloat(usdEl?.value) || 0
  if (usd > 0) {
    const pct = _tpslCalcPct(usd, isTp)
    const pctEl = document.getElementById(isTp ? 'tpslTpPct' : 'tpslSlPct')
    if (pctEl) pctEl.value = pct.toFixed(2)
  }
  _tpslUpdatePnl(isTp)
}

window.__tpslToggleType = function(side) {
  const isTp   = side === 'tp'
  const typeKey = isTp ? 'tpType' : 'slType'
  const pos    = state.editingPos
  if (!pos) return
  const newType = (pos[typeKey] === 'limit') ? 'market' : 'limit'
  pos[typeKey]  = newType
  document.getElementById(isTp ? 'tpslTpTypeLbl' : 'tpslSlTypeLbl').textContent =
    newType === 'limit' ? 'Limit' : 'Market'
}

window.__tpslSzSlider = function(side) {
  const isTp   = side === 'tp'
  const pos    = state.editingPos
  if (!pos) return
  const slider  = document.getElementById(isTp ? 'tpslTpSzSlider' : 'tpslSlSzSlider')
  const display = document.getElementById(isTp ? 'tpslTpSzDisplay' : 'tpslSlSzDisplay')
  const pct     = parseFloat(slider.value)
  const sz      = Math.abs(pos.szi) * pct / 100
  pos[isTp ? 'tpSzPct' : 'slSzPct'] = pct
  if (display) display.textContent = fmtSize(sz) + ' ' + coinLabel(pos.coin)
  slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--border2) ${pct}%)`
  _tpslUpdatePnl(isTp)
}

function _updateEditOrdSlider() {
  const ord    = state.editingOrder
  if (!ord) return
  const slider = document.getElementById('editOrdSlider')
  const pct    = parseInt(slider.value)
  const sz     = ord.maxSz * pct / 100
  const px     = parseFloat(document.getElementById('editOrderPriceInput').value) || ord.currentPx || 0
  slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--border2) ${pct}%)`
  const display = document.getElementById('eordSzDisplay')
  if (display) {
    if (ord.szUnit === 'usdc' && px > 0) {
      display.textContent = '$' + fmtUSD(sz * px)
    } else {
      display.textContent = fmtSize(sz) + ' ' + coinLabel(ord.coin)
    }
  }
}
window.__onEditOrdSlider = function () { _updateEditOrdSlider() }
window.__setEditOrdPct   = function (pct) {
  document.getElementById('editOrdSlider').value = pct
  _updateEditOrdSlider()
}
window.__eordUpdateSize = function () { _updateEditOrdSlider() }
window.__eordSetMid = function () {
  const ord = state.editingOrder
  if (!ord) return
  const mid = state.allMids?.[ord.coin]
  if (mid) {
    document.getElementById('editOrderPriceInput').value = parseFloat(mid).toFixed(5)
    _updateEditOrdSlider()
  }
}
window.__eordToggleSzUnit = function () {
  const ord = state.editingOrder
  if (!ord) return
  ord.szUnit = ord.szUnit === 'usdc' ? 'token' : 'usdc'
  _updateEditOrdSlider()
}

window.__openCloseModal = function (coin, side, szi, mktPx) {
  state.closingPos = { coin, side, szi: parseFloat(szi), mktPx: parseFloat(mktPx) }
  document.getElementById('closeModalTitle').textContent = `Close ${coinLabel(coin)} ${side}`
  document.getElementById('closeModalDesc').textContent  = `Mark: $${fmtPrice(parseFloat(mktPx))}`
  const slider = document.getElementById('closeSlider')
  slider.value = 100
  slider.style.setProperty('--slider-color', _closeColor())
  slider.style.background = _closeColor()
  document.getElementById('closeModalStatus').className  = 'trade-status'
  document.getElementById('closeModalConfirm').disabled  = false
  _modalToBody('closeModal').classList.add('open')
  _updateCloseDisplay()
}

// Reflect a filled close locally the moment HL confirms the fill — don't wait
// for the next 5s refresh tick (which can lag or fail entirely on bad wifi,
// leaving "ghost" open positions on screen). The next successful refresh
// re-baselines from HL either way.
function _optimisticClosePos(coin, closedSz) {
  const aps = state.perpState?.assetPositions
  if (!aps) return
  for (const ap of aps) {
    if (ap.position?.coin !== coin) continue
    const szi = parseFloat(ap.position.szi ?? 0)
    const rem = Math.abs(szi) - closedSz
    ap.position.szi = (rem <= Math.abs(szi) * 0.001 ? 0 : Math.sign(szi) * rem).toString()
    if (parseFloat(ap.position.szi) === 0) ap.position.unrealizedPnl = '0'
  }
  state.perpState.assetPositions = aps.filter(ap => parseFloat(ap.position?.szi ?? 0) !== 0)
  try { renderPositionSection() } catch {}
  try { updateMobileView(true) } catch {}
  try { _gmOrdersHash = null; _updateGameMode() } catch {}
}

window.__confirmClosePosition = async function () {
  if (!state.closingPos) return
  if (!isConnected()) { showTradeStatus(document.getElementById('closeModalStatus'), 'error', 'Connect agent key first.'); return }

  const { coin, side, szi, mktPx } = state.closingPos
  const pct     = parseInt(document.getElementById('closeSlider').value)
  const closeSz = Math.abs(szi) * pct / 100
  const statusEl = document.getElementById('closeModalStatus')

  showTradeStatus(statusEl, 'pending', 'Submitting close order...')
  document.getElementById('closeModalConfirm').disabled = true

  try {
    const result = await closePosition({ coin, isBuy: szi < 0, sz: closeSz, markPrice: mktPx })
    const parsed = parseOrderResult(result)
    const didFill = parsed.filled.some(f => parseFloat(f.filled?.totalSz ?? 0) > 0)
    if (!parsed.ok) {
      showTradeStatus(statusEl, 'error', '✗ ' + parsed.errors.join(', '))
      document.getElementById('closeModalConfirm').disabled = false
    } else if (!didFill) {
      showTradeStatus(statusEl, 'error', '✗ Order did not fill — market may have moved. Try again.')
      document.getElementById('closeModalConfirm').disabled = false
    } else {
      showTradeStatus(statusEl, 'success', '✓ Position closed!')
      _optimisticClosePos(coin, closeSz)   // reflect immediately, don't wait on the tick
      setTimeout(() => { closeModals(); refreshLive() }, 1000)
    }
  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    document.getElementById('closeModalConfirm').disabled = false
  }
}

// ─── ADJUST MARGIN MODAL (isolated positions only) ─────────────────────────────
window.__openAdjustMarginModal = function (coin, side, marginUsed, positionValue, leverage) {
  const isLong = side === 'LONG'
  // Reparent to <body> so it shows in the mobile view (.app is display:none there)
  const _ov = document.getElementById('marginModal')
  if (_ov && _ov.parentElement !== document.body) document.body.appendChild(_ov)
  // Fallback while activeAssetData loads — unified available (perp + free spot)
  const perpWdraw = parseFloat(state.perpState?.withdrawable ?? 0)
  const spotUSDC  = (state.spotState?.balances ?? []).find(b => b.coin === 'USDC')
  const spotFree  = spotUSDC ? Math.max(0, parseFloat(spotUSDC.total ?? 0) - parseFloat(spotUSDC.hold ?? 0)) : 0
  // Removable margin = position equity (deposited margin + uPnL) above the
  // initial-margin floor at the set leverage. uPnL matters: profit frees more,
  // a loss frees less. HL validates the exact cap and we surface its error.
  const lev        = parseFloat(leverage) || 1
  const initMargin = lev > 0 ? parseFloat(positionValue) / lev : parseFloat(marginUsed)
  const livePos    = (state.perpState?.assetPositions ?? []).find(a => a.position?.coin === coin)?.position
  const uPnl       = parseFloat(livePos?.unrealizedPnl ?? 0)
  const equity     = parseFloat(marginUsed) + uPnl
  const removable  = Math.max(0, equity - initMargin)
  state.marginPos = {
    coin, isLong,
    marginUsed: parseFloat(marginUsed) || 0,
    available: perpWdraw + spotFree, removable,
    // For the projected-liquidation preview (HL liq price is linear in margin)
    liqPx:  parseFloat(livePos?.liquidationPx ?? 0),
    size:   Math.abs(parseFloat(livePos?.szi ?? 0)),
    maxLev: parseFloat(livePos?.maxLeverage ?? lev) || lev,
  }
  document.getElementById('marginCurLabel').textContent = `Current margin for ${coinLabel(coin)}-USDC`
  document.getElementById('marginCurVal').textContent   = fmtUSD(state.marginPos.marginUsed) + ' USDC'
  document.getElementById('marginAmtInput').value = ''
  document.getElementById('marginDirSelect').value = 'add'
  document.getElementById('marginModalStatus').className = 'trade-status'
  window.__marginDirChange()
  document.getElementById('marginModal').classList.add('open')

  // Authoritative "available to add" = HL's availableToTrade for this coin
  // (matches their own Adjust Margin modal). availableToTrade[0] = same-side.
  if (state.addr) {
    infoClient.activeAssetData({ user: state.addr, coin }).then(d => {
      if (!state.marginPos || state.marginPos.coin !== coin) return
      const avail = Math.max(0, parseFloat(d?.availableToTrade?.[0] ?? 0))
      state.marginPos.available = avail
      window.__marginDirChange()
    }).catch(() => {})
  }
}

window.__marginDirChange = function () {
  const mp = state.marginPos; if (!mp) return
  const isAdd = document.getElementById('marginDirSelect').value === 'add'
  document.getElementById('marginAvailLabel').textContent = isAdd ? 'Margin available to add' : 'Margin available to remove'
  document.getElementById('marginAvailVal').textContent   = fmtUSD(isAdd ? mp.available : mp.removable) + ' USDC'
  window.__marginValidate()
  window.__marginUpdateLiq()
}

// Project the new liquidation price for the entered amount. HL's isolated liq
// price is LINEAR in margin, so we anchor to the real reported liqPx and apply
// the documented slope: Δliq = ∓ amount / (size · (1 ∓ maintFrac)), maintFrac =
// 1/(2·maxLeverage). Adding margin pushes liq away from mark (safer); removing
// pulls it toward mark (riskier).
window.__marginUpdateLiq = function () {
  const mp = state.marginPos; if (!mp) return
  const row = document.getElementById('marginLiqRow')
  const valEl = document.getElementById('marginLiqVal')
  if (!row || !valEl) return
  if (!(mp.liqPx > 0) || !(mp.size > 0)) { row.style.display = 'none'; return }
  row.style.display = ''
  const amt   = parseFloat(document.getElementById('marginAmtInput').value) || 0
  const isAdd = document.getElementById('marginDirSelect').value === 'add'
  if (amt <= 0) { valEl.innerHTML = `$${fmtPrice(mp.liqPx)}`; return }
  const delta     = isAdd ? amt : -amt
  const maintFrac = mp.maxLev > 0 ? 1 / (2 * mp.maxLev) : 0
  const slope     = mp.isLong ? 1 / (mp.size * (1 - maintFrac)) : 1 / (mp.size * (1 + maintFrac))
  const newLiq    = Math.max(0, mp.isLong ? mp.liqPx - delta * slope : mp.liqPx + delta * slope)
  const color     = isAdd ? 'var(--green)' : 'var(--red)'
  valEl.innerHTML = `<span style="color:var(--muted)">$${fmtPrice(mp.liqPx)}</span> → <span style="color:${color};font-weight:600">$${fmtPrice(newLiq)}</span>`
}

window.__marginSetMax = function () {
  const mp = state.marginPos; if (!mp) return
  const isAdd = document.getElementById('marginDirSelect').value === 'add'
  document.getElementById('marginAmtInput').value = (isAdd ? mp.available : mp.removable).toFixed(2)
  window.__marginValidate()
}

window.__marginValidate = function () {
  const mp = state.marginPos; if (!mp) return
  const amt   = parseFloat(document.getElementById('marginAmtInput').value) || 0
  const isAdd = document.getElementById('marginDirSelect').value === 'add'
  const cap   = isAdd ? mp.available : mp.removable
  const btn   = document.getElementById('marginModalConfirm')
  const statusEl = document.getElementById('marginModalStatus')
  if (amt > cap + 0.01) {
    showTradeStatus(statusEl, 'error', `Max ${isAdd ? 'available' : 'removable'} is $${fmtUSD(cap)}`)
    btn.disabled = true
  } else {
    statusEl.className = 'trade-status'
    btn.disabled = amt <= 0
  }
  window.__marginUpdateLiq()
}

window.__confirmAdjustMargin = async function () {
  if (!state.marginPos) return
  const statusEl = document.getElementById('marginModalStatus')
  if (!isConnected()) { showTradeStatus(statusEl, 'error', 'Connect agent key first.'); return }
  const { coin, isLong } = state.marginPos
  const isAdd  = document.getElementById('marginDirSelect').value === 'add'
  const amount = parseFloat(document.getElementById('marginAmtInput').value) || 0
  if (amount <= 0) { showTradeStatus(statusEl, 'error', 'Enter an amount first.'); return }

  showTradeStatus(statusEl, 'pending', `${isAdd ? 'Adding' : 'Removing'} margin...`)
  document.getElementById('marginModalConfirm').disabled = true
  try {
    await adjustIsolatedMargin({ coin, isLong, usdAmount: amount, isAdd })
    showTradeStatus(statusEl, 'success', `✓ ${isAdd ? 'Added' : 'Removed'} $${fmtUSD(amount)} margin!`)
    setTimeout(() => { closeModals(); refreshLive() }, 1000)
  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    document.getElementById('marginModalConfirm').disabled = false
  }
}

// ─── POSITION GUARDS (Liq Guard / Lev Brake) ────────────────────────────────────
// Per-position price-triggered safety bots that run server-side: Liq Guard adds
// margin as price nears liquidation, Lev Brake reduces position size. One server
// instance per (coin, mode); the running set is reflected in serverStatus._instances.
function _guardFindPos(coin) {
  return (state.perpState?.assetPositions ?? []).find(a => a.position?.coin === coin)?.position || null
}
// Parse a flat ['--flag','value',...] argv (from a running guard) into an object.
function _parseGuardArgs(args) {
  const o = {}
  if (!Array.isArray(args)) return o
  for (let i = 0; i < args.length; i++) {
    const t = String(args[i])
    if (!t.startsWith('--')) continue
    const k = t.slice(2)
    const next = args[i + 1]
    if (next === undefined || String(next).startsWith('--')) o[k] = true   // boolean flag
    else { o[k] = next; i++ }
  }
  return o
}

// Two-tap confirmation for Arm/Update and Disarm (money-touching actions).
let _guardArmArmed    = false
let _guardDisarmArmed = false
let _guardConfirmTimer = null
function _guardResetConfirm() {
  _guardArmArmed = false; _guardDisarmArmed = false
  clearTimeout(_guardConfirmTimer)
  const c = document.getElementById('guardConfirmBtn')
  const d = document.getElementById('guardDisarmBtn')
  if (c) { c.textContent = state.guardCfg?.running ? 'Update' : 'Arm'; c.classList.remove('btn-confirming') }
  if (d) { d.textContent = 'Disarm'; d.classList.remove('btn-confirming') }
}

window.__openGuardModal = function (mode, coin, apiSide) {
  const p = _guardFindPos(coin)
  if (!p) { alert('Position not found — refresh and try again.'); return }
  // The modal lives inside .app, which is display:none in the mobile view — reparent
  // it to <body> so it renders on mobile too (idempotent: a no-op after the first open).
  const _ov = document.getElementById('guardModal')
  if (_ov && _ov.parentElement !== document.body) document.body.appendChild(_ov)
  const isLong  = apiSide === 'LONG'
  const entry   = parseFloat(p.entryPx ?? 0)
  const liq     = parseFloat(p.liquidationPx ?? 0)
  const mark    = parseFloat(state.allMids?.[coin] ?? 0) || entry
  const posVal  = parseFloat(p.positionValue ?? (Math.abs(parseFloat(p.szi ?? 0)) * mark))
  const margin  = parseFloat(p.marginUsed ?? 0)
  const curLev  = margin > 0 ? posVal / margin : (parseFloat(p.leverage?.value ?? 1) || 1)
  const setLev  = parseFloat(p.leverage?.value ?? 0) || 0          // the leverage *setting* (e.g. 20x)
  const size    = Math.abs(parseFloat(p.szi ?? 0))
  const maxLev  = parseFloat(p.maxLeverage ?? p.leverage?.value ?? 1) || 1
  const uPnl    = parseFloat(p.unrealizedPnl ?? 0)
  const running = !!serverStatus?._instances?.[`${mode}:${String(coin).toUpperCase()}`]
  const gStatus = running ? serverStatus?._guards?.[`${mode}:${String(coin).toUpperCase()}`] : null
  state.guardCfg = { mode, coin, isLong, entry, liq, mark, posVal, margin, curLev, setLev, size, maxLev, uPnl, running,
                     added: parseFloat(gStatus?.added) || 0, fires: parseInt(gStatus?.fires) || 0 }

  const isLiq = mode === 'liqguard'
  document.getElementById('guardTitle').textContent = isLiq ? '🛡 Liq Guard' : '🛑 Lev Brake'
  document.getElementById('guardDesc').textContent  = isLiq
    ? 'Automatically ADD margin as price approaches liquidation, pushing the liq price further away.'
    : 'Automatically REDUCE position size (reduce-only) as price approaches liquidation.'
  document.getElementById('guardLiqSection').style.display = isLiq ? '' : 'none'
  document.getElementById('guardBrkSection').style.display = isLiq ? 'none' : ''

  // When editing an armed guard, pre-fill from its LIVE config; otherwise use defaults.
  const live = running ? _parseGuardArgs(serverStatus?._guards?.[`${mode}:${String(coin).toUpperCase()}`]?.args) : null

  document.getElementById('guardTrigPct').value   = live?.['trigger-pct'] ?? (isLiq ? 85 : 70)
  document.getElementById('guardMaxFires').value  = live?.['max-fires'] ?? 2
  document.getElementById('guardDryRun').checked  = !!live?.['dry-run']
  if (isLiq) {
    const tMode = live ? (live['target-leverage'] ? 'target' : 'fixed') : 'fixed'
    document.getElementById('guardTargetLev').value = live?.['target-leverage'] ?? Math.max(1, Math.floor(curLev * 0.6))
    document.getElementById('guardMaxAdd').value    = live?.['max-total-add'] ?? ''
    window.__guardSetMode(tMode)
  } else {
    document.getElementById('guardReducePct').value = live?.['reduce-pct'] ?? 25
  }

  const verb = running ? 'Edit' : (isLiq ? '🛡 Liq Guard' : '🛑 Lev Brake')
  document.getElementById('guardTitle').textContent = running ? `${verb} ${isLiq ? 'Liq Guard' : 'Lev Brake'}` : verb
  document.getElementById('guardEntryLiq').textContent = `$${fmtPrice(entry)} / ${liq > 0 ? '$' + fmtPrice(liq) : '—'}`
  document.getElementById('guardMarkVal').textContent  = mark > 0 ? '$' + fmtPrice(mark) : '—'
  document.getElementById('guardStatus').className     = 'trade-status'
  document.getElementById('guardDisarmBtn').style.display = running ? '' : 'none'
  // Logs are only available for a running guard (the bot writes them while armed).
  const _glBtn = document.getElementById('guardLogsBtn')
  if (_glBtn) _glBtn.style.display = running ? '' : 'none'
  _guardArmArmed = false; _guardDisarmArmed = false; clearTimeout(_guardConfirmTimer)
  document.getElementById('guardConfirmBtn').classList.remove('btn-confirming')
  document.getElementById('guardDisarmBtn').classList.remove('btn-confirming')
  document.getElementById('guardConfirmBtn').textContent  = running ? 'Update' : 'Arm'

  window.__guardPreview()
  document.getElementById('guardModal').classList.add('open')
}

window.__guardSetMode = function (mode) {
  if (state.guardCfg) state.guardCfg.addMode = mode
  document.querySelectorAll('#guardAddMode .guard-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === mode))
  document.getElementById('guardTargetRow').style.display = mode === 'target' ? '' : 'none'
  window.__guardPreview()
}

window.__guardPreview = function () {
  const g = state.guardCfg; if (!g) return
  const pct  = (parseFloat(document.getElementById('guardTrigPct').value) || 0) / 100
  const prev = document.getElementById('guardTrigPreview')
  if (g.liq > 0 && pct > 0) {
    const trig = g.isLong ? g.entry - pct * (g.entry - g.liq) : g.entry + pct * (g.liq - g.entry)
    prev.textContent = `Fires at ~$${fmtPrice(trig)} (mark now $${fmtPrice(g.mark)})`
  } else {
    prev.textContent = g.liq > 0 ? '' : 'No liquidation price available for this position.'
  }

  // Dynamic per-field descriptions — interpolate the user's live inputs (no hardcoded values)
  const setD = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt }
  const sym       = String(g.coin).replace(/.*:/, '')
  const trigPctV  = parseFloat(document.getElementById('guardTrigPct').value) || 0
  const maxFiresV = Math.max(1, parseInt(document.getElementById('guardMaxFires').value) || 1)
  const dir       = g.isLong ? 'falls' : 'rises'

  setD('gdescTrig', `Acts when ${sym} ${dir} to ${trigPctV}% of the way from your entry toward the liquidation price${g.mode === 'liqguard' ? ', adding margin to push liq away' : ', trimming size to pull liq away'}.`)
  setD('gdescMaxFires', `Stops after firing ${maxFiresV} time${maxFiresV === 1 ? '' : 's'} in total, then stays armed but idle.`)

  if (g.mode === 'liqguard') {
    const targetMode = g.addMode === 'target'
    const maxAddV    = parseFloat(document.getElementById('guardMaxAdd').value) || 0
    setD('gdescMode', targetMode
      ? 'Scales each top-up to your drawdown — adds only what is needed to restore the target leverage.'
      : 'Splits your max total margin evenly across the fires — same amount added each time.')
    const tlV = parseFloat(document.getElementById('guardTargetLev').value) || 0
    const effLev = (g.margin + g.uPnl) > 0 ? g.posVal / (g.margin + g.uPnl) : g.curLev
    setD('gdescTarget', tlV > 0
      ? `Each fire adds margin until effective leverage drops to ≈${tlV}x (now ${effLev.toFixed(1)}x effective${g.setLev ? `, ${g.setLev}x setting` : ''}). Lower = safer, uses more margin.`
      : '')
    if (maxAddV > 0) {
      setD('gdescMaxAdd', targetMode
        ? `Hard ceiling — never commits more than $${maxAddV} of margin in total across all fires.`
        : `Hard cap. Adds ~$${(maxAddV / maxFiresV).toFixed(2)} per fire (max total ÷ ${maxFiresV} fires).`)
    } else {
      setD('gdescMaxAdd', 'Required — the total margin this guard may ever add, across all fires.')
    }
  } else {
    const rV = parseFloat(document.getElementById('guardReducePct').value) || 0
    setD('gdescReduce', rV > 0
      ? `Each fire market-closes ${rV}% of the current ${sym} position (reduce-only), moving liq to safety.`
      : '')
  }
  window.__guardValidate()
  _guardRenderPlan()
}

// Build a step-by-step projection of how the position evolves across the fires —
// trigger price → action → resulting estimated liquidation price — so the user can
// plan. Liq math mirrors HL's isolated model (linear in margin; size-scaled for brake).
function _guardPlanHtml(g, rows, foot, firesUsed = 0, firedRows = []) {
  const sym = String(g.coin).replace(/.*:/, '')
  // Already-fired fires shown first (greyed, chronological), so the user sees #1/#2 done
  // before "now" and the projected #3/#4. Past trigger prices aren't stored, so we show
  // the action only (no fabricated price) — marked ✓ fired.
  const fired = firedRows.map(fr =>
    `<div class="guard-plan-row" style="opacity:.5"><span class="gp-when">#${fr.n} ✓ fired</span><span class="gp-act">${fr.act}</span><span class="gp-liq">done</span></div>`).join('')
  const nowAct = g.mode === 'liqguard' ? `margin $${fmtUSD(g.margin)}` : `${fmtSize(g.size)} ${sym}`
  const now = `<div class="guard-plan-row guard-plan-now"><span class="gp-when">now</span><span class="gp-act">${nowAct}</span><span class="gp-liq">liq $${fmtPrice(g.liq)}</span></div>`
  // Number the projected fires CONTINUING from those already fired (#3, #4… not #1 again).
  const body = rows.map((r, i) =>
    `<div class="guard-plan-row"><span class="gp-when">#${firesUsed + i + 1} @ $${fmtPrice(r.px)}</span><span class="gp-act">${r.act}</span><span class="gp-liq">liq $${fmtPrice(r.liq)}</span></div>`).join('')
  const title = rows.length === 0 && firesUsed > 0
    ? `Plan — max fires reached`
    : firesUsed > 0 ? `Projected plan — ${rows.length} more fire${rows.length === 1 ? '' : 's'}`
    : `Projected plan — ${rows.length} fire${rows.length === 1 ? '' : 's'}`
  return `<div class="guard-plan-title">${title}</div>${fired}${now}${body}<div class="guard-plan-foot">${foot}</div>`
}

function _guardRenderPlan() {
  const g = state.guardCfg
  const box = document.getElementById('guardPlan')
  if (!g || !box) return
  const pct      = (parseFloat(document.getElementById('guardTrigPct').value) || 0) / 100
  const maxFires = Math.max(1, parseInt(document.getElementById('guardMaxFires').value) || 1)
  const firesUsed = g.fires || 0
  if (!(g.liq > 0) || !(g.size > 0) || !(pct > 0)) { box.style.display = 'none'; box.innerHTML = ''; return }
  const long = g.isLong
  const mf   = g.maxLev > 0 ? 1 / (2 * g.maxLev) : 0
  const sym  = String(g.coin).replace(/.*:/, '')
  // Trigger price for a given current liq (pct of the way from entry to liq)
  const trigFrom = liq => long ? g.entry - pct * (g.entry - liq) : g.entry + pct * (liq - g.entry)
  const rows = []

  if (g.mode === 'liqguard') {
    const targetMode = g.addMode === 'target'
    const maxTotal   = parseFloat(document.getElementById('guardMaxAdd').value) || 0
    const tl         = parseFloat(document.getElementById('guardTargetLev').value) || 0
    if (maxTotal <= 0) { box.style.display = 'none'; box.innerHTML = ''; return }
    const slope = long ? 1 / (g.size * (1 - mf)) : 1 / (g.size * (1 + mf))   // Δliq per $ margin
    // Continue from what an armed guard has ALREADY done: budgetUsed counts toward the
    // cap; only remaining fires are projected; futureAdd is the additional margin from here.
    const remainingFires = Math.max(0, maxFires - firesUsed)
    const avgPast  = firesUsed > 0 ? (g.added || 0) / firesUsed : 0
    const firedRows = Array.from({ length: firesUsed }, (_, i) => ({ n: i + 1, act: `+$${avgPast.toFixed(2)} margin` }))
    let liq = g.liq, margin = g.margin, budgetUsed = g.added || 0, futureAdd = 0
    for (let i = 1; i <= remainingFires; i++) {
      const remaining = maxTotal - budgetUsed
      if (remaining <= 0.01) break
      const px = trigFrom(liq)
      let add
      if (targetMode) {
        const uPnlAtPx = (long ? (px - g.entry) : (g.entry - px)) * g.size
        const equity   = margin + uPnlAtPx
        add = Math.max(0, (g.size * px) / tl - equity)
      } else {
        add = maxTotal / maxFires
      }
      add = Math.min(add, remaining)
      if (add < 0.01) { rows.push({ px, act: 'already ≤ target', liq }); continue }
      const newLiq = long ? liq - add * slope : liq + add * slope
      rows.push({ px, act: `+$${add.toFixed(2)} margin`, liq: Math.max(0, newLiq) })
      liq = newLiq; margin += add; budgetUsed += add; futureAdd += add
    }
    const capReached = remainingFires <= 0 && firesUsed >= maxFires
    const foot = (capReached
        ? `Max Fires reached (${firesUsed}/${maxFires}) — raise Max Fires to add more. `
        : '')
      + `Adds $${futureAdd.toFixed(2)}${firesUsed > 0 ? ' more' : ''} → position margin $${fmtUSD(g.margin)} → $${fmtUSD(g.margin + futureAdd)}`
      + (firesUsed > 0 ? ` · $${fmtUSD(g.added || 0)} already added (${firesUsed}/${maxFires} fired)` : '')
      + `. Estimates — actual fills/fees vary slightly.`
    box.innerHTML = _guardPlanHtml(g, rows, foot, firesUsed, firedRows)
  } else {
    const r = (parseFloat(document.getElementById('guardReducePct').value) || 0) / 100
    if (!(r > 0)) { box.style.display = 'none'; box.innerHTML = ''; return }
    // Implied isolated margin consistent with the reported liq (held on the position as size shrinks)
    const M = long ? g.size * (g.entry - (1 - mf) * g.liq) : g.size * ((1 + mf) * g.liq - g.entry)
    // g.size is the CURRENT (already-reduced) size, so project only the remaining fires.
    const remainingFires = Math.max(0, maxFires - firesUsed)
    const firedRows = Array.from({ length: firesUsed }, (_, i) => ({ n: i + 1, act: 'reduced' }))
    let size = g.size, liq = g.liq
    for (let i = 1; i <= remainingFires; i++) {
      const px  = trigFrom(liq)
      const cut = size * r
      const newSize = size - cut
      if (newSize <= 0) break
      const newLiq = long ? (newSize * g.entry - M) / (newSize * (1 - mf)) : (newSize * g.entry + M) / (newSize * (1 + mf))
      rows.push({ px, act: `−${fmtSize(cut)} → ${fmtSize(newSize)} ${sym}`, liq: Math.max(0, newLiq) })
      size = newSize; liq = newLiq
    }
    const capReached = remainingFires <= 0 && firesUsed >= maxFires
    const foot = (capReached ? `Max Fires reached (${firesUsed}/${maxFires}) — raise Max Fires to add more. ` : firesUsed > 0 ? `${firesUsed}/${maxFires} already fired. ` : '')
      + 'Liq estimate assumes freed margin stays on the position. Estimates — actual fills/fees vary slightly.'
    box.innerHTML = _guardPlanHtml(g, rows, foot, firesUsed, firedRows)
  }
  box.style.display = (rows.length || firesUsed) ? '' : 'none'
}

window.__guardValidate = function () {
  const g = state.guardCfg; if (!g) return
  if (_guardArmArmed || _guardDisarmArmed) _guardResetConfirm()   // editing cancels a pending confirm
  const btn = document.getElementById('guardConfirmBtn')
  let incomplete = false
  if (g.mode === 'liqguard') {
    const maxAddEl = document.getElementById('guardMaxAdd')
    const maxAdd   = parseFloat(maxAddEl.value) || 0
    incomplete = maxAdd <= 0
    // Soft persistent hint on the required field; clear the hard-error cue once typing
    maxAddEl.classList.toggle('guard-required-empty', incomplete)
    if (!incomplete) maxAddEl.classList.remove('guard-input-invalid', 'guard-shake')
  }
  // Keep the button enabled (never silently dead) but show a clear "not ready" look —
  // tapping it then flashes the missing field instead of doing nothing.
  btn.classList.toggle('btn-incomplete', incomplete)
  btn.disabled = false
}

window.__guardArm = async function () {
  const g = state.guardCfg; if (!g) return
  const statusEl = document.getElementById('guardStatus')
  const agentKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null)
              || document.getElementById('m-agentKey')?.value?.trim()
              || document.getElementById('agentKey')?.value?.trim()
  if (!agentKey) { showTradeStatus(statusEl, 'error', 'Enter your Agent Private Key first (Strategies tab).'); return }

  const trigPct   = Math.min(99, Math.max(1, parseFloat(document.getElementById('guardTrigPct').value) || 0))
  const maxFires  = Math.max(1, parseInt(document.getElementById('guardMaxFires').value) || 2)
  const dryRun    = document.getElementById('guardDryRun').checked

  const argv = ['--coin', g.coin, '--mode', g.mode, '--trigger-pct', String(trigPct),
                '--max-fires', String(maxFires)]
  if (g.mode === 'liqguard') {
    const maxAdd = parseFloat(document.getElementById('guardMaxAdd').value) || 0
    if (maxAdd <= 0) {
      const el = document.getElementById('guardMaxAdd')
      el.classList.remove('guard-shake'); void el.offsetWidth   // restart the animation
      el.classList.add('guard-shake', 'guard-input-invalid')
      el.focus()
      showTradeStatus(statusEl, 'error', '⚠ Enter the max total margin first.')
      return
    }
    argv.push('--max-total-add', String(maxAdd))
    if (state.guardCfg.addMode === 'target') {
      const tl = parseFloat(document.getElementById('guardTargetLev').value) || 0
      if (tl <= 0) { showTradeStatus(statusEl, 'error', 'Set a target leverage.'); return }
      argv.push('--target-leverage', String(tl))
    } else {
      // Fixed mode: per-fire amount = max total ÷ max fires (computed in background)
      const perFire = Math.max(0, maxAdd / maxFires)
      if (perFire <= 0) { showTradeStatus(statusEl, 'error', 'Set the max total margin.'); return }
      argv.push('--add-usd', String(perFire))
    }
  } else {
    const r = Math.min(100, Math.max(1, parseFloat(document.getElementById('guardReducePct').value) || 0))
    argv.push('--reduce-pct', String(r))
  }
  if (dryRun) argv.push('--dry-run')
  // Editing a LIVE guard preserves its cumulative cap (totalAdded/fires) across the
  // stop+restart, so already-added margin counts toward the (possibly new) cap instead
  // of resetting to zero. A fresh arm (Disarm → Arm) omits this and starts the cap over.
  if (g.running) argv.push('--resume')

  // Two-tap confirmation (config is valid at this point)
  if (!_guardArmArmed) {
    _guardDisarmArmed = false
    _guardArmArmed = true
    const c = document.getElementById('guardConfirmBtn')
    c.textContent = g.running ? 'Tap to confirm update' : 'Tap to confirm'
    c.classList.add('btn-confirming')
    const what = g.mode === 'liqguard' ? 'Liq Guard' : 'Lev Brake'
    const sym  = String(g.coin).replace(/.*:/, '')
    showTradeStatus(statusEl, 'pending', `${g.running ? 'Update' : 'Arm'} ${what} on ${sym}${dryRun ? ' (dry-run)' : ''}? Tap again to confirm.`)
    clearTimeout(_guardConfirmTimer)
    _guardConfirmTimer = setTimeout(_guardResetConfirm, 5000)
    return
  }
  _guardResetConfirm()

  const inst = String(g.coin)
  showTradeStatus(statusEl, 'pending', g.running ? 'Updating guard…' : 'Arming…')
  document.getElementById('guardConfirmBtn').disabled = true
  try {
    // Re-arm = restart with fresh config: stop any existing instance first.
    if (g.running) { try { await _postStop(g.mode, inst) } catch {} await new Promise(r => setTimeout(r, 600)) }
    const res = await serverFetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: g.mode, agentKey, args: argv, address: state.addr, instance: inst }),
    })
    if (!res.ok) { showTradeStatus(statusEl, 'error', '✗ ' + (res.error || 'Could not start')); document.getElementById('guardConfirmBtn').disabled = false; return }
    showTradeStatus(statusEl, 'success', dryRun ? '✓ Armed (dry-run)' : '✓ Guard armed')
    checkServer()
    setTimeout(() => { closeModals(); if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'positions') _mobVRenderContent() }, 900)
  } catch {
    showTradeStatus(statusEl, 'error', 'Server unreachable. Is hliq-strat running?')
    document.getElementById('guardConfirmBtn').disabled = false
  }
}

window.__guardDisarm = async function () {
  const g = state.guardCfg; if (!g) return
  const statusEl = document.getElementById('guardStatus')
  // Two-tap confirmation
  if (!_guardDisarmArmed) {
    _guardArmArmed = false
    _guardDisarmArmed = true
    const d = document.getElementById('guardDisarmBtn')
    d.textContent = 'Tap to confirm'
    d.classList.add('btn-confirming')
    showTradeStatus(statusEl, 'pending', `Disarm ${g.mode === 'liqguard' ? 'Liq Guard' : 'Lev Brake'} on ${String(g.coin).replace(/.*:/, '')}? Tap again to confirm.`)
    clearTimeout(_guardConfirmTimer)
    _guardConfirmTimer = setTimeout(_guardResetConfirm, 5000)
    return
  }
  _guardResetConfirm()
  showTradeStatus(statusEl, 'pending', 'Disarming…')
  try {
    await _postStop(g.mode, String(g.coin))
    showTradeStatus(statusEl, 'success', '✓ Disarmed')
    checkServer()
    setTimeout(() => { closeModals(); if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'positions') _mobVRenderContent() }, 800)
  } catch { showTradeStatus(statusEl, 'error', 'Server unreachable.') }
}

// ─── EDIT MODAL ───────────────────────────────────────────────────────────────
window.__openEditModal = function (coin, side, szi, entryPx, existingTpPx = 0, existingSlPx = 0, existingTpOid = 0, existingSlOid = 0, leverage = 1) {
  const entry  = parseFloat(entryPx)
  const isLong = side === 'LONG'
  const sz     = Math.abs(parseFloat(szi))
  state.editingPos = {
    coin, side, szi: parseFloat(szi), entryPx: entry, isLong,
    leverage: parseFloat(leverage) || 1,
    tpOid: existingTpOid || 0, slOid: existingSlOid || 0,
    tpMode: 'pct', slMode: 'pct', tpType: 'market', slType: 'market',
    tpSzPct: 100, slSzPct: 100, activeTab: 'entire',
  }

  // Position info
  document.getElementById('tpslPosLabel').textContent = `${sz} ${coinLabel(coin)} ${side.charAt(0) + side.slice(1).toLowerCase()}`
  document.getElementById('tpslEntryPx').textContent  = '$' + fmtPrice(entry)
  const refPx = parseFloat(state.allMids?.[coin] ?? entry)
  document.getElementById('tpslRefPx').textContent = '$' + fmtPrice(refPx)

  // Reset tab to Entire Position
  window.__tpslTab('entire')

  // Reset mode labels
  ;['tpslTpModeLbl','tpslSlModeLbl'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'Price %' })
  ;['tpslTpTypeLbl','tpslSlTypeLbl'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = 'Market' })

  // Initialize size sliders
  ;['Tp','Sl'].forEach(s => {
    const slider  = document.getElementById(`tpsl${s}SzSlider`)
    const display = document.getElementById(`tpsl${s}SzDisplay`)
    if (slider)  { slider.value = 100; slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) 100%, var(--border2) 100%)` }
    if (display) display.textContent = fmtSize(sz) + ' ' + coin
  })

  // Clear all inputs
  ;['tpslTpPct','tpslTpUsd','tpslSlPct','tpslSlUsd'].forEach(id => { const el = document.getElementById(id); if (el) el.value = '' })
  ;['tpslTpPnl','tpslSlPnl'].forEach(id => { const el = document.getElementById(id); if (el) { el.textContent = '—'; el.style.color = '' } })
  ;['tpslTpPctEcho','tpslSlPctEcho'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = '0.00' })

  // Pre-fill from existing TP/SL
  const tpPx = parseFloat(existingTpPx) || 0
  if (tpPx > 0) {
    document.getElementById('tpslTpUsd').value = tpPx.toFixed(5)
    window.__tpslSync('tp', 'usd')
  }
  const slPx = parseFloat(existingSlPx) || 0
  if (slPx > 0) {
    document.getElementById('tpslSlUsd').value = slPx.toFixed(5)
    window.__tpslSync('sl', 'usd')
  }

  document.getElementById('editModalStatus').className = 'trade-status'
  document.getElementById('editModalConfirm').disabled = false
  _modalToBody('editModal').classList.add('open')
}

window.__confirmEditPosition = async function () {
  if (!state.editingPos) return
  if (!isConnected()) { showTradeStatus(document.getElementById('editModalStatus'), 'error', 'Connect agent key first.'); return }

  const { coin, side, szi, tpOid, slOid, tpSzPct, slSzPct, activeTab } = state.editingPos
  const tpPx     = parseFloat(document.getElementById('tpslTpUsd').value) || 0
  const slPx     = parseFloat(document.getElementById('tpslSlUsd').value) || 0
  const statusEl = document.getElementById('editModalStatus')

  if (!tpPx && !slPx) { showTradeStatus(statusEl, 'error', 'Set TP and/or SL price first.'); return }

  const isBuy   = side === 'SHORT'
  const fullSz  = Math.abs(szi)
  const tpSz    = activeTab === 'partial' ? fullSz * (tpSzPct ?? 100) / 100 : fullSz
  const slSz    = activeTab === 'partial' ? fullSz * (slSzPct ?? 100) / 100 : fullSz

  showTradeStatus(statusEl, 'pending', 'Placing trigger orders...')
  document.getElementById('editModalConfirm').disabled = true

  try {
    if (tpOid && tpPx) { try { await cancelOrder({ coin, oid: tpOid }) } catch (_) {} }
    if (slOid && slPx) { try { await cancelOrder({ coin, oid: slOid }) } catch (_) {} }
    if (tpPx && tpSz > 0) { const r = await placeTriggerOrder({ coin, isBuy, sz: tpSz, triggerPx: tpPx, tpsl: 'tp' }); if (!parseOrderResult(r).ok) throw new Error('TP failed') }
    if (slPx && slSz > 0) { const r = await placeTriggerOrder({ coin, isBuy, sz: slSz, triggerPx: slPx, tpsl: 'sl' }); if (!parseOrderResult(r).ok) throw new Error('SL failed') }
    const parts = []
    if (tpPx) parts.push('TP @ $' + fmtPrice(tpPx))
    if (slPx) parts.push('SL @ $' + fmtPrice(slPx))
    showTradeStatus(statusEl, 'success', '✓ ' + parts.join(' · ') + ' placed!')
    setTimeout(() => { closeModals(); refreshLive() }, 1500)
  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    document.getElementById('editModalConfirm').disabled = false
  }
}

// ─── EXPANDABLE ROWS ──────────────────────────────────────────────────────────
window.__toggleRowExpand = function(id) {
  const row = document.getElementById(id)
  if (!row) return
  const open = row.classList.toggle('open')
  // Update chevron by btn id pattern
  const btn = document.getElementById('btn-' + id) || row.previousElementSibling?.querySelector('.row-expand-btn')
  if (btn) btn.classList.toggle('open', open)
}

// ─── CANCEL ORDER ─────────────────────────────────────────────────────────────
function _removeOrderFromUI(oid) {
  const numOid = parseInt(oid)
  _cancelledOids.add(numOid)
  setTimeout(() => _cancelledOids.delete(numOid), 10000)
  state.openOrders = (state.openOrders ?? []).filter(o => o.oid !== numOid)
  _lastOrdHash = null
  renderOrders(state.openOrders, state.perpState, state.ocTokenMap)
  setTimeout(refreshLive, 2000)
}

window.__cancelOrder = async function (coin, oid, _isPositionTpsl, btn) {
  const statusEl = document.getElementById('ordersStatus') ?? document.getElementById('tradeStatus')
  if (!isConnected()) {
    showTradeStatus(statusEl, 'error', 'Connect agent key first.')
    _showChartToast('✗ Connect agent key first')
    if (btn && btn.isConnected) { btn.textContent = '✗ No key'; setTimeout(() => { if (btn.isConnected) btn.textContent = '✕ Cancel' }, 2000) }
    return
  }
  showTradeStatus(statusEl, 'pending', 'Cancelling…')
  if (btn) { btn.textContent = 'Cancelling…'; btn.disabled = true }
  try {
    const result   = await cancelOrder({ coin, oid: parseInt(oid) })
    const statuses = result?.response?.data?.statuses ?? []
    const errors   = statuses.filter(s => s?.error).map(s => s.error)
    const ok       = statuses.some(s => s === 'success' || (s && s.success !== undefined))
    if (ok || !statuses.length) {
      showTradeStatus(statusEl, 'success', '✓ Cancelled.')
      _removeOrderFromUI(oid)
    } else if (errors.length) {
      const errMsg = errors.join(', ')
      showTradeStatus(statusEl, 'error', '✗ ' + errMsg)
      _showChartToast('✗ ' + errMsg)
      if (btn && btn.isConnected) { btn.textContent = '✕ Cancel'; btn.disabled = false }
    }
  } catch (e) {
    console.error('[cancel]', coin, oid, e)
    if (/never placed|already cancel|filled/i.test(e.message)) {
      showTradeStatus(statusEl, 'success', '✓ Already cancelled or filled.')
      _removeOrderFromUI(oid)
    } else {
      const errMsg = e.message || String(e)
      showTradeStatus(statusEl, 'error', '✗ ' + errMsg)
      _showChartToast('✗ ' + errMsg)
      if (btn && btn.isConnected) { btn.textContent = '✕ Cancel'; btn.disabled = false }
    }
  }
}

window.__closeAllPositions = async function (btn) {
  const positions = (state.perpState?.assetPositions ?? []).filter(p => parseFloat(p.position?.szi ?? 0) !== 0)
  if (!positions.length) return
  if (!isConnected()) { _showChartToast('✗ Connect agent key first'); return }
  if (!confirm(`Close all ${positions.length} open position${positions.length > 1 ? 's' : ''} at market price?`)) return
  if (btn) { btn.disabled = true; btn.textContent = 'Closing…' }
  let ok = 0, fail = 0
  for (const ap of positions) {
    const p  = ap.position
    const sz = parseFloat(p.szi)
    const mktPx = parseFloat(state.allMids?.[p.coin] ?? 0) || parseFloat(p.entryPx)
    try {
      await closePosition({ coin: p.coin, isBuy: sz < 0, sz: Math.abs(sz), markPrice: mktPx })
      _optimisticClosePos(p.coin, Math.abs(sz))
      ok++
    } catch (e) {
      console.error('[closeAll]', p.coin, e.message)
      fail++
    }
  }
  const msg = fail === 0 ? `✓ Closed ${ok} position${ok > 1 ? 's' : ''}` : `${ok} closed, ${fail} failed`
  _showChartToast(msg)
  if (btn) { btn.disabled = false; btn.textContent = 'Close All' }
  setTimeout(refreshLive, 1500)
}

window.__cancelAllOrders = async function () {
  const orders = state.openOrders ?? []
  if (!orders.length) return
  const statusEl = document.getElementById('ordersStatus') ?? document.getElementById('tradeStatus')
  if (!isConnected()) {
    showTradeStatus(statusEl, 'error', 'Connect agent key first.')
    _showChartToast('✗ Connect agent key first')
    return
  }
  const n = orders.length
  if (!confirm(`Cancel all ${n} open order${n > 1 ? 's' : ''}?`)) return
  showTradeStatus(statusEl, 'pending', `Cancelling ${n} order${n > 1 ? 's' : ''}…`)
  _showChartToast(`Cancelling ${n} order${n > 1 ? 's' : ''}…`)
  try {
    let statuses = []
    try {
      const result = await cancelOrders(orders.map(o => ({ coin: o.coin, oid: o.oid })))
      statuses = result?.response?.data?.statuses ?? []
    } catch (e) {
      // SDK throws ApiRequestError if any individual cancel fails (e.g. already-filled order).
      // Extract statuses from the error response so partial successes are counted correctly.
      statuses = e?.response?.response?.data?.statuses ?? []
      if (!statuses.length) throw e
    }
    let ok = 0, fail = 0
    orders.forEach((o, i) => {
      const s = statuses[i]
      if (!s || s === 'success' || (s && s.success !== undefined)) { _removeOrderFromUI(o.oid); ok++ }
      else if (s?.error && /never placed|already cancel|filled/i.test(s.error)) { _removeOrderFromUI(o.oid); ok++ }
      else { fail++ }
    })
    if (!statuses.length) { orders.forEach(o => _removeOrderFromUI(o.oid)); ok = n }
    const msg = fail === 0 ? `✓ Cancelled ${ok} order${ok > 1 ? 's' : ''}` : `${ok} cancelled, ${fail} failed`
    showTradeStatus(statusEl, fail === 0 ? 'success' : ok > 0 ? 'success' : 'error', msg + '.')
    _showChartToast(msg)
    setTimeout(refreshLive, 1500)
  } catch (e) {
    console.error('[cancelAll]', e)
    const errMsg = e.message || String(e)
    showTradeStatus(statusEl, 'error', '✗ ' + errMsg)
    _showChartToast('✗ ' + errMsg)
  }
}

// ─── EDIT ORDER ───────────────────────────────────────────────────────────────
window.__openEditOrderModal = function (coin, oid, isBuy, sz, currentPx, tpsl, isTrigger) {
  // TP/SL orders open the position TP/SL modal instead
  if (tpsl) {
    const positions = state.perpState?.assetPositions ?? []
    const posEntry  = positions.map(ap => ap.position ?? ap).find(p => p.coin === coin)
    if (posEntry) {
      const side     = parseFloat(posEntry.szi) > 0 ? 'LONG' : 'SHORT'
      const leverage = posEntry.leverage?.value ?? 1
      let tpPx = 0, slPx = 0, tpOid = 0, slOid = 0
      for (const o of (state.openOrders ?? [])) {
        if (o.coin !== coin) continue
        const type  = o.orderType ?? ''
        const isTp2 = type.startsWith('Take Profit') || o.triggerCondition === 'tp'
        const isSl2 = type.startsWith('Stop')        || o.triggerCondition === 'sl'
        const px    = parseFloat(o.triggerPx ?? 0) > 0 ? parseFloat(o.triggerPx) : parseFloat(o.limitPx ?? 0)
        if (isTp2) { tpPx = px; tpOid = o.oid }
        if (isSl2) { slPx = px; slOid = o.oid }
      }
      window.__openEditModal(coin, side, posEntry.szi, posEntry.entryPx, tpPx, slPx, tpOid, slOid, leverage)
      return
    }
  }

  // For regular limit orders: maxSz = full position size
  let posSz = 0
  const maxSz   = (tpsl && posSz > 0) ? posSz : (sz > 0 ? sz : 0)
  const initPct = (sz > 0 && maxSz > 0) ? Math.min(100, Math.round(sz / maxSz * 100)) : 100
  const px      = parseFloat(currentPx) || 0
  state.editingOrder = { coin, oid, isBuy, sz, maxSz, tpsl, isTrigger, currentPx: px, szUnit: 'token' }

  // Header
  const typeLabel = tpsl === 'tp' ? 'Take Profit' : tpsl === 'sl' ? 'Stop Loss' : 'Limit'
  document.getElementById('editOrderModalTitle').textContent = `Edit ${typeLabel} Order`

  // Info box
  const direction = isBuy ? 'Buy/Long' : 'Sell/Short'
  document.getElementById('eordAction').textContent  = `${direction} ${coin}-PERP`
  document.getElementById('eordSizeInfo').textContent = fmtSize(sz) + ' ' + coin
  document.getElementById('eordType').textContent    = typeLabel
  const refPx = parseFloat(state.allMids?.[coin] ?? currentPx)
  document.getElementById('eordRefPx').textContent   = '$' + fmtPrice(refPx)

  // Available balance
  const { avail } = _tradeAvail()
  document.getElementById('eordAvailable').textContent = '$' + fmtUSD(avail)

  // Price input
  document.getElementById('editOrderPriceInput').value = px > 0 ? px : ''

  // Slider
  const slider = document.getElementById('editOrdSlider')
  slider.value = initPct
  _updateEditOrdSlider()

  document.getElementById('editOrderModalStatus').className = 'trade-status'
  document.getElementById('editOrderModalConfirm').disabled = false
  _modalToBody('editOrderModal').classList.add('open')
}

window.__confirmEditOrder = async function () {
  if (!state.editingOrder) return
  if (!isConnected()) { showTradeStatus(document.getElementById('editOrderModalStatus'), 'error', 'Connect agent key first.'); return }
  const { coin, oid, isBuy, sz: origSz, maxSz, tpsl, isTrigger } = state.editingOrder
  const newPx  = parseFloat(document.getElementById('editOrderPriceInput').value)
  const pct    = parseInt(document.getElementById('editOrdSlider').value)
  const newSz  = maxSz > 0 ? maxSz * pct / 100 : origSz
  const statusEl = document.getElementById('editOrderModalStatus')
  if (!newPx || newPx <= 0) { showTradeStatus(statusEl, 'error', 'Enter a valid price.'); return }
  showTradeStatus(statusEl, 'pending', 'Modifying order...')
  document.getElementById('editOrderModalConfirm').disabled = true
  try {
    const result = await modifyOrderPrice({ coin, oid, isBuy, sz: newSz, newPx, tpsl, isTrigger })
    // batchModify (triggers) returns OrderResponse with statuses; modify (limits) throws on failure.
    if (result && isTrigger && tpsl) {
      const parsed = parseOrderResult(result)
      if (!parsed.ok) {
        showTradeStatus(statusEl, 'error', '✗ ' + parsed.errors.join(', '))
        document.getElementById('editOrderModalConfirm').disabled = false
        return
      }
    }
    showTradeStatus(statusEl, 'success', '✓ Order updated!')
    setTimeout(() => { closeModals(); refreshLive() }, 1500)
  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    document.getElementById('editOrderModalConfirm').disabled = false
  }
}

// ─── MODALS ───────────────────────────────────────────────────────────────────
// Modals are authored inside .app, which is display:none in the mobile view — a
// display:none ancestor hides fixed descendants too. Reparent to <body> on open so
// they render on mobile (idempotent: a no-op once already moved).
function _modalToBody(id) {
  const ov = document.getElementById(id)
  if (ov && ov.parentElement !== document.body) document.body.appendChild(ov)
  return ov
}

function closeModals() {
  ;['closeModal','editModal','editOrderModal','marginModal','guardModal','ocBotModal'].forEach(id => {
    document.getElementById(id)?.classList.remove('open')
  })
  state.closingPos   = null
  state.editingPos   = null
  state.editingOrder = null
  state.marginPos    = null
  state.guardCfg     = null
  state.ocBotCfg     = null
}

// Add a close ✕ to the top-right of every standard modal (one-time, on load).
function _injectModalCloseButtons() {
  for (const id of ['closeModal','editModal','editOrderModal','marginModal','guardModal','ocBotModal']) {
    const m = document.getElementById(id)?.querySelector('.modal')
    if (!m || m.querySelector('.modal-close-x')) continue
    const b = document.createElement('button')
    b.type = 'button'; b.className = 'modal-close-x'; b.setAttribute('aria-label', 'Close'); b.innerHTML = '&times;'
    b.addEventListener('click', e => { e.stopPropagation(); closeModals() })
    m.insertBefore(b, m.firstChild)
  }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _injectModalCloseButtons)
else _injectModalCloseButtons()

// ─── PERFORMANCE TAB ──────────────────────────────────────────────────────────
// ── Bot performance attribution (shared by desktop + mobile) ──────────────────
// The bots only log [WIN] lines, so real PnL/fees/funding come from the user's HL
// fills + funding history, attributed to a bot by the coins it runs on. Coin sources:
// currently-running instances (serverStatus._instances → "type:COIN") + win-log coins.
const PERF_TYPES  = ['insolvent', 'dca', 'grid', 'trend', 'longer', 'shorter']
const PERF_LABELS = { insolvent: 'Insolvent', dca: 'DCA Bot', grid: 'Grid Bot', trend: 'Trend Follower', longer: 'Longer Bot', shorter: 'Shorter Bot' }

function _computeBotPerformance(wins) {
  const fills   = state.fills ?? []
  const funding = state.funding ?? []

  const botCoins = {}
  for (const t of PERF_TYPES) botCoins[t] = new Set()
  for (const k of Object.keys(serverStatus?._instances ?? {})) {
    const idx = k.indexOf(':')
    if (idx < 0) continue
    const t = k.slice(0, idx), coin = k.slice(idx + 1)
    if (botCoins[t] && coin) botCoins[t].add(coin.split(':').pop().toUpperCase())
  }
  for (const t of PERF_TYPES) {
    for (const w of (wins?.[t] ?? [])) {
      // win msgs look like "BTC long closed TP | profit ~$12.3 ..." or "ETH,SOL ..."
      const m = /^([A-Za-z0-9:,]{2,})/.exec((w.msg ?? '').trim())
      if (!m) continue
      for (const c of m[1].split(',')) {
        const coin = c.split(':').pop().toUpperCase()
        if (coin) botCoins[t].add(coin)
      }
    }
  }

  const ONE_HOUR = 3600000
  const statsForCoins = coinSet => {
    const fl       = coinSet ? fills.filter(f => coinSet.has((f.coin ?? '').toUpperCase())) : fills
    const fu       = coinSet ? funding.filter(f => coinSet.has((f.coin ?? '').toUpperCase())) : funding
    const realized = fl.reduce((s, f) => s + (f.closedPnl ?? 0), 0)
    const fees     = fl.reduce((s, f) => s + (f.fee ?? 0), 0)
    const vol      = fl.reduce((s, f) => s + (f.notional ?? 0), 0)
    const fund     = fu.reduce((s, f) => s + (f.usdc ?? 0), 0)
    const windows  = {}
    for (const f of fl.filter(f => (f.closedPnl ?? 0) !== 0)) {
      const key = `${f.coin}_${Math.floor(f.time / ONE_HOUR)}`
      windows[key] = (windows[key] ?? 0) + (f.closedPnl ?? 0) - (f.fee ?? 0)
    }
    const ws      = Object.values(windows)
    const winRate = ws.length ? (ws.filter(n => n > 0).length / ws.length * 100) : null
    const lastTs  = fl.length ? Math.max(...fl.map(f => f.time)) : 0
    return { trades: fl.length, realized, fees, fund, vol, net: realized - fees + fund, winRate, wins: 0, lastTs }
  }

  const botStats = PERF_TYPES.map(t => {
    const s = statsForCoins(botCoins[t])
    s.type  = t
    s.label = PERF_LABELS[t]
    s.coins = [...botCoins[t]]
    s.wins  = (wins?.[t] ?? []).length
    return s
  }).filter(s => s.coins.length > 0 || s.wins > 0)

  const allBotCoins = new Set()
  for (const t of PERF_TYPES) for (const c of botCoins[t]) allBotCoins.add(c)
  const totals = statsForCoins(allBotCoins)
  const best   = botStats.reduce((b, s) => s.net > (b?.net ?? -Infinity) ? s : b, null)

  return { botStats, totals, best, allBotCoins }
}

async function renderPerformance() {
  const el = document.getElementById('perfContent')
  if (!el) return

  if (!serverOnline) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--muted)">
      <div style="font-size:14px;font-weight:600">Server offline — start the strategy server to see bot performance.</div>
    </div>`
    return
  }

  let wins
  try { wins = await serverFetch(`/api/wins?address=${encodeURIComponent(state.addr ?? '')}`) }
  catch {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--muted)">Failed to load performance data.</div>`
    return
  }

  const fills   = state.fills ?? []
  const funding = state.funding ?? []
  const { botStats, totals, best, allBotCoins } = _computeBotPerformance(wins)

  if (botStats.length === 0) {
    destroyPerfCharts()
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--muted)">
      <div style="font-size:32px;margin-bottom:12px">📈</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:6px">No bot activity yet</div>
      <div style="font-size:11px">Run a strategy bot — its trades, PnL, fees and funding appear here.</div>
    </div>`
    return
  }

  // Build the per-coin event buckets that drive the interactive charts.
  const { coinNet, marketCoins } = _perfBuildData(allBotCoins)

  const money   = v => (v >= 0 ? '$' : '-$') + fmtUSD(Math.abs(v))
  const colOf   = v => v >= 0 ? 'var(--green)' : 'var(--red)'
  const clsOf   = v => v >= 0 ? 'pos' : 'neg'
  const tsDate  = ts => ts ? new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'
  const idSafe  = c => c.replace(/[^A-Za-z0-9]/g, '_')

  destroyPerfCharts()   // clear any instances from a prior render (coins may have changed)
  el.innerHTML = `
    <div class="perf-summary-grid">
      <div class="stat-card">
        <div class="stat-label">Net Bot P&amp;L</div>
        <div class="stat-value ${clsOf(totals.net)}">${money(totals.net)}</div>
        <div class="stat-sub">realized − fees + funding</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Realized PnL</div>
        <div class="stat-value ${clsOf(totals.realized)}">${money(totals.realized)}</div>
        <div class="stat-sub">${totals.trades} fills · $${fmtCompact(totals.vol)} vol</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Fees Paid</div>
        <div class="stat-value neg">-$${fmtUSD(totals.fees)}</div>
        <div class="stat-sub">Net funding ${money(totals.fund)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Best Bot</div>
        <div class="stat-value neu">${esc(best?.label ?? '—')}</div>
        <div class="stat-sub">${best ? money(best.net) + ' net' : ''}</div>
      </div>
    </div>

    <div class="perf-table-wrap">
      <div class="section-title" style="margin-bottom:8px">Per-Bot Breakdown</div>
      <div style="font-size:10px;color:var(--muted);margin-bottom:14px">Trades are attributed to a bot by the coins it runs on — a coin traded by multiple bots (or manually) may overlap.</div>
      <div style="overflow-x:auto">
      <table style="width:100%;min-width:760px">
        <thead><tr>
          <th style="text-align:left">Bot</th>
          <th style="text-align:left">Coins</th>
          <th style="text-align:right">Trades</th>
          <th style="text-align:right">Realized</th>
          <th style="text-align:right">Fees</th>
          <th style="text-align:right">Funding</th>
          <th style="text-align:right">Net</th>
          <th style="text-align:right">Volume</th>
          <th style="text-align:right">Win Rate</th>
          <th style="text-align:right">Wins</th>
          <th style="text-align:right">Last Trade</th>
        </tr></thead>
        <tbody>
          ${botStats.map(s => `<tr>
            <td><b>${esc(s.label)}</b></td>
            <td style="color:var(--muted);font-size:10px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(s.coins.join(', '))}">${esc(s.coins.join(', ') || '—')}</td>
            <td style="text-align:right">${s.trades}</td>
            <td style="text-align:right;color:${colOf(s.realized)}">${money(s.realized)}</td>
            <td style="text-align:right;color:var(--red)">-$${fmtUSD(s.fees)}</td>
            <td style="text-align:right;color:${colOf(s.fund)}">${money(s.fund)}</td>
            <td style="text-align:right;font-weight:700;color:${colOf(s.net)}">${money(s.net)}</td>
            <td style="text-align:right;color:var(--muted)">$${fmtCompact(s.vol)}</td>
            <td style="text-align:right">${s.winRate == null ? '—' : s.winRate.toFixed(0) + '%'}</td>
            <td style="text-align:right;color:var(--muted)">${s.wins}</td>
            <td style="text-align:right;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px">${tsDate(s.lastTs)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      </div>
    </div>

    <div class="perf-chart-wrap">
      <div class="perf-chart-head">
        <div class="section-title" style="margin:0">Cumulative P&amp;L — All Bots</div>
        <div class="perf-controls">
          <div class="perf-tabs" id="perfTypeTabs">
            <button data-perf-type="accum"    onclick="window.__perfSetType('accum')">Accum.</button>
            <button data-perf-type="realized" onclick="window.__perfSetType('realized')">Realized</button>
          </div>
          <div class="perf-tabs" id="perfPeriodTabs">
            ${['1D','1W','1M','All'].map(p => `<button data-perf-period="${p}" onclick="window.__perfSetPeriod('${p}')">${p}</button>`).join('')}
          </div>
        </div>
      </div>
      <div id="perfCombHero" class="portfolio-pnl-hero"></div>
      <div class="chart-wrap" style="height:220px"><canvas id="perfCombChart" style="cursor:crosshair"></canvas></div>
    </div>

    <div class="section-title" style="margin:24px 0 14px">Per-Market P&amp;L <span style="font-size:11px;color:var(--muted);font-weight:400">— sorted by net ▾</span></div>
    <div class="perf-market-grid">
      ${marketCoins.map(c => `
        <div class="perf-market-card">
          <div class="perf-market-head">
            <div class="perf-market-name">${esc(c)}</div>
            <div class="perf-market-net ${clsOf(coinNet[c])}">${money(coinNet[c])}</div>
          </div>
          <div id="perfHero-${idSafe(c)}" class="portfolio-pnl-hero" style="min-height:28px;padding:2px 0 4px"></div>
          <div class="chart-wrap" style="height:130px"><canvas id="perfChart-${idSafe(c)}" style="cursor:crosshair"></canvas></div>
        </div>`).join('')}
    </div>`

  _perfRenderCharts()
}

// Cumulative series for a coin set, honoring the active type + period.
function _perfSeries(coins) {
  if (!_perfData) return []
  const ms     = { '1D': 864e5, '1W': 7 * 864e5, '1M': 30 * 864e5 }
  const cutoff = _perfPeriod === 'All' ? 0 : Date.now() - (ms[_perfPeriod] ?? 864e5)
  const ev = []
  for (const c of coins) {
    for (const f of (_perfData.fillsByCoin[c] ?? [])) {
      if (f.time < cutoff) continue
      const v = _perfType === 'realized' ? (f.closedPnl ?? 0) : (f.closedPnl ?? 0) - (f.fee ?? 0)
      if (v !== 0) ev.push({ t: f.time, v })
    }
    if (_perfType !== 'realized') {
      for (const f of (_perfData.fundByCoin[c] ?? [])) {
        if (f.time < cutoff) continue
        if ((f.usdc ?? 0) !== 0) ev.push({ t: f.time, v: f.usdc })
      }
    }
  }
  ev.sort((a, b) => a.t - b.t)
  let run = 0
  return ev.map(e => ({ x: e.t, y: parseFloat((run += e.v).toFixed(4)) }))
}

// Bucket attributed fills/funding per coin + rank markets by net. Shared by the
// desktop (#perfContent) and mobile (mobVContent) performance views.
function _perfBuildData(allBotCoins) {
  const fills = state.fills ?? [], funding = state.funding ?? []
  const fillsByCoin = {}, fundByCoin = {}
  for (const f of fills) {
    const c = (f.coin ?? '').toUpperCase()
    if (!allBotCoins.has(c)) continue
    ;(fillsByCoin[c] ||= []).push(f)
  }
  for (const f of funding) {
    const c = (f.coin ?? '').toUpperCase()
    if (!allBotCoins.has(c)) continue
    ;(fundByCoin[c] ||= []).push(f)
  }
  const coinNet = {}
  for (const c of allBotCoins) {
    const fl = fillsByCoin[c] ?? [], fu = fundByCoin[c] ?? []
    coinNet[c] = fl.reduce((s, f) => s + (f.closedPnl ?? 0) - (f.fee ?? 0), 0)
               + fu.reduce((s, f) => s + (f.usdc ?? 0), 0)
  }
  const marketCoins = [...allBotCoins].filter(c => (fillsByCoin[c] ?? []).length).sort((a, b) => coinNet[b] - coinNet[a])
  _perfData = { coins: [...allBotCoins], marketCoins, fillsByCoin, fundByCoin }
  return { coinNet, marketCoins }
}

// Render the combined + per-market charts for one view. `prefix` namespaces the
// element ids ('perf' = desktop, 'mperf' = mobile) so both can coexist in the DOM.
function _perfRenderCharts(prefix = 'perf') {
  if (!_perfData) return
  document.querySelectorAll(`#${prefix}TypeTabs button`).forEach(b => b.classList.toggle('active', b.dataset.perfType === _perfType))
  document.querySelectorAll(`#${prefix}PeriodTabs button`).forEach(b => b.classList.toggle('active', b.dataset.perfPeriod === _perfPeriod))
  const idSafe = c => c.replace(/[^A-Za-z0-9]/g, '_')
  renderPerfChart(`${prefix}CombChart`, _perfSeries(_perfData.coins), `${prefix}CombHero`)
  for (const c of _perfData.marketCoins) {
    renderPerfChart(`${prefix}Chart-${idSafe(c)}`, _perfSeries([c]), `${prefix}Hero-${idSafe(c)}`)
  }
}

// Re-render whichever performance view(s) are currently mounted.
function _perfRenderAll() { _perfRenderCharts('perf'); _perfRenderCharts('mperf') }

window.__perfSetType   = t => { _perfType = t;   _perfRenderAll() }
window.__perfSetPeriod = p => { _perfPeriod = p; _perfRenderAll() }

// ─── TRADE MANAGE COLLAPSE ───────────────────────────────────────────────────
window.__toggleManageSection = function(id, btn) {
  const body = document.getElementById(id)
  if (!body) return
  const open = body.classList.toggle('open')
  btn.classList.toggle('open', open)
}

// Trade-tab manage section: Positions / Orders shown one at a time (like Overview).
let _manageTab = 'positions'
window.__manageSetTab = function(tab) {
  _manageTab = tab
  document.getElementById('mtab-positions')?.classList.toggle('active', tab === 'positions')
  document.getElementById('mtab-orders')?.classList.toggle('active', tab === 'orders')
  const pw = document.getElementById('man-pos-wrap'); if (pw) pw.style.display = tab === 'positions' ? '' : 'none'
  const ow = document.getElementById('man-ord-wrap'); if (ow) ow.style.display = tab === 'orders' ? '' : 'none'
  const act = document.getElementById('manageAction')
  if (act) act.textContent = tab === 'positions' ? 'Close All' : 'Cancel All'
}
window.__manageAction = function() {
  if (_manageTab === 'positions') window.__closeAllPositions?.(document.getElementById('manageAction'))
  else window.__cancelAllOrders?.()
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function _stopTabTimers() {
  if (_lbTabTimer)     { clearInterval(_lbTabTimer); _lbTabTimer = null }
  if (_maTabTimer)     { clearInterval(_maTabTimer); _maTabTimer = null }
  if (_mobTradeObTimer){ clearInterval(_mobTradeObTimer); _mobTradeObTimer = null }
}

function switchTab(name, btn) {
  if (_activeTab === 'outcomes' && name !== 'outcomes') _stopOcCountdown()
  _stopTabTimers()
  _activeTab = name
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
  const activeNavTab = btn ?? document.querySelector(`.nav-tab[onclick*="'${name}'"]`)
  if (activeNavTab) activeNavTab.classList.add('active')
  document.getElementById('tab-' + name).classList.add('active')
  _ensureTabRendered(name)   // trades / calendar / transfers render on first open
  if (name === 'portfolio') setTimeout(() => renderChartPeriod(state.currentPeriod), 60)
  if (name === 'tokens')    renderMarkets({ fills: state.fills, allMids: state.allMids, perpState: state.perpState })
  if (name === 'trade')     { try { renderManageTables(state.perpState, state.openOrders, state.allMids); populateCoinDropdown(); updateTradeBalance(); _updateAvailDisplay() } catch (e) { console.error(e) } }
  if (name === 'performance') renderPerformance()
  if (name === 'settings') { _syncSettingsTab(); _applyDevMode() }
  if (name === 'leaderboard') {
    const root = document.getElementById('leaderboardRoot')
    const stale = Date.now() - _lbLastFetch > 30_000
    if (!root?.querySelector('.lb-table tbody')) renderLeaderboard()
    else if (stale) _lbSilentUpdate()
    _lbTabTimer = setInterval(_lbSilentUpdate, 30_000)
  }
  if (name === 'accounts') {
    const root = document.getElementById('multiAcctRoot')
    const stale = Date.now() - _maLastFetch > 30_000
    if (!root?.querySelector('#maGrid')) renderMultiAccount().catch(() => {})
    else if (stale) _maSilentUpdate().catch(() => {})
    _maTabTimer = setInterval(() => _maSilentUpdate().catch(() => {}), 30_000)
  }
  if (name === 'outcomes')   renderOutcomes()
  // sync bottom nav
  document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name))
  // sync sidebar
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.toggle('active', i.dataset.tab === name))
  // close more drawer + backdrop
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
  // re-translate newly rendered content
  if (_currentLang !== 'en') setTimeout(() => _translateDOM(_currentLang), 150)
}

window.setSidebarActive = function(el) {
  document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'))
  el.classList.add('active')
}

window.__mobMore = function() {
  const drawer   = document.getElementById('mobMoreDrawer')
  const backdrop = document.getElementById('mobMoreBackdrop')
  const open     = drawer?.classList.toggle('open')
  backdrop?.classList.toggle('open', open)
}
window.__mobMoreTab = function(name) {
  const drawer = document.getElementById('mobMoreDrawer')
  const backdrop = document.getElementById('mobMoreBackdrop')
  drawer?.classList.remove('open')
  backdrop?.classList.remove('open')
  const mobileTabs = new Set(['settings', 'transfers', 'trades', 'leaderboard', 'accounts', 'portfolio', 'calendar', 'tokens', 'watch', 'strategies', 'performance', 'trade', 'news'])
  if (mobileTabs.has(name)) {
    _mobVActiveTab = name
    document.querySelectorAll('.mob-v-tab').forEach(b => b.classList.remove('active'))
    _mobVRenderContent()
  } else {
    mobVHide()
    const btn = [...document.querySelectorAll('.nav-tab')].find(b => b.getAttribute('onclick')?.includes(`'${name}'`))
    window.switchTab(name, btn)
  }
}

function filterTable(tableId, inputId) {
  const q = document.getElementById(inputId).value.toLowerCase().trim()
  document.querySelectorAll('#' + tableId + ' tbody tr').forEach(row => {
    row.style.display = row.textContent.toLowerCase().includes(q) ? '' : 'none'
  })
}

window.__showMarketDetail = function (coin, price) {
  const wrap  = document.getElementById('marketDetailWrap')
  const title = document.getElementById('marketDetailTitle')
  if (wrap)  wrap.style.display = ''
  if (title) title.textContent  = coin + ' — Token Detail'
  renderTokenDetail(coin, price, state.perpState, state.fills)
}

window.__searchMarketCard = function (query) {
  const results = document.getElementById('pokemonSearchResults')
  if (!results) return
  const q = query.trim().toLowerCase()
  if (!q) { results.innerHTML = ''; return }
  const matches = Object.entries(state.allMids)
    .filter(([k]) => k.toLowerCase().startsWith(q))
    .slice(0, 6)
  if (!matches.length) { results.innerHTML = '<div class="pokemon-search-no-results">No results</div>'; return }
  results.innerHTML = matches.map(([coin, px]) =>
    `<div class="pokemon-search-result-item" onclick="window.__selectMarketCard('${coin}', ${parseFloat(px)})">${coin} <span>$${fmtPrice(parseFloat(px))}</span></div>`
  ).join('')
}

window.__selectMarketCard = function (coin, price) {
  const input   = document.getElementById('pokemonSearchInput')
  const results = document.getElementById('pokemonSearchResults')
  if (input)   input.value = ''
  if (results) results.innerHTML = ''

  const coinFills = state.fills.filter(f => f.coin === coin)
  const stats     = computeCoinStats(coin, coinFills, price)
  const card      = document.getElementById('pokemonSearchCard')
  if (card) card.outerHTML = renderCoinCard(stats, price, true)

  window.__showMarketDetail(coin, price)
}

// ─── RESET ────────────────────────────────────────────────────────────────────
function resetDashboard() {
  if (liveTimer)    { clearInterval(liveTimer);    liveTimer    = null }
  if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null }
  document.getElementById('dashboard').classList.remove('active')
  document.getElementById('inputArea').style.display = ''
  document.getElementById('loadBtn').disabled        = false
  document.getElementById('walletInput').value       = ''
  localStorage.removeItem('walletAddr')
  renderSavedWallets()
  document.getElementById('errorBox').classList.remove('active')

  STEP_LABELS.forEach((label, i) => {
    const el = document.getElementById('step' + (i + 1))
    if (el) { el.className = 'load-step'; el.textContent = '→ ' + label }
  })

  document.querySelectorAll('.nav-tab').forEach((t, i)  => t.classList.toggle('active', i === 0))
  document.querySelectorAll('.tab-panel').forEach((p, i) => p.classList.toggle('active', i === 0))

  destroyCharts()
  disconnect()

  document.getElementById('apiStatusDot').classList.remove('connected')
  document.getElementById('apiConnectStatus').textContent  = ''
  document.getElementById('tradeBalance').textContent      = '—'
  document.getElementById('tradeWithdrawable').textContent = '—'
  updateCoinHeader(null)
  document.getElementById('sizeInput').value       = ''
  document.getElementById('tpInput').value         = ''
  document.getElementById('slInput').value         = ''
  document.getElementById('limitPriceInput').value = ''
  document.getElementById('stopPriceInput').value  = ''
  document.getElementById('levSlider').value       = '5'
  document.getElementById('levDisplay').textContent = '5x'
  document.getElementById('tradeStatus').className  = 'trade-status'

  const btn = document.getElementById('tradeSubmitBtn')
  btn.disabled = true; btn.textContent = 'Connect agent key to trade'; btn.className = 'btn-trade-long'

  state = INITIAL_STATE()
  _lastPosHash = null; _lastOrdHash = null; _lastAcctHash = null
}

// ─── DOWNLOADS ────────────────────────────────────────────────────────────────
function downloadJSON() {
  downloadBlob(JSON.stringify({
    wallet: state.addr, exportedAt: new Date().toISOString(),
    perpState: state.perpState, spotState: state.spotState,
    openOrders: state.openOrders, fills: state.fills, funding: state.funding, portfolio: state.portfolio,
  }, null, 2), 'hliq_' + state.addr.slice(0, 8) + '.json', 'application/json')
}

function downloadCSV() {
  const lines = ['type,coin,side,size,price,notional,closed_pnl,fee,fee_token,dir,time']
  for (const p of (state.perpState?.assetPositions ?? [])) {
    const pos = p.position; const side = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT'
    lines.push(`position,${pos.coin},${side},${pos.szi},${pos.entryPx},${pos.positionValue},${pos.unrealizedPnl},,,, `)
  }
  for (const f of state.fills) {
    lines.push(`fill,${f.coin},${f.side},${f.sz},${f.px},${f.notional},${f.closedPnl},${f.fee},${f.feeToken},${f.dir},${f.timeStr}`)
  }
  downloadBlob(lines.join('\n'), 'hliq_' + state.addr.slice(0, 8) + '.csv', 'text/csv')
}

function downloadTableCSV(tableId, name) {
  const table = document.getElementById(tableId); if (!table) return
  const csv = [...table.querySelectorAll('tr')]
    .map(r => [...r.querySelectorAll('th,td')].map(c => '"' + c.textContent.trim().replace(/"/g, '""') + '"').join(','))
    .join('\n')
  downloadBlob(csv, name + '_' + state.addr.slice(0, 8) + '.csv', 'text/csv')
}

function downloadBlob(content, filename, type) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([content], { type }))
  a.download = filename; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 5000)
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function showError(msg) {
  const el = document.getElementById('errorBox'); el.textContent = msg; el.classList.add('active')
}

function showTradeStatus(el, type, msg) {
  if (!el) return
  el.className = 'trade-status ' + type
  el.textContent = msg
}

// ─── ENTER KEY ────────────────────────────────────────────────────────────────
document.getElementById('walletInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') loadDashboard()
})

// ─── CARD VALIDATION ──────────────────────────────────────────────────────────
const CARD_RULES = {
  grid: [
    { ids: ['grid-lower', 'grid-upper'], test: vs => parseFloat(vs[0]) < parseFloat(vs[1]), hint: 'Lower must be < Upper', targets: ['fg-grid-lower', 'fg-grid-upper'] },
    { ids: ['grid-levels'],  test: vs => parseInt(vs[0]) >= 2,  hint: 'Min 2 levels', targets: ['grid-levels'] },
    { ids: ['grid-size'],    test: vs => { const el = document.getElementById('grid-size'); return el?.dataset?.mode === 'token' || parseFloat(vs[0]) >= 10 }, hint: 'Min $10/level (HL minimum)', targets: ['grid-size'] },
  ],
  dca:  [
    { ids: ['dca-size'],     test: vs => parseFloat(vs[0]) > 0, hint: 'Size must be > 0', targets: ['dca-size'] },
  ],
  trend: [
    { ids: ['trend-size'],   test: vs => parseFloat(vs[0]) > 0, hint: 'Size must be > 0', targets: ['trend-size'] },
  ],
  longer: [
    { ids: ['longer-size'], test: vs => parseFloat(vs[0]) > 0, hint: 'Size must be > 0', targets: ['longer-size'] },
  ],
  shorter: [
    { ids: ['shorter-size'], test: vs => parseFloat(vs[0]) > 0, hint: 'Size must be > 0', targets: ['shorter-size'] },
  ],
}

window.validateCard = function(type) {
  const card  = document.getElementById('strat-' + type)
  const rules = CARD_RULES[type] ?? []
  if (!card || !rules.length) return

  let anyError = false

  for (const rule of rules) {
    const vals  = rule.ids.map(id => document.getElementById(id)?.value?.trim() ?? '')
    const hasVal = vals.every(v => v !== '')
    const ok    = !hasVal || rule.test(vals)

    for (const tgt of (rule.targets ?? [])) {
      // tgt can be a field-group id (fg-*) or an input id — find the closest field-group
      const el = document.getElementById(tgt)
      if (!el) continue
      const fg = el.closest('.field-group') ?? el
      fg.classList.toggle('field-error', !ok)
      // Show/remove hint
      let hint = fg.querySelector('.field-error-hint')
      if (!ok) {
        if (!hint) { hint = document.createElement('div'); hint.className = 'field-error-hint'; fg.appendChild(hint) }
        hint.textContent = rule.hint
      } else {
        hint?.remove()
      }
    }
    if (!ok) anyError = true
  }

  card.classList.toggle('card-error', anyError)
}

// ─── STRATEGIES ───────────────────────────────────────────────────────────────
function generateCommand(type) {
  const get = id => document.getElementById(id)?.value?.trim() ?? ''

  // Asset lists — normalise to comma-separated no-spaces
  const longAssets  = (document.getElementById('longAssets')?.value  ?? '').split(',').map(s => s.trim()).filter(Boolean).join(',')
  const shortAssets = (document.getElementById('shortAssets')?.value ?? '').split(',').map(s => s.trim()).filter(Boolean).join(',')
  const assetFlags  = [
    longAssets  ? `--long-assets ${longAssets}`   : '',
    shortAssets ? `--short-assets ${shortAssets}` : '',
  ].filter(Boolean).join(' ')

  let cmd = ''

  if (type === 'insolvent') {
    const capital   = get('mgr-capital')   || '30'
    const shortzone = get('mgr-shortzone') || '0.5'
    const longzone  = get('mgr-longzone')  || '0.5'
    const interval  = get('mgr-interval')  || '1'
    cmd = `node strategies/manager.js --wallet $WALLET_KEY --max-capital-pct ${capital} --short-zone-pct ${shortzone} --long-zone-pct ${longzone} --interval ${interval}${longAssets ? ' --long-assets ' + longAssets : ''}${shortAssets ? ' --short-assets ' + shortAssets : ''}`
  } else if (type === 'dca') {
    const coin     = get('dca-coin') || 'BTC'
    const side     = get('dca-side') || 'long'
    const size     = getSizeUsd('dca-size', 'dca-coin') || '100'
    const mode     = get('dca-mode') || 'time'
    const interval = get('dca-interval') || (mode === 'drop' ? '5' : '60')
    const droppct  = get('dca-droppct') || '2'
    const max      = get('dca-maxorders') || '10'
    const maxpos   = get('dca-maxpos') || '0'
    const lev      = get('dca-leverage') || '1'
    cmd = `node strategies/dca.js --coin ${coin} --side ${side} --size ${size} --mode ${mode} --interval ${interval}${mode === 'drop' ? ' --drop-pct ' + droppct : ''} --max-orders ${max} --max-position ${maxpos} --leverage ${lev} --wallet $WALLET_KEY${assetFlags ? ' ' + assetFlags : ''}`
  } else if (type === 'grid') {
    const coin    = _resolveGridCoin(get('grid-coin') || state.selectedCoin || 'BTC')
    const lower   = _gridRangeToPrice(get('grid-lower'), coin)   // '' = auto-range
    const upper   = _gridRangeToPrice(get('grid-upper'), coin)
    const levVal  = parseFloat(get('grid-levels') || '10')
    const size    = getSizeUsd('grid-size', 'grid-coin')         // '' = auto-size
    const lev     = get('grid-leverage') || '10'
    const totMrg  = get('grid-totmargin')   // per-position margin cap — cross or isolated
    const levArg  = _gridSpacing !== 'usd'
      ? `--pct-interval ${levVal}`
      : `--levels ${levVal}`
    cmd = `node strategies/grid.js --coin ${coin}${_gridSide === 'short' ? ' --side short' : ''}${_gridMargin === 'isolated' ? ' --margin isolated' : ''}${totMrg ? ` --total-margin ${totMrg}` : ''}${lower ? ` --lower ${lower}` : ''}${upper ? ` --upper ${upper}` : ''} ${levArg}${size ? ` --size ${size}` : ''} --leverage ${lev} --wallet $WALLET_KEY --address ${state.addr}${assetFlags ? ' ' + assetFlags : ''}`
  } else if (type === 'trend') {
    const coin     = get('trend-coin') || 'BTC'
    const fast     = get('trend-fast') || '9'
    const slow     = get('trend-slow') || '21'
    const tf       = get('trend-tf') || '1h'
    const size     = getSizeUsd('trend-size', 'trend-coin') || '500'
    const lev      = get('trend-leverage') || '3'
    const interval = get('trend-interval') || '5'
    const sl       = get('trend-stoploss') || '0'
    cmd = `node strategies/trend.js --coin ${coin} --fast-ema ${fast} --slow-ema ${slow} --candle-tf ${tf} --size ${size} --leverage ${lev} --interval ${interval} --stop-loss-pct ${sl} --wallet $WALLET_KEY${assetFlags ? ' ' + assetFlags : ''}`
  } else if (type === 'longer') {
    const coins      = get('longer-coins') || 'BTC'
    const size       = getSizeUsd('longer-size', 'longer-coins') || '100'
    const lev        = get('longer-leverage') || '2'
    const trigger    = get('longer-trigger') || 'always'
    const dumppct    = get('longer-dumppct')    || '7'
    const dumpwindow = get('longer-dumpwindow') || '1d'
    const tp         = get('longer-tp') || '3'
    const sl         = get('longer-sl') || '2'
    const interval   = get('longer-interval') || '5'
    cmd = `node strategies/longer.js --coins ${coins} --size ${size} --leverage ${lev} --trigger ${trigger}${trigger === 'dump' ? ` --dump-pct ${dumppct} --dump-window ${dumpwindow}` : ''} --take-profit-pct ${tp} --stop-loss-pct ${sl} --interval ${interval} --wallet $WALLET_KEY`
  } else if (type === 'shorter') {
    const coins    = get('shorter-coins') || 'BTC'
    const size     = getSizeUsd('shorter-size', 'shorter-coins') || '100'
    const lev      = get('shorter-leverage') || '2'
    const trigger  = get('shorter-trigger') || 'always'
    const pumppct    = get('shorter-pumppct')    || '7'
    const pumpwindow = get('shorter-pumpwindow') || '1d'
    const tp         = get('shorter-tp') || '3'
    const sl         = get('shorter-sl') || '2'
    const interval   = get('shorter-interval') || '5'
    cmd = `node strategies/shorter.js --coins ${coins} --size ${size} --leverage ${lev} --trigger ${trigger}${trigger === 'pump' ? ` --pump-pct ${pumppct} --pump-window ${pumpwindow}` : ''} --take-profit-pct ${tp} --stop-loss-pct ${sl} --interval ${interval} --wallet $WALLET_KEY`
  } else if (type === 'custom') {
    const script = get('custom-script') || 'strategies/my-bot.js'
    const coin   = get('custom-coin')
    const lev    = get('custom-leverage')
    const extra  = get('custom-args')
    cmd = `node ${script}${coin ? ' --coin ' + coin : ''}${lev ? ' --leverage ' + lev : ''}${extra ? ' ' + extra : ''} --wallet $WALLET_KEY`
  }

  const outputEl = document.getElementById('cmd-' + type)
  if (!outputEl) return

  outputEl.innerHTML = `
    <div class="strategy-cmd-label">Terminal command:</div>
    <div class="strategy-cmd-code" id="cmdcode-${type}">${esc(cmd)}</div>
    <button class="btn-copy-cmd" onclick="copyCmd('${type}')">Copy</button>`
}

function copyCmd(type) {
  const el = document.getElementById('cmdcode-' + type)
  if (!el) return
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = el.nextElementSibling
    if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy' }, 1500) }
  })
}


// ═══════════════════════════════════════════════════════════════════════════════
// MOBILE VIEW — Uniswap-style
// ═══════════════════════════════════════════════════════════════════════════════

let _mobVActiveTab     = 'positions'
let _mobVPickerType    = 'all'  // 'all' | 'crypto' | 'tradfi'
let _mobVPosSortBy     = localStorage.getItem('mobPosSortBy')  || 'unrl'
let _mobVPosSortDir    = parseInt(localStorage.getItem('mobPosSortDir') ?? '-1', 10) || -1
let _mobVOrdSortBy     = 'coin'   // 'coin' | 'px' | 'sz'
let _mobVOrdSortDir    = 1
let _mobVOrdSelMode    = false        // multi-select mode for bulk-cancelling orders
let _mobVOrdSel        = new Set()    // selected order oids while in select mode

// ─── PRIVACY MODE ─────────────────────────────────────────────────────────────
let _privacyMode = localStorage.getItem('hliq_privacy') === '1'
function _prv(s)  { return _privacyMode ? '•••' : s }
function _prvPx(s){ return _privacyMode ? '<span style="filter:blur(4px);user-select:none">' + s + '</span>' : s }

// Reflect privacy state on both surfaces: desktop = CSS blur via body.priv (no
// re-render needed); mobile = dot-masking via _prv re-render. Shared state + key.
function _applyPrivacyUI() {
  document.body.classList.toggle('priv', _privacyMode)
  const db = document.getElementById('deskPrivBtn')
  if (db) { db.classList.toggle('on', _privacyMode); db.innerHTML = _privacyMode ? _privEyeClosedSvg : _privEyeSvg; db.title = _privacyMode ? 'Show balances' : 'Hide balances' }
  const mb = document.getElementById('mobVPrivacyBtn')
  if (mb) { mb.style.color = _privacyMode ? 'var(--accent)' : ''; mb.innerHTML = _privacyMode ? _privEyeClosedSvg : _privEyeSvg }
}
window.__togglePrivacy = function() {
  _privacyMode = !_privacyMode
  localStorage.setItem('hliq_privacy', _privacyMode ? '1' : '0')
  navigator.vibrate?.(_privacyMode ? [40, 60, 40] : 80)
  _applyPrivacyUI()
  if (_isMobView()) { _mobVRenderBalance(); _mobVRenderContent() }
}
window._mobVTogglePrivacy = window.__togglePrivacy

const _privEyeSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
const _privEyeClosedSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`

window._mobVSortPos = function(by) {
  if (_mobVPosSortBy === by) _mobVPosSortDir *= -1
  else { _mobVPosSortBy = by; _mobVPosSortDir = -1 }
  localStorage.setItem('mobPosSortBy', _mobVPosSortBy)
  localStorage.setItem('mobPosSortDir', String(_mobVPosSortDir))
  _mobVRenderContent()
}
window._mobVSortOrd = function(by) {
  if (_mobVOrdSortBy === by) _mobVOrdSortDir *= -1
  else { _mobVOrdSortBy = by; _mobVOrdSortDir = 1 }
  _mobVRenderContent()
}

let _mobVLbResults     = []   // cached leaderboard result objects
let _mobVLbSortBy      = 'value'  // 'value' | 'net' — Rankings sort key
let _mobVMaResults     = []   // cached multi-account result objects
let _mobVMaLastFetch   = 0
let _mobVExpandedIds   = new Set()
let _mobVPortPeriod    = 'allTime'
let _mobVPortChartType = 'value'  // 'value' | 'pnl' | 'realized'
let _mobVLastPosHash   = ''
let _mobVPortChartData = null     // { hist, pts, vals, W, H, isUp, color, dpr }
let _mobVMaPeriod      = 'allTime'
let _mobVMaChartType   = 'value'  // 'value' | 'pnl' | 'realized'
let _mobVMaChartData   = null
let _mobVMaCalMonth    = new Date().getMonth()
let _mobVMaCalYear     = new Date().getFullYear()
let _mobVTradeMarginPct = 50  // 0-100 slider
let _mobVTradeTp        = ''
let _mobVTradeSl        = ''
let _mobVTradesPage     = 0   // History tab pagination (20 per page)

// ─── MOBILE MARKETS / TRADE VIEW STATE ───────────────────────────────────────
let _mobTradeView       = 'list'    // 'list' | 'detail'
let _mobTradeDetailTab  = 'chart'   // 'chart' | 'trade' | 'orderbook' | 'history'
let _mobTradeSort       = 'oi'      // 'volume' | 'change' | 'price' | 'name' | 'oi'
let _mobTradeMainFilter = 'all'     // 'all' | 'perps' | 'spot' | 'crypto' | 'tradfi' | 'stocks' | 'indices' | 'commodities' | 'fx' | 'metals' | 'energy' | 'preipo' | 'hip3' | 'trending' | 'favorites'
let _mobTradeSearchQ    = ''
let _mobTradeObTimer    = null
let _mobTradeAmtUnit    = 'usd'     // 'usd' (margin in USDC) | 'coin' (size in tokens)
let _mobChartTf         = '1h'
let _mobChartType       = 'line'    // 'line' | 'candle'

function _isMobView() {
  if (localStorage.getItem('hliq_force_mobile') === '1') return true
  if (window.innerWidth > 768) return false
  if (window.matchMedia('(orientation: landscape)').matches) return false
  return true
}

function mobVShow() {
  const el = document.getElementById('mobileView')
  if (!el) return
  el.style.display = 'flex'
  el.classList.add('mob-view-active')
  document.body.classList.add('is-mob-view')
  const app = document.querySelector('.app')
  if (app) app.style.display = 'none'
  _mobVInitSwipe()
}

// Horizontal swipe to move between the bottom-nav pages (like changing pages from the
// sides). Page order matches the nav L→R, excluding the More drawer:  More ← History ←
// Home → Trade. Swiping right from History opens the (left) More drawer; swiping left
// while it's open closes it. Ignores swipes that start on scrollers/charts/inputs/tabs.
let _mobVSwipeInit = false
function _mobVInitSwipe() {
  if (_mobVSwipeInit) return
  const view = document.getElementById('mobileView')
  if (!view) return
  _mobVSwipeInit = true
  let sx = 0, sy = 0, st = 0, tracking = false
  const curPage = () => _mobVActiveTab === 'trades' ? 0 : _mobVActiveTab === 'trade' ? 2 : 1
  const go = i => {
    if (i < 0)        window.mobVOpenMore()       // past History (left edge) → More drawer
    else if (i === 0) window.mobVGoTab('trades')
    else if (i === 1) window.mobVHome()
    else              window.mobVGoTab('trade')
  }
  const blocked = t => !!(t && t.closest && t.closest('canvas, input, textarea, select, .mob-v-tabs, .mob-more-drawer, .no-swipe'))
  view.addEventListener('touchstart', e => {
    if (e.touches.length !== 1 || blocked(e.target)) { tracking = false; return }
    sx = e.touches[0].clientX; sy = e.touches[0].clientY; st = Date.now(); tracking = true
  }, { passive: true })
  view.addEventListener('touchend', e => {
    if (!tracking) return
    tracking = false
    const t = e.changedTouches[0]
    const dx = t.clientX - sx, dy = t.clientY - sy
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.8 || Date.now() - st > 600) return
    const drawerOpen = document.getElementById('mobMoreDrawer')?.classList.contains('open')
    if (drawerOpen) { if (dx < 0) window.mobVOpenMore(); return }   // swipe left closes the left drawer
    if (_mobVActiveTab === 'settings') { window.mobVHome(); return } // swipe anywhere closes Settings
    const cur = curPage()
    go(dx < 0 ? Math.min(2, cur + 1) : cur - 1)                     // left = next page, right = prev
  }, { passive: true })

  // The More drawer lives outside #mobileView, so it needs its own swipe-to-close
  // (anchored left → swipe left pushes it back out). Attach to BOTH the drawer and the
  // backdrop so a swipe anywhere over the open menu works, not just on the 280px panel.
  const attachMoreSwipe = elId => {
    const node = document.getElementById(elId)
    if (!node || node._moreSwipe) return
    node._moreSwipe = true
    let x0 = 0, y0 = 0, tr = false
    node.addEventListener('touchstart', e => {
      if (e.touches.length !== 1) { tr = false; return }
      x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; tr = true
    }, { passive: true })
    node.addEventListener('touchend', e => {
      if (!tr) return
      tr = false
      const t = e.changedTouches[0]
      const ddx = t.clientX - x0, ddy = t.clientY - y0
      if (ddx < -45 && Math.abs(ddx) > Math.abs(ddy)) _mobSwipeCloseMore()   // swipe left → close
    }, { passive: true })
  }
  attachMoreSwipe('mobMoreDrawer')
  attachMoreSwipe('mobMoreBackdrop')
}

// Explicit close (avoids the open/close toggle getting out of sync) + swallow the
// synthetic click the browser fires after the swipe, so it can't hit a button behind.
function _mobCloseMore() {
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
}
function _mobSwipeCloseMore() {
  _mobCloseMore()
  const swallow = e => { e.stopPropagation(); e.preventDefault() }
  document.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => document.removeEventListener('click', swallow, true), 450)
}

// Smooth slide-in for the content area on a page change — gives the native "pager" feel.
// Direction comes from the tab's position in the nav order so a forward move enters from
// the right, a back move from the left.
let _mobVLastTab = null
const _MOBV_NAV_ORDER = ['trades', 'positions', 'orders', 'outcomes', 'spot', 'strategies', 'watch', 'trade', 'settings', 'leaderboard', 'transfers', 'accounts', 'portfolio', 'calendar', 'tokens', 'news', 'performance']
function _mobVSlideIn(dir) {
  const c = document.getElementById('mobVContent')
  if (!c) return
  c.style.transition = 'none'
  c.style.transform  = `translateX(${dir >= 0 ? 26 : -26}px)`
  c.style.opacity    = '0.3'
  requestAnimationFrame(() => {
    c.style.transition = 'transform .26s cubic-bezier(.22,.61,.36,1), opacity .24s ease'
    c.style.transform  = 'translateX(0)'
    c.style.opacity    = '1'
  })
}
function _mobVAnimateTo(tab) {
  const ni = _MOBV_NAV_ORDER.indexOf(tab)
  const oi = _MOBV_NAV_ORDER.indexOf(_mobVLastTab)
  _mobVLastTab = tab
  if (ni === oi) return
  _mobVSlideIn(ni >= 0 && oi >= 0 ? (ni > oi ? 1 : -1) : 1)
}

function mobVHide() {
  const el = document.getElementById('mobileView')
  if (!el) return
  el.style.display = ''
  el.classList.remove('mob-view-active')
  document.body.classList.remove('is-mob-view')
  const app = document.querySelector('.app')
  if (app) app.style.display = ''
}

function renderMobileView() {
  if (!_isMobView()) return
  mobVShow()
  _mobVRenderHeader()
  _mobVRenderBalance()
  _mobVRenderContent()
  // Sync privacy button initial state
  const privBtn = document.getElementById('mobVPrivacyBtn')
  if (privBtn) {
    privBtn.style.color = _privacyMode ? 'var(--accent)' : ''
    privBtn.innerHTML   = _privacyMode ? _privEyeClosedSvg : _privEyeSvg
  }
  // Event delegation — survives innerHTML re-renders, fixes iOS DOM-swap click loss
  const content = document.getElementById('mobVContent')
  if (content && !content._del) {
    content._del = true
    content.addEventListener('click', e => {
      const btn = e.target.closest('[data-action]')
      if (btn && !btn.disabled) window._mobVBtn(btn, e)
    })
  }
}

function updateMobileView(fullData = false) {
  if (!_isMobView()) return
  _mobVRenderBalance()
  if (fullData || ['orders', 'spot', 'outcomes', 'watch'].includes(_mobVActiveTab)) {
    _mobVRenderContent()
  } else if (_mobVActiveTab === 'positions') {
    const hash = _mobVPosStructHash()
    if (hash !== _mobVLastPosHash) { _mobVLastPosHash = hash; _mobVRenderContent() }
    else _mobVUpdatePositionsLive()
  } else if (_mobVActiveTab === 'portfolio') {
    _mobVUpdatePortfolioLive()
  }
}

// Whether the unified portfolio snapshot has loaded — until it does, the perp-only
// fallback (perp equity + spot) can over/under-count and would spike the displayed
// account value on an account switch. Gate value displays on this.
function _acctValueReady() {
  return (state.portfolio ?? []).some(p => p[0] === 'allTime' && p[1]?.accountValueHistory?.length)
}

// Update only the live-changing values in the portfolio tab without rebuilding
function _mobVUpdatePortfolioLive() {
  if (!state.perpState || !_acctValueReady()) return
  const stats = computeAcctStats(state.perpState, state.spotState, state.fills, state.portfolio)
  const { accountValue, unrealizedPnl, healthStr, healthCls } = stats
  const pnlCls = v => v >= 0 ? 'pos' : 'neg'
  const pnlFmt = v => (v >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(v))
  const rows = document.querySelectorAll('#mobVContent .mob-v-setting-row')
  for (const row of rows) {
    const label = row.querySelector('span:first-child')?.textContent?.trim()
    const val   = row.querySelector('span:last-child')
    if (!label || !val) continue
    if (label === 'Account Value') {
      val.textContent = _prv('$' + fmtUSD(accountValue))
    } else if (label === 'Unrealized PnL') {
      val.textContent = _prv(pnlFmt(unrealizedPnl))
      val.className   = pnlCls(unrealizedPnl)
    } else if (label === 'Health') {
      val.textContent = healthStr
      val.className   = healthCls
    }
  }
  _mobVDrawPortChart()
}

function _mobVPosStructHash() {
  return (state.perpState?.assetPositions ?? [])
    .filter(ap => parseFloat(ap.position.szi ?? 0) !== 0)
    .map(ap => `${ap.position.coin}:${ap.position.szi}`).join('|')
}

function _mobVUpdatePositionsLive() {
  const pos = (state.perpState?.assetPositions ?? []).filter(ap => parseFloat(ap.position.szi ?? 0) !== 0)
  pos.forEach(ap => {
    const p      = ap.position
    const uPnl   = parseFloat(p.unrealizedPnl ?? 0)
    const roe    = parseFloat(p.returnOnEquity ?? 0) * 100
    const markPx = parseFloat(state.allMids?.[p.coin] ?? 0)
    const pnlCls = uPnl >= 0 ? 'pos' : 'neg'
    const markEl = document.getElementById(`pos-mark-${p.coin}`)
    const upnlEl = document.getElementById(`pos-upnl-${p.coin}`)
    const roeEl  = document.getElementById(`pos-roe-${p.coin}`)
    if (markEl) markEl.textContent = markPx > 0 ? '$' + fmtPrice(markPx) : '—'
    // Respect privacy mode — the live tick must not un-mask what the full render hid.
    if (upnlEl) { upnlEl.textContent = _prv((uPnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(uPnl))); upnlEl.className = 'mob-v-row-val ' + pnlCls }
    if (roeEl)  { roeEl.textContent  = _prv((roe  >= 0 ? '+' : '-') + Math.abs(roe).toFixed(2) + '%'); roeEl.className  = 'mob-v-row-pct ' + pnlCls }
  })
}

function _mobVCoinIcon(coin) {
  return `<div class="mob-v-row-icon" style="padding:0;overflow:hidden;background:var(--panel-2)">${_coinIconHtml(coin)}</div>`
}

function _mobVDetailGrid(items) {
  return `<div style="display:grid;grid-template-columns:1fr 1fr;gap:6px 16px;padding:10px 16px 14px;background:var(--panel-2);border-bottom:1px solid rgba(255,255,255,0.04)">
    ${items.map(([label, val, color]) => `<div>
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;margin-bottom:2px">${label}</div>
      <div style="font-size:13px;font-weight:600${color ? ';color:' + color : ''}">${val}</div>
    </div>`).join('')}
  </div>`
}

window._mobVToggleRow = function(id) {
  const detail = document.getElementById('mrd-' + id)
  if (!detail) return
  const open = detail.style.display !== 'none'
  if (open) _mobVExpandedIds.delete(id); else _mobVExpandedIds.add(id)
  detail.style.display = open ? 'none' : ''
  const chev = document.getElementById('mrc-' + id)
  if (chev) chev.style.transform = open ? '' : 'rotate(90deg)'
}

window._mobVEditPosTpSl = function(coin) {
  try {
    const ap = (state.perpState?.assetPositions ?? []).find(ap => ap.position.coin === coin && parseFloat(ap.position.szi ?? 0) !== 0)
    if (!ap) return
    const p       = ap.position
    const sz      = parseFloat(p.szi ?? 0)
    const apiSide = sz > 0 ? 'LONG' : 'SHORT'
    const levVal  = p.leverage?.value ?? 1
    let tpPx = 0, slPx = 0, tpOid = 0, slOid = 0
    for (const o of (state.openOrders ?? [])) {
      if (o.coin !== p.coin || !o.isTrigger) continue
      const isTp = o.orderType?.startsWith('Take Profit') || o.triggerCondition === 'tp'
      const isSl = o.orderType?.startsWith('Stop') || o.triggerCondition === 'sl'
      const opx  = parseFloat(o.triggerPx ?? 0)
      if (isTp && opx > 0) { tpPx = opx; tpOid = o.oid }
      if (isSl && opx > 0) { slPx = opx; slOid = o.oid }
    }
    const overlay = document.getElementById('editModal')
    // Move to end of body so iOS Safari paints it above the mobile view
    if (overlay && overlay.parentNode !== document.body || overlay?.nextSibling) {
      document.body.appendChild(overlay)
    }
    window.__openEditModal(p.coin, apiSide, p.szi, p.entryPx, tpPx, slPx, tpOid, slOid, levVal)
    if (overlay) {
      overlay.style.zIndex     = '99999'
      overlay.style.alignItems = 'flex-start'
      overlay.style.overflowY  = 'auto'
      overlay.style.padding    = '16px 12px 32px'
      overlay.scrollTop        = 0
    }
  } catch(e) {
    console.error('_mobVEditPosTpSl error:', e)
  }
}


window._mobVBtn = function(el, event) {
  if (event?.stopPropagation) event.stopPropagation()
  const d = el.dataset
  if (d.action === 'edit-ord') {
    try {
      const tpsl   = d.tpsl || false
      const isTrig = d.trigger === 'true'
      const isBuy  = d.side === 'B'
      window.__openEditOrderModal(d.coin, parseInt(d.oid), isBuy, parseFloat(d.sz), parseFloat(d.px), tpsl, isTrig)
    } catch(e) {
      el.textContent = '✗ ' + e.message
      setTimeout(() => { if (el.isConnected) el.textContent = 'Edit' }, 3000)
    }
    return
  }
}

window._mobVClosePos = function(btn, coin, side, szi, mark) {
  // The close modal IS the confirmation — it lets the user pick how much to
  // close (slider/presets) before submitting, so open it directly.
  const overlay = document.getElementById('closeModal')
  if (overlay) document.body.appendChild(overlay)   // ensure it sits above the mobile sheet
  window.__openCloseModal(coin, side, szi, mark)
}

window._mobVAdjustMargin = function(coin) {
  const ap = (state.perpState?.assetPositions ?? []).find(ap => ap.position.coin === coin && parseFloat(ap.position.szi ?? 0) !== 0)
  if (!ap) return
  const p    = ap.position
  const side = parseFloat(p.szi) > 0 ? 'LONG' : 'SHORT'
  const overlay = document.getElementById('marginModal')
  if (overlay) document.body.appendChild(overlay)   // sit above the mobile sheet
  window.__openAdjustMarginModal(coin, side, parseFloat(p.marginUsed ?? 0), parseFloat(p.positionValue ?? 0), p.leverage?.value ?? 1)
}

window._mobVCancelOrd = async function(btn, coin, oid) {
  if (!isConnected()) {
    btn.textContent = '⚠ Connect key'
    setTimeout(() => { if (btn.isConnected) btn.textContent = 'Cancel' }, 2000)
    return
  }
  btn.textContent = 'Cancelling…'
  btn.disabled = true
  try {
    const result   = await cancelOrder({ coin, oid: parseInt(oid) })
    const statuses = result?.response?.data?.statuses ?? []
    const errors   = statuses.filter(s => s?.error).map(s => s.error)
    const ok       = statuses.some(s => s === 'success' || (s && s.success !== undefined))
    if (ok || (!errors.length && !statuses.length)) {
      _removeOrderFromUI(oid)
    } else if (errors.length) {
      if (btn.isConnected) { btn.textContent = 'Cancel'; btn.disabled = false }
      _showChartToast('✗ ' + errors.join(', '))
    }
  } catch (e) {
    if (/never placed|already cancel|filled/i.test(e.message)) {
      _removeOrderFromUI(oid)
    } else {
      if (btn.isConnected) { btn.textContent = 'Cancel'; btn.disabled = false }
      _showChartToast('✗ ' + e.message)
    }
  }
}

window._mobVCancelAll = async function() {
  const orders = state.openOrders ?? []
  if (!orders.length) return
  if (!isConnected()) { _showChartToast('✗ Connect agent key first'); return }
  const n = orders.length
  if (!confirm(`Cancel all ${n} open order${n > 1 ? 's' : ''}?`)) return
  _showChartToast(`Cancelling ${n} order${n > 1 ? 's' : ''}…`)
  try {
    let statuses = []
    try {
      const result = await cancelOrders(orders.map(o => ({ coin: o.coin, oid: o.oid })))
      statuses = result?.response?.data?.statuses ?? []
    } catch (e) {
      statuses = e?.response?.response?.data?.statuses ?? []
      if (!statuses.length) throw e
    }
    let ok = 0, fail = 0
    orders.forEach((o, i) => {
      const s = statuses[i]
      if (!s || s === 'success' || (s && s.success !== undefined)) { _removeOrderFromUI(o.oid); ok++ }
      else if (s?.error && /never placed|already cancel|filled/i.test(s.error)) { _removeOrderFromUI(o.oid); ok++ }
      else { fail++ }
    })
    if (!statuses.length) { orders.forEach(o => _removeOrderFromUI(o.oid)); ok = n }
    _showChartToast(fail === 0 ? `✓ Cancelled ${ok} order${ok > 1 ? 's' : ''}` : `${ok} cancelled, ${fail} failed`)
    if (ok > 0) setTimeout(refreshLive, 1000)
  } catch (e) {
    console.error('[mobCancelAll]', e)
    _showChartToast('✗ ' + (e.message || String(e)))
  }
}

// Fetch live marks for held outcomes and update their Mark/PnL/ROE in place.
async function _mobUpdateOcMarks(holdings) {
  for (const b of holdings) {
    const n = parseInt(String(b.coin).replace(/[^\d]/g, '')) || 0
    if (!n) continue
    try {
      const book = await infoClient.l2Book({ coin: '#' + n })
      const bid  = parseFloat(book.levels?.[0]?.[0]?.px ?? 0)
      const ask  = parseFloat(book.levels?.[1]?.[0]?.px ?? 0)
      const mark = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask)
      if (!(mark > 0)) continue
      _ocMarkCache[b.coin] = mark
      const total = parseFloat(b.total || 0), cost = parseFloat(b.entryNtl || 0)
      const entry = total > 0 ? cost / total : 0
      const pnl = (mark - entry) * total, roe = cost > 0 ? pnl / cost * 100 : 0
      const cls = pnl >= 0 ? 'pos' : 'neg', key = String(n)
      const mk = document.getElementById('ocmark-' + key); if (mk) mk.textContent = (mark * 100).toFixed(2) + '¢'
      const pe = document.getElementById('ocpnl-' + key);  if (pe) { pe.textContent = (pnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(pnl)); pe.className = 'mob-v-row-val ' + cls }
      const re = document.getElementById('ocroe-' + key);  if (re) { re.textContent = (roe >= 0 ? '+' : '') + roe.toFixed(1) + '%'; re.className = 'mob-v-row-pct ' + cls }
    } catch {}
  }
}

// Close an outcome (prediction) holding by selling its shares — limit or market.
window._mobOcClose = async function(coin, mode, id, btn) {
  const stEl = document.getElementById('ocst-' + id)
  const setSt = (c, t) => { if (stEl) { stEl.style.color = c; stEl.textContent = t } }
  if (!isConnected()) { setSt('var(--red)', '✗ Connect agent key first'); return }
  const sz = parseFloat(document.getElementById('ocsz-' + id)?.value || 0)
  if (!(sz > 0)) { setSt('var(--red)', 'Enter shares'); return }
  btn.disabled = true
  setSt('var(--muted)', mode === 'market' ? 'Market closing…' : 'Placing limit…')
  try {
    let result
    if (mode === 'limit') {
      const cents = parseFloat(document.getElementById('ocpx-' + id)?.value || 0)
      if (!(cents > 0)) { setSt('var(--red)', 'Enter a limit price (¢)'); btn.disabled = false; return }
      result = await placeLimitOrder({ coin, isBuy: false, sz, limitPx: cents / 100, leverage: 1, isIsolated: false })
    } else {
      // Market: sell IOC through the live best bid so it actually fills
      const book = await infoClient.l2Book({ coin }).catch(() => null)
      const bid  = parseFloat(book?.levels?.[0]?.[0]?.px ?? 0)
      const ref  = bid > 0 ? bid : (parseFloat(document.getElementById('ocpx-' + id)?.value || 0) / 100)
      if (!(ref > 0)) { setSt('var(--red)', 'No price available'); btn.disabled = false; return }
      result = await placeMarketOrder({ coin, isBuy: false, sz, markPrice: ref, leverage: 1, isIsolated: false })
    }
    const statuses = result?.response?.data?.statuses ?? []
    const err = statuses.find(s => s?.error)?.error
    if (err) setSt('var(--red)', '✗ ' + err)
    else {
      const filled = statuses.some(s => s?.filled)
      setSt('var(--green)', mode === 'market' ? (filled ? '✓ Closed' : '✓ Submitted') : '✓ Limit placed')
      setTimeout(refreshLive, 1200)
    }
  } catch (e) {
    setSt('var(--red)', '✗ ' + (e.message || String(e)))
  } finally { btn.disabled = false }
}

// ── Bulk-cancel selection mode ──────────────────────────────────────────────
window._mobVOrdToggleSelMode = function() {
  _mobVOrdSelMode = !_mobVOrdSelMode
  _mobVOrdSel.clear()
  _mobVRenderContent()
}

window._mobVToggleOrdSel = function(oid) {
  if (_mobVOrdSel.has(oid)) _mobVOrdSel.delete(oid)
  else _mobVOrdSel.add(oid)
  _mobVRenderContent()
}

window._mobVOrdSelectAll = function() {
  const orders = state.openOrders ?? []
  // Toggle: if all already selected, clear; otherwise select all
  if (_mobVOrdSel.size === orders.length) _mobVOrdSel.clear()
  else orders.forEach(o => _mobVOrdSel.add(o.oid))
  _mobVRenderContent()
}

window._mobVCancelSelected = async function() {
  const oids   = new Set(_mobVOrdSel)
  const orders = (state.openOrders ?? []).filter(o => oids.has(o.oid))
  if (!orders.length) { _showChartToast('No orders selected'); return }
  if (!isConnected()) { _showChartToast('✗ Connect agent key first'); return }
  const n = orders.length
  if (!confirm(`Cancel ${n} selected order${n > 1 ? 's' : ''}?`)) return
  _showChartToast(`Cancelling ${n} order${n > 1 ? 's' : ''}…`)
  try {
    let statuses = []
    try {
      const result = await cancelOrders(orders.map(o => ({ coin: o.coin, oid: o.oid })))
      statuses = result?.response?.data?.statuses ?? []
    } catch (e) {
      statuses = e?.response?.response?.data?.statuses ?? []
      if (!statuses.length) throw e
    }
    let ok = 0, fail = 0
    orders.forEach((o, i) => {
      const s = statuses[i]
      if (!s || s === 'success' || (s && s.success !== undefined)) { _removeOrderFromUI(o.oid); ok++ }
      else if (s?.error && /never placed|already cancel|filled/i.test(s.error)) { _removeOrderFromUI(o.oid); ok++ }
      else { fail++ }
    })
    if (!statuses.length) { orders.forEach(o => _removeOrderFromUI(o.oid)); ok = n }
    _showChartToast(fail === 0 ? `✓ Cancelled ${ok} order${ok > 1 ? 's' : ''}` : `${ok} cancelled, ${fail} failed`)
    _mobVOrdSelMode = false
    _mobVOrdSel.clear()
    _mobVRenderContent()
    if (ok > 0) setTimeout(refreshLive, 1000)
  } catch (e) {
    console.error('[mobCancelSelected]', e)
    _showChartToast('✗ ' + (e.message || String(e)))
  }
}

window._mobVEditOrd = function(coin, oid, side, sz, px, tpsl, isTrigger) {
  try {
    const isBuy = side === 'B'
    if (tpsl) {
      // TP/SL order — open position edit modal with iOS fix
      const overlay = document.getElementById('editModal')
      if (overlay) document.body.appendChild(overlay)
      const o = (state.openOrders ?? []).find(o => o.oid === oid)
      window.__openEditOrderModal(coin, oid, isBuy, sz, px, tpsl, isTrigger)
      const ov = document.getElementById('editModal')
      if (ov) {
        ov.style.zIndex     = '99999'
        ov.style.alignItems = 'flex-start'
        ov.style.overflowY  = 'auto'
        ov.style.padding    = '16px 12px 32px'
        ov.scrollTop        = 0
      }
    } else {
      const overlay = document.getElementById('editOrderModal')
      if (overlay) document.body.appendChild(overlay)
      window.__openEditOrderModal(coin, oid, isBuy, sz, px, tpsl, isTrigger)
      const ov = document.getElementById('editOrderModal')
      if (ov) { ov.style.zIndex = '99999' }
    }
  } catch(e) { console.error('_mobVEditOrd error:', e) }
}

function _mobVGetPfp(addr) {
  if (!addr) return null
  return localStorage.getItem('hliq_pfp_' + addr.toLowerCase()) || null
}

function _mobVSetPfp(addr, dataUrl) {
  if (!addr) return
  localStorage.setItem('hliq_pfp_' + addr.toLowerCase(), dataUrl)
}

window._mobVPickPfp = function() {
  const input = document.getElementById('mobVPfpInput')
  if (input) input.click()
}

window._mobVHandlePfp = function(input) {
  const file = input?.files?.[0]
  if (!file || !state.addr) return
  if (!isDev()) return
  const reader = new FileReader()
  reader.onload = function(e) {
    const img = new Image()
    img.onload = function() {
      const canvas = document.createElement('canvas')
      canvas.width = 256; canvas.height = 256
      const ctx = canvas.getContext('2d')
      const size = Math.min(img.width, img.height)
      const sx = (img.width - size) / 2
      const sy = (img.height - size) / 2
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 256, 256)
      const dataUrl = canvas.toDataURL('image/jpeg', 0.88)
      const ts = Date.now()
      fetch('/pfp/' + state.addr.toLowerCase(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl }),
      }).then(() => {
        const bust = `/pfp/${state.addr.toLowerCase()}?v=${ts}`
        const avatarEl = document.getElementById('mobVAvatar')
        if (avatarEl) { const img = avatarEl.querySelector('img'); if (img) img.src = bust }
        const drawerAvatar = document.getElementById('mobVDrawerAvatar')
        if (drawerAvatar) { const img = drawerAvatar.querySelector('img'); if (img) img.src = bust }
        document.querySelectorAll(`img[src^="/pfp/${state.addr.toLowerCase()}"]`).forEach(img => { img.src = bust })
      }).catch(() => {})
    }
    img.src = e.target.result
  }
  reader.readAsDataURL(file)
  input.value = ''
}

window._mobVAvatarError = function(img, addr, size) {
  const hue = parseInt(addr.slice(2, 8), 16) % 360
  const initials = (addr.slice(2, 3) + addr.slice(3, 4)).toUpperCase()
  const d = document.createElement('div')
  d.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:oklch(0.52 0.2 ${hue});display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.38)}px;color:#fff;flex-shrink:0`
  d.textContent = initials
  img.replaceWith(d)
}

function _mobVAvatarHtml(addr, size) {
  if (!addr) return `<div style="width:${size}px;height:${size}px;border-radius:50%;background:var(--panel-2);flex-shrink:0"></div>`
  return `<img src="/pfp/${addr.toLowerCase()}" width="${size}" height="${size}" style="border-radius:50%;object-fit:cover;display:block;flex-shrink:0" onerror="window._mobVAvatarError(this,'${addr}',${size})">`
}

function _mobVAvatarImgHtml(addr, size) {
  return _mobVAvatarHtml(addr, size)
}
window._mobVAvatarHtml = _mobVAvatarHtml   // reused by the desktop overview (render.js)

function _mobVRenderHeader() {
  if (!state.addr) return
  const saved = WM.load().find(w => w.addr.toLowerCase() === state.addr.toLowerCase())
  const label = saved?.label || ''
  const avatarEl = document.getElementById('mobVAvatar')
  const nameEl   = document.getElementById('mobVName')
  const addrEl   = document.getElementById('mobVAddr')
  if (avatarEl) avatarEl.innerHTML = _mobVAvatarHtml(state.addr, 50)
  if (nameEl)   nameEl.textContent = label || 'My Wallet'
  if (addrEl)   addrEl.textContent = state.addr.slice(0, 6) + '…' + state.addr.slice(-4)
}

window._mobVOpenWalletSwitch = function() {
  if (!state.addr) return
  const drawer   = document.getElementById('mobWalletDrawer')
  const backdrop = document.getElementById('mobWalletBackdrop')
  if (!drawer) return
  const allWallets = WM.load()
  const current    = allWallets.find(w => w.addr.toLowerCase() === state.addr.toLowerCase())
  const label      = current?.label || 'My Wallet'
  const short      = state.addr.slice(0, 10) + '…' + state.addr.slice(-8)
  const others     = allWallets.filter(w => w.addr.toLowerCase() !== state.addr.toLowerCase())
  drawer.innerHTML = `
    <div class="mob-wallet-handle"></div>
    <div class="mob-wallet-current">
      <div style="position:relative;display:inline-block;flex-shrink:0" id="mobVDrawerAvatar">
        ${_mobVAvatarImgHtml(state.addr, 80)}
        ${isDev()
          ? `<button onclick="window._mobVPickPfp()" style="position:absolute;bottom:0;right:0;width:26px;height:26px;border-radius:50%;background:var(--panel-3);border:2px solid var(--bg);display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0" title="Change photo">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
             </button>`
          : ''}
      </div>
      <div class="mob-wallet-current-name">${esc(label)}</div>
      <div class="mob-wallet-current-addr">
        ${esc(short)}
        <button class="mob-wallet-copy-btn" onclick="navigator.clipboard?.writeText('${esc(state.addr)}').catch(()=>{})">⧉</button>
      </div>
    </div>
    <button class="mob-wallet-settings-btn" onclick="window._mobVCloseWalletSwitch();_mobVActiveTab='settings';document.querySelectorAll('.mob-v-tab').forEach(b=>b.classList.remove('active'));_mobVRenderContent()">Wallet settings</button>
    ${others.length ? `<div class="mob-wallet-list">
      ${others.map(w => `
        <div class="mob-wallet-list-item" onclick="window._mobVCloseWalletSwitch();window.__quickLoad('${esc(w.addr)}')">
          ${_mobVAvatarHtml(w.addr, 40)}
          <div class="mob-wallet-list-info">
            <div class="mob-wallet-list-name">${esc(w.label || w.addr.slice(0, 8) + '…')}</div>
            <div class="mob-wallet-list-addr">${esc(w.addr.slice(0, 8) + '…' + w.addr.slice(-6))}</div>
          </div>
          <button onclick="event.stopPropagation();window._mobVRemoveWallet('${esc(w.addr)}')"
            style="margin-left:auto;background:none;border:none;color:var(--muted);font-size:16px;padding:10px 12px;cursor:pointer;flex-shrink:0;min-width:40px;min-height:40px" title="Remove">✕</button>
        </div>`).join('')}
    </div>` : ''}
    <button class="mob-wallet-add-btn" onclick="window._mobVCloseWalletSwitch();window._mobVAddAddress()">
      <div style="width:40px;height:40px;border-radius:50%;background:var(--panel-2);display:flex;align-items:center;justify-content:center;font-size:20px;color:var(--fg);flex-shrink:0">+</div>
      Add address
    </button>
  `
  drawer.classList.add('open')
  backdrop.classList.add('open')
}

window._mobVCloseWalletSwitch = function() {
  document.getElementById('mobWalletDrawer')?.classList.remove('open')
  document.getElementById('mobWalletBackdrop')?.classList.remove('open')
}

window._mobVRemoveWallet = async function(addr) {
  const entry = WM.load().find(w => w.addr === addr)
  const ok = await _showPinModal({
    title: 'Remove account?',
    desc:  `${entry?.label || ''} ${addr.slice(0, 10)}…${addr.slice(-6)} — type YES to confirm`,
    confirmText: 'Remove',
    placeholder: 'YES',
    type: 'text',
  })
  if (ok === null || ok.trim().toUpperCase() !== 'YES') return
  WM.remove(addr)   // WM.save re-syncs the push subscription — alerts stop too
  window._mobVOpenWalletSwitch()   // re-render the drawer in place
}

window._mobVAddAddress = async function() {
  const addr = await _showPinModal({
    title: 'Add Address',
    desc:  'Paste a wallet address to watch',
    confirmText: 'Add',
    placeholder: '0x…',
    type: 'text',
  })
  if (addr === null) return
  const a = addr.trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(a)) {
    await _showPinModal({ title: 'Invalid address', desc: 'Must be 0x followed by 40 hex characters.', confirmText: 'OK', type: 'text' })
    return
  }
  const label = await _showPinModal({
    title: 'Name this account',
    desc:  a.slice(0, 10) + '…' + a.slice(-6),
    confirmText: 'Save',
    placeholder: 'e.g. Main, Degen…',
    type: 'text',
  })
  WM.upsert(a, (label ?? '').trim() || a.slice(0, 6) + '…' + a.slice(-4))
  window.__quickLoad(a)
}

// ── Solvi: the account-health pet ────────────────────────────────────────────
// A Tamagotchi-style creature whose mood = your account health (liq-distance).
// It turns a cold margin ratio into a visceral "feed me" instinct that nudges
// de-risking. v1 = one pet for the whole account; positions become a "zoo" later.
const _PET_STATES = {
  thriving: { color: '#00e5a0', label: 'Thriving', sub: 'Well fed and healthy. Nice work.' },
  uneasy:   { color: '#f5a623', label: 'Uneasy',   sub: 'Risk is creeping up — ease leverage or add margin.' },
  critical: { color: '#ff4d6d', label: 'Critical', sub: 'Close to liquidation! Feed me — cut risk now.' },
  idle:     { color: '#63b3ed', label: 'Chilling', sub: 'No open positions. Nothing at risk.' },
}
function _mobPetState(healthPct, hasPos) {
  if (!hasPos) return 'idle'
  if (healthPct > 60) return 'thriving'
  if (healthPct > 30) return 'uneasy'
  return 'critical'
}
// ── 3 selectable creatures — trading spirits (species persisted) ─────────────
// Bullo the bull (longs), Bera the bear (shorts), Botto the bot (automation).
// Bodies keep their species identity; the MOOD shows in the face + glow aura.
const _GM_SPECIES = ['bullo', 'bera', 'botto']
const _GM_NAMES   = { bullo: 'Bullo', bera: 'Bera', botto: 'Botto' }
// Species is PER ACCOUNT (each wallet can keep a different companion); falls
// back to the legacy global key, then Bullo.
function _gmGetSpecies() {
  const a = (state?.addr || '').toLowerCase()
  const s = (a && localStorage.getItem('hliq_pet_species_' + a)) || localStorage.getItem('hliq_pet_species')
  return _GM_SPECIES.includes(s) ? s : 'bullo'
}
function _gmSetSpecies(s) {
  const a = (state?.addr || '').toLowerCase()
  localStorage.setItem(a ? 'hliq_pet_species_' + a : 'hliq_pet_species', s)
}

// Shared face parts — same mood language across all three species.
function _gmFace(key, cx, cy, s = 1) {
  const crit  = key === 'critical'
  const happy = key === 'thriving' || key === 'idle'
  const ew    = (crit ? 8 : 6.5) * s
  const eyes  = key === 'idle'
    // sleepy: content closed-arc eyes
    ? `<path d="M${cx-16*s} ${cy} q ${4*s} ${5*s} ${8*s} 0" stroke="#0a0e14" stroke-width="${3*s}" fill="none" stroke-linecap="round"/>
       <path d="M${cx+8*s} ${cy} q ${4*s} ${5*s} ${8*s} 0" stroke="#0a0e14" stroke-width="${3*s}" fill="none" stroke-linecap="round"/>`
    : `<ellipse cx="${cx-12*s}" cy="${cy}" rx="${ew}" ry="${ew+2*s}" fill="#0a0e14"/>
       <ellipse cx="${cx+12*s}" cy="${cy}" rx="${ew}" ry="${ew+2*s}" fill="#0a0e14"/>
       <circle cx="${cx-10*s}" cy="${cy-3*s}" r="${2.6*s}" fill="#fff"/><circle cx="${cx+14*s}" cy="${cy-3*s}" r="${2.6*s}" fill="#fff"/>
       <circle cx="${cx-14*s}" cy="${cy+2*s}" r="${1.2*s}" fill="#fff" opacity="0.8"/><circle cx="${cx+10*s}" cy="${cy+2*s}" r="${1.2*s}" fill="#fff" opacity="0.8"/>`
  const mouth = happy
    ? `<path d="M${cx-13*s} ${cy+16*s} Q${cx} ${cy+28*s} ${cx+13*s} ${cy+16*s}" fill="none" stroke="#0a0e14" stroke-width="${3*s}" stroke-linecap="round"/>`
    : crit
      ? `<path d="M${cx-9*s} ${cy+18*s} Q${cx} ${cy+11*s} ${cx+9*s} ${cy+18*s} Q${cx} ${cy+30*s} ${cx-9*s} ${cy+18*s} Z" fill="#0a0e14"/>`
      : `<path d="M${cx-10*s} ${cy+19*s} Q${cx} ${cy+14*s} ${cx+10*s} ${cy+19*s}" fill="none" stroke="#0a0e14" stroke-width="${3*s}" stroke-linecap="round"/>`
  const blush = happy
    ? `<ellipse cx="${cx-21*s}" cy="${cy+11*s}" rx="${6*s}" ry="${3.4*s}" fill="#ff9db0" opacity="0.55"/><ellipse cx="${cx+21*s}" cy="${cy+11*s}" rx="${6*s}" ry="${3.4*s}" fill="#ff9db0" opacity="0.55"/>` : ''
  const sweat = crit
    ? `<path d="M${cx+30*s} ${cy-14*s} q ${4.5*s} ${8*s} 0 ${13*s} q ${-4.5*s} ${-5*s} 0 ${-13*s}Z" fill="#7cc4ff"><animate attributeName="opacity" values="0.25;1;0.25" dur="0.9s" repeatCount="indefinite"/></path>` : ''
  const zzz = key === 'idle'
    ? `<text x="${cx+30*s}" y="${cy-22*s}" font-size="${13*s}" font-weight="900" fill="#3d5a80" opacity="0.9">z<animate attributeName="opacity" values="0.2;1;0.2" dur="2.4s" repeatCount="indefinite"/></text>` : ''
  return eyes + mouth + blush + sweat + zzz
}

function _gmPetSvg(species, key) {
  const mood = _PET_STATES[key].color
  const dark = 'rgba(0,0,0,0.22)'
  // Mood aura = soft radial GLOW that fades to nothing (a hard ellipse behind the
  // body read as "a second pet underneath" on the dark den background).
  const aura = `<radialGradient id="au-${species}-${key}" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${mood}" stop-opacity="0.5"/><stop offset="60%" stop-color="${mood}" stop-opacity="0.22"/><stop offset="100%" stop-color="${mood}" stop-opacity="0"/>
    </radialGradient>
    <ellipse cx="60" cy="72" rx="58" ry="54" fill="url(#au-${species}-${key})">
      <animate attributeName="opacity" values="0.55;1;0.55" dur="2.8s" repeatCount="indefinite"/></ellipse>`
  const bodyGrad = (id, base, light) => `<radialGradient id="${id}" cx="38%" cy="28%" r="80%">
    <stop offset="0%" stop-color="${light}"/><stop offset="55%" stop-color="${base}"/><stop offset="100%" stop-color="${base}"/>
  </radialGradient>`
  const shadow = `<ellipse cx="60" cy="119" rx="33" ry="6" fill="rgba(0,0,0,0.35)"/>`

  if (species === 'bera') {
    // Bera — the bear. Round brown bear cub, big ears, light muzzle, tummy patch.
    const B = '#c9855a', L = '#e8b38b', M = '#f2dcc3'
    return `<svg viewBox="0 0 120 124" width="108" height="112" aria-hidden="true">
      <defs>${bodyGrad('bg-bera', B, L)}</defs>
      ${aura}${shadow}
      <circle cx="30" cy="30" r="14" fill="url(#bg-bera)" stroke="${dark}" stroke-width="1.5"/>
      <circle cx="90" cy="30" r="14" fill="url(#bg-bera)" stroke="${dark}" stroke-width="1.5"/>
      <circle cx="30" cy="30" r="7" fill="${M}"/><circle cx="90" cy="30" r="7" fill="${M}"/>
      <path d="M60 20 C 90 20 105 44 103 74 C 101 102 87 114 60 114 C 33 114 19 102 17 74 C 15 44 30 20 60 20 Z" fill="url(#bg-bera)" stroke="${dark}" stroke-width="1.5"/>
      <ellipse cx="60" cy="96" rx="22" ry="15" fill="${M}" opacity="0.9"/>
      <ellipse cx="60" cy="74" rx="16" ry="12" fill="${M}"/>
      <ellipse cx="40" cy="113" rx="11" ry="6.5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      <ellipse cx="80" cy="113" rx="11" ry="6.5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      <path d="M14 74 q -7 4 -3 12 q 7 1 11 -5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      <path d="M106 74 q 7 4 3 12 q -7 1 -11 -5" fill="${B}" stroke="${dark}" stroke-width="1.5"/>
      ${_gmFace(key, 60, 56, 0.94)}
    </svg>`
  }
  if (species === 'botto') {
    // Botto — the trading bot. Steel shell, candlestick antenna, mood-lit visor.
    const S = '#9aa6ba', L = '#cdd6e4'
    return `<svg viewBox="0 0 120 124" width="108" height="112" aria-hidden="true">
      <defs>${bodyGrad('bg-botto', S, L)}</defs>
      ${aura}${shadow}
      <g stroke="${dark}" stroke-width="1.4">
        <line x1="60" y1="22" x2="60" y2="4" stroke-width="3.4" stroke-linecap="round"/>
        <rect x="55.5" y="4" width="9" height="12" rx="2" fill="#35c97e"/>
        <line x1="60" y1="1" x2="60" y2="19" stroke="#35c97e" stroke-width="2"/>
      </g>
      <rect x="20" y="22" width="80" height="78" rx="24" fill="url(#bg-botto)" stroke="${dark}" stroke-width="1.5"/>
      <rect x="9"  y="50" width="13" height="30" rx="6.5" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <rect x="98" y="50" width="13" height="30" rx="6.5" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <circle cx="15.5" cy="46" r="5" fill="#ffd93b" stroke="${dark}" stroke-width="1.2"/>
      <circle cx="104.5" cy="46" r="5" fill="#ffd93b" stroke="${dark}" stroke-width="1.2"/>
      <rect x="30" y="34" width="60" height="50" rx="13" fill="#0d1420" stroke="rgba(255,255,255,0.3)" stroke-width="2"/>
      <g style="filter:drop-shadow(0 0 5px ${mood})">${_gmFace(key, 60, 53, 0.8).replaceAll('#0a0e14', mood).replaceAll('#ff9db0', mood)}</g>
      <rect x="32" y="88" width="56" height="7" rx="3.5" fill="rgba(0,0,0,0.25)"/>
      <rect x="34" y="89.5" width="${key === 'critical' ? 12 : key === 'uneasy' ? 28 : 52}" height="4" rx="2" fill="${mood}"/>
      <rect x="32" y="100" width="24" height="16" rx="6" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <rect x="64" y="100" width="24" height="16" rx="6" fill="${S}" stroke="${dark}" stroke-width="1.5"/>
      <line x1="38" y1="104" x2="38" y2="112" stroke="${dark}" stroke-width="2"/><line x1="46" y1="104" x2="46" y2="112" stroke="${dark}" stroke-width="2"/>
      <line x1="70" y1="104" x2="70" y2="112" stroke="${dark}" stroke-width="2"/><line x1="78" y1="104" x2="78" y2="112" stroke="${dark}" stroke-width="2"/>
    </svg>`
  }
  // Bullo — the bull. Clean mint round-body, crescent horns curving UP, small ears.
  const G = '#3fbf7f', GL = '#7fdcae', H = '#f7f3e8'
  return `<svg viewBox="0 0 120 124" width="108" height="112" aria-hidden="true">
    <defs>${bodyGrad('bg-bullo', G, GL)}</defs>
    ${aura}${shadow}
    <path d="M34 30 C 26 26 20 18 21 8 C 30 10 37 18 38 28 Z" fill="${H}" stroke="${dark}" stroke-width="1.5"/>
    <path d="M86 30 C 94 26 100 18 99 8 C 90 10 83 18 82 28 Z" fill="${H}" stroke="${dark}" stroke-width="1.5"/>
    <ellipse cx="24" cy="42" rx="8" ry="5.5" fill="${G}" stroke="${dark}" stroke-width="1.5" transform="rotate(-30 24 42)"/>
    <ellipse cx="96" cy="42" rx="8" ry="5.5" fill="${G}" stroke="${dark}" stroke-width="1.5" transform="rotate(30 96 42)"/>
    <path d="M60 22 C 92 22 106 46 104 76 C 102 103 88 114 60 114 C 32 114 18 103 16 76 C 14 46 28 22 60 22 Z" fill="url(#bg-bullo)" stroke="${dark}" stroke-width="1.5"/>
    <ellipse cx="60" cy="94" rx="17" ry="10" fill="#8fe6bb" opacity="0.85"/>
    <circle cx="54" cy="94" r="2.2" fill="#1d6b43"/><circle cx="66" cy="94" r="2.2" fill="#1d6b43"/>
    <ellipse cx="42" cy="113" rx="11" ry="6.5" fill="${G}" stroke="${dark}" stroke-width="1.5"/>
    <ellipse cx="78" cy="113" rx="11" ry="6.5" fill="${G}" stroke="${dark}" stroke-width="1.5"/>
    ${_gmFace(key, 60, 56, 0.94)}
  </svg>`
}

// Back-compat shim — Solvi card + game world both render the selected species.
function _petSvg(key, _color) { return _gmPetSvg(_gmGetSpecies(), key) }
// The pet lives ONLY in Game Mode now — Pro stays clean. This is just the
// per-tick sync hook (kept so every balance render refreshes the game world).
function _mobVRenderPet(healthPct, hasPos) {
  const el = document.getElementById('mobVPet')
  if (el) el.style.display = 'none'
  _updateGameMode()
}

// ── GAME MODE ─────────────────────────────────────────────────────────────────
// A full Moy/Pou-style illustrated pet world, drawn 100% in inline SVG (zero
// image assets) and skinned over the REAL account: coins = account value,
// hearts = liq-distance health, the wooden sign = live uPnL, and every action
// button is a real trading action wearing a cute verb. Toggleable — Pro UI stays.
let _gameMode = localStorage.getItem('hliq_game_mode') === '1'
let _gmLastMood = null

const _GM_QUIPS = {
  thriving: ['Green candles for dinner! 🌿', 'The desk is printing~', 'Health bar full, LFG!', 'Funding just hit the bowl 😋', 'We are so back.'],
  uneasy:   ['Margin\'s getting thin, boss…', 'Maybe ease the leverage?', 'The monitors look scary today…', 'I\'d hedge. Just saying.'],
  critical: ['FEED ME MARGIN!! 😰', 'LIQ PRICE ON SCREEN 2!!', 'It\'s not a loss until we sell— wait', 'MAYDAY MAYDAY 🚨'],
  idle:     ['Flat book~ nap time 💤', 'Wanna flip a card in the shop?', 'Charts are for watching, not touching.', 'The neon sign flickers sometimes.'],
}

window.__toggleGameMode = function() {
  _gameMode = !_gameMode
  localStorage.setItem('hliq_game_mode', _gameMode ? '1' : '0')
  const ov = document.getElementById('gameModeOverlay')
  if (!_gameMode && ov) { ov.style.display = 'none'; ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false }
  else { _gmScreen = 'home'; _updateGameMode() }
}

// Home scene: the trading den, but the ROOM IS THE MENU — every piece of
// furniture is a real action. viewBox is phone-shaped (400×820) so nothing gets
// cropped off the sides on tall screens (the old 400×560 lost ~100px each side).
//   · food table  → Feed (deposit)         · terminal  → Trade (card shop)
//   · clipboard   → List (positions+orders) · robot     → Bots (soon)
//   · door        → Outside (zoo, soon)     · monitor   → REAL account value + equity chart
// Every interactive furniture piece goes through this wrapper: a stable
// data-obj id, shared hover/press glow, floating name label — and if a painted
// `obj-<id>.png` is in the manifest, it replaces the SVG art in `box` while any
// `live` layers (screen text, charts) stay composited on top.
function _gmObj(id, action, box, svgArt, live, labelX, labelY, labelText) {
  const img = _gmV('obj-' + id, id)
  const art = img && box
    ? `<image href="${img}" x="${box[0]}" y="${box[1]}" width="${box[2]}" height="${box[3]}" preserveAspectRatio="xMidYMid meet"/>`
    : svgArt
  // Floating name labels removed — objects speak for themselves (label params
  // kept so call sites/skins stay stable).
  return `<g class="gm-obj" data-obj="${id}" onclick="${action}">${art}${live || ''}</g>`
}

function _gmWorldSvg() {
  const bg = _gmV('bg-den', 'bg-den')
  return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>
      <linearGradient id="gmDenWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#151a2c"/><stop offset="100%" stop-color="#242c4a"/></linearGradient>
      <linearGradient id="gmDenFloor" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#38291c"/><stop offset="100%" stop-color="#221812"/></linearGradient>
      <linearGradient id="gmCity" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0a1026"/><stop offset="100%" stop-color="#1e2d56"/></linearGradient>
      <linearGradient id="gmWoodTop" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#4a3826"/><stop offset="100%" stop-color="#33261a"/></linearGradient>
    </defs>
    ${bg ? `<image href="${bg}" x="0" y="0" width="400" height="820" preserveAspectRatio="xMidYMax slice"/>` : `
    <rect width="400" height="600" fill="url(#gmDenWall)"/>
    <rect y="600" width="400" height="220" fill="url(#gmDenFloor)"/>
    ${[0,1,2,3].map(i => `<line x1="0" y1="${640 + i * 46}" x2="400" y2="${640 + i * 46}" stroke="rgba(0,0,0,0.25)" stroke-width="2"/>`).join('')}`}

    <g class="gm-neon">
      <text x="242" y="242" text-anchor="middle" font-size="19" font-weight="900" letter-spacing="2.5" fill="none" stroke="#ff8a2a" stroke-width="1.4" style="filter:drop-shadow(0 0 8px #ff8a2a) drop-shadow(0 0 16px #ff8a2a88)">INSOLVENT</text>
      <text x="242" y="262" text-anchor="middle" font-size="9" font-weight="700" letter-spacing="4.5" fill="#ffb84d" opacity="0.8" style="filter:drop-shadow(0 0 6px #ff8a2a)">· TERMINAL ·</text>
    </g>

    <!-- Big window onto the city; the far building carries a LIVE billboard that
         cycles through the watchlist (coin · price · 24h%) like Times Square. -->
    <g stroke="#0d1120" stroke-width="5">
      <rect x="20" y="204" width="150" height="136" rx="7" fill="url(#gmCity)"/>
      <line x1="95" y1="206" x2="95" y2="338"/>
    </g>
    <g fill="#101a38">
      <rect x="28" y="268" width="18" height="72"/><rect x="52" y="248" width="15" height="92"/><rect x="126" y="256" width="17" height="84"/><rect x="150" y="276" width="14" height="64"/>
    </g>
    <g fill="#ffd93b">${[[32,276],[38,292],[56,256],[62,272],[130,264],[136,282],[153,284],[32,308],[62,300],[130,300],[153,306]].map(([x,y]) => `<rect x="${x}" y="${y}" width="3" height="3" opacity="0.85"/>`).join('')}</g>
    <circle cx="152" cy="222" r="7" fill="#e8ecf4" opacity="0.9"/>
    <g>
      <rect x="72" y="252" width="50" height="34" rx="4" fill="#06101f" stroke="#ff8a2a" stroke-width="2" style="filter:drop-shadow(0 0 6px #ff8a2a66)"/>
      <line x1="82" y1="286" x2="82" y2="300" stroke="#0d1120" stroke-width="3"/><line x1="112" y1="286" x2="112" y2="300" stroke="#0d1120" stroke-width="3"/>
      <text id="gmBillCoin" x="97" y="265" text-anchor="middle" font-size="9.5" font-weight="900" fill="#ffb84d">—</text>
      <text id="gmBillPx"   x="97" y="276" text-anchor="middle" font-size="8.5" font-weight="700" font-family="monospace" fill="#f4f6ff">—</text>
      <text id="gmBillChg"  x="97" y="284" text-anchor="middle" font-size="7.5" font-weight="900" font-family="monospace" fill="#8a93a8">—</text>
    </g>

    ${_gmObj('list', "window.__gmScreen('list')", [318, 216, 66, 112], `
      <rect x="322" y="228" width="58" height="76" rx="6" fill="#c9a755" stroke="#10141f" stroke-width="3"/>
      <rect x="330" y="240" width="42" height="58" rx="3" fill="#fdf7e4"/>
      <rect x="342" y="222" width="18" height="12" rx="4" fill="#8a93a8" stroke="#10141f" stroke-width="2"/>
      <text x="351" y="252" text-anchor="middle" font-size="7" font-weight="900" fill="#5d8f6f" letter-spacing="0.2">Hyperliquid</text>
      ${[262,272,282,290].map(y => `<line x1="335" y1="${y}" x2="367" y2="${y}" stroke="#b8a67c" stroke-width="2.5"/>`).join('')}`,
      '', 351, 322, 'List')}

    ${_gmObj('monitor', 'window.__gmPokeMonitor()', [96, 300, 208, 188], `
      <rect x="100" y="306" width="200" height="158" rx="12" fill="#0b1220" stroke="#2b2b2b" stroke-width="4"/>
      <rect x="107" y="313" width="186" height="144" rx="7" fill="#081018"/>
      <rect x="186" y="464" width="28" height="12" fill="#1c1c1e"/>
      <rect x="172" y="474" width="56" height="6" rx="3" fill="#1c1c1e"/>`, `
      <text x="114" y="326" font-size="7.5" font-weight="700" font-family="monospace" fill="#35c97e">┌ INSOLVENT:acct ── LIVE</text>
      <text x="114" y="326" font-size="7.5" font-family="monospace" fill="#35c97e"><tspan x="248">▮</tspan><animate attributeName="opacity" values="1;0;1" dur="1.2s" repeatCount="indefinite"/></text>
      <g id="gmMonPriv" onclick="event.stopPropagation();window.__gmMonPriv()" style="cursor:pointer">
        <rect x="264" y="316" width="24" height="14" rx="4" fill="#0f1d2e" stroke="#2f3a55" stroke-width="1.2"/>
        <text id="gmMonPrivIc" x="276" y="327" text-anchor="middle" font-size="8.5">👁</text>
      </g>
      <text id="gmMonVal" x="192" y="349" text-anchor="middle" font-size="19" font-weight="800" font-family="monospace" fill="#f4f6ff">—</text>
      <text id="gmMonDelta" x="192" y="362" text-anchor="middle" font-size="8.5" font-weight="700" font-family="monospace" fill="#8a93a8">—</text>
      <text id="gmMonPnl" x="192" y="374" text-anchor="middle" font-size="8.5" font-weight="700" font-family="monospace" fill="#8a93a8">—</text>
      <polyline id="gmMonSpark" points="" fill="none" stroke="#35c97e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="gm-mon"/>
      ${['value', 'accum', 'realized'].map((t, i) => `
      <g onclick="event.stopPropagation();window.__gmMonType('${t}')" style="cursor:pointer">
        <rect id="gmMonBtn-${t}" x="${112 + i * 47}" y="422" width="43" height="13" rx="4" fill="#0f1d2e" stroke="#2f3a55" stroke-width="1.2"/>
        <text id="gmMonBtnT-${t}" x="${133.5 + i * 47}" y="431.5" text-anchor="middle" font-size="7.5" font-weight="800" font-family="monospace" fill="#8a93a8">${t === 'value' ? 'VALUE' : t === 'accum' ? 'ACCUM' : 'REALZD'}</text>
      </g>`).join('')}
      <g onclick="event.stopPropagation();window.__toggleGameMode()" style="cursor:pointer">
        <rect x="255" y="422" width="35" height="13" rx="4" fill="#2b1a08" stroke="#ff8a2a" stroke-width="1.2"/>
        <text x="272.5" y="431.5" text-anchor="middle" font-size="7.5" font-weight="900" font-family="monospace" fill="#ffb84d">PRO</text>
      </g>
      ${[['day', '1D'], ['week', '1W'], ['month', '1M'], ['allTime', 'ALL']].map(([tf, lb], i) => `
      <g onclick="event.stopPropagation();window.__gmMonTf('${tf}')" style="cursor:pointer">
        <rect id="gmMonTf-${tf}" x="${112 + i * 39}" y="439" width="35" height="13" rx="4" fill="#0f1d2e" stroke="#2f3a55" stroke-width="1.2"/>
        <text id="gmMonTfT-${tf}" x="${129.5 + i * 39}" y="448.5" text-anchor="middle" font-size="7.5" font-weight="800" font-family="monospace" fill="#8a93a8">${lb}</text>
      </g>`).join('')}`,
      0, 0, '')}

    ${_gmObj('terminal', "window.__gmScreen('trade')", [24, 382, 74, 104], `
      <rect x="28" y="386" width="66" height="76" rx="7" fill="#1a212f" stroke="#10141f" stroke-width="4"/>
      <rect x="34" y="392" width="54" height="56" rx="4" fill="#04140a"/>
      <rect x="40" y="452" width="42" height="5" rx="2.5" fill="#2b3350"/>`, `
      <text x="38" y="406" font-size="9" font-family="monospace" fill="#35c97e">&gt; long?</text>
      <text x="38" y="419" font-size="9" font-family="monospace" fill="#35c97e">&gt; short?</text>
      <text x="38" y="432" font-size="9" font-family="monospace" fill="#ffb84d">&gt; deal_</text>`,
      61, 480, 'Trade')}

    ${bg ? '' : `
    <g stroke="#181008" stroke-width="2.5">
      <rect x="312" y="424" width="18" height="22" rx="4" fill="#f4f0e4"/>
      <path d="M330 430 q 8 2 0 11" fill="none"/>
      <path d="M316 419 q 3 -6 0 -9 M323 419 q 3 -6 0 -9" fill="none" stroke="#8a93a8" opacity="0.8"/>
    </g>
    <rect x="12" y="464" width="288" height="18" rx="7" fill="url(#gmWoodTop)" stroke="#181008" stroke-width="3"/>
    <rect x="16" y="482" width="280" height="5" rx="2.5" fill="#ff8a2a" opacity="0.85" style="filter:drop-shadow(0 3px 8px #ff8a2a)"/>
    <rect x="36" y="482" width="13" height="118" fill="#241a12" stroke="#181008" stroke-width="3"/>
    <rect x="262" y="482" width="13" height="118" fill="#241a12" stroke="#181008" stroke-width="3"/>`}

    ${_gmObj('door', "window.__gmSoon('🚪 The pen outside is under construction!')", [310, 340, 84, 282], `
      <rect x="314" y="368" width="74" height="232" rx="8" fill="#5a3d20" stroke="#10141f" stroke-width="4"/>
      <rect x="322" y="378" width="58" height="102" rx="5" fill="none" stroke="#3d2913" stroke-width="3"/>
      <rect x="322" y="490" width="58" height="98" rx="5" fill="none" stroke="#3d2913" stroke-width="3"/>
      <circle cx="326" cy="486" r="5" fill="#ffd93b" stroke="#10141f" stroke-width="2"/>
      <rect x="328" y="346" width="46" height="18" rx="4" fill="#1a212f" stroke="#10141f" stroke-width="2.5"/>
      <text x="351" y="359" text-anchor="middle" font-size="9" font-weight="900" fill="#7cc4ff">EXIT</text>`,
      '', 351, 616, 'Outside')}

    ${_gmObj('feed', "window.__gmScreen('feed')", [18, 634, 120, 118], `
      <ellipse cx="78" cy="668" rx="55" ry="17" fill="#7a4e1e" stroke="#181008" stroke-width="3"/>
      <ellipse cx="78" cy="663" rx="55" ry="17" fill="#a06a2c" stroke="#181008" stroke-width="2.5"/>
      <path d="M23 663 q 55 26 110 0 l 0 8 q -55 26 -110 0 Z" fill="#e8e2d4" opacity="0.14"/>
      <rect x="70" y="676" width="16" height="40" fill="#5f3d17" stroke="#181008" stroke-width="2.5"/>
      <ellipse cx="78" cy="718" rx="27" ry="7" fill="#5f3d17" stroke="#181008" stroke-width="2.5"/>
      <ellipse cx="78" cy="658" rx="31" ry="9.5" fill="#f7f3e8" stroke="#c9c2b0" stroke-width="2"/>
      <ellipse cx="78" cy="656" rx="24" ry="6.5" fill="none" stroke="#d9d2c0" stroke-width="1.5"/>
      <text x="59" y="656" font-size="17">🍕</text><text x="83" y="653" font-size="15">🍎</text>
      <text x="97" y="660" font-size="13">🧀</text>`,
      '', 78, 746, 'Feed')}

    ${_gmObj('bots', "window.__gmSoon('🤖 Bot garage opening soon — my cousins are coming!')", [252, 612, 60, 110], `
      <g class="pet-bob" style="transform-origin:282px 700px">
        <rect x="258" y="640" width="48" height="44" rx="12" fill="#9aa6ba" stroke="#10141f" stroke-width="3"/>
        <rect x="266" y="648" width="32" height="20" rx="6" fill="#0d1420"/>
        <circle cx="275" cy="658" r="3.4" fill="#7cc4ff"/><circle cx="289" cy="658" r="3.4" fill="#7cc4ff"/>
        <line x1="282" y1="640" x2="282" y2="628" stroke="#10141f" stroke-width="3"/>
        <circle cx="282" cy="625" r="4" fill="#ffd93b" stroke="#10141f" stroke-width="1.5"/>
        <rect x="262" y="684" width="16" height="10" rx="4" fill="#7e8aa0" stroke="#10141f" stroke-width="2.5"/>
        <rect x="286" y="684" width="16" height="10" rx="4" fill="#7e8aa0" stroke="#10141f" stroke-width="2.5"/>
      </g>`,
      '', 282, 714, 'Bots')}

    ${bg ? '' : `
    <ellipse cx="180" cy="766" rx="130" ry="36" fill="#54412e" stroke="#241a12" stroke-width="4"/>
    <ellipse cx="180" cy="766" rx="98" ry="26" fill="none" stroke="#241a12" stroke-width="2.5" opacity="0.6"/>
    <ellipse cx="180" cy="766" rx="66" ry="16" fill="none" stroke="#241a12" stroke-width="2.5" opacity="0.5"/>`}
  </svg>`
}

window.__gmMonType = function(t) {
  _gmMonType = t
  _updateGameMode()
}
window.__gmMonTf = function(tf) {
  _gmMonTf = tf
  _updateGameMode()
}
window.__gmMonPriv = function() {
  window.__togglePrivacy?.()   // shared app-wide privacy mode (Pro UI follows too)
  _updateGameMode()
}

// Tap the big monitor → the pet comments on the stack (it's display-only).
window.__gmPokeMonitor = function() {
  const bub = document.getElementById('gmBubble')
  if (!bub) return
  bub.textContent = 'That\'s our whole stack up there 📈'
  bub.classList.add('show'); clearTimeout(bub._t)
  bub._t = setTimeout(() => bub.classList.remove('show'), 2200)
}

function _gmLevel(v)  { return Math.max(1, Math.floor(Math.log10(Math.max(v, 1)))) }
function _gmHearts(pct, hasPos) {
  const filled = hasPos ? Math.max(1, Math.round((pct || 0) / 20)) : 5
  return Array.from({ length: 5 }, (_, i) =>
    `<span class="gm-heart${i < filled ? '' : ' off'}">❤</span>`).join('')
}

// ── Screens: home | feed (food shop) | list (order board) | trade (card shop) ─
let _gmScreen     = 'home'
let _gmLastVal    = null       // account value at last tick — a jump = deposit landed → eat!
let _gmValAddr    = null
let _gmOrdersHash = null
let _gmCardCoin   = null       // expanded market card
let _gmBillIdx    = 0          // billboard rotation through the watchlist
let _gmBillTs     = 0
let _gmMonType    = 'value'    // desk monitor chart: value | accum | realized
let _gmMonTf      = 'allTime'  // desk monitor timeframe: day | week | month | allTime
const _gmSparkCache = {}

// ── Painted-asset pipeline ────────────────────────────────────────────────────
// Drop PNGs in public/game/ and list their names in public/game/manifest.json —
// every listed asset replaces its SVG placeholder (see GAME-ASSETS.md for the
// full spec + prompts). Missing assets keep the hand-drawn fallback, so art can
// ship one file at a time.
let _gmAssets = new Set()
fetch('/game/manifest.json')
  .then(r => (r.ok ? r.json() : []))
  .then(list => {
    _gmAssets = new Set(Array.isArray(list) ? list : [])
    if (_gmAssets.size && _gameMode) {
      const ov = document.getElementById('gameModeOverlay')
      if (ov) { ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false }
      _updateGameMode()
    }
  })
  .catch(() => {})
const _gmA = n => (_gmAssets.has(n) ? `/game/${n}.png` : null)

// ── Skins ─────────────────────────────────────────────────────────────────────
// Every slot (object id, background name, or 'pet') can wear a named look.
// Variant files use a dot suffix: obj-door.neon.png, bg-den.winter.png,
// pet-bullo-thriving.royal.png. Resolution: selected variant → base painted
// asset → built-in SVG. The current SVG art IS the "default" skin, so future
// looks are purely additive — the shop just calls __gmSetSkin.
// Skins are PER ACCOUNT (each wallet can decorate its own room). Cached per addr.
let _gmSkinsAddr = undefined, _gmSkins = {}
function _gmSkinsLoad() {
  const a = (state?.addr || '').toLowerCase()
  if (a === _gmSkinsAddr) return _gmSkins
  _gmSkinsAddr = a
  try {
    _gmSkins = JSON.parse(localStorage.getItem('hliq_game_skins_' + a) || localStorage.getItem('hliq_game_skins') || '{}')
  } catch { _gmSkins = {} }
  return _gmSkins
}
window.__gmSetSkin = function(slot, skin) {
  const skins = _gmSkinsLoad()
  if (!skin || skin === 'default') delete skins[slot]
  else skins[slot] = skin
  localStorage.setItem('hliq_game_skins_' + (state?.addr || '').toLowerCase(), JSON.stringify(skins))
  const ov = document.getElementById('gameModeOverlay')
  if (ov) { ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false }
  _updateGameMode()
}
// Variant-aware lookup: base asset name + the skin slot that owns it.
const _gmV = (base, slot) => {
  const sk = _gmSkinsLoad()[slot]
  return (sk ? _gmA(`${base}.${sk}`) : null) || _gmA(base)
}

window.__gmScreen = function(s) {
  _gmScreen = s
  const ov = document.getElementById('gameModeOverlay')
  if (ov) { ov.innerHTML = ''; delete ov.dataset.screen }
  _gmLastMood = null; _gmOrdersHash = null; _gmCardCoin = null; _gmCardsBuilt = false
  _updateGameMode()
}

// Shared top chrome. Home gets the player HUD (avatar · name · HP bar · coins),
// like a proper game; sub-screens get just the wooden back arrow. Exit to Pro
// lives on the monitor's PRO key.
function _gmChrome(title, sub) {
  return `
    ${title ? `<div class="gm-title gm-outline">${title}</div>` : ''}
    ${sub
      ? `<button class="gm-back" onclick="window.__gmScreen('home')">◀</button>`
      : `<div class="gm-hud">
           <div class="gm-hud-ava" id="gmHudAva"></div>
           <div class="gm-hud-info">
             <div class="gm-hud-name gm-outline" id="gmHudName">—</div>
             <div class="gm-hud-hp"><div class="gm-hud-hp-fill" id="gmHudHp"></div></div>
             <div class="gm-hud-coins">🪙 <span id="gmCoins" class="gm-outline">—</span></div>
           </div>
         </div>`}`
}

// ── Scene backgrounds (all inline SVG) ────────────────────────────────────────
// Food shop: warm bistro — pendant lamps with light cones, wood-panel wainscot,
// stocked shelves with proper jars, a glass display counter, checkerboard floor.
function _gmShopSvg() {
  const bg = _gmV('bg-shop', 'bg-shop')
  if (bg) return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><image href="${bg}" width="400" height="820" preserveAspectRatio="xMidYMax slice"/></svg>`
  const jar = (x, y, w, h, c) => `
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="${c}" stroke="#5f3d17" stroke-width="2"/>
    <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="4" fill="url(#gmGlass)"/>
    <rect x="${x + w * 0.2}" y="${y - 5}" width="${w * 0.6}" height="6" rx="2" fill="#8a5a22" stroke="#5f3d17" stroke-width="1.5"/>`
  const lamp = (x) => `
    <line x1="${x}" y1="0" x2="${x}" y2="64" stroke="#3d2913" stroke-width="3"/>
    <path d="M${x - 22} 88 Q${x} 58 ${x + 22} 88 Z" fill="#d9542e" stroke="#8f2f14" stroke-width="2.5"/>
    <circle cx="${x}" cy="88" r="6" fill="#ffe9a3" style="filter:drop-shadow(0 0 10px #ffd93b)"/>
    <path d="M${x - 30} 92 L${x + 30} 92 L${x + 58} 240 L${x - 58} 240 Z" fill="#ffd93b" opacity="0.07"/>`
  return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs>
      <linearGradient id="gmShopWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3a2a22"/><stop offset="100%" stop-color="#5a4232"/></linearGradient>
      <linearGradient id="gmGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.35"/><stop offset="40%" stop-color="#ffffff" stop-opacity="0.05"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0.15"/></linearGradient>
      <linearGradient id="gmCounter" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#6e4a2a"/><stop offset="100%" stop-color="#4a2f18"/></linearGradient>
      <pattern id="gmChecker" width="64" height="34" patternUnits="userSpaceOnUse">
        <rect width="64" height="34" fill="#2a201a"/>
        <path d="M0 0 L32 0 L48 17 L16 17 Z" fill="#3d2f24"/>
        <path d="M16 17 L48 17 L64 34 L32 34 Z" fill="#3d2f24"/>
      </pattern>
    </defs>
    <rect width="400" height="620" fill="url(#gmShopWall)"/>
    ${[0,1,2,3].map(i => `<rect x="${i * 104 + 8}" y="330" width="88" height="180" rx="6" fill="rgba(0,0,0,0.16)" stroke="#2a1c12" stroke-width="2"/>`).join('')}
    <rect y="620" width="400" height="200" fill="url(#gmChecker)"/>
    <rect y="614" width="400" height="10" fill="#1d140e"/>

    ${lamp(100)}${lamp(300)}

    <g>
      <rect x="36" y="196" width="328" height="12" rx="4" fill="#7a4e1e" stroke="#3d2913" stroke-width="2.5"/>
      <rect x="42" y="208" width="316" height="6" fill="rgba(0,0,0,0.3)"/>
      ${jar(60, 160, 30, 36, '#9edb7a')}${jar(112, 166, 24, 30, '#f2b04a')}${jar(238, 162, 28, 34, '#7cc4ff')}${jar(296, 168, 30, 28, '#ff9db0')}
      <circle cx="180" cy="180" r="16" fill="#ffd93b" stroke="#5f3d17" stroke-width="2"/>
      <circle cx="196" cy="186" r="11" fill="#e2643d" stroke="#5f3d17" stroke-width="2"/>
    </g>

    <!-- Glass display counter: the food row (HTML) sits right on top of it -->
    <g>
      <rect x="14" y="300" width="372" height="96" rx="10" fill="#101a26" stroke="#2b2b2b" stroke-width="3"/>
      <rect x="14" y="300" width="372" height="96" rx="10" fill="url(#gmGlass)"/>
      <line x1="14" y1="348" x2="386" y2="348" stroke="rgba(255,255,255,0.18)" stroke-width="2"/>
      <rect x="6" y="392" width="388" height="26" rx="8" fill="url(#gmCounter)" stroke="#241505" stroke-width="3"/>
      <rect x="10" y="418" width="380" height="120" fill="#3a2716" stroke="#241505" stroke-width="3"/>
      <rect x="26" y="436" width="160" height="84" rx="6" fill="rgba(0,0,0,0.22)" stroke="#241505" stroke-width="2"/>
      <rect x="214" y="436" width="160" height="84" rx="6" fill="rgba(0,0,0,0.22)" stroke="#241505" stroke-width="2"/>
      <text x="200" y="410" text-anchor="middle" font-size="12" font-weight="900" letter-spacing="2" fill="#ffd93b" style="filter:drop-shadow(0 0 6px #ff8a2a)">FRESH MARGIN DAILY</text>
    </g>
  </svg>`
}
// Cozy study for the order board: wall, window, desk lamp glow.
function _gmRoomSvg() {
  const bg = _gmV('bg-study', 'bg-study')
  if (bg) return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><image href="${bg}" width="400" height="820" preserveAspectRatio="xMidYMax slice"/></svg>`
  return `<svg class="gm-world" viewBox="0 0 400 560" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs><linearGradient id="gmRoomWall" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5d6a8c"/><stop offset="100%" stop-color="#48536e"/></linearGradient></defs>
    <rect width="400" height="450" fill="url(#gmRoomWall)"/>
    <rect y="450" width="400" height="110" fill="#6e4a24"/>
    <rect y="444" width="400" height="12" fill="#8a5a22"/>
    <g stroke="#2b3247" stroke-width="4">
      <rect x="290" y="46" width="86" height="70" rx="8" fill="#0e1524"/>
      <line x1="333" y1="50" x2="333" y2="112"/><line x1="294" y1="81" x2="372" y2="81"/>
    </g>
    <circle cx="320" cy="60" r="7" fill="#f4f6ff" opacity="0.9"/>
    <circle cx="352" cy="70" r="3" fill="#f4f6ff" opacity="0.7"/><circle cx="306" cy="98" r="2.5" fill="#f4f6ff" opacity="0.6"/>
    <ellipse cx="70" cy="120" rx="46" ry="40" fill="#ffd93b" opacity="0.12"/>
    <path d="M46 96 q 24 -26 48 0 l -6 34 q -18 8 -36 0 Z" fill="#f2b04a" stroke="#8a5a22" stroke-width="3"/>
    <rect x="66" y="130" width="8" height="26" fill="#8a5a22"/>
  </svg>`
}
// Market stall for the card shop: tent top + counter.
function _gmMarketSvg() {
  const bg = _gmV('bg-market', 'bg-market')
  if (bg) return `<svg class="gm-world" viewBox="0 0 400 820" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><image href="${bg}" width="400" height="820" preserveAspectRatio="xMidYMax slice"/></svg>`
  return `<svg class="gm-world" viewBox="0 0 400 560" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
    <defs><linearGradient id="gmMktSky" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#79c7f2"/><stop offset="100%" stop-color="#b8e6fa"/></linearGradient></defs>
    <rect width="400" height="470" fill="url(#gmMktSky)"/>
    <rect y="470" width="400" height="90" fill="#4ea82e"/>
    <g class="gm-cloud gm-cloud-a" fill="#fff" opacity="0.9"><ellipse cx="120" cy="70" rx="30" ry="14"/><ellipse cx="146" cy="63" rx="22" ry="12"/></g>
    <g>${[0,1,2,3,4,5,6,7].map(i => `<path d="M${i*50} 8 L${i*50+50} 8 L${i*50+42} 78 Q${i*50+25} 94 ${i*50+8} 78 Z" fill="${i%2 ? '#6d28d9' : '#f6f2ea'}" stroke="#4c1d95" stroke-width="2.5"/>`).join('')}</g>
    <rect x="14" y="8" width="10" height="440" fill="#8a5a22" stroke="#5f3d17" stroke-width="2"/>
    <rect x="376" y="8" width="10" height="440" fill="#8a5a22" stroke="#5f3d17" stroke-width="2"/>
    <rect x="0" y="440" width="400" height="34" rx="8" fill="#a96e2c" stroke="#5f3d17" stroke-width="3"/>
  </svg>`
}

// ── The dispatcher: builds the active screen once, then patches live numbers ──
function _updateGameMode() {
  const ov = document.getElementById('gameModeOverlay')
  if (!ov) return
  if (!_gameMode || !_isMobView()) { if (ov.style.display !== 'none') { ov.style.display = 'none'; ov.innerHTML = ''; delete ov.dataset.screen; _gmLastMood = null; _gmCardsBuilt = false } return }

  const stats  = computeAcctStats(state.perpState, state.spotState, state.fills, state.portfolio)
  const hasPos = (state.perpState?.assetPositions ?? []).some(p => parseFloat(p.position?.szi ?? 0) !== 0)
  const mood   = _mobPetState(stats.healthPct, hasPos)
  ov.style.display = 'block'

  // Deposit detector: the account value jumping between ticks (same account, no
  // position-PnL of that size in 5s) = food arrived → chomp chomp.
  if (_gmValAddr === state.addr && _gmLastVal != null) {
    const jump = stats.accountValue - _gmLastVal
    if (jump > 1 && stats.accountValue > 0) _gmEatAnim(jump)
  }
  _gmValAddr = state.addr
  if (stats.accountValue > 0) _gmLastVal = stats.accountValue

  if (_gmScreen === 'feed')       { _gmFeedScreen(ov, stats, mood) }
  else if (_gmScreen === 'list')  { _gmListScreen(ov, mood) }
  else if (_gmScreen === 'trade') { _gmTradeScreen(ov, mood) }
  else                            { _gmHomeScreen(ov, stats, hasPos, mood) }
}

function _gmSetPet(mood, size = 190, cls = '') {
  const pet = document.getElementById('gmPet')
  if (!pet) return
  if (mood !== _gmLastMood || !pet.innerHTML) {
    _gmLastMood = mood
    pet.className = 'gm-pet ' + cls
    // Painted pet if the asset shipped (pet-<species>-<mood>.png), else SVG.
    const img = _gmV(`pet-${_gmGetSpecies()}-${mood}`, 'pet')
    const art = img
      ? `<img src="${img}" width="${size}" alt="" draggable="false" style="display:block;filter:drop-shadow(0 0 22px ${_PET_STATES[mood].color}55) drop-shadow(0 8px 10px rgba(0,0,0,0.45))">`
      : _gmPetSvg(_gmGetSpecies(), mood).replace('width="108" height="112"', `width="${size}" height="${Math.round(size * 112 / 108)}"`)
    // Idle animation lives on an INNER wrapper so dragging can freely transform
    // the outer element without fighting the keyframes.
    pet.innerHTML = `<div class="gm-pet-inner ${mood === 'critical' ? 'pet-shake' : 'pet-bob'}">${art}</div>`
    if (_gmScreen === 'home') {
      pet.style.transition = 'none'
      pet.style.transform = `translate(${_gmPetOff.x}px, ${_gmPetOff.y}px)`
    }
  }
}

// ── Grab & drag the pet (Beat-the-Boss style) + swipe-to-switch-account ──────
const _gmPetOff = { x: 0, y: 0 }   // where the pet was dropped (home screen)
function _gmWireGestures() {
  const ov = document.getElementById('gameModeOverlay')
  if (!ov || ov._wired) return
  ov._wired = true
  let sx = 0, sy = 0, t0 = 0, grabbed = null, baseX = 0, baseY = 0, moved = false, lastTap = 0
  ov.addEventListener('pointerdown', e => {
    sx = e.clientX; sy = e.clientY; t0 = Date.now(); moved = false
    const pet = _gmScreen === 'home' ? e.target.closest('#gmPet') : null
    if (pet) {
      grabbed = pet; baseX = _gmPetOff.x; baseY = _gmPetOff.y
      pet.classList.add('gm-grabbed')
      try { ov.setPointerCapture(e.pointerId) } catch {}
      e.preventDefault()
    } else grabbed = null
  })
  ov.addEventListener('pointermove', e => {
    if (!grabbed) return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) + Math.abs(dy) > 6) moved = true
    _gmPetOff.x = baseX + dx; _gmPetOff.y = baseY + dy
    grabbed.style.transition = 'none'
    grabbed.style.transform = `translate(${_gmPetOff.x}px, ${_gmPetOff.y}px)`
  })
  ov.addEventListener('pointerup', e => {
    if (grabbed) {
      grabbed.classList.remove('gm-grabbed')
      if (!moved && Date.now() - t0 < 350) {
        // tap = poke · double-tap = swap companion
        const now = Date.now()
        if (now - lastTap < 320) { lastTap = 0; window.__gmSwapPet(1) }
        else { lastTap = now; window.__gmPokePet() }
      } else {
        // Drop: clamp inside the room, fall back to the rug with a bounce.
        const maxX = Math.max(60, ov.clientWidth / 2 - 70)
        _gmPetOff.x = Math.max(-maxX, Math.min(maxX, _gmPetOff.x))
        _gmPetOff.y = 0
        grabbed.style.transition = 'transform 0.55s cubic-bezier(0.34, 1.6, 0.5, 1)'
        grabbed.style.transform = `translate(${_gmPetOff.x}px, 0px)`
      }
      grabbed = null
      return
    }
    // Elsewhere on the home screen: a horizontal swipe flips to the next account.
    if (_gmScreen !== 'home') return
    const dx = e.clientX - sx, dy = e.clientY - sy
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2.2 * Math.abs(dy)) _gmSwitchAccount(dx < 0 ? 1 : -1)
  })
}

// Swipe → cycle through the saved recent accounts. Each account brings its own
// pet, skins and (of course) data — the room literally changes owners.
function _gmSwitchAccount(dir) {
  let list = []
  try { list = JSON.parse(localStorage.getItem('hliq_recent_addrs') || '[]') } catch {}
  list = list.filter(a => typeof a === 'string' && a.startsWith('0x'))
  if (list.length < 2) { window.__gmSoon('👤 Save another account to swipe between rooms!'); return }
  const cur = (state.addr || '').toLowerCase()
  let i = list.findIndex(a => a.toLowerCase() === cur)
  if (i < 0) i = 0
  const next = list[(i + dir + list.length) % list.length]
  if (next.toLowerCase() === cur) return
  window.__gmSoon(`🚪 Heading to ${next.slice(0, 6)}…${next.slice(-4)}'s room`)
  _gmPetOff.x = 0; _gmPetOff.y = 0
  setTimeout(() => window.__quickLoad?.(next), 250)
}

// ── HOME ──────────────────────────────────────────────────────────────────────
function _gmHomeScreen(ov, stats, hasPos, mood) {
  if (ov.dataset.screen !== 'home') {
    ov.dataset.screen = 'home'
    ov.innerHTML = `
      ${_gmWorldSvg()}
      ${_gmChrome('', false)}
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet" id="gmPet"></div>`
    _gmLastMood = null
    if (!_mktCtxReady) _ensureMarketData().catch(() => {})   // billboard 24h% data
    _gmWireGestures()   // drag the pet, swipe to switch accounts
  }
  // ── Player HUD: mini pet avatar, account name, HP bar, coins ──
  const ava = document.getElementById('gmHudAva')
  if (ava) ava.innerHTML = _gmPetSvg(_gmGetSpecies(), mood).replace('width="108" height="112"', 'width="40" height="41"')
  const nameEl = document.getElementById('gmHudName')
  if (nameEl) {
    const a = state.addr || ''
    nameEl.textContent = (typeof WM !== 'undefined' && WM.getLabel?.(a)) || (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—')
  }
  const hp = document.getElementById('gmHudHp')
  if (hp) {
    const pct = hasPos ? Math.max(4, Math.min(100, stats.healthPct || 0)) : 100
    hp.style.width = pct + '%'
    hp.style.background = pct > 60 ? 'linear-gradient(90deg,#35c97e,#7fdcae)' : pct > 30 ? 'linear-gradient(90deg,#f5a623,#ffd93b)' : 'linear-gradient(90deg,#f0597a,#ff8aa0)'
  }
  const coins = document.getElementById('gmCoins')
  if (coins) coins.textContent = _privacyMode ? '•••••' : fmtUSD(stats.accountValue, 0)

  // The desk monitor is a live terminal: chart TYPE (VALUE / ACCUM / REALZD) ×
  // TIMEFRAME (1D / 1W / 1M / ALL), a Δ line for the period, uPnL, and privacy.
  const port = (state.portfolio ?? []).find(p => p[0] === _gmMonTf)?.[1]
             ?? (state.portfolio ?? []).find(p => p[0] === 'allTime')?.[1]
  const _tfMs = { day: 864e5, week: 7 * 864e5, month: 30 * 864e5 }[_gmMonTf] ?? Infinity
  let series = [], big = '', bigColor = '#f4f6ff'
  if (_gmMonType === 'accum') {
    series = (port?.pnlHistory ?? []).map(h => parseFloat(h[1]))
    const last = series.length ? series[series.length - 1] : 0
    big = (last >= 0 ? '+' : '−') + '$' + (_privacyMode ? '•••' : fmtUSD(Math.abs(last), 0))
    bigColor = last >= 0 ? '#35c97e' : '#f0597a'
  } else if (_gmMonType === 'realized') {
    const cutoff = Date.now() - _tfMs
    let acc = 0
    series = (state.fills ?? []).filter(f => f.time >= cutoff).sort((a, b) => a.time - b.time).map(f => (acc += (f.closedPnl || 0)))
    big = (acc >= 0 ? '+' : '−') + '$' + (_privacyMode ? '•••' : fmtUSD(Math.abs(acc), 0))
    bigColor = acc >= 0 ? '#35c97e' : '#f0597a'
  } else {
    series = (port?.accountValueHistory ?? []).map(h => parseFloat(h[1]))
    big = _privacyMode ? '•••••' : '$' + fmtUSD(stats.accountValue, 0)
  }
  // Downsample long series to ~48 points so the polyline stays light
  if (series.length > 48) {
    const step = series.length / 48
    series = Array.from({ length: 48 }, (_, i) => series[Math.floor(i * step)])
  }
  const mv = document.getElementById('gmMonVal')
  if (mv) { mv.textContent = big; mv.setAttribute('fill', bigColor) }
  // Δ over the selected period ($ and %)
  const md = document.getElementById('gmMonDelta')
  if (md) {
    if (series.length >= 2 && series[0] !== 0) {
      const d = series[series.length - 1] - series[0]
      const pct = Math.abs(series[0]) > 0 ? d / Math.abs(series[0]) * 100 : 0
      const tfLbl = { day: '24h', week: '7d', month: '30d', allTime: 'all' }[_gmMonTf]
      md.textContent = `Δ ${tfLbl}: ${d >= 0 ? '+' : '−'}$${_privacyMode ? '•••' : fmtUSD(Math.abs(d))} (${d >= 0 ? '+' : ''}${pct.toFixed(1)}%)`
      md.setAttribute('fill', d >= 0 ? '#35c97e' : '#f0597a')
    } else { md.textContent = 'Δ —'; md.setAttribute('fill', '#8a93a8') }
  }
  const mp = document.getElementById('gmMonPnl')
  if (mp) {
    const uPnl = stats.unrealizedPnl || 0
    mp.textContent = hasPos ? `uPnL ${uPnl >= 0 ? '+' : '−'}$${_privacyMode ? '•••' : fmtUSD(Math.abs(uPnl))} · lev ${stats.accountLeverage > 0 ? stats.accountLeverage.toFixed(1) + 'x' : '—'}` : 'no open risk'
    mp.setAttribute('fill', !hasPos ? '#8a93a8' : uPnl >= 0 ? '#35c97e' : '#f0597a')
  }
  const spark = document.getElementById('gmMonSpark')
  if (spark && series.length >= 2) {
    const min = Math.min(...series), max = Math.max(...series), rng = (max - min) || 1
    // chart area: x 114..286, y 382..414 (button rows live below)
    const pts = series.map((v, i) => `${(114 + i / (series.length - 1) * 172).toFixed(1)},${(414 - (v - min) / rng * 32).toFixed(1)}`).join(' ')
    spark.setAttribute('points', pts)
    spark.setAttribute('stroke', series[series.length - 1] >= series[0] ? '#35c97e' : '#f0597a')
  } else if (spark) spark.setAttribute('points', '')
  // Active buttons (type row + timeframe row) + privacy eye
  for (const t of ['value', 'accum', 'realized']) {
    const b = document.getElementById('gmMonBtn-' + t), tx = document.getElementById('gmMonBtnT-' + t)
    if (b)  { b.setAttribute('fill', t === _gmMonType ? '#1e3050' : '#0f1d2e'); b.setAttribute('stroke', t === _gmMonType ? '#7cc4ff' : '#2f3a55') }
    if (tx) tx.setAttribute('fill', t === _gmMonType ? '#cfe4ff' : '#8a93a8')
  }
  for (const tf of ['day', 'week', 'month', 'allTime']) {
    const b = document.getElementById('gmMonTf-' + tf), tx = document.getElementById('gmMonTfT-' + tf)
    if (b)  { b.setAttribute('fill', tf === _gmMonTf ? '#1e3050' : '#0f1d2e'); b.setAttribute('stroke', tf === _gmMonTf ? '#7cc4ff' : '#2f3a55') }
    if (tx) tx.setAttribute('fill', tf === _gmMonTf ? '#cfe4ff' : '#8a93a8')
  }
  const pv = document.getElementById('gmMonPrivIc')
  if (pv) pv.textContent = _privacyMode ? '🙈' : '👁'

  // City billboard: rotates through the watchlist (name · price · 24h%), one
  // asset every ~4s — falls back to the majors if the watchlist is empty.
  const nowTs = Date.now()
  if (nowTs - _gmBillTs > 4000) { _gmBillTs = nowTs; _gmBillIdx++ }
  const wl    = (loadWatchlist() || []).map(w => typeof w === 'string' ? w : w?.coin).filter(Boolean)
  const bills = wl.length ? wl : ['BTC', 'ETH', 'SOL', 'HYPE']
  const bCoin = bills[_gmBillIdx % bills.length]
  const bEl   = document.getElementById('gmBillCoin')
  if (bEl && bCoin) {
    const px  = parseFloat(state.allMids?.[bCoin] ?? 0)
    const chg = _mktCtxMap?.[bCoin]?.change24
    bEl.textContent = coinLabel(bCoin)
    const pxEl = document.getElementById('gmBillPx')
    if (pxEl) pxEl.textContent = px > 0 ? '$' + fmtPrice(px) : '…'
    const chEl = document.getElementById('gmBillChg')
    if (chEl) {
      if (Number.isFinite(chg)) {
        chEl.textContent = `${chg >= 0 ? '▲' : '▼'} ${Math.abs(chg).toFixed(2)}%`
        chEl.setAttribute('fill', chg >= 0 ? '#35c97e' : '#f0597a')
      } else { chEl.textContent = '· · ·'; chEl.setAttribute('fill', '#8a93a8') }
    }
  }
  _gmSetPet(mood, 190)
}

// Cycle this account's companion — triggered by DOUBLE-TAPPING the pet.
window.__gmSwapPet = function(dir) {
  const next = _GM_SPECIES[(_GM_SPECIES.indexOf(_gmGetSpecies()) + dir + _GM_SPECIES.length) % _GM_SPECIES.length]
  _gmSetSpecies(next)
  _gmLastMood = null                       // force pet redraw
  _updateGameMode()
  const bub = document.getElementById('gmBubble')
  if (bub) {
    bub.textContent = `${_GM_NAMES[next]} reporting for duty!`
    bub.classList.add('show'); clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2000)
  }
}

window.__gmSoon = function(msg) {
  const bub = document.getElementById('gmBubble')
  if (bub) {
    bub.textContent = msg || '🚧 Under construction!'
    bub.classList.add('show'); clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2200)
  }
}

// ── FEED: the food shop. Each dish = a real USDC deposit amount ───────────────
const _GM_FOODS = [
  { ic: '🍎', usd: 10,  plate: '#7cc4ff', as: 'food-apple'  },
  { ic: '🍕', usd: 20,  plate: '#9edb7a', as: 'food-pizza'  },
  { ic: '🍔', usd: 50,  plate: '#b98aff', as: 'food-burger' },
  { ic: '🎂', usd: 100, plate: '#ffd93b', as: 'food-cake'   },
]
function _gmFeedScreen(ov, stats, mood) {
  if (ov.dataset.screen !== 'feed') {
    ov.dataset.screen = 'feed'
    ov.innerHTML = `
      ${_gmShopSvg()}
      ${_gmChrome('Food Shop', true)}
      <div class="gm-feed-hint gm-outline">Pick a snack — it's a real USDC deposit!</div>
      <div class="gm-food-row">
        ${[..._GM_FOODS, { ic: '🍱', usd: 0, plate: '#ff9db0', as: 'food-bento' }].map(f => {
          const im = _gmV(f.as, 'food')
          return `<button class="gm-food" onclick="window.__gmFeedPick(${f.usd})">
            ${im ? `<img class="gm-food-img" src="${im}" alt="" draggable="false">`
                 : `<span class="gm-food-ic">${f.ic}</span><span class="gm-plate" style="background:${f.plate}"></span>`}
            <span class="gm-food-tag gm-outline">${f.usd ? '$' + f.usd : '$…'}</span>
          </button>`
        }).join('')}
      </div>
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet gm-pet-feed" id="gmPet" onclick="window.__gmPokePet()"></div>
      <div class="gm-feed-bal"><span class="gm-outline" id="gmFeedBal">—</span></div>`
    _gmLastMood = null
  }
  const bal = document.getElementById('gmFeedBal')
  if (bal) bal.textContent = 'Balance: ' + (_privacyMode ? '•••••' : '$' + fmtUSD(stats.accountValue, 0))
  _gmSetPet(mood, 150)
}

window.__gmFeedPick = function(usd) {
  if (!usd) {
    const v = parseFloat(prompt('How much USDC should we feed?') || 0)
    if (!(v > 0)) return
    usd = v
  }
  // Open the REAL deposit sheet (z 9000 — sits above the game) with the amount
  // prefilled. When the deposit lands on-chain the value-jump detector plays the
  // eating animation, so the chomp only happens on real food.
  window.mobVDeposit?.()
  setTimeout(() => {
    const inp = document.getElementById('depositAmount')
    if (inp) { inp.value = usd; window.__updateDepositPreview?.() }
  }, 60)
  const bub = document.getElementById('gmBubble')
  if (bub) {
    bub.textContent = 'Ooh!! Is that for me?? 🤤'
    bub.classList.add('show'); clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2400)
  }
}

// Deposit landed → food falls to the pet, big chomp, happy bubble.
function _gmEatAnim(amount) {
  const ov = document.getElementById('gameModeOverlay')
  const pet = document.getElementById('gmPet')
  if (!ov || !pet || ov.style.display === 'none') return
  const food = document.createElement('div')
  food.className = 'gm-fall-food'
  food.textContent = _GM_FOODS[Math.floor(Math.random() * _GM_FOODS.length)].ic
  ov.appendChild(food)
  setTimeout(() => {
    food.remove()
    const _pi = pet.firstElementChild || pet; _pi.classList.remove('gm-boing'); void _pi.offsetWidth
    _pi.classList.add('gm-boing')
    const bub = document.getElementById('gmBubble')
    if (bub) {
      bub.textContent = `YUM!! +$${fmtUSD(amount)} 😋`
      bub.classList.add('show'); clearTimeout(bub._t)
      bub._t = setTimeout(() => bub.classList.remove('show'), 3000)
    }
  }, 950)
}

// ── LIST: the pet studies your open orders on a corkboard; edits = rewriting ──
function _gmListScreen(ov, mood) {
  if (ov.dataset.screen !== 'list') {
    ov.dataset.screen = 'list'
    ov.innerHTML = `
      ${_gmRoomSvg()}
      ${_gmChrome('The List', true)}
      <div class="gm-board">
        <div class="gm-board-pin"></div><div class="gm-board-pin gm-board-pin-r"></div>
        <div class="gm-board-title">THE BOOK <span id="gmListPencil">✏️</span></div>
        <div class="gm-board-body" id="gmListBody"></div>
      </div>
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet gm-pet-list" id="gmPet" onclick="window.__gmPokePet()"></div>`
    _gmLastMood = null
  }
  _gmSetPet(mood, 120)

  const positions = (state.perpState?.assetPositions ?? []).filter(ap => parseFloat(ap.position?.szi ?? 0) !== 0)
  const orders    = state.openOrders ?? []

  // Live uPnL refresh on the existing rows (no rebuild — that would restart
  // animations and eat taps); the structural hash below decides full rewrites.
  positions.forEach((ap, i) => {
    const el = document.getElementById('gmpos-u-' + i)
    if (!el) return
    const u = parseFloat(ap.position?.unrealizedPnl ?? 0)
    el.textContent = `${u >= 0 ? '+' : '−'}$${fmtUSD(Math.abs(u))}`
    el.style.color = u >= 0 ? '#1d9e5f' : '#d33a56'
  })

  const hash = positions.map(ap => `${ap.position.coin}:${ap.position.szi}`).join('|') + '§' +
               orders.map(o => `${o.oid}:${o.sz}:${o.limitPx}`).join('|')
  if (hash === _gmOrdersHash) return
  const changed = _gmOrdersHash !== null
  _gmOrdersHash = hash

  const body = document.getElementById('gmListBody')
  if (body) {
    // ALL positions — each with mark, live uPnL and a real market-close button
    const posHtml = positions.length ? `<div class="gm-board-sec">— positions (${positions.length}) —</div>` + positions.map((ap, i) => {
      const p = ap.position, szi = parseFloat(p.szi ?? 0)
      const long = szi > 0
      const u    = parseFloat(p.unrealizedPnl ?? 0)
      const mark = parseFloat(state.allMids?.[p.coin] ?? 0)
      const lev  = p.leverage?.value ? ` ${p.leverage.value}x` : ''
      return `<div class="gm-order">
        <span class="gm-order-side" style="color:${long ? '#1d9e5f' : '#d33a56'}">${long ? 'LONG' : 'SHORT'}${lev}</span>
        <span class="gm-order-coin">${esc(_ocCoinLabel(p.coin))}</span>
        <span class="gm-order-px">${fmtSize(Math.abs(szi))} @ $${fmtPrice(parseFloat(p.entryPx ?? 0))}</span>
        <span class="gm-order-upnl" id="gmpos-u-${i}" style="color:${u >= 0 ? '#1d9e5f' : '#d33a56'}">${u >= 0 ? '+' : '−'}$${fmtUSD(Math.abs(u))}</span>
        <button class="gm-order-x" title="Market close" onclick="window._mobVClosePos(this,'${_jsStr(p.coin)}','${long ? 'LONG' : 'SHORT'}','${p.szi}','${mark}')">✕</button>
      </div>`
    }).join('') : ''
    // ALL orders — the board itself scrolls, so nothing gets cut off anymore
    const ordHtml = orders.length ? `<div class="gm-board-sec">— orders (${orders.length}) —</div>` + orders.map(o => {
      const isBuy = o.side === 'B'
      const px = parseFloat(o.triggerPx ?? 0) > 0 ? o.triggerPx : o.limitPx
      const kind = o.orderType?.startsWith('Take Profit') ? 'TP' : o.orderType?.startsWith('Stop') ? 'SL' : (o.isTrigger ? 'TRG' : '')
      return `<div class="gm-order">
        <span class="gm-order-side" style="color:${isBuy ? '#1d9e5f' : '#d33a56'}">${isBuy ? 'BUY' : 'SELL'}${kind ? ' ' + kind : ''}</span>
        <span class="gm-order-coin">${esc(_ocCoinLabel(o.coin))}</span>
        <span class="gm-order-px">${fmtSize(parseFloat(o.sz ?? 0))} @ $${fmtPrice(parseFloat(px ?? 0))}</span>
        <button class="gm-order-x" onclick="window.__gmCancel('${_jsStr(o.coin)}',${o.oid},this)">✕</button>
      </div>`
    }).join('') + (orders.length > 1 ? `<button class="gm-board-clear" onclick="window.__gmCancelAll(this)">🧹 Cancel all orders</button>` : '') : ''
    body.innerHTML = (posHtml + ordHtml) || '<div class="gm-order-empty">Flat book, empty list.<br>Nothing to rewrite~ 📝</div>'
  }
  if (changed) {
    // scribble: pencil wiggles + pet reacts, like it's rewriting the board
    const pencil = document.getElementById('gmListPencil')
    if (pencil) { pencil.classList.remove('gm-scribble'); void pencil.offsetWidth; pencil.classList.add('gm-scribble') }
    const bub = document.getElementById('gmBubble')
    if (bub) {
      bub.textContent = 'Rewriting the list… ✏️'
      bub.classList.add('show'); clearTimeout(bub._t)
      bub._t = setTimeout(() => bub.classList.remove('show'), 2000)
    }
  }
}

window.__gmCancel = async function(coin, oid, btn) {
  btn.disabled = true; btn.textContent = '…'
  try { await window.__cancelOrder(coin, oid, false, null) } catch {}
  _gmOrdersHash = null   // force list re-render next tick
  _updateGameMode()
}

window.__gmCancelAll = async function(btn) {
  const orders = (state.openOrders ?? []).slice()
  if (!orders.length) return
  if (!confirm(`Cancel all ${orders.length} open orders?`)) return
  btn.disabled = true; btn.textContent = 'Sweeping…'
  for (const o of orders) { try { await window.__cancelOrder(o.coin, o.oid, false, null) } catch {} }
  _gmOrdersHash = null
  _updateGameMode()
}

// ── TRADE: scrollable card shop — each card is a real market ──────────────────
function _gmTopMarkets() {
  return Object.entries(_mktCtxMap)
    .filter(([coin, c]) => c.volume > 0 && !coin.includes(':') && !coin.startsWith('@'))
    .sort((a, b) => b[1].volume - a[1].volume)
    .slice(0, 30)
}
function _gmTradeScreen(ov, mood) {
  if (ov.dataset.screen !== 'trade') {
    ov.dataset.screen = 'trade'
    ov.innerHTML = `
      ${_gmMarketSvg()}
      ${_gmChrome('Card Shop', true)}
      <input class="gm-card-search" id="gmCardSearch" placeholder="🔎 Search markets…" oninput="window.__gmCardFilter(this.value)">
      <div class="gm-cards" id="gmCards"><div class="gm-cards-loading gm-outline">Opening the shop…</div></div>
      <div class="gm-bubble" id="gmBubble"></div>
      <div class="gm-pet gm-pet-trade" id="gmPet" onclick="window.__gmPokePet()"></div>`
    _gmLastMood = null
    if (!_mktCtxReady) _ensureMarketData().then(() => { if (_gmScreen === 'trade') { _gmCardsBuilt = false; _updateGameMode() } })
  }
  _gmSetPet(mood, 110)
  _gmBuildCards()
  _gmPatchCards()
}

let _gmCardsBuilt = false
function _gmBuildCards() {
  const host = document.getElementById('gmCards')
  if (!host || !_mktCtxReady || _gmCardsBuilt) return
  const mkts = _gmTopMarkets()
  if (!mkts.length) return
  _gmCardsBuilt = true
  host.innerHTML = mkts.map(([coin, c]) => {
    const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
    return `<div class="gm-card" id="gmcard-${cid}" data-q="${esc(coinLabel(coin).toLowerCase())}" onclick="window.__gmCardTap('${_jsStr(coin)}')">
      <div class="gm-card-head">${_mobVCoinIcon(coin)}<span class="gm-card-name">${esc(coinLabel(coin))}</span></div>
      <div class="gm-card-px" id="gmpx-${cid}">$${fmtPrice(c.markPx)}</div>
      <div class="gm-card-chg ${c.change24 >= 0 ? 'up' : 'dn'}" id="gmchg-${cid}">${c.change24 >= 0 ? '▲' : '▼'} ${Math.abs(c.change24).toFixed(2)}%</div>
      <svg class="gm-card-spark" id="gmspark-${cid}" viewBox="0 0 100 34" preserveAspectRatio="none"></svg>
      <div class="gm-card-buy" id="gmbuy-${cid}" onclick="event.stopPropagation()">
        <div class="gm-card-meta">vol $${_fmtOcK(c.volume)} · fund ${(c.funding ?? 0).toFixed(4)}%</div>
        <div class="gm-card-amts">${[10, 25, 50, 100].map(u => `<button class="gm-card-amt" onclick="window.__gmCardAmt('${cid}',${u},this)">$${u}</button>`).join('')}
          <input class="gm-card-cust" id="gmcust-${cid}" type="number" min="0" placeholder="$…" inputmode="decimal" onclick="event.stopPropagation()">
        </div>
        <div class="gm-card-levs">${[1, 3, 5, 10, 20].map(l => `<button class="gm-card-lev${l === 1 ? ' on' : ''}" onclick="window.__gmCardLev('${cid}',${l},this)">${l}x</button>`).join('')}</div>
        <div class="gm-card-btns">
          <button class="gm-card-long"  onclick="window.__gmCardBuy('${_jsStr(coin)}','${cid}',true ,this)">LONG</button>
          <button class="gm-card-short" onclick="window.__gmCardBuy('${_jsStr(coin)}','${cid}',false,this)">SHORT</button>
        </div>
        <div class="gm-card-st" id="gmst-${cid}"></div>
      </div>
    </div>`
  }).join('')
  // Sparklines: 24h of 1h candles per card — fetched in small chunks so 30
  // cards don't burst-fire the rate limit at once.
  ;(async () => {
    for (let i = 0; i < mkts.length; i += 6) {
      await Promise.all(mkts.slice(i, i + 6).map(([coin]) => _gmDrawSpark(coin)))
      if (_gmScreen !== 'trade') return
    }
  })()
}

window.__gmCardFilter = function(q) {
  q = (q || '').toLowerCase().trim()
  document.querySelectorAll('#gmCards .gm-card').forEach(c => {
    c.style.display = !q || (c.dataset.q || '').includes(q) ? '' : 'none'
  })
}
window.__gmCardLev = function(cid, lev, btn) {
  const wrap = document.getElementById('gmbuy-' + cid)
  if (!wrap) return
  wrap.dataset.lev = lev
  wrap.querySelectorAll('.gm-card-lev').forEach(b => b.classList.remove('on'))
  btn.classList.add('on')
}
async function _gmDrawSpark(coin) {
  const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
  try {
    if (!_gmSparkCache[coin]) {
      _gmSparkCache[coin] = fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: Date.now() - 24 * 3600 * 1000, endTime: null } }),
      }).then(r => r.json())
    }
    const cs = await _gmSparkCache[coin]
    const el = document.getElementById('gmspark-' + cid)
    if (!el || !Array.isArray(cs) || cs.length < 2) return
    const vals = cs.map(k => parseFloat(k.c))
    const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1
    const pts = vals.map((v, i) => `${(i / (vals.length - 1) * 100).toFixed(1)},${(30 - (v - min) / rng * 26 + 2).toFixed(1)}`).join(' ')
    const up  = vals[vals.length - 1] >= vals[0]
    el.innerHTML = `<polyline points="${pts}" fill="none" stroke="${up ? '#1d9e5f' : '#d33a56'}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`
  } catch {}
}
function _gmPatchCards() {
  if (!_gmCardsBuilt) return
  for (const [coin, c] of _gmTopMarkets()) {
    const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
    const px  = parseFloat(state.allMids?.[coin] ?? c.markPx)
    const pxEl = document.getElementById('gmpx-' + cid)
    if (pxEl) pxEl.textContent = '$' + fmtPrice(px)
  }
}
window.__gmCardTap = function(coin) {
  const cid = coin.replace(/[^a-zA-Z0-9]/g, '_')
  const open = _gmCardCoin === coin
  document.querySelectorAll('.gm-card.open').forEach(c => c.classList.remove('open'))
  _gmCardCoin = open ? null : coin
  if (!open) document.getElementById('gmcard-' + cid)?.classList.add('open')
  document.getElementById('gmCards')?.classList.toggle('has-open', !open)
}
window.__gmCardAmt = function(cid, usd, btn) {
  const wrap = document.getElementById('gmbuy-' + cid)
  if (!wrap) return
  wrap.dataset.usd = usd
  wrap.querySelectorAll('.gm-card-amt').forEach(b => b.classList.remove('on'))
  btn.classList.add('on')
}
window.__gmCardBuy = async function(coin, cid, isBuy, btn) {
  const st   = document.getElementById('gmst-' + cid)
  if (!isConnected()) { window.__quickConnectAgent?.(); if (st) st.textContent = 'Connect agent key first!'; return }
  const wrap = document.getElementById('gmbuy-' + cid)
  const cust = parseFloat(document.getElementById('gmcust-' + cid)?.value)
  const usd  = cust > 0 ? cust : parseFloat(wrap?.dataset.usd || 25)
  const px   = parseFloat(state.allMids?.[coin] ?? _mktCtxMap[coin]?.markPx ?? 0)
  if (!(px > 0)) { if (st) st.textContent = 'No price — try again.'; return }
  const lev = parseFloat(wrap?.dataset.lev) || 1
  const sz  = (usd * lev) / px
  if (st) { st.textContent = 'Placing…'; st.style.color = '#5d6a8c' }
  btn.disabled = true
  try {
    const result   = await placeMarketOrder({ coin, isBuy, sz, markPrice: px, leverage: lev, isIsolated: state.isIsolated || false })
    const statuses = result?.response?.data?.statuses ?? []
    const filled   = statuses.find(x => x?.filled)?.filled
    if (filled) {
      if (st) { st.textContent = `✓ Got it! ${filled.totalSz} @ $${fmtPrice(parseFloat(filled.avgPx))}`; st.style.color = '#1d9e5f' }
      const bub = document.getElementById('gmBubble')
      if (bub) { bub.textContent = 'New card for the collection! 🃏'; bub.classList.add('show'); clearTimeout(bub._t); bub._t = setTimeout(() => bub.classList.remove('show'), 2600) }
    } else {
      const err = statuses.find(x => x?.error)?.error ?? 'rejected'
      if (st) { st.textContent = '✗ ' + err; st.style.color = '#d33a56' }
    }
  } catch (e) {
    if (st) { st.textContent = '✗ ' + e.message; st.style.color = '#d33a56' }
  } finally { btn.disabled = false }
}

window.__gmPokePet = function() {
  const pet = document.getElementById('gmPet')
  const bub = document.getElementById('gmBubble')
  if (pet) {
    const _pi2 = pet.firstElementChild || pet; _pi2.classList.remove('gm-boing'); void _pi2.offsetWidth   // restart animation
    _pi2.classList.add('gm-boing')
  }
  if (bub) {
    const qs = _GM_QUIPS[_gmLastMood || 'idle'] || _GM_QUIPS.idle
    bub.textContent = qs[Math.floor(Math.random() * qs.length)]
    bub.classList.add('show')
    clearTimeout(bub._t)
    bub._t = setTimeout(() => bub.classList.remove('show'), 2600)
  }
}

function _mobVRenderBalance() {
  const balEl    = document.getElementById('mobVBalance')
  const changeEl = document.getElementById('mobVChange')
  if (!balEl || !state.perpState) return

  const allTimePort = (state.portfolio ?? []).find(p => p[0] === 'allTime')
  const hist        = allTimePort?.[1]?.accountValueHistory ?? []

  const _petHasPos = (state.perpState?.assetPositions ?? []).some(p => parseFloat(p.position?.szi ?? 0) !== 0)

  // Wait for portfolio before showing a value — avoids flashing perp-only number
  if (!hist.length) {
    balEl.innerHTML = '<span style="color:var(--muted)">—</span>'
    if (changeEl) changeEl.textContent = ''
    // Health needs only perpState, so keep Solvi alive even before the portfolio lands.
    _mobVRenderPet(computeAcctStats(state.perpState, state.spotState, state.fills, state.portfolio).healthPct, _petHasPos)
    return
  }

  const { accountValue: val, healthStr, healthCls, healthPct, accountLeverage, withdrawable, maintMargin, unrealizedPnl } = computeAcctStats(state.perpState, state.spotState, state.fills, state.portfolio)
  _mobVRenderPet(healthPct, _petHasPos)

  // Format: $XX,XXX.XX — split cents dim
  const whole = Math.floor(val)
  const cents = (val % 1).toFixed(2).slice(1) // ".XX"
  balEl.innerHTML = _privacyMode
    ? `<span style="letter-spacing:4px;color:var(--muted)">•••••</span>`
    : `$${fmtUSD(whole, 0)}<span style="color:var(--muted)">${cents}</span>`

  // Today's change → colored pill ( ▲/▼  $X · Y% today )
  if (changeEl) {
    if (hist.length >= 2) {
      const todayStart = Date.now() - 86400000
      const prev = hist.find(([ts]) => ts >= todayStart)?.[1] ?? hist[0][1]
      const diff = val - parseFloat(prev)
      const pct  = parseFloat(prev) > 0 ? diff / parseFloat(prev) * 100 : 0
      const up   = diff >= 0
      changeEl.style.cssText = `display:inline-flex;align-items:center;gap:5px;padding:4px 9px;border-radius:8px;font-size:12px;font-weight:600;margin-top:7px;background:${up ? 'rgba(0,229,160,0.12)' : 'rgba(255,77,109,0.14)'};color:${up ? 'var(--green)' : 'var(--red)'}`
      changeEl.textContent = _privacyMode ? '••• today' : `${up ? '▲' : '▼'} $${fmtUSD(Math.abs(diff))} · ${Math.abs(pct).toFixed(2)}% today`
    } else {
      changeEl.style.display = 'none'
    }
  }

  // Health → percent + liq-risk label + knob position on the gradient bar
  const hBlk = document.getElementById('mobVHealthBlock')
  if (hBlk) {
    if (healthStr && healthStr !== '—') {
      const pc = Math.max(0, Math.min(100, healthPct || 0))
      hBlk.style.display = ''
      const hp = document.getElementById('mobVHealthPct')
      const hr = document.getElementById('mobVHealthRisk')
      const hk = document.getElementById('mobVHealthKnob')
      if (hp) { hp.textContent = healthStr; hp.className = healthCls }
      if (hr) hr.textContent = pc > 60 ? 'Low liq. risk' : pc > 30 ? 'Medium liq. risk' : 'High liq. risk'
      if (hk) hk.style.left = pc.toFixed(1) + '%'
    } else {
      hBlk.style.display = 'none'
    }
  }

  // Stats row — leverage is a ratio (not masked); free margin + maint respect privacy.
  const upEl = document.getElementById('mobVUnrealPnl')
  if (upEl) {
    upEl.textContent = _privacyMode ? '•••' : (unrealizedPnl >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(unrealizedPnl))
    upEl.style.color = unrealizedPnl > 0 ? 'var(--green)' : unrealizedPnl < 0 ? 'var(--red)' : ''
  }
  const levEl = document.getElementById('mobVLeverage')
  if (levEl) levEl.textContent = accountLeverage > 0 ? accountLeverage.toFixed(2) + 'x' : '—'
  const fmEl = document.getElementById('mobVFreeMargin')
  if (fmEl) fmEl.textContent = _prv('$' + fmtUSD(withdrawable))
  const mmEl = document.getElementById('mobVMaintMargin')
  if (mmEl) mmEl.textContent = _prv(maintMargin > 0 ? '$' + fmtUSD(maintMargin) : '—')

  _mobVDrawSpark()
}

function _mobVPortHeroHtml(hist, vals, idx) {
  const val  = vals[idx]
  const ts   = hist[idx][0]
  const date = new Date(+ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const isLatest = idx === vals.length - 1
  if (_mobVPortChartType === 'value') {
    const base = vals[0]
    const diff = val - base
    const pct  = base > 0 ? diff / base * 100 : 0
    const sign = diff >= 0 ? '+' : '-'
    const cls  = diff >= 0 ? 'pos' : 'neg'
    return `<div style="font-size:22px;font-weight:700;color:var(--fg)">${_prv('$' + fmtUSD(val))}</div><div style="font-size:13px;margin-top:2px" class="${cls}">${_prv(sign + '$' + fmtUSD(Math.abs(diff)) + ' (' + sign + Math.abs(pct).toFixed(2) + '%)')}</div>${!isLatest ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${date}</div>` : ''}`
  } else {
    const sign = val >= 0 ? '+' : '-'
    const cls  = val >= 0 ? 'pos' : 'neg'
    return `<div style="font-size:22px;font-weight:700" class="${cls}">${_prv(sign + '$' + fmtUSD(Math.abs(val)))}</div>${!isLatest ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${date}</div>` : ''}`
  }
}

function _mobVDrawPortCanvas(canvas, crosshairIdx) {
  const d = _mobVPortChartData
  if (!d) return
  const { pts, vals, hist, W, H, isUp, color, dpr, min, max, range, padY } = d
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  const smoothPath = (p) => {
    ctx.moveTo(p[0][0], p[0][1])
    for (let i = 0; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2
      const my = (p[i][1] + p[i + 1][1]) / 2
      ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my)
    }
    ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1])
  }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, isUp ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,109,0.22)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.beginPath()
  ctx.moveTo(pts[0][0], H)
  smoothPath(pts)
  ctx.lineTo(pts.at(-1)[0], H)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  // Zero line for pnl/realized charts when values cross zero
  if (_mobVPortChartType !== 'value' && min < 0 && max > 0) {
    const zeroY = H - padY - ((0 - min) / range) * (H - padY * 2)
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.lineWidth   = 1
    ctx.setLineDash([4, 4])
    ctx.moveTo(0, zeroY)
    ctx.lineTo(W, zeroY)
    ctx.stroke()
    ctx.setLineDash([])
  }

  // Chart line
  ctx.beginPath()
  smoothPath(pts)
  ctx.strokeStyle = color
  ctx.lineWidth   = 1.8
  ctx.lineJoin    = 'round'
  ctx.lineCap     = 'round'
  ctx.stroke()

  // Y-axis labels
  const labelW = 52
  ctx.font      = '10px system-ui, sans-serif'
  ctx.textAlign = 'right'
  ctx.fillStyle = 'rgba(255,255,255,0.35)'
  const fmtAxisVal = v => Math.abs(v) >= 1000 ? (v >= 0 ? '' : '-') + '$' + fmtUSD(Math.abs(v), 0) : (v >= 0 ? '' : '-') + '$' + Math.abs(v).toFixed(2)
  ctx.fillText(fmtAxisVal(max), W - 3, padY + 9)
  ctx.fillText(fmtAxisVal(min), W - 3, H - padY - 2)

  // Crosshair
  if (crosshairIdx >= 0 && crosshairIdx < pts.length) {
    const cp = pts[crosshairIdx]
    ctx.beginPath()
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'
    ctx.lineWidth   = 1
    ctx.setLineDash([3, 3])
    ctx.moveTo(cp[0], padY)
    ctx.lineTo(cp[0], H - padY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.shadowColor = color
    ctx.shadowBlur  = 8
    ctx.beginPath()
    ctx.arc(cp[0], cp[1], 4, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.shadowBlur = 0
  } else {
    // Live dot at end
    const lp = pts[pts.length - 1]
    ctx.shadowColor = color
    ctx.shadowBlur  = 8
    ctx.beginPath()
    ctx.arc(lp[0], lp[1], 3, 0, Math.PI * 2)
    ctx.fillStyle = color
    ctx.fill()
    ctx.shadowBlur = 0
  }
}

function _mobVPortTouchMove(e) {
  e.preventDefault()
  if (!_mobVPortChartData) return
  const { pts, vals, hist } = _mobVPortChartData
  const canvas = document.getElementById('mobVPortChart')
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.touches[0].clientX - rect.left
  let minDist = Infinity, nearestIdx = 0
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(pts[i][0] - x)
    if (d < minDist) { minDist = d; nearestIdx = i }
  }
  _mobVDrawPortCanvas(canvas, nearestIdx)
  const heroEl = document.getElementById('mobVPortHero')
  if (heroEl) heroEl.innerHTML = _mobVPortHeroHtml(hist, vals, nearestIdx)
}

function _mobVPortTouchEnd() {
  _mobVDrawPortChart()
}

function _mobVDrawPortChart() {
  const canvas = document.getElementById('mobVPortChart')
  if (!canvas) return
  const periodKey = { '1D': 'day', '7D': 'week', '1M': 'month', 'allTime': 'allTime' }[_mobVPortPeriod] ?? 'allTime'
  const portEntry = (state.portfolio ?? []).find(p => p[0] === periodKey)
  const heroEl    = document.getElementById('mobVPortHero')
  let hist = []

  if (_mobVPortChartType === 'value') {
    hist = portEntry?.[1]?.accountValueHistory ?? []
  } else if (_mobVPortChartType === 'pnl') {
    hist = portEntry?.[1]?.pnlHistory ?? []
  } else {
    // realized: bucket fills into period pnlHistory timestamps, cumulative sum
    const pnlHist = portEntry?.[1]?.pnlHistory ?? []
    const buckets = pnlHist.map(p => +p[0])
    if (buckets.length >= 2) {
      const cutoffMs = { '1D': 86400000, '7D': 7 * 86400000, '1M': 30 * 86400000 }[_mobVPortPeriod]
      const cutoffTs = cutoffMs ? Date.now() - cutoffMs : 0
      const fills    = (state.fills ?? []).filter(f => !cutoffTs || f.time >= cutoffTs)
      const bucketPnl = new Array(buckets.length).fill(0)
      for (const f of fills) {
        if (!f.closedPnl) continue
        let idx = buckets.findIndex((ts, j) => ts > f.time || j === buckets.length - 1)
        if (idx < 0) idx = buckets.length - 1
        bucketPnl[idx] += f.closedPnl
      }
      let running = 0
      hist = buckets.map((ts, i) => [ts, (running += bucketPnl[i]).toString()])
    }
  }

  if (heroEl) {
    if (hist.length >= 2) {
      heroEl.innerHTML = _mobVPortHeroHtml(hist, hist.map(h => parseFloat(h[1])), hist.length - 1)
    } else {
      heroEl.innerHTML = `<div style="color:var(--muted);font-size:13px">No data for period</div>`
    }
  }

  if (hist.length < 2) return

  const dpr      = window.devicePixelRatio || 1
  const rect     = canvas.getBoundingClientRect()
  const displayW = Math.round(rect.width) || 340
  const displayH = 140
  canvas.width        = displayW * dpr
  canvas.height       = displayH * dpr
  canvas.style.width  = displayW + 'px'
  canvas.style.height = displayH + 'px'
  const W = displayW, H = displayH

  const vals  = hist.map(h => parseFloat(h[1]))
  const min   = Math.min(...vals)
  const max   = Math.max(...vals)
  const range = max - min || 1
  const padY  = H * 0.12
  const pts   = vals.map((v, i) => [
    i / (vals.length - 1) * (W - 4),
    H - padY - ((v - min) / range) * (H - padY * 2),
  ])
  const lastV = vals.at(-1)
  const isUp  = _mobVPortChartType === 'value' ? lastV >= vals[0] : lastV >= 0
  const color = isUp ? '#00e5a0' : '#ff4d6d'

  _mobVPortChartData = { hist, pts, vals, W, H, isUp, color, dpr, min, max, range, padY }
  _mobVDrawPortCanvas(canvas, -1)

  // Bind touch handlers once per canvas instance
  if (!canvas._touchBound) {
    canvas._touchBound = true
    canvas.addEventListener('touchstart', _mobVPortTouchMove, { passive: false })
    canvas.addEventListener('touchmove',  _mobVPortTouchMove, { passive: false })
    canvas.addEventListener('touchend',   _mobVPortTouchEnd)
  }
}

const _mobVPortBtnStyle = (active) => `padding:4px 10px;border:1px solid var(--border2);border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;touch-action:manipulation;background:${active ? 'var(--panel-2)' : 'transparent'};color:${active ? 'var(--fg)' : 'var(--muted)'}`

window.mobVSetPortPeriod = function(p) {
  _mobVPortPeriod = p
  document.querySelectorAll('[data-port-period]').forEach(btn => {
    btn.style.cssText = _mobVPortBtnStyle(btn.dataset.portPeriod === p)
  })
  _mobVDrawPortChart()
}

window.mobVSetPortChartType = function(t) {
  _mobVPortChartType = t
  document.querySelectorAll('[data-port-type]').forEach(btn => {
    btn.style.cssText = _mobVPortBtnStyle(btn.dataset.portType === t)
  })
  _mobVDrawPortChart()
}

function _mobVDrawSpark() {
  const canvas = document.getElementById('mobVSpark')
  if (!canvas) return
  const allTime = (state.portfolio ?? []).find(p => p[0] === 'allTime')
  const hist    = (allTime?.[1]?.accountValueHistory ?? []).slice(-60)
  if (hist.length < 2) return

  const dpr = window.devicePixelRatio || 1
  const displayW = 140, displayH = 72
  canvas.width  = displayW * dpr
  canvas.height = displayH * dpr
  canvas.style.width  = displayW + 'px'
  canvas.style.height = displayH + 'px'
  const ctx = canvas.getContext('2d')
  ctx.scale(dpr, dpr)
  const W = displayW, H = displayH

  const vals  = hist.map(h => parseFloat(h[1]))
  const min   = Math.min(...vals), max = Math.max(...vals)
  const range = max - min || 1
  const padY  = H * 0.12
  const pts   = vals.map((v, i) => [
    i / (vals.length - 1) * W,
    H - padY - ((v - min) / range) * (H - padY * 2),
  ])

  const isUp  = vals[vals.length - 1] >= vals[0]
  const color = isUp ? '#00e5a0' : '#ff4d6d'

  const smoothPath = (p) => {
    ctx.moveTo(p[0][0], p[0][1])
    for (let i = 0; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i + 1][0]) / 2
      const my = (p[i][1] + p[i + 1][1]) / 2
      ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my)
    }
    ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1])
  }

  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, isUp ? 'rgba(0,229,160,0.4)' : 'rgba(255,77,109,0.4)')
  grad.addColorStop(0.7, isUp ? 'rgba(0,229,160,0.08)' : 'rgba(255,77,109,0.08)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.beginPath()
  ctx.moveTo(pts[0][0], H)
  smoothPath(pts)
  ctx.lineTo(pts[pts.length - 1][0], H)
  ctx.closePath()
  ctx.fillStyle = grad
  ctx.fill()

  ctx.beginPath()
  smoothPath(pts)
  ctx.strokeStyle = color
  ctx.lineWidth   = 2
  ctx.lineJoin    = 'round'
  ctx.lineCap     = 'round'
  ctx.stroke()

  const lp = pts[pts.length - 1]
  ctx.shadowColor = color
  ctx.shadowBlur  = 8
  ctx.beginPath()
  ctx.arc(lp[0], lp[1], 3, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
  ctx.shadowBlur = 0
}

window._mobVRenderContent = () => _mobVRenderContent()
function _mobVRenderContent() {
  const el = document.getElementById('mobVContent')
  if (!el) return

  const _pc = (state.perpState?.assetPositions ?? []).filter(p => parseFloat(p.position?.szi ?? 0) !== 0).length
  _updateMobTabCounts(_pc, state.openOrders?.length ?? 0)

  // Hide home-tab chrome (header/balance/actions/tabs) when trade OR settings is active
  // so those take the whole screen (bottom nav stays for getting back).
  const isTrade    = _mobVActiveTab === 'trade'
  const hideChrome = isTrade || _mobVActiveTab === 'settings'
  document.querySelectorAll('.mob-v-header, .mob-v-equity-card, .mob-v-actions, .mob-v-tabs, .mob-pet-card')
    .forEach(e => { e.style.display = hideChrome ? 'none' : '' })

  // In the trade DETAIL view the screen has its own Long/Short action bar at the
  // bottom — hide the fixed bottom nav so it doesn't cover it (back arrow returns).
  const inTradeDetail = isTrade && _mobTradeView === 'detail'
  document.querySelectorAll('.mob-v-bottom')
    .forEach(e => { e.style.display = inTradeDetail ? 'none' : '' })

  // Reset overrides that the trade tab applies to #mobVContent
  if (!isTrade) {
    el.style.overflow      = ''
    el.style.padding       = ''
    el.style.display       = ''
    el.style.flexDirection = ''
    el.style.minHeight     = ''
  }

  if (_mobVActiveTab === 'spot' || _mobVActiveTab === 'outcomes') {
    const bals = (state.spotState?.balances ?? []).filter(b => parseFloat(b.total) > 0)
    const isOutcome = c => typeof c === 'string' && (c[0] === '+' || c[0] === '#' || /^o\d/.test(c))
    const outcomes  = bals.filter(b => isOutcome(b.coin))
    const spots     = bals.filter(b => !isOutcome(b.coin))

    // ── Spot row (USDC, etc.) ────────────────────────────────────────────────
    const renderSpotRow = (b, id) => {
      const total = parseFloat(b.total ?? 0)
      const hold  = parseFloat(b.hold ?? 0)
      const avail = total - hold
      const px    = parseFloat(state.allMids?.[b.coin] ?? 0)
      const usd   = px > 0 ? total * px : (b.coin === 'USDC' ? total : 0)
      const xp    = _mobVExpandedIds.has(id)
      const chev  = `<svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
      return `<div>
        <div class="mob-v-row" style="cursor:pointer" onclick="window._mobVToggleRow('${id}')">
          ${_mobVCoinIcon(b.coin)}
          <div class="mob-v-row-info">
            <div class="mob-v-row-name">${esc(_ocCoinLabel(b.coin))}</div>
            <div class="mob-v-row-sub">${fmtSize(total)} ${esc(_ocCoinLabel(b.coin))}</div>
          </div>
          <div style="flex-shrink:0;width:74px;display:flex;flex-direction:column">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;line-height:1.2;text-align:center">Price</div>
            <div style="font-size:13px;font-weight:500;color:var(--fg);line-height:1.3;margin-top:2px;white-space:nowrap;text-align:center;overflow:hidden;text-overflow:ellipsis">${px > 0 ? '$' + fmtPrice(px) : b.coin === 'USDC' ? '$1.00' : '—'}</div>
          </div>
          <div class="mob-v-row-right" style="width:86px;flex-shrink:0;flex-grow:0">
            <div class="mob-v-row-val">${usd > 0 ? '$' + fmtUSD(usd) : '—'}</div>
          </div>
          ${chev}
        </div>
        <div id="mrd-${id}" style="display:${xp ? '' : 'none'}">${_mobVDetailGrid([
          ['Available', fmtSize(avail) + ' ' + esc(_ocCoinLabel(b.coin))],
          ['In Orders', hold > 0 ? fmtSize(hold) + ' ' + esc(_ocCoinLabel(b.coin)) : '—'],
          ['Price', px > 0 ? '$' + fmtPrice(px) : '—'],
          ['Value', usd > 0 ? '$' + fmtUSD(usd, 2) : '—'],
        ])}</div>
      </div>`
    }

    // ── Outcome holding row — displayed like a position (entry/mark/PnL/ROE) ──
    const renderOcRow = (b, id) => {
      const total = parseFloat(b.total ?? 0)
      const hold  = parseFloat(b.hold ?? 0)
      const cost  = parseFloat(b.entryNtl ?? 0)
      const n     = parseInt(String(b.coin).replace(/[^\d]/g, '')) || 0
      const oid   = Math.floor(n / 10), side = n % 10
      const entry = total > 0 ? cost / total : 0
      const fromBook  = _ocMarkCache[b.coin] || 0
      const fromPanel = _ocPrices?.[oid] ? (side === 0 ? _ocPrices[oid].yes : _ocPrices[oid].no) : 0
      const mark  = fromBook > 0 ? fromBook : (fromPanel > 0 ? fromPanel : entry)
      const value = total * mark
      const pnl   = (mark - entry) * total
      const roe   = cost > 0 ? pnl / cost * 100 : 0
      const cls   = pnl >= 0 ? 'pos' : 'neg'
      const nm    = _ocCoinLabel(b.coin)                       // "USA Yes"
      const sideLabel = nm.replace(/\s+/g, '-')                // "USA-Yes"
      const title = state.ocQuestionMap?.[oid] || nm           // "2026 World Cup Champion"
      const key   = String(n)
      // Card styling like a position: YES/NO badge by side, tint/border by P&L
      const sideTxt   = side === 0 ? 'YES' : 'NO'
      const sideColor = side === 0 ? '#00e5a0' : '#ff4d6d'
      const sideBg    = side === 0 ? 'rgba(0,229,160,0.15)' : 'rgba(255,77,109,0.15)'
      const accent    = pnl >= 0 ? '#00e5a0' : '#ff4d6d'
      const cardBg    = pnl >= 0
        ? 'linear-gradient(160deg, rgba(0,229,160,0.10), rgba(255,255,255,0.012) 60%)'
        : 'linear-gradient(160deg, rgba(255,77,109,0.10), rgba(255,255,255,0.012) 60%)'
      const xp    = _mobVExpandedIds.has(id)
      const chev  = `<svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
      const closePanel = `
        <div style="padding:2px 16px 14px;background:var(--panel-2);border-bottom:1px solid rgba(255,255,255,0.04)" onclick="event.stopPropagation()">
          <div style="display:flex;gap:6px;margin-bottom:6px">
            <div style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="font-size:10px;color:var(--muted)">Shares</span>
              <input id="ocsz-${id}" type="number" value="${Math.max(0, Math.floor(total - hold))}" style="background:var(--bg1);border:1px solid var(--border2);border-radius:7px;color:var(--fg);padding:7px;font-size:13px;width:100%"></div>
            <div style="flex:1;display:flex;flex-direction:column;gap:2px"><span style="font-size:10px;color:var(--muted)">Limit ¢/share</span>
              <input id="ocpx-${id}" type="number" step="0.1" value="${mark > 0 ? (mark * 100).toFixed(1) : ''}" style="background:var(--bg1);border:1px solid var(--border2);border-radius:7px;color:var(--fg);padding:7px;font-size:13px;width:100%"></div>
          </div>
          <div style="display:flex;gap:8px">
            <button onclick="window._mobOcClose('#${n}','limit','${id}',this)" style="flex:1;padding:8px;background:rgba(0,229,160,0.1);border:none;border-radius:8px;color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;touch-action:manipulation">Limit Close</button>
            <button onclick="window._mobOcClose('#${n}','market','${id}',this)" style="flex:1;padding:8px;background:rgba(255,77,109,0.1);border:none;border-radius:8px;color:var(--red);font-size:12px;font-weight:700;cursor:pointer;touch-action:manipulation">Market Close</button>
          </div>
          <button onclick="window.__openShareCard({coin:'${_jsStr(b.coin)}',title:'${_jsStr(title)}',side:'${sideTxt}',roePct:${roe.toFixed(2)},entry:'${(entry * 100).toFixed(2)}¢',mark:'${mark > 0 ? (mark * 100).toFixed(2) + '¢' : '—'}'})" style="width:100%;margin-top:8px;padding:8px;background:rgba(255,138,42,0.12);border:none;border-radius:8px;color:var(--accent);font-size:12px;font-weight:700;cursor:pointer;touch-action:manipulation">↗ Share PnL</button>
          <div id="ocst-${id}" style="font-size:11px;margin-top:6px;text-align:center"></div>
        </div>`
      return `<div style="margin:0 12px 8px;border-radius:14px;background:${cardBg};border:1px solid rgba(255,255,255,0.07);border-left:3px solid ${accent};overflow:hidden">
        <div style="padding:12px 14px;cursor:pointer" onclick="window._mobVToggleRow('${id}')">
          <div style="display:flex;align-items:center;gap:10px">
            ${_mobVCoinIcon(b.coin)}
            <div style="min-width:0;flex:1">
              <div style="display:flex;align-items:center;gap:7px">
                <span style="font-size:14px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(title)}</span>
                <span style="font-size:9.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:${sideBg};color:${sideColor};text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0">${sideTxt}</span>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">${fmtSize(total)} shares</div>
            </div>
            <div style="text-align:center;flex-shrink:0">
              <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px">Mark</div>
              <div id="ocmark-${key}" style="font-size:13px;font-weight:600;margin-top:2px">${mark > 0 ? (mark * 100).toFixed(2) + '¢' : '—'}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;min-width:62px">
              <div class="mob-v-row-val ${cls}" id="ocpnl-${key}" style="font-size:15px;font-weight:700;line-height:1.15">${(pnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(pnl))}</div>
              <div class="mob-v-row-pct ${cls}" id="ocroe-${key}" style="font-size:11px;font-weight:600;line-height:1.15;margin-top:1px">${(roe >= 0 ? '+' : '') + roe.toFixed(1)}%</div>
            </div>
            ${chev}
          </div>
        </div>
        <div id="mrd-${id}" style="display:${xp ? '' : 'none'}">${_mobVDetailGrid([
          ['Size', fmtSize(total) + ' ' + sideLabel],
          ['Position Value', '$' + fmtUSD(value, 2)],
          ['Entry Price', (entry * 100).toFixed(2) + '¢'],
          ['Mark Price', mark > 0 ? (mark * 100).toFixed(2) + '¢' : '—'],
          ['Cost', '$' + fmtUSD(cost, 2)],
          ['PnL (ROE)', `${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))} (${roe >= 0 ? '+' : ''}${roe.toFixed(1)}%)`, pnl >= 0 ? 'var(--green)' : 'var(--red)'],
          ...(hold > 0 ? [['In Orders', fmtSize(hold) + ' ' + sideLabel]] : []),
        ])}${closePanel}</div>
      </div>`
    }

    if (_mobVActiveTab === 'spot') {
      el.innerHTML = spots.length
        ? `<div style="padding-top:6px">${spots.map((b, i) => renderSpotRow(b, `sp-${i}`)).join('')}</div>`
        : `<div class="mob-v-empty">No spot balances</div>`
      return
    }
    // Outcomes tab — prediction holdings as position-style cards
    el.innerHTML = outcomes.length
      ? `<div style="padding-top:6px">${outcomes.map((b, i) => renderOcRow(b, `oc-${i}`)).join('')}</div>`
      : `<div class="mob-v-empty">No outcome positions</div>`
    if (outcomes.length) _mobUpdateOcMarks(outcomes)   // fetch live marks → update PnL/ROE
    return
  }

  if (_mobVActiveTab === 'positions') {
    const allPos = state.perpState?.assetPositions ?? []
    const rawPos = allPos.filter(ap => parseFloat(ap.position.szi ?? 0) !== 0)
    if (!rawPos.length) { el.innerHTML = `<div class="mob-v-empty">No open positions</div>`; return }
    const pos = [...rawPos].sort((a, b) => {
      const pa = a.position, pb = b.position
      let va, vb
      if (_mobVPosSortBy === 'posval') {
        va = parseFloat(pa.positionValue ?? Math.abs(parseFloat(pa.szi ?? 0)) * parseFloat(state.allMids?.[pa.coin] ?? 0))
        vb = parseFloat(pb.positionValue ?? Math.abs(parseFloat(pb.szi ?? 0)) * parseFloat(state.allMids?.[pb.coin] ?? 0))
      } else {
        va = parseFloat(pa.unrealizedPnl ?? 0); vb = parseFloat(pb.unrealizedPnl ?? 0)
      }
      return _mobVPosSortDir * (vb - va)
    })
    const _mobVSortPill = (by, label) => {
      const active = _mobVPosSortBy === by
      const arrow  = active ? (_mobVPosSortDir === -1 ? ' ↓' : ' ↑') : ''
      return `<button onclick="window._mobVSortPos('${by}')" style="padding:3px 9px;border-radius:20px;border:1px solid ${active ? 'var(--accent)' : 'var(--border2)'};background:${active ? 'rgba(0,229,160,0.12)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--muted)'};font-size:11px;font-weight:600;cursor:pointer;touch-action:manipulation">${label}${arrow}</button>`
    }
    const sortBar = `<div style="display:flex;gap:6px;padding:8px 14px 2px;align-items:center">
      <span style="font-size:10px;color:var(--muted);margin-right:2px">Sort:</span>
      ${_mobVSortPill('unrl','Unrl PnL')}
      ${_mobVSortPill('posval','Pos Value')}
      <button onclick="window.__closeAllPositions(this)" style="margin-left:auto;padding:3px 10px;border-radius:20px;border:1px solid rgba(255,77,109,0.4);background:rgba(255,77,109,0.08);color:var(--red);font-size:11px;font-weight:600;cursor:pointer;touch-action:manipulation">Close All</button>
    </div>`
    // Per-position cross health = each position's SHARE of the account's maintenance
    // margin against the unified balance, scaled so the shares sum to the exact account
    // maintenance. So one position's health == the account Health in the header, and
    // multiple positions each get their own (riskier = consumes more maint = lower).
    const _crossMaint = parseFloat(state.perpState?.crossMaintenanceMarginUsed ?? state.perpState?.marginSummary?.totalMarginUsed ?? 0)
    const _suUSDC     = (state.spotState?.balances ?? []).find(b => b.coin === 'USDC')
    const _marginBase = (_suUSDC && parseFloat(_suUSDC.total ?? 0) > 0) ? parseFloat(_suUSDC.total) : parseFloat(state.perpState?.marginSummary?.accountValue ?? 0)
    const _estMaint   = (q) => {
      const pv  = parseFloat(q.positionValue ?? Math.abs(parseFloat(q.szi ?? 0)) * parseFloat(state.allMids?.[q.coin] ?? 0))
      const mlv = parseFloat(q.maxLeverage ?? q.leverage?.value ?? 1) || 1
      return pv / (2 * mlv)   // HL maintenance ≈ notional / (2 × maxLeverage)
    }
    const _sumEstMaint = rawPos.reduce((s, ap) => s + _estMaint(ap.position), 0)

    el.innerHTML = sortBar + pos.map((ap, i) => {
      const p       = ap.position
      const sz      = parseFloat(p.szi ?? 0)
      const uPnl    = parseFloat(p.unrealizedPnl ?? 0)
      const roe     = parseFloat(p.returnOnEquity ?? 0) * 100
      const side    = sz > 0 ? 'Long' : 'Short'
      const apiSide = sz > 0 ? 'LONG' : 'SHORT'
      const sideCls = sz > 0 ? 'pos' : 'neg'
      const sideColor = sz > 0 ? '#00e5a0' : '#ff4d6d'
      const sideBg    = sz > 0 ? 'rgba(0,229,160,0.15)' : 'rgba(255,77,109,0.15)'
      // Side-tinted gradient matching the Account Equity card (green long / red short)
      const cardBg    = sz > 0
        ? 'linear-gradient(160deg, rgba(0,229,160,0.10), rgba(255,255,255,0.012) 60%)'
        : 'linear-gradient(160deg, rgba(255,77,109,0.10), rgba(255,255,255,0.012) 60%)'
      const pnlCls  = uPnl >= 0 ? 'pos' : 'neg'
      const lev     = p.leverage?.value ? `${p.leverage.value}x` : ''
      const markPx  = parseFloat(state.allMids?.[p.coin] ?? 0)
      const liqPx   = parseFloat(p.liquidationPx ?? 0)
      const margin  = parseFloat(p.marginUsed ?? 0)
      const posVal  = parseFloat(p.positionValue ?? Math.abs(sz) * markPx)
      const funding = parseFloat(p.cumFunding?.sinceOpen ?? 0)
      const levType = p.leverage?.type ?? ''
      // Find TP/SL orders for this position
      let tpPx = 0, slPx = 0, tpOid = 0, slOid = 0
      for (const o of (state.openOrders ?? [])) {
        if (o.coin !== p.coin || !o.isTrigger) continue
        const isTp = o.orderType?.startsWith('Take Profit') || o.triggerCondition === 'tp'
        const isSl = o.orderType?.startsWith('Stop') || o.triggerCondition === 'sl'
        const opx  = parseFloat(o.triggerPx ?? 0)
        if (isTp && opx > 0) { tpPx = opx; tpOid = o.oid }
        if (isSl && opx > 0) { slPx = opx; slOid = o.oid }
      }
      const levVal  = p.leverage?.value ?? 1
      const isLong  = sz > 0
      const entryPx = parseFloat(p.entryPx ?? 0)
      const isCross = (p.leverage?.type ?? 'cross') !== 'isolated'
      // Health: CROSS positions share the whole account's margin, so their health =
      // the account Health shown in the header (HL Unified Account Ratio: 1 −
      // maintMargin / USDC balance). ISOLATED positions have their own margin, so use
      // the liq-distance metric (100% at entry, 0% at liquidation).
      let healthPct
      if (isCross) {
        const share   = _sumEstMaint > 0 ? _estMaint(p) / _sumEstMaint : 0
        const mmShare = _crossMaint * share   // this position's slice of account maintenance
        healthPct = _marginBase > 0 ? Math.max(0, Math.min(100, (1 - mmShare / _marginBase) * 100)) : 100
      } else if (liqPx > 0 && entryPx > 0 && markPx > 0) {
        if (isLong && entryPx > liqPx) {
          healthPct = Math.max(0, Math.min(100, (markPx - liqPx) / (entryPx - liqPx) * 100))
        } else if (!isLong && liqPx > entryPx) {
          healthPct = Math.max(0, Math.min(100, (liqPx - markPx) / (liqPx - entryPx) * 100))
        } else {
          healthPct = 100
        }
      } else {
        healthPct = Math.max(0, Math.min(100, roe + 100))
      }
      // Graded by distance to liquidation: losing ~a third of margin = amber
      const liqBarColorRaw = healthPct > 70 ? '#00e5a0' : healthPct > 40 ? '#f59e0b' : healthPct > 20 ? '#ff9444' : '#ff4d6d'
      const id      = `pos-${p.coin}`
      const xp      = _mobVExpandedIds.has(id)
      const chev    = `<svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
      const isIso   = levType === 'isolated'
      // Per-position risk guards (isolated only) — armed = a server bot is running for this coin
      const _gInst  = String(p.coin).toUpperCase()
      const _liqOn  = !!serverStatus?._instances?.[`liqguard:${_gInst}`]
      const _brkOn  = !!serverStatus?._instances?.[`levbrake:${_gInst}`]
      const guardsRow = isIso ? `<div style="display:flex;gap:8px;padding:0 16px 12px;background:var(--panel-2)">
        <button onclick="event.stopPropagation();window.__openGuardModal('liqguard','${esc(p.coin)}','${apiSide}')"
          style="flex:1;padding:8px;background:${_liqOn ? 'rgba(0,229,160,0.18)' : 'rgba(255,255,255,0.05)'};border:1px solid ${_liqOn ? 'var(--accent)' : 'rgba(255,255,255,0.12)'};border-radius:8px;color:${_liqOn ? 'var(--accent)' : 'var(--fg)'};font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">🛡 Liq Guard${_liqOn ? ' ✓' : ''}</button>
        <button onclick="event.stopPropagation();window.__openGuardModal('levbrake','${esc(p.coin)}','${apiSide}')"
          style="flex:1;padding:8px;background:${_brkOn ? 'rgba(245,158,11,0.18)' : 'rgba(255,255,255,0.05)'};border:1px solid ${_brkOn ? '#f59e0b' : 'rgba(255,255,255,0.12)'};border-radius:8px;color:${_brkOn ? '#f59e0b' : 'var(--fg)'};font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">🛑 Lev Brake${_brkOn ? ' ✓' : ''}</button>
      </div>` : ''
      const actions = `<div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 16px 14px;background:var(--panel-2);border-bottom:1px solid rgba(255,255,255,0.04)">
        <button onclick="event.stopPropagation();window._mobVEditPosTpSl('${esc(p.coin)}')"
          style="flex:1;min-width:80px;padding:8px;background:rgba(0,229,160,0.1);border:none;border-radius:8px;color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">Edit TP/SL</button>
        ${isIso ? `<button onclick="event.stopPropagation();window._mobVAdjustMargin('${esc(p.coin)}')"
          style="flex:1;min-width:80px;padding:8px;background:rgba(99,179,237,0.12);border:none;border-radius:8px;color:#63b3ed;font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">Margin</button>` : ''}
        <button onclick="event.stopPropagation();window.__openShareCard({coin:'${_jsStr(p.coin)}',title:'${_jsStr(_ocCoinLabel(p.coin))}',side:'${side}',lev:${levVal},roePct:${roe.toFixed(2)},entry:'$${fmtPrice(entryPx)}',mark:'$${fmtPrice(markPx)}'})"
          style="flex:1;min-width:80px;padding:8px;background:rgba(255,138,42,0.12);border:none;border-radius:8px;color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">↗ Share</button>
        <button onclick="event.stopPropagation();window._mobVClosePos(this,'${esc(p.coin)}','${apiSide}','${p.szi}','${markPx}')"
          style="flex:1;min-width:80px;padding:8px;background:rgba(255,77,109,0.1);border:none;border-radius:8px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">Close</button>
      </div>`
      return `<div style="margin:0 12px 8px;border-radius:14px;background:${cardBg};border:1px solid rgba(255,255,255,0.07);border-left:3px solid ${sideColor};overflow:hidden">
        <div style="padding:12px 14px;cursor:pointer" onclick="window._mobVToggleRow('${id}')">
          <div style="display:flex;align-items:center;gap:10px">
            ${_mobVCoinIcon(p.coin)}
            <div style="min-width:0;flex:1">
              <div style="display:flex;align-items:center;gap:7px">
                <span style="font-size:15px;font-weight:700">${esc(_ocCoinLabel(p.coin))}</span>
                <span style="font-size:9.5px;font-weight:700;padding:2px 6px;border-radius:5px;background:${sideBg};color:${sideColor};text-transform:uppercase;letter-spacing:0.5px">${side}</span>
              </div>
              <div style="font-size:11px;color:var(--muted);margin-top:2px">${lev}${levType ? ' ' + levType : ''}</div>
            </div>
            <div style="text-align:center;flex-shrink:0">
              <div style="font-size:9px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px">Mark</div>
              <div id="pos-mark-${p.coin}" style="font-size:13px;font-weight:600;margin-top:2px">${markPx > 0 ? '$' + fmtPrice(markPx) : '—'}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;min-width:64px">
              <div class="mob-v-row-val ${pnlCls}" id="pos-upnl-${p.coin}" style="font-size:15px;font-weight:700;line-height:1.15">${_prv((uPnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(uPnl)))}</div>
              <div class="mob-v-row-pct ${pnlCls}" id="pos-roe-${p.coin}" style="font-size:11px;font-weight:600;line-height:1.15;margin-top:1px">${_prv((roe >= 0 ? '+' : '-') + Math.abs(roe).toFixed(2) + '%')}</div>
            </div>
            ${chev}
          </div>
          <div style="margin-top:12px">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px">
              <span style="font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px">Health</span>
              <span style="font-size:11px;font-weight:700;color:${liqBarColorRaw}">${healthPct.toFixed(1)}%</span>
            </div>
            <div style="position:relative;height:6px;border-radius:3px;background:linear-gradient(90deg,#ff4d6d 0%,#f5a623 50%,#00e5a0 100%)">
              <div style="position:absolute;top:50%;left:${Math.max(0, Math.min(100, healthPct)).toFixed(1)}%;width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid var(--bg);transform:translate(-50%,-50%);box-shadow:0 1px 3px rgba(0,0,0,0.45)"></div>
            </div>
          </div>
        </div>
        <div id="mrd-${id}" style="display:${xp ? '' : 'none'}">
          ${_mobVDetailGrid([
            ['Size', fmtSize(Math.abs(sz)) + ' ' + esc(_ocCoinLabel(p.coin))],
            ['Position Value', _prv('$' + fmtUSD(posVal))],
            ['Entry Price', '$' + fmtPrice(p.entryPx)],
            ['Liq. Price', _prv(liqPx > 0 ? '$' + fmtPrice(liqPx) : '—'), liqPx > 0 && markPx > 0 && (sz > 0 ? liqPx > markPx * 0.9 : liqPx < markPx * 1.1) ? 'var(--red)' : ''],
            ['Margin Used', _prv('$' + fmtUSD(margin))],
            // Effective leverage = notional ÷ margin. Unlike the leverage SETTING shown in
            // the header (e.g. 20x), this drops as margin is added — the real current ratio.
            ['Real Leverage', margin > 0 ? (posVal / margin).toFixed(2) + 'x' : '—'],
            ['Funding', _prv((funding >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(funding))), funding >= 0 ? 'var(--green)' : 'var(--red)'],
          ])}
          ${guardsRow}
          ${actions}
        </div>
      </div>`
    }).join('')
    return
  }

  if (_mobVActiveTab === 'orders') {
    const rawOrders = state.openOrders ?? []
    if (!rawOrders.length) { el.innerHTML = `<div class="mob-v-empty">No open orders</div>`; return }
    const orders = [...rawOrders].sort((a, b) => {
      if (_mobVOrdSortBy === 'px') {
        // triggerPx is the string "0.0" (not null) on plain limit orders — `??`
        // never falls through, so use numeric-or to pick the real price
        const pxa = parseFloat(a.triggerPx ?? 0) || parseFloat(a.limitPx ?? 0)
        const pxb = parseFloat(b.triggerPx ?? 0) || parseFloat(b.limitPx ?? 0)
        return _mobVOrdSortDir * (pxb - pxa)
      } else if (_mobVOrdSortBy === 'sz') {
        return _mobVOrdSortDir * (parseFloat(b.sz ?? 0) - parseFloat(a.sz ?? 0))
      }
      return _mobVOrdSortDir * a.coin.localeCompare(b.coin)
    })
    const _mobVSortOrdPill = (by, label) => {
      const active = _mobVOrdSortBy === by
      const arrow  = active ? (_mobVOrdSortDir === 1 ? ' ↑' : ' ↓') : ''
      return `<button onclick="window._mobVSortOrd('${by}')" style="padding:3px 9px;border-radius:20px;border:1px solid ${active ? 'var(--accent)' : 'var(--border2)'};background:${active ? 'rgba(0,229,160,0.12)' : 'transparent'};color:${active ? 'var(--accent)' : 'var(--muted)'};font-size:11px;font-weight:600;cursor:pointer;touch-action:manipulation">${label}${arrow}</button>`
    }
    const _pill = (txt, cb, color) => `<button onclick="${cb}" style="padding:3px 10px;border-radius:20px;border:1px solid ${color}55;background:${color}14;color:${color};font-size:11px;font-weight:600;cursor:pointer;touch-action:manipulation">${txt}</button>`
    const ordSortBar = _mobVOrdSelMode
      ? `<div style="display:flex;gap:6px;padding:8px 14px 2px;align-items:center">
          <span style="font-size:11px;color:var(--muted);margin-right:2px">${_mobVOrdSel.size} selected</span>
          ${_pill('Select all', 'window._mobVOrdSelectAll()', '#9aa0ab')}
          <span style="margin-left:auto;display:flex;gap:6px">
            ${_pill('Done', 'window._mobVOrdToggleSelMode()', '#9aa0ab')}
            ${_pill(`Cancel (${_mobVOrdSel.size})`, 'window._mobVCancelSelected()', '#ff4d6d')}
          </span>
        </div>`
      : `<div style="display:flex;gap:6px;padding:8px 14px 2px;align-items:center">
          <span style="font-size:10px;color:var(--muted);margin-right:2px">Sort:</span>
          ${_mobVSortOrdPill('coin','Coin')}
          ${_mobVSortOrdPill('px','Price')}
          ${_mobVSortOrdPill('sz','Size')}
          <span style="margin-left:auto;display:flex;gap:6px">
            ${_pill('Select', 'window._mobVOrdToggleSelMode()', '#9aa0ab')}
            ${_pill('Cancel All', 'window._mobVCancelAll()', '#ff4d6d')}
          </span>
        </div>`
    el.innerHTML = ordSortBar + orders.map((o, i) => {
      const side      = o.side === 'B' ? 'Buy' : 'Sell'
      const sideCls   = o.side === 'B' ? 'pos' : 'neg'
      const isTrigger = o.isTrigger || parseFloat(o.triggerPx ?? 0) > 0
      const triggerPx = parseFloat(o.triggerPx ?? 0)
      const limitPx   = parseFloat(o.limitPx ?? 0)
      const notional  = parseFloat(o.sz ?? 0) * (triggerPx || limitPx)
      const ordMarkPx = parseFloat(state.allMids?.[o.coin] ?? 0)
      const id        = `ord-${i}`
      const xp        = _mobVExpandedIds.has(id)
      const chev      = `<svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
      const sel       = _mobVOrdSel.has(o.oid)
      const checkbox  = `<span style="width:20px;height:20px;flex-shrink:0;border-radius:6px;border:2px solid ${sel ? 'var(--accent)' : 'var(--border2)'};background:${sel ? 'var(--accent)' : 'transparent'};display:flex;align-items:center;justify-content:center;color:#000;font-size:13px;font-weight:800">${sel ? '✓' : ''}</span>`
      const rowClick  = _mobVOrdSelMode ? `window._mobVToggleOrdSel(${o.oid})` : `window._mobVToggleRow('${id}')`
      return `<div>
        <div class="mob-v-row" style="cursor:pointer" onclick="${rowClick}">
          ${_mobVOrdSelMode ? checkbox : _mobVCoinIcon(o.coin)}
          <div class="mob-v-row-info">
            <div class="mob-v-row-name">${esc(_ocCoinLabel(o.coin))}</div>
            <div class="mob-v-row-sub ${sideCls}">${side} · ${esc(o.orderType ?? 'Limit')}</div>
          </div>
          <div style="flex-shrink:0;width:74px;display:flex;flex-direction:column">
            <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;line-height:1.2;text-align:center">Price</div>
            <div style="font-size:13px;font-weight:500;color:var(--fg);line-height:1.3;margin-top:2px;white-space:nowrap;text-align:center;overflow:hidden;text-overflow:ellipsis">${(triggerPx || limitPx) > 0 ? '$' + fmtPrice(triggerPx || limitPx) : '—'}</div>
          </div>
          <div class="mob-v-row-right" style="width:86px;flex-shrink:0;flex-grow:0">
            <div class="mob-v-row-val">${fmtSize(parseFloat(o.sz ?? 0))}</div>
            <div class="mob-v-row-pct" style="color:var(--muted)">${esc(_ocCoinLabel(o.coin))}</div>
          </div>
          ${chev}
        </div>
        <div id="mrd-${id}" style="display:${xp ? '' : 'none'}">
          ${(() => {
            const tpslType = isTrigger
              ? (o.orderType?.startsWith('Take Profit') || o.triggerCondition === 'tp' ? 'Take Profit'
               : o.orderType?.startsWith('Stop') || o.triggerCondition === 'sl' ? 'Stop Loss'
               : null)
              : null
            const triggerCondStr = isTrigger && triggerPx > 0
              ? (o.triggerCondition === 'above' ? `≥ $${fmtPrice(triggerPx)}`
               : o.triggerCondition === 'below' ? `≤ $${fmtPrice(triggerPx)}`
               : `$${fmtPrice(triggerPx)}`)
              : null
            // Expected PnL if this order fills — same math as the desktop table:
            // only meaningful for TP/SL/reduce-only orders tied to a position
            const _pos    = (state.perpState?.assetPositions ?? []).find(ap => ap.position.coin === o.coin)?.position
            const _entry  = _pos ? parseFloat(_pos.entryPx ?? 0) : 0
            const _szi    = _pos ? parseFloat(_pos.szi ?? 0) : 0
            const _dispPx = triggerPx > 0 ? triggerPx : limitPx
            const _rawSz  = parseFloat(o.sz ?? 0)
            const _effSz  = _rawSz > 0 ? _rawSz : Math.abs(_szi)   // sz=0 → closes whole position
            let expRows = []
            if (_entry > 0 && _dispPx > 0 && _effSz > 0 && (tpslType || o.reduceOnly)) {
              const _pnl    = _szi > 0 ? (_dispPx - _entry) * _effSz : (_entry - _dispPx) * _effSz
              const _margin = parseFloat(_pos.marginUsed ?? 0)
              const _roe    = _margin > 0 ? (_pnl / _margin) * 100 : null
              expRows = [['Expected PnL', `${_pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(_pnl))}${_roe != null ? ` (${_roe >= 0 ? '+' : ''}${_roe.toFixed(1)}% on margin)` : ''}`, _pnl >= 0 ? 'var(--green)' : 'var(--red)']]
            }
            return _mobVDetailGrid([
              ['Size', fmtSize(parseFloat(o.sz ?? 0)) + ' ' + esc(_ocCoinLabel(o.coin))],
              ['Value', '$' + fmtUSD(notional)],
              ...expRows,
              ...(tpslType ? [['TP / SL', tpslType]] : []),
              ...(triggerCondStr ? [['Trigger Condition', triggerCondStr]] : []),
              ...(limitPx > 0 && isTrigger ? [['Limit Price', '$' + fmtPrice(limitPx)]] : []),
              ['Reduce Only', o.reduceOnly ? 'Yes' : 'No'],
              ['Order ID', String(o.oid)],
            ])
          })()}
          <div style="padding:0 16px 14px;background:var(--panel-2);border-bottom:1px solid rgba(255,255,255,0.04)">
            <div style="display:flex;gap:8px;margin-bottom:8px">
              <button onclick="event.stopPropagation();window._mobVEditOrd('${esc(o.coin)}',${o.oid},'${o.side}',${o.sz},${triggerPx || limitPx},'${isTrigger ? (o.orderType?.startsWith('Take Profit') || o.triggerCondition === 'tp' ? 'tp' : o.orderType?.startsWith('Stop') || o.triggerCondition === 'sl' ? 'sl' : '') : ''}',${isTrigger})"
                style="flex:1;padding:8px;background:rgba(0,229,160,0.1);border:none;border-radius:8px;color:var(--accent);font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">Edit</button>
              <button onclick="event.stopPropagation();window._mobVCancelOrd(this,'${esc(o.coin)}',${o.oid})"
                style="flex:1;padding:8px;background:rgba(255,77,109,0.1);border:none;border-radius:8px;color:var(--red);font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation">Cancel</button>
            </div>
          </div>
        </div>
      </div>`
    }).join('')
    return
  }

  if (_mobVActiveTab === 'trades') {
    // Group partial fills of the same order into one row (matches desktop)
    const all = aggregateByHash(state.fills ?? []).sort((a, b) => b.time - a.time)
    const PER = 20
    const pages = Math.max(1, Math.ceil(all.length / PER))
    if (_mobVTradesPage >= pages) _mobVTradesPage = pages - 1
    if (_mobVTradesPage < 0) _mobVTradesPage = 0
    const start  = _mobVTradesPage * PER
    const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px">
      <span style="font-size:17px;font-weight:700">History</span>
      ${all.length ? `<span style="font-size:11px;color:var(--muted)">${all.length} trade${all.length === 1 ? '' : 's'}</span>` : ''}</div>`
    if (!all.length) { el.innerHTML = header + `<div class="mob-v-empty">No trade history yet</div>`; return }
    const fills = all.slice(start, start + PER)
    const rows = fills.map((f, idx) => {
      const i      = `p${_mobVTradesPage}-${idx}`
      const isBuy  = f.side === 'BUY'
      const pnl    = f.closedPnl
      const pnlCls = pnl >= 0 ? 'pos' : 'neg'
      const fee    = parseFloat(f.fee ?? 0)
      const dir    = f.dir ? (f.dir.charAt(0).toUpperCase() + f.dir.slice(1).toLowerCase()) : '—'
      const id     = `fill-${i}`
      const xp     = _mobVExpandedIds.has(id)
      const chev   = `<svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
      // Share card for a closed trade. Reconstruct entry from the fill:
      //   entry = (exitNotional ∓ closedPnl) / size   (− for a long, + for a short)
      // Side = the POSITION side, which for a *closing* fill is the opposite of the
      // fill side (a sell closes a long). Outcome positions are always long, and
      // their settlement fills carry dir="Settlement" (no long/short word), so the
      // old regex mis-read them as short → wrong entry (e.g. 1.68 for a 0–1 token).
      const _sz       = parseFloat(f.sz) || 0
      const _isOc     = typeof f.coin === 'string' && (f.coin[0] === '#' || f.coin[0] === '+')
      const _sideLong = _isOc ? true
                      : /long/i.test(dir)  ? true
                      : /short/i.test(dir) ? false
                      : !isBuy
      const _cost     = _sideLong ? (f.notional - pnl) : (f.notional + pnl)
      const _entryPx  = (_sz > 0 && _cost > 0) ? _cost / _sz : parseFloat(f.px)
      const _priceRet = _cost > 0 ? (pnl / _cost) * 100 : 0
      // Outcomes are 0–1 probabilities (show raw, like HL); perps show $ price.
      const _entryStr = _isOc ? _entryPx.toFixed(5)         : '$' + fmtPrice(_entryPx)
      const _markStr  = _isOc ? parseFloat(f.px).toFixed(5) : '$' + fmtPrice(f.px)
      const _sideStr  = _isOc ? '' : (_sideLong ? 'LONG' : 'SHORT')
      const _shareCall = `window.__shareTrade('${_jsStr(f.coin)}',{title:'${_jsStr(_ocCoinLabel(f.coin))}',side:'${_sideStr}',roePct:${_priceRet.toFixed(2)},entry:'${_entryStr}',mark:'${_markStr}'})`
      return `<div>
        <div class="mob-v-row" style="cursor:pointer" onclick="window._mobVToggleRow('${id}')">
          ${_mobVCoinIcon(f.coin)}
          <div class="mob-v-row-info">
            <div class="mob-v-row-name">${esc(_ocCoinLabel(f.coin))} <span class="${isBuy ? 'pos' : 'neg'}" style="font-size:11px;font-weight:500">${f.side}</span></div>
            <div class="mob-v-row-sub">${f.timeStr}</div>
          </div>
          <div class="mob-v-row-right">
            <div class="mob-v-row-val">${fmtSize(f.sz)} @ $${fmtPrice(f.px)}</div>
            <div class="mob-v-row-pct ${pnl !== 0 ? pnlCls : ''}" style="display:flex;align-items:center;gap:6px;justify-content:flex-end;${pnl === 0 ? 'color:var(--muted)' : ''}">
              <span>${pnl !== 0 ? (pnl >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(pnl)) : '—'}</span>
              ${pnl !== 0 ? `<button class="trade-share-btn" title="Share PnL" onclick="event.stopPropagation();${_shareCall}" style="padding:1px 6px;font-size:12px">↗</button>` : ''}
            </div>
          </div>
          ${chev}
        </div>
        <div id="mrd-${id}" style="display:${xp ? '' : 'none'}">${_mobVDetailGrid([
          ['Notional', '$' + fmtUSD(f.notional ?? parseFloat(f.sz) * parseFloat(f.px))],
          ['Fee', fee > 0 ? '$' + fmtUSD(fee) + (f.feeToken && f.feeToken !== 'USDC' ? ' ' + esc(f.feeToken) : '') : '—'],
          ['Direction', dir],
          ['Closed PnL', pnl !== 0 ? (pnl >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(pnl)) : '—', pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : ''],
        ])}${pnl !== 0 ? `<button class="trade-share-btn-full" onclick="event.stopPropagation();${_shareCall}">↗ Share this trade</button>` : ''}</div>
      </div>`
    }).join('')
    const btn = (dir, disabled) => `<button onclick="window._mobVTradesPageChange(${dir})" ${disabled ? 'disabled' : ''} style="width:40px;height:40px;border-radius:10px;border:1px solid var(--border2);background:var(--panel-2);color:${disabled ? 'var(--muted)' : 'var(--accent)'};font-size:20px;line-height:1;cursor:${disabled ? 'default' : 'pointer'};opacity:${disabled ? '0.4' : '1'}">${dir < 0 ? '‹' : '›'}</button>`
    const pager = pages > 1
      ? `<div style="display:flex;align-items:center;justify-content:center;gap:16px;padding:14px 16px 28px">
          ${btn(-1, _mobVTradesPage === 0)}
          <span style="font-size:12px;color:var(--muted)">Page ${_mobVTradesPage + 1} / ${pages}</span>
          ${btn(1, _mobVTradesPage >= pages - 1)}
        </div>`
      : ''
    el.innerHTML = header + rows + pager
    return
  }

  if (_mobVActiveTab === 'leaderboard') {
    const stale = Date.now() - _lbLastFetch > 30_000
    if (_mobVLbResults.length && !stale) {
      el.innerHTML = _mobVBuildLbHtml(_mobVLbResults)
    } else {
      if (!_mobVLbResults.length) el.innerHTML = `<div class="mob-v-empty">Loading…</div>`
      _mobVFetchLeaderboard(el)
    }
    return
  }

  if (_mobVActiveTab === 'transfers') {
    const ledger = (state.ledger ?? []).slice().sort((a, b) => b.time - a.time)
    if (!ledger.length) { el.innerHTML = `<div class="mob-v-empty">No transfers yet</div>`; return }
    const typeLabel = { deposit: 'Deposit', withdraw: 'Withdraw', send: 'Send', accountClassTransfer: 'Internal', internalTransfer: 'Internal', subAccountTransfer: 'Sub-account', spotTransfer: 'Spot transfer' }
    el.innerHTML = ledger.map(e => {
      const type   = e.delta?.type ?? ''
      const label  = typeLabel[type] ?? type
      // Signed flow (+ into the account, − out) — spot/peer transfers are signed
      // by whether we sent or received them (shared with the desktop ledger).
      const amt    = ledgerAmount(e, state.addr)
      const isIn   = amt >= 0
      const cls    = isIn ? 'pos' : 'neg'
      const ts     = new Date(e.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      return `<div class="mob-v-row">
        <div class="mob-v-row-icon" style="color:${isIn ? 'var(--green)' : 'var(--red)'};font-size:18px">${isIn ? '↓' : '↑'}</div>
        <div class="mob-v-row-info">
          <div class="mob-v-row-name">${esc(label)}</div>
          <div class="mob-v-row-sub">${ts}</div>
        </div>
        <div class="mob-v-row-right">
          <div class="mob-v-row-val ${cls}">${isIn ? '+' : '-'}$${fmtUSD(Math.abs(amt))}</div>
        </div>
      </div>`
    }).join('')
    return
  }

  if (_mobVActiveTab === 'settings') {
    const isLight      = localStorage.getItem('hliq_light_mode') === '1'
    const themeSt      = localStorage.getItem('hliq_theme_style') || 'pro'
    const accentH      = parseInt(localStorage.getItem('hliq_accent_h') || '142')
    const brightness   = parseInt(localStorage.getItem('hliq_brightness') || '100')
    const savedLang    = localStorage.getItem('hliq_lang') || 'en'
    const pinEnabled   = localStorage.getItem(PIN_ON_KEY) === 'true' && !!localStorage.getItem(PIN_KEY)
    const haEnabled    = localStorage.getItem('hliq_health_alert_enabled') === '1'
    const haThreshold  = localStorage.getItem('hliq_health_alert_threshold') || '50'
    const laEnabled    = localStorage.getItem('hliq_liq_alert_enabled') === '1'
    const laThreshold  = localStorage.getItem('hliq_liq_alert_threshold') || '20'
    const notifCd      = localStorage.getItem('hliq_notif_cooldown_min') || '60'
    const notifPerm    = notifPermission()
    const notifOn      = notifPerm === 'granted'
    const riskThresh   = getRiskState().thresholds
    const priceAlerts  = _paLoad()
    const mainConnected = isMainWalletConnected()
    const mainAddr     = getMainAddress?.() || state.addr || ''
    const walletStatus = mainConnected ? (mainAddr ? mainAddr.slice(0, 8) + '…' + mainAddr.slice(-5) : 'Connected') : 'Not connected'
    const savedKey     = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null) || localStorage.getItem('hliq_agent_key') || ''
    const agentStatus  = isConnected() ? 'Connected' : (savedKey ? 'Saved — not active' : 'Not connected')
    const agentCls     = isConnected() ? 'var(--green)' : 'var(--muted)'
    const newsKw       = document.getElementById('newsKeywords')?.value || 'war, attack, sanctions, hack, exploit, ban, seized, collapse, default'
    const devOn        = !!localStorage.getItem('hliq_dev')
    const bioEnabled   = !!localStorage.getItem('hliq_biometric_cred')
    const tog = (checked, fn) =>
      `<label class="pin-toggle" style="flex-shrink:0"><input type="checkbox" ${checked ? 'checked' : ''} onchange="${fn}"><span class="pin-toggle-slider"></span></label>`
    const segBtn = (active, label, fn) =>
      `<button onclick="${fn}" style="padding:5px 14px;border:none;font-size:12px;font-weight:600;cursor:pointer;background:${active ? 'var(--accent)' : 'var(--panel-2)'};color:${active ? '#000' : 'var(--muted)'}">${label}</button>`
    el.innerHTML = `<div style="margin:10px 8px calc(82px + env(safe-area-inset-bottom));border:1px solid var(--border2);border-radius:18px;background:var(--bg2);overflow:hidden">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px 16px 13px;border-bottom:1px solid var(--border)">
        <span style="font-size:18px;font-weight:700">Settings</span>
        <button onclick="window.mobVHome()" aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:22px;line-height:1;cursor:pointer;padding:0 4px">&times;</button>
      </div>

      <!-- Connections -->
      <div class="mob-v-setting-group">
        <div class="mob-v-setting-row" style="flex-wrap:wrap;gap:6px">
          <div>
            <div>Main Wallet</div>
            <div style="font-size:11px;color:${mainConnected ? 'var(--green)' : 'var(--muted)'}">${esc(walletStatus)}</div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="mob-v-setting-btn" onclick="connectMainWalletUI()">${mainConnected ? 'Switch' : 'Connect'}</button>
            ${mainConnected ? `<button class="mob-v-setting-btn" style="color:var(--neg);border-color:rgba(255,77,109,0.3)" onclick="window._mobVDisconnectWallet()">Disconnect</button>` : ''}
          </div>
        </div>
        <div style="padding:10px 16px;border-bottom:1px solid rgba(255,255,255,0.05)">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
            <span>Agent Key</span>
            <span style="font-size:11px;color:${agentCls}">${esc(agentStatus)}</span>
          </div>
          <div style="display:flex;gap:8px">
            <input type="password" id="mobVAgentKeyInput" placeholder="0x… private key"
              style="flex:1;min-width:0;padding:7px 10px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:12px;font-family:monospace"
              value="${esc(savedKey)}" />
            <button class="mob-v-setting-btn" onclick="window._mobVConnectAgentKey()">Connect</button>
          </div>
          ${savedKey ? '' : `<button class="auto-gen-agent-btn" onclick="window.__quickConnectAgent()" style="width:100%;margin-top:8px;padding:9px;border-radius:8px;border:none;background:rgba(255,138,42,0.14);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer">${mainConnected ? '⚡ Auto-generate Agent Key' : '🔗 Connect wallet'}</button>`}
        </div>
      </div>

      <!-- Appearance -->
      <div class="mob-v-setting-group">
        <div class="mob-v-setting-row">
          <span>Color Scheme</span>
          <div style="display:flex;border:1px solid var(--border2);border-radius:6px;overflow:hidden">
            ${segBtn(!isLight, 'Dark', "window.__onThemeMode('dark');_mobVRenderContent()")}
            ${segBtn(isLight,  'Light', "window.__onThemeMode('light');_mobVRenderContent()")}
          </div>
        </div>
        <div class="mob-v-setting-row">
          <span>Style</span>
          <div style="display:flex;border:1px solid var(--border2);border-radius:6px;overflow:hidden">
            ${segBtn(themeSt !== 'soft', 'A · Pro',  "window.__onThemeStyle('pro');_mobVRenderContent()")}
            ${segBtn(themeSt === 'soft', 'B · Soft', "window.__onThemeStyle('soft');_mobVRenderContent()")}
          </div>
        </div>
        <div class="mob-v-setting-row">
          <span>Accent</span>
          <div style="display:flex;gap:8px">
            ${[[142,'Green'],[50,'Orange'],[195,'Cyan'],[280,'Purple'],[350,'Pink']].map(([h, name]) =>
              `<button onclick="window.__onAccentChange(${h})" title="${name}"
                style="width:26px;height:26px;border-radius:50%;background:oklch(0.78 0.18 ${h});border:3px solid ${accentH === h ? 'var(--fg)' : 'transparent'};cursor:pointer;flex-shrink:0"></button>`
            ).join('')}
          </div>
        </div>
        <div class="mob-v-setting-row" style="flex-wrap:wrap;gap:4px">
          <div><div>Brightness</div><div style="font-size:11px;color:var(--muted)" id="mobVBrightLbl">${brightness}%</div></div>
          <input type="range" style="width:100%;margin-top:2px" min="50" max="150" step="5" value="${brightness}"
            oninput="window.__onBrightnessChange(this.value);document.getElementById('mobVBrightLbl').textContent=this.value+'%'">
        </div>
        <div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div>Language</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px">
            ${Object.entries(_LANG_NAMES).map(([code]) =>
              `<button onclick="window.__setLang('${code}');_mobVRenderContent()"
                style="padding:4px 10px;border-radius:4px;border:1px solid ${savedLang === code ? 'var(--accent)' : 'var(--border2)'};background:${savedLang === code ? 'color-mix(in oklch,var(--accent) 15%,transparent)' : 'var(--panel-2)'};color:${savedLang === code ? 'var(--accent)' : 'var(--muted)'};font-size:12px;font-weight:600;cursor:pointer">${code.toUpperCase()}</button>`
            ).join('')}
          </div>
        </div>
      </div>


      <!-- Security -->
      <div class="mob-v-setting-group">
        ${pinEnabled
          ? `<div class="mob-v-setting-row">
              <div><div>PIN Lock</div><div style="font-size:11px;color:var(--green)">Active</div></div>
              <button class="mob-v-setting-btn" style="color:var(--neg);border-color:rgba(255,77,109,0.3)"
                onclick="localStorage.removeItem('${PIN_KEY}');localStorage.removeItem('${PIN_ON_KEY}');localStorage.removeItem('hliq_biometric_cred');_mobVRenderContent()">Disable PIN &amp; Face ID</button>
            </div>`
          : `<div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
              <div>PIN Lock</div>
              <div style="display:flex;gap:8px;width:100%">
                <input type="password" id="mobVPinInput" inputmode="numeric" maxlength="4" placeholder="4-digit PIN"
                  style="flex:1;padding:7px 10px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:16px;letter-spacing:4px;font-family:monospace">
                <button class="mob-v-setting-btn" onclick="window._mobVSetPin()">Set PIN</button>
              </div>
            </div>`}
        ${pinEnabled && window.PublicKeyCredential ? `
        <div class="mob-v-setting-row">
          <div><div>Face ID / Touch ID</div><div style="font-size:11px;color:var(--muted)">Unlock with biometrics instead of PIN</div></div>
          ${bioEnabled
            ? `<button class="mob-v-setting-btn" style="color:var(--neg);border-color:rgba(255,77,109,0.3)"
                onclick="localStorage.removeItem('hliq_biometric_cred');_mobVRenderContent()">Remove</button>`
            : `<button class="mob-v-setting-btn" onclick="window._mobVEnableBiometric()">Set Up</button>`}
        </div>` : ''}
      </div>

      <!-- Notifications -->
      <div class="mob-v-setting-group">
        <div class="mob-v-setting-row">
          <div>
            <div>Browser Notifications</div>
            <div style="font-size:11px;color:var(--muted)">${notifPerm === 'granted' ? 'Enabled' : notifPerm === 'denied' ? 'Blocked by browser' : 'Alerts for liquidation &amp; risk'}</div>
          </div>
          ${notifOn
            ? `<span style="font-size:12px;font-weight:600;color:var(--green)">On</span>`
            : `<button class="mob-v-setting-btn" onclick="window.__enableNotifs()">Enable</button>`}
        </div>
        ${notifOn ? `
        <div class="mob-v-setting-row">
          <div><div>Health Alert</div><div style="font-size:11px;color:var(--muted)">Alert when account health drops below threshold</div></div>
          ${tog(haEnabled, 'window.__onHealthAlertToggle(this.checked);_mobVRenderContent()')}
        </div>
        ${haEnabled ? `
        <div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span style="font-size:12px;color:var(--muted)">Alert if health ≤</span>
            <span id="mobVHaLbl" style="font-size:12px">${haThreshold}%</span>
          </div>
          <input type="range" style="width:100%" min="1" max="99" step="1" value="${haThreshold}"
            oninput="window.__onHealthAlertThresholdChange(this.value);document.getElementById('mobVHaLbl').textContent=this.value+'%'">
        </div>` : ''}
        <div class="mob-v-setting-row">
          <div><div>Position Health Alert</div><div style="font-size:11px;color:var(--muted)">Push when a position's health drops near liquidation (works when app is closed)</div></div>
          ${tog(laEnabled, 'window.__onLiqAlertToggle(this.checked);_mobVRenderContent()')}
        </div>
        ${laEnabled ? `
        <div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span style="font-size:12px;color:var(--muted)">Alert if health ≤</span>
            <span id="mobVLaLbl" style="font-size:12px">${laThreshold}%</span>
          </div>
          <input type="range" style="width:100%" min="1" max="99" step="1" value="${laThreshold}"
            oninput="window.__onLiqAlertThresholdChange(this.value);document.getElementById('mobVLaLbl').textContent=this.value+'%'">
        </div>` : ''}
        <div class="mob-v-setting-row">
          <div><div>Alert Frequency</div><div style="font-size:11px;color:var(--muted)">Min time between repeat alerts per account</div></div>
          <select onchange="window.__onNotifCooldownChange(this.value)"
            style="padding:6px 8px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:13px">
            ${[['15','15 min'],['30','30 min'],['60','1 hour'],['240','4 hours'],['720','12 hours'],['1440','24 hours']].map(([v,l]) =>
              `<option value="${v}"${notifCd === v ? ' selected' : ''}>${l}</option>`).join('')}
          </select>
        </div>
        <div class="mob-v-setting-row">
          <div><div>Mute All Alerts</div><div style="font-size:11px;color:var(--muted)">Pause push notifications on this device for 24h</div></div>
          <button class="mob-v-setting-btn" onclick="window.__muteNotifs(1440,this)">🔕 Mute 24h</button>
        </div>
        <div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:8px">
          <div>Price Alerts</div>
          ${priceAlerts.length ? priceAlerts.map(a => `
            <div style="display:flex;align-items:center;gap:8px;width:100%;font-size:13px">
              <span style="font-weight:600">${esc(a.coin)}</span>
              <span class="${a.dir === 'above' ? 'pos' : 'neg'}">${a.dir === 'above' ? '↑' : '↓'}</span>
              <span style="font-family:monospace">$${fmtUSD(a.price)}</span>
              ${a.fired ? `<span style="font-size:10px;color:var(--muted);border:1px solid var(--border2);border-radius:3px;padding:1px 4px">Triggered</span>` : ''}
              <span style="flex:1"></span>
              ${a.fired ? `<button class="mob-v-setting-btn" style="padding:2px 7px;font-size:11px" onclick="window.__resetPriceAlert('${a.id}');_mobVRenderContent()">↺</button>` : ''}
              <button class="mob-v-setting-btn" style="padding:2px 7px;font-size:11px" onclick="window.__removePriceAlert('${a.id}');_mobVRenderContent()">✕</button>
            </div>`).join('') : '<div style="font-size:12px;color:var(--muted)">No alerts set</div>'}
          <div style="display:flex;gap:6px;width:100%;flex-wrap:wrap">
            <input id="mobVPaCoIn" placeholder="BTC" maxlength="10"
              style="flex:1;min-width:60px;padding:6px 10px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:12px">
            <select id="mobVPaDir"
              style="padding:6px 8px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:12px">
              <option value="above">↑ Above</option>
              <option value="below">↓ Below</option>
            </select>
            <input id="mobVPaPrice" type="number" min="0" placeholder="Price"
              style="flex:1;min-width:70px;padding:6px 10px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:12px">
            <button class="mob-v-setting-btn" onclick="window._mobVAddPriceAlert()">Add</button>
          </div>
        </div>` : ''}
      </div>

      <!-- Trading -->
      <div class="mob-v-setting-group">
        <div class="mob-v-setting-row">
          <div><div>News Pause</div><div style="font-size:11px;color:var(--muted)">Pause trading on matching headlines</div></div>
          ${tog(newsPauseEnabled, 'window.__onNewsPauseToggle(this.checked);_mobVRenderContent()')}
        </div>
        ${newsPauseEnabled ? `
        <div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
          <div style="font-size:12px;color:var(--muted)">Keywords (comma separated)</div>
          <input id="mobVNewsKw" value="${esc(newsKw)}"
            style="width:100%;padding:7px 10px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:12px;box-sizing:border-box"
            oninput="const d=document.getElementById('newsKeywords');if(d)d.value=this.value">
        </div>` : ''}
        <div class="mob-v-setting-row">
          <div><div>Risk Management</div><div style="font-size:11px;color:var(--muted)">Auto-pause on drawdown or loss streak</div></div>
          ${tog(riskMgmtEnabled, 'window.__onRiskMgmtToggle(this.checked);_mobVRenderContent()')}
        </div>
        ${riskMgmtEnabled ? `
        ${(() => {
          const _r  = getRiskState()
          const _lq = state.perpState ? checkLiquidation(state.perpState, state.allMids) : null
          return `<div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:6px">
            <div style="display:flex;align-items:center;gap:8px;width:100%">
              <span style="width:8px;height:8px;border-radius:50%;background:${_r.paused ? 'var(--red)' : 'var(--green)'};flex-shrink:0"></span>
              <span style="font-size:12px;font-weight:700;color:${_r.paused ? 'var(--red)' : 'var(--green)'}">${_r.paused ? 'TRADING PAUSED' : 'Trading active'}</span>
              ${_r.paused ? `<button class="mob-v-setting-btn" style="margin-left:auto" onclick="window.__resumeRisk();_mobVRenderContent()">Resume</button>` : ''}
            </div>
            ${_r.paused && _r.pauseReason ? `<div style="font-size:11px;color:var(--red)">${esc(_r.pauseReason)}</div>` : ''}
            <div style="font-size:11px;color:var(--muted)">Drawdown ${_r.drawdownPct.toFixed(2)}% / ${_r.thresholds.maxDrawdownPct}% · Streak ${_r.lossStreak}/${_r.thresholds.maxLossStreak} · Nearest liq ${_lq ? _lq.bufferPct.toFixed(1) + '%' : '—'}</div>
          </div>`
        })()}
        <div class="mob-v-setting-row" style="flex-direction:column;align-items:flex-start;gap:10px">
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span style="font-size:13px">Max Drawdown %</span>
            <input id="mobVRiskDd" type="number" min="1" max="100" value="${riskThresh.maxDrawdownPct}"
              oninput="window._mobVApplyThresholds()"
              style="width:64px;padding:4px 8px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:13px;text-align:right">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span style="font-size:13px">Max Loss Streak</span>
            <input id="mobVRiskSt" type="number" min="1" max="50" value="${riskThresh.maxLossStreak}"
              oninput="window._mobVApplyThresholds()"
              style="width:64px;padding:4px 8px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:13px;text-align:right">
          </div>
          <div style="display:flex;align-items:center;justify-content:space-between;width:100%">
            <span style="font-size:13px">Liq. Warning %</span>
            <input id="mobVRiskLq" type="number" min="1" max="100" value="${riskThresh.liqWarningPct}"
              oninput="window._mobVApplyThresholds()"
              style="width:64px;padding:4px 8px;background:var(--input-bg,var(--panel-2));border:1px solid var(--border2);border-radius:6px;color:var(--fg);font-size:13px;text-align:right">
          </div>
        </div>` : ''}
      </div>

      <!-- Data & Backup -->
      <div class="mob-v-setting-group">
        <div class="mob-v-setting-row">
          <span>Export Settings</span>
          <button class="mob-v-setting-btn" onclick="window.__exportSettings()">Export JSON</button>
        </div>
        <div class="mob-v-setting-row">
          <span>Import Settings</span>
          <label for="importFileInput" class="mob-v-setting-btn" style="cursor:pointer;display:inline-flex;align-items:center">Import JSON</label>
        </div>
      </div>

      <!-- Developer -->
      <div class="mob-v-setting-group">
        <div class="mob-v-setting-row">
          <div><div>Dev Mode</div><div style="font-size:11px;color:var(--muted)">Unlock leaderboard management</div></div>
          ${tog(devOn, 'window.toggleDevMode(this.checked)')}
        </div>
      </div>

      <!-- Sign Out -->
      <div class="mob-v-setting-group">
        <div class="mob-v-setting-row" style="border:none">
          <span style="color:var(--neg)">Sign Out</span>
          <button class="mob-v-setting-btn" style="color:var(--neg);border-color:rgba(255,77,109,0.4)" onclick="window.resetDashboard()">Sign Out</button>
        </div>
      </div>
    </div>`
    return
  }

  if (_mobVActiveTab === 'accounts') {
    const stale = Date.now() - _mobVMaLastFetch > 30_000
    if (_mobVMaResults.length && !stale) {
      el.innerHTML = _mobVBuildAccountsHtml(_mobVMaResults)
      setTimeout(() => _mobVAfterMaRender(_mobVMaResults), 10)
    } else {
      if (!_mobVMaResults.length) el.innerHTML = `<div class="mob-v-empty">Loading accounts…</div>`
      _mobVFetchAccounts(el)
    }
    return
  }

  if (_mobVActiveTab === 'portfolio') {
    const stats = computeAcctStats(state.perpState, state.spotState, state.fills, state.portfolio)
    const { accountValue, unrealizedPnl, realizedPnl, netPnl, healthStr, healthCls, maintMargin, withdrawable } = stats
    const fills    = state.fills ?? []
    const funding  = state.funding ?? []
    const ledger   = state.ledger ?? []
    let totalDeposited = 0, totalWithdrawn = 0
    for (const e of ledger) {
      const t = e.delta?.type
      if (t === 'deposit') totalDeposited += parseFloat(e.delta.usdc ?? 0)
      else if (t === 'send' && e.delta?.token === 'USDC') totalDeposited += parseFloat(e.delta.usdcValue ?? 0)
      else if (t === 'withdraw') totalWithdrawn += parseFloat(e.delta.usdc ?? 0)
    }
    const netDeposited  = totalDeposited - totalWithdrawn
    const totalFees     = fills.reduce((s, f) => s + (f.fee ?? 0), 0)
    const netFunding    = funding.reduce((s, f) => s + (f.usdc ?? 0), 0)
    const totalVol      = fills.reduce((s, f) => s + (f.notional ?? 0), 0)
    const ONE_HOUR = 3600000
    const windows  = {}
    for (const f of fills.filter(f => f.closedPnl !== 0)) {
      const key = `${f.coin}_${Math.floor(f.time / ONE_HOUR)}`
      windows[key] = (windows[key] ?? 0) + f.closedPnl - f.fee
    }
    const allW    = Object.values(windows)
    const winRate = allW.length > 0 ? (allW.filter(n => n > 0).length / allW.length * 100).toFixed(1) + '%' : '—'
    const pnlFmt = v => (v >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(v))
    const pnlCls = v => v >= 0 ? 'pos' : 'neg'
    const btnStyle = (active) => `padding:4px 10px;border:1px solid var(--border2);border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;touch-action:manipulation;background:${active ? 'var(--panel-2)' : 'transparent'};color:${active ? 'var(--fg)' : 'var(--muted)'}`
    const periods   = [['1D','1D'],['7D','7D'],['1M','1M'],['All','allTime']]
    const chartTypes = [['Value','value'],['Accum. PnL','pnl'],['Realized','realized']]
    el.innerHTML = `<div style="padding:0 0 24px">
      <div style="display:flex;gap:4px;padding:12px 16px 0;overflow-x:auto;scrollbar-width:none">
        ${chartTypes.map(([lbl,t]) => `<button data-port-type="${t}" onclick="window.mobVSetPortChartType('${t}')"
          style="${btnStyle(t === _mobVPortChartType)}">${lbl}</button>`).join('')}
        <span style="flex:1"></span>
        ${periods.map(([lbl,val]) => `<button data-port-period="${val}" onclick="window.mobVSetPortPeriod('${val}')"
          style="${btnStyle(val === _mobVPortPeriod)}">${lbl}</button>`).join('')}
      </div>
      <div id="mobVPortHero" style="padding:8px 16px 4px;min-height:44px"></div>
      <div style="padding:0 16px 8px">
        <canvas id="mobVPortChart" height="120" style="width:100%;display:block"></canvas>
      </div>
      <div class="mob-v-setting-group" style="margin-top:8px">
        <div class="mob-v-setting-row"><span>Account Value</span><span style="font-weight:600;font-size:14px">${_acctValueReady() ? _prv('$' + fmtUSD(accountValue)) : '<span style="color:var(--muted)">—</span>'}</span></div>
        <div class="mob-v-setting-row"><span>Unrealized PnL</span><span class="${pnlCls(unrealizedPnl)}" style="font-weight:600;font-size:14px">${_prv(pnlFmt(unrealizedPnl))}</span></div>
        <div class="mob-v-setting-row"><span>Realized PnL</span><span class="${pnlCls(realizedPnl)}" style="font-weight:600;font-size:14px">${_prv(pnlFmt(realizedPnl))}</span></div>
        <div class="mob-v-setting-row"><span>Net PnL</span><span class="${pnlCls(netPnl)}" style="font-weight:600;font-size:14px">${_prv(pnlFmt(netPnl))}</span></div>
        ${netFunding !== 0 ? `<div class="mob-v-setting-row"><span>Net Funding</span><span class="${pnlCls(netFunding)}" style="font-weight:600;font-size:14px">${_prv(pnlFmt(netFunding))}</span></div>` : ''}
        <div class="mob-v-setting-row"><span>Health</span><span class="${healthCls}" style="font-weight:600;font-size:14px">${healthStr}</span></div>
        <div class="mob-v-setting-row"><span>Withdrawable</span><span style="font-weight:600;font-size:14px">$${fmtUSD(withdrawable)}</span></div>
        <div class="mob-v-setting-row"><span>Margin Used</span><span style="font-weight:600;font-size:14px">$${fmtUSD(maintMargin)}</span></div>
        ${totalFees > 0 ? `<div class="mob-v-setting-row"><span>Total Fees</span><span class="neg" style="font-weight:600;font-size:14px">-$${fmtUSD(totalFees)}</span></div>` : ''}
        ${totalVol > 0 ? `<div class="mob-v-setting-row"><span>Total Volume</span><span style="font-weight:600;font-size:14px">$${fmtCompact(totalVol)}</span></div>` : ''}
        <div class="mob-v-setting-row"><span>Win Rate</span><span style="font-weight:600;font-size:14px">${winRate}</span></div>
        ${totalDeposited > 0 ? `<div class="mob-v-setting-row"><span>Total Deposited</span><span style="font-weight:600;font-size:14px">$${fmtUSD(totalDeposited)}</span></div>` : ''}
        ${totalWithdrawn > 0 ? `<div class="mob-v-setting-row"><span>Total Withdrawn</span><span style="font-weight:600;font-size:14px">$${fmtUSD(totalWithdrawn)}</span></div>` : ''}
        ${(totalDeposited > 0 || totalWithdrawn > 0) ? `<div class="mob-v-setting-row"><span>Net Deposited</span><span class="${accountValue >= netDeposited ? 'pos' : 'neg'}" style="font-weight:600;font-size:14px">${pnlFmt(netDeposited)}</span></div>` : ''}
      </div>
    </div>`
    setTimeout(_mobVDrawPortChart, 10)
    return
  }

  if (_mobVActiveTab === 'calendar') {
    const now = new Date()
    if (state.calMonth == null) state.calMonth = now.getMonth()
    if (state.calYear  == null) state.calYear  = now.getFullYear()
    el.innerHTML = `<div style="padding:0 8px"><div id="mobCalRoot"></div></div><div id="mobCalDetail" class="cal-detail" style="margin:8px 16px 0"></div>`
    try {
      renderPnLCalendar(state.fills ?? [], state.calMonth, state.calYear, state.ledger ?? [], 'mobCalRoot', 'mobCalNav', 'mobCalDetail')
    } catch (e) {
      console.error('[mobile calendar]', e)
      el.innerHTML = `<div class="mob-v-empty">Calendar failed to load: ${esc(e.message)}</div>`
    }
    return
  }

  if (_mobVActiveTab === 'tokens') {
    const fills = state.fills ?? []
    if (!fills.length) { el.innerHTML = `<div class="mob-v-empty">No trades yet</div>`; return }
    const coinMap = {}
    for (const f of fills) {
      if (!coinMap[f.coin]) coinMap[f.coin] = []
      coinMap[f.coin].push({ ...f, notional: (f.sz ?? 0) * (f.px ?? 0), closedPnl: f.closedPnl ?? 0 })
    }
    const allStats = Object.entries(coinMap)
      .map(([coin, cf]) => computeCoinStats(coin, cf, parseFloat(state.allMids?.[coin] ?? 0)))
      .sort((a, b) => Math.abs(b.totalPnl) - Math.abs(a.totalPnl))
    el.innerHTML = allStats.map(s => {
      const cls = s.totalPnl >= 0 ? 'pos' : 'neg'
      const wl  = s.longs + s.shorts
      const wr  = wl > 0 ? Math.round((s.longsWon + s.shortsWon) / wl * 100) : 0
      return `<div class="mob-v-row">
        ${_mobVCoinIcon(s.coin)}
        <div class="mob-v-row-info">
          <div class="mob-v-row-name">${esc(s.coin)}</div>
          <div class="mob-v-row-sub">${s.fills} trades · ${wr}% win</div>
        </div>
        <div class="mob-v-row-right">
          <div class="mob-v-row-val ${cls}">${s.totalPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(s.totalPnl))}</div>
          <div class="mob-v-row-pct" style="color:var(--muted)">$${fmtUSD(s.volume)} vol</div>
        </div>
      </div>`
    }).join('')
    return
  }

  if (_mobVActiveTab === 'watch') {
    const list = loadWatchlist()
    el.innerHTML = `
      <div style="padding:12px 16px;position:sticky;top:0;background:var(--panel-1);z-index:10;border-bottom:1px solid var(--border)">
        <div style="position:relative">
          <input id="mobWatchSearchInput" type="text" placeholder="Search to add coins…"
            oninput="window.__mobWatchSearch(this.value)"
            style="width:100%;box-sizing:border-box;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;padding:8px 12px;font-size:13px;color:var(--fg);outline:none"
          />
          <div id="mobWatchSearchResults" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;margin-top:4px;overflow:hidden;z-index:20;box-shadow:0 4px 16px rgba(0,0,0,.4)"></div>
        </div>
      </div>
      ${!list.length
        ? `<div class="mob-v-empty">No coins in watchlist.<br>Search above to add coins.</div>`
        : list.map(coin => {
            const px = parseFloat(state.allMids?.[coin] ?? 0)
            return `<div class="mob-v-row">
              ${_mobVCoinIcon(coin)}
              <div class="mob-v-row-info">
                <div class="mob-v-row-name">${esc(watchCoinLabel(coin))}</div>
                <div class="mob-v-row-sub">${coin.startsWith('@') ? 'Spot' : 'Perp'}</div>
              </div>
              <div class="mob-v-row-right">
                <div class="mob-v-row-val">${px > 0 ? '$' + fmtPrice(px) : '—'}</div>
              </div>
              <button onclick="window.__mobWatchRemove('${esc(coin)}')" style="background:none;border:none;color:var(--muted);padding:8px 4px 8px 10px;cursor:pointer;flex-shrink:0;line-height:0">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>`
          }).join('')
      }
    `
    return
  }

  if (_mobVActiveTab === 'strategies') {
    _mobVRenderStrategies(el)
    return
  }

  if (_mobVActiveTab === 'performance') {
    el.innerHTML = `<div class="mob-v-empty">Loading…</div>`
    _mobVFetchPerformance(el)
    return
  }

  if (_mobVActiveTab === 'news') {
    el.innerHTML = `<div style="padding:90px 20px;text-align:center;color:var(--muted)">
      <div style="font-size:42px;margin-bottom:14px">📰</div>
      <div style="font-size:17px;font-weight:700;color:var(--fg);margin-bottom:6px">News</div>
      <div style="font-size:13px">Coming soon</div>
    </div>`
    return
  }

  if (_mobVActiveTab === 'trade') {
    if (_mobTradeView === 'list') { _mobRenderTradeList(el); return }
    _mobRenderTradeDetail(el)
    return
  }
}

function _mobVSubPosRow(ap, pid) {
  const p      = ap.position
  const sz     = parseFloat(p.szi ?? 0)
  const pnl    = parseFloat(p.unrealizedPnl ?? 0)
  const roe    = parseFloat(p.returnOnEquity ?? 0) * 100
  const markPx = parseFloat(state.allMids?.[p.coin] ?? 0)
  const liqPx  = parseFloat(p.liquidationPx ?? 0)
  const margin = parseFloat(p.marginUsed ?? 0)
  const lev    = p.leverage?.value ? p.leverage.value + 'x' : ''
  const sc     = sz > 0 ? 'var(--green)' : 'var(--red)'
  const pc     = pnl >= 0 ? 'var(--green)' : 'var(--red)'
  const xp     = _mobVExpandedIds.has(pid)
  const detail = _mobVDetailGrid([
    ['Size',    fmtSize(Math.abs(sz)) + ' ' + esc(_ocCoinLabel(p.coin))],
    ['Entry',   '$' + fmtPrice(p.entryPx)],
    ['Mark',    markPx > 0 ? '$' + fmtPrice(markPx) : '—'],
    ['PnL',     (pnl >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(pnl)), pc],
    ['ROE',     (roe >= 0 ? '+' : '') + roe.toFixed(2) + '%', pc],
    ['Lev',     lev || '—'],
    ['Liq',     liqPx > 0 ? '$' + fmtPrice(liqPx) : '—'],
    ['Margin',  margin > 0 ? '$' + fmtUSD(margin) : '—'],
  ])
  return `<div>
    <div style="display:grid;grid-template-columns:1fr auto auto 14px;align-items:center;gap:6px;padding:8px 16px;cursor:pointer;background:var(--panel-2)" onclick="window._mobVToggleRow('${pid}')">
      <span style="font-size:13px;font-weight:600;color:var(--fg)">${esc(_ocCoinLabel(p.coin))}${lev ? `<span style="font-size:10px;color:var(--muted);margin-left:4px">${lev}</span>` : ''}</span>
      <span style="font-size:10px;color:${sc};font-weight:700;padding:1px 5px;background:${sz>0?'rgba(0,229,160,0.1)':'rgba(255,77,109,0.1)'};border-radius:4px">${sz > 0 ? 'Long' : 'Short'}</span>
      <span style="font-size:12px;font-weight:600;color:${pc}">${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))}</span>
      <svg id="mrc-${pid}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>
    </div>
    <div id="mrd-${pid}" style="display:${xp ? '' : 'none'}">${detail}</div>
  </div>`
}

function _mobVSubOrdRow(o, oid) {
  const side    = o.side === 'B' ? 'Buy' : 'Sell'
  const sc      = o.side === 'B' ? 'var(--green)' : 'var(--red)'
  const trigPx  = parseFloat(o.triggerPx ?? 0)
  const limPx   = parseFloat(o.limitPx ?? 0)
  const px      = trigPx || limPx
  const isTrig  = trigPx > 0
  const isTp    = o.orderType?.startsWith('Take Profit') || o.triggerCondition === 'tp'
  const isSl    = o.orderType?.startsWith('Stop') || o.triggerCondition === 'sl'
  const typeStr = isTp ? 'Take Profit' : isSl ? 'Stop Loss' : isTrig ? 'Trigger' : 'Limit'
  const xp      = _mobVExpandedIds.has(oid)
  const detail  = _mobVDetailGrid([
    ['Type',   typeStr],
    ['Size',   fmtSize(parseFloat(o.sz ?? 0)) + ' ' + esc(_ocCoinLabel(o.coin))],
    ['Price',  px > 0 ? '$' + fmtPrice(px) : '—'],
    ...(isTrig && limPx > 0 ? [['Limit Px', '$' + fmtPrice(limPx)]] : []),
  ])
  return `<div>
    <div style="display:grid;grid-template-columns:1fr auto auto 14px;align-items:center;gap:6px;padding:8px 16px;cursor:pointer;background:var(--panel-2)" onclick="window._mobVToggleRow('${oid}')">
      <span style="font-size:13px;font-weight:600;color:var(--fg)">${esc(_ocCoinLabel(o.coin))}</span>
      <span style="font-size:10px;color:${sc};font-weight:700;padding:1px 5px;background:${o.side==='B'?'rgba(0,229,160,0.1)':'rgba(255,77,109,0.1)'};border-radius:4px">${side}</span>
      <span style="font-size:12px;font-weight:600;color:var(--fg)">${px > 0 ? '$' + fmtPrice(px) : '—'}</span>
      <svg id="mrc-${oid}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>
    </div>
    <div id="mrd-${oid}" style="display:${xp ? '' : 'none'}">${detail}</div>
  </div>`
}

function _mobVSubOcRow(b, ocid) {
  const n      = parseInt(String(b.coin).replace(/[^\d]/g, '')) || 0
  const oid    = Math.floor(n / 10)
  const tok    = state.ocTokenMap?.['#' + n] || {}
  const market = state.ocQuestionMap?.[oid] || tok.name || _ocCoinLabel(b.coin)
  const side   = tok.side || _ocCoinLabel(b.coin)
  const pc     = b.pnl >= 0 ? 'var(--green)' : 'var(--red)'
  const xp     = _mobVExpandedIds.has(ocid)
  const cent   = v => (v * 100).toFixed(2) + '¢'
  const detail = _mobVDetailGrid([
    ['Size',      fmtSize(b.total) + ' ' + esc(side)],
    ['Position Value', '$' + fmtUSD(b.value)],
    ['Entry',     cent(b.entry)],
    ['Mark',      cent(b.mark)],
    ['Cost',      '$' + fmtUSD(b.cost)],
    ['PnL',       (b.pnl >= 0 ? '+' : '-') + '$' + fmtUSD(Math.abs(b.pnl)), pc],
    ['ROE',       (b.roe >= 0 ? '+' : '') + b.roe.toFixed(2) + '%', pc],
    ['In Orders', b.hold > 0 ? fmtSize(b.hold) : '—'],
  ])
  return `<div>
    <div style="display:grid;grid-template-columns:1fr auto auto 14px;align-items:center;gap:6px;padding:8px 16px;cursor:pointer;background:var(--panel-2)" onclick="window._mobVToggleRow('${ocid}')">
      <div style="min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(market)}</div>
        <div style="font-size:11px;color:var(--muted)">${esc(side)}</div>
      </div>
      <span style="font-size:10px;color:var(--muted);font-weight:600">${cent(b.mark)}</span>
      <span style="font-size:12px;font-weight:600;color:${pc}">${b.pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(b.pnl))}</span>
      <svg id="mrc-${ocid}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>
    </div>
    <div id="mrd-${ocid}" style="display:${xp ? '' : 'none'}">${detail}</div>
  </div>`
}

function _mobVBuildAccountsHtml(results) {
  const hidden  = _maHiddenLoad()
  const vis     = results.filter(r => !hidden.has(r.addr))
  const pnlFmt  = v => (v >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(v))
  const pnlCls  = v => v >= 0 ? 'pos' : 'neg'

  // Aggregate bar
  const totalValue  = vis.reduce((s, r) => s + (r.error ? 0 : r.accountValue  ?? 0), 0)
  const totalUnreal = vis.reduce((s, r) => s + (r.error ? 0 : r.unrealizedPnl ?? 0), 0)
  const totalNet    = vis.reduce((s, r) => s + (r.error ? 0 : r.netPnl        ?? 0), 0)
  const totalReal   = vis.reduce((s, r) => s + (r.error ? 0 : r.realizedPnl   ?? 0), 0)
  const totalDep    = vis.reduce((s, r) => s + (r.error ? 0 : r.totalDeposited ?? 0), 0)
  const totalWith   = vis.reduce((s, r) => s + (r.error ? 0 : r.totalWithdrawn ?? 0), 0)
  const totalVol    = vis.reduce((s, r) => s + (r.error ? 0 : r.totalVolume    ?? 0), 0)
  const totalFees   = vis.reduce((s, r) => s + (r.error ? 0 : r.totalFees      ?? 0), 0)
  const winCount    = vis.reduce((s, r) => s + (r.error ? 0 : r.winCount       ?? 0), 0)
  const totalWin    = vis.reduce((s, r) => s + (r.error ? 0 : r.totalWindows   ?? 0), 0)
  const winRate     = totalWin > 0 ? (winCount / totalWin * 100).toFixed(1) + '%' : '—'
  const netDep      = totalDep - totalWith

  // Per-account rows
  const accountRows = vis.map((r, i) => {
    const id    = `ma-mob-${i}`
    const xp    = _mobVExpandedIds.has(id)
    const label = r.label || (r.addr.slice(0, 6) + '…' + r.addr.slice(-4))
    const chev  = `<svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`

    if (r.error) return `<div class="mob-v-row">${_mobVAvatarHtml(r.addr, 36)}<div class="mob-v-row-info" style="margin-left:12px"><div class="mob-v-row-name">${esc(label)}</div><div class="mob-v-row-sub" style="color:var(--red)">Failed to load</div></div></div>`

    const hStr  = r.accountValue > 0 ? (r.healthPct ?? 0).toFixed(1) + '%' : '—'
    const hCls  = r.healthCls ?? 'pos'
    const actPos = (r.positions ?? []).filter(ap => parseFloat(ap.position?.szi ?? 0) !== 0)

    const actOrders = r.openOrders ?? []
    const expandHtml = _mobVDetailGrid([
      ['Unrealized', pnlFmt(r.unrealizedPnl), r.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)'],
      ['Realized',   pnlFmt(r.realizedPnl),   r.realizedPnl   >= 0 ? 'var(--green)' : 'var(--red)'],
      ['Net PnL',    pnlFmt(r.netPnl),        r.netPnl        >= 0 ? 'var(--green)' : 'var(--red)'],
      ['Health',     hStr,                    hCls === 'pos' ? 'var(--green)' : hCls === 'warn' ? 'var(--orange)' : 'var(--red)'],
      ['Withdrawable', '$' + fmtUSD(r.withdrawable ?? 0)],
    ]) +
    (actPos.length ? `<div style="border-bottom:1px solid rgba(255,255,255,0.04)">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;padding:8px 16px 4px;background:var(--panel-2)">${actPos.length} Open Position${actPos.length !== 1 ? 's' : ''}</div>
      ${actPos.map((ap, pi) => _mobVSubPosRow(ap, `${id}-p${pi}`)).join('')}
    </div>` : '') +
    (actOrders.length ? `<div style="border-bottom:1px solid rgba(255,255,255,0.04)">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;padding:8px 16px 4px;background:var(--panel-2)">${actOrders.length} Open Order${actOrders.length !== 1 ? 's' : ''}</div>
      ${actOrders.map((o, oi) => _mobVSubOrdRow(o, `${id}-o${oi}`)).join('')}
    </div>` : '')

    return `<div>
      <div class="mob-v-row" style="cursor:pointer" onclick="window._mobVToggleRow('${id}')">
        ${_mobVAvatarHtml(r.addr, 36)}
        <div class="mob-v-row-info" style="margin-left:12px">
          <div class="mob-v-row-name">${esc(label)}</div>
          <div class="mob-v-row-sub">${r.addr.slice(0, 6)}…${r.addr.slice(-4)}</div>
        </div>
        <div class="mob-v-row-right">
          <div class="mob-v-row-val">$${fmtUSD(r.accountValue)}</div>
          <div class="mob-v-row-pct ${pnlCls(r.unrealizedPnl)}">${pnlFmt(r.unrealizedPnl)}</div>
        </div>
        ${chev}
      </div>
      <div id="mrd-${id}" style="display:${xp ? '' : 'none'}">${expandHtml}</div>
    </div>`
  }).join('')

  const chartTypes = [['Value','value'],['Accum. PnL','pnl'],['Realized','realized']]
  const periods    = [['1D','1D'],['7D','7D'],['1M','1M'],['All','allTime']]
  const sectionHdr = (title) => `<div style="padding:10px 16px 4px;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;border-top:1px solid rgba(255,255,255,0.06);margin-top:4px">${title}</div>`

  return `<div style="padding:0 0 24px">
    <div class="mob-v-setting-group" style="margin:12px 0 4px">
      <div class="mob-v-setting-row"><span>Total Value</span><span style="font-weight:600;font-size:14px">$${fmtUSD(totalValue)}</span></div>
      <div class="mob-v-setting-row"><span>Unrealized PnL</span><span class="${pnlCls(totalUnreal)}" style="font-weight:600;font-size:14px">${pnlFmt(totalUnreal)}</span></div>
      <div class="mob-v-setting-row"><span>Realized PnL</span><span class="${pnlCls(totalReal)}" style="font-weight:600;font-size:14px">${pnlFmt(totalReal)}</span></div>
      <div class="mob-v-setting-row"><span>Net PnL</span><span class="${pnlCls(totalNet)}" style="font-weight:600;font-size:14px">${pnlFmt(totalNet)}</span></div>
      ${totalDep > 0 ? `<div class="mob-v-setting-row"><span>Total Deposited</span><span style="font-weight:600;font-size:14px">$${fmtUSD(totalDep)}</span></div>` : ''}
      ${totalWith > 0 ? `<div class="mob-v-setting-row"><span>Total Withdrawn</span><span style="font-weight:600;font-size:14px">$${fmtUSD(totalWith)}</span></div>` : ''}
      ${(totalDep > 0 || totalWith > 0) ? `<div class="mob-v-setting-row"><span>Net Deposited</span><span class="${totalValue >= netDep ? 'pos' : 'neg'}" style="font-weight:600;font-size:14px">${pnlFmt(netDep)}</span></div>` : ''}
      <div class="mob-v-setting-row"><span>Total Volume</span><span style="font-weight:600;font-size:14px">$${fmtCompact(totalVol)}</span></div>
      <div class="mob-v-setting-row"><span>Total Fees</span><span class="neg" style="font-weight:600;font-size:14px">-$${fmtUSD(totalFees)}</span></div>
      <div class="mob-v-setting-row"><span>Win Rate</span><span style="font-weight:600;font-size:14px">${winRate}</span></div>
    </div>

    ${sectionHdr('Combined Chart')}
    <div style="display:flex;gap:4px;padding:8px 16px 0;overflow-x:auto;scrollbar-width:none">
      ${chartTypes.map(([lbl,t]) => `<button data-ma-type="${t}" onclick="window.mobVSetMaChartType('${t}')" style="${_mobVMaBtnStyle(t === _mobVMaChartType)}">${lbl}</button>`).join('')}
      <span style="flex:1"></span>
      ${periods.map(([lbl,val]) => `<button data-ma-period="${val}" onclick="window.mobVSetMaPeriod('${val}')" style="${_mobVMaBtnStyle(val === _mobVMaPeriod)}">${lbl}</button>`).join('')}
    </div>
    <div id="mobMaHero" style="padding:8px 16px 4px;min-height:44px"></div>
    <div style="padding:0 16px 8px">
      <canvas id="mobMaChart" height="140" style="width:100%;display:block"></canvas>
    </div>

    ${sectionHdr(vis.length + ' Account' + (vis.length !== 1 ? 's' : ''))}
    ${accountRows || '<div class="mob-v-empty">No accounts</div>'}

    ${sectionHdr('PnL Calendar')}
    <div id="mobMaCalRoot" style="padding:0 8px"></div>
    <div id="mobMaCalDetail" class="cal-detail" style="margin:8px 16px 0"></div>
  </div>`
}

function _mobVAfterMaRender(results) {
  _mobVDrawMaChart(results)
  const hidden    = _maHiddenLoad()
  const vis       = results.filter(r => !hidden.has(r.addr) && !r.error)
  const allFills  = vis.flatMap(r => (r.fills ?? []).map(f => ({ ...f, _label: r.label || r.addr.slice(0, 6) + '…' })))
  const allLedger = vis.flatMap(r => (r.ledgerEntries ?? []).map(e => ({ ...e, _label: r.label || r.addr.slice(0, 6) + '…' })))
  renderPnLCalendar(allFills, _mobVMaCalMonth, _mobVMaCalYear, allLedger, 'mobMaCalRoot', 'mobVMaCalNav', 'mobMaCalDetail')
}

async function _mobVFetchAccounts(el) {
  const entries = _maLoad()
  if (!entries.length) {
    el.innerHTML = `<div class="mob-v-empty">No saved wallets yet.<br>Add wallets using the wallet switcher.</div>`
    return
  }
  let results = await _lbFetchResults(entries)
  results = await _maEnrichResults(results, true)
  _mobVMaLastFetch = Date.now()
  _mobVMaResults   = results
  el.innerHTML = _mobVBuildAccountsHtml(results)
  setTimeout(() => _mobVAfterMaRender(results), 10)
}

function _mobVMaHeroHtml(hist, vals, idx, chartType) {
  const val = vals[idx]
  const ts  = hist[idx][0]
  const date = new Date(+ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const isLatest = idx === vals.length - 1
  if (chartType === 'value') {
    const base = vals[0]; const diff = val - base; const pct = base > 0 ? diff / base * 100 : 0
    const sign = diff >= 0 ? '+' : '-'; const cls = diff >= 0 ? 'pos' : 'neg'
    return `<div style="font-size:22px;font-weight:700;color:var(--fg)">$${fmtUSD(val)}</div><div style="font-size:13px;margin-top:2px" class="${cls}">${sign}$${fmtUSD(Math.abs(diff))} (${sign}${Math.abs(pct).toFixed(2)}%)</div>${!isLatest ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${date}</div>` : ''}`
  } else {
    const sign = val >= 0 ? '+' : '-'; const cls = val >= 0 ? 'pos' : 'neg'
    return `<div style="font-size:22px;font-weight:700" class="${cls}">${sign}$${fmtUSD(Math.abs(val))}</div>${!isLatest ? `<div style="font-size:11px;color:var(--muted);margin-top:2px">${date}</div>` : ''}`
  }
}

function _mobVDrawMaCanvas(canvas, crosshairIdx) {
  const d = _mobVMaChartData
  if (!d) return
  const { pts, vals, hist, W, H, isUp, color, dpr, min, max, range, padY, chartType } = d
  const ctx = canvas.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)
  const smoothPath = p => {
    ctx.moveTo(p[0][0], p[0][1])
    for (let i = 0; i < p.length - 1; i++) {
      const mx = (p[i][0] + p[i+1][0]) / 2, my = (p[i][1] + p[i+1][1]) / 2
      ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my)
    }
    ctx.lineTo(p.at(-1)[0], p.at(-1)[1])
  }
  const grad = ctx.createLinearGradient(0, 0, 0, H)
  grad.addColorStop(0, isUp ? 'rgba(0,229,160,0.22)' : 'rgba(255,77,109,0.22)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.beginPath(); ctx.moveTo(pts[0][0], H); smoothPath(pts); ctx.lineTo(pts.at(-1)[0], H); ctx.closePath()
  ctx.fillStyle = grad; ctx.fill()
  if (chartType !== 'value' && min < 0 && max > 0) {
    const zeroY = H - padY - ((0 - min) / range) * (H - padY * 2)
    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.18)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    ctx.moveTo(0, zeroY); ctx.lineTo(W, zeroY); ctx.stroke(); ctx.setLineDash([])
  }
  ctx.beginPath(); smoothPath(pts); ctx.strokeStyle = color; ctx.lineWidth = 1.8; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.stroke()
  const fmtAxisVal = v => Math.abs(v) >= 1000 ? (v >= 0 ? '' : '-') + '$' + fmtUSD(Math.abs(v), 0) : (v >= 0 ? '' : '-') + '$' + Math.abs(v).toFixed(2)
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.fillStyle = 'rgba(255,255,255,0.35)'
  ctx.fillText(fmtAxisVal(max), W - 3, padY + 9); ctx.fillText(fmtAxisVal(min), W - 3, H - padY - 2)
  if (crosshairIdx >= 0 && crosshairIdx < pts.length) {
    const cp = pts[crosshairIdx]
    ctx.beginPath(); ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.setLineDash([4, 4])
    ctx.moveTo(cp[0], 0); ctx.lineTo(cp[0], H); ctx.stroke(); ctx.setLineDash([])
    ctx.beginPath(); ctx.arc(cp[0], cp[1], 4, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill()
    ctx.beginPath(); ctx.arc(cp[0], cp[1], 4, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 1.5; ctx.stroke()
  } else {
    const lp = pts.at(-1); ctx.shadowColor = color; ctx.shadowBlur = 8
    ctx.beginPath(); ctx.arc(lp[0], lp[1], 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill(); ctx.shadowBlur = 0
  }
}

function _mobVMaTouchMove(e) {
  e.preventDefault()
  if (!_mobVMaChartData) return
  const { pts, vals, hist, chartType } = _mobVMaChartData
  const canvas = document.getElementById('mobMaChart')
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.touches[0].clientX - rect.left
  let minDist = Infinity, nearestIdx = 0
  for (let i = 0; i < pts.length; i++) {
    const d = Math.abs(pts[i][0] - x)
    if (d < minDist) { minDist = d; nearestIdx = i }
  }
  _mobVDrawMaCanvas(canvas, nearestIdx)
  const heroEl = document.getElementById('mobMaHero')
  if (heroEl) heroEl.innerHTML = _mobVMaHeroHtml(hist, vals, nearestIdx, chartType)
}

function _mobVMaTouchEnd() { _mobVDrawMaChart(_mobVMaResults) }

function _mobVDrawMaChart(results) {
  const canvas = document.getElementById('mobMaChart')
  if (!canvas) return
  const aggregated = _maAggregatePortfolioData(results)
  if (!aggregated) return
  const periodKey = { '1D': 'day', '7D': 'week', '1M': 'month', 'allTime': 'allTime' }[_mobVMaPeriod] ?? 'allTime'
  const entry = aggregated.find(p => p[0] === periodKey)
  const heroEl = document.getElementById('mobMaHero')
  let hist = []
  if (_mobVMaChartType === 'value') {
    hist = entry?.[1]?.accountValueHistory ?? []
  } else if (_mobVMaChartType === 'pnl') {
    hist = entry?.[1]?.pnlHistory ?? []
  } else {
    const pnlH = entry?.[1]?.pnlHistory ?? []
    const buckets = pnlH.map(p => +p[0])
    if (buckets.length >= 2) {
      const cutoffMs = { '1D': 86400000, '7D': 7 * 86400000, '1M': 30 * 86400000 }[_mobVMaPeriod]
      const cutoffTs = cutoffMs ? Date.now() - cutoffMs : 0
      const hidden = _maHiddenLoad()
      const vis = (results ?? []).filter(r => !hidden.has(r.addr) && !r.error)
      const allFills = vis.flatMap(r => r.fills ?? []).filter(f => !cutoffTs || f.time >= cutoffTs)
      const bucketPnl = new Array(buckets.length).fill(0)
      for (const f of allFills) {
        if (!f.closedPnl) continue
        let idx = buckets.findIndex((ts, j) => ts > f.time || j === buckets.length - 1)
        if (idx < 0) idx = buckets.length - 1
        bucketPnl[idx] += f.closedPnl
      }
      let running = 0
      hist = buckets.map((ts, i) => [ts, (running += bucketPnl[i]).toString()])
    }
  }
  if (hist.length < 2) {
    if (heroEl) heroEl.innerHTML = `<div style="color:var(--muted);font-size:12px">No data for period</div>`
    return
  }
  const dpr = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  const displayW = Math.round(rect.width) || 320
  const displayH = 140
  canvas.width = displayW * dpr; canvas.height = displayH * dpr
  canvas.style.width = displayW + 'px'; canvas.style.height = displayH + 'px'
  const W = displayW, H = displayH
  const vals = hist.map(h => parseFloat(h[1]))
  const min = Math.min(...vals), max = Math.max(...vals), range = max - min || 1
  const padY = H * 0.12
  const pts = vals.map((v, i) => [i / (vals.length - 1) * (W - 4), H - padY - ((v - min) / range) * (H - padY * 2)])
  const lastV = vals.at(-1)
  const isUp = _mobVMaChartType === 'value' ? lastV >= vals[0] : lastV >= 0
  const color = isUp ? '#00e5a0' : '#ff4d6d'
  if (heroEl) heroEl.innerHTML = _mobVMaHeroHtml(hist, vals, hist.length - 1, _mobVMaChartType)
  _mobVMaChartData = { hist, pts, vals, W, H, isUp, color, dpr, min, max, range, padY, chartType: _mobVMaChartType }
  _mobVDrawMaCanvas(canvas, -1)
  if (!canvas._maTouchBound) {
    canvas._maTouchBound = true
    canvas.addEventListener('touchstart', _mobVMaTouchMove, { passive: false })
    canvas.addEventListener('touchmove',  _mobVMaTouchMove, { passive: false })
    canvas.addEventListener('touchend',   _mobVMaTouchEnd)
  }
}

const _mobVMaBtnStyle = (active) => `padding:4px 10px;border:1px solid var(--border2);border-radius:6px;font-size:11px;font-weight:600;cursor:pointer;touch-action:manipulation;background:${active?'var(--panel-2)':'transparent'};color:${active?'var(--fg)':'var(--muted)'}`

window.mobVSetMaPeriod = function(p) {
  _mobVMaPeriod = p
  document.querySelectorAll('[data-ma-period]').forEach(btn => {
    btn.style.cssText = _mobVMaBtnStyle(btn.dataset.maPeriod === p)
  })
  _mobVDrawMaChart(_mobVMaResults)
}

window.mobVSetMaChartType = function(t) {
  _mobVMaChartType = t
  document.querySelectorAll('[data-ma-type]').forEach(btn => {
    btn.style.cssText = _mobVMaBtnStyle(btn.dataset.maType === t)
  })
  _mobVDrawMaChart(_mobVMaResults)
}

window.mobVMaCalNav = function(dir) {
  _mobVMaCalMonth += dir
  if (_mobVMaCalMonth > 11) { _mobVMaCalMonth = 0; _mobVMaCalYear++ }
  if (_mobVMaCalMonth < 0)  { _mobVMaCalMonth = 11; _mobVMaCalYear-- }
  const hidden    = _maHiddenLoad()
  const vis       = (_mobVMaResults ?? []).filter(r => !hidden.has(r.addr) && !r.error)
  const allFills  = vis.flatMap(r => (r.fills ?? []).map(f => ({ ...f, _label: r.label || r.addr.slice(0, 6) + '…' })))
  const allLedger = vis.flatMap(r => (r.ledgerEntries ?? []).map(e => ({ ...e, _label: r.label || r.addr.slice(0, 6) + '…' })))
  const detail = document.getElementById('mobMaCalDetail')
  if (detail) { detail.innerHTML = ''; detail.dataset.activeKey = '' }
  renderPnLCalendar(allFills, _mobVMaCalMonth, _mobVMaCalYear, allLedger, 'mobMaCalRoot', 'mobVMaCalNav', 'mobMaCalDetail')
}

window._mobVLbSort = function(by) {
  _mobVLbSortBy = by
  const el = document.getElementById('mobVContent')
  if (el && _mobVLbResults.length) el.innerHTML = _mobVBuildLbHtml(_mobVLbResults)
}

function _mobVBuildLbHtml(results) {
  const RANK_BADGE = [
    { bg: 'linear-gradient(135deg,#FFD700,#FFA500)', color: '#7a4800', label: '👑' },
    { bg: 'linear-gradient(135deg,#D8D8D8,#A8A8A8)', color: '#444',    label: '2' },
    { bg: 'linear-gradient(135deg,#E8A96A,#B87333)', color: '#5a2a00', label: '3' },
  ]
  const key    = _mobVLbSortBy === 'net' ? 'netPnl' : 'accountValue'
  const sorted = [...results].sort((a, b) => (b.error ? -Infinity : (b[key] ?? 0)) - (a.error ? -Infinity : (a[key] ?? 0)))
  const chip = (by, label) => {
    const on = _mobVLbSortBy === by
    return `<button onclick="window._mobVLbSort('${by}')" style="padding:5px 11px;border-radius:14px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#000' : 'var(--muted)'};font-size:11px;font-weight:700;cursor:pointer">${label}</button>`
  }
  const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px 8px">
    <span style="font-size:13px;font-weight:700;color:var(--fg);text-transform:uppercase;letter-spacing:0.04em">Rankings</span>
    <div style="display:flex;gap:6px">${chip('value', 'Value')}${chip('net', 'Net PnL')}</div>
  </div>`
  return header + sorted.map((r, i) => {
    const id     = `lb-${r.addr.slice(2, 10)}`
    const xp     = _mobVExpandedIds.has(id)
    const val    = r.error ? '—' : '$' + fmtUSD(r.accountValue)
    const net    = r.error ? '—' : _lbPnl(r.netPnl, r.error)
    const netCls = !r.error && r.netPnl >= 0 ? 'pos' : 'neg'
    const label  = r.label || (r.addr.slice(0, 6) + '…' + r.addr.slice(-4))
    const chev   = `<svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
    const badge  = RANK_BADGE[i]
    let avatar
    if (i === 0) {
      avatar = `<div style="flex-shrink:0;width:40px;display:flex;flex-direction:column;align-items:center;gap:2px"><div style="font-size:18px;line-height:1">👑</div>${_mobVAvatarHtml(r.addr, 40)}</div>`
    } else {
      const rankBadge = badge
        ? `<div style="position:absolute;bottom:-3px;right:-3px;width:18px;height:18px;border-radius:50%;background:${badge.bg};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;color:${badge.color};border:1.5px solid var(--bg)">${badge.label}</div>`
        : `<div style="position:absolute;bottom:-3px;right:-3px;min-width:18px;height:18px;border-radius:9px;background:var(--panel-3);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;color:var(--muted);padding:0 4px;border:1.5px solid var(--bg)">${i+1}</div>`
      avatar = `<div style="position:relative;flex-shrink:0;width:40px;height:40px">${_mobVAvatarHtml(r.addr, 40)}${rankBadge}</div>`
    }
    let expandHtml = ''
    if (!r.error) {
      const uCls = r.unrealizedPnl >= 0 ? 'var(--green)' : 'var(--red)'
      const rCls = r.realizedPnl   >= 0 ? 'var(--green)' : 'var(--red)'
      const nCls = r.netPnl        >= 0 ? 'var(--green)' : 'var(--red)'
      const hCls = r.healthCls === 'pos' ? 'var(--green)' : r.healthCls === 'warn' ? 'var(--orange)' : 'var(--red)'
      const winRate = r.totalWindows > 0 ? (r.winCount / r.totalWindows * 100).toFixed(1) + '%' : '—'
      expandHtml = _mobVDetailGrid([
        ['Unrealized', _lbPnl(r.unrealizedPnl, null), uCls],
        ['Realized',   _lbPnl(r.realizedPnl,   null), rCls],
        ['Net PnL',    _lbPnl(r.netPnl,         null), nCls],
        ['Health',     r.healthPct > 0 ? r.healthPct.toFixed(1) + '%' : '—', hCls],
        ['Win Rate',   winRate],
        ['Volume',     '$' + fmtCompact(r.totalVolume ?? 0)],
      ])
      const openPos = (r.positions ?? []).filter(ap => parseFloat(ap.position?.szi ?? 0) !== 0)
      if (openPos.length) {
        expandHtml += `<div style="border-bottom:1px solid rgba(255,255,255,0.04)">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;padding:8px 16px 4px;background:var(--panel-2)">${openPos.length} Open Position${openPos.length !== 1 ? 's' : ''}</div>
          ${openPos.map((ap, pi) => _mobVSubPosRow(ap, `${id}-p${pi}`)).join('')}
        </div>`
      }
      const outcomes = r.outcomes ?? []
      if (outcomes.length) {
        expandHtml += `<div style="border-bottom:1px solid rgba(255,255,255,0.04)">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;padding:8px 16px 4px;background:var(--panel-2)">${outcomes.length} Outcome${outcomes.length !== 1 ? 's' : ''}</div>
          ${outcomes.map((b, ci) => _mobVSubOcRow(b, `${id}-c${ci}`)).join('')}
        </div>`
      }
      const openOrders = r.openOrders ?? []
      if (openOrders.length) {
        expandHtml += `<div style="border-bottom:1px solid rgba(255,255,255,0.04)">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;padding:8px 16px 4px;background:var(--panel-2)">${openOrders.length} Open Order${openOrders.length !== 1 ? 's' : ''}</div>
          ${openOrders.map((o, oi) => _mobVSubOrdRow(o, `${id}-o${oi}`)).join('')}
        </div>`
      }
    }
    return `<div>
      <div class="mob-v-row" style="cursor:pointer" onclick="window._mobVToggleRow('${id}')">
        ${avatar}
        <div class="mob-v-row-info" style="margin-left:10px">
          <div class="mob-v-row-name">${esc(label)}</div>
          <div class="mob-v-row-sub">${val}</div>
        </div>
        <div class="mob-v-row-right">
          <div class="mob-v-row-val ${netCls}">${net}</div>
          <div class="mob-v-row-pct" style="color:var(--muted)">Net PnL</div>
        </div>
        ${chev}
      </div>
      <div id="mrd-${id}" style="display:${xp ? '' : 'none'}">${expandHtml}</div>
    </div>`
  }).join('')
}

async function _mobVFetchLeaderboard(el) {
  if (_lbFetching) return
  _lbFetching = true
  try {
    const entries = await _lbLoad()
    if (!entries.length) {
      el.innerHTML = `<div class="mob-v-empty">No wallets tracked yet.<br>Add wallets in the Leaderboard tab.</div>`
      return
    }
    const results = await _lbFetchResults(entries)
    _lbLastFetch = Date.now()
    _mobVLbResults = results
    if (_mobVActiveTab !== 'leaderboard') return
    if (!results.length) { el.innerHTML = `<div class="mob-v-empty">No data available</div>`; return }
    el.innerHTML = _mobVBuildLbHtml(results)
  } finally {
    _lbFetching = false
  }
}

async function _mobVFetchPerformance(el) {
  let wins
  try { wins = await serverFetch(`/api/wins?address=${encodeURIComponent(state.addr ?? '')}`) }
  catch {
    el.innerHTML = `<div class="mob-v-empty">Performance data unavailable.<br>Start the strategy server to see bot performance.</div>`
    return
  }
  const stats = _computeBotPerformance(wins)
  if (!stats.botStats.length) {
    el.innerHTML = `<div class="mob-v-empty">No bot activity yet.<br>Run a strategy bot — its trades, PnL, fees and funding appear here.</div>`
    return
  }
  const { botStats, totals, best, allBotCoins } = stats
  const money  = v => (v >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(v))
  const cls    = v => v >= 0 ? 'pos' : 'neg'
  const idSafe = c => c.replace(/[^A-Za-z0-9]/g, '_')
  const { coinNet, marketCoins } = _perfBuildData(allBotCoins)
  el.innerHTML = `<div style="padding:4px 0 24px">
    <div class="mob-v-setting-group">
      <div class="mob-v-setting-row"><span>Net Bot P&amp;L</span><span class="${cls(totals.net)}" style="font-weight:700">${money(totals.net)}</span></div>
      <div class="mob-v-setting-row"><span>Realized PnL</span><span class="${cls(totals.realized)}" style="font-weight:700">${money(totals.realized)}</span></div>
      <div class="mob-v-setting-row"><span>Fees Paid</span><span class="neg" style="font-weight:700">-$${fmtUSD(totals.fees)}</span></div>
      <div class="mob-v-setting-row"><span>Net Funding</span><span class="${cls(totals.fund)}" style="font-weight:700">${money(totals.fund)}</span></div>
      <div class="mob-v-setting-row" style="border:none"><span>Best Bot</span><span style="font-weight:700">${esc(best?.label ?? '—')}</span></div>
    </div>

    <div style="padding:4px 4px 0">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:8px">
        <div style="font-size:13px;font-weight:700">Cumulative P&amp;L</div>
        <div class="perf-tabs" id="mperfTypeTabs">
          <button data-perf-type="accum"    onclick="window.__perfSetType('accum')">Accum.</button>
          <button data-perf-type="realized" onclick="window.__perfSetType('realized')">Realized</button>
        </div>
      </div>
      <div class="perf-tabs" id="mperfPeriodTabs" style="margin-bottom:8px;width:fit-content">
        ${['1D','1W','1M','All'].map(p => `<button data-perf-period="${p}" onclick="window.__perfSetPeriod('${p}')">${p}</button>`).join('')}
      </div>
      <div id="mperfCombHero" class="portfolio-pnl-hero"></div>
      <div style="position:relative;height:180px"><canvas id="mperfCombChart" style="cursor:crosshair"></canvas></div>
    </div>

    <div style="font-size:13px;font-weight:700;padding:18px 4px 8px">Per-Market P&amp;L <span style="font-size:11px;color:var(--muted);font-weight:400">— sorted by net ▾</span></div>
    ${marketCoins.map(c => `
      <div class="perf-market-card" style="margin:0 4px 10px">
        <div class="perf-market-head"><div class="perf-market-name">${esc(c)}</div><div class="perf-market-net ${cls(coinNet[c])}">${money(coinNet[c])}</div></div>
        <div id="mperfHero-${idSafe(c)}" class="portfolio-pnl-hero" style="min-height:24px;padding:2px 0 4px"></div>
        <div style="position:relative;height:120px"><canvas id="mperfChart-${idSafe(c)}" style="cursor:crosshair"></canvas></div>
      </div>`).join('')}

    <div style="font-size:10px;color:var(--muted);padding:8px 4px">Trades are attributed to a bot by the coins it runs on — a coin traded by multiple bots (or manually) may overlap.</div>
    <div class="mob-v-setting-group">
      ${botStats.map(s => `<div class="mob-v-setting-row">
        <div>
          <div style="font-size:14px;font-weight:600">${esc(s.label)}</div>
          <div style="font-size:11px;color:var(--muted)">${s.trades} trades · ${s.winRate == null ? '—' : s.winRate.toFixed(0) + '% win'} · fees -$${fmtUSD(s.fees)}</div>
        </div>
        <span class="${cls(s.net)}" style="font-weight:700">${money(s.net)}</span>
      </div>`).join('')}
    </div>
  </div>`
  _perfRenderCharts('mperf')
}

function _mobVTradeCoinList(q = '') {
  const lq   = q.toLowerCase()
  const favs = loadFavCoins()

  // Mirror desktop exactly: use state.allMids as source so category map keys match
  const mids = state.allMids ?? {}

  if (_mobVPickerType === 'spot') {
    const spotEntries = Object.entries(mids)
      .filter(([k]) => k.startsWith('@') || !!_spotNameMap[k])
      .sort((a, b) => parseFloat(b[1]) - parseFloat(a[1]))
    if (!spotEntries.length) return `<div style="padding:40px;text-align:center;color:var(--muted)">Loading spot markets…</div>`
    return spotEntries.map(([k, px]) => {
      const display = _spotNameMap[k] ?? k
      const price   = parseFloat(px)
      return `<div style="display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border)" onclick="window._mobVSelectTradeCoin('${esc(k)}')">
        <div style="width:36px;height:36px;border-radius:50%;overflow:hidden;background:var(--panel-2);flex-shrink:0">${_coinIconHtml(display)}</div>
        <div style="flex:1;min-width:0">
          <div style="font-size:14px;font-weight:700">${esc(display)}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:2px">Spot</div>
        </div>
        <div style="text-align:right;flex-shrink:0">
          <div style="font-size:14px;font-weight:600;font-family:'JetBrains Mono',monospace">$${fmtPrice(price)}</div>
        </div>
      </div>`
    }).join('')
  }

  const rowHtml = (c) => {
    const d        = _mktCtxMap[c]
    const mark     = d?.markPx || parseFloat(mids[c] ?? 0)
    const ch       = d?.change24 ?? 0
    const chCls    = ch >= 0 ? 'pos' : 'neg'
    const chSign   = ch >= 0 ? '+' : ''
    const fund     = d?.funding ?? 0
    const fundCls  = fund >= 0 ? 'pos' : 'neg'
    const fundSign = fund >= 0 ? '+' : ''
    const vol      = d?.volume ?? 0
    const lev      = state.assetMap?.[c]?.maxLeverage
    const display  = _mktDisplay(c) ?? hip3Rename(c).replace(/.*:/, '')
    return `<div style="display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid var(--border)" onclick="window._mobVSelectTradeCoin('${esc(c)}')">
      <div style="width:36px;height:36px;border-radius:50%;overflow:hidden;background:var(--panel-2);flex-shrink:0">${_coinIconHtml(c)}</div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:5px">
          <span style="font-size:14px;font-weight:700">${esc(display)}</span>
          ${lev ? `<span style="font-size:9px;font-weight:700;padding:1px 4px;border-radius:3px;background:var(--panel-3);color:var(--muted)">${lev}x</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">
          Vol $${_fmtK(vol)} · <span class="${fundCls}">F ${fundSign}${Math.abs(fund).toFixed(4)}%</span>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div style="font-size:14px;font-weight:600;font-family:'JetBrains Mono',monospace">$${fmtPrice(mark)}</div>
        <div style="font-size:11px;font-weight:600;font-family:'JetBrains Mono',monospace" class="${chCls}">${chSign}${ch.toFixed(2)}%</div>
      </div>
    </div>`
  }

  const sectionHdr = label =>
    `<div style="padding:7px 16px;font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;background:var(--panel-2);border-bottom:1px solid var(--border)">${label}</div>`

  // Apply type filter — same logic as desktop renderCoinDropdownItems
  let entries = Object.entries(mids)
  if (lq) entries = entries.filter(([k]) => k.toLowerCase().includes(lq) || k.replace(/.*:/, '').toLowerCase().includes(lq) || (_mktDisplay(k) ?? '').toLowerCase().includes(lq))
  if (_mobVPickerType === 'crypto')    entries = entries.filter(([k]) => !_isTradFiCat(_mktCatMap[k]))
  if (_mobVPickerType === 'tradfi')    entries = entries.filter(([k]) =>  _isTradFiCat(_mktCatMap[k]))
  if (_mobVPickerType === 'hip3')      entries = entries.filter(([k]) => k.includes(':'))
  if (_mobVPickerType === 'prelaunch') entries = entries.filter(([k]) => _mktCatMap[k]?.toLowerCase() === 'preipo')

  // Sort
  if (_mobVPickerType === 'trending') {
    entries = entries.sort((a, b) => (_mktCtxMap[b[0]]?.volume ?? 0) - (_mktCtxMap[a[0]]?.volume ?? 0))
  } else {
    entries = entries.sort((a, b) => (_mktCtxMap[b[0]]?.oi ?? 0) - (_mktCtxMap[a[0]]?.oi ?? 0))
  }

  if (!entries.length) return `<div style="padding:40px;text-align:center;color:var(--muted)">No markets found</div>`

  if (lq) return entries.map(([c]) => rowHtml(c)).join('')

  const favEntries  = entries.filter(([k]) => favs.includes(k))
  const restEntries = entries.filter(([k]) => !favs.includes(k))

  // Group by category with section headers
  const grouped = {}
  for (const [c] of restEntries) {
    const cat = _mktCatMap[c] || 'crypto'
    ;(grouped[cat] = grouped[cat] ?? []).push(c)
  }
  const catOrder = ['crypto', ...Object.keys(grouped).filter(k => k !== 'crypto').sort()]

  let html = favEntries.length ? sectionHdr('⭐ Favorites') + favEntries.map(([c]) => rowHtml(c)).join('') : ''
  for (const cat of catOrder) {
    if (!grouped[cat]?.length) continue
    if (Object.keys(grouped).length > 1 || favEntries.length) html += sectionHdr(_CAT_LABEL[cat] ?? cat)
    html += grouped[cat].map(c => rowHtml(c)).join('')
  }
  return html || `<div style="padding:40px;text-align:center;color:var(--muted)">No markets available</div>`
}

function _mobVRenderPickerPills() {
  const el = document.getElementById('mobCoinPickerPills')
  if (!el) return
  const pill = (label, type) => {
    const active = _mobVPickerType === type
    return `<button onclick="window._mobVSetPickerType('${type}')" style="flex-shrink:0;padding:5px 14px;border-radius:20px;border:1px solid ${active ? 'var(--accent)' : 'var(--border)'};background:${active ? 'color-mix(in oklch,var(--accent) 15%,transparent)' : 'var(--panel-2)'};color:${active ? 'var(--accent)' : 'var(--muted)'};font-size:12px;font-weight:600;cursor:pointer">${label}</button>`
  }
  el.innerHTML = [
    ['All',        'all'],
    ['Perps',      'perps'],
    ['Spot',       'spot'],
    ['Crypto',     'crypto'],
    ['Trad-Fi',    'tradfi'],
    ['HIP-3',      'hip3'],
    ['Trending',   'trending'],
    ['Pre-launch', 'prelaunch'],
  ].map(([l, t]) => pill(l, t)).join('')
}

window._mobVSetPickerType = function(type) {
  _mobVPickerType = type
  _mobVRenderPickerPills()
  const list = document.getElementById('mobCoinPickerList')
  const q    = document.getElementById('mobCoinPickerSearch')?.value ?? ''
  if (list) list.innerHTML = _mobVTradeCoinList(q)
}

window._mobVSelectTradeCoin = function(coin) {
  window.__selectCoin(coin)
  window._mobVCloseCoinPicker()
  _mobVActiveTab     = 'trade'
  _mobTradeView      = 'detail'
  _mobTradeDetailTab = 'chart'
  _mobVRenderContent()
}

window._mobVCloseCoinPicker = function() {
  const ov = document.getElementById('mobCoinPickerOverlay')
  if (ov) ov.style.display = 'none'
}

window._mobVTradeToggleCoinPicker = function() {
  let ov = document.getElementById('mobCoinPickerOverlay')
  if (!ov) {
    ov = document.createElement('div')
    ov.id = 'mobCoinPickerOverlay'
    ov.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:var(--bg);z-index:10000;display:flex;flex-direction:column'
    ov.innerHTML = `
      <div style="flex-shrink:0;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px">
          <button onclick="window._mobVCloseCoinPicker()" style="background:none;border:none;color:var(--fg);font-size:24px;padding:0;line-height:1;cursor:pointer;flex-shrink:0">←</button>
          <input id="mobCoinPickerSearch" placeholder="Search markets…" oninput="window._mobVTradeSearch(this.value)"
            style="flex:1;background:var(--panel-2);border:none;border-radius:10px;padding:9px 13px;color:var(--fg);font-size:16px;outline:none;-webkit-text-size-adjust:none">
        </div>
        <div id="mobCoinPickerPills" style="display:flex;gap:6px;padding:0 14px 10px;overflow-x:auto;-webkit-overflow-scrolling:touch;touch-action:pan-x;scrollbar-width:none"></div>
      </div>
      <div id="mobCoinPickerList" style="flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch"></div>`
    document.body.appendChild(ov)
    // Manually drive horizontal scroll — CSS overflow-x scroll is unreliable on iOS fixed overlays
    const pillsEl = ov.querySelector('#mobCoinPickerPills')
    if (pillsEl) {
      let tx = 0, sl = 0
      pillsEl.addEventListener('touchstart', e => { tx = e.touches[0].clientX; sl = pillsEl.scrollLeft }, { passive: true })
      pillsEl.addEventListener('touchmove',  e => { pillsEl.scrollLeft = sl + (tx - e.touches[0].clientX); e.stopPropagation() }, { passive: true })
    }
  } else {
    ov.style.display = 'flex'
  }
  const search = document.getElementById('mobCoinPickerSearch')
  if (search) { search.value = ''; search.focus() }
  _mobVRenderPickerPills()
  const list = document.getElementById('mobCoinPickerList')
  if (_mktCtxReady) {
    if (list) list.innerHTML = _mobVTradeCoinList('')
  } else {
    if (list) list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted)">Loading…</div>'
    _ensureMarketData().then(() => {
      const l = document.getElementById('mobCoinPickerList')
      const q = document.getElementById('mobCoinPickerSearch')?.value ?? ''
      if (l) l.innerHTML = _mobVTradeCoinList(q)
    })
  }
}

window._mobVTradeSearch = function(q) {
  const list = document.getElementById('mobCoinPickerList')
  if (list) list.innerHTML = _mobVTradeCoinList(q)
}

window._mobVSetSide = function(side) {
  state.tradeSide = side
  _updateAvailEl()
  // Update the order sheet / trade form in place if it's open
  const longBtn   = document.getElementById('mobTradeLongBtn')
  const shortBtn  = document.getElementById('mobTradeShortBtn')
  if (longBtn && shortBtn) {
    const isBuy     = side !== 'short'
    const submitBtn = document.getElementById('mobTradeSubmitBtn')
    const slider    = document.getElementById('mobTradeAmtSlider')
    longBtn.style.border      = `1px solid ${isBuy ? 'var(--green)' : 'var(--border2)'}`
    longBtn.style.background   = isBuy ? 'color-mix(in oklch,var(--green) 18%,transparent)' : 'var(--panel-2)'
    longBtn.style.color        = isBuy ? 'var(--green)' : 'var(--muted)'
    shortBtn.style.border     = `1px solid ${!isBuy ? 'var(--red)' : 'var(--border2)'}`
    shortBtn.style.background  = !isBuy ? 'color-mix(in oklch,var(--red) 18%,transparent)' : 'var(--panel-2)'
    shortBtn.style.color       = !isBuy ? 'var(--red)' : 'var(--muted)'
    if (submitBtn && isConnected()) {
      const coin = state.selectedCoin || 'BTC'
      const display = _spotNameMap[coin] ?? _mktDisplay(coin) ?? coin.replace(/.*:/, '')
      submitBtn.style.background = isBuy ? 'var(--green)' : 'var(--red)'
      submitBtn.style.color = isBuy ? '#000' : '#fff'
      submitBtn.textContent = isBuy ? `Long ${display}` : `Short ${display}`
    }
    if (slider) slider.style.accentColor = isBuy ? 'var(--green)' : 'var(--red)'
    _mobUpdateOrderSummary()
    return
  }
  _mobVRenderContent()
}

window._mobVSetOrderType = function(type) {
  state.orderType = type
  const mktBtn = document.getElementById('mobTradeOrderTypeMkt')
  const lmtBtn = document.getElementById('mobTradeOrderTypeLmt')
  if (mktBtn && lmtBtn) {
    const isLmt   = type === 'limit'
    const wrapper = document.getElementById('mobTradeLimitWrapper')
    mktBtn.style.background = !isLmt ? 'var(--panel-3)' : 'transparent'
    mktBtn.style.color      = !isLmt ? 'var(--fg)' : 'var(--muted)'
    lmtBtn.style.background = isLmt ? 'var(--panel-3)' : 'transparent'
    lmtBtn.style.color      = isLmt ? 'var(--fg)' : 'var(--muted)'
    if (wrapper) wrapper.style.display = isLmt ? 'flex' : 'none'
    _mobUpdateOrderSummary()
    return
  }
  _mobVRenderContent()
}

window._mobVSetLev = function(val) {
  state.leverage = parseInt(val)
  const label = document.getElementById('mobTradeLevLabel')
  if (label) label.textContent = val + 'x'
}

window._mobVSetMarginPct = function(pct) {
  _mobVTradeMarginPct = parseInt(pct)
  _mobVRenderContent()
}

window._mobVToggleIsolated = function() {
  state.isIsolated = !state.isIsolated
  try { localStorage.setItem('hliq_isolated', state.isIsolated ? '1' : '0') } catch {}
  _startAvailTimer()
  // Update the toggle button in place (order sheet or trade form) without re-rendering
  const btn = document.getElementById('mobTradeIsolatedBtn')
  if (btn) {
    btn.textContent = state.isIsolated ? 'Isolated' : 'Cross'
    try { _mobUpdateOrderSummary() } catch {}   // refresh est. liq price for the new mode
    return
  }
  _mobVRenderContent()
}

window._mobVEditTpSl = function(type) {
  const cur = type === 'tp' ? _mobVTradeTp : _mobVTradeSl
  const val = prompt(type === 'tp' ? 'Take Profit price (leave blank to clear):' : 'Stop Loss price (leave blank to clear):', cur)
  if (val === null) return
  if (type === 'tp') _mobVTradeTp = val.trim()
  else               _mobVTradeSl = val.trim()
  _mobVRenderContent()
}

window._mobVSubmitOrder = async function() {
  const statusEl = document.getElementById('mobTradeStatus')
  const btnEl    = document.getElementById('mobTradeSubmitBtn')
  if (!isConnected()) { if (statusEl) statusEl.innerHTML = '<span style="color:var(--neg)">Connect agent key to trade</span>'; return }
  const coin    = state.selectedCoin
  const isBuy   = state.tradeSide !== 'short'
  const mktPx   = parseFloat(state.allMids?.[coin] ?? 0)
  const avail   = _tradeAvail().avail
  const margin  = avail * _mobVTradeMarginPct / 100
  const notional = margin * (state.leverage ?? 5)
  const coinSz  = mktPx > 0 ? notional / mktPx : 0
  const limitPx = parseFloat(document.getElementById('mobTradeLimitInput')?.value ?? 0)
  const tpPx    = parseFloat(_mobVTradeTp) || 0
  const slPx    = parseFloat(_mobVTradeSl) || 0
  if (notional <= 0) { if (statusEl) statusEl.innerHTML = '<span style="color:var(--neg)">Move the margin slider above 0%</span>'; return }
  if (mktPx <= 0)    { if (statusEl) statusEl.innerHTML = `<span style="color:var(--neg)">No price for ${coin}</span>`; return }
  if (state.orderType === 'limit' && (!limitPx || limitPx <= 0)) { if (statusEl) statusEl.innerHTML = '<span style="color:var(--neg)">Enter limit price</span>'; return }
  if (btnEl) btnEl.disabled = true
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted)">Signing…</span>'
  try {
    let result
    if (state.orderType === 'market') {
      result = await placeMarketOrder({ coin, isBuy, sz: coinSz, markPrice: mktPx, leverage: state.leverage, isIsolated: state.isIsolated })
    } else {
      result = await placeLimitOrder({ coin, isBuy, sz: coinSz, limitPx, leverage: state.leverage, isIsolated: state.isIsolated })
    }
    const parsed = parseOrderResult(result)
    if (!parsed.ok) { if (statusEl) statusEl.innerHTML = `<span style="color:var(--neg)">✗ ${esc(parsed.errors.join(', '))}</span>`; if (btnEl) btnEl.disabled = false; return }
    let msg = '✓ Order placed!'
    if (parsed.filled.length > 0) {
      const f = parsed.filled[0]
      msg = `✓ ${fmtSize(f.totalSz ?? coinSz)} ${coin} @ $${fmtPrice(f.avgPx ?? mktPx)}`
    }
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--green)">${esc(msg)}</span>`
    if (tpPx > 0) { try { await placeTriggerOrder({ coin, isBuy: !isBuy, sz: coinSz, triggerPx: tpPx, tpsl: 'tp' }) } catch {} }
    if (slPx > 0) { try { await placeTriggerOrder({ coin, isBuy: !isBuy, sz: coinSz, triggerPx: slPx, tpsl: 'sl' }) } catch {} }
    _mobVTradeMarginPct = 50
    setTimeout(refreshLive, 1500)
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--neg)">✗ ${esc(e.message)}</span>`
  }
  if (btnEl) btnEl.disabled = false
}

// ─── MOBILE MARKETS + TRADE REDESIGN ─────────────────────────────────────────

window._mobSelectMarket = function(coin) {
  if (_mobTradeObTimer) { clearInterval(_mobTradeObTimer); _mobTradeObTimer = null }
  window.__selectCoin(coin)
  _mobTradeView      = 'detail'
  _mobTradeDetailTab = 'chart'
  _mobVRenderContent()
}

window._mobTradeGoBack = function() {
  if (_mobTradeObTimer) { clearInterval(_mobTradeObTimer); _mobTradeObTimer = null }
  if (window._mobCandleWs) { try { window._mobCandleWs.close() } catch {} window._mobCandleWs = null }
  destroyMobTradeChart()
  _stopAvailTimer()
  _mobTradeView = 'list'
  _mobVRenderContent()
}

window._mobTradeSetFilter = function(type) {
  _mobTradeMainFilter = type
  const rows = document.getElementById('mobMktRows')
  if (rows) rows.innerHTML = _mobBuildMarketRows()
  // Update OI sort button label based on filter context
  document.querySelectorAll('.mob-mkt-sortbtn').forEach(b => {
    if (b.dataset.sort !== 'oi') return
    const active = _mobTradeSort === 'oi' || (_mobTradeSort !== 'volume' && _mobTradeSort !== 'change' && _mobTradeSort !== 'price' && _mobTradeSort !== 'name')
    const lbl = type === 'spot' ? 'Mkt Cap' : 'OI'
    b.textContent = lbl + (active ? ' ▾' : '')
  })
  // Re-render pills
  document.querySelectorAll('.mob-mkt-fpill').forEach(b => {
    const active = b.dataset.type === type
    b.style.borderColor = active ? 'var(--accent)' : 'var(--border)'
    b.style.background  = active ? 'color-mix(in oklch,var(--accent) 15%,transparent)' : 'transparent'
    b.style.color       = active ? 'var(--accent)' : 'var(--muted)'
  })
}

window._mobTradeSetSort = function(type) {
  _mobTradeSort = type
  const rows = document.getElementById('mobMktRows')
  if (rows) rows.innerHTML = _mobBuildMarketRows()
  document.querySelectorAll('.mob-mkt-sortbtn').forEach(b => {
    const active = b.dataset.sort === type
    b.style.fontWeight = active ? '700' : '500'
    b.style.color      = active ? 'var(--fg)' : 'var(--muted)'
    const baseLabel = b.dataset.sort === 'oi' && _mobTradeMainFilter === 'spot' ? 'Mkt Cap' : ({ volume:'Vol', change:'Chg%', price:'Price', oi:'OI' }[b.dataset.sort] ?? b.dataset.sort)
    b.textContent = baseLabel + (active ? ' ▾' : '')
  })
}

window._mobTradeSearch = function(q) {
  _mobTradeSearchQ = q
  const rows = document.getElementById('mobMktRows')
  if (rows) rows.innerHTML = _mobBuildMarketRows()
  const clr = document.getElementById('mobMktSearchClr')
  if (clr) clr.style.display = q ? '' : 'none'
}

window._mobTradeFavToggle = function(coin) {
  const favs = loadFavCoins()
  const idx  = favs.indexOf(coin)
  if (idx >= 0) favs.splice(idx, 1)
  else favs.unshift(coin)
  saveFavCoins(favs)
  const btn = document.getElementById('mobFavBtn-' + coin.replace(/[^a-z0-9]/gi, '_'))
  if (btn) btn.style.color = favs.includes(coin) ? 'var(--accent)' : 'rgba(255,255,255,0.25)'
  const detailBtn = document.getElementById('mobDetailFavBtn')
  if (detailBtn) detailBtn.style.color = favs.includes(coin) ? 'var(--accent)' : 'var(--muted)'
}

window._mobTradeSetDetailTab = function(tab) {
  if (_mobTradeObTimer && tab !== 'orderbook') {
    clearInterval(_mobTradeObTimer); _mobTradeObTimer = null
  }
  if (tab !== 'trade') _stopAvailTimer()
  _mobTradeDetailTab = tab
  const contentEl = document.getElementById('mobTradeDetailContent')
  if (!contentEl) return
  document.querySelectorAll('.mob-trade-dtab').forEach(b => {
    const active = b.dataset.tab === tab
    b.style.fontWeight   = active ? '700' : '500'
    b.style.color        = active ? 'var(--fg)' : 'var(--muted)'
    b.style.borderBottom = active ? '2px solid var(--accent)' : '2px solid transparent'
  })
  _mobRenderDetailContent(contentEl, state.selectedCoin || 'BTC')
  const bar = document.getElementById('mobTradeSideBar')
  if (bar) bar.style.display = tab === 'trade' ? 'none' : ''
}

window._mobTradeGoLong  = function() { window._mobOpenOrderSheet('long') }
window._mobTradeGoShort = function() { window._mobOpenOrderSheet('short') }

function _mobBuildMarketRows() {
  const mids = state.allMids ?? {}
  const lq   = _mobTradeSearchQ.trim().toLowerCase()
  const favs = loadFavCoins()

  // Exclude 'TOKEN/USDC' pair-name keys — they duplicate their '@N' counterparts in allMids.
  // The @N key always has ctx data (we populate both in _ensureMarketData).
  let entries = Object.entries(mids).filter(([k]) => !k.includes('/') && !k.startsWith('#'))
  if (lq) entries = entries.filter(([k]) => {
    const d = (_spotNameMap[k] ?? k.replace(/.*:/, '')).toLowerCase()
    return k.toLowerCase().includes(lq) || d.includes(lq)
  })

  const f = _mobTradeMainFilter
  if      (f === 'favorites')   entries = entries.filter(([k]) => favs.includes(k))
  else if (f === 'perps')       entries = entries.filter(([k]) => !k.includes(':') && !k.startsWith('@'))
  else if (f === 'spot')        entries = entries.filter(([k]) => _spotCommunityKeys.has(k))
  else if (f === 'hip3')        entries = entries.filter(([k]) => k.includes(':'))
  else if (f === 'crypto')      entries = entries.filter(([k]) => !_isTradFiCat(_mktCatMap[k]) && !k.includes(':') && !k.startsWith('@'))
  else if (f === 'tradfi')      entries = entries.filter(([k]) => _isTradFiCat(_mktCatMap[k]))
  else if (f === 'stocks')      entries = entries.filter(([k]) => (_mktCatMap[k] ?? '').toLowerCase() === 'stocks')
  else if (f === 'indices')     entries = entries.filter(([k]) => (_mktCatMap[k] ?? '').toLowerCase() === 'indices')
  else if (f === 'commodities') entries = entries.filter(([k]) => (_mktCatMap[k] ?? '').toLowerCase() === 'commodities')
  else if (f === 'fx')          entries = entries.filter(([k]) => (_mktCatMap[k] ?? '').toLowerCase() === 'fx')
  else if (f === 'metals')      entries = entries.filter(([k]) => _METALS_BASES.has(k.replace(/.*:/,'').toUpperCase()))
  else if (f === 'energy')      entries = entries.filter(([k]) => _ENERGY_BASES.has(k.replace(/.*:/,'').toUpperCase()))
  else if (f === 'preipo')      entries = entries.filter(([k]) => (_mktCatMap[k] ?? '').toLowerCase() === 'preipo')
  else if (f === 'trending')    entries = [...entries].sort((a,b) => (_mktCtxMap[b[0]]?.volume ?? 0) - (_mktCtxMap[a[0]]?.volume ?? 0)).slice(0, 30)
  // 'all' — no filter

  if (_mobTradeSort === 'volume')      entries.sort((a,b) => (_mktCtxMap[b[0]]?.volume ?? 0) - (_mktCtxMap[a[0]]?.volume ?? 0))
  else if (_mobTradeSort === 'change') entries.sort((a,b) => (_mktCtxMap[b[0]]?.change24 ?? 0) - (_mktCtxMap[a[0]]?.change24 ?? 0))
  else if (_mobTradeSort === 'price')  entries.sort((a,b) => parseFloat(b[1] ?? 0) - parseFloat(a[1] ?? 0))
  else if (_mobTradeSort === 'name')   entries.sort((a,b) => a[0].replace(/.*:/,'').localeCompare(b[0].replace(/.*:/,'')))
  else if (f === 'spot')               entries.sort((a,b) => (_mktCtxMap[b[0]]?.marketCap ?? 0) - (_mktCtxMap[a[0]]?.marketCap ?? 0))
  else                                 entries.sort((a,b) => (_mktCtxMap[b[0]]?.oi ?? 0) - (_mktCtxMap[a[0]]?.oi ?? 0))

  if (!entries.length) return `<div style="padding:40px;text-align:center;color:var(--muted)">No markets found</div>`

  return entries.map(([coin]) => {
    const d        = _mktCtxMap[coin]
    const mark     = d?.markPx || parseFloat(mids[coin] ?? 0)
    const ch       = d?.change24 ?? 0
    const vol      = d?.volume ?? 0
    const oi       = d?.oi ?? 0
    const display  = _spotNameMap[coin] ?? _mktDisplay(coin) ?? coin.replace(/.*:/, '')
    const isSpot   = coin.startsWith('@') || !!_spotNameMap[coin]
    const rawCat   = _mktCatMap[coin]
    const catLabel = rawCat ? (_CAT_LABEL[rawCat] ?? rawCat) : (isSpot ? 'Spot' : coin.includes(':') ? 'HIP-3' : 'Perp')
    const oiVal    = isSpot ? (d?.marketCap ?? 0) : oi
    const oiLbl   = isSpot ? 'Mkt Cap' : 'OI'
    const coinFav  = favs.includes(coin)
    const chBg     = ch >= 0 ? 'rgba(0,229,160,0.15)' : 'rgba(255,77,109,0.15)'
    const chColor  = ch >= 0 ? 'var(--green)' : 'var(--red)'
    const chSign   = ch >= 0 ? '+' : ''
    const safeId   = coin.replace(/[^a-z0-9]/gi, '_')
    return `<div style="display:flex;align-items:center;gap:8px;padding:11px 12px;border-bottom:1px solid var(--border);cursor:pointer" onclick="window._mobSelectMarket('${esc(coin)}')">
      <button id="mobFavBtn-${safeId}" onclick="event.stopPropagation();window._mobTradeFavToggle('${esc(coin)}')" style="background:none;border:none;padding:2px 4px;color:${coinFav?'var(--accent)':'rgba(255,255,255,0.25)'};font-size:18px;line-height:1;cursor:pointer;flex-shrink:0;min-width:28px;min-height:28px;display:flex;align-items:center;justify-content:center">★</button>
      <div style="width:36px;height:36px;border-radius:50%;overflow:hidden;background:var(--panel-2);flex-shrink:0">${_coinIconHtml(coin)}</div>
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(display)}<span style="color:var(--muted);font-weight:400">/USDC</span></div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;display:flex;align-items:center;gap:5px">
          <span style="background:var(--panel-2);padding:1px 5px;border-radius:3px;font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:var(--muted)">${esc(catLabel)}</span>
          <span>Vol $${_fmtK(vol)} · ${oiLbl} $${_fmtK(oiVal)}</span>
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0;min-width:72px">
        <div style="font-size:13px;font-weight:600;font-family:'JetBrains Mono',monospace">${mark > 0 ? fmtPrice(mark) : '—'}</div>
      </div>
      <div style="min-width:62px;text-align:right;flex-shrink:0">
        <span style="font-size:11px;font-weight:700;padding:3px 7px;border-radius:6px;background:${chBg};color:${chColor}">${chSign}${ch.toFixed(2)}%</span>
      </div>
    </div>`
  }).join('')
}

function _mobRenderTradeList(el) {
  el.style.overflow      = 'hidden'
  el.style.padding       = '0'
  el.style.display       = 'flex'
  el.style.flexDirection = 'column'
  el.style.minHeight     = '0'

  const fp = (label, type) => {
    const active = _mobTradeMainFilter === type
    // display:inline-block + white-space:nowrap in parent = simplest reliable iOS horizontal scroll
    return `<button class="mob-mkt-fpill" data-type="${type}" onclick="window._mobTradeSetFilter('${type}')"
      style="display:inline-block;padding:6px 14px;border-radius:20px;border:1px solid ${active?'var(--accent)':'var(--border)'};background:${active?'color-mix(in oklch,var(--accent) 15%,transparent)':'transparent'};color:${active?'var(--accent)':'var(--muted)'};font-size:12px;font-weight:600;cursor:pointer;white-space:nowrap;vertical-align:middle">${label}</button>`
  }
  const sb = (label, type) => {
    const active = _mobTradeSort === type
    return `<button class="mob-mkt-sortbtn" data-sort="${type}" onclick="window._mobTradeSetSort('${type}')"
      style="padding:10px 6px;border:none;background:none;font-size:12px;font-weight:${active?'700':'500'};color:${active?'var(--fg)':'var(--muted)'};cursor:pointer;white-space:nowrap;min-height:40px">${label}${active?' ▾':''}</button>`
  }

  el.innerHTML = `
    <div id="mobMktTopBar" style="flex-shrink:0">
      <div style="padding:8px 12px;border-bottom:1px solid var(--border)">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="flex:1;display:flex;align-items:center;background:var(--panel-2);border-radius:10px;padding:8px 12px;gap:8px">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" style="color:var(--muted);flex-shrink:0"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input id="mobMktSearch" placeholder="Search markets" value="${esc(_mobTradeSearchQ)}" oninput="window._mobTradeSearch(this.value)"
              autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="search"
              onkeydown="if(event.key==='Enter')this.blur()"
              onfocus="document.getElementById('mobMktSearchCancel').style.display=''"
              onblur="setTimeout(()=>{const c=document.getElementById('mobMktSearchCancel');if(c&&!window._mobTradeSearchQHold)c.style.display='none'},150)"
              style="flex:1;background:none;border:none;color:var(--fg);font-size:16px;outline:none;-webkit-text-size-adjust:none">
            <button id="mobMktSearchClr" onclick="window._mobTradeSearch('');const i=document.getElementById('mobMktSearch');i.value='';i.focus()"
              style="display:${_mobTradeSearchQ?'':'none'};background:none;border:none;color:var(--muted);font-size:20px;padding:0 2px;cursor:pointer;line-height:1;min-width:28px;min-height:28px">×</button>
          </div>
          <button id="mobMktSearchCancel"
            onpointerdown="event.preventDefault();window._mobTradeSearch('');const i=document.getElementById('mobMktSearch');i.value='';i.blur();this.style.display='none'"
            style="display:${_mobTradeSearchQ?'':'none'};background:none;border:none;color:var(--accent);font-size:14px;font-weight:600;padding:8px 2px;cursor:pointer;flex-shrink:0">Cancel</button>
        </div>
      </div>
      <div style="overflow-x:scroll;-webkit-overflow-scrolling:touch;touch-action:pan-x;scrollbar-width:none;-ms-overflow-style:none;border-bottom:1px solid var(--border);padding:8px 12px;white-space:nowrap">
        ${fp('All','all')} ${fp('★ Favs','favorites')} ${fp('Perps','perps')} ${fp('Spot','spot')} ${fp('Crypto','crypto')} ${fp('TradFi','tradfi')} ${fp('Stocks','stocks')} ${fp('Indices','indices')} ${fp('Commod.','commodities')} ${fp('FX','fx')} ${fp('Metals','metals')} ${fp('Energy','energy')} ${fp('Pre-IPO','preipo')} ${fp('HIP-3','hip3')} ${fp('Trending','trending')}
      </div>
      <div style="display:flex;align-items:center;padding:0 12px 0 52px;border-bottom:2px solid var(--border);background:var(--panel-2);min-height:42px;gap:4px">
        <div style="flex:1;font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Symbol</div>
        <div style="display:flex;align-items:center">${sb('Vol','volume')}${sb('Chg%','change')}${sb('Price','price')}${sb('OI','oi')}</div>
      </div>
    </div>
    <div id="mobMktList" style="flex:1;min-height:0;overflow-y:scroll;-webkit-overflow-scrolling:touch;touch-action:pan-y">
      <div id="mobMktRows" style="padding-bottom:80px">
        ${_mktCtxReady ? _mobBuildMarketRows() : '<div style="padding:40px;text-align:center;color:var(--muted)">Loading…</div>'}
      </div>
    </div>`

  // Double-RAF: first frame lets browser apply flex/display:none changes,
  // second frame measures after layout has fully resolved.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const topBar = document.getElementById('mobMktTopBar')
    const list   = document.getElementById('mobMktList')
    if (!topBar || !list) return
    // Prefer measured height; fall back to window.innerHeight if flex hasn't resolved (returns 0)
    let elH = el.getBoundingClientRect().height
    if (elH < 100) elH = window.innerHeight
    const topH = topBar.getBoundingClientRect().height
    const h    = Math.max(200, Math.round(elH - topH))
    list.style.flex   = 'none'
    list.style.height = h + 'px'
  }))

  if (!_mktCtxReady) {
    _ensureMarketData().then(() => {
      const rows = document.getElementById('mobMktRows')
      if (rows && _mobTradeView === 'list') rows.innerHTML = _mobBuildMarketRows()
    })
  }
}

function _hlTradeUrl(coin) {
  // HIP-3 coins (e.g. WTIOIL → xyz:CL) — trade.xyz blocks iframes, fall back to app.hl
  const HIP3_REVERSE = { 'WTIOIL': 'xyz:CL' }
  const original = HIP3_REVERSE[coin] ?? coin
  if (original.includes(':')) {
    // Use main HL app anyway — it at least won't block the iframe
    const base = original.split(':')[1]
    return `https://app.hyperliquid.xyz/trade/${base}`
  }
  return `https://app.hyperliquid.xyz/trade/${coin}`
}

function _mobRenderTradeDetail(el) {
  el.style.overflow      = 'hidden'
  el.style.padding       = '0'
  el.style.display       = 'flex'
  el.style.flexDirection = 'column'
  el.style.minHeight     = '0'

  // Clean up any running chart/ws from a previous render
  if (window._mobCandleWs) { try { window._mobCandleWs.close() } catch {} window._mobCandleWs = null }
  destroyMobTradeChart()

  const coin    = state.selectedCoin || 'BTC'
  const display = _spotNameMap[coin] ?? _mktDisplay(coin) ?? coin.replace(/.*:/, '')
  const coinFav = loadFavCoins().includes(coin)
  const isSpot  = coin.startsWith('@') || !!_spotNameMap[coin]
  const isHip3  = coin.includes(':')
  const badge   = isSpot ? 'SPOT' : isHip3 ? 'HIP-3' : 'PERP'
  const quote   = isSpot ? 'SPOT' : 'PERP'
  const ctx     = _mktCtxMap[coin]
  const mids    = state.allMids ?? {}
  const mark    = ctx?.markPx || parseFloat(mids[coin] ?? 0)
  const chg24   = ctx?.change24 ?? 0
  const chgAbs  = ctx?.change24Abs ?? 0
  const chgClr  = chg24 >= 0 ? 'var(--green)' : 'var(--red)'
  const chgBg   = chg24 >= 0 ? 'color-mix(in oklch,var(--green) 16%,transparent)' : 'color-mix(in oklch,var(--red) 16%,transparent)'
  const chgArr  = chg24 >= 0 ? '▲' : '▼'
  const fund    = ctx?.funding ?? 0
  const fundClr = fund >= 0 ? 'var(--green)' : 'var(--red)'
  const nft     = ctx?.nextFundingTime
  const oi      = ctx?.oi ?? 0

  // Hero price split: big integer part + smaller cents
  const pxStr   = mark > 0 ? fmtPrice(mark) : '—'
  const dotIdx  = pxStr.indexOf('.')
  const pxInt   = dotIdx >= 0 ? pxStr.slice(0, dotIdx) : pxStr
  const pxDec   = dotIdx >= 0 ? pxStr.slice(dotIdx) : ''

  // Current open position on this coin (if any)
  const ps      = (isConnected() && _tradePerpState) ? _tradePerpState : state.perpState
  const posEntry= (ps?.assetPositions ?? []).find(ap => ap.position?.coin === coin)
  const pos     = posEntry?.position
  const hasPos  = pos && parseFloat(pos.szi ?? 0) !== 0

  let posBlocks = ''
  if (hasPos) {
    const szi      = parseFloat(pos.szi)
    const isLong   = szi > 0
    const sideClr  = isLong ? 'var(--green)' : 'var(--red)'
    const sideBg   = isLong ? 'color-mix(in oklch,var(--green) 18%,transparent)' : 'color-mix(in oklch,var(--red) 18%,transparent)'
    const sideLbl  = isLong ? 'LONG' : 'SHORT'
    const posVal   = parseFloat(pos.positionValue ?? 0)
    const uPnl     = parseFloat(pos.unrealizedPnl ?? 0)
    const roe      = parseFloat(pos.returnOnEquity ?? 0) * 100
    const entryPx  = parseFloat(pos.entryPx ?? 0)
    const liqPx    = parseFloat(pos.liquidationPx ?? 0)
    const margin   = parseFloat(pos.marginUsed ?? 0)
    const levVal   = pos.leverage?.value ?? 1
    const levType  = pos.leverage?.type ?? 'cross'
    const fundPaid = -parseFloat(pos.cumFunding?.sinceOpen ?? 0)
    const netPnl   = uPnl + fundPaid
    const pnlClr   = uPnl >= 0 ? 'var(--green)' : 'var(--red)'
    const pnlArr   = uPnl >= 0 ? '▲' : '▼'
    const netClr   = netPnl >= 0 ? 'var(--green)' : 'var(--red)'
    const fundPClr = fundPaid >= 0 ? 'var(--green)' : 'var(--red)'
    const szStr    = Math.abs(szi).toLocaleString('en-US', { maximumFractionDigits: 6 })
    // Position health: 100% at entry, 0% at liquidation (in-profit clamps to 100%)
    let healthPct = 100
    if (liqPx > 0 && entryPx > 0 && mark > 0) {
      if (isLong && entryPx > liqPx)       healthPct = Math.max(0, Math.min(100, (mark - liqPx) / (entryPx - liqPx) * 100))
      else if (!isLong && liqPx > entryPx) healthPct = Math.max(0, Math.min(100, (liqPx - mark) / (liqPx - entryPx) * 100))
      else healthPct = 100
    } else {
      healthPct = Math.max(0, Math.min(100, roe + 100))
    }
    const healthClr = healthPct > 70 ? 'var(--green)' : healthPct > 40 ? '#f59e0b' : healthPct > 20 ? '#ff9444' : 'var(--red)'

    const perfRow = (label, valHtml) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:9px 0;border-top:1px solid var(--border)"><span style="font-size:13px;color:var(--fg-2)">${label}</span><span style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${valHtml}</span></div>`
    const riskCell = (label, valHtml) => `<div><div style="font-size:11px;color:var(--muted);margin-bottom:3px">${label}</div><div style="font-size:14px;font-weight:700;font-family:var(--font-mono)">${valHtml}</div></div>`

    posBlocks = `
      <!-- Your position -->
      <div style="border:1px solid var(--border);border-radius:16px;padding:14px;background:var(--panel)">
        <div style="font-size:12px;color:var(--muted);margin-bottom:6px">Your position</div>
        <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:8px">
          <div>
            <span style="font-size:26px;font-weight:800;font-family:var(--font-mono)">$${_prv(fmtUSD(posVal, 2))}</span>
            <span style="font-size:13px;color:var(--muted);margin-left:6px">${_prv(szStr)} ${esc(display)}</span>
          </div>
          <div style="text-align:right">
            <div style="font-size:15px;font-weight:800;color:${pnlClr};font-family:var(--font-mono)">${uPnl >= 0 ? '+' : '−'}$${_prv(fmtUSD(Math.abs(uPnl), 2))}</div>
            <div style="font-size:12px;font-weight:700;color:${pnlClr}">${roe >= 0 ? '+' : ''}${roe.toFixed(2)}%</div>
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px">
          <span style="font-size:10px;font-weight:800;letter-spacing:.04em;padding:3px 8px;border-radius:6px;background:${sideBg};color:${sideClr}">${sideLbl}</span>
          <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:6px;background:var(--panel-2);color:var(--fg-2)">${levVal}× ${levType}</span>
        </div>
      </div>

      <!-- Margin & risk -->
      <div style="border:1px solid var(--border);border-radius:16px;padding:14px;background:var(--panel)">
        <div style="font-size:14px;font-weight:800;margin-bottom:12px">Margin &amp; risk</div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:7px">
          <span style="font-size:12px;color:var(--muted)">Position health</span>
          <span style="font-size:12px;font-weight:700;color:${healthClr}">${healthPct.toFixed(1)}% healthy</span>
        </div>
        <div style="position:relative;height:7px;border-radius:4px;background:linear-gradient(90deg,var(--red),#f5c518 48%,var(--green));margin-bottom:6px">
          <div style="position:absolute;top:50%;left:${Math.max(2, Math.min(98, healthPct)).toFixed(1)}%;width:13px;height:13px;border-radius:50%;background:#fff;border:2px solid var(--bg);transform:translate(-50%,-50%);box-shadow:0 1px 3px rgba(0,0,0,0.5)"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:14px">
          <span style="color:var(--red)">Liq ${liqPx > 0 ? '$' + _prv(fmtPrice(liqPx)) : '—'}</span>
          <span style="color:var(--muted)">Mark $${fmtPrice(mark)}</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 10px">
          ${riskCell('Position margin', '$' + _prv(fmtUSD(margin, 2)))}
          ${riskCell('Leverage', levVal.toFixed ? levVal.toFixed(2) + '×' : levVal + '×')}
          ${riskCell('Liq. price', liqPx > 0 ? '<span style="color:var(--red)">$' + _prv(fmtPrice(liqPx)) + '</span>' : '—')}
          ${riskCell('Funding paid', '<span style="color:' + fundPClr + '">' + (fundPaid >= 0 ? '+' : '−') + '$' + _prv(fmtUSD(Math.abs(fundPaid), 2)) + '</span>')}
        </div>
      </div>

      <!-- Performance -->
      <div style="padding:2px 2px 0">
        <div style="font-size:12px;color:var(--muted);margin-bottom:2px">Performance (this position)</div>
        ${perfRow('Entry price', '$' + _prv(fmtPrice(entryPx)))}
        ${perfRow('Unrealized PnL', '<span style="color:' + pnlClr + '">' + pnlArr + ' ' + (uPnl >= 0 ? '+' : '−') + '$' + _prv(fmtUSD(Math.abs(uPnl), 2)) + ' (' + (roe >= 0 ? '+' : '') + roe.toFixed(2) + '%)</span>')}
        ${perfRow('Funding paid', '<span style="color:' + fundPClr + '">' + (fundPaid >= 0 ? '+' : '−') + '$' + _prv(fmtUSD(Math.abs(fundPaid), 2)) + '</span>')}
        ${perfRow('Net PnL', '<span style="color:' + netClr + '">' + (netPnl >= 0 ? '+' : '−') + '$' + _prv(fmtUSD(Math.abs(netPnl), 2)) + '</span>')}
      </div>`
  }

  const aboutTxt = isSpot
    ? `${esc(display)} trades spot against USDC on Hyperliquid's fully on-chain order book. Spot balances settle directly into your account — no leverage or funding applies.`
    : `The ${esc(display)} perpetual tracks ${esc(display)}'s price via an on-chain oracle, with funding settled hourly to keep the mark aligned with the underlying. Orders clear on Hyperliquid's on-chain book.`

  const TFS = ['1m','5m','15m','1h','4h','1D','1W']

  el.innerHTML = `
    <div style="flex-shrink:0;padding:9px 12px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
      <button onclick="window._mobTradeGoBack()" style="background:none;border:none;color:var(--fg);font-size:22px;padding:0 2px 0 0;cursor:pointer;line-height:1">←</button>
      <div style="width:26px;height:26px;border-radius:50%;overflow:hidden;background:var(--panel-2);flex-shrink:0">${_coinIconHtml(coin)}</div>
      <button onclick="window._mobVTradeToggleCoinPicker()" style="background:none;border:none;color:var(--fg);cursor:pointer;padding:0;display:flex;align-items:center;gap:5px">
        <span style="font-size:15px;font-weight:700;line-height:1">${esc(display)}-${quote}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="11" height="11" style="color:var(--muted)"><polyline points="6 9 12 15 18 9"/></svg>
      </button>
      <div style="flex:1"></div>
      <button id="mobDetailFavBtn" onclick="window._mobTradeFavToggle('${esc(coin)}')" style="background:none;border:none;color:${coinFav?'var(--accent)':'var(--muted)'};font-size:20px;padding:4px;cursor:pointer;line-height:1">★</button>
    </div>

    <div class="mob-trade-scroll" style="flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px 12px 100px;display:flex;flex-direction:column;gap:14px">
      <!-- Hero: mark price -->
      <div>
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:2px">
          <span style="font-size:12px;color:var(--muted)">Mark price</span>
          <span style="font-size:9px;font-weight:800;letter-spacing:.05em;padding:2px 6px;border-radius:5px;background:var(--panel-2);color:var(--muted)">${badge}</span>
        </div>
        <div style="font-family:var(--font-mono);font-weight:800;line-height:1;margin:2px 0 8px">
          <span style="font-size:42px">${pxInt}</span><span style="font-size:24px;color:var(--muted)">${pxDec}</span>
        </div>
        <div style="display:inline-flex;align-items:center;gap:6px">
          <span style="display:inline-flex;align-items:center;gap:4px;font-size:13px;font-weight:700;color:${chgClr};background:${chgBg};padding:4px 9px;border-radius:8px">
            ${chgArr} ${chg24 >= 0 ? '+' : '−'}$${_fmtHdrChgAbs(Math.abs(chgAbs), mark)} (${chg24 >= 0 ? '+' : ''}${chg24.toFixed(2)}%)
          </span>
          <span style="font-size:12px;color:var(--muted)">24h</span>
        </div>
      </div>

      <!-- Chart -->
      <div style="position:relative;border:1px solid var(--border);border-radius:16px;overflow:hidden;background:var(--panel)">
        <div id="mobChartHero" style="position:absolute;top:8px;left:11px;z-index:2;font-size:12px;pointer-events:none"></div>
        <button id="mobChartTypeBtn" onclick="window._mobChartToggleType()" title="Toggle candlesticks" style="position:absolute;top:6px;right:42px;z-index:3;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid var(--border2);background:var(--panel-2);color:var(--muted);cursor:pointer;padding:0">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="7" y1="3" x2="7" y2="21"/><rect x="4.5" y="7" width="5" height="8" rx="1" fill="currentColor" stroke="none"/><line x1="17" y1="3" x2="17" y2="21"/><rect x="14.5" y="9.5" width="5" height="6.5" rx="1" fill="currentColor" stroke="none"/></svg>
        </button>
        <button onclick="window._mobChartReset()" title="Reset chart" style="position:absolute;top:6px;right:8px;z-index:3;display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:8px;border:1px solid var(--border2);background:var(--panel-2);color:var(--fg-2);cursor:pointer;padding:0">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>
        </button>
        <div style="position:relative;height:400px;padding:26px 2px 2px"><canvas id="mobChartCanvas"></canvas></div>
        <div style="display:flex;gap:2px;padding:7px 8px;border-top:1px solid var(--border)">
          ${TFS.map(tf => `<button class="mob-detail-tf" data-tf="${tf}" onclick="window._mobDetailSetTf('${tf}')"
            style="flex:1;padding:6px 0;border-radius:7px;border:none;background:${_mobChartTf===tf?'var(--panel-3)':'transparent'};color:${_mobChartTf===tf?'var(--fg)':'var(--muted)'};font-size:11px;font-weight:700;cursor:pointer">${tf.toUpperCase()}</button>`).join('')}
        </div>
      </div>

      ${!isSpot ? `
      <!-- Funding / next / OI strip -->
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid var(--border);border-radius:14px;overflow:hidden;background:var(--panel)">
        <div style="padding:11px 12px">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Funding</div>
          <div style="font-size:14px;font-weight:700;color:${fundClr};font-family:var(--font-mono)">${fund >= 0 ? '+' : ''}${fund.toFixed(4)}%</div>
        </div>
        <div style="padding:11px 12px;border-left:1px solid var(--border)">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Volume 24h</div>
          <div style="font-size:14px;font-weight:700;font-family:var(--font-mono)">$${_fmtK(ctx?.volume ?? 0)}</div>
        </div>
        <div style="padding:11px 12px;border-left:1px solid var(--border)">
          <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin-bottom:3px">Open int.</div>
          <div style="font-size:14px;font-weight:700;font-family:var(--font-mono)">$${_fmtK(oi)}</div>
        </div>
      </div>` : ''}

      ${posBlocks}

      <!-- About -->
      <div style="padding:2px 2px 0">
        <div style="font-size:12px;color:var(--muted);margin-bottom:5px">About this market</div>
        <div style="font-size:13px;line-height:1.5;color:var(--fg-2)">${aboutTxt}</div>
      </div>
    </div>

    <!-- Sticky action bar -->
    <div style="flex-shrink:0;display:flex;gap:8px;padding:10px 12px;border-top:1px solid var(--border);background:var(--bg)">
      <button onclick="window._mobOpenOrderSheet('long')"  style="flex:1;padding:14px;border-radius:13px;border:none;background:var(--green);color:#000;font-weight:800;font-size:15px;cursor:pointer">Long</button>
      <button onclick="window._mobOpenOrderSheet('short')" style="flex:1;padding:14px;border-radius:13px;border:none;background:var(--red);color:#fff;font-weight:800;font-size:15px;cursor:pointer">Short</button>
      <button onclick="window._mobOpenMktTools('orderbook')" style="flex-shrink:0;width:52px;border-radius:13px;border:1px solid var(--border2);background:var(--panel-2);color:var(--fg-2);cursor:pointer;display:flex;align-items:center;justify-content:center">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>
      </button>
    </div>`

  // Interactive Chart.js price chart (crosshair, axes, pan/zoom) + overlays
  _mobRenderTradeChart(coin, _mobChartTf)
}

window._mobChartReset = function() { resetMobTradeChart() }

// Which trade chart is on screen — mobile detail view or the desktop Trade tab.
function _chartTarget() {
  return _isMobView()
    ? { canvasId: 'mobChartCanvas',  heroId: 'mobChartHero' }
    : { canvasId: 'deskChartCanvas', heroId: 'deskChartHero' }
}

function _mobUpdateChartTypeBtn() {
  const on = _mobChartType === 'candle'
  for (const id of ['mobChartTypeBtn', 'deskChartTypeBtn']) {
    const b = document.getElementById(id)
    if (!b) continue
    b.style.color       = on ? 'var(--accent)' : 'var(--muted)'
    b.style.borderColor = on ? 'var(--accent)' : 'var(--border2)'
    b.style.background  = on ? 'color-mix(in oklch,var(--accent) 12%,transparent)' : 'var(--panel-2)'
  }
}

window._mobChartToggleType = function() {
  _mobChartType = _mobChartType === 'line' ? 'candle' : 'line'
  const t = _chartTarget()
  const cv = document.getElementById(t.canvasId)
  const coin = state.selectedCoin || 'BTC'
  if (cv && window._mobTradeCandles) {
    renderMobTradeChart(cv, window._mobTradeCandles, _mobChartOverlays(coin), t.heroId, _mobChartTf, _mobChartType)
  }
  _mobUpdateChartTypeBtn()
}

window._mobDetailSetTf = function(tf) {
  _mobChartTf = tf
  document.querySelectorAll('.mob-detail-tf').forEach(b => {
    const a = b.dataset.tf === tf
    b.style.background = a ? 'var(--panel-3)' : 'transparent'
    b.style.color      = a ? 'var(--fg)' : 'var(--muted)'
  })
  _mobRenderTradeChart(state.selectedCoin || 'BTC', tf)
}

// Overlay lines for the trade chart: entry / liq (position) + TP / SL + nearest
// open limit orders (capped so a grid bot's dozens of orders don't bury the chart).
function _mobChartOverlays(coin) {
  const overlays = []
  const ps  = (isConnected() && _tradePerpState) ? _tradePerpState : state.perpState
  const pos = (ps?.assetPositions ?? []).find(ap => ap.position?.coin === coin)?.position
  if (pos && parseFloat(pos.szi ?? 0) !== 0) {
    const e = parseFloat(pos.entryPx ?? 0), l = parseFloat(pos.liquidationPx ?? 0)
    if (e > 0) overlays.push({ price: e, color: '#f5c518', label: 'Entry' })
    if (l > 0) overlays.push({ price: l, color: '#ff4d6d', label: 'Liq' })
  }
  const orders = []
  for (const o of (state.openOrders ?? [])) {
    if (o.coin !== coin) continue
    const ot   = o.orderType ?? ''
    const isTp = ot.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl = ot.startsWith('Stop')        || o.triggerCondition === 'sl'
    const px   = parseFloat(o.triggerPx ?? 0) > 0 ? parseFloat(o.triggerPx) : parseFloat(o.limitPx ?? 0)
    if (!px) continue
    if      (isTp) overlays.push({ price: px, color: '#00e5a0', label: 'TP', type: 'line' })
    else if (isSl) overlays.push({ price: px, color: '#ff8c42', label: 'SL', type: 'line' })
    else           orders.push({ price: px, color: '#ffa033', label: 'Order', type: 'dot' })
  }
  const mark = _mktCtxMap[coin]?.markPx || parseFloat(state.allMids?.[coin] ?? 0)
  orders.sort((a, b) => Math.abs(a.price - mark) - Math.abs(b.price - mark))
  return overlays.concat(orders.slice(0, 40))
}

// ─── Interactive trade-detail chart (Chart.js, same engine as the home charts) ─
async function _mobRenderTradeChart(coin, tf, canvasId = 'mobChartCanvas', heroId = 'mobChartHero') {
  const canvas = document.getElementById(canvasId)
  const hero   = document.getElementById(heroId)
  if (!canvas) return
  if (hero) hero.innerHTML = '<span style="color:var(--muted)">Loading…</span>'

  const hlInterval = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','1h':'1h','4h':'4h','8h':'8h','1D':'1d','1d':'1d','1W':'1w','1w':'1w' }[tf] ?? '1h'
  // Fetch deep history (~5000 candles, HL's per-request cap) so the user can
  // pan/zoom far back; the chart defaults to the recent window.
  const D = 86400 * 1000
  const lookbackMs = { '1m':3.3*D,'5m':17*D,'15m':50*D,'30m':100*D,'1h':200*D,'4h':800*D,'8h':1600*D,'1D':3650*D,'1d':3650*D,'1W':3650*D,'1w':3650*D }[tf] ?? 200*D

  let candles
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: hlInterval, startTime: Date.now() - lookbackMs, endTime: null } })
    })
    candles = await r.json()
  } catch { candles = [] }

  const cv = document.getElementById(canvasId)
  if (!cv || (state.selectedCoin || 'BTC') !== coin) return   // user navigated away
  if (!Array.isArray(candles) || candles.length < 2) {
    const h = document.getElementById(heroId)
    if (h) h.innerHTML = '<span style="color:var(--muted)">No chart data</span>'
    return
  }

  window._mobTradeCandles = candles
  renderMobTradeChart(cv, candles, _mobChartOverlays(coin), heroId, tf, _mobChartType)
  _mobUpdateChartTypeBtn()

  // Live updates via candle WS
  if (window._mobCandleWs) { try { window._mobCandleWs.close() } catch {} window._mobCandleWs = null }
  const ws = new WebSocket('wss://api.hyperliquid.xyz/ws')
  window._mobCandleWs = ws
  ws.onopen = () => ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin, interval: hlInterval } }))
  ws.onmessage = (evt) => {
    if (window._mobCandleWs !== ws) return
    try {
      const msg = JSON.parse(evt.data)
      if (msg.channel !== 'candle' || !msg.data) return
      const arr = window._mobTradeCandles
      if (!arr) return
      const k = msg.data
      const last = arr[arr.length - 1]
      if (last && k.t === last.t) arr[arr.length - 1] = k
      else { arr.push(k); if (arr.length > 6000) arr.shift() }
      updateMobTradeChartData(arr, _mobChartOverlays(coin))
    } catch {}
  }
  ws.onerror = ws.onclose = () => {}
}

// Order entry as a bottom sheet (reuses the full trade form)
window._mobOpenOrderSheet = function(side) {
  state.tradeSide = side
  const coin    = state.selectedCoin || 'BTC'
  const display = _spotNameMap[coin] ?? _mktDisplay(coin) ?? coin.replace(/.*:/, '')
  let ov = document.getElementById('mobOrderSheetOverlay')
  if (ov) ov.remove()
  ov = document.createElement('div')
  ov.id = 'mobOrderSheetOverlay'
  ov.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;flex-direction:column;justify-content:flex-end'
  ov.innerHTML = `
    <div onclick="window._mobCloseOrderSheet()" style="position:absolute;inset:0;background:rgba(0,0,0,0.55)"></div>
    <div style="position:relative;background:var(--bg);border-radius:20px 20px 0 0;border-top:1px solid var(--border);height:88vh;display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,0.4)">
      <div style="flex-shrink:0;display:flex;align-items:center;gap:9px;padding:12px 14px;border-bottom:1px solid var(--border)">
        <div style="width:24px;height:24px;border-radius:50%;overflow:hidden;background:var(--panel-2);flex-shrink:0">${_coinIconHtml(coin)}</div>
        <span style="font-size:15px;font-weight:700">${esc(display)} <span style="color:var(--muted);font-weight:500">order</span></span>
        <button onclick="window._mobCloseOrderSheet()" style="margin-left:auto;background:none;border:none;color:var(--muted);font-size:24px;line-height:1;cursor:pointer;padding:0 4px">✕</button>
      </div>
      <div id="mobOrderSheetContent" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>
    </div>`
  document.body.appendChild(ov)
  const content = document.getElementById('mobOrderSheetContent')
  if (content) _mobRenderDetailTrade(content, coin)
}

window._mobCloseOrderSheet = function() {
  _stopAvailTimer()
  const ov = document.getElementById('mobOrderSheetOverlay')
  if (ov) ov.remove()
}

// Order book / recent fills as a bottom sheet (the squares button)
window._mobOpenMktTools = function(tab) {
  tab = tab || 'orderbook'
  let ov = document.getElementById('mobToolsSheetOverlay')
  if (ov) ov.remove()
  ov = document.createElement('div')
  ov.id = 'mobToolsSheetOverlay'
  ov.style.cssText = 'position:fixed;inset:0;z-index:10001;display:flex;flex-direction:column;justify-content:flex-end'
  ov.innerHTML = `
    <div onclick="window._mobCloseMktTools()" style="position:absolute;inset:0;background:rgba(0,0,0,0.55)"></div>
    <div style="position:relative;background:var(--bg);border-radius:20px 20px 0 0;border-top:1px solid var(--border);height:80vh;display:flex;flex-direction:column;box-shadow:0 -8px 30px rgba(0,0,0,0.4)">
      <div style="flex-shrink:0;display:flex;align-items:center;border-bottom:1px solid var(--border)">
        <button class="mob-tools-tab" data-tab="orderbook" onclick="window._mobMktToolsTab('orderbook')" style="flex:1;padding:12px 0;border:none;background:none;font-size:13px;cursor:pointer">Order book</button>
        <button class="mob-tools-tab" data-tab="history" onclick="window._mobMktToolsTab('history')" style="flex:1;padding:12px 0;border:none;background:none;font-size:13px;cursor:pointer">Recent fills</button>
        <button onclick="window._mobCloseMktTools()" style="background:none;border:none;color:var(--muted);font-size:22px;line-height:1;cursor:pointer;padding:0 12px">✕</button>
      </div>
      <div id="mobToolsContent" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>
    </div>`
  document.body.appendChild(ov)
  window._mobMktToolsTab(tab)
}

window._mobMktToolsTab = function(tab) {
  const c = document.getElementById('mobToolsContent')
  if (!c) return
  document.querySelectorAll('.mob-tools-tab').forEach(b => {
    const a = b.dataset.tab === tab
    b.style.color        = a ? 'var(--fg)' : 'var(--muted)'
    b.style.fontWeight   = a ? '700' : '500'
    b.style.borderBottom = a ? '2px solid var(--accent)' : '2px solid transparent'
  })
  const coin = state.selectedCoin || 'BTC'
  if (tab === 'orderbook') _mobRenderDetailOrderBook(c, coin)
  else                     _mobRenderDetailHistory(c, coin)
}

window._mobCloseMktTools = function() {
  if (_mobTradeObTimer) { clearInterval(_mobTradeObTimer); _mobTradeObTimer = null }
  const ov = document.getElementById('mobToolsSheetOverlay')
  if (ov) ov.remove()
}

function _mobRenderDetailContent(el, coin) {
  // Always clean up any running chart when switching content
  if (window._mobCandleWs) { try { window._mobCandleWs.close() } catch {} window._mobCandleWs = null }
  if (window._mobLWChart)  { try { window._mobLWChart.remove() } catch {} window._mobLWChart = null }
  if (window._mobLWRO)     { window._mobLWRO.disconnect(); window._mobLWRO = null }
  window._mobCandleSeries = null
  window._mobPriceLines   = []
  if (_mobTradeDetailTab === 'chart')      _mobRenderDetailChart(el, coin)
  else if (_mobTradeDetailTab === 'trade')      _mobRenderDetailTrade(el, coin)
  else if (_mobTradeDetailTab === 'orderbook')  _mobRenderDetailOrderBook(el, coin)
  else if (_mobTradeDetailTab === 'history')    _mobRenderDetailHistory(el, coin)
}

function _mobRenderDetailChart(el, coin) {
  el.style.overflow      = 'hidden'
  el.style.display       = 'flex'
  el.style.flexDirection = 'column'

  el.innerHTML = `
    <div style="flex-shrink:0;display:flex;gap:2px;padding:5px 10px;border-bottom:1px solid var(--border)">
      ${['1m','5m','15m','1h','4h','1D'].map(tf => `<button onclick="window._mobChartSetTf('${tf}')"
        style="padding:4px 8px;border-radius:6px;border:none;background:${_mobChartTf===tf?'var(--panel-2)':'transparent'};color:${_mobChartTf===tf?'var(--fg)':'var(--muted)'};font-size:11px;font-weight:600;cursor:pointer">${tf}</button>`).join('')}
    </div>
    <div id="mobChartWidget" style="flex:1;min-height:0;overflow:hidden"></div>`

  // Pass the FULL coin id (incl. HIP-3 dex prefix like "xyz:TSLA") — candleSnapshot
  // 500s on the bare symbol, which showed "No chart data available".
  _mobLoadHLChart(coin, _mobChartTf)
}

window._mobChartSetTf = function(tf) {
  _mobChartTf = tf
  if (_mobTradeDetailTab === 'chart') {
    const contentEl = document.getElementById('mobTradeDetailContent')
    if (contentEl) _mobRenderDetailChart(contentEl, state.selectedCoin || 'BTC')
  }
}

async function _mobLoadHLChart(coin, tf) {
  const container = document.getElementById('mobChartWidget')
  if (!container) return

  container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px">Loading chart…</div>'

  // Load pinned v4.2.0 — v5 changed the series API
  if (!window.LightweightCharts) {
    if (!document.getElementById('lwcScript')) {
      await new Promise(resolve => {
        const s = document.createElement('script')
        s.id = 'lwcScript'
        s.src = 'https://unpkg.com/lightweight-charts@4.2.0/dist/lightweight-charts.standalone.production.js'
        s.onload  = resolve
        s.onerror = resolve
        document.head.appendChild(s)
      })
    } else {
      // Tag already inserted but library might still be loading
      for (let i = 0; i < 20 && !window.LightweightCharts; i++) {
        await new Promise(r => setTimeout(r, 100))
      }
    }
  }

  if (!window.LightweightCharts) {
    const c = document.getElementById('mobChartWidget')
    if (c) c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--red);font-size:13px">Chart library failed to load</div>'
    return
  }

  const hlInterval = { '1m':'1m','5m':'5m','15m':'15m','1h':'1h','4h':'4h','1D':'1d' }[tf] ?? '1h'
  const lookbackMs = { '1m':12*3600*1000,'5m':4*86400*1000,'15m':10*86400*1000,'1h':45*86400*1000,'4h':180*86400*1000,'1D':600*86400*1000 }[tf] ?? 45*86400*1000

  let candles
  try {
    const r = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'candleSnapshot', req: { coin, interval: hlInterval, startTime: Date.now() - lookbackMs, endTime: null } })
    })
    candles = await r.json()
  } catch { candles = [] }

  const c = document.getElementById('mobChartWidget')
  if (!c) return
  if (!Array.isArray(candles) || !candles.length) {
    c.innerHTML = '<div style="padding:40px;text-align:center;color:var(--muted);font-size:13px">No chart data available</div>'
    return
  }

  c.innerHTML = ''

  // Wait one frame so the DOM has laid out and clientHeight is non-zero
  await new Promise(r => requestAnimationFrame(r))
  const c2 = document.getElementById('mobChartWidget')
  if (!c2) return

  const isDark = !document.body.classList.contains('theme-light')
  const chart = window.LightweightCharts.createChart(c2, {
    width:  c2.clientWidth  || 320,
    height: c2.clientHeight || 300,
    layout: { background: { color: isDark ? '#131722' : '#ffffff' }, textColor: isDark ? '#d1d4dc' : '#444444', fontSize: 12 },
    grid:   { vertLines: { color: isDark ? '#1e222d' : '#f0f0f0' }, horzLines: { color: isDark ? '#1e222d' : '#f0f0f0' } },
    crosshair: { mode: 1 },
    rightPriceScale: { borderColor: isDark ? '#2a2e39' : '#dddddd' },
    timeScale: { borderColor: isDark ? '#2a2e39' : '#dddddd', timeVisible: true, secondsVisible: tf === '1m' },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
    handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: { time: true, price: false } },
  })

  const candleSeries = chart.addCandlestickSeries({
    upColor: '#26a69a', downColor: '#ef5350',
    borderVisible: false,
    wickUpColor: '#26a69a', wickDownColor: '#ef5350',
  })
  const volumeSeries = chart.addHistogramSeries({
    priceFormat: { type: 'volume' },
    priceScaleId: 'vol',
    scaleMargins: { top: 0.82, bottom: 0 },
  })
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false })

  const mapped = candles.map(k => ({
    time:  Math.floor(k.t / 1000),
    open:  parseFloat(k.o), high: parseFloat(k.h),
    low:   parseFloat(k.l), close: parseFloat(k.c),
    value: parseFloat(k.v),
    color: parseFloat(k.c) >= parseFloat(k.o) ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)',
  }))

  candleSeries.setData(mapped)
  volumeSeries.setData(mapped.map(d => ({ time: d.time, value: d.value, color: d.color })))
  chart.timeScale().fitContent()

  window._mobCandleSeries = candleSeries
  window._mobPriceLines   = []
  _refreshMobChartLines(coin)

  const ro = new ResizeObserver(() => {
    if (window._mobLWChart === chart) chart.applyOptions({ width: c2.clientWidth, height: c2.clientHeight })
  })
  ro.observe(c2)
  window._mobLWChart = chart
  window._mobLWRO    = ro

  // Live candle streaming
  const _wsMobCandle = candleSeries
  const _wsMobVolume = volumeSeries
  const mobWs = new WebSocket('wss://api.hyperliquid.xyz/ws')
  window._mobCandleWs = mobWs
  mobWs.onopen = () => {
    mobWs.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'candle', coin, interval: hlInterval } }))
  }
  mobWs.onmessage = (evt) => {
    if (window._mobCandleWs !== mobWs) return
    try {
      const msg = JSON.parse(evt.data)
      if (msg.channel !== 'candle' || !msg.data) return
      const k = msg.data
      const t = Math.floor(k.t / 1000)
      _wsMobCandle.update({ time: t, open: parseFloat(k.o), high: parseFloat(k.h), low: parseFloat(k.l), close: parseFloat(k.c) })
      _wsMobVolume.update({ time: t, value: parseFloat(k.v), color: parseFloat(k.c) >= parseFloat(k.o) ? 'rgba(38,166,154,0.5)' : 'rgba(239,83,80,0.5)' })
    } catch {}
  }
  mobWs.onerror = mobWs.onclose = () => {}
}

function _refreshMobChartLines(coin) {
  if (!window._mobCandleSeries) return
  const activeCoin = coin || state.selectedCoin
  if (!activeCoin) return

  for (const pl of (window._mobPriceLines ?? [])) {
    try { window._mobCandleSeries.removePriceLine(pl) } catch {}
  }
  window._mobPriceLines = []

  const ps = (isConnected() && _tradePerpState) ? _tradePerpState : state.perpState
  const posEntry = (ps?.assetPositions ?? []).find(ap => ap.position?.coin === activeCoin)
  const pos = posEntry?.position

  if (pos && parseFloat(pos.szi ?? 0) !== 0) {
    const entryPx = parseFloat(pos.entryPx ?? 0)
    const liqPx   = parseFloat(pos.liquidationPx ?? 0)
    if (entryPx > 0) {
      window._mobPriceLines.push(window._mobCandleSeries.createPriceLine({
        price: entryPx, color: '#f5c518', lineWidth: 1.5,
        lineStyle: 0, axisLabelVisible: true, title: 'Entry',
      }))
    }
    if (liqPx > 0) {
      window._mobPriceLines.push(window._mobCandleSeries.createPriceLine({
        price: liqPx, color: '#ff4d6d', lineWidth: 1,
        lineStyle: 2, axisLabelVisible: true, title: 'Liq',
      }))
    }
  }

  for (const o of (state.openOrders ?? [])) {
    if (o.coin !== activeCoin) continue
    const orderType = o.orderType ?? ''
    const isTp = orderType.startsWith('Take Profit') || o.triggerCondition === 'tp'
    const isSl = orderType.startsWith('Stop')        || o.triggerCondition === 'sl'
    const px   = parseFloat(o.triggerPx ?? 0) > 0 ? parseFloat(o.triggerPx) : parseFloat(o.limitPx ?? 0)
    if (!px) continue
    let color, title, style
    if (isTp) {
      color = '#00e5a0'; title = 'TP'; style = 2
    } else if (isSl) {
      color = '#ff8c42'; title = 'SL'; style = 2
    } else {
      color = o.side === 'B' ? '#26a69a' : '#ef5350'
      title = o.side === 'B' ? 'Buy' : 'Sell'
      style = 1
    }
    window._mobPriceLines.push(window._mobCandleSeries.createPriceLine({
      price: px, color, lineWidth: 1,
      lineStyle: style, axisLabelVisible: true, title,
    }))
  }
}

function _mobRenderDetailTrade(el, coin) {
  const mids      = state.allMids ?? {}
  const price     = parseFloat(mids[coin] ?? 0)
  const isBuy     = state.tradeSide !== 'short'
  const isLmt     = state.orderType === 'limit'
  const lev       = state.leverage ?? 5
  const avail     = _tradeAvail().avail
  const isIso     = state.isIsolated ?? false
  const accentClr = isBuy ? 'var(--green)' : 'var(--red)'
  const connected = isConnected()
  const display   = _spotNameMap[coin] ?? _mktDisplay(coin) ?? coin.replace(/.*:/, '')

  // Make el a flex row (horizontal split) — no wrapper div needed
  el.style.overflow      = 'hidden'
  el.style.display       = 'flex'
  el.style.flexDirection = 'column'
  const isCoin    = _mobTradeAmtUnit === 'coin'
  el.innerHTML = `
    <div style="flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:12px 12px 84px;display:flex;flex-direction:column;gap:11px">
      <!-- Order type + available -->
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div style="display:flex;gap:3px;background:var(--panel-2);border-radius:9px;padding:3px">
          <button id="mobTradeOrderTypeMkt" onclick="window._mobVSetOrderType('market')" style="padding:6px 13px;border-radius:7px;border:none;background:${!isLmt?'var(--panel-3)':'transparent'};color:${!isLmt?'var(--fg)':'var(--muted)'};font-size:12px;font-weight:600;cursor:pointer;transition:all .12s">Market</button>
          <button id="mobTradeOrderTypeLmt" onclick="window._mobVSetOrderType('limit')" style="padding:6px 13px;border-radius:7px;border:none;background:${isLmt?'var(--panel-3)':'transparent'};color:${isLmt?'var(--fg)':'var(--muted)'};font-size:12px;font-weight:600;cursor:pointer;transition:all .12s">Limit</button>
        </div>
        <span style="font-size:11px;color:var(--muted)">Available <span id="mobTradeAvailAmt" style="color:var(--fg);font-weight:700;font-family:var(--font-mono)">$${fmtUSD(avail,2)}</span></span>
      </div>
      <!-- Long / Short -->
      <div style="display:flex;gap:6px">
        <button id="mobTradeLongBtn" onclick="window._mobVSetSide('long')" style="flex:1;padding:12px;border-radius:11px;border:1px solid ${isBuy?'var(--green)':'var(--border2)'};font-size:14px;font-weight:700;cursor:pointer;background:${isBuy?'color-mix(in oklch,var(--green) 18%,transparent)':'var(--panel-2)'};color:${isBuy?'var(--green)':'var(--muted)'};transition:all .12s">Long</button>
        <button id="mobTradeShortBtn" onclick="window._mobVSetSide('short')" style="flex:1;padding:12px;border-radius:11px;border:1px solid ${!isBuy?'var(--red)':'var(--border2)'};font-size:14px;font-weight:700;cursor:pointer;background:${!isBuy?'color-mix(in oklch,var(--red) 18%,transparent)':'var(--panel-2)'};color:${!isBuy?'var(--red)':'var(--muted)'};transition:all .12s">Short</button>
      </div>
      <!-- Margin mode + leverage -->
      <div style="display:flex;gap:6px">
        <button id="mobTradeIsolatedBtn" onclick="window._mobVToggleIsolated()" style="flex:1;padding:9px;border-radius:10px;border:1px solid var(--border2);background:var(--panel-2);color:var(--fg-2);font-size:12px;font-weight:600;cursor:pointer">${isIso?'Isolated':'Cross'}</button>
        <button id="mobTradeLevBtn" onclick="window._mobTradeLevPicker()" style="flex:1;padding:9px;border-radius:10px;border:1px solid var(--accent);background:color-mix(in oklch,var(--accent) 12%,transparent);color:var(--accent);font-size:12px;font-weight:700;cursor:pointer">${lev}× Leverage</button>
      </div>
      <!-- Amount input -->
      <div style="display:flex;flex-direction:column;gap:6px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:11px;font-weight:600;color:var(--fg-2);text-transform:uppercase;letter-spacing:.05em">Amount</span>
          <span id="mobTradeConvHint" style="font-size:11px;color:var(--muted);font-family:var(--font-mono)"></span>
        </div>
        <div id="mobTradeAmtBox" style="border:1px solid var(--border2);border-radius:12px;padding:11px 12px;background:var(--panel-2);display:flex;align-items:center;gap:8px;transition:border-color .15s,box-shadow .15s">
          <span id="mobTradeAmtPrefix" style="color:var(--muted);font-size:16px;flex-shrink:0">${isCoin?'':'$'}</span>
          <input id="mobTradeAmtInput" type="number" placeholder="0.00" step="any" min="0"
            oninput="window._mobTradeUpdateSlider()"
            onfocus="this.closest('#mobTradeAmtBox').style.borderColor='var(--accent)';this.closest('#mobTradeAmtBox').style.boxShadow='0 0 0 3px color-mix(in oklch,var(--accent) 16%,transparent)'"
            onblur="this.closest('#mobTradeAmtBox').style.borderColor='var(--border2)';this.closest('#mobTradeAmtBox').style.boxShadow='none'"
            style="flex:1;min-width:0;background:none;border:none;color:var(--fg);font-size:19px;font-weight:700;outline:none;-webkit-text-size-adjust:none;font-family:var(--font-mono)">
          <button id="mobTradeUnitToggle" onclick="window._mobTradeToggleUnit()" style="display:flex;align-items:center;gap:4px;background:var(--bg1);border:1px solid var(--border2);border-radius:9px;padding:6px 10px;font-size:12px;font-weight:700;color:var(--accent);cursor:pointer;flex-shrink:0">
            <span id="mobTradeUnitLabel">${isCoin?esc(display):'USDC'}</span>
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
        </div>
      </div>
      <!-- % quick buttons -->
      <div style="display:flex;gap:6px">
        ${[25,50,75,100].map(p => `<button onclick="window._mobTradeSetPct(${p})" style="flex:1;padding:7px 0;border-radius:9px;border:1px solid var(--border2);background:var(--panel-2);color:var(--fg-2);font-size:11px;font-weight:600;cursor:pointer">${p}%</button>`).join('')}
      </div>
      <!-- Slider -->
      <input id="mobTradeAmtSlider" type="range" min="0" max="100" value="0" step="1"
        oninput="window._mobTradeSliderAmt(this.value)"
        style="width:100%;accent-color:${accentClr}">
      <!-- Limit price — always in DOM, toggled by display -->
      <div id="mobTradeLimitWrapper" style="display:${isLmt?'flex':'none'};border:1px solid var(--border2);border-radius:12px;padding:11px 12px;background:var(--panel-2);align-items:center;gap:8px">
        <span style="color:var(--muted);font-size:12px;flex-shrink:0;font-weight:600">Limit price</span>
        <input id="mobTradeLimitInput" type="number" placeholder="${fmtPrice(price)}" step="any" min="0"
          oninput="window._mobUpdateOrderSummary&&window._mobUpdateOrderSummary()"
          style="flex:1;background:none;border:none;color:var(--fg);font-size:15px;font-weight:700;outline:none;-webkit-text-size-adjust:none;text-align:right;font-family:var(--font-mono)">
        <span style="font-size:12px;color:var(--muted)">USDC</span>
      </div>
      <!-- TP/SL -->
      <div style="border:1px solid var(--border2);border-radius:12px;overflow:hidden">
        <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:var(--panel-2)">
          <input type="checkbox" id="mobTpSlCheck" ${_mobVTradeTp||_mobVTradeSl?'checked':''} onchange="window._mobToggleTpSl(this.checked)" style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer">
          <label for="mobTpSlCheck" style="font-size:13px;font-weight:600;cursor:pointer">Take Profit / Stop Loss</label>
        </div>
        <div id="mobTpSlInputs" style="display:${_mobVTradeTp||_mobVTradeSl?'flex':'none'};gap:8px;padding:9px 12px">
          <div style="flex:1;display:flex;align-items:center;gap:5px;background:color-mix(in oklch,var(--green) 7%,transparent);border:1px solid color-mix(in oklch,var(--green) 30%,transparent);border-radius:9px;padding:7px 9px">
            <span style="font-size:9px;font-weight:700;color:var(--green);flex-shrink:0">TP</span>
            <input id="mobTradeTpInput" type="number" placeholder="Price" step="any" value="${_mobVTradeTp||''}" onchange="window._mobTradeTpChange(this.value)" style="flex:1;background:none;border:none;color:var(--fg);font-size:13px;outline:none;width:100%;-webkit-text-size-adjust:none;font-family:var(--font-mono)">
          </div>
          <div style="flex:1;display:flex;align-items:center;gap:5px;background:color-mix(in oklch,var(--red) 7%,transparent);border:1px solid color-mix(in oklch,var(--red) 30%,transparent);border-radius:9px;padding:7px 9px">
            <span style="font-size:9px;font-weight:700;color:var(--red);flex-shrink:0">SL</span>
            <input id="mobTradeSlInput" type="number" placeholder="Price" step="any" value="${_mobVTradeSl||''}" onchange="window._mobTradeSlChange(this.value)" style="flex:1;background:none;border:none;color:var(--fg);font-size:13px;outline:none;width:100%;-webkit-text-size-adjust:none;font-family:var(--font-mono)">
          </div>
        </div>
      </div>
      <!-- Reduce only -->
      <label for="mobTradeROCheck" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer">
        <span style="font-size:13px;color:var(--fg-2)">Reduce Only</span>
        <input type="checkbox" id="mobTradeROCheck" style="width:17px;height:17px;accent-color:var(--accent);cursor:pointer">
      </label>
      <!-- Order summary -->
      <div style="border:1px solid var(--border2);border-radius:12px;padding:11px 12px;background:var(--panel-2);display:flex;flex-direction:column;gap:7px">
        <div class="mob-sum-row"><span>Est. Price</span><b id="mobSumPrice">—</b></div>
        <div class="mob-sum-row"><span>Size (USD)</span><b id="mobSumSizeUsd">—</b></div>
        <div class="mob-sum-row"><span>Size (Coin)</span><b id="mobSumSizeCoin">—</b></div>
        <div class="mob-sum-row"><span>Leverage</span><b id="mobSumLev">—</b></div>
        <div class="mob-sum-row"><span>Funding (8h)</span><b id="mobSumFund">—</b></div>
        <div class="mob-sum-row"><span>Est. Fee</span><b id="mobSumFee">—</b></div>
        <div style="height:1px;background:var(--border);margin:1px 0"></div>
        <div class="mob-sum-row"><span style="font-weight:700;color:var(--fg)">Required Margin</span><b id="mobSumMargin" style="color:var(--accent)">—</b></div>
      </div>
      <!-- Position preview -->
      <div id="mobPosPreview" style="display:none;border:1px solid var(--border2);border-radius:12px;padding:11px 12px;background:var(--panel-2);flex-direction:column;gap:7px">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1px">
          <span style="font-size:10px;font-weight:700;letter-spacing:.06em;color:var(--muted)">POSITION PREVIEW</span>
          <span style="font-size:10px;color:var(--muted)">estimates</span>
        </div>
        <div class="mob-sum-row"><span>New Size</span><b id="mobPpSize">—</b></div>
        <div class="mob-sum-row"><span>New Avg Entry</span><b id="mobPpEntry">—</b></div>
        <div class="mob-sum-row"><span>Est. Liq Price</span><b id="mobPpLiq">—</b></div>
        <div style="height:1px;background:var(--border);margin:1px 0"></div>
        <div class="mob-sum-row"><span style="font-weight:700;color:var(--fg)">New Margin</span><b id="mobPpMargin" style="color:var(--yellow,#f5c518)">—</b></div>
      </div>
      <!-- Submit -->
      <button id="mobTradeSubmitBtn" onclick="window._mobTradeSubmitNew()"
        style="width:100%;padding:14px;border-radius:13px;border:none;font-size:15px;font-weight:700;cursor:pointer;background:${connected?(isBuy?'var(--green)':'var(--red)'):'var(--panel-2)'};color:${connected?(isBuy?'#000':'#fff'):'var(--muted)'};letter-spacing:.01em;transition:all .12s">
        ${connected ? (isBuy ? `Long ${esc(display)}` : `Short ${esc(display)}`) : (isMainWalletConnected() ? '⚡ Auto-generate agent key' : '🔗 Connect wallet to trade')}
      </button>
      <div id="mobTradeStatus" style="text-align:center;font-size:12px;min-height:18px;padding-bottom:4px"></div>
    </div>`

  if (_mobTradeObTimer) { clearInterval(_mobTradeObTimer); _mobTradeObTimer = null }
  _mobTradeUpdateConvHint()
  _startAvailTimer()
}

function _mobRenderDetailOrderBook(el, coin) {
  el.style.overflow      = 'hidden'
  el.style.display       = 'flex'
  el.style.flexDirection = 'column'
  el.innerHTML = `
    <div style="flex-shrink:0;display:flex;justify-content:space-between;padding:4px 10px;color:var(--muted);font-size:9px;text-transform:uppercase;letter-spacing:0.04em;border-bottom:1px solid var(--border)">
      <span>Price (USDC)</span><span>Size</span><span>Cum. (USD)</span>
    </div>
    <div id="mobOBContent" style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column">
      <div style="padding:20px;text-align:center;color:var(--muted)">Loading…</div>
    </div>`
  _mobFetchOB(coin, 'mobOBContent', false)
  if (_mobTradeObTimer) clearInterval(_mobTradeObTimer)
  _mobTradeObTimer = setInterval(() => _mobFetchOB(coin, 'mobOBContent', false), 4000)
}

async function _mobFetchOB(coin, containerId, mini) {
  try {
    const book = await infoClient.l2Book({ coin })
    const bids = book.levels?.[0] ?? []
    const asks = book.levels?.[1] ?? []
    const el   = document.getElementById(containerId)
    if (!el) return

    const bestBid   = parseFloat(bids[0]?.px ?? 0)
    const bestAsk   = parseFloat(asks[0]?.px ?? 0)
    const spread    = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0
    const spreadPct = bestBid > 0 ? (spread / bestBid * 100).toFixed(3) : '0'
    const mid       = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : 0

    const rows   = mini ? 8 : 14
    const askSlice = asks.slice(0, rows)
    const bidSlice = bids.slice(0, rows)
    const askRows  = [...askSlice].reverse()

    let cumA = 0; const askCums = askSlice.map(a => { cumA += parseFloat(a.sz)*parseFloat(a.px); return cumA }).reverse()
    let cumB = 0; const bidCums = bidSlice.map(b => { cumB += parseFloat(b.sz)*parseFloat(b.px); return cumB })
    const maxCum = Math.max(cumA, cumB) || 1

    if (mini) {
      el.innerHTML = `
        ${askRows.map((a, i) => {
          const px = parseFloat(a.px); const cum = askCums[i]; const pct = Math.round(cum/maxCum*100)
          return `<div style="display:flex;justify-content:space-between;padding:2px 6px;position:relative;cursor:pointer" onclick="window._mobOBFillLimit(${px})">
            <div style="position:absolute;right:0;top:0;bottom:0;background:rgba(255,77,109,0.08);width:${pct}%"></div>
            <span style="color:var(--red);position:relative">${fmtPrice(px)}</span>
            <span style="color:var(--muted);position:relative">${_fmtK(cum)}</span>
          </div>`
        }).join('')}
        <div style="display:flex;justify-content:space-between;padding:3px 6px;background:var(--panel-2);border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
          <span style="color:var(--muted);font-size:9px">Spread ${spread > 0 ? spread.toFixed(2) : '—'}</span>
          <span style="color:var(--muted);font-size:9px">${spreadPct}%</span>
        </div>
        ${bidSlice.map((b, i) => {
          const px = parseFloat(b.px); const cum = bidCums[i]; const pct = Math.round(cum/maxCum*100)
          return `<div style="display:flex;justify-content:space-between;padding:2px 6px;position:relative;cursor:pointer" onclick="window._mobOBFillLimit(${px})">
            <div style="position:absolute;right:0;top:0;bottom:0;background:rgba(0,229,160,0.08);width:${pct}%"></div>
            <span style="color:var(--green);position:relative">${fmtPrice(px)}</span>
            <span style="color:var(--muted);position:relative">${_fmtK(cum)}</span>
          </div>`
        }).join('')}`
    } else {
      el.innerHTML = `
        <div style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end">
          ${askRows.map((a, i) => {
            const px = parseFloat(a.px); const sz = parseFloat(a.sz); const cum = askCums[i]; const pct = Math.round(cum/maxCum*100)
            return `<div style="display:flex;justify-content:space-between;padding:2px 10px;position:relative;font-size:11px;font-family:'JetBrains Mono',monospace;flex-shrink:0">
              <div style="position:absolute;right:0;top:0;bottom:0;background:rgba(255,77,109,0.07);width:${pct}%"></div>
              <span style="color:var(--red);position:relative">${fmtPrice(px)}</span>
              <span style="color:var(--muted);position:relative">${fmtSize(sz)}</span>
              <span style="color:var(--muted);position:relative">${_fmtK(cum)}</span>
            </div>`
          }).join('')}
        </div>
        <div style="flex-shrink:0;padding:5px 10px;border-top:1px solid var(--border);border-bottom:1px solid var(--border);background:var(--panel-2);display:flex;justify-content:space-between">
          <span style="font-size:12px;font-weight:600;font-family:'JetBrains Mono',monospace">${mid > 0 ? fmtPrice(mid) : '—'}</span>
          <span style="font-size:10px;color:var(--muted)">Spread ${spread > 0 ? fmtPrice(spread) : '—'} · ${spreadPct}%</span>
        </div>
        <div style="flex:1;min-height:0;overflow:hidden;display:flex;flex-direction:column">
          ${bidSlice.map((b, i) => {
            const px = parseFloat(b.px); const sz = parseFloat(b.sz); const cum = bidCums[i]; const pct = Math.round(cum/maxCum*100)
            return `<div style="display:flex;justify-content:space-between;padding:2px 10px;position:relative;font-size:11px;font-family:'JetBrains Mono',monospace;flex-shrink:0">
              <div style="position:absolute;right:0;top:0;bottom:0;background:rgba(0,229,160,0.07);width:${pct}%"></div>
              <span style="color:var(--green);position:relative">${fmtPrice(px)}</span>
              <span style="color:var(--muted);position:relative">${fmtSize(sz)}</span>
              <span style="color:var(--muted);position:relative">${_fmtK(cum)}</span>
            </div>`
          }).join('')}
        </div>`
    }
  } catch {
    const el = document.getElementById(containerId)
    if (el) el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--muted);font-size:12px">Order book unavailable</div>`
  }
}

window._mobOBFillLimit = function(px) {
  const input = document.getElementById('mobTradeLimitInput')
  if (input && input.type !== 'hidden') input.value = px
}

function _mobRenderDetailHistory(el, coin) {
  const fills = (state.fills ?? []).filter(f => f.coin === coin).slice(0, 100)
  // Make el itself the scroll container
  el.style.overflowY  = 'auto'
  el.style.overflowX  = 'hidden'
  el.style.display    = 'block'
  el.style.paddingBottom = '80px'
  el.style.webkitOverflowScrolling = 'touch'
  if (!fills.length) {
    el.innerHTML = `<div style="padding:40px;text-align:center;color:var(--muted)">No trade history for ${esc(coin)}</div>`
    return
  }
  el.innerHTML = `${fills.map((f, i) => {
      const isBuy  = f.side === 'BUY'
      const pnl    = f.closedPnl ?? 0
      const pnlClr = pnl > 0 ? 'var(--green)' : pnl < 0 ? 'var(--red)' : 'var(--muted)'
      const id     = `mhist-${i}`
      const xp     = _mobVExpandedIds.has(id)
      return `<div>
        <div class="mob-v-row" style="cursor:pointer" onclick="window._mobVToggleRow('${id}')">
          <div class="mob-v-row-info">
            <div class="mob-v-row-name"><span style="color:${isBuy?'var(--green)':'var(--red)'};font-weight:600">${f.side}</span> <span style="color:var(--muted);font-size:11px">${f.timeStr}</span></div>
            <div class="mob-v-row-sub">${fmtSize(f.sz)} @ $${fmtPrice(f.px)}</div>
          </div>
          <div class="mob-v-row-right">
            <div class="mob-v-row-val">$${fmtUSD(parseFloat(f.sz)*parseFloat(f.px))}</div>
            <div style="font-size:11px;color:${pnlClr}">${pnl!==0?(pnl>=0?'+':'')+`$${fmtUSD(Math.abs(pnl))}`:'—'}</div>
          </div>
          <svg id="mrc-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp?';transform:rotate(90deg)':''}"><polyline points="9 6 15 12 9 18"/></svg>
        </div>
        <div id="mrd-${id}" style="display:${xp?'':'none'}">${_mobVDetailGrid([
          ['Direction', f.dir ?? '—'],
          ['Size', fmtSize(f.sz)+' '+esc(coin)],
          ['Price', '$'+fmtPrice(f.px)],
          ['Value', '$'+fmtUSD(parseFloat(f.sz)*parseFloat(f.px))],
          ['Closed PnL', pnl!==0?(pnl>=0?'+':'')+`$${fmtUSD(Math.abs(pnl))}`:'—', pnl>0?'var(--green)':pnl<0?'var(--red)':''],
        ])}</div>
      </div>`
    }).join('')}`
}

// Input value for a given % of available margin — respects the USDC/token unit.
function _mobTradeAmtForPct(pct) {
  const marginAmt = _tradeAvail().avail * pct / 100
  if (_mobTradeAmtUnit !== 'coin') return marginAmt > 0 ? marginAmt.toFixed(2) : ''
  const coin = state.selectedCoin, mktPx = parseFloat(state.allMids?.[coin] ?? 0), lev = state.leverage ?? 5
  const sz = mktPx > 0 ? (marginAmt * lev) / mktPx : 0
  return sz > 0 ? sz.toFixed(4) : ''
}
window._mobTradeSetPct = function(pct) {
  const input  = document.getElementById('mobTradeAmtInput')
  const slider = document.getElementById('mobTradeAmtSlider')
  if (input)  input.value  = _mobTradeAmtForPct(pct)
  if (slider) slider.value = pct
  _mobTradeUpdateConvHint()
}
window._mobTradeSliderAmt = function(val) {
  const input = document.getElementById('mobTradeAmtInput')
  if (input) input.value = _mobTradeAmtForPct(parseInt(val))
  _mobTradeUpdateConvHint()
}
window._mobTradeUpdateSlider = function() {
  const input  = document.getElementById('mobTradeAmtInput')
  const slider = document.getElementById('mobTradeAmtSlider')
  if (!input || !slider) return
  const val   = parseFloat(input.value) || 0
  const avail = _tradeAvail().avail
  // Convert the entered amount to a margin-equivalent for the slider position
  let marginEquiv = val
  if (_mobTradeAmtUnit === 'coin') {
    const coin = state.selectedCoin, mktPx = parseFloat(state.allMids?.[coin] ?? 0), lev = state.leverage ?? 5
    marginEquiv = (mktPx > 0 && lev > 0) ? (val * mktPx) / lev : 0
  }
  slider.value = avail > 0 ? Math.min(100, marginEquiv / avail * 100) : 0
  _mobTradeUpdateConvHint()
}
// Toggle the amount unit between USDC margin and token size, converting the value.
window._mobTradeToggleUnit = function() {
  const input = document.getElementById('mobTradeAmtInput')
  const coin  = state.selectedCoin
  const mktPx = parseFloat(state.allMids?.[coin] ?? 0)
  const lev   = state.leverage ?? 5
  const cur   = parseFloat(input?.value) || 0
  if (input && cur > 0 && mktPx > 0 && lev > 0) {
    input.value = _mobTradeAmtUnit === 'usd' ? ((cur * lev) / mktPx).toFixed(4) : ((cur * mktPx) / lev).toFixed(2)
  }
  _mobTradeAmtUnit = _mobTradeAmtUnit === 'usd' ? 'coin' : 'usd'
  const display = _spotNameMap[coin] ?? _mktDisplay(coin) ?? String(coin).replace(/.*:/, '')
  const prefix  = document.getElementById('mobTradeAmtPrefix')
  const label   = document.getElementById('mobTradeUnitLabel')
  if (prefix) prefix.textContent = _mobTradeAmtUnit === 'usd' ? '$' : ''
  if (label)  label.textContent  = _mobTradeAmtUnit === 'usd' ? 'USDC' : display
  _mobTradeUpdateSlider()
}
// Live equivalence line under the Amount label (size ↔ margin ↔ notional).
function _mobTradeUpdateConvHint() {
  const hint = document.getElementById('mobTradeConvHint'); if (!hint) return
  const coin  = state.selectedCoin
  const mktPx = parseFloat(state.allMids?.[coin] ?? 0)
  const lev   = state.leverage ?? 5
  const display = _spotNameMap[coin] ?? _mktDisplay(coin) ?? String(coin).replace(/.*:/, '')
  const v = parseFloat(document.getElementById('mobTradeAmtInput')?.value) || 0
  if (!(v > 0) || !(mktPx > 0)) { hint.textContent = ''; return }
  if (_mobTradeAmtUnit === 'usd') {
    const notional = v * lev, sz = notional / mktPx
    hint.textContent = `≈ ${fmtSize(sz)} ${display} · $${fmtUSD(notional)} size`
  } else {
    const notional = v * mktPx, margin = notional / lev
    hint.textContent = `≈ $${fmtUSD(margin)} margin · $${fmtUSD(notional)} size`
  }
  _mobUpdateOrderSummary()
}

// Pure estimate of an order's cost + resulting position (size/avg-entry/liq/margin).
// Shared math with the desktop position preview — kept DOM-free so any view can use it.
function _orderEstimate({ coin, side, coinSz, price, leverage, orderType }) {
  const sizeUSD = coinSz * price
  const margin  = leverage > 0 ? sizeUSD / leverage : 0
  const feeRate = orderType === 'limit' ? 0.0002 : 0.00045
  const fee     = sizeUSD * feeRate
  const funding = _mktCtxMap[coin]?.funding ?? null

  const pos      = (state.perpState?.assetPositions ?? []).find(p => p.position.coin === coin)?.position
  const curSzi   = parseFloat(pos?.szi ?? 0)
  const curEntry = parseFloat(pos?.entryPx ?? 0)
  const curMargin= parseFloat(pos?.marginUsed ?? 0)
  const curHlLiq = parseFloat(pos?.liquidationPx ?? 0)
  const orderSzi = side === 'long' ? coinSz : -coinSz
  const newSzi   = curSzi + orderSzi

  let newEntry
  if (newSzi === 0) newEntry = 0
  else if (curSzi === 0 || curEntry === 0) newEntry = price
  else if (Math.sign(curSzi) === Math.sign(orderSzi))
    newEntry = (Math.abs(curSzi) * curEntry + Math.abs(orderSzi) * price) / (Math.abs(curSzi) + Math.abs(orderSzi))
  else newEntry = Math.abs(orderSzi) <= Math.abs(curSzi) ? curEntry : price

  const newMargin = curMargin + margin
  const mmr = 0.005
  const absCur = Math.abs(curSzi), absNew = Math.abs(newSzi)
  let newLiqPx = 0
  if (newSzi === 0) newLiqPx = 0
  else if (absCur > 0 && curHlLiq > 0 && Math.sign(curSzi) === Math.sign(newSzi)) {
    newLiqPx = newSzi > 0
      ? (price * coinSz + curHlLiq * absCur * (1 - mmr)) / (absNew * (1 - mmr))
      : (price * coinSz + curHlLiq * absCur * (1 + mmr)) / (absNew * (1 + mmr))
    if (newLiqPx < 0) newLiqPx = 0
  } else if (absCur === 0 || curHlLiq === 0) {
    // Fresh position: cross is backed by full account equity, isolated only by the
    // margin posted for this position (notional / leverage) → liq sits closer to entry.
    const notional = absNew * newEntry
    const backing  = state.isIsolated
      ? margin
      : parseFloat(state.perpState?.marginSummary?.accountValue ?? 0)
    if (backing > 0 && notional > 0) {
      newLiqPx = newSzi > 0 ? (notional - backing) / (absNew * (1 - mmr)) : (notional + backing) / (absNew * (1 + mmr))
      if (newLiqPx < 0) newLiqPx = 0
    }
  } else newLiqPx = curHlLiq

  const newSide = newSzi > 0 ? 'LONG' : newSzi < 0 ? 'SHORT' : 'CLOSED'
  return { sizeUSD, margin, fee, funding, newSzi, newSide, newEntry, newLiqPx, newMargin }
}

function _mobUpdateOrderSummary() {
  if (!document.getElementById('mobSumPrice')) return
  const coin  = state.selectedCoin || 'BTC'
  const display = _spotNameMap[coin] ?? _mktDisplay(coin) ?? String(coin).replace(/.*:/, '')
  const mktPx = parseFloat(state.allMids?.[coin] ?? 0)
  const limitPx = parseFloat(document.getElementById('mobTradeLimitInput')?.value) || 0
  const price = state.orderType === 'limit' && limitPx > 0 ? limitPx : mktPx
  const lev   = state.leverage ?? 5
  const v     = parseFloat(document.getElementById('mobTradeAmtInput')?.value) || 0
  // Resolve coin size from the entered amount (USDC-margin or coin unit)
  const coinSz = _mobTradeAmtUnit === 'coin' ? v : (price > 0 ? (v * lev) / price : 0)
  const side  = state.tradeSide === 'short' ? 'short' : 'long'

  const set = (id, txt) => { const e = document.getElementById(id); if (e) e.textContent = txt }
  set('mobSumPrice',   price > 0 ? '$' + fmtPrice(price) : '—')
  set('mobSumLev',     lev + 'x')

  if (!(coinSz > 0) || !(price > 0)) {
    set('mobSumSizeUsd', '—'); set('mobSumSizeCoin', '—'); set('mobSumFee', '—'); set('mobSumMargin', '—')
    const ff = document.getElementById('mobSumFund'); if (ff) ff.innerHTML = '—'
    const pp = document.getElementById('mobPosPreview'); if (pp) pp.style.display = 'none'
    return
  }

  const est = _orderEstimate({ coin, side, coinSz, price, leverage: lev, orderType: state.orderType })
  set('mobSumSizeUsd',  '$' + fmtUSD(est.sizeUSD))
  set('mobSumSizeCoin', fmtSize(coinSz) + ' ' + display)
  set('mobSumFee',      '-$' + fmtUSD(est.fee))
  set('mobSumMargin',   '$' + fmtUSD(est.margin))
  const fundEl = document.getElementById('mobSumFund')
  if (fundEl) {
    if (est.funding !== null) {
      const s = est.funding >= 0 ? '+' : ''
      fundEl.innerHTML = `<span style="color:${est.funding >= 0 ? 'var(--green)' : 'var(--red)'}">${s}${est.funding.toFixed(4)}%</span>`
    } else fundEl.textContent = '—'
  }

  const pp = document.getElementById('mobPosPreview')
  if (pp) {
    pp.style.display = 'flex'
    const sizeEl = document.getElementById('mobPpSize')
    if (sizeEl) {
      if (est.newSzi === 0) { sizeEl.textContent = 'CLOSED'; sizeEl.style.color = 'var(--muted)' }
      else { sizeEl.textContent = fmtSize(Math.abs(est.newSzi)) + ' ' + display + ' (' + est.newSide + ')'; sizeEl.style.color = est.newSzi > 0 ? 'var(--green)' : 'var(--red)' }
    }
    set('mobPpEntry',  est.newEntry > 0 ? '$' + fmtPrice(est.newEntry) : '—')
    set('mobPpLiq',    est.newLiqPx > 0 ? '$' + fmtPrice(est.newLiqPx) : '—')
    set('mobPpMargin', '$' + fmtUSD(est.newMargin))
  }
}
window._mobUpdateOrderSummary = _mobUpdateOrderSummary
window._mobToggleTpSl = function(checked) {
  const inputs = document.getElementById('mobTpSlInputs')
  if (inputs) inputs.style.display = checked ? 'flex' : 'none'
}
window._mobTradeTpChange = function(val) { _mobVTradeTp = val.trim() }
window._mobTradeSlChange = function(val) { _mobVTradeSl = val.trim() }

window._mobTradeLevPicker = function() {
  const coin   = state.selectedCoin || 'BTC'
  const maxLev = state.assetMap?.[coin]?.maxLeverage ?? 50
  const curLev = state.leverage ?? 5
  const presets = [1,2,3,5,10,20,50].filter(v => v <= maxLev)
  const existing = document.getElementById('mobLevModal')
  if (existing) existing.remove()
  const overlay = document.createElement('div')
  overlay.id = 'mobLevModal'
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10003;display:flex;align-items:flex-end;justify-content:center'
  overlay.innerHTML = `
    <div style="background:var(--panel);border-radius:20px 20px 0 0;padding:20px 20px 32px;width:100%;max-width:480px;display:flex;flex-direction:column;gap:16px">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:15px;font-weight:700">Leverage</span>
        <span id="mobLevDisplay" style="font-size:26px;font-weight:800;color:var(--accent)">${curLev}x</span>
      </div>
      <input id="mobLevSlider" type="range" min="1" max="${maxLev}" value="${curLev}" step="1"
        style="width:100%;accent-color:var(--accent);height:4px"
        oninput="document.getElementById('mobLevDisplay').textContent=this.value+'x'">
      <div style="display:flex;gap:6px">
        ${presets.map(v => `<button onclick="document.getElementById('mobLevSlider').value=${v};document.getElementById('mobLevDisplay').textContent='${v}x'"
          style="flex:1;padding:7px 2px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:11px;font-weight:600;cursor:pointer">${v}x</button>`).join('')}
      </div>
      <div style="display:flex;gap:10px;margin-top:4px">
        <button onclick="document.getElementById('mobLevModal').remove()"
          style="flex:1;padding:13px;border-radius:12px;border:1px solid var(--border);background:transparent;color:var(--muted);font-size:14px;font-weight:600;cursor:pointer">Cancel</button>
        <button onclick="window._mobLevConfirm()"
          style="flex:1;padding:13px;border-radius:12px;border:none;background:var(--accent);color:#000;font-size:14px;font-weight:700;cursor:pointer">Confirm</button>
      </div>
    </div>`
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove() })
  document.body.appendChild(overlay)
}

window._mobLevConfirm = function() {
  const slider  = document.getElementById('mobLevSlider')
  const modal   = document.getElementById('mobLevModal')
  if (!slider) return
  const coin    = state.selectedCoin || 'BTC'
  const maxLev  = state.assetMap?.[coin]?.maxLeverage ?? 50
  state.leverage = Math.max(1, Math.min(maxLev, parseInt(slider.value)))
  try { localStorage.setItem('hliq_leverage', String(state.leverage)) } catch {}
  const btn = document.getElementById('mobTradeLevBtn')
  if (btn) btn.textContent = state.leverage + '× Leverage'
  // Leverage affects size↔margin conversion — refresh the slider position and hint
  _mobTradeUpdateSlider()
  if (modal) modal.remove()
}

window._mobTradeSubmitNew = async function() {
  const statusEl = document.getElementById('mobTradeStatus')
  const btnEl    = document.getElementById('mobTradeSubmitBtn')
  if (!isConnected()) { window.__quickConnectAgent(); return }
  const coin      = state.selectedCoin
  const isBuy     = state.tradeSide !== 'short'
  const mktPx     = parseFloat(state.allMids?.[coin] ?? 0)
  const inputVal  = parseFloat(document.getElementById('mobTradeAmtInput')?.value ?? 0)
  const lev       = state.leverage ?? 5
  // Amount can be entered as USDC margin or as token size — resolve to coin size
  const coinSz    = _mobTradeAmtUnit === 'coin' ? inputVal : (mktPx > 0 ? (inputVal * lev) / mktPx : 0)
  const limitPx   = parseFloat(document.getElementById('mobTradeLimitInput')?.value ?? 0) || 0
  const tpPx      = parseFloat(document.getElementById('mobTradeTpInput')?.value ?? 0) || 0
  const slPx      = parseFloat(document.getElementById('mobTradeSlInput')?.value ?? 0) || 0
  const reduceOnly = document.getElementById('mobTradeROCheck')?.checked ?? false

  if (!inputVal || inputVal <= 0) { if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">Enter an amount</span>'; return }
  if (mktPx <= 0) { if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">No price for ${esc(coin)}</span>`; return }
  if (state.orderType === 'limit' && (!limitPx || limitPx <= 0)) { if (statusEl) statusEl.innerHTML = '<span style="color:var(--red)">Enter limit price</span>'; return }

  if (btnEl) btnEl.disabled = true
  if (statusEl) statusEl.innerHTML = '<span style="color:var(--muted)">Signing…</span>'
  try {
    let result
    if (state.orderType === 'market') {
      result = await placeMarketOrder({ coin, isBuy, sz: coinSz, markPrice: mktPx, leverage: lev, isIsolated: state.isIsolated, reduceOnly })
    } else {
      result = await placeLimitOrder({ coin, isBuy, sz: coinSz, limitPx, leverage: lev, isIsolated: state.isIsolated, reduceOnly })
    }
    const parsed = parseOrderResult(result)
    if (!parsed.ok) { if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">✗ ${esc(parsed.errors.join(', '))}</span>`; if (btnEl) btnEl.disabled = false; return }
    let msg = '✓ Order placed!'
    if (parsed.filled?.length > 0) {
      const f = parsed.filled[0]
      msg = `✓ ${fmtSize(f.totalSz ?? coinSz)} ${esc(coin)} @ $${fmtPrice(f.avgPx ?? mktPx)}`
    }
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--green)">${esc(msg)}</span>`
    if (tpPx > 0) { try { await placeTriggerOrder({ coin, isBuy: !isBuy, sz: coinSz, triggerPx: tpPx, tpsl: 'tp' }) } catch {} }
    if (slPx > 0) { try { await placeTriggerOrder({ coin, isBuy: !isBuy, sz: coinSz, triggerPx: slPx, tpsl: 'sl' }) } catch {} }
    const amtInput = document.getElementById('mobTradeAmtInput')
    if (amtInput) amtInput.value = ''
    setTimeout(refreshLive, 1500)
  } catch (e) {
    if (statusEl) statusEl.innerHTML = `<span style="color:var(--red)">✗ ${esc(e.message)}</span>`
  }
  if (btnEl) btnEl.disabled = false
}

window.mobCalNav = function(dir) {
  const now = new Date()
  if (state.calMonth == null) state.calMonth = now.getMonth()
  if (state.calYear  == null) state.calYear  = now.getFullYear()
  state.calMonth += dir
  if (state.calMonth > 11) { state.calMonth = 0;  state.calYear++ }
  if (state.calMonth < 0)  { state.calMonth = 11; state.calYear-- }
  const detail = document.getElementById('mobCalDetail')
  if (detail) { detail.innerHTML = ''; detail.dataset.activeKey = '' }
  renderPnLCalendar(state.fills ?? [], state.calMonth, state.calYear, state.ledger ?? [], 'mobCalRoot', 'mobCalNav', 'mobCalDetail')
}

window._mobVConnectAgentKey = async function() {
  const input    = document.getElementById('mobVAgentKeyInput')
  const statusEl = document.getElementById('mobVAgentKeyStatus')
  if (!input || !statusEl) return
  const keyVal = input.value.trim()
  if (!keyVal || !keyVal.startsWith('0x') || keyVal.length < 66) {
    statusEl.textContent = 'Invalid key (must be 0x + 64 hex chars)'
    statusEl.style.color = 'var(--red)'
    return
  }
  statusEl.textContent = 'Connecting…'
  statusEl.style.color = 'var(--muted)'
  try {
    const addr = await connectAgentKey(keyVal)
    if (state.addr) localStorage.setItem(_agentKeyForAddr(state.addr), keyVal)
    else localStorage.setItem('hliq_agent_key', keyVal)
    const agentInputDesktop = document.getElementById('agentKey')
    if (agentInputDesktop) agentInputDesktop.value = keyVal
    statusEl.innerHTML = `Connected: ${addr.slice(0, 6)}…${addr.slice(-4)}`
    statusEl.style.color = 'var(--green)'
    applyReferrer().catch(() => {})
    updateSubmitBtn()
  } catch {
    statusEl.textContent = 'Failed — check key and try again'
    statusEl.style.color = 'var(--red)'
  }
}

window._mobVDisconnectWallet = function() {
  disconnectMainWalletUI()
  _mobVRenderContent()
}

window._mobVSetPin = function() {
  const input = document.getElementById('mobVPinInput')
  const val = input?.value?.replace(/\D/g, '')  // strip any non-digits
  if (!val || val.length !== 4) {
    if (input) {
      input.style.borderColor = 'var(--neg, #ff4d6d)'
      input.placeholder = 'Enter exactly 4 digits'
      input.value = ''
      setTimeout(() => { input.style.borderColor = ''; input.placeholder = '4-digit PIN' }, 2500)
    }
    navigator.vibrate?.([60, 40, 60])
    return
  }
  localStorage.setItem(PIN_KEY, _hashPin(val))
  localStorage.setItem(PIN_ON_KEY, 'true')
  navigator.vibrate?.(100)
  _mobVRenderContent()
}

const _BIO_KEY = 'hliq_biometric_cred'

window._mobVEnableBiometric = async function() {
  if (!window.PublicKeyCredential) return
  try {
    const challenge = new Uint8Array(32)
    crypto.getRandomValues(challenge)
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'Insolvent Terminal', id: location.hostname },
        user: { id: new Uint8Array(16), name: 'trader', displayName: 'Trader' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
        timeout: 60000
      }
    })
    const id = btoa(String.fromCharCode(...new Uint8Array(cred.rawId)))
    localStorage.setItem(_BIO_KEY, id)
    navigator.vibrate?.(80)
    _mobVRenderContent()
  } catch(e) { console.warn('Biometric setup failed', e) }
}

window._mobVAuthBiometric = async function(isAuto = false) {
  const idStr = localStorage.getItem(_BIO_KEY)
  if (!idStr) return
  if (window.__bioInFlight) return
  window.__bioInFlight = true
  try {
    const credId = Uint8Array.from(atob(idStr), c => c.charCodeAt(0))
    const challenge = new Uint8Array(32)
    crypto.getRandomValues(challenge)
    await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: [{ type: 'public-key', id: credId }],
        userVerification: 'required',
        timeout: 60000
      }
    })
    navigator.vibrate?.(80)
    document.getElementById('pinLockScreen').style.display = 'none'
    _pinBuffer = ''
    _updatePinDots?.()
  } catch(e) {
    // iOS blocks gesture-less WebAuthn (or shows a consent sheet) — an auto
    // attempt failing is NOT a real Face ID failure, so don't count it; the
    // tap-anywhere handler retries with a user gesture (direct scan, no sheet).
    if (!isAuto) {
      window.__bioFailCount = (window.__bioFailCount || 0) + 1
      const errEl = document.getElementById('pinError')
      if (window.__bioFailCount >= 2) {
        // Repeated Face ID failures — fall back to the PIN pad
        window.__pinShowPad?.()
        if (errEl) { errEl.textContent = 'Face ID failed — enter your PIN'; setTimeout(() => errEl.textContent = '', 3000) }
      } else {
        if (errEl) { errEl.textContent = 'Face ID failed — tap to retry'; setTimeout(() => errEl.textContent = '', 2500) }
      }
    }
  } finally {
    window.__bioInFlight = false
  }
}

window._mobVAddPriceAlert = function() {
  const coin  = document.getElementById('mobVPaCoIn')?.value?.trim().toUpperCase()
  const dir   = document.getElementById('mobVPaDir')?.value || 'above'
  const price = parseFloat(document.getElementById('mobVPaPrice')?.value)
  if (!coin || isNaN(price) || price <= 0) return
  const alerts = _paLoad()
  alerts.push({ id: Date.now().toString(36), coin, dir, price, fired: false })
  _paSave(alerts)
  _mobVRenderContent()
}

window._mobVApplyThresholds = function() {
  const drawdown = parseFloat(document.getElementById('mobVRiskDd')?.value)
  const streak   = parseInt(document.getElementById('mobVRiskSt')?.value)
  const liq      = parseFloat(document.getElementById('mobVRiskLq')?.value)
  setThresholds({
    maxDrawdownPct: isNaN(drawdown) ? undefined : drawdown,
    maxLossStreak:  isNaN(streak)   ? undefined : streak,
    liqWarningPct:  isNaN(liq)      ? undefined : liq,
  })
  localStorage.setItem('hliq_risk_thresholds', JSON.stringify(getRiskState().thresholds))
}

window.mobVTab = function(name) {
  _mobVActiveTab = name
  document.querySelectorAll('.mob-v-tab').forEach(b => b.classList.remove('active'))
  const btn = document.getElementById('mobVTab-' + name)
  if (btn) btn.classList.add('active')
  // Top-strip tabs live under Home — clear other bottom-nav highlights (e.g. History)
  document.querySelectorAll('.mob-v-bottom-btn').forEach(b => b.classList.remove('active'))
  document.getElementById('mobVBotHome')?.classList.add('active')
  _mobVRenderContent()
  _mobVAnimateTo(name)
}

window.mobVHome = function() {
  _mobVActiveTab = 'positions'
  document.querySelectorAll('.mob-v-bottom-btn').forEach(b => b.classList.remove('active'))
  document.getElementById('mobVBotHome')?.classList.add('active')
  document.querySelectorAll('.mob-v-tab').forEach(b => b.classList.remove('active'))
  document.getElementById('mobVTab-positions')?.classList.add('active')
  mobVShow()
  _mobVRenderContent()
  _mobVAnimateTo('positions')
}

window._mobVTradesPageChange = function(d) {
  _mobVTradesPage += d
  _mobVRenderContent()   // keep scroll position — don't jump back up to the header
}

window.mobVGoTab = function(tabName) {
  if (tabName === 'trades') _mobVTradesPage = 0   // start History at the latest page
  document.querySelectorAll('.mob-v-bottom-btn').forEach(b => b.classList.remove('active'))
  const _mobTabs = new Set(['trades', 'leaderboard', 'accounts', 'portfolio', 'calendar', 'tokens', 'watch', 'strategies', 'performance', 'transfers', 'settings', 'trade', 'news'])
  if (_mobTabs.has(tabName)) {
    _mobVActiveTab = tabName
    document.querySelectorAll('.mob-v-tab').forEach(b => b.classList.remove('active'))
    // Highlight the matching bottom-nav icon (like Home) so the active tab shows.
    const _botBtn = { trades: 'mobVBotHistory' }[tabName]
    if (_botBtn) document.getElementById(_botBtn)?.classList.add('active')
    _mobVRenderContent()
    _mobVAnimateTo(tabName)
    return
  }
  mobVHide()
  switchTab(tabName, null)
}

window.mobVOpenMore = function() {
  const d = document.getElementById('mobMoreDrawer')
  const b = document.getElementById('mobMoreBackdrop')
  const willOpen = !d?.classList.contains('open')
  d?.classList.toggle('open', willOpen)
  b?.classList.toggle('open', willOpen)
}

// Open the prediction-markets sheet from the More drawer. The drag handle is a
// touch gesture that barely works with a mouse (forced-mobile on desktop) and
// is easy to miss on phones — this is the discoverable entry point.
window.__mobMorePredictions = function() {
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
  window.__openPredictions()
}

function _mobDefiModal(type) {
  document.getElementById('mobDefiModal')?.remove()

  const isDeposit = type === 'deposit'
  const ppActive  = _depositDest === 'perps'

  const row = (lbl, id, extra='') =>
    `<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:3px 0">
       <span style="color:var(--muted)">${lbl}</span><span id="${id}" ${extra}>—</span></div>`

  const depositForm = `
    <div style="display:flex;justify-content:space-between;align-items:center;background:var(--panel-1);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <span style="font-size:12px;color:var(--muted)">Arbitrum USDC Balance</span>
      <span style="font-size:14px;font-weight:600" id="depositUsdcBal">Loading…</span>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Destination</div>
      <div style="display:flex;gap:8px">
        <button id="depDest-perps" onclick="window.__mobDepDest('perps')"
          style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--border);background:${ppActive?'var(--accent)':'var(--panel-1)'};color:${ppActive?'#000':'var(--fg)'};font-size:13px;font-weight:600;cursor:pointer">Perps</button>
        <button id="depDest-spot" onclick="window.__mobDepDest('spot')"
          style="flex:1;padding:10px;border-radius:8px;border:1px solid var(--border);background:${!ppActive?'var(--accent)':'var(--panel-1)'};color:${!ppActive?'#000':'var(--fg)'};font-size:13px;font-weight:600;cursor:pointer">Spot</button>
      </div>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Amount (USDC)</div>
      <div style="display:flex;gap:8px">
        <input id="depositAmount" type="number" min="0" step="any" placeholder="0.00" oninput="window.__updateDepositPreview()"
          style="flex:1;background:var(--panel-1);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--fg);outline:none"/>
        <button onclick="window.__setDepositMax()" style="padding:10px 14px;background:var(--panel-1);border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0">MAX</button>
      </div>
    </div>
    <div id="depositPreview" style="opacity:0.4;background:var(--panel-1);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      ${row('You send','dp-send')}${row('You receive','dp-receive')}${row('Destination','dp-dest')}
    </div>
    <div id="depositWarning" style="display:none;font-size:12px;color:var(--red);background:rgba(255,77,109,.08);border-radius:8px;padding:10px 12px;margin-bottom:10px"></div>
    <div id="depositStatus" style="font-size:13px;min-height:16px;margin-bottom:10px"></div>
    <button id="depositBtn" disabled style="width:100%;padding:14px;border-radius:10px;border:none;background:var(--accent);color:#000;font-size:15px;font-weight:700;cursor:pointer">Enter amount</button>`

  const withdrawForm = `
    <div style="display:flex;justify-content:space-between;align-items:center;background:var(--panel-1);border-radius:10px;padding:12px 14px;margin-bottom:16px">
      <span style="font-size:12px;color:var(--muted)">Available to Withdraw</span>
      <span style="font-size:14px;font-weight:600">$${_withdrawAvailable.toFixed(2)}</span>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px">Amount (USDC)</div>
      <div style="display:flex;gap:8px">
        <input id="withdrawAmount" type="number" min="0" step="any" placeholder="0.00" oninput="window.__updateWithdrawPreview()"
          style="flex:1;background:var(--panel-1);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:15px;color:var(--fg);outline:none"/>
        <button onclick="window.__setWithdrawMax()" style="padding:10px 14px;background:var(--panel-1);border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:12px;font-weight:600;cursor:pointer;flex-shrink:0">MAX</button>
      </div>
    </div>
    <div style="margin-bottom:14px">
      <div style="font-size:11px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">Destination Address</div>
      <input id="withdrawDest" type="text" placeholder="0x…" oninput="window.__updateWithdrawPreview()"
        style="width:100%;box-sizing:border-box;background:var(--panel-1);border:1px solid var(--border);border-radius:8px;padding:10px 12px;font-size:13px;color:var(--fg);outline:none;font-family:monospace"/>
      <button onclick="window.__useConnectedAddress()" style="margin-top:6px;background:none;border:none;color:var(--accent);font-size:12px;cursor:pointer;padding:0">Use my connected address →</button>
    </div>
    <div id="withdrawPreview" style="opacity:0.4;background:var(--panel-1);border-radius:10px;padding:12px 14px;margin-bottom:10px">
      ${row('You withdraw','wp-amount')}${row('You receive','wp-receive')}${row('To','wp-dest','style="font-family:monospace;font-size:12px"')}${row('Fee','wp-fee')}
    </div>
    <div id="withdrawWarning" style="display:none;font-size:12px;color:var(--red);background:rgba(255,77,109,.08);border-radius:8px;padding:10px 12px;margin-bottom:10px"></div>
    <div id="withdrawStatus" style="font-size:13px;min-height:16px;margin-bottom:10px"></div>
    <button id="withdrawBtn" disabled style="width:100%;padding:14px;border-radius:10px;border:none;background:var(--accent);color:#000;font-size:15px;font-weight:700;cursor:pointer">Enter amount</button>`

  const walletConnected = isMainWalletConnected()
  const connectBanner = !walletConnected ? `
    <div id="mobWalletBanner" style="background:rgba(var(--accent-rgb,99,202,183),.08);border:1px solid rgba(var(--accent-rgb,99,202,183),.25);border-radius:10px;padding:14px 16px;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;gap:12px">
      <div>
        <div style="font-size:13px;font-weight:600;margin-bottom:2px">Wallet not connected</div>
        <div style="font-size:12px;color:var(--muted)">Connect to ${isDeposit ? 'deposit' : 'withdraw'} USDC</div>
      </div>
      <button onclick="window.__mobConnectWallet()" style="flex-shrink:0;padding:9px 16px;border-radius:8px;border:none;background:var(--accent);color:#000;font-size:13px;font-weight:700;cursor:pointer">Connect</button>
    </div>` : `<div id="mobWalletBanner" style="display:none"></div>`

  const wrap = document.createElement('div')
  wrap.id = 'mobDefiModal'
  wrap.innerHTML = `
    <div onclick="window._closeMobDefiModal()" style="position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:8999"></div>
    <div style="position:fixed;bottom:0;left:0;right:0;z-index:9000;background:var(--panel-2);border-radius:20px 20px 0 0;padding:0 0 env(safe-area-inset-bottom);max-height:90vh;overflow-y:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:18px 18px 14px;border-bottom:1px solid var(--border)">
        <span style="font-size:17px;font-weight:700">${isDeposit ? 'Deposit USDC' : 'Withdraw USDC'}</span>
        <button onclick="window._closeMobDefiModal()" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer;line-height:1;padding:0 4px">×</button>
      </div>
      <div style="padding:18px">${connectBanner}${isDeposit ? depositForm : withdrawForm}</div>
    </div>`
  document.body.appendChild(wrap)

  // Boost wallet picker z-index so it appears above this modal
  const picker = document.getElementById('walletPickerModal')
  if (picker) picker.style.zIndex = '9001'

  if (isDeposit) {
    refreshDefiBalances()
    window.__updateDepositPreview()
  } else {
    document.getElementById('wp-fee').textContent = '$1.00'
    window.__updateWithdrawPreview()
  }
}

window._closeMobDefiModal = function() {
  document.getElementById('mobDefiModal')?.remove()
  const picker = document.getElementById('walletPickerModal')
  if (picker) picker.style.zIndex = ''
}

window.__mobConnectWallet = function() {
  const picker = document.getElementById('walletPickerModal')
  if (picker) picker.style.zIndex = '9001'
  window.connectMainWalletUI()
}

window.__mobDepDest = function(dest) {
  _depositDest = dest
  const pp = _defiEl('depDest-perps')
  const ps = _defiEl('depDest-spot')
  if (pp) { pp.style.background = dest === 'perps' ? 'var(--accent)' : 'var(--panel-1)'; pp.style.color = dest === 'perps' ? '#000' : 'var(--fg)' }
  if (ps) { ps.style.background = dest === 'spot'  ? 'var(--accent)' : 'var(--panel-1)'; ps.style.color = dest === 'spot'  ? '#000' : 'var(--fg)' }
  window.__updateDepositPreview()
}

window.mobVDeposit  = function() { _mobDefiModal('deposit') }
window.mobVWithdraw = function() { _mobDefiModal('withdraw') }

// ─── GLOBAL EXPORTS ───────────────────────────────────────────────────────────
window.loadDashboard      = loadDashboard
window.resetDashboard     = resetDashboard
window.switchTab          = switchTab
window.filterTable        = filterTable
window.downloadJSON       = downloadJSON
window.downloadCSV        = downloadCSV
window.downloadTableCSV   = downloadTableCSV
window.connectAgentKeyUI  = connectAgentKeyUI
window.setSide            = setSide
window.setOrderType       = setOrderType
window.updateLevDisplay   = updateLevDisplay
window.setLev             = setLev
window.setMarginMode      = setMarginMode
window.setSizePct         = setSizePct
window.fillMarketPrice    = fillMarketPrice
window.updateOrderSummary = updateOrderSummary
window.submitOrder        = submitOrder
window.closeModals        = closeModals
window.setChartPeriod     = renderChartPeriod
window.setPnlChart        = (type, btn) => {
  document.querySelectorAll('[data-pnl]').forEach(b => b.classList.toggle('active', b.dataset.pnl === type))
  setPnlChartType(type)
}
window.toggleCoinDropdown  = window.toggleCoinDropdown

window.__calDayClick = calDayClick

window.calNav = function(dir) {
  // Mobile renders the calendar into its own container — keep nav on the same one
  const isMob   = typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'calendar' && !!document.getElementById('mobCalRoot')
  const detail  = document.getElementById(isMob ? 'mobCalDetail' : 'calDetail')
  if (detail) { detail.innerHTML = ''; detail.dataset.activeKey = '' }
  state.calMonth += dir
  if (state.calMonth > 11) { state.calMonth = 0;  state.calYear++ }
  if (state.calMonth < 0)  { state.calMonth = 11; state.calYear-- }
  if (isMob) renderPnLCalendar(state.fills ?? [], state.calMonth, state.calYear, state.ledger ?? [], 'mobCalRoot', 'mobCalNav', 'mobCalDetail')
  else       renderPnLCalendar(state.fills, state.calMonth, state.calYear, state.ledger)
}

window.filterTransfers = function(filter, btn) {
  state.transferFilter = filter
  document.querySelectorAll('#transferFilterTabs .order-type-tab')
    .forEach(b => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  renderTransfers(state.ledger, filter, state.addr)
}
window.filterCoinDropdown  = window.filterCoinDropdown
window.generateCommand    = generateCommand
window.copyCmd            = copyCmd
window.runStrategy        = runStrategy
window.stopStrategy       = stopStrategy
window.showStrategyLogs   = showStrategyLogs
window.hideStrategyLogs   = hideStrategyLogs
window.togglePastLogs     = togglePastLogs
window.loadPastLog        = loadPastLog
window.flipCard           = flipCard
window.toggleSizeMode     = toggleSizeMode
window.setSizeMode        = setSizeMode
window.updateRiskUI       = updateRiskUI
window.toggleDcaMode        = toggleDcaMode
window.toggleShorterTrigger = toggleShorterTrigger
window.syncShorterTpSl      = syncShorterTpSl
window.toggleLongerTrigger  = toggleLongerTrigger
window.syncLongerTpSl       = syncLongerTpSl

// ─── NEWS PAUSE ───────────────────────────────────────────────────────────────
let newsPauseEnabled = false
let newsPaused       = false
let riskMgmtEnabled  = false

window.__toggleNewsPause = function () {
  newsPauseEnabled = !newsPauseEnabled
  const btn = document.getElementById('btnNewsPause')
  if (btn) {
    btn.textContent = newsPauseEnabled ? 'Pause on News' : 'News Pause Off'
    btn.classList.toggle('active', newsPauseEnabled)
  }
  if (!newsPauseEnabled && newsPaused) {
    newsPaused = false
    updateNewsPauseUI(false)
  }
}

window.__checkNewsAlert = function (headline) {
  if (!newsPauseEnabled || !headline.trim()) {
    if (newsPaused) { newsPaused = false; updateNewsPauseUI(false) }
    return
  }
  const raw  = document.getElementById('newsKeywords')?.value ?? ''
  const keys = raw.split(',').map(k => k.trim().toLowerCase()).filter(Boolean)
  const hit  = keys.find(k => headline.toLowerCase().includes(k))
  if (hit && !newsPaused) {
    newsPaused = true
    updateNewsPauseUI(true, hit)
    updateSubmitBtn()
  } else if (!hit && newsPaused) {
    newsPaused = false
    updateNewsPauseUI(false)
    updateSubmitBtn()
  }
}

function updateNewsPauseUI(paused, keyword) {
  const el = document.getElementById('newsPauseStatus')
  if (!el) return
  if (paused) {
    el.innerHTML = `<span class="risk-status-dot" style="background:var(--red)"></span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--red)">
        News pause: "${keyword}" detected
      </span>`
  } else {
    el.innerHTML = `<span class="risk-status-dot" style="background:var(--green)"></span>
      <span style="font-family:'JetBrains Mono',monospace;font-size:11px">News: clear</span>`
  }
}

// ─── MOBILE STRATEGIES ────────────────────────────────────────────────────────
let _gridRangeMode     = 'price'   // 'price' | 'pct' — shared desktop + mobile
let _mobGridSpacing    = 'usd'
let _mobDcaMode        = 'time'
let _mobDcaSide        = 'long'
let _mobLongerTrigger  = 'always'
let _mobShorterTrigger = 'always'
let _mobAccumDryRun    = true   // Profit Stack: default to dry-run (no real transfers/buys) until the user opts in
let _mobEditing        = null   // { type, instance } when editing a running bot's config in-place
let _mobExpandedStrat  = null
let _mobLogStream      = null

function _applyGridDefaults(coinId, lowerId, upperId) {
  // Sync the Long/Short toggle + card title with the persisted side
  const sideTog = document.getElementById('tog-grid-side')
  if (sideTog) {
    const isShort = _gridSide === 'short'
    sideTog.textContent = isShort ? 'Short' : 'Long'
    sideTog.classList.toggle('active', !isShort)
  }
  // Sync the Cross/Isolated toggle with the persisted margin mode
  const marginTog = document.getElementById('tog-grid-margin')
  if (marginTog) {
    const isIso = _gridMargin === 'isolated'
    marginTog.textContent = isIso ? 'Isolated' : 'Cross'
    marginTog.classList.toggle('active', !isIso)
  }
  const coinEl = document.getElementById(coinId)
  if (coinEl && !coinEl.value) coinEl.placeholder = state.selectedCoin || 'BTC'
  const coin = (coinEl?.value?.trim() || coinEl?.placeholder || 'BTC').toUpperCase()
  const px = parseFloat(state.allMids?.[coin] ?? 0)
  const lowerEl = document.getElementById(lowerId)
  const upperEl = document.getElementById(upperId)
  // NEVER pre-fill values — empty fields mean the bot auto-ranges ±10% around
  // the live mark of whatever coin it starts with. Placeholders only preview
  // that, and update as the coin changes (pre-filled values went stale).
  if (_gridRangeMode === 'pct') {
    if (lowerEl) lowerEl.placeholder = '-10'
    if (upperEl) upperEl.placeholder = '10'
  } else {
    // Mirror the bot's auto-range: if a position is open in this coin, anchor the
    // band to the AVERAGE ENTRY (long: avg → avg+12%, short: avg−12% → avg); else mark ±10%.
    const BAND = 0.12
    const isShort = _gridSide === 'short'
    const apos = (state.perpState?.assetPositions ?? []).find(a => a.position?.coin === coin)
    const szi  = parseFloat(apos?.position?.szi ?? 0)
    const avg  = parseFloat(apos?.position?.entryPx ?? 0)
    const hasPos = avg > 0 && (isShort ? szi < 0 : szi > 0)
    let lo, up
    if (hasPos) {
      if (isShort) { up = avg; lo = Math.min(avg, px || avg) * (1 - BAND) }
      else         { lo = avg; up = Math.max(avg, px || avg) * (1 + BAND) }
    } else if (px) {
      lo = px * 0.90; up = px * 1.10
    }
    if (lowerEl) lowerEl.placeholder = lo ? `auto ~${lo.toFixed(2)}${hasPos ? ' (avg)' : ''}` : 'auto'
    if (upperEl) upperEl.placeholder = up ? `auto ~${up.toFixed(2)}${hasPos ? ' (avg)' : ''}` : 'auto'
  }
}
window._applyGridDefaults = _applyGridDefaults

// Convert grid lower/upper input to absolute price (handles both price and % mode)
function _gridRangeToPrice(val, coin) {
  if (!val) return ''
  if (_gridRangeMode !== 'pct') return val
  const px = parseFloat(state.allMids?.[(coin || state.selectedCoin || 'BTC').toUpperCase()] ?? 0)
  if (!px) return val
  return (px * (1 + parseFloat(val) / 100)).toFixed(2)
}

function toggleGridRange(btn) {
  const isPct = _gridRangeMode === 'price'   // about to switch TO pct
  _gridRangeMode = isPct ? 'pct' : 'price'

  // Update desktop toggle button + labels
  const togBtn = document.getElementById('tog-grid-range')
  if (togBtn) { togBtn.textContent = isPct ? '%' : '$'; togBtn.classList.toggle('active', isPct) }
  const lblU = document.getElementById('lbl-grid-upper')
  const lblL = document.getElementById('lbl-grid-lower')
  if (lblU) lblU.textContent = isPct ? 'Upper %' : 'Upper Price'
  if (lblL) lblL.textContent = isPct ? 'Lower %' : 'Lower Price'

  // Convert existing values
  const coin = (document.getElementById('grid-coin')?.value?.trim() || state.selectedCoin || 'BTC').toUpperCase()
  const px = parseFloat(state.allMids?.[coin] ?? 0)
  const lowerEl = document.getElementById('grid-lower')
  const upperEl = document.getElementById('grid-upper')
  if (px) {
    if (isPct) {
      if (lowerEl?.value) lowerEl.value = (((parseFloat(lowerEl.value) / px) - 1) * 100).toFixed(1)
      if (upperEl?.value) upperEl.value = (((parseFloat(upperEl.value) / px) - 1) * 100).toFixed(1)
    } else {
      if (lowerEl?.value) lowerEl.value = (px * (1 + parseFloat(lowerEl.value) / 100)).toFixed(2)
      if (upperEl?.value) upperEl.value = (px * (1 + parseFloat(upperEl.value) / 100)).toFixed(2)
    }
  }
  if (lowerEl) lowerEl.placeholder = isPct ? '-10' : 'auto'
  if (upperEl) upperEl.placeholder = isPct ? '10'  : 'auto'

  // Re-render mobile form to pick up new labels/placeholders
  const mobEl = document.getElementById('mobVContent')
  if (mobEl && _mobExpandedStrat === 'grid') _mobVRenderStrategies(mobEl)
}
window.toggleGridRange = toggleGridRange

function _mobExpandStrat(type) {
  if (_mobEditing && _mobEditing.type !== type) _mobEditing = null   // leaving the edited card cancels the edit
  _mobExpandedStrat = _mobExpandedStrat === type ? null : type
  if (!_mobExpandedStrat) _mobEditing = null
  const el = document.getElementById('mobVContent')
  if (el) _mobVRenderStrategies(el)
  if (type === 'grid' && _mobExpandedStrat === 'grid' && !_mobEditing) {
    setTimeout(() => _applyGridDefaults('m-grid-coin', 'm-grid-lower', 'm-grid-upper'), 0)
  }
}

// ─── EDIT A RUNNING BOT'S CONFIG IN-PLACE ───────────────────────────────────────
// Parse a launched instance's argv (['--coin','HYPE',...]) back into a {flag: value} map.
function _parseStratArgs(argv) {
  const out = {}
  for (let i = 0; i < (argv || []).length; i++) {
    const a = argv[i]
    if (typeof a !== 'string' || !a.startsWith('--')) continue
    const key = a.slice(2)
    const next = argv[i + 1]
    if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

// Open the bot's config card pre-filled with a specific running instance's live config.
function _mobEditStratInstance(type, instance) {
  const cfg = serverStatus?._configs?.[`${type}:${instance}`]
  if (!cfg) { alert('Config not available yet — wait a second and try again.'); return }
  const p = _parseStratArgs(cfg.args)
  if (type === 'grid') _mobEditGridInstance(instance, p)
}

function _mobEditGridInstance(instance, p) {
  // Toggle state must be set BEFORE the card renders (it drives the field HTML).
  _gridSide       = (p.side === 'short') ? 'short' : 'long'
  _gridMargin     = (p.margin === 'isolated') ? 'isolated' : 'cross'
  _mobGridSpacing = (p['pct-interval'] != null) ? 'pct' : 'usd'
  _gridRangeMode  = 'price'   // args store ABSOLUTE prices; price mode passes them through unchanged
  _mobEditing     = { type: 'grid', instance }
  _mobExpandedStrat = 'grid'
  const el = document.getElementById('mobVContent')
  if (el) _mobVRenderStrategies(el)
  // Inputs exist only after the render above — fill them next tick.
  setTimeout(() => {
    const set = (id, v) => { const e = document.getElementById(id); if (e && v != null && v !== true) e.value = v }
    set('m-grid-coin',      p.coin)
    set('m-grid-lower',     p.lower)
    set('m-grid-upper',     p.upper)
    set('m-grid-levels',    p['pct-interval'] != null ? p['pct-interval'] : p.levels)
    set('m-grid-leverage',  p.leverage)
    set('m-grid-totmargin', p['total-margin'])
    set('m-grid-entry-gap', p['entry-gap'])
    const szEl = document.getElementById('m-grid-size')
    if (szEl && p.size != null && p.size !== true) {
      szEl.value = p.size; szEl.dataset.mode = 'usd'
      const tog = document.getElementById('m-tog-grid-size')
      if (tog) { tog.textContent = 'USD'; tog.classList.remove('active') }
    }
  }, 0)
}

function _mobCancelEdit() {
  _mobEditing = null
  const el = document.getElementById('mobVContent')
  if (el) _mobVRenderStrategies(el)
}

// ─── DESKTOP: EDIT A RUNNING BOT'S CONFIG IN-PLACE (grid only, mirrors mobile) ───
let _deskEditing = null

function _deskEditStratInstance(type, instance) {
  const cfg = serverStatus?._configs?.[`${type}:${instance}`]
  if (!cfg) { alert('Config not available yet — wait a second and try again.'); return }
  const p = _parseStratArgs(cfg.args)
  if (type === 'grid') _deskEditGridInstance(instance, p)
}
window._deskEditStratInstance = _deskEditStratInstance

function _deskEditGridInstance(instance, p) {
  // Toggle state must be set BEFORE filling — args store ABSOLUTE prices in price mode.
  _gridSide      = (p.side === 'short') ? 'short' : 'long'
  _gridMargin    = (p.margin === 'isolated') ? 'isolated' : 'cross'
  _gridSpacing   = (p['pct-interval'] != null) ? 'pct' : 'usd'
  _gridRangeMode = 'price'
  _deskEditing   = { type: 'grid', instance }

  // Sync the desktop toggle buttons to the loaded config.
  const isShort = _gridSide === 'short'
  const togSide = document.getElementById('tog-grid-side')
  if (togSide) { togSide.textContent = isShort ? 'Short' : 'Long'; togSide.classList.toggle('active', !isShort) }
  const isIso = _gridMargin === 'isolated'
  const togMargin = document.getElementById('tog-grid-margin')
  if (togMargin) { togMargin.textContent = isIso ? 'Isolated' : 'Cross'; togMargin.classList.toggle('active', !isIso) }
  const isPctSpace = _gridSpacing === 'pct'
  const togSpace = document.getElementById('tog-grid-spacing')
  if (togSpace) { togSpace.textContent = isPctSpace ? '%' : '$'; togSpace.classList.toggle('active', isPctSpace) }
  const lblLevels = document.getElementById('lbl-grid-levels')
  if (lblLevels) lblLevels.textContent = isPctSpace ? 'Level Spacing %' : 'Grid Levels'
  const togRange = document.getElementById('tog-grid-range')
  if (togRange) { togRange.textContent = '$'; togRange.classList.remove('active') }
  const lblU = document.getElementById('lbl-grid-upper'); if (lblU) lblU.textContent = 'Upper Price'
  const lblL = document.getElementById('lbl-grid-lower'); if (lblL) lblL.textContent = 'Lower Price'

  // Fill inputs.
  const set = (id, v) => { const e = document.getElementById(id); if (e && v != null && v !== true) e.value = v }
  set('grid-coin',      p.coin)
  set('grid-lower',     p.lower)
  set('grid-upper',     p.upper)
  set('grid-levels',    p['pct-interval'] != null ? p['pct-interval'] : p.levels)
  set('grid-leverage',  p.leverage)
  set('grid-totmargin', p['total-margin'])
  set('grid-entry-gap', p['entry-gap'])
  const szEl = document.getElementById('grid-size')
  if (szEl && p.size != null && p.size !== true) {
    szEl.value = p.size; szEl.dataset.mode = 'usd'
    const tog = document.getElementById('tog-grid-size')
    if (tog) { tog.textContent = 'USD'; tog.classList.remove('active') }
  }

  // Inline Update / Cancel banner in the grid card's command-output slot.
  const out = document.getElementById('cmd-grid')
  if (out) {
    out.innerHTML = `<div class="strategy-run-row" style="flex-wrap:wrap;align-items:center;gap:8px">
      <span style="font-size:11px;color:var(--accent);font-weight:700;flex:1 0 100%">✎ Editing ${esc(instance || 'default')} — change fields, then Update</span>
      <button class="btn-run-strategy" onclick="updateStrategy('grid')">✓ Update ${esc(instance || '')}</button>
      <button class="btn-stop-strategy" onclick="_deskCancelEdit()" style="display:inline-block">Cancel</button>
    </div>`
  }
  document.getElementById('strat-grid')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function _deskCancelEdit() {
  _deskEditing = null
  const out = document.getElementById('cmd-grid'); if (out) out.innerHTML = ''
}
window._deskCancelEdit = _deskCancelEdit

// Apply a desktop edit: stop the edited instance, relaunch with the new args.
async function updateStrategy(type) {
  const ed = _deskEditing
  if (!ed || ed.type !== type) return runStrategy(type)
  const agentKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null)
                || document.getElementById('agentKey')?.value?.trim()
  if (!agentKey) { alert('Enter your Agent Private Key above.'); return }
  if (!state.addr) { alert('Load a wallet address before updating a strategy.'); return }
  await ensureAllMids()
  const argv    = buildArgv(type)
  const newInst = _argvInstance(argv)
  try {
    await _postStop(type, ed.instance)               // stop the instance being edited
    await new Promise(r => setTimeout(r, 600))
    const r = await serverFetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, agentKey, args: argv, address: state.addr, instance: newInst }),
    })
    if (!r.ok) { alert(`Could not update: ${r.error}`); return }
    _deskEditing = null
    const out = document.getElementById('cmd-' + type); if (out) out.innerHTML = ''
    serverStatus[type] = true
    checkServer()
    updateAllStrategyButtons()
    _verifyStarted(type, newInst)
  } catch { alert('Server unreachable. Is hliq-strat running?') }
}
window.updateStrategy = updateStrategy

// Apply an edit: re-launch the SAME (or coin-changed) instance with the new args. Stateful
// bots keep their cumulative counters via --resume; grid/others just re-adopt the position.
async function updateStrategyMob(type) {
  const ed = _mobEditing
  if (!ed || ed.type !== type) return runStrategyMob(type)
  const agentKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null)
                || document.getElementById('m-agentKey')?.value?.trim()
                || document.getElementById('agentKey')?.value?.trim()
  if (!agentKey) { alert('Enter your Agent Private Key above.'); return }
  await ensureAllMids()
  const argv    = buildArgvMob(type)
  const newInst = _argvInstance(argv)
  if (type === 'accumulator' || type === 'liqguard' || type === 'levbrake') argv.push('--resume')
  try {
    await _postStop(type, ed.instance)               // stop the instance being edited
    await new Promise(r => setTimeout(r, 600))
    const r = await serverFetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, agentKey, args: argv, address: state.addr, instance: newInst }),
    })
    if (!r.ok) { alert(`Could not update: ${r.error}`); return }
    _mobEditing = null
    serverStatus[type] = true
    checkServer()
    _verifyStarted(type, newInst)
  } catch { alert('Server unreachable. Is hliq-strat running?') }
}

function _mobToggleGridSpacing(btn) {
  _mobGridSpacing = _mobGridSpacing === 'pct' ? 'usd' : 'pct'
  btn.textContent = _mobGridSpacing === 'pct' ? '%' : '$'
  btn.classList.toggle('active', _mobGridSpacing === 'pct')
  const lbl = document.getElementById('m-lbl-grid-levels')
  if (lbl) lbl.textContent = _mobGridSpacing === 'pct' ? 'Level Spacing %' : 'Grid Levels'
}

function _mobToggleDcaMode(btn) {
  _mobDcaMode = _mobDcaMode === 'time' ? 'drop' : 'time'
  btn.textContent = _mobDcaMode === 'time' ? 'Time' : 'Drop'
  btn.classList.toggle('active', _mobDcaMode === 'time')
  const dropRow = document.getElementById('m-dca-drop-row')
  if (dropRow) dropRow.style.display = _mobDcaMode === 'drop' ? 'block' : 'none'
  const intEl = document.getElementById('m-dca-interval')
  if (intEl) intEl.placeholder = _mobDcaMode === 'drop' ? '5' : '60'
}

function _mobToggleDcaSide(btn) {
  _mobDcaSide = _mobDcaSide === 'long' ? 'short' : 'long'
  btn.textContent = _mobDcaSide === 'long' ? 'Long' : 'Short'
  btn.style.color = _mobDcaSide === 'long' ? 'var(--green)' : 'var(--red)'
}

function _mobToggleLongerTrigger(btn) {
  _mobLongerTrigger = _mobLongerTrigger === 'always' ? 'dump' : 'always'
  btn.textContent = _mobLongerTrigger === 'always' ? 'Always' : 'On Dump'
  btn.classList.toggle('active', _mobLongerTrigger === 'always')
  const row = document.getElementById('m-longer-dump-row')
  if (row) row.style.display = _mobLongerTrigger === 'dump' ? 'block' : 'none'
}

function _mobToggleShorterTrigger(btn) {
  _mobShorterTrigger = _mobShorterTrigger === 'always' ? 'pump' : 'always'
  btn.textContent = _mobShorterTrigger === 'always' ? 'Always' : 'On Pump'
  btn.classList.toggle('active', _mobShorterTrigger === 'always')
  const row = document.getElementById('m-shorter-pump-row')
  if (row) row.style.display = _mobShorterTrigger === 'pump' ? 'block' : 'none'
}

function _mobToggleAccumDryRun(btn) {
  _mobAccumDryRun = !_mobAccumDryRun
  btn.textContent = _mobAccumDryRun ? 'Dry-run' : 'LIVE'
  btn.classList.toggle('active', !_mobAccumDryRun)
  btn.style.color = _mobAccumDryRun ? 'var(--muted)' : 'var(--green)'
}
window._mobToggleAccumDryRun = _mobToggleAccumDryRun

function _mobToggleSizeMode(inputId, coinId, btn) {
  const el = document.getElementById(inputId)
  if (!el) return
  const toToken = el.dataset.mode !== 'token'
  el.dataset.mode = toToken ? 'token' : 'usd'
  btn.textContent = toToken ? 'TKN' : 'USD'
  btn.classList.toggle('active', toToken)
  el.placeholder = toToken ? '10' : '100'
}

function _mobVRenderStrategies(el) {
  // Preserve in-progress edits across re-renders. This view rebuilds via innerHTML on a
  // server-status poll or any toggle (Cross/Isolated, Long/Short, %/$, size unit). The
  // config inputs carry no value= attribute, so without this a re-render mid-typing wipes
  // them back to placeholders (looked like fields "changing to random numbers"). Snapshot
  // every input's value + size-unit data-mode now, restore after the rebuild below.
  const _preserved = {}
  el.querySelectorAll('input[id]').forEach(i => { _preserved[i.id] = { v: i.value, mode: i.dataset.mode } })
  const _focusedId = (document.activeElement && el.contains(document.activeElement)) ? document.activeElement.id : null
  const savedKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null)
                || document.getElementById('agentKey')?.value?.trim() || ''
  const serverBadge = serverOnline
    ? `<span style="font-size:11px;color:var(--green)">server ● online</span>`
    : `<span style="font-size:11px;color:var(--red)">server ○ offline</span>`
  const agentAddr   = isConnected() ? getWalletAddress() : null
  const agentStatus = agentAddr
    ? `<span style="color:var(--green)">✓ Connected: ${agentAddr.slice(0,6)}...${agentAddr.slice(-4)}</span>`
    : `<span style="color:var(--muted)">Not connected</span>`

  const stratsConfig = [
    { type: 'accumulator', label: '🪙 Profit Stack', desc: 'Skim a % of winning trades into spot' },
    { type: 'dca',     label: 'DCA Bot',       desc: 'Dollar-cost average into a position'    },
    { type: 'grid',    label: 'Grid Bot',       desc: 'Range grid with automatic rebalancing'  },
    { type: 'trend',   label: 'Trend Follower', desc: 'EMA crossover trend following'          },
    { type: 'longer',  label: 'Longer Bot',     desc: 'Long bias with take-profit / stop-loss' },
    { type: 'shorter', label: 'Shorter Bot',    desc: 'Short bias with take-profit / stop-loss'},
  ]

  const cards = stratsConfig.map(s => {
    const running  = !!serverStatus[s.type]
    const expanded = _mobExpandedStrat === s.type
    const dot = `<span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${running ? 'var(--green)' : 'var(--border2)'};display:inline-block;margin-right:8px"></span>`

    let bodyHtml = ''
    if (expanded) {
      if (s.type === 'accumulator') {
        bodyHtml = `
          <div style="font-size:11px;color:var(--muted);line-height:1.5;margin-bottom:12px">Takes a cut of every <b style="color:var(--green)">net-profitable</b> window across <b>all</b> your bots and buys spot — a stack that's ring-fenced from perp risk (only USDC is collateral, not your accumulated token). One per account.</div>
          <div class="mob-strat-field"><span class="mob-strat-label" title="Spot token to accumulate (must have a SYM/USDC spot pair)">Accumulate</span><input class="mob-strat-input" id="m-accum-asset" placeholder="HYPE"></div>
          <div class="mob-strat-field"><span class="mob-strat-label" title="% of net realized profit skimmed each window">Cut %</span><input class="mob-strat-input" id="m-accum-cut" type="number" placeholder="10"></div>
          <div class="mob-strat-field"><span class="mob-strat-label" title="Buffer up to this USD before each spot buy — batches to clear HL's $10 min and cut fee drag">Buy at ($)</span><input class="mob-strat-input" id="m-accum-threshold" type="number" placeholder="15"></div>
          <div class="mob-strat-field"><span class="mob-strat-label" title="Optional cap on USD skimmed per day (0 = no cap)">Max / day ($)</span><input class="mob-strat-input" id="m-accum-maxdaily" type="number" placeholder="0"></div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0" title="Dry-run logs what it WOULD buy without moving funds. Switch to LIVE to place real transfers + spot buys.">Mode</span><button class="btn-size-unit" style="color:var(--muted)" onclick="window._mobToggleAccumDryRun(this)">${_mobAccumDryRun ? 'Dry-run' : 'LIVE'}</button></div>
          </div>`
      } else if (s.type === 'dca') {
        bodyHtml = `
          <div class="mob-strat-field"><span class="mob-strat-label">Coin</span><input class="mob-strat-input" id="m-dca-coin" placeholder="BTC"></div>
          <div class="mob-strat-field">
            <span class="mob-strat-label">Side</span>
            <button class="btn-size-unit active" style="color:var(--green)" onclick="window._mobToggleDcaSide(this)">${_mobDcaSide === 'long' ? 'Long' : 'Short'}</button>
          </div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Size</span><button class="btn-size-unit" id="m-tog-dca-size" onclick="window._mobToggleSizeMode('m-dca-size','m-dca-coin',this)">TKN</button></div>
            <input class="mob-strat-input" id="m-dca-size" type="number" placeholder="100" data-mode="usd">
          </div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Mode</span><button class="btn-size-unit${_mobDcaMode === 'time' ? ' active' : ''}" onclick="window._mobToggleDcaMode(this)">${_mobDcaMode === 'time' ? 'Time' : 'Drop'}</button></div>
          </div>
          <div id="m-dca-drop-row" class="mob-strat-field" style="display:${_mobDcaMode === 'drop' ? 'block' : 'none'}"><span class="mob-strat-label">Drop % trigger</span><input class="mob-strat-input" id="m-dca-droppct" type="number" placeholder="2"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Interval (min)</span><input class="mob-strat-input" id="m-dca-interval" type="number" placeholder="${_mobDcaMode === 'drop' ? '5' : '60'}"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Max Orders</span><input class="mob-strat-input" id="m-dca-maxorders" type="number" placeholder="10"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Max Position ($)</span><input class="mob-strat-input" id="m-dca-maxpos" type="number" placeholder="0"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Leverage</span><input class="mob-strat-input" id="m-dca-leverage" type="number" placeholder="1"></div>`
      } else if (s.type === 'grid') {
        bodyHtml = `
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Direction</span>
              <button class="btn-size-unit${_gridSide === 'long' ? ' active' : ''}" onclick="window.toggleGridSide()">${_gridSide === 'short' ? 'Short ↓' : 'Long ↑'}</button>
            </div>
          </div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Margin</span>
              <button class="btn-size-unit${_gridMargin === 'cross' ? ' active' : ''}" onclick="window.toggleGridMargin()">${_gridMargin === 'isolated' ? 'Isolated' : 'Cross'}</button>
            </div>
          </div>
          <div class="mob-strat-field"><span class="mob-strat-label">Coin</span><input class="mob-strat-input" id="m-grid-coin" placeholder="${esc(state.selectedCoin || 'BTC')}" oninput="_applyGridDefaults('m-grid-coin','m-grid-lower','m-grid-upper')"></div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">${_gridRangeMode === 'pct' ? 'Lower %' : 'Lower Price'}</span><button class="btn-size-unit${_gridRangeMode === 'pct' ? ' active' : ''}" onclick="window.toggleGridRange(this)">${_gridRangeMode === 'pct' ? '%' : '$'}</button></div>
            <input class="mob-strat-input" id="m-grid-lower" type="number" placeholder="${_gridRangeMode === 'pct' ? '-10' : 'auto'}">
          </div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">${_gridRangeMode === 'pct' ? 'Upper %' : 'Upper Price'}</span></div>
            <input class="mob-strat-input" id="m-grid-upper" type="number" placeholder="${_gridRangeMode === 'pct' ? '10' : 'auto'}">
          </div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" id="m-lbl-grid-levels" style="margin:0">${_mobGridSpacing === 'pct' ? 'Level Spacing %' : 'Grid Levels'}</span><button class="btn-size-unit${_mobGridSpacing === 'pct' ? ' active' : ''}" onclick="window._mobToggleGridSpacing(this)">${_mobGridSpacing === 'pct' ? '%' : '$'}</button></div>
            <input class="mob-strat-input" id="m-grid-levels" type="number" placeholder="10">
          </div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Size per Level</span><button class="btn-size-unit active" id="m-tog-grid-size" onclick="window._mobToggleSizeMode('m-grid-size','m-grid-coin',this)">TKN</button></div>
            <input class="mob-strat-input" id="m-grid-size" type="number" placeholder="auto" data-mode="token">
          </div>
          <div class="mob-strat-field"><span class="mob-strat-label">Leverage</span><input class="mob-strat-input" id="m-grid-leverage" type="number" placeholder="10"></div>
          <div class="mob-strat-field" id="m-grid-totmargin-row"><span class="mob-strat-label" title="Cap the margin THIS position may use. The grid stops adding once its margin hits this — only profit-taking exits continue. Per grid, independent of your other bots. Blank = no cap.">Max Margin ($)</span><input class="mob-strat-input" id="m-grid-totmargin" type="number" placeholder="no cap"></div>
          <div class="mob-strat-field"><span class="mob-strat-label" title="% below entry price before placing first buy when a long exists">Entry Gap %</span><input class="mob-strat-input" id="m-grid-entry-gap" type="number" placeholder="3"></div>`
      } else if (s.type === 'trend') {
        bodyHtml = `
          <div class="mob-strat-field"><span class="mob-strat-label">Coin</span><input class="mob-strat-input" id="m-trend-coin" placeholder="BTC"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Fast EMA</span><input class="mob-strat-input" id="m-trend-fast" type="number" placeholder="9"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Slow EMA</span><input class="mob-strat-input" id="m-trend-slow" type="number" placeholder="21"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Timeframe</span><input class="mob-strat-input" id="m-trend-tf" placeholder="1h"></div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Size</span><button class="btn-size-unit" id="m-tog-trend-size" onclick="window._mobToggleSizeMode('m-trend-size','m-trend-coin',this)">TKN</button></div>
            <input class="mob-strat-input" id="m-trend-size" type="number" placeholder="500" data-mode="usd">
          </div>
          <div class="mob-strat-field"><span class="mob-strat-label">Leverage</span><input class="mob-strat-input" id="m-trend-leverage" type="number" placeholder="3"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Stop Loss %</span><input class="mob-strat-input" id="m-trend-stoploss" type="number" placeholder="0"></div>`
      } else if (s.type === 'longer') {
        bodyHtml = `
          <div class="mob-strat-field"><span class="mob-strat-label">Coins (comma-separated)</span><input class="mob-strat-input" id="m-longer-coins" placeholder="BTC"></div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Size</span><button class="btn-size-unit" id="m-tog-longer-size" onclick="window._mobToggleSizeMode('m-longer-size','m-longer-coins',this)">TKN</button></div>
            <input class="mob-strat-input" id="m-longer-size" type="number" placeholder="100" data-mode="usd">
          </div>
          <div class="mob-strat-field"><span class="mob-strat-label">Leverage</span><input class="mob-strat-input" id="m-longer-leverage" type="number" placeholder="2"></div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Trigger</span><button class="btn-size-unit${_mobLongerTrigger === 'always' ? ' active' : ''}" onclick="window._mobToggleLongerTrigger(this)">${_mobLongerTrigger === 'always' ? 'Always' : 'On Dump'}</button></div>
          </div>
          <div id="m-longer-dump-row" class="mob-strat-field" style="display:${_mobLongerTrigger === 'dump' ? 'block' : 'none'}">
            <span class="mob-strat-label">Dump %&nbsp;/&nbsp;Window</span>
            <div style="display:flex;gap:6px"><input class="mob-strat-input" id="m-longer-dumppct" type="number" placeholder="7" style="flex:1"><input class="mob-strat-input" id="m-longer-dumpwindow" placeholder="1d" style="flex:1"></div>
          </div>
          <div class="mob-strat-field"><span class="mob-strat-label">Take Profit %</span><input class="mob-strat-input" id="m-longer-tp" type="number" placeholder="3"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Stop Loss %</span><input class="mob-strat-input" id="m-longer-sl" type="number" placeholder="2"></div>`
      } else if (s.type === 'shorter') {
        bodyHtml = `
          <div class="mob-strat-field"><span class="mob-strat-label">Coins (comma-separated)</span><input class="mob-strat-input" id="m-shorter-coins" placeholder="BTC"></div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Size</span><button class="btn-size-unit" id="m-tog-shorter-size" onclick="window._mobToggleSizeMode('m-shorter-size','m-shorter-coins',this)">TKN</button></div>
            <input class="mob-strat-input" id="m-shorter-size" type="number" placeholder="100" data-mode="usd">
          </div>
          <div class="mob-strat-field"><span class="mob-strat-label">Leverage</span><input class="mob-strat-input" id="m-shorter-leverage" type="number" placeholder="2"></div>
          <div class="mob-strat-field">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px"><span class="mob-strat-label" style="margin:0">Trigger</span><button class="btn-size-unit${_mobShorterTrigger === 'always' ? ' active' : ''}" onclick="window._mobToggleShorterTrigger(this)">${_mobShorterTrigger === 'always' ? 'Always' : 'On Pump'}</button></div>
          </div>
          <div id="m-shorter-pump-row" class="mob-strat-field" style="display:${_mobShorterTrigger === 'pump' ? 'block' : 'none'}">
            <span class="mob-strat-label">Pump %&nbsp;/&nbsp;Window</span>
            <div style="display:flex;gap:6px"><input class="mob-strat-input" id="m-shorter-pumppct" type="number" placeholder="7" style="flex:1"><input class="mob-strat-input" id="m-shorter-pumpwindow" placeholder="1d" style="flex:1"></div>
          </div>
          <div class="mob-strat-field"><span class="mob-strat-label">Take Profit %</span><input class="mob-strat-input" id="m-shorter-tp" type="number" placeholder="3"></div>
          <div class="mob-strat-field"><span class="mob-strat-label">Stop Loss %</span><input class="mob-strat-input" id="m-shorter-sl" type="number" placeholder="2"></div>`
      }
      const _insts = Object.keys(serverStatus?._instances ?? {}).filter(k => k.startsWith(s.type + ':')).map(k => k.slice(s.type.length + 1))
      const _editing = _mobEditing && _mobEditing.type === s.type
      bodyHtml += `
        ${_editing ? `<div style="font-size:11px;color:var(--accent);font-weight:700;margin-top:10px">✎ Editing ${esc(_mobEditing.instance || 'default')} — change fields, then Update</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:${_editing ? '6' : '14'}px">
          <button id="m-run-btn-exp-${s.type}" onclick="window.${_editing ? 'updateStrategyMob' : 'runStrategyMob'}('${s.type}')"
            style="display:flex;flex:1;align-items:center;justify-content:center;padding:8px 0;border-radius:8px;border:none;background:var(--accent);color:#000;font-size:13px;font-weight:700;cursor:pointer">${_editing ? '✓ Update ' + esc(_mobEditing.instance || '') : '▶ Run'}</button>
          ${_editing
            ? `<button onclick="window._mobCancelEdit()" style="display:flex;flex:1;align-items:center;justify-content:center;padding:8px 0;border-radius:8px;border:1px solid var(--muted);background:transparent;color:var(--muted);font-size:13px;font-weight:700;cursor:pointer">Cancel</button>`
            : `<button id="m-stop-btn-exp-${s.type}" onclick="window.stopStrategyMob('${s.type}')"
            style="display:${running ? 'flex' : 'none'};flex:1;align-items:center;justify-content:center;padding:8px 0;border-radius:8px;border:1px solid var(--red);background:transparent;color:var(--red);font-size:13px;font-weight:700;cursor:pointer">■ Stop All</button>`}
          <button class="mob-strat-logs-btn" onclick="window._mobShowStratLogs('${s.type}')">Logs</button>
        </div>
        ${_insts.length ? `<div style="margin-top:12px;display:flex;flex-direction:column;gap:7px">
          <div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em">Running instances</div>
          ${_insts.map(i => {
            const paused = !!serverStatus?._paused?.[`${s.type}:${i}`]
            const sb = 'padding:5px 8px;border-radius:7px;font-size:11px;font-weight:700;cursor:pointer;touch-action:manipulation;white-space:nowrap'
            const pr = paused
              ? `<button onclick="window.resumeStrategyMob('${s.type}','${esc(i)}')" style="${sb};border:1px solid var(--green);background:transparent;color:var(--green)">▶ Resume</button>`
              : `<button onclick="window.pauseStrategyMob('${s.type}','${esc(i)}')" style="${sb};border:1px solid var(--orange);background:transparent;color:var(--orange)">⏸ Pause</button>`
            return `
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:9px 12px;border:1px solid var(--border2);border-radius:10px;background:var(--panel-2)">
            <span style="width:8px;height:8px;border-radius:50%;background:${paused ? 'var(--orange)' : 'var(--green)'};flex-shrink:0"></span>
            <span style="font-size:13px;font-weight:700">${esc(i || 'default')}${paused ? ' <span style="font-size:10px;color:var(--orange);font-weight:600">paused</span>' : ''}</span>
            <span style="flex:1"></span>
            ${s.type === 'grid' ? `<button onclick="window._mobEditStratInstance('${s.type}','${esc(i)}')" style="${sb};border:1px solid var(--accent);background:transparent;color:var(--accent)">✎ Edit</button>` : ''}
            <button onclick="window.restartStrategyMob('${s.type}','${esc(i)}',this)" style="${sb};border:1px solid var(--accent);background:transparent;color:var(--accent)"><span style="display:inline-block">⟳</span> Restart</button>
            ${pr}
            <button onclick="window.stopStrategyMob('${s.type}','${esc(i)}')" style="${sb};border:none;background:var(--red);color:#fff">■ Stop</button>
            <button onclick="window._mobShowStratLogs('${s.type}','${esc(i)}')" style="${sb};border:1px solid var(--border2);background:transparent;color:var(--muted);font-weight:600">Logs</button>
          </div>`}).join('')}</div>` : ''}`
    }

    return `<div class="mob-strat-card${running ? ' mob-strat-running' : ''}">
      <div class="mob-strat-header" onclick="window._mobExpandStrat('${s.type}')">
        <div style="display:flex;align-items:center">${dot}<div>
          <div style="font-size:14px;font-weight:600">${esc(s.label)}</div>
          <div style="font-size:11px;color:${running ? 'var(--green)' : 'var(--muted)'};margin-top:1px">${running ? 'Running' : esc(s.desc)}</div>
        </div></div>
        <div style="display:flex;align-items:center;gap:8px">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" style="color:var(--muted);flex-shrink:0;transform:rotate(${expanded ? 180 : 0}deg);transition:transform .2s"><polyline points="6 9 12 15 18 9"/></svg>
        </div>
      </div>
      ${expanded ? `<div class="mob-strat-body">${bodyHtml}</div>` : ''}
    </div>`
  }).join('')

  const autoGenBtn = savedKey ? '' :
    `<button class="auto-gen-agent-btn" onclick="window.__quickConnectAgent()" style="width:100%;padding:10px;border-radius:9px;border:none;background:rgba(255,138,42,0.14);color:var(--accent);font-size:13px;font-weight:700;cursor:pointer">${isMainWalletConnected() ? '⚡ Auto-generate Agent Key' : '🔗 Connect wallet'}</button>`

  el.innerHTML = `<div style="padding:4px 0 80px">
    <div class="mob-v-setting-group" style="margin-bottom:14px">
      <div class="mob-v-setting-row" style="flex-direction:column;align-items:stretch;gap:8px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span style="font-size:13px;font-weight:600">Agent Key</span>${serverBadge}
        </div>
        <input type="password" id="m-agentKey" class="mob-strat-input" placeholder="0x private key…"
          value="${esc(savedKey)}"
          oninput="window.__saveAgentKey(this.value);const dk=document.getElementById('agentKey');if(dk)dk.value=this.value"
          autocomplete="off" style="font-family:monospace;font-size:12px">
        <div id="m-agentKeyStatus" style="font-size:11px">${agentStatus}</div>
        <div style="display:flex;gap:6px">
          <button onclick="window.__mobConnectAgentKey()" style="flex:1;padding:8px 0;border-radius:8px;border:none;background:var(--accent);color:#000;font-size:12px;font-weight:700;cursor:pointer">Connect</button>
          <button onclick="window.__clearAgentKey()" style="padding:8px 14px;border-radius:8px;border:1px solid var(--panel-3);background:transparent;color:var(--muted);font-size:12px;cursor:pointer">Clear</button>
        </div>
        ${autoGenBtn}
      </div>
    </div>
    <div class="mob-v-setting-group">${cards}</div>
  </div>`

  // Restore the snapshotted edits onto the freshly-rendered inputs (skip the agent key —
  // it already re-fills from storage via value=). Re-apply size-unit data-mode so the
  // TKN/USD choice survives, and re-focus the field the user was typing in.
  for (const [id, snap] of Object.entries(_preserved)) {
    if (id === 'm-agentKey') continue
    const node = el.querySelector('#' + (window.CSS?.escape ? CSS.escape(id) : id))
    if (!node) continue
    if (snap.v != null && snap.v !== '') node.value = snap.v
    if (snap.mode != null) node.dataset.mode = snap.mode
  }
  if (_focusedId) {
    const f = el.querySelector('#' + (window.CSS?.escape ? CSS.escape(_focusedId) : _focusedId))
    if (f) { try { f.focus(); const n = f.value.length; f.setSelectionRange?.(n, n) } catch {} }
  }
}

function buildArgvMob(type) {
  const get = id => document.getElementById(id)?.value?.trim() ?? ''
  const argv = []
  const push = (f, v) => { if (v) argv.push(f, v) }

  if (type === 'accumulator') {
    push('--asset',     get('m-accum-asset')     || 'HYPE')
    push('--cut-pct',   get('m-accum-cut')       || '10')
    push('--threshold', get('m-accum-threshold') || '15')
    push('--max-daily', get('m-accum-maxdaily')  || '0')
    if (_mobAccumDryRun) argv.push('--dry-run')
  } else if (type === 'dca') {
    push('--coin',         get('m-dca-coin')      || 'BTC')
    push('--side',         _mobDcaSide)
    push('--size',         getSizeUsd('m-dca-size', 'm-dca-coin') || '100')
    push('--mode',         _mobDcaMode)
    push('--interval',     get('m-dca-interval')  || (_mobDcaMode === 'drop' ? '5' : '60'))
    if (_mobDcaMode === 'drop') push('--drop-pct', get('m-dca-droppct') || '2')
    push('--max-orders',   get('m-dca-maxorders') || '10')
    push('--max-position', get('m-dca-maxpos')    || '0')
    push('--leverage',     get('m-dca-leverage')  || '1')
  } else if (type === 'grid') {
    const _mCoin = _resolveGridCoin(get('m-grid-coin') || state.selectedCoin || 'BTC')
    const lower  = _gridRangeToPrice(get('m-grid-lower'), _mCoin)   // '' = bot auto-ranges
    const upper  = _gridRangeToPrice(get('m-grid-upper'), _mCoin)
    const levVal = parseFloat(get('m-grid-levels') || '10')
    push('--coin',  _mCoin)
    if (_gridSide === 'short') push('--side', 'short')
    push('--lower', lower)
    push('--upper', upper)
    if (_mobGridSpacing !== 'usd') push('--pct-interval', String(levVal))
    else                           push('--levels',       String(levVal))
    push('--size',      getSizeUsd('m-grid-size', 'm-grid-coin'))   // empty = auto-size from balance
    push('--leverage',  get('m-grid-leverage') || '10')
    if (_gridMargin === 'isolated') push('--margin', 'isolated')
    push('--total-margin', get('m-grid-totmargin'))   // per-position margin cap — works in cross or isolated
    const mEntryGap = get('m-grid-entry-gap')
    if (mEntryGap) push('--entry-gap', mEntryGap)
  } else if (type === 'trend') {
    push('--coin',          get('m-trend-coin')     || 'BTC')
    push('--fast-ema',      get('m-trend-fast')     || '9')
    push('--slow-ema',      get('m-trend-slow')     || '21')
    push('--candle-tf',     get('m-trend-tf')       || '1h')
    push('--size',          getSizeUsd('m-trend-size', 'm-trend-coin') || '500')
    push('--leverage',      get('m-trend-leverage') || '3')
    push('--interval',      get('m-trend-interval') || '5')
    push('--stop-loss-pct', get('m-trend-stoploss') || '0')
  } else if (type === 'longer') {
    push('--coins',           get('m-longer-coins')    || 'BTC')
    push('--size',            getSizeUsd('m-longer-size', 'm-longer-coins') || '100')
    push('--leverage',        get('m-longer-leverage') || '2')
    push('--trigger',         _mobLongerTrigger)
    if (_mobLongerTrigger === 'dump') {
      push('--dump-pct',    get('m-longer-dumppct')    || '7')
      push('--dump-window', get('m-longer-dumpwindow') || '1d')
    }
    push('--take-profit-pct', get('m-longer-tp') || '3')
    push('--stop-loss-pct',   get('m-longer-sl') || '2')
    push('--interval',        get('m-longer-interval') || '5')
  } else if (type === 'shorter') {
    push('--coins',           get('m-shorter-coins')    || 'BTC')
    push('--size',            getSizeUsd('m-shorter-size', 'm-shorter-coins') || '100')
    push('--leverage',        get('m-shorter-leverage') || '2')
    push('--trigger',         _mobShorterTrigger)
    if (_mobShorterTrigger === 'pump') {
      push('--pump-pct',    get('m-shorter-pumppct')    || '7')
      push('--pump-window', get('m-shorter-pumpwindow') || '1d')
    }
    push('--take-profit-pct', get('m-shorter-tp') || '3')
    push('--stop-loss-pct',   get('m-shorter-sl') || '2')
    push('--interval',        get('m-shorter-interval') || '5')
  }
  return argv
}

async function runStrategyMob(type) {
  if (!state.addr) { alert('Load a wallet address first.'); return }
  const agentKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null)
                || document.getElementById('m-agentKey')?.value?.trim()
                || document.getElementById('agentKey')?.value?.trim()
  if (!agentKey) { alert('Enter your Agent Private Key above.'); return }
  await ensureAllMids()
  const argv = buildArgvMob(type)
  try {
    const r = await serverFetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, agentKey, args: argv, address: state.addr, instance: _argvInstance(argv) }),
    })
    if (!r.ok) { alert(`Could not start: ${r.error}`); return }
    serverStatus[type] = true
    updateAllStrategyButtons()
    _verifyStarted(type, _argvInstance(argv))
  } catch { alert('Server unreachable. Is hliq-strat running?') }
}

// Bots validate config (min order size, margin) right after spawn, but the
// strat server may reply "ok" before that. Re-check a few seconds later and
// surface the silent death instead of leaving the user staring at nothing.
function _verifyStarted(type, instance) {
  setTimeout(async () => {
    try {
      await checkServer()   // refreshes serverStatus, buttons, mobile strategies tab
      const alive = instance ? !!serverStatus?._instances?.[`${type}:${instance}`] : !!serverStatus?.[type]
      if (!alive) alert(`The ${type} bot${instance ? ' (' + instance + ')' : ''} exited right after starting.\n\nOpen its Logs for the exact reason — most common: capital too low for Hyperliquid's $10 minimum order size, or no free margin (other bots' orders reserve margin).`)
    } catch {}
  }, 5000)
}

async function stopStrategyMob(type, instance) {
  try {
    if (instance !== undefined) {
      await _postStop(type, instance)
      if (serverStatus._instances) delete serverStatus._instances[`${type}:${instance}`]
      if (!_typeInstances(type).length) serverStatus[type] = false
    } else {
      const insts = _typeInstances(type)
      for (const i of (insts.length ? insts : [''])) await _postStop(type, i)
      serverStatus[type] = false
    }
    checkServer()
    updateAllStrategyButtons()
    if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'strategies') _mobVRenderContent()
  } catch { alert('Server unreachable.') }
}

function _mobShowStratLogs(type, inst = '') {
  const labels = { dca: 'DCA', grid: 'Grid', trend: 'Trend', longer: 'Longer', shorter: 'Shorter', accumulator: '🪙 Profit Stack', liqguard: '🛡 Liq Guard', levbrake: '🛑 Lev Brake' }
  let overlay = document.getElementById('mobStratLogOverlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'mobStratLogOverlay'
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:var(--bg);display:flex;flex-direction:column'
    document.body.appendChild(overlay)
  }
  overlay.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;padding:16px 16px 12px;border-bottom:1px solid var(--border);flex-shrink:0">
      <button onclick="document.getElementById('mobStratLogOverlay').style.display='none'"
        style="background:none;border:none;color:var(--fg);font-size:22px;padding:0;line-height:1;cursor:pointer">✕</button>
      <span style="font-size:15px;font-weight:700">${labels[type] || type}${inst ? ' · ' + inst : ''} — Live Logs</span>
      <span id="mob-log-stopped" style="display:none;margin-left:auto;font-size:11px;padding:2px 8px;border-radius:10px;background:var(--red);color:#fff">Stopped</span>
    </div>
    <div id="mobStratLogOut" style="flex:1;overflow-y:auto;padding:12px 14px;font-size:11px;font-family:'JetBrains Mono',monospace;line-height:1.65;white-space:pre-wrap;word-break:break-all"></div>`
  overlay.style.display = 'flex'

  if (_mobLogStream) { _mobLogStream.close(); _mobLogStream = null }
  const out  = document.getElementById('mobStratLogOut')
  const addr = state.addr || ''

  // Load today's log file from disk first, then attach SSE for live tail
  const today = (inst ? inst.toUpperCase() + '-' : '') + new Date().toISOString().slice(0, 10) + '.log'
  fetch(`/api/history/${type}/${today}?address=${encodeURIComponent(addr)}`)
    .then(r => r.ok ? r.text() : null).catch(() => null)
    .then(text => {
      if (text) {
        text.split('\n').filter(Boolean).forEach(line => {
          const color = line.includes('[WIN') ? '#22c55e' : line.includes('[ERROR') ? '#ef4444' : line.includes('[PLACE') ? '#60a5fa' : null
          _appendMobLog(out, line, color)
        })
        _appendMobLog(out, '─── live ───', '#6b7280')
      }
    })

  const es = new EventSource(`/api/logs/${type}?address=${encodeURIComponent(addr)}&instance=${encodeURIComponent(inst)}`)
  _mobLogStream = es
  es.onmessage = e => {
    const d = JSON.parse(e.data)
    if (d.exit !== undefined) {
      serverStatus[type] = false
      updateAllStrategyButtons()
      const b = document.getElementById('mob-log-stopped')
      if (b) b.style.display = 'inline'
      _appendMobLog(out, `[process exited — code ${d.exit}]`, '#ef4444')
      return
    }
    const color = d.line.includes('[WIN') ? '#22c55e' : d.line.includes('[ERROR') ? '#ef4444' : d.line.includes('[PLACE') ? '#60a5fa' : null
    _appendMobLog(out, d.line, color)
  }
  es.onerror = () => _appendMobLog(out, '[connection lost]', '#ef4444')
}

function _appendMobLog(container, text, color) {
  const div = document.createElement('div')
  div.textContent = _logLineLocal(text)
  if (color) div.style.color = color
  container.appendChild(div)
  container.scrollTop = container.scrollHeight
}

window.runStrategyMob      = runStrategyMob
window.updateStrategyMob   = updateStrategyMob
window._mobEditStratInstance = _mobEditStratInstance
window._mobCancelEdit      = _mobCancelEdit
window.stopStrategyMob     = stopStrategyMob
window._mobExpandStrat     = _mobExpandStrat
window._mobToggleGridSpacing   = _mobToggleGridSpacing
window._mobToggleDcaMode       = _mobToggleDcaMode
window._mobToggleDcaSide       = _mobToggleDcaSide
window._mobToggleLongerTrigger = _mobToggleLongerTrigger
window._mobToggleShorterTrigger = _mobToggleShorterTrigger
window._mobToggleSizeMode      = _mobToggleSizeMode
window._mobShowStratLogs       = _mobShowStratLogs

// Open the live log viewer for the guard currently shown in the guard modal. The guard's
// log instance is its uppercased coin (matches the server's per-instance log filenames).
window.__guardShowLogs = function () {
  const g = state.guardCfg
  if (!g) return
  _mobShowStratLogs(g.mode, String(g.coin).toUpperCase())
}

// ─── STRATEGY SERVER INTEGRATION ──────────────────────────────────────────────
let serverOnline  = false
let serverStatus  = {}          // { insolvent: bool, dca: bool, ... }
const logStreams   = {}          // type → EventSource

async function serverFetch(path, opts = {}) {
  const r = await fetch(path, opts)
  const ct = r.headers.get('content-type') ?? ''
  if (ct.includes('application/json')) return r.json()
  const txt = await r.text()
  return { ok: false, error: txt.trim() || 'Strategy server unreachable' }
}

let _lastStatusHash = ''
async function checkServer() {
  if (!state.addr) return
  try {
    serverStatus = await serverFetch(`/api/status?address=${encodeURIComponent(state.addr)}`)
    const justCameOnline = !serverOnline
    serverOnline = true
    updateServerBadge()
    updateAllStrategyButtons()
    // Mobile strategies tab renders from serverStatus — refresh it when the
    // running set changes (e.g. a bot was started/stopped from another device)
    const _sh = JSON.stringify(serverStatus)
    if (_sh !== _lastStatusHash) {
      _lastStatusHash = _sh
      if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'strategies') {
        try { _mobVRenderContent() } catch {}
      }
    }
    if (justCameOnline) {
      // Inject Run/Stop into any command outputs already on screen
      for (const type of ['insolvent','dca','grid','trend','longer','shorter']) {
        const outputEl = document.getElementById('cmd-' + type)
        if (outputEl && outputEl.innerHTML.trim() && !document.getElementById('run-btn-' + type)) {
          injectRunButtons(type)
        }
      }
      renderWinsPanel()
    }
  } catch {
    if (serverOnline) {
      serverOnline = false
      updateServerBadge()
      updateAllStrategyButtons()
    }
  }
}

function updateServerBadge() {
  const el = document.getElementById('serverBadge')
  if (!el) return
  el.textContent   = serverOnline ? '● Server connected' : '○ Server offline'
  el.className     = 'server-badge ' + (serverOnline ? 'server-online' : 'server-offline')
}

// ── Inject Run/Stop row into a strategy command output area ──────────────────
function updateAllStrategyButtons() {
  const labels  = { insolvent:'Insolvent', dca:'DCA', grid:'Grid', trend:'Trend', longer:'Longer', shorter:'Shorter' }
  const running = []
  for (const type of ['insolvent','dca','grid','trend','longer','shorter']) {
    const isRunning = !!serverStatus[type]

    // Desktop buttons
    const runBtn  = document.getElementById(`run-btn-${type}`)
    const stopBtn = document.getElementById(`stop-btn-${type}`)
    if (runBtn)  runBtn.style.display  = 'inline-block'   // always — allows starting another token
    if (stopBtn) stopBtn.style.display = isRunning ? 'inline-block' : 'none'
    // Ensure each card always has its Run/Stop row + instance list, even if the user
    // never clicked "Generate Command" — otherwise running bots have no visible controls.
    if (serverOnline && _deskEditing?.type !== type
        && document.getElementById(`cmd-${type}`) && !document.getElementById(`inst-list-${type}`)) {
      injectRunButtons(type)
    }
    const instList = document.getElementById(`inst-list-${type}`)
    if (instList) {
      const lb = 'background:none;border:none;cursor:pointer;padding:0;font-size:11px;font-weight:600'
      instList.innerHTML = _typeInstances(type).map(i => {
        const paused  = !!serverStatus?._paused?.[`${type}:${i}`]
        const dotCol  = paused ? 'var(--orange)' : 'var(--green)'
        const pauseBtn = paused
          ? `<button onclick="resumeStrategyMob('${type}','${esc(i)}')" title="Resume" style="${lb};color:var(--green)">▶ Resume</button>`
          : `<button onclick="pauseStrategyMob('${type}','${esc(i)}')" title="Pause" style="${lb};color:var(--orange)">⏸ Pause</button>`
        const editBtn = type === 'grid'
          ? `<button onclick="_deskEditStratInstance('${type}','${esc(i)}')" title="Edit" style="${lb};color:var(--accent)">✎ Edit</button>` : ''
        return `<span style="display:inline-flex;align-items:center;gap:8px;margin-left:8px;padding:3px 9px;border:1px solid var(--border2);border-radius:14px;font-size:11px"><span style="color:${dotCol}">●</span>${esc(i || 'default')}${paused ? ' <span style="color:var(--orange);font-size:10px;font-weight:600">paused</span>' : ''}${editBtn}<button onclick="restartInstance('${type}','${esc(i)}',this)" title="Restart" style="${lb};color:var(--accent)">⟳ Restart</button>${pauseBtn}<button onclick="stopInstance('${type}','${esc(i)}')" title="Stop" style="${lb};color:var(--red)">■ Stop</button><button onclick="showStrategyLogs('${type}','${esc(i)}')" style="${lb};color:var(--muted);font-weight:400">Logs</button></span>`
      }).join('')
    }
    const card = document.getElementById(`strat-${type === 'insolvent' ? 'manager' : type}`)
    if (card) card.classList.toggle('strategy-running', isRunning)

    // Mobile buttons (present when strategies tab is open)
    const mRunBtn  = document.getElementById(`m-run-btn-${type}`)
    const mStopBtn = document.getElementById(`m-stop-btn-${type}`)
    if (mRunBtn)  mRunBtn.style.display  = 'flex'   // always — allows starting another token
    if (mStopBtn) mStopBtn.style.display = isRunning ? 'flex' : 'none'
    // Refresh card border
    const mCard = mRunBtn?.closest?.('.mob-strat-card') || mStopBtn?.closest?.('.mob-strat-card')
    if (mCard) mCard.classList.toggle('mob-strat-running', isRunning)

    if (isRunning) {
      const insts = _typeInstances(type).filter(Boolean)
      running.push(labels[type] + (insts.length ? ` (${insts.join(', ')})` : ''))
    }
  }
  const statusEl = document.getElementById('runningBotsStatus')
  if (statusEl) {
    if (running.length) {
      statusEl.style.display = 'block'
      statusEl.innerHTML = `<span style="color:var(--green)">▶</span> Running: <strong style="color:var(--green)">${running.join(', ')}</strong>`
    } else {
      statusEl.style.display = 'none'
    }
  }
  // Mobile Strats tab badge — count only trading-strategy bots, NOT the per-position
  // risk guards (liqguard/levbrake), which are managed from the position rows.
  const mobStrat = document.getElementById('mobStratCount')
  if (mobStrat) {
    const isGuard = k => k.startsWith('liqguard:') || k.startsWith('levbrake:')
    const inst  = Object.keys(serverStatus?._instances ?? {}).filter(k => !isGuard(k)).length
    const count = inst || Object.keys(serverStatus ?? {}).filter(k => k !== '_instances' && k !== '_paused' && k !== '_guards' && k !== 'liqguard' && k !== 'levbrake' && serverStatus[k] === true).length
    mobStrat.textContent = count
    mobStrat.style.display = count > 0 ? '' : 'none'
  }
}

// Called by generateCommand after it sets innerHTML — injects run/stop buttons
function injectRunButtons(type) {
  if (!serverOnline) return
  const outputEl = document.getElementById('cmd-' + type)
  if (!outputEl) return
  const running = !!serverStatus[type]

  const div = document.createElement('div')
  div.className = 'strategy-run-row'
  div.innerHTML = `
    <button class="btn-run-strategy"  id="run-btn-${type}"
      style="display:inline-block"
      onclick="runStrategy('${type}')">▶ Run</button>
    <button class="btn-stop-strategy" id="stop-btn-${type}"
      style="display:${running ? 'inline-block' : 'none'}"
      onclick="stopStrategy('${type}')">■ Stop All</button>
    <button class="btn-show-logs" onclick="showStrategyLogs('${type}')">Logs</button>
    <span id="inst-list-${type}"></span>`
  outputEl.appendChild(div)
}

// ── Build argv from the current input values ─────────────────────────────────
function buildArgv(type) {
  const get = id => document.getElementById(id)?.value?.trim() ?? ''
  const longAssets  = (document.getElementById('longAssets')?.value  ?? '').split(',').map(s => s.trim()).filter(Boolean).join(',')
  const shortAssets = (document.getElementById('shortAssets')?.value ?? '').split(',').map(s => s.trim()).filter(Boolean).join(',')

  const argv = []
  const push = (flag, val) => { if (val) { argv.push(flag, val) } }

  if (type === 'insolvent') {
    push('--max-capital-pct', get('mgr-capital')   || '30')
    push('--short-zone-pct',  get('mgr-shortzone') || '0.5')
    push('--long-zone-pct',   get('mgr-longzone')  || '0.5')
    push('--interval',        get('mgr-interval')  || '5')
    if (longAssets)  argv.push('--long-assets',  longAssets)
    if (shortAssets) argv.push('--short-assets', shortAssets)
  } else if (type === 'dca') {
    const dcaMode = get('dca-mode') || 'time'
    push('--coin',         get('dca-coin')      || 'BTC')
    push('--side',         get('dca-side')      || 'long')
    push('--size',         getSizeUsd('dca-size', 'dca-coin') || '100')
    push('--mode',         dcaMode)
    push('--interval',     get('dca-interval') || (dcaMode === 'drop' ? '5' : '60'))
    if (dcaMode === 'drop') push('--drop-pct', get('dca-droppct') || '2')
    push('--max-orders',   get('dca-maxorders') || '10')
    push('--max-position', get('dca-maxpos')    || '0')
    push('--leverage',     get('dca-leverage')  || '1')
  } else if (type === 'grid') {
    const _gCoin  = _resolveGridCoin(get('grid-coin') || state.selectedCoin || 'BTC')
    const gLower  = _gridRangeToPrice(get('grid-lower'), _gCoin)   // '' = bot auto-ranges
    const gUpper  = _gridRangeToPrice(get('grid-upper'), _gCoin)
    const gLevVal = parseFloat(get('grid-levels') || '10')
    push('--coin',     _gCoin)
    if (_gridSide === 'short') push('--side', 'short')
    push('--lower',    gLower)
    push('--upper',    gUpper)
    if (_gridSpacing !== 'usd') {
      push('--pct-interval', String(gLevVal))
    } else {
      push('--levels', String(gLevVal))
    }
    push('--size',      getSizeUsd('grid-size',  'grid-coin'))   // empty = auto-size from balance
    push('--leverage',  get('grid-leverage') || '10')
    if (_gridMargin === 'isolated') push('--margin', 'isolated')
    push('--total-margin', get('grid-totmargin'))   // per-position margin cap — works in cross or isolated
    const gEntryGap = get('grid-entry-gap')
    if (gEntryGap) push('--entry-gap', gEntryGap)
  } else if (type === 'trend') {
    push('--coin',      get('trend-coin')     || 'BTC')
    push('--fast-ema',       get('trend-fast')      || '9')
    push('--slow-ema',       get('trend-slow')      || '21')
    push('--candle-tf',      get('trend-tf')        || '1h')
    push('--size',           getSizeUsd('trend-size', 'trend-coin') || '500')
    push('--leverage',       get('trend-leverage')  || '3')
    push('--interval',       get('trend-interval')  || '5')
    push('--stop-loss-pct',  get('trend-stoploss')  || '0')
  } else if (type === 'longer') {
    const trigger = get('longer-trigger') || 'always'
    push('--coins',            get('longer-coins')    || 'BTC')
    push('--size',             getSizeUsd('longer-size', 'longer-coins') || '100')
    push('--leverage',         get('longer-leverage') || '2')
    push('--trigger',          trigger)
    if (trigger === 'dump') {
      push('--dump-pct',    get('longer-dumppct')    || '7')
      push('--dump-window', get('longer-dumpwindow') || '1d')
    }
    push('--take-profit-pct',  get('longer-tp')       || '3')
    push('--stop-loss-pct',    get('longer-sl')       || '2')
    push('--interval',         get('longer-interval') || '5')
  } else if (type === 'shorter') {
    const trigger = get('shorter-trigger') || 'always'
    push('--coins',            get('shorter-coins')    || 'BTC')
    push('--size',             getSizeUsd('shorter-size', 'shorter-coins') || '100')
    push('--leverage',         get('shorter-leverage') || '2')
    push('--trigger',          trigger)
    if (trigger === 'pump') {
      push('--pump-pct',    get('shorter-pumppct')    || '7')
      push('--pump-window', get('shorter-pumpwindow') || '1d')
    }
    push('--take-profit-pct',  get('shorter-tp')       || '3')
    push('--stop-loss-pct',    get('shorter-sl')       || '2')
    push('--interval',         get('shorter-interval') || '5')
  } else if (type === 'custom') {
    const coin = get('custom-coin'); const lev = get('custom-leverage')
    const extra = get('custom-args')
    if (coin)  argv.push('--coin', coin)
    if (lev)   argv.push('--leverage', lev)
    // extra args are raw string — split and push
    if (extra) extra.split(/\s+/).filter(Boolean).forEach(a => argv.push(a))
  }
  return argv
}

async function runStrategy(type) {
  const agentKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null)
                || document.getElementById('agentKey')?.value?.trim()
  if (!agentKey) { alert('Enter your Agent Private Key in the Strategies tab before running.'); return }
  if (!state.addr) { alert('Load a wallet address before running a strategy.'); return }
  await ensureAllMids()
  const argv = buildArgv(type)
  const script = type === 'custom'
    ? (document.getElementById('custom-script')?.value?.trim() || null)
    : null
  try {
    const r = await serverFetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, agentKey, args: argv, script, address: state.addr, instance: _argvInstance(argv) }),
    })
    if (!r.ok) { alert(`Could not start: ${r.error}`); return }
    serverStatus[type] = true
    updateAllStrategyButtons()
    renderWinsPanel()
    _verifyStarted(type, _argvInstance(argv))
  } catch (e) {
    alert('Server unreachable. Is server.js running?')
  }
}

// Instance = the coin a bot runs on; '' for multi-coin bots. One address can
// run the same bot type on several coins simultaneously.
function _argvInstance(argv) {
  const i = argv.indexOf('--coin')
  return i >= 0 && argv[i + 1] ? String(argv[i + 1]).toUpperCase() : ''
}

// Normalize a grid coin to its full "dex:SYM" form so typing "SPCX" and "xyz:SPCX"
// resolve to the SAME market — same --coin, same instance key — so the server refuses
// a duplicate instead of spawning a second bot on the same TradFi market.
function _resolveGridCoin(raw) {
  const c = String(raw || '').trim()
  if (!c || c.includes(':')) return c            // already a full dex:SYM (or empty)
  const up = c.toUpperCase()
  if (state.allMids?.[up] != null) return up      // a main-dex coin
  const hit = Object.keys(state.allMids || {}).find(k => k.includes(':') && k.split(':').pop().toUpperCase() === up)
  return hit || up                                // HIP-3 full key, else leave as typed
}

function _typeInstances(type) {
  return Object.keys(serverStatus?._instances ?? {})
    .filter(k => k.startsWith(type + ':'))
    .map(k => k.slice(type.length + 1))
}

async function _postStop(type, instance) {
  await serverFetch('/api/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, address: state.addr, instance }),
  })
}

// Restart a single running instance — server relaunches with its exact config.
async function restartInstance(type, instance, btn) {
  if (btn) {
    btn.disabled = true
    btn.dataset._t = btn.innerHTML
    btn.innerHTML = '<span style="display:inline-block;animation:spin .8s linear infinite">⟳</span> Restarting'
  }
  try {
    const r = await serverFetch('/api/restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, address: state.addr, instance: instance ?? '' }),
    })
    if (!r.ok) alert(`Could not restart: ${r.error}`)
    await checkServer()
    updateAllStrategyButtons()
    if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'strategies') _mobVRenderContent()
  } catch {
    alert('Server unreachable.')
    if (btn) { btn.disabled = false; btn.innerHTML = btn.dataset._t || '⟳ Restart' }
  }
}
window.restartInstance    = restartInstance
window.restartStrategyMob = (type, instance, btn) => restartInstance(type, instance, btn)

// Pause / resume a running instance — keeps the process + key alive (no key loss).
async function _pauseResumeInstance(action, type, instance, btn) {
  if (btn) { btn.disabled = true; btn.dataset._t = btn.textContent; btn.textContent = '…' }
  try {
    const r = await serverFetch(`/api/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, address: state.addr, instance: instance ?? '' }),
    })
    if (!r.ok) alert(`Could not ${action}: ${r.error}`)
    await checkServer()
    updateAllStrategyButtons()
    if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'strategies') _mobVRenderContent()
  } catch {
    alert('Server unreachable.')
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset._t }
  }
}
window.pauseStrategyMob  = (type, instance) => _pauseResumeInstance('pause',  type, instance)
window.resumeStrategyMob = (type, instance) => _pauseResumeInstance('resume', type, instance)

async function stopStrategy(type, instance) {
  try {
    if (instance !== undefined) {
      await _postStop(type, instance)
      if (serverStatus._instances) delete serverStatus._instances[`${type}:${instance}`]
      if (!_typeInstances(type).length) serverStatus[type] = false
    } else {
      // No instance given — stop every running instance of this type
      const insts = _typeInstances(type)
      for (const i of (insts.length ? insts : [''])) await _postStop(type, i)
      serverStatus[type] = false
    }
    checkServer()
    updateAllStrategyButtons()
  } catch (e) {
    alert('Server unreachable.')
  }
}
window.stopInstance = (type, inst) => stopStrategy(type, inst)

// ── Live log panel ────────────────────────────────────────────────────────────
function showStrategyLogs(type, inst = '') {
  const panel  = document.getElementById('logPanel')
  const title  = document.getElementById('logPanelTitle')
  const output = document.getElementById('logPanelOutput')
  if (!panel || !title || !output) return

  _pastLogsType = type
  // Reset past logs bar when switching strategies
  const bar = document.getElementById('pastLogsBar')
  if (bar) bar.style.display = 'none'

  // Unsubscribe previous stream
  Object.keys(logStreams).forEach(t => { logStreams[t]?.close(); delete logStreams[t] })
  output.innerHTML = ''

  title.textContent = type.toUpperCase() + (inst ? ' · ' + inst : '') + ' — Live Logs'
  panel.style.display = 'flex'

  const es = new EventSource(`/api/logs/${type}?address=${encodeURIComponent(state.addr || '')}&instance=${encodeURIComponent(inst)}`)
  logStreams[type] = es

  es.onmessage = e => {
    const data = JSON.parse(e.data)
    if (data.exit !== undefined) {
      appendLog(output, `[process exited — code ${data.exit}]`, 'log-exit')
      return
    }
    const cls = data.line.includes('[WIN') ? 'log-win'
              : data.line.includes('[ERROR') ? 'log-error'
              : data.line.includes('[ORDER') || data.line.includes('[LIMIT') ? 'log-order'
              : ''
    appendLog(output, data.line, cls)
    if (data.line.includes('[WIN')) renderWinsPanel()
  }
  es.onerror = () => appendLog(output, '[connection lost]', 'log-error')
}

function hideStrategyLogs() {
  const panel = document.getElementById('logPanel')
  if (panel) panel.style.display = 'none'
  Object.keys(logStreams).forEach(t => { logStreams[t]?.close(); delete logStreams[t] })
}

let _pastLogsType = null

async function togglePastLogs() {
  const bar    = document.getElementById('pastLogsBar')
  const select = document.getElementById('pastLogFile')
  if (!bar || !select || !_pastLogsType) return
  const showing = bar.style.display !== 'none'
  if (showing) { bar.style.display = 'none'; return }

  // Fetch file list for current log type
  try {
    const files = await serverFetch(`/api/history/${_pastLogsType}?address=${encodeURIComponent(state.addr || '')}`)
    select.innerHTML = '<option value="">— select a log file —</option>' +
      files.map(f => `<option value="${f}">${f}</option>`).join('')
    bar.style.display = 'block'
  } catch { bar.style.display = 'none' }
}

function colorLogLine(text) {
  if (text.includes('[WIN'))    return 'log-win'
  if (text.includes('[ERROR'))  return 'log-error'
  if (text.includes('[STOP'))   return 'log-error'
  if (text.includes('[ORDER') || text.includes('[LIMIT') || text.includes('[FILL') || text.includes('[PLACE')) return 'log-order'
  if (text.includes('[START') || text.includes('[REINIT') || text.includes('[DONE')) return 'log-info'
  return ''
}

async function loadPastLog(filename) {
  if (!filename || !_pastLogsType) return
  const output = document.getElementById('logPanelOutput')
  if (!output) return
  output.innerHTML = ''
  try {
    const text = await serverFetch(`/api/history/${_pastLogsType}/${filename}?address=${encodeURIComponent(state.addr || '')}`)
    const lines = (typeof text === 'string' ? text : JSON.stringify(text)).split('\n')
    for (const line of lines) {
      if (line) appendLog(output, line, colorLogLine(line))
    }
  } catch (e) {
    appendLog(output, `[error loading log: ${e.message}]`, 'log-error')
  }
}

// Bot logs are written server-side in UTC ("[2026-06-11 04:09:50]") —
// convert the leading timestamp to the device's local timezone for display.
function _logLineLocal(text) {
  return String(text).replace(/^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\]/, (_, Y, Mo, D, H, Mi, S) => {
    const d = new Date(Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S))
    const p  = n => String(n).padStart(2, '0')
    const h12 = d.getHours() % 12 || 12
    const ap  = d.getHours() < 12 ? 'AM' : 'PM'
    return `[${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(h12)}:${p(d.getMinutes())}:${p(d.getSeconds())} ${ap}]`
  })
}

function appendLog(container, text, cls = '') {
  const line = document.createElement('div')
  line.className = 'log-line' + (cls ? ' ' + cls : '')
  line.textContent = _logLineLocal(text)
  container.appendChild(line)
  container.scrollTop = container.scrollHeight
}

// ── Wins panel ────────────────────────────────────────────────────────────────
async function renderWinsPanel() {
  const el = document.getElementById('winsPanel')
  if (!el || !serverOnline) return

  if (!state.addr) return
  let wins
  try { wins = await serverFetch(`/api/wins?address=${encodeURIComponent(state.addr)}`) }
  catch { return }

  const types    = ['insolvent','dca','grid','trend','longer','shorter']
  const labels   = { insolvent:'Insolvent', dca:'DCA Bot', grid:'Grid Bot', trend:'Trend Follower', longer:'Longer Bot', shorter:'Shorter Bot' }

  const sections = types.map(t => {
    const list = wins[t] ?? []
    if (!list.length) return ''
    const rows = list.slice(0, 20).map(w =>
      `<div class="win-row"><span class="win-ts">${w.ts}</span><span class="win-msg">${esc(w.msg)}</span></div>`
    ).join('')
    return `
      <div class="wins-strategy-block">
        <div class="wins-strategy-title">${labels[t]} <span class="wins-count">${list.length} win${list.length !== 1 ? 's' : ''}</span></div>
        ${rows}
      </div>`
  }).filter(Boolean).join('')

  el.innerHTML = sections || `<div style="font-size:11px;color:var(--muted)">No wins recorded yet. Wins appear here when strategies close profitable trades.</div>`
}

// Hook generateCommand to also inject run buttons
const _origGenerateCommand = window.generateCommand
window.generateCommand = function(type) {
  _origGenerateCommand(type)
  injectRunButtons(type)
}

// ─── FLIP CARD ────────────────────────────────────────────────────────────────
function flipCard(type) {
  const front = document.getElementById('front-' + type)
  const back  = document.getElementById('back-'  + type)
  if (!front || !back) return
  const showingFront = back.style.display === 'none'
  // Use '' to let the CSS class (display:flex) take over — never set 'block'
  front.style.display = showingFront ? 'none' : ''
  back.style.display  = showingFront ? '' : 'none'
  const visible = showingFront ? back : front
  visible.classList.remove('flip-anim')
  void visible.offsetWidth
  visible.classList.add('flip-anim')
}

// ─── SHORTER TP/SL PRICE SYNC ─────────────────────────────────────────────────
// which: 'tp' | 'sl'   changedField: 'pct' | 'px'
// For shorts: TP price is BELOW entry, SL price is ABOVE entry.
function syncShorterTpSl(which, changedField) {
  const coinRaw = (document.getElementById('shorter-coins')?.value?.split(',')[0]?.trim() || 'BTC').toUpperCase()
  const midPx   = parseFloat(state.allMids?.[coinRaw] ?? 0)

  const pctEl = document.getElementById(`shorter-${which}`)
  const pxEl  = document.getElementById(`shorter-${which}-px`)
  const refEl = document.getElementById(`shorter-${which}-ref`)
  if (!pctEl || !pxEl) return

  if (changedField === 'pct') {
    const pct = parseFloat(pctEl.value)
    if (!isNaN(pct) && midPx > 0) {
      const targetPx = which === 'tp'
        ? midPx * (1 - pct / 100)   // TP: price falls for profit
        : midPx * (1 + pct / 100)   // SL: price rises against us
      pxEl.value = targetPx.toFixed(targetPx >= 1000 ? 1 : targetPx >= 1 ? 2 : 4)
    } else {
      pxEl.value = ''
    }
  } else {
    const px = parseFloat(pxEl.value)
    if (!isNaN(px) && midPx > 0) {
      const calcPct = which === 'tp'
        ? (midPx - px) / midPx * 100   // how much below entry
        : (px - midPx) / midPx * 100   // how much above entry
      pctEl.value = Math.max(0, calcPct).toFixed(2)
    } else {
      pctEl.value = ''
    }
  }

  if (refEl) {
    if (midPx > 0) {
      refEl.textContent = `based on ${coinRaw} @ $${midPx.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    } else {
      refEl.textContent = `load a wallet to see live prices`
    }
  }
}

// ─── DCA MODE TOGGLE ──────────────────────────────────────────────────────────
function toggleDcaMode() {
  const mode      = document.getElementById('dca-mode')?.value ?? 'time'
  const dropRow   = document.getElementById('dca-droppct-row')
  const label     = document.getElementById('dca-interval-label')
  if (dropRow) dropRow.style.display = mode === 'drop' ? '' : 'none'
  if (label)  label.textContent      = mode === 'drop' ? 'Check Interval (min)' : 'Interval (min)'
  // Reset placeholder for interval based on mode
  const intervalEl = document.getElementById('dca-interval')
  if (intervalEl) intervalEl.placeholder = mode === 'drop' ? '5' : '60'
}

// ─── SHORTER TRIGGER TOGGLE ───────────────────────────────────────────────────
function toggleShorterTrigger() {
  const trigger  = document.getElementById('shorter-trigger')?.value ?? 'always'
  const pumpRow  = document.getElementById('shorter-pumppct-row')
  if (pumpRow) pumpRow.style.display = trigger === 'pump' ? '' : 'none'
}

// ─── LONGER TRIGGER TOGGLE ────────────────────────────────────────────────────
function toggleLongerTrigger() {
  const trigger = document.getElementById('longer-trigger')?.value ?? 'always'
  const dumpRow = document.getElementById('longer-dumppct-row')
  if (dumpRow) dumpRow.style.display = trigger === 'dump' ? '' : 'none'
}

function syncLongerTpSl(which, changedField) {
  const coinRaw = (document.getElementById('longer-coins')?.value?.split(',')[0]?.trim() || 'BTC').toUpperCase()
  const midPx   = parseFloat(state.allMids?.[coinRaw] ?? 0)

  const pctEl = document.getElementById(`longer-${which}`)
  const pxEl  = document.getElementById(`longer-${which}-px`)
  const refEl = document.getElementById(`longer-${which}-ref`)
  if (!pctEl || !pxEl) return

  if (changedField === 'pct') {
    const pct = parseFloat(pctEl.value)
    if (!isNaN(pct) && midPx > 0) {
      const targetPx = which === 'tp'
        ? midPx * (1 + pct / 100)   // TP: price rises for profit
        : midPx * (1 - pct / 100)   // SL: price falls against us
      pxEl.value = targetPx.toFixed(targetPx >= 1000 ? 1 : targetPx >= 1 ? 2 : 4)
    } else {
      pxEl.value = ''
    }
  } else {
    const px = parseFloat(pxEl.value)
    if (!isNaN(px) && midPx > 0) {
      const calcPct = which === 'tp'
        ? (px - midPx) / midPx * 100   // how much above entry
        : (midPx - px) / midPx * 100   // how much below entry
      pctEl.value = Math.max(0, calcPct).toFixed(2)
    } else {
      pctEl.value = ''
    }
  }

  if (refEl) {
    refEl.textContent = midPx > 0
      ? `based on ${coinRaw} @ $${midPx.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
      : `load a wallet to see live prices`
  }
}

// ─── SIZE UNIT TOGGLE ─────────────────────────────────────────────────────────
let _gridSpacing = 'pct'
let _gridSide    = localStorage.getItem('hliq_grid_side') || 'long'

window.toggleGridSide = function() {
  _gridSide = _gridSide === 'long' ? 'short' : 'long'
  localStorage.setItem('hliq_grid_side', _gridSide)
  const isShort = _gridSide === 'short'
  const tog = document.getElementById('tog-grid-side')
  if (tog) { tog.textContent = isShort ? 'Short' : 'Long'; tog.classList.toggle('active', !isShort) }
  if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'strategies') _mobVRenderContent()
}

// Margin mode for the grid bot — cross (default) or isolated. Shared between
// desktop and mobile via one state var, like _gridSide.
let _gridMargin = localStorage.getItem('hliq_grid_margin') || 'cross'

window.toggleGridMargin = function() {
  _gridMargin = _gridMargin === 'cross' ? 'isolated' : 'cross'
  localStorage.setItem('hliq_grid_margin', _gridMargin)
  const isIso = _gridMargin === 'isolated'
  const tog = document.getElementById('tog-grid-margin')
  if (tog) { tog.textContent = isIso ? 'Isolated' : 'Cross'; tog.classList.toggle('active', !isIso) }
  // Max Margin cap applies in BOTH modes now, so the field stays visible regardless.
  if (typeof _mobVActiveTab !== 'undefined' && _mobVActiveTab === 'strategies') _mobVRenderContent()
}

function toggleGridSpacing(btn) {
  _gridSpacing = _gridSpacing === 'pct' ? 'usd' : 'pct'
  btn.textContent = _gridSpacing === 'pct' ? '%' : '$'
  btn.classList.toggle('active', _gridSpacing === 'pct')
  const lbl = document.getElementById('lbl-grid-levels')
  if (lbl) lbl.textContent = _gridSpacing === 'pct' ? 'Level Spacing %' : 'Grid Levels'
}

function pctLevelsCount(lower, upper, pctInterval) {
  if (pctInterval <= 0 || lower <= 0 || upper <= lower) return 2
  return Math.max(2, Math.floor(Math.log(upper / lower) / Math.log(1 + pctInterval / 100)) + 1)
}

function toggleSizeMode(inputId, _coinInputId, btn) {
  const el = document.getElementById(inputId)
  if (!el) return
  const isUsd = el.dataset.mode !== 'token'
  el.dataset.mode  = isUsd ? 'token' : 'usd'
  btn.textContent  = isUsd ? 'TKN' : 'USD'
  btn.classList.toggle('active', isUsd)
  el.placeholder   = isUsd ? '0.001' : el.placeholder.replace(/[^\d]/g, '') || '100'
}

function getSizeUsd(inputId, coinInputId) {
  const el  = document.getElementById(inputId)
  // Only the typed value counts — placeholders are hints ('auto'), never sizes
  const val = el?.value?.trim()
  if (!val) return ''
  const n = parseFloat(val)
  if (!isFinite(n) || n <= 0) return ''
  if (el?.dataset?.mode === 'token') {
    const coinEl  = document.getElementById(coinInputId)
    const coinRaw = coinEl?.value?.trim() || coinEl?.placeholder?.trim() || state.selectedCoin || 'BTC'
    const coin    = coinRaw.toUpperCase()
    // allMids: perps use coin name ('HYPE'), spot uses @N key — check both
    let price = parseFloat(state.allMids?.[coin] ?? 0)
    if (price === 0 && _watchSpotKeyMap) {
      const spotKey = _watchSpotKeyMap[coin] ?? _watchSpotKeyMap[coin + '/USDC']
      if (spotKey) price = parseFloat(state.allMids?.[spotKey] ?? 0)
    }
    if (price > 0) return (n * price).toFixed(2)
    // price still 0 — allMids not loaded; treat as unset rather than emit garbage
    console.warn(`getSizeUsd: no price for ${coin} — size left as auto`)
    return ''
  }
  return String(n)
}

// ─── MAIN WALLET (per-address) ───────────────────────────────────────────────
function _walletRdnsForAddr(addr) {
  return addr ? 'hliq_wallet_rdns_' + addr.toLowerCase() : null
}

function _resetMainWalletUI() {
  const dotEl    = document.getElementById('mainWalletDot')
  const statusEl = document.getElementById('mainWalletStatus')
  const btn      = document.getElementById('mainWalletBtn')
  disconnectMainWallet()
  setBuilderFeeEnabled(false)
  if (dotEl)    dotEl.classList.remove('connected')
  if (statusEl) { statusEl.textContent = 'Not connected'; statusEl.style.color = 'var(--muted)' }
  if (btn)      { btn.textContent = 'Connect Wallet'; btn.onclick = openWalletPicker }
}

async function restoreWalletForAddr(addr) {
  const lookupAddr = addr || state.addr
  if (!lookupAddr) return
  const savedRdns = localStorage.getItem(_walletRdnsForAddr(lookupAddr))
  if (!savedRdns) return
  try {
    const connected = await connectWalletSilent(savedRdns)
    if (!connected) return
    // Switched accounts while the silent reconnect was in flight — don't paint
    // this account's wallet status over the account now loaded.
    if (state.addr !== lookupAddr) return
    const dotEl    = document.getElementById('mainWalletDot')
    const statusEl = document.getElementById('mainWalletStatus')
    const btn      = document.getElementById('mainWalletBtn')
    if (dotEl)    dotEl.classList.add('connected')
    if (statusEl) { statusEl.innerHTML = `✓ <span style="color:var(--accent)">${connected.slice(0,6)}...${connected.slice(-4)}</span> · Connected`; statusEl.style.color = 'var(--green)' }
    if (btn)      { btn.textContent = 'Disconnect'; btn.onclick = disconnectMainWalletUI }
    window.__updateDepositPreview?.()
    window.__updateWithdrawPreview?.()
    refreshDefiBalances?.()
  } catch { /* silent fail — wallet not available */ }
}

// ─── AGENT KEY (per-address) ──────────────────────────────────────────────────
function _agentKeyForAddr(addr) {
  return addr ? 'hliq_agent_key_' + addr.toLowerCase() : null
}
function _updateAutoGenBtnVisibility() {
  const hasKey    = !!(state.addr && localStorage.getItem(_agentKeyForAddr(state.addr)))
  const connected = isMainWalletConnected()
  const label     = connected ? '⚡ Auto-generate' : '🔗 Connect wallet'
  for (const id of ['desktopAutoGenBtn', 'tradeAutoGenBtn']) {
    const btn = document.getElementById(id)
    if (!btn) continue
    btn.style.display = hasKey ? 'none' : ''
    btn.textContent   = label
  }
}
window.__saveAgentKey = function(val) {
  if (val && state.addr) {
    localStorage.setItem(_agentKeyForAddr(state.addr), val)
    _updateAutoGenBtnVisibility()
  }
}

window.__mobConnectAgentKey = async function() {
  const mobInput  = document.getElementById('m-agentKey')
  const deskInput = document.getElementById('privateKeyInput')
  if (mobInput && deskInput) deskInput.value = mobInput.value
  await window.connectAgentKeyUI()
  const mobStatus  = document.getElementById('m-agentKeyStatus')
  const deskStatus = document.getElementById('apiConnectStatus')
  if (mobStatus && deskStatus) {
    mobStatus.innerHTML   = deskStatus.innerHTML
    mobStatus.style.color = deskStatus.style.color
  }
}

// One-tap "get me trading": activate a saved key, else connect the wallet, else
// auto-generate. Used by the trade buttons (and anywhere an agent key is required)
// so the user never hits a dead "Connect agent key" wall.
window.__quickConnectAgent = async function() {
  const saved = state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null
  if (saved) {
    try { await connectAgentKey(saved); updateSubmitBtn(); updateTradeBalance(); if (_isMobView()) _mobVRenderContent() } catch {}
    return
  }
  if (!isMainWalletConnected()) {
    if (_isMobView()) window.__mobConnectWallet?.()
    else openWalletPicker()
    return
  }
  const mainAddr = getMainAddress()?.toLowerCase()
  if (!state.addr || mainAddr !== state.addr.toLowerCase()) {
    alert('Your connected wallet (' + (mainAddr ? mainAddr.slice(0, 6) + '…' + mainAddr.slice(-4) : '?') +
          ') doesn\'t match the address you\'re viewing.\n\nSwitch to this address in your wallet (or load the address your wallet controls), then try again.')
    return
  }
  await window.__autoGenerateAgentKey()
}

window.__autoGenerateAgentKey = async function() {
  const existingKey = state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null
  if (existingKey) return

  if (!isMainWalletConnected()) {
    alert('Connect your wallet first.\n\nThis proves you own the address and lets the app approve the agent key on Hyperliquid on your behalf.')
    return
  }
  const mainAddr = getMainAddress()?.toLowerCase()
  if (!state.addr || mainAddr !== state.addr.toLowerCase()) {
    alert('Connected wallet (' + (mainAddr ? mainAddr.slice(0,6) + '…' + mainAddr.slice(-4) : '?') + ') does not match the address you\'re viewing.\n\nSwitch to this address in your wallet and reconnect.')
    return
  }

  document.querySelectorAll('.auto-gen-agent-btn').forEach(b => { b.disabled = true; b.textContent = 'Approving on HL…' })

  try {
    const { privateKey, address: agentAddr } = generateAgentWallet()

    await ensureChain('0xa4b1')   // wallet must be on Arbitrum to sign the HL agent approval
    await approveAgentKey(getHlSigner(), agentAddr)

    window.__saveAgentKey(privateKey)
    const connectedAddr = await connectAgentKey(privateKey)

    const stratInput = document.getElementById('agentKey')
    if (stratInput) stratInput.value = privateKey
    const mobInput = document.getElementById('m-agentKey')
    if (mobInput) mobInput.value = privateKey
    const mobSet = document.getElementById('mobVAgentKeyInput')
    if (mobSet) mobSet.value = privateKey

    const dotEl    = document.getElementById('apiStatusDot')
    const statusEl = document.getElementById('apiConnectStatus')
    if (dotEl)    dotEl.classList.add('connected')
    if (statusEl) {
      statusEl.innerHTML = `✓ Connected: <span style="color:var(--accent)">${connectedAddr.slice(0,6)}...${connectedAddr.slice(-4)}</span>`
      statusEl.style.color = 'var(--green)'
    }
    _syncSettingsTab()
    _updateAutoGenBtnVisibility()
    applyReferrer().catch(() => {})
    updateSubmitBtn()
    updateTradeBalance()
    if (_isMobView()) { try { _mobVRenderContent() } catch {} }

    document.querySelectorAll('.auto-gen-agent-btn').forEach(b => {
      b.disabled = false
      b.style.background = 'var(--green)'; b.style.color = '#000'; b.textContent = '✓ Done'
      setTimeout(() => { b.style.background = ''; b.style.color = ''; b.textContent = 'Auto-generate'; _updateAutoGenBtnVisibility() }, 3000)
    })
  } catch (e) {
    // The SDK wraps the real wallet error in `.cause` — surface it so signing
    // failures (e.g. wallet rejected eth_signTypedData_v4) are diagnosable.
    const top   = e?.message || String(e)
    const cause = e?.cause?.message || e?.cause?.cause?.message || ''
    const full  = cause && cause !== top ? `${top}\n\n${cause}` : top
    alert('Failed:\n\n' + (/rejected|denied|cancel|user (rejected|denied)/i.test(full) ? 'Signature rejected in your wallet.' : full))
    console.error('auto-gen agent key failed:', e)
    document.querySelectorAll('.auto-gen-agent-btn').forEach(b => { b.disabled = false; b.textContent = 'Auto-generate' })
  }
}

function _disconnectAgentKeyUI() {
  const dotEl    = document.getElementById('apiStatusDot')
  const statusEl = document.getElementById('apiConnectStatus')
  const tradeInput = document.getElementById('privateKeyInput')
  const stratInput = document.getElementById('agentKey')
  if (dotEl)    dotEl.classList.remove('connected')
  if (statusEl) { statusEl.textContent = 'Not connected'; statusEl.style.color = 'var(--muted)' }
  if (tradeInput) tradeInput.value = ''
  if (stratInput) stratInput.value = ''
  _tradePerpState = null
  disconnect()
  _updateAvailDisplay()
}
function restoreAgentKey(addr) {
  const lookupAddr = addr || state.addr
  if (!lookupAddr) return
  const perAddrKey = localStorage.getItem(_agentKeyForAddr(lookupAddr))
  const globalKey  = localStorage.getItem('hliq_agent_key')
  const savedKey   = perAddrKey || globalKey
  // Migrate global key to per-address slot so future restores find it
  if (!perAddrKey && globalKey) localStorage.setItem(_agentKeyForAddr(lookupAddr), globalKey)
  const el = document.getElementById('agentKey')
  const tradeInput = document.getElementById('privateKeyInput')
  _updateAutoGenBtnVisibility()
  if (!savedKey) {
    if (el) el.value = ''
    if (tradeInput) tradeInput.value = ''
    return
  }
  if (el) el.value = savedKey
  if (tradeInput) tradeInput.value = savedKey
  connectAgentKey(savedKey).then(connectedAddr => {
    // Account switched between kicking off this restore and it resolving — a
    // later loadDashboard has already disconnected/reconnected the correct key,
    // so don't paint this (now-stale) account's "Connected" status over it.
    if (state.addr !== lookupAddr) return
    const dotEl    = document.getElementById('apiStatusDot')
    const statusEl = document.getElementById('apiConnectStatus')
    if (dotEl) dotEl.classList.add('connected')
    if (statusEl) {
      statusEl.innerHTML = `✓ Connected: <span style="color:var(--accent)">${connectedAddr.slice(0,6)}...${connectedAddr.slice(-4)}</span>`
      statusEl.style.color = 'var(--green)'
    }
    applyReferrer().catch(() => {})
    updateSubmitBtn()
    updateTradeBalance()
  }).catch(() => {})
}

function restoreAssetLists(addr) {
  const saved = JSON.parse(localStorage.getItem('assetLists_' + addr) || 'null')
  if (!saved) return
  const la = document.getElementById('longAssets')
  const sa = document.getElementById('shortAssets')
  if (la) la.value = saved.long  ?? ''
  if (sa) sa.value = saved.short ?? ''
}

window.__saveAssetLists = function() {
  if (!state.addr) return
  const long  = document.getElementById('longAssets')?.value  ?? ''
  const short = document.getElementById('shortAssets')?.value ?? ''
  localStorage.setItem('assetLists_' + state.addr, JSON.stringify({ long, short }))
  const status = document.getElementById('assetSaveStatus')
  if (status) {
    status.textContent = '✓ Saved'
    setTimeout(() => { status.textContent = '' }, 2000)
  }
}

// Restore wallet address from localStorage (agent key restored after wallet loads)
const _savedAddr = localStorage.getItem('walletAddr')
if (_savedAddr) { const el = document.getElementById('walletInput'); if (el) el.value = _savedAddr }
renderSavedWallets()
renderRecentAddrs()

// Auto-load last used address if explicitly saved
if (_savedAddr) loadDashboard()

// Restore agent key connection immediately on startup
restoreAgentKey()

// Restore language preference
;(() => {
  _i18nLoadCache()
  const savedLang = localStorage.getItem('hliq_lang') || 'en'
  if (savedLang !== 'en') _applyLang(savedLang)
})()

// Restore appearance preferences
;(() => {
  const isLight = localStorage.getItem('hliq_light_mode') === '1'
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark')
  if (isLight) document.body.classList.add('light-mode')
  if (localStorage.getItem('hliq_theme_style') === 'soft') document.body.classList.add('theme-soft')
  const accentH = localStorage.getItem('hliq_accent_h')
  if (accentH) document.documentElement.style.setProperty('--accent-h', accentH)
  const brightness = parseInt(localStorage.getItem('hliq_brightness') || '100')
  document.documentElement.style.setProperty('--ui-brightness', brightness / 100)
})()

// Auto-register push on load if notifications already granted
if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
  _registerPush()
}

// ─── SETTINGS / PIN ───────────────────────────────────────────────────────────
// Clean up stale keys from old versions
localStorage.removeItem('hliq_pin')
localStorage.removeItem('hliq_pin_v2')
localStorage.removeItem('hliq_pin_v3')

const PIN_KEY    = 'hliq_pin_v4'       // stored hash
const PIN_ON_KEY = 'hliq_pin_enabled'  // 'true' when user has activated PIN
let _pinBuffer = ''

function _hashPin(pin) {
  let h = 0
  for (let i = 0; i < pin.length; i++) h = (Math.imul(31, h) + pin.charCodeAt(i)) | 0
  return h.toString(36)
}

// On load: if PIN is enabled and hash exists, show lock screen
;(function initPinLock() {
  if (localStorage.getItem(PIN_ON_KEY) !== 'true') return
  if (!localStorage.getItem(PIN_KEY)) return
  const screen = document.getElementById('pinLockScreen')
  if (screen) screen.style.display = 'flex'
  const bioBtn = document.getElementById('pinBiometricBtn')
  if (bioBtn && localStorage.getItem('hliq_biometric_cred')) {
    // Biometric-first: hide the PIN pad, auto-prompt Face ID. The pad only
    // appears after repeated failures or via "Use PIN instead".
    const pad = document.getElementById('pinPadArea')
    if (pad) pad.style.display = 'none'
    bioBtn.style.display = 'flex'
    const usePin = document.getElementById('pinUsePinBtn')
    if (usePin) usePin.style.display = 'inline-block'
    // Auto-attempt; if iOS demands a user gesture, ANY tap on the lock screen
    // retries with the gesture (direct Face ID scan, no consent sheet)
    setTimeout(() => window._mobVAuthBiometric?.(true), 350)
    screen.addEventListener('click', e => {
      const pad2 = document.getElementById('pinPadArea')
      if (pad2 && pad2.style.display !== 'none') return            // pad visible → typing PIN
      if (e.target.closest?.('#pinUsePinBtn,#pinForgotArea')) return
      window._mobVAuthBiometric?.()
    })
  }
})()

window.__pinShowPad = function() {
  const pad = document.getElementById('pinPadArea')
  if (pad) pad.style.display = 'flex'
  const usePin = document.getElementById('pinUsePinBtn')
  if (usePin) usePin.style.display = 'none'
}

window.__clearAgentKey = function() {
  if (state.addr) localStorage.removeItem(_agentKeyForAddr(state.addr))
  localStorage.removeItem('hliq_agent_key')
  const tradeInput = document.getElementById('privateKeyInput')
  const stratInput = document.getElementById('agentKey')
  const mobInput   = document.getElementById('m-agentKey')
  if (tradeInput) tradeInput.value = ''
  if (stratInput) stratInput.value = ''
  if (mobInput)   mobInput.value   = ''
  disconnect()
  const dotEl    = document.getElementById('apiStatusDot')
  const statusEl = document.getElementById('apiConnectStatus')
  if (dotEl) dotEl.classList.remove('connected')
  if (statusEl) { statusEl.textContent = 'Not connected'; statusEl.style.color = '' }
  updateSubmitBtn?.()
  _syncSettingsTab()
  _updateAutoGenBtnVisibility()
  const mobStatus = document.getElementById('m-agentKeyStatus')
  if (mobStatus) { mobStatus.innerHTML = '<span style="color:var(--muted)">Not connected</span>'; mobStatus.style.color = '' }
  if (_mobVActiveTab === 'strategies') {
    const mobEl = document.getElementById('mobVContent')
    if (mobEl) _mobVRenderStrategies(mobEl)
  }
}

// Sync toggle state whenever settings tab is opened
function _syncSettingsTab() {
  // Language
  const savedLang = localStorage.getItem('hliq_lang') || 'en'
  document.querySelectorAll('.lang-chip').forEach(b => b.classList.toggle('active', b.dataset.lang === savedLang))
  const langNameEl = document.getElementById('langCurrentName')
  if (langNameEl) langNameEl.textContent = _LANG_NAMES[savedLang] || 'English'
  // Agent key
  const agentKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null) || localStorage.getItem('hliq_agent_key')
  const statusEl = document.getElementById('agentKeySavedStatus')
  const clearBtn = document.getElementById('agentKeyClearBtn')
  if (statusEl) statusEl.textContent = agentKey ? 'Saved — auto-connects on load' : 'Not saved'
  if (statusEl) statusEl.style.color = agentKey ? 'var(--green)' : 'var(--muted)'
  if (clearBtn) clearBtn.style.display = agentKey ? '' : 'none'

  // PIN
  const enabled = localStorage.getItem(PIN_ON_KEY) === 'true' && !!localStorage.getItem(PIN_KEY)
  const toggle = document.getElementById('pinToggle')
  if (toggle) toggle.checked = enabled
  const setupArea = document.getElementById('pinSetupArea')
  if (setupArea) setupArea.style.display = 'none'
  const status = document.getElementById('pinSettingStatus')
  if (status) status.textContent = enabled ? 'PIN is active' : ''
  const input = document.getElementById('pinInput')
  if (input) input.value = ''

  // Appearance controls
  const isLight   = document.documentElement.getAttribute('data-theme') === 'light'
  const themeSt   = localStorage.getItem('hliq_theme_style') || 'pro'
  const accentH   = parseInt(localStorage.getItem('hliq_accent_h') || '142')
  document.querySelectorAll('#colorSchemeSeg .settings-seg-btn').forEach((b, i) => b.classList.toggle('active', i === (isLight ? 1 : 0)))
  document.querySelectorAll('#themeStyleSeg .settings-seg-btn').forEach((b, i) => b.classList.toggle('active', i === (themeSt === 'soft' ? 1 : 0)))
  document.querySelectorAll('.accent-swatch').forEach(b => b.classList.toggle('active', parseInt(b.dataset.hue) === accentH))
  const themeDesc = document.getElementById('themeStyleDesc')
  if (themeDesc) themeDesc.textContent = themeSt === 'soft' ? 'Soft Quant — rounded, more breathing room' : 'Terminal — sharp corners, high contrast'
  const brightness = parseInt(localStorage.getItem('hliq_brightness') || '100')
  const bSlider = document.getElementById('brightnessSlider')
  const bDesc   = document.getElementById('brightnessDesc')
  if (bSlider) bSlider.value = brightness
  if (bDesc) bDesc.textContent = brightness + '%'

  // Health alert
  const haEnabled   = localStorage.getItem('hliq_health_alert_enabled') === '1'
  const haThreshold = localStorage.getItem('hliq_health_alert_threshold') || '50'
  const haToggle    = document.getElementById('healthAlertToggle')
  const haArea      = document.getElementById('healthAlertArea')
  const haInput     = document.getElementById('healthAlertThreshold')
  if (haToggle) haToggle.checked = haEnabled
  if (haArea)   haArea.style.display = haEnabled ? '' : 'none'
  if (haInput)  haInput.value = haThreshold
  const haLabel = document.getElementById('healthAlertThresholdLabel')
  if (haLabel) haLabel.textContent = haThreshold + '%'

  // Position health alert
  const laEnabled   = localStorage.getItem('hliq_liq_alert_enabled') === '1'
  const laThreshold = localStorage.getItem('hliq_liq_alert_threshold') || '20'
  const laToggle    = document.getElementById('liqAlertToggle')
  const laArea      = document.getElementById('liqAlertArea')
  const laInput     = document.getElementById('liqAlertThreshold')
  if (laToggle) laToggle.checked = laEnabled
  if (laArea)   laArea.style.display = laEnabled ? '' : 'none'
  if (laInput)  laInput.value = laThreshold
  const laLabel = document.getElementById('liqAlertThresholdLabel')
  if (laLabel) laLabel.textContent = laThreshold + '%'

  // Alert frequency
  const cdSel = document.getElementById('notifCooldownSel')
  if (cdSel) cdSel.value = localStorage.getItem('hliq_notif_cooldown_min') || '60'

  // Price alerts
  _renderPriceAlerts()

  // Notifications
  const notifToggle = document.getElementById('notifToggle')
  const notifDesc   = document.getElementById('notifSettingDesc')
  if (notifToggle) notifToggle.checked = notifPermission() === 'granted'
  if (notifDesc) {
    const p = notifPermission()
    notifDesc.textContent = p === 'granted' ? 'Notifications enabled' : p === 'denied' ? 'Blocked by browser — check site permissions' : 'Get alerts for liquidation warnings and risk events'
  }

  // News pause
  const npToggle = document.getElementById('newsPauseToggle')
  if (npToggle) npToggle.checked = newsPauseEnabled
  const npArea = document.getElementById('newsPauseArea')
  if (npArea) npArea.style.display = newsPauseEnabled ? '' : 'none'

  // Risk management
  const rmToggle = document.getElementById('riskMgmtToggle')
  if (rmToggle) rmToggle.checked = riskMgmtEnabled
  const rmArea = document.getElementById('riskMgmtArea')
  if (rmArea) rmArea.style.display = riskMgmtEnabled ? '' : 'none'

  // UI mode
  const fmToggle = document.getElementById('forceMobileToggle')
  if (fmToggle) fmToggle.checked = localStorage.getItem('hliq_force_mobile') === '1'
}

window.__switchSettingsPanel = function(name, btn) {
  document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.settings-card[id^="settings-panel-"]').forEach(p => p.style.display = 'none')
  if (btn) btn.classList.add('active')
  const panel = document.getElementById('settings-panel-' + name)
  if (panel) panel.style.display = ''
}

window.__exportSettings = function() {
  const data = { _exportedAt: new Date().toISOString(), _version: 1 }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    data[key] = localStorage.getItem(key)
  }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `insolvent-backup-${new Date().toISOString().slice(0, 10)}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

window.__handleImportFile = async function(input) {
  const file = input.files[0]
  input.value = ''
  if (!file) return
  const box = document.getElementById('errorBox')
  try {
    const text = await file.text()
    const data = JSON.parse(text)
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Not a valid backup file')
    const SKIP = new Set(['_exportedAt', '_version', 'cg_icon_map', 'cg_icon_map_at', 'hliq_i18n', 'hliq_i18n_g'])
    let count = 0
    for (const [key, val] of Object.entries(data)) {
      if (key.startsWith('_') || SKIP.has(key)) continue
      try {
        localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val))
        count++
      } catch { /* quota — skip */ }
    }
    if (box) { box.style.color = 'var(--pos)'; box.textContent = `Imported ${count} settings` }
    // Imported alert thresholds/toggles must reach the push server too
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') _registerPush()
    const isLight = localStorage.getItem('hliq_light_mode') === '1'
    document.body.classList.toggle('light-mode', isLight)
    const importedAddr = localStorage.getItem('walletAddr')
    if (importedAddr) {
      const inp = document.getElementById('walletInput')
      if (inp) inp.value = importedAddr
      setTimeout(() => window.loadDashboard(), 300)
    }
  } catch (err) {
    if (box) { box.style.color = 'var(--neg)'; box.textContent = 'Import failed: ' + err.message }
  }
}

window.__importSettings = function() {
  document.getElementById('importFileInput')?.click()
}

window.__onThemeMode = function(mode) {
  const isLight = mode === 'light'
  document.documentElement.setAttribute('data-theme', mode)
  document.body.classList.toggle('light-mode', isLight)
  localStorage.setItem('hliq_light_mode', isLight ? '1' : '0')
  document.querySelectorAll('#colorSchemeSeg .settings-seg-btn').forEach((b, i) => b.classList.toggle('active', i === (isLight ? 1 : 0)))
}

window.__onThemeStyle = function(style) {
  document.body.classList.toggle('theme-soft', style === 'soft')
  localStorage.setItem('hliq_theme_style', style)
  const desc = document.getElementById('themeStyleDesc')
  if (desc) desc.textContent = style === 'soft' ? 'Soft Quant — rounded, more breathing room' : 'Terminal — sharp corners, high contrast'
  document.querySelectorAll('#themeStyleSeg .settings-seg-btn').forEach((b, i) => b.classList.toggle('active', i === (style === 'soft' ? 1 : 0)))
}

window.__onAccentChange = function(hue) {
  document.documentElement.style.setProperty('--accent-h', hue)
  localStorage.setItem('hliq_accent_h', hue)
  document.querySelectorAll('.accent-swatch').forEach(b => b.classList.toggle('active', parseInt(b.dataset.hue) === hue))
}

window.__onBrightnessChange = function(val) {
  const v = parseInt(val)
  document.documentElement.style.setProperty('--ui-brightness', v / 100)
  localStorage.setItem('hliq_brightness', v)
  const desc = document.getElementById('brightnessDesc')
  if (desc) desc.textContent = v + '%'
}

window.__onHealthAlertToggle = function(checked) {
  localStorage.setItem('hliq_health_alert_enabled', checked ? '1' : '0')
  const area = document.getElementById('healthAlertArea')
  if (area) area.style.display = checked ? '' : 'none'
}

window.__onHealthAlertThresholdChange = function(val) {
  const v = parseInt(val) || 50
  localStorage.setItem('hliq_health_alert_threshold', v)
  const lbl = document.getElementById('healthAlertThresholdLabel')
  if (lbl) lbl.textContent = v + '%'
  _registerPushDebounced() // sync new threshold to server
}

window.__onLiqAlertToggle = function(checked) {
  localStorage.setItem('hliq_liq_alert_enabled', checked ? '1' : '0')
  const area = document.getElementById('liqAlertArea')
  if (area) area.style.display = checked ? '' : 'none'
  _registerPush() // sync to server
}

window.__onLiqAlertThresholdChange = function(val) {
  const v = parseInt(val) || 20
  localStorage.setItem('hliq_liq_alert_threshold', v)
  const lbl = document.getElementById('liqAlertThresholdLabel')
  if (lbl) lbl.textContent = v + '%'
  _registerPushDebounced() // sync new threshold to server
}

window.__onNotifCooldownChange = function(val) {
  localStorage.setItem('hliq_notif_cooldown_min', parseInt(val) || 60)
  _registerPushDebounced() // sync new frequency to server
}

// In-app mute (works on iOS too, where notification action buttons don't exist)
window.__muteNotifs = async function(minutes = 1440, btn = null) {
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    await fetch('/notify/mute', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ endpoint: sub.endpoint, minutes }),
    })
    if (btn) { btn.textContent = '🔕 Muted 24h'; btn.disabled = true }
  } catch (e) { console.warn('[push] mute failed:', e.message) }
}


// Health & liquidation alerts are sent SERVER-SIDE ONLY (hliq-notify), which checks
// all tracked wallets with a streak guard against transient bad data. The old
// client-side _checkHealthAlerts/maybeSendLiqNotification were removed — they had no
// streak guard and could false-fire on partial refresh data. Settings toggles now
// configure the server subscription (see _registerPush).

// ─── PRICE ALERTS ─────────────────────────────────────────────────────────────
const _PA_KEY = 'hliq_price_alerts'
function _paLoad() { try { return JSON.parse(localStorage.getItem(_PA_KEY) || '[]') } catch { return [] } }
function _paSave(a) { localStorage.setItem(_PA_KEY, JSON.stringify(a)) }

let _paDir = 'above'
window.__paDirSelect = function(dir, btn) {
  _paDir = dir
  document.querySelectorAll('#paDirSeg .settings-seg-btn').forEach((b, i) => b.classList.toggle('active', i === (dir === 'above' ? 0 : 1)))
}

window.__addPriceAlert = function() {
  const coin  = document.getElementById('paCoInInput')?.value?.trim().toUpperCase()
  const price = parseFloat(document.getElementById('paPriceInput')?.value)
  if (!coin || isNaN(price) || price <= 0) return
  const alerts = _paLoad()
  alerts.push({ id: Date.now().toString(36), coin, dir: _paDir, price, fired: false })
  _paSave(alerts)
  document.getElementById('paCoInInput').value  = ''
  document.getElementById('paPriceInput').value = ''
  _renderPriceAlerts()
}

window.__removePriceAlert = function(id) {
  _paSave(_paLoad().filter(a => a.id !== id))
  _renderPriceAlerts()
}

window.__resetPriceAlert = function(id) {
  const alerts = _paLoad()
  const a = alerts.find(x => x.id === id)
  if (a) a.fired = false
  _paSave(alerts)
  _renderPriceAlerts()
}

function _renderPriceAlerts() {
  const el = document.getElementById('priceAlertsList')
  if (!el) return
  const alerts = _paLoad()
  if (!alerts.length) { el.innerHTML = '<div class="pa-empty">No alerts set</div>'; return }
  el.innerHTML = alerts.map(a => `
    <div class="pa-row${a.fired ? ' pa-row-fired' : ''}">
      <span class="pa-coin">${esc(a.coin)}</span>
      <span class="pa-dir ${a.dir === 'above' ? 'pos' : 'neg'}">${a.dir === 'above' ? '↑' : '↓'}</span>
      <span class="pa-price">$${fmtUSD(a.price)}</span>
      ${a.fired ? '<span class="pa-tag">Triggered</span>' : '<span class="pa-tag-placeholder"></span>'}
      ${a.fired ? `<button class="lb-edit" onclick="window.__resetPriceAlert('${a.id}')" title="Reset">↺</button>` : ''}
      <button class="lb-remove" onclick="window.__removePriceAlert('${a.id}')">✕</button>
    </div>`).join('')
}

function _checkPriceAlerts(allMids) {
  if (notifPermission() !== 'granted') return
  const alerts  = _paLoad()
  let changed   = false
  for (const a of alerts) {
    if (a.fired) continue
    const mid = parseFloat(allMids[a.coin])
    if (isNaN(mid)) continue
    const hit = a.dir === 'above' ? mid >= a.price : mid <= a.price
    if (!hit) continue
    a.fired = true
    changed = true
    showNotif(`Price Alert: ${a.coin} ${a.dir === 'above' ? '↑' : '↓'} $${fmtUSD(a.price)}`, {
      body: `${a.coin} is now at $${fmtUSD(mid)}`,
      tag:  'hliq-price-' + a.id,
    })
  }
  if (changed) { _paSave(alerts); _renderPriceAlerts() }
}

// ─── PUSH SUBSCRIPTION ───────────────────────────────────────────────────────

function _urlBase64ToUint8Array(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4)
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)))
}

// Debounced sync — slider oninput fires continuously while dragging; without
// this every drag tick would POST /notify/subscribe.
let _registerPushTimer = null
function _registerPushDebounced() {
  clearTimeout(_registerPushTimer)
  _registerPushTimer = setTimeout(_registerPush, 1000)
}

// VAPID key comes from the server (single source of truth); the literal is only
// an offline fallback and must match notify-server.js.
let _vapidKey = null
async function _getVapidKey() {
  if (_vapidKey) return _vapidKey
  try {
    const r = await fetch('/notify/vapid-public')
    const j = await r.json()
    if (j?.key) { _vapidKey = j.key; return _vapidKey }
  } catch {}
  return 'BLspXxgXQYJsr0J672DRQr2tgKt0rVXdVft0MEeuLwb5rfEB7IsAfUjqxvF2pMwii9tvkuIFRa_Ku5dG9z1NZoQ'
}

async function _registerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  if (Notification.permission !== 'granted') return

  try {
    const reg = await navigator.serviceWorker.ready
    let sub = await reg.pushManager.getSubscription()
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly:      true,
        applicationServerKey: _urlBase64ToUint8Array(await _getVapidKey()),
      })
    }
    const wallets   = WM.load()
    const watchList = wallets.length
      ? wallets.map(w => ({ addr: w.addr, label: w.label || '' }))
      : state.addr ? [{ addr: state.addr, label: '' }] : []
    if (!watchList.length) return
    const healthEnabled = localStorage.getItem('hliq_health_alert_enabled') === '1'
    const threshold    = parseInt(localStorage.getItem('hliq_health_alert_threshold') || '50')
    const liqEnabled   = localStorage.getItem('hliq_liq_alert_enabled') === '1'
    const liqThreshold = parseInt(localStorage.getItem('hliq_liq_alert_threshold') || '20')
    const cooldownMin  = parseInt(localStorage.getItem('hliq_notif_cooldown_min') || '60')
    await fetch('/notify/subscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ subscription: sub.toJSON(), wallets: watchList, healthEnabled, threshold, liqEnabled, liqThreshold, cooldownMin }),
    })
  } catch (e) {
    console.warn('[push] registration failed:', e.message)
  }
}

async function _unregisterPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
  try {
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (!sub) return
    await fetch('/notify/unsubscribe', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ endpoint: sub.endpoint }),
    })
    await sub.unsubscribe()
  } catch (e) {
    console.warn('[push] unregister failed:', e.message)
  }
}

window.__onNotifToggle = function(checked) {
  if (checked) {
    requestNotifications().then(perm => {
      _syncSettingsTab()
      if (perm === 'granted') _registerPush()
    })
  } else {
    _unregisterPush()
    const t = document.getElementById('notifToggle')
    if (t) t.checked = false
    const d = document.getElementById('notifSettingDesc')
    if (d) d.textContent = 'Get alerts for liquidation warnings and risk events'
  }
}

window.__onNewsPauseToggle = function(checked) {
  newsPauseEnabled = checked
  const area = document.getElementById('newsPauseArea')
  if (area) area.style.display = checked ? '' : 'none'
  if (!checked && newsPaused) {
    newsPaused = false
    updateNewsPauseUI(false)
    updateSubmitBtn()
  }
}

window.__onRiskMgmtToggle = function(checked) {
  riskMgmtEnabled = checked
  const area = document.getElementById('riskMgmtArea')
  if (area) area.style.display = checked ? '' : 'none'
  updateSubmitBtn()
}

window.__onPinToggle = function(checked) {
  const setupArea = document.getElementById('pinSetupArea')
  const status = document.getElementById('pinSettingStatus')
  if (!checked) {
    // Turning OFF — remove PIN
    localStorage.removeItem(PIN_KEY)
    localStorage.removeItem(PIN_ON_KEY)
    setupArea.style.display = 'none'
    status.textContent = ''
    document.getElementById('pinInput').value = ''
  } else {
    // Turning ON — ask user to set a PIN
    const existing = localStorage.getItem(PIN_KEY)
    if (existing) {
      // Already has a PIN hash saved, re-enabling
      localStorage.setItem(PIN_ON_KEY, 'true')
      setupArea.style.display = 'none'
      status.textContent = 'PIN re-enabled'
    } else {
      setupArea.style.display = 'block'
      status.textContent = 'Set a PIN to activate lock'
      document.getElementById('pinInput').focus()
    }
  }
}

window.__setPin = function() {
  const val = document.getElementById('pinInput').value.trim()
  const status = document.getElementById('pinSettingStatus')
  if (!/^\d{4}$/.test(val)) {
    status.textContent = 'Enter exactly 4 digits'
    return
  }
  localStorage.setItem(PIN_KEY, _hashPin(val))
  localStorage.setItem(PIN_ON_KEY, 'true')
  document.getElementById('pinInput').value = ''
  document.getElementById('pinSetupArea').style.display = 'none'
  status.textContent = 'PIN activated!'
}

window.__pinKey = function(digit) {
  if (_pinBuffer.length >= 4) return
  _pinBuffer += digit
  _updatePinDots()
  if (_pinBuffer.length === 4) {
    if (_hashPin(_pinBuffer) === localStorage.getItem(PIN_KEY)) {
      document.getElementById('pinLockScreen').style.display = 'none'
      _pinBuffer = ''
      _updatePinDots()
    } else {
      document.getElementById('pinError').textContent = 'Incorrect PIN'
      setTimeout(() => {
        _pinBuffer = ''
        _updatePinDots()
        document.getElementById('pinError').textContent = ''
      }, 800)
    }
  }
}

window.__pinBackspace = function() {
  _pinBuffer = _pinBuffer.slice(0, -1)
  _updatePinDots()
}

function _updatePinDots() {
  document.querySelectorAll('.pin-dot').forEach((d, i) => {
    d.classList.toggle('filled', i < _pinBuffer.length)
  })
}

window.__showForgotPin = function() {
  document.getElementById('pinForgotForm').style.display = 'block'
  document.getElementById('pinForgotInput').value = ''
  document.getElementById('pinForgotError').textContent = ''
}

window.__hideForgotPin = function() {
  document.getElementById('pinForgotForm').style.display = 'none'
}

window.__submitForgotPin = function() {
  const entered = document.getElementById('pinForgotInput').value.trim().toLowerCase()
  const errEl = document.getElementById('pinForgotError')
  if (!entered) { errEl.textContent = 'Enter your wallet address'; return }

  // Check against saved wallets
  const recent = JSON.parse(localStorage.getItem(RECENT_ADDRS_KEY) || '[]')
  const active = localStorage.getItem('walletAddr') || ''
  const allAddrs = [...new Set([active, ...recent])].map(a => a.toLowerCase())

  if (allAddrs.includes(entered)) {
    localStorage.removeItem(PIN_KEY)
    localStorage.removeItem(PIN_ON_KEY)
    document.getElementById('pinLockScreen').style.display = 'none'
    _pinBuffer = ''
    _updatePinDots()
  } else {
    errEl.textContent = 'Address not recognized'
  }
}

// Poll strategy-server status on all devices (nginx proxies /api/ everywhere,
// so a bot started on one device shows as running on every other one)
checkServer()
setInterval(checkServer, 5000)
if (window.innerWidth > 768) setInterval(renderWinsPanel, 30000)

// ─── WATCHLIST ────────────────────────────────────────────────────────────────
const WATCH_KEY = 'hliq_watchlist'

// Spot meta: lazily loaded once, maps @N ↔ display name
let _watchSpotNameMap = null  // { '@1': 'PURR/USDC', ... }
let _watchSpotKeyMap  = null  // { 'PURR/USDC': '@1', ... }
let _perpNames   = null  // string[] — all perp coin names from meta

let _spotMetaPromise = null
async function ensureSpotMeta() {
  if (_watchSpotNameMap) return
  if (_spotMetaPromise) return _spotMetaPromise
  _spotMetaPromise = (async () => {
    try {
      const meta = await infoClient.spotMeta()
      _watchSpotNameMap = {}
      _watchSpotKeyMap  = {}
      for (const u of (meta.universe ?? [])) {
        const key = `@${u.index}`
        _watchSpotNameMap[key]   = u.name
        _watchSpotKeyMap[u.name] = key
      }
    } catch (e) {
      console.warn('spotMeta fetch failed:', e.message)
      _watchSpotNameMap = {}
      _watchSpotKeyMap  = {}
    } finally {
      _spotMetaPromise = null
    }
  })()
  return _spotMetaPromise
}

// Fetch allMids independently so Watch search works even before a wallet is loaded
let _allMidsPromise = null
async function ensureAllMids() {
  if (Object.keys(state.allMids ?? {}).length > 0) return
  if (_allMidsPromise) return _allMidsPromise
  _allMidsPromise = (async () => {
    try {
      state.allMids = await fetchAllMids(state.allMetas)
    } catch (e) {
      console.warn('allMids fetch failed:', e.message)
    } finally {
      _allMidsPromise = null
    }
  })()
  return _allMidsPromise
}

let _perpMetaPromise = null
async function ensurePerpMeta() {
  if (_perpNames) return
  if (_perpMetaPromise) return _perpMetaPromise
  _perpMetaPromise = (async () => {
    try {
      const allMetas = await infoClient.allPerpMetas()
      const names = new Set()
      for (const dex of allMetas) {
        for (const u of (dex.universe ?? [])) names.add(u.name)
      }
      _perpNames = [...names]
    } catch (e) {
      console.warn('perpMeta fetch failed:', e.message)
      _perpNames = []
    } finally {
      _perpMetaPromise = null
    }
  })()
  return _perpMetaPromise
}

// ─── MARKET TYPE + LABEL HELPERS ─────────────────────────────────────────────

function watchMarketType(coin) {
  if (coin.startsWith('@')) return 'spot'
  return 'perp'
}

// Resolve @N → display name, or return perp coin name as-is
function watchCoinLabel(coin) {
  // HIP-3 markets are prefixed "dex:SYM" — strip the dex so it reads "SPCX", not "xyz:SPCX"
  if (typeof coin === 'string' && coin.includes(':')) return coinLabel(coin)
  return _watchSpotNameMap?.[coin] ?? coin
}

const WATCH_TF_CONFIG = {
  '1D': { interval: '1h',  startFn: () => Date.now() - 24 * 3600_000 },
  '1W': { interval: '1d',  startFn: () => Date.now() - 7  * 86400_000 },
  '1M': { interval: '1d',  startFn: () => Date.now() - 30 * 86400_000 },
  '3M': { interval: '3d',  startFn: () => Date.now() - 90 * 86400_000 },
  '6M': { interval: '1w',  startFn: () => Date.now() - 180 * 86400_000 },
  '1Y': { interval: '1w',  startFn: () => Date.now() - 365 * 86400_000 },
  '5Y': { interval: '1M',  startFn: () => Date.now() - 5 * 365 * 86400_000 },
}

// Cache: { 'BTC_1D': { ts, candles } }
const _watchCandleCache = {}
const WATCH_CACHE_TTL   = 3 * 60_000  // 3 min
let _watchFetchCtrl     = null
let _watchData          = {}   // { coin: { tf: candles } }
let _watchCurrentTf     = '1D'

function loadWatchlist() {
  try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || [] } catch { return [] }
}
function saveWatchlist(list) {
  localStorage.setItem(WATCH_KEY, JSON.stringify(list))
}

// SVG sparkline from close prices array (1D data)
function watchSparkline(closes, isPos) {
  if (!closes || closes.length < 2) return ''
  const W = 100, H = 36, PAD = 2
  const min = Math.min(...closes), max = Math.max(...closes)
  const range = max - min || 1
  const pts = closes.map((c, i) => {
    const x = PAD + (i / (closes.length - 1)) * (W - PAD * 2)
    const y = H - PAD - ((c - min) / range) * (H - PAD * 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  const color  = isPos ? '#00e5a0' : '#ff4d6d'
  const gradId = `spg${Math.random().toString(36).slice(2, 7)}`
  const area   = `${PAD},${H - PAD} ${pts} ${W - PAD},${H - PAD}`
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="none">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="${area}" fill="url(#${gradId})"/>
    <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`
}

// Compute % change for a timeframe from its candle data + current price
function watchChgPct(candles, currentPx) {
  if (!candles?.length) return null
  const openPx = parseFloat(candles[0].o)
  const curPx  = currentPx ?? parseFloat(candles[candles.length - 1].c)
  return openPx ? ((curPx - openPx) / openPx) * 100 : 0
}

// Render the watchlist for the current timeframe.
// Pass null for allTfData to show loading skeletons.
function renderWatchTab(allTfData) {
  const list = loadWatchlist()
  const mids = state.allMids ?? {}
  const wrap = document.getElementById('watchTableWrap')
  if (!wrap) return

  if (!list.length) {
    wrap.innerHTML = '<div class="watch-empty">No tokens on watchlist. Search above to add coins.</div>'
    return
  }

  const isLoading = allTfData === null
  const tf        = _watchCurrentTf

  const BADGES = { perp: 'PERP', spot: 'SPOT' }

  const rows = list.map(coin => {
    const candles = allTfData?.[coin]?.[tf]
    const isLive  = tf === '1D'
    const label   = watchCoinLabel(coin)
    const mType   = watchMarketType(coin)

    const curPx = mids[coin]
      ? parseFloat(mids[coin])
      : candles?.length ? parseFloat(candles[candles.length - 1].c) : null

    const spark = !isLoading && candles
      ? watchSparkline(candles.map(c => parseFloat(c.c)), (watchChgPct(candles, isLive ? curPx : null) ?? 0) >= 0)
      : ''

    let chgHtml
    if (isLoading) {
      chgHtml = `<span class="watch-chg-cell loading">···</span>`
    } else if (candles) {
      const pct  = watchChgPct(candles, isLive ? curPx : null) ?? 0
      const cls  = pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'neu'
      const sign = pct >= 0 ? '+' : ''
      chgHtml = `<span class="watch-chg-cell ${cls}">${sign}${pct.toFixed(2)}%</span>`
    } else {
      chgHtml = `<span class="watch-chg-cell neu">—</span>`
    }

    return `<tr onclick="window.__watchOpenTrade('${esc(coin)}')">
      <td>
        <div class="watch-coin-name">${esc(label)}</div>
        <span class="watch-market-badge ${mType}">${BADGES[mType] ?? mType.toUpperCase()}</span>
      </td>
      <td class="watch-price-cell">${isLoading ? '···' : curPx ? '$' + fmtPrice(curPx) : '—'}</td>
      <td class="watch-spark-cell">${spark}</td>
      <td>${chgHtml}</td>
      <td><button class="watch-remove-btn" onclick="event.stopPropagation();window.__watchRemove('${esc(coin)}')">✕</button></td>
    </tr>`
  }).join('')

  wrap.innerHTML = `
    <div class="watch-table-wrap">
      <table class="watch-table">
        <thead><tr>
          <th>Asset</th>
          <th>Price</th>
          <th class="th-spark">Chart</th>
          <th>${esc(tf)} Change</th>
          <th></th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`
}

// Fetch candles for a single timeframe for all watched coins
async function fetchWatchTf(tf) {
  const list = loadWatchlist()
  if (!list.length) return {}

  const now  = Date.now()
  const data = {}
  list.forEach(c => { data[c] = {} })

  if (_watchFetchCtrl) _watchFetchCtrl.abort()
  _watchFetchCtrl = new AbortController()
  const sig  = _watchFetchCtrl.signal
  const info = new InfoClient({ transport: _transport })

  await Promise.all(list.map(async coin => {
    const key    = `${coin}_${tf}`
    const cached = _watchCandleCache[key]
    if (cached && (now - cached.ts) < WATCH_CACHE_TTL) {
      data[coin][tf] = cached.candles
      return
    }
    const cfg = WATCH_TF_CONFIG[tf]
    try {
      const candles = await info.candleSnapshot(
        { coin, interval: cfg.interval, startTime: cfg.startFn() },
        sig
      )
      if (!sig.aborted && candles.length) {
        _watchCandleCache[key] = { ts: now, candles }
        data[coin][tf]         = candles
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.warn('Watch fetch failed:', coin, tf, e.message)
    }
  }))

  return data
}

// Merge fetched data into _watchData
function _mergeWatchData(fetched) {
  const list = loadWatchlist()
  list.forEach(coin => {
    if (!_watchData[coin]) _watchData[coin] = {}
    if (fetched[coin]) Object.assign(_watchData[coin], fetched[coin])
  })
}

// Show skeletons → fetch current TF → render
async function refreshWatchTab() {
  await Promise.all([ensureSpotMeta(), ensureAllMids()])
  const list = loadWatchlist()
  if (!list.length) { renderWatchTab(null); return }
  renderWatchTab(null)
  _mergeWatchData(await fetchWatchTf(_watchCurrentTf))
  renderWatchTab(_watchData)
}

// Switch active timeframe — fetches only if not cached
window.__watchSetTf = async function(tf) {
  _watchCurrentTf = tf
  document.querySelectorAll('.watch-tf-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.tf === tf)
  )
  const list        = loadWatchlist()
  const allCached   = list.length > 0 && list.every(coin => _watchData[coin]?.[tf])
  if (!allCached) {
    renderWatchTab(null)
    _mergeWatchData(await fetchWatchTf(tf))
  }
  renderWatchTab(_watchData)
}

// Ensure 1D candles are cached for every watchlist coin so the ticker can always
// show the 24h % change — even before the Watch tab has been opened. Self-guarded
// by TTL + an in-flight flag, and uses its own request (won't abort the Watch tab).
let _tickerFetching = false
async function _ensureTickerCandles() {
  const list = loadWatchlist()
  if (!list.length || _tickerFetching) return
  const now  = Date.now()
  const need = list.filter(c => { const x = _watchCandleCache[`${c}_1D`]; return !x || (now - x.ts) >= WATCH_CACHE_TTL })
  if (!need.length) return
  _tickerFetching = true
  try {
    const info = new InfoClient({ transport: _transport })
    const cfg  = WATCH_TF_CONFIG['1D']
    await Promise.all(need.map(async coin => {
      try {
        const candles = await info.candleSnapshot({ coin, interval: cfg.interval, startTime: cfg.startFn() })
        if (candles?.length) _watchCandleCache[`${coin}_1D`] = { ts: now, candles }
      } catch (e) { if (e.name !== 'AbortError') console.warn('ticker candle fetch', coin, e.message) }
    }))
  } finally { _tickerFetching = false }
  updateWatchTicker()
}

function updateWatchTicker() {
  const list   = loadWatchlist()
  const mids   = state.allMids ?? {}
  const ticker = document.getElementById('watchTicker')
  const track  = document.getElementById('watchTickerTrack')
  if (!ticker || !track) return

  if (!list.length) { ticker.style.display = 'none'; return }
  ticker.style.display = 'flex'

  track.innerHTML = list.map(coin => {
    const cached1D  = _watchCandleCache[`${coin}_1D`]
    const lastClose = cached1D?.candles?.length ? parseFloat(cached1D.candles[cached1D.candles.length - 1].c) : null
    const price     = mids[coin] ? parseFloat(mids[coin]) : lastClose
    const priceStr  = price ? '$' + fmtPrice(price) : '—'
    // Always use 1D for the 24h % change
    let chgHtml = `<span class="watch-ticker-chg neu">—</span>`
    if (cached1D?.candles?.length) {
      const pct  = watchChgPct(cached1D.candles, price) ?? 0
      const cls  = pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'neu'
      const arr  = pct > 0 ? '▲' : pct < 0 ? '▼' : '·'
      const sign = pct >= 0 ? '+' : ''
      chgHtml = `<span class="watch-ticker-chg ${cls}">${arr} ${sign}${pct.toFixed(2)}%</span>`
    }
    return `<span class="watch-ticker-item" onclick="window.__watchOpenTrade('${esc(coin)}')">
      <span class="watch-ticker-ic">${_coinIconHtml(coin)}</span>
      <span class="watch-ticker-coin">${esc(watchCoinLabel(coin))}</span>
      <span class="watch-ticker-price">${priceStr}</span>${chgHtml}
    </span>`
  }).join('')

  _ensureTickerCandles()
}

window.__watchSearch = async function(q) {
  const resultsEl = document.getElementById('watchSearchResults')
  if (!resultsEl) return
  q = q.trim().toUpperCase()
  if (!q) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return }

  await Promise.all([ensureAllMids(), ensureSpotMeta(), ensurePerpMeta()])

  const mids = state.allMids ?? {}

  // Perp markets — use full meta list so TradFi (kXAU, kSPX…) are included
  const perpMatches = (_perpNames ?? Object.keys(mids).filter(k => !k.startsWith('@')))
    .filter(coin => coin.toUpperCase().includes(q))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 7)
    .map(coin => ({ coin, label: coin, px: parseFloat(mids[coin] ?? 0), isSpot: false }))

  // Spot markets — match against display name (e.g. "PURR/USDC" or base "PURR")
  const spotMatches = Object.entries(_watchSpotNameMap ?? {})
    .filter(([, name]) =>
      name.toUpperCase().includes(q) ||
      name.split('/')[0].toUpperCase().includes(q)
    )
    .slice(0, 5)
    .map(([key, name]) => ({ coin: key, label: name, px: parseFloat(mids[key] ?? 0), isSpot: true }))

  const matches = [...perpMatches, ...spotMatches].slice(0, 10)

  if (!matches.length) { resultsEl.style.display = 'none'; return }
  resultsEl.style.display = ''
  resultsEl.innerHTML = matches.map(({ coin, label, px, isSpot }) =>
    `<div class="watch-result-item" onclick="window.__watchAdd('${esc(coin)}')">
      <span>${esc(label)}</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span class="watch-market-badge ${isSpot ? 'spot' : 'perp'}" style="font-size:9px">${isSpot ? 'SPOT' : 'PERP'}</span>
        <span class="watch-result-price">${px ? '$' + fmtPrice(px) : '—'}</span>
      </span>
    </div>`
  ).join('')
}

window.__watchAdd = function(coin) {
  const list = loadWatchlist()
  if (!list.includes(coin)) {
    list.push(coin)
    saveWatchlist(list)
    delete _watchData[coin]  // will be fetched fresh
  }
  const inp = document.getElementById('watchSearchInput')
  const res = document.getElementById('watchSearchResults')
  if (inp) inp.value = ''
  if (res) { res.style.display = 'none'; res.innerHTML = '' }
  updateWatchTicker()
  refreshWatchTab()
}

window.__watchRemove = function(coin) {
  const list = loadWatchlist().filter(c => c !== coin)
  saveWatchlist(list)
  delete _watchData[coin]
  updateWatchTicker()
  refreshWatchTab()
}


window.__watchOpenTrade = function(coin) {
  const tradeBtn = [...document.querySelectorAll('.nav-tab')]
    .find(b => b.getAttribute('onclick')?.includes("'trade'"))
  switchTab('trade', tradeBtn)
  setTimeout(() => {
    if (state.allMids?.[coin]) {
      state.selectedCoin = coin
      updateCoinHeader(coin)
      updateOrderSummary()
      loadTradeChart(coin)
    }
  }, 80)
}


// Close search results when clicking outside
document.addEventListener('click', e => {
  const inp = document.getElementById('watchSearchInput')
  const res = document.getElementById('watchSearchResults')
  if (inp && res && !inp.contains(e.target) && !res.contains(e.target)) {
    res.style.display = 'none'
  }
  const mInp = document.getElementById('mobWatchSearchInput')
  const mRes = document.getElementById('mobWatchSearchResults')
  if (mInp && mRes && !mInp.contains(e.target) && !mRes.contains(e.target)) {
    mRes.style.display = 'none'
  }
})

window.__mobWatchSearch = async function(q) {
  const resultsEl = document.getElementById('mobWatchSearchResults')
  if (!resultsEl) return
  q = q.trim().toUpperCase()
  if (!q) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return }

  await Promise.all([ensureAllMids(), ensureSpotMeta(), ensurePerpMeta()])

  const mids = state.allMids ?? {}

  const perpMatches = (_perpNames ?? Object.keys(mids).filter(k => !k.startsWith('@')))
    .filter(coin => coin.toUpperCase().includes(q))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 7)
    .map(coin => ({ coin, label: coin, px: parseFloat(mids[coin] ?? 0), isSpot: false }))

  const spotMatches = Object.entries(_watchSpotNameMap ?? {})
    .filter(([, name]) =>
      name.toUpperCase().includes(q) ||
      name.split('/')[0].toUpperCase().includes(q)
    )
    .slice(0, 5)
    .map(([key, name]) => ({ coin: key, label: name, px: parseFloat(mids[key] ?? 0), isSpot: true }))

  const matches = [...perpMatches, ...spotMatches].slice(0, 10)

  if (!matches.length) { resultsEl.style.display = 'none'; return }
  resultsEl.style.display = ''
  resultsEl.innerHTML = matches.map(({ coin, label, px, isSpot }) =>
    `<div class="watch-result-item" onclick="window.__mobWatchAdd('${esc(coin)}')">
      <span>${esc(label)}</span>
      <span style="display:flex;align-items:center;gap:6px">
        <span class="watch-market-badge ${isSpot ? 'spot' : 'perp'}" style="font-size:9px">${isSpot ? 'SPOT' : 'PERP'}</span>
        <span class="watch-result-price">${px ? '$' + fmtPrice(px) : '—'}</span>
      </span>
    </div>`
  ).join('')
}

window.__mobWatchAdd = function(coin) {
  const list = loadWatchlist()
  if (!list.includes(coin)) {
    list.push(coin)
    saveWatchlist(list)
    delete _watchData[coin]
  }
  const inp = document.getElementById('mobWatchSearchInput')
  const res = document.getElementById('mobWatchSearchResults')
  if (inp) inp.value = ''
  if (res) { res.style.display = 'none'; res.innerHTML = '' }
  updateWatchTicker()
  refreshWatchTab()
  updateMobileView()
}

window.__mobWatchRemove = function(coin) {
  const list = loadWatchlist().filter(c => c !== coin)
  saveWatchlist(list)
  delete _watchData[coin]
  updateWatchTicker()
  refreshWatchTab()
  updateMobileView()
}

// Hook switchTab to load watch data and refresh defi cards
const _origSwitchTab = window.switchTab
window.switchTab = function(name, btn) {
  _origSwitchTab(name, btn)
  if (name === 'watch')      refreshWatchTab()
  if (name === 'strategies') _applyGridDefaults('grid-coin', 'grid-lower', 'grid-upper')
  if (name === 'portfolio') { window.__updateDepositPreview(); window.__updateWithdrawPreview() }
  if (name === 'trade' && !state.selectedCoin && state.allMids?.['BTC']) {
    window.__selectCoin('BTC')
  }
  if (name === 'trade' && state.selectedCoin) {
    _ensureMarketData().then(() => updateChartStats(state.selectedCoin))
    // (Re)render the chart now the tab is visible so Chart.js sizes the canvas correctly
    loadTradeChart(state.selectedCoin)
  }
}

// Init defi card buttons on load
window.__updateDepositPreview()
window.__updateWithdrawPreview()

// ─── DEV MODE ─────────────────────────────────────────────────────────────────
function isDev() {
  return localStorage.getItem('hliq_dev') === '1'
}

let _pinResolve = null
function _showPinModal({ title, desc = '', confirmText = 'Confirm', placeholder = '••••••••', type = 'password' }) {
  return new Promise(resolve => {
    _pinResolve = resolve
    const modal = document.getElementById('pinModal')
    const input = document.getElementById('pinModalInput')
    document.getElementById('pinModalTitle').textContent = title
    document.getElementById('pinModalDesc').textContent  = desc
    document.getElementById('pinModalConfirmBtn').textContent = confirmText
    input.type        = type
    input.placeholder = placeholder
    input.value       = ''
    modal.style.display = 'flex'
    setTimeout(() => input.focus(), 50)
  })
}
window.__pinModalConfirm = function() {
  const val = document.getElementById('pinModalInput').value.trim()
  document.getElementById('pinModal').style.display = 'none'
  if (_pinResolve) { _pinResolve(val || null); _pinResolve = null }
}
window.__pinModalCancel = function() {
  document.getElementById('pinModal').style.display = 'none'
  if (_pinResolve) { _pinResolve(null); _pinResolve = null }
}

function _applyDevMode() {
  const chk  = document.getElementById('devModeToggle')
  const desc = document.getElementById('devModeDesc')
  const on   = isDev()
  if (chk)  chk.checked = on
  if (desc) desc.textContent = on
    ? 'Dev mode active — leaderboard management, bot strategies, and profile pic editing unlocked'
    : 'Unlock leaderboard management, bot strategies, and profile pic editing. Requires PIN.'
  document.querySelectorAll('.dev-only').forEach(el => { el.style.display = on ? '' : 'none' })
}

window.toggleDevMode = async function(wantOn) {
  if (!wantOn) {
    localStorage.removeItem('hliq_dev')
    _applyDevMode()
    return
  }
  const pin = await _showPinModal({
    title: 'Activate Dev Mode',
    desc:  'Enter the leaderboard PIN to unlock management controls.',
    confirmText: 'Activate',
  })
  if (!pin) { _applyDevMode(); return }
  try {
    const current = await _lbLoad()
    const r = await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-lb-pin': pin },
      body: JSON.stringify({ addrs: current }),
    })
    if (r.status === 403) {
      await _showPinModal({ title: 'Wrong PIN', desc: 'The PIN you entered is incorrect.', confirmText: 'OK', type: 'text' })
      _applyDevMode(); return
    }
    localStorage.setItem('hliq_lb_pin', pin)
    localStorage.setItem('hliq_dev', '1')
  } catch {
    await _showPinModal({ title: 'Error', desc: 'Could not reach the server.', confirmText: 'OK', type: 'text' })
  }
  _applyDevMode()
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
const _LB_LS_KEY = 'hliq_lb_extra'

async function _lbLoad() {
  try {
    const r = await fetch('/api/leaderboard')
    if (!r.ok) throw new Error()
    const data = await r.json()
    // normalize: server may store plain strings (legacy) or {addr,label} objects
    return data.map(x => typeof x === 'string' ? { addr: x, label: '' } : x)
  } catch {
    try { return JSON.parse(localStorage.getItem(_LB_LS_KEY) || '[]') } catch { return [] }
  }
}

function _lbGetPin() {
  return localStorage.getItem('hliq_lb_pin') || ''
}

async function _lbSave(addrs) {
  const pin = _lbGetPin()
  const r = await fetch('/api/leaderboard', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-lb-pin': pin },
    body: JSON.stringify({ addrs }),
  })
  if (r.status === 403) {
    localStorage.removeItem('hliq_lb_pin')
    throw Object.assign(new Error('wrong pin'), { isPinError: true })
  }
}

function _lbPosHtml(positions) {
  if (!positions.length) return `<div class="lb-no-pos">No open positions</div>`
  return `<table class="lb-pos-table">
    <thead><tr><th>Coin</th><th>Side</th><th>Size</th><th>Entry</th><th>PnL</th></tr></thead>
    <tbody>${positions.map(p => {
      const pos    = p.position
      const isLong = parseFloat(pos.szi) > 0
      const side   = isLong ? 'LONG' : 'SHORT'
      const pnl    = parseFloat(pos.unrealizedPnl ?? 0)
      const sideCls = isLong ? 'pos' : 'neg'
      const pnlCls  = pnl >= 0 ? 'pos' : 'neg'
      return `<tr>
        <td><b>${esc(coinLabel(pos.coin))}</b></td>
        <td class="${sideCls}">${side}</td>
        <td>${Math.abs(parseFloat(pos.szi))}</td>
        <td>$${fmtPrice(parseFloat(pos.entryPx ?? 0))}</td>
        <td class="${pnlCls}">${pnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(pnl))}</td>
      </tr>`
    }).join('')}</tbody>
  </table>`
}

function _lbOutcomesHtml(outcomes) {
  if (!outcomes?.length) return ''
  return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
    <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Outcomes</div>
    <table class="lb-pos-table">
      <thead><tr><th>Market</th><th>Side</th><th>Shares</th><th>Value</th><th>PnL</th></tr></thead>
      <tbody>${outcomes.map(b => {
        const n      = parseInt(String(b.coin).replace(/[^\d]/g, '')) || 0
        const oid    = Math.floor(n / 10)
        const tok    = state.ocTokenMap?.['#' + n] || {}
        const market = state.ocQuestionMap?.[oid] || tok.name || _ocCoinLabel(b.coin)
        const side   = tok.side || _ocCoinLabel(b.coin)
        const pnlCls = b.pnl >= 0 ? 'pos' : 'neg'
        return `<tr>
          <td><b>${esc(market)}</b></td>
          <td>${esc(side)}</td>
          <td>${fmtSize(b.total)}</td>
          <td>$${fmtUSD(b.value)}</td>
          <td class="${pnlCls}">${b.pnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(b.pnl))}<span style="font-size:10px;opacity:0.65;margin-left:4px">(${b.roe >= 0 ? '+' : ''}${b.roe.toFixed(1)}%)</span></td>
        </tr>`
      }).join('')}</tbody>
    </table>
  </div>`
}

function _lbOrdersHtml(openOrders) {
  if (!openOrders?.length) return ''
  return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
    <div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">Open Orders</div>
    <table class="lb-pos-table">
      <thead><tr><th>Coin</th><th>Side</th><th>Size</th><th>Limit</th><th>Type</th></tr></thead>
      <tbody>${openOrders.map(o => {
        const isBuy  = o.side === 'B'
        const sideCls = isBuy ? 'pos' : 'neg'
        const sideStr = isBuy ? 'BUY' : 'SELL'
        const sz   = Math.abs(parseFloat(o.sz ?? 0))
        const px   = parseFloat(o.limitPx ?? 0)
        const type = o.orderType ?? o.tif ?? '—'
        return `<tr>
          <td><b>${esc(_ocCoinLabel(o.coin))}</b></td>
          <td class="${sideCls}">${sideStr}</td>
          <td>${sz}</td>
          <td>$${fmtPrice(px)}</td>
          <td style="color:var(--muted)">${esc(type)}</td>
        </tr>`
      }).join('')}</tbody>
    </table>
  </div>`
}

function _lbPnl(val, err) {
  if (err) return '—'
  return (val >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(val))
}

function _lbPct(val, acctVal, err) {
  if (err || !acctVal) return ''
  const pct = (val / acctVal) * 100
  return `<span style="font-size:10px;opacity:0.65;margin-left:4px">(${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)</span>`
}

function _lbRankHtml(rank) {
  if (rank === 1) return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#f0b429" stroke-width="1.5" stroke-linejoin="round"><path d="M2 12h12"/><path d="M3 12 2 5.5l3.5 2.5L8 2l2.5 6 3.5-2.5L13 12z"/></svg>`
  if (rank === 2) return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#a8a8be" stroke-width="1.5"><circle cx="8" cy="9.5" r="4.5"/><rect x="6" y="2" width="4" height="3" rx="0.5" stroke-linejoin="round"/><line x1="6" y1="5" x2="8" y2="5"/><line x1="10" y1="5" x2="8" y2="5"/></svg>`
  if (rank === 3) return `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="#c07a3a" stroke-width="1.5"><circle cx="8" cy="9.5" r="4.5"/><rect x="6" y="2" width="4" height="3" rx="0.5" stroke-linejoin="round"/><line x1="6" y1="5" x2="8" y2="5"/><line x1="10" y1="5" x2="8" y2="5"/></svg>`
  return `<span class="lb-rank-num">${rank}</span>`
}

function _lbAvatarHtml(addr, size) {
  const hue  = parseInt(addr.slice(2, 8), 16) % 360
  const init = (addr.slice(2, 3) + addr.slice(3, 4)).toUpperCase()
  const fallback = `this.replaceWith(Object.assign(document.createElement('div'),{style:'width:${size}px;height:${size}px;border-radius:50%;background:oklch(0.52 0.2 ${hue});display:flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.38)}px;color:#fff;flex-shrink:0',textContent:'${init}'}))`
  return `<img src="/pfp/${addr.toLowerCase()}" width="${size}" height="${size}" style="border-radius:50%;object-fit:cover;display:block;flex-shrink:0" onerror="${fallback}">`
}

function _lbRowHtml(entry, rank) {
  const short  = entry.addr.slice(0, 8) + '…' + entry.addr.slice(-5)
  const valStr = entry.error ? '<span class="lb-err">Error</span>' : '$' + fmtUSD(entry.accountValue)
  const uid    = 'lbx-' + entry.addr.slice(2, 10)
  const uCls   = entry.unrealizedPnl >= 0 ? 'pos' : 'neg'
  const rCls   = entry.realizedPnl   >= 0 ? 'pos' : 'neg'
  const nCls   = entry.netPnl        >= 0 ? 'pos' : 'neg'

  let avatarHtml
  if (rank === 1) {
    avatarHtml = `<div style="flex-shrink:0;width:36px;display:flex;flex-direction:column;align-items:center;gap:2px"><div style="font-size:16px;line-height:1">👑</div>${_lbAvatarHtml(entry.addr, 36)}</div>`
  } else if (rank === 2) {
    avatarHtml = `<div style="position:relative;flex-shrink:0;width:36px;height:36px">${_lbAvatarHtml(entry.addr, 36)}<div style="position:absolute;bottom:-3px;right:-3px;width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,#D8D8D8,#A8A8A8);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#444;border:1.5px solid var(--bg)">2</div></div>`
  } else if (rank === 3) {
    avatarHtml = `<div style="position:relative;flex-shrink:0;width:36px;height:36px">${_lbAvatarHtml(entry.addr, 36)}<div style="position:absolute;bottom:-3px;right:-3px;width:16px;height:16px;border-radius:50%;background:linear-gradient(135deg,#E8A96A,#B87333);display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:800;color:#5a2a00;border:1.5px solid var(--bg)">3</div></div>`
  } else {
    avatarHtml = `<div style="position:relative;flex-shrink:0;width:36px;height:36px">${_lbAvatarHtml(entry.addr, 36)}<div style="position:absolute;bottom:-3px;right:-3px;min-width:15px;height:15px;border-radius:8px;background:var(--panel-3);display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;color:var(--muted);padding:0 3px;border:1.5px solid var(--bg)">${rank}</div></div>`
  }

  return `
    <tr class="lb-row" onclick="window.__lbToggle('${uid}', this)">
      <td class="lb-rank">${_lbRankHtml(rank)}</td>
      <td class="lb-identity">
        ${avatarHtml}
        <div>
          ${entry.label ? `<div class="lb-label">${esc(entry.label)}</div>` : ''}
          <div class="lb-addr-short">${short}</div>
        </div>
      </td>
      <td class="lb-val">${valStr}</td>
      <td class="lb-pnl ${uCls}">${_lbPnl(entry.unrealizedPnl, entry.error)}</td>
      <td class="lb-pnl ${rCls} lb-col-full">${_lbPnl(entry.realizedPnl, entry.error)}${_lbPct(entry.realizedPnl, entry.accountValue, entry.error)}</td>
      <td class="lb-pnl ${nCls} lb-col-full">${_lbPnl(entry.netPnl, entry.error)}${_lbPct(entry.netPnl, entry.accountValue, entry.error)}</td>
      <td class="lb-chev">▶</td>
    </tr>
    <tr class="lb-expand" id="${uid}" style="display:none">
      <td colspan="7"><div class="lb-expand-inner">
        <div class="lb-expand-header">
          <div style="display:flex;align-items:center;gap:12px">
            ${_lbAvatarHtml(entry.addr, 44)}
            <div class="lb-expand-identity">
              ${entry.label ? `<span class="lb-expand-label">${esc(entry.label)}</span>` : ''}
              <span class="lb-expand-addr-row">
                <span class="lb-expand-addr">${entry.addr.slice(0, 10)}…${entry.addr.slice(-6)}</span>
                <button class="lb-copy-btn" onclick="event.stopPropagation();window.__lbCopy('${esc(entry.addr)}',this)">⎘ copy</button>
              </span>
            </div>
          </div>
          ${isDev() ? `<button class="lb-rename-btn" onclick="event.stopPropagation();window.__lbRename('${esc(entry.addr)}')">✎ Rename</button>` : ''}
        </div>
        ${entry.error ? `<div class="lb-err">${entry.error}</div>` : `
          <div class="lb-pnl-breakdown">
            <div class="lb-pnl-item">
              <span class="lb-pnl-lbl">Unrealized PnL</span>
              <span class="lb-pnl-val ${uCls}">${_lbPnl(entry.unrealizedPnl, null)}</span>
            </div>
            <div class="lb-pnl-item">
              <span class="lb-pnl-lbl">Realized PnL</span>
              <span class="lb-pnl-val ${rCls}">${_lbPnl(entry.realizedPnl, null)}</span>
            </div>
            <div class="lb-pnl-item">
              <span class="lb-pnl-lbl">Net PnL</span>
              <span class="lb-pnl-val ${nCls}">${_lbPnl(entry.netPnl, null)}</span>
            </div>
          </div>
          ${_lbPosHtml(entry.positions)}
          ${_lbOutcomesHtml(entry.outcomes)}
          ${_lbOrdersHtml(entry.openOrders)}`}
      </div></td>
    </tr>`
}

// Prediction-outcome holdings live in spotClearinghouseState as "+N"/"#N"/"oN" coins.
const _lbIsOutcome = c => typeof c === 'string' && (c[0] === '+' || c[0] === '#' || /^o\d/.test(c))

// Ensure the all-dex perp metas + outcome token map are loaded so the leaderboard
// can resolve HIP-3 dexes and prediction-market names even without a loaded account.
async function _lbEnsureMetas() {
  if (!state.allMetas || !state.allMetas.length) {
    try { state.allMetas = await infoClient.allPerpMetas() } catch {}
  }
  _hydrateOcTokenMap()   // instant names from cache, even if the fetch below fails
  if (!state.ocTokenMap || !Object.keys(state.ocTokenMap).length) {
    // Retry a few times — a single flaky fetch shouldn't leave rows showing "#numbers".
    for (let i = 0; i < 3; i++) {
      try { _buildOcTokenMap(await infoClient.outcomeMeta()); break } catch {}
      await new Promise(r => setTimeout(r, 400 * (i + 1)))
    }
  }
}

// HIP-3 (TradFi) positions/orders for one wallet, fanned across every builder dex.
// Cached per address with a 60s TTL so the 30s leaderboard poll doesn't multiply
// API load by the dex count on every tick.
const _lbHip3ByAddr = {}
async function _lbFetchHip3(addr) {
  const dexes = [...new Set((state.allMetas || []).slice(1)
    .map(m => (m.universe?.[0]?.name || '').split(':')[0].toLowerCase()).filter(Boolean))]
  const out = { ts: Date.now(), positions: [], orders: [] }
  if (!dexes.length) return out
  const info = new InfoClient({ transport: _transport })
  await Promise.all(dexes.map(async dex => {
    try {
      const [cs, oo] = await Promise.all([
        info.clearinghouseState({ user: addr, dex }),
        info.frontendOpenOrders({ user: addr, dex }).catch(() => []),
      ])
      for (const ap of (cs?.assetPositions ?? [])) {
        if (parseFloat(ap.position?.szi ?? 0) === 0) continue
        const c = ap.position.coin.includes(':') ? ap.position.coin : `${dex}:${ap.position.coin}`
        out.positions.push({ ...ap, position: { ...ap.position, coin: hip3Rename(c) } })
      }
      for (const o of (oo ?? [])) {
        const c = o.coin.includes(':') ? o.coin : `${dex}:${o.coin}`
        out.orders.push({ ...o, coin: hip3Rename(c) })
      }
    } catch {}
  }))
  return out
}

// Live mid for a prediction outcome, cached per market with a 60s TTL (shared
// across wallets — the same outcome resolves to the same price).
const _lbOcMarkCache = {}
async function _lbOcMark(coin, info) {
  const c = _lbOcMarkCache[coin]
  if (c && Date.now() - c.ts < 60_000) return c.px
  let px = 0
  try {
    const n    = parseInt(String(coin).replace(/[^\d]/g, '')) || 0
    const book = await info.l2Book({ coin: '#' + n })
    const bid  = parseFloat(book?.levels?.[0]?.[0]?.px ?? 0)
    const ask  = parseFloat(book?.levels?.[1]?.[0]?.px ?? 0)
    px = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask || 0)
  } catch {}
  _lbOcMarkCache[coin] = { px, ts: Date.now() }
  return px
}

async function _lbFetchResults(entries) {
  const GENESIS = 1667260800000
  const info    = new InfoClient({ transport: _transport })
  const results = []
  await _lbEnsureMetas()
  const _fetchOne = async (entry) => {
    const key = entry.addr.toLowerCase()
    let hip3 = _lbHip3ByAddr[key]
    const hip3Pending = (!hip3 || Date.now() - hip3.ts > 60_000)
      ? _lbFetchHip3(entry.addr).then(h => { _lbHip3ByAddr[key] = h; return h })
      : Promise.resolve(hip3)
    const [cs, portfolio, fills, funding, openOrders, spotState, hip3Res] = await Promise.all([
      info.clearinghouseState({ user: entry.addr }),
      info.portfolio({ user: entry.addr }).catch(() => []),
      info.userFillsByTime({ user: entry.addr, startTime: GENESIS, reversed: true })
        .catch(() => info.userFills({ user: entry.addr }).catch(() => [])),
      info.userFunding({ user: entry.addr, startTime: GENESIS }).catch(() => []),
      info.frontendOpenOrders({ user: entry.addr }).catch(() => []),
      info.spotClearinghouseState({ user: entry.addr }).catch(() => null),
      hip3Pending.catch(() => ({ positions: [], orders: [] })),
    ])
    const positions        = cs.assetPositions ?? []
    const allTimePort      = (portfolio ?? []).find(p => p[0] === 'allTime')
    const acctValHist      = allTimePort?.[1]?.accountValueHistory ?? []
    const portfolioAcctVal = acctValHist.length ? parseFloat(acctValHist.at(-1)[1]) : null
    const _perpAcctVal     = parseFloat(cs.marginSummary?.accountValue ?? 0)
    const _spotUSDCTotal   = parseFloat((spotState?.balances ?? []).find(b => b.coin === 'USDC')?.total ?? 0)
    // HL "Portfolio Value" — the portfolio endpoint is HL's own unified account
    // value (unified USDC already contains perp equity; perp+spot only as fallback)
    const accountValue     = portfolioAcctVal ?? (_perpAcctVal + _spotUSDCTotal)
    // Denominator of HL's Unified Account Ratio — cached for the light refresh
    const _marginBase      = _spotUSDCTotal > 0 ? _spotUSDCTotal : _perpAcctVal
    const unrealizedPnl    = positions.reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0)
    const realizedPnl      = fills.reduce((s, f) => s + parseFloat(f.closedPnl ?? 0), 0)
    const totalFees        = fills.reduce((s, f) => s + parseFloat(f.fee ?? 0), 0)
    const allTimeFunding   = funding.reduce((s, f) => s + parseFloat(f.delta?.usdc ?? 0), 0)
    const netPnl           = realizedPnl + unrealizedPnl + allTimeFunding - totalFees
    const maintMargin      = parseFloat(cs.crossMaintenanceMarginUsed ?? 0)
    // Health = 100 − HL's Unified Account Ratio (maint / unified USDC balance)
    const healthPct        = _marginBase > 0 ? Math.max(0, (1 - maintMargin / _marginBase) * 100) : 0
    const healthCls        = healthPct > 60 ? 'pos' : healthPct > 30 ? 'warn' : 'neg'
    const withdrawable     = parseFloat(cs.withdrawable ?? 0)
    const totalVolume      = fills.reduce((s, f) => s + parseFloat(f.sz ?? 0) * parseFloat(f.px ?? 0), 0)
    let grossWin = 0, grossLoss = 0
    const ONE_HOUR = 3600000
    const _windows = {}
    for (const f of fills) {
      const pnl = parseFloat(f.closedPnl ?? 0)
      if (pnl > 0) grossWin += pnl
      else if (pnl < 0) grossLoss += Math.abs(pnl)
      if (pnl !== 0) {
        const key = `${f.coin}_${Math.floor(+f.time / ONE_HOUR)}`
        _windows[key] = (_windows[key] ?? 0) + pnl - parseFloat(f.fee ?? 0)
      }
    }
    const _allW        = Object.values(_windows)
    const winCount     = _allW.filter(n => n > 0).length
    const totalWindows = _allW.length
    const chartFills   = fills.map(f => ({ time: +f.time, closedPnl: parseFloat(f.closedPnl ?? 0), coin: f.coin, fee: parseFloat(f.fee ?? 0), sz: parseFloat(f.sz ?? 0), px: parseFloat(f.px ?? 0), notional: parseFloat(f.sz ?? 0) * parseFloat(f.px ?? 0), dir: f.dir ?? '', hash: f.hash ?? '' }))
    // Merge HIP-3 (TradFi) positions/orders for display; outcomes come from spot balances.
    const allPositions = [...positions, ...(hip3Res?.positions ?? [])]
    const allOrders    = [...openOrders, ...(hip3Res?.orders ?? [])]
    const ocRaw        = (spotState?.balances ?? []).filter(b => _lbIsOutcome(b.coin) && parseFloat(b.total ?? 0) > 0)
    const outcomes     = await Promise.all(ocRaw.map(async b => {
      const mark  = await _lbOcMark(b.coin, info)
      const total = parseFloat(b.total ?? 0), cost = parseFloat(b.entryNtl ?? 0)
      const entry = total > 0 ? cost / total : 0
      const m     = mark > 0 ? mark : entry
      const pnl   = (m - entry) * total
      return { coin: b.coin, total, hold: parseFloat(b.hold ?? 0), cost, entry, mark: m, value: total * m, pnl, roe: cost > 0 ? pnl / cost * 100 : 0 }
    }))
    return { ...entry, accountValue, _marginBase, maintMargin, healthPct, healthCls, unrealizedPnl, realizedPnl, netPnl, totalFees, allTimeFunding, withdrawable, totalVolume, totalDeposited: 0, totalWithdrawn: 0, grossWin, grossLoss, winCount, totalWindows, positions: allPositions, openOrders: allOrders, outcomes, portfolio, fills: chartFills, error: null }
  }

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 150))
    const entry = entries[i]
    let ok = false
    for (let attempt = 0; attempt < 8; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, Math.min(500 * attempt, 4000)))
      try {
        results.push(await _fetchOne(entry))
        ok = true
        break
      } catch {}
    }
    if (!ok) results.push({ ...entry, accountValue: 0, unrealizedPnl: 0, realizedPnl: 0, netPnl: 0, positions: [], error: 'Failed to load' })
  }
  results.sort((a, b) => b.accountValue - a.accountValue)
  return results
}

async function _lbSilentUpdate() {
  if (_lbFetching) return
  const root = document.getElementById('leaderboardRoot')
  if (!root) return
  const tbody = root.querySelector('.lb-table tbody')
  if (!tbody) return

  _lbFetching = true
  try {
    const entries = await _lbLoad()
    if (!entries.length) return

    // Save which expand rows are open
    const openUids = new Set()
    tbody.querySelectorAll('tr[id^="lb-expand-"]').forEach(tr => {
      if (tr.style.display !== 'none') openUids.add(tr.id)
    })

    const results = await _lbFetchResults(entries)
    _lbLastFetch = Date.now()

    // Re-render tbody only if data changed
    const newLbKey = results.map(r => `${r.addr}:${r.accountValue.toFixed(2)}:${r.healthPct?.toFixed(1)}`).join('|')
    if (tbody.dataset.lbHash === newLbKey) return
    tbody.innerHTML = results.map((r, i) => _lbRowHtml(r, i + 1)).join('')
    tbody.dataset.lbHash = newLbKey

    // Restore expanded rows
    openUids.forEach(uid => {
      const row = document.getElementById(uid)
      if (!row) return
      row.style.display = ''
      const mainRow = row.previousElementSibling
      if (mainRow) {
        const chev = mainRow.querySelector('.lb-chev')
        if (chev) chev.textContent = '▼'
      }
    })

    // Update count
    const countEl = root.querySelector('.lb-count')
    if (countEl) countEl.textContent = `${results.length} wallet${results.length !== 1 ? 's' : ''}`
  } finally {
    _lbFetching = false
  }
}

async function renderLeaderboard() {
  if (_lbFetching) return
  const root = document.getElementById('leaderboardRoot')
  if (!root) return

  root.innerHTML = `<div class="lb-loading">Fetching wallets…</div>`
  _lbFetching = true

  let entries, results
  try {
    entries = await _lbLoad()

    if (!entries.length) {
      root.innerHTML = `<div class="lb-empty">${isDev() ? 'Add wallet addresses below to start tracking.' : 'No wallets tracked yet.'}</div>`
      if (isDev()) root.appendChild(_lbFormEl(entries))
      return
    }

    results = await _lbFetchResults(entries)
    _lbLastFetch = Date.now()
  } finally {
    _lbFetching = false
  }

  root.innerHTML = `
    <div class="lb-toolbar">
      <div class="lb-count">${results.length} wallet${results.length !== 1 ? 's' : ''}</div>
      <button class="btn-sm" onclick="renderLeaderboard()">↻ Refresh</button>
    </div>
    <div class="table-wrap">
      <table class="lb-table">
        <thead><tr>
          <th>#</th>
          <th>Wallet</th>
          <th><span class="lb-col-full">Account Value</span><span class="lb-col-mob">Value</span></th>
          <th><span class="lb-col-full">Unrealized PnL</span><span class="lb-col-mob">Unr. PnL</span></th>
          <th class="lb-col-full"><span class="lb-col-full">Realized PnL</span></th>
          <th class="lb-col-full"><span class="lb-col-full">Net PnL</span></th>
          <th></th>
        </tr></thead>
        <tbody>${results.map((r, i) => _lbRowHtml(r, i + 1)).join('')}</tbody>
      </table>
    </div>`
  if (isDev()) root.appendChild(_lbFormEl(entries))
}

function _lbFormEl(entries) {
  const div = document.createElement('div')
  div.className = 'lb-form'
  div.innerHTML = `
    <div class="lb-form-title">Tracked Addresses</div>
    <div class="lb-extras" id="lbExtrasList">
      ${entries.length ? entries.map(e => `
        <div class="lb-extra-row">
          <span class="lb-extra-name">${esc(e.label || e.addr.slice(0, 8) + '…' + e.addr.slice(-5))}</span>
          <span class="lb-extra-addr-sub">${e.label ? e.addr.slice(0, 6) + '…' + e.addr.slice(-4) : ''}</span>
          <button class="lb-edit" onclick="window.__lbRename('${esc(e.addr)}')">✎</button>
          <button class="lb-remove" onclick="window.__lbRemove('${esc(e.addr)}')">✕</button>
        </div>`).join('') : '<div class="lb-extras-empty">None added yet</div>'}
    </div>
    <div class="lb-add-row">
      <input class="lb-input" id="lbAddrInput" placeholder="0x… wallet address" />
      <input class="lb-input lb-name-input" id="lbLabelInput" placeholder="Name (optional)" />
      <button class="btn-sm" onclick="window.__lbAdd()">Add</button>
    </div>`
  return div
}

window.__lbCopy = function(addr, btn) {
  navigator.clipboard.writeText(addr).then(() => {
    const orig = btn.textContent
    btn.textContent = '✓ copied'
    btn.style.color = 'var(--accent)'
    btn.style.borderColor = 'var(--accent)'
    setTimeout(() => { btn.textContent = orig; btn.style.color = ''; btn.style.borderColor = '' }, 1500)
  })
}

window.__lbToggle = function(uid, tr) {
  const row  = document.getElementById(uid)
  if (!row) return
  const open = row.style.display === 'none'
  row.style.display = open ? '' : 'none'
  const chev = tr.querySelector('.lb-chev')
  if (chev) chev.textContent = open ? '▼' : '▶'
}

async function _lbWithPin(fn) {
  if (!_lbGetPin()) {
    const p = await _showPinModal({ title: 'Leaderboard PIN', desc: 'Enter your PIN to modify the leaderboard.', confirmText: 'Confirm' })
    if (!p) return
    localStorage.setItem('hliq_lb_pin', p)
  }
  try {
    await fn()
  } catch (e) {
    if (e.isPinError) {
      await _showPinModal({ title: 'Wrong PIN', desc: 'PIN cleared. Try the action again.', confirmText: 'OK', type: 'text' })
    } else {
      throw e
    }
  }
}

window.__lbAdd = async function() {
  const addr  = document.getElementById('lbAddrInput')?.value?.trim()
  const label = document.getElementById('lbLabelInput')?.value?.trim() || ''
  if (!addr || !addr.startsWith('0x') || addr.length < 42) return
  await _lbWithPin(async () => {
    const entries = await _lbLoad()
    if (entries.some(e => e.addr.toLowerCase() === addr.toLowerCase())) return
    entries.push({ addr, label })
    await _lbSave(entries)
    renderLeaderboard()
  })
}

window.__lbRemove = async function(addr) {
  await _lbWithPin(async () => {
    const entries = await _lbLoad()
    await _lbSave(entries.filter(e => e.addr.toLowerCase() !== addr.toLowerCase()))
    renderLeaderboard()
  })
}

window.__lbRename = async function(addr) {
  const entries = await _lbLoad()
  const entry   = entries.find(e => e.addr.toLowerCase() === addr.toLowerCase())
  const name    = await _showPinModal({
    title: 'Rename Wallet',
    desc:  entry?.addr.slice(0, 10) + '…' + entry?.addr.slice(-6),
    confirmText: 'Save',
    placeholder: entry?.label || 'Wallet name',
    type: 'text',
  })
  if (name === null) return
  await _lbWithPin(async () => {
    const latest = await _lbLoad()
    const idx = latest.findIndex(e => e.addr.toLowerCase() === addr.toLowerCase())
    if (idx !== -1) latest[idx].label = name.trim()
    await _lbSave(latest)
    renderLeaderboard()
  })
}

window.__lbChangePic = function(addr) {
  const input = document.createElement('input')
  input.type   = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'
  document.body.appendChild(input)
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    document.body.removeChild(input)
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      const dataUrl = reader.result
      if (!dataUrl?.startsWith('data:image/')) return
      try {
        const r = await fetch(`/pfp/${addr.toLowerCase()}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dataUrl }),
        })
        if (!r.ok) { alert('Failed to upload profile pic'); return }
        // Bust browser cache for every avatar img showing this addr
        const ts = Date.now()
        document.querySelectorAll(`img[src^="/pfp/${addr.toLowerCase()}"]`).forEach(img => {
          img.src = `/pfp/${addr.toLowerCase()}?v=${ts}`
        })
      } catch { alert('Upload failed — is the server running?') }
    }
    reader.readAsDataURL(file)
  })
  input.click()
}

// ─── MULTI-ACCOUNT ────────────────────────────────────────────────────────────
const _MA_HIDDEN_KEY = 'hliq_ma_hidden'

function _maHiddenLoad() {
  try { return new Set(JSON.parse(localStorage.getItem(_MA_HIDDEN_KEY) || '[]')) } catch { return new Set() }
}
function _maHiddenSave(s) { localStorage.setItem(_MA_HIDDEN_KEY, JSON.stringify([...s])) }

function _maLoad() {
  return WM.load()
}

function _maCardHtml(r) {
  const hidden   = _maHiddenLoad().has(r.addr)
  const unreal   = fmtPnL(r.unrealizedPnl)
  const real     = fmtPnL(r.realizedPnl)
  const net      = fmtPnL(r.netPnl)
  const hPct     = r.healthPct ?? 0
  const hCls     = r.healthCls ?? 'pos'
  const hStr     = r.accountValue > 0 ? hPct.toFixed(1) + '%' : '—'
  const dispName = r.label || (r.addr.slice(0, 8) + '…' + r.addr.slice(-5))
  const dispAddr = r.label ? r.addr.slice(0, 8) + '…' + r.addr.slice(-5) : ''
  const eyeIcon  = hidden
    ? `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><line x1="2" y1="2" x2="14" y2="14"/><path d="M6.5 6.6A2 2 0 009.4 9.5"/><path d="M4 4.3A7 7 0 001 8s2.5 5 7 5a6.8 6.8 0 003.7-1.1"/><path d="M12.5 12A7 7 0 0015 8s-2.5-5-7-5c-1 0-2 .2-2.8.6"/></svg>`
    : `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg>`
  return `
  <div class="ma-card${r.error ? ' ma-card-err' : ''}${hidden ? ' ma-card-hidden' : ''}">
    <div class="ma-card-head">
      <div class="ma-card-identity">
        <div class="ma-card-name">${esc(dispName)}</div>
        ${dispAddr ? `<div class="ma-card-addr">${esc(dispAddr)}</div>` : ''}
      </div>
      <div class="ma-card-actions">
        <button class="lb-edit" onclick="window.__maToggleHide('${esc(r.addr)}')" title="${hidden ? 'Show' : 'Hide'}">${eyeIcon}</button>
        <button class="lb-edit" onclick="window.__maRename('${esc(r.addr)}')">✎</button>
        <button class="lb-remove" onclick="window.__maRemove('${esc(r.addr)}')">✕</button>
      </div>
    </div>
    ${r.error
      ? `<div class="ma-error">Failed to load</div>`
      : (() => {
          const addrKey = r.addr.toLowerCase()
          const runningBots = (_maBotStatus[addrKey] ?? [])
          const botsHtml = runningBots.length
            ? `<div class="ma-bots-row">${runningBots.map(t => `<span class="ma-bot-pill">${t}</span>`).join('')}</div>`
            : ''
          return `<div class="ma-card-value">$${fmtUSD(r.accountValue)}</div>
         <div class="stat-health-bar" style="margin:8px 0 4px"><div class="stat-health-fill ${hCls}" style="width:${Math.min(100, hPct).toFixed(1)}%"></div></div>
         <div class="ma-card-grid">
           <div class="ma-stat"><span class="ma-stat-lbl">Health</span><span class="ma-stat-val ${hCls}">${hStr}</span></div>
           <div class="ma-stat"><span class="ma-stat-lbl">Positions</span><span class="ma-stat-val">${r.positions.length} open</span></div>
           <div class="ma-stat"><span class="ma-stat-lbl">Unrealized</span><span class="ma-stat-val ${unreal.cls}">${unreal.text}</span></div>
           <div class="ma-stat"><span class="ma-stat-lbl">Realized</span><span class="ma-stat-val ${real.cls}">${real.text}</span></div>
           <div class="ma-stat"><span class="ma-stat-lbl">Net PnL</span><span class="ma-stat-val ${net.cls}">${net.text}</span></div>
         </div>${botsHtml}`
        })()
    }
  </div>`
}

function _maAggregateHtml(results) {
  const hidden = _maHiddenLoad()
  const vis    = results.filter(r => !hidden.has(r.addr))
  const totalValue  = vis.reduce((s, r) => s + (r.accountValue  ?? 0), 0)
  const totalUnreal = vis.reduce((s, r) => s + (r.unrealizedPnl ?? 0), 0)
  const totalNet    = vis.reduce((s, r) => s + (r.netPnl        ?? 0), 0)
  const totalReal   = vis.reduce((s, r) => s + (r.realizedPnl   ?? 0), 0)
  const unreal = fmtPnL(totalUnreal)
  const net    = fmtPnL(totalNet)
  const real   = fmtPnL(totalReal)
  return `
    <div class="stat-card"><div class="stat-label">Combined Value</div><div class="stat-value neu">$${fmtUSD(totalValue)}</div><div class="stat-sub">Sum of all visible accounts</div></div>
    <div class="stat-card"><div class="stat-label">Unrealized PnL</div><div class="stat-value ${unreal.cls}">${unreal.text}</div><div class="stat-sub">Combined open positions</div></div>
    <div class="stat-card"><div class="stat-label">Net PnL</div><div class="stat-value ${net.cls}">${net.text}</div><div class="stat-sub">Realized + unrealized + funding − fees</div></div>
    <div class="stat-card"><div class="stat-label">Realized PnL</div><div class="stat-value ${real.cls}">${real.text}</div><div class="stat-sub">Closed trades all-time</div></div>`
}

function _maStatsHtml(results) {
  const hidden = _maHiddenLoad()
  const vis = results.filter(r => !hidden.has(r.addr) && !r.error)
  const sum = k => vis.reduce((s, r) => s + (r[k] ?? 0), 0)

  const totalDeposited = sum('totalDeposited')
  const totalWithdrawn = sum('totalWithdrawn')
  const withdrawable   = sum('withdrawable')
  const totalVolume    = sum('totalVolume')
  const allTimeFunding = sum('allTimeFunding')
  const totalFees      = sum('totalFees')
  const grossWin       = sum('grossWin')
  const grossLoss      = sum('grossLoss')
  const winCount       = sum('winCount')
  const totalWindows   = sum('totalWindows')

  const pfNum        = grossLoss > 0 ? grossWin / grossLoss : null
  const profitFactor = pfNum === null ? (grossWin > 0 ? 'No losses' : '—') : pfNum.toFixed(2)
  const pfCls        = pfNum === null ? 'neu' : pfNum >= 1 ? 'pos' : 'neg'
  const wrPct        = totalWindows > 0 ? winCount / totalWindows * 100 : null
  const winRate      = wrPct === null ? '—' : wrPct.toFixed(1) + '%'
  const wrCls        = wrPct === null ? 'neu' : wrPct >= 50 ? 'pos' : 'neg'

  const cards = [
    { label: 'Total Deposited',  value: '$'  + fmtUSD(totalDeposited),    sub: 'All-time USDC bridged in',          cls: 'neu' },
    { label: 'Total Withdrawn',  value: '$'  + fmtUSD(totalWithdrawn),    sub: 'All-time USDC bridged out',         cls: 'neu' },
    { label: 'Withdrawable',     value: '$'  + fmtUSD(withdrawable),      sub: 'Perp + free spot USDC',             cls: 'pos' },
    { label: 'Total Volume',     value: '$'  + fmtCompact(totalVolume),   sub: 'Notional traded all-time',          cls: 'neu' },
    { label: 'All Time Funding', value: fmtPnL(allTimeFunding).text,      sub: 'Cumulative funding received',       cls: allTimeFunding >= 0 ? 'pos' : 'neg' },
    { label: 'Total Fees Paid',  value: '-$' + fmtUSD(totalFees),         sub: 'Paid to exchange across all fills', cls: 'neg' },
    { label: 'Profit Factor',    value: profitFactor,                      sub: 'Gross wins ÷ gross losses',         cls: pfCls },
    { label: 'Win Rate',         value: winRate,                           sub: 'Winning trade windows',             cls: wrCls },
  ]
  return cards.map(c => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls}">${c.value}</div>
      <div class="stat-sub">${c.sub}</div>
    </div>`).join('')
}

let _maCurrentPeriod = 'day'
let _maBotStatus = {}   // { "0xaddr": ["grid","dca",...] }
const _now = new Date()
let _maCalMonth = _now.getMonth()
let _maCalYear  = _now.getFullYear()
let _maCalFillHash = ''

function _maAggregatePortfolioData(results) {
  const hidden = _maHiddenLoad()
  const vis = results.filter(r => !hidden.has(r.addr) && !r.error && r.portfolio?.length)
  if (!vis.length) return null

  // Anchor the chart's latest point to the SAME live total the "Combined Value" stat
  // card shows (sum of every visible account's live accountValue). Portfolio-history
  // snapshots lag and omit accounts with no history, so without this the chart's last
  // point / hero under-reports vs the card. Append (or replace a very recent) last point.
  const liveTotal = results.filter(r => !hidden.has(r.addr)).reduce((s, r) => s + (r.error ? 0 : r.accountValue ?? 0), 0)
  const _appendLive = series => {
    if (!series.length || !(liveTotal > 0)) return series
    const now  = Date.now()
    const last = series[series.length - 1]
    return (last && now - last[0] < 60000)
      ? [...series.slice(0, -1), [now, String(liveTotal)]]
      : [...series, [now, String(liveTotal)]]
  }

  return ['day', 'week', 'month', 'allTime'].map(period => {
    const valSeries = [], pnlSeries = []
    for (const r of vis) {
      const entry = r.portfolio.find(p => p[0] === period)
      if (!entry) continue
      const vh = (entry[1].accountValueHistory ?? []).map(([ts, v]) => [+ts, parseFloat(v)]).filter(([,v]) => !isNaN(v)).sort((a,b) => a[0]-b[0])
      const ph = (entry[1].pnlHistory ?? []).map(([ts, v]) => [+ts, parseFloat(v)]).filter(([,v]) => !isNaN(v)).sort((a,b) => a[0]-b[0])
      if (vh.length) valSeries.push(vh)
      if (ph.length) pnlSeries.push(ph)
    }
    const sumSeries = series => {
      if (!series.length) return []
      const allTs = [...new Set(series.flatMap(s => s.map(([ts]) => ts)))].sort((a,b) => a-b)
      return allTs.map(ts => {
        let sum = 0
        for (const s of series) {
          for (let i = s.length - 1; i >= 0; i--) { if (s[i][0] <= ts) { sum += s[i][1]; break } }
        }
        return [ts, sum.toString()]
      })
    }
    return [period, { accountValueHistory: _appendLive(sumSeries(valSeries)), pnlHistory: sumSeries(pnlSeries) }]
  })
}

function _maRenderChartsFromResults(results, opts = {}) {
  const aggregated = _maAggregatePortfolioData(results)
  if (!aggregated) return
  const hidden = _maHiddenLoad()
  const vis = results.filter(r => !hidden.has(r.addr) && !r.error)
  const allFills = vis.flatMap(r => r.fills ?? [])
  renderAcctCharts(aggregated, _maCurrentPeriod, allFills, opts)
}

window.setAcctChartPeriod = function(period, btn) {
  _maCurrentPeriod = period
  document.querySelectorAll('.ma-period').forEach(b => b.classList.toggle('active', b.dataset.period === period))
  zoomAcctChartsToPeriod(period)
}

window.__maResetValZoom  = function() { renderAcctCharts._resetVal?.(); }
window.__maPnlResetZoom  = function() { renderAcctCharts._resetPnl?.(); }

window.setAcctPnlChart = function(type, btn) {
  document.querySelectorAll('.ma-pnl-tab').forEach(b => b.classList.toggle('active', b.dataset.pnl === type))
  setAcctPnlChartType(type)
}

const _maLedgerCache   = new Map()
const _MA_LEDGER_TTL   = 5 * 60 * 1000
const _maLastFullFetch = new Map()       // addr → timestamp of last full fills+ledger fetch
const _MA_FULL_FETCH_INTERVAL = 30 * 60 * 1000  // full refetch every 30 min per account

async function _maEnrichResults(results, forceRefreshLedger = false) {
  const GENESIS = 1667260800000
  const info    = new InfoClient({ transport: _transport })
  const enriched = results.map(r => ({ ...r }))
  for (let i = 0; i < enriched.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 150))
    const r = enriched[i]
    if (r.error) continue
    try {
      const now    = Date.now()
      const cached = _maLedgerCache.get(r.addr)
      let totalDeposited = 0, totalWithdrawn = 0, ledgerEntries = []
      if (!forceRefreshLedger && cached && now - cached.ts < _MA_LEDGER_TTL) {
        totalDeposited = cached.totalDeposited
        totalWithdrawn = cached.totalWithdrawn
        ledgerEntries  = cached.ledgerEntries ?? []
      } else {
        const ledger = await info.userNonFundingLedgerUpdates({ user: r.addr, startTime: GENESIS }).catch(() => [])
        ledgerEntries = ledger ?? []
        for (const e of ledgerEntries) {
          const t = e.delta?.type
          if (t === 'deposit') totalDeposited += parseFloat(e.delta.usdc ?? 0)
          else if (t === 'send' && e.delta?.token === 'USDC') totalDeposited += parseFloat(e.delta.usdcValue ?? 0)
          else if (t === 'withdraw') totalWithdrawn += parseFloat(e.delta.usdc ?? 0)
        }
        _maLedgerCache.set(r.addr, { totalDeposited, totalWithdrawn, ledgerEntries, ts: now })
      }
      const spotCs  = await info.spotClearinghouseState({ user: r.addr }).catch(() => ({ balances: [] }))
      const spotUSDC = (spotCs?.balances ?? []).find(b => b.coin === 'USDC')
      const spotFree = spotUSDC ? Math.max(0, parseFloat(spotUSDC.total ?? 0) - parseFloat(spotUSDC.hold ?? 0)) : 0
      enriched[i] = { ...r, totalDeposited, totalWithdrawn, withdrawable: r.withdrawable + spotFree, ledgerEntries }
    } catch {}
  }
  return enriched
}

async function renderMultiAccount() {
  const root = document.getElementById('multiAcctRoot')
  if (!root) return
  destroyAcctCharts()
  root.innerHTML = `<div class="ma-loading">Fetching accounts…</div>`
  const entries = _maLoad()
  if (!entries.length) {
    root.innerHTML = `<div class="ma-empty">No saved wallets yet — add one using the wallet switcher.</div>`
    return
  }
  const [results] = await Promise.all([
    _lbFetchResults(entries),
    serverFetch('/api/status/all').then(s => { _maBotStatus = s ?? {} }).catch(() => {}),
  ])
  root.__maResults = results
  // Stamp fetch time now so the 30s tick does light updates instead of re-fetching immediately
  const _t0 = Date.now()
  const _STAGGER_MS = 2 * 60 * 1000
  results.forEach((r, i) => !r.error && _maLastFullFetch.set(r.addr, _t0 + i * _STAGGER_MS))
  root.innerHTML = `
    <div class="stats-row ma-aggregate" style="grid-template-columns:repeat(4,1fr);margin-bottom:16px">
      ${_maAggregateHtml(results)}
    </div>
    <div class="stats-row" id="maStatsCards" style="grid-template-columns:repeat(4,1fr);margin-bottom:24px">
      ${_maStatsHtml(results)}
    </div>
    <div class="ma-charts-section">
      <div class="charts-two-col">
        <div class="chart-container">
          <div class="chart-header">
            <div class="section-title" style="margin:0">Combined Value</div>
            <div style="display:flex;align-items:center;gap:6px">
              <button id="maValResetZoom" class="ma-reset-zoom" style="display:none"
                onclick="maPortfolioChartInst?.resetZoom();this.style.display='none'">↺ Reset</button>
              <div class="chart-tabs" style="margin:0">
                <button class="chart-tab ma-period${_maCurrentPeriod==='day'?' active':''}"     data-period="day"     onclick="setAcctChartPeriod('day',this)">1D</button>
                <button class="chart-tab ma-period${_maCurrentPeriod==='week'?' active':''}"    data-period="week"    onclick="setAcctChartPeriod('week',this)">1W</button>
                <button class="chart-tab ma-period${_maCurrentPeriod==='month'?' active':''}"   data-period="month"   onclick="setAcctChartPeriod('month',this)">1M</button>
                <button class="chart-tab ma-period${_maCurrentPeriod==='allTime'?' active':''}" data-period="allTime" onclick="setAcctChartPeriod('allTime',this)">All</button>
              </div>
            </div>
          </div>
          <div class="portfolio-pnl-hero" id="maPortfolioValueHero"></div>
          <div class="chart-wrap"><canvas id="maPortfolioChart" style="cursor:crosshair"></canvas></div>
        </div>
        <div class="chart-container">
          <div class="chart-header">
            <div class="section-title" style="margin:0" id="maPnlChartTitle">Accumulative PnL</div>
            <div style="display:flex;align-items:center;gap:6px">
              <button id="maPnlResetZoom" class="ma-reset-zoom" style="display:none"
                onclick="maPnlChartInst?.resetZoom();this.style.display='none'">↺ Reset</button>
              <div class="chart-tabs" style="margin:0">
                <button class="chart-tab ma-pnl-tab active" data-pnl="accumulative" onclick="setAcctPnlChart('accumulative',this)">Accum.</button>
                <button class="chart-tab ma-pnl-tab"        data-pnl="realized"     onclick="setAcctPnlChart('realized',this)">Realized</button>
              </div>
            </div>
          </div>
          <div class="portfolio-pnl-hero" id="maPnlHero"></div>
          <div class="chart-wrap"><canvas id="maPnlChart" style="cursor:crosshair"></canvas></div>
        </div>
      </div>
      <div class="ma-charts-hint">Hover for value · use the timeframe tabs to change range</div>
    </div>
    <div class="multi-acct-grid" id="maGrid" style="margin-bottom:32px">
      ${results.map(r => _maCardHtml(r)).join('')}
    </div>
    <div class="ma-section-wrap">
      <div class="ma-section-header" onclick="maToggleSection('maPositionsBody',this)">
        <span class="section-title" style="margin:0">Positions</span>
        <span class="ma-section-chevron">▼</span>
      </div>
      <div id="maPositionsBody" class="ma-section-body"></div>
    </div>
    <div class="ma-section-wrap">
      <div class="ma-section-header" onclick="maToggleSection('maOrdersBody',this)">
        <span class="section-title" style="margin:0">Open Orders</span>
        <span class="ma-section-chevron">▼</span>
      </div>
      <div id="maOrdersBody" class="ma-section-body"></div>
    </div>
    <div class="section-title" style="margin:28px 0 12px">PnL Calendar</div>
    <div id="maCalendarRoot"></div>
    <div id="maCalDetail" class="cal-detail"></div>`
  setTimeout(() => _maRenderChartsFromResults(results), 50)
  setTimeout(() => _maRenderCalendar(results), 80)
  setTimeout(() => { _maRenderPositions(results); _maRenderOrders(results) }, 80)
  _maEnrichResults(results, true).then(enriched => {
    if (!root.querySelector('#maStatsCards')) return
    root.__maResults = enriched
    const agg = root.querySelector('.ma-aggregate')
    if (agg) agg.innerHTML = _maAggregateHtml(enriched)
    const statsEl = root.querySelector('#maStatsCards')
    if (statsEl) statsEl.innerHTML = _maStatsHtml(enriched)
    _maRenderCalendar(enriched)  // re-render with real ledger entries
    _maRenderPositions(enriched)
    _maRenderOrders(enriched)
  }).catch(() => {})
}

const _ACCT_COLORS = ['#00e5a0','#4d9fff','#c77dff','#ffd93d','#ff6b6b','#ff9f43','#00d2d3','#ff6b9d']

window.maToggleSection = function(id, btn) {
  const body = document.getElementById(id)
  if (!body) return
  const open = body.classList.toggle('ma-section-open')
  btn.querySelector('.ma-section-chevron').textContent = open ? '▲' : '▼'
}

window.maToggleAcct = function(id, btn) {
  const body = document.getElementById(id)
  if (!body) return
  const open = body.classList.toggle('ma-acct-open')
  btn.querySelector('.ma-acct-chevron').textContent = open ? '▲' : '▼'
}

function _maAcctBlocks(results, buildBlock) {
  const hidden = _maHiddenLoad()
  const vis    = results.filter(r => !r.error && !hidden.has(r.addr))
  if (!vis.length) return '<div class="ma-section-empty">No accounts loaded.</div>'
  const html = vis.map((r, i) => buildBlock(r, i, _ACCT_COLORS[i % _ACCT_COLORS.length])).filter(Boolean).join('')
  return html || '<div class="ma-section-empty">Nothing to show.</div>'
}

function _maRenderPositions(results) {
  const el = document.getElementById('maPositionsBody')
  if (!el) return
  el.innerHTML = _maAcctBlocks(results, (r, i, color) => {
    const label     = r.label || (r.addr.slice(0, 6) + '…')
    const id        = 'maPosAcct-' + r.addr.replace(/[^a-z0-9]/gi, '')
    const actPos    = (r.positions ?? []).filter(ap => parseFloat(ap.position.szi ?? 0) !== 0)
    const totalUPnl = actPos.reduce((s, ap) => s + parseFloat(ap.position.unrealizedPnl ?? 0), 0)
    const upnlCls   = totalUPnl >= 0 ? 'pos' : 'neg'
    const upnlStr   = actPos.length
      ? `<span class="ma-acct-upnl ${upnlCls}">${totalUPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(totalUPnl))}</span>`
      : `<span class="ma-acct-upnl" style="color:var(--muted)">No positions</span>`
    const rows = actPos.map((ap, ri) => {
      const p       = ap.position
      const sz      = parseFloat(p.szi ?? 0)
      const coin    = p.coin
      const entryPx = parseFloat(p.entryPx ?? 0)
      const mark    = parseFloat(state.allMids?.[coin] ?? 0)
      const uPnl    = parseFloat(p.unrealizedPnl ?? 0)
      const roe     = parseFloat(p.returnOnEquity ?? 0) * 100
      const liqPx   = parseFloat(p.liquidationPx ?? 0)
      const margin  = parseFloat(p.marginUsed ?? 0)
      const value   = parseFloat(p.positionValue ?? 0)
      const lev     = p.leverage?.value ? `${p.leverage.value}x` : '—'
      const side    = sz > 0 ? 'LONG' : 'SHORT'
      const sideCls = sz > 0 ? 'pos' : 'neg'
      const uCls    = uPnl >= 0 ? 'pos' : 'neg'
      const rCls    = roe  >= 0 ? 'pos' : 'neg'
      const isLong  = sz > 0
      let liqWarn = false, liqDistPct = 0
      if (liqPx > 0 && mark > 0) {
        liqDistPct = isLong ? (mark - liqPx) / mark * 100 : (liqPx - mark) / mark * 100
        liqWarn = liqDistPct > 0 && liqDistPct < 15
      }
      const eid = `maPosExp-${r.addr.slice(2,8)}-${ri}`
      return `<tr${liqWarn ? ' class="liq-warn-row"' : ''}>
        <td>
          <div style="display:flex;align-items:center;gap:6px">
            <button class="row-expand-btn" onclick="window.__toggleRowExpand('${eid}')" aria-label="expand">&#8964;</button>
            <b>${esc(coin)}</b>
          </div>
        </td>
        <td><span class="badge badge-${side.toLowerCase()}">${side}</span></td>
        <td>${fmtSize(sz)}</td>
        <td>$${fmtPrice(entryPx)}</td>
        <td>${mark ? '$' + fmtPrice(mark) : '—'}</td>
        <td>$${fmtUSD(value)}</td>
        <td class="${uCls}">${uPnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(uPnl))}</td>
        <td class="${rCls}">${(roe >= 0 ? '+' : '') + roe.toFixed(2) + '%'}</td>
        <td class="${liqWarn ? 'liq-warn' : ''}" style="color:var(--red)">${liqWarn ? '⚠ ' : ''}$${fmtPrice(liqPx)}${liqWarn ? `<div style="font-size:10px">${liqDistPct.toFixed(1)}% away</div>` : ''}</td>
        <td>${lev}</td>
        <td>$${fmtUSD(margin)}</td>
      </tr>
      <tr class="row-expand-detail" id="${eid}">
        <td colspan="11">
          <div class="row-expand-grid">
            <div class="row-expand-item"><span>Size</span><span>${fmtSize(sz)} ${esc(coin)}</span></div>
            <div class="row-expand-item"><span>Position Value</span><span>$${fmtUSD(value)}</span></div>
            <div class="row-expand-item"><span>Mark Price</span><span>${mark ? '$' + fmtPrice(mark) : '—'}</span></div>
            <div class="row-expand-item"><span>Entry Price</span><span>$${fmtPrice(entryPx)}</span></div>
            <div class="row-expand-item ${liqWarn ? 'liq-warn' : ''}"><span>Liq. Price</span><span>${liqWarn ? '⚠ ' : ''}$${fmtPrice(liqPx)}</span></div>
            <div class="row-expand-item"><span>Leverage</span><span>${lev}</span></div>
            <div class="row-expand-item"><span>Margin Used</span><span>$${fmtUSD(margin)}</span></div>
            <div class="row-expand-item"><span>ROE</span><span class="${rCls}">${(roe >= 0 ? '+' : '') + roe.toFixed(2) + '%'}</span></div>
          </div>
        </td>
      </tr>`
    }).join('')
    const table = rows
      ? `<div class="ma-tbl-wrap" data-sync-scroll="maPosSync">
           <table class="ma-tbl">
             <thead><tr><th>Coin</th><th>Side</th><th>Size</th><th>Entry</th><th>Mark</th><th>Value</th><th>Unr. PnL</th><th>ROE</th><th>Liq.</th><th>Lev.</th><th>Margin</th></tr></thead>
             <tbody>${rows}</tbody>
           </table>
         </div>`
      : `<div class="ma-section-empty">No open positions.</div>`
    return `<div class="ma-acct-block" style="--acct-color:${color}">
      <div class="ma-acct-header" onclick="maToggleAcct('${id}',this)">
        <span class="ma-acct-dot"></span>
        <span class="ma-acct-name">${esc(label)}</span>
        ${upnlStr}
        <span class="ma-acct-chevron">▼</span>
      </div>
      <div id="${id}" class="ma-acct-body">${table}</div>
    </div>`
  })

  // Sync horizontal scroll across all position tables
  _maSyncScroll()
}

function _maSyncScroll() {
  const wraps = [...document.querySelectorAll('[data-sync-scroll="maPosSync"]')]
  if (wraps.length < 2) return
  let _syncing = false
  wraps.forEach(w => {
    w.addEventListener('scroll', () => {
      if (_syncing) return
      _syncing = true
      wraps.forEach(other => { if (other !== w) other.scrollLeft = w.scrollLeft })
      _syncing = false
    }, { passive: true })
  })
}

function _maRenderOrders(results) {
  const el = document.getElementById('maOrdersBody')
  if (!el) return
  el.innerHTML = _maAcctBlocks(results, (r, i, color) => {
    const label  = r.label || (r.addr.slice(0, 6) + '…')
    const id     = 'maOrdAcct-' + r.addr.replace(/[^a-z0-9]/gi, '')
    const orders = r.openOrders ?? []
    const countStr = orders.length
      ? `<span class="ma-acct-upnl" style="color:var(--muted)">${orders.length} order${orders.length !== 1 ? 's' : ''}</span>`
      : `<span class="ma-acct-upnl" style="color:var(--muted)">No orders</span>`
    const rows = orders.map(o => {
      const side    = o.side === 'B' ? 'Buy' : 'Sell'
      const sideCls = o.side === 'B' ? 'pos' : 'neg'
      return `<tr>
        <td><span class="coin-badge">${esc(_ocCoinLabel(o.coin))}</span></td>
        <td class="${sideCls}">${side}</td>
        <td>${fmtSize(parseFloat(o.sz ?? 0))}</td>
        <td>$${fmtPrice(parseFloat(o.limitPx ?? 0))}</td>
        <td>${esc(o.orderType ?? 'Limit')}</td>
      </tr>`
    }).join('')
    const table = rows ? `<div class="ma-tbl-wrap"><table class="ma-tbl">
      <thead><tr><th>Coin</th><th>Side</th><th>Size</th><th>Price</th><th>Type</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>` : `<div class="ma-section-empty">No open orders.</div>`
    return `<div class="ma-acct-block" style="--acct-color:${color}">
      <div class="ma-acct-header" onclick="maToggleAcct('${id}',this)">
        <span class="ma-acct-dot"></span>
        <span class="ma-acct-name">${esc(label)}</span>
        ${countStr}
        <span class="ma-acct-chevron">▼</span>
      </div>
      <div id="${id}" class="ma-acct-body">${table}</div>
    </div>`
  })
}

function _maRenderCalendar(results) {
  const hidden    = _maHiddenLoad()
  const vis       = results.filter(r => !hidden.has(r.addr) && !r.error)
  const label     = r => r.label || (r.addr.slice(0, 6) + '…')
  const allFills  = vis.flatMap(r => (r.fills ?? []).map(f => ({ ...f, _label: label(r) })))
  const allLedger = vis.flatMap(r => (r.ledgerEntries ?? []).map(e => ({ ...e, _label: label(r) })))
  renderPnLCalendar(allFills, _maCalMonth, _maCalYear, allLedger, 'maCalendarRoot', 'maCalNav', 'maCalDetail')
}

window.maCalNav = function(dir) {
  const detail = document.getElementById('maCalDetail')
  if (detail) { detail.innerHTML = ''; detail.dataset.activeKey = '' }
  _maCalMonth += dir
  if (_maCalMonth > 11) { _maCalMonth = 0;  _maCalYear++ }
  if (_maCalMonth < 0)  { _maCalMonth = 11; _maCalYear-- }
  const root = document.getElementById('multiAcctRoot')
  if (root?.__maResults) _maRenderCalendar(root.__maResults)
}

async function _maSilentUpdate() {
  const root = document.getElementById('multiAcctRoot')
  if (!root) return
  if (!root.querySelector('#maGrid')) return

  const prev = root.__maResults
  if (!prev?.length) return  // wait for initial full load

  _maLastFetch = Date.now()
  const entries = _maLoad()
  if (!entries.length) return

  const now  = Date.now()
  const info = new InfoClient({ transport: _transport })
  const results = []
  let hadFullFetch = false
  let fullFetchDone = 0
  const MAX_FULL_PER_TICK = 1

  for (let i = 0; i < entries.length; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 150))
    const entry  = entries[i]
    const cached = prev.find(r => r.addr === entry.addr)
    const needFull = !cached || cached.error ||
                     (fullFetchDone < MAX_FULL_PER_TICK &&
                      (now - (_maLastFullFetch.get(entry.addr) ?? 0)) > _MA_FULL_FETCH_INTERVAL)

    if (needFull) {
      // Full refetch: fills + ledger + everything (runs every 30 min per account, max 1 per tick)
      fullFetchDone++
      try {
        const base     = await _lbFetchResults([entry])
        const enriched = await _maEnrichResults(base, false)
        _maLastFullFetch.set(entry.addr, now)
        results.push(enriched[0])
        hadFullFetch = true
      } catch {
        results.push(cached ?? { ...entry, error: 'Failed to load', accountValue: 0 })
      }
    } else {
      // Light update: only clearinghouseState for live positions/value (runs every 30s)
      try {
        const cs            = await info.clearinghouseState({ user: entry.addr })
        const positions     = cs.assetPositions ?? []
        const perpAcctVal   = parseFloat(cs.marginSummary?.accountValue ?? 0)
        // Keep the cached HL Portfolio Value (refreshed by the 5-min full fetch);
        // recompute health live against the cached unified-USDC base
        const accountValue  = cached.accountValue ?? perpAcctVal
        const unrealizedPnl = positions.reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0)
        const withdrawable  = parseFloat(cs.withdrawable ?? 0)
        const maintMargin   = parseFloat(cs.crossMaintenanceMarginUsed ?? 0)
        const _hBase        = (cached._marginBase ?? 0) > 0 ? cached._marginBase : perpAcctVal
        const healthPct     = _hBase > 0 ? Math.max(0, (1 - maintMargin / _hBase) * 100) : 0
        const healthCls     = healthPct > 60 ? 'pos' : healthPct > 30 ? 'warn' : 'neg'
        const netPnl        = (cached.realizedPnl ?? 0) + unrealizedPnl + (cached.allTimeFunding ?? 0) - (cached.totalFees ?? 0)
        results.push({ ...cached, accountValue, unrealizedPnl, netPnl, withdrawable, maintMargin, healthPct, healthCls, positions })
      } catch {
        results.push(cached)
      }
    }
  }

  root.__maResults = results

  // Always refresh live cards and aggregate (account value, positions, health)
  serverFetch('/api/status/all').then(s => { _maBotStatus = s ?? {} }).catch(() => {})
  const agg = root.querySelector('.ma-aggregate')
  if (agg) agg.innerHTML = _maAggregateHtml(results)
  const grid = root.querySelector('#maGrid')
  if (grid) grid.innerHTML = results.map(r => _maCardHtml(r)).join('')
  _checkHealthAlerts(results.map(r => ({ addr: r.addr, label: r.label || '', healthPct: r.healthPct })))

  // Heavy UI (charts, calendar, stats) only when a full fetch actually ran
  if (hadFullFetch) {
    const statsEl = root.querySelector('#maStatsCards')
    if (statsEl) statsEl.innerHTML = _maStatsHtml(results)
    _maRenderChartsFromResults(results, { resetZoom: false })
    const newHash = results.map(r => (r.fills ?? []).length).join(',')
    if (newHash !== _maCalFillHash) {
      _maCalFillHash = newHash
      _maRenderCalendar(results)
    }
  }
}

window.__maToggleHide = function(addr) {
  const s = _maHiddenLoad()
  if (s.has(addr)) s.delete(addr); else s.add(addr)
  _maHiddenSave(s)
  renderMultiAccount()
}

window.__maRemove = function(addr) {
  WM.remove(addr)
  _maLedgerCache.delete(addr)
  renderMultiAccount()
}

window.__maRename = async function(addr) {
  const entry = WM.load().find(e => e.addr.toLowerCase() === addr.toLowerCase())
  const name = await _showPinModal({
    title: 'Rename Account',
    desc:  entry?.addr.slice(0, 10) + '…' + entry?.addr.slice(-6),
    confirmText: 'Save',
    placeholder: entry?.label || 'Account name',
    type: 'text',
  })
  if (name === null) return
  WM.upsert(addr, name.trim())
  renderMultiAccount()
}

// ─── MOBILE PREDICTIONS SHEET (Exodus-style pull-down) ──────────────────────
// Reuses the entire desktop outcomes tab by MOVING #outcomesRoot into the
// overlay while open, and returning it to its tab on close.
window.__predictRendered = false
const _PREDICT_LIP = 76   // px of home left peeking at the bottom when parked
let _predictOpen = false

function _predictEls() {
  return { ov: document.getElementById('mobPredictOverlay'), home: document.getElementById('mobileView') }
}

// px = how far home has slid down (0 = closed .. maxY = parked at bottom lip)
function _predictDragTo(px, animate) {
  const { ov, home } = _predictEls()
  if (!ov || !home) return
  const maxY = window.innerHeight - _PREDICT_LIP
  px = Math.max(0, Math.min(maxY, px))
  ov.style.display    = 'flex'
  home.style.position = 'relative'
  home.style.zIndex   = '1'
  home.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.25,1), border-radius .28s' : 'none'
  home.style.transform  = `translateY(${px}px)`
  home.style.borderRadius = px > 4 ? '18px 18px 0 0' : '0'
}

function _predictSettle(open) {
  const { ov, home } = _predictEls()
  if (!ov || !home) return
  _predictOpen = open
  if (open) {
    const root = document.getElementById('outcomesRoot')
    const body = document.getElementById('mobPredictBody')
    if (root && body && root.parentElement !== body) body.appendChild(root)
    _predictDragTo(window.innerHeight - _PREDICT_LIP, true)
    if (!window.__predictRendered) { window.__predictRendered = true; renderOutcomes() }
  } else {
    _predictDragTo(0, true)
    setTimeout(() => {
      if (_predictOpen) return
      ov.style.display = 'none'
      home.style.transform = ''
      home.style.borderRadius = ''
      home.style.position = ''
      home.style.zIndex = ''
      _stopOcCountdown()
      window.__predictRendered = false
      const root = document.getElementById('outcomesRoot')
      const tab  = document.getElementById('tab-outcomes')
      if (root && tab && root.parentElement !== tab) tab.appendChild(root)
    }, 300)
  }
}
window.__openPredictions  = () => _predictSettle(true)
window.__closePredictions = () => _predictSettle(false)

// ── Exodus-style: HOME is the sheet. Drag it down to park it as a bottom lip
// (predictions revealed behind); drag the lip back up to return. The same
// header/handle zones work in both states since they ARE the visible lip.
;(function initPredictPull() {
  const zones = [document.getElementById('mobPredictHandle'), document.querySelector('.mob-v-header:not(#mobPredictHandle)')].filter(Boolean)
  let sy = null, dy = 0, t0 = 0, dragging = false
  const DRAG_THRESHOLD = 10   // px before a touch counts as a drag (not a tap)
  for (const z of zones) {
    z.addEventListener('touchstart', e => { sy = e.touches[0].clientY; dy = 0; t0 = Date.now(); dragging = false }, { passive: true })
    z.addEventListener('touchmove', e => {
      if (sy == null) return
      dy = e.touches[0].clientY - sy
      if (!dragging && Math.abs(dy) > DRAG_THRESHOLD) dragging = true
      if (!dragging) return            // still a tap — don't grab the screen
      const base = _predictOpen ? window.innerHeight - _PREDICT_LIP : 0
      _predictDragTo(base + dy, false)   // tracks the finger in both directions
    }, { passive: true })
    z.addEventListener('touchend', () => {
      if (sy == null) return
      // A tap (no real drag) must fall through to the element's own click —
      // e.g. tapping the header opens the wallet switcher. Don't hijack it.
      if (!dragging) { sy = null; dy = 0; return }
      const fast = Math.abs(dy) > 50 && (Date.now() - t0) < 300
      if (_predictOpen) _predictSettle(!(dy < -window.innerHeight / 5 || (fast && dy < 0)))
      else              _predictSettle(dy > window.innerHeight / 3 || (fast && dy > 0))
      sy = null; dy = 0; dragging = false
    })
    if (z.id === 'mobPredictHandle') z.addEventListener('click', () => { if (Math.abs(dy) < 4) _predictSettle(!_predictOpen) })
  }
})()

// ─── OUTCOMES (PREDICTION MARKETS) ───────────────────────────────────────────
let _ocCharts          = {}
let _ocCountdownInterval = null
let _ocRefreshInterval = null
let _ocPrices          = {}   // { [outcomeId]: { yes: number, no: number } }
let _ocMarkCache       = {}   // { [spotCoin '+N']: mark price } — last live mid for held outcomes
let _ocLiveOutcomes    = []   // stored for polling
let _ocLiveQuestions   = []   // HL question groups (native event grouping)
let _ocLiveInfo        = null
let _ocActiveCat       = 'all'
let _ocExpandedId      = null

function _stopOcCountdown() {
  if (_ocCountdownInterval) { clearInterval(_ocCountdownInterval); _ocCountdownInterval = null }
  if (_ocRefreshInterval)   { clearInterval(_ocRefreshInterval);   _ocRefreshInterval   = null }
  Object.values(_ocCharts).forEach(c => { try { c.destroy() } catch {} })
  _ocCharts       = {}
  _ocPrices       = {}
  _ocLiveOutcomes  = []
  _ocLiveQuestions = []
  _ocLiveInfo      = null
}

// Friendly label resolving prediction "#N" coins to "<market> <side>" via the
// outcome token map (e.g. "#2170" → "USA Yes"); falls back to coinLabel otherwise.
function _ocCoinLabel(coin) {
  // Orders use "#N"; spot holdings of the same outcome use "+N" — both map to
  // the "#N" entry in ocTokenMap.
  if (typeof coin === 'string' && (coin[0] === '#' || coin[0] === '+')) {
    const t = state.ocTokenMap?.['#' + coin.slice(1)]
    if (t && t.name) return `${t.name} ${t.side ?? ''}`.trim()
    // Settled outcomes drop out of the live outcomeMeta, but HL keeps their
    // spec behind {type:'settledOutcome'}. Fire a one-shot lazy fetch to pull
    // the real title (e.g. "World Cup Round of 16: Brazil vs Norway · Norway")
    // and re-render; until it lands, show a readable decoded placeholder.
    _lazyResolveSettledOutcome(coin)
    return _ocFallbackLabel(coin)
  }
  return coinLabel(coin)
}
window._ocFallbackLabel = _ocFallbackLabel   // used by render.js ocCoinLabel fallback

// Human-readable placeholder for an outcome coin whose title isn't in ocTokenMap.
// "#7391"/"+7391" → outcome 739, side 1 → "Prediction #739 · No".
function _ocFallbackLabel(coin) {
  const n = parseInt(String(coin).slice(1), 10)
  if (!Number.isFinite(n)) return coinLabel(coin)
  const outcome = Math.floor(n / 10)
  const side    = n % 10
  const sideName = side === 0 ? 'Yes' : side === 1 ? 'No' : `#${side}`
  return `Prediction #${outcome} · ${sideName}`
}

// Lazy backfill of settled-outcome titles. The live outcomeMeta purges fully
// resolved questions, but HL's {type:'settledOutcome',outcome:N} still returns
// the spec (name + sideSpecs). We fetch on demand, merge into ocTokenMap, persist,
// and re-render the trades/positions views so the title appears in place.
const _settledOcSeen = new Set()   // outcome ids already fetched (ok/failed) — never refetch
let _settledOcRerender = null
function _lazyResolveSettledOutcome(coin) {
  const n = parseInt(String(coin).slice(1), 10)
  if (!Number.isFinite(n)) return
  const outcome = Math.floor(n / 10)
  if (_settledOcSeen.has(outcome)) return
  _settledOcSeen.add(outcome)
  fetch('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'settledOutcome', outcome })
  })
    .then(r => r.json())
    .then(res => {
      const spec = res?.spec
      if (!spec || !Array.isArray(spec.sideSpecs)) return
      if (!state.ocTokenMap) state.ocTokenMap = {}
      // Match the live _buildOcTokenMap display: prefer the parsed underlying,
      // fall back to the raw settled name (the full question text).
      const d          = _parseOutcomeDesc(spec.description)
      const underlying = d.underlying || spec.name
      const target     = d.targetPrice ? ` >$${parseFloat(d.targetPrice).toLocaleString()}` : ''
      const expiry     = d.expiry ? ` (${_fmtOutcomeExpiry(d.expiry)})` : ''
      const displayName = underlying + target + expiry
      for (let i = 0; i < spec.sideSpecs.length; i++) {
        state.ocTokenMap['#' + (outcome * 10 + i)] = { name: displayName, side: spec.sideSpecs[i].name }
      }
      try {
        localStorage.setItem('hliq_oc_token_map', JSON.stringify(state.ocTokenMap))
      } catch {}
      // Debounce re-renders so a page full of settled outcomes rerenders once.
      clearTimeout(_settledOcRerender)
      _settledOcRerender = setTimeout(() => {
        try { _refreshVisitedSection('trades') } catch {}
        try { if (state.fills) renderTrades(state.fills) } catch {}
        try { if (typeof _mobVRenderContent === 'function') _mobVRenderContent() } catch {}
      }, 150)
    })
    .catch(() => {})
}
window._ocCoinLabel = _ocCoinLabel   // reused by render.js (history, overview, manage tables)

function _buildOcTokenMap(meta) {
  // ACCUMULATE, don't reset. Settled/expired outcomes drop out of the active
  // outcomeMeta, but their names must still resolve in History/positions (e.g. a
  // closed "#7391"). Start from the persisted union and merge the current meta in.
  _hydrateOcTokenMap()
  if (!state.ocTokenMap)    state.ocTokenMap    = {}
  if (!state.ocQuestionMap) state.ocQuestionMap = {}
  const list = Array.isArray(meta) ? meta : (meta?.outcomes ?? [])
  // outcomeId → question name (e.g. 217 → "2026 World Cup Champion") for labels
  const questions = Array.isArray(meta) ? [] : (meta?.questions ?? [])
  for (const q of questions) for (const oid of (q.namedOutcomes ?? [])) state.ocQuestionMap[oid] = q.name
  for (const o of list) {
    try {
      const d           = _parseOutcomeDesc(o.description)
      const underlying  = d.underlying || o.name
      const target      = d.targetPrice ? ` >$${parseFloat(d.targetPrice).toLocaleString()}` : ''
      const expiry      = d.expiry ? ` (${_fmtOutcomeExpiry(d.expiry)})` : ''
      const displayName = underlying + target + expiry
      for (let i = 0; i < (o.sideSpecs?.length ?? 0); i++) {
        state.ocTokenMap['#' + (o.outcome * 10 + i)] = { name: displayName, side: o.sideSpecs[i].name }
      }
    } catch (e) {
      console.warn('_buildOcTokenMap entry error:', e.message)
    }
  }
  // Persist so outcome names resolve instantly next session (and survive a flaky
  // outcomeMeta fetch) instead of falling back to the raw "+N"/"#N" code.
  try {
    if (Object.keys(state.ocTokenMap).length) {
      localStorage.setItem('hliq_oc_token_map', JSON.stringify(state.ocTokenMap))
      localStorage.setItem('hliq_oc_question_map', JSON.stringify(state.ocQuestionMap || {}))
    }
  } catch {}
}

// Hydrate the outcome label maps from localStorage (synchronous, instant) so the
// leaderboard / outcomes never flash raw "#numbers" while outcomeMeta is in flight.
function _hydrateOcTokenMap() {
  if (state.ocTokenMap && Object.keys(state.ocTokenMap).length) return
  try {
    const cached = JSON.parse(localStorage.getItem('hliq_oc_token_map') || 'null')
    if (cached && Object.keys(cached).length) {
      state.ocTokenMap    = cached
      state.ocQuestionMap = JSON.parse(localStorage.getItem('hliq_oc_question_map') || '{}')
    }
  } catch {}
}

function _parseOutcomeDesc(desc) {
  const p = {}
  if (!desc) return p
  desc.split('|').forEach(part => { const [k, v] = part.split(':'); if (k && v !== undefined) p[k] = v })
  return p
}

function _fmtOutcomeExpiry(raw) {
  if (!raw || raw.length < 8) return raw
  const ds = raw.slice(0, 8), ts = (raw.slice(9) || '0000').padEnd(4, '0')
  const utc = new Date(Date.UTC(+ds.slice(0,4), +ds.slice(4,6)-1, +ds.slice(6,8), +ts.slice(0,2), +ts.slice(2,4)))
  return utc.toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })
}

function _expiryDate(raw) {
  if (!raw || raw.length < 8) return null
  const ds = raw.slice(0, 8), ts = (raw.slice(9) || '0000').padEnd(4, '0')
  return new Date(Date.UTC(+ds.slice(0,4), +ds.slice(4,6)-1, +ds.slice(6,8), +ts.slice(0,2), +ts.slice(2,4)))
}

function _fmtCountdown(ms) {
  if (ms <= 0) return 'Expired'
  const s   = Math.floor(ms / 1000)
  const d   = Math.floor(s / 86400)
  const h   = Math.floor((s % 86400) / 3600)
  const m   = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${sec}s`
  return `${m}m ${sec}s`
}

function _startOcCountdown(expiryMap) {
  if (_ocCountdownInterval) clearInterval(_ocCountdownInterval)
  const tick = () => {
    const now = Date.now()
    for (const [id, expiry] of Object.entries(expiryMap)) {
      const el = document.getElementById('oc-cd-' + id)
      if (!el) continue
      if (!expiry) { el.textContent = '—'; continue }
      const remaining = expiry.getTime() - now
      const fmt = _fmtCountdown(remaining)
      el.textContent = fmt
      el.className   = 'oc-countdown' + (remaining < 3600000 ? ' oc-countdown--urgent' : '')
      const cEl = document.getElementById('oc-compact-cd-' + id)
      if (cEl) cEl.textContent = fmt
    }
  }
  tick()
  _ocCountdownInterval = setInterval(tick, 1000)
}

function _fmtOcK(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
  return n.toFixed(0)
}

// Returns { line1, line2 } for two-row question display
function _buildFullQuestion(d, name) {
  if (d.class === 'priceBinary' && d.underlying) {
    const target = d.targetPrice ? `$${parseFloat(d.targetPrice).toLocaleString()}` : '?'
    const when   = d.expiry ? _fmtOcQuestionTime(d.expiry) : null
    const line1  = `Will ${d.underlying} close above ${target}`
    const line2  = when ? `on ${when}?` : '?'
    return { line1, line2 }
  }
  return { line1: name, line2: null }
}

function _fmtOutcomeClosingTime(raw) {
  if (!raw || raw.length < 8) return null
  const ds = raw.slice(0, 8), ts = (raw.slice(9) || '0000').padEnd(4, '0')
  const utc = new Date(Date.UTC(+ds.slice(0,4), +ds.slice(4,6)-1, +ds.slice(6,8), +ts.slice(0,2), +ts.slice(2,4)))
  return utc.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

// Short date for embedding in the question: "May 4 at 2:00 AM"
function _fmtOcQuestionTime(raw) {
  if (!raw || raw.length < 8) return null
  const ds = raw.slice(0, 8), ts = (raw.slice(9) || '0000').padEnd(4, '0')
  const utc = new Date(Date.UTC(+ds.slice(0,4), +ds.slice(4,6)-1, +ds.slice(6,8), +ts.slice(0,2), +ts.slice(2,4)))
  return utc.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// Fetch YES price via L2 book (#N coin format). NO = 1 - YES for binary markets.
async function _loadOcPrices(outcomes, info) {
  await Promise.all(outcomes.map(async o => {
    const yesPairIdx = o.outcome * 10
    let yesPx = 0

    // Primary: L2 book with order-coin format
    try {
      const book  = await info.l2Book({ coin: '#' + yesPairIdx })
      const bids  = book.levels?.[0] ?? []
      const asks  = book.levels?.[1] ?? []
      const bid   = parseFloat(bids[0]?.px ?? 0)
      const ask   = parseFloat(asks[0]?.px ?? 0)
      if (bid > 0 && ask > 0) yesPx = (bid + ask) / 2
      else yesPx = bid || ask

    } catch {}

    // Fallback: 1m candle last close (use #N outcome coin format)
    if (!yesPx) {
      try {
        const cs = await fetchCandles('#' + yesPairIdx, '1m', Date.now() - 5 * 60 * 1000)
        if (cs.length) yesPx = parseFloat(cs[cs.length - 1].c)
      } catch {}
    }

    if (!yesPx || yesPx <= 0 || yesPx >= 1) return

    const noPx = 1 - yesPx

    // Store in dedicated price map — avoids allMids race condition
    _ocPrices[o.outcome] = { yes: yesPx, no: noPx }

    // Update DOM: YES/NO side buttons
    const updBtn = (id, px) => {
      const btn = document.getElementById(id)
      if (!btn) return
      const pctEl   = btn.querySelector('.oc-sel-pct')
      const priceEl = btn.querySelector('.oc-sel-price')
      if (pctEl)   pctEl.textContent   = (px * 100).toFixed(0) + '%'
      if (priceEl) priceEl.textContent = (px * 100).toFixed(3) + '¢'
    }
    updBtn('oc-sel-yes-' + o.outcome, yesPx)
    updBtn('oc-sel-no-'  + o.outcome, noPx)

    // Update chance stat
    const chanceEl = document.getElementById('oc-chance-' + o.outcome)
    if (chanceEl) {
      chanceEl.textContent = (yesPx * 100).toFixed(0) + '%'
      chanceEl.className   = 'oc-stat-val ' + (yesPx > 0.5 ? 'pos' : 'neg')
    }
    const compactPct = document.getElementById('oc-compact-pct-' + o.outcome)
    if (compactPct) {
      compactPct.textContent = (yesPx * 100).toFixed(0) + '%'
      compactPct.className   = 'oc-compact-pct ' + (yesPx > 0.5 ? 'pos' : 'neg')
    }
    const evtPct = document.getElementById('oc-evt-pct-' + o.outcome)
    if (evtPct) {
      evtPct.textContent = (yesPx * 100).toFixed(0) + '%'
      evtPct.style.color = yesPx >= 0.5 ? 'var(--green, #00e5a0)' : 'var(--fg)'
      const row = evtPct.closest('.oc-evt-row')
      if (row) row.dataset.p = yesPx
    }
    const hotPct = document.getElementById('oc-hot-pct-' + o.outcome)
    if (hotPct) hotPct.textContent = (yesPx * 100).toFixed(0) + '%'
    const s0 = esc(o.sideSpecs?.[0]?.name || 'Yes'), s1 = esc(o.sideSpecs?.[1]?.name || 'No')
    const miniY = document.getElementById('oc-mini-yes-' + o.outcome)
    if (miniY) miniY.innerHTML = s0 + ' <b>' + (yesPx * 100).toFixed(0) + '¢</b>'
    const miniN = document.getElementById('oc-mini-no-' + o.outcome)
    if (miniN) miniN.innerHTML = s1 + ' <b>' + (noPx * 100).toFixed(0) + '¢</b>'
  }))
  _ocEvtResortAll()
}

// Per-outcome stats, loaded lazily when a card is expanded (never in bulk — that
// would fire 2 requests × ~36 markets at once and get rate-limited). Outcomes
// aren't in spotMetaAndAssetCtxs, so both figures are derived directly:
//   · Volume  = Σ(shares × close) over the last 24h of 1h candles ≈ USDC traded
//   · Liquidity = total resting book notional Σ(px × sz) across both sides
async function _loadOcStats(outcomes, info) {
  await Promise.all((outcomes || []).map(async o => {
    const coin = '#' + (o.outcome * 10)

    try {
      const cs = await fetchCandles(coin, '1h', Date.now() - 24 * 3600 * 1000)
      if (Array.isArray(cs) && cs.length) {
        const vol   = cs.reduce((s, k) => s + parseFloat(k.v ?? 0) * parseFloat(k.c ?? 0), 0)
        const volEl = document.getElementById('oc-vol-' + o.outcome)
        if (volEl) volEl.textContent = vol > 0 ? '$' + _fmtOcK(vol) : '$0'
      }
    } catch {}

    try {
      const book = await info.l2Book({ coin })
      let liq = 0
      for (const sideLevels of (book?.levels ?? []))
        for (const lvl of (sideLevels || [])) liq += parseFloat(lvl.px ?? 0) * parseFloat(lvl.sz ?? 0)
      const oiEl = document.getElementById('oc-oi-' + o.outcome)
      if (oiEl) oiEl.textContent = liq > 0 ? '$' + _fmtOcK(liq) : '—'
    } catch {}
  }))
}

function _ocAvailBalance() {
  const balances = state.spotState?.balances ?? []
  // Outcome markets are quoted in USDC; fall back to other USD stables.
  const order = ['USDC', 'USDH', 'USDY', 'USDE', 'USDT0', 'USD']
  let best = null
  for (const b of balances) {
    if (!order.includes(b.coin)) continue
    const avail = Math.max(0, parseFloat(b.total ?? 0) - parseFloat(b.hold ?? 0))
    if (avail > 0 && (!best || order.indexOf(b.coin) < order.indexOf(best.coin))) best = { coin: b.coin, avail }
  }
  return best ? best.avail : 0
}

// True when the outcomes grid is currently living inside the mobile predictions sheet.
function _ocInMobileSheet() {
  return !!document.getElementById('mobPredictBody')?.contains(document.getElementById('ocGrid'))
}

async function _initOcCharts(outcomes) {
  const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000
  await Promise.all(outcomes.map(async o => {
    const canvas = document.getElementById('oc-chart-' + o.outcome)
    if (!canvas) return
    const pairIdx = o.outcome * 10
    const d       = _parseOutcomeDesc(o.description)

    let candles = []
    try { candles = await fetchCandles('#' + pairIdx, '1h', sevenDaysAgo) } catch {}

    if (!canvas.isConnected) return
    const wrap = canvas.parentElement
    let emptyEl = wrap.querySelector('.oc-chart-empty')
    if (!candles.length) {
      // Keep the canvas (don't wipe it) so a later expand can retry the fetch —
      // the bulk load can transiently fail under rate limits.
      if (!emptyEl) { emptyEl = document.createElement('div'); emptyEl.className = 'oc-chart-empty'; emptyEl.textContent = 'No chart data'; wrap.appendChild(emptyEl) }
      return
    }
    if (emptyEl) emptyEl.remove()

    // Build full timeline: past candles + null slots up to expiry
    const HOUR   = 3600 * 1000
    const now    = Date.now()
    const expiry = (_expiryDate(d.expiry) ?? new Date(now)).getTime()
    const lastTs = candles[candles.length - 1].t

    // Pad future with null data points so the line ends at "now" and
    // empty space to the right represents time remaining to close
    const futureHours = Math.max(0, Math.round((expiry - lastTs) / HOUR))
    const futureLabels = Array.from({ length: futureHours }, (_, i) => lastTs + (i + 1) * HOUR)
    const futureNulls  = Array(futureHours).fill(null)

    const labels = [...candles.map(c => c.t), ...futureLabels]
    const pcts   = [...candles.map(c => parseFloat(c.c) * 100), ...futureNulls]

    const last    = candles[candles.length - 1]
    const lastPct = parseFloat(last.c) * 100
    const winning = lastPct >= 50
    const col     = winning ? '#00e5a0' : '#ff4d6d'

    const ctx  = canvas.getContext('2d')
    const grad = ctx.createLinearGradient(0, 0, 0, 90)
    grad.addColorStop(0, winning ? 'rgba(0,229,160,0.18)' : 'rgba(255,77,109,0.18)')
    grad.addColorStop(1, 'rgba(0,0,0,0)')

    if (_ocCharts[o.outcome]) { try { _ocCharts[o.outcome].destroy() } catch {} }
    const dataLen  = candles.length
    const totalLen = labels.length

    _ocCharts[o.outcome] = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: pcts, borderColor: col, backgroundColor: grad, fill: true,
          tension: 0.3, borderWidth: 1.5,
          spanGaps: false,
          pointRadius: (ctx2) => ctx2.dataIndex === dataLen - 1 ? 3 : 0,
          pointBackgroundColor: col, pointBorderColor: '#000', pointBorderWidth: 1,
        }],
      },
      options: {
        animation: false, responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false }, tooltip: { enabled: false },
          zoom: { zoom: { wheel: { enabled: false }, drag: { enabled: false } }, pan: { enabled: false } },
        },
        scales: { x: { display: false }, y: { display: false, min: 0, max: 100 } },
      },
    })

    // Store index so _refreshOcPrices updates the right (last real) data point
    _ocCharts[o.outcome]._dataIdx = dataLen - 1

    // Set initial current BTC price from allMids
    const underlying = d.underlying
    if (underlying) {
      const mid = parseFloat(state.allMids?.[underlying] ?? 0)
      if (mid > 0) {
        const el = document.getElementById('oc-current-' + o.outcome)
        if (el) el.textContent = '$' + mid.toLocaleString(undefined, { maximumFractionDigits: 0 })
      }
    }
  }))
}

// Poll live prices every 30s and update charts + DOM
async function _refreshOcPrices() {
  const outcomes = _ocLiveOutcomes
  const info     = _ocLiveInfo
  if (!outcomes.length || !info) return
  // Don't poll ~76 order books while the predictions UI is off screen — that
  // alone would burn most of HL's per-IP rate budget for nothing
  const grid    = document.getElementById('ocGrid')
  const inSheet = document.getElementById('mobPredictBody')?.contains(grid)
  if (inSheet ? !_predictOpen : !grid?.offsetParent) return
  await Promise.all(outcomes.map(async o => {
    const yesPairIdx = o.outcome * 10
    try {
      const book = await info.l2Book({ coin: '#' + yesPairIdx })
      const bid  = parseFloat(book.levels?.[0]?.[0]?.px ?? 0)
      const ask  = parseFloat(book.levels?.[1]?.[0]?.px ?? 0)
      if (!bid && !ask) return
      const yesPx = bid > 0 && ask > 0 ? (bid + ask) / 2 : (bid || ask)
      if (yesPx <= 0 || yesPx >= 1) return
      const noPx = 1 - yesPx
      _ocPrices[o.outcome] = { yes: yesPx, no: noPx }
      // Keep the open card's avg-price/preview in sync with the live mid.
      if (String(o.outcome) === String(_ocExpandedId)) window.__ocUpdCalc(o.outcome)

      // Update YES/NO buttons
      const updBtn = (id, px) => {
        const btn = document.getElementById(id)
        if (!btn) return
        const pctEl   = btn.querySelector('.oc-sel-pct')
        const priceEl = btn.querySelector('.oc-sel-price')
        if (pctEl)   pctEl.textContent   = (px * 100).toFixed(0) + '%'
        if (priceEl) priceEl.textContent = (px * 100).toFixed(3) + '¢'
      }
      updBtn('oc-sel-yes-' + o.outcome, yesPx)
      updBtn('oc-sel-no-'  + o.outcome, noPx)

      // Update chance stat
      const chanceEl = document.getElementById('oc-chance-' + o.outcome)
      if (chanceEl) {
        chanceEl.textContent = (yesPx * 100).toFixed(0) + '%'
        chanceEl.className   = 'oc-stat-val ' + (yesPx > 0.5 ? 'pos' : 'neg')
      }
      const compactPct2 = document.getElementById('oc-compact-pct-' + o.outcome)
      if (compactPct2) {
        compactPct2.textContent = (yesPx * 100).toFixed(0) + '%'
        compactPct2.className   = 'oc-compact-pct ' + (yesPx > 0.5 ? 'pos' : 'neg')
      }
      const s0 = esc(o.sideSpecs?.[0]?.name || 'Yes'), s1 = esc(o.sideSpecs?.[1]?.name || 'No')
      const miniY2 = document.getElementById('oc-mini-yes-' + o.outcome)
      if (miniY2) miniY2.innerHTML = s0 + ' <b>' + (yesPx * 100).toFixed(0) + '¢</b>'
      const miniN2 = document.getElementById('oc-mini-no-' + o.outcome)
      if (miniN2) miniN2.innerHTML = s1 + ' <b>' + ((1 - yesPx) * 100).toFixed(0) + '¢</b>'
      const evtPct2 = document.getElementById('oc-evt-pct-' + o.outcome)
      if (evtPct2) {
        evtPct2.textContent = (yesPx * 100).toFixed(0) + '%'
        evtPct2.style.color = yesPx >= 0.5 ? 'var(--green, #00e5a0)' : 'var(--fg)'
        const row2 = evtPct2.closest('.oc-evt-row')
        if (row2) row2.dataset.p = yesPx
      }
      const hotPct2 = document.getElementById('oc-hot-pct-' + o.outcome)
      if (hotPct2) hotPct2.textContent = (yesPx * 100).toFixed(0) + '%'

      // Update live dot — only move the last real data point, not future nulls
      const chart = _ocCharts[o.outcome]
      if (chart) {
        const data = chart.data.datasets[0].data
        const idx  = chart._dataIdx ?? data.length - 1
        if (idx >= 0) {
          data[idx] = yesPx * 100
          chart.update('none')
        }
      }

      // Update current underlying price from allMids
      const d = _parseOutcomeDesc(o.description)
      if (d.underlying) {
        const mid = parseFloat(state.allMids?.[d.underlying] ?? 0)
        if (mid > 0) {
          const el = document.getElementById('oc-current-' + o.outcome)
          if (el) el.textContent = '$' + mid.toLocaleString(undefined, { maximumFractionDigits: 0 })
        }
      }
    } catch {}
  }))
  _ocEvtResortAll()
}

function _ocGetCategory(o, d) {
  if (d.class === 'priceBinary') return 'crypto'
  // Word-boundary matching over name + description — substring matching put
  // "nETHerlands" in crypto and "spAIn" in tech.
  const name = ((o.name || '') + ' ' + (o.description || '')).toLowerCase()
  if (/\b(world ?cup|fifa|uefa|olympic|super ?bowl|sport|nba|nfl|mlb|soccer|football|basketball|tennis|golf|champion)\b/.test(name)) return 'sports'
  if (/\b(btc|eth|sol|bnb|doge|xrp|crypto|bitcoin|ethereum|solana|defi|nft|stablecoin)\b/.test(name)) return 'crypto'
  if (/\b(politic\w*|election|president|congress|senate|vote|democrat\w*|republican\w*)\b/.test(name)) return 'politics'
  if (/\b(culture|music|movie|oscar\w*|grammy\w*|award\w*|film|celebrity)\b/.test(name)) return 'culture'
  if (/\b(econom\w*|gdp|inflation|fed|rates?|unemployment|recession|cpi)\b/.test(name)) return 'economy'
  if (/\b(weather|climate|hurricane|temperature|rainfall|storm)\b/.test(name)) return 'weather'
  if (/\b(business|company|stocks?|ipo|revenue|earnings|acquisition)\b/.test(name)) return 'business'
  if (/\b(tech|ai|apple|google|microsoft|meta|nvidia|openai|llm)\b/.test(name)) return 'tech'
  return 'other'
}

window.__ocExpandCard = function(id) {
  // Already open: do nothing. Clicks on inner controls (Yes/No, +10, amount…)
  // bubble up to this handler — collapsing here would kick the user off the
  // market mid-trade. Close only via the ✕ button or the backdrop. This MUST run
  // before the collapse-previous block below, else we strip oc-expanded off this
  // very card and it visually collapses.
  if (_ocExpandedId === id) return
  if (_ocExpandedId !== null) {
    document.getElementById('oc-card-' + _ocExpandedId)?.classList.remove('oc-expanded')
  }
  _ocExpandedId = id
  const card = document.getElementById('oc-card-' + id)
  if (card) { card.classList.add('oc-expanded'); card.scrollTop = 0 }
  // Freeze the sheet/list behind the card so touch scrolls the card, not the
  // background (the card is a DOM child of the scrollable #mobPredictBody).
  document.body.classList.add('oc-card-open')
  document.getElementById('ocExpandBackdrop')?.classList.add('active')
  // The chart canvas was hidden (collapsed card) when first drawn, so Chart.js
  // sized it to 0×0. Now that it's visible, resize it — or build it if it never
  // got created — and refresh this market's volume/OI in case the initial load missed.
  const oc = (_ocLiveOutcomes ?? []).find(x => String(x.outcome) === String(id))
  requestAnimationFrame(() => {
    const ch = _ocCharts[id]
    if (ch) { try { ch.resize(); ch.update('none') } catch {} }
    else if (oc) _initOcCharts([oc])
  })
  if (oc && _ocLiveInfo) _loadOcStats([oc], _ocLiveInfo)
  window.__ocUpdCalc(id)   // seed avg price / preview from the live mid
  // In the predictions sheet: the parked home lip (z-index 1) sits over the
  // bottom of the screen — lift the sheet above it while trading
  const ov = document.getElementById('mobPredictOverlay')
  if (ov && card && ov.contains(card)) ov.style.zIndex = '3'
}

// ── Outcome spread-grid bot: config modal → launch ──────────────────────────────
window.__openOcBotModal = function(outcome, yesLabel, noLabel) {
  if (!state.addr) { alert('Load a wallet first.'); return }
  state.ocBotCfg = { outcome, side: 0, yesLabel: yesLabel || 'Yes', noLabel: noLabel || 'No' }
  _modalToBody('ocBotModal')
  const name = state.ocQuestionMap?.[outcome] || _ocCoinLabel('#' + (outcome * 10)) || 'Outcome'
  document.getElementById('ocBotTitle').textContent = '⚡ Spread Grid · ' + name
  document.getElementById('ocBotYesLbl').textContent = state.ocBotCfg.yesLabel
  document.getElementById('ocBotNoLbl').textContent  = state.ocBotCfg.noLabel
  document.getElementById('ocBotLevels').value = 10
  document.getElementById('ocBotSize').value   = ''
  document.getElementById('ocBotLower').value  = ''
  document.getElementById('ocBotUpper').value  = ''
  document.getElementById('ocBotStatus').className = 'trade-status'
  const sb = document.getElementById('ocBotStartBtn'); sb.textContent = 'Start bot'; sb.disabled = false
  document.querySelectorAll('#ocBotSide .guard-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === '0'))
  window.__ocBotPreview()
  document.getElementById('ocBotModal').classList.add('open')
}

window.__ocBotSetSide = function(side) {
  if (!state.ocBotCfg) return
  state.ocBotCfg.side = side
  document.querySelectorAll('#ocBotSide .guard-seg-btn').forEach(b => b.classList.toggle('active', b.dataset.val === String(side)))
  window.__ocBotPreview()
}

window.__ocBotPreview = function() {
  const c = state.ocBotCfg; if (!c) return
  const px  = _ocPrices?.[c.outcome] ? (c.side === 0 ? _ocPrices[c.outcome].yes : _ocPrices[c.outcome].no) : 0
  const lbl = c.side === 0 ? c.yesLabel : c.noLabel
  const el  = document.getElementById('ocBotPxVal')
  if (el) el.textContent = px > 0 ? `${esc(lbl)} ${(px * 100).toFixed(1)}¢` : '—'
  const sd = document.getElementById('ocBotSideDesc')
  if (sd) sd.textContent = `Runs the grid on the ${esc(lbl)} share (token #${c.outcome * 10 + c.side}).`
}

window.__ocBotStart = async function() {
  const c = state.ocBotCfg; if (!c) return
  const statusEl = document.getElementById('ocBotStatus')
  const agentKey = (state.addr ? localStorage.getItem(_agentKeyForAddr(state.addr)) : null)
        || document.getElementById('m-agentKey')?.value?.trim()
        || document.getElementById('agentKey')?.value?.trim()
  if (!agentKey) { showTradeStatus(statusEl, 'error', 'Enter your Agent Private Key first (Strategies tab).'); return }
  const coin   = '#' + (c.outcome * 10 + c.side)
  const levels = Math.max(2, Math.min(40, parseInt(document.getElementById('ocBotLevels').value) || 10))
  const size   = parseFloat(document.getElementById('ocBotSize').value) || 0
  const lower  = parseFloat(document.getElementById('ocBotLower').value) || 0
  const upper  = parseFloat(document.getElementById('ocBotUpper').value) || 0
  const argv   = ['--coin', coin, '--levels', String(levels)]
  if (size > 0) argv.push('--size', String(size))
  if (lower > 0 && upper > 0 && upper > lower) argv.push('--lower', String(lower), '--upper', String(upper))

  const btn = document.getElementById('ocBotStartBtn')
  btn.disabled = true
  showTradeStatus(statusEl, 'pending', 'Starting…')
  try {
    const r = await serverFetch('/api/start', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type: 'ocgrid', agentKey, args: argv, address: state.addr, instance: coin }),
    })
    if (!r.ok) { showTradeStatus(statusEl, 'error', '✗ ' + (r.error || 'Could not start')); btn.disabled = false; return }
    showTradeStatus(statusEl, 'success', '✓ Bot running — manage in Strategies')
    checkServer()
    _verifyStarted('ocgrid', coin)
    setTimeout(() => closeModals(), 1100)
  } catch {
    showTradeStatus(statusEl, 'error', 'Server unreachable. Is hliq-strat running?')
    btn.disabled = false
  }
}

window.__ocCloseExpanded = function() {
  if (_ocExpandedId !== null) document.getElementById('oc-card-' + _ocExpandedId)?.classList.remove('oc-expanded')
  _ocExpandedId = null
  document.body.classList.remove('oc-card-open')
  document.getElementById('ocExpandBackdrop')?.classList.remove('active')
  const ov = document.getElementById('mobPredictOverlay')
  if (ov) ov.style.zIndex = '0'   // restore — home lip becomes reachable again
}

window.__ocSetCat = function(cat, btn) {
  _ocActiveCat = cat
  document.querySelectorAll('.oc-cat').forEach(b => b.classList.toggle('oc-cat-active', b.dataset.cat === cat))
  window.__ocFilter()
}

window.__ocFilter = function() {
  const q = (document.getElementById('ocSearchInput')?.value || '').toLowerCase().trim()
  document.querySelectorAll('#ocGrid .oc-card').forEach(card => {
    const matchCat = _ocActiveCat === 'all' || card.dataset.cat === _ocActiveCat
    const matchQ   = !q || (card.dataset.q || '').includes(q)
    card.style.display = (matchCat && matchQ) ? '' : 'none'
  })
}

const _OC_SECTIONS = [
  ['crypto','🪙','Crypto'], ['sports','🏆','Sports'], ['politics','🏛️','Politics'],
  ['economy','📈','Economy'], ['tech','🤖','Tech'], ['business','💼','Business'],
  ['culture','🎬','Culture'], ['weather','⛅','Weather'], ['other','🔮','More Markets'],
]

// Group the flat card list into emoji sections + a Trending hero strip.
// Mobile predictions sheet only — the desktop grid stays flat.
function _ocSectionize() {
  const grid = document.getElementById('ocGrid')
  if (!grid) return
  // Runs for both the desktop grid (#outcomesRoot) and the mobile sheet (#mobPredictBody)
  const cards = [...grid.querySelectorAll('.oc-card:not(.oc-event)')]
  if (!cards.length) return
  const cardById = {}
  for (const c of cards) cardById[c.id.replace('oc-card-', '')] = c
  const outById = {}
  for (const o of (_ocLiveOutcomes ?? [])) outById[o.outcome] = o

  // ── HL-native grouping: outcomeMeta.questions lists each event's member
  // outcome ids (namedOutcomes) plus a placeholder leg (fallbackOutcome).
  const hidden = new Set(), grouped = new Set(), eventCards = []
  for (const q of (_ocLiveQuestions ?? [])) {
    if (q.fallbackOutcome != null) hidden.add(String(q.fallbackOutcome))
    const members = (q.namedOutcomes ?? []).map(i => outById[i]).filter(o => o && cardById[String(o.outcome)])
    // Template questions ("Recurring") hold placeholder legs — hide them all
    if (/\b(recurring|fallback|template)\b/i.test(q.name || '') || members.length < 2) {
      for (const i of (q.namedOutcomes ?? [])) hidden.add(String(i))
      continue
    }
    members.forEach(o => grouped.add(String(o.outcome)))

    let sub = null, title = q.name || 'Event'
    const mm = title.match(/^([^:]{2,28}):\s*(.+)$/)
    if (mm) { sub = mm[1]; title = mm[2] }
    let cat = _ocGetCategory({ name: q.name || '', description: '' }, {})
    if (cat === 'other') cat = cardById[String(members[0].outcome)]?.dataset.cat || 'other'

    const evId = 'evt-' + (q.question ?? members[0].outcome)
    const rows = members.map(o => `
      <div class="oc-evt-row" data-name="${esc((o.name || '').toLowerCase())}" data-p="0" onclick="window.__ocExpandCard(${o.outcome})">
        <span class="oc-evt-name">${esc(o.name)}</span>
        <span class="oc-evt-pct" id="oc-evt-pct-${o.outcome}">—</span>
        <span class="oc-evt-chev">›</span>
      </div>`).join('')
    const card = document.createElement('div')
    card.className = 'oc-card oc-event'
    card.dataset.cat = cat
    card.dataset.q = ((q.name || '') + ' ' + members.map(o => o.name).join(' ')).toLowerCase()
    card.id = 'oc-card-' + evId
    card.innerHTML = `
      <div class="oc-evt-head">
        <div class="oc-evt-head-l">
          ${sub ? `<div class="oc-evt-sub">${esc(sub)}</div>` : ''}
          <div class="oc-evt-title">${esc(title)}</div>
        </div>
        <div class="oc-evt-head-r">
          <button class="oc-evt-sort" onclick="event.stopPropagation();window.__ocEvtSort('${evId}',this)">⇅ Odds</button>
          <span class="oc-sec-count">${members.length}</span>
        </div>
      </div>
      <div class="oc-evt-rows" id="oc-evt-rows-${evId}" data-sort="odds">${rows}</div>
      ${members.length > 5 ? `<button class="oc-evt-more" onclick="this.previousElementSibling.classList.toggle('oc-evt-open');this.textContent=this.previousElementSibling.classList.contains('oc-evt-open')?'Show less':'Show all ${members.length}'">Show all ${members.length}</button>` : ''}`
    _ocEvtApplySort(card.querySelector('.oc-evt-rows'))
    eventCards.push(card)
  }

  // Standalone placeholder legs not tied to a question (keep parsable markets
  // like the daily priceBinary series, which are also named "Recurring")
  for (const o of (_ocLiveOutcomes ?? [])) {
    const id = String(o.outcome)
    if (!cardById[id] || hidden.has(id) || grouped.has(id)) continue
    const d = _parseOutcomeDesc(o.description || '')
    if (!d.class && /\b(fallback|recurring|named outcome|template)\b/i.test(o.name || '')) hidden.add(id)
  }

  // ── Compose the new grid ────────────────────────────────────────────────────
  const frag  = document.createDocumentFragment()
  const byCat = {}

  // category buckets: event cards + standalone cards (junk & grouped hidden)
  for (const card of cards) {
    const id = card.id.replace('oc-card-', '')
    card.classList.toggle('oc-junk', hidden.has(id))
    card.classList.toggle('oc-grouped', grouped.has(id))
  }
  for (const ev of eventCards) (byCat[ev.dataset.cat] ??= []).push(ev)
  for (const c of cards) {
    const id = c.id.replace('oc-card-', '')
    if (hidden.has(id) || grouped.has(id)) continue
    (byCat[c.dataset.cat] ??= []).push(c)
  }

  // 🔥 Trending hero — standalone markets only
  const standalone = cards.filter(c => {
    const id = c.id.replace('oc-card-', '')
    return !hidden.has(id) && !grouped.has(id)
  })
  const head = document.createElement('div')
  head.className = 'oc-sec-head'
  head.innerHTML = '<span class="oc-sec-emoji">🔥</span> Trending now'
  frag.appendChild(head)
  const scroller = document.createElement('div')
  scroller.className = 'oc-hot-scroll'
  standalone.slice(0, 6).forEach((c, idx) => {
    const id = c.id.replace('oc-card-', '')
    const q  = c.querySelector('.oc-compact-q')?.textContent ?? ''
    const d  = document.createElement('div')
    d.className = 'oc-hot-card oc-hot-' + (idx % 4)
    d.innerHTML = `<div class="oc-hot-q">${esc(q)}</div><div class="oc-hot-pct" id="oc-hot-pct-${id}">—</div>`
    d.onclick = () => {
      c.scrollIntoView({ behavior: 'smooth', block: 'center' })
      setTimeout(() => window.__ocExpandCard(parseInt(id)), 350)
    }
    scroller.appendChild(d)
  })
  frag.appendChild(scroller)

  for (const [cat, emoji, label] of _OC_SECTIONS) {
    const list = byCat[cat]
    if (!list?.length) continue
    const h = document.createElement('div')
    h.className = 'oc-sec-head'
    h.innerHTML = `<span class="oc-sec-emoji">${emoji}</span> ${label} <span class="oc-sec-count">${list.length}</span>`
    frag.appendChild(h)
    list.forEach(c => frag.appendChild(c))
  }
  // grouped + junk member cards parked at the end (hidden; expand still works)
  for (const c of cards) {
    const id = c.id.replace('oc-card-', '')
    if (hidden.has(id) || grouped.has(id)) frag.appendChild(c)
  }
  grid.innerHTML = ''
  grid.appendChild(frag)
  _ocSectionVis()
}

// Sort an event card's rows: by odds (desc, default) or by name
function _ocEvtApplySort(wrap) {
  if (!wrap) return
  const rows = [...wrap.querySelectorAll('.oc-evt-row')]
  const mode = wrap.dataset.sort || 'odds'
  rows.sort((a, b) => mode === 'name'
    ? (a.dataset.name || '').localeCompare(b.dataset.name || '')
    : (parseFloat(b.dataset.p || 0) - parseFloat(a.dataset.p || 0)) ||
      (a.dataset.name || '').localeCompare(b.dataset.name || ''))
  rows.forEach((r, i) => { r.classList.toggle('oc-evt-extra', i >= 5); wrap.appendChild(r) })
}

window.__ocEvtSort = function(evId, btn) {
  const wrap = document.getElementById('oc-evt-rows-' + evId)
  if (!wrap) return
  wrap.dataset.sort = (wrap.dataset.sort || 'odds') === 'odds' ? 'name' : 'odds'
  if (btn) btn.textContent = wrap.dataset.sort === 'name' ? '⇅ A–Z' : '⇅ Odds'
  _ocEvtApplySort(wrap)
}

// After a price tick, re-sort odds-ordered rows — only if the order changed
function _ocEvtResortAll() {
  document.querySelectorAll('.oc-evt-rows').forEach(wrap => {
    if ((wrap.dataset.sort || 'odds') !== 'odds') return
    const rows = [...wrap.querySelectorAll('.oc-evt-row')]
    const sorted = [...rows].sort((a, b) =>
      (parseFloat(b.dataset.p || 0) - parseFloat(a.dataset.p || 0)) ||
      (a.dataset.name || '').localeCompare(b.dataset.name || ''))
    if (rows.some((r, i) => r !== sorted[i]))
      sorted.forEach((r, i) => { r.classList.toggle('oc-evt-extra', i >= 5); wrap.appendChild(r) })
  })
}

function _ocSectionVis() {
  const grid = document.getElementById('ocGrid')
  if (!grid) return
  const show = _ocActiveCat === 'all' && !(document.getElementById('ocSearchInput')?.value ?? '').trim()
  grid.querySelectorAll('.oc-sec-head, .oc-hot-scroll').forEach(el => { el.style.display = show ? '' : 'none' })
}

async function renderOutcomes() {
  const root = document.getElementById('outcomesRoot')
  if (!root) return
  _stopOcCountdown()
  _ocActiveCat  = 'all'
  _ocExpandedId = null
  root.innerHTML = '<div class="ma-loading">Loading prediction markets…</div>'
  try {
    const info = new InfoClient({ transport: _transport })
    const raw  = await info.outcomeMeta()

    const outcomes = Array.isArray(raw) ? raw : (raw?.outcomes ?? [])
    _ocLiveQuestions = Array.isArray(raw?.questions) ? raw.questions : []
    if (!outcomes.length) {
      root.innerHTML = '<div class="ma-empty">No prediction markets available</div>'
      return
    }
    _buildOcTokenMap(outcomes)
    const connected = isConnected()
    const expiryMap = {}
    const balStr    = connected ? '$' + fmtUSD(_ocAvailBalance()) : 'N/A'

    const cardsHtml = outcomes.map(o => {
      const d      = _parseOutcomeDesc(o.description)
      const { line1, line2 } = _buildFullQuestion(d, o.name)
      const period = d.period || null
      const cls    = d.class || ''
      const cat    = _ocGetCategory(o, d)
      expiryMap[o.outcome] = _expiryDate(d.expiry)
      const disAttr = connected ? '' : 'disabled'

      const targetPrice = d.targetPrice ? parseFloat(d.targetPrice) : null
      const targetStr   = targetPrice ? '$' + targetPrice.toLocaleString() : '—'
      const s0          = o.sideSpecs?.[0]?.name || 'Yes'
      const s1          = o.sideSpecs?.[1]?.name || 'No'
      const searchQ     = (line1 + ' ' + (line2 || '') + ' ' + (o.name || '') + ' ' + s0 + ' ' + s1).toLowerCase()

      return `<div class="oc-card" id="oc-card-${o.outcome}" data-cat="${cat}" data-q="${esc(searchQ)}" onclick="window.__ocExpandCard(${o.outcome})">
        <div class="oc-compact-info">
          <div class="oc-compact-q">${esc(line1)}${line2 ? ' ' + esc(line2) : ''}</div>
          <div class="oc-compact-right">
            <span class="oc-compact-pct" id="oc-compact-pct-${o.outcome}">—</span>
            <span class="oc-compact-cd" id="oc-compact-cd-${o.outcome}">—</span>
          </div>
        </div>
        <div class="oc-mini-row">
          <button class="oc-mini-btn oc-mini-yes" id="oc-mini-yes-${o.outcome}">${esc(s0)} —</button>
          <button class="oc-mini-btn oc-mini-no"  id="oc-mini-no-${o.outcome}">${esc(s1)} —</button>
        </div>
        <button class="oc-card-close" onclick="event.stopPropagation();window.__ocCloseExpanded()">✕</button>
        <div class="oc-card-head">
          <div class="oc-full-q">
            <div>${esc(line1)}</div>
            ${line2 ? `<div class="oc-full-q-line2">${esc(line2)}</div>` : ''}
          </div>
          <div class="oc-card-head-right">
            <span class="oc-status-tag oc-active">Active</span>
            <div class="oc-card-pills">
              ${cls === 'priceBinary' ? '<span class="oc-meta-pill">Binary</span>' : ''}
              ${period ? `<span class="oc-meta-pill">${esc(period)}</span>` : ''}
            </div>
          </div>
        </div>
        <div class="oc-stats-row">
          <div class="oc-stat">
            <div class="oc-stat-label">Chance</div>
            <div class="oc-stat-val" id="oc-chance-${o.outcome}">—</div>
          </div>
          <div class="oc-stat">
            <div class="oc-stat-label">Volume</div>
            <div class="oc-stat-val" id="oc-vol-${o.outcome}">—</div>
          </div>
          <div class="oc-stat">
            <div class="oc-stat-label">Liquidity</div>
            <div class="oc-stat-val" id="oc-oi-${o.outcome}">—</div>
          </div>
        </div>
        <div class="oc-price-row">
          <div class="oc-price-block">
            <div class="oc-price-label">Target</div>
            <div class="oc-price-target">${esc(targetStr)}</div>
          </div>
          <div class="oc-price-block">
            <div class="oc-price-label">Current</div>
            <div class="oc-price-current" id="oc-current-${o.outcome}">—</div>
          </div>
          <div class="oc-price-block oc-price-block--cd">
            <div class="oc-price-label">Closes in</div>
            <div class="oc-countdown" id="oc-cd-${o.outcome}">—</div>
          </div>
        </div>
        <div class="oc-chart-wrap">
          <canvas id="oc-chart-${o.outcome}"></canvas>
        </div>
        <div class="oc-panel" id="oc-panel-${o.outcome}" data-mode="buy" data-side="0" data-otype="market">
          <div class="oc-panel-tabs">
            <button class="oc-tab oc-tab-active" onclick="window.__ocSetMode(${o.outcome},'buy',this)">Buy</button>
            <button class="oc-tab" onclick="window.__ocSetMode(${o.outcome},'sell',this)">Sell</button>
            <span class="oc-tab-space"></span>
            <div class="oc-otype-seg">
              <button class="oc-otype oc-otype-active" onclick="window.__ocSetType(${o.outcome},'market',this)">Market</button>
              <button class="oc-otype" onclick="window.__ocSetType(${o.outcome},'limit',this)">Limit</button>
            </div>
          </div>
          <div class="oc-side-sel-row">
            <button class="oc-side-sel-btn oc-side-yes oc-side-active" id="oc-sel-yes-${o.outcome}"
              onclick="window.__ocSelSide(${o.outcome},0)">
              <span class="oc-sel-name">${esc(s0.toUpperCase())}</span>
              <span class="oc-sel-pct">—</span>
              <span class="oc-sel-price">—</span>
            </button>
            <button class="oc-side-sel-btn oc-side-no" id="oc-sel-no-${o.outcome}"
              onclick="window.__ocSelSide(${o.outcome},1)">
              <span class="oc-sel-name">${esc(s1.toUpperCase())}</span>
              <span class="oc-sel-pct">—</span>
              <span class="oc-sel-price">—</span>
            </button>
          </div>
          <div class="oc-bal-row">
            <span class="oc-bal-label">Available Balance</span>
            <span class="oc-bal-val">${balStr}</span>
          </div>
          <div class="oc-amt-wrap">
            <span class="oc-amt-prefix">$</span>
            <input class="oc-amt-input" id="oc-amt-${o.outcome}" type="number" min="0" step="1" inputmode="decimal"
              placeholder="0" oninput="window.__ocUpdCalc(${o.outcome})">
          </div>
          <div class="oc-quicks-row">
            <button class="oc-quick" onclick="window.__ocAddAmt(${o.outcome},10)">+10</button>
            <button class="oc-quick" onclick="window.__ocAddAmt(${o.outcome},50)">+50</button>
            <button class="oc-quick" onclick="window.__ocAddAmt(${o.outcome},100)">+100</button>
            <button class="oc-quick" onclick="window.__ocAddAmt(${o.outcome},500)">+500</button>
            <button class="oc-quick" onclick="window.__ocMaxAmt(${o.outcome})">Max</button>
          </div>
          <div class="oc-limit-row" id="oc-limit-${o.outcome}" style="display:none">
            <span class="oc-limit-label">Limit price</span>
            <div class="oc-px-group">
              <button class="oc-px-step" onclick="window.__ocStepPx(${o.outcome},-1)" tabindex="-1">−</button>
              <div class="oc-px-wrap">
                <input class="oc-px-input" id="oc-px-${o.outcome}" type="number" min="0.1" max="99.9" step="0.1"
                  inputmode="decimal" placeholder="—" oninput="window.__ocUpdCalc(${o.outcome})">
                <span class="oc-px-suffix">¢</span>
              </div>
              <button class="oc-px-step" onclick="window.__ocStepPx(${o.outcome},1)" tabindex="-1">+</button>
            </div>
          </div>
          <div class="oc-preview" id="oc-prev-${o.outcome}">
            <div class="oc-prev-row"><span>Avg price</span><span class="oc-prev-avg">—</span></div>
            <div class="oc-prev-row"><span>Shares</span><span class="oc-prev-shares">—</span></div>
            <div class="oc-prev-row oc-prev-ret"><span>Potential return</span><span class="oc-prev-val">$0.00</span></div>
          </div>
          <button class="oc-action-btn oc-action-yes" id="oc-action-${o.outcome}"
            ${disAttr} onclick="window.__ocTrade(${o.outcome},this)">
            BUY ${esc(s0.toUpperCase())}
          </button>
          <div class="oc-trade-status" id="oc-status-${o.outcome}"></div>
          <button id="oc-bot-${o.outcome}" onclick="event.stopPropagation();window.__openOcBotModal(${o.outcome},'${esc(s0)}','${esc(s1)}')"
            style="margin-top:8px;width:100%;padding:11px;border-radius:10px;border:1px solid var(--accent);background:transparent;color:var(--accent);font-size:13px;font-weight:700;cursor:pointer">
            ⚡ Configure spread grid bot
          </button>
          <div style="font-size:10px;color:var(--muted);text-align:center;margin-top:5px">Market-maker grid — buys dips, sells rips, never below cost. Manage in Strategies.</div>
        </div>
      </div>`
    }).join('')

    root.innerHTML = `
      <div class="oc-expand-backdrop" id="ocExpandBackdrop" onclick="window.__ocCloseExpanded()"></div>
      <div class="oc-header">
        <div class="oc-search-wrap">
          <svg class="oc-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="5"/><line x1="14" y1="14" x2="10.35" y2="10.35"/></svg>
          <input class="oc-search" id="ocSearchInput" placeholder="Search markets…" oninput="window.__ocFilter()">
        </div>
        <div class="oc-cats" id="ocCats">
          <button class="oc-cat oc-cat-active" data-cat="all" onclick="window.__ocSetCat('all',this)">All</button>
          <button class="oc-cat" data-cat="crypto" onclick="window.__ocSetCat('crypto',this)">Crypto</button>
          <button class="oc-cat" data-cat="sports" onclick="window.__ocSetCat('sports',this)">Sports</button>
          <button class="oc-cat" data-cat="politics" onclick="window.__ocSetCat('politics',this)">Politics</button>
          <button class="oc-cat" data-cat="culture" onclick="window.__ocSetCat('culture',this)">Culture</button>
          <button class="oc-cat" data-cat="economy" onclick="window.__ocSetCat('economy',this)">Economy</button>
          <button class="oc-cat" data-cat="weather" onclick="window.__ocSetCat('weather',this)">Weather</button>
          <button class="oc-cat" data-cat="business" onclick="window.__ocSetCat('business',this)">Business</button>
          <button class="oc-cat" data-cat="tech" onclick="window.__ocSetCat('tech',this)">Tech</button>
          <button class="oc-cat" data-cat="other" onclick="window.__ocSetCat('other',this)">Other</button>
        </div>
      </div>
      <div class="oc-grid" id="ocGrid">${cardsHtml}</div>`
    _ocLiveOutcomes = outcomes
    _ocLiveInfo     = info
    _startOcCountdown(expiryMap)
    _loadOcPrices(outcomes, info)
    // Volume/Liquidity load lazily per card on expand (see __ocExpandCard) — a
    // bulk fetch here would burst ~72 requests and trip HL's rate limit.
    // Cards are collapsed on both mobile and desktop now (charts hidden until a
    // card is expanded) — load each chart lazily on expand to avoid firing ~76
    // candle requests at once and getting rate-limited.
    _ocSectionize()
    if (_ocRefreshInterval) clearInterval(_ocRefreshInterval)
    _ocRefreshInterval = setInterval(_refreshOcPrices, 5000)
  } catch(e) {
    root.innerHTML = `<div class="ma-error">Failed to load: ${esc(e.message)}</div>`
  }
}

function _ocRefreshAction(id) {
  const panel     = document.getElementById('oc-panel-' + id)
  const actionBtn = document.getElementById('oc-action-' + id)
  if (!panel || !actionBtn) return
  const mode = panel.dataset.mode || 'buy'
  const side = parseInt(panel.dataset.side ?? 0)
  const o    = (_ocLiveOutcomes ?? []).find(x => String(x.outcome) === String(id))
  const sideName = (o?.sideSpecs?.[side]?.name || (side === 0 ? 'Yes' : 'No')).toUpperCase()
  actionBtn.textContent = (mode === 'buy' ? 'BUY ' : 'SELL ') + sideName
  actionBtn.className   = 'oc-action-btn ' + (side === 0 ? 'oc-action-yes' : 'oc-action-no')
}

window.__ocSetMode = function(id, mode, btn) {
  const panel = document.getElementById('oc-panel-' + id)
  if (!panel) return
  panel.dataset.mode = mode
  panel.querySelectorAll('.oc-tab').forEach(t => t.classList.remove('oc-tab-active'))
  if (btn) btn.classList.add('oc-tab-active')
  _ocRefreshAction(id)
  window.__ocUpdCalc(id)
}

// Market (aggressive IOC) vs Limit (resting GTC at an editable price).
window.__ocSetType = function(id, type, btn) {
  const panel = document.getElementById('oc-panel-' + id)
  if (!panel) return
  panel.dataset.otype = type
  panel.querySelectorAll('.oc-otype').forEach(t => t.classList.remove('oc-otype-active'))
  if (btn) btn.classList.add('oc-otype-active')
  const limitRow = document.getElementById('oc-limit-' + id)
  if (limitRow) limitRow.style.display = type === 'limit' ? '' : 'none'
  if (type === 'limit') _ocSyncLimitPx(id, true)
  window.__ocUpdCalc(id)
}

// Prefill the limit-price input from the selected side's live mid (in cents).
// force=true overwrites an existing value (used on side flip / mode switch).
function _ocSyncLimitPx(id, force = false) {
  const pxEl = document.getElementById('oc-px-' + id)
  if (!pxEl) return
  if (!force && pxEl.value) return
  const panel  = document.getElementById('oc-panel-' + id)
  const side   = parseInt(panel?.dataset.side ?? 0)
  const prices = _ocPrices[id]
  const mid    = prices ? (side === 0 ? prices.yes : prices.no) : 0
  if (mid > 0) pxEl.value = (mid * 100).toFixed(1)
}

// Effective per-share price (0–1) for the current panel: the editable limit for
// limit orders, else the live mid (market orders cross the spread at fill time).
function _ocEffPx(id) {
  const panel = document.getElementById('oc-panel-' + id)
  if (!panel) return 0
  const side   = parseInt(panel.dataset.side ?? 0)
  const prices = _ocPrices[id]
  const mid    = prices ? (side === 0 ? prices.yes : prices.no) : 0
  if ((panel.dataset.otype || 'market') === 'limit') {
    const cents = parseFloat(document.getElementById('oc-px-' + id)?.value)
    if (cents > 0) return Math.min(0.999, Math.max(0.001, cents / 100))
  }
  return mid
}

window.__ocStepPx = function(id, dir) {
  const pxEl = document.getElementById('oc-px-' + id)
  if (!pxEl) return
  const cur = parseFloat(pxEl.value) || 0
  let v = Math.round((cur + dir * 0.5) * 10) / 10   // 0.5¢ increments
  v = Math.min(99.9, Math.max(0.1, v))
  pxEl.value = v.toFixed(1)
  window.__ocUpdCalc(id)
}

window.__ocSelSide = function(id, sideIndex) {
  const panel = document.getElementById('oc-panel-' + id)
  if (!panel) return
  panel.dataset.side = sideIndex
  document.getElementById('oc-sel-yes-' + id)?.classList.toggle('oc-side-active', sideIndex === 0)
  document.getElementById('oc-sel-no-'  + id)?.classList.toggle('oc-side-active', sideIndex === 1)
  _ocRefreshAction(id)
  if ((panel.dataset.otype || 'market') === 'limit') _ocSyncLimitPx(id, true)
  window.__ocUpdCalc(id)
}

window.__ocAddAmt = function(id, n) {
  const el = document.getElementById('oc-amt-' + id)
  if (el) { el.value = Math.max(0, (parseFloat(el.value) || 0) + n); window.__ocUpdCalc(id) }
}

window.__ocMaxAmt = function(id) {
  const bal = _ocAvailBalance()
  const el  = document.getElementById('oc-amt-' + id)
  if (el) { el.value = Math.floor(bal * 100) / 100; window.__ocUpdCalc(id) }
}

window.__ocUpdCalc = function(id) {
  const panel = document.getElementById('oc-panel-' + id)
  const prev  = document.getElementById('oc-prev-' + id)
  const amtEl = document.getElementById('oc-amt-' + id)
  if (!panel || !prev || !amtEl) return
  const px       = _ocEffPx(id)
  const amount   = parseFloat(amtEl.value) || 0
  const isBuy    = (panel.dataset.mode || 'buy') === 'buy'
  const avgEl    = prev.querySelector('.oc-prev-avg')
  const sharesEl = prev.querySelector('.oc-prev-shares')
  const valEl    = prev.querySelector('.oc-prev-val')
  const retLblEl = prev.querySelector('.oc-prev-ret > span:first-child')
  if (retLblEl) retLblEl.textContent = isBuy ? 'Potential return' : 'Est. proceeds'
  if (avgEl) avgEl.textContent = px > 0 ? (px * 100).toFixed(1) + '¢' : '—'
  if (!px || px <= 0 || px >= 1 || !amount || amount <= 0) {
    if (sharesEl) sharesEl.textContent = '—'
    if (valEl)    valEl.textContent    = '$0.00'
    return
  }
  const shares = Math.floor(amount / px)
  if (sharesEl) sharesEl.textContent = shares.toLocaleString()
  if (!valEl) return
  if (isBuy) {
    const payout = shares                 // each share pays $1 if it wins
    const roi    = ((payout - amount) / amount * 100).toFixed(0)
    valEl.textContent = `$${fmtUSD(payout)} (+${roi}%)`
  } else {
    valEl.textContent = `$${fmtUSD(shares * px)}`
  }
}

// Pull fresh balances/positions shortly after an outcome fill so the Available
// Balance line and any open positions reflect the trade.
function _ocPostTradeRefresh() {
  const addr = state.addr
  if (!addr) return
  setTimeout(async () => {
    try {
      const info = new InfoClient({ transport: _transport })
      const [spot, perp] = await Promise.all([
        info.spotClearinghouseState({ user: addr }).catch(() => null),
        fetchClearinghouseState(addr, null).catch(() => null),
      ])
      if (state.addr !== addr) return
      if (spot) state.spotState = spot
      if (perp) state.perpState = perp
      const balStr = isConnected() ? '$' + fmtUSD(_ocAvailBalance()) : 'N/A'
      document.querySelectorAll('.oc-bal-val').forEach(el => { el.textContent = balStr })
      if (_isMobView()) _mobVRenderBalance()
    } catch {}
  }, 800)
}

window.__ocTrade = async function(id, btn) {
  const panel    = document.getElementById('oc-panel-' + id)
  const amtEl    = document.getElementById('oc-amt-' + id)
  const statusEl = document.getElementById('oc-status-' + id)
  if (!panel || !amtEl) return

  if (!isConnected()) { window.__quickConnectAgent?.(); return }

  const mode    = panel.dataset.mode || 'buy'
  const otype   = panel.dataset.otype || 'market'
  const isMarket = otype === 'market'
  const side    = parseInt(panel.dataset.side ?? 0)
  const isBuy   = mode === 'buy'
  const coin    = '#' + (id * 10 + side)
  const amount  = parseFloat(amtEl.value) || 0

  if (!amount || amount <= 0) {
    if (statusEl) { statusEl.className = 'oc-trade-status oc-status-err'; statusEl.textContent = 'Enter an amount.' }
    return
  }
  // Reference price for sizing = the price this order actually posts at:
  //  · limit → the user's editable limit price
  //  · market → the live mid (the marketable price is derived from it below)
  const refPx = _ocEffPx(id)
  if (!refPx || refPx <= 0 || refPx >= 1) {
    if (statusEl) { statusEl.className = 'oc-trade-status oc-status-err'; statusEl.textContent = 'Price unavailable.' }
    return
  }
  // A market order must cross the *real* top-of-book — outcome spreads are wide
  // (e.g. 0.85/0.90), so a flat mid±% can miss the ask entirely. Fetch the live
  // book and post just beyond the touch with an IOC tif: it fills at the resting
  // levels (better prices) and cancels any remainder. A limit order rests at refPx.
  const SLIP = 0.025
  let postPx = refPx
  let sizePx = refPx   // price to divide $ amount by → share count
  if (isMarket) {
    let touch = refPx
    try {
      const info = _ocLiveInfo || new InfoClient({ transport: _transport })
      const book = await info.l2Book({ coin })
      const bestBid = parseFloat(book?.levels?.[0]?.[0]?.px ?? 0)
      const bestAsk = parseFloat(book?.levels?.[1]?.[0]?.px ?? 0)
      touch = isBuy ? (bestAsk || refPx) : (bestBid || refPx)
    } catch {}
    postPx = isBuy ? Math.min(0.999, touch * (1 + SLIP)) : Math.max(0.001, touch * (1 - SLIP))
    // Size a market BUY off the ask (execution price), not the mid, so spending
    // "all available" doesn't round up past the balance and get rejected.
    if (isBuy) sizePx = touch
  }

  // Outcome shares are whole units; HL also enforces a $10 minimum order value,
  // so round to the nearest share and bump up if the notional would fall under $10.
  let sz = Math.round(amount / sizePx)
  if (sz < 1) sz = 1
  if (sz * sizePx < 10) sz = Math.ceil(10 / sizePx)
  if (sz <= 0) {
    if (statusEl) { statusEl.className = 'oc-trade-status oc-status-err'; statusEl.textContent = 'Amount too small.' }
    return
  }

  if (statusEl) { statusEl.className = 'oc-trade-status oc-status-pending'; statusEl.textContent = isMarket ? 'Placing market order…' : 'Placing limit order…' }
  btn.disabled = true
  try {
    const result   = await placeOutcomeOrder({ coin, isBuy, sz, limitPx: postPx, market: isMarket })
    const statuses = result?.response?.data?.statuses ?? []
    if (statuses.some(s => s?.resting || s?.filled)) {
      const filled = statuses.find(s => s?.filled)?.filled
      if (statusEl) {
        statusEl.className = 'oc-trade-status oc-status-ok'
        statusEl.textContent = filled ? `✓ Filled ${filled.totalSz} @ ${(parseFloat(filled.avgPx) * 100).toFixed(1)}¢` : '✓ Limit order resting.'
      }
      _ocPostTradeRefresh()
    } else {
      const err = statuses.find(s => s?.error)?.error ?? 'Unknown error'
      if (statusEl) { statusEl.className = 'oc-trade-status oc-status-err'; statusEl.textContent = '✗ ' + err }
    }
  } catch(e) {
    if (statusEl) { statusEl.className = 'oc-trade-status oc-status-err'; statusEl.textContent = '✗ ' + e.message }
  } finally {
    btn.disabled = false
  }
}

// ── Shareable PnL card ────────────────────────────────────────────────────────
// Escape a value for embedding inside a single-quoted JS string that itself sits
// in a double-quoted HTML onclick attribute.
const _jsStr = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;')
let _shareData   = null
let _shareBg     = null   // user-uploaded background as a data: URL (CORS-safe for export)
let _shareAccent = '#ff8a2a'

window.__shareBgPick = function(input) {
  const f = input.files?.[0]
  if (!f) return
  if (!f.type.startsWith('image/')) { alert('Please choose an image file.'); return }
  const rd = new FileReader()
  rd.onload = () => { _shareBg = rd.result; window.__shareRenderPreview() }
  rd.readAsDataURL(f)
}
window.__shareBgClear = function() {
  _shareBg = null
  const i = document.getElementById('shareBgInput'); if (i) i.value = ''
  window.__shareRenderPreview()
}
const _SHARE_ACCENTS = ['#ff8a2a', '#00e5a0', '#4da2ff', '#b57bff', '#ff5c8a']

// Leverage HL applied to a coin, read from the current open position (fills carry
// no leverage, so this is how a closed-trade ROE gets leveraged to match HL).
window.__coinLeverage = function(coin) {
  const op = (state.perpState?.assetPositions ?? []).find(ap => ap.position?.coin === coin)
  const v  = op ? parseFloat(op.position?.leverage?.value) : NaN
  return Number.isFinite(v) && v > 0 ? v : 1
}

// Share a CLOSED trade's PnL card. This is a fixed historical snapshot — it must
// NOT change between opens, so we always use the trade's realized entry/exit/PnL
// (passed in `d`, with an un-leveraged price roePct) and only resolve the stable
// leverage VALUE to scale it: ROE = priceReturn × leverage, matching HL. Leverage
// comes from the coin's live position if held, else its persisted per-coin setting
// (activeAssetData) — both are settings, not the fluctuating returnOnEquity.
window.__shareTrade = async function(coin, d) {
  // Outcome markets (#N/+N) are unleveraged 1× — never scale their return.
  const isOc = typeof coin === 'string' && (coin[0] === '#' || coin[0] === '+')
  let lev = isOc ? 1 : window.__coinLeverage(coin)   // open-position leverage (stable), else 1
  if (!isOc && lev <= 1) {
    try {
      const r  = await fetch('https://api.hyperliquid.xyz/info', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'activeAssetData', user: state.addr, coin }),
      })
      const ad = await r.json()
      const v  = parseFloat(ad?.leverage?.value)
      if (Number.isFinite(v) && v > 0) lev = v
    } catch {}
  }
  window.__openShareCard({ ...d, coin, lev, roePct: (Number(d.roePct) || 0) * lev })
}

window.__openShareCard = function(d) {
  const lev = Number(d.lev) || 1
  _shareData = {
    title:  d.title || d.coin || 'Position',
    side:   d.side || '',
    lev,
    roePct: Number(d.roePct) || 0,
    entry:  d.entry || '—',
    mark:   d.mark || '—',
    coin:   d.coin || '',
  }
  const m = document.getElementById('shareCardModal'); if (!m) return
  const inp = document.getElementById('shareTextInput')
  // Side + leverage render as a fixed badge on the card, so the caption is just the market.
  if (inp) inp.value = d.caption || _shareData.title
  _shareBuildAccents()
  window.__shareRenderPreview()
  m.classList.add('show')
}
window.__closeShareCard = function() { document.getElementById('shareCardModal')?.classList.remove('show') }

function _shareBuildAccents() {
  const row = document.getElementById('shareAccentRow'); if (!row) return
  row.innerHTML = _SHARE_ACCENTS.map(c =>
    `<span class="share-accent-dot${c === _shareAccent ? ' on' : ''}" style="background:${c}" onclick="window.__shareSetAccent('${c}')"></span>`).join('')
}
window.__shareSetAccent = function(c) { _shareAccent = c; _shareBuildAccents(); window.__shareRenderPreview() }

window.__shareRenderPreview = function() {
  const d = _shareData; if (!d) return
  const el = document.getElementById('shareCardPreview'); if (!el) return
  // '' reverts to the stylesheet's gradient+rings; a data URL overrides with a
  // scrim (for legibility) over the user's image.
  el.style.background = _shareBg
    ? `linear-gradient(90deg, rgba(6,7,10,0.82), rgba(6,7,10,0.32)), linear-gradient(0deg, rgba(6,7,10,0.62), rgba(6,7,10,0) 42%), url("${_shareBg}") center/cover`
    : ''
  const caption = document.getElementById('shareTextInput')?.value || d.title
  const up  = d.roePct >= 0
  const col = up ? '#00e5a0' : '#ff4d6d'
  const pct = (up ? '+' : '') + d.roePct.toFixed(1) + '%'
  const a   = _shareAccent
  el.innerHTML = `
    <div style="position:absolute;inset:0;padding:5.5% 6% 5%;display:flex;flex-direction:column;justify-content:space-between;box-sizing:border-box">
      <div style="display:flex;align-items:center;gap:5px;font-family:'JetBrains Mono',monospace;font-weight:800;font-size:clamp(15px,2.3vw,26px)">
        <span style="color:${a}">&gt;</span><span>insolvent</span>
      </div>
      <div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:1.5%">
          <span style="color:#c8cdd8;font-size:clamp(12px,1.7vw,19px);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(caption)}</span>
          ${d.side ? `<span style="font-size:clamp(10px,1.35vw,15px);font-weight:800;letter-spacing:.03em;color:${/short/i.test(d.side) ? '#ff4d6d' : '#00e5a0'}">${esc(d.side.toUpperCase())}</span>` : ''}
          ${d.lev > 1 ? `<span style="font-size:clamp(9px,1.2vw,13px);font-weight:700;font-family:'JetBrains Mono',monospace;color:#e6e9f0;background:rgba(255,255,255,0.1);padding:2px 7px;border-radius:6px">${d.lev}x</span>` : ''}
        </div>
        <div style="font-weight:800;font-size:clamp(40px,9vw,96px);line-height:1;color:${col}">${pct}</div>
      </div>
      <div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px">
        <div style="display:flex;gap:clamp(20px,4vw,44px)">
          <div><div style="font-size:clamp(9px,1.1vw,12px);color:#8a92a3">Entry Price</div><div style="font-family:'JetBrains Mono',monospace;font-weight:600;font-size:clamp(13px,1.7vw,20px)">${esc(d.entry)}</div></div>
          <div><div style="font-size:clamp(9px,1.1vw,12px);color:#8a92a3">Mark Price</div><div style="font-family:'JetBrains Mono',monospace;font-weight:600;font-size:clamp(13px,1.7vw,20px)">${esc(d.mark)}</div></div>
        </div>
        <div style="text-align:right"><div style="font-size:clamp(9px,1.1vw,12px);color:#8a92a3">Trade on</div><div style="font-family:'JetBrains Mono',monospace;font-weight:700;color:${a};font-size:clamp(12px,1.6vw,18px)">insolvent.trade</div></div>
      </div>
    </div>
    <img src="/pwa-512x512.png?v=5" alt="" style="position:absolute;right:5.5%;top:5%;width:clamp(44px,9vw,82px);height:auto;border-radius:18%;box-shadow:0 0 40px ${a}66">`
}

function _rr(ctx, x, y, w, h, r) {
  ctx.beginPath()
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
function _drawCover(ctx, img, W, H) {
  const ir = img.width / img.height, cr = W / H
  let dw, dh, dx, dy
  if (ir > cr) { dh = H; dw = H * ir; dx = (W - dw) / 2; dy = 0 }
  else         { dw = W; dh = W / ir; dx = 0; dy = (H - dh) / 2 }
  ctx.drawImage(img, dx, dy, dw, dh)
}
function _shareTrunc(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return t + '…'
}

async function _shareDrawCanvas() {
  const d = _shareData, a = _shareAccent
  const W = 1200, H = 675
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H
  const ctx = canvas.getContext('2d')
  try { await document.fonts.ready } catch {}
  if (_shareBg) {
    await new Promise(res => { const im = new Image(); im.onload = () => { _drawCover(ctx, im, W, H); res() }; im.onerror = res; im.src = _shareBg })
    const s1 = ctx.createLinearGradient(0, 0, W, 0); s1.addColorStop(0, 'rgba(6,7,10,0.82)'); s1.addColorStop(1, 'rgba(6,7,10,0.32)')
    ctx.fillStyle = s1; ctx.fillRect(0, 0, W, H)
    const s2 = ctx.createLinearGradient(0, H, 0, H * 0.5); s2.addColorStop(0, 'rgba(6,7,10,0.62)'); s2.addColorStop(1, 'rgba(6,7,10,0)')
    ctx.fillStyle = s2; ctx.fillRect(0, 0, W, H)
  } else {
    const g = ctx.createRadialGradient(W * 0.66, H * 0.5, 60, W * 0.66, H * 0.5, 920)
    g.addColorStop(0, '#16241e'); g.addColorStop(0.56, '#0a0c10'); g.addColorStop(1, '#06070a')
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H)
    ctx.strokeStyle = a + '14'; ctx.lineWidth = 2
    for (let r = 50; r < 700; r += 34) { ctx.beginPath(); ctx.arc(W * 0.70, H * 0.52, r, 0, Math.PI * 2); ctx.stroke() }
  }
  ctx.strokeStyle = a + '44'; ctx.lineWidth = 3; _rr(ctx, 12, 12, W - 24, H - 24, 26); ctx.stroke()
  const P = 66
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
  ctx.font = '800 42px "JetBrains Mono", monospace'
  ctx.fillStyle = a; ctx.fillText('>', P, 98)
  ctx.fillStyle = '#e5e9f0'; ctx.fillText('insolvent', P + 36, 98)
  const caption = document.getElementById('shareTextInput')?.value || d.title
  ctx.font = '600 32px "Inter", system-ui, sans-serif'; ctx.fillStyle = '#c8cdd8'
  const capText = _shareTrunc(ctx, caption, W - P * 2 - 320)   // leave room for the side/lev badge
  ctx.fillText(capText, P, 336)
  // Side + leverage badge, right of the caption (matches the preview).
  let _bx = P + ctx.measureText(capText).width + 20
  if (d.side) {
    const sideTxt = d.side.toUpperCase()
    ctx.font = '800 27px "Inter", system-ui, sans-serif'
    ctx.fillStyle = /short/i.test(d.side) ? '#ff4d6d' : '#00e5a0'
    ctx.fillText(sideTxt, _bx, 336)
    _bx += ctx.measureText(sideTxt).width + 14
  }
  if (d.lev > 1) {
    const lt = d.lev + 'x'
    ctx.font = '700 23px "JetBrains Mono", monospace'
    const lw = ctx.measureText(lt).width
    ctx.fillStyle = 'rgba(255,255,255,0.12)'; _rr(ctx, _bx, 311, lw + 20, 33, 8); ctx.fill()
    ctx.fillStyle = '#e6e9f0'; ctx.fillText(lt, _bx + 10, 336)
  }
  const up = d.roePct >= 0, col = up ? '#00e5a0' : '#ff4d6d'
  ctx.font = '800 132px "Inter", system-ui, sans-serif'; ctx.fillStyle = col
  ctx.fillText((up ? '+' : '') + d.roePct.toFixed(1) + '%', P - 4, 476)
  ctx.font = '500 21px "JetBrains Mono", monospace'; ctx.fillStyle = '#8a92a3'
  ctx.fillText('Entry Price', P, 566); ctx.fillText('Mark Price', P + 250, 566)
  ctx.font = '600 30px "JetBrains Mono", monospace'; ctx.fillStyle = '#e5e9f0'
  ctx.fillText(d.entry, P, 606); ctx.fillText(d.mark, P + 250, 606)
  ctx.textAlign = 'right'
  ctx.font = '500 21px "JetBrains Mono", monospace'; ctx.fillStyle = '#8a92a3'; ctx.fillText('Trade on', W - P, 566)
  ctx.font = '700 27px "JetBrains Mono", monospace'; ctx.fillStyle = a; ctx.fillText('insolvent.trade', W - P, 606)
  ctx.textAlign = 'left'
  await new Promise(res => {
    const img = new Image()
    img.onload = () => {
      const s = 118, x = W - P - s, y = 64
      ctx.save(); ctx.shadowColor = a; ctx.shadowBlur = 34
      _rr(ctx, x, y, s, s, 22); ctx.clip(); ctx.drawImage(img, x, y, s, s); ctx.restore()
      res()
    }
    img.onerror = res
    img.src = '/pwa-512x512.png?v=5'
  })
  return canvas
}

window.__shareSaveImage = async function(btn) {
  const t = btn.textContent; btn.disabled = true; btn.textContent = 'Rendering…'
  try {
    const c = await _shareDrawCanvas()
    const a = document.createElement('a')
    a.download = 'insolvent-' + ((_shareData?.coin || 'pnl').replace(/[^a-z0-9]/gi, '') || 'pnl') + '.png'
    a.href = c.toDataURL('image/png'); a.click()
  } catch (e) { alert('Could not render image: ' + (e?.message || e)) }
  finally { btn.disabled = false; btn.textContent = t }
}
window.__shareCopyLink = async function(btn) {
  try { await navigator.clipboard.writeText('https://insolvent.trade'); const t = btn.textContent; btn.textContent = '✓ Copied'; setTimeout(() => { btn.textContent = t }, 1500) }
  catch { alert('Copy failed — link: https://insolvent.trade') }
}
window.__shareOnX = function() {
  const d = _shareData; if (!d) return
  const cap = document.getElementById('shareTextInput')?.value || d.title
  const up  = d.roePct >= 0
  const txt = `${cap}\n${(up ? '+' : '') + d.roePct.toFixed(1)}% on Insolvent Terminal 📈`
  window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(txt) + '&url=' + encodeURIComponent('https://insolvent.trade'), '_blank', 'noopener')
}

// ── Desktop Overview: outcome (prediction) holdings manager ──────────────────
// Bridges consumed by render.js's Overview "Outcomes" sub-tab. Reuses the same
// close flow (_mobOcClose) and mark math as the mobile outcome cards.
window.__ovOutcomeHoldings = function() {
  const isOc = c => typeof c === 'string' && (c[0] === '+' || c[0] === '#' || /^o\d/.test(c))
  return (state.spotState?.balances ?? []).filter(b => isOc(b.coin) && parseFloat(b.total ?? 0) > 0)
}

function _ovOcRow(b, id) {
  const total = parseFloat(b.total ?? 0)
  const hold  = parseFloat(b.hold ?? 0)
  const cost  = parseFloat(b.entryNtl ?? 0)
  const n     = parseInt(String(b.coin).replace(/[^\d]/g, '')) || 0
  const oid   = Math.floor(n / 10), side = n % 10
  const entry = total > 0 ? cost / total : 0
  const fromBook  = _ocMarkCache[b.coin] || 0
  const fromPanel = _ocPrices?.[oid] ? (side === 0 ? _ocPrices[oid].yes : _ocPrices[oid].no) : 0
  const mark  = fromBook > 0 ? fromBook : (fromPanel > 0 ? fromPanel : entry)
  const value = total * mark
  const pnl   = (mark - entry) * total
  const roe   = cost > 0 ? pnl / cost * 100 : 0
  const cls   = pnl >= 0 ? 'pos' : 'neg'
  const title = state.ocQuestionMap?.[oid] || _ocCoinLabel(b.coin)
  const sideTxt = side === 0 ? 'YES' : 'NO'
  const sideCls = side === 0 ? 'pos' : 'neg'
  const key = String(n)
  return `<div class="ov-oc-item">
    <div class="ov-ord-row ov-oc-row" onclick="window.__ovToggleOc('${id}')">
      <span class="ov-pos-mkt"><div class="ov-av-img">${_coinIconHtml(b.coin)}</div><span class="ov-pos-info"><b>${esc(title)}</b><i>${fmtSize(total)} shares</i></span></span>
      <span class="ov-side-badge ${sideCls}">${sideTxt}</span>
      <span class="ov-r mono" id="ovocmark-${key}">${mark > 0 ? (mark * 100).toFixed(2) + '¢' : '—'}</span>
      <span class="ov-r mono">$${fmtUSD(value)}</span>
      <span class="ov-r mono ${cls}" id="ovocpnl-${key}">${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))} · ${roe >= 0 ? '+' : ''}${roe.toFixed(1)}%</span>
      <span class="ov-r"><button class="ov-close-x" title="Close position" onclick="event.stopPropagation();window.__ovToggleOc('${id}')">✕</button></span>
    </div>
    <div class="ov-oc-close" id="ovocp-${id}" style="display:none" onclick="event.stopPropagation()">
      <div class="ov-oc-inputs">
        <label>Shares<input id="ocsz-${id}" type="number" value="${Math.max(0, Math.floor(total - hold))}"></label>
        <label>Limit ¢ / share<input id="ocpx-${id}" type="number" step="0.1" value="${mark > 0 ? (mark * 100).toFixed(1) : ''}"></label>
      </div>
      <div class="ov-oc-btns">
        <button class="manage-btn" onclick="window._mobOcClose('#${n}','limit','${id}',this)">Limit Close</button>
        <button class="manage-btn close" onclick="window._mobOcClose('#${n}','market','${id}',this)">Market Close</button>
        <button class="manage-btn" onclick="window.__openShareCard({coin:'${_jsStr(b.coin)}',title:'${_jsStr(title)}',side:'${sideTxt}',roePct:${roe.toFixed(2)},entry:'${(entry * 100).toFixed(2)}¢',mark:'${mark > 0 ? (mark * 100).toFixed(2) + '¢' : '—'}'})">↗ Share</button>
      </div>
      <div id="ocst-${id}" class="ov-oc-status"></div>
    </div>
  </div>`
}
window.__ovToggleOc = function(id) {
  const el = document.getElementById('ovocp-' + id)
  if (el) el.style.display = el.style.display === 'none' ? '' : 'none'
}
window.__ovBuildOcBody = function() {
  const holdings = window.__ovOutcomeHoldings()
  if (!holdings.length) return '<div class="ov-empty">No outcome positions</div>'
  const head = `<div class="ov-ord-head ov-oc-row"><span>Market</span><span>Side</span><span class="ov-r">Mark</span><span class="ov-r">Value</span><span class="ov-r">PnL</span><span class="ov-r"></span></div>`
  return `${head}<div class="ov-pos-scroll">${holdings.map((b, i) => _ovOcRow(b, `ovoc-${i}`)).join('')}</div>`
}
window.__ovUpdateOcMarks = async function() {
  for (const b of window.__ovOutcomeHoldings()) {
    const n = parseInt(String(b.coin).replace(/[^\d]/g, '')) || 0; if (!n) continue
    try {
      const book = await infoClient.l2Book({ coin: '#' + n })
      const bid  = parseFloat(book.levels?.[0]?.[0]?.px ?? 0), ask = parseFloat(book.levels?.[1]?.[0]?.px ?? 0)
      const mark = (bid > 0 && ask > 0) ? (bid + ask) / 2 : (bid || ask); if (!(mark > 0)) continue
      _ocMarkCache[b.coin] = mark
      const total = parseFloat(b.total || 0), cost = parseFloat(b.entryNtl || 0), entry = total > 0 ? cost / total : 0
      const pnl = (mark - entry) * total, roe = cost > 0 ? pnl / cost * 100 : 0, cls = pnl >= 0 ? 'pos' : 'neg', key = String(n)
      const mk = document.getElementById('ovocmark-' + key); if (mk) mk.textContent = (mark * 100).toFixed(2) + '¢'
      const pe = document.getElementById('ovocpnl-' + key); if (pe) { pe.textContent = `${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))} · ${roe >= 0 ? '+' : ''}${roe.toFixed(1)}%`; pe.className = 'ov-r mono ' + cls }
    } catch {}
  }
}

function renderOutcomePositions() {
  const section = document.getElementById('outcomePositionsSection')
  const tbody   = document.getElementById('outcomePositionsTbody')
  if (!section || !tbody) return

  const ocOrders = (state.openOrders ?? []).filter(o => /^#\d+$/.test(o.coin))

  if (!ocOrders.length) {
    section.style.display = 'none'
    return
  }

  section.style.display = ''
  tbody.innerHTML = ocOrders.map(o => {
    const entry   = state.ocTokenMap[o.coin] ?? {}
    const market  = entry.name || o.coin
    const side    = entry.side || (o.side === 'B' ? 'Buy' : 'Sell')
    const isYes   = side.toLowerCase() === 'yes'
    const px      = parseFloat(o.limitPx ?? 0)
    const sz      = parseFloat(o.sz ?? 0)
    const value   = px * sz
    const sideCls = isYes ? 'pos' : 'neg'

    return `<tr>
      <td><b>${esc(market)}</b></td>
      <td><span class="${sideCls}" style="font-weight:700">${esc(side)}</span></td>
      <td style="font-family:var(--font-mono)">${fmtSize(sz)}</td>
      <td style="font-family:var(--font-mono)">$${fmtPrice(px)}</td>
      <td style="font-family:var(--font-mono)">$${fmtUSD(value)}</td>
      <td>
        <button class="manage-btn close" onclick="window.__cancelOrder('${esc(o.coin)}',${o.oid},false,this)">✕ Cancel</button>
      </td>
    </tr>`
  }).join('')
}

// ─── UI MODE TOGGLES ──────────────────────────────────────────────────────────
window.__toggleForceMobile = function(checked) {
  localStorage.setItem('hliq_force_mobile', checked ? '1' : '0')
  if (checked) {
    renderMobileView()
  } else {
    mobVHide()
    renderAll()
  }
}

window.matchMedia('(orientation: landscape)').addEventListener('change', e => {
  if (localStorage.getItem('hliq_force_mobile') === '1') return
  if (e.matches) { mobVHide(); renderAll() }
  else renderMobileView()
})

// Initial ticker render
updateWatchTicker()
_applyDevMode()
_applyPrivacyUI()   // restore persisted privacy (body.priv blur + toggle icons)

// Predictions sheet: keep section headers in sync with category/search filtering
;(() => {
  const orig = window.__ocFilter
  if (typeof orig === 'function') {
    window.__ocFilter = function() { orig(); try { _ocSectionVis() } catch {} }
  }
})()
