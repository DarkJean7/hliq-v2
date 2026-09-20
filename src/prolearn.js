/**
 * INSOLVENT TERMINAL — "About Order Types"
 *
 * The explainer behind the Pro list's "Learn More". Pick a type on the left, see what it
 * does on the right: Hyperliquid's own definition, what this terminal does to produce it, a
 * drawing of it happening, and a button that closes the modal with that type selected.
 *
 * Why a drawing. Every one of these types is a statement about WHEN an order exists — a stop
 * does not exist until price reaches it, a scale exists at five prices at once, a chase
 * exists at a price that keeps changing. That is a hard thing to say in a sentence and an
 * easy thing to show on a chart, which is why Hyperliquid draws it too.
 *
 * The candles are fixed, made-up data. They are the same for every type on purpose: the only
 * thing that changes between panels is the annotation, so the difference between a Stop
 * Market and a Take Market is the only thing moving on screen.
 *
 * Everything here reads the catalogue in src/protypes.js. Nothing in this file decides what
 * an order type IS — if the copy here and the order that gets placed ever disagree, it is
 * because someone edited one of the two files and not the other, and the catalogue is the
 * one that wins.
 */
import { ORDER_TYPES, byId, TIFS, TWAP } from './protypes.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))

/** What the modal is currently showing. */
let _sel  = 'market'
let _long = true
/** Handed in by the ticket: "the user pressed Place a … Order". */
let _onPick = null

// ─── THE CANDLES ──────────────────────────────────────────────────────────────
// [open, high, low, close]. A rally, a pullback, a recovery — enough shape that a trigger
// above, a trigger below and a trailing high-water mark all have somewhere to point.
const CANDLES = [
  [100.0, 100.6,  99.4,  99.6],
  [ 99.6, 100.2,  98.6,  98.9],
  [ 98.9,  99.4,  98.2,  99.1],
  [ 99.1, 100.4,  98.9, 100.2],
  [100.2, 102.2, 100.0, 101.9],
  [101.9, 103.4, 101.5, 103.0],
  [103.0, 103.6, 101.9, 102.2],
  [102.2, 102.8, 100.8, 101.0],
  [101.0, 101.6,  99.4,  99.8],
  [ 99.8, 100.2,  97.8,  98.2],
  [ 98.2,  99.0,  97.2,  98.7],
  [ 98.7, 100.6,  98.5, 100.3],
  [100.3, 101.8, 100.1, 101.4],
  [101.4, 102.6, 101.0, 102.3],
]
const LO = 96.4, HI = 104.4        // a little padding either side so labels have room
const W = 520, H = 200, PAD_L = 10, PAD_R = 92

/**
 * The annotation for one type, as prices and candle indices.
 *
 * `long` is the buy-side drawing. A short flips it: the level that sat above the market
 * moves below it and vice versa, which is exactly the thing people get wrong about stops.
 * `mirror(p)` reflects a price through the middle of the range to do that.
 */
const mirror = (p) => Math.round(((LO + HI) - p) * 100) / 100

