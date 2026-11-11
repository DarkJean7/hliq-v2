// "Past reports" in Signals → Macro: what each report said, when it came out and how Bitcoin moved that day.
// The last year is every release; five years is a line per year that opens into its months.
//
// The figures are FRED's CURRENT values, so a report that was later revised shows the revised number, not
// the one first printed. Release dates come from the agencies' calendars, which only reach back to 2025
// (BLS, BEA) and 2021 (the Fed). An older row shows the period it covers and no date: not knowing when it
// came out is not the same as it never coming out.

const DAY = 864e5
const KINDS = ['cpi', 'pce', 'ppi', 'jobs', 'jolts', 'gdp', 'fomc']

// main and second are item keys from /macro-data. GDP's date is its first estimate's.
const DEFS = {
  cpi:   { main: 'cpi', second: 'core', fmt: 'pct1', fmt2: 'pct1' },
  pce:   { main: 'pce', second: 'corepce', fmt: 'pct1', fmt2: 'pct1' },
  ppi:   { main: 'ppi', second: null, fmt: 'pct1' },
  jobs:  { main: 'payrolls', second: 'unrate', fmt: 'jobs', fmt2: 'pct1' },
  jolts: { main: 'jolts', second: null, fmt: 'mil' },
  gdp:   { main: 'gdp', second: null, fmt: 'pct1', quarter: true, stage: 'advance' },
}

const fmtV = (fmt, v) => {
  if (v == null || !Number.isFinite(v)) return '—'
  if (fmt === 'pct1') return v.toFixed(1) + '%'
  if (fmt === 'pct2') return v.toFixed(2) + '%'
  if (fmt === 'mil') return v.toFixed(2) + 'M'
  if (fmt === 'jobs') return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(0) + 'K'
  return String(v)
}
// Signed after rounding, so a dip of 0.004 reads "0.0 pt", not "−0.0 pt".
const sgn = (v, dp, unit = '') => { const r = Math.abs(v).toFixed(dp); return (+r === 0 ? '' : v > 0 ? '+' : '−') + r + unit }
const ym = (ms) => new Date(ms).toISOString().slice(0, 7)
const addMonths = (ms, n) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1, 12) }
const yearOf = (ms) => new Date(ms).getUTCFullYear()

/**
 * The rows for one report, newest first. `years` null is the last year; otherwise everything from
 * January `years` years before this one. Each row: { at, year, v, chg, v2, rel, btc }.
 * `rel` and `btc` are absent when the calendar does not reach that release.
 */
export function pastRows(d, kind, years = null, now = Date.now()) {
  if (kind === 'fomc') return fedRows(d, years, now)
  const def = DEFS[kind]
  if (!def) return []
  const by = Object.fromEntries((d?.items ?? []).map(i => [i.key, i]))
  const pts = (by[def.main]?.pts ?? []).filter(p => p && Number.isFinite(p[1]))
  const second = new Map((def.second ? by[def.second]?.pts ?? [] : []).map(p => [ym(p[0]), p[1]]))
  // By the month (or quarter) each release names. Matching by timing instead put every jobs report after
  // the 2025 shutdown on the following month's date, because one release had covered two months.
  const rel = new Map((d?.past ?? []).filter(e => e.kind === kind && e.period && (!def.stage || e.stage === def.stage)).map(e => [e.period, e]))
  const step = def.quarter ? 3 : 1
  const rows = []
  pts.forEach((p, i) => {
    // A month with no figure (October 2025: the shutdown stopped the survey) is a row that says so, not a
    // silent hole, and the month after it has no "change": that would be two months' worth.
    let next = i > 0 ? addMonths(pts[i - 1][0], step) : null
    for (; next != null && ym(next) < ym(p[0]); next = addMonths(next, step)) rows.push({ at: next, year: yearOf(next), gap: true })
    const adjacent = i > 0 && ym(addMonths(pts[i - 1][0], step)) === ym(p[0])
    const row = { at: p[0], year: yearOf(p[0]), v: p[1], chg: adjacent ? p[1] - pts[i - 1][1] : null, v2: second.get(ym(p[0])) ?? null }
    const e = rel.get(ym(p[0]))
    if (e) { row.rel = e.t; if (e.btc != null) row.btc = e.btc }
    rows.push(row)
  })
  return windowed(rows, years, now, def.quarter ? 4 : 12)
}

