/**
 * INSOLVENT TERMINAL — Trade Simulator: pictures of what the settings mean
 *
 * Asked for: "currently i can set the entry category from 1-6 but is lacking the visual of
 * letting the user know what is a category 1 vs 2, vs 3, etc ... make it more visual and
 * flexible". A number in a box says nothing about a candle. So:
 *
 *   catGuideHtml   the seven categories drawn as candles, each its size in the market's own
 *                  dollars, how many of the run's candles reached it, and which ones the band
 *                  you set will trade. Tap a candle to start the band there.
 *   levelsHtml     the target and stop drawn either side of the entry, with the ratio they
 *                  imply and the win rate needed to break even -- per side when shorts have
 *                  their own pair, and saying plainly when nothing would close a trade.
 *
 * Pure: candles and settings in, HTML out. The arithmetic is backtest.js's own
 * (rangeBaseline, categoryOf), so the picture of "category 3" is exactly what the trades used.
 */
import { rangeBaseline, categoryOf, signals } from './backtest.js'
// Its stylesheet, simcat.css, is imported by simulator.js: this file stays loadable in plain Node.

const CAT_N = 7   // categories 0..6; 6 means "six times normal or more"

/**
 * Counts per category over a run's candles, and the latest normal range.
 * `rows` are normalised candles; null or too few gives `null` -- unknown, not zero.
 */
export function catStats(rows, p) {
  if (!Array.isArray(rows) || rows.length < 12) return null
  const base = rangeBaseline(rows, p)
  const counts = Array.from({ length: CAT_N }, (_, cat) => ({ cat, green: 0, red: 0 }))
  let judged = 0
  for (let i = 0; i < rows.length; i++) {
    if (!(base[i] > 0)) continue
    judged++
    const c = counts[categoryOf(rows[i].range / base[i])]
    if (rows[i].red) c.red++; else c.green++
  }
  // The most recent normal, which is what "a category-3 candle" would mean if one closed now.
  let normal = null, px = null
  for (let i = rows.length - 1; i >= 0; i--) if (base[i] > 0) { normal = base[i]; px = rows[i].c; break }
  const sig = signals(rows, { ...p, strategy: 'range' })
  const longs = sig.filter(s => s > 0).length, shorts = sig.filter(s => s < 0).length
  return { counts, judged, normal, px, longs, shorts, candles: rows.length }
}

const money = (v, fmtPrice) => '$' + (fmtPrice ? fmtPrice(v) : (+v).toPrecision(4))
const pct = (v) => (v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '') + '%'

/**
 * The guide. `s` is catStats() or null (no candles yet); `p` the settings; `o` carries the
 * app's T, fmtPrice, the market's label and the interval. Columns call __simCatPick(k).
 */
