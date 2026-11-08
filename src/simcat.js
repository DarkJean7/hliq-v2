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
import { rangeBaseline, categoryOf, signals, catRange, CAT_COUNT, CAT_MID } from './backtest.js'
// Its stylesheet, simcat.css, is imported by simulator.js: this file stays loadable in plain Node.

const CATS = Array.from({ length: CAT_COUNT }, (_, i) => i + 1)   // 1..9, 5 = normal

/**
 * Counts per category over a run's candles, and the latest normal range.
 * `rows` are normalised candles; null or too few gives `null` -- unknown, not zero.
 * `counts[k - 1]` is category k.
 */
export function catStats(rows, p) {
  if (!Array.isArray(rows) || rows.length < 12) return null
  const base = rangeBaseline(rows, p)
  const counts = CATS.map(cat => ({ cat, green: 0, red: 0 }))
  let judged = 0
  for (let i = 0; i < rows.length; i++) {
    if (!(base[i] > 0)) continue
    judged++
    const c = counts[categoryOf(rows[i].range / base[i]) - 1]
    if (rows[i].red) c.red++; else c.green++
  }
  // The most recent normal, which is what "a category-8 candle" would mean if one closed now.
  let normal = null, px = null
  for (let i = rows.length - 1; i >= 0; i--) if (base[i] > 0) { normal = base[i]; px = rows[i].c; break }
  const sig = signals(rows, { ...p, strategy: 'range' })
  const longs = sig.filter(s => s > 0).length, shorts = sig.filter(s => s < 0).length
  return { counts, judged, normal, px, longs, shorts, candles: rows.length }
}

const isMedian = (p) => p.baselineKind === 'median'
const band = (p) => {
  const lo = Math.max(1, Math.min(CAT_COUNT, (p.entryCategory | 0) || 1))
  return [lo, Math.max(lo, Math.min(CAT_COUNT, p.entryCategoryMax ?? CAT_COUNT))]
}
// A multiple as people say it: .2, ⅓, ½, 1.25.
const mx = (m) => m === 1 / 3 ? '⅓' : m === 0.5 ? '½' : String(+m.toFixed(2)).replace(/^0\./, '.')
/** "0.8–1.25×", "5× and up", "under .2×" */
export function catLabel(k, T = (en) => en) {
  const [a, b] = catRange(k)
  return k === 1 ? T(`under ${mx(b)}×`, `menos de ${mx(b)}×`) : b == null ? T(`${mx(a)}× and up`, `${mx(a)}× o más`) : `${mx(a)}–${mx(b)}×`
}

const money = (v, fmtPrice) => '$' + (fmtPrice ? fmtPrice(v) : (+v).toPrecision(4))
const pct = (v) => (v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '') + '%'

/**
 * The guide. `s` is catStats() or null (no candles yet); `p` the settings; `o` carries the
 * app's T, fmtPrice, the market's label and the interval. Every column calls __simCatPick(k).
 */
