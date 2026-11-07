// The Macro view inside Signals. The numbers come from /macro-data (src/macro.js), served from our own
// box, so opening this spends nothing from the Hyperliquid budget.
//
// Rises and falls are not coloured green and red here. A jump in unemployment can send markets up if it
// brings rate cuts closer, and hot inflation can do the reverse. The view says what the number did, and
// what it means for a trader is the reader's call.

import { fngWindow, fngZone, FNG_ZONES } from './macro.js'

const REFRESH = 10 * 60e3
const RETRY = 30e3
let _d = null, _at = 0, _busy = false, _failed = false, _retry = null
const _open = new Set()

let ctx = {
  T: (en) => en, esc: (s) => String(s),
  chart: () => '',              // main.js's interactive chart
  tv: () => {},                 // main.js's TradingView embed
  tvTheme: () => 'dark',
  visible: () => false,         // is this view on screen
  repaint: () => {},
}
const TV_URL = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js'
export function setMacroDeps(deps) { ctx = { ...ctx, ...deps } }

/** Fetch if it is due. Each render calls this; it does nothing most of the time. */
export function ensureMacro(now = Date.now()) {
  if (_busy || (_d && now - _at < REFRESH) || _retry) return
  _busy = true
  fetch('/macro-data', { signal: AbortSignal.timeout(60_000) })
    .then(r => (r.ok ? r.json() : null))
    .then((j) => { if (j?.items) { _d = j; _at = Date.now(); _failed = false } else _failed = true })
    .catch(() => { _failed = true })
    .finally(() => {
      _busy = false
      if (_failed) _retry = setTimeout(() => { _retry = null; if (ctx.visible()) ensureMacro() }, RETRY)
      if (ctx.visible()) ctx.repaint()
    })
}

let _fngRange = '1y'
let _tvSel = { cap: 'total', dom: 'btcd' }
try { const s = JSON.parse(localStorage.getItem('hliq_macro_charts') || '{}'); if (s.fng) _fngRange = s.fng; _tvSel = { ..._tvSel, ...s.tv } } catch {}
const saveCharts = () => { try { localStorage.setItem('hliq_macro_charts', JSON.stringify({ fng: _fngRange, tv: _tvSel })) } catch {} }
const FNG_RANGES = [['30d', 30], ['90d', 90], ['1y', 365], ['3y', 1095], ['all', null]]

export function macroFngRange(r) { if (FNG_RANGES.some(x => x[0] === r)) { _fngRange = r; saveCharts(); ctx.repaint() } }
export function macroTvSel(card, k) { if (TV_CHARTS[card]?.[k]) { _tvSel[card] = k; saveCharts(); ctx.repaint() } }

export function macroToggle(key) {
  if (_open.has(key)) _open.delete(key); else _open.add(key)
  ctx.repaint()
}

const signed = (n, s) => (n > 0 ? '+' : n < 0 ? '−' : '') + s(Math.abs(n))

export function fmtMacro(fmt, v) {
  if (v == null || !Number.isFinite(v)) return '—'
  switch (fmt) {
    case 'pct1': return v.toFixed(1) + '%'
    case 'pct2': return v.toFixed(2) + '%'
    case 'pts2': return (v > 0 ? '+' : '') + v.toFixed(2)
    case 'jobs': return signed(v, a => a.toFixed(0) + 'K')
    case 'k': return v.toFixed(0) + 'K'
    case 'num1': return v.toFixed(1)
    case 'num2': return v.toFixed(2)
    case 'usd2': return '$' + v.toFixed(2)
    default: return String(v)
  }
}
/** The same change, in the units that figure is read in. */
export function fmtDelta(fmt, d) {
  if (d == null || !Number.isFinite(d)) return ''
  switch (fmt) {
    case 'pct1': return signed(+d.toFixed(1), a => a.toFixed(1)) + ' pt'
    case 'pct2': case 'pts2': return signed(+d.toFixed(2), a => a.toFixed(2)) + ' pt'
    case 'jobs': case 'k': return signed(+d.toFixed(0), a => a.toFixed(0) + 'K')
    case 'num1': return signed(+d.toFixed(1), a => a.toFixed(1))
    case 'usd2': return signed(+d.toFixed(2), a => '$' + a.toFixed(2))
    default: return signed(+d.toFixed(2), a => a.toFixed(2))
  }
}

