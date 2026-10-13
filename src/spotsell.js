// Sell a spot holding: an amount or all of it, at market or at a limit.
//
// Asked for: "an easy way of selling spot tokens, like closing a position … selling a certain
// amount or max available". The only way before was the trade ticket, which treats every
// market as a perp: it let you "sell" more than you held and previewed the result as a SHORT —
// something spot cannot be. Here the ceiling is what you own and is free (not resting in an
// order), and the preview is what you keep and what you get.
//
// Knows nothing of the app's state: main.js hands it what it needs (deps below).

const MIN_ORDER = 10          // Hyperliquid's minimum order value, in USDC
const MARKET_SLIP = 0.03      // a market sell's worst price: 3% under mid, as Close does
const FEE = 0.0007            // spot taker fee, for the estimate only

/**
 * deps: {
 *   T(en, es), esc, fmtPrice, fmtSize, fmtUSD, icon(coin) → html, label(coin) → 'KNTQ',
 *   holding(coin) → { total, hold, entryNtl } | null   (read fresh on every redraw)
 *   pairOf(coin) → '@N' | 'PURR/USDC' | null,  mid(coin) → number,
 *   szDec(pair) → Promise<number>,
 *   place({ pair, sz, limitPx, tif }) → Promise<order response>,
 *   blocked() → reason string | null  (no key, watch-only, …),
 *   done(message, ok)                  (toast + refresh)
 * }
 */