export function catGuideHtml(s, p, o = {}) {
  const T = o.T ?? ((en) => en)
  const [lo, hi] = band(p)
  const fade = p.rangeMode === 'fade'
  // The figure: one candle per category, heights stepping evenly -- the edges grow by a
  // ratio, so even steps are a log scale, and a fifth-of-normal candle is still visible.
  // Bottom-aligned so the eye compares heights; "normal" is a dashed line at the middle one.
  const W = 322, H = 144, base = 86, colW = W / CAT_COUNT
  const hOf = (k) => 5 + (k - 1) * 9
  const maxCount = s ? Math.max(1, ...s.counts.map(c => c.green + c.red)) : 1
  const word = isMedian(p) ? T('the median', 'la mediana') : T('normal', 'lo normal')
  const cols = CATS.map((k, i) => {
    const cx = colW * i + colW / 2
    const h = hOf(k)
    const inBand = k >= lo && k <= hi
    const c = s?.counts[i]
    const n = c ? c.green + c.red : null
    // Green and red side by side: in follow mode a green one is a long, in fade mode a short.
    const bw = 6, gap = 2.5
    const candle = (x, col, op) => `<line x1="${x}" y1="${base - h - 5}" x2="${x}" y2="${base}" stroke="${col}" stroke-width="1.3" opacity="${op}"/>` +
      `<rect x="${x - bw / 2}" y="${base - h}" width="${bw}" height="${Math.max(2, h - 3)}" rx="1.5" fill="${col}" opacity="${op}"/>`
    const op = inBand ? 1 : 0.28
    const [a] = catRange(k)
    const size = s?.normal ? (k === 1 ? ` · ${T('under', 'menos de')} ${money(s.normal * catRange(1)[1], o.fmtPrice)}` : ` · ${T('from', 'desde')} ${money(s.normal * a, o.fmtPrice)}`) : ''
    const tip = `${T('Category', 'Categoría')} ${k}${k === CAT_MID ? ' (' + T('normal', 'normal') + ')' : ''}: ${catLabel(k, T)} ${word}${size}${
      c ? ` · ${n} ${T('candles', 'velas')} (${c.green} ${T('green', 'verdes')}, ${c.red} ${T('red', 'rojas')})` : ''}`
    // A faint bar under each column: how common the category is in the run's own candles.
    const bar = c ? `<rect x="${cx - colW / 2 + 4}" y="${H - 5}" width="${(colW - 8) * Math.min(1, n / maxCount)}" height="3" rx="1.5" fill="var(--fg-2)" opacity="${inBand ? 0.7 : 0.25}"/>` : ''
    return `<g class="simcat-col${inBand ? ' on' : ''}${k === CAT_MID ? ' mid' : ''}" data-cat="${k}" onclick="window.__simCatPick(${k})" role="button" tabindex="0" aria-label="${esc(tip)}">
      <title>${esc(tip)}</title>
      <rect x="${colW * i + 1}" y="0" width="${colW - 2}" height="${H}" rx="6" fill="${inBand ? 'var(--accent)' : 'transparent'}" opacity="${inBand ? 0.08 : 0}"/>
      ${candle(cx - gap - bw / 2 + 2, 'var(--green)', op)}${candle(cx + gap + bw / 2 - 2, 'var(--red)', op)}
      <text x="${cx}" y="${base + 12}" text-anchor="middle" class="simcat-k">${k}</text>
      <text x="${cx}" y="${base + 22}" text-anchor="middle" class="simcat-r">${k === 1 ? '<' + mx(catRange(1)[1]) : mx(a) + (k === CAT_COUNT ? '+' : '')}×</text>
      ${c ? `<text x="${cx}" y="${base + 34}" text-anchor="middle" class="simcat-c">${n.toLocaleString()}</text>` : ''}
      ${bar}
    </g>`
  }).join('')
  const midX = colW * (CAT_MID - 1)
  const normalY = base - hOf(CAT_MID) + 2
  const svg = `<svg class="simcat-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="group" aria-label="${T('Candle size categories', 'Categorías de tamaño de vela')}">
    <line x1="0" x2="${W}" y1="${normalY}" y2="${normalY}" stroke="var(--fg-2)" stroke-dasharray="3 3" opacity=".45"/>
    <text x="${midX + colW / 2}" y="9" text-anchor="middle" class="simcat-n">${isMedian(p) ? T('median', 'mediana') : T('average', 'media')}</text>
    ${cols}
  </svg>`

  const lbl = o.label ? esc(o.label) : T('this market', 'este mercado')
  const bandTxt = lo === hi ? `${T('category', 'categoría')} ${lo}` : `${T('categories', 'categorías')} ${lo}–${hi}`
  const [bLo] = catRange(lo), [, bHi] = catRange(hi)
  const bandMult = lo === 1 && bHi == null ? T('every candle', 'todas las velas')
    : lo === 1 ? T(`under ${mx(bHi)}× normal`, `menos de ${mx(bHi)}×`)
    : bHi == null ? T(`${mx(bLo)}× normal and up`, `${mx(bLo)}× o más`) : `${mx(bLo)}–${mx(bHi)}× ${T('normal', 'lo normal')}`
  let facts
  if (s && s.normal) {
    const nPct = s.px ? s.normal / s.px * 100 : null
    const nb = s.counts.filter(c => c.cat >= lo && c.cat <= hi).reduce((a, c) => a + c.green + c.red, 0)
    const fires = s.longs + s.shorts
    const every = fires ? Math.round(s.judged / fires) : null
    const share = (f) => s.judged ? s.counts.filter(c => f(c.cat)).reduce((a, c) => a + c.green + c.red, 0) / s.judged * 100 : 0
    const below = share(k => k < CAT_MID), mid = share(k => k === CAT_MID), above = share(k => k > CAT_MID)
    const of = p.baselineLookback ? T(`the ${p.baselineLookback} candles before it`, `las ${p.baselineLookback} velas anteriores`) : T('the whole sample', 'la muestra entera')
    const range = (a, b) => b == null ? T(`of at least <b>${money(s.normal * a, o.fmtPrice)}</b>`, `de al menos <b>${money(s.normal * a, o.fmtPrice)}</b>`)
      : a === 0 ? T(`under <b>${money(s.normal * b, o.fmtPrice)}</b>`, `de menos de <b>${money(s.normal * b, o.fmtPrice)}</b>`)
      : T(`from <b>${money(s.normal * a, o.fmtPrice)}</b> to under ${money(s.normal * b, o.fmtPrice)}`, `de <b>${money(s.normal * a, o.fmtPrice)}</b> a ${money(s.normal * b, o.fmtPrice)}`)
    facts = `<div class="simcat-facts">
      <div>${isMedian(p)
        ? T(`A normal ${esc(o.iv ?? '')} candle on ${lbl} is <b>${money(s.normal, o.fmtPrice)}</b> high to low${nPct != null ? ` (${pct(nPct)})` : ''} — the <b>median</b> of ${of}: the middle one, half smaller and half bigger. That is category <b>5</b>.`,
            `Una vela ${esc(o.iv ?? '')} normal en ${lbl} mide <b>${money(s.normal, o.fmtPrice)}</b>${nPct != null ? ` (${pct(nPct)})` : ''} — la <b>mediana</b> de ${of}. Es la categoría <b>5</b>.`)
        : T(`A normal ${esc(o.iv ?? '')} candle on ${lbl} is <b>${money(s.normal, o.fmtPrice)}</b> high to low${nPct != null ? ` (${pct(nPct)})` : ''} — the <b>average</b> of ${of}. That is category <b>5</b>.`,
            `Una vela ${esc(o.iv ?? '')} normal en ${lbl} mide <b>${money(s.normal, o.fmtPrice)}</b>${nPct != null ? ` (${pct(nPct)})` : ''} — la <b>media</b> de ${of}. Es la categoría <b>5</b>.`)}</div>
      <div>${T(`<b>${pct(below)}</b> smaller than normal (1–4) · <b>${pct(mid)}</b> normal (5) · <b>${pct(above)}</b> bigger (6–9).${isMedian(p) ? '' : ' A few huge candles pull the average up, so more sit below it; switch "Normal is the" to Median to centre it.'}`,
              `<b>${pct(below)}</b> más pequeñas (1–4) · <b>${pct(mid)}</b> normales (5) · <b>${pct(above)}</b> más grandes (6–9).`)}</div>
      <div>${T(`Your band, <b>${bandTxt}</b> (${bandMult}), trades candles ${range(bLo, bHi)}.`,
              `Tu banda, <b>${bandTxt}</b> (${bandMult}), opera velas ${range(bLo, bHi)}.`)}</div>
      <div>${T(`In these ${s.candles.toLocaleString()} candles, <b>${nb}</b> qualified: <span style="color:var(--green)">▲ ${s.longs} long</span> · <span style="color:var(--red)">▼ ${s.shorts} short</span>${fade ? ' (faded: green ones open shorts)' : ''}${every ? ` — about one every ${every}` : ''}. Cooldown and one-at-a-time take fewer.`,
              `En estas ${s.candles.toLocaleString()} velas califican <b>${nb}</b>: ▲ ${s.longs} · ▼ ${s.shorts}.`)}</div>
    </div>`
  } else {
    facts = `<div class="simcat-facts"><div>${T(`Each candle is measured against the ${isMedian(p) ? 'median' : 'average'} size of the ones before it and put in one of nine categories: <b>5</b> is normal, 1–4 smaller, 6–9 bigger (8 is three to five times normal). Your band is <b>${bandTxt}</b> (${bandMult}). Run once and this fills in with ${lbl}'s real sizes and how often each happened.`,
      `Cada vela se mide contra el tamaño de las anteriores y cae en una de nueve categorías: <b>5</b> es lo normal, 1–4 más pequeñas, 6–9 más grandes. Ejecuta una vez para ver los tamaños reales de ${lbl}.`)}</div></div>`
  }
  return `<div class="simcat">
    <div class="simcat-h"><span>${T('What each category means', 'Qué significa cada categoría')}</span><span class="simcat-hint">${T('tap any candle to start the band there', 'toca una vela para empezar la banda ahí')}</span></div>
    ${svg}
    ${s ? catTableHtml(s, p, o) : ''}
    ${facts}
  </div>`
}

/**
 * The last run's trades, per category of the candle that opened each: how many, how many won
 * and lost (an unresolved trade is neither), and what they made. Null without trades that
 * carry a category -- another strategy's run, or none -- which is unknown, not zero.
 */
export function catTradeStats(trades) {
  const withCat = (trades ?? []).filter(t => Number.isFinite(t?.cat))
  if (!withCat.length) return null
  const out = CATS.map(cat => ({ cat, n: 0, won: 0, lost: 0, pnl: 0 }))
  for (const t of withCat) {
    const c = out[Math.max(1, Math.min(CAT_COUNT, Math.abs(t.cat))) - 1]
    c.n++
    if (t.outcome === 'win') c.won++
    else if (t.outcome === 'loss') c.lost++
    else if (t.outcome === 'timeout' && t.exitPx != null) {
      const up = t.side === 'long' ? t.exitPx > t.entry : t.exitPx < t.entry
      if (up) c.won++; else c.lost++
    }
    if (Number.isFinite(t.delta)) c.pnl += t.delta
  }
  return out
}

/**
 * Two tables, each narrow enough for the settings column, so nothing hides off to the side.
 *
 *   How many of each   every category: the smallest candle in it, green and red counts, the
 *                      total, and its share of the candles judged.
 *   What they did      after a Range run: per category of the candle that opened each trade,
 *                      how many, won and lost, win rate, and PnL. The question the counts
 *                      raise is "and which of these made money" -- this answers it.
 *
 * One table of nine columns was tried first; in the desktop settings column it scrolled the
 * trade figures out of view, which is where the answer was.
 */
function catTableHtml(s, p, o) {
  const T = o.T ?? ((en) => en)
  const [lo, hi] = band(p)
  const ts = catTradeStats(o.trades)
  const usd = (v) => money(v, o.fmtPrice)
  const signed = (v) => (v >= 0 ? '+' : '−') + '$' + Math.abs(v).toFixed(2)
  const pc = (v) => v >= 10 ? v.toFixed(0) : v >= 1 ? v.toFixed(1) : v > 0 ? v.toFixed(2) : '0'
  const kCell = (cat, inBand) => `<td class="k">${cat}${inBand ? ' <i>●</i>' : ''}</td>`
  const rowAttrs = (cat, inBand) => `class="${inBand ? 'on' : ''}${cat === CAT_MID ? ' mid' : ''}" onclick="window.__simCatPick(${cat})"`

  const rows = s.counts.map(c => {
    const n = c.green + c.red
    const share = s.judged ? n / s.judged * 100 : 0
    const inBand = c.cat >= lo && c.cat <= hi
    // The floor alone: the next row's floor is this one's ceiling, so a range would say it twice.
    const [a, b] = catRange(c.cat)
    const size = s.normal ? (c.cat === 1 ? `< ${usd(s.normal * b)}` : `${usd(s.normal * a)}`) : '—'
    return `<tr ${rowAttrs(c.cat, inBand)} title="${esc(catLabel(c.cat, T) + ' ' + T('normal', 'lo normal'))}">
      ${kCell(c.cat, inBand)}
      <td class="sz">${size}</td>
      <td class="g">${c.green.toLocaleString()}</td>
      <td class="r">${c.red.toLocaleString()}</td>
      <td class="n">${n.toLocaleString()}</td>
      <td class="sh"><span class="simcat-shbar"><i style="width:${Math.min(100, share).toFixed(1)}%"></i></span>${pc(share)}%</td>
    </tr>`
  }).join('')
  const tot = s.counts.reduce((a, c) => ({ g: a.g + c.green, r: a.r + c.red }), { g: 0, r: 0 })
  const counts = `<div class="simcat-tbl" data-dragscroll data-tbl="counts">
    <table>
      <thead><tr>
        <th>${T('Cat', 'Cat')}</th><th>${T('From', 'Desde')}</th>
        <th class="g">▲ ${T('Green', 'Verdes')}</th><th class="r">▼ ${T('Red', 'Rojas')}</th>
        <th>${T('Total', 'Total')}</th><th>${T('Share', 'Parte')}</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td></td><td>${T('judged', 'medidas')}</td><td class="g">${tot.g.toLocaleString()}</td><td class="r">${tot.r.toLocaleString()}</td><td class="n">${s.judged.toLocaleString()}</td><td>100%</td></tr></tfoot>
    </table>
  </div>`

  let trades = `<div class="simcat-note">${T('Run it and a second table shows what the trades from each category did.', 'Ejecuta y una segunda tabla muestra qué hicieron las operaciones de cada categoría.')}</div>`
  if (ts) {
    // Categories with trades, plus any in the band that had none -- "0 trades" is an answer too.
    const shown = ts.filter(c => c.n > 0 || (c.cat >= lo && c.cat <= hi))
    const all = ts.reduce((a, c) => ({ n: a.n + c.n, won: a.won + c.won, lost: a.lost + c.lost, pnl: a.pnl + c.pnl }), { n: 0, won: 0, lost: 0, pnl: 0 })
    const wr = (c) => c.won + c.lost ? (c.won / (c.won + c.lost) * 100).toFixed(0) + '%' : '—'
    const tone = (c) => c.n ? (c.pnl >= 0 ? 'g' : 'r') : ''
    trades = `<div class="simcat-sub">${T('What the last run\'s trades did, by the candle that opened them', 'Qué hicieron las operaciones de la última ejecución, por la vela que las abrió')}</div>
    <div class="simcat-tbl" data-dragscroll data-tbl="trades">
      <table>
        <thead><tr>
          <th>${T('Cat', 'Cat')}</th><th>${T('Trades', 'Ops')}</th><th class="g">${T('Won', 'Gan.')}</th><th class="r">${T('Lost', 'Perd.')}</th>
          <th>${T('Win rate', 'Aciertos')}</th><th>${T('PnL', 'PnL')}</th>
        </tr></thead>
        <tbody>${shown.map(c => {
          const inBand = c.cat >= lo && c.cat <= hi
          return `<tr ${rowAttrs(c.cat, inBand)}>
            ${kCell(c.cat, inBand)}
            <td class="n">${c.n}</td><td class="g">${c.won}</td><td class="r">${c.lost}</td>
            <td>${wr(c)}</td><td class="${tone(c)}">${c.n ? signed(c.pnl) : '—'}</td>
          </tr>`
        }).join('')}</tbody>
        <tfoot><tr><td></td><td class="n">${all.n}</td><td class="g">${all.won}</td><td class="r">${all.lost}</td><td>${wr(all)}</td><td class="${tone(all)}">${signed(all.pnl)}</td></tr></tfoot>
      </table>
    </div>`
  }
  return `<div class="simcat-sub">${T('How many of each', 'Cuántas de cada una')}</div>
  ${counts}
  ${s.candles > s.judged ? `<div class="simcat-note">${T(`The first ${(s.candles - s.judged).toLocaleString()} candles have too little history before them to judge.`, `Las primeras ${(s.candles - s.judged).toLocaleString()} velas no tienen historia suficiente.`)}</div>` : ''}
  ${trades}`
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