function windowed(rows, years, now, perYear) {
  const out = years == null ? rows.slice(-perYear) : rows.filter(r => r.year >= yearOf(now) - years)
  return out.reverse()
}

/**
 * Fed decisions, one per scheduled meeting: the top of the target range after it and the change it made.
 * The range moves the day after the statement, so "after" looks two days on and "before" looks before it.
 */
function fedRows(d, years, now) {
  const fed = (d?.items ?? []).find(i => i.key === 'fed')
  const steps = (fed?.pts ?? []).filter(p => p && Number.isFinite(p[1]))
  const at = (t) => { let v = null; for (const p of steps) { if (p[0] <= t) v = p[1]; else break } return v }
  const meets = (d?.past ?? []).filter(e => e.kind === 'fomc').sort((a, b) => a.t - b.t)
  const rows = meets.map((e) => {
    const before = at(e.t - DAY / 2), after = at(e.t + 2 * DAY)
    const row = { at: e.t, year: yearOf(e.t), rel: e.t, v: after, chg: before != null && after != null ? +(after - before).toFixed(2) : null, projections: !!e.projections }
    if (e.btc != null) row.btc = e.btc
    return row
  })
  if (years == null) return rows.filter(r => r.at > now - 366 * DAY).reverse()
  return rows.filter(r => r.year >= yearOf(now) - years).reverse()
}

/** One line for a year: what the report did across it. */
export function yearSummary(kind, all, T) {
  const rows = all.filter(r => !r.gap)
  const vs = rows.map(r => r.v).filter(Number.isFinite)
  if (!vs.length) return ''
  const last = rows[0]     // newest first
  const avg = vs.reduce((a, b) => a + b, 0) / vs.length
  switch (kind) {
    case 'fomc': {
      const cuts = rows.filter(r => r.chg < 0), hikes = rows.filter(r => r.chg > 0)
      const net = rows.reduce((a, r) => a + (r.chg ?? 0), 0)
      const moves = [cuts.length && T(`${cuts.length} cut${cuts.length === 1 ? '' : 's'}`, `${cuts.length} recorte${cuts.length === 1 ? '' : 's'}`), hikes.length && T(`${hikes.length} hike${hikes.length === 1 ? '' : 's'}`, `${hikes.length} subida${hikes.length === 1 ? '' : 's'}`)].filter(Boolean)
      return `${moves.length ? moves.join(', ') + ' · ' + sgn(net, 2, ' pt') : T('No change', 'Sin cambios')} · ${T('ended', 'cerró en')} ${rangeOf(last.v)}`
    }
    case 'jobs': {
      const sum = vs.reduce((a, b) => a + b, 0)
      const jobs = Math.abs(sum) >= 1000 ? sgn(sum / 1000, 2, 'M') : sgn(sum, 0, 'K')
      return `${T(`${jobs} jobs`, `${jobs} empleos`)}${last.v2 != null ? ` · ${T('unemployment ended', 'desempleo cerró en')} ${fmtV('pct1', last.v2)}` : ''}`
    }
    case 'jolts': return `${T('avg', 'media')} ${fmtV('mil', avg)} ${T('openings', 'vacantes')} · ${T('ended', 'cerró en')} ${fmtV('mil', last.v)}`
    default: return `${T('avg', 'media')} ${avg.toFixed(1)}% · ${T('ended', 'cerró en')} ${fmtV('pct1', last.v)}`
  }
}
const rangeOf = (top) => top == null ? '—' : `${Math.max(0, top - 0.25).toFixed(2)}–${top.toFixed(2)}%`

