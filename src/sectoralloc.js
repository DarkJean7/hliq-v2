/**
 * Allocation → "By sector": how much of what you hold sits in each sector of the market.
 *
 * The same categories as /markets (src/sectors.js classify): Hyperliquid's own category for a
 * HIP-3 market, our curated lists, DefiLlama's protocol category for a token with revenue, and
 * the SEC's industry code for a stock. The /markets page and this view cannot disagree about
 * what HYPE or NVDA is, because they ask the same function.
 *
 * Sized by EXPOSURE, not margin: a 20× position on $100 of margin is $2,000 of the sector, and
 * that is the number the question "how exposed am I to AI" is about. Perps count their
 * position value (long or short), spot and off-exchange tokens their dollar value. Cash —
 * USDC, free margin, an order's reserve — is not exposure to anything and is left out.
 *
 * Each asset sits in ONE sector on the ring, so the ring adds up; every other tag it carries is
 * listed under "Every tag", where an asset counts in all of them (NVDA is AI, tech and semis).
 *
 * Pure parts (holdingsSectors, primarySector, unwrapSym) are tested in
 * tests/suites/sectoralloc.test.mjs; the app feeds holdings from src/main.js.
 */
import { classify, SECTOR_LABEL, LLAMA_TO_SECTOR } from './sectors.js'
import { WEAK_LLAMA_CATS } from './marketsdata.js'

// ── the categories' data: /markets-meta (revenue → DefiLlama category, sic → SEC code) ──────
// null = not loaded (or failed): the view still works from Hyperliquid's categories and our
// curated lists, and says that the rest did not load rather than filing tokens as "Other".
let meta = null, metaAt = 0, metaState = 'idle'   // 'idle' | 'loading' | 'ok' | 'failed'
const META_TTL = 30 * 60_000
let onChange = () => {}

export function initSectorAlloc(ctx = {}) { if (ctx.onChange) onChange = ctx.onChange }
export const metaStatus = () => metaState

export function loadSectorMeta(force = false) {
  if (metaState === 'loading') return
  if (!force && meta && Date.now() - metaAt < META_TTL) return
  metaState = 'loading'
  fetch('/markets-meta', { signal: AbortSignal.timeout(30_000) })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (!j || !j.revenue) throw new Error('none')
      meta = { revenue: j.revenue, sic: j.sic ?? null }
      metaAt = Date.now(); metaState = 'ok'
    })
    .catch(() => { metaState = 'failed' })
    .finally(() => onChange())
}

// ── pure ─────────────────────────────────────────────────────────────────────────────────────

/** Wrapped spot tokens (Unit's UBTC, UETH, USOL, UPUMP…) are the asset they wrap. */
const WRAPPED = { UFART: 'FARTCOIN', UBONK: 'kBONK', UPEPE: 'kPEPE' }
export function unwrapSym(sym, hasTags) {
  const s = String(sym ?? '')
  if (WRAPPED[s]) return WRAPPED[s]
  if (/^U[A-Z0-9]{2,}$/.test(s) && !hasTags(s) && hasTags(s.slice(1))) return s.slice(1)
  return s
}

/** Tags too broad to name an asset by when it has a more specific one. */
const BROAD = new Set(['defi', 'stocks', 'hlnative', 'etf'])

/**
 * The ONE sector an asset is drawn in. DefiLlama's word first for a token whose protocol is
 * earning (as the /markets table labels it: HYPE is Derivatives), unless that word is too
 * generic; else our most specific tag; else what Hyperliquid calls it; else "other".
 */
export function primarySector(c, llamaCat = null) {
  const fromLlama = llamaCat && !WEAK_LLAMA_CATS.has(llamaCat) ? (LLAMA_TO_SECTOR[llamaCat] ?? []).filter(t => !BROAD.has(t)) : []
  if (fromLlama[0]) return fromLlama[0]
  const specific = c.tags.find(t => !BROAD.has(t))
  if (specific) return specific
  if (c.tags[0]) return c.tags[0]
  return c.group === 'tradfi' ? (c.hlCat || 'tradfi') : 'other'
}

