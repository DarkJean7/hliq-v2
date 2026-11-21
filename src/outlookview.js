// The Outlook tab: one card per open position — the score and why, the cone with the three
// cases, and what each would do to the position. The numbers are src/outlook.js; this file
// fetches, draws and remembers which "why" lists are open.
//
// Candles come from the Analysis tab's cache (analysis.js ensureAnalysis) — the same 4h, daily
// and weekly reads, the same support/resistance and book — so a market Analysis has read costs
// nothing here, and one read here is ready there. A market never seen costs about 120 weight
// (three candle reads), so positions load ONE AT A TIME, only while this tab is on screen, and a
// loaded market is not reloaded for 15 minutes: 4h candles do not change in five, and the live
// price comes from the mids the app already has.
import './outlook.css'
import { ensureAnalysis, analysisFor, analysisRaw, analysisState, setAnalysisDeps, fmtPx } from './analysis.js'
import { outlookFor, HORIZONS, RANGE_CANDLES, RANGE_LOOKBACK, pastSamples, pastRecord, candleScoreOf } from './outlook.js'
import { catLabel } from './simcat.js'

const LS_H = 'hliq_outlook_h'
const RELOAD_MS = 15 * 60e3
let horizon = (() => { try { const h = localStorage.getItem(LS_H); return h in HORIZONS ? h : '24h' } catch { return '24h' } })()
const whyOpen = new Set()   // card keys whose factor list is open
let last = null             // { host, ctx } — the latest render, for repaints when a load lands
let painted = ''
let pumping = false

// ── version 2: the track record ────────────────────────────────────────────
// The past record replays the candle score over the year of 4h candles already loaded (~40ms a
// market), once per load and horizon. The live record is the server's (/outlook-record), asked
// at most every two minutes per market; and each rating shown is reported to it once an hour per
// market and horizon (/outlook-log) — coin, horizon, score and volatility, nothing about who.
const pastMemo = new Map()     // coin|loadedAt|hours → samples
const recs = new Map()         // coin|hours → { at, data, err }
const logged = new Set()       // coin|hours|hour already reported from this page
let recVer = 0
function pastFor(coin, raw, hours) {
  const k = `${coin}|${raw.at}|${hours}`
  if (!pastMemo.has(k)) {
    for (const key of [...pastMemo.keys()]) if (key.startsWith(coin + '|') && key.endsWith('|' + hours)) pastMemo.delete(key)
    pastMemo.set(k, pastSamples(raw.candles['4h'], raw.candles['1d'], hours))
  }
  return pastMemo.get(k)
}
function ensureRecord(coin, hours) {
  const k = `${coin}|${hours}`, r = recs.get(k)
  if (r && (r.inflight || Date.now() - r.at < 120e3)) return
  recs.set(k, { ...(r ?? {}), inflight: true })
  fetch(`/outlook-record?coin=${encodeURIComponent(coin)}&h=${hours}`)
    .then(res => res.ok ? res.json() : Promise.reject(new Error(String(res.status))))
    .then(data => recs.set(k, { at: Date.now(), data, err: false }))
    .catch(() => recs.set(k, { at: Date.now(), data: r?.data ?? null, err: true }))
    .finally(() => { recVer++; paint(false) })
}
function logRating(coin, hours, score, sigma) {
  if (score == null || !(sigma > 0)) return
  const k = `${coin}|${hours}|${Math.floor(Date.now() / 3600e3)}`
  if (logged.has(k)) return
  logged.add(k)
  fetch('/outlook-log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ coin, hours, score, sigma }) }).catch(() => {})
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const keyOf = (p) => `${p.coin}|${p._acctAddr ?? ''}`
const pct = (x, d = 0) => x == null ? '—' : `${(x * 100).toFixed(d)}%`
const chance = (x) => x == null ? '—' : x < 0.01 ? '<1%' : x > 0.99 ? '>99%' : pct(x)

/** Positions as the app holds them → the position objects, or null when not yet known. */
function positionsOf(ctx) {
  const list = ctx.positions()
  if (list == null) return null
  return list.map(ap => ap?.position ?? ap).filter(p => p?.coin && parseFloat(p.szi))
}

function priceOf(ctx, coin, raw) {
  const m = ctx.mid(coin)
  if (m > 0) return m
  return raw?.candles?.['4h']?.at(-1)?.c ?? null
}

// Load the positions' markets, one after another, while the tab is on screen.
async function pump() {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      if (!last?.host?.isConnected) return
      const ps = positionsOf(last.ctx) ?? []
      const coins = [...new Set(ps.map(p => p.coin))]
      const due = coins.find(c => {
        const raw = analysisRaw(c), st = analysisState(c)
        if (st === 'loading') return false
        if (st === 'none') return false
        return !raw || Date.now() - raw.at > RELOAD_MS
      })
      if (!due) return
      const before = analysisRaw(due)?.at ?? 0
      await ensureAnalysis(due)
      paint(true)
      // ensureAnalysis waits a minute after a failure, and stands down while the app is rate
      // limited. Either way nothing loaded: stop, and the next render tries again.
      if ((analysisRaw(due)?.at ?? 0) === before) return
    }
  } finally { pumping = false }
}

