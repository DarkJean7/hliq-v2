import './style.css'
const _il = document.getElementById('init-loader')
if (_il) _il.remove()
import { InfoClient, HttpTransport } from '@nktkas/hyperliquid'
import { loadAccountData, buildAssetMap, infoClient } from './api.js'
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
  toggleTradesExpanded,
  renderSummaryCards,
} from './render.js'
import { renderCharts, destroyCharts } from './charts.js'
import Chart from 'chart.js/auto'
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
  parseOrderResult,
  approveBuilderFee,
  setBuilderFeeEnabled,
  isBuilderFeeEnabled,
  applyReferrer,
} from './trading.js'
import {
  getDiscoveredWallets,
  getMainAddress,
  isMainWalletConnected,
  getMainSigner,
  connectWallet,
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
})
let state = INITIAL_STATE()

let perfChart = null

// ─── STEP LABELS ─────────────────────────────────────────────────────────────
const STEP_LABELS = [
  'Perp positions & margin',
  'Spot balances',
  'Orders, fills, portfolio & prices',
  'Funding payments (all-time)',
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
    const raw     = await loadAccountData(addr, setStep, { mobile: window.innerWidth <= 768 })
    const fills   = parseFills(raw.fills)
    const funding = parseFunding(raw.funding)

    state = {
      ...state,
      addr,
      perpState:  raw.perpState,
      spotState:  raw.spotState,
      openOrders: raw.openOrders,
      fills,
      funding,
      portfolio:  raw.portfolio,
      allMids:    raw.allMids,
      assetMap:   buildAssetMap(raw.meta),
      allMetas:   raw.allMetas,
      webData:    raw.webData ?? null,
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
    const isMobile = window.innerWidth <= 768

    // Cache first fill time so mobile (90-day) loads still show correct "Member Since"
    const FIRST_FILL_KEY = 'hliq_first_fill_' + addr
    if (!isMobile && fills.length > 0) {
      localStorage.setItem(FIRST_FILL_KEY, fills[fills.length - 1].time)
    }
    const cachedFirstFill = localStorage.getItem(FIRST_FILL_KEY)
    state.firstFillTime = cachedFirstFill ? parseInt(cachedFirstFill) : null

    liveTimer    = setInterval(refreshLive, isMobile ? 30000 : 5000)
    sessionTimer = setInterval(tickSessionUptime, 1000)

    if (!isMobile) fetchAllTimeVolume(addr)
    fetchLedger(addr)
    fetchSubAccounts(addr)

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
  renderPortfolioStats({ perpState, fills, funding, portfolio, webData: state.webData })
  renderSummaryCards(fills, perpState)
}

function renderPositionSection() {
  const { perpState, spotState, openOrders, allMids } = state
  renderPositions(perpState, allMids)
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
  if (refreshFailCount === 0) {
    banner.classList.remove('active')
    return
  }
  banner.classList.add('active')
  banner.innerHTML = `⚠ Live data paused — connection lost (${refreshFailCount} failed attempt${refreshFailCount !== 1 ? 's' : ''})
    <button class="refresh-error-retry" onclick="window.__retryRefresh()">Retry now</button>`
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

    const [perpState, openOrders, allMids, newRawFills] = await Promise.all([
      info.clearinghouseState({ user: state.addr }),
      info.frontendOpenOrders({ user: state.addr }),
      info.allMids(),
      // Fetch only fills newer than what we already have (startTime is exclusive on HL)
      info.userFillsByTime({ user: state.addr, startTime: latestFillTs + 1 })
        .catch(() => []),
    ])

    state.perpState  = perpState
    state.openOrders = openOrders
    state.allMids    = allMids

    // Merge new fills if any arrived
    if (newRawFills.length > 0) {
      const newFills = parseFills(newRawFills)
      state.fills = [...newFills, ...state.fills]
      computeLossStreak(state.fills)
      renderTrades(state.fills)
      renderPositions(perpState, allMids)
      renderMarkets({ fills: state.fills, allMids, perpState })
    }

    const posCount = (perpState.assetPositions ?? []).length
    document.getElementById('posCount').textContent    = posCount
    document.getElementById('posCountBig').textContent = posCount
    document.getElementById('ordCount').textContent    = openOrders.length
    document.getElementById('ordCountBig').textContent = openOrders.length

    // Re-render only when data actually changed
    const posHash  = _fingerprint(perpState.assetPositions)
    const ordHash  = _fingerprint(openOrders)
    const acctHash = _fingerprint({ mv: perpState.crossMarginSummary?.accountValue, w: perpState.withdrawable })

    renderSummaryCards(state.fills, perpState)

    if (acctHash !== _lastAcctHash) {
      renderAccountSection()
      updateTradeBalance()
      _lastAcctHash = acctHash
    }
    const posChanged = posHash !== _lastPosHash
    const ordChanged = ordHash !== _lastOrdHash
    if (posChanged) { renderPositions(perpState, allMids); _lastPosHash = posHash }
    if (ordChanged) { renderOrders(openOrders, perpState); _lastOrdHash = ordHash }
    if (posChanged || ordChanged) { renderManageTables(perpState, openOrders, allMids) }

    updateAccountValue(totalPerpEquity(perpState))
    maybeSendLiqNotification(perpState, state.allMids)
    updateRiskUI()
    if (isPaused()) updateSubmitBtn()

    refreshFailCount = 0
    updateRefreshBanner()
    updateWatchTicker()

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
    localStorage.setItem('hliq_agent_key', keyVal)
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
window.__expandTrades       = () => { if (!state.fills) return; toggleTradesExpanded(); renderTrades(state.fills) }

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

function renderCoinDropdownItems(query) {
  const list    = document.getElementById('coinDropdownList')
  const entries = Object.entries(state.allMids)
  const q       = query.toLowerCase().trim()
  const filtered = q ? entries.filter(([k]) => k.toLowerCase().includes(q)) : entries

  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--muted);font-family:\'Space Mono\',monospace;font-size:12px">No markets found</div>'
    return
  }

  list.innerHTML = filtered.slice(0, 120).map(([coin, price]) => `
    <div class="coin-dropdown-item ${state.selectedCoin === coin ? 'active' : ''}"
      onclick="window.__selectCoin('${coin}')">
      <span style="font-weight:700">${coin}</span>
      <span style="color:var(--muted)">$${fmtPrice(parseFloat(price))}</span>
    </div>`).join('')
}

