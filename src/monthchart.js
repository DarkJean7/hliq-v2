/**
 * INSOLVENT TERMINAL — the month, as a curve
 *
 * The calendar says what each day made. It does not say how the month got there: a month that
 * ends +$2,497 having never given anything back and a month that ends +$2,497 after being down
 * $1,800 in the middle are the same nine stat cards and the same grid of green squares.
 *
 * Asked for: "it would allow the user see how a month's drawback, etc may have affected" —
 * so, between the stat cards and the grid, a collapsed row that opens into the Portfolio tab's
 * own chart, restricted to the month being looked at. Collapsed whenever the calendar is
 * opened, because the calendar is what the reader came for.
 *
 * ── the three series, and what each is measuring ──
 *
 *   ACCOUNT VALUE      HL's own portfolio value, as it stood through the month. Absolute
 *                      dollars, so a deposit shows as a step — which is the truth about the
 *                      account even though it is not performance.
 *   ACCUMULATIVE PnL   HL's own PnL history, REBASED to zero at the month's first instant:
 *                      what this month made, as it went, unrealized included. This is the one
 *                      that shows a drawdown while it is happening.
 *   REALIZED PnL       The closing fills of the month, accumulated. It moves only when a trade
 *                      closes, so it is a staircase, and it is the same closedPnl the grid
 *                      above sums into each day.
 *
 * ── where the points come from ──
 *
 * HL's `portfolio` call answers in four windows (day / week / month / allTime) at four
 * resolutions. No single one of them is right for "whichever month is on screen": `month`
 * covers the last 30 days at a fine grain and cannot reach March, `allTime` reaches March but
 * is coarse. So all four are merged and then cut to the month — each timestamp taken once,
 * which gives whatever the best available resolution for that month happens to be.
 *
 * ── what it cannot show ──
 *
 * A month further back than the fills the app holds shows an empty Realized series. That is
 * the same limit the grid above it has (it is drawn from those same fills), so the two agree
 * with each other — but it is a limit, not a month in which nothing was closed.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']

/** The modes, in the order they are offered. `needs` is the data a mode cannot do without. */
export const MODES = [
  { id: 'value',    label: 'Value',    title: 'Account value',    needs: 'portfolio' },
  { id: 'accum',    label: 'Accum.',   title: 'Accumulative PnL', needs: 'portfolio' },
  { id: 'realized', label: 'Realized', title: 'Realized PnL',     needs: 'fills' },
]

export const DEFAULT_MODE = 'accum'

/** First and last millisecond of the month, in the reader's own timezone — the same boundary
 *  the grid's day keys are built on, so the curve and the squares describe one month. */
export function monthBounds(year, month) {
  return { from: new Date(year, month, 1).getTime(), to: new Date(year, month + 1, 1).getTime() - 1 }
}

const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

/**
 * The windows that describe the WHOLE account.
 *
 * HL answers the portfolio call with eight: these four, and a perp-only twin of each
 * (perpDay … perpAllTime) carrying just the perp side's equity. Points from all eight used to
 * be merged into one line here, which is what made the All Accounts chart look like a
 * scribble — two quantities hundreds or thousands of dollars apart, sampled on grids that do
 * not line up, drawn alternately as if they were one series. Reported as "in all accounts the
 * charts are very bad… they are so wrong", and the single account had the same fault; its
 * perp and unified values just happen to sit closer together.
 */
const ACCOUNT_WINDOWS = ['day', 'week', 'month', 'allTime']

/** One window's series, sorted, as points. Null when that window is not in the portfolio. */
export function windowHistory(portfolio, key, name) {
  if (!Array.isArray(portfolio)) return null
  const hist = portfolio.find(e => e?.[0] === name)?.[1]?.[key]
  if (!Array.isArray(hist) || !hist.length) return null
  const pts = hist.map(p => ({ x: num(p?.[0]), y: num(p?.[1]) }))
    .filter(p => p.x != null && p.y != null)
    .sort((a, b) => a.x - b.x)
  return pts.length ? pts : null
}

/**
 * The best single window for this month, and its points.
 *
 * ONE window, never a blend: `day` and `allTime` are the same quantity at different
 * resolutions, but they are sampled and (in the combined view) resampled independently, so
 * interleaving them draws the difference between two approximations as if it were the market.
 *
 * Best means: covers the most of the month — a window that reaches only the last 24 hours
 * cannot describe September — and, between two that cover the same span, the one with more
 * points, which is the finer grain. So the current month is usually drawn from `month` and an
 * older one from `allTime`, without either being hard-coded.
 */
export function pickWindow(portfolio, key, year, month) {
  const { from, to } = monthBounds(year, month)
  let best = null
  for (const name of ACCOUNT_WINDOWS) {
    const all = windowHistory(portfolio, key, name)
    if (!all) continue
    const inMonth = all.filter(p => p.x >= from && p.x <= to)
    if (!inMonth.length) continue
    const span = inMonth.at(-1).x - inMonth[0].x
    if (!best || span > best.span + 36e5 || (Math.abs(span - best.span) <= 36e5 && inMonth.length > best.inMonth.length)) {
      best = { name, all, inMonth, span }
    }
  }
  return best
}

