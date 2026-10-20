// Analysis → Support & resistance (src/zones.js does the maths; this fetches and draws).
//
// Reads Hyperliquid directly — 4h, daily and weekly candles plus the order book at three
// aggregations — through the METERED client in api.js, so it paces against the same
// per-IP budget as everything else. Candles are kept five minutes, the book twenty seconds,
// and nothing is fetched while the view is not on screen, while the global 429 breaker is
// tripped, or for a market the person has already navigated away from.
//
// It is not a cheap view: a market never seen before costs three candle reads at weight 20
// each plus the book at three aggregations, and tests/hl-weight.mjs --analysis=N measures what
// browsing N of them does to the budget. Treat anything that fetches per market as expensive.
//
// Its surfaces are solid on purpose: with a wallpaper set the app's panels go translucent
// (theme.js), and a table of prices you read the photo through is not readable. `.ana-view`
// pins them back to the preset's opaque colours (analysis.css).
import './analysis.css'
import { infoClient } from './api.js'
import { TFS, toCandles, buildZones, parseBooks, bookMid, wallFor, bookReach, bookRatio, readSetup, smoothRatio } from './zones.js'

const LS_COIN = 'hliq_ana_coin', LS_PREFS = 'hliq_ana_prefs'
// A year of 4h for the chart; the zones read only the last ZONE_4H_DAYS of it, where a 4h
// swing still means something (older ones are what the daily and weekly are for).
const SPAN = { '4h': 365 * 864e5, '1d': 1000 * 864e5, '1w': 3000 * 864e5 }
const ZONE_4H_DAYS = 180
// The chart's range buttons, in days.
const RANGE_DAYS = [['1M', 30], ['3M', 91], ['6M', 182], ['1Y', 365], ['All', 0]]
const BARS_PER_DAY = { '4h': 6, '1d': 1, '1w': 1 / 7 }
const CANDLE_TTL = 5 * 60e3, BOOK_TTL = 20e3
// The chart opens on three months of 4h, a year of daily, everything weekly.
const CHART_BARS = { '4h': 546, '1d': 365, '1w': 1000 }
const RANGES = { 10: 0.10, 25: 0.25, all: Infinity }

const cache = new Map()        // coin → { candles, candleAt, books, bookAt, err, loading }
let S = null                   // view state, made on first render
let deps = { T: (en) => en, coins: () => [], coin: () => 'BTC', addAlert: null, limited: () => false }
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
  return { sort: ['price', 'score', 'near'].includes(p.sort) ? p.sort : 'price', range: p.range in RANGES ? p.range : '25', tf: TFS.includes(p.tf) ? p.tf : '4h', all: p.all === true }
}
function savePrefs() { try { localStorage.setItem(LS_PREFS, JSON.stringify({ sort: S.sort, range: S.range, tf: S.tf, all: S.all })) } catch {} }

// ── data ────────────────────────────────────────────────────────────────────
async function loadCandles(coin, signal) {
  const e = cache.get(coin)
  const now = Date.now()
  const out = {}
  let failed = 0
  // One at a time: the transport paces them anyway, and a burst is what the limiter punishes.
  // Checked before each one rather than only at the top: tapping through chips used to load
  // every market in full, so browsing six of them cost six markets of candles (weight 20 each)
  // to look at one. Leaving a market abandons whatever it had not fetched yet.
  for (const tf of TFS) {
    if (signal?.aborted) return
    try { out[tf] = toCandles(await infoClient.candleSnapshot({ coin, interval: tf, startTime: now - SPAN[tf] }, signal)) }
    catch { out[tf] = null; failed++ }
  }
  // Walking away is not a failure. Letting an abort fall through to 'net' put a network error
  // on a market the person had already left, and it was waiting for them when they came back.
  if (signal?.aborted) return
  if (failed === TFS.length) { e.err = 'net'; return }
  // Every timeframe answered and none has a bar: there is no such market. A failed one is
  // unknown, not empty, so it never reads as "no market".
  if (!failed && TFS.every(tf => !out[tf].length)) { e.err = 'none'; return }
  for (const tf of TFS) if (!out[tf]) out[tf] = e.candles?.[tf] ?? []
  e.candles = out; e.candleAt = now; e.err = null
}