function spec(id, isLong) {
  const m = isLong ? (p => p) : (p => mirror(p))
  switch (id) {
    case 'market':
      return {
        badge: { i: 8, text: 'Market order placed' },
        levels: [{ v: m(99.8), label: 'Order filled', kind: 'fill' }],
        mark: { i: 8, v: m(99.8) },
      }
    case 'limit':
      return {
        badge: { i: 3, text: 'Limit order placed' },
        levels: [{ v: m(98.2), label: 'Limit price', kind: 'order' }],
        mark: { i: 9, v: m(98.2) },
        foot: 'Rests at your price until the market comes to it.',
      }
    case 'chase':
      return {
        badge: { i: 2, text: 'Chase started' },
        chase: [m(99.0), m(99.6), m(100.6), m(101.6), m(101.0), m(99.9), m(98.6)],
        mark: { i: 10, v: m(98.6) },
        foot: 'The order is cancelled and replaced as the top of the book moves.',
      }
    case 'scale':
      return {
        badge: { i: 2, text: '5 limit orders placed' },
        levels: [100.4, 99.8, 99.2, 98.6, 98.0].map((v, k) => ({ v: m(v), label: k === 0 ? 'Range' : '', kind: 'order' })),
        fills: [{ i: 4, v: m(100.4) }, { i: 9, v: m(99.8) }, { i: 9, v: m(99.2) }, { i: 10, v: m(98.6) }],
        foot: 'Rungs the market never reaches simply stay resting.',
      }
    case 'stopLimit':
      return {
        levels: [
          { v: m(102.6), label: 'Trigger', kind: 'trigger' },
          { v: m(102.2), label: 'Limit',   kind: 'order' },
        ],
        badge: { i: 3, text: 'Waiting — nothing on the book' },
        mark: { i: 5, v: m(102.2) },
        foot: 'Price can gap past the limit and leave you unfilled.',
      }
    case 'stopMarket':
      return {
        levels: [{ v: m(102.6), label: 'Trigger', kind: 'trigger' }],
        badge: { i: 3, text: 'Waiting — nothing on the book' },
        mark: { i: 5, v: m(102.8) },
        foot: 'Fills at whatever the book offers once it triggers.',
      }
    case 'takeLimit':
      return {
        levels: [
          { v: m(98.0), label: 'Trigger', kind: 'trigger' },
          { v: m(98.4), label: 'Limit',   kind: 'order' },
        ],
        badge: { i: 3, text: 'Waiting — nothing on the book' },
        mark: { i: 10, v: m(98.4) },
        foot: 'Arms on a move in your favour, not against you.',
      }
    case 'takeMarket':
      return {
        levels: [{ v: m(98.0), label: 'Trigger', kind: 'trigger' }],
        badge: { i: 3, text: 'Waiting — nothing on the book' },
        mark: { i: 10, v: m(97.8) },
        foot: 'Arms on a move in your favour, not against you.',
      }
    case 'trailingStop':
      return {
        trail: true,
        badge: { i: 2, text: 'Trailing 2% behind the high' },
        mark: { i: 9, v: m(101.3) },
        foot: 'The stop follows the high and never moves back down.',
      }
    case 'twap':
      return {
        badge: { i: 1, text: 'TWAP started' },
        slices: [2, 4, 6, 8, 10, 12],
        foot: `One suborder every ${TWAP.SUB_SECONDS} seconds until the window is done.`,
      }
    default:
      return {}
  }
}

// ─── THE DRAWING ──────────────────────────────────────────────────────────────

const yOf = (v) => H - ((v - LO) / (HI - LO)) * H
const xOf = (i) => PAD_L + (i + 0.5) * ((W - PAD_L - PAD_R) / CANDLES.length)
const bodyW = Math.max(5, ((W - PAD_L - PAD_R) / CANDLES.length) * 0.56)

function candlesSvg() {
  return CANDLES.map(([o, h, l, c], i) => {
    const up = c >= o
    const col = up ? 'var(--green,#2ebd85)' : 'var(--red,#f6465d)'
    const x = xOf(i)
    const yh = yOf(h), yl = yOf(l)
    const yo = yOf(o), yc = yOf(c)
    const top = Math.min(yo, yc)
    const hgt = Math.max(1.5, Math.abs(yc - yo))
    return `<line x1="${x}" y1="${yh}" x2="${x}" y2="${yl}" stroke="${col}" stroke-width="1.2"/>`
         + `<rect x="${x - bodyW / 2}" y="${top}" width="${bodyW}" height="${hgt}" rx="1" fill="${col}"/>`
  }).join('')
}

function levelSvg({ v, label, kind }) {
  const y = yOf(v)
  const col = kind === 'trigger' ? 'var(--red,#f6465d)'
            : kind === 'fill'    ? 'var(--accent,#00e5a0)'
            : 'var(--fg-2,#9aa4b2)'
  const line = `<line x1="${PAD_L}" y1="${y}" x2="${W - PAD_R}" y2="${y}" stroke="${col}" stroke-width="1" stroke-dasharray="3 3" opacity=".85"/>`
  if (!label) return line
  return line + `<rect x="${W - PAD_R + 6}" y="${y - 9}" width="${PAD_R - 12}" height="18" rx="5" fill="${col}" opacity=".16"/>`
    + `<text x="${W - PAD_R + 6 + (PAD_R - 12) / 2}" y="${y + 4}" text-anchor="middle" font-size="10.5" font-weight="700" fill="${col}">${esc(label)}</text>`
}

