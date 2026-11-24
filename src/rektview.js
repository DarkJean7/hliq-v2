/**
 * Rekt-01's part of its Agent Arena card (src/agentsview.js): what it has learned, and its
 * settings — a form in dev mode ("its settings should be only changeable by users with dev mode
 * on"), a read-only list otherwise. The server checks the dev PIN again on save (/agents-config);
 * hiding the form is only the courtesy, the PIN is the lock.
 */
import { SIGNALS, SIGNAL_NAME, STYLES, HORIZONS } from './rekt.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
// The same colours as the arena agent each signal comes from (src/agents.js), so a reader can match them.
export const SIGNAL_COLOR = { oracle: '#4da3ff', momentum: '#a78bfa', reversion: '#22d3ee', funding: '#f472b6' }
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%'
const sgn = (x, d = 2) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d)

export const isDevMode = () => { try { return localStorage.getItem('hliq_dev') === '1' && !!localStorage.getItem('hliq_lb_pin') } catch { return false } }
export const devPin = () => { try { return localStorage.getItem('hliq_lb_pin') || '' } catch { return '' } }

function weightsChart(hist, T, width) {
  if ((hist?.length ?? 0) < 2) return ''
  const W = Math.max(240, Math.round(width)), H = 110, L = 34, R = 8, Tp = 6, B = 16
  const t0 = hist[0][0], t1 = hist.at(-1)[0]
  const hi = Math.max(0.3, ...hist.flatMap(([, w]) => SIGNALS.map(k => w[k] ?? 0))) * 1.08
  const x = (t) => L + (t1 > t0 ? (t - t0) / (t1 - t0) : 1) * (W - L - R)
  const y = (v) => Tp + (1 - v / hi) * (H - Tp - B)
  const grid = [0, 0.25, 0.5, 0.75].filter(v => v <= hi).map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="ag-grid"/><text x="${L - 5}" y="${(y(v) + 3.5).toFixed(1)}" class="ag-ax" text-anchor="end">${v * 100}%</text>`).join('')
  const lines = SIGNALS.map(k => `<path d="${hist.map(([t, w], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(w[k] ?? 0).toFixed(1)}`).join('')}" fill="none" stroke="${SIGNAL_COLOR[k]}" stroke-width="2" stroke-linejoin="round"/>`).join('')
  return `<svg class="rk-wchart" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(T('How much it trusts each signal, over time', 'Cuánto confía en cada señal, en el tiempo'))}">${grid}${lines}</svg>`
}

function armTable(rows, unit, T) {
  const tried = rows.filter(r => r.n)
  const best = tried.length ? tried.reduce((a, b) => (b.avg > a.avg ? b : a)) : null
  return `<div class="ag-tbl-wrap" data-dragscroll><table class="ag-tbl rk-arms"><thead><tr><th></th>${rows.map(r => `<th class="${r === best ? 'rk-best' : ''}">${r.v}${unit}</th>`).join('')}</tr></thead><tbody>
    <tr><td>${T('Trades', 'Operaciones')}</td>${rows.map(r => `<td>${r.n}</td>`).join('')}</tr>
    <tr><td>${T('Avg result', 'Resultado medio')}</td>${rows.map(r => `<td class="${r.avg > 0 ? 'pos' : r.avg < 0 ? 'neg' : ''}">${r.avg == null ? '—' : sgn(r.avg) + '%'}</td>`).join('')}</tr>
  </tbody></table></div>`
}

const STYLE_NAME = { cautious: ['Cautious', 'Prudente'], balanced: ['Balanced', 'Equilibrado'], aggressive: ['Aggressive', 'Agresivo'] }
const HORIZON_NAME = { hours: ['Hours', 'Horas'], days: ['Days', 'Días'], weeks: ['Weeks', 'Semanas'] }
const MODE_NAME = { all: ['Every market', 'Todos los mercados'], allow: ['Only these', 'Solo estos'], block: ['All except these', 'Todos menos estos'] }

