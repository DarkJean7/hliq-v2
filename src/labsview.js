/**
 * INSOLVENT TERMINAL — Labs, on screen
 *
 * Build a strategy on the spot out of signals, groups and rules, and see what it would have done
 * on past Hyperliquid candles while you are still building it. The arithmetic is src/labs.js and
 * the statistics are btstats.js, the simulator's own; this is the form, the fetch and the report.
 *
 * Nothing here is per-account, places an order, or moves money. Strategies are kept in this
 * browser only (localStorage `hliq_labs_v1`).
 *
 * Two things the screen is careful about:
 *   TYPING SURVIVES. A number or a name is saved as it changes without rebuilding the form; only
 *     a choice that changes the form's shape (a different indicator, a different operator) does.
 *     The results under it repaint on their own, so a run follows the edit without stealing focus.
 *   ONE FETCH PER MARKET. Candles are cached per market, interval and length for ten minutes:
 *     editing a strategy forty times costs nothing from the per-IP budget order placement shares.
 */
import './labs.css'
import { runLab, labRows, makesCycle, groupFormula, nextId, coerceStrategy,
         LAB_SOURCES, LAB_OPS, LAB_ACTIONS, LAB_PRESETS, LAB_TEMPLATES, LAB_RISK_DEFAULTS } from './labs.js'
import { summarize } from './btstats.js'
import { fetchCandles } from './trading.js'
import { fmtUSD, fmtPrice, esc } from './format.js'

let ctx = {
  T: (en) => en,
  viewHost: () => null,
  fullHeader: (title) => `<div>${esc(title)}</div>`,
  toast: () => {},
  resolveMarketId: (s) => String(s ?? '').trim().toUpperCase(),
  coinLabel: (c) => String(c ?? ''),
  markets: () => [],
  maxLeverage: () => null,
  isShowing: () => true,
}
export function initLabs(o = {}) { ctx = { ...ctx, ...o } }
const T = (en, es) => ctx.T(en, es)

// ── storage ─────────────────────────────────────────────────────────────────────────────────
const KEY = 'hliq_labs_v1'
const IVS = { '15m': 900e3, '1h': 3600e3, '4h': 14400e3, '1d': 86400e3 }
const COUNTS = [500, 1000, 2000, 5000]
let store = null
function load() {
  if (store) return store
  let raw = null
  try { raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') } catch {}
  const list = (Array.isArray(raw?.list) ? raw.list : []).map(coerceStrategy)
  if (!list.length) list.push(coerceStrategy({ ...LAB_TEMPLATES[0].make(), id: 'dip' }))
  const t = raw?.test ?? {}
  store = {
    list, active: list.some(s => s.id === raw?.active) ? raw.active : list[0].id,
    test: { coin: typeof t.coin === 'string' && t.coin ? t.coin : 'BTC', iv: IVS[t.iv] ? t.iv : '4h', count: COUNTS.includes(+t.count) ? +t.count : 2000 },
  }
  return store
}
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)) } catch {} }
const cur = () => { const s = load(); return s.list.find(x => x.id === s.active) ?? s.list[0] }

// ── candles ─────────────────────────────────────────────────────────────────────────────────
const CACHE_MS = 10 * 60e3
const cache = new Map()
let loading = null, loadErr = ''
const testKey = () => { const t = load().test; return `${t.coin}|${t.iv}|${t.count}` }
async function loadCandles() {
  const t = load().test, key = testKey()
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.rows
  if (loading?.key === key) return loading.p
  const ms = IVS[t.iv]
  const p = (async () => {
    const raw = await fetchCandles(t.coin, t.iv, Date.now() - t.count * ms * 1.05)
    // The last candle is still forming; its close is not a close yet, and a rule read on it
    // would be read on a price that later changes.
    const now = Date.now()
    const rows = labRows(raw).filter(r => r.t + ms <= now).slice(-t.count)
    cache.set(key, { rows, at: Date.now() })
    return rows
  })()
  loading = { key, p }
  try { return await p } finally { if (loading?.key === key) loading = null }
}

// ── running ─────────────────────────────────────────────────────────────────────────────────
let result = null       // { key, rows, r, sum, coin }
let timer = null
function schedule(ms = 180) { clearTimeout(timer); timer = setTimeout(() => runNow(false), ms) }
async function runNow(fetch = true) {
  const key = testKey()
  let rows = cache.get(key)?.rows
  if (!rows) {
    if (!fetch) return
    loadErr = ''
    paintResults()
    try { rows = await loadCandles() }
    catch (e) {
      const m = String(e?.message ?? e)
      loadErr = /500|422/.test(m) ? T('Hyperliquid has no candles for that market.', 'Hyperliquid no tiene velas para ese mercado.') : m.slice(0, 120)
      paintResults(); return
    }
    if (testKey() !== key) return
  }
  if (rows.length < 50) { loadErr = T('Not enough history on this market for a test.', 'No hay historial suficiente en este mercado.'); result = null; paintResults(); return }
  loadErr = ''
  const coin = load().test.coin
  let maxLev = null
  try { maxLev = Number(ctx.maxLeverage(coin)) } catch {}
  const strat = cur()
  const r = runLab(rows, strat, Number.isFinite(maxLev) && maxLev >= 1 ? { maxLev } : {})
  result = { key, rows, r, coin, stratId: strat.id, sum: summarize(r, { [coin]: rows }, [coin]) }
  paintResults()
}

/** A result is only shown for the market, candles AND strategy it was run on: another strategy's numbers under this one's name would be believed. */
const fresh = () => !!result && result.key === testKey() && result.stratId === cur().id

// ── helpers ─────────────────────────────────────────────────────────────────────────────────
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const letterOf = (s, id) => { const i = (s.signals ?? []).findIndex(x => x.id === id); return i >= 0 ? (LETTERS[i] ?? String(i + 1)) : '' }
const nameOf = (s, id) => s.signals.find(x => x.id === id)?.name ?? s.groups.find(x => x.id === id)?.name ?? '?'
const refLabel = (s, id) => { const l = letterOf(s, id); return l ? `${l} · ${nameOf(s, id)}` : `◆ ${nameOf(s, id)}` }
const shortLabel = (s, id) => letterOf(s, id) || nameOf(s, id)
const pct = (v, d = 1) => v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d) + '%'
const cls = (v) => v == null ? '' : v > 0 ? 'lab-pos' : v < 0 ? 'lab-neg' : ''
const fmtNum = (v) => v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2)
function fmtT(t, iv = load().test.iv) {
  const d = new Date(t)
  const o = { month: 'short', day: 'numeric', year: '2-digit' }
  if (iv !== '1d') { o.hour = '2-digit'; o.minute = '2-digit' }
  return d.toLocaleString(undefined, o)
}
const PARAM_LABEL = { n: () => T('len', 'long'), k: () => 'σ', f: () => T('fast', 'rápida'), s: () => T('slow', 'lenta'), g: () => T('signal', 'señal'), m: () => '×' }

