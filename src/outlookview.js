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
import { ensureAnalysis, analysisFor, analysisRaw, analysisState, setAnalysisDeps, fmtPx, hydrateAnalysis } from './analysis.js'
import { outlookFor, HORIZONS, RANGE_CANDLES, RANGE_LOOKBACK, WEIGHTS, weightsFor, candleIds, PAST_HORIZONS, TESTED_HORIZONS, pastSamples, pastRecord, signalRecords, learnedWeights, learnedScores, weightedScore, coneRecord, pooledRecord, coneScale, bandTable, bandOfScore, halvesRecord, recentLike, weightsOverTime, moveDistribution } from './outlook.js'
import { catLabel } from './simcat.js'
import { leanOf, actionsFor, ideaFor, sortCards, ORACLE_SORTS } from './outlooksuggest.js'
import { posHealthPct } from './posgroup.js'

const LS_H = 'hliq_outlook_h'
const RELOAD_MS = 15 * 60e3
let horizon = (() => { try { const h = localStorage.getItem(LS_H); return h in HORIZONS ? h : '24h' } catch { return '24h' } })()
const whyOpen = new Set()   // card keys whose factor list is open
const recOpen = new Set()   // coin|row of the track record rows opened to their detail
// Cards start folded ("make the cards unextended"): the lean, the score and the P&L in each case.
// The ones opened are remembered on this device — a convenience, so storage failing is fine.
const LS_OPEN = 'hliq_oracle_open'
const cardOpen = new Set((() => { try { return JSON.parse(localStorage.getItem(LS_OPEN)) || [] } catch { return [] } })())
const saveOpen = () => { try { localStorage.setItem(LS_OPEN, JSON.stringify([...cardOpen])) } catch {} }
let last = null             // { host, ctx } — the latest render, for repaints when a load lands
let painted = ''
let pumping = false

// ── version 2: the track record ────────────────────────────────────────────
// The past record replays the candle score over the year of 4h candles already loaded (~40ms a
// market), once per load and horizon. The live record is the server's (/outlook-record), asked
// at most every two minutes per market; and each rating shown is reported to it once an hour per
// market and horizon (/outlook-log) — coin, horizon, score and volatility, nothing about who.
const pastMemo = new Map()     // coin → { k: coin|loadedAt, samples, byH: hours → records }
const recs = new Map()         // coin|hours → { at, data, err }
const logged = new Set()       // coin|hours|hour already reported from this page
let recVer = 0
function pastFor(coin, raw) {
  const k = `${coin}|${raw.at}`
  let e = pastMemo.get(coin)
  if (!e || e.k !== k) { e = { k, samples: pastSamples(raw.candles['4h'], raw.candles['1d']), byH: new Map() }; pastMemo.set(coin, e) }
  return e
}
/** One horizon's view of the replay: learned multipliers now, the walk-forward learned score on
 *  each past day, each signal's record and the cone's. Computed once per load and horizon. */
function pastAt(coin, raw, h) {
  const e = pastFor(coin, raw)
  if (!e.byH.has(h)) {
    const cone = coneRecord(e.samples, h)
    e.byH.set(h, { mult: learnedWeights(e.samples, h), learned: learnedScores(e.samples, h), signals: signalRecords(e.samples, h), cone, scale: coneScale(cone, h) })
  }
  return { samples: e.samples, ...e.byH.get(h) }
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
      if (!onScreen(last?.host)) return   // left the tab: stop loading for it
      const ps = positionsOf(last.ctx) ?? []
      const coins = [...new Set([...ps.map(p => p.coin), ...watchList()])]
      // First what this device kept from last time: every card drawn at once, before any fetch.
      if (await hydrateAnalysis(coins)) paint(true)
      // Then, one at a time, only what is stale — or has no order book yet (it is not kept).
      const due = coins.find(c => {
        const raw = analysisRaw(c), st = analysisState(c)
        if (st === 'loading') return false
        if (st === 'none') return false
        return !raw || Date.now() - raw.at > RELOAD_MS || raw.ratio == null
      })
      if (!due) return
      const mark = (r) => r ? `${r.at}|${r.ratio}` : ''
      const before = mark(analysisRaw(due))
      await ensureAnalysis(due)
      paint(true)
      // ensureAnalysis waits a minute after a failure, and stands down while the app is rate
      // limited. Either way nothing loaded: stop, and the next render tries again.
      if (mark(analysisRaw(due)) === before) return
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
    host.addEventListener('input', (e) => { if (e.target.matches?.('.ol-add-in')) { addMsg = ''; addResults(host, last.ctx, e.target.value) } })
    host.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-ol-rm]')
      if (rm) { saveWatch(watchList().filter(c => c !== rm.dataset.olRm)); cardOpen.delete(rm.dataset.olRm); saveOpen(); paint(true); return }
      const ad = e.target.closest('[data-ol-add]')
      if (ad) {
        addWatch(ad.dataset.olAdd, last.ctx)
        const inp = host.querySelector('.ol-add-in')
        if (inp && !addMsg) inp.value = ''
        addResults(host, last.ctx, addMsg ? 'x' : '')
        if (addMsg) host.querySelector('.ol-add-res').innerHTML = `<div class="ol-add-msg">${esc(addMsg)}</div>`
        paint(true); pump(); return
      }
      const so = e.target.closest('[data-ol-sort]')
      if (so) { sortBy = so.dataset.olSort; try { localStorage.setItem(LS_SORT, sortBy) } catch {} ; paint(true); return }
      const h = e.target.closest('[data-ol-h]')
      if (h) { horizon = h.dataset.olH; try { localStorage.setItem(LS_H, horizon) } catch {} ; paint(true); return }
      const c = e.target.closest('[data-ol-coin]')
      if (c) { last?.ctx.openCoin?.(c.dataset.olCoin); return }
      const rc = e.target.closest('[data-ol-rec]')
      if (rc) { const k = rc.dataset.olRec; recOpen.has(k) ? recOpen.delete(k) : recOpen.add(k); paint(true); return }
      const w = e.target.closest('[data-ol-why]')
      if (w) { const k = w.dataset.olWhy; whyOpen.has(k) ? whyOpen.delete(k) : whyOpen.add(k); paint(true); return }
      // "make the cards be able to unextend more easily": a folded card opens from anywhere on it,
      // an open one folds from its header row (and from "Show less" at the bottom).
      const op = e.target.closest('[data-ol-open]')
      if (op) { const k = op.dataset.olOpen; cardOpen.has(k) ? cardOpen.delete(k) : cardOpen.add(k); saveOpen(); paint(true); return }
    })
  }
  paint(!tick, true)
  pump()
}

// ── what is on the tab: positions, and markets watched without a position ───────
// "let the user add assets that he does not have as positions. make it organized. add sorts."
// Watched markets are kept on this device (a convenience; storage failing just means none) and
// capped: each one never seen costs ~120 weight of the per-IP budget to load, then reloads every
// 15 minutes — still one at a time.
const LS_WATCH = 'hliq_oracle_watch', LS_SORT = 'hliq_oracle_sort'
export const ORACLE_WATCH_MAX = 12
const watchList = () => { try { const v = JSON.parse(localStorage.getItem(LS_WATCH)); return Array.isArray(v) ? v.filter(c => typeof c === 'string') : [] } catch { return [] } }
const saveWatch = (list) => { try { localStorage.setItem(LS_WATCH, JSON.stringify(list)) } catch {} }
let sortBy = (() => { try { const v = localStorage.getItem(LS_SORT); return ORACLE_SORTS.includes(v) ? v : 'default' } catch { return 'default' } })()
let addMsg = ''

/** The tab's frame. The add box lives OUTSIDE what repaints, or a price tick would wipe what is
 *  being typed and drop the keyboard. Rebuilt only when something else took the host over. */