function settingsHtml(cfg, { T, dev, draft, status }) {
  const c = draft ?? cfg
  if (!dev) {
    const row = (k, v) => `<div><small>${k}</small>${v}</div>`
    return `<div class="rk-set ro">
      ${row(T('Max leverage', 'Apalancamiento máx.'), c.maxLev + '×')}
      ${row(T('Max positions', 'Posiciones máx.'), c.maxPositions)}
      ${row(T('Max loss per trade', 'Pérdida máx. por operación'), c.maxLossPct + '% ' + T('of equity', 'del capital'))}
      ${row(T('Pause if down', 'Pausa si cae'), c.pauseDDPct + '% ' + T('from its peak', 'desde su máximo'))}
      ${row(T('Markets', 'Mercados'), esc(T(...MODE_NAME[c.markets.mode])) + (c.markets.mode !== 'all' && c.markets.list.length ? ': ' + esc(c.markets.list.join(', ')) : ''))}
      ${row(T('Style', 'Estilo'), esc(T(...STYLE_NAME[c.style])) + ' · ' + esc(T(...HORIZON_NAME[c.horizon])))}
      ${row(T('In the arena', 'En la arena'), c.arena ? T('Yes', 'Sí') : T('No', 'No'))}
      ${row(T('Status', 'Estado'), c.paused ? T('Paused', 'En pausa') : T('Running', 'Activo'))}
    </div><p class="ag-none">${T('Settings can be changed in dev mode.', 'Los ajustes se cambian en modo dev.')}</p>`
  }
  const opt = (map, v) => Object.keys(map).map(k => `<option value="${k}"${k === v ? ' selected' : ''}>${esc(T(...map[k]))}</option>`).join('')
  const n = (name, v, min, max, step, label, hint) => `<label><span>${label}</span><input type="number" name="${name}" value="${v}" min="${min}" max="${max}" step="${step}" inputmode="decimal"><em>${hint}</em></label>`
  return `<form class="rk-form" data-rk-form onsubmit="return false">
    <fieldset><legend>${T('Risk limits', 'Límites de riesgo')}</legend>
      ${n('maxLev', c.maxLev, 1, 10, 1, T('Max leverage', 'Apalancamiento máx.'), '1–10×')}
      ${n('maxPositions', c.maxPositions, 1, 8, 1, T('Max positions', 'Posiciones máx.'), '1–8')}
      ${n('maxLossPct', c.maxLossPct, 0.25, 10, 0.25, T('Max loss per trade', 'Pérdida máx. por operación'), T('% of equity, at its stop', '% del capital, en su stop'))}
      ${n('pauseDDPct', c.pauseDDPct, 5, 90, 1, T('Pause if down', 'Pausa si cae'), T('% from its peak: no new trades', '% desde su máximo: sin nuevas operaciones'))}
    </fieldset>
    <fieldset><legend>${T('Markets it may trade', 'Mercados que puede operar')}</legend>
      <label><span>${T('Which', 'Cuáles')}</span><select name="mode">${opt(MODE_NAME, c.markets.mode)}</select></label>
      <label class="rk-wide"><span>${T('Coins', 'Monedas')}</span><input type="text" name="list" value="${esc(c.markets.list.join(', '))}" placeholder="BTC, ETH, SOL, HYPE" autocapitalize="characters" spellcheck="false"></label>
    </fieldset>
    <fieldset><legend>${T('Style / goal', 'Estilo / objetivo')}</legend>
      <label><span>${T('Temperament', 'Temperamento')}</span><select name="style">${opt(STYLE_NAME, c.style)}</select></label>
      <label><span>${T('Horizon', 'Horizonte')}</span><select name="horizon">${opt(HORIZON_NAME, c.horizon)}</select></label>
    </fieldset>
    <fieldset><legend>${T('Arena', 'Arena')}</legend>
      <label class="rk-check"><input type="checkbox" name="arena"${c.arena ? ' checked' : ''}> ${T('Show it on the Agent Arena board', 'Mostrarlo en la Arena de agentes')}</label>
      <label class="rk-check"><input type="checkbox" name="paused"${c.paused ? ' checked' : ''}> ${T('Paused (keeps managing what it holds, opens nothing new)', 'En pausa (gestiona lo que tiene, no abre nada nuevo)')}</label>
    </fieldset>
    <div class="rk-actions"><button type="button" class="rk-save" data-rk-save>${T('Save settings', 'Guardar ajustes')}</button><span class="rk-status">${esc(status ?? '')}</span></div>
  </form>`
}

