/**
 * Revenue history, as a chart — opened from a row of the /markets Revenue view.
 *
 * Crypto tokens: DefiLlama's daily revenue (or fees) for the token's protocol, from
 * /markets-revenue (serve-prod.js). Stocks: the last 16 quarters reported to the SEC, which
 * ride along on the row (src/secrev.js → /markets-meta).
 *
 * One measure at a time, on one axis: revenue and fees are a toggle, never two scales on one
 * chart. Bars, because each is an amount for a period. Daily up to 90 days; a year is summed
 * by week and all time by month, so a bar never shrinks below what can be read or hovered. A
 * period still in progress (this week, this month) is drawn faded and labelled "so far", and
 * a fiscal fourth quarter derived from the 10-K is faded and marked * — both say so in the
 * tooltip and the table, never by colour alone.
 *
 * The pure helpers (windowPoints, bucket, rangeStats, niceScale) carry the arithmetic and are
 * tested on their own; openRevenueChart only draws.
 */

export const RANGES = [['30D', 30], ['90D', 90], ['1Y', 365], ['All', null]]
const DAY = 86_400_000
const BAR = '#4e8ff0'           // validated against the dark surface (dataviz validator)

// ── pure ────────────────────────────────────────────────────────────────────

/** [[unixSeconds, usd], …] → [{ t (ms), v }] within the last `days` of the series. */
export function windowPoints(points, days) {
  const pts = (points ?? []).map(([s, v]) => ({ t: Number(s) * 1000, v: Number(v) })).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v))
  if (!pts.length || !days) return pts
  // Measured from the newest day the series HAS, not from now: DefiLlama lags by a day.
  const end = pts[pts.length - 1].t
  return pts.filter(p => p.t > end - days * DAY)
}

const weekStart = (t) => { const d = new Date(t); const dow = (d.getUTCDay() + 6) % 7; return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow) }
const monthStart = (t) => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) }

/**
 * Daily points → bars for a range: daily (≤ 90 days), weekly (a year), monthly (all time).
 * Each bar: { t, v, days, unit, partial }. `partial` marks the newest bucket when it is not
 * yet complete — this week so far is not a week, and drawn like one it reads as a collapse.
 */
export function bucket(pts, days) {
  const unit = days && days <= 90 ? 'day' : days && days <= 400 ? 'week' : 'month'
  if (unit === 'day') return pts.map(p => ({ t: p.t, v: p.v, days: 1, unit, partial: false }))
  const key = unit === 'week' ? weekStart : monthStart
  const out = []
  for (const p of pts) {
    const k = key(p.t)
    const cur = out[out.length - 1]
    if (cur && cur.t === k) { cur.v += p.v; cur.days++ } else out.push({ t: k, v: p.v, days: 1, unit, partial: false })
  }
  const last = out[out.length - 1]
  if (last) {
    const full = unit === 'week' ? 7 : new Date(Date.UTC(new Date(last.t).getUTCFullYear(), new Date(last.t).getUTCMonth() + 1, 0)).getUTCDate()
    last.partial = last.days < full
  }
  // The OLDEST bucket can be partial too (a series that starts mid-month): flag it as well.
  const first = out[0]
  if (first && first !== last && unit === 'week' && first.days < 7) first.partial = true
  return out
}

/**
 * Total over the range, average per day, and the change against the range before it — only
 * when that earlier range is fully covered by data (a protocol that launched 40 days ago has
 * no "previous 90 days" to compare with, and a change against half of one is meaningless).
 */
export function rangeStats(points, days) {
  const all = windowPoints(points, null)
  const cur = windowPoints(points, days)
  const total = cur.reduce((a, p) => a + p.v, 0)
  const avg = cur.length ? total / cur.length : null
  let change = null
  if (days && all.length) {
    const end = all[all.length - 1].t
    const prev = all.filter(p => p.t <= end - days * DAY && p.t > end - 2 * days * DAY)
    const prevTotal = prev.reduce((a, p) => a + p.v, 0)
    if (prev.length >= days * 0.95 && prevTotal > 0) change = (total / prevTotal - 1) * 100
  }
  return { total, avg, days: cur.length, change }
}