const LABEL = { ...SECTOR_LABEL, other: 'Other crypto', tradfi: 'Other TradFi', outcomes: 'Predictions (outcomes)' }
export const sectorLabel = (k) => LABEL[k] ?? k

/**
 * holdings: [{ id, sym, hlCat, long, short, label, accts, size, kind }] — long/short in USD,
 * both ≥ 0. `meta`: { revenue, sic } or null.
 * → { gross, long, short, sectors: [{ key, label, gross, long, short, items }], tags: [{ key, label, gross }] }
 */
export function holdingsSectors(holdings, metaIn = meta) {
  const revenue = metaIn?.revenue ?? null, sic = metaIn?.sic ?? null
  const by = new Map(), tagSum = new Map()
  let gross = 0, long = 0, short = 0
  const hasTags = (s) => classify({ sym: s }).tags.length > 0
  for (const h of holdings) {
    const g = (h.long || 0) + (h.short || 0)
    if (!(g > 0)) continue
    let key, tags = []
    if (h.kind === 'outcome') key = 'outcomes'
    else {
      const sym = h.hlCat && h.hlCat !== 'crypto' ? h.sym : unwrapSym(h.sym, hasTags)
      const rev = revenue?.[String(sym).toUpperCase()] ?? null
      const active = rev && ((rev.r30 ?? 0) > 0 || (rev.f30 ?? 0) > 0)
      const c = classify({ sym, hlCat: h.hlCat ?? null, llamaCat: active ? rev.category : null, sic: sic?.[sym]?.[0] ?? null })
      key = primarySector(c, c.group === 'crypto' && active ? rev.category : null)
      tags = c.tags
    }
    const s = by.get(key) ?? { key, label: sectorLabel(key), gross: 0, long: 0, short: 0, items: [] }
    s.gross += g; s.long += h.long || 0; s.short += h.short || 0
    s.items.push({ ...h, gross: g, tags })
    by.set(key, s)
    gross += g; long += h.long || 0; short += h.short || 0
    for (const t of new Set([key, ...tags])) tagSum.set(t, (tagSum.get(t) ?? 0) + g)
  }
  const sectors = [...by.values()].sort((a, b) => b.gross - a.gross)
  for (const s of sectors) s.items.sort((a, b) => b.gross - a.gross)
  const tags = [...tagSum].map(([key, v]) => ({ key, label: sectorLabel(key), gross: v })).sort((a, b) => b.gross - a.gross)
  return { gross, long, short, sectors, tags }
}

// ── colours: fixed per sector, so "AI" is the same colour every time you open it ─────────────
const COLORS = {
  l1: '#7B61FF', l2: '#9F8CFF', defi: '#2EC5CE', dex: '#22A6B3', derivatives: '#00D1A0', lending: '#4DB6AC',
  launchpad: '#FF7A45', tradingapp: '#FFB020', ai: '#FF4FA3', memes: '#F5D90A', infra: '#5C9DFF', gaming: '#B37FEB',
  rwa: '#C9A227', privacy: '#8C8C8C', prediction: '#36CFC9', stables: '#2775CA', hlnative: '#50E3C2',
  stocks: '#4E8FF0', tech: '#3D7BFF', semis: '#00B3FF', cryptostocks: '#F28C28', financials: '#52C41A', healthcare: '#FF6B6B',
  consumer: '#E8A33D', media: '#A0D911', industrials: '#8D99AE', aerospace: '#6C8EBF', autos: '#D46B08', utilities: '#13C2C2',
  materials: '#AD8B73', etf: '#8E7CC3', preipo: '#EB2F96', indices: '#597EF7', metals: '#FAAD14', energy: '#FA541C',
  commodities: '#D4B106', fx: '#40A9FF', rates: '#9254DE', outcomes: '#36CFC9', other: '#6B7384', tradfi: '#6B7384',
}
export const sectorColor = (k) => COLORS[k] ?? '#6B7384'