/** The period a figure is FOR, which is not when it came out. Dates are read in UTC, as they were written. */
export function periodLabel(period, date) {
  if (!date) return ''
  const t = new Date(date + 'T12:00:00Z')
  if (period === 'm') return t.toLocaleDateString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' })
  if (period === 'q') return `Q${Math.floor(t.getUTCMonth() / 3) + 1} ${t.getUTCFullYear()}`
  return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const fmtUsdBig = (n) => n >= 1e12 ? '$' + (n / 1e12).toFixed(2) + 'T' : n >= 1e9 ? '$' + (n / 1e9).toFixed(1) + 'B' : '$' + (n / 1e6).toFixed(0) + 'M'

function words() {
  const T = ctx.T
  return {
    groups: { inflation: T('Inflation', 'Inflación'), jobs: T('Jobs', 'Empleo'), growth: T('Growth', 'Crecimiento'), rates: T('Rates, dollar and oil', 'Tipos, dólar y petróleo'), sentiment: T('Market mood', 'Ánimo del mercado') },
    events: { cpi: T('CPI inflation report', 'Informe de inflación IPC'), jobs: T('Jobs report', 'Informe de empleo'), ppi: T('Producer prices (PPI)', 'Precios al productor (PPI)'), jolts: T('Job openings (JOLTS)', 'Vacantes (JOLTS)'), gdp: T('GDP', 'PIB'), pce: T('PCE inflation', 'Inflación PCE'), fomc: T('Fed rate decision', 'Decisión de tipos de la Fed') },
    items: {
      cpi: [T('CPI inflation', 'Inflación IPC'), T('Yearly', 'Anual'), T('What a basket of everyday goods and services costs against a year ago. The headline inflation number, and the report that tends to move markets most on the day.', 'Lo que cuesta una cesta de bienes y servicios frente a hace un año. Es la cifra principal de inflación y el informe que más suele mover el mercado ese día.'), 'BLS'],
      core: [T('Core CPI', 'IPC subyacente'), T('Yearly, no food or energy', 'Anual, sin alimentos ni energía'), T('CPI without food and energy, which swing on their own. Closer to the underlying trend, so it is usually read beside the headline.', 'IPC sin alimentos ni energía, que oscilan por su cuenta. Se acerca más a la tendencia de fondo, así que suele leerse junto al dato general.'), 'BLS'],
      pce: [T('PCE inflation', 'Inflación PCE'), T('Yearly', 'Anual'), T('A broader measure of prices, and the one the Fed\'s 2% target is written against.', 'Una medida más amplia de precios, y a la que se refiere el objetivo del 2% de la Fed.'), 'BEA'],
      corepce: [T('Core PCE', 'PCE subyacente'), T('Yearly, no food or energy', 'Anual, sin alimentos ni energía'), T('PCE without food and energy. The inflation figure the Fed watches most closely.', 'PCE sin alimentos ni energía. La cifra de inflación que la Fed sigue más de cerca.'), 'BEA'],
      ppi: [T('Producer prices', 'Precios al productor'), T('Yearly', 'Anual'), T('What businesses receive for what they sell. Costs here can reach consumer prices later, though not always.', 'Lo que reciben las empresas por lo que venden. Estos costes pueden llegar después a los precios al consumo, aunque no siempre.'), 'BLS'],
      unrate: [T('Unemployment', 'Desempleo'), T('Rate', 'Tasa'), T('The share of people looking for work who have none. The Fed is charged with keeping employment high as well as prices stable, so this feeds into rates.', 'El porcentaje de quienes buscan trabajo y no lo tienen. La Fed debe mantener un empleo alto además de precios estables, así que esto influye en los tipos.'), 'BLS'],
      payrolls: [T('Jobs added', 'Empleos creados'), T('Non-farm payrolls', 'Nóminas no agrícolas'), T('Jobs added or lost in the month. Later reports often revise these figures, sometimes by a lot.', 'Empleos creados o perdidos en el mes. Los informes posteriores suelen revisar estas cifras, a veces mucho.'), 'BLS'],
      claims: [T('Jobless claims', 'Solicitudes de desempleo'), T('Weekly, new claims', 'Semanal, nuevas'), T('New claims for unemployment benefits. Published every week, so it shows a turn in the jobs market sooner than the monthly report.', 'Nuevas solicitudes de prestación por desempleo. Sale cada semana, así que muestra un giro del empleo antes que el informe mensual.'), T('US Dept. of Labor', 'Dpto. de Trabajo de EE. UU.')],
      gdp: [T('GDP growth', 'Crecimiento del PIB'), T('Quarterly, annualised', 'Trimestral, anualizado'), T('How fast the US economy grew in the quarter, adjusted for inflation and stated as a yearly pace. Each quarter gets revised twice after the first estimate.', 'A qué ritmo creció la economía de EE. UU. en el trimestre, ajustado por inflación y expresado en ritmo anual. Cada trimestre se revisa dos veces tras la primera estimación.'), 'BEA'],
      fed: [T('Fed funds rate', 'Tipo de la Fed'), T('Target range', 'Rango objetivo'), T('The rate the Fed sets. Most other interest rates take their lead from it, and it affects how much money chases risk assets such as crypto.', 'El tipo que fija la Fed. La mayoría de los demás tipos lo toman como referencia, e influye en cuánto dinero busca activos de riesgo como las criptomonedas.'), T('Federal Reserve', 'Reserva Federal')],
      y10: [T('10-year yield', 'Bono a 10 años'), T('US Treasury', 'Tesoro de EE. UU.'), T('What the US government pays to borrow for ten years. A higher yield makes holding something that pays no interest less attractive by comparison.', 'Lo que paga el gobierno de EE. UU. por endeudarse a diez años. Un rendimiento mayor hace menos atractivo, en comparación, mantener algo que no paga intereses.'), T('Federal Reserve', 'Reserva Federal')],
      y2: [T('2-year yield', 'Bono a 2 años'), T('US Treasury', 'Tesoro de EE. UU.'), T('Moves closely with where the market expects the Fed\'s rate to go over the next two years.', 'Se mueve de cerca con lo que el mercado espera del tipo de la Fed en los próximos dos años.'), T('Federal Reserve', 'Reserva Federal')],
      curve: [T('Yield curve', 'Curva de tipos'), T('10-year minus 2-year', '10 años menos 2 años'), T('Negative means two-year debt pays more than ten-year. That inversion has come before many US recessions, often a long time before, and it is not a timer.', 'Negativa significa que la deuda a dos años paga más que la de diez. Esa inversión ha precedido a muchas recesiones en EE. UU., a menudo con mucha antelación, y no sirve de cronómetro.'), T('Federal Reserve', 'Reserva Federal')],
      dollar: [T('US dollar', 'Dólar'), T('Broad index', 'Índice amplio'), T('The dollar against a wide basket of currencies. This is the Fed\'s index, so it reads differently from the better-known DXY.', 'El dólar frente a una cesta amplia de divisas. Es el índice de la Fed, así que no coincide con el conocido DXY.'), T('Federal Reserve', 'Reserva Federal')],
      oil: [T('Oil', 'Petróleo'), T('WTI, per barrel', 'WTI, por barril'), T('A large input to costs and to inflation, particularly headline CPI.', 'Un gran componente de los costes y de la inflación, sobre todo del IPC general.'), 'EIA'],
      vix: [T('VIX', 'VIX'), T('Stock market fear gauge', 'Medidor de miedo en bolsa'), T('How much movement options traders are pricing into the S&P 500 over the next 30 days. High means they expect a rough ride, in either direction.', 'Cuánto movimiento descuentan los operadores de opciones en el S&P 500 para los próximos 30 días. Alto significa que esperan turbulencias, en cualquier dirección.'), 'Cboe'],
      umich: [T('Consumer sentiment', 'Confianza del consumidor'), T('University of Michigan', 'Universidad de Míchigan'), T('A monthly survey of how US households feel about money and the economy. It describes mood and does not always match spending.', 'Encuesta mensual sobre cómo ven las familias de EE. UU. su dinero y la economía. Describe el ánimo y no siempre coincide con el gasto.'), T('Univ. of Michigan', 'Univ. de Míchigan')],
    },
  }
}

export const nextOf = (events, kind, now = Date.now()) => (events ?? []).find(e => e.kind === kind && e.t > now) ?? null

function whenLabel(t, now) {
  const T = ctx.T
  const day = (x) => { const d = new Date(x); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
  const days = Math.round((day(t) - day(now)) / 864e5)
  if (days === 0) return T('Today', 'Hoy')
  if (days === 1) return T('Tomorrow', 'Mañana')
  return T(`In ${days} days`, `En ${days} días`)
}

const CARD = 'border:1px solid var(--border);border-radius:14px;background:var(--panel);padding:11px 12px;margin-top:10px'
const HEAD = 'font-size:12.5px;font-weight:800'
const SMALL = 'font-size:10.5px;color:var(--fg-3);line-height:1.5'

function eventsCard(now) {
  const { T, esc } = ctx
  const w = words()
  // The next of each kind. A plain "next six" pushed December's Fed decision off the list in November.
  const seen = new Set()
  const ev = (_d.events ?? []).filter(e => e.t > now && !seen.has(e.kind) && seen.add(e.kind))
  const stage = (e) => e.stage === 'advance' ? T('first estimate', 'primera estimación') : e.stage === 'second' ? T('second estimate', 'segunda estimación') : e.stage === 'third' ? T('third estimate', 'tercera estimación') : e.projections ? T('with projections', 'con proyecciones') : ''
  const missing = (_d.unknownCal ?? []).length
  const rows = ev.map((e) => {
    const when = new Date(e.t)
    const soon = e.t - now < 2 * 864e5
    const sub = stage(e)
    return `<div data-macro-event="${esc(e.kind)}" style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--border)">
      <div style="flex:1;min-width:0">
        <div style="font-size:12.5px;font-weight:700">${esc(w.events[e.kind] ?? e.kind)}${sub ? `<span style="font-weight:500;color:var(--muted)"> · ${esc(sub)}</span>` : ''}</div>
        <div style="font-size:11px;color:var(--muted);margin-top:1px">${esc(when.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</div>
      </div>
      <div style="flex-shrink:0;font-size:11px;font-weight:700;color:${soon ? 'var(--accent)' : 'var(--fg-2)'}">${esc(whenLabel(e.t, now))}</div>
    </div>`
  }).join('')
  return `<div id="macroEvents" style="${CARD}">
    <div style="${HEAD};margin-bottom:7px">${T('Coming up', 'Próximamente')}</div>
    ${rows || `<div style="font-size:12px;color:var(--fg-3);padding:4px 0">${_d.events ? T('No dates published yet for the coming weeks.', 'Aún no hay fechas publicadas para las próximas semanas.') : T('Release dates are unavailable right now.', 'Las fechas no están disponibles ahora.')}</div>`}
    <div style="${SMALL};margin-top:6px;border-top:1px solid var(--border);padding-top:7px">${T('Your local time. Official dates, and they can change.', 'En tu hora local. Fechas oficiales, que pueden cambiar.')}${missing && _d.events ? ' ' + T('Some calendars could not be read, so this list may be incomplete.', 'Algunos calendarios no se pudieron leer, así que la lista puede estar incompleta.') : ''}</div>
  </div>`
}

const zoneWord = (z) => {
  const T = ctx.T
  return { xfear: T('Extreme fear', 'Miedo extremo'), fear: T('Fear', 'Miedo'), neutral: T('Neutral', 'Neutral'), greed: T('Greed', 'Codicia'), xgreed: T('Extreme greed', 'Codicia extrema') }[z]
}
const dayStr = (d, year = true) => new Date(d * 864e5).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: year ? 'numeric' : undefined, timeZone: 'UTC' })
const chip = (on, label, handler, attr = '') => `<button ${attr} onclick="${handler}" style="flex-shrink:0;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;border:1px solid ${on ? 'var(--accent)' : 'var(--border2)'};background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#000' : 'var(--muted)'}">${label}</button>`