// ── the card ──
let _kind = 'cpi', _range = '1y'
const _yr = new Map()     // year → open, overriding "newest year open"
try { const s = JSON.parse(localStorage.getItem('hliq_macro_past') || '{}'); if (KINDS.includes(s.kind)) _kind = s.kind; if (s.range === '5y') _range = '5y' } catch {}
const save = () => { try { localStorage.setItem('hliq_macro_past', JSON.stringify({ kind: _kind, range: _range })) } catch {} }

export function macroPastSet(what, v, repaint) {
  if (what === 'kind' && KINDS.includes(v)) _kind = v
  else if (what === 'range' && (v === '1y' || v === '5y')) _range = v
  else if (what === 'year') _yr.set(+v, !yearOpen(+v))
  else return
  save(); repaint()
}
let _newest = null
const yearOpen = (y) => _yr.has(y) ? _yr.get(y) : y === _newest

const CARD = 'border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:11px 12px;margin-top:10px'
const SMALL = 'font-size:10.5px;color:var(--fg-3);line-height:1.5'
const chip = (on, label, attr, call) => `<button ${attr} aria-pressed="${on}" onclick="${call}" style="flex-shrink:0;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;border:1px solid ${on ? 'var(--accent)' : 'var(--border2)'};background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#000' : 'var(--muted)'}">${label}</button>`

function heads(kind, T) {
  return {
    cpi: [T('CPI', 'IPC'), T('Core', 'Subyac.')], pce: ['PCE', T('Core', 'Subyac.')], ppi: [T('Yearly', 'Anual'), ''],
    jobs: [T('Jobs added', 'Empleos'), T('Unemp.', 'Desempleo')], jolts: [T('Openings', 'Vacantes'), ''], gdp: [T('Growth', 'Crecim.'), ''],
    fomc: [T('Decision', 'Decisión'), T('Range after', 'Rango tras')],
  }[kind]
}