/** The form's values, as /agents-config takes them (the server cleans them again). */
export function readForm(form) {
  const f = (n) => form.elements[n]
  return {
    maxLev: +f('maxLev').value, maxPositions: +f('maxPositions').value, maxLossPct: +f('maxLossPct').value, pauseDDPct: +f('pauseDDPct').value,
    markets: { mode: f('mode').value, list: f('list').value.split(/[\s,]+/).filter(Boolean) },
    style: f('style').value, horizon: f('horizon').value, arena: f('arena').checked, paused: f('paused').checked,
  }
}

export function rektHtml(a, { T, dev, draft, status, width = 600 }) {
  const L = a.learn, cfg = a.config
  if (!L || !cfg) return ''
  const w = L.weights ?? {}
  const bars = [...SIGNALS].sort((p, q) => (w[q] ?? 0) - (w[p] ?? 0)).map(k => {
    const st = L.stats?.[k] ?? {}
    return `<div class="rk-w"><span class="rk-wn"><i style="background:${SIGNAL_COLOR[k]}"></i>${esc(T(...SIGNAL_NAME[k]))}</span>
      <span class="rk-bar"><b style="width:${Math.round((w[k] ?? 0) * 100)}%;background:${SIGNAL_COLOR[k]}"></b></span>
      <span class="rk-wv">${pct(w[k] ?? 0)}</span>
      <span class="rk-ws">${st.n ? T(`right ${pct(st.hit ?? 0)} · ${st.n.toLocaleString()} checks`, `acierta ${pct(st.hit ?? 0)} · ${st.n.toLocaleString()} pruebas`) : T('no checks yet', 'sin pruebas aún')}</span></div>`
  }).join('')
  const paused = L.pausedBy ? T(`Paused by itself: down ${L.pausedBy.dd.toFixed(1)}% from its peak (resumes when back within ${(cfg.pauseDDPct / 2).toFixed(0)}%).`, `En pausa por sí mismo: cae ${L.pausedBy.dd.toFixed(1)}% desde su máximo (vuelve cuando esté a menos de ${(cfg.pauseDDPct / 2).toFixed(0)}%).`)
    : cfg.paused ? T('Paused in its settings: managing what it holds, opening nothing new.', 'En pausa en sus ajustes: gestiona lo que tiene, no abre nada nuevo.') : ''
  const checks = SIGNALS.reduce((s, k) => s + (L.stats?.[k]?.n ?? 0), 0)
  return `<div class="rk">
    ${paused ? `<p class="rk-paused">⏸ ${esc(paused)}</p>` : ''}
    <h4>${T('What it has learned', 'Lo que ha aprendido')}</h4>
    <p class="ag-when">${T(`Learning since ${new Date(L.since).toLocaleDateString()} · ${checks.toLocaleString()} signal checks scored · ${L.pending.toLocaleString()} waiting for their ${HORIZONS[cfg.horizon].evalH}h result · ${L.trades} of its own trades`, `Aprendiendo desde ${new Date(L.since).toLocaleDateString()} · ${checks.toLocaleString()} pruebas puntuadas · ${L.pending.toLocaleString()} esperando su resultado de ${HORIZONS[cfg.horizon].evalH} h · ${L.trades} operaciones propias`)}</p>
    <div class="rk-ws-list">${bars}</div>
    ${weightsChart(L.hist, T, width)}
    <h4>${T('Its stop distance', 'Su distancia de stop')}</h4>
    ${armTable(L.stops ?? [], '%', T)}
    <h4>${T('How long it holds', 'Cuánto mantiene')}</h4>
    ${armTable(L.holds ?? [], 'h', T)}
    <p class="ag-none">${T('It mostly picks the best so far and sometimes tries another, so it keeps learning.', 'Elige casi siempre lo mejor hasta ahora y a veces prueba otra opción, para seguir aprendiendo.')}</p>
    <h4>${T('Settings', 'Ajustes')}${dev ? ` <span class="rk-dev">dev</span>` : ''}</h4>
    ${settingsHtml(cfg, { T, dev, draft, status })}
  </div>`
}

export { STYLES }