function markSvg({ i, v }, isLong) {
  const x = xOf(i), y = yOf(v)
  const col = isLong ? 'var(--green,#2ebd85)' : 'var(--red,#f6465d)'
  return `<circle cx="${x}" cy="${y}" r="8" fill="${col}"/>`
       + `<text x="${x}" y="${y + 3.6}" text-anchor="middle" font-size="9.5" font-weight="800" fill="#06110c">${isLong ? 'B' : 'S'}</text>`
}

function badgeSvg({ i, text }) {
  // Kept inside the plot: a badge that runs off the right edge is a badge nobody can read.
  const w = Math.min(190, 7 * text.length + 18)
  const x = Math.max(PAD_L, Math.min(xOf(i) - w / 2, W - PAD_R - w))
  return `<rect x="${x}" y="6" width="${w}" height="20" rx="6" fill="var(--panel-3,#20262e)"/>`
       + `<text x="${x + w / 2}" y="20" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--fg,#e6edf3)">${esc(text)}</text>`
}

/** The chase order's price over time: a line that follows the market without touching it. */
function chaseSvg(prices, isLong) {
  const pts = prices.map((p, k) => `${xOf(k + 2)},${yOf(p)}`).join(' ')
  const col = 'var(--accent,#00e5a0)'
  return `<polyline points="${pts}" fill="none" stroke="${col}" stroke-width="1.6" stroke-dasharray="4 3"/>`
       + prices.map((p, k) => `<circle cx="${xOf(k + 2)}" cy="${yOf(p)}" r="2.4" fill="${col}"/>`).join('')
       + `<text x="${xOf(2)}" y="${yOf(prices[0]) + (isLong ? 15 : -8)}" font-size="10" font-weight="700" fill="${col}">re-priced</text>`
}

/**
 * The trailing stop's ratchet.
 *
 * Drawn as a staircase under the highs, because a staircase is the mechanism: it steps up
 * when a new high is made and stays flat through every pullback. A smooth line following
 * price would draw a stop that moves DOWN, which is the one thing a trailing stop never does.
 */
function trailSvg(isLong) {
  const dist = 2.2
  let best = isLong ? -Infinity : Infinity
  const stops = CANDLES.map(([, h, l]) => {
    best = isLong ? Math.max(best, h) : Math.min(best, l)
    return isLong ? best - dist : best + dist
  })
  let d = ''
  stops.forEach((s, i) => {
    const x0 = xOf(i) - bodyW, x1 = xOf(i) + bodyW
    d += (i === 0 ? `M ${x0} ${yOf(s)}` : ` L ${x0} ${yOf(s)}`) + ` L ${x1} ${yOf(s)}`
  })
  const col = 'var(--red,#f6465d)'
  return `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.6"/>`
       + `<text x="${xOf(0)}" y="${yOf(stops[0]) + (isLong ? 14 : -7)}" font-size="10" font-weight="700" fill="${col}">stop</text>`
}

/** TWAP: one small fill marker per suborder, spread evenly across the window. */
function slicesSvg(idxs, isLong) {
  const col = isLong ? 'var(--green,#2ebd85)' : 'var(--red,#f6465d)'
  return idxs.map(i => {
    const [, , , c] = CANDLES[i]
    return `<circle cx="${xOf(i)}" cy="${yOf(c)}" r="4.5" fill="${col}" opacity=".9"/>`
  }).join('')
    + `<text x="${xOf(idxs[0])}" y="${H - 6}" font-size="10" font-weight="700" fill="var(--muted,#7d8794)">suborders, every ${TWAP.SUB_SECONDS}s</text>`
}