// The chart's geometry, kept for the crosshair. The SVG stretches to the card, so text and dots are HTML
// placed by percent: inside a stretched SVG they would stretch with it.
let _fngPlot = null
const ZONE_FILL = { xfear: ['var(--red)', 0.2], fear: ['var(--red)', 0.08], neutral: ['var(--fg-3)', 0.08], greed: ['var(--green)', 0.08], xgreed: ['var(--green)', 0.2] }

function fngChart(w) {
  const rows = w.rows
  const x0 = rows[0][0], x1 = rows.at(-1)[0], span = Math.max(1, x1 - x0)
  const X = (d) => (d - x0) / span * 100
  const Y = (v) => 100 - v
  _fngPlot = { rows, x0, span }
  const line = rows.map((r, i) => `${i ? 'L' : 'M'}${X(r[0]).toFixed(2)},${Y(r[1])}`).join('')
  const bands = FNG_ZONES.map(([z, lo, hi], i) => {
    const top = i === 4 ? 100 : hi + 0.5, bot = i === 0 ? 0 : lo - 0.5
    return `<rect x="0" width="100" y="${100 - top}" height="${top - bot}" fill="${ZONE_FILL[z][0]}" opacity="${ZONE_FILL[z][1]}"/>`
  }).join('')
  // Neutral is too thin a band to hold a label on a phone.
  const labels = [['xgreed', 88], ['greed', 65], ['fear', 36], ['xfear', 12]].map(([z, v]) =>
    `<span style="position:absolute;left:6px;top:${100 - v}%;transform:translateY(-50%);font-size:9.5px;font-weight:700;color:var(--fg-2);background:var(--panel);padding:0 4px;border-radius:3px;pointer-events:none">${zoneWord(z)}</span>`).join('')
  const ticks = [0, 25, 50, 75, 100].map(v => `<span style="position:absolute;right:0;top:${100 - v}%;transform:translateY(-50%);font-size:9.5px;color:var(--fg-3);font-family:var(--font-mono)">${v}</span>`).join('')
  const xs = [0, 1 / 3, 2 / 3, 1].map((f, i) => {
    const d = x0 + span * f
    const fmt = new Date(d * 864e5).toLocaleDateString(undefined, span > 300 ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { month: 'short', day: 'numeric', timeZone: 'UTC' })
    return `<span style="position:absolute;left:${f * 100}%;transform:translateX(${i === 0 ? '0' : i === 3 ? '-100%' : '-50%'});white-space:nowrap">${fmt}</span>`
  }).join('')
  const last = rows.at(-1)
  return `<div id="macroFngRead" style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:11.5px;min-height:17px;margin-top:10px">${fngRead(last)}</div>
    <div style="position:relative;margin:5px 24px 0 0">
      <div id="macroFngPlot" style="position:relative;height:210px;touch-action:pan-y;cursor:crosshair"
        onpointerdown="window.__macroFngScrub(event)" onpointermove="window.__macroFngScrub(event)" onpointerleave="window.__macroFngScrub(null)" onpointercancel="window.__macroFngScrub(null)">
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" style="position:absolute;inset:0;width:100%;height:100%;display:block;border-radius:6px" aria-label="${ctx.T('Crypto Fear and Greed Index over time', 'Índice Crypto Fear and Greed en el tiempo')}" role="img">
          ${bands}
          <path d="${line}" fill="none" stroke="var(--fg)" stroke-width="${rows.length > 800 ? 1 : 1.75}" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
        </svg>
        ${labels}
        <div id="macroFngCross" style="position:absolute;top:0;bottom:0;width:1px;background:var(--fg-3);opacity:0;pointer-events:none"></div>
        <div id="macroFngDot" style="position:absolute;width:9px;height:9px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 2px var(--panel);transform:translate(-50%,-50%);pointer-events:none;left:${X(last[0])}%;top:${Y(last[1])}%"></div>
        <div style="position:absolute;top:0;bottom:0;right:-24px;width:20px">${ticks}</div>
      </div>
      <div style="position:relative;height:15px;margin-top:4px;font-size:9.5px;color:var(--fg-3)">${xs}</div>
    </div>`
}
function fngRead(r) {
  return `<span><b style="font-family:var(--font-mono);font-size:13px">${r[1]}</b> <span style="color:var(--fg-2)">${zoneWord(fngZone(r[1]))}</span></span><span style="color:var(--muted)">${dayStr(r[0])}</span>`
}
export function macroFngScrub(ev) {
  const p = _fngPlot, read = document.getElementById('macroFngRead'), cross = document.getElementById('macroFngCross'), dot = document.getElementById('macroFngDot'), plot = document.getElementById('macroFngPlot')
  if (!p || !read || !cross || !dot || !plot) return
  const place = (r) => {
    const x = (r[0] - p.x0) / p.span * 100
    dot.style.left = x + '%'; dot.style.top = (100 - r[1]) + '%'
    read.innerHTML = fngRead(r)
    return x
  }
  if (!ev) { cross.style.opacity = '0'; place(p.rows.at(-1)); return }
  const box = plot.getBoundingClientRect()
  if (!box.width) return
  const want = p.x0 + Math.min(1, Math.max(0, (ev.clientX - box.left) / box.width)) * p.span
  let lo = 0, hi = p.rows.length - 1                    // nearest day; the full history is 3,000 points
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (p.rows[m][0] < want) lo = m; else hi = m }
  const r = want - p.rows[lo][0] < p.rows[hi][0] - want ? p.rows[lo] : p.rows[hi]
  cross.style.left = place(r) + '%'; cross.style.opacity = '.7'
}

