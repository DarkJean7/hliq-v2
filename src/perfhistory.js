/**
 * The trade history behind one market on the Bot Performance screen.
 *
 * Pure presentation on purpose: it is handed the fills and returns a string. It reads no
 * app state, so it can be exercised directly from a test, and the "which market, whose
 * fills, which bot" question stays in main.js where the answer already lives.
 *
 * Two things this has to get right, because both are ways of quietly misreporting money:
 *
 *   - Hyperliquid splits one order across several fills. Showing them raw makes six
 *     entries out of one trade and reads as six times the activity, so fills are collapsed
 *     by order id, with size and fees summed and price weighted by size. `oid` is the key
 *     for that -- never `hash`, which comes back 0x0…0 for a great many fills.
 *   - A fill's closedPnl is gross. The fee is a real cost and is netted here, so the
 *     numbers in this list add up to the card's total rather than to something larger.
 */

/** Sum, weighted-average price, netted PnL. One row per order, newest first. */
export function collapseFills(fills) {
  const byOrder = new Map()
  for (const f of fills ?? []) {
    // tid is the last-resort key: unique per fill, so an order without an oid stays its
    // own row rather than every such fill merging into one.
    const key = f.oid != null ? 'o' + f.oid : 't' + (f.tid ?? f.time)
    const prev = byOrder.get(key)
    if (!prev) {
      byOrder.set(key, {
        time: f.time, timeStr: f.timeStr, coin: f.coin, side: f.side, dir: f.dir,
        sz: f.sz, pxNotional: f.px * f.sz, closedPnl: f.closedPnl, fee: f.fee, n: 1,
      })
      continue
    }
    prev.sz         += f.sz
    prev.pxNotional += f.px * f.sz
    prev.closedPnl  += f.closedPnl
    prev.fee        += f.fee
    prev.n          += 1
    // Keep the earliest timestamp: an order is done when it starts, not when it finishes.
    if (f.time < prev.time) { prev.time = f.time; prev.timeStr = f.timeStr }
  }
  return [...byOrder.values()]
    .map(r => ({ ...r, px: r.sz ? r.pxNotional / r.sz : 0, net: r.closedPnl - r.fee }))
    .sort((a, b) => b.time - a.time)
}

/** Totals for the header. Realized is gross; net is what actually reached the account. */
export function summarise(rows) {
  const closed = rows.filter(r => r.closedPnl !== 0)
  return {
    orders:   rows.length,
    fills:    rows.reduce((s, r) => s + r.n, 0),
    volume:   rows.reduce((s, r) => s + r.px * r.sz, 0),
    fees:     rows.reduce((s, r) => s + r.fee, 0),
    realized: rows.reduce((s, r) => s + r.closedPnl, 0),
    net:      rows.reduce((s, r) => s + r.net, 0),
    wins:     closed.filter(r => r.net > 0).length,
    closes:   closed.length,
  }
}

/**
 * The sheet body. `fmt` carries the host's formatters and translator so this file owns no
 * locale logic of its own: { money, size, price, t }.
 */
export function historyHtml(coin, fills, botLabels, fmt) {
  const rows = collapseFills(fills)
  const s    = summarise(rows)
  const T    = fmt.t
  const cls  = n => n > 0 ? 'pos' : n < 0 ? 'neg' : ''

  if (!rows.length) {
    return `<div style="padding:28px 16px;text-align:center;color:var(--muted);font-size:13px">
      ${T('No trades recorded for this market yet.', 'Aún no hay operaciones en este mercado.')}</div>`
  }

  const stat = (label, value, klass = '') =>
    `<div style="flex:1;min-width:78px">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em">${label}</div>
      <div class="${klass}" style="font-size:14px;font-weight:700;margin-top:2px">${value}</div>
    </div>`

  const head = `
    <div style="display:flex;flex-wrap:wrap;gap:12px 10px;padding:12px 14px;border-bottom:1px solid var(--border2)">
      ${stat(T('Net', 'Neto'), fmt.money(s.net), cls(s.net))}
      ${stat(T('Realized', 'Realizado'), fmt.money(s.realized), cls(s.realized))}
      ${stat(T('Fees', 'Comisiones'), '-' + fmt.money(Math.abs(s.fees)).replace('-', ''), 'neg')}
      ${stat(T('Volume', 'Volumen'), fmt.money(s.volume))}
      ${stat(T('Trades', 'Operaciones'), String(s.orders))}
      ${stat(T('Win rate', 'Aciertos'), s.closes ? (s.wins / s.closes * 100).toFixed(0) + '%' : '—')}
    </div>
    ${botLabels.length ? `<div style="padding:8px 14px;font-size:11px;color:var(--muted);border-bottom:1px solid var(--border2)">
      ${T('Run by', 'Ejecutado por')} <b style="color:var(--fg-2)">${botLabels.join(', ')}</b>
    </div>` : ''}`

  // A row that closed a position is the interesting one, so its PnL leads. An entry has no
  // PnL at all, and showing "0.00" there would read as a break-even trade rather than as
  // an opening -- so it shows a dash.
  const list = rows.map(r => `
    <div style="display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--border)">
      <div style="min-width:0;flex:1">
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:12px;font-weight:700;color:${r.side === 'BUY' ? 'var(--green)' : 'var(--neg)'}">${r.side}</span>
          <span style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.dir || ''}</span>
          ${r.n > 1 ? `<span style="font-size:9px;color:var(--muted);border:1px solid var(--border2);border-radius:4px;padding:0 3px">${r.n} ${T('fills', 'ejec.')}</span>` : ''}
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px">
          ${fmt.size(r.sz)} @ ${fmt.price(r.px)} · ${r.timeStr}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="${cls(r.net)}" style="font-size:13px;font-weight:700">${r.closedPnl !== 0 ? fmt.money(r.net) : '—'}</div>
        <div style="font-size:10px;color:var(--muted)">${T('fee', 'com.')} ${fmt.money(r.fee)}</div>
      </div>
    </div>`).join('')

  return head + `<div>${list}</div>` +
    `<div style="padding:10px 14px 4px;font-size:10px;color:var(--muted)">
      ${T('Partial fills of one order are shown as a single trade. PnL is net of fees.',
          'Las ejecuciones parciales de una orden se muestran como una sola operación. El PnL es neto de comisiones.')}
    </div>`
}