/** A clean y-axis: 0 to a round maximum, in 4 steps of 1, 2, 2.5 or 5 × 10ⁿ. */
export function niceScale(max) {
  if (!(max > 0)) return { max: 1, ticks: [0, 1] }
  const raw = max / 4
  const p = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(s => s >= raw)
  const top = Math.ceil(max / step) * step
  const ticks = []
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v)
  return { max: top, ticks }
}

// ── formatting ──────────────────────────────────────────────────────────────

export const usd = (n) => {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n), s = n < 0 ? '-' : ''
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M'
  if (a >= 1e3) return s + '$' + (a / 1e3).toFixed(1) + 'K'
  return s + '$' + a.toFixed(0)
}
/** Axis ticks are round numbers: $150M, not $150.00M. */
export const tickUsd = (n) => usd(n).replace(/\.(\d*?)0+(?=[KMB]$)/, (_, d) => (d ? '.' + d : ''))
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const dLabel = (t) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}` }
const mLabel = (t) => { const d = new Date(t); return `${MON[d.getUTCMonth()]} '${String(d.getUTCFullYear()).slice(2)}` }
export function barLabel(b) {
  if (b.unit === 'day') return dLabel(b.t) + ', ' + new Date(b.t).getUTCFullYear()
  if (b.unit === 'week') return 'Week of ' + dLabel(b.t) + (b.partial ? ' (so far)' : '')
  if (b.unit === 'quarter') return b.label + (b.derived ? ' *' : '')
  return MON[new Date(b.t).getUTCMonth()] + ' ' + new Date(b.t).getUTCFullYear() + (b.partial ? ' (so far)' : '')
}

// ── the chart ───────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const cache = new Map()          // 'SYM|type' -> points

