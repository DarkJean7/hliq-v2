// The Macro view inside Signals. The numbers come from /macro-data (src/macro.js), served from our own
// box, so opening this spends nothing from the Hyperliquid budget.
//
// Rises and falls are not coloured green and red here. A jump in unemployment can send markets up if it
// brings rate cuts closer, and hot inflation can do the reverse. The view says what the number did, and
// what it means for a trader is the reader's call.

const REFRESH = 10 * 60e3
const RETRY = 30e3
let _d = null, _at = 0, _busy = false, _failed = false, _retry = null
const _open = new Set()

let ctx = {
  T: (en) => en, esc: (s) => String(s),
  chart: () => '',              // main.js's interactive chart
  visible: () => false,         // is this view on screen
  repaint: () => {},
}
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

function sentimentCard() {
  const { T, esc } = ctx
  const f = _d.fng, g = _d.global
  const LABELS = { 'Extreme Fear': T('Extreme fear', 'Miedo extremo'), Fear: T('Fear', 'Miedo'), Neutral: T('Neutral', 'Neutral'), Greed: T('Greed', 'Codicia'), 'Extreme Greed': T('Extreme greed', 'Codicia extrema') }
  const ago = (label, v) => `<div style="flex:1;min-width:0"><div style="font-size:10px;color:var(--muted)">${label}</div><div style="font-size:13px;font-weight:700;font-family:var(--font-mono)">${v ?? '—'}</div></div>`
  const stat = (label, v, sub = '') => `<div style="flex:1;min-width:0"><div style="font-size:10px;color:var(--muted)">${label}</div><div style="font-size:14px;font-weight:800;font-family:var(--font-mono);white-space:nowrap">${v}</div>${sub ? `<div style="font-size:10.5px;color:var(--fg-3)">${sub}</div>` : ''}</div>`
  return `<div id="macroMood" style="${CARD}">
    <div style="${HEAD}">${T('Crypto sentiment', 'Sentimiento cripto')}</div>
    ${f ? `<div style="display:flex;align-items:baseline;gap:9px;margin-top:6px">
        <span id="macroFng" style="font-size:30px;font-weight:800;font-family:var(--font-mono)">${f.value}</span>
        <span style="font-size:13px;font-weight:700">${esc(LABELS[f.label] ?? f.label)}</span>
        <span style="font-size:10.5px;color:var(--muted)">/ 100</span>
      </div>
      <div style="position:relative;height:6px;border-radius:999px;background:var(--panel-3);margin:8px 0 10px" aria-hidden="true">
        <div style="position:absolute;top:-3px;bottom:-3px;width:3px;border-radius:2px;background:var(--accent);left:calc(${f.value}% - 1.5px)"></div>
      </div>
      <div style="display:flex;gap:8px">${ago(T('Yesterday', 'Ayer'), f.d1)}${ago(T('Week ago', 'Hace 7 días'), f.d7)}${ago(T('Month ago', 'Hace 30 días'), f.d30)}</div>
      ${ctx.chart(f.pts, { key: 'macro_fng', fmt: (v) => v.toFixed(0), color: 'var(--accent)' })}
      <div style="${SMALL};margin-top:7px">${T('The Crypto Fear &amp; Greed Index blends volatility, momentum, volume, social media and Bitcoin dominance. It describes mood and does not predict where price goes. Source: Alternative.me.', 'El índice Crypto Fear &amp; Greed combina volatilidad, impulso, volumen, redes sociales y dominancia de Bitcoin. Describe el ánimo y no predice el precio. Fuente: Alternative.me.')}</div>`
    : `<div style="font-size:12px;color:var(--fg-3);padding:6px 0">${T('The Fear &amp; Greed Index is unavailable right now.', 'El índice Fear &amp; Greed no está disponible ahora.')}</div>`}
    ${g ? `<div id="macroGlobal" style="display:flex;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border)">
        ${stat(T('Crypto market cap', 'Capitalización cripto'), fmtUsdBig(g.cap), g.chg24 == null ? '' : `${g.chg24 >= 0 ? '+' : '−'}${Math.abs(g.chg24).toFixed(1)}% 24h`)}
        ${stat(T('BTC dominance', 'Dominancia BTC'), g.btc.toFixed(1) + '%', g.eth == null ? '' : `ETH ${g.eth.toFixed(1)}%`)}
      </div><div style="${SMALL};margin-top:6px">${T('Market cap and dominance: CoinGecko.', 'Capitalización y dominancia: CoinGecko.')}</div>` : ''}
  </div>`
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

export function macroHtml(now = Date.now()) {
  ensureMacro(now)
  const { T } = ctx
  if (!_d) {
    return `<div id="macroRoot" style="padding:10px 12px 26px"><div class="mob-v-empty" id="macroLoading">${_failed
      ? T('Macro data is unavailable right now. Trying again shortly.', 'Los datos macro no están disponibles ahora. Reintentando en breve.')
      : T('Loading macro data…', 'Cargando datos macro…')}</div></div>`
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
  return `<div id="macroRoot" style="padding:10px 12px 26px">
    <div style="font-size:11.5px;color:var(--muted);line-height:1.45">${T('The bigger picture behind every market: US economic reports, interest rates and sentiment. Tap a row for what it means and its history.', 'El contexto detrás de cada mercado: informes económicos de EE. UU., tipos de interés y sentimiento. Toca una fila para ver qué significa y su historial.')}</div>
    ${eventsCard(now)}
    ${sentimentCard()}
    ${group('sentiment')}
    ${group('inflation')}
    ${group('jobs')}
    ${group('growth')}
    ${group('rates')}
    <div style="${SMALL};margin-top:12px">${T('Data shown for the US, via the St. Louis Fed (FRED). Each row shows the period it covers, because reports arrive weeks after the period ends. Forecasts are not included, so this does not show whether a report beat expectations. This is context and not trading advice.', 'Datos de EE. UU., a través de la Fed de St. Louis (FRED). Cada fila indica el período que cubre, porque los informes llegan semanas después. No incluye previsiones, así que no muestra si un informe superó las expectativas. Es contexto, no asesoramiento de inversión.')}</div>
  </div>`
}

/** For tests. */
export function _macroReset() { _d = null; _at = 0; _busy = false; _failed = false; if (_retry) clearTimeout(_retry); _retry = null; _open.clear() }