async function loadBooks(coin, signal) {
  const e = cache.get(coin)
  const raws = await Promise.all([undefined, 3, 2].map(n =>
    infoClient.l2Book(n ? { coin, nSigFigs: n } : { coin }, signal).catch(() => null)))
  if (signal?.aborted) return
  const books = parseBooks(raws)
  if (books.length) { e.books = books; e.bookAt = Date.now(); e.ratio = smoothRatio(e.ratio, bookRatio(books)?.ratio ?? null) }
}

// The load for the market currently on screen, so leaving one can abandon it.
let inflight = null   // { coin, ac }

async function refresh(force = false) {
  // The global 429 breaker. Every other poller in the app stands down when Hyperliquid
  // throttles us; this one did not, because it reaches HL through api.js and never saw the
  // breaker. So the pause that was meant to let the budget refill was spent with this tab
  // still fetching — which re-tripped it, and the backoff doubled 15s → 30s → 60s → 120s and
  // stuck at the cap. "Rate limited just by being in the Analysis tab" was this: the tab was
  // not only paying its share, it was holding the whole app in the penalty box.
  if (!force && deps.limited?.()) return
  const coin = S.coin
  if (!cache.has(coin)) cache.set(coin, { candles: null, candleAt: 0, books: null, bookAt: 0, err: null, loading: false })
  const e = cache.get(coin)
  // A market left behind has nothing waiting on it. Cancelling frees the budget for the one
  // being looked at instead of making it queue behind markets nobody is reading.
  if (inflight && inflight.coin !== coin) { try { inflight.ac.abort() } catch {} ; inflight = null }
  if (e.loading) return
  const now = Date.now()
  const needC = force || now - e.candleAt > CANDLE_TTL
  const needB = force || now - e.bookAt > BOOK_TTL
  if (!needC && !needB) return
  const ac = new AbortController()
  inflight = { coin, ac }
  e.loading = true
  if (needC && !e.candles) draw()
  try {
    await Promise.all([needC ? loadCandles(coin, ac.signal) : null, needB && e.err !== 'none' ? loadBooks(coin, ac.signal) : null])
  } finally {
    e.loading = false
    if (inflight?.ac === ac) inflight = null
  }
  if (S.coin === coin && !ac.signal.aborted) { S.ver++; draw() }
}