function drawBars(host, bars, { onHover } = {}) {
  const W = Math.max(280, host.clientWidth || 600), H = 260
  const L = 58, R = 8, T = 12, B = 26
  const pw = W - L - R, ph = H - T - B
  const { max, ticks } = niceScale(Math.max(0, ...bars.map(b => b.v)))
  const n = bars.length || 1
  const band = pw / n
  // ≤ 24px, never filling the band: the 2px surface gap between neighbours is the leftover.
  const bw = Math.max(1, Math.min(24, band - 2))
  const y = (v) => T + ph - (Math.max(0, v) / max) * ph
  const r = Math.min(4, bw / 2)
  const bar = (b, i) => {
    const x = L + i * band + (band - bw) / 2, top = y(b.v), base = T + ph, h = Math.max(0, base - top)
    if (h < 0.5) return `<rect x="${x}" y="${base - 0.5}" width="${bw}" height="0.5" fill="${BAR}" opacity=".35"/>`
    const rr = Math.min(r, h)
    // Rounded at the data end, square at the baseline.
    const d = `M${x},${base} L${x},${top + rr} Q${x},${top} ${x + rr},${top} L${x + bw - rr},${top} Q${x + bw},${top} ${x + bw},${top + rr} L${x + bw},${base} Z`
    const faded = b.partial || b.derived
    return `<path class="rc-bar" data-i="${i}" d="${d}" fill="${BAR}" opacity="${faded ? 0.45 : 1}"/>`
  }
  const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i && bars[v])
  const lab = (b) => b.unit === 'day' ? dLabel(b.t) : b.unit === 'quarter' ? b.short : mLabel(b.t)
  host.innerHTML = `<svg class="rc-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0"
      aria-label="Bar chart, ${bars.length} bars. Use the arrow keys to read each value.">
    ${ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="rc-grid"/>
      <text x="${L - 8}" y="${y(v) + 4}" class="rc-tick" text-anchor="end">${esc(tickUsd(v))}</text>`).join('')}
    ${bars.map(bar).join('')}
    ${xl.map(i => `<text x="${L + i * band + band / 2}" y="${H - 6}" class="rc-tick" text-anchor="${i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}">${esc(lab(bars[i]))}</text>`).join('')}
    <rect class="rc-hit" x="${L}" y="${T}" width="${pw}" height="${ph}" fill="transparent"/>
  </svg><div class="rc-tip" hidden></div>`
  const svg = host.querySelector('svg'), tip = host.querySelector('.rc-tip')
  let cur = -1
  const show = (i) => {
    cur = Math.max(0, Math.min(n - 1, i))
    host.querySelectorAll('.rc-bar').forEach(p => p.classList.toggle('is-hot', +p.dataset.i === cur))
    const b = bars[cur]
    // Value first and strongest, the period under it — built with textContent (data is untrusted).
    tip.replaceChildren()
    const v = document.createElement('b'); v.textContent = usd(b.v)
    const l = document.createElement('span'); l.textContent = barLabel(b)
    tip.append(v, l)
    if (b.derived) { const nt = document.createElement('small'); nt.textContent = 'Derived: the annual report less the three quarters filed before it'; tip.append(nt) }
    tip.hidden = false
    const sx = svg.getBoundingClientRect().width / W
    const cx = (L + cur * band + band / 2) * sx
    tip.style.left = Math.max(0, Math.min(host.clientWidth - tip.offsetWidth, cx - tip.offsetWidth / 2)) + 'px'
    tip.style.top = Math.max(0, y(b.v) * sx - tip.offsetHeight - 10) + 'px'
    onHover?.(b)
  }
  const hide = () => { tip.hidden = true; cur = -1; host.querySelectorAll('.rc-bar.is-hot').forEach(p => p.classList.remove('is-hot')) }
  // The whole plot is the hit area: the nearest bar to the pointer, not only its painted pixels.
  svg.addEventListener('pointermove', (e) => {
    const rect = svg.getBoundingClientRect()
    const x = (e.clientX - rect.left) * (W / rect.width)
    if (x < L || x > W - R) return hide()
    show(Math.floor((x - L) / band))
  })
  svg.addEventListener('pointerleave', hide)
  svg.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { show(cur < 0 ? n - 1 : cur + 1); e.preventDefault() }
    else if (e.key === 'ArrowLeft') { show(cur < 0 ? n - 1 : cur - 1); e.preventDefault() }
  })
  svg.addEventListener('blur', hide)
}

function tableHtml(bars) {
  return `<table class="rc-table"><thead><tr><th>Period</th><th>Amount</th></tr></thead><tbody>
    ${[...bars].reverse().map(b => `<tr><td>${esc(barLabel(b))}</td><td>${esc(usd(b.v))}</td></tr>`).join('')}
  </tbody></table>`
}

const tile = (label, value, sub = '') => `<div class="rc-stat"><span>${esc(label)}</span><b>${esc(value)}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
const pct = (c) => c == null ? '' : `<em class="${c >= 0 ? 'up' : 'dn'}">${c >= 0 ? '+' : ''}${c.toFixed(1)}% vs the period before</em>`

/**
 * Open the chart for a row. `row` is a /markets row: crypto rows carry `rev*`, stock rows
 * `sHist` (their quarters). Returns the overlay element.
 */