function diagramSvg(id, isLong) {
  const s = spec(id, isLong)
  const parts = [
    `<rect x="0" y="0" width="${W}" height="${H}" fill="none"/>`,
    `<line x1="${PAD_L}" y1="${H - 1}" x2="${W - PAD_R}" y2="${H - 1}" stroke="var(--border,#2a2e39)" stroke-width="1"/>`,
    `<line x1="${PAD_L}" y1="0" x2="${PAD_L}" y2="${H - 1}" stroke="var(--border,#2a2e39)" stroke-width="1"/>`,
    ...(s.levels ?? []).map(levelSvg),
    s.trail  ? trailSvg(isLong)          : '',
    candlesSvg(),
    s.chase  ? chaseSvg(s.chase, isLong) : '',
    s.slices ? slicesSvg(s.slices, isLong) : '',
    ...(s.fills ?? []).map(f => markSvg(f, isLong)),
    s.mark   ? markSvg(s.mark, isLong)   : '',
    s.badge  ? badgeSvg(s.badge)         : '',
  ]
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="200" role="img"
    aria-label="${esc(byId(id)?.label ?? '')} order, drawn on a price chart"
    style="overflow:visible">${parts.join('')}</svg>`
    + (s.foot ? `<div style="margin-top:10px;font-size:12.5px;color:var(--muted)">${esc(s.foot)}</div>` : '')
}

// ─── THE MODAL ────────────────────────────────────────────────────────────────

const OVERLAY_ID = 'proLearnOverlay'

function paint() {
  const body = document.getElementById('proLearnBody')
  const nav  = document.getElementById('proLearnNav')
  if (!body || !nav) return
  const t = byId(_sel) ?? ORDER_TYPES[0]
  const side = _long ? 'long' : 'short'

  nav.querySelectorAll('[data-lt]').forEach(el => {
    const on = el.dataset.lt === _sel
    el.style.color      = on ? 'var(--fg)' : 'var(--muted)'
    el.style.fontWeight = on ? '700' : '500'
    el.style.background = on ? 'var(--panel-3)' : 'transparent'
  })

  const tifRows = t.fields.includes('tif')
    ? `<div style="margin-top:14px;display:flex;flex-direction:column;gap:6px">
         ${TIFS.map(x => `<div style="font-size:12.5px;color:var(--fg-2)"><b style="color:var(--fg)">${esc(x.label)}</b> · ${esc(x.name)} — ${esc(x.desc)}</div>`).join('')}
       </div>`
    : ''

  body.innerHTML = `
    <div style="display:flex;gap:4px;background:var(--panel-2);border-radius:10px;padding:4px;margin-bottom:14px">
      <button data-ls="long"  style="flex:1;padding:9px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;background:${_long ? 'var(--green)' : 'transparent'};color:${_long ? '#06110c' : 'var(--muted)'}">Long</button>
      <button data-ls="short" style="flex:1;padding:9px;border:none;border-radius:8px;cursor:pointer;font-size:13px;font-weight:700;background:${!_long ? 'var(--red)' : 'transparent'};color:${!_long ? '#fff' : 'var(--muted)'}">Short</button>
    </div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px">
      ${(t.tags ?? []).map(x => `<span style="font-size:11px;font-weight:600;color:var(--fg-2);background:var(--panel-2);border-radius:6px;padding:4px 9px">${esc(x)}</span>`).join('')}
      ${t.native === false ? `<span style="font-size:11px;font-weight:600;color:var(--accent);background:color-mix(in oklch,var(--accent) 14%,transparent);border-radius:6px;padding:4px 9px">Managed for you</span>` : ''}
    </div>
    <div style="font-size:14px;line-height:1.5;color:var(--fg);margin-bottom:16px">${esc(t.blurb(side))}</div>
    <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:14px 12px 12px">
      ${diagramSvg(t.id, _long)}
    </div>
    <div style="margin-top:16px;font-size:12.5px;line-height:1.6;color:var(--fg-2)">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--muted);margin-bottom:5px">HYPERLIQUID DEFINES IT AS</div>
      ${esc(t.doc)}
    </div>
    <div style="margin-top:12px;font-size:12.5px;line-height:1.6;color:var(--fg-2)">
      <div style="font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--muted);margin-bottom:5px">HOW THIS TERMINAL DOES IT</div>
      ${esc(t.how)}
    </div>
    ${t.liveness ? `<div style="margin-top:12px;font-size:12.5px;color:var(--accent)">${esc(t.liveness)}</div>` : ''}
    ${tifRows}
    <div style="margin-top:16px;font-size:12.5px;color:var(--muted)">${esc(t.note)}</div>
    <button id="proLearnUse" style="width:100%;margin-top:18px;padding:13px;border:none;border-radius:11px;cursor:pointer;font-size:14px;font-weight:700;background:${_long ? 'var(--green)' : 'var(--red)'};color:${_long ? '#06110c' : '#fff'}">Place a ${esc(t.label)} Order</button>
  `

  body.querySelectorAll('[data-ls]').forEach(b => b.onclick = () => { _long = b.dataset.ls === 'long'; paint() })
  const use = document.getElementById('proLearnUse')
  if (use) use.onclick = () => { close(); _onPick?.(t.id, _long) }
}

function ensureModal() {
  let ov = document.getElementById(OVERLAY_ID)
  if (ov) return ov
  ov = document.createElement('div')
  ov.id = OVERLAY_ID
  ov.style.cssText = 'position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;'
    + 'background:rgba(0,0,0,.66);backdrop-filter:blur(3px);padding:16px'
  ov.innerHTML = `
    <div id="proLearnCard" role="dialog" aria-modal="true" aria-label="About order types"
         style="width:min(904px,100%);max-height:min(92vh,760px);display:flex;flex-direction:column;
                background:var(--panel);border:1px solid var(--border);border-radius:18px;overflow:hidden">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;padding:22px 22px 12px">
        <div style="font-size:21px;font-weight:700">About Order Types</div>
        <button id="proLearnX" aria-label="Close"
          style="background:none;border:none;color:var(--muted);font-size:22px;line-height:1;cursor:pointer;padding:0 2px">&times;</button>
      </div>
      <div id="proLearnSplit" style="display:flex;gap:0;min-height:0;flex:1">
        <div id="proLearnNav" data-dragscroll
             style="flex:0 0 168px;border-right:1px solid var(--border);padding:4px 10px 18px 14px;overflow-y:auto"></div>
        <div id="proLearnBody" style="flex:1;min-width:0;padding:4px 22px 22px;overflow-y:auto"></div>
      </div>
    </div>`
  document.body.appendChild(ov)

  ov.querySelector('#proLearnX').onclick = close
  ov.addEventListener('click', e => { if (e.target === ov) close() })

  const nav = ov.querySelector('#proLearnNav')
  nav.innerHTML = ORDER_TYPES.map(t => `
    <div data-lt="${t.id}" role="button" tabindex="0"
         style="padding:9px 10px;border-radius:8px;font-size:13.5px;cursor:pointer;white-space:nowrap">${esc(t.label)}</div>`).join('')
  nav.querySelectorAll('[data-lt]').forEach(el => {
    el.onclick = () => { _sel = el.dataset.lt; paint() }
    el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() } }
  })

  // Narrow screens get the type list as a scrolling chip row above the panel rather than a
  // 168px column that would leave the explanation about eighty pixels wide.
  const applyLayout = () => {
    const narrow = window.innerWidth < 720
    const split = ov.querySelector('#proLearnSplit')
    split.style.flexDirection = narrow ? 'column' : 'row'
    nav.style.cssText = narrow
      ? 'flex:0 0 auto;display:flex;gap:6px;overflow-x:auto;overflow-y:hidden;padding:2px 14px 12px;border-bottom:1px solid var(--border)'
      : 'flex:0 0 168px;border-right:1px solid var(--border);padding:4px 10px 18px 14px;overflow-y:auto'
    // A horizontally scrolling element needs this attribute or a global rule strips the
    // scrolling and the types past the fold become unreachable.
    nav.setAttribute('data-dragscroll', '')
  }
  applyLayout()
  window.addEventListener('resize', applyLayout)

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && ov.style.display === 'flex') close()
  })
  return ov
}

export function close() {
  const ov = document.getElementById(OVERLAY_ID)
  if (ov) ov.style.display = 'none'
}

/**
 * Open the explainer, optionally on a specific type and side.
 *
 * `onPick` is called with (typeId, isLong) when the CTA is pressed, so the modal can hand
 * the choice straight back to the ticket instead of being a dead end that has to be read
 * and then re-navigated.
 */
export function openLearn({ type = null, isLong = null, onPick = null } = {}) {
  const ov = ensureModal()
  if (type && byId(type)) _sel = type
  if (isLong != null) _long = !!isLong
  if (onPick !== undefined) _onPick = onPick
  paint()
  ov.style.display = 'flex'
}

/** For tests and for anything that wants the copy without the chrome. */
export { spec as _diagramSpec }
