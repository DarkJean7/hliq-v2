// Analysis → Support & resistance (src/zones.js does the maths; this fetches and draws).
//
// Reads Hyperliquid directly — 4h, daily and weekly candles plus the order book at three
// aggregations — through the METERED client in api.js, so it paces against the same
// per-IP budget as everything else. Candles are kept five minutes, the book twenty seconds,
// and nothing is fetched while the view is not on screen.
//
// Its surfaces are solid on purpose: with a wallpaper set the app's panels go translucent
// (theme.js), and a table of prices you read the photo through is not readable. `.ana-view`
// pins them back to the preset's opaque colours (analysis.css).
import './analysis.css'
import { infoClient } from './api.js'
import { TFS, toCandles, buildZones, parseBooks, bookMid, wallFor, bookReach, bookRatio } from './zones.js'

const LS_COIN = 'hliq_ana_coin', LS_PREFS = 'hliq_ana_prefs'
const SPAN = { '4h': 180 * 864e5, '1d': 1000 * 864e5, '1w': 3000 * 864e5 }
const CANDLE_TTL = 5 * 60e3, BOOK_TTL = 20e3
const CHART_BARS = { '4h': 180, '1d': 180, '1w': 160 }
const RANGES = { 10: 0.10, 25: 0.25, all: Infinity }

const cache = new Map()        // coin → { candles, candleAt, books, bookAt, err, loading }
let S = null                   // view state, made on first render
let deps = { T: (en) => en, coins: () => [], coin: () => 'BTC' }
let timer = null

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const T = (en, es) => deps.T(en, es)

export function fmtPx(p) {
  if (!(p > 0)) return '—'
  const d = Math.min(6, Math.max(0, 4 - Math.floor(Math.log10(p))))
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })
}
export function fmtUsd(x) {
  if (x == null || !Number.isFinite(x)) return '—'
  const a = Math.abs(x)
  return a >= 1e9 ? '$' + (x / 1e9).toFixed(2) + 'B' : a >= 1e6 ? '$' + (x / 1e6).toFixed(1) + 'M' : a >= 1e3 ? '$' + (x / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K' : '$' + Math.round(x)
}
const pct = (x, d = 2) => (x > 0 ? '+' : '') + (x * 100).toFixed(d) + '%'

/** What a person typed → the coin name Hyperliquid uses ('btc' → 'BTC', 'xyz:gold' → 'xyz:GOLD'). */
export function normCoin(s) {
  let x = String(s ?? '').trim().replace(/\s+/g, '').replace(/(-PERP|USDC\.P|\/USDC|-USD)$/i, '')
  if (!x) return ''
  if (x.startsWith('@')) return x
  if (x.includes(':')) { const [d, c] = x.split(':'); return d.toLowerCase() + ':' + c.toUpperCase() }
  return x.toUpperCase()
}

function prefs() {
  let p = {}
  try { p = JSON.parse(localStorage.getItem(LS_PREFS)) || {} } catch {}
  return { sort: ['price', 'score', 'near'].includes(p.sort) ? p.sort : 'price', range: p.range in RANGES ? p.range : '25', tf: TFS.includes(p.tf) ? p.tf : '4h' }
}
function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify({ sort: S.sort, range: S.range, tf: S.tf })) } catch {} }

// ── data ────────────────────────────────────────────────────────────────────
async function loadCandles(coin) {
  const e = cache.get(coin)
  const now = Date.now()
  const out = {}
  let failed = 0
  // One at a time: the transport paces them anyway, and a burst is what the limiter punishes.
  for (const tf of TFS) {
    try { out[tf] = toCandles(await infoClient.candleSnapshot({ coin, interval: tf, startTime: now - SPAN[tf] })) }
    catch { out[tf] = null; failed++ }
  }
  if (failed === TFS.length) { e.err = 'net'; return }
  // Every timeframe answered and none has a bar: there is no such market. A failed one is
  // unknown, not empty, so it never reads as "no market".
  if (!failed && TFS.every(tf => !out[tf].length)) { e.err = 'none'; return }
  for (const tf of TFS) if (!out[tf]) out[tf] = e.candles?.[tf] ?? []
  e.candles = out; e.candleAt = now; e.err = null
}