const onScreen = (host) => !!host?.isConnected && !!host.querySelector(':scope > .ol-view > .ol-addbox')
function shell(host, ctx) {
  if (onScreen(host)) return false
  const { T } = ctx
  host.innerHTML = `<div class="ol-view"><div class="ol-top"></div>
    <div class="ol-addbox"><input class="ol-add-in" type="search" autocomplete="off" spellcheck="false"
      placeholder="${esc(T('+ Add a market to watch — BTC, HYPE, GOLD…', '+ Añade un mercado — BTC, HYPE, GOLD…'))}"><div class="ol-add-res"></div></div>
    <div class="ol-body"></div></div>`
  return true
}
function addResults(host, ctx, q) {
  const box = host.querySelector('.ol-add-res')
  if (!box) return
  const { T } = ctx
  q = String(q ?? '').trim().toUpperCase()
  if (!q) { box.innerHTML = addMsg ? `<div class="ol-add-msg">${esc(addMsg)}</div>` : ''; return }
  const held = new Set((positionsOf(ctx) ?? []).map(p => p.coin)), have = new Set(watchList())
  const hits = (ctx.markets?.() ?? [])
    .filter(m => !held.has(m.coin) && !have.has(m.coin))
    .filter(m => m.coin.toUpperCase().includes(q) || String(m.label ?? '').toUpperCase().includes(q))
    .sort((a, b) => (String(a.label).toUpperCase().startsWith(q) ? 0 : 1) - (String(b.label).toUpperCase().startsWith(q) ? 0 : 1) || String(a.label).localeCompare(String(b.label)))
    .slice(0, 8)
  box.innerHTML = hits.length
    ? hits.map(m => `<button data-ol-add="${esc(m.coin)}"><b>${esc(m.label ?? m.coin)}</b>${m.label && m.label !== m.coin ? ` <em>${esc(m.coin)}</em>` : ''}</button>`).join('')
    : `<div class="ol-add-msg">${T('No market matches', 'Ningún mercado coincide')}</div>`
}
function addWatch(coin, ctx) {
  const list = watchList()
  if (list.includes(coin)) return
  if (list.length >= ORACLE_WATCH_MAX) { addMsg = ctx.T(`You can watch up to ${ORACLE_WATCH_MAX} markets — remove one first.`, `Puedes seguir hasta ${ORACLE_WATCH_MAX} mercados — quita uno primero.`); return }
  addMsg = ''
  saveWatch([...list, coin])
}

const SORT_NAME = {
  default: ['Worst health', 'Peor salud'], strong: ['Strongest', 'Más fuerte'], bull: ['Most bullish', 'Más alcista'], bear: ['Most bearish', 'Más bajista'],
  conviction: ['Conviction', 'Convicción'], pnl: ['P&L', 'P&L'], risk: ['Liq. risk', 'Riesgo liq.'], az: ['A–Z', 'A–Z'],
}
function toolsHtml(ctx, held) {
  const { T } = ctx
  const have = new Set(watchList())
  const wl = (ctx.watchlist?.() ?? []).filter(c => !held.has(c) && !have.has(c)).slice(0, 10)
  return `<div class="ol-tools">
      <span class="ol-tools-l">${T('Sort', 'Orden')}</span>
      <div class="ol-sorts" data-dragscroll>${ORACLE_SORTS.map(k => `<button data-ol-sort="${k}" class="${k === sortBy ? 'on' : ''}">${T(...SORT_NAME[k])}</button>`).join('')}</div>
    </div>
    ${wl.length ? `<div class="ol-wl"><span>${T('From your watchlist', 'De tu lista')}</span>${wl.map(c => `<button data-ol-add="${esc(c)}">+ ${esc(ctx.coinLabel(c))}</button>`).join('')}</div>` : ''}`
}
function secHtml(title, list, empty) {
  return `<div class="ol-sec"><div class="ol-sec-h">${title} <span>${list.length}</span></div>${list.length
    ? `<div class="ol-cards">${sortCards(list, sortBy).map(i => i.html).join('')}</div>`
    : `<div class="ol-empty ol-empty-s">${empty}</div>`}</div>`
}

