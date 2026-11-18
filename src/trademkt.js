/**
 * The Markets tab's read of this market, as a card on the Trade tab.
 *
 * Asked for, after the Analysis and Signals cards landed there: "i would like to have the data
 * available like volume(time frames), open interest(time frames), revenue(time frame),
 * fees(time frame), worth". So: what /markets knows about the one market on screen.
 *
 * ── the budget, which is why this is nearly free ──
 * Nothing here fetches Hyperliquid. The 24h volume, open interest and funding are already in
 * main.js's market-context map, and the 1h (31 days) and 1d (since 2023) candles are already
 * read for the Signals card beside it. Volume over longer windows is summed from those candles
 * rather than asked for: measured against HL's own dayNtlVlm on BTC, ETH, HYPE and SOL, the sum
 * lands within 0.1%, so it is the same figure and not a second opinion. The only request this
 * module makes is /markets-meta, which is our own server, cached, and already fetched by
 * src/sectoralloc.js for the Allocation view.
 *
 * ── crypto and TradFi do not get the same figures ──
 * A ticker collides: NVDA is a chip company on one dex and could be a protocol token on
 * DefiLlama. categorize() in src/marketsdata.js settles it with classify() and only lets a
 * CRYPTO row take DefiLlama revenue or a CoinGecko market cap; this asks the same function the
 * same question rather than keeping a second opinion of its own. A TradFi market shows what the
 * company files with the SEC instead — for NVDA-PERP that is NVIDIA's quarter, not the $19M
 * tokenised-stock wrapper CoinGecko happens to list under the same three letters.
 *
 * ── what is NOT here, and why it is a dash ──
 * OPEN INTEREST OVER TIME. Hyperliquid publishes open interest as it is now and keeps no
 * history of it per market, and no candle carries it. Showing 24h-ago OI would mean recording
 * it ourselves, every market, every few minutes, server-side. Until that exists the card shows
 * the live figure and says the rest is not published, rather than inventing a window.
 * Everything unknown here is null and reads as a dash: never a 0 that was not measured.
 */
import { classify } from './sectors.js'

/** /markets-meta is cached hard on the server; this is how long a tab keeps its copy. */
export const META_TTL = 10 * 60_000

let meta = null, metaAt = 0, metaState = 'idle'

export function marketMeta() { return meta }
export function marketMetaState() { return metaState }
/** Test seam: drop what is held so a suite can drive the loader from empty. */
export function resetMarketMeta() { meta = null; metaAt = 0; metaState = 'idle' }

/**
 * /markets-meta, once per TTL. Resolves either way: a card without it still shows volume and
 * open interest, which is the half that does not depend on anyone else's feed.
 */
export async function loadMarketMeta(fetchImpl = (...a) => fetch(...a), now = () => Date.now()) {
  if (metaState === 'loading') return meta
  if (meta && now() - metaAt < META_TTL) return meta
  metaState = 'loading'
  try {
    const r = await fetchImpl('/markets-meta', { signal: AbortSignal.timeout(30_000) })
    const j = r.ok ? await r.json() : null
    if (!j || !j.revenue) throw new Error('none')
    meta = { revenue: j.revenue, stocks: j.stocks ?? null, cg: j.cg ?? null, sic: j.sic ?? null }
    metaAt = now(); metaState = 'ok'
  } catch { metaState = meta ? 'ok' : 'failed' }
  return meta
}

/** 'xyz:NVDA' → 'NVDA'. The dex prefix is not part of what the company is called. */
export const symOf = (coin) => String(coin ?? '').replace(/.*:/, '').toUpperCase()

/**
 * USD traded inside the last `ms`, summed from candles.
 *
 * A candle's `v` is volume in the base asset, so it is worth what it traded at; close-weighting
 * reproduces Hyperliquid's own 24h figure to within 0.1%. Returns null — not 0 — when there are
 * no candles in the window, and when every one of them carries no volume at all, which is what
 * /extcandles synthesises for the markets Hyperliquid does not list (DXY, the S&P): those have
 * a price history and no volume, and 0 would claim nobody traded them.
 */
