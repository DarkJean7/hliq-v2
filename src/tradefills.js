// "My trades" on the Trade tab: the account's own recent trades in the market on screen.
//
// Asked for: "in trade tab below the new markets data, lets add the recent trades made in the
// selected asset. show 3, as unexpanded and 10 when expanded" -- and, asked whose: "mine".
//
// A trade is an ORDER, not a fill (src/tradegroup.js): one market order filled in six pieces is
// one row, with its size-weighted price and everything it closed. Fills come from main.js, which
// already holds them for the account on screen, so the card costs the exchange nothing.
//
// fills: the account's fills in this market (any order), or NULL when they have not loaded for
// this account yet -- which is not the same as an account that never traded it, and says so.
//
// Pure: data in, HTML out. tradebrief.js owns the card's place and its expanded state.

import { groupTrades } from './tradegroup.js'

export const SHOW_FOLDED = 3
export const SHOW_OPEN = 10

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

/** The account's trades in this market, newest first. Null passes through: unknown stays unknown. */
export function recentTrades(fills) {
  if (!Array.isArray(fills)) return null
  return groupTrades(fills).reverse()
}

/** What the order did, in words: "Open long", "Close short", "Buy", "Sell". */
export function tradeLabel(t) {
  const dir = String(t?.dir ?? '').trim()
  if (dir) return dir.charAt(0).toUpperCase() + dir.slice(1).toLowerCase()
  return t?.rawSide === 'B' || t?.rawSide === 'BUY' ? 'Buy' : 'Sell'
}

/** Buying is green whatever it does to a position: a buy that closes a short is still a buy. */
// Hyperliquid's side on the fill says it: 'B' bought, 'A' sold. Only without one is the direction read.
export const isBuy = (t) => {
  if (t?.rawSide === 'B' || t?.rawSide === 'BUY') return true
  if (t?.rawSide === 'A' || t?.rawSide === 'SELL') return false
  return /open long|close short|^buy|short > long/i.test(String(t?.dir ?? ''))
}

const ES_LABEL = { 'Open long': 'Abrir largo', 'Close long': 'Cerrar largo', 'Open short': 'Abrir corto', 'Close short': 'Cerrar corto', Buy: 'Compra', Sell: 'Venta' }

function ago(ms, now) {
  const s = Math.max(0, Math.floor((now - ms) / 1000))
  if (s < 60) return s + 's'
  const m = Math.floor(s / 60); if (m < 60) return m + 'm'
  const h = Math.floor(m / 60); if (h < 24) return h + 'h'
  const d = Math.floor(h / 24); return d < 60 ? d + 'd' : new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

const fmtSz = (v) => {
  const a = Math.abs(v)
  const dp = a >= 1000 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6
  return v.toLocaleString('en-US', { maximumFractionDigits: dp })
}
const fmtUsd = (v) => {
  const a = Math.abs(v)
  return '$' + (a >= 1e6 ? (a / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (a / 1e3).toFixed(1) + 'K' : a.toFixed(2))
}

/**
 * The card. opts: { T, prv, fmtPx, coin, expanded, combined, now, more: bool (show the toggle) }.
 * `prv` blurs figures in privacy mode, as the cards beside it do.
 */
export function myTradesCardHtml(trades, { T = (en) => en, prv = (x) => x, fmtPx = (p) => String(p), coin = '', expanded = false, combined = false, now = Date.now(), all = false } = {}) {
  const name = String(coin).replace(/^[a-z0-9]+:/, '')
  const head = `<div class="tb-top"><span>${T('My trades', 'Mis operaciones')} · ${esc(name)}</span>
    ${all ? `<button type="button" data-tb-trades>${T('All trades', 'Todas')} →</button>` : ''}</div>`
  if (trades == null) return `<div class="tb-card tf-card">${head}<div class="tb-msg">${T('Loading your trades…', 'Cargando tus operaciones…')}</div></div>`
  if (!trades.length) return `<div class="tb-card tf-card">${head}<div class="tb-msg">${T('You have no trades in this market on this account.', 'No tienes operaciones en este mercado en esta cuenta.')}</div></div>`

  const shown = trades.slice(0, expanded ? SHOW_OPEN : SHOW_FOLDED)
  const rows = shown.map(t => {
    const buy = isBuy(t)
    const pnl = t.closedPnl !== 0
      ? `<b class="${t.closedPnl >= 0 ? 'up' : 'dn'}">${prv((t.closedPnl >= 0 ? '+' : '-') + fmtUsd(t.closedPnl))}</b>`
      : `<b class="tf-none">—</b>`
    return `<div class="tf-row" data-tf-key="${esc(t.key)}">
      <span class="tf-side ${buy ? 'up' : 'dn'}">${esc(T(tradeLabel(t), ES_LABEL[tradeLabel(t)] ?? tradeLabel(t)))}</span>
      <span class="tf-what">${prv(fmtSz(t.sz))} <i>@</i> ${esc(fmtPx(t.px))}${combined && t.acct ? `<em>${esc(t.acct)}</em>` : ''}</span>
      <span class="tf-pnl">${pnl}<small>${ago(t.time, now)}</small></span>
    </div>`
  }).join('')
  const more = trades.length > SHOW_FOLDED
    ? `<button type="button" class="tf-more" data-tb-fills-more>${expanded
        ? T('Show fewer', 'Ver menos')
        : T(`Show ${Math.min(SHOW_OPEN, trades.length)}`, `Ver ${Math.min(SHOW_OPEN, trades.length)}`)}</button>`
    : ''
  return `<div class="tb-card tf-card">${head}
    <div class="tf-cols"><span>${T('Trade', 'Operación')}</span><span>${T('Size @ price', 'Tamaño @ precio')}</span><span>${T('Closed PnL', 'PnL cerrado')}</span></div>
    <div class="tf-rows">${rows}</div>
    ${more}
  </div>`
}