function sentimentCard() {
  const { T, esc } = ctx
  const f = _d.fng
  if (!f?.days?.length) {
    return `<div id="macroMood" style="${CARD}"><div style="${HEAD}">${T('Crypto sentiment', 'Sentimiento cripto')}</div>
      <div style="font-size:12px;color:var(--fg-3);padding:6px 0">${T('The Fear &amp; Greed Index is unavailable right now.', 'El índice Fear &amp; Greed no está disponible ahora.')}</div></div>`
  }
  const ago = (label, v) => `<div style="flex:1;min-width:0"><div style="font-size:10px;color:var(--muted)">${label}</div><div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${v ?? '—'}</div></div>`
  const n = FNG_RANGES.find(x => x[0] === _fngRange)?.[1] ?? null
  const w = fngWindow(f.days, n)
  const name = { '30d': T('30 days', '30 días'), '90d': T('90 days', '90 días'), '1y': T('1 year', '1 año'), '3y': T('3 years', '3 años'), all: T('All', 'Todo') }
  const stat = (label, v, sub = '') => `<div style="min-width:0"><div style="font-size:10px;color:var(--muted)">${label}</div><div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${v}</div>${sub ? `<div style="font-size:10px;color:var(--fg-3);white-space:nowrap">${sub}</div>` : ''}</div>`
  const sideWord = { fear: T('fear', 'miedo'), greed: T('greed', 'codicia'), neutral: T('neutral', 'neutral') }[w.side]
  return `<div id="macroMood" style="${CARD}">
    <div style="${HEAD}">${T('Crypto sentiment', 'Sentimiento cripto')}</div>
    <div style="display:flex;align-items:baseline;gap:9px;margin-top:6px;flex-wrap:wrap">
      <span id="macroFng" style="font-size:30px;font-weight:800;font-family:var(--font-mono)">${f.value}</span>
      <span style="font-size:13px;font-weight:700">${esc(zoneWord(fngZone(f.value)))}</span>
      <span id="macroFngStreak" style="font-size:11px;color:var(--muted)">${w.side === 'neutral' ? T(`Neutral for ${w.streak} day${w.streak === 1 ? '' : 's'}`, `Neutral desde hace ${w.streak} día${w.streak === 1 ? '' : 's'}`) : T(`${w.streak} day${w.streak === 1 ? '' : 's'} in ${sideWord}`, `${w.streak} día${w.streak === 1 ? '' : 's'} en ${sideWord}`)}</span>
    </div>
    <div style="display:flex;gap:8px;margin-top:9px">${ago(T('Yesterday', 'Ayer'), f.d1)}${ago(T('Week ago', 'Hace 7 días'), f.d7)}${ago(T('Month ago', 'Hace 30 días'), f.d30)}</div>
    <div data-dragscroll style="display:flex;gap:5px;margin-top:11px;overflow-x:auto">${FNG_RANGES.map(([k]) => chip(k === _fngRange, name[k], `window.__macroFngRange('${k}')`, `data-fng-range="${k}"`)).join('')}</div>
    ${fngChart(w)}
    <div id="macroFngStats" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:9px 10px;margin-top:9px;padding-top:9px;border-top:1px solid var(--border)">
      ${stat(T('Average', 'Media'), w.avg.toFixed(0), esc(zoneWord(fngZone(Math.round(w.avg)))))}
      ${stat(T('High', 'Máximo'), w.hi[1], esc(dayStr(w.hi[0])))}
      ${stat(T('Low', 'Mínimo'), w.lo[1], esc(dayStr(w.lo[0])))}
      ${stat(T('Days in fear', 'Días con miedo'), w.fearPct.toFixed(0) + '%')}
      ${stat(T('Days in greed', 'Días con codicia'), w.greedPct.toFixed(0) + '%')}
    </div>
    <div style="${SMALL};margin-top:9px">${T('The Crypto Fear &amp; Greed Index blends volatility, momentum, volume, social media and Bitcoin dominance, once a day. It describes mood and does not predict where price goes. Source: Alternative.me.', 'El índice Crypto Fear &amp; Greed combina volatilidad, impulso, volumen, redes sociales y dominancia de Bitcoin, una vez al día. Describe el ánimo y no predice el precio. Fuente: Alternative.me.')}</div>
  </div>`
}