async function loadBooks(coin) {
  const e = cache.get(coin)
  const raws = await Promise.all([undefined, 3, 2].map(n =>
    infoClient.l2Book(n ? { coin, nSigFigs: n } : { coin }).catch(() => null)))
  const books = parseBooks(raws)
  if (books.length) { e.books = books; e.bookAt = Date.now() }
}

async function refresh(force = false) {
  const coin = S.coin
  if (!cache.has(coin)) cache.set(coin, { candles: null, candleAt: 0, books: null, bookAt: 0, err: null, loading: false })
  const e = cache.get(coin)
  if (e.loading) return
  const now = Date.now()
  const needC = force || now - e.candleAt > CANDLE_TTL
  const needB = force || now - e.bookAt > BOOK_TTL
  if (!needC && !needB) return
  e.loading = true
  if (needC && !e.candles) draw()
  try {
    await Promise.all([needC ? loadCandles(coin) : null, needB && e.err !== 'none' ? loadBooks(coin) : null])
  } finally { e.loading = false }
  if (S.coin === coin) { S.ver++; draw() }
}

function result() {
  const e = cache.get(S.coin)
  if (!e?.candles) return null
  const c4 = e.candles['4h']
  const price = bookMid(e.books) ?? c4[c4.length - 1]?.c ?? e.candles['1d'].at(-1)?.c
  const key = `${S.coin}|${e.candleAt}|${price}`
  if (e.memo?.key !== key) e.memo = { key, r: buildZones({ candles: e.candles, price }) }
  return e.memo.r
}

// ── drawing ─────────────────────────────────────────────────────────────────
function headHtml() {
  return `
    <div class="ana-z-title">
      <div><div class="ana-h">${T('Support & resistance', 'Soportes y resistencias')}</div>
      <div class="ana-sub">${T('Swing pivots on 4h, daily and weekly, where traders put their volume, and the live order book. A zone is worth how many independent structures agree on it, not how often one of them touched it.',
        'Pivotes en 4h, diario y semanal, dónde se negoció el volumen y el libro de órdenes en vivo. Una zona vale por cuántas estructuras independientes coinciden en ella, no por cuántas veces la tocó una sola.')}</div></div>
    </div>
    <form class="ana-z-search" data-act="search">
      <input id="anaZInput" autocomplete="off" spellcheck="false" placeholder="${T('Market: BTC, HYPE, xyz:GOLD…', 'Mercado: BTC, HYPE, xyz:GOLD…')}">
      <button type="submit">${T('Analyse', 'Analizar')}</button>
    </form>
    <div class="ana-z-chips" data-dragscroll id="anaZChips"></div>
    <div id="anaZBody"></div>`
}

function chipsHtml() {
  const list = [...new Set([...deps.coins(), 'BTC', 'ETH', 'SOL', 'HYPE'].map(normCoin).filter(Boolean))].slice(0, 16)
  if (!list.includes(S.coin)) list.unshift(S.coin)
  return list.map(c => `<button data-act="coin" data-coin="${esc(c)}" class="${c === S.coin ? 'on' : ''}">${esc(c)}</button>`).join('')
}

