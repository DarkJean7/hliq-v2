/**
 * The Analysis tab's read of the selected market, as a card on the Trade tab.
 *
 * Asked: "use some of the most relevant data in the analysis tab and display that data in the trade
 * tab on the selected asset ... a summary of the analysis under the user position summary (if a
 * position is open)". The reading, the checks, the nearest levels, the plans — and, holding a
 * position, what those levels mean for it. Same numbers as the Analysis tab, out of the same cache
 * (src/analysis.js); nothing here works out a level of its own.
 *
 * ── the budget ──
 * A market never read before costs about 125 weight of a 1,200-a-minute budget the exchange's own
 * tab shares ("i just got rate limited in hyperliquid.xyz"). So: nothing loads until a market has
 * been on screen for LOAD_AFTER_MS, which makes browsing past coins free; moving on abandons the
 * load; a read lasts five minutes; and nothing is fetched off screen or while rate limited.
 *
 *   initTradeBrief({ T, limited, price(coin), position(coin), prv(text), open(coin) })
 *   setTradeBriefCoin(coin)     the market on screen; called whenever the chart loads
 *
 * position(coin) → { side: 'long'|'short', liq, hedged } | null. Takes what it needs from main.js
 * through that object, so it cannot reach into state — the shape src/agentkeys.js uses.
 */
import { analysisFor, analysisState, ensureAnalysis, setAnalysisDeps, setupHead, fmtPx, normCoin } from './analysis.js'

const LOAD_AFTER_MS = 1500
const TICK_MS = 5000
/** How often the levels are re-read against the live price. A rebuild walks years of candles. */
const REPAINT_MS = 30_000
const HOSTS = ['mobTradeBrief', 'deskTradeBrief']