export function catGuideHtml(s, p, o = {}) {
  const T = o.T ?? ((en) => en)
  const lo = Math.max(1, p.entryCategory | 0), hi = Math.max(lo, Math.min(6, p.entryCategoryMax ?? 6))
  const fade = p.rangeMode === 'fade'
  // The figure: one candle per category, its height its size, the band lit. Bottom-aligned so
  // the eye compares heights, with "normal" as a dashed line across all of them.
  const W = 322, H = 118, base = 92, unit = 12.5, colW = W / CAT_N
  const maxCount = s ? Math.max(1, ...s.counts.map(c => c.green + c.red)) : 1
  const cols = Array.from({ length: CAT_N }, (_, k) => {
    const cx = colW * k + colW / 2
    const h = unit * (k === 0 ? 0.6 : k + 0.5)
    const inBand = k >= lo && k <= hi
    const c = s?.counts[k]
    const n = c ? c.green + c.red : null
    // Green and red side by side: in follow mode a green one is a long, in fade mode a short.
    const bw = 7, gap = 3
    const candle = (x, col, op) => `<line x1="${x}" y1="${base - h - 6}" x2="${x}" y2="${base}" stroke="${col}" stroke-width="1.4" opacity="${op}"/>` +
      `<rect x="${x - bw / 2}" y="${base - h}" width="${bw}" height="${Math.max(2, h - 4)}" rx="1.5" fill="${col}" opacity="${op}"/>`
    const op = inBand ? 1 : 0.28
    const range = k === 0 ? T('under 1×', 'menos de 1×') : k === 6 ? T('6× or more', '6× o más') : `${k}–${k + 1}×`
    const size = s?.normal ? ` · ${T('at least', 'al menos')} ${money(s.normal * Math.max(k, 0.0001), o.fmtPrice)}` : ''
    const tip = `${T('Category', 'Categoría')} ${k}: ${range} ${T('normal', 'lo normal')}${k ? size : ''}${
      c ? ` · ${n} ${T('candles', 'velas')} (${c.green} ${T('green', 'verdes')}, ${c.red} ${T('red', 'rojas')})` : ''}`
    // A faint bar under each column: how common the category is in the run's own candles.
    const bar = c ? `<rect x="${cx - colW / 2 + 6}" y="${H - 6}" width="${(colW - 12) * Math.min(1, n / maxCount)}" height="3" rx="1.5" fill="var(--fg-2)" opacity="${inBand ? 0.7 : 0.25}"/>` : ''
    return `<g class="simcat-col${inBand ? ' on' : ''}${k === 0 ? ' zero' : ''}" data-cat="${k}"${k ? ` onclick="window.__simCatPick(${k})" role="button" tabindex="0" aria-label="${esc(tip)}"` : ''}>
      <title>${esc(tip)}</title>
      <rect x="${colW * k + 1}" y="0" width="${colW - 2}" height="${H}" rx="6" fill="${inBand ? 'var(--accent)' : 'transparent'}" opacity="${inBand ? 0.08 : 0}"/>
      ${candle(cx - gap - bw / 2 + 2, 'var(--green)', op)}${candle(cx + gap + bw / 2 - 2, 'var(--red)', op)}
      <text x="${cx}" y="${base + 12}" text-anchor="middle" class="simcat-k">${k === 0 ? '<1×' : k === 6 ? '6×+' : k + '×'}</text>
      ${bar}
    </g>`
  }).join('')
  const normalY = base - unit * 1
  const svg = `<svg class="simcat-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="${T('Candle size categories', 'Categorías de tamaño de vela')}">
    <line x1="0" x2="${W}" y1="${normalY}" y2="${normalY}" stroke="var(--fg-2)" stroke-dasharray="3 3" opacity=".55"/>
    <text x="3" y="${normalY - 4}" text-anchor="start" class="simcat-n">${T('normal', 'normal')}</text>
    ${cols}
  </svg>`

  // The table under it: one row per category in the band, with real sizes and counts.
  const lbl = o.label ? esc(o.label) : T('this market', 'este mercado')
  let facts
  if (s && s.normal) {
    const nPct = s.px ? s.normal / s.px * 100 : null
    const inBand = s.counts.filter(c => c.cat >= lo && c.cat <= hi)
    const nb = inBand.reduce((a, c) => a + c.green + c.red, 0)
    const fires = s.longs + s.shorts
    const every = fires ? Math.round(s.judged / fires) : null
    facts = `<div class="simcat-facts">
      <div>${T(`A normal ${esc(o.iv ?? '')} candle on ${lbl} is <b>${money(s.normal, o.fmtPrice)}</b> high to low${nPct != null ? ` (${pct(nPct)})` : ''} — the average of the ${p.baselineLookback || T('whole sample', 'muestra entera')} before it.`,
              `Una vela ${esc(o.iv ?? '')} normal en ${lbl} mide <b>${money(s.normal, o.fmtPrice)}</b>${nPct != null ? ` (${pct(nPct)})` : ''}.`)}</div>
      <div>${T(`Your band, <b>${lo}×${hi === 6 ? ' and up' : ` to ${hi}×`}</b>, trades candles at least <b>${money(s.normal * lo, o.fmtPrice)}</b>${nPct != null ? ` (${pct(nPct * lo)})` : ''}${hi < 6 ? ` and under ${money(s.normal * (hi + 1), o.fmtPrice)}` : ''}.`,
              `Tu banda, <b>${lo}×${hi === 6 ? ' o más' : ` a ${hi}×`}</b>, opera velas de al menos <b>${money(s.normal * lo, o.fmtPrice)}</b>.`)}</div>
      <div>${T(`In these ${s.candles.toLocaleString()} candles, <b>${nb}</b> qualified: <span style="color:var(--green)">▲ ${s.longs} long</span> · <span style="color:var(--red)">▼ ${s.shorts} short</span>${fade ? ' (faded: green ones open shorts)' : ''}${every ? ` — about one every ${every}` : ''}. Cooldown and one-at-a-time take fewer.`,
              `En estas ${s.candles.toLocaleString()} velas califican <b>${nb}</b>: ▲ ${s.longs} · ▼ ${s.shorts}.`)}</div>
    </div>`
  } else {
    facts = `<div class="simcat-facts"><div>${T(`Each candle is measured against the average size of the ones before it. Category 3 means three times that normal. Run once and this fills in with ${lbl}'s real sizes and how often each happened.`,
      `Cada vela se mide contra el tamaño medio de las anteriores. Categoría 3 = tres veces lo normal. Ejecuta una vez para ver los tamaños reales de ${lbl}.`)}</div></div>`
  }
  return `<div class="simcat">
    <div class="simcat-h"><span>${T('What each category means', 'Qué significa cada categoría')}</span><span class="simcat-hint">${T('tap a candle to start the band there', 'toca una vela para empezar la banda ahí')}</span></div>
    ${svg}
    ${facts}
  </div>`
}

/**
 * The exits, drawn. A track per side: stop to the left of the entry, target to the right,
 * each its percentage, and the ratio and break-even win rate they imply.
 */
export function levelsHtml(p, o = {}) {
  const T = o.T ?? ((en) => en)
  const sides = p.splitLevels
    ? [['long', T('Longs', 'Largos'), p.takeProfitPct, p.stopLossPct], ['short', T('Shorts', 'Cortos'), p.shortTpPct, p.shortSlPct]]
    : [['both', T('Every trade', 'Cada operación'), p.takeProfitPct, p.stopLossPct]]
  const tpOn = p.useTp !== false, slOn = p.useSl !== false
  const track = ([, name, tp, sl]) => {
    // Lengths on one scale across both sides so a 0.27% short reads shorter than a 0.9% long.
    const scale = Math.max(...sides.flatMap(s => [s[2], s[3]]), 0.01)
    const wSl = slOn ? Math.max(6, sl / scale * 46) : 46
    const wTp = tpOn ? Math.max(6, tp / scale * 46) : 46
    const rr = tpOn && slOn ? tp / sl : null
    const be = tpOn && slOn ? sl / (tp + sl) * 100 : null
    return `<div class="simlv-row">
      <div class="simlv-name">${esc(name)}</div>
      <div class="simlv-track">
        <span class="simlv-half l"><span class="simlv-seg sl${slOn ? '' : ' off'}" style="width:${wSl}%"><i>${slOn ? '−' + pct(sl) : T('no stop', 'sin stop')}</i></span></span>
        <span class="simlv-entry" title="${T('entry', 'entrada')}"></span>
        <span class="simlv-half r"><span class="simlv-seg tp${tpOn ? '' : ' off'}" style="width:${wTp}%"><i>${tpOn ? '+' + pct(tp) : T('no target', 'sin objetivo')}</i></span></span>
      </div>
      <div class="simlv-rr">${rr != null
        ? `${rr >= 1 ? rr.toFixed(rr >= 10 ? 0 : 1) + ' : 1' : '1 : ' + (1 / rr).toFixed(1)} · ${T('breaks even at', 'equilibrio con')} <b>${be.toFixed(0)}%</b> ${T('wins', 'ganadas')}`
        : !tpOn && !slOn ? T('neither level', 'ningún nivel') : !tpOn ? T('winners run until something else closes them', 'las ganadoras corren hasta que algo las cierre') : T('losers run until liquidation or another exit', 'las perdedoras corren hasta liquidación u otra salida')}</div>
    </div>`
  }
  const nothingCloses = !tpOn && !slOn && !p.useTrailing && !p.useTimeExit
  const warn = nothingCloses
    ? `<div class="simlv-warn">${T('With no target, no stop, no trailing stop and no time exit, only a liquidation or the end of the data closes a trade — most will be unresolved, and with "one at a time" on, the first trade may be the only one.',
        'Sin objetivo, stop, trailing ni salida por tiempo, solo una liquidación o el final de los datos cierran una operación.')}</div>`
    : !slOn && !p.useTrailing
      ? `<div class="simlv-warn soft">${T('No stop: a losing trade stays open until liquidation, a time exit or the end of the data.', 'Sin stop: una perdedora sigue abierta hasta liquidación, salida por tiempo o el final.')}</div>`
      : ''
  return `<div class="simlv">${sides.map(track).join('')}${warn}
    <div class="simlv-foot">${T('Before fees. A tie inside one candle follows the setting below.', 'Antes de comisiones.')}</div></div>`
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