export function volumeIn(candles, ms, now = Date.now()) {
  if (!Array.isArray(candles) || !candles.length) return null
  const from = now - ms
  let usd = 0, bars = 0, any = false
  for (const k of candles) {
    const end = Number(k?.T ?? k?.t)
    // Strictly after the window opens: a bar that ENDS exactly at `from` covers only time
    // before it, so counting it would add volume the window never saw.
    if (!Number.isFinite(end) || end <= from) continue
    const v = Number(k?.v), c = Number(k?.c)
    if (!Number.isFinite(v) || !Number.isFinite(c)) continue
    bars++
    if (v > 0) { usd += v * c; any = true }
  }
  if (!bars || !any) return null
  return usd
}

const DAY = 86_400_000
/** The windows the card shows, each from the finest candles that span it. */
export const VOL_WINDOWS = [
  ['24H', DAY, '1h'], ['7D', 7 * DAY, '1h'], ['30D', 30 * DAY, '1h'],
  ['3M', 91 * DAY, '1d'], ['6M', 182 * DAY, '1d'], ['1Y', 365 * DAY, '1d'],
]

/**
 * [label, usd|null] per window. `h1` spans 31 days and `d1` goes back to 2023, so each window
 * asks the series that actually covers it — 7d off hourly candles, a year off daily ones.
 */
export function volumeWindows(h1, d1, now = Date.now()) {
  return VOL_WINDOWS.map(([label, ms, which]) => [label, volumeIn(which === '1h' ? h1 : d1, ms, now)])
}

/**
 * Everything the card may show for one market, and nothing it may not.
 *
 * `hlCat` is Hyperliquid's own category for the coin, `ctx` its asset context from main.js.
 * The crypto/TradFi split decides which feed is allowed to speak, exactly as categorize() does.
 */
export function marketFacts({ coin, hlCat = null, ctx = null, h1 = null, d1 = null, meta: m = null, now = Date.now() }) {
  const sym = symOf(coin)
  const rev = m?.revenue?.[sym] ?? null
  const sic = m?.sic?.[sym]?.[0] ?? null
  const cls = classify({ sym, hlCat, llamaCat: rev?.category ?? null, sic })
  const crypto = cls.group === 'crypto'
  const stock = !crypto ? (m?.stocks?.[sym] ?? null) : null
  // A CoinGecko cap is the TOKEN's. On a TradFi market that token is a tokenised wrapper worth
  // a rounding error of the company, so it is not this market's worth and is not shown.
  const cg = crypto ? m?.cg?.[sym]?.[1] ?? null : null
  return {
    coin, sym, group: cls.group,
    sector: !crypto && sic != null ? (m?.sic?.[sym]?.[1] ?? null) : null,
    vol: volumeWindows(h1, d1, now),
    // HL's own 24h notional, when the candles could not answer (an external market, a cold tab).
    vol24Hl: Number.isFinite(ctx?.volume) && ctx.volume > 0 ? ctx.volume : null,
    oi: Number.isFinite(ctx?.oi) && ctx.oi > 0 ? ctx.oi : null,
    worth: cg,
    // DefiLlama, crypto only: what the protocol behind the token earns and charges.
    rev: crypto && rev ? { name: rev.name ?? null, r24: rev.r24 ?? null, r7: rev.r7 ?? null, r30: rev.r30 ?? null } : null,
    fee: crypto && rev ? { f24: rev.f24 ?? null, f7: rev.f7 ?? null, f30: rev.f30 ?? null } : null,
    // The SEC filing, TradFi only: the company's last quarter, trailing twelve months, and how
    // that quarter compares with the same one a year before.
    stock: stock ? { name: stock.name ?? null, q: stock.q ?? null, qEnd: stock.qEnd ?? null, ttm: stock.ttm ?? null, yoy: stock.yoy ?? null } : null,
  }
}

