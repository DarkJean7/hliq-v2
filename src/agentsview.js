/**
 * The Agent Arena screen: the shared paper agents (src/agents.js) that the server runs
 * (src/agentrunner.js), read from GET /agents-data. More → Agent Arena.
 *
 * Read-only and public: nobody's account is involved, so it works before a wallet is connected.
 * Colours follow the AGENT, never its rank — the board re-sorts by return and a line must keep its
 * colour. HODL BTC is the benchmark: grey, and every other row says how far it is from it.
 */
import './agents.css'
import { valueAt } from './agents.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const usd = (x, d = 2) => (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
const sgnPct = (x, d = 2) => (x > 0 ? '+' : x < 0 ? '−' : '') + Math.abs(x).toFixed(d) + '%'
const sgnUsd = (x) => (x > 0 ? '+' : '') + usd(x)
const pxFmt = (p) => !(p > 0) ? '—' : p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 1 ? p.toFixed(3) : p.toPrecision(4)
const cls = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : '')
const dt = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const dday = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
function ago(ms, T) {
  const m = Math.round(ms / 60e3)
  if (m < 60) return T(`${m} min`, `${m} min`)
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h` : T(`${Math.round(h / 24)} days`, `${Math.round(h / 24)} días`)
}

let data = null, err = null, timer = null, open = new Set(), T = (en) => en

/** Return % series per agent, for the chart: [[t, pct]]. */
function pctCurve(a) { return (a.curve ?? []).map(([t, v]) => [t, (v / a.start - 1) * 100]) }


function chartHtml(agents, width = 640) {
  const W = Math.max(260, Math.round(width)), H = 220, L = 44, R = 12, Tp = 10, B = 22
  const series = agents.map(a => ({ a, c: pctCurve(a) })).filter(s => s.c.length)
  const pts = series.flatMap(s => s.c)
  if (pts.length < 2) return `<div class="ag-chart-empty">${T('The chart fills in as the agents trade — one point an hour.', 'El gráfico se llena a medida que operan — un punto por hora.')}</div>`
  const t0 = Math.min(...pts.map(p => p[0])), t1 = Math.max(...pts.map(p => p[0]))
  let lo = Math.min(0, ...pts.map(p => p[1])), hi = Math.max(0, ...pts.map(p => p[1]))
  const pad = Math.max(0.5, (hi - lo) * 0.08); lo -= pad; hi += pad
  const x = (t) => L + (t1 > t0 ? (t - t0) / (t1 - t0) : 1) * (W - L - R)
  const y = (v) => Tp + (hi - v) / (hi - lo) * (H - Tp - B)
  const step = niceStep((hi - lo) / 4)
  const ticks = []
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(+v.toFixed(6))
  const grid = ticks.map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="${v === 0 ? 'ag-zero' : 'ag-grid'}"/><text x="${L - 6}" y="${(y(v) + 3.5).toFixed(1)}" class="ag-ax" text-anchor="end">${v > 0 ? '+' : ''}${+v.toFixed(2)}%</text>`).join('')
  const xl = `<text x="${L}" y="${H - 6}" class="ag-ax">${esc(dday(t0))}</text><text x="${W - R}" y="${H - 6}" class="ag-ax" text-anchor="end">${esc(dday(t1))}</text>`
  // HODL first so the agents draw over it.
  const order = [...series].sort((p, q) => (q.a.baseline ? 1 : 0) - (p.a.baseline ? 1 : 0))
  const lines = order.map(({ a, c }) => `<path d="${c.map(([t, v], i) => `${i ? 'L' : 'M'}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join('')}" fill="none" stroke="${a.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${a.baseline ? ' stroke-dasharray="5 4"' : ''}/>`).join('')
  const legend = series.map(({ a }) => `<span class="ag-leg"><i style="background:${a.color}"></i>${esc(a.name)}</span>`).join('')
  return `<div class="ag-chart" data-t0="${t0}" data-t1="${t1}" data-l="${L}" data-r="${R}" data-w="${W}">
    <div class="ag-legend">${legend}</div>
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(T('Return since start, per agent', 'Rentabilidad desde el inicio, por agente'))}">${grid}${xl}${lines}<line class="ag-cross" x1="0" x2="0" y1="${Tp}" y2="${H - B}" style="display:none"/></svg>
    <div class="ag-tip" style="display:none"></div>
  </div>`
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6)))
  const n = raw / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

function cardHtml(a, hodl, rank) {
  const vs = hodl && !a.baseline ? a.ret - hodl.ret : null
  const isOpen = open.has(a.id)
  const wr = a.trades ? Math.round(a.wins / a.trades * 100) : null
  const pos = (a.positions ?? []).map(p => {
    const stop = (a.stops ?? []).find(s => s.coin === p.coin)
    return `<tr><td><b>${esc(p.coin)}</b></td><td class="${p.szi > 0 ? 'pos' : 'neg'}">${p.szi > 0 ? T('Long', 'Largo') : T('Short', 'Corto')} ${p.lev ? p.lev + '×' : ''}</td><td>${usd(Math.abs(p.value), 0)}</td><td>${pxFmt(p.entryPx)}</td><td>${pxFmt(p.mark)}</td><td class="${cls(p.upnl)}">${sgnUsd(p.upnl)}</td><td>${stop ? pxFmt(stop.px) : '—'}</td></tr>`
  }).join('')
  const KIND = { open: T('Opened', 'Abrió'), close: T('Closed', 'Cerró'), stop: T('Stopped', 'Stop'), skip: T('Skipped', 'Omitió'), error: T('Error', 'Error') }
  const jr = (a.journal ?? []).map(j => `<tr class="ag-j-${j.kind}"><td>${esc(dt(j.t))}</td><td>${KIND[j.kind] ?? esc(j.kind)}</td><td>${j.coin ? `<b>${esc(j.coin)}</b>` : ''}${j.side ? ` <span class="${j.side === 'long' ? 'pos' : 'neg'}">${j.side === 'long' ? T('long', 'largo') : T('short', 'corto')}</span>` : ''}</td><td>${j.px ? pxFmt(j.px) : ''}</td><td class="${cls(j.pnl)}">${Number.isFinite(j.pnl) ? sgnUsd(j.pnl) : ''}</td><td class="ag-why">${esc(j.why ?? '')}</td></tr>`).join('')
  const now = data?.at ?? Date.now()
  return `<div class="ag-card${isOpen ? ' open' : ''}${a.baseline ? ' base' : ''}" data-ag="${esc(a.id)}">
    <button class="ag-head" data-ag-open="${esc(a.id)}" aria-expanded="${isOpen}">
      <span class="ag-rank">${rank}</span>
      <span class="ag-name"><i style="background:${a.color}"></i>${esc(a.name)}${a.baseline ? `<em>${T('benchmark', 'referencia')}</em>` : ''}</span>
      <span class="ag-ret ${cls(a.ret)}">${sgnPct(a.ret)}</span>
      <span class="ag-chev">${isOpen ? '▴' : '▾'}</span>
    </button>
    <div class="ag-stats">
      <span><small>${T('Equity', 'Capital')}</small>${usd(a.equity)}</span>
      <span><small>${T('vs HODL BTC', 'vs HODL BTC')}</small>${vs == null ? '—' : `<b class="${cls(vs)}">${sgnPct(vs)}</b>`}</span>
      <span><small>${T('Max drawdown', 'Caída máx.')}</small>${a.maxDD > 0 ? '−' + a.maxDD.toFixed(1) + '%' : '0%'}</span>
      <span><small>${T('Trades', 'Operaciones')}</small>${a.trades}${wr != null ? ` · ${wr}% ${T('won', 'ganadas')}` : ''}</span>
      <span><small>${T('Open', 'Abiertas')}</small>${(a.positions ?? []).length}/${a.max}</span>
    </div>
    ${isOpen ? `<div class="ag-body">
      <p class="ag-blurb">${esc(T(a.blurb?.[0] ?? '', a.blurb?.[1] ?? a.blurb?.[0] ?? ''))}</p>
      <p class="ag-when">${a.last ? T(`Last look ${ago(now - a.last, T)} ago`, `Última revisión hace ${ago(now - a.last, T)}`) : ''}${a.next ? ` · ${T('next', 'próxima')} ${a.next <= now ? T('within a minute', 'en un minuto') : T(`in ${ago(a.next - now, T)}`, `en ${ago(a.next - now, T)}`)}` : ''} · ${a.lev}× · ${T(`up to ${a.max} positions`, `hasta ${a.max} posiciones`)}</p>
      <h4>${T('Positions', 'Posiciones')}</h4>
      ${pos ? `<div class="ag-tbl-wrap" data-dragscroll><table class="ag-tbl"><thead><tr><th>${T('Market', 'Mercado')}</th><th>${T('Side', 'Lado')}</th><th>${T('Size', 'Tamaño')}</th><th>${T('Entry', 'Entrada')}</th><th>${T('Mark', 'Marca')}</th><th>PnL</th><th>Stop</th></tr></thead><tbody>${pos}</tbody></table></div>` : `<p class="ag-none">${T('Flat — nothing qualifies right now.', 'Sin posiciones — nada califica ahora mismo.')}</p>`}
      <h4>${T('Journal', 'Diario')}</h4>
      ${jr ? `<div class="ag-tbl-wrap" data-dragscroll><table class="ag-tbl ag-journal"><thead><tr><th>${T('When', 'Cuándo')}</th><th>${T('Action', 'Acción')}</th><th>${T('Market', 'Mercado')}</th><th>${T('Price', 'Precio')}</th><th>PnL</th><th>${T('Why', 'Por qué')}</th></tr></thead><tbody>${jr}</tbody></table></div>` : `<p class="ag-none">${T('No trades yet.', 'Aún sin operaciones.')}</p>`}
    </div>` : ''}
  </div>`
}

function bodyHtml() {
  if (err && !data) return `<div class="ag-msg">${T('Could not load the arena', 'No se pudo cargar la arena')}: ${esc(err)}</div>`
  if (!data) return `<div class="ag-msg">${T('Loading…', 'Cargando…')}</div>`
  if (!Array.isArray(data.agents)) return `<div class="ag-msg">${T('The agents are starting up — their first look is within a minute or two. Check back shortly.', 'Los agentes están arrancando — su primera revisión es en uno o dos minutos. Vuelve en breve.')}</div>`
  const agents = data.agents
  const hodl = agents.find(a => a.baseline)
  const ranked = [...agents].sort((p, q) => q.ret - p.ret)
  return `<p class="ag-intro">${T(`${agents.length} paper agents, $1,000 each, trading live Hyperliquid prices since ${esc(dday(data.started))}. Same fees, slippage and funding as your paper account. Paper money — not advice.`, `${agents.length} agentes de papel, $1.000 cada uno, operando precios reales de Hyperliquid desde ${esc(dday(data.started))}. Mismas comisiones, deslizamiento y funding que tu cuenta de papel. Dinero ficticio — no es asesoría.`)}</p>
    <h3 class="ag-h">${T('Return since start', 'Rentabilidad desde el inicio')}</h3>
    ${chartHtml(agents, chartWidth())}
    <div class="ag-board-h"><h3 class="ag-h">${T('Standings', 'Clasificación')}</h3><span class="ag-upd">${T('updated', 'actualizado')} ${esc(dt(data.at))}</span></div>
    <div class="ag-cards">${ranked.map((a, i) => cardHtml(a, hodl, i + 1)).join('')}</div>`
}

// The chart's inner width: the scroller less its padding, the chart's border and padding.
function chartWidth() {
  const sc = document.querySelector('#agentArenaOverlay .ag-scroll')
  if (!sc?.clientWidth) return 640
  const cs = getComputedStyle(sc)
  return sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 22
}

function paint() {
  const ov = document.getElementById('agentArenaOverlay')
  if (!ov) return
  const body = ov.querySelector('.ag-scroll')
  const top = body.scrollTop
  body.innerHTML = bodyHtml()
  body.scrollTop = top
}

async function load() {
  try {
    const r = await fetch('/agents-data', { cache: 'no-store' })
    const j = await r.json().catch(() => null)
    if (!j) throw new Error('HTTP ' + r.status)
    data = j; err = null
  } catch (e) { err = e.message }
  paint()
}

function onMove(e) {
  const ch = e.target.closest?.('.ag-chart')
  if (!ch || !data?.agents) return
  const svg = ch.querySelector('svg'), tip = ch.querySelector('.ag-tip'), cross = ch.querySelector('.ag-cross')
  const rc = svg.getBoundingClientRect()
  const W = +ch.dataset.w, L = +ch.dataset.l, R = +ch.dataset.r, t0 = +ch.dataset.t0, t1 = +ch.dataset.t1
  const sx = (e.clientX - rc.left) / rc.width * W
  if (sx < L || sx > W - R) { tip.style.display = 'none'; cross.style.display = 'none'; return }
  const t = t0 + (sx - L) / (W - L - R) * (t1 - t0)
  const rows = data.agents.map(a => ({ a, v: valueAt(pctCurve(a), t) })).filter(r => r.v != null).sort((p, q) => q.v - p.v)
  if (!rows.length) return
  cross.setAttribute('x1', sx); cross.setAttribute('x2', sx); cross.style.display = ''
  tip.innerHTML = `<div class="ag-tip-t">${esc(dt(t))}</div>` + rows.map(r => `<div><i style="background:${r.a.color}"></i>${esc(r.a.name)}<b>${sgnPct(r.v)}</b></div>`).join('')
  tip.style.display = 'block'
  const px = e.clientX - ch.getBoundingClientRect().left
  tip.style.left = Math.max(0, Math.min(ch.clientWidth - tip.offsetWidth, px + (px > ch.clientWidth / 2 ? -tip.offsetWidth - 12 : 12))) + 'px'
}
function onLeave(e) {
  const ch = e.target.closest?.('.ag-chart')
  if (!ch) return
  ch.querySelector('.ag-tip').style.display = 'none'; ch.querySelector('.ag-cross').style.display = 'none'
}

export function openAgentArena({ t } = {}) {
  if (typeof t === 'function') T = t
  let ov = document.getElementById('agentArenaOverlay')
  if (!ov) {
    ov = document.createElement('div')
    ov.id = 'agentArenaOverlay'
    ov.innerHTML = `<div class="ag-top"><span class="ag-title">${T('Agent Arena', 'Arena de agentes')}</span><button class="ag-x" data-ag-close aria-label="${T('Close', 'Cerrar')}">×</button></div><div class="ag-scroll"></div>`
    document.body.appendChild(ov)
    ov.addEventListener('click', (e) => {
      if (e.target.closest('[data-ag-close]')) return closeAgentArena()
      const b = e.target.closest('[data-ag-open]')
      if (b) { const id = b.dataset.agOpen; open.has(id) ? open.delete(id) : open.add(id); paint() }
    })
    ov.addEventListener('pointermove', onMove)
    let rz = null
    addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (ov.style.display !== 'none') paint() }, 150) })
    ov.addEventListener('pointerleave', onLeave, true)
  }
  ov.style.display = 'flex'
  paint()
  load()
  clearInterval(timer)
  timer = setInterval(() => { if (document.visibilityState === 'visible') load() }, 60_000)
}

export function closeAgentArena() {
  const ov = document.getElementById('agentArenaOverlay')
  if (ov) ov.style.display = 'none'
  clearInterval(timer); timer = null
}