function result() {
  const e = cache.get(S.coin)
  if (!e?.candles) return null
  const c4 = e.candles['4h']
  const price = bookMid(e.books) ?? c4[c4.length - 1]?.c ?? e.candles['1d'].at(-1)?.c
  const key = `${S.coin}|${e.candleAt}|${price}`
  if (e.memo?.key !== key) {
    const from = Date.now() - ZONE_4H_DAYS * 864e5
    const r = buildZones({ candles: { ...e.candles, '4h': c4.filter(k => k.t >= from) }, price })
    // The smoothed book ratio, and the last reading — so a reading holds until the market moves it.
    if (r) { r.setup = readSetup({ zones: r.zones, price, atrD: r.atrD, daily: e.candles['1d'], ratio: e.ratio ?? null, prev: e.lastSetup ?? null }); e.lastSetup = r.setup }
    e.memo = { key, r }
  }
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

// ── the signal: where price is against the levels, and the two plans they describe ──
const zoneTxt = z => `${fmtPx(z.px)} (${T('strength', 'fuerza')} ${z.score}, ${T(`${z.confluence} of 3`, `${z.confluence} de 3`)})`
const days = x => x == null ? '' : x < 0.1 ? T('right there', 'justo ahí') : T(`${x.toFixed(1)} day-ranges away`, `a ${x.toFixed(1)} rangos diarios`)

function setupHtml(r) {
  const s = r.setup
  if (!s) return ''
  const p = r.price
  const head = {
    breakout: [T('Broke above a key level', 'Rompió un nivel clave al alza'), 'up',
      T(`Price closed under ${zoneTxt(s.broke ?? s.long?.zone)} in the last week and is now above it. An old ceiling often becomes a floor: the long plan is a retest of it.`,
        `El precio cerró por debajo de ${zoneTxt(s.broke ?? s.long?.zone)} la última semana y ahora está encima. Un techo roto suele volverse suelo: el plan largo es volver a probarlo.`)],
    breakdown: [T('Broke below a key level', 'Rompió un nivel clave a la baja'), 'dn',
      T(`Price closed over ${zoneTxt(s.broke ?? s.short?.zone)} in the last week and is now below it. An old floor often becomes a ceiling: the short plan is a retest of it from below.`,
        `El precio cerró por encima de ${zoneTxt(s.broke ?? s.short?.zone)} la última semana y ahora está debajo. Un suelo roto suele volverse techo: el plan corto es volver a probarlo desde abajo.`)],
    support: [T('Testing support', 'Probando soporte'), 'up',
      T(`Price is on or just above support at ${zoneTxt(s.long?.zone)}. Buyers have stepped in here before; if they do again, this is where a long has the least distance to its stop.`,
        `El precio está sobre o justo encima del soporte en ${zoneTxt(s.long?.zone)}. Aquí ya entraron compradores; si vuelven, es donde un largo tiene el stop más cerca.`)],
    resistance: [T('Testing resistance', 'Probando resistencia'), 'dn',
      T(`Price is at or just under resistance at ${zoneTxt(s.short?.zone)}. Sellers have stepped in here before; if they do again, this is where a short has the least distance to its stop.`,
        `El precio está en o justo debajo de la resistencia en ${zoneTxt(s.short?.zone)}. Aquí ya entraron vendedores; si vuelven, es donde un corto tiene el stop más cerca.`)],
    at: [T('Sitting on a key level', 'Sobre un nivel clave'), '',
      T(`Price is inside ${fmtPx(s.inside?.lo)}–${fmtPx(s.inside?.hi)} and the checks below do not lean either way. How it leaves decides it: holding is the long plan, rejecting is the short plan.`,
        `El precio está dentro de ${fmtPx(s.inside?.lo)}–${fmtPx(s.inside?.hi)} y los indicadores no se inclinan. Cómo salga decide: si aguanta, plan largo; si lo rechaza, plan corto.`)],
    range: [T('Between levels — no edge here', 'Entre niveles — sin ventaja aquí'), '',
      T(`Support ${s.support ? fmtPx(s.support.px) : '—'} is ${days(s.toSupport)} below, resistance ${s.resistance ? fmtPx(s.resistance.px) : '—'} is ${days(s.toResistance)} above. In the middle, a trade risks the most for the least; the plans below are what to wait for.`,
        `El soporte ${s.support ? fmtPx(s.support.px) : '—'} está ${days(s.toSupport)} abajo y la resistencia ${s.resistance ? fmtPx(s.resistance.px) : '—'} ${days(s.toResistance)} arriba. En medio, una operación arriesga más por menos; los planes de abajo son lo que hay que esperar.`)],
  }[s.state]
  const conf = s.confidence ? `<span class="ana-conf c-${s.confidence}">${{ high: T('high confidence', 'confianza alta'), medium: T('medium confidence', 'confianza media'), low: T('low confidence', 'confianza baja') }[s.confidence]}</span>` : ''
  const leanTxt = { up: T('leans up', 'se inclina al alza'), down: T('leans down', 'se inclina a la baja'), flat: T('no clear lean', 'sin inclinación clara') }[s.bias.lean]
  const chip = b => {
    const tone = b.v > 0 ? 'up' : b.v < 0 ? 'dn' : ''
    const txt = {
      sma50: b.v > 0 ? T(`Above its 50-day average (${fmtPx(b.x)})`, `Encima de su media de 50 días (${fmtPx(b.x)})`) : T(`Below its 50-day average (${fmtPx(b.x)})`, `Debajo de su media de 50 días (${fmtPx(b.x)})`),
      cross: b.v > 0 ? T('50-day average over the 200-day: uptrend', 'Media de 50 sobre la de 200: tendencia alcista') : T('50-day average under the 200-day: downtrend', 'Media de 50 bajo la de 200: tendencia bajista'),
      rsi: b.x >= 70 ? T(`RSI ${b.x.toFixed(0)}: stretched, often cools off`, `RSI ${b.x.toFixed(0)}: estirado, suele enfriarse`) : b.x <= 30 ? T(`RSI ${b.x.toFixed(0)}: oversold, often bounces`, `RSI ${b.x.toFixed(0)}: sobrevendido, suele rebotar`) : b.v > 0 ? T(`RSI ${b.x.toFixed(0)}: momentum up`, `RSI ${b.x.toFixed(0)}: impulso al alza`) : b.v < 0 ? T(`RSI ${b.x.toFixed(0)}: momentum down`, `RSI ${b.x.toFixed(0)}: impulso a la baja`) : T(`RSI ${b.x.toFixed(0)}: neutral`, `RSI ${b.x.toFixed(0)}: neutral`),
      book: b.v > 0 ? T(`Order book: more buyers (${b.x.toFixed(2)})`, `Libro: más compradores (${b.x.toFixed(2)})`) : b.v < 0 ? T(`Order book: more sellers (${b.x.toFixed(2)})`, `Libro: más vendedores (${b.x.toFixed(2)})`) : T(`Order book: balanced (${b.x.toFixed(2)})`, `Libro: equilibrado (${b.x.toFixed(2)})`),
    }[b.id]
    return `<span class="ana-chk ${tone}"><i>${b.v > 0 ? '▲' : b.v < 0 ? '▼' : '•'}</i>${txt}</span>`
  }
  const planCard = (pl, side) => {
    const isLong = side === 'long'
    if (!pl) return `<div class="ana-plan"><div class="ana-plan-h ${isLong ? 'up' : 'dn'}">${isLong ? T('Long plan', 'Plan largo') : T('Short plan', 'Plan corto')}</div><div class="ana-empty">${isLong ? T('No key support below to lean on.', 'No hay soporte clave debajo en el que apoyarse.') : T('No key resistance above to lean on.', 'No hay resistencia clave arriba en la que apoyarse.')}</div></div>`
    const active = s.active === side
    const name = { bounce: T('Buy the bounce at support', 'Comprar el rebote en soporte'), retest: isLong ? T('Buy the retest of the broken level', 'Comprar la vuelta al nivel roto') : T('Sell the retest of the broken level', 'Vender la vuelta al nivel roto'), reject: T('Sell the rejection at resistance', 'Vender el rechazo en resistencia') }[pl.kind]
    const pc = x => x == null ? '' : ` <small>${pct((x - p) / p)}</small>`
    const row = (l, v, cls = '') => `<div class="r ${cls}"><span>${l}</span><b>${v}</b></div>`
    const inZone = pl.zone.lo <= p && pl.zone.hi >= p
    const wait = active ? `<div class="ana-now">${T('Price is here now', 'El precio está aquí ahora')}</div>`
      : inZone ? `<div class="ana-now">${isLong ? T('Price is in this zone now — the plan if it holds', 'El precio está en esta zona — el plan si aguanta') : T('Price is in this zone now — the plan if it is rejected', 'El precio está en esta zona — el plan si la rechaza')}</div>`
      : `<div class="ana-wait">${T(`Wait for ${fmtPx(isLong ? pl.zone.hi : pl.zone.lo)}`, `Esperar a ${fmtPx(isLong ? pl.zone.hi : pl.zone.lo)}`)} <small>${pct(((isLong ? pl.zone.hi : pl.zone.lo) - p) / p)}</small></div>`
    const rrTone = pl.rr == null ? '' : pl.rr >= 2 ? 'up' : pl.rr < 1 ? 'dn' : ''
    return `<div class="ana-plan${active ? ' active' : ''}">
      <div class="ana-plan-h ${isLong ? 'up' : 'dn'}">${isLong ? T('Long plan', 'Plan largo') : T('Short plan', 'Plan corto')}<span>${name}</span></div>
      ${wait}
      ${row(T('Entry', 'Entrada'), fmtPx(pl.entry) + pc(pl.entry))}
      ${row('Stop', fmtPx(pl.stop) + pc(pl.stop), 'dn')}
      ${row(T('Target 1', 'Objetivo 1'), pl.t1 == null ? T('none in range', 'ninguno cerca') : fmtPx(pl.t1) + pc(pl.t1), 'up')}
      ${pl.t2 != null ? row(T('Target 2', 'Objetivo 2'), fmtPx(pl.t2) + pc(pl.t2), 'up') : ''}
      ${row(T('Reward : risk', 'Beneficio : riesgo'), pl.rr == null ? '—' : pl.rr.toFixed(1) + ' : 1', rrTone)}
      <div class="ana-plan-b">
        <button data-act="plan" data-v="${side}" class="${S.plan === side ? 'on' : ''}">${S.plan === side ? T('Hide from chart', 'Quitar del gráfico') : T('Show on chart', 'Ver en el gráfico')}</button>
        ${deps.addAlert && !active && !inZone ? `<button data-act="alert" data-dir="${isLong ? 'below' : 'above'}" data-px="${isLong ? pl.zone.hi : pl.zone.lo}">${T('Alert me there', 'Avisarme ahí')}</button>` : ''}
      </div>
    </div>`
  }
  return `<div class="ana-card ana-sig">
    <div class="ana-sig-top">
      <div class="ana-sig-k">${T('What the levels say now', 'Qué dicen los niveles ahora')}</div>
      <div class="ana-sig-h ${head[1]}">${head[0]} ${conf}</div>
      <div class="ana-sig-p">${head[2]}</div>
    </div>
    ${s.bias.items.length ? `<div class="ana-bias"><div class="ana-bias-h">${T('Checks', 'Indicadores')}: <b class="${s.bias.lean === 'up' ? 'up' : s.bias.lean === 'down' ? 'dn' : ''}">${leanTxt}</b> <small>(${s.bias.score > 0 ? '+' : ''}${s.bias.score} ${T('of', 'de')} ±${s.bias.max})</small></div><div class="ana-chks">${s.bias.items.map(chip).join('')}</div></div>` : ''}
    <div class="ana-plans">${planCard(s.long, 'long')}${planCard(s.short, 'short')}</div>
    <div class="ana-sig-note">${T('Stops sit a quarter of a day’s range past the zone; targets are the next key zones. Aim for reward:risk of 2 or more. This reads levels — it is not advice, and levels fail.',
      'El stop va un cuarto de rango diario más allá de la zona; los objetivos son las siguientes zonas clave. Busca beneficio:riesgo de 2 o más. Esto lee niveles — no es consejo, y los niveles fallan.')} <button data-act="help" class="ana-link">${S.help ? T('Hide the guide', 'Ocultar la guía') : T('How to read this', 'Cómo leer esto')}</button></div>
  </div>`
}

function helpHtml() {
  if (!S.help) return ''
  const it = (h, en, es) => `<div class="ana-help-i"><b>${h}</b><span>${T(en, es)}</span></div>`
  return `<div class="ana-card ana-help"><div class="ana-bar"><span class="ana-t">${T('How to read this', 'Cómo leer esto')}</span><span style="flex:1"></span><button data-act="help" class="ana-link">${T('Close', 'Cerrar')}</button></div><div class="ana-help-g">
    ${it(T('Support', 'Soporte'), 'A price below where buyers have stepped in before. Price tends to slow or bounce there; if it breaks, it often becomes resistance.', 'Un precio por debajo donde antes entraron compradores. El precio suele frenar o rebotar ahí; si se rompe, suele volverse resistencia.')}
    ${it(T('Resistance', 'Resistencia'), 'A price above where sellers have stepped in before. Price tends to stall there; if it breaks, it often becomes support.', 'Un precio por encima donde antes entraron vendedores. El precio suele frenarse ahí; si se rompe, suele volverse soporte.')}
    ${it(T('Strength', 'Fuerza'), '0–100. Mostly how many timeframes agree, then how many times price turned there, how hard, how recently, and how much traded there.', '0–100. Sobre todo cuántas temporalidades coinciden, luego cuántas veces giró ahí, con qué fuerza, lo reciente y cuánto se negoció.')}
    ${it(T('Confluence', 'Confluencia'), '“3 of 3” means the 4h, daily and weekly charts all turned at this price. Those are the levels most traders can see.', '“3 de 3” significa que los gráficos de 4h, diario y semanal giraron en este precio. Son los niveles que más traders ven.')}
    ${it(T('Flip', 'Giro'), 'Made of the opposite swings: an old ceiling price has since gone through (now support), or an old floor it has fallen through (now resistance).', 'Formada por giros contrarios: un techo que el precio ya atravesó (ahora soporte) o un suelo que perdió (ahora resistencia).')}
    ${it(T('Day-range (ATR)', 'Rango diario (ATR)'), 'How far price usually moves in a day. Distances in day-ranges tell you how close something really is for this market.', 'Cuánto se mueve el precio en un día normal. Las distancias en rangos diarios dicen qué tan cerca está algo de verdad en este mercado.')}
    ${it(T('Reward : risk', 'Beneficio : riesgo'), 'How far to the first target compared with how far to the stop. 2 : 1 means you stand to make twice what you risk.', 'Distancia al primer objetivo comparada con la distancia al stop. 2 : 1 significa ganar el doble de lo que arriesgas.')}
    ${it(T('Wall', 'Muro'), 'Dollars resting in the order book inside the zone right now. Big walls can slow price, but they can be pulled at any moment.', 'Dólares en el libro de órdenes dentro de la zona ahora mismo. Los muros grandes pueden frenar el precio, pero pueden retirarse en cualquier momento.')}
    ${it(T('Checks', 'Indicadores'), 'Trend (price vs its 50-day average, 50-day vs 200-day), momentum (RSI) and the order book. They say which plan the market currently favours.', 'Tendencia (precio vs media de 50 días, media de 50 vs 200), impulso (RSI) y el libro de órdenes. Indican qué plan favorece el mercado ahora.')}
    ${it(T('Breakout / breakdown', 'Ruptura'), 'A key level crossed in the last week. The common trade is not chasing it but waiting for price to come back and test it from the other side.', 'Un nivel clave cruzado la última semana. Lo habitual no es perseguirlo sino esperar a que el precio vuelva a probarlo desde el otro lado.')}
  </div></div>`
}

function statsHtml(r, e) {
  const z = r.zones.filter(x => x.key)
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
    ${card(T('Key zones', 'Zonas clave'), String(z.length), `${all3} ${T('on all 3 timeframes', 'en las 3 temporalidades')} · ${r.zones.length} ${T('in total', 'en total')}`)}
    ${card(T('Book bid/ask ±2%', 'Libro bid/ask ±2%'), ratio ? ratio.ratio.toFixed(2) : '—', ratio ? `${fmtUsd(ratio.bid)} / ${fmtUsd(ratio.ask)}` : T('book not read yet', 'libro aún sin leer'), ratio ? (ratio.ratio >= 1 ? 'up' : 'dn') : '')}
  </div>`
}

// One line of plain reading — what the numbers say, never what to do about them.
function readingHtml(r) {
  const z = r.zones.filter(x => x.key)
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
  // The plan on show: its stop and first target are always inside the range.
  const plan = S.plan ? r.setup?.[S.plan] : null
  if (plan) for (const p of [plan.stop, plan.t1].filter(x => x != null)) { lo = Math.min(lo, p); hi = Math.max(hi, p) }
  const pad = (hi - lo) * 0.06
  lo -= pad; hi += pad
  const mid = (lo + hi) / 2 + S.view.yo, half = (hi - lo) / 2 / S.view.yz
  lo = mid - half; hi = mid + half
  const W = 1000, H = 300, n = c.length, bw = W / n
  const y = p => (hi - p) / (hi - lo) * H
  S.map = { lo, hi, c, H }
  const col = z => z.kind === 'support' ? 'var(--green)' : z.kind === 'resistance' ? 'var(--red)' : 'var(--accent)'
  const inView = r.zones.map((z, i) => ({ z, i })).filter(({ z, i }) => (S.all || z.key || i === S.sel) && z.hi >= lo && z.lo <= hi)
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
  // Entry, stop and targets of the plan on show, labelled on the left.
  const planLv = plan ? [['entry', plan.entry, T('Entry', 'Entrada')], ['stop', plan.stop, 'Stop'], ['tgt', plan.t1, 'T1'], ['tgt', plan.t2, 'T2']].filter(([, p]) => p != null && p > lo && p < hi) : []
  const planSvg = planLv.map(([cls, p]) => hline(p, 'pl-' + cls)).join('')
  const planLab = planLv.map(([cls, p, name]) => `<span class="ana-pl pl-${cls}" style="top:${(y(p) / H * 100).toFixed(2)}%">${name} ${fmtPx(p)}</span>`).join('')
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bands}${hline(r.profile?.poc, 'poc')}${bars}${hline(r.price, 'now')}${planSvg}</svg>
    ${plan ? '' : ticks.join('')}${dates.join('')}${planLab}
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

// The range buttons worth offering: one wider than the data is the same as All.
function rangesFor(e) {
  const len = (e.candles[S.tf] ?? []).length
  return RANGE_DAYS.filter(([, d]) => !d || d * BARS_PER_DAY[S.tf] < len * 0.97)
}
// Which of them matches what is on screen, if any.
function rangeOn(e) {
  if (S.view.end || S.view.yz !== 1 || S.view.yo) return null
  const len = (e.candles[S.tf] ?? []).length, n = Math.min(S.view.n, len)
  for (const [l, d] of rangesFor(e)) {
    const want = d ? Math.min(len, d * BARS_PER_DAY[S.tf]) : len
    if (Math.abs(n - want) <= Math.max(1, want * 0.03)) return l
  }
  return null
}

function chartHtml(r, e) {
  const on = rangeOn(e)
  const ranges = rangesFor(e)
  return `<div class="ana-card ana-chart">
    <div class="ana-bar wrap"><span class="ana-t">${T('Zones on the chart', 'Zonas en el gráfico')}</span><span style="flex:1"></span>
      <span class="ana-seg">${ranges.map(([l]) => `<button data-act="range-days" data-v="${l}" class="${on === l ? 'on' : ''}">${l === 'All' ? T('All', 'Todo') : l}</button>`).join('')}</span>
      <span class="ana-seg"><button data-act="zoom" data-v="out" aria-label="${T('Zoom out', 'Alejar')}">−</button><button data-act="zoom" data-v="in" aria-label="${T('Zoom in', 'Acercar')}">+</button><button data-act="zoom" data-v="reset" class="${on ? 'dim' : ''}">${T('Reset', 'Restablecer')}</button></span>
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
    const on = rangeOn(e)
    if (rs) rs.classList.toggle('dim', !!on)
    S.root.querySelectorAll('[data-act="range-days"]').forEach(b => b.classList.toggle('on', b.dataset.v === on))
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
  let z = r.zones.map((x, i) => ({ ...x, i })).filter(x => Math.abs(x.dist) <= lim && (S.all || x.key))
  const hidden = r.zones.filter(x => Math.abs(x.dist) <= lim && !x.key).length
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
      <button data-act="showall" class="ana-toggle${S.all ? ' on' : ''}" title="${T('Key zones: on 2+ timeframes, or strength 65+. The rest are mostly single 4h turns.', 'Zonas clave: en 2+ temporalidades o fuerza 65+. El resto son sobre todo giros sueltos de 4h.')}">${S.all ? T('Key zones only', 'Solo zonas clave') : T(`Show all (+${hidden} weak)`, `Mostrar todas (+${hidden} débiles)`)}</button>
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
  // The chart opens on the plan price is at now, if any.
  if (S.plan === undefined) S.plan = r.setup?.active ?? null
  const keep = body.querySelector('.ana-table')?.scrollLeft ?? 0
  // The answer first, then the picture, then the numbers behind it.
  body.innerHTML = setupHtml(r) + chartHtml(r, e) + statsHtml(r, e) + readingHtml(r) + rowsHtml(r, e) + helpHtml() + footHtml(r, e)
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
  if (a === 'showall') { S.all = !S.all; if (!S.all && S.sel != null && !result()?.zones[S.sel]?.key) S.sel = null; savePrefs(); draw(); return }
  if (a === 'zoom') {
    if (b.dataset.v === 'reset') S.view = freshView(S.tf)
    else return zoomBy(b.dataset.v === 'in' ? 1.5 : 1 / 1.5)
    drawPlot(); return
  }
  if (a === 'range-days') {
    const d = RANGE_DAYS.find(([l]) => l === b.dataset.v)?.[1]
    S.view = { n: d ? d * BARS_PER_DAY[S.tf] : 1e6, end: 0, yz: 1, yo: 0 }
    drawPlot(); return
  }
  // A plan's "Show on chart": its entry, stop and targets drawn; pressing again hides them.
  if (a === 'plan') {
    S.plan = S.plan === b.dataset.v ? null : b.dataset.v
    S.sel = null
    draw()
    if (S.plan) S.root.querySelector('.ana-chart')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    return
  }
  if (a === 'alert') {
    const px = +b.dataset.px
    if (deps.addAlert && px > 0 && deps.addAlert(S.coin, b.dataset.dir, px)) { b.disabled = true; b.textContent = T('Alert set ✓', 'Alerta creada ✓') }
    return
  }
  if (a === 'help') { S.help = !S.help; draw(); return }
  if (a === 'sort' || a === 'range' || a === 'tf') { S[a] = b.dataset.v; if (a === 'tf') S.view = freshView(S.tf); savePrefs(); draw() }
}

function pick(coin) {
  coin = normCoin(coin)
  if (!coin) return
  S.coin = coin; S.sel = null; S.plan = undefined; S.view = freshView(S.tf)
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
    if (prev && prev.coin === S.coin) { S.sel = prev.sel; S.view = prev.view; S.tf = prev.tf; S.plan = prev.plan; S.help = prev.help }
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
    // Off screen (another tab, another app): stand down, and drop whatever was still in
    // flight when the view was left. An unexported hook would have to be wired from main.js
    // and remembered at every call site; the tick already knows when nobody is looking.
    if (S.root.offsetParent === null || document.hidden) {
      if (inflight) { try { inflight.ac.abort() } catch {} ; inflight = null }
      return
    }
    refresh()
  }, 5000)
}