export function createSpotSell(deps) {
  const { T, esc, fmtPrice, fmtSize, fmtUSD } = deps
  let st = null    // { coin, pair, dec, type, unit, amt, px, busy, msg }

  const avail = () => { const h = deps.holding(st.coin); return h ? Math.max(0, (+h.total || 0) - (+h.hold || 0)) : 0 }
  const floorTo = (x, d) => { const f = Math.pow(10, d); return Math.floor(x * f + 1e-9) / f }
  const mid = () => deps.mid(st.coin) || 0
  const price = () => st.type === 'limit' ? (+st.px || 0) : mid()

  // The size being sold, in tokens, whatever unit was typed.
  function size() {
    const v = +st.amt || 0
    const raw = st.unit === 'usd' ? (price() > 0 ? v / price() : 0) : v
    return floorTo(raw, st.dec)
  }

  /** Why this cannot be sent as it stands, or null. */
  function problem() {
    const sz = size(), a = avail()
    if (!(a > 0)) return T('Nothing free to sell: it is all resting in orders.', 'Nada libre para vender: todo está en órdenes.')
    if (!(sz > 0)) return T('Enter an amount.', 'Introduce una cantidad.')
    if (sz > floorTo(a, st.dec) + 1e-12) return T(`You have ${fmtSize(a)} ${deps.label(st.coin)} free to sell.`, `Tienes ${fmtSize(a)} ${deps.label(st.coin)} libres para vender.`)
    if (!(price() > 0)) return st.type === 'limit' ? T('Enter a limit price.', 'Introduce un precio límite.') : T('No price for this market right now.', 'No hay precio para este mercado ahora.')
    if (sz * price() < MIN_ORDER) return T(`Hyperliquid's minimum order is $${MIN_ORDER} (this is $${fmtUSD(sz * price())}).`, `La orden mínima de Hyperliquid es $${MIN_ORDER} (esta es $${fmtUSD(sz * price())}).`)
    return null
  }

  function setPct(p) {
    const a = floorTo(avail() * p / 100, st.dec)
    st.amt = st.unit === 'usd' ? (a * price()).toFixed(2) : String(a)
    st.pct = p
    draw()
  }

  function html() {
    const lbl = esc(deps.label(st.coin)), h = deps.holding(st.coin) ?? {}
    const a = avail(), m = mid(), sz = size(), px = price()
    const proceeds = sz * px, fee = proceeds * FEE
    const cost = +h.entryNtl || 0, total = +h.total || 0
    const avgBuy = cost > 0 && total > 0 ? cost / total : null
    const pnl = avgBuy != null && sz > 0 ? (px - avgBuy) * sz - fee : null
    const left = Math.max(0, total - sz)
    const err = problem()
    const btn = (on, act, v, txt) => `<button data-ss="${act}" data-v="${v}" style="flex:1;padding:8px 6px;border-radius:9px;border:1px solid ${on ? 'var(--accent)' : 'var(--border)'};background:${on ? 'color-mix(in srgb, var(--accent) 16%, transparent)' : 'var(--panel-2)'};color:${on ? 'var(--accent)' : 'var(--fg-2)'};font-weight:700;font-size:12.5px;cursor:pointer">${txt}</button>`
    const row = (l, v, c = '') => `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:13px"><span style="color:var(--muted)">${l}</span><b style="font-variant-numeric:tabular-nums${c ? ';color:' + c : ''}">${v}</b></div>`
    const below = st.type === 'limit' && px > 0 && m > 0 && px < m
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <div style="width:30px;height:30px;border-radius:50%;overflow:hidden;flex-shrink:0">${deps.icon(st.coin)}</div>
        <div style="flex:1;min-width:0"><div style="font-size:17px;font-weight:800">${T('Sell', 'Vender')} ${lbl}</div>
          <div style="font-size:12px;color:var(--muted)">${T('Free to sell', 'Libre para vender')}: <b style="color:var(--fg)">${fmtSize(a)} ${lbl}</b>${m > 0 ? ` ≈ $${fmtUSD(a * m)}` : ''}${+h.hold > 0 ? ` · ${fmtSize(+h.hold)} ${T('in orders', 'en órdenes')}` : ''}</div></div>
        <button data-ss="close" aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:24px;line-height:1;cursor:pointer;padding:0 4px">&times;</button>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:10px">${btn(st.type === 'market', 'type', 'market', T('Market', 'Mercado'))}${btn(st.type === 'limit', 'type', 'limit', T('Limit', 'Límite'))}</div>
      ${st.type === 'limit' ? `
        <div style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em;margin:4px 0 5px">${T('Limit price', 'Precio límite')} <span style="text-transform:none;font-weight:600">· ${T('mid', 'medio')} $${fmtPrice(m)}</span></div>
        <input id="ssPx" inputmode="decimal" value="${esc(st.px)}" style="width:100%;box-sizing:border-box;background:var(--panel-2);border:1px solid var(--border);border-radius:10px;padding:11px 12px;font-size:16px;color:var(--fg);outline:none;font-variant-numeric:tabular-nums">
        <div style="display:flex;gap:6px;margin:7px 0 10px">${[[0, T('Mid', 'Medio')], [1, '+1%'], [2, '+2%'], [5, '+5%'], [10, '+10%']].map(([p, l]) => btn(false, 'pxpct', p, l)).join('')}</div>
        ${below ? `<div style="font-size:11.5px;color:var(--accent);margin:-4px 0 8px">${T('Below the market: it sells right away, at the best bids.', 'Por debajo del mercado: se vende al instante, a las mejores ofertas.')}</div>` : ''}` : ''}
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:4px 0 5px">
        <span style="font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${T('Amount', 'Cantidad')}</span>
        <span style="font-size:11.5px;color:var(--muted)">${sz > 0 && px > 0 ? (st.unit === 'usd' ? `≈ ${fmtSize(sz)} ${lbl}` : `≈ $${fmtUSD(sz * px)}`) : ''}</span>
      </div>
      <div style="display:flex;gap:6px">
        <input id="ssAmt" inputmode="decimal" placeholder="0" value="${esc(st.amt)}" style="flex:1;min-width:0;box-sizing:border-box;background:var(--panel-2);border:1px solid ${err && st.amt ? 'var(--red)' : 'var(--border)'};border-radius:10px;padding:11px 12px;font-size:18px;font-weight:700;color:var(--fg);outline:none;font-variant-numeric:tabular-nums">
        <button data-ss="unit" style="flex-shrink:0;padding:0 12px;border-radius:10px;border:1px solid var(--border);background:var(--panel-2);color:var(--accent);font-weight:800;font-size:12.5px;cursor:pointer">${st.unit === 'usd' ? 'USD' : lbl} ⇄</button>
      </div>
      <div style="display:flex;gap:6px;margin:8px 0 12px">${[25, 50, 75, 100].map(p => btn(st.pct === p, 'pct', p, p === 100 ? 'Max' : p + '%')).join('')}</div>
      <div style="background:var(--panel-2);border:1px solid var(--border);border-radius:12px;padding:8px 12px;margin-bottom:12px">
        ${row(st.type === 'market' ? T('Est. price', 'Precio est.') : T('Limit price', 'Precio límite'), px > 0 ? '$' + fmtPrice(px) : '—')}
        ${st.type === 'market' && m > 0 ? row(T('Worst price', 'Peor precio'), '$' + fmtPrice(m * (1 - MARKET_SLIP))) : ''}
        ${row(T('You get', 'Recibes'), sz > 0 && px > 0 ? `≈ $${fmtUSD(proceeds - fee)} USDC` : '—', 'var(--green)')}
        ${row(T('Est. fee', 'Comisión est.'), sz > 0 && px > 0 ? '$' + fmtUSD(fee) : '—')}
        ${pnl != null ? row(T('Profit on what you sell', 'Ganancia en lo vendido'), `${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))}`, pnl >= 0 ? 'var(--green)' : 'var(--red)') : ''}
        ${row(T('You keep', 'Te quedas'), `${fmtSize(left)} ${lbl}`)}
      </div>
      ${err && st.amt ? `<div style="font-size:12px;color:var(--red);margin:-4px 0 10px">${esc(err)}</div>` : ''}
      ${st.msg ? `<div style="font-size:12px;color:${st.msg.ok ? 'var(--green)' : 'var(--red)'};margin:-4px 0 10px">${esc(st.msg.text)}</div>` : ''}
      <button data-ss="go" ${err || st.busy ? 'disabled' : ''} style="width:100%;padding:14px;border-radius:13px;border:none;background:var(--red);color:#fff;font-weight:800;font-size:15px;cursor:pointer;opacity:${err || st.busy ? '.45' : '1'}">${st.busy ? T('Selling…', 'Vendiendo…') : `${T('Sell', 'Vender')} ${sz > 0 ? fmtSize(sz) + ' ' : ''}${lbl}`}</button>`
  }

  function draw() {
    const box = document.getElementById('spotSellBox')
    if (!box) return
    // Redrawing replaces the inputs; keep the caret where the person is typing.
    const act = document.activeElement?.id, pos = document.activeElement?.selectionStart
    box.innerHTML = html()
    if (act === 'ssAmt' || act === 'ssPx') { const el = document.getElementById(act); el?.focus(); try { el.setSelectionRange(pos, pos) } catch {} }
  }

  function close() { document.getElementById('spotSellOv')?.remove(); st = null }

  async function go() {
    if (problem() || st.busy) return
    const reason = deps.blocked?.()
    if (reason) { st.msg = { ok: false, text: reason }; return draw() }
    const sz = size(), px = st.type === 'market' ? mid() * (1 - MARKET_SLIP) : price()
    st.busy = true; st.msg = null; draw()
    try {
      const r = await deps.place({ pair: st.pair, sz, limitPx: px, tif: st.type === 'market' ? 'Ioc' : 'Gtc' })
      const s0 = r?.response?.data?.statuses?.[0]
      if (s0?.error) throw new Error(s0.error)
      const lbl = deps.label(st.coin)
      const text = s0?.filled
        ? T(`Sold ${fmtSize(+s0.filled.totalSz)} ${lbl} at $${fmtPrice(+s0.filled.avgPx)}`, `Vendido ${fmtSize(+s0.filled.totalSz)} ${lbl} a $${fmtPrice(+s0.filled.avgPx)}`)
        : s0?.resting ? T(`Sell order placed: ${fmtSize(sz)} ${lbl} at $${fmtPrice(px)}`, `Orden de venta colocada: ${fmtSize(sz)} ${lbl} a $${fmtPrice(px)}`)
        : T('Sent.', 'Enviado.')
      close(); deps.done(text, true)
    } catch (e) {
      st.busy = false; st.msg = { ok: false, text: e?.message || String(e) }; draw()
    }
  }

  /** Open the sheet for a holding, by the name the balance uses (token name, or "@N" on paper). */
  async function open(coin) {
    const pair = deps.pairOf(coin)
    if (!pair) { deps.done(T(`No spot market found for ${deps.label(coin)}.`, `No hay mercado spot para ${deps.label(coin)}.`), false); return }
    let dec = 2
    try { dec = await deps.szDec(pair) } catch {}
    st = { coin, pair, dec, type: 'market', unit: 'coin', amt: '', px: '', pct: null, busy: false, msg: null }
    st.px = mid() > 0 ? String(+mid().toPrecision(5)) : ''
    document.getElementById('spotSellOv')?.remove()
    const ov = document.createElement('div')
    ov.id = 'spotSellOv'
    const wide = window.innerWidth >= 700
    ov.style.cssText = `position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.6);display:flex;align-items:${wide ? 'center' : 'flex-end'};justify-content:center`
    ov.innerHTML = `<div id="spotSellBox" style="width:100%;max-width:${wide ? '420px' : '100%'};max-height:92vh;overflow-y:auto;box-sizing:border-box;background:var(--panel-3-o, var(--panel-3, var(--bg)));border:1px solid var(--border);border-radius:${wide ? '16px' : '18px 18px 0 0'};padding:16px 16px calc(18px + env(safe-area-inset-bottom))"></div>`
    document.body.appendChild(ov)
    ov.addEventListener('click', (e) => {
      if (e.target === ov) return close()
      const b = e.target.closest('[data-ss]'); if (!b || !st) return
      const a = b.dataset.ss, v = b.dataset.v
      if (a === 'close') return close()
      if (a === 'go') return go()
      if (a === 'type') { st.type = v; st.msg = null; if (st.pct) return setPct(st.pct); return draw() }
      if (a === 'pct') return setPct(+v)
      if (a === 'pxpct') { st.px = String(+(mid() * (1 + v / 100)).toPrecision(5)); if (st.pct && st.unit === 'usd') return setPct(st.pct); return draw() }
      if (a === 'unit') {
        const sz = size()
        st.unit = st.unit === 'usd' ? 'coin' : 'usd'
        st.amt = sz > 0 ? (st.unit === 'usd' ? (sz * price()).toFixed(2) : String(sz)) : ''
        return draw()
      }
    })
    ov.addEventListener('input', (e) => {
      if (!st) return
      if (e.target.id === 'ssAmt') { st.amt = e.target.value.replace(/[^0-9.]/g, ''); st.pct = null }
      if (e.target.id === 'ssPx') st.px = e.target.value.replace(/[^0-9.]/g, '')
      st.msg = null
      draw()
    })
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); if (e.key === 'Enter') go() })
    draw()
  }

  return { open, close, isOpen: () => !!st }
}