function paint(force, fromRender = false) {
  const { host, ctx } = last ?? {}
  if (!host?.isConnected) return
  // "when i visit the oracle section and exit it redirects me again to oracle": on the phone this
  // tab draws into the same element every home tab does, and a load landing after it was left
  // used to rebuild it there, over the tab the person had moved to. Background work never builds
  // the frame; only an open of the tab (renderOutlook) does.
  if (!onScreen(host) && !fromRender) return
  if (shell(host, ctx)) force = true
  const T = ctx.T
  const ps = positionsOf(ctx)
  // One card per market, its accounts in the order the app lists them.
  const groups = new Map()
  for (const p of ps ?? []) { if (!groups.has(p.coin)) groups.set(p.coin, []); groups.get(p.coin).push(p) }
  const itemOf = (coin, list) => { const raw = analysisRaw(coin); return { coin, ps: list, raw, price: priceOf(ctx, coin, raw), state: analysisState(coin) } }
  const held = [...groups].map(([coin, list]) => itemOf(coin, list))
  // A market both held and watched is shown once, as the position.
  const watched = watchList().filter(c => !groups.has(c)).map(c => itemOf(c, []))
  const items = [...held, ...watched]
  // Repaint only when something on the card would change: a position, a load landing, the price
  // moving a twentieth of a percent, a toggle, the sort, the list watched.
  const sig = [horizon, sortBy, watchList().join(','), recVer, ps == null ? 'unknown' : '', [...whyOpen].join(','), [...recOpen].join(','), [...cardOpen].join(','), ...items.map(i =>
    `${i.coin}:${i.ps.map(p => `${keyOf(p)}:${p.szi}:${p.entryPx}:${p.liquidationPx}:${p.unrealizedPnl}`).join(',')}:${i.raw?.at ?? 0}:${i.state}:${i.price ? Math.round(Math.log(i.price) * 2000) : 0}`)].join('|')
  if (!force && sig === painted) return
  painted = sig
  for (const i of items) i.html = cardHtml(i, ctx)
  host.querySelector('.ol-top').innerHTML = headHtml(T) + toolsHtml(ctx, new Set(groups.keys()))
  host.querySelector('.ol-body').innerHTML = `${items.length >= 2 ? pooledHtml(items, ctx) : ''}
    ${secHtml(T('Your positions', 'Tus posiciones'), held, ps == null ? T('Loading your positions…', 'Cargando tus posiciones…') : T('No open positions.', 'Sin posiciones abiertas.'))}
    ${secHtml(T('Watching', 'Siguiendo'), watched, T('Add any market above to read it here, held or not.', 'Añade cualquier mercado arriba para leerlo aquí, lo tengas o no.'))}
    <div class="ol-foot">${T(
    `Not a prediction. The cone is how far each market has moved in ${horizon} from its last 180 4h candles, calibrated to how often its past moves stayed inside; chances assume no drift and are for touching a price, not ending there. The score is a lean from six signals — read the reasons, not just the number.`,
    `No es una predicción. El cono es cuánto se ha movido cada mercado en ${horizon} según sus últimas 180 velas de 4h; las probabilidades suponen que no hay tendencia y son de tocar un precio, no de terminar ahí. La puntuación es una inclinación de seis señales: lee los motivos, no solo el número.`)}</div>`
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

const HZ = { 1: '1h', 4: '4h', 24: '24h', 72: '3d', 168: '7d', 720: '30d' }
const mv = (x) => x == null ? '—' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`
const CONE_V = {
  calibrated: ['The cone fits this market', 'El cono se ajusta a este mercado'],
  narrow: ['Moves ran bigger than the cone: its chances read low', 'Los movimientos superaron el cono: sus probabilidades se quedan cortas'],
  wide: ['Moves ran smaller than the cone: its chances read high', 'Los movimientos fueron menores que el cono: sus probabilidades se pasan'],
  thin: ['Too few days to tell', 'Muy pocos días para saber'],
}
const VSHORT = { better: ['Beat chance', 'Superó al azar'], worse: ['Worse', 'Peor'], chance: ['Chance', 'Azar'], thin: ['Too few', 'Muy pocos'], none: ['—', '—'] }
const BANDN = { sbear: ['Strongly bearish', 'Muy bajista'], bear: ['Bearish', 'Bajista'], neutral: ['Neutral', 'Neutral'], bull: ['Bullish', 'Alcista'], sbull: ['Strongly bullish', 'Muy alcista'] }
const verdictEm = (v, T) => `<em class="v ${v}">${T(...VERDICT[v])}</em>`
const candleValues = (fs, h) => Object.fromEntries(fs.filter(f => candleIds(h).includes(f.id)).map(f => [f.id, f.v]))
/** "Trend, momentum and range" — or at 4h, "trend, range, 3-day fade and Bollinger stretch". */
const candleNames = (h, T) => {
  const n = candleIds(h).map(id => T(FACTOR_NAME[id][0], FACTOR_NAME[id][1]).replace(' (4h)', ''))
  return n.slice(0, -1).join(', ') + ' ' + T('and', 'y') + ' ' + n.at(-1)
}

/**
 * Track record. Past year: the candle signals replayed (fixed weights, then learned ones,
 * walk-forward), with the size of the move after and the base rate; the cone checked; the same
 * reading at every horizon. Live: the server's grading of the full score as shown, and of the cone.
 * Rendering it also reports this rating and asks for the record — both rate-limited above.
 */
function recordHtml(coin, raw, o, ctx, past) {
  const { T } = ctx
  const hours = o.hours, hz = HZ[hours]
  const lab = esc(ctx.coinLabel(coin))
  ensureRecord(coin, hours)

  const fv = candleValues(o.factors, hours)
  const fixedNow = weightedScore(fv, null, hours), learnedNow = weightedScore(fv, past.mult, hours)
  const happened = (lean, h) => lean === 'up' ? T(`higher ${HZ[h]} later`, `más alto ${HZ[h]} después`)
    : lean === 'down' ? T(`lower ${HZ[h]} later`, `más bajo ${HZ[h]} después`)
    : T(`within its usual range ${HZ[h]} later`, `dentro de su rango usual ${HZ[h]} después`)

  // Past year, fixed weights — and how big the move was.
  const fx = fixedNow == null ? null : pastRecord(past.samples, fixedNow, hours)
  let pastLine
  if (!fx && hours < 4) pastLine = T('No replay at 1h: the candles here are 4h, so the shortest outcome there is to check is 4h.', 'Sin repetición a 1h: aquí las velas son de 4h, así que el resultado más corto que se puede revisar es a 4h.')
  else if (!fx) pastLine = T('Not enough history to replay.', 'No hay historial suficiente.')
  else if (!fx.n) pastLine = `${T(`The candle signals read ${BAND_NAME(fixedNow, T)} now (${signed(fixedNow)}).`, `Las señales de velas marcan ${BAND_NAME(fixedNow, T)} ahora (${signed(fixedNow)}).`)} ${verdictEm('none', T)}`
  else {
    const band = fx.widened ? LEAN_NAME(fixedNow, T) : BAND_NAME(fixedNow, T)
    pastLine = `${T(`When ${lab}'s candle signals read ${band} (now ${signed(fixedNow)}), it was ${happened(fx.lean, hours)} on`,
      `Cuando las señales de velas de ${lab} marcaron ${band} (ahora ${signed(fixedNow)}), estuvo ${happened(fx.lean, hours)} en`)}
      <b>${pct(fx.rate)}</b> ${T(`of ${fx.n} days`, `de ${fx.n} días`)} — ${T('on all days', 'en todos los días')} ${pct(fx.base)}. ${verdictEm(fx.verdict, T)}
      <div class="ol-rec-sub">${T('Average move after', 'Movimiento medio después')} <b>${mv(fx.avgAfter)}</b> · ${T('on all days', 'en todos los días')} ${mv(fx.avgAll)}</div>`
  }

  // Past year, learned weights — graded walk-forward, against the fixed ones.
  const lx = learnedNow == null ? null : pastRecord(past.samples, learnedNow, hours, x => past.learned.get(x))
  const learnedLine = !lx?.n ? T('Not enough history to learn from yet.', 'Aún no hay historial suficiente para aprender.')
    : `${T(`Weighted by how each signal did on ${lab} (now ${signed(learnedNow)}): right`, `Ponderadas por cómo le fue a cada señal en ${lab} (ahora ${signed(learnedNow)}): acertó`)}
      <b>${pct(lx.rate)}</b> ${T(`of ${lx.n} days`, `de ${lx.n} días`)} — ${T('chance', 'azar')} ${pct(lx.base)}. ${verdictEm(lx.verdict, T)}
      ${fx?.n ? `<div class="ol-rec-sub">${lx.z > fx.z + 0.5 ? T('Learning helped on this market.', 'Aprender ayudó en este mercado.') : lx.z < fx.z - 0.5 ? T('Learning made it worse here.', 'Aprender lo empeoró aquí.') : T('Learning made little difference here.', 'Aprender cambió poco aquí.')} ${T('Each day used only what was known by then.', 'Cada día usó solo lo que se sabía entonces.')}</div>` : ''}`

  // The cone, past and live.
  const r = recs.get(`${coin}|${hours}`)
  const d = r?.data
  const c = past.cone
  const coneLine = !c ? T('Not enough history to check.', 'No hay historial suficiente.')
    : `${T('Ended inside the 1σ band on', 'Terminó dentro de la banda de 1σ en')} <b>${pct(c.inside)}</b> ${T(`of ${c.n} days (expect 68%) · touched the bullish line ${pct(c.up)}, the bearish ${pct(c.dn)} (expect 32% each).`, `de ${c.n} días (se espera 68%) · tocó la línea alcista ${pct(c.up)}, la bajista ${pct(c.dn)} (se espera 32% cada una).`)}
      <em class="v ${c.verdict === 'calibrated' ? 'better' : c.verdict === 'thin' ? 'thin' : 'worse'}">${T(...CONE_V[c.verdict])}</em>
      ${Math.abs(past.scale - 1) >= 0.005 ? `<div class="ol-rec-sub">${T(`So the cone on this card is scaled <b>×${past.scale.toFixed(2)}</b> to fit, and so are its touch chances.`, `Así que el cono de esta tarjeta está escalado <b>×${past.scale.toFixed(2)}</b> para ajustarse, y sus probabilidades también.`)}</div>` : ''}
      ${d?.coin?.n && d.coin.inside != null ? `<div class="ol-rec-sub">${T(`Live: inside on ${pct(d.coin.inside / d.coin.n)} of ${d.coin.n} graded.`, `En vivo: dentro en ${pct(d.coin.inside / d.coin.n)} de ${d.coin.n} calificadas.`)}</div>` : ''}`

  // The same reading at every horizon.
  const cells = fixedNow == null ? [] : PAST_HORIZONS.map(h => {
    const x = pastRecord(past.samples, fixedNow, h)
    return x?.n
      ? `<span class="ol-hz ${x.verdict}${h === hours ? ' cur' : ''}">${HZ[h]} <b>${pct(x.rate)}</b> <i>${T('vs', 'vs')} ${pct(x.base)}</i></span>`
      : `<span class="ol-hz${h === hours ? ' cur' : ''}">${HZ[h]} —</span>`
  })
  const hzLine = cells.length ? `<div class="ol-hzs">${cells.join('')}</div><div class="ol-rec-note">${T('How often this reading was right at each horizon, vs any day. Green beat chance, red did worse.', 'Con qué frecuencia esta lectura acertó en cada horizonte, vs cualquier día. Verde superó al azar, rojo lo hizo peor.')}</div>` : ''

  // Live.
  let liveLine
  if (!d) liveLine = r?.err ? T('Live record unavailable right now.', 'Registro en vivo no disponible ahora.') : T('Loading the live record…', 'Cargando el registro en vivo…')
  else if (!d.coin?.n) {
    const waiting = d.pending ? T(` ${d.pending} waiting on ${lab}.`, ` ${d.pending} pendientes en ${lab}.`) : ''
    const all = d.all?.n ? T(` All markets so far: ${pct(d.all.hits / d.all.n)} right of ${d.all.n}.`, ` Todos los mercados: ${pct(d.all.hits / d.all.n)} acertadas de ${d.all.n}.`) : ''
    liveLine = T(`Grading started: every rating is checked ${hz} after it was shown.`, `Calificación iniciada: cada lectura se revisa ${hz} después de mostrarse.`) + waiting + all
  } else {
    const cc = d.coin
    const parts = [
      cc.up.n ? `${T('bullish', 'alcistas')} ${cc.up.hits}/${cc.up.n}` : null,
      cc.down.n ? `${T('bearish', 'bajistas')} ${cc.down.hits}/${cc.down.n}` : null,
      cc.flat.n ? `${T('neutral', 'neutrales')} ${cc.flat.hits}/${cc.flat.n}` : null,
      `${T('all markets', 'todos')} ${pct(d.all.hits / d.all.n)} ${T('of', 'de')} ${d.all.n}`,
      d.pending ? `${d.pending} ${T('waiting', 'pendientes')}` : null,
    ].filter(Boolean)
    liveLine = `${T(`${cc.n} graded ${lab} calls,`, `${cc.n} lecturas calificadas de ${lab},`)} <b>${pct(cc.hits / cc.n)}</b> ${T('right', 'acertadas')} · ${parts.join(' · ')}`
  }
  // ── Each row opens to its detail ("make this section each individually expandable") ──
  const isOpen = (key) => recOpen.has(`${coin}|${key}`)
  const day = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const dayY = (t) => new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
  const when = (t) => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  const tbl = (head, rows) => `<div class="ol-tbl-wrap" data-dragscroll><table class="ol-tbl"><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
  const vshort = (v) => `<span class="v ${v}">${T(...VSHORT[v ?? 'none'])}</span>`
  const ok = (h) => h ? `<span class="ok">✓</span>` : `<span class="no">✗</span>`
  const sub = (s) => `<div class="ol-rec-dh">${s}</div>`

  const pastDetail = () => {
    if (fixedNow == null) return ''
    const bt = bandTable(past.samples, hours)
    const cur = bandOfScore(fixedNow)?.id
    const halves = halvesRecord(past.samples, fixedNow, hours)
    const like = recentLike(past.samples, fixedNow, hours)
    const s0 = past.samples?.[0]?.t, s1 = past.samples?.at(-1)?.t
    return [
      s0 != null ? `<div class="ol-rec-since">${T(`Replayed on ${past.samples.length} days of ${lab}, <b>${dayY(s0)}</b> to <b>${dayY(s1)}</b>`, `Reproducido en ${past.samples.length} días de ${lab}, <b>${dayY(s0)}</b> a <b>${dayY(s1)}</b>`)}</div>` : '',
      bt ? sub(T(`Every reading, ${hz} after`, `Cada lectura, ${hz} después`)) + tbl(
        [T('Reading', 'Lectura'), T('Days', 'Días'), T('Right', 'Acertó'), T('Chance', 'Azar'), T('Avg move', 'Mov. medio'), ''],
        bt.map(b => `<tr class="${b.band === cur ? 'cur' : ''}"><td>${T(...BANDN[b.band])}</td><td>${b.n}</td><td>${b.n ? pct(b.rate) : '—'}</td><td>${pct(b.base)}</td><td>${b.n ? mv(b.avgAfter) : '—'}</td><td>${b.n ? vshort(b.verdict) : ''}</td></tr>`)) : '',
      halves ? sub(T('Did it hold across the year?', '¿Se sostuvo durante el año?')) + `<div class="ol-rec-pair">${halves.map((x, i) => `<span><b>${i ? T('Second half', 'Segunda mitad') : T('First half', 'Primera mitad')}</b> ${x?.n ? `${pct(x.rate)} ${T('of', 'de')} ${x.n} · ${T('chance', 'azar')} ${pct(x.base)} ${vshort(x.verdict)}` : '—'}</span>`).join('')}</div>` : '',
      like.length ? sub(T(`The last ${like.length} days that read like today`, `Los últimos ${like.length} días que marcaron como hoy`)) + tbl(
        [T('Day', 'Día'), T('Score', 'Puntaje'), T(`Move ${hz} after`, `Mov. ${hz} después`), T('Right?', '¿Acertó?')],
        like.map(x => `<tr><td>${day(x.t)}</td><td>${signed(x.s)}</td><td class="${x.move >= 0 ? 'pos' : 'neg'}">${mv(x.move)}</td><td>${ok(x.hit)}</td></tr>`)) : '',
    ].join('')
  }

  const learnedDetail = () => {
    const ids = candleIds(hours)
    const sig = past.signals ?? {}
    const over = weightsOverTime(past.samples, hours)
    return [
      sub(T(`Each signal on ${lab}, at ${hz}`, `Cada señal en ${lab}, a ${hz}`)) + tbl(
        [T('Signal', 'Señal'), T('Calls', 'Lecturas'), T('Right', 'Acertó'), T('Chance', 'Azar'), T('Avg per call', 'Media/lectura'), T('Weight', 'Peso')],
        ids.map(id => { const r = sig[id]; const m = past.mult?.[id] ?? 1
          return `<tr><td>${T(...FACTOR_NAME[id])}</td><td>${r?.n ?? 0}</td><td>${r?.n ? pct(r.rate) : '—'}</td><td>${r?.n ? pct(r.chance) : '—'}</td><td>${r?.n ? mv(r.edge) : '—'}</td><td class="${m > 1.005 ? 'pos' : m < 0.995 ? 'neg' : ''}">×${m.toFixed(2)}</td></tr>` })),
      over.length ? sub(T('How the weights moved through the year', 'Cómo cambiaron los pesos durante el año')) + tbl(
        [T('Up to', 'Hasta'), ...ids.map(id => T(...FACTOR_NAME[id]))],
        over.map(w => `<tr><td>${day(w.t)}</td>${ids.map(id => `<td>×${(w.m[id] ?? 1).toFixed(2)}</td>`).join('')}</tr>`)) : '',
      `<div class="ol-rec-note">${T('A signal right more often than chance on this market counts more (up to ×2), one right less often counts less (down to ×0.25); few calls pull it towards ×1.', 'Una señal que acierta más que el azar en este mercado cuenta más (hasta ×2), una que acierta menos cuenta menos (hasta ×0,25); pocas lecturas la acercan a ×1.')}</div>`,
    ].join('')
  }

  const coneDetail = () => {
    const dist = moveDistribution(past.samples, hours)
    const lo = (b) => b.hi === Infinity ? T(`over ${b.lo}σ`, `más de ${b.lo}σ`) : `${b.lo}–${b.hi}σ`
    return [
      dist ? sub(T(`How big the moves were, ${hz} after`, `Qué tan grandes fueron los movimientos, ${hz} después`)) + tbl(
        [T('Move', 'Movimiento'), T('Days', 'Días'), T('Share', 'Parte'), T('Expected', 'Esperado')],
        dist.map(b => `<tr><td>${lo(b)}</td><td>${b.n}</td><td class="${b.share > b.expect + 0.05 ? 'warn' : ''}">${pct(b.share)}</td><td>${pct(b.expect)}</td></tr>`)) : '',
      sub(T('The cone at every timeframe', 'El cono en cada marco')) + tbl(
        [T('Timeframe', 'Marco'), T('Days', 'Días'), T('Inside 1σ', 'Dentro 1σ'), T('Bull line', 'Línea alcista'), T('Bear line', 'Línea bajista'), T('Scale', 'Escala')],
        PAST_HORIZONS.map(h => { const c = coneRecord(past.samples, h); return c ? `<tr class="${h === hours ? 'cur' : ''}"><td>${HZ[h]}</td><td>${c.n}</td><td>${pct(c.inside)}</td><td>${pct(c.up)}</td><td>${pct(c.dn)}</td><td>×${coneScale(c, h).toFixed(2)}</td></tr>` : `<tr><td>${HZ[h]}</td><td colspan="5">—</td></tr>` })),
      `<div class="ol-rec-note">${T('Expected: 68% inside 1σ, 32% touching each line. Moves bigger than that make the cone too narrow, smaller ones too wide; the scale corrects it.', 'Esperado: 68% dentro de 1σ, 32% tocando cada línea. Movimientos mayores hacen el cono angosto, menores ancho; la escala lo corrige.')}</div>`,
    ].join('')
  }

  const hzDetail = () => fixedNow == null ? '' : tbl(
    [T('Timeframe', 'Marco'), T('Days', 'Días'), T('Right', 'Acertó'), T('Chance', 'Azar'), T('Avg move after', 'Mov. medio después'), T('On any day', 'Cualquier día'), ''],
    PAST_HORIZONS.map(h => { const x = pastRecord(past.samples, fixedNow, h); return x?.n
      ? `<tr class="${h === hours ? 'cur' : ''}"><td>${HZ[h]}</td><td>${x.n}</td><td>${pct(x.rate)}</td><td>${pct(x.base)}</td><td>${mv(x.avgAfter)}</td><td>${mv(x.avgAll)}</td><td>${vshort(x.verdict)}</td></tr>`
      : `<tr><td>${HZ[h]}</td><td colspan="6">—</td></tr>` })) + `<div class="ol-rec-note">${T(`For a reading like today's (${signed(fixedNow)}). 7d and 30d windows overlap day to day, so they need more days to say anything.`, `Para una lectura como la de hoy (${signed(fixedNow)}). Las ventanas de 7d y 30d se solapan, así que necesitan más días.`)}</div>`

  const liveDetail = () => {
    if (!d) return ''
    const leanRow = (name, x) => `<tr><td>${name}</td><td>${x?.n ?? 0}</td><td>${x?.n ? x.hits : '—'}</td><td>${x?.n ? pct(x.hits / x.n) : '—'}</td></tr>`
    const t1 = (title, rec) => sub(title) + tbl([T('Call', 'Lectura'), T('Graded', 'Calificadas'), T('Right', 'Acertadas'), '%'],
      [leanRow(T('Bullish', 'Alcista'), rec?.up), leanRow(T('Bearish', 'Bajista'), rec?.down), leanRow(T('Neutral', 'Neutral'), rec?.flat),
       `<tr class="cur"><td>${T('All', 'Todas')}</td><td>${rec?.n ?? 0}</td><td>${rec?.n ? rec.hits : '—'}</td><td>${rec?.n ? pct(rec.hits / rec.n) : '—'}</td></tr>`])
    const rows = (d.recent ?? []).map(e => `<tr><td>${when(e.t)}</td><td>${signed(e.score)}</td><td>$${fmtPx(e.px)} → $${fmtPx(e.end)}</td><td class="${e.end >= e.px ? 'pos' : 'neg'}">${mv((e.end / e.px - 1) * 100)}</td><td>${ok(e.hit)}</td></tr>`)
    const wait = (d.waiting ?? []).map(e => `<tr><td>${when(e.t)}</td><td>${signed(e.score)}</td><td>$${fmtPx(e.px)}</td><td>${when(e.due)}</td></tr>`)
    // Since when: the first call this coin's log holds at this horizon, and the whole log's.
    const since = d.since != null
      ? `<div class="ol-rec-since">${T(`Tracking ${lab} at ${hz} since <b>${when(d.since)}</b>`, `Siguiendo ${lab} a ${hz} desde <b>${when(d.since)}</b>`)} · ${d.logged ?? 0} ${T('logged', 'registradas')} · ${d.coin?.n ?? 0} ${T('graded', 'calificadas')} · ${d.pending ?? 0} ${T('waiting', 'pendientes')}${d.expired ? ` · ${d.expired} ${T('missed (server was late)', 'perdidas (servidor tarde)')}` : ''}${d.allSince != null ? `<br>${T('Every market since', 'Todos los mercados desde')} ${when(d.allSince)}` : ''}</div>`
      : ''
    return [
      since,
      t1(T(`${lab}, ${hz}`, `${lab}, ${hz}`), d.coin),
      t1(T(`Every market, ${hz}`, `Todos los mercados, ${hz}`), d.all),
      d.coin?.n && d.coin.inside != null ? `<div class="ol-rec-note">${T(`Ended inside the cone's 1σ on ${pct(d.coin.inside / d.coin.n)} of ${d.coin.n} graded (expect 68%).`, `Terminó dentro de 1σ del cono en ${pct(d.coin.inside / d.coin.n)} de ${d.coin.n} calificadas (se espera 68%).`)}</div>` : '',
      wait.length ? sub(T('Waiting to be graded', 'Esperando calificación')) + tbl(
        [T('Shown', 'Mostrada'), T('Score', 'Puntaje'), T('Price then', 'Precio entonces'), T('Graded at', 'Se califica')], wait)
        + (d.pending > wait.length ? `<div class="ol-rec-note">${T(`and ${d.pending - wait.length} more.`, `y ${d.pending - wait.length} más.`)}</div>` : '') : '',
      rows.length ? sub(T(`Log: the last ${rows.length} graded calls on ${lab}`, `Registro: las últimas ${rows.length} lecturas calificadas de ${lab}`)) + tbl(
        [T('Shown', 'Mostrada'), T('Score', 'Puntaje'), T(`Price → ${hz} later`, `Precio → ${hz} después`), T('Move', 'Mov.'), T('Right?', '¿Acertó?')], rows) : '',
    ].join('')
  }

  const row = (key, tag, body, note = '', detail = null) => {
    const open = isOpen(key), k = `${esc(coin)}|${key}`
    return `<div class="ol-rec-row${open ? ' open' : ''}">
      <button class="ol-rec-tag" data-ol-rec="${k}" aria-expanded="${open}">${tag} <i>${open ? '▴' : '▾'}</i></button>
      <div class="ol-rec-sum" data-ol-rec="${k}">${body}${note ? `<div class="ol-rec-note">${note}</div>` : ''}</div>
    </div>${open ? `<div class="ol-rec-detail">${(detail && detail()) || `<div class="ol-rec-note">${T('Nothing more to show yet.', 'Nada más que mostrar aún.')}</div>`}</div>` : ''}`
  }
  return `<div class="ol-rec">
    <div class="ol-rec-h">${T(`Track record · ${hz}`, `Historial · ${hz}`)} <span>${T('tap a row for its detail', 'toca una fila para ver el detalle')}</span></div>
    ${row('past', T('Past year', 'Último año'), pastLine, T(`${candleNames(hours, T)} only: the signals with history. One check a day.`, `Solo ${candleNames(hours, T)}: las señales con historial. Una revisión al día.`), pastDetail)}
    ${row('learned', T('Learned', 'Aprendido'), learnedLine, '', learnedDetail)}
    ${row('cone', T('Cone', 'Cono'), coneLine, '', coneDetail)}
    ${row('hz', T('Horizons', 'Horizontes'), hzLine, '', hzDetail)}
    ${row('live', T('Live', 'En vivo'), liveLine, T('The full score as shown, graded by the server at its own price.', 'La puntuación completa tal como se mostró, calificada por el servidor con su propio precio.'), liveDetail)}
  </div>`
}

