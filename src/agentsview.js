/**
 * The Agent Arena screen: the shared paper agents (src/agents.js) that the server runs
 * (src/agentrunner.js), read from GET /agents-data. A tab on both shells: the desktop nav and
 * sidebar, and More → Agent Arena on the phone.
 *
 * Read-only and public: nobody's account is involved, so it works before a wallet is connected.
 * Colours follow the AGENT, never its rank — the board re-sorts by return and a line must keep its
 * colour. HODL BTC is the benchmark: grey, and every other row says how far it is from it.
 */
import './agents.css'
import { valueAt } from './agents.js'
import { maxRunupPct } from './runup.js'
import { rektHtml, readForm, isDevMode, devPin } from './rektview.js'

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
let rkDraft = null, rkStatus = ''   // Rekt-01's settings being edited, and what the last save said
let rkCtl = '', rkBusy = false       // what its last control said, and one at a time

/** Return % series per agent, for the chart: [[t, pct]]. */
function pctCurve(a) { return (a.curve ?? []).map(([t, v]) => [t, (v / a.start - 1) * 100]) }


function chartHtml(agents, width = 640) {
  const W = Math.max(260, Math.round(width)), H = 220, L = 44, R = 12, Tp = 10, B = 22
  const series = agents.map(a => ({ a, c: pctCurve(a) })).filter(s => s.c.length)
  const pts = series.flatMap(s => s.c)
  if (pts.length < 2) return `<div class="ag-chart-empty">${T('The chart fills in as the bots trade — one point an hour.', 'El gráfico se llena a medida que operan — un punto por hora.')}</div>`
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
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(T('Return since start, per bot', 'Rentabilidad desde el inicio, por bot'))}">${grid}${xl}${lines}<line class="ag-cross" x1="0" x2="0" y1="${Tp}" y2="${H - B}" style="display:none"/></svg>
    <div class="ag-tip" style="display:none"></div>
  </div>`
}
function niceStep(raw) {
  const p = 10 ** Math.floor(Math.log10(Math.max(raw, 1e-6)))
  const n = raw / p
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p
}

// Size in tokens: 4.84M HMSTR, 1,234.5 HYPE, 0.0123 BTC. The exact figure is in the tooltip.
function szFmt(n) {
  const a = Math.abs(n)
  if (!(a > 0)) return '0'
  if (a >= 1e6) return (a / 1e6).toFixed(2) + 'M'
  if (a >= 1e4) return a.toLocaleString('en-US', { maximumFractionDigits: 0 })
  if (a >= 1) return a.toLocaleString('en-US', { maximumFractionDigits: 2 })
  return a.toPrecision(3)
}
const kv = (k, v, c = '') => `<span><small>${k}</small><b class="${c}">${v}</b></span>`

// One open position, with what the Trade screen's position row shows: size in tokens, value,
// entry, mark, liquidation and how far it is, margin, stop, take-profit, funding, when it opened.
function posHtml(a, p) {
  const trig = (a.stops ?? []).filter(s => s.coin === p.coin)
  const sl = trig.find(s => !s.tp), tp = trig.find(s => s.tp)
  const long = p.szi > 0
  const roe = p.margin > 0 ? p.upnl / p.margin * 100 : null
  // null = cannot be liquidated on price alone (HL's own null). Undefined = an older summary.
  const liq = p.liq === undefined ? '—' : p.liq == null || !(p.liq > 0) ? T('None', 'Ninguna') : `${pxFmt(p.liq)} <i class="ag-dim">${(Math.abs(p.mark - p.liq) / p.mark * 100).toFixed(1)}%</i>`
  const opened = (a.journal ?? []).find(j => j.kind === 'open' && j.coin === p.coin)
  return `<div class="ag-pos">
    <div class="ag-pos-h"><b>${esc(p.coin)}</b><span class="ag-side ${long ? 'pos' : 'neg'}">${long ? T('Long', 'Largo') : T('Short', 'Corto')}${p.lev ? ' ' + p.lev + '×' : ''}${p.cross === false ? ' ' + T('isolated', 'aislada') : p.cross ? ' ' + T('cross', 'cruzada') : ''}</span>
      <span class="ag-pos-pnl ${cls(p.upnl)}">${sgnUsd(p.upnl)}${roe != null ? ` <i>(${sgnPct(roe, 1)})</i>` : ''}</span></div>
    <div class="ag-kv">
      ${kv(T('Size', 'Tamaño'), `<span title="${Math.abs(p.szi)}">${szFmt(p.szi)} ${esc(p.coin)}</span>`)}
      ${kv(T('Value', 'Valor'), usd(Math.abs(p.value)))}
      ${kv(T('Entry', 'Entrada'), pxFmt(p.entryPx))}
      ${kv(T('Mark', 'Marca'), pxFmt(p.mark))}
      ${kv(T('Liq. price', 'Precio liq.'), liq, 'ag-liq')}
      ${kv(T('Margin', 'Margen'), Number.isFinite(p.margin) ? usd(p.margin) : '—')}
      ${kv('Stop', sl ? pxFmt(sl.px) : '—')}
      ${kv(T('Take profit', 'Toma de ganancia'), tp ? pxFmt(tp.px) : '—')}
      ${kv(T('Funding', 'Funding'), Number.isFinite(p.funding) ? sgnUsd(p.funding) : '—', cls(p.funding))}
      ${kv(T('Opened', 'Abierta'), opened ? esc(dt(opened.t)) : '—')}
    </div>
  </div>`
}

function cardHtml(a, hodl, rank) {
  const vs = hodl && !a.baseline ? a.ret - hodl.ret : null
  const isOpen = open.has(a.id)
  const wr = a.trades ? Math.round(a.wins / a.trades * 100) : null
  const ps = a.positions ?? []
  const upnl = ps.reduce((x, p) => x + (p.upnl || 0), 0)
  const expo = ps.reduce((x, p) => x + Math.abs(p.value || 0), 0)
  const margin = ps.every(p => Number.isFinite(p.margin)) ? ps.reduce((x, p) => x + p.margin, 0) : null
  const pos = ps.map(p => posHtml(a, p)).join('')
  const KIND = { open: T('Opened', 'Abrió'), close: T('Closed', 'Cerró'), stop: T('Stopped', 'Stop'), skip: T('Skipped', 'Omitió'), error: T('Error', 'Error'), note: T('You', 'Tú') }
  const jr = (a.journal ?? []).map(j => `<tr class="ag-j-${j.kind}"><td>${esc(dt(j.t))}</td><td>${KIND[j.kind] ?? esc(j.kind)}</td><td>${j.coin ? `<b>${esc(j.coin)}</b>` : ''}${j.side ? ` <span class="${j.side === 'long' ? 'pos' : 'neg'}">${j.side === 'long' ? T('long', 'largo') : T('short', 'corto')}</span>` : ''}</td><td>${j.px ? pxFmt(j.px) : ''}</td><td class="${cls(j.pnl)}">${Number.isFinite(j.pnl) ? sgnUsd(j.pnl) : ''}</td><td class="ag-why">${esc(j.why ?? '')}</td></tr>`).join('')
  const now = data?.at ?? Date.now()
  return `<div class="ag-card${isOpen ? ' open' : ''}${a.baseline ? ' base' : ''}" data-ag="${esc(a.id)}">
    <button class="ag-head" data-ag-open="${esc(a.id)}" aria-expanded="${isOpen}">
      <span class="ag-rank">${rank}</span>
      <span class="ag-name"><i style="background:${a.color}"></i>${esc(a.name)}${a.baseline ? `<em>${T('benchmark', 'referencia')}</em>` : ''}${a.personal ? `<em class="ag-yours">${T('yours · learning', 'tuyo · aprendiendo')}</em>` : ''}${a.hidden ? `<em>${T('not in the Bot Pit', 'fuera del Bot Pit')}</em>` : ''}</span>
      <span class="ag-ret ${cls(a.ret)}">${sgnPct(a.ret)}</span>
      <span class="ag-chev">${isOpen ? '▴' : '▾'}</span>
    </button>
    <div class="ag-stats">
      ${kv(T('Equity', 'Capital'), usd(a.equity))}
      ${kv(T('Unrealized PnL', 'PnL no realizado'), sgnUsd(upnl), cls(upnl))}
      ${kv(T('Realized PnL', 'PnL realizado'), Number.isFinite(a.realized) ? sgnUsd(a.realized) : '—', cls(a.realized))}
      ${kv(T('vs HODL BTC', 'vs HODL BTC'), vs == null ? '—' : sgnPct(vs), cls(vs))}
      ${kv(T('Max drawdown', 'Caída máx.'), a.maxDD > 0 ? '−' + a.maxDD.toFixed(1) + '%' : '0%')}
      ${(() => { const up = Number.isFinite(a.maxUp) ? a.maxUp : maxRunupPct(a.curve); return kv(T('Max upside', 'Subida máx.'), up == null ? '—' : up > 0 ? '+' + up.toFixed(1) + '%' : '0%', up > 0 ? 'pos' : '') })()}
      ${kv(T('Trades', 'Operaciones'), `${a.trades}${wr != null ? ` · ${wr}% ${T('won', 'ganadas')}` : ''}`)}
      ${kv(T('Exposure', 'Exposición'), `${usd(expo, 0)}${a.equity > 0 && expo > 0 ? ` <i class="ag-dim">${(expo / a.equity).toFixed(2)}×</i>` : ''}`)}
      ${kv(T('Margin used', 'Margen usado'), margin == null ? '—' : usd(margin))}
      ${kv(T('Free cash', 'Disponible'), Number.isFinite(a.cash) ? usd(a.cash) : '—')}
      ${kv(T('Open', 'Abiertas'), `${ps.length}/${a.max}`)}
    </div>
    ${isOpen ?`<div class="ag-body">
      <p class="ag-blurb">${esc(T(a.blurb?.[0] ?? '', a.blurb?.[1] ?? a.blurb?.[0] ?? ''))}</p>
      <p class="ag-when">${a.last ? T(`Last look ${ago(now - a.last, T)} ago`, `Última revisión hace ${ago(now - a.last, T)}`) : ''}${a.next ? ` · ${T('next', 'próxima')} ${a.next <= now ? T('within a minute', 'en un minuto') : T(`in ${ago(a.next - now, T)}`, `en ${ago(a.next - now, T)}`)}` : ''} · ${a.lev}× · ${T(`up to ${a.max} positions`, `hasta ${a.max} posiciones`)}</p>
      ${a.personal ? rektHtml(a, { T, dev: isDevMode(), draft: rkDraft, status: rkStatus, ctlStatus: rkCtl, width: chartWidth() - 24 }) : ''}
      <h4>${T('Positions', 'Posiciones')}</h4>
      ${pos ? `<div class="ag-poss">${pos}</div>` : `<p class="ag-none">${T('Flat — nothing qualifies right now.', 'Sin posiciones — nada califica ahora mismo.')}</p>`}
      <h4>${T('Journal', 'Diario')}</h4>
      ${jr ? `<div class="ag-tbl-wrap" data-dragscroll><table class="ag-tbl ag-journal"><thead><tr><th>${T('When', 'Cuándo')}</th><th>${T('Action', 'Acción')}</th><th>${T('Market', 'Mercado')}</th><th>${T('Price', 'Precio')}</th><th>PnL</th><th>${T('Why', 'Por qué')}</th></tr></thead><tbody>${jr}</tbody></table></div>` : `<p class="ag-none">${T('No trades yet.', 'Aún sin operaciones.')}</p>`}
    </div>` : ''}
  </div>`
}

function bodyHtml() {
  if (err && !data) return `<div class="ag-msg">${T('Could not load the arena', 'No se pudo cargar la arena')}: ${esc(err)}</div>`
  if (!data) return `<div class="ag-msg">${T('Loading…', 'Cargando…')}</div>`
  if (!Array.isArray(data.agents)) return `<div class="ag-msg">${T('The bots are starting up — their first look is within a minute or two. Check back shortly.', 'Los bots están arrancando — su primera revisión es en uno o dos minutos. Vuelve en breve.')}</div>`
  const agents = data.agents
  const hodl = agents.find(a => a.baseline)
  const ranked = [...agents].sort((p, q) => q.ret - p.ret)
  return `<p class="ag-intro">${T(`${agents.length} paper bots, $1,000 each, trading live Hyperliquid prices since ${esc(dday(data.started))}. Same fees, slippage and funding as your paper account. Paper money — not advice.`, `${agents.length} bots de papel, $1.000 cada uno, operando precios reales de Hyperliquid desde ${esc(dday(data.started))}. Mismas comisiones, deslizamiento y funding que tu cuenta de papel. Dinero ficticio — no es asesoría.`)}</p>
    <h3 class="ag-h">${T('Return since start', 'Rentabilidad desde el inicio')}</h3>
    ${chartHtml(agents, chartWidth())}
    <div class="ag-board-h"><h3 class="ag-h">${T('Standings', 'Clasificación')}</h3><span class="ag-upd">${T('updated', 'actualizado')} ${esc(dt(data.at))}</span></div>
    <div class="ag-cards">${ranked.map((a, i) => cardHtml(a, hodl, i + 1)).join('')}</div>`
}

// The chart's inner width: the scroller less its padding, the chart's border and padding.
function chartWidth() {
  const sc = root?.querySelector('.ag-scroll')
  if (!sc?.clientWidth) return 640
  const cs = getComputedStyle(sc)
  return sc.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 22
}

// The arena's root in whichever tab it is mounted: the desktop pane or the phone's content area.
let root = null
const showing = () => !!root && root.isConnected && root.offsetParent !== null

function paint() {
  if (!root?.isConnected) return
  const body = root.querySelector('.ag-scroll')
  // Not while someone is typing in Rekt-01's settings: a repaint would take the field from under them.
  if (document.activeElement?.closest?.('[data-rk-form]') && body.contains(document.activeElement)) return
  body.innerHTML = bodyHtml()
}

let lastLoad = 0
async function load() {
  lastLoad = Date.now()
  try {
    // Dev mode also sees Rekt-01 when it is out of the arena; the server checks the PIN.
    const r = await fetch('/agents-data', { cache: 'no-store', headers: isDevMode() ? { 'x-lb-pin': devPin() } : {} })
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

/**
 * Mount the arena in a tab: `host` is the desktop pane (#deskAgents) or the phone's content area,
 * `header` the app's own full-page header, so it looks and closes like every other tab.
 *
 * It was a fixed overlay over the whole app — "not take the whole window and behave like all
 * tabs". The phone shell re-renders its content area on every tick; a host that already holds the
 * arena is left alone, so the scroll position and the open cards survive it.
 */
export function renderAgentArena(host, { t, header = '', enter = false } = {}) {
  if (typeof t === 'function') T = t
  if (!host) return
  const mounted = host.querySelector(':scope > .ag-root')
  if (!mounted) {
    host.innerHTML = `${header}<div class="ag-root" id="agentArena"><div class="ag-scroll"></div></div>`
    root = host.querySelector('.ag-root')
    wire(root)
    paint()
    load()
  } else {
    root = mounted
    // Back on the desktop tab (its pane keeps the arena while hidden): fresh numbers, and dev mode
    // may have changed. The phone's ticks re-render without `enter`, and only reload when stale.
    if (enter || Date.now() - lastLoad > 60_000) { paint(); load() }
  }
  clearInterval(timer)
  // Stops itself once the tab is left, rather than relying on every way out to stop it.
  timer = setInterval(() => { if (!showing()) { clearInterval(timer); timer = null; return } if (document.visibilityState === 'visible') load() }, 60_000)
}

let resizeWired = false
function wire(ov) {
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('[data-ag-open]')
      if (b) { const id = b.dataset.agOpen; open.has(id) ? open.delete(id) : open.add(id); paint() }
      if (e.target.closest('[data-rk-save]')) saveRekt(e.target.closest('[data-rk-form]'))
      const c = e.target.closest('[data-rk-ctl]')
      if (c) controlRekt(c.dataset.rkCtl)
    })
    ov.addEventListener('input', (e) => { const f = e.target.closest('[data-rk-form]'); if (f) { rkDraft = readForm(f); rkStatus = T('Not saved yet', 'Aún sin guardar'); const s = f.querySelector('.rk-status'); if (s) s.textContent = rkStatus } })
    ov.addEventListener('pointermove', onMove)
    ov.addEventListener('pointerleave', onLeave, true)
    if (!resizeWired) {
      resizeWired = true
      let rz = null
      addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { if (showing()) paint() }, 150) })
    }
}

async function saveRekt(form) {
  if (!form || !isDevMode()) return
  const config = readForm(form)
  rkStatus = T('Saving…', 'Guardando…'); form.querySelector('.rk-status').textContent = rkStatus
  try {
    const r = await fetch('/agents-config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-lb-pin': devPin() }, body: JSON.stringify({ config }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    rkDraft = null
    rkStatus = T('Saved — it uses them from its next run (within the hour).', 'Guardado — los usa desde su próxima revisión (en menos de una hora).')
    const a = data?.agents?.find(x => x.personal)
    if (a) { a.config = j.config; a.hidden = !j.config.arena }
  } catch (e) { rkStatus = T('Not saved: ', 'No guardado: ') + e.message }
  document.activeElement?.blur?.()
  paint()
}

const CONFIRM = {
  stop: ['Stop Rekt-01? It closes every position now at the market and opens nothing until you start it again.', '¿Detener Rekt-01? Cierra todas sus posiciones ahora a mercado y no abre nada hasta que lo inicies.'],
  restart: ['Restart Rekt-01? It closes every position now and decides afresh. Its money, record and what it learned stay.', '¿Reiniciar Rekt-01? Cierra todas sus posiciones ahora y decide de nuevo. Su dinero, historial y lo aprendido se mantienen.'],
  clear: ["Clear Rekt-01's track? Its positions, record, chart and everything it learned are wiped, and it starts again with $1,000. This cannot be undone.", '¿Borrar el historial de Rekt-01? Se borran sus posiciones, historial, gráfico y todo lo aprendido, y empieza de nuevo con $1,000. No se puede deshacer.'],
}
async function controlRekt(action) {
  if (!isDevMode() || rkBusy) return
  if (CONFIRM[action] && !confirm(T(...CONFIRM[action]))) return
  rkBusy = true
  rkCtl = T('Working…', 'Procesando…'); paint()
  try {
    const r = await fetch('/agents-control', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-lb-pin': devPin() }, body: JSON.stringify({ action }) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status)
    const a = data?.agents?.find(x => x.personal)
    if (a) a.config = j.config
    rkCtl = T('Done.', 'Hecho.')
    await load()
    // The worker was mid-run: the board is a minute behind the control.
    const fresh = data?.agents?.find(x => x.personal)
    if (fresh && fresh.config?.status !== j.config.status) { fresh.config = j.config; rkCtl = T('Queued — applied within a minute.', 'En cola — se aplica en menos de un minuto.') }
  } catch (e) { rkCtl = T('Failed: ', 'Falló: ') + e.message }
  rkBusy = false
  paint()
}