// ── view ─────────────────────────────────────────────────────────────────────────────────────
const open = new Set()
let pinned = null       // the sector KEY the reader tapped; survives the repaint every few seconds
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/**
 * h: { usd(v) → "$1,234.56" (privacy applied), equity (number|null), icon(item) → html,
 *      T(en, es) }
 */
export function sectorAllocHtml(d, h) {
  const T = h.T ?? ((en) => en)
  if (!d.sectors.length) {
    return `<div class="mob-v-empty">${T('Nothing held yet — no positions or tokens to put in a sector.', 'Nada todavía — sin posiciones ni tokens que clasificar.')}</div>`
  }
  const SIZE = 240, CX = SIZE / 2, SW = 18, R = (SIZE - 26) / 2 - 4, C = 2 * Math.PI * R
  const gap = d.sectors.length > 1 ? Math.min(5, C * 0.01) : 0
  let acc = 0
  const arcs = d.sectors.map((s, i) => {
    const frac = s.gross / d.gross, len = Math.max(0.6, frac * C - gap), off = -acc
    acc += frac * C
    const attrs = `cx="${CX}" cy="${CX}" r="${R}" fill="none" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}" transform="rotate(-90 ${CX} ${CX})"`
    return `<circle data-sec-arc="${i}" ${attrs} stroke="${sectorColor(s.key)}" stroke-width="${SW}" style="pointer-events:none;transition:opacity .12s,stroke-width .12s"></circle>
      <circle data-sec-hit="${i}" ${attrs} stroke="transparent" stroke-width="${SW + 8}" pointer-events="stroke" style="cursor:pointer"></circle>`
  }).join('')
  const lev = h.equity > 0 ? d.gross / h.equity : null
  const net = d.long - d.short
  const centre = `
    <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${T('Exposure', 'Exposición')}</div>
    <div style="font-size:26px;font-weight:800;font-family:var(--font-mono);line-height:1.15">${h.usd(d.gross)}</div>
    <div style="font-size:11.5px;color:var(--muted)">${d.sectors.length} ${d.sectors.length === 1 ? T('sector', 'sector') : T('sectors', 'sectores')}${lev != null ? ` · ${lev.toFixed(2)}× ${T('equity', 'patrimonio')}` : ''}</div>
    <div style="font-size:11.5px;color:${net >= 0 ? 'var(--green)' : 'var(--red)'}">${T('Net', 'Neto')} ${net >= 0 ? T('long', 'largo') : T('short', 'corto')} ${h.usd(Math.abs(net))}</div>`

  const side = (x) => x.long > 0 && x.short > 0 ? `${T('Long', 'Largo')} ${h.usd(x.long)} / ${T('Short', 'Corto')} ${h.usd(x.short)}`
    : x.short > 0 ? T('Short', 'Corto') : T('Long', 'Largo')
  const rows = d.sectors.map((s, i) => {
    const isOpen = open.has(s.key)
    const n = s.items.length
    const items = isOpen ? s.items.map(it => `<div class="mob-v-row" style="padding-left:30px">
        <div style="width:26px;height:26px;border-radius:50%;overflow:hidden;background:var(--panel-2);flex-shrink:0;margin-right:10px">${h.icon(it)}</div>
        <div class="mob-v-row-info">
          <div class="mob-v-row-name">${escH(it.label)}</div>
          <div class="mob-v-row-sub">${[it.kind === 'offex' ? T('Off-exchange', 'Fuera del exchange') : it.kind === 'spot' ? 'Spot' : it.kind === 'outcome' ? T('Outcome', 'Resultado') : 'Perp', side(it),
            it.tags.filter(t => t !== s.key).map(t => escH(sectorLabel(t))).join(', '),
            it.accts?.size ? `<span style="color:var(--accent)">${escH([...it.accts].join(', '))}</span>` : ''].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="mob-v-row-right">
          <div class="mob-v-row-val">${h.usd(it.gross)}</div>
          <div class="mob-v-row-pct" style="color:var(--muted)">${((it.gross / d.gross) * 100).toFixed(1)}%</div>
        </div>
      </div>`).join('') : ''
    return `<div data-sec-group="${escH(s.key)}">
      <div class="mob-v-row" data-sec-row="${i}" style="cursor:pointer;transition:background .12s">
        <span style="width:10px;height:10px;border-radius:3px;background:${sectorColor(s.key)};flex-shrink:0;margin-right:10px"></span>
        <div class="mob-v-row-info">
          <div class="mob-v-row-name" style="font-weight:800">${escH(s.label)}</div>
          <div class="mob-v-row-sub">${n} ${n === 1 ? T('asset', 'activo') : T('assets', 'activos')} · ${side(s)}</div>
        </div>
        <div class="mob-v-row-right">
          <div class="mob-v-row-val">${h.usd(s.gross)}</div>
          <div class="mob-v-row-pct" style="color:var(--muted)">${((s.gross / d.gross) * 100).toFixed(1)}%</div>
        </div>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;margin-left:8px;transition:transform .2s${isOpen ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>
      </div>${items}</div>`
  }).join('')

  // Every tag, overlapping: the answer to "how much AI do I hold" when AI is not where an asset
  // is drawn. Only worth showing when some asset carries more than one.
  const extra = d.tags.some(t => !d.sectors.find(s => s.key === t.key) || t.gross > (d.sectors.find(s => s.key === t.key)?.gross ?? 0) + 0.005)
  const tagRows = extra ? d.tags.map(t => {
    const pct = (t.gross / d.gross) * 100
    return `<div style="display:flex;align-items:center;gap:10px;padding:7px 16px">
      <span style="flex:0 0 118px;font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escH(t.label)}</span>
      <span style="flex:1;height:6px;border-radius:3px;background:var(--panel-2);overflow:hidden"><i style="display:block;height:100%;width:${Math.min(100, pct).toFixed(1)}%;background:${sectorColor(t.key)}"></i></span>
      <span style="flex:0 0 auto;font-size:12px;font-family:var(--font-mono)">${h.usd(t.gross)}</span>
      <span style="flex:0 0 44px;text-align:right;font-size:12px;color:var(--muted)">${pct.toFixed(0)}%</span>
    </div>`
  }).join('') : ''

  const st = metaStatus()
  const note = st === 'failed'
    ? `<div style="margin:4px 16px 0;font-size:11.5px;color:var(--muted)">${T('Protocol and company categories did not load, so some tokens may sit in Other.', 'Las categorías de protocolos y empresas no cargaron; algunos tokens pueden quedar en Otros.')} <button data-sec-retry style="font:inherit;color:var(--accent);background:none;border:0;padding:0;cursor:pointer;text-decoration:underline">${T('Retry', 'Reintentar')}</button></div>`
    : st === 'loading' ? `<div style="margin:4px 16px 0;font-size:11.5px;color:var(--muted)">${T('Loading protocol and company categories…', 'Cargando categorías…')}</div>` : ''

  return `<div style="display:flex;justify-content:center;padding:18px 12px 6px">
      <div style="position:relative;width:${SIZE}px;height:${SIZE}px;max-width:100%">
        <svg viewBox="0 0 ${SIZE} ${SIZE}" style="width:100%;height:100%;display:block;overflow:visible">
          <circle cx="${CX}" cy="${CX}" r="${R}" fill="none" stroke="var(--panel-2)" stroke-width="${SW}" style="pointer-events:none"></circle>${arcs}
        </svg>
        <div id="secCenter" data-default="1" style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;pointer-events:none;padding:0 40px">${centre}</div>
        <template id="secCenterDefault">${centre}</template>
      </div>
    </div>${note}
    <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:10px 16px 4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700">
      <span>${T('By sector', 'Por sector')}</span><span>${T('Exposure', 'Exposición')}</span>
    </div>
    <div>${rows}</div>
    ${tagRows ? `<div style="padding:16px 16px 4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700">${T('Every tag', 'Todas las etiquetas')}</div>
      <div style="padding:0 16px 6px;font-size:11.5px;color:var(--muted)">${T('An asset counts in every tag it carries — NVDA is AI, tech and semiconductors — so these add up to more than 100%.', 'Un activo cuenta en cada etiqueta que tiene, así que suman más del 100%.')}</div>
      ${tagRows}` : ''}
    <div style="padding:12px 16px calc(90px + env(safe-area-inset-bottom));font-size:11.5px;color:var(--muted)">${T('Sized by exposure: a position\'s full value, long or short, and a token\'s value. Cash is not counted. Categories as on /markets.', 'Por exposición: el valor total de cada posición y token. El efectivo no cuenta.')}</div>`
}

