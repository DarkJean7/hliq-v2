/**
 * INSOLVENT TERMINAL — a span of the calendar, as a curve
 *
 * Two rows use this, and they are the same row twice: "Month's chart performance" between the
 * stat cards and the grid, and "Day's chart performance" inside a pressed day's panel. Asked
 * for as "similar as month's chart performance, no the same for the selected day".
 *
 * So nothing here knows about months. Everything takes a SPAN — { from, to } in milliseconds
 * — and monthBounds() and dayBounds() are the two ways of making one. A second copy of the
 * three series for days would have been the cheapest change and the wrong one: this file's
 * whole subject is that each series measures a different thing, and two copies of that
 * argument drift. The file is still called monthchart.js because the month row is what it
 * was built for and a rename buys nothing.
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

/** The same, for one 'YYYY-MM-DD' key — built the way the grid builds its keys, local time. */
export function dayBounds(key) {
  if (typeof key !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const [y, m, d] = key.split('-').map(Number)
  const from = new Date(y, m - 1, d).getTime()
  return { from, to: from + 86400000 - 1 }
}

/** A span this module will draw, or null. Anything else is refused rather than guessed at. */
export const isSpan = (sp) => !!sp && Number.isFinite(sp.from) && Number.isFinite(sp.to) && sp.to > sp.from

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
export function pickWindow(portfolio, key, span) {
  if (!isSpan(span)) return null
  const { from, to } = span
  let best = null
  for (const name of ACCOUNT_WINDOWS) {
    const all = windowHistory(portfolio, key, name)
    if (!all) continue
    const inMonth = all.filter(p => p.x >= from && p.x <= to)   // "inMonth" historically; it is the span
    if (!inMonth.length) continue
    const span = inMonth.at(-1).x - inMonth[0].x
    if (!best || span > best.span + 36e5 || (Math.abs(span - best.span) <= 36e5 && inMonth.length > best.inMonth.length)) {
      best = { name, all, inMonth, span }
    }
  }
  return best
}

/** The account's own value through the month. Absolute dollars. */
export function valueSeries(portfolio, span) {
  if (!Array.isArray(portfolio)) return null
  return pickWindow(portfolio, 'accountValueHistory', span)?.inMonth ?? []
}

/**
 * What the month itself made, as it went.
 *
 * HL's pnlHistory is all-time, so it is rebased: zero at the month's first instant, measured
 * against the last reading BEFORE the month started. Rebasing against the first reading INSIDE
 * it instead would silently drop whatever happened between midnight and that first bucket.
 */
export function accumSeries(portfolio, span) {
  if (!Array.isArray(portfolio) || !isSpan(span)) return null
  const { from } = span
  const win = pickWindow(portfolio, 'pnlHistory', span)
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
export function realizedSeries(fills, span) {
  if (!Array.isArray(fills) || !isSpan(span)) return null
  const { from, to } = span
  const closes = fills
    .filter(f => f && f.closedPnl && f.time >= from && f.time <= to)
    .sort((a, b) => a.time - b.time)
  if (!closes.length) return []
  let running = 0
  return [{ x: from, y: 0 }, ...closes.map(f => ({ x: f.time, y: (running += f.closedPnl) }))]
}

/**
 * The worst peak-to-trough run on a curve: { drop, from, to, peak }, or null when there is
 * no curve to walk. `drop` is positive dollars given back, 0 when it only ever went up.
 *
 * Used by the calendar's Max Drawdown card, which used to walk the DAILY CLOSED PnL instead
 * — so a month that gave back $600 of open profit and closed nothing at a loss reported "$0,
 * never gave any back" directly underneath a chart visibly showing the dip. Reported as:
 * "some of my accounts are experiencing a drawdown. despite that the card max drawdown is
 * displaying $0. it seems it uses just closed pnl."
 */
export function maxDrawdown(points) {
  if (!Array.isArray(points) || points.length < 2) return null
  let peak = points[0].y, peakX = points[0].x
  let drop = 0, from = null, to = null
  for (const p of points) {
    if (!Number.isFinite(p?.y)) continue
    if (p.y > peak) { peak = p.y; peakX = p.x }
    const gap = peak - p.y
    if (gap > drop) { drop = gap; from = peakX; to = p.x }
  }
  return { drop, from, to, peak }
}

/** The series for a mode, or null when the data it needs is not held. */
export function seriesFor(mode, { portfolio = null, fills = null } = {}, span) {
  if (mode === 'value')    return valueSeries(portfolio, span)
  if (mode === 'realized') return realizedSeries(fills, span)
  return accumSeries(portfolio, span)
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

/**
 * Open state and mode, PER SCOPE. One calendar is on screen at a time, but the month row and
 * a pressed day's row are on it together: one state for both would open and close them as a
 * pair and make the tabs of one move the other.
 */
export const MONTH = 'month'
export const DAY   = 'day'
const scopeOf = (s) => (s === DAY ? DAY : MONTH)
const _st = {
  [MONTH]: { open: false, mode: DEFAULT_MODE },
  [DAY]:   { open: false, mode: DEFAULT_MODE },
}

export const isOpen = (scope) => _st[scopeOf(scope)].open
export const currentMode = (scope) => _st[scopeOf(scope)].mode
export function setOpen(v, scope) { _st[scopeOf(scope)].open = !!v; return _st[scopeOf(scope)].open }
export function setMode(m, scope) {
  const sc = scopeOf(scope)
  _st[sc].mode = MODES.some(x => x.id === m) ? m : DEFAULT_MODE
  return _st[sc].mode
}
/**
 * Called when the calendar is OPENED, not when it re-renders: the row starts closed every
 * time the reader arrives, and stays as they left it while they page through months.
 *
 * Shuts any row already on screen as well as the flag. The mobile calendar skips rebuilding
 * itself when nothing about the month has changed, so leaving and coming straight back would
 * otherwise find the row exactly as it was left — closed in the state and open on the page.
 */
export function collapse() {
  _st[MONTH].open = false
  _st[DAY].open   = false
  if (typeof document === 'undefined') return
  document.querySelectorAll('[data-cal-chart]').forEach(el => repaint(el))
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// The day row and the month row are on screen together, so their canvases cannot share an id.
export const canvasId = (rootId, scope) => (scopeOf(scope) === DAY ? 'calDChart_' : 'calMChart_') + rootId
export const heroId   = (rootId, scope) => (scopeOf(scope) === DAY ? 'calDChartHero_' : 'calMChartHero_') + rootId

/**
 * The row, collapsed or open. Built to look like the note cards under the calendar, because it
 * is the same gesture on the same screen.
 */
/** What each row calls itself, and what its three captions say. One shape, two subjects. */
const WORDS = {
  [MONTH]: {
    title: "Month's chart performance",
    realized: 'Closed trades only, accumulated through the month — the same figures the days above add up.',
    accum:    "This month's PnL as it happened, unrealized included, starting from zero on the 1st.",
    value:    "The account's own value through the month. A deposit or a withdrawal moves it.",
  },
  [DAY]: {
    title: "Day's chart performance",
    realized: 'Closed trades only, accumulated through the day — the same figures this day adds up to.',
    accum:    "This day's PnL as it happened, unrealized included, starting from zero at midnight.",
    value:    "The account's own value through the day. A deposit or a withdrawal moves it.",
  },
}

/** "October 5, 2026" for a day, "October 2026" for a month — the subtitle under the title. */
function spanLabel(span, scope) {
  if (!isSpan(span)) return ''
  const d = new Date(span.from)
  return scopeOf(scope) === DAY
    ? `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`
    : `${MONTHS[d.getMonth()]} ${d.getFullYear()}`
}

/**
 * The row, collapsed or open. Built to look like the note cards under the calendar, because it
 * is the same gesture on the same screen.
 *
 * The span is written onto the element, so a repaint and a redraw can read it back without
 * asking the calendar which day is open — the day panel is rebuilt from scratch on every
 * press and the answer would be stale exactly when it changed.
 */
export function panelHtml(rootId, span, data = {}, scope = MONTH) {
  const sc = scopeOf(scope)
  const st = _st[sc]
  const modes = availableModes()
  if (!modes.some(m => m.id === st.mode)) st.mode = DEFAULT_MODE
  const active = modes.find(m => m.id === st.mode) ?? modes[0]
  const w = WORDS[sc]
  const tabs = modes.map(m => `<button class="chart-tab${m.id === st.mode ? ' active' : ''}"
      onclick="event.stopPropagation();window.__calChartMode('${esc(rootId)}','${m.id}','${sc}')">${m.label}</button>`).join('')
  return `<div class="cal-note-card cal-mchart${st.open ? ' open' : ''}" data-cal-chart="${esc(rootId)}"
      data-scope="${sc}" data-from="${isSpan(span) ? span.from : ''}" data-to="${isSpan(span) ? span.to : ''}">
    <div class="cal-note-head" onclick="window.__calChartToggle('${esc(rootId)}','${sc}')">
      <div class="cal-note-titles">
        <div class="cal-note-title">${w.title}</div>
        <div class="cal-note-date">${esc(spanLabel(span, sc))} · how the account moved</div>
      </div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" class="cal-note-chev"><polyline points="9 6 15 12 9 18"/></svg>
    </div>
    ${st.open ? `<div class="cal-note-body cal-mchart-body">
      <div class="chart-header" style="margin:10px 0 0">
        <div class="section-title" style="margin:0">${active.title}</div>
        <div class="chart-tabs" style="margin:0">${tabs}</div>
      </div>
      <div class="portfolio-pnl-hero" id="${heroId(rootId, sc)}"></div>
      <div class="cal-mchart-wrap"><canvas id="${canvasId(rootId, sc)}" style="cursor:crosshair"></canvas></div>
      <div class="cal-mchart-foot">${w[active.id] ?? ''}</div>
    </div>` : ''}
  </div>`
}

/** What the chart should say when a mode has no points, which is not the same as zero. */
export function emptyNote(mode, data = {}, scope = MONTH) {
  const what = scopeOf(scope) === DAY ? 'day' : 'month'
  if (!modeHasData(mode, data)) return 'Account history has not loaded yet'
  if (mode === 'realized') return `No trades closed in this ${what}`
  // A day far enough back that HL only keeps a coarse reading of it has no points to draw,
  // which is not the same as a flat day. Said plainly rather than shown as a flat line.
  return `No account history for this ${what}`
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
/** The element for one row, and the span written on it. */
function rowOf(rootId, scope) {
  return document.querySelector(`[data-cal-chart="${rootId}"][data-scope="${scopeOf(scope)}"]`)
}
function spanOf(el) {
  const from = Number(el?.getAttribute('data-from')), to = Number(el?.getAttribute('data-to'))
  return isSpan({ from, to }) ? { from, to } : null
}

/**
 * Draw (or redraw) one open row. Does nothing when it is closed — there is no canvas then,
 * and no chart to keep alive behind a collapsed card.
 */
export async function drawCalChart(rootId, scope = MONTH) {
  const sc = scopeOf(scope)
  if (typeof document === 'undefined' || !_st[sc].open) return
  const root = document.getElementById(rootId)
  const cache = root?._calData
  const el = rowOf(rootId, sc)
  const span = spanOf(el)
  if (!cache || !span || !document.getElementById(canvasId(rootId, sc))) return
  const mode = _st[sc].mode
  const data = chartData(cache.fills)
  const pts  = seriesFor(mode, data, span)
  // Imported here rather than at the top: charts.js reaches for `window` and pulls in
  // Chart.js, and the arithmetic above is meant to be readable by a test with neither.
  // main.js imports charts.js statically, so in the app this is already loaded.
  const { renderPerfChart } = await import('./charts.js')
  // The frame is the SPAN, not the data: the 1st (or midnight) on the left and its last
  // instant — or now, while it is still running — on the right, so a month that only traded
  // in its first week shows that, and two of them can be compared by eye.
  const { from, to } = span
  const now = Date.now()
  renderPerfChart(canvasId(rootId, sc), pts ?? [], heroId(rootId, sc), {
    kind: mode === 'value' ? 'value' : 'pnl',
    empty: emptyNote(mode, data, sc),
    // A guaranteed axis width, and four labels rather than three: with the frame measured
    // from the data (src/chartframe.js) the range is tight enough to carry them, and three
    // over a tight frame left whole cards with a single "$0" on the axis.
    maxTicks: 4, axisMin: 66,
    dates: true, xMin: from, xMax: now > from && now < to ? now : to,
  })
}

/** The month row, by its old name — src/render.js and the browser test both call it. */
export const drawMonthChart = (rootId) => drawCalChart(rootId, MONTH)
/** The day row. */
export const drawDayChart = (rootId) => drawCalChart(rootId, DAY)

/** Repaint just one row — not the calendar, so the grid and any open day panel stay put. */
function repaint(elOrRootId, scope = MONTH) {
  const el = typeof elOrRootId === 'string' ? rowOf(elOrRootId, scope) : elOrRootId
  if (!el) return
  const rootId = el.getAttribute('data-cal-chart')
  const sc     = scopeOf(el.getAttribute('data-scope'))
  const span   = spanOf(el)
  const cache  = document.getElementById(rootId)?._calData
  if (!cache || !span) return
  el.outerHTML = panelHtml(rootId, span, chartData(cache.fills), sc)
  drawCalChart(rootId, sc)
}

if (typeof window !== 'undefined') {
  window.__calChartToggle = (rootId, scope) => {
    const sc = scopeOf(scope)
    _st[sc].open = !_st[sc].open
    repaint(rootId, sc)
  }
  window.__calChartMode = (rootId, mode, scope) => { setMode(mode, scope); repaint(rootId, scopeOf(scope)) }
  // What a row is actually drawing. For the browser test, and for a console when a span on
  // screen looks wrong — charts.js exposes its own instances the same way.
  window.__calChartPoints = (rootId, scope) => {
    const sc = scopeOf(scope)
    const c = document.getElementById(rootId)?._calData
    const span = spanOf(rowOf(rootId, sc))
    return c && span ? seriesFor(_st[sc].mode, chartData(c.fills), span) : null
  }
  window.__calMonthPoints = (rootId) => window.__calChartPoints(rootId, MONTH)
}