/** All the markets on screen, pooled: more days than any one of them has. Two or more only. */
function pooledHtml(items, ctx) {
  const { T } = ctx
  const h = HORIZONS[horizon]
  const byCoin = items.filter(i => i.raw).map(i => pastFor(i.coin, i.raw).samples)
  if (byCoin.length < 2) return ''
  const r = pooledRecord(byCoin, h)
  const part = (lean, word) => r[lean]?.n ? `<span>${word} ${T('reads right', 'acertaron')} <b>${pct(r[lean].rate)}</b> ${T('of', 'de')} ${r[lean].n} <i>(${T('chance', 'azar')} ${pct(r[lean].chance)})</i> ${verdictEm(r[lean].verdict, T)}</span>` : null
  const parts = [part('up', T('Bullish', 'Alcistas')), part('down', T('Bearish', 'Bajistas'))].filter(Boolean)
  if (!parts.length && !r.cone) return ''
  return `<div class="ol-pool">
    <div class="ol-rec-h">${T(`Your ${r.markets} markets pooled · past year · ${HZ[h]}`, `Tus ${r.markets} mercados juntos · último año · ${HZ[h]}`)}</div>
    <div class="ol-pool-rows">${parts.join('')}</div>
    ${r.cone ? `<div class="ol-rec-note">${T(`Cone: ended inside 1σ on ${pct(r.cone.inside)} of ${r.cone.n} days (expect 68%).`, `Cono: terminó dentro de 1σ en ${pct(r.cone.inside)} de ${r.cone.n} días (se espera 68%).`)}</div>` : ''}
  </div>`
}