function setPath(obj, path, val) {
  const ks = path.split('.')
  let o = obj
  for (let i = 0; i < ks.length - 1; i++) { if (o[ks[i]] == null || typeof o[ks[i]] !== 'object') o[ks[i]] = {}; o = o[ks[i]] }
  o[ks[ks.length - 1]] = val
}

// ── the form ────────────────────────────────────────────────────────────────────────────────
function srcSelect(attrs, src) {
  const groups = [
    [T('Price', 'Precio'), ['close', 'open', 'high', 'low', 'sma', 'ema', 'hh', 'll', 'bbUp', 'bbMid', 'bbLow']],
    [T('Momentum', 'Momento'), ['rsi', 'stoch', 'macd', 'macdSig', 'macdHist', 'change', 'streak']],
    [T('Volatility & volume', 'Volatilidad y volumen'), ['atrPct', 'volume', 'volAvg', 'trend']],
  ]
  return `<select ${attrs}>${groups.map(([g, ks]) => `<optgroup label="${esc(g)}">${ks.map(k =>
    `<option value="${k}"${k === src ? ' selected' : ''}>${esc(T(LAB_SOURCES[k].en, LAB_SOURCES[k].es))}</option>`).join('')}</optgroup>`).join('')}</select>`
}
function paramInputs(id, side, srcObj) {
  const def = LAB_SOURCES[srcObj?.src]?.p ?? []
  return def.map(([k, d]) => `<label class="lab-par"><span>${PARAM_LABEL[k]?.() ?? k}</span><input type="number" inputmode="decimal" step="any" min="0" data-sig="${id}" data-k="${side}.p.${k}" value="${esc(srcObj?.p?.[k] ?? d)}"></label>`).join('')
}
function signalCard(s, sig, i) {
  const unary = LAB_OPS[sig.op]?.unary
  const rt = sig.right?.type === 'src' ? 'src' : 'value'
  const ops = Object.entries(LAB_OPS).map(([k, o]) => `<option value="${k}"${k === sig.op ? ' selected' : ''}>${esc(T(o.en, o.es))}</option>`).join('')
  const used = s.groups.filter(g => g.members.some(m => m.ref === sig.id)).length + s.rules.filter(r => r.ref === sig.id).length
  return `<div class="lab-card" data-card="${sig.id}">
    <div class="lab-card-head">
      <span class="lab-tag">${LETTERS[i] ?? i + 1}</span>
      <input class="lab-name" data-sig="${sig.id}" data-k="name" value="${esc(sig.name)}" maxlength="40" aria-label="${esc(T('Signal name', 'Nombre de la señal'))}">
      <span class="lab-fire" data-fire="${sig.id}"></span>
      <button type="button" class="lab-icon" data-act="dupSig" data-id="${sig.id}" title="${esc(T('Duplicate', 'Duplicar'))}">⧉</button>
      <button type="button" class="lab-icon" data-act="delSig" data-id="${sig.id}" title="${esc(T('Delete', 'Eliminar'))}">×</button>
    </div>
    <div class="lab-expr">
      ${srcSelect(`data-sig="${sig.id}" data-k="left.src"`, sig.left.src)}${paramInputs(sig.id, 'left', sig.left)}
      <select data-sig="${sig.id}" data-k="op">${ops}</select>
      ${unary ? '' : `<select data-sig="${sig.id}" data-k="right.type">
          <option value="value"${rt === 'value' ? ' selected' : ''}>${esc(T('a number', 'un número'))}</option>
          <option value="src"${rt === 'src' ? ' selected' : ''}>${esc(T('a series', 'una serie'))}</option></select>
        ${rt === 'value'
          ? `<input type="number" inputmode="decimal" step="any" class="lab-val" data-sig="${sig.id}" data-k="right.value" value="${esc(sig.right.value)}">`
          : `${srcSelect(`data-sig="${sig.id}" data-k="right.src"`, sig.right.src)}${paramInputs(sig.id, 'right', sig.right)}
             <label class="lab-par"><span>×</span><input type="number" inputmode="decimal" step="any" data-sig="${sig.id}" data-k="right.mult" value="${esc(sig.right.mult ?? 1)}"></label>`}`}
    </div>
    <div class="lab-sub">${T('true for', 'verdadera durante')} <input type="number" min="1" step="1" class="lab-mini" data-sig="${sig.id}" data-k="bars" value="${sig.bars ?? 1}"> ${T('candle(s) in a row', 'vela(s) seguidas')}${used ? '' : ` · <span class="lab-warn">${T('not used by any group or rule yet', 'aún sin usar en grupos ni reglas')}</span>`}</div>
  </div>`
}
function groupCard(s, g) {
  const cand = [...s.signals.map(x => x.id), ...s.groups.filter(x => x.id !== g.id).map(x => x.id)]
  const chips = cand.map(id => {
    const m = g.members.find(x => x.ref === id)
    const st = !m ? 'off' : m.not ? 'not' : 'on'
    const cyc = !m && makesCycle(s, g.id, id)
    return `<button type="button" class="lab-chip lab-chip-${st}" data-act="chip" data-g="${g.id}" data-ref="${id}"${cyc ? ' disabled title="' + esc(T('That group already contains this one', 'Ese grupo ya contiene este')) + '"' : ''} aria-pressed="${st !== 'off'}">${st === 'not' ? 'NOT ' : ''}<span data-name-of="${id}">${esc(refLabel(s, id))}</span></button>`
  }).join('')
  const n = g.members.length
  return `<div class="lab-card lab-gcard" data-card="${g.id}">
    <div class="lab-card-head">
      <span class="lab-tag lab-tag-g">◆</span>
      <input class="lab-name" data-grp="${g.id}" data-k="name" value="${esc(g.name)}" maxlength="40" aria-label="${esc(T('Group name', 'Nombre del grupo'))}">
      <span class="lab-fire" data-fire="${g.id}"></span>
      <button type="button" class="lab-icon" data-act="dupGrp" data-id="${g.id}" title="${esc(T('Duplicate', 'Duplicar'))}">⧉</button>
      <button type="button" class="lab-icon" data-act="delGrp" data-id="${g.id}" title="${esc(T('Delete', 'Eliminar'))}">×</button>
    </div>
    <div class="lab-expr">
      <span>${T('True when', 'Verdadero cuando')}</span>
      <select data-grp="${g.id}" data-k="mode">
        <option value="all"${g.mode === 'all' ? ' selected' : ''}>${esc(T('ALL of', 'TODAS'))}</option>
        <option value="any"${g.mode === 'any' ? ' selected' : ''}>${esc(T('ANY of', 'ALGUNA'))}</option>
        <option value="atleast"${g.mode === 'atleast' ? ' selected' : ''}>${esc(T('AT LEAST', 'AL MENOS'))}</option>
      </select>
      ${g.mode === 'atleast' ? `<input type="number" min="1" step="1" class="lab-mini" data-grp="${g.id}" data-k="k" value="${g.k}"> <span>${T('of', 'de')}</span>` : ''}
      <span>${T('these, within the last', 'estas, en las últimas')}</span>
      <input type="number" min="1" step="1" class="lab-mini" data-grp="${g.id}" data-k="within" value="${g.within}">
      <span>${T('candle(s)', 'vela(s)')}</span>
    </div>
    <div class="lab-chips">${chips || `<span class="lab-hint">${T('Add signals first.', 'Primero añade señales.')}</span>`}</div>
    <div class="lab-formula" data-formula="${g.id}">${esc(groupFormula(s, g, id => shortLabel(s, id)))}</div>
    ${n ? '' : `<div class="lab-hint">${T('Tap a signal to include it, again to require it NOT be true, a third time to leave it out.', 'Toca una señal para incluirla, otra vez para exigir que NO sea verdadera, una tercera para quitarla.')}</div>`}
  </div>`
}
function refOptions(s, sel) {
  const o = (id) => `<option value="${id}"${id === sel ? ' selected' : ''} data-name-of="${id}">${esc(refLabel(s, id))}</option>`
  return (s.signals.length ? `<optgroup label="${esc(T('Signals', 'Señales'))}">${s.signals.map(x => o(x.id)).join('')}</optgroup>` : '')
    + (s.groups.length ? `<optgroup label="${esc(T('Groups', 'Grupos'))}">${s.groups.map(x => o(x.id)).join('')}</optgroup>` : '')
}
function rulesHtml(s) {
  if (!s.signals.length && !s.groups.length) return `<div class="lab-hint">${T('Rules pair a signal or group with an action. Add a signal first.', 'Las reglas unen una señal o grupo con una acción. Añade una señal primero.')}</div>`
  const rows = s.rules.map((r, i) => `<div class="lab-rule">
      <span class="lab-rule-n">${i + 1}</span>
      <span>${T('When', 'Cuando')}</span>
      <select data-rule="${i}" data-k="ref">${refOptions(s, r.ref)}</select>
      <span>→</span>
      <select data-rule="${i}" data-k="action" class="lab-act-${r.action}">${Object.entries(LAB_ACTIONS).map(([k, a]) => `<option value="${k}"${k === r.action ? ' selected' : ''}>${esc(T(a.en, a.es))}</option>`).join('')}</select>
      <span class="lab-rule-btns">
        <button type="button" class="lab-icon" data-act="ruleUp" data-i="${i}" ${i ? '' : 'disabled'} aria-label="${esc(T('Move up', 'Subir'))}">↑</button>
        <button type="button" class="lab-icon" data-act="ruleDown" data-i="${i}" ${i < s.rules.length - 1 ? '' : 'disabled'} aria-label="${esc(T('Move down', 'Bajar'))}">↓</button>
        <button type="button" class="lab-icon" data-act="delRule" data-i="${i}" aria-label="${esc(T('Delete', 'Eliminar'))}">×</button>
      </span>
    </div>`).join('')
  return `${rows || `<div class="lab-hint">${T('No rules yet: signals light up, but nothing trades.', 'Aún no hay reglas: las señales se encienden, pero nada opera.')}</div>`}
    <button type="button" class="lab-btn lab-btn-ghost" data-act="addRule">+ ${T('Add rule', 'Añadir regla')}</button>
    <div class="lab-hint">${T('Read top to bottom on every closed candle; orders fill at the next candle’s open. Hold stops the rules under it.', 'Se leen de arriba abajo en cada vela cerrada; las órdenes se llenan en la apertura de la siguiente. Mantener detiene las reglas de debajo.')}</div>`
}
function riskHtml(s) {
  const r = { ...LAB_RISK_DEFAULTS, ...s.risk }
  const f = (k, en, es, unit, hint = '') => `<label class="lab-field"><span>${esc(T(en, es))}</span>
    <span class="lab-inp"><input type="number" inputmode="decimal" step="any" min="0" data-risk="${k}" value="${esc(r[k])}">${unit ? `<em>${unit}</em>` : ''}</span>${hint ? `<small>${esc(hint)}</small>` : ''}</label>`
  return `<div class="lab-fields">
    ${f('sizePct', 'Position size', 'Tamaño', '% ' + T('of balance', 'del saldo'))}
    ${f('leverage', 'Leverage', 'Apalancamiento', '×')}
    ${f('stopPct', 'Stop loss', 'Stop loss', '%', T('0 = off', '0 = desactivado'))}
    ${f('targetPct', 'Take profit', 'Take profit', '%', T('0 = off', '0 = desactivado'))}
    ${f('trailPct', 'Trailing stop', 'Stop dinámico', '%', T('0 = off', '0 = desactivado'))}
    ${f('maxBars', 'Max hold', 'Duración máx.', T('candles', 'velas'), T('0 = no limit', '0 = sin límite'))}
    ${f('feeBps', 'Taker fee', 'Comisión taker', 'bps')}
    ${f('slipBps', 'Slippage', 'Deslizamiento', 'bps')}
  </div>`
}
function testBar() {
  const t = load().test
  const mk = (ctx.markets() ?? []).slice().sort((a, b) => (b.vol ?? 0) - (a.vol ?? 0)).slice(0, 300)
  return `<div class="lab-test">
    <label class="lab-field lab-f-mkt"><span>${T('Market', 'Mercado')}</span>
      <input data-test="coin" list="labMkts" value="${esc(ctx.coinLabel(t.coin))}" autocomplete="off" spellcheck="false">
      <datalist id="labMkts">${mk.map(m => `<option value="${esc(m.name ?? m.id)}">`).join('')}</datalist></label>
    <label class="lab-field"><span>${T('Candles', 'Velas')}</span>
      <select data-test="iv">${Object.keys(IVS).map(k => `<option${k === t.iv ? ' selected' : ''}>${k}</option>`).join('')}</select></label>
    <label class="lab-field"><span>${T('How many', 'Cuántas')}</span>
      <select data-test="count">${COUNTS.map(n => `<option value="${n}"${n === t.count ? ' selected' : ''}>${n.toLocaleString()}</option>`).join('')}</select></label>
    <label class="lab-field"><span>${T('Start balance', 'Saldo inicial')}</span>
      <span class="lab-inp"><input type="number" inputmode="decimal" min="10" step="any" data-risk="balance" value="${esc(cur().risk.balance ?? 1000)}"><em>USDC</em></span></label>
    <button type="button" class="lab-btn lab-btn-run" data-act="run">${T('Run test', 'Probar')}</button>
  </div>`
}
function stratBar() {
  const st = load(), s = cur()
  return `<div class="lab-strat">
    <select data-act-change="pick" aria-label="${esc(T('Saved strategies', 'Estrategias guardadas'))}">${st.list.map(x => `<option value="${x.id}"${x.id === s.id ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <input class="lab-name lab-sname" data-strat="name" value="${esc(s.name)}" maxlength="60" aria-label="${esc(T('Strategy name', 'Nombre de la estrategia'))}">
    <select data-act-change="newFrom" class="lab-new" aria-label="${esc(T('New strategy', 'Nueva estrategia'))}">
      <option value="">+ ${esc(T('New…', 'Nueva…'))}</option>
      ${LAB_TEMPLATES.map(x => `<option value="${x.key}">${esc(T(x.en, x.es))}</option>`).join('')}
    </select>
    <button type="button" class="lab-icon" data-act="dupStrat" title="${esc(T('Duplicate strategy', 'Duplicar estrategia'))}">⧉</button>
    <button type="button" class="lab-icon" data-act="delStrat" title="${esc(T('Delete strategy', 'Eliminar estrategia'))}" ${st.list.length > 1 ? '' : 'disabled'}>×</button>
  </div>`
}

function section(id, title, hint, body, extra = '') {
  return `<section class="lab-sec" data-lab-sec="${id}"><div class="lab-sec-head"><h3>${esc(title)}</h3>${extra}</div>${hint ? `<div class="lab-hint">${esc(hint)}</div>` : ''}${body}</section>`
}
function builderHtml() {
  const s = cur()
  const addSig = `<select data-act-change="addSig" class="lab-add" aria-label="${esc(T('Add signal', 'Añadir señal'))}">
      <option value="">+ ${esc(T('Add signal', 'Añadir señal'))}</option>
      <option value="custom">${esc(T('Custom comparison', 'Comparación personalizada'))}</option>
      <optgroup label="${esc(T('Ready-made', 'Predefinidas'))}">${LAB_PRESETS.map((p, i) => `<option value="${i}">${esc(T(p.en, p.es))}</option>`).join('')}</optgroup>
    </select>`
  return section('signals', T('Signals', 'Señales'), T('Each one is true or false on every candle.', 'Cada una es verdadera o falsa en cada vela.'),
      `<div class="lab-list">${s.signals.map((x, i) => signalCard(s, x, i)).join('')}</div>`, addSig)
    + section('groups', T('Groups', 'Grupos'), T('Combine signals into one. A signal can be in as many groups as you like.', 'Combina señales en una. Una señal puede estar en tantos grupos como quieras.'),
      `<div class="lab-list">${s.groups.map(g => groupCard(s, g)).join('')}</div>`,
      `<button type="button" class="lab-btn lab-btn-ghost" data-act="addGrp">+ ${T('Group', 'Grupo')}</button>`)
    + section('rules', T('Rules', 'Reglas'), '', rulesHtml(s))
    + section('risk', T('Risk', 'Riesgo'), T('Stops are checked inside every candle; when one candle hits both the stop and the target, the stop is assumed.', 'Los stops se revisan dentro de cada vela; si una vela toca stop y objetivo, se asume el stop.'), riskHtml(s))
}

// ── charts ──────────────────────────────────────────────────────────────────────────────────
const charts = {}
const W = 640, H = 200, PL = 8, PR = 58, PT = 10, PB = 20
/** Indices to draw: every point, or each bucket's low and high, so no extreme is smoothed away. */
function pick(n, max = 700) {
  if (n <= max) return [...Array(n).keys()]
  return null
}
function pathOf(vals, x, y, max = 700) {
  const n = vals.length
  let idx = pick(n, max)
  if (!idx) {
    idx = []
    const b = n / (max / 2)
    for (let k = 0; k < max / 2; k++) {
      const a = Math.floor(k * b), z = Math.min(n, Math.floor((k + 1) * b))
      let lo = -1, hi = -1
      for (let i = a; i < z; i++) { if (vals[i] == null) continue; if (lo < 0 || vals[i] < vals[lo]) lo = i; if (hi < 0 || vals[i] > vals[hi]) hi = i }
      if (lo >= 0) idx.push(...(lo < hi ? [lo, hi] : lo === hi ? [lo] : [hi, lo]))
    }
  }
  let d = '', pen = false
  for (const i of idx) {
    const v = vals[i]
    if (v == null) { pen = false; continue }
    d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)
    pen = true
  }
  return d
}
function lineChart(id, { ts, series, markers = [], fmt = fmtUSD, logo = '' }) {
  const n = ts.length
  const all = series.flatMap(s => s.vals).filter(v => v != null && Number.isFinite(v))
  if (n < 2 || !all.length) return ''
  let lo = Math.min(...all), hi = Math.max(...all)
  if (hi === lo) { hi += 1; lo -= 1 }
  const pad = (hi - lo) * 0.06; lo -= pad; hi += pad
  const x = (i) => PL + (W - PL - PR) * i / (n - 1)
  const y = (v) => PT + (H - PT - PB) * (1 - (v - lo) / (hi - lo))
  const ticks = [0, 0.5, 1].map(f => lo + pad + (hi - lo - 2 * pad) * f)
  charts[id] = { ts, series, n, fmt, x, y, markers }
  const grid = ticks.map(v => `<line x1="${PL}" x2="${W - PR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" class="lab-gl"/><text x="${W - PR + 6}" y="${(y(v) + 3.5).toFixed(1)}" class="lab-axis">${esc(fmt(v, true))}</text>`).join('')
  const xl = [0, Math.floor((n - 1) / 2), n - 1].map((i, k) => `<text x="${x(i).toFixed(1)}" y="${H - 5}" class="lab-axis" text-anchor="${['start', 'middle', 'end'][k]}">${esc(fmtT(ts[i]).replace(/,\s*\d\d:\d\d.*$/, ''))}</text>`).join('')
  const lines = series.map(s => `<path d="${pathOf(s.vals, x, y)}" class="lab-line" style="stroke:${s.color}"${s.dash ? ' stroke-dasharray="5 4"' : ''}/>`).join('')
  const mk = markers.map(m => {
    const cx = x(m.i).toFixed(1), cy = y(m.v).toFixed(1)
    if (m.kind === 'exit') return `<circle cx="${cx}" cy="${cy}" r="4" class="lab-mk-exit"/>`
    const up = m.kind === 'long'
    const yy = +cy + (up ? 9 : -9)
    return `<path d="M${cx} ${(yy + (up ? -6 : 6)).toFixed(1)}l5 ${up ? 9 : -9}h-10z" class="${up ? 'lab-mk-long' : 'lab-mk-short'}"/>`
  }).join('')
  return `<div class="lab-chart" data-chart-wrap="${id}">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" data-chart="${id}" role="img" aria-label="${esc(series.map(s => s.label).join(', '))}">
      ${grid}${xl}${lines}${mk}<line class="lab-cross" data-cross x1="0" x2="0" y1="${PT}" y2="${H - PB}" visibility="hidden"/>
    </svg>
    <div class="lab-tip" data-tip hidden></div>${logo}
  </div>`
}
function hover(svg, ev) {
  const c = charts[svg.dataset.chart]
  if (!c) return
  const rect = svg.getBoundingClientRect()
  const px = (ev.clientX - rect.left) / rect.width * W
  const i = Math.max(0, Math.min(c.n - 1, Math.round((px - PL) / (W - PL - PR) * (c.n - 1))))
  const wrap = svg.parentElement
  const line = svg.querySelector('[data-cross]'), tip = wrap.querySelector('[data-tip]')
  const xx = c.x(i)
  line.setAttribute('x1', xx); line.setAttribute('x2', xx); line.setAttribute('visibility', 'visible')
  let extra = ''
  if (svg.dataset.chart === 'px' && result) {
    // What was true on this candle -- the question a price chart of a strategy always raises.
    const s = cur(), on = [...s.signals, ...s.groups].filter(x => result.r.series[x.id]?.[i] === true)
    if (on.length) extra = `<div class="lab-tip-on">${on.map(x => esc(refLabel(s, x.id))).join('<br>')}</div>`
    const tr = result.r.trades.filter(t => t.i === i || t.j === i)
    for (const t of tr) extra += `<div>${t.i === i ? (t.side === 'long' ? '▲ ' + T('Bought', 'Compra') : '▼ ' + T('Shorted', 'Corto')) : '● ' + T('Closed', 'Cierre') + ' · ' + esc(whyLabel(t))}</div>`
  }
  tip.innerHTML = `<b>${esc(fmtT(c.ts[i]))}</b>` + c.series.map(s => `<div><i style="background:${s.color}"></i>${esc(s.label)} <b>${esc(s.vals[i] == null ? '—' : c.fmt(s.vals[i]))}</b></div>`).join('') + extra
  tip.hidden = false
  const left = xx / W * rect.width
  tip.style.left = Math.min(Math.max(0, left - tip.offsetWidth / 2), rect.width - tip.offsetWidth) + 'px'
}
function unhover(svg) {
  svg.querySelector('[data-cross]')?.setAttribute('visibility', 'hidden')
  const tip = svg.parentElement.querySelector('[data-tip]'); if (tip) tip.hidden = true
}

// ── results ─────────────────────────────────────────────────────────────────────────────────
function whyLabel(t) {
  if (t.outcome === 'open') return T('still open', 'aún abierta')
  if (t.outcome.startsWith('rule:')) return T('rule: ', 'regla: ') + shortName(t.outcome.slice(5))
  return { stop: T('stop loss', 'stop loss'), 'trailing stop': T('trailing stop', 'stop dinámico'), target: T('take profit', 'take profit'),
           'time limit': T('max hold', 'duración máx.'), liquidated: T('liquidated', 'liquidada') }[t.outcome] ?? t.outcome
}
const shortName = (id) => { const s = cur(); return refLabel(s, id) }
function tile(label, val, c = '', sub = '') {
  return `<div class="lab-tile"><span>${esc(label)}</span><b class="${c}">${val}</b>${sub ? `<small>${sub}</small>` : ''}</div>`
}
function resultsHtml() {
  const t = load().test
  if (loadErr) return `<div class="lab-err">${esc(loadErr)}</div>`
  if (!fresh()) {
    return `<div class="lab-empty">${loading ? T('Loading candles…', 'Cargando velas…') : T('Run the test to load candles. After that, every edit re-runs it.', 'Pulsa Probar para cargar velas. Después, cada cambio vuelve a probarla.')}</div>`
  }
  const { r, sum, rows } = result
  const s = cur()
  const tr = sum.trades
  const winRate = tr.closed ? (r.trades.filter(x => x.outcome !== 'open' && x.delta > 0).length / tr.closed * 100) : null
  const bench = sum.bench
  const head = `<div class="lab-range">${esc(ctx.coinLabel(result.coin))} · ${t.iv} · ${rows.length.toLocaleString()} ${T('candles', 'velas')} · ${esc(fmtT(rows[0].t))} → ${esc(fmtT(rows[rows.length - 1].t))}</div>`
  const tiles = `<div class="lab-tiles">
    ${tile(T('Return', 'Rendimiento'), pct(r.roe), cls(r.roe), fmtUSD(r.balance - r.startBalance))}
    ${tile(T('Buy & hold', 'Comprar y mantener'), pct(bench?.retPct), cls(bench?.retPct), sum.edge != null ? (sum.edge >= 0 ? T('beat by ', 'superado por ') : T('trailed by ', 'por detrás ')) + Math.abs(sum.edge).toFixed(1) + ' pt' : '')}
    ${tile(T('Max drawdown', 'Caída máx.'), sum.maxDD ? '−' + sum.maxDD.toFixed(1) + '%' : '0%', sum.maxDD > 0 ? 'lab-neg' : '', bench ? T('hold: ', 'mantener: ') + '−' + bench.maxDD.toFixed(1) + '%' : '')}
    ${tile(T('Trades', 'Operaciones'), String(tr.closed), '', r.trades.some(x => x.outcome === 'open') ? T('+1 still open', '+1 abierta') : '')}
    ${tile(T('Win rate', 'Acierto'), winRate == null ? '—' : winRate.toFixed(0) + '%', '', tr.closed ? `${T('long', 'largo')} ${tr.long.n} · ${T('short', 'corto')} ${tr.short.n}` : '')}
    ${tile(T('Profit factor', 'Factor de beneficio'), fmtNum(tr.profitFactor), tr.profitFactor == null ? '' : tr.profitFactor >= 1 ? 'lab-pos' : 'lab-neg', tr.expectancy != null ? fmtUSD(tr.expectancy) + ' ' + T('/ trade', '/ op.') : '')}
    ${tile('Sharpe', fmtNum(sum.risk.sharpe), '', sum.risk.sharpe == null ? T('needs 14+ days', 'requiere 14+ días') : '')}
    ${tile(T('Time in market', 'Tiempo en mercado'), sum.exposure == null ? '—' : sum.exposure.toFixed(0) + '%')}
  </div>`
  const notes = []
  if (!s.rules.length) notes.push(T('No rules, so nothing traded. Add one under Rules.', 'Sin reglas, nada operó. Añade una en Reglas.'))
  else if (!r.trades.length) notes.push(T('The rules never fired on this history. The signal counts on each card show which part never turned true.', 'Las reglas nunca se activaron en este historial. Los contadores de cada tarjeta muestran qué parte nunca fue verdadera.'))
  if (r.refused) notes.push(T(`${r.refused} entr${r.refused === 1 ? 'y was' : 'ies were'} refused: the position would have been under Hyperliquid’s $10 minimum.`, `${r.refused} entrada(s) rechazadas: por debajo del mínimo de $10 de Hyperliquid.`))
  if (tr.liquidations) notes.push(T(`Liquidated ${tr.liquidations} time(s). Leverage or size is too high for this market’s swings.`, `Liquidada ${tr.liquidations} vez/veces. Apalancamiento o tamaño demasiado altos.`))
  // Equity, with the benchmark on the same dollars.
  const ts = rows.map(x => x.t)
  const eqVals = r.curve.map(p => p[1])
  const bhVals = bench ? rows.map(x => r.startBalance * x.c / rows[0].c) : null
  const eq = lineChart('eq', { ts, fmt: (v, axis) => axis ? '$' + compact(v) : fmtUSD(v), series: [
    { label: T('Strategy', 'Estrategia'), vals: eqVals, color: 'var(--accent)' },
    ...(bhVals ? [{ label: T('Buy & hold', 'Comprar y mantener'), vals: bhVals, color: 'var(--fg-3)', dash: true }] : []),
  ] })
  const markers = []
  for (const x of r.trades) {
    markers.push({ i: x.i, v: rows[x.i].o, kind: x.side })
    if (x.outcome !== 'open') markers.push({ i: x.j, v: x.exit, kind: 'exit' })
  }
  const px = lineChart('px', { ts, fmt: (v) => fmtPrice(v), series: [{ label: T('Price', 'Precio'), vals: rows.map(x => x.c), color: 'var(--fg-2)' }], markers: markers.slice(-400) })
  const legend = (items) => `<div class="lab-legend">${items.map(([c, l, d]) => `<span><i style="background:${c}"${d ? ' class="dash"' : ''}></i>${esc(l)}</span>`).join('')}</div>`
  return head + tiles
    + (notes.length ? `<div class="lab-notes">${notes.map(n => `<div>${esc(n)}</div>`).join('')}</div>` : '')
    + `<h4>${T('Account value', 'Valor de la cuenta')}</h4>` + legend([['var(--accent)', T('Strategy', 'Estrategia')], ...(bhVals ? [['var(--fg-3)', T('Buy & hold', 'Comprar y mantener'), 1]] : [])]) + eq
    + `<h4>${T('Price and trades', 'Precio y operaciones')}</h4>`
    + `<div class="lab-legend"><span><b class="lab-pos">▲</b> ${T('buy', 'compra')}</span><span><b class="lab-neg">▼</b> ${T('short', 'corto')}</span><span><b>●</b> ${T('close', 'cierre')}</span><span class="lab-hint">${T('hover to see what was true', 'pasa el cursor para ver qué era verdadero')}</span></div>` + px
}
const compact = (v) => Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(1) + 'k' : v.toFixed(0)
function tradesHtml() {
  if (!fresh() || !result.r.trades.length) return ''
  const list = result.r.trades.slice().reverse().slice(0, 60)
  return section('trades', T('Trades', 'Operaciones'), result.r.trades.length > 60 ? T(`The latest 60 of ${result.r.trades.length}.`, `Las últimas 60 de ${result.r.trades.length}.`) : '',
    `<div class="lab-trades" data-dragscroll><table><thead><tr><th>${T('Side', 'Lado')}</th><th>${T('Entry', 'Entrada')}</th><th>${T('Exit', 'Salida')}</th><th>${T('Why in', 'Por qué entró')}</th><th>${T('Why out', 'Por qué salió')}</th><th>P&L</th></tr></thead><tbody>
    ${list.map(x => `<tr><td class="${x.side === 'long' ? 'lab-pos' : 'lab-neg'}">${x.side === 'long' ? T('Long', 'Largo') : T('Short', 'Corto')}</td>
      <td>${esc(fmtT(x.time))}<br><small>${esc(fmtPrice(x.entry))}</small></td>
      <td>${x.outcome === 'open' ? '—' : esc(fmtT(x.exitAt))}<br><small>${esc(fmtPrice(x.exit))}</small></td>
      <td>${esc(shortName(x.why))}</td><td>${esc(whyLabel(x))}</td>
      <td class="${cls(x.delta)}">${esc(fmtUSD(x.delta))}<br><small>${pct(x.retPct)}</small></td></tr>`).join('')}
    </tbody></table></div>`)
}
function fireText(id) {
  if (!fresh()) return ''
  const f = result.r.fires[id]
  if (!f) return ''
  const known = f.on + f.off
  const p = known ? f.on / known * 100 : null
  return `${T('true', 'verdadera')} ${p == null ? '—' : p < 1 && f.on ? '<1' : p.toFixed(0)}% · ${T('now', 'ahora')} ${f.now === true ? '✓' : f.now === false ? '✗' : '?'}`
}
function paintFires(root) {
  root.querySelectorAll('[data-fire]').forEach(el => {
    el.textContent = fireText(el.dataset.fire)
    const f = result?.r?.fires?.[el.dataset.fire]
    el.classList.toggle('lab-fire-on', f?.now === true)
    el.classList.toggle('lab-fire-never', !!f && f.on === 0)
  })
}
function paintResults() {
  const root = document.getElementById('labsRoot')
  if (!root) return
  const res = root.querySelector('#labsRes'), trs = root.querySelector('#labsTrades')
  if (res) res.innerHTML = resultsHtml()
  if (trs) trs.innerHTML = tradesHtml()
  const btn = root.querySelector('[data-act="run"]')
  if (btn) { btn.disabled = !!loading; btn.textContent = loading ? T('Loading…', 'Cargando…') : T('Run test', 'Probar') }
  paintFires(root)
  root.querySelectorAll('svg[data-chart]').forEach(svg => svg.addEventListener('pointerleave', () => unhover(svg)))
}

// ── events ──────────────────────────────────────────────────────────────────────────────────
function changed({ rebuild = false } = {}) {
  save()
  if (rebuild) renderLabs()
  schedule()
}
function onAct(el) {
  const st = load(), s = cur(), a = el.dataset.act
  if (a === 'run') { cache.delete(testKey()); runNow(true); return }
  if (a === 'delSig' || a === 'delGrp') {
    const id = el.dataset.id
    s.signals = s.signals.filter(x => x.id !== id)
    s.groups = s.groups.filter(x => x.id !== id)
    for (const g of s.groups) g.members = g.members.filter(m => m.ref !== id)
    s.rules = s.rules.filter(r => r.ref !== id)
  } else if (a === 'dupSig') {
    const src = s.signals.find(x => x.id === el.dataset.id); if (!src) return
    const at = s.signals.indexOf(src)
    s.signals.splice(at + 1, 0, { ...structuredClone(src), id: nextId(s, 's'), name: src.name + ' 2' })
  } else if (a === 'dupGrp') {
    const src = s.groups.find(x => x.id === el.dataset.id); if (!src) return
    s.groups.push({ ...structuredClone(src), id: nextId(s, 'g'), name: src.name + ' 2' })
  } else if (a === 'addGrp') {
    s.groups.push({ id: nextId(s, 'g'), name: T('Group', 'Grupo') + ' ' + (s.groups.length + 1), mode: 'all', k: 2, within: 1, members: [] })
  } else if (a === 'chip') {
    const g = s.groups.find(x => x.id === el.dataset.g), ref = el.dataset.ref
    if (!g) return
    const m = g.members.find(x => x.ref === ref)
    if (!m) { if (makesCycle(s, g.id, ref)) return; g.members.push({ ref, not: false }) }
    else if (!m.not) m.not = true
    else g.members = g.members.filter(x => x !== m)
  } else if (a === 'addRule') {
    const ref = s.groups[s.groups.length - 1]?.id ?? s.signals[0]?.id
    if (!ref) return
    s.rules.push({ ref, action: s.rules.some(r => r.action === 'buy') ? 'sell' : 'buy' })
  } else if (a === 'delRule') s.rules.splice(+el.dataset.i, 1)
  else if (a === 'ruleUp' || a === 'ruleDown') {
    const i = +el.dataset.i, j = a === 'ruleUp' ? i - 1 : i + 1
    if (j < 0 || j >= s.rules.length) return
    ;[s.rules[i], s.rules[j]] = [s.rules[j], s.rules[i]]
  } else if (a === 'dupStrat') {
    const c = coerceStrategy({ ...structuredClone(s), id: undefined, name: s.name + ' ' + T('copy', 'copia') })
    st.list.push(c); st.active = c.id
  } else if (a === 'delStrat') {
    if (st.list.length < 2) return
    if (!confirm(T(`Delete “${s.name}”?`, `¿Eliminar “${s.name}”?`))) return
    st.list = st.list.filter(x => x.id !== s.id); st.active = st.list[0].id
  } else return
  changed({ rebuild: true })
}
function onChange(el) {
  const st = load(), s = cur()
  const raw = el.value
  const asNum = el.type === 'number'
  const v = asNum ? Number(raw) : raw
  if (asNum && !Number.isFinite(v)) return
  if (el.dataset.actChange) {
    const a = el.dataset.actChange
    if (a === 'pick') { st.active = raw; changed({ rebuild: true }); return }
    if (a === 'newFrom') {
      const tpl = LAB_TEMPLATES.find(x => x.key === raw); if (!tpl) return
      const c = coerceStrategy({ ...tpl.make(), id: undefined })
      st.list.push(c); st.active = c.id; changed({ rebuild: true }); return
    }
    if (a === 'addSig') {
      if (!raw) return
      const base = raw === 'custom'
        ? { name: T('Signal', 'Señal') + ' ' + (LETTERS[s.signals.length] ?? s.signals.length + 1), left: { src: 'close', p: {} }, op: 'gt', right: { type: 'src', src: 'sma', p: { n: 50 }, mult: 1 } }
        : LAB_PRESETS[+raw]?.make()
      if (!base) return
      s.signals.push({ bars: 1, ...base, id: nextId(s, 's') })
      changed({ rebuild: true })
      requestAnimationFrame(() => document.querySelector(`#labsRoot [data-card="${s.signals[s.signals.length - 1].id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
      return
    }
  }
  if (el.dataset.strat) { s.name = String(raw).slice(0, 60) || 'Strategy'; save(); const o = document.querySelector(`#labsRoot [data-act-change="pick"] option[value="${s.id}"]`); if (o) o.textContent = s.name; return }
  if (el.dataset.test) {
    const k = el.dataset.test
    if (k === 'coin') {
      const id = ctx.resolveMarketId(raw)
      if (!id) return
      st.test.coin = id
      el.value = ctx.coinLabel(id)
    } else st.test[k] = k === 'count' ? +raw : raw
    save(); result = null; paintResults(); runNow(true); return
  }
  if (el.dataset.risk) { s.risk[el.dataset.risk] = v; changed(); return }
  if (el.dataset.sig) {
    const sig = s.signals.find(x => x.id === el.dataset.sig); if (!sig) return
    const k = el.dataset.k
    setPath(sig, k, v)
    if (k === 'name') { renameEverywhere(sig.id, refLabel(s, sig.id)); changed(); return }
    if (k === 'left.src') {
      sig.left.p = {}
      const def = LAB_SOURCES[raw]
      // A number that means something on the new scale, rather than RSI's 30 against a price.
      if (def.def != null) sig.right = { type: 'value', value: def.def }
      else if (sig.right?.type !== 'src') sig.right = { type: 'src', src: def.kind === 'vol' ? 'volAvg' : 'sma', p: { n: 20 }, mult: 1 }
    }
    if (k === 'right.src') sig.right.p = {}
    if (k === 'right.type') sig.right = raw === 'src' ? { type: 'src', src: 'sma', p: { n: 50 }, mult: 1 } : { type: 'value', value: LAB_SOURCES[sig.left.src]?.def ?? 0 }
    changed({ rebuild: el.tagName === 'SELECT' }); return
  }
  if (el.dataset.grp) {
    const g = s.groups.find(x => x.id === el.dataset.grp); if (!g) return
    const k = el.dataset.k
    g[k] = k === 'name' ? String(raw).slice(0, 40) : v
    if (k === 'name') { renameEverywhere(g.id, refLabel(s, g.id)); changed(); return }
    if (el.tagName !== 'SELECT') { const f = document.querySelector(`#labsRoot [data-formula="${g.id}"]`); if (f) f.textContent = groupFormula(s, g, id => shortLabel(s, id)) }
    changed({ rebuild: el.tagName === 'SELECT' }); return
  }
  if (el.dataset.rule != null) {
    const r = s.rules[+el.dataset.rule]; if (!r) return
    r[el.dataset.k] = raw
    el.className = el.dataset.k === 'action' ? 'lab-act-' + raw : el.className
    changed(); return
  }
}
function renameEverywhere(id, label) {
  document.querySelectorAll(`#labsRoot [data-name-of="${id}"]`).forEach(n => { n.textContent = label })
  const s = cur()
  for (const g of s.groups) { const f = document.querySelector(`#labsRoot [data-formula="${g.id}"]`); if (f) f.textContent = groupFormula(s, g, x => shortLabel(s, x)) }
}
function bind(root) {
  root.addEventListener('click', (e) => { const el = e.target.closest('[data-act]'); if (el && root.contains(el) && !el.disabled) onAct(el) })
  root.addEventListener('change', (e) => { const el = e.target; if (el.matches('input, select')) onChange(el) })
  // A number committed by Enter on a phone keyboard should run without leaving the field.
  root.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input')) { e.target.blur() } })
  root.addEventListener('pointermove', (e) => { const svg = e.target.closest?.('svg[data-chart]'); if (svg) hover(svg, e) })
  root.addEventListener('pointerdown', (e) => { const svg = e.target.closest?.('svg[data-chart]'); if (svg) hover(svg, e) })
}

