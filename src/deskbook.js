/**
 * The order book beside the desktop Trade chart.
 *
 * Asked: "is desktop missing the order book? if so make it able to be hidden and visible". The
 * phone has had one as a tab (main.js _mobRenderDetailOrderBook), polled every four seconds;
 * desktop had none. This one reads Hyperliquid's l2Book SOCKET, which pushes the book as it
 * changes and spends nothing from the 1200-weight budget the dashboard and order placement share
 * (CLAUDE.md), so leaving it open costs no rate limit.
 *
 *   initDeskBook({ subscribe, fmtPrice, fmtSize, onPick })   once; subscribe(coin, cb) → ISubscription
 *   setDeskBookCoin(coin)                                     follows the chart
 *   toggleDeskBook() / deskBookVisible()                      shown or hidden, remembered
 *
 * Clicking a level hands its price to `onPick` (the limit price field). Imports nothing from the
 * app: what it needs is passed in, the shape src/agentkeys.js uses.
 */
const LS_KEY = 'hliq_desk_book'
const ROW_PX = 19

let ctx = null
let coin = null, sub = null, book = null, raf = 0, gen = 0

export function deskBookVisible() {
  try { return localStorage.getItem(LS_KEY) !== '0' } catch { return true }
}

export function initDeskBook(opts) {
  ctx = opts
  applyVisible()
  const el = document.getElementById('deskBook')
  el?.addEventListener('click', (e) => {
    const row = e.target.closest('[data-px]')
    if (row) ctx.onPick?.(Number(row.dataset.px))
  })
  // Depth follows the panel: expanding the chart to full view gives the book a taller column.
  try { new ResizeObserver(() => paint()).observe(document.getElementById('deskBookRows')) } catch {}
}

function applyVisible() {
  const on = deskBookVisible()
  document.getElementById('deskBook')?.classList.toggle('is-hidden', !on)
  document.getElementById('deskBookBtn')?.classList.toggle('is-on', on)
  if (on && coin && !sub) resubscribe()
  if (!on) stop()
}

export function toggleDeskBook() {
  try { localStorage.setItem(LS_KEY, deskBookVisible() ? '0' : '1') } catch {}
  applyVisible()
}

export function setDeskBookCoin(next) {
  if (!next || next === coin) return
  coin = next
  book = null
  paint()
  if (deskBookVisible()) resubscribe()
}

function stop() {
  gen++
  const s = sub; sub = null
  try { s?.unsubscribe?.() } catch {}
}

async function resubscribe() {
  stop()
  if (!ctx?.subscribe || !coin) return
  const mine = ++gen, want = coin
  try {
    const s = await ctx.subscribe(want, (ev) => {
      if (mine !== gen || ev?.coin !== want) return
      book = ev
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint() })
    })
    if (mine === gen) sub = s
    else { try { s?.unsubscribe?.() } catch {} }
  } catch { if (mine === gen) paint('The order book did not load — it will retry when you change market.') }
}

const fmtK = (v) => v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(0)

function paint(msg) {
  const el = document.getElementById('deskBookRows')
  if (!el || !ctx) return
  if (msg || !book) {
    el.innerHTML = `<div class="desk-book-empty">${msg ?? 'Loading…'}</div>`
    return
  }
  const [bids = [], asks = []] = book.levels ?? []
  // As many levels each side as fit the panel, so a taller window shows a deeper book.
  const each = Math.max(4, Math.floor(((el.clientHeight || 440) - 40) / ROW_PX / 2))
  const a = asks.slice(0, each), b = bids.slice(0, each)
  let ca = 0; const askCum = a.map(x => (ca += +x.sz * +x.px))
  let cb = 0; const bidCum = b.map(x => (cb += +x.sz * +x.px))
  const max = Math.max(ca, cb) || 1
  const row = (lv, cum, side) => `<div class="desk-book-row" data-px="${+lv.px}" title="Use ${ctx.fmtPrice(+lv.px)} as the limit price">
      <i style="width:${(cum / max * 100).toFixed(1)}%" class="${side}"></i>
      <span class="${side}">${ctx.fmtPrice(+lv.px)}</span><span>${ctx.fmtSize(+lv.sz)}</span><span>${fmtK(cum)}</span>
    </div>`
  const bestBid = +(b[0]?.px ?? 0), bestAsk = +(a[0]?.px ?? 0)
  const spread = bestBid > 0 && bestAsk > 0 ? bestAsk - bestBid : 0
  el.innerHTML = `
    <div class="desk-book-side desk-book-asks">${a.map((x, i) => row(x, askCum[i], 'ask')).reverse().join('')}</div>
    <div class="desk-book-mid"><b>${bestBid && bestAsk ? ctx.fmtPrice((bestBid + bestAsk) / 2) : '—'}</b><span>Spread ${spread ? ctx.fmtPrice(spread) : '—'} · ${bestBid ? (spread / bestBid * 100).toFixed(3) : '—'}%</span></div>
    <div class="desk-book-side">${b.map((x, i) => row(x, bidCum[i], 'bid')).join('')}</div>`
}