let ctx = { T: (en) => en, limited: () => false, price: () => null, position: () => null, prv: (x) => x, open: null }
let coin = null, ac = null, loadT = null, timer = null, paintedAt = 0, paintedState = null

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const T = (en, es) => ctx.T(en, es)
const pct = (x) => (x > 0 ? '+' : '') + (x * 100).toFixed(1) + '%'
// Outcomes have sides, not support and resistance: there is no read to give.
const readable = (c) => !!c && !/^[#+]/.test(String(c))

/** The host on screen, if either is. A hidden one has offsetParent null, which is what gates the fetch. */
function host() {
  for (const id of HOSTS) { const el = document.getElementById(id); if (el && el.offsetParent !== null) return el }
  return null
}

const CHECK = { sma50: () => T('50-day avg', 'Media 50d'), cross: () => T('Trend', 'Tendencia'), rsi: (b) => 'RSI ' + b.x.toFixed(0), book: () => T('Book', 'Libro') }

/** What the levels mean for a position held. Plain facts, never what to do about them. */
export function positionLines(pos, r, T_ = T) {
  if (!pos || pos.hedged || !r?.setup) return []
  const long = pos.side === 'long', out = []
  const lean = r.setup.bias?.lean
  if (lean && lean !== 'flat') {
    const withIt = (lean === 'up') === long
    out.push({ tone: withIt ? 'up' : 'dn', text: withIt
      ? T_(`The checks lean ${lean} — with your ${pos.side}.`, `Los indicadores se inclinan ${lean === 'up' ? 'al alza' : 'a la baja'}: a favor de tu ${long ? 'largo' : 'corto'}.`)
      : T_(`The checks lean ${lean} — against your ${pos.side}.`, `Los indicadores se inclinan ${lean === 'up' ? 'al alza' : 'a la baja'}: en contra de tu ${long ? 'largo' : 'corto'}.`) })
  }
  // The level between price and the liquidation, on the side a loss travels.
  const key = (r.zones ?? []).filter(z => z.key)
  const guard = long
    ? key.filter(z => z.kind === 'support').sort((a, b) => b.px - a.px)[0]
    : key.filter(z => z.kind === 'resistance').sort((a, b) => a.px - b.px)[0]
  if (guard && pos.liq > 0) {
    const name = long ? T_('support', 'soporte') : T_('resistance', 'resistencia')
    const before = long ? pos.liq < guard.px : pos.liq > guard.px
    out.push(before
      ? { tone: 'up', text: T_(`Your liquidation is past the nearest ${name} (${fmtPx(guard.px)}): price meets the level first.`, `Tu liquidación está más allá del ${name} más cercano (${fmtPx(guard.px)}): el precio llega antes al nivel.`) }
      : { tone: 'dn', text: T_(`Your liquidation comes before the nearest ${name} (${fmtPx(guard.px)}): no key level stands in front of it.`, `Tu liquidación llega antes que el ${name} más cercano (${fmtPx(guard.px)}): ningún nivel clave la protege.`) })
  }
  return out
}

function cardHtml(c, r, pos) {
  const s = r.setup
  const [title, tone] = setupHead(s)
  const conf = s.confidence ? `<span class="tb-conf c-${s.confidence}">${{ high: T('high confidence', 'confianza alta'), medium: T('medium confidence', 'confianza media'), low: T('low confidence', 'confianza baja') }[s.confidence]}</span>` : ''
  const leanTxt = { up: T('Checks lean up', 'Indicadores al alza'), down: T('Checks lean down', 'Indicadores a la baja'), flat: T('No clear lean', 'Sin inclinación clara') }[s.bias.lean]
  const chips = s.bias.items.map(b => `<span class="tb-chk ${b.v > 0 ? 'up' : b.v < 0 ? 'dn' : ''}"><i>${b.v > 0 ? '▲' : b.v < 0 ? '▼' : '•'}</i>${esc(CHECK[b.id]?.(b) ?? b.id)}</span>`).join('')

  const key = (r.zones ?? []).filter(z => z.key)
  const sup = key.filter(z => z.kind === 'support').sort((a, b) => b.px - a.px)[0]
  const res = key.filter(z => z.kind === 'resistance').sort((a, b) => a.px - b.px)[0]
  const level = (label, z, cls) => `<div class="tb-lvl"><span>${label}</span><b class="${cls}">${z ? fmtPx(z.px) : '—'}</b>${z ? `<small>${pct(z.dist)} · ${T('strength', 'fuerza')} ${z.score}</small>` : `<small>${T('none near', 'ninguno cerca')}</small>`}</div>`

  const plan = (pl, side) => {
    if (!pl) return ''
    const isLong = side === 'long'
    return `<div class="tb-plan">
      <b class="${isLong ? 'up' : 'dn'}">${isLong ? T('Long plan', 'Plan largo') : T('Short plan', 'Plan corto')}${s.active === side ? ` <em>${T('price is here', 'el precio está aquí')}</em>` : ''}</b>
      <span><i>${T('Entry', 'Entrada')}</i>${fmtPx(pl.entry)}</span>
      <span><i>Stop</i>${fmtPx(pl.stop)}</span>
      <span><i>${T('Target', 'Objetivo')}</i>${pl.t1 == null ? '—' : fmtPx(pl.t1)}</span>
      <span><i>R:R</i>${pl.rr == null ? '—' : pl.rr.toFixed(1)}</span>
    </div>`
  }
  // Holding one side, that side's plan is the one that says anything about the position.
  const plans = pos && !pos.hedged ? plan(s[pos.side], pos.side) : plan(s.long, 'long') + plan(s.short, 'short')
  const lines = positionLines(pos, r).map(l => `<div class="tb-pos ${l.tone}">${esc(ctx.prv(l.text))}</div>`).join('')

  return `<div class="tb-card">
    <div class="tb-top"><span>${T('Analysis', 'Análisis')}</span>
      ${ctx.open ? `<button type="button" data-tb-open>${T('Full analysis', 'Análisis completo')} →</button>` : ''}</div>
    <div class="tb-h ${tone}">${esc(title)} ${conf}</div>
    ${s.bias.items.length ? `<div class="tb-chks"><b class="${s.bias.lean === 'up' ? 'up' : s.bias.lean === 'down' ? 'dn' : ''}">${leanTxt}</b>${chips}</div>` : ''}
    ${lines}
    <div class="tb-lvls">${level(T('Support', 'Soporte'), sup, 'up')}${level(T('Resistance', 'Resistencia'), res, 'dn')}</div>
    ${plans}
    <div class="tb-note">${T('Reads levels. It is not advice, and levels fail.', 'Lee niveles. No es consejo, y los niveles fallan.')}</div>
  </div>`
}

const quiet = (msg) => `<div class="tb-card"><div class="tb-top"><span>${T('Analysis', 'Análisis')}</span></div><div class="tb-msg">${msg}</div></div>`

function paint() {
  const el = host()
  if (!el) return
  paintedAt = Date.now()
  if (!readable(coin)) { el.innerHTML = ''; return }
  const st = analysisState(coin)
  paintedState = st
  const r = st === 'ok' ? analysisFor(coin, ctx.price(coin)) : null
  if (r?.setup) { el.innerHTML = cardHtml(coin, r, ctx.position(coin)); return }
  // Not read yet, and could not be read, are different things and say so.
  if (st === 'none') { el.innerHTML = ''; return }
  el.innerHTML = quiet(st === 'net' ? T('Analysis did not load. It will try again shortly.', 'El análisis no cargó. Se reintentará pronto.')
    : st === 'ok' ? T('Not enough history here to read levels from.', 'No hay historial suficiente para leer niveles.')
    : T('Reading the levels…', 'Leyendo los niveles…'))
}

async function load() {
  if (!readable(coin) || !host()) return
  if (!ac || ac.signal.aborted) ac = new AbortController()
  const mine = coin, sig = ac.signal
  const p = ensureAnalysis(mine, sig)
  paint()
  await p
  if (mine === coin && !sig.aborted) paint()
}

function tick() {
  if (!host() || document.hidden) {
    // Off screen: nobody is reading, so nothing stays in flight either.
    if (ac) { try { ac.abort() } catch {} ; ac = null }
    return
  }
  load()
  if (analysisState(coin) !== paintedState || Date.now() - paintedAt >= REPAINT_MS) paint()
}

export function initTradeBrief(opts) {
  ctx = { ...ctx, ...opts }
  setAnalysisDeps({ T: ctx.T, limited: ctx.limited })
  for (const id of HOSTS) document.getElementById(id)?.addEventListener('click', (e) => { if (e.target.closest('[data-tb-open]')) ctx.open?.(coin) })
}

export function setTradeBriefCoin(next) {
  next = readable(next) ? normCoin(next) : next
  if (next !== coin) {
    if (ac) { try { ac.abort() } catch {} ; ac = null }
    coin = next
  }
  // The phone's host is rebuilt with its screen, so it gets its listener here rather than once.
  const el = document.getElementById('mobTradeBrief')
  if (el && !el.__tb) { el.__tb = true; el.addEventListener('click', (e) => { if (e.target.closest('[data-tb-open]')) ctx.open?.(coin) }) }
  paint()
  clearTimeout(loadT)
  loadT = setTimeout(load, LOAD_AFTER_MS)
  if (!timer) timer = setInterval(tick, TICK_MS)
}