// ── Market cap and dominance charts ──
// History for these is paid-only on CoinGecko, and TradingView publishes both for embedding. An iframe
// reloads whenever it is rebuilt or moved, so these cards are built once (macroShell) and macroFill only
// ever rewrites the text around them. They mount on first scroll into view: each is a full chart app.
const TV_CHARTS = {
  cap: {
    total: { sym: 'CRYPTOCAP:TOTAL', l: () => ctx.T('Total', 'Total'), note: () => ctx.T('Every coin added together.', 'Todas las monedas sumadas.') },
    alts: { sym: 'CRYPTOCAP:TOTAL2', l: () => ctx.T('Without BTC', 'Sin BTC'), note: () => ctx.T('Everything except Bitcoin, stablecoins included.', 'Todo excepto Bitcoin, incluidas las stablecoins.') },
    alts3: { sym: 'CRYPTOCAP:TOTAL3', l: () => ctx.T('Without BTC and ETH', 'Sin BTC ni ETH'), note: () => ctx.T('Everything except Bitcoin and Ethereum, stablecoins included.', 'Todo excepto Bitcoin y Ethereum, incluidas las stablecoins.') },
  },
  dom: {
    btcd: { sym: 'CRYPTOCAP:BTC.D', l: () => ctx.T('BTC dominance', 'Dominancia BTC'), note: () => ctx.T('Bitcoin\'s share of the whole market. Rising means money is favouring Bitcoin over the rest.', 'La parte de Bitcoin en todo el mercado. Si sube, el dinero favorece a Bitcoin sobre el resto.') },
    alts: { sym: '100-CRYPTOCAP:BTC.D', l: () => ctx.T('Alts share', 'Parte de alts'), note: () => ctx.T('Everything that is not Bitcoin, as a share of the market. Stablecoins count here, so this can rise simply because people moved into cash.', 'Todo lo que no es Bitcoin, como parte del mercado. Las stablecoins cuentan aquí, así que puede subir solo porque la gente pasó a efectivo.') },
    vs: { sym: 'CRYPTOCAP:BTC', cmp: 'CRYPTOCAP:TOTAL2', l: () => ctx.T('BTC vs alts', 'BTC vs alts'), note: () => ctx.T('Growth in market cap from the same starting point, so the two can be compared on one scale. BTC against everything else.', 'Crecimiento de la capitalización desde un mismo punto, para compararlos en una sola escala. BTC frente a todo lo demás.') },
    eth: { sym: 'CRYPTOCAP:ETH.D', l: () => ctx.T('ETH dominance', 'Dominancia ETH'), note: () => ctx.T('Ethereum\'s share of the whole market.', 'La parte de Ethereum en todo el mercado.') },
  },
}
const fmtSigned = (n) => `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`