/** The account's own value through the month. Absolute dollars. */
export function valueSeries(portfolio, year, month) {
  if (!Array.isArray(portfolio)) return null
  return pickWindow(portfolio, 'accountValueHistory', year, month)?.inMonth ?? []
}

/**
 * What the month itself made, as it went.
 *
 * HL's pnlHistory is all-time, so it is rebased: zero at the month's first instant, measured
 * against the last reading BEFORE the month started. Rebasing against the first reading INSIDE
 * it instead would silently drop whatever happened between midnight and that first bucket.
 */
export function accumSeries(portfolio, year, month) {
  if (!Array.isArray(portfolio)) return null
  const { from } = monthBounds(year, month)
  const win = pickWindow(portfolio, 'pnlHistory', year, month)
  if (!win) return []
  const { all, inMonth } = win
  // The baseline comes from the SAME window: a reading from a different one is a different
  // approximation of the same number, and the whole month would be shifted by the gap.
  const before = all.filter(p => p.x < from).at(-1)
  const base = before ? before.y : inMonth[0].y
  const pts = inMonth.map(p => ({ x: p.x, y: p.y - base }))
  // Start the line ON the first of the month at zero, so the shape is the month's and the
  // eye is not asked to subtract a starting offset.
  return before ? [{ x: from, y: 0 }, ...pts] : pts
}

/**
 * The month's closing fills, accumulated — a staircase, one step per close.
 *
 * closedPnl only, the same figure the day squares above are summed from, so the last point of
 * this line equals the Month PnL card. Fees are not taken out here for exactly that reason.
 */
export function realizedSeries(fills, year, month) {
  if (!Array.isArray(fills)) return null
  const { from, to } = monthBounds(year, month)
  const closes = fills
    .filter(f => f && f.closedPnl && f.time >= from && f.time <= to)
    .sort((a, b) => a.time - b.time)
  if (!closes.length) return []
  let running = 0
  return [{ x: from, y: 0 }, ...closes.map(f => ({ x: f.time, y: (running += f.closedPnl) }))]
}

/** The series for a mode, or null when the data it needs is not held. */
export function seriesFor(mode, { portfolio = null, fills = null } = {}, year, month) {
  if (mode === 'value')    return valueSeries(portfolio, year, month)
  if (mode === 'realized') return realizedSeries(fills, year, month)
  return accumSeries(portfolio, year, month)
}

/**
 * All three, always — the tab is how the reader learns the series exists.
 *
 * They used to be filtered by what was held, and a view whose account history had not arrived
 * (or was wrongly withheld, as the combined view's was) showed a lone "Realized" tab with
 * nothing to say why: "how can i see the month account equity and accumulative pnl". A tab
 * that opens onto an explained empty chart answers that question; a missing tab cannot.
 */
export function availableModes() { return MODES }

/** Whether a mode has the data it needs — for the note the empty chart shows. */
export function modeHasData(mode, { portfolio = null, fills = null } = {}) {
  const m = MODES.find(x => x.id === mode)
  return m?.needs === 'fills' ? Array.isArray(fills) : Array.isArray(portfolio)
}

// ── the panel ─────────────────────────────────────────────────────────────────

// Open state and mode, per nothing: one calendar is on screen at a time, and the row is
// collapsed again whenever the calendar is opened (collapse() below).
let _open = false
let _mode = DEFAULT_MODE

export const isOpen = () => _open
export const currentMode = () => _mode
export function setOpen(v) { _open = !!v; return _open }
export function setMode(m) { _mode = MODES.some(x => x.id === m) ? m : DEFAULT_MODE; return _mode }
/**
 * Called when the calendar is OPENED, not when it re-renders: the row starts closed every
 * time the reader arrives, and stays as they left it while they page through months.
 *
 * Shuts any row already on screen as well as the flag. The mobile calendar skips rebuilding
 * itself when nothing about the month has changed, so leaving and coming straight back would
 * otherwise find the row exactly as it was left — closed in the state and open on the page.
 */