function periodText(kind, at) {
  const d = new Date(at)
  if (kind === 'fomc') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  if (kind === 'gdp') return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`
  return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function rowHtml(kind, r, T, esc) {
  const def = DEFS[kind]
  const cell = (main, sub = '') => `<div style="text-align:right;min-width:0"><div style="font-size:12px;font-weight:800;font-family:var(--font-mono);white-space:nowrap">${main}</div>${sub ? `<div style="font-size:10px;color:var(--muted);font-family:var(--font-mono);white-space:nowrap">${sub}</div>` : ''}</div>`
  let a, b
  if (r.gap) {
    a = cell('—', T('No figure', 'Sin cifra'))
    b = def.second ? cell('—') : '<div></div>'
  } else if (kind === 'fomc') {
    a = cell(r.chg == null ? '—' : r.chg === 0 ? T('Hold', 'Sin cambio') : r.chg < 0 ? T('Cut', 'Recorte') + ' ' + Math.abs(r.chg).toFixed(2) : T('Hike', 'Subida') + ' ' + r.chg.toFixed(2))
    b = cell(rangeOf(r.v))
  } else {
    const chg = r.chg == null || kind === 'jobs' ? '' : def.fmt === 'mil' ? sgn(r.chg, 2, 'M') : sgn(r.chg, 1, ' pt')
    a = cell(esc(fmtV(def.fmt, r.v)), chg)
    b = def.second ? cell(esc(fmtV(def.fmt2, r.v2))) : '<div></div>'
  }
  const rel = kind === 'fomc'
    ? (r.projections ? T('with projections', 'con proyecciones') : '')
    : r.rel ? T('Out', 'Salió') + ' ' + new Date(r.rel).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
  return `<div data-past-row style="display:contents">
    <div style="min-width:0"><div style="font-size:12px;font-weight:700;white-space:nowrap">${esc(periodText(kind, r.at))}</div>${rel ? `<div style="font-size:10px;color:var(--muted);white-space:nowrap">${esc(rel)}</div>` : ''}</div>
    ${a}${b}
    ${cell(r.btc == null ? '—' : sgn(r.btc, 1, '%'))}
  </div>`
}

function grid(kind, rows, T, esc) {
  const [h1, h2] = heads(kind, T)
  const head = (s, right = true) => `<div style="font-size:10px;color:var(--muted);${right ? 'text-align:right;' : ''}white-space:nowrap">${s}</div>`
  return `<div style="display:grid;grid-template-columns:minmax(0,1fr) auto auto auto;gap:7px 12px;align-items:center;margin-top:6px">
    ${head(kind === 'fomc' ? T('Meeting', 'Reunión') : T('Period', 'Período'), false)}${head(h1)}${head(h2)}${head(T('BTC that day', 'BTC ese día'))}
    ${rows.map(r => rowHtml(kind, r, T, esc)).join('')}
  </div>`
}

/** The whole card. `d` is /macro-data; `ctx` brings T and esc. */
export function pastCardHtml(d, ctx, now = Date.now()) {
  const { T, esc } = ctx
  const names = { cpi: 'CPI', pce: 'PCE', ppi: 'PPI', jobs: T('Jobs', 'Empleo'), jolts: 'JOLTS', gdp: T('GDP', 'PIB'), fomc: 'Fed' }
  const kinds = KINDS.map(k => chip(_kind === k, names[k], `data-past-kind="${k}"`, `window.__macroPast('kind','${k}')`)).join('')
  const ranges = [['1y', T('1Y', '1A')], ['5y', T('5Y', '5A')]].map(([k, l]) => chip(_range === k, l, `data-past-range="${k}"`, `window.__macroPast('range','${k}')`)).join('')
  const rows = pastRows(d, _kind, _range === '5y' ? 5 : null, now)
  let body
  if (!rows.length) body = `<div style="font-size:12px;color:var(--fg-3);padding:8px 0">${T('No past figures are available for this report right now.', 'No hay cifras pasadas disponibles ahora para este informe.')}</div>`
  else if (_range === '1y') body = grid(_kind, rows, T, esc)
  else {
    const years = [...new Set(rows.map(r => r.year))]
    _newest = years[0]
    body = years.map((y) => {
      const yr = rows.filter(r => r.year === y), open = yearOpen(y)
      return `<div style="border-top:1px solid var(--border);margin-top:6px">
        <div data-past-year="${y}" role="button" tabindex="0" aria-expanded="${open}" onclick="window.__macroPast('year',${y})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();window.__macroPast('year',${y})}" style="display:flex;align-items:center;gap:10px;padding:8px 0 2px;cursor:pointer">
          <div style="font-size:12.5px;font-weight:800;flex-shrink:0">${y}</div>
          <div style="flex:1;min-width:0;font-size:11px;color:var(--fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(yearSummary(_kind, yr, T))}</div>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${open ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>
        </div>
        ${open ? grid(_kind, yr, T, esc) : ''}
      </div>`
    }).join('')
  }
  return `<div id="macroPast" style="${CARD}">
    <div style="display:flex;align-items:center;gap:8px">
      <div style="font-size:12.5px;font-weight:800;flex:1">${T('Past reports', 'Informes pasados')}</div>
      <div style="display:flex;gap:5px">${ranges}</div>
    </div>
    <div data-dragscroll style="display:flex;gap:5px;overflow-x:auto;margin-top:8px;padding-bottom:2px">${kinds}</div>
    ${body}
    <div style="${SMALL};margin-top:8px;border-top:1px solid var(--border);padding-top:7px">${T('Figures are the latest revised values, so they can differ from what was first announced. PCE and GDP release dates reach back to late 2024, so older rows of those show the period only. "No figure" is a month that was never published or has nothing to compare with. Bitcoin\'s move covers the last year, over the whole UTC day of the release, so it includes everything else that happened.', 'Las cifras son los valores revisados más recientes, así que pueden diferir de lo anunciado al principio. Las fechas de PCE y PIB llegan hasta finales de 2024, así que sus filas anteriores solo muestran el período. "Sin cifra" es un mes que no se publicó o que no tiene con qué compararse. El movimiento de Bitcoin cubre el último año, sobre el día UTC completo de la publicación, así que incluye todo lo demás que pasó.')}</div>
  </div>`
}
