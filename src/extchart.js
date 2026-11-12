// The chart that opens for an outside market (DXY, the S&P, gold...), drawn by the app from the
// same data as its price in the strip.
//
// It used to open a TradingView embed. TradingView licenses its own index feeds (TVC:DXY, ICEUS:DXY,
// SP:SPX) for tradingview.com only, so the embed showed a broker's CFD instead -- CAPITALCOM:DXY at
// 102.664 beside the strip's ICE index at 102.98, "price is not matching". No embeddable feed tracks
// the index itself (checked with tests/tvfeed-probe.mjs: Capital.com 102.66, Tickmill 102.67,
// Purple Trading 103.04, ICE futures 102.91, the index 102.97). So the chart is ours, from the index
// via /extcandles, and the headline is the strip's own quote: one source, one number.
// TradingView stays one tap away for its drawing tools, on its own site where its feeds are licensed.

import { EXT_MARKETS, extPriceStr } from './extmarkets.js'

const TFS = ['1D', '1W', '1M', '3M', '6M', '1Y', '5Y']
let ctx = {
  T: (en) => en, esc: (s) => String(s),
  chart: () => '',             // main.js's interactive line chart
  quote: () => null,           // the strip's quote for a market: { price, pct }
  fetch: (u) => fetch(u),
}
export function setExtChartDeps(d) { ctx = { ...ctx, ...d } }

let _sym = null, _tf = '1D', _seq = 0
const _cache = new Map()       // sym|tf -> { at, pts }
const TTL = 60_000

const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + '%'

/** The change across a series, first point to last. Null for fewer than two points. */
export function seriesChange(pts) {
  if (!Array.isArray(pts) || pts.length < 2) return null
  const a = +pts[0].c, b = +pts.at(-1).c
  return a > 0 && Number.isFinite(b) ? (b / a - 1) * 100 : null
}

async function load(sym, tf) {
  const key = sym + '|' + tf, hit = _cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.pts
  const r = await ctx.fetch('/extcandles?s=' + encodeURIComponent(sym) + '&tf=' + encodeURIComponent(tf))
  if (!r.ok) throw new Error(String(r.status))
  const j = await r.json()
  // Absent is unknown (the server could not reach the source); empty is a market with no trading
  // in the window, which over a weekend is the truth for 1D.
  if (!Object.hasOwn(j?.series ?? {}, sym)) throw new Error('no series')
  const pts = j.series[sym] ?? []
  _cache.set(key, { at: Date.now(), pts })
  return pts
}

function head(sym) {
  const { T, esc } = ctx
  const m = EXT_MARKETS[sym]
  const q = ctx.quote(sym)
  const pct = q?.pct
  const col = pct == null ? 'var(--muted)' : pct >= 0 ? 'var(--green)' : 'var(--red)'
  return `<div style="flex-shrink:0;display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid var(--border)">
    <div style="flex:1;min-width:0">
      <div style="font-size:15px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(m?.name ?? sym)} <span style="color:var(--muted);font-weight:600;font-size:12px">${esc(m?.short ?? '')}</span></div>
      <div style="display:flex;align-items:baseline;gap:8px;margin-top:3px">
        <span id="extChartPrice" style="font-size:20px;font-weight:800;font-family:var(--font-mono)">${esc(extPriceStr(sym, q?.price))}</span>
        <span id="extChartPct" style="font-size:12px;font-weight:700;color:${col}">${pct == null ? '' : esc(signed(pct)) + ' <span style="color:var(--muted);font-weight:500">' + T('24h', '24h') + '</span>'}</span>
      </div>
    </div>
    <button onclick="window.__tvCloseChart()" aria-label="${T('Close', 'Cerrar')}" style="background:none;border:none;color:var(--muted);font-size:26px;line-height:1;cursor:pointer;padding:0 4px">&times;</button>
  </div>`
}

function pills() {
  return `<div data-dragscroll style="display:flex;gap:6px;overflow-x:auto;padding:10px 16px 2px">${TFS.map(tf => {
    const on = tf === _tf
    return `<button data-ext-tf="${tf}" aria-pressed="${on}" onclick="window.__extChartTf('${tf}')" style="flex-shrink:0;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;cursor:pointer;border:1px solid ${on ? 'var(--accent)' : 'var(--border2)'};background:${on ? 'var(--accent)' : 'transparent'};color:${on ? '#000' : 'var(--muted)'}">${tf}</button>`
  }).join('')}</div>`
}