// ── rendering ────────────────────────────────────────────────────────────────────────────────
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** Compact dollars. null is a dash, because it was not measured. */
export function money(n) {
  if (n == null || !Number.isFinite(n)) return '—'
  const a = Math.abs(n)
  if (a >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T'
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B'
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M'
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K'
  return '$' + n.toFixed(0)
}

/** True when there is anything at all worth drawing a card for. */
export function hasFacts(f) {
  return !!f && (f.oi != null || f.worth != null || f.rev || f.stock || f.vol.some(([, v]) => v != null) || f.vol24Hl != null)
}

/**
 * The card. `T(en, es)` translates and `prv(text)` applies privacy mode, both passed in so this
 * file stays out of main.js's globals the way src/tradebrief.js does.
 */
export function marketCardHtml(f, { T = (en) => en, prv = (x) => x, full = null } = {}) {
  if (!hasFacts(f)) return ''
  const p = (x) => prv(x)
  const cell = ([label, v], i) => `<div class="tb-perf-c"><span>${esc(label)}</span><b>${i === 0 && v == null && f.vol24Hl != null ? p(money(f.vol24Hl)) : p(money(v))}</b></div>`
  const row = (label, value, tone = '') => `<div class="tb-ind"><span>${esc(label)}</span><b class="${tone}">${value}</b></div>`

  const rows = []
  rows.push(row(T('Open interest', 'Interés abierto'), p(money(f.oi))))
  if (f.worth != null) rows.push(row(T('Worth', 'Capitalización'), p(money(f.worth))))
  if (f.rev) {
    rows.push(row(T('Revenue 24h', 'Ingresos 24h'), p(money(f.rev.r24))))
    rows.push(row(T('Revenue 7d', 'Ingresos 7d'), p(money(f.rev.r7))))
    rows.push(row(T('Revenue 30d', 'Ingresos 30d'), p(money(f.rev.r30))))
    rows.push(row(T('Fees 24h', 'Comisiones 24h'), p(money(f.fee.f24))))
    rows.push(row(T('Fees 7d', 'Comisiones 7d'), p(money(f.fee.f7))))
    rows.push(row(T('Fees 30d', 'Comisiones 30d'), p(money(f.fee.f30))))
  }
  if (f.stock) {
    rows.push(row(T('Revenue, quarter', 'Ingresos, trimestre'), p(money(f.stock.q))))
    rows.push(row(T('Revenue, 12mo', 'Ingresos, 12 meses'), p(money(f.stock.ttm))))
    if (f.stock.yoy != null) {
      rows.push(row(T('Year on year', 'Interanual'), (f.stock.yoy >= 0 ? '+' : '') + f.stock.yoy.toFixed(1) + '%', f.stock.yoy >= 0 ? 'up' : 'dn'))
    }
  }
  if (f.sector) rows.push(row(T('Industry', 'Industria'), esc(f.sector)))

  // What the figures under it are, said once. A protocol's revenue is the protocol's, not this
  // market's, and the SEC figure is the company's: neither is Hyperliquid's take on the market.
  const note = f.stock
    ? T(`Volume traded on Hyperliquid. Revenue is ${f.stock.name ?? 'the company'}'s own, as filed with the SEC${f.stock.qEnd ? ` (quarter to ${f.stock.qEnd})` : ''}.`,
        `Volumen negociado en Hyperliquid. Los ingresos son de ${f.stock.name ?? 'la empresa'}, según sus informes a la SEC${f.stock.qEnd ? ` (trimestre hasta ${f.stock.qEnd})` : ''}.`)
    : f.rev
      ? T(`Volume traded on Hyperliquid. Revenue and fees are ${f.rev.name ?? 'the protocol'}'s, across every chain it runs on.`,
          `Volumen negociado en Hyperliquid. Ingresos y comisiones son de ${f.rev.name ?? 'el protocolo'}, en todas sus cadenas.`)
      : T('Volume traded on Hyperliquid. Open interest is what is open right now — Hyperliquid publishes no history of it.',
          'Volumen negociado en Hyperliquid. El interés abierto es el de ahora — Hyperliquid no publica su histórico.')

  return `<div class="tb-card">
    <div class="tb-top"><span>${T('Market', 'Mercado')}</span>
      ${full ? `<button type="button" data-tb-markets>${T('All markets', 'Todos los mercados')} →</button>` : ''}</div>
    <div class="tb-perf">${f.vol.map(cell).join('')}</div>
    <div class="tb-note">${T('Volume traded, by window.', 'Volumen negociado, por ventana.')}</div>
    <div class="tb-inds">${rows.join('')}</div>
    <div class="tb-note">${esc(note)}</div>
  </div>`
}