function headHtml(T) {
  return `<div class="ol-head">
    <div><div class="ol-title">${T('Oracle', 'Oráculo')}</div>
    <div class="ol-sub">${T('Your positions and the markets you watch: three cases, and what the signals lean towards', 'Tus posiciones y los mercados que sigues: tres escenarios y hacia dónde se inclinan las señales')}</div></div>
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
function cardHtml(item, ctx) {
  const { coin, ps, raw, price, state } = item
  const watch = !ps.length
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
  const head = watch
    ? `<div class="ol-card-head" data-ol-open="${esc(coin)}">
        <button class="ol-coin" data-ol-coin="${esc(coin)}">${esc(lab)}</button>
        <span class="ol-watching">${T('Watching', 'Siguiendo')}</span>
        <button class="ol-rm" data-ol-rm="${esc(coin)}" title="${esc(T('Stop watching', 'Dejar de seguir'))}">✕</button>`
    : multi
    ? `<div class="ol-card-head" data-ol-open="${esc(coin)}">
        <button class="ol-coin" data-ol-coin="${esc(coin)}">${esc(lab)}</button>
        <span class="ol-naccts">${T(`${ps.length} accounts`, `${ps.length} cuentas`)}</span>
        <span class="ol-net">${net === 0 ? T('Net flat', 'Neto plano') : `${T('Net', 'Neto')} ${sideWord(net > 0 ? 'long' : 'short')} ${prv(size(net))}`}${hedged ? ` · ${T('hedged', 'cubierto')}` : ''}</span>`
    : `<div class="ol-card-head" data-ol-open="${esc(coin)}">
        <button class="ol-coin" data-ol-coin="${esc(coin)}">${esc(lab)}</button>
        ${badge(ps[0])}
        ${nameOf(ps[0]) ? `<em class="ol-acct">${esc(nameOf(ps[0]))}</em>` : ''}`
  if (!raw) {
    const msg = state === 'net' ? T('Could not load this market. It will try again.', 'No se pudo cargar este mercado. Se reintentará.')
      : state === 'none' ? T('No candles for this market.', 'Sin velas para este mercado.')
      : T('Loading candles…', 'Cargando velas…')
    return `<div class="ol-card ol-loading">${head}</div><div class="ol-wait">${msg}</div></div>`
  }
  const setup = analysisFor(coin, price)?.setup ?? null
  const orders = ctx.orders()
  // The market's read is the same for every account; each position adds its own P&L and risk.
  // The candle signals weighted by how they have done on this market (learnedWeights, walk-forward).
  const past = pastAt(coin, raw, HORIZONS[horizon])
  const outs = (watch ? [null] : ps).map(p => outlookFor({ position: p, price, c4: raw.candles['4h'], c1: raw.candles['1d'], setup, ratio: raw.ratio,
    fundingPctHr: ctx.funding(coin), orders, hours: HORIZONS[horizon], mult: past.mult, sigmaScale: past.scale }))
  const o = outs[0]
  const L = suggestionFor(coin, raw, price, setup, ps, outs, o, ctx, orders)
  // Reported whether the card is open or folded: the live record grades what was shown.
  if ((o.score?.coverage ?? 0) >= 0.9) logRating(coin, o.hours, o.score.score, o.sigma)
  const sc = o.score
  const tone = !sc ? 'flat' : sc.lean
  const chip = sc ? `<span class="ol-score ${tone}"><b>${sc.score > 0 ? '+' : ''}${sc.score}</b>${T(STRENGTH[sc.strength][0], STRENGTH[sc.strength][1])}${sc.lean !== 'flat' ? ' ' + T(LEAN[sc.lean][0], LEAN[sc.lean][1]) : ''}</span>` : ''

  // With or against: per account, named, when there is more than one.
  let agree = ''
  if (!watch && sc && sc.lean !== 'flat') {
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
      ${watch ? '' : `<div class="ol-case-pnl ${(!multi && c.liquidated) || t.pnl < 0 ? 'neg' : 'pos'}">${pnlHtml}</div>`}
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
  const accounts = watch ? '' : `<div class="ol-accts">${multi ? `<div class="ol-accts-h">${T('By account', 'Por cuenta')}</div>` : ''}${rows}</div>`

  // The chart's reference lines: one position draws its entry, liquidation and orders; a group
  // draws each account's liquidation, named, since that is the line that ends a position.
  const marks = []
  // `short`: a named line leaves its price to the account row; "Liq Swing ↓ $52.000" ran off the chart.
  const add = (px, cls, label, short = false) => { if (px > 0) marks.push({ px, cls, label, short }) }
  if (watch) { /* nothing held: no entry, liquidation or orders to draw */ } else if (!multi) {
    add(o.pos?.entry, 'entry', T('Entry', 'Entrada'))
    add(o.risk?.liq?.px, 'liq', T('Liq', 'Liq'))
    add(o.risk?.tp?.px, 'tp', 'TP')
    add(o.risk?.sl?.px, 'sl', 'SL')
  } else ps.forEach((p, i) => add(outs[i].risk?.liq?.px, 'liq', `${T('Liq', 'Liq')} ${nameOf(p) ?? ''}`.trim(), true))
  // What the sorts read (sortCards).
  const liqs = outs.map(x => x.risk?.liq?.sig).filter(v => Number.isFinite(v))
  // Health as the position cards show it (posgroup.js): 100 at entry, 0 at liquidation. The card's
  // is its worst account's — liquidation is per account and does not merge. A watched market has none.
  const healths = ps.map(p => posHealthPct(p.szi, p.entryPx, p.liquidationPx, price)).filter(Number.isFinite)
  item.keys = { health: healths.length ? Math.min(...healths) : null, score: sc?.score ?? null, conviction: L.conviction, pnl: watch ? null : ps.reduce((s, p) => s + (parseFloat(p.unrealizedPnl) || 0), 0), risk: liqs.length ? Math.min(...liqs) : null, name: lab }

  const open = whyOpen.has(k)
  const why = sc ? `<button class="ol-why-btn" data-ol-why="${esc(k)}">${open ? T('Hide why', 'Ocultar motivos') : T(`Why ${sc.score > 0 ? '+' : ''}${sc.score}? ${sc.agree} of ${sc.of} signals agree`, `¿Por qué ${sc.score > 0 ? '+' : ''}${sc.score}? ${sc.agree} de ${sc.of} señales coinciden`)}</button>
    ${open ? `<div class="ol-why">${o.factors.map(f => factorHtml(f, ctx, past.signals)).join('')}<div class="ol-why-note">${T(`${candleNames(HORIZONS[horizon], T)} are weighted by how each has called ${esc(lab)} over the past year (×0.25 to ×2), at ${HZ[HORIZONS[horizon]]}.`, `${candleNames(HORIZONS[horizon], T)} se ponderan según cómo ha acertado cada una en ${esc(lab)} el último año (×0,25 a ×2), a ${HZ[HORIZONS[horizon]]}.`)}</div>${HORIZONS[horizon] <= 4 ? `<div class="ol-why-note">${T('At 4h the score is a different set. Tested on a year of 4h candles across 19 markets, fading a 3-day move and a Bollinger stretch called the next 4 hours better than chance in both halves of the year; momentum called it wrong (43% vs 50%), so it is left out here.', 'A 4h la puntuación usa otro conjunto. Probado con un año de velas de 4h en 19 mercados, ir contra el movimiento de 3 días y el estiramiento de Bollinger acertaron las siguientes 4 horas mejor que el azar en ambas mitades del año; el momento falló (43% vs 50%), así que aquí se omite.')}</div>` : ''}${sc.coverage < 0.999 ? `<div class="ol-why-note">${T('Signals without data are left out, not counted as neutral.', 'Las señales sin datos se omiten, no cuentan como neutrales.')}</div>` : ''}</div>` : ''}` : ''
  if (!cardOpen.has(coin)) return miniHtml({ coin, ps, outs, o, L, head, chip, multi, setup, total, money, ctx, watch, price })
  return `<div class="ol-card${multi ? ' ol-group' : ''}${watch ? ' ol-watch' : ''}">${head}${chip}</div>${agree}
    ${sugHtml(L, ps, outs, setup, ctx, lab, multi)}
    ${coneSvg(o, raw.candles['4h'], ctx, marks)}
    ${cases}${accounts}${recordHtml(coin, raw, o, ctx, past)}${why}
    <button class="ol-less" data-ol-open="${esc(coin)}">${T('Show less', 'Mostrar menos')} ▴</button></div>`
}

/** A folded card: the lean and how sure, the P&L now and in each case, and a warning if any
 *  account's liquidation is close. Tapping it opens the whole card. */
function miniHtml({ coin, ps, outs, o, L, head, chip, multi, setup, total, money, ctx, watch, price }) {
  const { T, fmtPrice } = ctx
  const tone = L.lean === 'up' ? 'up' : L.lean === 'down' ? 'down' : 'flat'
  const now = ps.reduce((s, p) => s + (parseFloat(p.unrealizedPnl) || 0), 0)
  const cell = (key, name) => { const c = o.cases?.[key], t = total(key); return !c ? '' : watch
    ? `<span class="${key}">${name} <b>$${fmtPrice(c.px)}</b> <i>${c.pct >= 0 ? '+' : ''}${c.pct.toFixed(1)}%</i></span>`
    : `<span class="${key}">${name} <b class="${t.pnl < 0 ? 'neg' : 'pos'}">${money(t.pnl)}</b></span>` }
  const close = ps.filter((p, i) => actionsFor(L, outs[i], setup).some(a => a.id === 'cutRisk'))
  return `<div class="ol-card ol-mini${multi ? ' ol-group' : ''}${watch ? ' ol-watch' : ''}" data-ol-open="${esc(coin)}">${head}${chip}</div>
    <button class="ol-mini-body" data-ol-open="${esc(coin)}">
      <div class="ol-mini-lean ${tone}">${T(...KIND[L.kind])}
        <span class="ol-conv c${L.conviction}">${[1, 2, 3].map(k => `<i class="${k <= L.conviction ? 'on' : ''}"></i>`).join('')} ${T(...CONV[L.conviction])}</span></div>
      <div class="ol-mini-row">${watch ? `<span>${T('Price', 'Precio')} <b>$${fmtPrice(price)}</b></span>` : `<span>${T('P&L now', 'P&L ahora')} <b class="${now < 0 ? 'neg' : 'pos'}">${money(now)}</b></span>`}${cell('bear', T('Bear', 'Bajista'))}${cell('neutral', T('Neutral', 'Neutral'))}${cell('bull', T('Bull', 'Alcista'))}</div>
      ${close.length ? `<div class="ol-mini-warn">${T('Liquidation close', 'Liquidación cerca')}${multi ? ': ' + close.map(p => esc(p._acct ?? '?')).join(', ') : ''}</div>` : ''}
      <div class="ol-mini-more">${T('Details', 'Detalles')} ▾</div>
    </button>
  </div>`
}

// ── the suggestion (src/outlooksuggest.js) ────────────────────────────────────
const CONV = [['No edge', 'Sin ventaja'], ['Low', 'Baja'], ['Medium', 'Media'], ['High', 'Alta']]
const KIND = {
  pullback: ['Leans to a pullback (mean reversion)', 'Se inclina a un retroceso (reversión a la media)'],
  bounce: ['Leans to a bounce (mean reversion)', 'Se inclina a un rebote (reversión a la media)'],
  'trend-up': ['Leans up (trend)', 'Se inclina al alza (tendencia)'],
  'trend-down': ['Leans down (trend)', 'Se inclina a la baja (tendencia)'],
  none: ['No clear lean', 'Sin inclinación clara'],
}
/** The lean for the next 4h, from the tested 4h set, with this market's record for a reading like it. */
function suggestionFor(coin, raw, price, setup, ps, outs, o, ctx, orders) {
  // "build it": the horizon on screen, like the rest of the card. Its conviction is capped where
  // no signal set has beaten chance (TESTED_HORIZONS), and the box says so.
  const h = o.hours
  const p4 = pastAt(coin, raw, h)
  const o4 = o.hours === h ? o : outlookFor({ position: ps[0], price, c4: raw.candles['4h'], c1: raw.candles['1d'], setup, ratio: raw.ratio,
    fundingPctHr: ctx.funding(coin), orders, hours: h, mult: p4.mult, sigmaScale: p4.scale })
  const learned4 = weightedScore(candleValues(o4.factors, h), p4.mult, h)
  const rec4 = learned4 == null ? null : pastRecord(p4.samples, learned4, h, x => p4.learned.get(x))
  return { ...leanOf(o4, rec4, TESTED_HORIZONS.includes(h)), hours: h }
}
function sugHtml(L, ps, outs, setup, ctx, lab, multi) {
  const { T, fmtPrice } = ctx
  const px = (v) => `$${fmtPrice(v)}`
  const st = L.stretch ?? {}
  let why
  if (L.kind === 'pullback' || L.kind === 'bounce') {
    const bits = [
      st.move3d != null ? T(`${st.move3d >= 0 ? 'up' : 'down'} ${Math.abs(st.move3d * 100).toFixed(1)}% in 3 days`, `${st.move3d >= 0 ? 'subió' : 'bajó'} ${Math.abs(st.move3d * 100).toFixed(1)}% en 3 días`) : null,
      st.sd != null ? T(`${Math.abs(st.sd).toFixed(1)} sd ${st.sd >= 0 ? 'above' : 'below'} its 20-candle average`, `${Math.abs(st.sd).toFixed(1)} de ${st.sd >= 0 ? 'sobre' : 'bajo'} su media de 20 velas`) : null,
    ].filter(Boolean)
    why = `${esc(lab)} ${T('is', 'está')} ${bits.join(T(' and ', ' y '))}. ${L.kind === 'pullback'
      ? T('The tested 4h signals expect it to give some of that back.', 'Las señales de 4h probadas esperan que devuelva parte.')
      : T('The tested 4h signals expect it to recover some of that.', 'Las señales de 4h probadas esperan que recupere parte.')}`
  } else if (L.kind === 'none') {
    why = T('The tested 4h signals are quiet or cancel each other out.', 'Las señales de 4h probadas están tranquilas o se anulan.')
  } else {
    why = T(`Trend and large candles point ${L.lean === 'up' ? 'up' : 'down'}, and the mean-reversion signals do not stand in the way.`, `La tendencia y las velas grandes apuntan ${L.lean === 'up' ? 'arriba' : 'abajo'}, y las señales de reversión no se oponen.`)
  }
  const r = L.record
  const recLine = !r?.n ? '' : `<div class="ol-sug-rec">${T(`On ${esc(lab)}, a ${HZ[L.hours]} reading like this was right ${pct(r.rate)} of ${r.n} times (chance ${pct(r.base)}).`, `En ${esc(lab)}, una lectura de ${HZ[L.hours]} así acertó ${pct(r.rate)} de ${r.n} veces (azar ${pct(r.base)}).`)} ${verdictEm(r.verdict, T)}</div>`
  const sideWord = (side, n) => side === 'long' ? (n > 1 ? T('longs', 'largos') : T('long', 'largo')) : (n > 1 ? T('shorts', 'cortos') : T('short', 'corto'))
  const words = (a, side, n = 1) => {
    const s = sideWord(side, n), th = n > 1 ? T('these', 'estos') : T('this', 'este')
    switch (a.id) {
      case 'cutRisk': return T(`Liquidation at ${px(a.px)} is only ${a.sig.toFixed(1)}σ away: consider reducing size or adding margin.`, `La liquidación en ${px(a.px)} está a solo ${a.sig.toFixed(1)}σ: considera reducir tamaño o añadir margen.`)
      case 'noEdge': return T(`No edge in the next ${HZ[L.hours]}: stick to your plan.`, `Sin ventaja en las próximas ${HZ[L.hours]}: sigue tu plan.`)
      case 'setStop': return T(`No stop on ${th} ${s}: consider one beyond ${px(a.px)}.`, `Sin stop en ${th} ${s}: considera uno más allá de ${px(a.px)}.`)
      case 'takeSome': return T(`In profit with the lean against you: consider taking some off.`, `En ganancia con la inclinación en contra: considera tomar parte.`)
      case 'dontAdd': return a.px ? T(`The lean is against ${th} ${s}: hold off adding; a better price may come near ${px(a.px)}.`, `La inclinación va contra ${th} ${s}: no añadas aún; un mejor precio podría llegar cerca de ${px(a.px)}.`)
        : T(`The lean is against ${th} ${s}: hold off adding.`, `La inclinación va contra ${th} ${s}: no añadas aún.`)
      case 'hold': return T(`The lean is with ${th} ${s}: holding fits.`, `La inclinación va con ${th} ${s}: mantener encaja.`)
      case 'setTarget': return T(`No take-profit: the next level your way is ${px(a.px)}.`, `Sin take-profit: el próximo nivel a tu favor es ${px(a.px)}.`)
      case 'addOnDip': return side === 'long' ? T('Adding into the dip fits the bounce read.', 'Añadir en la caída encaja con el rebote.') : T('Adding into the rally fits the pullback read.', 'Añadir en la subida encaja con el retroceso.')
    }
    return ''
  }
  // The same advice to several accounts is ONE line ("group them so it does not keep repeating
  // the same stuff"): accounts on the same side get each action once, named together. Advice that
  // differs only by price — each account's own liquidation, its own stop — is one line listing them.
  const groups = new Map()
  ps.forEach((p, i) => {
    const side = parseFloat(p.szi) > 0 ? 'long' : 'short'
    for (const a of actionsFor(L, outs[i], setup)) {
      const perAcct = a.id === 'cutRisk' || a.id === 'setStop'
      const k = perAcct ? `${a.id}|${side}` : `${a.id}|${side}|${a.px != null ? fmtPrice(a.px) : ''}`
      if (!groups.has(k)) groups.set(k, { a, side, members: [] })
      groups.get(k).members.push({ p, a })
    }
  })
  const nameOf = (p) => esc(p._acct ?? '?')
  const items = [...groups.values()].map(({ a, side, members }) => {
    const n = members.length
    const samePx = new Set(members.map(m => m.a.px != null ? fmtPrice(m.a.px) : '')).size === 1
    const who = multi ? `<b>${members.map(m => nameOf(m.p)).join(', ')}</b> (${sideWord(side, n)}): ` : ''
    if (multi && n > 1 && a.id === 'cutRisk') return `<li class="ol-act cutRisk">${T('Liquidation close', 'Liquidación cerca')} — ${members.map(m => `<b>${nameOf(m.p)}</b> ${px(m.a.px)} (${m.a.sig.toFixed(1)}σ)`).join(', ')}: ${T('consider reducing size or adding margin.', 'considera reducir tamaño o añadir margen.')}</li>`
    if (multi && n > 1 && a.id === 'setStop' && !samePx) return `<li class="ol-act setStop">${T(`No stop on these ${sideWord(side, n)}`, `Sin stop en estos ${sideWord(side, n)}`)} — ${T('consider one beyond', 'considera uno más allá de')} ${members.map(m => `<b>${nameOf(m.p)}</b> ${px(m.a.px)}`).join(', ')}.</li>`
    return `<li class="ol-act ${a.id}">${who}${words(a, side, n)}</li>`
  })
  if (!ps.length) for (const a of ideaFor(L, outs[0], setup)) items.push(a.id === 'entryIdea'
    ? `<li class="ol-act entryIdea">${T(`Not held. If you want in, the lean favors a ${a.side === 'long' ? 'long' : 'short'}`, `Sin posición. Si quieres entrar, la inclinación favorece un ${a.side === 'long' ? 'largo' : 'corto'}`)}${a.stop ? T(`: a stop beyond ${px(a.stop)}`, `: un stop más allá de ${px(a.stop)}`) : ''}${a.target ? T(`, a first target near ${px(a.target)}`, `, un primer objetivo cerca de ${px(a.target)}`) : ''}.</li>`
    : `<li class="ol-act noEdge">${words(a, 'long')}</li>`)
  const tone = L.lean === 'up' ? 'up' : L.lean === 'down' ? 'down' : 'flat'
  return `<div class="ol-sug ${tone}">
    <div class="ol-sug-top"><span class="ol-sug-tag">${T(`Suggestion · next ${HZ[L.hours]}`, `Sugerencia · próximas ${HZ[L.hours]}`)}</span>
      <span class="ol-conv c${L.conviction}" title="${esc(T('How strong the reading is, and whether this market\'s own record backs it', 'Qué tan fuerte es la lectura y si el historial de este mercado la respalda'))}">${[1, 2, 3].map(k => `<i class="${k <= L.conviction ? 'on' : ''}"></i>`).join('')} ${T(...CONV[L.conviction])}</span></div>
    <div class="ol-sug-lean">${T(...KIND[L.kind])}</div>
    ${L.tested ? '' : `<div class="ol-sug-untested">${L.hours < 4
      ? T('Untested at 1h: there is no replay at 1h, so this reads the 4h signals and conviction stays Low.', 'Sin probar a 1h: no hay repetición a 1h, así que lee las señales de 4h y la convicción se queda baja.')
      : T(`Untested at ${HZ[L.hours]}: no signal set has beaten chance at this timeframe, so conviction stays Low. Tested: 4h.`, `Sin probar a ${HZ[L.hours]}: ningún conjunto de señales superó al azar en este marco, así que la convicción se queda baja. Probado: 4h.`)}</div>`}
    <div class="ol-sug-why">${why}</div>
    ${recLine}
    ${items.length ? `<ul class="ol-acts">${items.join('')}</ul>` : ''}
    <div class="ol-sug-note">${T('A reading of the signals, not financial advice. Conviction stays low unless the timeframe is tested and this market\'s own record backs it.', 'Una lectura de las señales, no asesoría financiera. La convicción se queda baja salvo que el marco esté probado y el historial de este mercado la respalde.')}</div>
  </div>`
}

const FACTOR_NAME = {
  trend: ['Trend', 'Tendencia'], momentum: ['Momentum', 'Momento'], range: ['Range (4h)', 'Rango (4h)'],
  rev3d: ['3-day fade', 'Contra 3 días'], bbFade: ['Bollinger stretch', 'Estiramiento Bollinger'],
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
    case 'rev3d': return x.move == null ? '' : `${x.move >= 0 ? T('Up', 'Subió') : T('Down', 'Bajó')} ${Math.abs(x.move * 100).toFixed(1)}% ${T('in 3 days', 'en 3 días')} · ${T('leaning against it', 'en contra')}`
    case 'bbFade': return `${T('Close', 'Cierre')} ${Math.abs(x.sd).toFixed(1)} ${T('sd', 'de')} ${x.sd >= 0 ? T('above', 'sobre') : T('below', 'bajo')} ${T('its 20-candle average', 'su media de 20 velas')} · ${T('leaning back', 'inclina de vuelta')}`
    case 'funding': return `${x.pctHr >= 0 ? '+' : ''}${x.pctHr.toFixed(4)}%/h · ${x.pctHr > 0.003 ? T('longs crowded', 'largos saturados') : x.pctHr < 0 ? T('shorts crowded', 'cortos saturados') : T('normal', 'normal')}`
  }
  return ''
}

function factorHtml(f, ctx, recs) {
  const { T } = ctx
  const w = Math.round(Math.abs(f.v) * 50)
  const base = weightsFor(HORIZONS[horizon])[f.id] ?? f.w
  const wt = f.m != null && Math.abs(f.m - 1) > 0.005 ? `${base}% <b class="${f.m > 1 ? 'pos' : 'neg'}">×${f.m.toFixed(2)}</b>` : `${base}%`
  const r = recs?.[f.id]
  const hist = !candleIds(HORIZONS[horizon]).includes(f.id) ? T('No history here to check this one.', 'Aquí no hay historial para revisar esta.')
    : !r?.n ? T('Past year: it made no calls.', 'Último año: no hizo ninguna lectura.')
    : `${T(`Past year: right ${pct(r.rate)} of ${r.n} calls · chance ${pct(r.chance)} · avg ${mv(r.edge)} per call`, `Último año: acertó ${pct(r.rate)} de ${r.n} · azar ${pct(r.chance)} · media ${mv(r.edge)} por lectura`)} ${verdictEm(r.verdict, T)}`
  return `<div class="ol-f">
    <div class="ol-f-top"><span>${T(FACTOR_NAME[f.id][0], FACTOR_NAME[f.id][1])}</span><em>${wt}</em></div>
    <div class="ol-f-bar"><i class="${f.v >= 0 ? 'pos' : 'neg'}" style="${f.v >= 0 ? 'left:50%' : `left:${50 - w}%`};width:${w}%"></i></div>
    <div class="ol-f-x">${esc(factorText(f, ctx))}</div>
    <div class="ol-f-rec">${hist}</div>
  </div>`
}

// ── the chart: the last days of price, then the cone ──────────────────────
function coneSvg(o, c4, { fmtPrice, T }, marks = []) {
  if (!o.sigma || !o.price || !o.cases) return ''
  const W = 360, H = 168, padR = 66, padT = 8, padB = 10
  // 4h candles of history before "now": about three times the horizon, within reason.
  const histN = { 1: 12, 4: 18, 24: 30, 72: 36, 168: 42, 720: 120 }[o.hours] ?? 30
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
    ${labels.map(l => l.t.length > 11
      ? `<text class="ol-lbl ${l.cls}" x="${W - 1}" text-anchor="end" y="${(l.y + 3.5).toFixed(1)}">${esc(l.t)}</text>`
      : `<text class="ol-lbl ${l.cls}" x="${plotW + 4}" y="${(l.y + 3.5).toFixed(1)}">${esc(l.t)}</text>`).join('')}
    <text class="ol-axis" x="2" y="${H - 1}">${T(`${hist.length * 4 / 24 | 0}d ago`, `hace ${hist.length * 4 / 24 | 0}d`)}</text>
    <text class="ol-axis" x="${(xNow + 3).toFixed(1)}" y="${H - 1}">${T('now', 'ahora')} → ${horizon}</text>
  </svg>`
}

// For the suites: the constants the footer and the Range factor describe.
export const OUTLOOK_RANGE = { candles: RANGE_CANDLES, lookback: RANGE_LOOKBACK }