function foot(sym) {
  const { T, esc } = ctx
  const m = EXT_MARKETS[sym]
  const src = m?.y === 'DX-Y.NYB' ? T('The ICE US Dollar Index itself', 'El índice del dólar de ICE en sí') : T('The market itself', 'El mercado en sí')
  return `<div style="padding:12px 16px calc(14px + env(safe-area-inset-bottom,0px));font-size:11px;color:var(--fg-3);line-height:1.5">
    ${src}, ${T('via Yahoo Finance, the same source as its price in the strip. Quotes can be delayed by the exchange.', 'vía Yahoo Finance, la misma fuente que su precio en la franja. Las cotizaciones pueden llegar con retraso de la bolsa.')}
    <a data-ext-tv href="https://www.tradingview.com/chart/?symbol=${encodeURIComponent(sym)}" target="_blank" rel="noopener" style="color:var(--accent);font-weight:700;text-decoration:none;white-space:nowrap">${T('Open in TradingView', 'Abrir en TradingView')} ↗</a>
    <div style="margin-top:4px">${T('TradingView only lets other sites show a broker\'s version of this market, which trades at its own price, so the chart here is drawn from the index.', 'TradingView solo deja a otros sitios mostrar la versión de un bróker de este mercado, que cotiza a su propio precio, así que el gráfico de aquí se dibuja con el índice.')}</div>
  </div>`
}

async function paintChart() {
  const { T, esc } = ctx
  const sym = _sym, tf = _tf, seq = ++_seq
  const box = document.getElementById('extChartBody')
  if (!box) return
  box.innerHTML = `<div style="padding:40px 0;text-align:center;font-size:12px;color:var(--fg-3)">${T('Loading…', 'Cargando…')}</div>`
  let pts
  try { pts = await load(sym, tf) } catch { pts = null }
  if (seq !== _seq || !document.getElementById('extChartBody')) return     // a newer choice, or closed
  if (pts == null) {
    box.innerHTML = `<div data-ext-msg style="padding:40px 16px;text-align:center;font-size:12px;color:var(--fg-3)">${T('The chart could not be loaded right now.', 'No se pudo cargar el gráfico ahora.')} <button onclick="window.__extChartTf('${tf}')" style="background:none;border:none;color:var(--accent);font-weight:700;cursor:pointer">${T('Try again', 'Reintentar')}</button></div>`
    return
  }
  if (pts.length < 2) {
    box.innerHTML = `<div data-ext-msg style="padding:40px 16px;text-align:center;font-size:12px;color:var(--fg-3)">${T('No trading in this window: the market is closed.', 'Sin operaciones en este periodo: el mercado está cerrado.')} <button onclick="window.__extChartTf('1W')" style="background:none;border:none;color:var(--accent);font-weight:700;cursor:pointer">${T('See the week', 'Ver la semana')}</button></div>`
    return
  }
  const chg = seriesChange(pts)
  const lo = Math.min(...pts.map(p => p.c)), hi = Math.max(...pts.map(p => p.c))
  const h = Math.max(180, Math.min(420, Math.round((window.innerHeight || 700) * 0.42)))
  const color = chg == null || chg >= 0 ? 'var(--green)' : 'var(--red)'
  box.innerHTML = `<div style="padding:4px 16px 0">
    <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--fg-2);margin-top:6px">
      <span data-ext-chg>${tf} ${chg == null ? '' : `<b style="color:${color}">${esc(signed(chg))}</b>`}</span>
      <span>${T('High', 'Máx')} <b>${esc(extPriceStr(sym, hi))}</b> · ${T('Low', 'Mín')} <b>${esc(extPriceStr(sym, lo))}</b></span>
    </div>
    ${ctx.chart(pts.map(p => [p.t, p.c]), { key: 'extchart', color, h, money: false, fmt: (v) => extPriceStr(sym, v) })}
  </div>`
}

/** Open the chart for an outside market. */
export function openExtChart(sym) {
  if (!EXT_MARKETS[sym]) return false
  _sym = sym
  let ov = document.getElementById('tvChartOverlay')
  if (!ov) {
    ov = document.createElement('div')
    ov.id = 'tvChartOverlay'
    ov.style.cssText = 'position:fixed;inset:0;z-index:100000;background:var(--bg);display:flex;flex-direction:column'
    document.body.appendChild(ov)
  }
  ov.style.display = 'flex'
  ov.innerHTML = `${head(sym)}<div data-ext-chart style="flex:1;min-height:0;overflow-y:auto">${pills()}<div id="extChartBody"></div>${foot(sym)}</div>`
  paintChart()
  return true
}

export function extChartTf(tf) {
  if (!TFS.includes(tf) || !_sym) return
  _tf = tf
  const ov = document.querySelector('#tvChartOverlay [data-ext-chart]')
  if (!ov) return
  const p = ov.querySelector('[data-dragscroll]')
  if (p) p.outerHTML = pills()
  paintChart()
}

/** The strip's quote moved: keep the headline the same number as the strip. */
export function extChartQuote() {
  if (!_sym || !document.getElementById('extChartPrice')) return
  const q = ctx.quote(_sym)
  if (!q) return
  document.getElementById('extChartPrice').textContent = extPriceStr(_sym, q.price)
}