// ── mount ───────────────────────────────────────────────────────────────────────────────────
let autoStarted = false
export function renderLabs(el) {
  if (!el && !ctx.isShowing()) return
  const host = el ?? ctx.viewHost('deskLabs')
  if (!host) return
  // Rebuilding the page must not move it, or lose a field halfway through being typed in.
  const scrolled = []
  for (let n = host; n; n = n.parentElement) if (n.scrollTop > 0) scrolled.push([n, n.scrollTop])
  const se = document.scrollingElement
  if (se && se.scrollTop > 0 && !scrolled.some(([n]) => n === se)) scrolled.push([se, se.scrollTop])
  const a = document.activeElement
  const focusSel = a && host.contains(a) && a.matches('input') ? ['data-sig', 'data-grp', 'data-risk', 'data-test', 'data-strat']
    .map(k => a.hasAttribute(k) ? `[${k}="${a.getAttribute(k)}"]${a.dataset.k ? `[data-k="${a.dataset.k}"]` : ''}` : '').find(Boolean) : null
  const caret = focusSel && a.type !== 'number' ? [a.selectionStart, a.selectionEnd] : null
  host.innerHTML = `<div class="lab-root" id="labsRoot">${ctx.fullHeader('Labs')}
    <div class="lab-intro">${T('Build a strategy out of signals, combine them into groups, pair them with actions, and test it on past Hyperliquid candles. Nothing is placed and no money moves.', 'Crea una estrategia con señales, combínalas en grupos, únelas a acciones y pruébala con velas pasadas de Hyperliquid. No se coloca nada ni se mueve dinero.')}</div>
    ${stratBar()}
    <div class="lab-grid">
      <div class="lab-col-res">
        ${section('test', T('Test', 'Prueba'), '', testBar() + '<div id="labsRes"></div>')}
      </div>
      <div class="lab-col-build">${builderHtml()}</div>
    </div>
    <!-- The trade list closes the page: on a phone, sixty rows between the results and the builder put Signals out of reach. -->
    <div id="labsTrades" class="lab-grid"></div>
    <div class="lab-foot">${T('Assumes fills at the next candle’s open with the slippage set, isolated margin, and no funding payments. A backtest is an upper bound: real fills are worse, and a strategy tuned to one history often fails on the next.', 'Supone ejecución en la apertura de la siguiente vela con el deslizamiento indicado, margen aislado y sin pagos de funding. Un backtest es un límite superior: las ejecuciones reales son peores.')}</div>
  </div>`
  const root = host.querySelector('#labsRoot')
  bind(root)
  paintResults()
  for (const [n, t] of scrolled) n.scrollTop = t
  if (focusSel) {
    const f = root.querySelector(focusSel)
    if (f) { f.focus({ preventScroll: true }); if (caret) try { f.setSelectionRange(caret[0], caret[1]) } catch {} }
  }
  if (!autoStarted) { autoStarted = true; runNow(true) }
  else if (!fresh()) schedule(0)
}

// For tests: the model, without the screen.
export const _labsTest = { load, cur, save, reset: () => { store = null; result = null; cache.clear(); autoStarted = false } }