window.__selectCoin = function (coin) {
  state.selectedCoin = coin
  const price      = parseFloat(state.allMids[coin] ?? 0)
  const assetInfo  = state.assetMap[coin]
  const maxLev     = assetInfo?.maxLeverage ?? 50

  document.getElementById('selectedCoinLabel').textContent = coin + '  ·  $' + fmtPrice(price)
  document.getElementById('coinDropdown').classList.remove('open')

  // Cap leverage to this asset's max
  const slider = document.getElementById('levSlider')
  slider.max = maxLev
  if (state.leverage > maxLev) {
    state.leverage = maxLev
    slider.value   = maxLev
    document.getElementById('levDisplay').textContent = maxLev + 'x'
  }

  // Update size label to reflect current mode
  updateSizeModeLabel()

  if (state.orderType !== 'market') {
    document.getElementById('limitPriceInput').value = price.toString()
  }
  updateOrderSummary()
  updateSubmitBtn()
}

window.toggleCoinDropdown = function () {
  const dd = document.getElementById('coinDropdown')
  dd.classList.toggle('open')
  if (dd.classList.contains('open')) {
    setTimeout(() => document.getElementById('coinDropdownSearch').focus(), 50)
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
  updateOrderSummary()
}

function setLev(n) {
  state.leverage = n
  document.getElementById('levSlider').value = n
  document.getElementById('levDisplay').textContent = n + 'x'
  updateOrderSummary()
}

// ─── MARGIN MODE ──────────────────────────────────────────────────────────────
function setMarginMode(isIsolated) {
  state.isIsolated = isIsolated
  document.getElementById('marginCross').classList.toggle('active', !isIsolated)
  document.getElementById('marginIsolated').classList.toggle('active', isIsolated)
}

// ─── SIZE MODE (USD / COIN) ───────────────────────────────────────────────────
function setSizeMode(mode) {
  state.sizeMode = mode
  document.getElementById('sizeBtn-usd').classList.toggle('active',  mode === 'usd')
  document.getElementById('sizeBtn-coin').classList.toggle('active', mode === 'coin')
  updateSizeModeLabel()
  document.getElementById('sizeInput').value = ''
  updateOrderSummary()
}

function updateSizeModeLabel() {
  const coin = state.selectedCoin
  const label = document.getElementById('sizeModeLabel')
  if (!label) return
  label.textContent = state.sizeMode === 'usd' ? 'Size (USD notional)' : `Size (${coin ?? 'Coin'} amount)`
  const input = document.getElementById('sizeInput')
  input.placeholder = state.sizeMode === 'usd' ? '100' : '0.00'
}

// ─── SIZE PRESETS ─────────────────────────────────────────────────────────────
function setSizePct(pct) {
  const avail = parseFloat(state.perpState?.withdrawable ?? 0)
  if (avail <= 0) return
  if (state.sizeMode === 'usd') {
    document.getElementById('sizeInput').value = (avail * pct * state.leverage).toFixed(2)
  } else {
    const mktPx = state.selectedCoin ? parseFloat(state.allMids[state.selectedCoin] ?? 0) : 0
    if (mktPx > 0) {
      const coinSz = (avail * pct * state.leverage) / mktPx
      document.getElementById('sizeInput').value = coinSz.toFixed(4)
    }
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
  document.getElementById('sum-margin').textContent = margin  > 0 ? '$' + fmtUSD(margin)   : '—'

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
  liqEl.textContent = curHlLiq > 0 ? '$' + fmtPrice(curHlLiq) : '—'
  const liqDist = curHlLiq > 0 && price > 0 ? Math.abs(curHlLiq - price) / price : 1
  liqEl.className = liqDist < 0.05 ? 'neg' : liqDist < 0.1 ? '' : 'pos-preview-liq-safe'
  document.getElementById('pp-new-margin').textContent = newMargin > 0 ? '$' + fmtUSD(newMargin) : '$' + fmtUSD(margin)

  previewEl.style.display = 'block'
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
window.__openCloseModal = function (coin, side, szi, mktPx) {
  state.closingPos = { coin, side, szi: parseFloat(szi), mktPx: parseFloat(mktPx) }
  document.getElementById('closeModalTitle').textContent = `Close ${coin} ${side}`
  document.getElementById('closeModalDesc').textContent  =
    `Size: ${fmtSize(Math.abs(parseFloat(szi)))} ${coin}\nMark: $${fmtPrice(parseFloat(mktPx))}\n\nLeave blank to fully close.`
  document.getElementById('closeSizeInput').value       = ''
  document.getElementById('closeModalStatus').className = 'trade-status'
  document.getElementById('closeModalConfirm').disabled = false
  document.getElementById('closeModal').classList.add('open')
}

window.__confirmClosePosition = async function () {
  if (!state.closingPos) return
  if (!isConnected()) { showTradeStatus(document.getElementById('closeModalStatus'), 'error', 'Connect agent key first.'); return }

  const { coin, side, szi, mktPx } = state.closingPos
  const inputSz  = parseFloat(document.getElementById('closeSizeInput').value)
  const closeSz  = inputSz > 0 ? inputSz : Math.abs(szi)
  const statusEl = document.getElementById('closeModalStatus')

  showTradeStatus(statusEl, 'pending', 'Submitting close order...')
  document.getElementById('closeModalConfirm').disabled = true

  try {
    const result = await closePosition({ coin, isBuy: side === 'SHORT', sz: closeSz, markPrice: mktPx })
    const parsed = parseOrderResult(result)
    if (parsed.ok) {
      showTradeStatus(statusEl, 'success', '✓ Position closed!')
      setTimeout(() => { closeModals(); refreshLive() }, 1000)
    } else {
      showTradeStatus(statusEl, 'error', '✗ ' + parsed.errors.join(', '))
      document.getElementById('closeModalConfirm').disabled = false
    }
  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    document.getElementById('closeModalConfirm').disabled = false
  }
}

// ─── EDIT MODAL ───────────────────────────────────────────────────────────────
window.__openEditModal = function (coin, side, szi, entryPx) {
  state.editingPos = { coin, side, szi: parseFloat(szi), entryPx: parseFloat(entryPx) }
  document.getElementById('editModalTitle').textContent = `Edit ${coin} ${side}`
  document.getElementById('editTpInput').value          = ''
  document.getElementById('editSlInput').value          = ''
  document.getElementById('editModalStatus').className  = 'trade-status'
  document.getElementById('editModalConfirm').disabled  = false
  document.getElementById('editModal').classList.add('open')
}

window.__confirmEditPosition = async function () {
  if (!state.editingPos) return
  if (!isConnected()) { showTradeStatus(document.getElementById('editModalStatus'), 'error', 'Connect agent key first.'); return }

  const { coin, side, szi } = state.editingPos
  const tpPx     = parseFloat(document.getElementById('editTpInput').value)
  const slPx     = parseFloat(document.getElementById('editSlInput').value)
  const statusEl = document.getElementById('editModalStatus')

  if (!tpPx && !slPx) { showTradeStatus(statusEl, 'error', 'Enter TP and/or SL.'); return }

  const isBuy = side === 'SHORT'
  const sz    = Math.abs(szi)
  showTradeStatus(statusEl, 'pending', 'Placing trigger orders...')
  document.getElementById('editModalConfirm').disabled = true

  try {
    if (tpPx > 0) { const r = await placeTriggerOrder({ coin, isBuy, sz, triggerPx: tpPx, tpsl: 'tp' }); if (!parseOrderResult(r).ok) throw new Error('TP failed') }
    if (slPx > 0) { const r = await placeTriggerOrder({ coin, isBuy, sz, triggerPx: slPx, tpsl: 'sl' }); if (!parseOrderResult(r).ok) throw new Error('SL failed') }
    const parts = []
    if (tpPx > 0) parts.push('TP @ $' + fmtPrice(tpPx))
    if (slPx > 0) parts.push('SL @ $' + fmtPrice(slPx))
    showTradeStatus(statusEl, 'success', '✓ ' + parts.join(' · ') + ' placed!')
    setTimeout(() => { closeModals(); refreshLive() }, 1000)
  } catch (e) {
    showTradeStatus(statusEl, 'error', '✗ ' + e.message)
    document.getElementById('editModalConfirm').disabled = false
  }
}

// ─── EXPANDABLE ROWS ──────────────────────────────────────────────────────────
window.__toggleRowExpand = function(id) {
  const row = document.getElementById(id)
  if (!row) return
  const btn = row.previousElementSibling?.querySelector('.row-expand-btn')
  const open = row.classList.toggle('open')
  if (btn) btn.classList.toggle('open', open)
}

// ─── CANCEL ORDER ─────────────────────────────────────────────────────────────
window.__cancelOrder = async function (coin, oid) {
  const statusEl = document.getElementById('ordersStatus') ?? document.getElementById('tradeStatus')
  if (!isConnected()) { showTradeStatus(statusEl, 'error', 'Connect agent key first (go to ⚡ Trade tab).'); return }
  showTradeStatus(statusEl, 'pending', `Cancelling order ${oid}...`)
  try {
    const result = await cancelOrder({ coin, oid })
    const parsed = parseOrderResult(result)
    if (parsed.ok) { showTradeStatus(statusEl, 'success', `✓ Order cancelled.`); setTimeout(refreshLive, 800) }
    else showTradeStatus(statusEl, 'error', '✗ ' + parsed.errors.join(', '))
  } catch (e) { showTradeStatus(statusEl, 'error', '✗ ' + e.message) }
}

// ─── MODALS ───────────────────────────────────────────────────────────────────
function closeModals() {
  document.getElementById('closeModal').classList.remove('open')
  document.getElementById('editModal').classList.remove('open')
  state.closingPos = null
  state.editingPos = null
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

  const types  = ['insolvent', 'dca', 'grid', 'twap', 'trend', 'shorter']
  const labels = { insolvent: 'F', dca: 'DCA Bot', grid: 'Grid Bot', twap: 'TWAP', trend: 'Trend Follower', shorter: 'Shorter Bot' }

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
            <td style="text-align:right;color:var(--muted);font-family:'Space Mono',monospace;font-size:10px">${esc(s.lastWin)}</td>
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
          legend: { labels: { color: '#aaa', font: { family: 'Space Mono', size: 11 } } },
          tooltip: { callbacks: { label: ctx => ' $' + fmtUSD(ctx.parsed.y) } },
        },
        scales: {
          x: { ticks: { color: '#666', font: { family: 'Space Mono', size: 10 }, maxTicksLimit: 10 }, grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { ticks: { color: '#666', font: { family: 'Space Mono', size: 10 }, callback: v => '$' + fmtUSD(v) }, grid: { color: 'rgba(255,255,255,0.05)' } },
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
  // find the matching top nav button and switch
  const btn = [...document.querySelectorAll('.nav-tab')].find(b => b.getAttribute('onclick')?.includes(`'${name}'`))
  switchTab(name, btn)
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
  document.getElementById('selectedCoinLabel').textContent = 'Select market...'
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
  twap: [
    { ids: ['twap-total'],   test: vs => parseFloat(vs[0]) > 0, hint: 'Total must be > 0', targets: ['twap-total'] },
    { ids: ['twap-slices'],  test: vs => parseInt(vs[0]) >= 1,  hint: 'Min 1 slice', targets: ['twap-slices'] },
  ],
  trend: [
    { ids: ['trend-size'],   test: vs => parseFloat(vs[0]) > 0, hint: 'Size must be > 0', targets: ['trend-size'] },
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
  } else if (type === 'twap') {
    const coin     = get('twap-coin') || 'SOL'
    const side     = get('twap-side') || 'long'
    const total    = getSizeUsd('twap-total', 'twap-coin') || '1000'
    const duration = get('twap-duration') || '60'
    const slices   = get('twap-slices') || '12'
    const maxpos   = get('twap-maxpos') || '0'
    const lev      = get('twap-leverage') || '1'
    cmd = `node strategies/twap.js --coin ${coin} --side ${side} --total ${total} --duration ${duration} --slices ${slices} --max-position ${maxpos} --leverage ${lev} --wallet $WALLET_KEY${assetFlags ? ' ' + assetFlags : ''}`
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
      <span style="font-family:'Space Mono',monospace;font-size:11px;color:var(--red)">
        News pause: "${keyword}" detected
      </span>`
  } else {
    el.innerHTML = `<span class="risk-status-dot" style="background:var(--green)"></span>
      <span style="font-family:'Space Mono',monospace;font-size:11px">News: clear</span>`
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
      for (const type of ['insolvent','dca','grid','twap','trend','shorter']) {
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
  const labels  = { insolvent:'Insolvent', dca:'DCA', grid:'Grid', twap:'TWAP', trend:'Trend', shorter:'Shorter' }
  const running = []
  for (const type of ['insolvent','dca','grid','twap','trend','shorter']) {
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
  } else if (type === 'twap') {
    push('--coin',     get('twap-coin')     || 'SOL')
    push('--side',     get('twap-side')     || 'long')
    push('--total',    getSizeUsd('twap-total', 'twap-coin')  || '1000')
    push('--duration',     get('twap-duration') || '60')
    push('--slices',       get('twap-slices')   || '12')
    push('--max-position', get('twap-maxpos')   || '0')
    push('--leverage',     get('twap-leverage') || '1')
  } else if (type === 'trend') {
    push('--coin',      get('trend-coin')     || 'BTC')
    push('--fast-ema',       get('trend-fast')      || '9')
    push('--slow-ema',       get('trend-slow')      || '21')
    push('--candle-tf',      get('trend-tf')        || '1h')
    push('--size',           getSizeUsd('trend-size', 'trend-coin') || '500')
    push('--leverage',       get('trend-leverage')  || '3')
    push('--interval',       get('trend-interval')  || '5')
    push('--stop-loss-pct',  get('trend-stoploss')  || '0')
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

  const types    = ['insolvent','dca','grid','twap','trend','shorter']
  const labels   = { insolvent:'Insolvent', dca:'DCA Bot', grid:'Grid Bot', twap:'TWAP', trend:'Trend Follower', shorter:'Shorter Bot' }

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

// ─── AGENT KEY ────────────────────────────────────────────────────────────────
window.__saveAgentKey = function(val) {
  if (val) localStorage.setItem('hliq_agent_key', val)
}
function restoreAgentKey() {
  // Check current key, then fall back to any old per-wallet key
  let savedKey = localStorage.getItem('hliq_agent_key')
  if (!savedKey) {
    const oldKey = Object.keys(localStorage).find(k => k.startsWith('agentKey_'))
    if (oldKey) {
      savedKey = localStorage.getItem(oldKey)
      if (savedKey) localStorage.setItem('hliq_agent_key', savedKey) // migrate
    }
  }
  if (!savedKey) return
  const el = document.getElementById('agentKey')
  if (el) el.value = savedKey
  const tradeInput = document.getElementById('privateKeyInput')
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
  localStorage.removeItem('hliq_agent_key')
  _syncSettingsTab()
}

// Sync toggle state whenever settings tab is opened
function _syncSettingsTab() {
  // Agent key
  const agentKey = localStorage.getItem('hliq_agent_key')
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
      state.allMids = await infoClient.allMids()
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
      const lbl = document.getElementById('selectedCoinLabel')
      if (lbl) lbl.textContent = coin
      updateOrderSummary()
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
}

// Init defi card buttons on load
window.__updateDepositPreview()
window.__updateWithdrawPreview()

// Initial ticker render
updateWatchTicker()