function tvHead(card) {
  const { T } = ctx
  const g = _d?.global
  const opts = TV_CHARTS[card]
  const chips = `<div data-dragscroll style="display:flex;gap:5px;margin-top:9px;overflow-x:auto">${Object.entries(opts).map(([k, o]) => chip(k === _tvSel[card], o.l(), `window.__macroTvSel('${card}','${k}')`, `data-tv-sel="${k}"`)).join('')}</div>`
  if (card === 'cap') {
    return `<div style="${HEAD}">${T('Crypto market cap', 'Capitalización cripto')}</div>
      ${g ? `<div id="macroGlobal" style="display:flex;align-items:baseline;gap:9px;margin-top:6px;flex-wrap:wrap">
        <span style="font-size:24px;font-weight:800;font-family:var(--font-mono)">${fmtUsdBig(g.cap)}</span>
        ${g.chg24 == null ? '' : `<span style="font-size:12px;font-weight:700;color:var(--fg-2)">${fmtSigned(g.chg24)} 24h</span>`}
        ${g.vol == null ? '' : `<span style="font-size:11px;color:var(--muted)">${fmtUsdBig(g.vol)} ${T('traded in 24h', 'negociado en 24h')}</span>`}
      </div>` : `<div style="font-size:12px;color:var(--fg-3);margin-top:5px">${T('Today\'s figure is unavailable right now.', 'La cifra de hoy no está disponible ahora.')}</div>`}${chips}`
  }
  const rest = g ? 100 - g.btc - (g.eth ?? 0) : null
  const seg = (pct, bg) => `<div style="width:${pct}%;background:${bg};border-radius:3px"></div>`
  const key = (bg, label, pct) => `<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap"><i style="width:9px;height:9px;border-radius:2px;background:${bg};display:inline-block"></i><span style="color:var(--muted)">${label}</span> <b style="font-family:var(--font-mono)">${pct.toFixed(1)}%</b></span>`
  return `<div style="${HEAD}">${T('Bitcoin vs alts', 'Bitcoin vs alts')}</div>
    ${g ? `<div id="macroShare" style="margin-top:8px">
      <div role="img" aria-label="${T('Share of the crypto market', 'Parte del mercado cripto')}" style="display:flex;gap:2px;height:12px">${seg(g.btc, 'var(--accent)')}${g.eth != null ? seg(g.eth, 'var(--fg-2)') : ''}${seg(rest, 'var(--fg-3)')}</div>
      <div style="display:flex;flex-wrap:wrap;gap:4px 13px;margin-top:6px;font-size:11.5px">${key('var(--accent)', 'BTC', g.btc)}${g.eth != null ? key('var(--fg-2)', 'ETH', g.eth) : ''}${key('var(--fg-3)', T('Everything else', 'El resto'), rest)}</div>
    </div>` : `<div style="font-size:12px;color:var(--fg-3);margin-top:5px">${T('Today\'s split is unavailable right now.', 'El reparto de hoy no está disponible ahora.')}</div>`}${chips}`
}
function tvFoot(card) {
  const { T, esc } = ctx
  const note = esc(TV_CHARTS[card][_tvSel[card]].note())
  const src = card === 'cap'
    ? T('Today\'s figures: CoinGecko. Chart: TradingView, which counts a different set of coins, so its total will not match exactly.', 'Cifras de hoy: CoinGecko. Gráfico: TradingView, que cuenta otro conjunto de monedas, así que su total no coincidirá exactamente.')
    : T('Today\'s split: CoinGecko. Chart: TradingView, which counts a different set of coins, so its dominance usually differs by about a point.', 'Reparto de hoy: CoinGecko. Gráfico: TradingView, que cuenta otro conjunto de monedas, así que su dominancia suele diferir cerca de un punto.')
  return `<div style="font-size:11.5px;line-height:1.5;color:var(--fg-2);margin-top:8px">${note}</div><div style="${SMALL};margin-top:4px">${src}</div>`
}
function tvCard(card) {
  return `<div id="macroCard_${card}" style="${CARD}"><div data-tv-head></div><div data-tv-mount style="height:330px;margin-top:9px;border-radius:10px;overflow:hidden;background:var(--panel-2)"></div><div data-tv-foot></div></div>`
}
const _tvSeen = new WeakSet()
let _tvObs = null
function tvMount(root, card) {
  const box = root.querySelector(`#macroCard_${card} [data-tv-mount]`)
  if (!box) return
  if (typeof IntersectionObserver === 'function' && !_tvSeen.has(box)) {
    _tvObs ??= new IntersectionObserver((es) => {
      for (const e of es) if (e.isIntersecting) { _tvSeen.add(e.target); _tvObs.unobserve(e.target); if (ctx.visible()) ctx.repaint() }
    }, { rootMargin: '250px' })
    _tvObs.observe(box)
    return
  }
  const o = TV_CHARTS[card][_tvSel[card]]
  const sig = `${o.sym}|${ctx.tvTheme()}`
  if (box.dataset.sig === sig) return       // the same chart: leave the iframe alone
  box.dataset.sig = sig
  box.dataset.symbol = o.sym
  ctx.tv(box, TV_URL, {
    symbol: o.sym, interval: 'D', timezone: 'Etc/UTC', theme: ctx.tvTheme(), style: '2', locale: 'en', autosize: true,
    range: '12M', withdateranges: true, allow_symbol_change: false, hide_side_toolbar: true, hide_top_toolbar: true,
    hide_volume: true, details: false, save_image: false,
    // The embed ignores compare_symbols; as a study it works, and it puts both on a percent scale.
    studies: o.cmp ? [{ id: 'Compare@tv-basicstudies', inputs: { symbol: o.cmp } }] : [],
    support_host: 'https://www.tradingview.com',
  })
}