/** Draw the tab into `host`. Called on open and on every tick; repaints only on change. */
export function renderOutlook(host, ctx, tick = false) {
  if (!host) return
  // Prices at five significant figures, as the Analysis tab prints them: the app's fmtPrice
  // keeps a market's full precision, and "$101.9545" made the case tiles cut off.
  ctx = { ...ctx, fmtPrice: fmtPx }
  last = { host, ctx }
  // The 429 breaker: while the app is throttled the loads stand down (analysis.js checks it).
  if (ctx.limited) setAnalysisDeps({ limited: ctx.limited })
  if (!host._ol) {
    host._ol = true
    host.addEventListener('click', (e) => {
      const h = e.target.closest('[data-ol-h]')
      if (h) { horizon = h.dataset.olH; try { localStorage.setItem(LS_H, horizon) } catch {} ; paint(true); return }
      const w = e.target.closest('[data-ol-why]')
      if (w) { const k = w.dataset.olWhy; whyOpen.has(k) ? whyOpen.delete(k) : whyOpen.add(k); paint(true); return }
      const c = e.target.closest('[data-ol-coin]')
      if (c) last?.ctx.openCoin?.(c.dataset.olCoin)
    })
  }
  paint(!tick)
  pump()
}

function paint(force) {
  const { host, ctx } = last ?? {}
  if (!host?.isConnected) return
  const ps = positionsOf(ctx)
  // One card per market, its accounts in the order the app lists them.
  const groups = new Map()
  for (const p of ps ?? []) { if (!groups.has(p.coin)) groups.set(p.coin, []); groups.get(p.coin).push(p) }
  const items = [...groups].map(([coin, list]) => {
    const raw = analysisRaw(coin)
    return { coin, ps: list, raw, price: priceOf(ctx, coin, raw), state: analysisState(coin) }
  })
  // Repaint only when something on the card would change: a position, a load landing, the price
  // moving a twentieth of a percent, a toggle.
  const sig = [horizon, recVer, ps == null ? 'unknown' : '', [...whyOpen].join(','), ...items.map(i =>
    `${i.ps.map(p => `${keyOf(p)}:${p.szi}:${p.entryPx}:${p.liquidationPx}:${p.unrealizedPnl}`).join(',')}:${i.raw?.at ?? 0}:${i.state}:${i.price ? Math.round(Math.log(i.price) * 2000) : 0}`)].join('|')
  if (!force && sig === painted) return
  painted = sig
  const T = ctx.T
  host.innerHTML = `<div class="ol-view">${headHtml(T)}${ps == null
    ? `<div class="ol-empty">${T('Loading your positions…', 'Cargando tus posiciones…')}</div>`
    : !ps.length
      ? `<div class="ol-empty"><b>${T('No open positions', 'Sin posiciones abiertas')}</b><br>${T('Outlook reads the positions you hold: what could happen to each one, and what the signals lean towards.', 'Outlook lee tus posiciones abiertas: qué podría pasarle a cada una y hacia dónde se inclinan las señales.')}</div>`
      : `<div class="ol-cards">${items.map(i => cardHtml(i, ctx)).join('')}</div>`
  }<div class="ol-foot">${T(
    `Not a prediction. The cone is how far each market has moved in ${horizon} from its last 180 4h candles; chances assume no drift and are for touching a price, not ending there. The score is a lean from six signals — read the reasons, not just the number.`,
    `No es una predicción. El cono es cuánto se ha movido cada mercado en ${horizon} según sus últimas 180 velas de 4h; las probabilidades suponen que no hay tendencia y son de tocar un precio, no de terminar ahí. La puntuación es una inclinación de seis señales: lee los motivos, no solo el número.`)}</div></div>`
}

