// A running portfolio, opened: how it has done since it started (src/pflivepub.js shapes the
// data, server.js serves it). Used for everyone's public runs and for your own.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const pct = (x, d = 2) => x == null || !Number.isFinite(x) ? '—' : (x >= 0 ? '+' : '') + (x * 100).toFixed(d) + '%'
const usd = (x) => x == null || !Number.isFinite(Number(x)) ? '—' : '$' + Number(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ago = (t) => {
  if (!t) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  return s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 * 2 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`
}
export const runningFor = (t) => t ? ago(t) : '—'

/** A small line of the return over time; green above zero at the end, red below. */
export function sparkSvg(curve, { w = 220, h = 44 } = {}) {
  const pts = (curve ?? []).filter(p => Number.isFinite(p?.[1]))
  if (pts.length < 2) return `<svg class="pf-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"></svg>`
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1
  const vs = pts.map(p => p[1]), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), span = hi - lo || 1
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * w, y = (v) => h - 2 - ((v - lo) / span) * (h - 4)
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('')
  const up = vs[vs.length - 1] >= 0
  return `<svg class="pf-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><line x1="0" x2="${w}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="z"/><path d="${d}" class="${up ? 'up' : 'dn'}"/></svg>`
}

/** The big chart: return since the start, with a zero line, dates and the high/low. */
function chartSvg(curve) {
  const W = 640, H = 220
  const pts = (curve ?? []).filter(p => Number.isFinite(p?.[1]))
  if (pts.length < 2) return '<div class="pf-run-empty">Not enough history yet — the bot records its value every five minutes.</div>'
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0]
  const vs = pts.map(p => p[1]), lo = Math.min(0, ...vs), hi = Math.max(0, ...vs), pad = (hi - lo) * 0.08 || 0.01
  const L = lo - pad, Hh = hi + pad
  const x = (t) => ((t - t0) / (t1 - t0 || 1)) * W, y = (v) => H - ((v - L) / (Hh - L)) * H
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join('')
  const area = `${line}L${W},${y(0).toFixed(1)}L0,${y(0).toFixed(1)}Z`
  const up = vs[vs.length - 1] >= 0
  const fmtD = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  return `<div class="pf-run-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <path d="${area}" class="a ${up ? 'up' : 'dn'}"/>
      <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="z"/>
      <path d="${line}" class="l ${up ? 'up' : 'dn'}"/>
    </svg>
    <span class="pf-run-ax hi">${pct(hi)}</span><span class="pf-run-ax lo">${pct(lo)}</span>
    <span class="pf-run-ax d0">${fmtD(t0)}</span><span class="pf-run-ax d1">${fmtD(t1)}</span>
  </div>`
}

/**
 * Open one run. `run` is the server's (src/pflivepub.js publicRun with full: true).
 * opts: { labels: { strategyId: label }, nameOf(coin) → display name, mine: bool }
 */
export function openRunView(run, { labels = {}, nameOf = (c) => c, iconOf = () => '', mine = false } = {}) {
  document.getElementById('pfRunOv')?.remove()
  const ov = document.createElement('div')
  ov.id = 'pfRunOv'
  ov.className = 'pf-sheet-bg pf-run-ov'
  const r = run
  const strat = labels[r.strategy] ?? labels['bot:' + String(r.strategy).replace(/^bot:/, '')] ?? r.strategy
  // Each holding as a position card: what it is, which way, where it was bought and where it
  // is now. Sizes and dollars only when the run shows money (paper, or yours).
  const px = (v) => v == null ? '—' : '$' + (v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : v >= 1 ? v.toFixed(v >= 100 ? 2 : 4) : v.toPrecision(4))
  const holdings = (r.holdings ?? []).map(h => {
    const cls = h.pnlPct == null ? '' : h.pnlPct >= 0 ? 'up' : 'dn'
    return `<div class="pf-pos ${h.short ? 'is-short' : 'is-long'}">
      <div class="pf-pos-h">${iconOf(h.coin)}<div class="pf-pos-n"><b>${esc(nameOf(h.coin))}</b><span class="pf-pos-side">${h.short ? 'SHORT' : 'LONG'}</span></div>
        <div class="pf-pos-pnl ${cls}">${h.pnl != null ? `<b>${h.pnl >= 0 ? '+' : '-'}${usd(Math.abs(h.pnl))}</b>` : ''}<span>${pct(h.pnlPct)}</span></div></div>
      <div class="pf-pos-g">
        <div><i>Share</i>${h.share == null ? '—' : (h.share * 100).toFixed(1) + '%'}</div>
        <div><i>Entry</i>${px(h.entry)}</div>
        <div><i>Mark</i>${px(h.mark)}</div>
        ${h.value != null ? `<div><i>Value</i>${usd(h.value)}</div>` : h.size != null ? `<div><i>Size</i>${h.size}</div>` : ''}
      </div>
      ${h.share != null ? `<div class="pf-pos-bar"><i style="width:${(h.share * 100).toFixed(1)}%"></i></div>` : ''}
    </div>`
  }).join('')
  // Spot pairs are named by id in the bot's log ("BUY 24.72 @700"); say the token instead.
  const named = (t) => String(t ?? '').replace(/@\d+/g, (id) => nameOf(id))
  const events = (r.events ?? []).map(e => `<li><time>${esc(new Date(e.t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))}</time><b class="k-${esc(e.kind)}">${esc({ REBAL: 'Rebalance', FILL: 'Fill', START: 'Start', STOP: 'Stop', SKIP: 'Skipped', RECONCILE: 'Reconciled', WARN: 'Note' }[e.kind] ?? e.kind)}</b><span>${esc(named(e.text))}</span></li>`).join('')
  const stat = (l, v, cls = '') => `<div class="pf-run-stat"><div class="l">${l}</div><div class="v ${cls}">${v}</div></div>`
  ov.innerHTML = `<div class="pf-sheet pf-run" role="dialog" aria-label="${esc(r.name)}">
    <div class="pf-sheet-h"><div><b>${r.paper ? '<span class="pf-paper-tag">PAPER</span> ' : ''}${esc(r.name)}</b>
      <small>${esc(strat)}${r.lev ? ` · ${r.lev === 'max' ? 'max' : r.lev + '×'}` : ''}${r.margin === 'isolated' ? ' isolated' : ''} · running ${runningFor(r.startedAt)}${r.paused ? ' · <span class="pf-warn">paused</span>' : ''}${mine ? ' · yours' : ''}</small></div>
      <button class="pf-sheet-x" data-x aria-label="Close">×</button></div>
    <div class="pf-run-ret ${r.ret == null ? '' : r.ret >= 0 ? 'up' : 'dn'}">${pct(r.ret)}<small> since it started</small></div>
    ${chartSvg(r.curve)}
    <div class="pf-run-stats">
      ${stat('Return', pct(r.ret), r.ret == null ? '' : r.ret >= 0 ? 'up' : 'dn')}
      ${stat('Max drawdown', pct(r.maxDd), 'dn')}
      ${stat('Costs', r.costPct == null ? '—' : (r.costPct * 100).toFixed(2) + '% of budget')}
      ${stat('Trades', String(r.trades ?? 0))}
      ${r.budget != null ? stat('Value', `${usd(r.equity)} <small>of ${usd(r.budget)}</small>`) : stat('Positions', String(r.positions ?? 0))}
      ${stat('Started', r.startedAt ? new Date(r.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—')}
    </div>
    ${r.reason ? `<p class="pf-run-next"><b>Next:</b> ${esc(r.reason)}</p>` : ''}
    ${holdings ? `<div class="pf-run-sec">Positions <small>entry is the average of its own fills</small></div><div class="pf-pos-grid">${holdings}</div>` : ''}
    ${events ? `<div class="pf-run-sec">Recent actions</div><ul class="pf-run-ev">${events}</ul>` : ''}
    ${r.budget == null ? '<p class="pf-help">A real-money run, shown in percent: its owner\'s balances and order sizes are not published.</p>' : ''}
  </div>`
  document.body.appendChild(ov)
  const close = () => { ov.remove(); document.removeEventListener('keydown', onKey) }
  const onKey = (e) => { if (e.key === 'Escape') close() }
  document.addEventListener('keydown', onKey)
  ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-x]')) close() })
  return { close }
}