/** Hover, tap and expand, after the html is in `el`. `d` is what it was drawn from. */
export function wireSectorAlloc(el, d, h) {
  const T = h.T ?? ((en) => en)
  const centre = el.querySelector('#secCenter'), def = el.querySelector('#secCenterDefault')?.innerHTML ?? ''
  const show = (i) => {
    const s = d.sectors[i]
    if (!s || !centre) return
    el.querySelectorAll('[data-sec-arc]').forEach(a => { a.style.opacity = a.dataset.secArc === String(i) ? '1' : '.3' })
    el.querySelectorAll('[data-sec-row]').forEach(r => { r.style.background = r.dataset.secRow === String(i) ? 'var(--panel-2)' : '' })
    const top = s.items.slice(0, 3).map(it => `${escH(it.label)} ${h.usd(it.gross)}`).join(' · ')
    centre.innerHTML = `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px"><span style="width:9px;height:9px;border-radius:3px;background:${sectorColor(s.key)}"></span>
      <span style="font-size:13px;font-weight:700;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escH(s.label)}</span></div>
      <div style="font-size:24px;font-weight:800;font-family:var(--font-mono);line-height:1.15">${h.usd(s.gross)}</div>
      <div style="font-size:12px;color:var(--muted)">${((s.gross / d.gross) * 100).toFixed(1)}% ${T('of exposure', 'de la exposición')}</div>
      ${top ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;line-height:1.35">${top}</div>` : ''}`
  }
  const clear = () => {
    const pi = d.sectors.findIndex(s => s.key === pinned)
    if (pi >= 0) return show(pi)
    el.querySelectorAll('[data-sec-arc]').forEach(a => { a.style.opacity = '1' })
    el.querySelectorAll('[data-sec-row]').forEach(r => { r.style.background = '' })
    if (centre) centre.innerHTML = def
  }
  el.querySelectorAll('[data-sec-hit], [data-sec-row]').forEach(node => {
    const i = Number(node.dataset.secHit ?? node.dataset.secRow)
    node.addEventListener('mouseenter', () => show(i))
    node.addEventListener('mouseleave', clear)
    node.addEventListener('click', () => {
      const k0 = d.sectors[i]?.key
      pinned = pinned === k0 ? null : k0
      if (node.dataset.secRow != null) {
        const k = d.sectors[i]?.key
        if (k) { if (open.has(k)) open.delete(k); else open.add(k) }
        onChange()
      } else clear()
    })
  })
  el.querySelector('[data-sec-retry]')?.addEventListener('click', () => loadSectorMeta(true))
  const pi = d.sectors.findIndex(s => s.key === pinned)
  if (pi >= 0) show(pi)
}