const BAND_NAME = (s, T) => {
  const a = Math.abs(s)
  if (a < 15) return T('neutral', 'neutral')
  const w = a >= 40 ? T('strongly ', 'fuertemente ') : ''
  return w + (s > 0 ? T('bullish', 'alcista') : T('bearish', 'bajista'))
}
const LEAN_NAME = (s, T) => Math.abs(s) < 15 ? T('neutral', 'neutral') : s > 0 ? T('bullish', 'alcista') : T('bearish', 'bajista')
const VERDICT = {
  better: ['Better than the base rate', 'Mejor que la tasa base'], worse: ['Worse than the base rate', 'Peor que la tasa base'],
  chance: ['No better than chance', 'No mejor que el azar'], thin: ['Too few days to tell', 'Muy pocos días para saber'],
  none: ['Never read like this in the past year', 'Nunca marcó así en el último año'],
}
const signed = (n) => `${n > 0 ? '+' : ''}${n}`

/**
 * Track record: the past year (the candle signals replayed, against the base rate) and the live
 * record (the server's grading of the full score as shown). Rendering it also reports this
 * rating and asks for the record — both rate-limited above.
 */
function recordHtml(coin, raw, o, ctx) {
  const { T } = ctx
  const hours = o.hours, hz = hours === 24 ? '24h' : '7d'
  const lab = esc(ctx.coinLabel(coin))
  // Only a full read is reported: a first paint before the levels and the book have loaded
  // scored -9 where the full one said -37, and the record would grade a number nobody saw for long.
  if ((o.score?.coverage ?? 0) >= 0.9) logRating(coin, hours, o.score.score, o.sigma)
  ensureRecord(coin, hours)

  const cs = candleScoreOf(o.factors)
  const past = cs ? pastRecord(pastFor(coin, raw, hours), cs.score, hours) : null
  const happened = (lean) => lean === 'up' ? T(`higher ${hz} later`, `más alto ${hz} después`)
    : lean === 'down' ? T(`lower ${hz} later`, `más bajo ${hz} después`)
    : T(`within its usual range ${hz} later`, `dentro de su rango usual ${hz} después`)
  let pastLine
  if (!past) pastLine = T('Not enough history to replay.', 'No hay historial suficiente.')
  else if (past.verdict === 'none') pastLine = `${T(`The candle signals read ${BAND_NAME(cs.score, T)} now (${signed(cs.score)}).`, `Las señales de velas marcan ${BAND_NAME(cs.score, T)} ahora (${signed(cs.score)}).`)} <em class="v none">${T(...VERDICT.none)}</em>`
  else {
    const band = past.widened ? LEAN_NAME(cs.score, T) : BAND_NAME(cs.score, T)
    pastLine = `${T(`When ${lab}'s candle signals read ${band} (now ${signed(cs.score)}), it was ${happened(past.lean)} on`,
      `Cuando las señales de velas de ${lab} marcaron ${band} (ahora ${signed(cs.score)}), estuvo ${happened(past.lean)} en`)}
      <b>${pct(past.rate)}</b> ${T(`of ${past.n} days`, `de ${past.n} días`)} — ${T('on all days', 'en todos los días')} ${pct(past.base)}.
      <em class="v ${past.verdict}">${T(...VERDICT[past.verdict])}</em>`
  }

  const r = recs.get(`${coin}|${hours}`)
  const d = r?.data
  let liveLine
  if (!d) liveLine = r?.err ? T('Live record unavailable right now.', 'Registro en vivo no disponible ahora.') : T('Loading the live record…', 'Cargando el registro en vivo…')
  else if (!d.coin?.n) {
    const waiting = d.pending ? T(` ${d.pending} waiting on ${lab}.`, ` ${d.pending} pendientes en ${lab}.`) : ''
    const all = d.all?.n ? T(` All markets so far: ${pct(d.all.hits / d.all.n)} right of ${d.all.n}.`, ` Todos los mercados: ${pct(d.all.hits / d.all.n)} acertadas de ${d.all.n}.`) : ''
    liveLine = T(`Grading started: every rating is checked ${hz} after it was shown.`, `Calificación iniciada: cada lectura se revisa ${hz} después de mostrarse.`) + waiting + all
  } else {
    const c = d.coin
    const parts = [
      c.up.n ? `${T('bullish', 'alcistas')} ${c.up.hits}/${c.up.n}` : null,
      c.down.n ? `${T('bearish', 'bajistas')} ${c.down.hits}/${c.down.n}` : null,
      c.flat.n ? `${T('neutral', 'neutrales')} ${c.flat.hits}/${c.flat.n}` : null,
      `${T('all markets', 'todos')} ${pct(d.all.hits / d.all.n)} ${T('of', 'de')} ${d.all.n}`,
      d.pending ? `${d.pending} ${T('waiting', 'pendientes')}` : null,
    ].filter(Boolean)
    liveLine = `${T(`${c.n} graded ${lab} calls,`, `${c.n} lecturas calificadas de ${lab},`)} <b>${pct(c.hits / c.n)}</b> ${T('right', 'acertadas')} · ${parts.join(' · ')}`
  }
  return `<div class="ol-rec">
    <div class="ol-rec-h">${T('Track record', 'Historial')}</div>
    <div class="ol-rec-row"><span class="ol-rec-tag">${T('Past year', 'Último año')}</span><div>${pastLine}<div class="ol-rec-note">${T('Trend, momentum and range only: the signals with history. One check a day.', 'Solo tendencia, momento y rango: las señales con historial. Una revisión al día.')}</div></div></div>
    <div class="ol-rec-row"><span class="ol-rec-tag">${T('Live', 'En vivo')}</span><div>${liveLine}<div class="ol-rec-note">${T('The full score as shown, graded by the server at its own price.', 'La puntuación completa tal como se mostró, calificada por el servidor con su propio precio.')}</div></div></div>
  </div>`
}

function headHtml(T) {
  return `<div class="ol-head">
    <div><div class="ol-title">${T('Outlook', 'Perspectiva')}</div>
    <div class="ol-sub">${T('Your positions: three cases, and what the signals lean towards', 'Tus posiciones: tres escenarios y hacia dónde se inclinan las señales')}</div></div>
    <div class="ol-seg">${Object.keys(HORIZONS).map(h => `<button data-ol-h="${h}" class="${h === horizon ? 'on' : ''}">${h}</button>`).join('')}</div>
  </div>`
}

const LEAN = {
  up: ['bullish', 'alcista'], down: ['bearish', 'bajista'], flat: ['neutral', 'neutral'],
}
const STRENGTH = { neutral: ['Neutral', 'Neutral'], weak: ['Weak', 'Débil'], moderate: ['Moderate', 'Moderado'], strong: ['Strong', 'Fuerte'] }

/**
 * One card per MARKET. "group same assets cards together with all individual and account data
 * including account name": in the combined view the same coin held in three accounts was three
 * cards with the same chart, score and cases. The market's read is shown once; the tiles add up
 * every account's P&L in each case; and each account gets its own row — name, side, size, entry,
 * P&L now, liquidation, its own TP and stop, and what each case does to it.
 */
function cardHtml({ coin, ps, raw, price, state }, ctx) {
  const { T, fmtPrice, fmtUSD, prv } = ctx
  const k = coin
  const lab = ctx.coinLabel(coin)
  const multi = ps.length > 1
  const sideOf = (p) => parseFloat(p.szi) > 0 ? 'long' : 'short'
  const sideWord = (s) => s === 'long' ? T('long', 'largo') : T('short', 'corto')
  const badge = (p) => { const s = sideOf(p), lev = p.leverage?.value; return `<span class="ol-side ${s}">${s === 'long' ? T('Long', 'Largo') : T('Short', 'Corto')}${lev ? ` ${lev}×` : ''}</span>` }
  const nameOf = (p) => p._acct ?? ctx.acctName?.() ?? null
  const size = (v) => Number(Math.abs(v).toPrecision(5)).toLocaleString('en-US', { maximumFractionDigits: 6 })
  const money = (v) => v == null ? '—' : prv((v >= 0 ? '+$' : '−$') + fmtUSD(Math.abs(v)))
  const net = ps.reduce((s, p) => s + parseFloat(p.szi), 0)
  const hedged = multi && new Set(ps.map(sideOf)).size > 1
  const head = multi
    ? `<div class="ol-card-head">
        <button class="ol-coin" data-ol-coin="${esc(coin)}">${esc(lab)}</button>
        <span class="ol-naccts">${T(`${ps.length} accounts`, `${ps.length} cuentas`)}</span>
        <span class="ol-net">${net === 0 ? T('Net flat', 'Neto plano') : `${T('Net', 'Neto')} ${sideWord(net > 0 ? 'long' : 'short')} ${prv(size(net))}`}${hedged ? ` · ${T('hedged', 'cubierto')}` : ''}</span>`
    : `<div class="ol-card-head">
        <button class="ol-coin" data-ol-coin="${esc(coin)}">${esc(lab)}</button>
        ${badge(ps[0])}
        ${nameOf(ps[0]) ? `<em class="ol-acct">${esc(nameOf(ps[0]))}</em>` : ''}`
  if (!raw) {
    const msg = state === 'net' ? T('Could not load this market. It will try again.', 'No se pudo cargar este mercado. Se reintentará.')
      : state === 'none' ? T('No candles for this market.', 'Sin velas para este mercado.')
      : T('Loading candles…', 'Cargando velas…')
    return `<div class="ol-card">${head}</div><div class="ol-wait">${msg}</div></div>`
  }
  const setup = analysisFor(coin, price)?.setup ?? null
  const orders = ctx.orders()
  // The market's read is the same for every account; each position adds its own P&L and risk.
  const outs = ps.map(p => outlookFor({ position: p, price, c4: raw.candles['4h'], c1: raw.candles['1d'], setup, ratio: raw.ratio,
    fundingPctHr: ctx.funding(coin), orders, hours: HORIZONS[horizon] }))
  const o = outs[0]
  const sc = o.score
  const tone = !sc ? 'flat' : sc.lean
  const chip = sc ? `<span class="ol-score ${tone}"><b>${sc.score > 0 ? '+' : ''}${sc.score}</b>${T(STRENGTH[sc.strength][0], STRENGTH[sc.strength][1])}${sc.lean !== 'flat' ? ' ' + T(LEAN[sc.lean][0], LEAN[sc.lean][1]) : ''}</span>` : ''

  // With or against: per account, named, when there is more than one.
  let agree = ''
  if (sc && sc.lean !== 'flat') {
    const lean = T(LEAN[sc.lean][0], LEAN[sc.lean][1])
    if (!multi) {
      const a = o.agrees, s = sideWord(sideOf(ps[0]))
      agree = `<div class="ol-agree ${a ? 'with' : 'against'}">${a
        ? T(`Signals lean ${lean} — with your ${s}`, `Las señales se inclinan ${lean} — a favor de tu ${s}`)
        : T(`Signals lean ${lean} — against your ${s}`, `Las señales se inclinan ${lean} — en contra de tu ${s}`)}</div>`
    } else {
      const names = (want) => ps.filter((_, i) => outs[i].agrees === want).map(p => `${esc(nameOf(p) ?? '?')} (${sideWord(sideOf(p))})`)
      const w = names(true), a = names(false)
      const cls = !a.length ? 'with' : !w.length ? 'against' : 'mixed'
      agree = `<div class="ol-agree ${cls}">${T(`Signals lean ${lean}`, `Las señales se inclinan ${lean}`)}${w.length ? ` — ${T('with', 'a favor de')} ${w.join(', ')}` : ''}${a.length ? `${w.length ? ' ·' : ' —'} ${T('against', 'en contra de')} ${a.join(', ')}` : ''}</div>`
    }
  }

  // The tiles: every account's P&L in each case, added up.
  const total = (key) => {
    let pnl = 0, liq = 0
    outs.forEach(x => { const c = x.cases?.[key]; if (!c) return; pnl += c.pnl ?? 0; if (c.liquidated) liq++ })
    return { pnl, liq }
  }
  const tile = (key, name) => {
    const c = o.cases?.[key]
    if (!c) return ''
    const t = total(key)
    const pnlHtml = !multi && c.liquidated ? T('Liquidated', 'Liquidada') : money(t.pnl)
    return `<div class="ol-case ${key}">
      <div class="ol-case-name">${name}</div>
      <div class="ol-case-px">$${fmtPrice(c.px)} <span>${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%</span></div>
      <div class="ol-case-pnl ${(!multi && c.liquidated) || t.pnl < 0 ? 'neg' : 'pos'}">${pnlHtml}</div>
      ${multi && t.liq ? `<div class="ol-case-liq">${T(`${t.liq} liquidated`, `${t.liq} liquidada${t.liq > 1 ? 's' : ''}`)}</div>` : ''}
      <div class="ol-case-p">${key === 'neutral' ? T('stays between', 'se queda entre') : T('touch', 'tocar')} ${chance(c.p)}</div>
      ${c.level ? `<div class="ol-case-lvl">${c.level === 'resistance' ? T('next resistance', 'próxima resistencia') : T('next support', 'próximo soporte')}</div>` : ''}
    </div>`
  }
  const cases = o.cases ? `${multi ? `<div class="ol-cases-cap">${T(`P&L across all ${ps.length} accounts`, `P&L de las ${ps.length} cuentas`)}</div>` : ''}<div class="ol-cases">${tile('bear', T('Bearish', 'Bajista'))}${tile('neutral', T('Neutral', 'Neutral'))}${tile('bull', T('Bullish', 'Alcista'))}</div>` : ''

  // One row per account.
  const rows = ps.map((p, i) => {
    const x = outs[i], r = x.risk, cs = x.cases
    const name = nameOf(p)
    const bits = [
      r?.liq ? `${T('Liq', 'Liq')} <b class="neg">$${fmtPrice(r.liq.px)}</b> <em>${r.liq.sig.toFixed(1)}σ · ${T('touch', 'tocar')} ${chance(r.liq.p)}</em>` : `${T('Liq', 'Liq')} <b>—</b> <em>${T('none in range', 'ninguna cerca')}</em>`,
      r?.tp ? `TP <b class="pos">$${fmtPrice(r.tp.px)}</b> <em>${T('touch', 'tocar')} ${chance(r.tp.p)}</em>` : null,
      r?.sl ? `${T('Stop', 'Stop')} <b class="warn">$${fmtPrice(r.sl.px)}</b> <em>${T('touch', 'tocar')} ${chance(r.sl.p)}</em>` : null,
      r?.tpFirst != null ? `<em>${T(`TP before stop: ${pct(r.tpFirst)}`, `TP antes que el stop: ${pct(r.tpFirst)}`)}</em>` : null,
    ].filter(Boolean)
    const caseCell = (key, word) => { const c = cs?.[key]; return c ? `<span class="${key}">${word} <b class="${c.liquidated || c.pnl < 0 ? 'neg' : 'pos'}">${c.liquidated ? T('liquidated', 'liquidada') : money(c.pnl)}</b></span>` : '' }
    return `<div class="ol-acct-row">
      <div class="ol-acct-top">
        ${multi ? `<b class="ol-acct-name">${esc(name ?? '?')}</b>${badge(p)}` : ''}
        <span class="ol-acct-pos">${prv(size(p.szi))} ${esc(lab)} @ $${fmtPrice(parseFloat(p.entryPx))}</span>
        <span class="ol-acct-upnl">${T('P&L', 'P&L')} <b class="${(parseFloat(p.unrealizedPnl) || 0) >= 0 ? 'pos' : 'neg'}">${money(parseFloat(p.unrealizedPnl) || 0)}</b></span>
      </div>
      <div class="ol-acct-risk">${bits.map(b => `<span>${b}</span>`).join('')}</div>
      ${multi ? `<div class="ol-acct-cases">${caseCell('bear', T('Bearish', 'Bajista'))}${caseCell('neutral', T('Neutral', 'Neutral'))}${caseCell('bull', T('Bullish', 'Alcista'))}</div>` : ''}
    </div>`
  }).join('')
  const accounts = `<div class="ol-accts">${multi ? `<div class="ol-accts-h">${T('By account', 'Por cuenta')}</div>` : ''}${rows}</div>`

  // The chart's reference lines: one position draws its entry, liquidation and orders; a group
  // draws each account's liquidation, named, since that is the line that ends a position.
  const marks = []
  // `short`: a named line leaves its price to the account row; "Liq Swing ↓ $52.000" ran off the chart.
  const add = (px, cls, label, short = false) => { if (px > 0) marks.push({ px, cls, label, short }) }
  if (!multi) {
    add(o.pos?.entry, 'entry', T('Entry', 'Entrada'))
    add(o.risk?.liq?.px, 'liq', T('Liq', 'Liq'))
    add(o.risk?.tp?.px, 'tp', 'TP')
    add(o.risk?.sl?.px, 'sl', 'SL')
  } else ps.forEach((p, i) => add(outs[i].risk?.liq?.px, 'liq', `${T('Liq', 'Liq')} ${nameOf(p) ?? ''}`.trim(), true))

  const open = whyOpen.has(k)
  const why = sc ? `<button class="ol-why-btn" data-ol-why="${esc(k)}">${open ? T('Hide why', 'Ocultar motivos') : T(`Why ${sc.score > 0 ? '+' : ''}${sc.score}? ${sc.agree} of ${sc.of} signals agree`, `¿Por qué ${sc.score > 0 ? '+' : ''}${sc.score}? ${sc.agree} de ${sc.of} señales coinciden`)}</button>
    ${open ? `<div class="ol-why">${o.factors.map(f => factorHtml(f, ctx)).join('')}${sc.coverage < 0.999 ? `<div class="ol-why-note">${T('Signals without data are left out, not counted as neutral.', 'Las señales sin datos se omiten, no cuentan como neutrales.')}</div>` : ''}</div>` : ''}` : ''
  return `<div class="ol-card${multi ? ' ol-group' : ''}">${head}${chip}</div>${agree}
    ${coneSvg(o, raw.candles['4h'], ctx, marks)}
    ${cases}${accounts}${recordHtml(coin, raw, o, ctx)}${why}</div>`
}

const FACTOR_NAME = {
  trend: ['Trend', 'Tendencia'], momentum: ['Momentum', 'Momento'], range: ['Range (4h)', 'Rango (4h)'],
  levels: ['Levels', 'Niveles'], book: ['Order book', 'Libro'], funding: ['Funding', 'Funding'],
}

function factorText(f, { T, fmtPrice }) {
  const x = f.x
  switch (f.id) {
    case 'trend': return `${x.above ? T('Above', 'Sobre') : T('Below', 'Bajo')} ${T('50-day avg', 'media 50d')} $${fmtPrice(x.s50)}${x.golden == null ? '' : ` · ${x.golden ? T('50 above 200: uptrend', '50 sobre 200: alcista') : T('50 below 200: downtrend', '50 bajo 200: bajista')}`}`
    case 'momentum': return [x.rsi != null ? `RSI ${x.rsi.toFixed(0)}${x.rsi >= 75 ? T(' (stretched)', ' (extendido)') : x.rsi <= 25 ? T(' (washed out)', ' (agotado)') : ''}` : null,
      x.macd ? `MACD ${x.macd.now > 0 ? T('above', 'sobre') : T('below', 'bajo')} 0, ${x.macd.now > x.macd.prev ? T('rising', 'subiendo') : T('falling', 'bajando')}` : null].filter(Boolean).join(' · ')
    case 'range': {
      const lastCat = Math.abs(x.last)
      const big = x.big
        ? T(`${x.big} large 4h candle${x.big > 1 ? 's' : ''} in 24h (${x.up} up, ${x.down} down)`, `${x.big} vela${x.big > 1 ? 's' : ''} grande${x.big > 1 ? 's' : ''} de 4h en 24h (${x.up} arriba, ${x.down} abajo)`)
        : T('No large 4h candles in 24h', 'Sin velas grandes de 4h en 24h')
      const reg = x.regime === 'expanding' ? T('candles expanding', 'velas expandiéndose') : x.regime === 'quiet' ? T('candles quiet', 'velas tranquilas') : T('normal size', 'tamaño normal')
      return `${big} · ${T('latest', 'última')} ${T('cat', 'cat')} ${lastCat} (${catLabel(lastCat, T)} ${T('normal', 'normal')}) · ${reg}`
    }
    case 'levels': return ({ breakout: T('Broke above a key level', 'Rompió sobre un nivel clave'), breakdown: T('Broke below a key level', 'Rompió bajo un nivel clave'),
      support: T('At support', 'En soporte'), resistance: T('At resistance', 'En resistencia') })[x.state] ?? T('Between key levels', 'Entre niveles clave')
    case 'book': return T(`Bids ${x.ratio.toFixed(2)}× asks near the price`, `Compras ${x.ratio.toFixed(2)}× ventas cerca del precio`)
    case 'funding': return `${x.pctHr >= 0 ? '+' : ''}${x.pctHr.toFixed(4)}%/h · ${x.pctHr > 0.003 ? T('longs crowded', 'largos saturados') : x.pctHr < 0 ? T('shorts crowded', 'cortos saturados') : T('normal', 'normal')}`
  }
  return ''
}

function factorHtml(f, ctx) {
  const { T } = ctx
  const w = Math.round(Math.abs(f.v) * 50)
  return `<div class="ol-f">
    <div class="ol-f-top"><span>${T(FACTOR_NAME[f.id][0], FACTOR_NAME[f.id][1])}</span><em>${f.w}%</em></div>
    <div class="ol-f-bar"><i class="${f.v >= 0 ? 'pos' : 'neg'}" style="${f.v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></i></div>
    <div class="ol-f-x">${esc(factorText(f, ctx))}</div>
  </div>`
}

// ── the chart: the last days of price, then the cone ──────────────────────
function coneSvg(o, c4, { fmtPrice, T }, marks = []) {
  if (!o.sigma || !o.price || !o.cases) return ''
  const W = 360, H = 168, padR = 66, padT = 8, padB = 10
  const histN = o.hours <= 24 ? 30 : 42
  const hist = (c4 ?? []).slice(-histN).map(k => +k.c).filter(v => v > 0)
  if (hist.length < 2) return ''
  const plotW = W - padR
  const xNow = plotW * (o.hours <= 24 ? 0.66 : 0.55)
  const xAt = (i) => (i / (hist.length - 1)) * xNow
  const cone = (k, f) => o.price * Math.exp(k * o.sigma * Math.sqrt(f))
  let lo = Math.min(...hist, cone(-2, 1)), hi = Math.max(...hist, cone(2, 1))
  const span = hi - lo
  // Entry, liquidation and the orders are drawn when they are within reach; one far away would
  // squash the cone flat, so it gets an arrow at the edge instead.
  for (const m of marks) if (m.px >= lo - span * 0.35 && m.px <= hi + span * 0.35) { lo = Math.min(lo, m.px); hi = Math.max(hi, m.px) }
  const yAt = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB)
  const steps = 16
  const fx = (f) => xNow + f * (plotW - xNow)
  const band = (k) => {
    const up = [], dn = []
    for (let s = 0; s <= steps; s++) { const f = s / steps; up.push(`${fx(f).toFixed(1)},${yAt(cone(k, f)).toFixed(1)}`); dn.push(`${fx(f).toFixed(1)},${yAt(cone(-k, f)).toFixed(1)}`) }
    return [...up, ...dn.reverse()].join(' ')
  }
  const yNow = yAt(o.price)
  const path = hist.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join('')
  // Right-edge labels, pushed apart so two close prices do not print over each other.
  const labels = [
    { y: yAt(o.cases.bull.px), cls: 'bull', t: `$${fmtPrice(o.cases.bull.px)}` },
    { y: yAt(o.cases.neutral.px), cls: 'neutral', t: `$${fmtPrice(o.cases.neutral.px)}` },
    { y: yAt(o.cases.bear.px), cls: 'bear', t: `$${fmtPrice(o.cases.bear.px)}` },
  ]
  const lines = []
  for (const m of marks) {
    if (m.px < lo || m.px > hi) {
      labels.push({ y: m.px > hi ? padT + 4 : H - padB - 2, cls: m.cls, t: `${m.label} ${m.px > hi ? '↑' : '↓'}${m.short ? '' : ` $${fmtPrice(m.px)}`}` })
      continue
    }
    const y = yAt(m.px)
    lines.push(`<line class="ol-m ${m.cls}" x1="0" x2="${plotW}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}"/>`)
    labels.push({ y, cls: m.cls, t: m.short ? m.label : `${m.label} $${fmtPrice(m.px)}` })
  }
  labels.sort((a, b) => a.y - b.y)
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 11) labels[i].y = labels[i - 1].y + 11
  const over = labels.at(-1)?.y - (H - 6)
  if (over > 0) for (const l of labels) l.y -= over
  const end = (px) => yAt(px).toFixed(1)
  return `<svg class="ol-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(T('Price and the range of outcomes', 'Precio y el rango de resultados'))}">
    <polygon class="ol-c2" points="${band(2)}"/>
    <polygon class="ol-c1" points="${band(1)}"/>
    <line class="ol-now" x1="${xNow.toFixed(1)}" x2="${xNow.toFixed(1)}" y1="${padT}" y2="${H - padB}"/>
    ${lines.join('')}
    <path class="ol-px" d="${path}"/>
    <line class="ol-path bull" x1="${xNow.toFixed(1)}" y1="${yNow.toFixed(1)}" x2="${plotW}" y2="${end(o.cases.bull.px)}"/>
    <line class="ol-path neutral" x1="${xNow.toFixed(1)}" y1="${yNow.toFixed(1)}" x2="${plotW}" y2="${end(o.cases.neutral.px)}"/>
    <line class="ol-path bear" x1="${xNow.toFixed(1)}" y1="${yNow.toFixed(1)}" x2="${plotW}" y2="${end(o.cases.bear.px)}"/>
    <circle class="ol-dot" cx="${xNow.toFixed(1)}" cy="${yNow.toFixed(1)}" r="3.2"/>
    ${labels.map(l => `<text class="ol-lbl ${l.cls}" x="${plotW + 4}" y="${(l.y + 3.5).toFixed(1)}">${esc(l.t)}</text>`).join('')}
    <text class="ol-axis" x="2" y="${H - 1}">${T(`${hist.length * 4 / 24 | 0}d ago`, `hace ${hist.length * 4 / 24 | 0}d`)}</text>
    <text class="ol-axis" x="${(xNow + 3).toFixed(1)}" y="${H - 1}">${T('now', 'ahora')} → ${horizon}</text>
  </svg>`
}

// For the suites: the constants the footer and the Range factor describe.
export const OUTLOOK_RANGE = { candles: RANGE_CANDLES, lookback: RANGE_LOOKBACK }