export function openRevenueChart(row) {
  document.getElementById('rcOverlay')?.remove()
  const stock = Array.isArray(row.sHist) && row.sHist.length > 0 && row.sq != null
  const state = { range: '90D', type: 'revenue' }
  const ov = document.createElement('div')
  ov.id = 'rcOverlay'
  ov.className = 'rc-overlay'
  ov.innerHTML = `<div class="rc-panel" role="dialog" aria-modal="true" aria-labelledby="rcTitle">
    <div class="rc-head">
      <div><h3 id="rcTitle"></h3><p class="rc-sub"></p></div>
      <button class="rc-close" aria-label="Close">×</button>
    </div>
    ${stock ? '' : `<div class="rc-controls">
      <div class="rc-seg" data-k="range">${RANGES.map(([l]) => `<button data-v="${l}" class="${l === state.range ? 'is-on' : ''}">${l}</button>`).join('')}</div>
      <div class="rc-seg" data-k="type"><button data-v="revenue" class="is-on">Revenue</button><button data-v="fees">Fees</button></div>
    </div>`}
    <div class="rc-stats"></div>
    <div class="rc-chart"><div class="rc-msg">Loading…</div></div>
    <details class="rc-details"><summary>Show as a table</summary><div class="rc-tbl"></div></details>
    <p class="rc-src"></p>
  </div>`
  document.body.appendChild(ov)
  ov.querySelector('#rcTitle').textContent = `${row.sym} — ${stock ? 'reported revenue' : 'revenue history'}`
  ov.querySelector('.rc-sub').textContent = (stock ? row.sName : row.revName) || row.name || ''
  ov.querySelector('.rc-src').textContent = stock
    ? 'Source: quarterly filings with the SEC. * A fiscal fourth quarter: the annual report less the three quarters filed before it.'
    : 'Source: DefiLlama. Revenue is what the protocol kept; fees are what its users paid. Days in UTC.'
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  ov.addEventListener('click', (e) => { if (e.target === ov) close() })
  ov.querySelector('.rc-close').addEventListener('click', close)
  ov.querySelector('.rc-close').focus()

  const chart = ov.querySelector('.rc-chart'), stats = ov.querySelector('.rc-stats'), tbl = ov.querySelector('.rc-tbl')

  if (stock) {
    const bars = row.sHist.map(([start, end, v, derived]) => {
      const e = new Date(end + 'T00:00:00Z'), s = new Date(start + 'T00:00:00Z')
      return { t: e.getTime(), v: Number(v), unit: 'quarter', derived: !!derived, partial: false,
               label: `${MON[s.getUTCMonth()]}–${MON[e.getUTCMonth()]} ${e.getUTCFullYear()}`, short: mLabel(e.getTime()) }
    })
    stats.innerHTML = tile('Last quarter', usd(row.sq)) + tile('Last 12 months', usd(row.sttm)) +
      tile('Growth, year on year', row.syoy == null ? '—' : `${row.syoy >= 0 ? '+' : ''}${row.syoy.toFixed(1)}%`)
    drawBars(chart, bars)
    tbl.innerHTML = tableHtml(bars)
    return ov
  }

  const render = (points) => {
    const days = RANGES.find(([l]) => l === state.range)[1]
    const bars = bucket(windowPoints(points, days), days)
    const st = rangeStats(points, days)
    const per = state.type === 'fees' ? 'Fees' : 'Revenue'
    stats.innerHTML = tile(`${per}, ${state.range === 'All' ? 'all time' : 'last ' + state.range}`, usd(st.total), pct(st.change)) +
      tile('Average per day', usd(st.avg)) +
      tile('Days of data', String(st.days))
    if (!bars.length) { chart.innerHTML = `<div class="rc-msg">No ${per.toLowerCase()} recorded for this range.</div>`; tbl.innerHTML = ''; return }
    drawBars(chart, bars)
    tbl.innerHTML = tableHtml(bars)
  }
  const load = async () => {
    const k = row.sym + '|' + state.type
    if (cache.has(k)) return render(cache.get(k))
    // Refetch keeps the frame: the previous chart stays, dimmed, until the new one lands.
    chart.style.opacity = chart.querySelector('svg') ? '.45' : ''
    try {
      const r = await fetch(`/markets-revenue?sym=${encodeURIComponent(row.sym)}&type=${state.type}`, { signal: AbortSignal.timeout(45_000) })
      const j = r.ok ? await r.json() : null
      if (!Array.isArray(j?.points)) throw new Error('none')
      cache.set(k, j.points)
      if (document.body.contains(ov)) render(j.points)
    } catch {
      chart.innerHTML = '<div class="rc-msg">The history is not available right now.</div>'
    } finally { chart.style.opacity = '' }
  }
  ov.querySelectorAll('.rc-seg').forEach(seg => seg.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-v]'); if (!b) return
    state[seg.dataset.k] = b.dataset.v
    seg.querySelectorAll('button').forEach(x => x.classList.toggle('is-on', x === b))
    load()
  }))
  load()
  return ov
}