function rowHtml(it, now) {
  const { T, esc } = ctx
  const w = words().items[it.key]
  if (!w) return ''
  const xp = _open.has(it.key)
  const unknown = it.value == null
  const next = it.next ? nextOf(_d.events, it.next, now) : null
  const nextTxt = next ? new Date(next.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
  const value = it.key === 'fed' && it.low != null ? `${it.low.toFixed(2)}–${it.value.toFixed(2)}%` : fmtMacro(it.fmt, it.value)
  const period = periodLabel(it.period, it.date)
  const sub = unknown ? T('Unavailable right now', 'No disponible ahora')
    : it.key === 'fed' ? `${esc(w[1])} · ${T('since', 'desde')} ${esc(periodLabel('m', it.date))}` : `${esc(w[1])} · ${esc(period)}`
  const delta = !unknown && it.prev != null ? fmtDelta(it.fmt, it.value - it.prev) : ''
  const prevLabel = delta ? periodLabel(it.period, it.prevDate) : ''
  const fmtPt = it.key === 'fed' ? (v) => v.toFixed(2) + '%' : (v) => fmtMacro(it.fmt, v)
  return `<div data-macro-row="${esc(it.key)}">
    <div class="mob-v-row" style="cursor:pointer" onclick="window.__macroToggle('${esc(it.key)}')">
      <div class="mob-v-row-info">
        <div class="mob-v-row-name">${esc(w[0])}</div>
        <div class="mob-v-row-sub">${sub}</div>
      </div>
      <div class="mob-v-row-right">
        <div class="mob-v-row-val" style="font-family:var(--font-mono);white-space:nowrap">${esc(value)}</div>
        ${delta ? `<div style="font-size:10.5px;color:var(--muted);white-space:nowrap;margin-top:1px">${esc(delta)} ${it.key === 'fed' ? T('last move', 'último cambio') : `${T('vs', 'vs')} ${esc(prevLabel)}`}</div>` : ''}
      </div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;margin-left:6px;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>
    </div>
    ${xp ? `<div data-macro-detail style="padding:2px 12px 12px">
      <div style="font-size:12px;line-height:1.55;color:var(--fg-2)">${esc(w[2])}</div>
      ${it.mom != null ? `<div style="font-size:12px;margin-top:7px"><span style="color:var(--muted)">${T('On the month before', 'Frente al mes anterior')}</span> <b style="font-family:var(--font-mono)">${it.mom >= 0 ? '+' : '−'}${Math.abs(it.mom).toFixed(1)}%</b></div>` : ''}
      ${next ? `<div style="font-size:12px;margin-top:4px"><span style="color:var(--muted)">${T('Next report', 'Próximo informe')}</span> <b>${esc(new Date(next.t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }))}</b> <span style="color:var(--muted)">· ${esc(nextTxt && whenLabel(next.t, now))}</span></div>` : ''}
      ${it.pts?.length ? ctx.chart(it.pts, { key: 'macro_' + it.key, fmt: fmtPt, color: 'var(--accent)' }) : ''}
      <div style="${SMALL};margin-top:6px">${T('Source', 'Fuente')}: ${esc(w[3])}${it.key === 'cpi' || it.key === 'core' ? ' · ' + T('October 2025 was never published because of the US government shutdown, so the chart skips the months that depend on it.', 'Octubre de 2025 nunca se publicó por el cierre del gobierno de EE. UU., así que el gráfico omite los meses que dependen de él.') : ''}</div>
    </div>` : ''}
  </div>`
}

/** The frame, built once per visit. Everything but the two chart mounts is filled in by macroFill. */
export function macroShell() {
  const { T } = ctx
  return `<div id="macroRoot" style="padding:10px 12px 26px">
    <div style="font-size:11.5px;color:var(--muted);line-height:1.45">${T('The bigger picture behind every market: US economic reports, interest rates and sentiment. Tap a row for what it means and its history.', 'El contexto detrás de cada mercado: informes económicos de EE. UU., tipos de interés y sentimiento. Toca una fila para ver qué significa y su historial.')}</div>
    <div id="macroA"></div>
    <div id="macroCharts" style="display:none">${tvCard('cap')}${tvCard('dom')}</div>
    <div id="macroB"></div>
  </div>`
}

export function macroFill(root, now = Date.now()) {
  ensureMacro(now)
  const { T } = ctx
  const A = root.querySelector('#macroA'), B = root.querySelector('#macroB'), charts = root.querySelector('#macroCharts')
  if (!A || !B || !charts) return
  if (!_d) {
    A.innerHTML = `<div class="mob-v-empty" id="macroLoading">${_failed
      ? T('Macro data is unavailable right now. Trying again shortly.', 'Los datos macro no están disponibles ahora. Reintentando en breve.')
      : T('Loading macro data…', 'Cargando datos macro…')}</div>`
    B.innerHTML = ''
    return
  }
  const w = words()
  const group = (g) => {
    const rows = _d.items.filter(i => i.group === g)
    if (!rows.length) return ''
    return `<div data-macro-group="${g}" style="${CARD};padding:11px 0 3px">
      <div style="${HEAD};padding:0 12px 5px">${w.groups[g]}</div>
      ${rows.map(i => rowHtml(i, now)).join('')}
    </div>`
  }
  A.innerHTML = eventsCard(now) + sentimentCard()
  B.innerHTML = `${group('sentiment')}${group('inflation')}${group('jobs')}${group('growth')}${group('rates')}
    <div style="${SMALL};margin-top:12px">${T('Economic data is for the US, via the St. Louis Fed (FRED). Each row shows the period it covers, because reports arrive weeks after the period ends. Forecasts are not included, so this does not show whether a report beat expectations. This is context and not trading advice.', 'Los datos económicos son de EE. UU., a través de la Fed de St. Louis (FRED). Cada fila indica el período que cubre, porque los informes llegan semanas después. No incluye previsiones, así que no muestra si un informe superó las expectativas. Es contexto, no asesoramiento de inversión.')}</div>`
  charts.style.display = ''
  for (const card of ['cap', 'dom']) {
    const el = charts.querySelector(`#macroCard_${card}`)
    el.querySelector('[data-tv-head]').innerHTML = tvHead(card)
    el.querySelector('[data-tv-foot]').innerHTML = tvFoot(card)
    tvMount(root, card)
  }
}

/** For tests. */
export function _macroReset() { _d = null; _at = 0; _busy = false; _failed = false; if (_retry) clearTimeout(_retry); _retry = null; _open.clear() }
