import './style.css'
const _il = document.getElementById('init-loader')
if (_il) _il.remove()
import { InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { loadAccountData, loadFundingData, buildAssetMap, infoClient, fetchAllMids } from './api.js'
import {
  renderOverview,
  renderPositions,
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
  skeletonStatCards,
  skeletonRows,
  setSortPos,
  setSortOrd,
  setSortMPos,
  setSortMOrd,
  setTradesPage,
  getTradesPage,
  renderSummaryCards,
} from './render.js'
import { renderCharts, destroyCharts } from './charts.js'
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
    ctx.save()
    ctx.beginPath(); ctx.rect(area.left, area.top, area.right - area.left, area.bottom - area.top); ctx.clip()
    for (let i = 0; i < n; i++) {
      const d = chart._candleData[i]; if (!d) continue
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
  placeTriggerOrder,
  closePosition,
  cancelOrder,
  modifyOrderPrice,
  parseOrderResult,
  approveBuilderFee,
  setBuilderFeeEnabled,
  isBuilderFeeEnabled,
  applyReferrer,
  fetchCandles,
  fetchMarketCtxs,
  fetchPerpCategories,
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
} from './wallet.js'
import { deposit, withdraw, getUsdcBalance } from './defi.js'
import { fmtUSD, fmtPrice, fmtSize, fmtPnL, fmtCompact, esc, parseFills, parseFunding } from './format.js'
import {
  initRisk, updateAccountValue, computeLossStreak,
  maybeSendLiqNotification, checkLiquidation,
  isPaused, resume, getRiskState,
  setThresholds, requestNotifications, notifPermission,
} from './risk.js'

// ─── STATE ────────────────────────────────────────────────────────────────────
const INITIAL_STATE = () => ({
  addr:           null,
  perpState:      null,
  spotState:      null,
  openOrders:     [],
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
  leverage:       5,
  isIsolated:     false,
  sizeMode:       'usd',   // 'usd' or 'coin'
  editingPos:     null,
  closingPos:     null,
  currentPeriod:  'day',
  ledger:         [],
  calMonth:       new Date().getMonth(),
  calYear:        new Date().getFullYear(),
  transferFilter: 'all',
  basicMode:      localStorage.getItem('hliq_basicMode') === '1',
})
let state = INITIAL_STATE()
window.__getState = () => state

let perfChart = null

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

// ─── WALLET MANAGER ──────────────────────────────────────────────────────────
const WM = {
  load()              { return JSON.parse(localStorage.getItem('savedWallets') || '[]') },
  save(list)          { localStorage.setItem('savedWallets', JSON.stringify(list)) },
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
      <button class="mob-mode-btn" id="mobModeBtn" onclick="window.toggleBasicMode()">
        <span class="mode-switch"></span>
        <span id="mobModeBtnLabel">${state.basicMode ? 'Basic' : 'Advanced'}</span>
      </button>
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

// ─── LOAD DASHBOARD ──────────────────────────────────────────────────────────
async function loadDashboard() {
  const addr = document.getElementById('walletInput').value.trim()

  if (!addr || !addr.startsWith('0x') || addr.length < 42) {
    showError('Please enter a valid 0x wallet address (42+ characters).')
    return
  }
  localStorage.setItem('walletAddr', addr)

  document.getElementById('loadBtn').disabled = true
  document.getElementById('errorBox').classList.remove('active')
  document.getElementById('inputArea').style.display = 'none'
  document.getElementById('loadingOverlay').classList.add('active')

  try {
    const isMobile = window.innerWidth <= 768
    const raw      = await loadAccountData(addr, setStep, { mobile: isMobile })
    const fills    = parseFills(raw.fills)

    state = {
      ...state,
      addr,
      perpState:  raw.perpState,
      spotState:  raw.spotState,
      openOrders: raw.openOrders,
      fills,
      funding:    [],    // populated in background below
      portfolio:  raw.portfolio,
      allMids:    raw.allMids,
      assetMap:   buildAssetMap(raw.meta),
      allMetas:   raw.allMetas,
      webData:    null,  // populated in background below
      sessionStart: Date.now(),
    }
    // Seed perp name list from already-fetched allMetas so Watch search doesn't re-fetch
    if (raw.allMetas) {
      const names = new Set()
      for (const dex of raw.allMetas) for (const u of (dex.universe ?? [])) names.add(u.name)
      _perpNames = [...names]
    }

    pushRecentAddr(addr)
    renderAll()
    _szSyncSlider()
    _disconnectAgentKeyUI()
    _resetMainWalletUI()
    restoreAgentKey(addr)
    restoreWalletForAddr(addr)
    const _wdrawEl = document.getElementById('withdrawAvail')
    if (_wdrawEl) {
      const _perpWdraw  = parseFloat(state.perpState?.withdrawable ?? 0)
      const _spotUSDC   = (state.spotState?.balances ?? []).find(b => b.coin === 'USDC')
      const _spotFree   = _spotUSDC ? Math.max(0, parseFloat(_spotUSDC.total ?? 0) - parseFloat(_spotUSDC.hold ?? 0)) : 0
      _withdrawAvailable = _perpWdraw + _spotFree
      _wdrawEl.textContent = `Available: ${_withdrawAvailable.toFixed(2)} USDC`
    }
    document.getElementById('loadingOverlay').classList.remove('active')
    document.getElementById('dashboard').classList.add('active')

    initRisk(totalPerpEquity(raw.perpState))
    computeLossStreak(parseFills(raw.fills))
    updateRiskUI()

    if (liveTimer)    clearInterval(liveTimer)
    if (sessionTimer) clearInterval(sessionTimer)

    // Cache first fill time so mobile (90-day) loads still show correct "Member Since"
    const FIRST_FILL_KEY = 'hliq_first_fill_' + addr
    if (!isMobile && fills.length > 0) {
      localStorage.setItem(FIRST_FILL_KEY, fills[fills.length - 1].time)
    }
    const cachedFirstFill = localStorage.getItem(FIRST_FILL_KEY)
    state.firstFillTime = cachedFirstFill ? parseInt(cachedFirstFill) : null

    liveTimer    = setInterval(refreshLive, 5000)
    sessionTimer = setInterval(tickSessionUptime, 1000)
    // Fast mids refresh — drives the available-to-trade display between full refreshes
    setInterval(() => {
      if (!state.addr) return
      infoClient.allMids().then(m => {
        state.allMids = { ...state.allMids, ...m }
        _updateAvailDisplay()
      }).catch(() => {})
    }, 2000)
    // Refresh HIP-3 mids separately every 60s (they don't need per-tick updates)
    setInterval(() => {
      if (state.allMetas) fetchAllMids(state.allMetas).then(m => { state.allMids = m }).catch(() => {})
    }, 60000)

    if (!isMobile) fetchAllTimeVolume(addr)
    fetchLedger(addr)
    fetchSubAccounts(addr)

    // HIP-3 DEX mids — patch allMids silently when ready
    raw.hip3Promise.then(merged => {
      if (state.addr !== addr) return
      state.allMids = merged
    }).catch(() => {})

    // Funding + webData in background — re-renders stats when ready
    loadFundingData(addr, { mobile: isMobile }).then(({ funding, webData }) => {
      if (state.addr !== addr) return
      state.funding = parseFunding(funding)
      state.webData = webData ?? null
      renderAccountSection()
    }).catch(e => console.warn('Background funding load failed:', e.message))

  } catch (e) {
    console.error(e)
    document.getElementById('loadingOverlay').classList.remove('active')
    document.getElementById('inputArea').style.display = ''
    document.getElementById('loadBtn').disabled = false
    showError('Failed to load account: ' + e.message)
  }
}

// ─── RENDER SECTIONS ──────────────────────────────────────────────────────────
function renderAccountSection() {
  const { perpState, spotState, fills, funding, portfolio, allMids, openOrders } = state
  renderOverview({ perpState, spotState, fills, funding, openOrders, allMids, portfolio, webData: state.webData, sessionStart: state.sessionStart, firstFillTime: state.firstFillTime ?? null })
  renderPortfolioStats({ perpState, spotState, fills, funding, portfolio, webData: state.webData })
  renderSummaryCards(fills, perpState)
}

function renderPositionSection() {
  const { perpState, spotState, openOrders, allMids } = state
  renderPositions(perpState, allMids, state.openOrders ?? [])
  renderSpot(spotState)
  renderOrders(openOrders, perpState)
}

function renderHistorySection() {
  renderTrades(state.fills)
  renderPnLCalendar(state.fills, state.calMonth, state.calYear, state.ledger)
  renderTransfers(state.ledger, state.transferFilter)
}

function renderMarketSection() {
  const { fills, allMids, perpState, openOrders } = state
  renderMarkets({ fills, allMids, perpState })
  renderManageTables(perpState, openOrders, allMids)
  populateCoinDropdown()
  updateTradeBalance()
  _updateAvailDisplay()
}

// ─── RENDER ALL ───────────────────────────────────────────────────────────────
function renderAll() {
  renderWalletStrip(state.addr)
  restoreAssetLists(state.addr)

  renderAccountSection()
  renderPositionSection()
  renderHistorySection()
  renderMarketSection()
  updateWatchTicker()
  _applyBasicMode()

  setTimeout(() => renderChartPeriod('day'), 80)
}

function totalPerpEquity(perpState) {
  // Use portfolio allTime latest as primary — same source as the Overview card.
  // Falls back to live marginSummary.accountValue if portfolio isn't loaded.
  const entry   = (state.portfolio ?? []).find(p => p[0] === 'allTime')
  const history = entry?.[1]?.accountValueHistory ?? []
  const last    = history.at(-1)
  if (last) return parseFloat(last[1])
  return parseFloat(perpState.marginSummary?.accountValue ?? 0)
}

// ─── RISK UI ──────────────────────────────────────────────────────────────────
function updateRiskUI() {
  const el = document.getElementById('riskPanel')
  if (!el) return

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

  const notifBtnLabel = notifPermission() === 'granted' ? '✓ Notifications On'
    : notifPermission() === 'denied' ? '✗ Blocked in browser'
    : 'Enable Alerts'

  const notifBtnDisabled = notifPermission() === 'denied' ? 'disabled' : ''

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
}

window.__enableNotifs = function () {
  requestNotifications().then(() => updateRiskUI())
}

// ─── LIVE REFRESH ─────────────────────────────────────────────────────────────
let liveTimer    = null
let sessionTimer = null
let refreshFailCount = 0

function updateRefreshBanner() {
  const banner = document.getElementById('refreshErrorBanner')
  if (!banner) return
  if (refreshFailCount < 12) {
    banner.classList.remove('active')
    return
  }
  banner.classList.add('active')
  banner.innerHTML = `⚠ Live data paused — connection lost. <button class="refresh-error-retry" onclick="window.__retryRefresh()">Retry now</button>`
}

window.__retryRefresh = function() {
  refreshFailCount = 0
  updateRefreshBanner()
  refreshLive()
}

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
    const info  = new InfoClient({ transport: new HttpTransport() })
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
  const tbody     = document.getElementById('transfersTbody')
  if (summaryEl) summaryEl.innerHTML = skeletonStatCards(4)
  if (tbody)     tbody.innerHTML     = skeletonRows(4, 8)

  try {
    const info   = new InfoClient({ transport: new HttpTransport() })
    const ledger = await info.userNonFundingLedgerUpdates({ user: addr, startTime: 1667260800000 })
    state.ledger = ledger ?? []
    renderTransfers(state.ledger, state.transferFilter)
    renderPnLCalendar(state.fills, state.calMonth, state.calYear, state.ledger)
  } catch (e) {
    console.warn('Ledger fetch failed:', e.message)
    renderTransfers([], state.transferFilter)
  }
}

async function fetchSubAccounts(addr) {
  try {
    const info = new InfoClient({ transport: new HttpTransport() })
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
const _cancelledOids = new Set()  // oids removed optimistically, filtered from refreshes

function _fingerprint(obj) {
  try { return JSON.stringify(obj) } catch (e) { return null }
}

async function refreshLive() {
  try {
    const info = new InfoClient({ transport: new HttpTransport() })

    // Latest known fill timestamp — used to fetch only new fills
    const latestFillTs = state.fills.length > 0
      ? Math.max(...state.fills.map(f => f.time))
      : Date.now() - 60 * 1000

    const [perpState, openOrders, mainMids, newRawFills] = await Promise.all([
      info.clearinghouseState({ user: state.addr }),
      info.frontendOpenOrders({ user: state.addr }),
      info.allMids(),
      // Fetch only fills newer than what we already have (startTime is exclusive on HL)
      info.userFillsByTime({ user: state.addr, startTime: latestFillTs + 1 })
        .catch(() => []),
    ])

    state.perpState  = perpState
    state.openOrders = openOrders.filter(o => !_cancelledOids.has(o.oid))
    // Merge main-DEX prices into allMids (HIP-3 mids loaded at startup, refreshed separately)
    state.allMids    = { ...state.allMids, ...mainMids }
    const allMids    = state.allMids

    // Auto-select BTC on first data load if no coin chosen yet
    if (!state.selectedCoin && allMids['BTC']) {
      window.__selectCoin('BTC')
    }

    // Merge new fills if any arrived
    if (newRawFills.length > 0) {
      const newFills = parseFills(newRawFills)
      state.fills = [...newFills, ...state.fills]
      computeLossStreak(state.fills)
      renderTrades(state.fills)
      renderPositions(perpState, allMids, state.openOrders ?? [])
      renderMarkets({ fills: state.fills, allMids, perpState })
    }

    const posCount = (perpState.assetPositions ?? []).length
    document.getElementById('posCount').textContent    = posCount
    document.getElementById('posCountBig').textContent = posCount
    document.getElementById('ordCount').textContent    = state.openOrders.length
    document.getElementById('ordCountBig').textContent = state.openOrders.length

    // Re-render only when data actually changed
    const posHash  = _fingerprint(perpState.assetPositions)
    const ordHash  = _fingerprint(openOrders)
    const acctHash = _fingerprint({ mv: perpState.crossMarginSummary?.accountValue, w: perpState.withdrawable })

    renderSummaryCards(state.fills, perpState)

    if (acctHash !== _lastAcctHash) {
      renderAccountSection()
      updateTradeBalance()
      _updateAvailDisplay()
      _lastAcctHash = acctHash
    }
    const posChanged = posHash !== _lastPosHash
    const ordChanged = ordHash !== _lastOrdHash
    if (posChanged) { renderPositions(perpState, allMids, state.openOrders ?? []); _lastPosHash = posHash }
    if (ordChanged) { renderOrders(openOrders, perpState); _lastOrdHash = ordHash }
    if (posChanged || ordChanged) { renderManageTables(perpState, openOrders, allMids) }

    updateAccountValue(totalPerpEquity(perpState))
    maybeSendLiqNotification(perpState, state.allMids)
    updateRiskUI()
    if (isPaused()) updateSubmitBtn()

    refreshFailCount = 0
    updateRefreshBanner()
    updateWatchTicker()
    if (state.selectedCoin) updateChartStats(state.selectedCoin)

  } catch (e) {
    refreshFailCount++
    console.warn('Live refresh failed:', e.message)
    updateRefreshBanner()
  }
}

// ─── PORTFOLIO CHARTS ─────────────────────────────────────────────────────────
function renderChartPeriod(period) {
  state.currentPeriod = period

  document.querySelectorAll('.chart-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.period === period)
  })

  const result = renderCharts(state.portfolio, period)
  if (!result) return
  // Hero HTML is now set inside renderCharts (including hover attachment)
  // Nothing extra needed here
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
      const signer = getMainSigner()
      const feeResult = await approveBuilderFee(signer)
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
}

onWalletDisconnect(disconnectMainWalletUI)

window.connectMainWalletUI  = openWalletPicker
window.closeWalletPicker    = () => { document.getElementById('walletPickerModal').style.display = 'none' }
window.__sortPositions      = (key) => { if (!state.perpState) return; setSortPos(key); renderPositions(state.perpState, state.allMids) }
window.__sortOrders         = (key) => { if (!state.perpState) return; setSortOrd(key); renderOrders(state.openOrders, state.perpState) }
window.__sortMPos           = (key) => { if (!state.perpState) return; setSortMPos(key); renderManageTables(state.perpState, state.openOrders, state.allMids) }
window.__sortMOrd           = (key) => { if (!state.perpState) return; setSortMOrd(key); renderManageTables(state.perpState, state.openOrders, state.allMids) }
window.__tradesPrevPage = () => { if (!state.fills) return; setTradesPage(Math.max(0, getTradesPage() - 1)); renderTrades(state.fills) }
window.__tradesNextPage = () => { if (!state.fills) return; setTradesPage(getTradesPage() + 1); renderTrades(state.fills) }

// ─── DEPOSIT / WITHDRAW ───────────────────────────────────────────────────────
let _depositDest = 'perps'

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
  const el = document.getElementById('depositAmount')
  if (el) { el.value = Math.floor(_usdcBalance * 100) / 100; window.__updateDepositPreview() }
}

window.__setWithdrawMax = function() {
  if (!_withdrawAvailable) return
  const el = document.getElementById('withdrawAmount')
  if (el) { el.value = Math.floor(_withdrawAvailable * 100) / 100; window.__updateWithdrawPreview() }
}

window.__updateDepositPreview = function() {
  const amount  = parseFloat(document.getElementById('depositAmount')?.value)
  const preview = document.getElementById('depositPreview')
  const warning = document.getElementById('depositWarning')
  const btn     = document.getElementById('depositBtn')
  if (!preview) return

  if (!isMainWalletConnected()) {
    btn.textContent = 'Connect Wallet'
    btn.disabled    = false
    btn.onclick     = () => window.connectMainWalletUI()
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
  document.getElementById('dp-send').textContent    = `${amount.toFixed(2)} USDC`
  document.getElementById('dp-receive').textContent = `${amount.toFixed(2)} USDC`
  document.getElementById('dp-dest').textContent    = _depositDest === 'perps' ? 'Perps Account' : 'Spot Account'
  btn.disabled    = false
  btn.textContent = 'Deposit'
}

window.__updateWithdrawPreview = function() {
  const amount  = parseFloat(document.getElementById('withdrawAmount')?.value)
  const dest    = document.getElementById('withdrawDest')?.value.trim()
  const preview = document.getElementById('withdrawPreview')
  const warning = document.getElementById('withdrawWarning')
  const btn     = document.getElementById('withdrawBtn')
  if (!preview) return

  if (!isMainWalletConnected()) {
    btn.textContent = 'Connect Wallet'
    btn.disabled    = false
    btn.onclick     = () => window.connectMainWalletUI()
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
  document.getElementById('wp-amount').textContent  = `${amount.toFixed(2)} USDC`
  document.getElementById('wp-receive').textContent = `${receive.toFixed(2)} USDC`
  document.getElementById('wp-dest').textContent    = `${dest.slice(0,8)}...${dest.slice(-6)}`
  btn.disabled    = false
  btn.textContent = 'Withdraw'
}

window.__useConnectedAddress = function() {
  const addr = getMainAddress()
  if (!addr) return
  const el = document.getElementById('withdrawDest')
  if (el) { el.value = addr; window.__updateWithdrawPreview() }
}

window.__executeDeposit = async function() {
  const amount   = parseFloat(document.getElementById('depositAmount').value)
  const statusEl = document.getElementById('depositStatus')
  const btn      = document.getElementById('depositBtn')
  btn.disabled = true
  try {
    const hash = await deposit({
      amount,
      destination: _depositDest,
      onStep: msg => { statusEl.innerHTML = `<span style="color:var(--muted)">${msg}</span>` },
    })
    statusEl.innerHTML = `<span style="color:var(--green)">✓ Deposit confirmed · <a href="https://arbiscan.io/tx/${hash}" target="_blank" rel="noopener" style="color:var(--accent)">View on Arbiscan</a></span>`
    document.getElementById('depositAmount').value = ''
    window.__updateDepositPreview()
    refreshDefiBalances()
  } catch (e) {
    statusEl.innerHTML = `<span style="color:var(--red)">✗ ${e.message}</span>`
    btn.disabled = false
    window.__updateDepositPreview()
  }
}

window.__executeWithdraw = async function() {
  const amount   = parseFloat(document.getElementById('withdrawAmount').value)
  const dest     = document.getElementById('withdrawDest').value.trim()
  const statusEl = document.getElementById('withdrawStatus')
  const btn      = document.getElementById('withdrawBtn')
  btn.disabled = true
  statusEl.innerHTML = '<span style="color:var(--muted)">Confirm in wallet...</span>'
  try {
    await withdraw({ amount, destination: dest })
    statusEl.innerHTML = `<span style="color:var(--green)">✓ Withdrawal submitted — arrives on Arbitrum in ~1 min</span>`
    document.getElementById('withdrawAmount').value = ''
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
  const balEl = document.getElementById('depositUsdcBal')
  if (balEl) balEl.textContent = bal !== null ? `${bal.toFixed(2)} USDC on Arbitrum` : '—'
  window.__updateDepositPreview()
}

// ─── TRADE BALANCE ────────────────────────────────────────────────────────────
async function updateTradeBalance() {
  if (!isConnected()) return
  try {
    const info  = new InfoClient({ transport: new HttpTransport() })
    const s     = await info.clearinghouseState({ user: getWalletAddress() })
    const val   = parseFloat(s.marginSummary?.accountValue ?? 0)
    const wdraw = parseFloat(s.withdrawable ?? 0)
    document.getElementById('tradeBalance').textContent      = '$' + fmtUSD(val)
    document.getElementById('tradeWithdrawable').textContent = '$' + fmtUSD(wdraw)
  } catch { /* non-critical */ }
}

// ─── COIN DROPDOWN ────────────────────────────────────────────────────────────
function populateCoinDropdown() {
  renderCoinDropdownItems('')
}

// ─── MARKET DROPDOWN STATE ────────────────────────────────────────────────────
let _mktCtxMap   = {}   // coin → { oi, volume, change24h, funding, markPx, ... }
let _mktCatMap   = {}   // coin → category string
let _mktCtxReady = false
let _dropSort    = 'oi'
let _dropCat     = 'all'
let _dropType    = 'all'
const _TRADFI_CATS = new Set(['Forex', 'Commodities', 'Commodity', 'Indices', 'Index', 'Equity', 'Equities', 'Metal', 'Metals', 'Energy', 'Rates', 'Rate'])

async function _ensureMarketData() {
  if (_mktCtxReady) return
  try {
    const [[meta, ctxs], cats] = await Promise.all([fetchMarketCtxs(), fetchPerpCategories()])
    _mktCtxMap = {}
    ;(meta.universe ?? []).forEach((u, i) => {
      const c   = ctxs[i]
      if (!c) return
      const mark = parseFloat(c.markPx ?? 0)
      const prev = parseFloat(c.prevDayPx ?? 0)
      _mktCtxMap[u.name] = {
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
    })
    _mktCatMap = {}
    for (const [coin, cat] of (cats ?? [])) _mktCatMap[coin] = cat
    const uniqueCats = [...new Set(Object.values(_mktCatMap))]
    console.log('[hliq] perpCategories unique values:', uniqueCats)
    _mktCtxReady = true
  } catch { /* use allMids only */ }
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

window.__coinImgErr = function(img, coin) {
  const p = img?.parentElement
  if (!p) return
  p.style.background = _coinColor(coin)
  p.textContent = coin.charAt(0)
}

function _coinIconHtml(coin, style = '') {
  const sym = coin.replace(/[-/].*/, '').toLowerCase()
  return `<img src="https://cdn.jsdelivr.net/npm/cryptocurrency-icons@0.18.1/svg/color/${sym}.svg"
    style="width:100%;height:100%;border-radius:50%;object-fit:cover;${style}"
    onerror="window.__coinImgErr(this,'${coin}')">`
}

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
  nameEl.textContent = coin + '-USDC'
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
function _updateAvailDisplay() {
  const ps = state.perpState
  if (!ps) {
    const el = document.getElementById('availDisplay')
    const hint = document.getElementById('availHint')
    if (el) el.textContent = '—'
    if (hint) hint.textContent = 'Max: —'
    return
  }

  let avail
  if (state.isIsolated) {
    // Isolated mode: free USDC = perp withdrawable + free spot USDC (matches overview)
    const perpWdraw  = parseFloat(ps.withdrawable ?? 0)
    const spotUSDC   = (state.spotState?.balances ?? []).find(b => b.coin === 'USDC')
    const spotFree   = spotUSDC ? Math.max(0, parseFloat(spotUSDC.total ?? 0) - parseFloat(spotUSDC.hold ?? 0)) : 0
    avail = Math.max(0, perpWdraw + spotFree)
  } else {
    const cms            = ps.crossMarginSummary ?? {}
    const accountValue   = parseFloat(cms.accountValue   ?? 0)
    const totalMarginUsed = parseFloat(cms.totalMarginUsed ?? 0)

    // HL unified account: spot non-USDC tokens count as collateral
    const spotNonUSDC = (state.spotState?.balances ?? [])
      .filter(b => b.coin !== 'USDC')
      .reduce((sum, b) => {
        const px  = parseFloat(state.allMids[b.coin] ?? 0)
        const qty = parseFloat(b.total ?? 0)
        return sum + px * qty
      }, 0)

    const selectedPos = (ps.assetPositions ?? []).find(ap => ap.position?.coin === state.selectedCoin)
    const selSzi      = parseFloat(selectedPos?.position?.szi ?? 0)
    const selIsCross  = selectedPos?.position?.leverage?.type === 'cross'

    const opposingPos =
      (state.tradeSide === 'short' && selSzi > 0) ||
      (state.tradeSide === 'long'  && selSzi < 0)

    if (opposingPos && selIsCross) {
      // Opposing an existing cross position: raw snapshot formula (no spotNonUSDC)
      avail = (accountValue + totalMarginUsed) / 2
    } else {
      // Same direction or no position: portfolioValue minus margin used
      avail = Math.max(0, accountValue + spotNonUSDC - totalMarginUsed)
    }
  }

  const maxPos = avail * state.leverage

  const el   = document.getElementById('availDisplay')
  const hint = document.getElementById('availHint')
  if (el)   el.textContent   = '$' + fmtUSD(avail) + ' USDC'
  if (hint) hint.textContent = maxPos > 0 ? `Max: $${fmtUSD(maxPos)} at ${state.leverage}x` : 'Max: —'
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

// ─── BASIC MODE ───────────────────────────────────────────────────────────────
function _renderBasicExtraCards() {
  const el = document.getElementById('basicExtraCards')
  if (!el) return
  const { fills, funding, allMids, ledger, perpState } = state
  if (!fills) return

  // Deposits & withdrawals from ledger
  let totalDeposited = 0, totalWithdrawn = 0
  for (const e of (ledger ?? [])) {
    const t = e.delta?.type
    if (t === 'deposit') totalDeposited += parseFloat(e.delta.usdc ?? 0)
    else if (t === 'send' && e.delta?.token === 'USDC') totalDeposited += parseFloat(e.delta.usdcValue ?? 0)
    else if (t === 'withdraw') totalWithdrawn += parseFloat(e.delta.usdc ?? 0)
  }

  // Net PnL
  const realizedPnl   = fills.reduce((s, f) => s + f.closedPnl, 0)
  const unrealizedPnl = (perpState?.assetPositions ?? []).reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0)
  const totalFees     = fills.reduce((s, f) => {
    if (!f.fee) return s
    if (f.feeToken === 'USDC' || !f.feeToken) return s + f.fee
    const px = parseFloat(allMids[f.feeToken] ?? 0)
    return s + (px > 0 ? f.fee * px : 0)
  }, 0)
  const allTimeFunding = (funding ?? []).reduce((s, f) => s + f.usdc, 0)
  const netPnl         = realizedPnl + unrealizedPnl + allTimeFunding - totalFees

  // Win rate (coin+hour buckets)
  const ONE_HOUR = 3600000
  const windows  = {}
  for (const f of fills.filter(f => f.closedPnl !== 0)) {
    const key = `${f.coin}_${Math.floor(f.time / ONE_HOUR)}`
    if (!windows[key]) windows[key] = 0
    windows[key] += f.closedPnl - f.fee
  }
  const allW    = Object.values(windows)
  const winRate = allW.length > 0 ? (allW.filter(n => n > 0).length / allW.length * 100).toFixed(1) + '%' : '—'

  // Total volume
  const totalVolume = fills.reduce((s, f) => s + (f.notional ?? 0), 0)

  const pnlCls = v => v >= 0 ? 'pos' : 'neg'
  const pnlFmt = v => (v >= 0 ? '+$' : '-$') + fmtUSD(Math.abs(v))

  const cards = [
    { label: 'Total Deposited', value: '$' + fmtUSD(totalDeposited),  sub: 'All-time USDC in',             cls: 'neu' },
    { label: 'Total Withdrawn', value: '$' + fmtUSD(totalWithdrawn),  sub: 'All-time USDC out',            cls: 'neu' },
    { label: 'Net PnL',         value: pnlFmt(netPnl),                sub: 'Realized + unrealized + funding − fees', cls: pnlCls(netPnl) },
    { label: 'Win Rate',        value: winRate,                        sub: 'Winning trade windows',         cls: 'neu' },
    { label: 'Total Volume',    value: '$' + fmtCompact(totalVolume), sub: 'Notional traded all-time',     cls: 'neu' },
  ]

  el.innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-label">${c.label}</div>
      <div class="stat-value ${c.cls}">${c.value}</div>
      <div class="stat-sub">${c.sub}</div>
    </div>`).join('')
}

function _applyBasicMode() {
  document.body.classList.toggle('is-basic-mode', state.basicMode)
  const fab = document.getElementById('modeFab')
  if (fab) {
    const label = document.getElementById('modeFabLabel')
    if (label) label.textContent = state.basicMode ? 'Basic' : 'Advanced'
    fab.classList.toggle('fab-visible', true)
  }
  // Mobile wallet-strip toggle button
  const mobLbl = document.getElementById('mobModeBtnLabel')
  if (mobLbl) mobLbl.textContent = state.basicMode ? 'Basic' : 'Advanced'
  // Settings toggle checkbox
  const settingsChk = document.getElementById('basicModeToggle')
  if (settingsChk) settingsChk.checked = state.basicMode
  if (state.basicMode) _renderBasicExtraCards()
}

window.toggleBasicMode = function() {
  state.basicMode = !state.basicMode
  localStorage.setItem('hliq_basicMode', state.basicMode ? '1' : '0')
  _applyBasicMode()
  if (state.basicMode) {
    const portfolioBtn = document.querySelector('.nav-tab[data-basic="1"]')
    switchTab('portfolio', portfolioBtn)
  } else {
    const overviewBtn = document.querySelector('.nav-tab[onclick*="overview"]')
    switchTab('overview', overviewBtn)
  }
}

function _fmtTableDollar(n) {
  return '$' + Math.round(n).toLocaleString('en-US')
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
  if (q) entries = entries.filter(([k]) => k.toLowerCase().includes(q) || (k + '-USDC').toLowerCase().includes(q))

  if (_dropType === 'spot') {
    if (catTabsEl) catTabsEl.innerHTML = ''
    list.innerHTML = `<tr class="mkt-empty-row"><td colspan="6">Spot markets not available</td></tr>`
    return
  }
  if (_dropType === 'perps') { /* all — same as all */ }
  if (_dropType === 'crypto')    entries = entries.filter(([k]) => !_TRADFI_CATS.has(_mktCatMap[k]))
  if (_dropType === 'tradfi')    entries = entries.filter(([k]) =>  _TRADFI_CATS.has(_mktCatMap[k]))
  if (_dropType === 'hip3')      entries = entries.filter(([k]) => _mktCatMap[k] === 'HIP-3')
  if (_dropType === 'prelaunch') entries = entries.filter(([k]) => _mktCatMap[k] === 'Pre-launch')

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
        <span class="mkt-sym-name">${coin}-USDC</span>
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
  _updateAvailDisplay()

  if (state.orderType !== 'market') {
    document.getElementById('limitPriceInput').value = price.toString()
  }
  updateOrderSummary()
  updateSubmitBtn()
  loadTradeChart(coin, _chartTf)
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
  const avail  = parseFloat(state.perpState?.withdrawable ?? 0)
  const maxPos = avail * state.leverage
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
  const avail  = parseFloat(state.perpState?.withdrawable ?? 0)
  const maxPos = avail * state.leverage
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
  const avail  = parseFloat(state.perpState?.withdrawable ?? 0)
  const maxPos = avail * state.leverage
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
    // Fresh position — use account equity from marginSummary
    const equity = parseFloat(state.perpState?.marginSummary?.accountValue ?? 0)
    const notional = absNewSzi * newEntry
    if (equity > 0 && notional > 0) {
      newLiqPx = newSzi > 0
        ? (notional - equity) / (absNewSzi * (1 - mmr))
        : (notional + equity) / (absNewSzi * (1 + mmr))
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

async function loadTradeChart(coin, tf) {
  tf = tf || _chartTf
  _chartTf = tf

  document.querySelectorAll('.chart-tf-btn').forEach(b => {
    b.classList.toggle('active', b.textContent.toLowerCase() === tf.toLowerCase())
  })

  const emptyEl = document.getElementById('tradeChartEmpty')
  const canvas  = document.getElementById('tradeChartCanvas')
  if (!canvas) return

  if (!coin) {
    if (emptyEl) emptyEl.style.display = 'flex'
    canvas.style.display = 'none'
    return
  }

  updateCoinHeader(coin)
  updateChartStats(coin)
  if (emptyEl) emptyEl.style.display = 'none'
  canvas.style.display = 'block'

  let candles
  try {
    candles = await fetchCandles(coin, tf, Date.now() - (_TF_LOOKBACK[tf] ?? 5*24*60*60*1000))
  } catch { return }
  if (!candles || candles.length === 0) return

  // fmtLabel → string for crosshair; fmtAxisLabel → array for two-line axis ticks
  const _fmtParts = (ts) => {
    const d  = new Date(ts)
    const dd = String(d.getDate()).padStart(2, '0')
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const HH = String(d.getHours()).padStart(2, '0')
    const MM = String(d.getMinutes()).padStart(2, '0')
    return { date: `${dd}/${mo}/${d.getFullYear()}`, time: `${HH}:${MM}` }
  }
  const fmtLabel = (ts) => {
    const { date, time } = _fmtParts(ts)
    if (tf === '1w' || tf === '1d') return date
    return `${date} ${time}`
  }
  const fmtAxisLabel = (ts) => {
    const { date, time } = _fmtParts(ts)
    if (tf === '1w' || tf === '1d') return date
    return [date, time]
  }
  _chartFmtLabel = fmtLabel
  const fmtYAxis = (v) => {
    if (v >= 1000) return '$' + (v / 1000).toFixed(1) + 'k'
    if (v >= 1)    return '$' + parseFloat(v.toFixed(2))
    return '$' + parseFloat(v.toPrecision(4))
  }

  const labels = candles.map(c => fmtAxisLabel(c.t))
  const closes = candles.map(c => parseFloat(c.c))
  _chartAllLabels  = labels
  _chartAllData    = closes
  _chartAllCandles = candles
  _chartViewStart  = 0
  _chartViewEnd    = labels.length
  _chartCurrentCoin = coin
  _chartCurrentTf   = tf
  _chartEarliestTs  = candles[0]?.t ?? null
  _chartYPanned     = false
  const isUp  = closes[closes.length - 1] >= closes[0]
  const color = isUp ? '#00e5a0' : '#ff4d6d'

  // Y-axis bounds — use H/L range for candle mode, close range for line mode
  const dataMin = _chartMode === 'candle'
    ? Math.min(...candles.map(c => parseFloat(c.l)))
    : Math.min(...closes)
  const dataMax = _chartMode === 'candle'
    ? Math.max(...candles.map(c => parseFloat(c.h)))
    : Math.max(...closes)
  const pad  = (dataMax - dataMin) * 0.08
  const yMin = dataMin - pad
  const yMax = dataMax + pad
  _chartYMin = yMin
  _chartYMax = yMax

  // Mark price annotation — green if above entry, red if below
  const markPx   = parseFloat(state.allMids?.[coin] ?? 0)
  const annotations = _buildChartAnnotations(coin)
  if (markPx > 0) {
    const openPos   = (state.perpState?.assetPositions ?? [])
      .find(p => p.position.coin === coin)?.position
    const posEntry  = parseFloat(openPos?.entryPx ?? 0)
    const isLong    = parseFloat(openPos?.szi ?? 0) > 0
    const inProfit  = posEntry > 0
      ? (isLong ? markPx >= posEntry : markPx <= posEntry)
      : null
    const markColor = inProfit === null ? 'rgba(255,255,255,0.5)'
      : inProfit ? '#00e5a0' : '#ff4d6d'
    annotations.mark = {
      type: 'line', scaleID: 'y', value: markPx,
      borderColor: markColor, borderWidth: 1,
      borderDash: [4, 4],
      adjustScaleRange: false,
      label: {
        display: true,
        content: `$${fmtPrice(markPx)}`,
        backgroundColor: 'rgba(30,30,45,0.9)',
        color: markColor,
        font: { family: 'JetBrains Mono', size: 10, weight: '600' },
        padding: { x: 5, y: 2 }, borderRadius: 3,
        position: 'end',
      },
    }
  }

  if (_tradeChart) { _tradeChart.destroy(); _tradeChart = null }
  if (_chartPanCleanup)  { _chartPanCleanup();  _chartPanCleanup  = null }
  if (_crosshairCleanup) { _crosshairCleanup(); _crosshairCleanup = null }

  const dot = document.getElementById('markDot')
  if (dot) dot.style.display = 'none'

  const ctx    = canvas.getContext('2d')
  const h      = canvas.parentElement.offsetHeight || 380
  const grad   = ctx.createLinearGradient(0, 0, 0, h)
  grad.addColorStop(0,   isUp ? 'rgba(0,229,160,0.20)' : 'rgba(255,77,109,0.20)')
  grad.addColorStop(0.6, isUp ? 'rgba(0,229,160,0.04)' : 'rgba(255,77,109,0.04)')
  grad.addColorStop(1,   'rgba(0,0,0,0)')
  const isCandleMode = _chartMode === 'candle'
  _tradeChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: closes,
        borderColor:     isCandleMode ? 'transparent' : color,
        backgroundColor: isCandleMode ? 'transparent' : grad,
        fill: !isCandleMode,
        pointRadius: 0, pointHoverRadius: 0,
        tension: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 250 },
      layout: { padding: { left: 0, right: 0, top: 8, bottom: 0 } },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
        zoom: {
          pan:  { enabled: false },
          zoom: { wheel: { enabled: false }, pinch: { enabled: false }, mode: 'x' },
        },
        annotation: { annotations },
      },
      scales: {
        x: {
          ticks: { color: '#555566', font: { family: 'JetBrains Mono', size: 9 }, maxTicksLimit: 4, maxRotation: 0, minRotation: 0 },
          grid:  { color: 'rgba(255,255,255,0.03)', drawBorder: false },
          border: { display: false },
        },
        y: {
          position: 'right',
          min: yMin, max: yMax,
          afterFit(scale) { scale.width = Math.max(scale.width, 72) },
          ticks: { color: 'transparent', font: { family: 'JetBrains Mono', size: 9 }, callback: fmtYAxis, maxTicksLimit: 10 },
          grid:  { color: 'rgba(255,255,255,0.03)', drawBorder: false },
          border: { display: false },
        },
      },
    },
  })
  _tradeChart._candleMode = isCandleMode
  _tradeChart._candleData = candles
  _setupChartPan(_tradeChart)
  _crosshairCleanup = _setupCrosshair(_tradeChart, fmtLabel)
}

// Double-click resets view (handled inside _setupChartPan via the db handler)

window.__chartSetTf     = function(tf) {
  _chartRange = null
  document.querySelectorAll('.chart-range-btn').forEach(b => b.classList.remove('active'))
  loadTradeChart(state.selectedCoin, tf)
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
  if (state.selectedCoin) loadTradeChart(state.selectedCoin, _chartTf)
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
    btn.disabled = true; btn.textContent = 'Connect agent key to trade'; btn.className = 'btn-trade-long'
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
  if (!isConnected()) { showTradeStatus(statusEl, 'error', 'Connect your agent key first.'); return }
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
  document.getElementById('closeSzDisplay').textContent   = fmtSize(closeSz) + ' ' + pos.coin
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
  if (display) display.textContent = fmtSize(sz) + ' ' + pos.coin
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
      display.textContent = fmtSize(sz) + ' ' + ord.coin
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
  document.getElementById('closeModalTitle').textContent = `Close ${coin} ${side}`
  document.getElementById('closeModalDesc').textContent  = `Mark: $${fmtPrice(parseFloat(mktPx))}`
  const slider = document.getElementById('closeSlider')
  slider.value = 100
  slider.style.setProperty('--slider-color', _closeColor())
  slider.style.background = _closeColor()
  document.getElementById('closeModalStatus').className  = 'trade-status'
  document.getElementById('closeModalConfirm').disabled  = false
  document.getElementById('closeModal').classList.add('open')
  _updateCloseDisplay()
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
      setTimeout(() => { closeModals(); refreshLive() }, 1000)
    }
  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    document.getElementById('closeModalConfirm').disabled = false
  }
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
  document.getElementById('tpslPosLabel').textContent = `${sz} ${coin} ${side.charAt(0) + side.slice(1).toLowerCase()}`
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
  document.getElementById('editModal').classList.add('open')
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
  renderOrders(state.openOrders, state.perpState)
  setTimeout(refreshLive, 2000)
}

window.__cancelOrder = async function (coin, oid, isPositionTpsl) {
  const statusEl = document.getElementById('ordersStatus') ?? document.getElementById('tradeStatus')
  if (!isConnected()) { showTradeStatus(statusEl, 'error', 'Connect agent key first (go to ⚡ Trade tab).'); return }

  showTradeStatus(statusEl, 'pending', 'Cancelling order...')

  let resolvedOid = parseInt(oid)
  const frontendOrder = (state.openOrders ?? []).find(o => o.coin === coin && o.oid === resolvedOid)
  console.log('[cancelOrder] coin:', coin, 'oid:', oid, 'isPositionTpsl:', isPositionTpsl,
    'isTrigger:', frontendOrder?.isTrigger, 'orderType:', frontendOrder?.orderType,
    'triggerPx:', frontendOrder?.triggerPx, 'side:', frontendOrder?.side,
    'sz:', frontendOrder?.sz, 'limitPx:', frontendOrder?.limitPx)

  // Always cross-reference with openOrders to compare oids
  try {
    const info = new InfoClient({ transport: new HttpTransport() })
    const rawOrders = await info.openOrders({ user: state.addr })
    const rawMatch = rawOrders.find(o => o.coin === coin)
    const rawMatchByOid = rawOrders.find(o => o.oid === resolvedOid)
    console.log('[cancelOrder] openOrders for', coin, ':', JSON.stringify(rawOrders.filter(o => o.coin === coin)))
    console.log('[cancelOrder] frontendOpenOrders oid:', resolvedOid, '— found in openOrders by oid:', !!rawMatchByOid)

    if (isPositionTpsl || resolvedOid === 0) {
      const match = rawOrders.find(o =>
        o.coin === coin &&
        o.side === frontendOrder?.side &&
        o.sz   === frontendOrder?.sz &&
        o.limitPx === frontendOrder?.limitPx
      )
      if (match && match.oid > 0) {
        resolvedOid = match.oid
        console.log('[cancelOrder] resolved isPositionTpsl oid to:', resolvedOid)
      } else {
        showTradeStatus(statusEl, 'error', '✗ Cannot resolve order ID — try cancelling from HL directly.')
        return
      }
    }
  } catch (e) {
    console.warn('[cancelOrder] openOrders fetch failed:', e.message)
  }

  const agentAddr = getWalletAddress()
  console.log('[cancelOrder] agentAddr:', agentAddr, '| state.addr:', state.addr, '| match:', agentAddr?.toLowerCase() === state.addr?.toLowerCase())
  console.log('[cancelOrder] sending cancel: coin=', coin, 'resolvedOid=', resolvedOid)

  try {
    const result = await cancelOrder({ coin, oid: resolvedOid })
    const statuses = result?.response?.data?.statuses ?? []
    const errors   = statuses.filter(s => s && typeof s === 'object' && s.error).map(s => s.error)
    if (statuses.some(s => s === 'success')) {
      showTradeStatus(statusEl, 'success', '✓ Order cancelled.')
      _removeOrderFromUI(oid)
    } else if (errors.length > 0) {
      showTradeStatus(statusEl, 'error', '✗ ' + errors.join(', '))
    } else {
      showTradeStatus(statusEl, 'error', '✗ Cancel failed — check the order is still open.')
    }
  } catch (e) {
    console.log('[cancelOrder] error:', e.message)
    if (/never placed|already cancel|filled/i.test(e.message)) {
      try {
        const info = new InfoClient({ transport: new HttpTransport() })
        const fresh = await info.frontendOpenOrders({ user: state.addr })
        const stillExists = fresh.some(o => o.oid === parseInt(oid))
        console.log('[cancelOrder] fresh frontendOpenOrders stillExists:', stillExists, '(oid=', oid, ')')
        if (!stillExists) {
          showTradeStatus(statusEl, 'success', '✓ Order was already filled or cancelled.')
          _removeOrderFromUI(oid)
        } else {
          showTradeStatus(statusEl, 'error', '✗ Cannot cancel — this order must be cancelled from HL\'s interface directly.')
        }
      } catch (_) {
        showTradeStatus(statusEl, 'error', '✗ ' + e.message)
      }
    } else {
      showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    }
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
  const avail = parseFloat(state.perpState?.crossMarginSummary?.availableBalance ?? state.perpState?.marginSummary?.availableBalance ?? 0)
  document.getElementById('eordAvailable').textContent = '$' + fmtUSD(avail)

  // Price input
  document.getElementById('editOrderPriceInput').value = px > 0 ? px : ''

  // Slider
  const slider = document.getElementById('editOrdSlider')
  slider.value = initPct
  _updateEditOrdSlider()

  document.getElementById('editOrderModalStatus').className = 'trade-status'
  document.getElementById('editOrderModalConfirm').disabled = false
  document.getElementById('editOrderModal').classList.add('open')
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
function closeModals() {
  ;['closeModal','editModal','editOrderModal'].forEach(id => {
    document.getElementById(id)?.classList.remove('open')
  })
  state.closingPos   = null
  state.editingPos   = null
  state.editingOrder = null
}

// ─── PERFORMANCE TAB ──────────────────────────────────────────────────────────
async function renderPerformance() {
  const el = document.getElementById('perfContent')
  if (!el) return

  if (!serverOnline) {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--muted)">
      <div style="font-size:14px;font-weight:600">Server offline — start the dev server to see bot performance.</div>
    </div>`
    return
  }

  let wins
  try { wins = await serverFetch('/api/wins') }
  catch {
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--muted)">Failed to load performance data.</div>`
    return
  }

  const types  = ['insolvent', 'dca', 'grid', 'trend', 'longer', 'shorter']
  const labels = { insolvent: 'F', dca: 'DCA Bot', grid: 'Grid Bot', trend: 'Trend Follower', longer: 'Longer Bot', shorter: 'Shorter Bot' }

  // Flatten all wins with profit parsed
  const allWins = []
  for (const t of types) {
    for (const w of (wins[t] ?? [])) {
      const matches = [...w.msg.matchAll(/[~]?\$([0-9]+(?:\.[0-9]+)?)/g)]
      const profit  = matches.length ? parseFloat(matches[matches.length - 1][1]) : 0
      allWins.push({ ...w, strategy: t, profit })
    }
  }

  if (allWins.length === 0) {
    if (perfChart) { perfChart.destroy(); perfChart = null }
    el.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--muted)">
      <div style="font-size:32px;margin-bottom:12px">📈</div>
      <div style="font-size:14px;font-weight:600;margin-bottom:6px">No wins recorded yet</div>
      <div style="font-size:11px">Wins appear here when your strategy bots close profitable trades.</div>
    </div>`
    return
  }

  // Per-strategy totals
  const stratStats = types.map(t => {
    const list    = allWins.filter(w => w.strategy === t)
    const total   = list.reduce((s, w) => s + w.profit, 0)
    const avg     = list.length ? total / list.length : 0
    const lastWin = list.length ? list[list.length - 1].ts : '—'
    return { type: t, label: labels[t], wins: list.length, total, avg, lastWin }
  }).filter(s => s.wins > 0)

  const totalWins   = allWins.length
  const totalPnl    = allWins.reduce((s, w) => s + w.profit, 0)
  const avgProfit   = totalWins ? totalPnl / totalWins : 0
  const bestStrat   = stratStats.reduce((best, s) => s.total > best.total ? s : best, stratStats[0])

  // Cumulative P&L chart data — sort all wins by ts
  const sorted = [...allWins].sort((a, b) => a.ts.localeCompare(b.ts))
  let running = 0
  const chartLabels = sorted.map(w => w.ts.slice(0, 10))
  const chartData   = sorted.map(w => { running += w.profit; return parseFloat(running.toFixed(4)) })

  el.innerHTML = `
    <div class="perf-summary-grid">
      <div class="stat-card">
        <div class="stat-label">Total Wins</div>
        <div class="stat-value neu">${totalWins}</div>
        <div class="stat-sub">across all bots</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Bot P&amp;L</div>
        <div class="stat-value ${totalPnl >= 0 ? 'pos' : 'neg'}">$${fmtUSD(totalPnl)}</div>
        <div class="stat-sub">sum of closed wins</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Best Strategy</div>
        <div class="stat-value neu">${esc(bestStrat.label)}</div>
        <div class="stat-sub">$${fmtUSD(bestStrat.total)} total</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Avg Profit / Win</div>
        <div class="stat-value ${avgProfit >= 0 ? 'pos' : 'neg'}">$${fmtUSD(avgProfit)}</div>
        <div class="stat-sub">per closed trade</div>
      </div>
    </div>

    <div class="perf-table-wrap">
      <div class="section-title" style="margin-bottom:16px">Per-Strategy Breakdown</div>
      <table style="width:100%">
        <thead><tr>
          <th style="text-align:left">Strategy</th>
          <th style="text-align:right">Wins</th>
          <th style="text-align:right">Total P&amp;L</th>
          <th style="text-align:right">Avg / Win</th>
          <th style="text-align:right">Last Win</th>
        </tr></thead>
        <tbody>
          ${stratStats.map(s => `<tr>
            <td><b>${esc(s.label)}</b></td>
            <td style="text-align:right">${s.wins}</td>
            <td style="text-align:right;color:${s.total >= 0 ? 'var(--green)' : 'var(--red)'}">$${fmtUSD(s.total)}</td>
            <td style="text-align:right;color:${s.avg >= 0 ? 'var(--green)' : 'var(--red)'}">$${fmtUSD(s.avg)}</td>
            <td style="text-align:right;color:var(--muted);font-family:'JetBrains Mono',monospace;font-size:10px">${esc(s.lastWin)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>

    <div class="perf-chart-wrap">
      <div class="section-title" style="margin-bottom:16px">Cumulative P&amp;L</div>
      <canvas id="perfChartCanvas"></canvas>
    </div>`

  // Destroy old chart before creating new one
  if (perfChart) { perfChart.destroy(); perfChart = null }

  const ctx = document.getElementById('perfChartCanvas')
  if (ctx) {
    perfChart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [{
          label: 'Cumulative P&L',
          data: chartData,
          borderColor: '#00ff88',
          backgroundColor: 'rgba(0,255,136,0.08)',
          borderWidth: 2,
          pointRadius: chartData.length > 60 ? 0 : 3,
          tension: 0.3,
          fill: true,
        }],
      },
      options: {
        responsive: true,
        plugins: {
          legend: { labels: { color: '#aaa', font: { family: 'JetBrains Mono', size: 11 } } },
          tooltip: { callbacks: { label: ctx => ' $' + fmtUSD(ctx.parsed.y) } },
        },
        scales: {
          x: { ticks: { color: '#666', font: { family: 'JetBrains Mono', size: 10 }, maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#666', font: { family: 'JetBrains Mono', size: 10 }, callback: v => '$' + fmtUSD(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
        },
      },
    })
  }
}

// ─── TRADE MANAGE COLLAPSE ───────────────────────────────────────────────────
window.__toggleManageSection = function(id, btn) {
  const body = document.getElementById(id)
  if (!body) return
  const open = body.classList.toggle('open')
  btn.classList.toggle('open', open)
}

// ─── TABS ─────────────────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'))
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'))
  if (btn) btn.classList.add('active')
  document.getElementById('tab-' + name).classList.add('active')
  if (name === 'portfolio') setTimeout(() => renderChartPeriod(state.currentPeriod), 60)
  if (name === 'performance') renderPerformance()
  if (name === 'settings') _syncSettingsTab()
  if (name === 'leaderboard') renderLeaderboard()
  // sync bottom nav
  document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name))
  // close more drawer + backdrop
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
}

window.__mobMore = function() {
  const drawer   = document.getElementById('mobMoreDrawer')
  const backdrop = document.getElementById('mobMoreBackdrop')
  const open     = drawer?.classList.toggle('open')
  backdrop?.classList.toggle('open', open)
}
window.__mobMoreTab = function(name) {
  const btn = [...document.querySelectorAll('.nav-tab')].find(b => b.getAttribute('onclick')?.includes(`'${name}'`))
  window.switchTab(name, btn)
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
  el.className = 'trade-status ' + type; el.textContent = msg
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
    const coin  = get('grid-coin') || 'ETH'
    const lower = get('grid-lower') || '2000'
    const upper = get('grid-upper') || '3000'
    const levels = get('grid-levels') || '10'
    const size  = getSizeUsd('grid-size', 'grid-coin') || '50'
    const lev   = get('grid-leverage') || '1'
    cmd = `node strategies/grid.js --coin ${coin} --lower ${lower} --upper ${upper} --levels ${levels} --size ${size} --leverage ${lev} --wallet $WALLET_KEY --address ${state.addr}${assetFlags ? ' ' + assetFlags : ''}`
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
window.toggleCoinDropdown  = window.toggleCoinDropdown

window.__calDayClick = calDayClick

window.calNav = function(dir) {
  const detail = document.getElementById('calDetail')
  if (detail) { detail.innerHTML = ''; detail.dataset.activeKey = '' }
  state.calMonth += dir
  if (state.calMonth > 11) { state.calMonth = 0;  state.calYear++ }
  if (state.calMonth < 0)  { state.calMonth = 11; state.calYear-- }
  renderPnLCalendar(state.fills, state.calMonth, state.calYear, state.ledger)
}

window.filterTransfers = function(filter, btn) {
  state.transferFilter = filter
  document.querySelectorAll('#transferFilterTabs .order-type-tab')
    .forEach(b => b.classList.remove('active'))
  if (btn) btn.classList.add('active')
  renderTransfers(state.ledger, filter)
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

// ─── STRATEGY SERVER INTEGRATION ──────────────────────────────────────────────
let serverOnline  = false
let serverStatus  = {}          // { insolvent: bool, dca: bool, ... }
const logStreams   = {}          // type → EventSource

async function serverFetch(path, opts = {}) {
  const r = await fetch(path, opts)
  const ct = r.headers.get('content-type') ?? ''
  return ct.includes('application/json') ? r.json() : r.text()
}

async function checkServer() {
  try {
    serverStatus = await serverFetch('/api/status')
    const justCameOnline = !serverOnline
    serverOnline = true
    updateServerBadge()
    updateAllStrategyButtons()
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
    const runBtn  = document.getElementById(`run-btn-${type}`)
    const stopBtn = document.getElementById(`stop-btn-${type}`)
    if (!runBtn || !stopBtn) continue
    const isRunning = !!serverStatus[type]
    runBtn.style.display  = isRunning ? 'none' : 'inline-block'
    stopBtn.style.display = isRunning ? 'inline-block' : 'none'
    const card = document.getElementById(`strat-${type === 'insolvent' ? 'manager' : type}`)
    if (card) card.classList.toggle('strategy-running', isRunning)
    if (isRunning) running.push(labels[type])
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
      style="display:${running ? 'none' : 'inline-block'}"
      onclick="runStrategy('${type}')">▶ Run</button>
    <button class="btn-stop-strategy" id="stop-btn-${type}"
      style="display:${running ? 'inline-block' : 'none'}"
      onclick="stopStrategy('${type}')">■ Stop</button>
    <button class="btn-show-logs" onclick="showStrategyLogs('${type}')">Logs</button>`
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
    push('--coin',     get('grid-coin')     || 'ETH')
    push('--lower',    get('grid-lower')    || '2000')
    push('--upper',    get('grid-upper')    || '3000')
    push('--levels',   get('grid-levels')   || '10')
    push('--size',     getSizeUsd('grid-size',  'grid-coin')  || '50')
    push('--leverage', get('grid-leverage') || '1')
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
  const agentKey = document.getElementById('agentKey')?.value?.trim()
  if (!agentKey) { alert('Enter your Agent Private Key in the Strategies tab before running.'); return }
  const argv = buildArgv(type)
  const script = type === 'custom'
    ? (document.getElementById('custom-script')?.value?.trim() || null)
    : null
  try {
    const r = await serverFetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, agentKey, args: argv, script }),
    })
    if (!r.ok) { alert(`Could not start: ${r.error}`); return }
    serverStatus[type] = true
    updateAllStrategyButtons()
    showStrategyLogs(type)
    renderWinsPanel()
  } catch (e) {
    alert('Server unreachable. Is server.js running?')
  }
}

async function stopStrategy(type) {
  try {
    await serverFetch('/api/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    })
    serverStatus[type] = false
    updateAllStrategyButtons()
  } catch (e) {
    alert('Server unreachable.')
  }
}

// ── Live log panel ────────────────────────────────────────────────────────────
function showStrategyLogs(type) {
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

  title.textContent = type.toUpperCase() + ' — Live Logs'
  panel.style.display = 'flex'

  const es = new EventSource(`/api/logs/${type}`)
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
    const files = await serverFetch(`/api/history/${_pastLogsType}`)
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
    const text = await serverFetch(`/api/history/${_pastLogsType}/${filename}`)
    const lines = (typeof text === 'string' ? text : JSON.stringify(text)).split('\n')
    for (const line of lines) {
      if (line) appendLog(output, line, colorLogLine(line))
    }
  } catch (e) {
    appendLog(output, `[error loading log: ${e.message}]`, 'log-error')
  }
}

function appendLog(container, text, cls = '') {
  const line = document.createElement('div')
  line.className = 'log-line' + (cls ? ' ' + cls : '')
  line.textContent = text
  container.appendChild(line)
  container.scrollTop = container.scrollHeight
}

// ── Wins panel ────────────────────────────────────────────────────────────────
async function renderWinsPanel() {
  const el = document.getElementById('winsPanel')
  if (!el || !serverOnline) return

  let wins
  try { wins = await serverFetch('/api/wins') }
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
  const el   = document.getElementById(inputId)
  const val  = el?.value?.trim()
  if (!val) return ''
  if (el?.dataset?.mode === 'token') {
    const coin  = (document.getElementById(coinInputId)?.value?.trim() || 'BTC').toUpperCase()
    const price = parseFloat(state.allMids?.[coin] ?? 0)
    if (price > 0) return (parseFloat(val) * price).toFixed(2)
  }
  return val
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
window.__saveAgentKey = function(val) {
  if (val && state.addr) localStorage.setItem(_agentKeyForAddr(state.addr), val)
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
  disconnect()
}
function restoreAgentKey(addr) {
  const lookupAddr = addr || state.addr
  if (!lookupAddr) return
  const savedKey = localStorage.getItem(_agentKeyForAddr(lookupAddr))
  const el = document.getElementById('agentKey')
  const tradeInput = document.getElementById('privateKeyInput')
  if (!savedKey) {
    if (el) el.value = ''
    if (tradeInput) tradeInput.value = ''
    return
  }
  if (el) el.value = savedKey
  if (tradeInput) tradeInput.value = savedKey
  connectAgentKey(savedKey).then(connectedAddr => {
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

// Restore light mode preference
if (localStorage.getItem('hliq_light_mode') === '1') {
  document.body.classList.add('light-mode')
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
})()

window.__clearAgentKey = function() {
  if (state.addr) localStorage.removeItem(_agentKeyForAddr(state.addr))
  localStorage.removeItem('hliq_agent_key')
  // Clear key from Trade and Strategies inputs
  const tradeInput = document.getElementById('privateKeyInput')
  const stratInput = document.getElementById('agentKey')
  if (tradeInput) tradeInput.value = ''
  if (stratInput) stratInput.value = ''
  // Disconnect the active agent session
  disconnect()
  const dotEl    = document.getElementById('apiStatusDot')
  const statusEl = document.getElementById('apiConnectStatus')
  if (dotEl) dotEl.classList.remove('connected')
  if (statusEl) { statusEl.textContent = 'Not connected'; statusEl.style.color = '' }
  updateSubmitBtn?.()
  _syncSettingsTab()
}

// Sync toggle state whenever settings tab is opened
function _syncSettingsTab() {
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

  // Light mode
  const lmToggle = document.getElementById('lightModeToggle')
  if (lmToggle) lmToggle.checked = document.body.classList.contains('light-mode')

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
}

window.__switchSettingsPanel = function(name, btn) {
  document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'))
  document.querySelectorAll('.settings-card[id^="settings-panel-"]').forEach(p => p.style.display = 'none')
  if (btn) btn.classList.add('active')
  const panel = document.getElementById('settings-panel-' + name)
  if (panel) panel.style.display = ''
}

window.__onLightModeToggle = function(checked) {
  document.body.classList.toggle('light-mode', checked)
  localStorage.setItem('hliq_light_mode', checked ? '1' : '0')
}

window.__onNotifToggle = function(checked) {
  if (checked) {
    requestNotifications().then(() => _syncSettingsTab())
  } else {
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

// Poll server every 5 seconds (desktop only — server is localhost, unreachable on mobile)
if (window.innerWidth > 768) {
  checkServer()
  setInterval(checkServer, 5000)
  setInterval(renderWinsPanel, 30000)
}

// ─── WATCHLIST ────────────────────────────────────────────────────────────────
const WATCH_KEY = 'hliq_watchlist'

// Spot meta: lazily loaded once, maps @N ↔ display name
let _spotNameMap = null  // { '@1': 'PURR/USDC', ... }
let _spotKeyMap  = null  // { 'PURR/USDC': '@1', ... }
let _perpNames   = null  // string[] — all perp coin names from meta

let _spotMetaPromise = null
async function ensureSpotMeta() {
  if (_spotNameMap) return
  if (_spotMetaPromise) return _spotMetaPromise
  _spotMetaPromise = (async () => {
    try {
      const meta = await infoClient.spotMeta()
      _spotNameMap = {}
      _spotKeyMap  = {}
      for (const u of (meta.universe ?? [])) {
        const key = `@${u.index}`
        _spotNameMap[key]   = u.name
        _spotKeyMap[u.name] = key
      }
    } catch (e) {
      console.warn('spotMeta fetch failed:', e.message)
      _spotNameMap = {}
      _spotKeyMap  = {}
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
  return _spotNameMap?.[coin] ?? coin
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
  const info = new InfoClient({ transport: new HttpTransport() })

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
    // Always use 1D for ticker % change
    let chgHtml = ''
    if (cached1D?.candles?.length) {
      const pct  = watchChgPct(cached1D.candles, price) ?? 0
      const cls  = pct > 0 ? 'pos' : pct < 0 ? 'neg' : 'neu'
      const sign = pct >= 0 ? '+' : ''
      chgHtml = `<span class="watch-ticker-chg ${cls}">${sign}${pct.toFixed(2)}%</span>`
    }
    return `<span class="watch-ticker-item" onclick="window.__watchOpenTrade('${esc(coin)}')">
      <span class="watch-ticker-coin">${esc(watchCoinLabel(coin))}</span>
      <span class="watch-ticker-price">${priceStr}</span>${chgHtml}
    </span>`
  }).join('')
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
  const spotMatches = Object.entries(_spotNameMap ?? {})
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
      loadTradeChart(coin, _chartTf)
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
})

// Hook switchTab to load watch data and refresh defi cards
const _origSwitchTab = window.switchTab
window.switchTab = function(name, btn) {
  _origSwitchTab(name, btn)
  if (name === 'watch')     refreshWatchTab()
  if (name === 'portfolio') { window.__updateDepositPreview(); window.__updateWithdrawPreview() }
  if (name === 'trade' && !state.selectedCoin && state.allMids?.['BTC']) {
    window.__selectCoin('BTC')
  }
  if (name === 'trade' && state.selectedCoin) {
    _ensureMarketData().then(() => updateChartStats(state.selectedCoin))
  }
}

// Init defi card buttons on load
window.__updateDepositPreview()
window.__updateWithdrawPreview()

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────
const _LB_LS_KEY = 'hliq_lb_extra'

async function _lbLoad() {
  try {
    const r = await fetch('/api/leaderboard')
    if (!r.ok) throw new Error()
    return await r.json()
  } catch {
    try { return JSON.parse(localStorage.getItem(_LB_LS_KEY) || '[]') } catch { return [] }
  }
}

async function _lbSave(addrs) {
  localStorage.setItem(_LB_LS_KEY, JSON.stringify(addrs))
  try {
    await fetch('/api/leaderboard', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ addrs }),
    })
  } catch {}
}

function _lbPosHtml(positions) {
  if (!positions.length) return `<div class="lb-no-pos">No open positions</div>`
  return `<table class="lb-pos-table">
    <thead><tr><th>Coin</th><th>Side</th><th>Size</th><th>Entry</th><th>PnL</th></tr></thead>
    <tbody>${positions.map(p => {
      const pos  = p.position
      const side = parseFloat(pos.szi) > 0 ? 'LONG' : 'SHORT'
      const pnl  = parseFloat(pos.unrealizedPnl ?? 0)
      const cls  = pnl >= 0 ? 'pos' : 'neg'
      return `<tr>
        <td><b>${esc(pos.coin)}</b></td>
        <td class="${cls}">${side}</td>
        <td>${Math.abs(parseFloat(pos.szi))}</td>
        <td>$${fmtPrice(parseFloat(pos.entryPx ?? 0))}</td>
        <td class="${cls}">${pnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(pnl))}</td>
      </tr>`
    }).join('')}</tbody>
  </table>`
}

function _lbRowHtml(entry, rank) {
  const short  = entry.addr.slice(0, 8) + '…' + entry.addr.slice(-5)
  const pnlCls = entry.unrealizedPnl >= 0 ? 'pos' : 'neg'
  const pnlStr = entry.error ? '—'
    : (entry.unrealizedPnl >= 0 ? '+' : '') + '$' + fmtUSD(Math.abs(entry.unrealizedPnl))
  const valStr = entry.error ? '<span class="lb-err">Error</span>' : '$' + fmtUSD(entry.accountValue)
  const uid    = 'lbx-' + entry.addr.slice(2, 10)
  return `
    <tr class="lb-row" onclick="window.__lbToggle('${uid}', this)">
      <td class="lb-rank">${rank}</td>
      <td class="lb-identity">
        ${entry.label ? `<div class="lb-label">${esc(entry.label)}</div>` : ''}
        <div class="lb-addr-short">${short}</div>
      </td>
      <td class="lb-val">${valStr}</td>
      <td class="lb-pnl ${pnlCls}">${pnlStr}</td>
      <td class="lb-chev">▶</td>
    </tr>
    <tr class="lb-expand" id="${uid}" style="display:none">
      <td colspan="5"><div class="lb-expand-inner">${entry.error ? `<div class="lb-err">${entry.error}</div>` : _lbPosHtml(entry.positions)}</div></td>
    </tr>`
}

async function renderLeaderboard() {
  const root = document.getElementById('leaderboardRoot')
  if (!root) return

  root.innerHTML = `<div class="lb-loading">Fetching wallets…</div>`

  const extras   = await _lbLoad()
  const saved    = WM.load()
  const seen     = new Set(saved.map(w => w.addr.toLowerCase()))
  const allEntries = [
    ...saved.map(w => ({ addr: w.addr, label: w.label })),
    ...extras.filter(a => !seen.has(a.toLowerCase())).map(a => ({ addr: a, label: null })),
  ]

  if (!allEntries.length) {
    root.innerHTML = `<div class="lb-empty">Add wallet addresses below to start tracking.</div>`
    root.appendChild(_lbFormEl(extras))
    return
  }

  const results = await Promise.all(allEntries.map(async entry => {
    try {
      const info = new InfoClient({ transport: new HttpTransport() })
      const cs   = await info.clearinghouseState({ user: entry.addr })
      const positions    = cs.assetPositions ?? []
      const accountValue = parseFloat(cs.marginSummary?.accountValue ?? 0)
      const unrealizedPnl = positions.reduce((s, p) => s + parseFloat(p.position.unrealizedPnl ?? 0), 0)
      return { ...entry, accountValue, unrealizedPnl, positions, error: null }
    } catch (e) {
      return { ...entry, accountValue: 0, unrealizedPnl: 0, positions: [], error: 'Failed to load' }
    }
  }))

  results.sort((a, b) => b.accountValue - a.accountValue)

  root.innerHTML = `
    <div class="lb-toolbar">
      <div class="lb-count">${results.length} wallet${results.length !== 1 ? 's' : ''}</div>
      <button class="btn-sm" onclick="renderLeaderboard()">↻ Refresh</button>
    </div>
    <div class="table-wrap">
      <table class="lb-table">
        <thead><tr><th>#</th><th>Wallet</th><th>Account Value</th><th>Unrealized PnL</th><th></th></tr></thead>
        <tbody>${results.map((r, i) => _lbRowHtml(r, i + 1)).join('')}</tbody>
      </table>
    </div>`
  root.appendChild(_lbFormEl(extras))
}

function _lbFormEl(extras) {
  const div = document.createElement('div')
  div.className = 'lb-form'
  div.innerHTML = `
    <div class="lb-form-title">Tracked Addresses</div>
    <div class="lb-extras" id="lbExtrasList">
      ${extras.length ? extras.map(a => `
        <div class="lb-extra-row">
          <span class="lb-extra-addr">${a.slice(0, 8)}…${a.slice(-5)}</span>
          <button class="lb-remove" onclick="window.__lbRemove('${esc(a)}')">✕</button>
        </div>`).join('') : '<div class="lb-extras-empty">None added yet</div>'}
    </div>
    <div class="lb-add-row">
      <input class="lb-input" id="lbAddrInput" placeholder="0x… wallet address" />
      <button class="btn-sm" onclick="window.__lbAdd()">Add</button>
    </div>`
  return div
}

window.__lbToggle = function(uid, tr) {
  const row  = document.getElementById(uid)
  if (!row) return
  const open = row.style.display === 'none'
  row.style.display = open ? '' : 'none'
  const chev = tr.querySelector('.lb-chev')
  if (chev) chev.textContent = open ? '▼' : '▶'
}

window.__lbAdd = async function() {
  const input = document.getElementById('lbAddrInput')
  const addr  = input?.value?.trim()
  if (!addr || !addr.startsWith('0x') || addr.length < 42) return
  const extras = await _lbLoad()
  if (extras.some(a => a.toLowerCase() === addr.toLowerCase())) return
  extras.push(addr)
  await _lbSave(extras)
  renderLeaderboard()
}

window.__lbRemove = async function(addr) {
  const extras = await _lbLoad()
  await _lbSave(extras.filter(a => a.toLowerCase() !== addr.toLowerCase()))
  renderLeaderboard()
}

// Initial ticker render
updateWatchTicker()