export function collapse() {
  _open = false
  if (typeof document === 'undefined') return
  document.querySelectorAll('[data-cal-mchart]').forEach(el => repaint(el.getAttribute('data-cal-mchart')))
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export const canvasId = (rootId) => 'calMChart_' + rootId
export const heroId   = (rootId) => 'calMChartHero_' + rootId

/**
 * The row, collapsed or open. Built to look like the note cards under the calendar, because it
 * is the same gesture on the same screen.
 */
export function panelHtml(rootId, year, month, data = {}) {
  const modes = availableModes()
  if (!modes.some(m => m.id === _mode)) _mode = DEFAULT_MODE
  const active = modes.find(m => m.id === _mode) ?? modes[0]
  const tabs = modes.map(m => `<button class="chart-tab${m.id === _mode ? ' active' : ''}"
      onclick="event.stopPropagation();window.__calMonthChartMode('${esc(rootId)}','${m.id}')">${m.label}</button>`).join('')
  return `<div class="cal-note-card cal-mchart${_open ? ' open' : ''}" data-cal-mchart="${esc(rootId)}">
    <div class="cal-note-head" onclick="window.__calMonthChartToggle('${esc(rootId)}')">
      <div class="cal-note-titles">
        <div class="cal-note-title">Month's chart performance</div>
        <div class="cal-note-date">${MONTHS[month]} ${year} · how the account moved</div>
      </div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" class="cal-note-chev"><polyline points="9 6 15 12 9 18"/></svg>
    </div>
    ${_open ? `<div class="cal-note-body cal-mchart-body">
      <div class="chart-header" style="margin:10px 0 0">
        <div class="section-title" style="margin:0">${active.title}</div>
        <div class="chart-tabs" style="margin:0">${tabs}</div>
      </div>
      <div class="portfolio-pnl-hero" id="${heroId(rootId)}"></div>
      <div class="cal-mchart-wrap"><canvas id="${canvasId(rootId)}" style="cursor:crosshair"></canvas></div>
      <div class="cal-mchart-foot">${active.id === 'realized'
        ? 'Closed trades only, accumulated through the month — the same figures the days above add up.'
        : active.id === 'accum'
          ? 'This month\'s PnL as it happened, unrealized included, starting from zero on the 1st.'
          : 'The account\'s own value through the month. A deposit or a withdrawal moves it.'}</div>
    </div>` : ''}
  </div>`
}

/** What the chart should say when a mode has no points, which is not the same as zero. */
export function emptyNote(mode, data = {}) {
  if (!modeHasData(mode, data)) return 'Account history has not loaded yet'
  if (mode === 'realized') return 'No trades closed in this month'
  return 'No account history for this month'
}

// ── wiring ────────────────────────────────────────────────────────────────────

/**
 * Where the portfolio comes from.
 *
 * The calendar is rendered from seven places (both shells, the combined view, the accounts
 * tab) and already carries the fills each of them means. Threading a portfolio through all
 * seven signatures to reach this one row would touch every caller; asking for it at draw time
 * does not. The combined view answers null — it has no single account history, and a sum of
 * eight wallets' histories is a different problem with its own module.
 */
let _source = () => null
export function setMonthChartSource(fn) { _source = typeof fn === 'function' ? fn : () => null }

/** The data the panel draws from, for one calendar's fills. */
export function chartData(fills) {
  let s = null
  try { s = _source() } catch { s = null }
  return { portfolio: Array.isArray(s?.portfolio) ? s.portfolio : null, fills: Array.isArray(fills) ? fills : null }
}

/**
 * Draw (or redraw) the open panel for one calendar. Does nothing when the row is closed —
 * there is no canvas then, and no chart to keep alive behind a collapsed card.
 */
export async function drawMonthChart(rootId) {
  if (typeof document === 'undefined' || !_open) return
  const root = document.getElementById(rootId)
  const cache = root?._calData
  if (!cache || !document.getElementById(canvasId(rootId))) return
  const data = chartData(cache.fills)
  const pts  = seriesFor(_mode, data, cache.year, cache.month)
  // Imported here rather than at the top: charts.js reaches for `window` and pulls in
  // Chart.js, and the arithmetic above is meant to be readable by a test with neither.
  // main.js imports charts.js statically, so in the app this is already loaded.
  const { renderPerfChart } = await import('./charts.js')
  // The frame is the MONTH, not the data: the 1st on the left and the last day (or today, in
  // the month still running) on the right, so a month that only traded in its first week
  // shows that, and two months can be compared by eye.
  const { from, to } = monthBounds(cache.year, cache.month)
  const now = Date.now()
  renderPerfChart(canvasId(rootId), pts ?? [], heroId(rootId), {
    kind: _mode === 'value' ? 'value' : 'pnl',
    empty: emptyNote(_mode, data),
    // Three labels and a guaranteed axis width: this chart lives in a card a third the height
    // of the Portfolio tab's, where four labels crowd and a clipped "$1,000.00" reads as a
    // glitch rather than as an axis.
    maxTicks: 3, axisMin: 66,
    dates: true, xMin: from, xMax: now > from && now < to ? now : to,
  })
}

/** Repaint just the row — not the calendar, so the grid and any open day panel stay put. */
function repaint(rootId) {
  const el = document.querySelector(`[data-cal-mchart="${rootId}"]`)
  const root = document.getElementById(rootId)
  const cache = root?._calData
  if (!el || !cache) return
  el.outerHTML = panelHtml(rootId, cache.year, cache.month, chartData(cache.fills))
  drawMonthChart(rootId)
}

if (typeof window !== 'undefined') {
  window.__calMonthChartToggle = (rootId) => { _open = !_open; repaint(rootId) }
  window.__calMonthChartMode   = (rootId, mode) => { setMode(mode); repaint(rootId) }
  // What the row is actually drawing. For the browser test, and for a console when a month
  // on screen looks wrong — charts.js exposes its own instances the same way.
  window.__calMonthPoints = (rootId) => {
    const c = document.getElementById(rootId)?._calData
    return c ? seriesFor(_mode, chartData(c.fills), c.year, c.month) : null
  }
}