const seg = (act, cur, opts) => `<span class="ana-seg">${opts.map(([v, l]) =>
  `<button data-act="${act}" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</span>`

function statsHtml(r, e) {
  const z = r.zones
  const sup = z.filter(x => x.kind === 'support').sort((a, b) => b.px - a.px)[0]
  const res = z.filter(x => x.kind === 'resistance').sort((a, b) => a.px - b.px)[0]
  const c4 = e.candles['4h']
  const day = c4.length > 6 ? (r.price - c4[c4.length - 7].c) / c4[c4.length - 7].c : null
  const ratio = e.books ? bookRatio(e.books) : null
  const all3 = z.filter(x => x.confluence === 3).length
  const pos = sup && res ? (r.price - sup.px) / (res.px - sup.px) : null
  const card = (label, value, sub = '', tone = '') => `<div class="ana-stat"><div class="l">${label}</div><div class="v ${tone}">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`
  return `<div class="ana-stats">
    ${card(T('Price', 'Precio'), fmtPx(r.price), day == null ? '' : `${T('24h', '24h')} <span class="${day >= 0 ? 'up' : 'dn'}">${pct(day)}</span>`)}
    ${card(T('Nearest support', 'Soporte más cercano'), sup ? fmtPx(sup.px) : '—', sup ? `<span class="dn">${pct(sup.dist)}</span> · ${T('strength', 'fuerza')} ${sup.score}` : T('none below', 'ninguno debajo'), 'up')}
    ${card(T('Nearest resistance', 'Resistencia más cercana'), res ? fmtPx(res.px) : '—', res ? `<span class="up">${pct(res.dist)}</span> · ${T('strength', 'fuerza')} ${res.score}` : T('none above', 'ninguna arriba'), 'dn')}
    ${card(T('Between them', 'Entre ambos'), pos == null ? '—' : Math.round(pos * 100) + '%', T('0% = on support, 100% = on resistance', '0% = en soporte, 100% = en resistencia'))}
    ${card(T('Daily range (ATR)', 'Rango diario (ATR)'), fmtPx(r.atrD), (r.atrD / r.price * 100).toFixed(2) + '% ' + T('a day', 'al día'))}
    ${card(T('Volume POC', 'POC de volumen'), r.profile ? fmtPx(r.profile.poc) : '—', r.profile ? `${T('value area', 'área de valor')} ${fmtPx(r.profile.val)}–${fmtPx(r.profile.vah)}` : '')}
    ${card(T('Zones', 'Zonas'), String(z.length), `${all3} ${T('on all 3 timeframes', 'en las 3 temporalidades')}`)}
    ${card(T('Book bid/ask ±2%', 'Libro bid/ask ±2%'), ratio ? ratio.ratio.toFixed(2) : '—', ratio ? `${fmtUsd(ratio.bid)} / ${fmtUsd(ratio.ask)}` : T('book not read yet', 'libro aún sin leer'), ratio ? (ratio.ratio >= 1 ? 'up' : 'dn') : '')}
  </div>`
}

// One line of plain reading — what the numbers say, never what to do about them.
function readingHtml(r) {
  const z = r.zones
  const near = (k) => z.filter(x => x.kind === k && Math.abs(x.dist) <= 0.1).sort((a, b) => b.score - a.score)[0]
  const s = near('support'), q = near('resistance'), at = z.find(x => x.kind === 'at')
  const bits = []
  if (at) bits.push(T(`Price is inside a zone right now (${fmtPx(at.lo)}–${fmtPx(at.hi)}, strength ${at.score}).`, `El precio está dentro de una zona ahora (${fmtPx(at.lo)}–${fmtPx(at.hi)}, fuerza ${at.score}).`))
  if (s) bits.push(T(`Strongest support within 10%: ${fmtPx(s.px)} (${pct(s.dist)}, ${s.confluence} of 3 timeframes).`, `Soporte más fuerte a menos del 10%: ${fmtPx(s.px)} (${pct(s.dist)}, ${s.confluence} de 3 temporalidades).`))
  if (q) bits.push(T(`Strongest resistance within 10%: ${fmtPx(q.px)} (${pct(q.dist)}, ${q.confluence} of 3).`, `Resistencia más fuerte a menos del 10%: ${fmtPx(q.px)} (${pct(q.dist)}, ${q.confluence} de 3).`))
  if (r.profile) bits.push(r.price > r.profile.vah ? T('Trading above the value area — most volume changed hands lower.', 'Cotiza por encima del área de valor — la mayor parte del volumen se negoció más abajo.')
    : r.price < r.profile.val ? T('Trading below the value area — most volume changed hands higher.', 'Cotiza por debajo del área de valor — la mayor parte del volumen se negoció más arriba.')
    : T('Trading inside the value area.', 'Cotiza dentro del área de valor.'))
  return bits.length ? `<div class="ana-read">${bits.join(' ')}</div>` : ''
}

// ── the chart: zoomable, pannable, every zone drawn and labelled ───────────
//
// S.view: n bars on screen, `end` bars hidden off the right edge (0 = the latest), yz a
// price zoom around the fitted range and yo a price offset. The vertical range is fitted to
// the candles on screen PLUS the selected zone, so picking a zone in the table always
// brings it into view, however far it sits from where price has been.
const MIN_BARS = 20
const freshView = (tf) => ({ n: CHART_BARS[tf], end: 0, yz: 1, yo: 0 })

function viewOf(e) {
  const all = e.candles[S.tf] ?? []
  const v = S.view
  v.n = Math.max(Math.min(MIN_BARS, all.length), Math.min(all.length, v.n))
  v.end = Math.max(0, Math.min(all.length - v.n, v.end))
  const end = Math.round(v.end), n = Math.round(v.n)
  return all.slice(Math.max(0, all.length - end - n), all.length - end)
}

function plotHtml(r, e) {
  const c = viewOf(e)
  if (c.length < 2) return `<div class="ana-empty">${T('No candles on this timeframe.', 'Sin velas en esta temporalidad.')}</div>`
  let lo = Math.min(...c.map(k => k.l)), hi = Math.max(...c.map(k => k.h))
  const sel = S.sel != null ? r.zones[S.sel] : null
  if (sel) { lo = Math.min(lo, sel.lo); hi = Math.max(hi, sel.hi) }
  const pad = (hi - lo) * 0.06
  lo -= pad; hi += pad
  const mid = (lo + hi) / 2 + S.view.yo, half = (hi - lo) / 2 / S.view.yz
  lo = mid - half; hi = mid + half
  const W = 1000, H = 300, n = c.length, bw = W / n
  const y = p => (hi - p) / (hi - lo) * H
  S.map = { lo, hi, c, H }
  const col = z => z.kind === 'support' ? 'var(--green)' : z.kind === 'resistance' ? 'var(--red)' : 'var(--accent)'
  const inView = r.zones.map((z, i) => ({ z, i })).filter(({ z }) => z.hi >= lo && z.lo <= hi)
  const bands = inView.map(({ z, i }) => {
    const top = y(Math.min(hi, z.hi)), bot = y(Math.max(lo, z.lo)), on = S.sel === i
    const a = on ? 0.42 : 0.08 + 0.2 * z.score / 100
    return `<rect x="0" y="${top.toFixed(1)}" width="${W}" height="${Math.max(1, bot - top).toFixed(1)}" style="fill:${col(z)};fill-opacity:${a.toFixed(3)}"/>` +
      `<line x1="0" x2="${W}" y1="${y(z.px).toFixed(1)}" y2="${y(z.px).toFixed(1)}" class="zl${on ? ' on' : ''}" style="stroke:${col(z)};stroke-opacity:${on ? 1 : (0.35 + 0.5 * z.score / 100).toFixed(2)}" vector-effect="non-scaling-stroke"/>`
  }).join('')
  const bars = c.map((k, i) => {
    const x = i * bw + bw / 2, cc = k.c >= k.o ? 'var(--green)' : 'var(--red)'
    const t = y(Math.max(k.o, k.c)), b = y(Math.min(k.o, k.c))
    return `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${y(k.h).toFixed(1)}" y2="${y(k.l).toFixed(1)}" style="stroke:${cc}" vector-effect="non-scaling-stroke"/>` +
      `<rect x="${(x - bw * 0.35).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" y="${t.toFixed(1)}" height="${Math.max(0.6, b - t).toFixed(1)}" style="fill:${cc}"/>`
  }).join('')
  const hline = (p, cls) => p > lo && p < hi ? `<line x1="0" x2="${W}" y1="${y(p).toFixed(1)}" y2="${y(p).toFixed(1)}" class="${cls}" vector-effect="non-scaling-stroke"/>` : ''
  // A label for every zone that has room: the selected one first, then by strength, never
  // two closer than a label's height.
  const px = S.root.querySelector('.ana-plot')?.clientHeight || 300
  const gap = 15 / px
  const labels = []
  const order = [...inView].sort((a, b) => (b.i === S.sel) - (a.i === S.sel) || b.z.score - a.z.score)
  for (const it of order) {
    const top = y(it.z.px) / H
    if (top < 0.02 || top > 0.98 || labels.some(l => Math.abs(l.top - top) < gap)) continue
    labels.push({ top, ...it })
  }
  const lab = (top, txt, cls, i) => `<span class="ana-lab ${cls}"${i != null ? ` data-act="selz" data-i="${i}"` : ''} style="top:${(top * 100).toFixed(2)}%">${txt}</span>`
  // Price ticks on the left, dates along the bottom.
  const ticks = []
  const stepP = niceStep((hi - lo) / 5)
  for (let p = Math.ceil(lo / stepP) * stepP; p < hi; p += stepP) ticks.push(`<span class="ana-tick" style="top:${(y(p) / H * 100).toFixed(2)}%">${fmtPx(p)}</span>`)
  const dates = []
  for (let j = 0; j < 5; j++) {
    const i = Math.round((n - 1) * (j + 0.5) / 5)
    dates.push(`<span class="ana-date" style="left:${((i + 0.5) / n * 100).toFixed(2)}%">${fmtDate(c[i].t)}</span>`)
  }
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bands}${hline(r.profile?.poc, 'poc')}${bars}${hline(r.price, 'now')}</svg>
    ${ticks.join('')}${dates.join('')}
    ${labels.map(l => lab(l.top, `${fmtPx(l.z.px)} · ${l.z.score}`, l.z.kind + (l.i === S.sel ? ' on' : ''), l.i)).join('')}
    ${r.price > lo && r.price < hi ? lab(y(r.price) / H, fmtPx(r.price), 'now') : ''}
    <div class="ana-xh"><span></span></div>`
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x))), f = x / p
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p
}
function fmtDate(t) {
  const d = new Date(t)
  const m = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return S.tf === '4h' ? `${m} ${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}h` : S.tf === '1d' ? `${m} ${d.getUTCDate()}` : `${m} ${String(d.getUTCFullYear()).slice(2)}`
}

function chartHtml(r, e) {
  const zoomed = S.view.n !== CHART_BARS[S.tf] || S.view.end || S.view.yz !== 1 || S.view.yo
  return `<div class="ana-card ana-chart">
    <div class="ana-bar wrap"><span class="ana-t">${T('Zones on the chart', 'Zonas en el gráfico')}</span><span style="flex:1"></span>
      <span class="ana-seg"><button data-act="zoom" data-v="out" aria-label="${T('Zoom out', 'Alejar')}">−</button><button data-act="zoom" data-v="in" aria-label="${T('Zoom in', 'Acercar')}">+</button><button data-act="zoom" data-v="reset" class="${zoomed ? '' : 'dim'}">${T('Reset', 'Restablecer')}</button></span>
      ${seg('tf', S.tf, TFS.map(t => [t, t]))}</div>
    <div class="ana-plot">${plotHtml(r, e)}</div>
    <div class="ana-legend"><span><i class="sw sup"></i>${T('support', 'soporte')}</span><span><i class="sw res"></i>${T('resistance', 'resistencia')}</span><span><i class="sw poc"></i>${T('volume POC', 'POC de volumen')}</span><span>${T('deeper colour = stronger · scroll or pinch to zoom, drag to pan, double-click to reset', 'color más intenso = más fuerte · rueda o pellizco para zoom, arrastra para mover, doble clic para restablecer')}</span></div>
  </div>`
}

// Redraw only the plot — zooming must not rebuild the table under the finger.
let _raf = 0
function drawPlot() {
  if (_raf) return
  _raf = requestAnimationFrame(() => {
    _raf = 0
    const plot = S?.root?.querySelector('.ana-plot'), e = cache.get(S?.coin), r = e?.candles && result()
    if (!plot || !r) return
    plot.innerHTML = plotHtml(r, e)
    const rs = S.root.querySelector('[data-act="zoom"][data-v="reset"]')
    if (rs) rs.classList.toggle('dim', !(S.view.n !== CHART_BARS[S.tf] || S.view.end || S.view.yz !== 1 || S.view.yo))
  })
}

/** Zoom time by `f` (>1 = fewer bars), keeping the bar at fraction `fx` of the width still. */
function zoomBy(f, fx = 1) {
  const v = S.view, n0 = v.n
  v.n = Math.max(MIN_BARS, v.n / f)
  v.end = v.end + (1 - fx) * (n0 - v.n)
  drawPlot()
}

function bindChart(root) {
  const pts = new Map()
  let drag = null, pinch = null
  const plotOf = ev => ev.target.closest?.('.ana-plot')
  root.addEventListener('wheel', ev => {
    const plot = plotOf(ev)
    if (!plot || !S.map) return
    ev.preventDefault()
    const f = Math.exp(-ev.deltaY * 0.0015)
    if (ev.shiftKey || ev.ctrlKey) { S.view.yz = Math.max(0.2, Math.min(40, S.view.yz * f)); drawPlot(); return }
    const rc = plot.getBoundingClientRect()
    zoomBy(f, (ev.clientX - rc.left) / rc.width)
  }, { passive: false })
  root.addEventListener('pointerdown', ev => {
    const plot = plotOf(ev)
    if (!plot || ev.button > 0) return
    pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
    const rc = plot.getBoundingClientRect()
    if (pts.size === 1) drag = { x: ev.clientX, y: ev.clientY, end: S.view.end, yo: S.view.yo, w: rc.width, h: rc.height, moved: false, mouse: ev.pointerType === 'mouse' }
    if (pts.size === 2) {
      const [a, b] = [...pts.values()]
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, n: S.view.n, end: S.view.end, fx: ((a.x + b.x) / 2 - rc.left) / rc.width }
      drag = null
    }
  })
  root.addEventListener('pointermove', ev => {
    const plot = plotOf(ev)
    if (pts.has(ev.pointerId)) pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1
      S.view.n = pinch.n; S.view.end = pinch.end
      zoomBy(d / pinch.d, pinch.fx)
      return
    }
    if (drag && pts.has(ev.pointerId)) {
      const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true
      if (!drag.moved) return
      S.view.end = drag.end + dx / drag.w * S.view.n
      // Vertical drag moves price for a mouse only; on a phone it is the page scrolling.
      if (drag.mouse && S.map) S.view.yo = drag.yo + dy / drag.h * (S.map.hi - S.map.lo)
      drawPlot()
      return
    }
    // Crosshair: the price and time under the pointer.
    if (plot && S.map && ev.pointerType === 'mouse') {
      const rc = plot.getBoundingClientRect(), fy = (ev.clientY - rc.top) / rc.height, fx = (ev.clientX - rc.left) / rc.width
      const xh = plot.querySelector('.ana-xh')
      if (!xh || fy < 0 || fy > 1) return
      const k = S.map.c[Math.min(S.map.c.length - 1, Math.max(0, Math.floor(fx * S.map.c.length)))]
      xh.style.display = 'block'; xh.style.top = (fy * 100) + '%'
      xh.firstElementChild.textContent = fmtPx(S.map.hi - fy * (S.map.hi - S.map.lo)) + (k ? ' · ' + fmtDate(k.t) : '')
    }
  })
  const up = ev => {
    pts.delete(ev.pointerId)
    if (pts.size < 2) pinch = null
    // The click that ends a drag is not a press on whatever it ended over.
    if (drag?.moved) { S.dragClick = true; setTimeout(() => { S.dragClick = false }, 0) }
    if (!pts.size) drag = null
  }
  root.addEventListener('pointerup', up)
  root.addEventListener('pointercancel', up)
  root.addEventListener('pointerleave', ev => { const xh = root.querySelector('.ana-xh'); if (xh && ev.pointerType === 'mouse') xh.style.display = 'none' })
  root.addEventListener('dblclick', ev => { if (plotOf(ev)) { S.view = freshView(S.tf); drawPlot() } })
}

function rowsHtml(r, e) {
  const lim = RANGES[S.range]
  let z = r.zones.map((x, i) => ({ ...x, i })).filter(x => Math.abs(x.dist) <= lim)
  if (S.sort === 'score') z.sort((a, b) => b.score - a.score || Math.abs(a.dist) - Math.abs(b.dist))
  else if (S.sort === 'near') z.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist))
  else z.sort((a, b) => b.px - a.px)
  const kindLbl = { support: T('support', 'soporte'), resistance: T('resistance', 'resistencia'), at: T('at price', 'en precio') }
  const row = x => {
    const w = wallFor(x, e.books)
    return `<div class="ana-row ${S.sel === x.i ? 'sel' : ''}" data-act="sel" data-i="${x.i}">
      <span class="c-zone">${x.tfs.map(t => `<b class="tf tf-${t}">${t}</b>`).join('')}<span class="k ${x.kind}">${kindLbl[x.kind]}</span>${x.flip ? `<span class="flip" title="${T('Built from the opposite swings: a level price has since broken through and may now hold from the other side', 'Formada por los giros contrarios: un nivel que el precio ya atravesó y que puede sostener desde el otro lado')}">${T('flip', 'giro')}</span>` : ''}</span>
      <span class="c-px">${fmtPx(x.px)}</span>
      <span class="c-dist ${x.kind === 'support' ? 'up' : x.kind === 'resistance' ? 'dn' : ''}">${pct(x.dist)}</span>
      <span class="c-str"><b>${x.score}</b><i><u style="width:${x.score}%"></u></i></span>
      <span class="c-conf">${T(`${x.confluence} of 3`, `${x.confluence} de 3`)}</span>
      <span class="c-piv">${x.pivots}</span>
      <span class="c-tch">${x.touches == null ? '—' : (x.touches * 100).toFixed(1) + '%'}</span>
      <span class="c-vol">${x.density == null ? '—' : x.density.toFixed(1) + '×'}</span>
      <span class="c-wall">${w ? fmtUsd(w.usd) : `<em>${T('beyond the book', 'fuera del libro')}</em>`}</span>
      <span class="c-ord">${w ? w.orders.toLocaleString('en-US') : '—'}</span>
      <span class="c-per">${w?.perOrder ? fmtUsd(w.perOrder) : '—'}</span>
    </div>`
  }
  let body = ''
  if (S.sort === 'price') {
    const above = z.filter(x => x.px > r.price), below = z.filter(x => x.px <= r.price)
    body = above.map(row).join('') + `<div class="ana-row now"><span class="c-zone">${T('price now', 'precio ahora')}</span><span class="c-px">${fmtPx(r.price)}</span></div>` + below.map(row).join('')
  } else body = z.map(row).join('')
  const head = `<div class="ana-row head">
    <span class="c-zone">${T('Zone', 'Zona')}</span><span class="c-px">${T('Price', 'Precio')}</span><span class="c-dist">${T('Distance', 'Distancia')}</span>
    <span class="c-str">${T('Strength', 'Fuerza')}</span><span class="c-conf">${T('Confluence', 'Confluencia')}</span><span class="c-piv" title="${T('Swing points in the zone', 'Pivotes en la zona')}">${T('Swings', 'Giros')}</span>
    <span class="c-tch" title="${T('Share of 4h candles that traded inside it', 'Parte de las velas de 4h que cotizaron dentro')}">${T('Touches', 'Toques')}</span>
    <span class="c-vol" title="${T('Volume traded there vs an average band of the same width', 'Volumen negociado ahí vs una franja media del mismo ancho')}">${T('Volume', 'Volumen')}</span>
    <span class="c-wall">${T('Wall', 'Muro')}</span><span class="c-ord">${T('Orders', 'Órdenes')}</span><span class="c-per">$/${T('order', 'orden')}</span></div>`
  return `<div class="ana-card">
    <div class="ana-bar wrap">
      ${seg('sort', S.sort, [['price', T('by price', 'por precio')], ['score', T('by strength', 'por fuerza')], ['near', T('nearest', 'más cerca')]])}
      <span style="flex:1"></span>
      ${seg('range', S.range, [['10', '±10%'], ['25', '±25%'], ['all', T('all', 'todas')]])}
    </div>
    <div class="ana-table" data-dragscroll><div class="ana-rows">${head}${z.length ? body : `<div class="ana-empty">${T('No zones in this range.', 'Sin zonas en este rango.')}</div>`}</div></div>
  </div>`
}

function footHtml(r, e) {
  const reach = e.books ? bookReach(e.books) : null
  const cnt = TFS.map(tf => `${tf}: ${r.counts[tf].candles} ${T('candles', 'velas')}, ${r.counts[tf].pivots} ${T('pivots', 'pivotes')}`).join(' · ')
  return `<div class="ana-foot">${cnt}. ${reach != null ? T(`The wall is only visible where the order book reaches (about ±${(reach * 100).toFixed(1)}% of price); beyond it there may be orders, they just cannot be seen. `, `El muro solo se ve donde alcanza el libro de órdenes (cerca de ±${(reach * 100).toFixed(1)}% del precio); más allá puede haber órdenes, solo que no se ven. `) : ''}${
    T('Strength weighs timeframe agreement most, then the number of swings, how hard price turned there, how recent, and the volume traded in the band. A book cannot tell orders that open positions from ones that close them. Not advice.',
      'La fuerza pesa sobre todo la coincidencia entre temporalidades, luego el número de giros, cuánto rebotó el precio, lo reciente y el volumen negociado en la franja. El libro no distingue órdenes que abren de las que cierran. No es consejo.')}</div>`
}

function draw() {
  const body = S?.root?.querySelector('#anaZBody')
  if (!body) return
  const e = cache.get(S.coin)
  if (!e || (!e.candles && !e.err)) { body.innerHTML = `<div class="ana-card"><div class="ana-empty">${T(`Reading ${esc(S.coin)}…`, `Leyendo ${esc(S.coin)}…`)}</div></div>`; return }
  if (e.err && !e.candles) {
    body.innerHTML = `<div class="ana-card"><div class="ana-empty">${e.err === 'none'
      ? T(`Hyperliquid has no market called <b>${esc(S.coin)}</b>.`, `Hyperliquid no tiene un mercado llamado <b>${esc(S.coin)}</b>.`)
      : T('Could not reach Hyperliquid.', 'No se pudo contactar con Hyperliquid.') + ` <button data-act="retry" class="ana-btn">${T('Retry', 'Reintentar')}</button>`}</div></div>`
    return
  }
  const r = result()
  if (!r) { body.innerHTML = `<div class="ana-card"><div class="ana-empty">${T('Not enough data for this market yet.', 'Aún no hay datos suficientes para este mercado.')}</div></div>`; return }
  const keep = body.querySelector('.ana-table')?.scrollLeft ?? 0
  body.innerHTML = statsHtml(r, e) + readingHtml(r) + chartHtml(r, e) + rowsHtml(r, e) + footHtml(r, e)
  const t = body.querySelector('.ana-table')
  if (t) t.scrollLeft = keep
  S.drawn = S.ver
}

function onClick(ev) {
  const b = ev.target.closest('[data-act]')
  if (!b || !S.root.contains(b) || b.tagName === 'FORM') return
  const a = b.dataset.act
  if (a === 'coin') return pick(b.dataset.coin)
  if (a === 'retry') { refresh(true); return }
  // A row takes you to its line on the chart; a label on the chart takes you to its row.
  if (a === 'sel') {
    const i = +b.dataset.i
    S.sel = S.sel === i ? null : i
    S.view.yz = 1; S.view.yo = 0
    draw()
    if (S.sel != null) S.root.querySelector('.ana-chart')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  if (a === 'selz') {
    if (S.dragClick) return
    S.sel = +b.dataset.i
    draw()
    const row = S.root.querySelector(`.ana-row[data-i="${S.sel}"]`)
    row?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  if (a === 'zoom') {
    if (b.dataset.v === 'reset') S.view = freshView(S.tf)
    else return zoomBy(b.dataset.v === 'in' ? 1.5 : 1 / 1.5)
    drawPlot(); return
  }
  if (a === 'sort' || a === 'range' || a === 'tf') { S[a] = b.dataset.v; if (a === 'tf') S.view = freshView(S.tf); savePrefs(); draw() }
}

function pick(coin) {
  coin = normCoin(coin)
  if (!coin) return
  S.coin = coin; S.sel = null; S.view = freshView(S.tf)
  try { localStorage.setItem(LS_COIN, coin) } catch {}
  const chips = S.root.querySelector('#anaZChips')
  if (chips) chips.innerHTML = chipsHtml()
  draw()
  refresh()
}

/**
 * Draw into `root` (built once, then only the body is redrawn when the data changes — the
 * host re-renders on every price tick, and rebuilding would take the search box's focus).
 *
 * d: { T(en, es), coins() → coin names to offer as chips, coin() → a default market }
 */
export function renderAnalysis(root, d) {
  if (d) deps = { ...deps, ...d }
  if (!S || S.root !== root || !root.querySelector('#anaZBody')) {
    let coin = ''
    try { coin = localStorage.getItem(LS_COIN) || '' } catch {}
    // A rebuilt container is the same view to the person using it: keep the market, the
    // selected zone and the zoom.
    const prev = S
    S = { root, coin: normCoin(coin || deps.coin() || 'BTC'), sel: null, ver: 0, drawn: -1, chipSig: null, ...prefs() }
    S.view = freshView(S.tf)
    if (prev && prev.coin === S.coin) { S.sel = prev.sel; S.view = prev.view; S.tf = prev.tf }
    root.innerHTML = headHtml()
    root.addEventListener('click', onClick)
    bindChart(root)
    root.querySelector('form[data-act="search"]').addEventListener('submit', ev => {
      ev.preventDefault()
      const inp = root.querySelector('#anaZInput')
      pick(inp.value); inp.value = ''; inp.blur()
    })
  }
  const sig = deps.coins().join(',')
  if (sig !== S.chipSig) { S.chipSig = sig; root.querySelector('#anaZChips').innerHTML = chipsHtml() }
  if (S.drawn !== S.ver) draw()
  refresh()
  if (!timer) timer = setInterval(() => {
    if (!S?.root?.isConnected) { clearInterval(timer); timer = null; return }
    if (S.root.offsetParent !== null && !document.hidden) refresh()
  }, 5000)
}
