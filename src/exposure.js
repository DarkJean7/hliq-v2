// ─── NET DIRECTIONAL EXPOSURE ─────────────────────────────────────────────────
//
// Every other surface in the app renders ONE position or ONE account at a time. With
// several wallets that hides the only number that describes the actual risk being run:
// the net, after positions on different wallets cancel each other out.
//
// Two things fall out of that and are visible nowhere else:
//   • net vs gross — being long $10k and short $9k is 19k of fees, funding and
//     liquidation surface for $1k of directional risk;
//   • internal hedges — the same coin held long on one wallet and short on another.
//     Net zero exposure, but funding is paid on BOTH legs, indefinitely.
//
// Everything here is arithmetic on data the app already holds. Nothing is fetched, nothing
// is narrated, and no number is re-derived from a different source than the rest of the app
// uses — a report that invents its own figures is worse than no report.
//
// Self-contained on purpose: pure computation plus an HTML string, with formatters passed in.
// It renders INTO the Allocation screen as a third segmented view, so it owns no overlay and no
// z-index of its own — removing the feature is deleting this file plus its call sites in main.js.

// One position, normalised out of either shape the app stores them in.
function _norm(ap) {
  const p = ap?.position ?? ap
  if (!p?.coin) return null
  const szi = parseFloat(p.szi ?? 0)
  if (!szi) return null
  // positionValue is HL's |szi| × mark. Fall back to unsigned zero rather than guessing.
  const ntl = Math.abs(parseFloat(p.positionValue ?? 0))
  if (!(ntl > 0)) return null
  const entry = parseFloat(p.entryPx ?? 0)
  const liq   = parseFloat(p.liquidationPx ?? 0)
  // Mark is derived from the position itself (notional / size) rather than a price feed, so
  // an expanded row can never show a price the card it came from disagrees with.
  const mark  = ntl / Math.abs(szi)
  const long  = szi > 0
  // Same formula the home position card uses: how far through the entry->liquidation span
  // the mark has travelled. Null when HL gives us nothing to measure against.
  let health = null
  if (entry > 0 && liq > 0) {
    if (long  && entry > liq) health = Math.max(0, Math.min(100, (mark - liq) / (entry - liq) * 100))
    if (!long && liq > entry) health = Math.max(0, Math.min(100, (liq - mark) / (liq - entry) * 100))
  }
  return {
    coin: String(p.coin),
    dir:  long ? 1 : -1,
    ntl,
    uPnl: parseFloat(p.unrealizedPnl ?? 0),
    szi:  Math.abs(szi),
    entry, mark, liq, health,
    lev: parseFloat(p.leverage?.value ?? 0) || null,
  }
}

/**
 * rows: [{ label, addr, accountValue, positions: [] }]
 * Pure — no globals, no fetching. Tested directly.
 */
export function computeExposure(rows) {
  const byCoin = new Map()
  let totalEquity = 0

  for (const r of (rows ?? [])) {
    if (r?.error) continue
    totalEquity += Math.max(0, parseFloat(r?.accountValue ?? 0))
    const who = r?.label || (r?.addr ? r.addr.slice(0, 6) + '…' : '—')
    for (const ap of (r?.positions ?? [])) {
      const p = _norm(ap)
      if (!p) continue
      const cur = byCoin.get(p.coin) ?? { coin: p.coin, longNtl: 0, shortNtl: 0, uPnl: 0, legs: [] }
      if (p.dir > 0) cur.longNtl += p.ntl; else cur.shortNtl += p.ntl
      cur.uPnl += p.uPnl
      cur.legs.push({ who, dir: p.dir, ntl: p.ntl, uPnl: p.uPnl, szi: p.szi, entry: p.entry, mark: p.mark, liq: p.liq, health: p.health, lev: p.lev })
      byCoin.set(p.coin, cur)
    }
  }

  const coins = [...byCoin.values()].map(c => {
    const net   = c.longNtl - c.shortNtl          // signed: + long, − short
    const gross = c.longNtl + c.shortNtl
    // The offsetting part. Long 10k / short 4k on the same coin = 4k hedged, 6k net long.
    // Only possible ACROSS wallets: HL nets a single account into one position per coin.
    const hedged = Math.min(c.longNtl, c.shortNtl)
    return { ...c, net, gross, hedged, wallets: new Set(c.legs.map(l => l.who)).size }
  }).sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || b.gross - a.gross)

  const grossNotional = coins.reduce((s, c) => s + c.gross, 0)
  // Net DIRECTIONAL is the signed sum: a long and a short in DIFFERENT coins still offset
  // in dollar terms, which is the honest reading of "how long am I overall". It is not a
  // beta-weighted figure and does not claim to be — correlation is not modelled here.
  const netDirectional = coins.reduce((s, c) => s + c.net, 0)
  const hedgedNotional = coins.reduce((s, c) => s + c.hedged, 0)

  return {
    coins,
    totalEquity,
    grossNotional,
    netDirectional,
    hedgedNotional,
    netLeverage:   totalEquity > 0 ? Math.abs(netDirectional) / totalEquity : 0,
    grossLeverage: totalEquity > 0 ? grossNotional / totalEquity : 0,
    accounts: (rows ?? []).filter(r => !r?.error).length,
  }
}

/** Deterministic findings. Each one states a number the other screens cannot show. */
export function exposureFindings(d, fmtUSD) {
  const out = []
  const $ = v => '$' + fmtUSD(Math.abs(v), 2)

  if (!d.coins.length) return out

  const side = d.netDirectional >= 0 ? 'LONG' : 'SHORT'
  out.push({
    kind: 'net',
    text: `Net ${side} ${$(d.netDirectional)} — ${d.netLeverage.toFixed(2)}× account equity.`,
  })

  if (d.hedgedNotional > 0) {
    const names = d.coins.filter(c => c.hedged > 0).map(c => c.coin).join(', ')
    out.push({
      kind: 'warn',
      text: `${$(d.hedgedNotional)} is hedged against itself across wallets (${names}). `
          + `That leg pays funding and fees on both sides for zero net exposure.`,
    })
  }

  // Gross materially above net means you are carrying liquidation surface you get no
  // directional benefit from.
  if (Math.abs(d.netDirectional) > 0 && d.grossNotional > Math.abs(d.netDirectional) * 1.25) {
    const ratio = d.grossNotional / Math.abs(d.netDirectional)
    out.push({
      kind: 'warn',
      text: `Gross ${$(d.grossNotional)} is ${ratio.toFixed(1)}× your net ${$(d.netDirectional)} — `
          + `most of the position risk is not directional exposure.`,
    })
  }

  const top = d.coins[0]
  if (top && Math.abs(d.netDirectional) > 0) {
    const share = Math.abs(top.net) / Math.abs(d.netDirectional) * 100
    if (share >= 50) out.push({
      kind: 'warn',
      text: `${top.coin} alone is ${share.toFixed(0)}% of your net exposure `
          + `(${top.net >= 0 ? 'long' : 'short'} ${$(top.net)}).`,
    })
  }

  return out
}

// ─── STRESS TEST ──────────────────────────────────────────────────────────────
//
// The question no screen answers: if the market moves against me, WHICH wallets break, and
// at what move? Per-position liquidation prices are shown one card at a time, so the picture
// across eight wallets never assembles.
//
// Model: shock every mark by the same percentage and ask which positions cross their own
// liquidation price. Longs are hurt by a fall, shorts by a rise, so each direction is a
// separate sweep. Deliberately simple and stated as such in the UI — this is a "how close am
// I" gauge, not a margin engine. It does NOT model cross-margin cascades (one liquidation
// freeing or consuming collateral and moving the others), correlation, or funding.
const STRESS_STEPS = [5, 10, 20, 30]

function _stressLegs(rows) {
  const legs = []
  for (const r of (rows ?? [])) {
    if (r?.error) continue
    const who = r?.label || (r?.addr ? r.addr.slice(0, 6) + '…' : '—')
    for (const ap of (r?.positions ?? [])) {
      const p = ap?.position ?? ap
      const szi = parseFloat(p?.szi ?? 0)
      const liq = parseFloat(p?.liquidationPx ?? 0)
      const ntl = Math.abs(parseFloat(p?.positionValue ?? 0))
      if (!szi || !(ntl > 0)) continue
      // Mark comes from the position itself (notional / size) so this needs no price feed
      // and cannot disagree with what the card shows.
      const mark = ntl / Math.abs(szi)
      if (!(mark > 0)) continue
      // A position with no liquidation price (isolated fully-funded, or HL not reporting one)
      // is skipped rather than assumed safe — and counted, so the UI can say so.
      legs.push({ who, coin: String(p.coin), long: szi > 0, mark, liq: liq > 0 ? liq : null, ntl })
    }
  }
  return legs
}

// Percentage move against a leg before it reaches liquidation. null when HL reports no
// liquidation price for it.
function _distToLiq(leg) {
  if (!leg.liq) return null
  const d = leg.long ? (leg.mark - leg.liq) / leg.mark : (leg.liq - leg.mark) / leg.mark
  return d * 100
}

export function computeStress(rows) {
  const legs = _stressLegs(rows)
  const priced = legs.filter(l => l.liq != null)
  const unpriced = legs.length - priced.length

  const scenarios = []
  for (const pct of STRESS_STEPS) {
    for (const dir of [-1, 1]) {
      // A drop only threatens longs, a rise only threatens shorts.
      const hit = priced.filter(l => (dir < 0 ? l.long : !l.long) && (_distToLiq(l) ?? Infinity) <= pct)
      if (!hit.length) continue
      scenarios.push({
        pct, dir,
        coins:   [...new Set(hit.map(h => h.coin))],
        wallets: [...new Set(hit.map(h => h.who))],
        notional: hit.reduce((s, h) => s + h.ntl, 0),
        count: hit.length,
      })
    }
  }

  // Closest leg to liquidation in each direction — the headline risk.
  const withDist = priced.map(l => ({ ...l, dist: _distToLiq(l) })).sort((a, b) => a.dist - b.dist)
  return { legs: legs.length, unpriced, scenarios, nearest: withDist.slice(0, 3), worst: withDist[0] ?? null }
}

/**
 * Positions with no take-profit or stop-loss trigger order protecting them.
 * openOrdersByCoin: Map<coinUpper, true> for coins that HAVE a trigger order.
 */
export function computeUnprotected(rows, protectedCoins) {
  const out = []
  for (const r of (rows ?? [])) {
    if (r?.error) continue
    const who = r?.label || (r?.addr ? r.addr.slice(0, 6) + '…' : '—')
    for (const ap of (r?.positions ?? [])) {
      const p = ap?.position ?? ap
      const szi = parseFloat(p?.szi ?? 0)
      const ntl = Math.abs(parseFloat(p?.positionValue ?? 0))
      if (!szi || !(ntl > 0)) continue
      if (protectedCoins?.has?.(String(p.coin).toUpperCase())) continue
      out.push({ who, coin: String(p.coin), long: szi > 0, ntl })
    }
  }
  out.sort((a, b) => b.ntl - a.ntl)
  return { positions: out, notional: out.reduce((s, x) => s + x.ntl, 0) }
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
const _esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function exposureHtml(d, fmtUSD, T = (en) => en, opts = {}) {
  // expanded: Set of coin names whose legs are open. Held by the caller so it survives the
  // re-render that toggling triggers.
  const expanded = opts.expanded ?? new Set()
  const fmtPx    = opts.fmtPrice ?? (v => String(v))
  const $ = v => '$' + fmtUSD(Math.abs(v), 2)
  const findings = exposureFindings(d, fmtUSD)

  if (!d.coins.length) {
    return `<div style="padding:34px 18px;text-align:center;color:var(--muted);font-size:13px">
      ${T('No open positions to analyse.')}
    </div>`
  }

  const stat = (label, value, sub, tone) => `
    <div style="flex:1;min-width:96px;padding:11px 12px;border:1px solid var(--border2);border-radius:11px;background:var(--panel-2)">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700">${label}</div>
      <div style="font-size:17px;font-weight:800;font-family:var(--font-mono);margin-top:3px${tone ? `;color:${tone}` : ''}">${value}</div>
      <div style="font-size:11px;color:var(--muted);margin-top:1px">${sub}</div>
    </div>`

  const netTone = d.netDirectional >= 0 ? 'var(--green)' : 'var(--red)'
  const stats = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;padding:14px 14px 4px">
      ${stat(T('Net exposure'), (d.netDirectional >= 0 ? '+' : '−') + $(d.netDirectional),
             `${d.netLeverage.toFixed(2)}× ${T('equity')}`, netTone)}
      ${stat(T('Gross notional'), $(d.grossNotional), `${d.grossLeverage.toFixed(2)}× ${T('equity')}`)}
      ${stat(T('Self-hedged'), $(d.hedgedNotional),
             d.hedgedNotional > 0 ? T('paying both sides') : T('none'),
             d.hedgedNotional > 0 ? 'var(--orange)' : null)}
    </div>`

  const findingsHtml = findings.length ? `
    <div style="padding:10px 14px 2px;display:flex;flex-direction:column;gap:7px">
      ${findings.map(f => `
        <div style="display:flex;gap:8px;align-items:flex-start;padding:9px 11px;border-radius:10px;
                    background:${f.kind === 'warn' ? 'rgba(255,159,10,0.09)' : 'var(--panel-2)'};
                    border:1px solid ${f.kind === 'warn' ? 'rgba(255,159,10,0.25)' : 'var(--border2)'}">
          <span style="flex-shrink:0;font-size:12px">${f.kind === 'warn' ? '⚠️' : '📐'}</span>
          <span style="font-size:12px;line-height:1.45">${_esc(f.text)}</span>
        </div>`).join('')}
    </div>` : ''

  // One expanded leg, in the same visual language as a home position card — side pill,
  // signed PnL, entry -> mark, and the entry-to-liquidation health bar — but without the
  // trade actions, guards and account routing those cards carry. This is a read-only
  // inspection of what makes up the net above it, not a second place to trade from.
  const legCard = (l) => {
    const long = l.dir > 0
    const tone = l.uPnl >= 0 ? 'var(--green)' : 'var(--red)'
    const bar  = l.health == null ? '' : `
      <div style="margin-top:7px">
        <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin-bottom:3px">
          <span>${T('HEALTH')}</span><span style="color:${l.health > 70 ? 'var(--green)' : l.health > 40 ? '#f59e0b' : l.health > 20 ? '#ff9444' : 'var(--red)'}">${l.health.toFixed(1)}%</span>
        </div>
        <div style="height:4px;border-radius:3px;background:rgba(255,255,255,.07);overflow:hidden">
          <div style="height:100%;width:${l.health.toFixed(1)}%;border-radius:3px;background:${l.health > 70 ? 'var(--green)' : l.health > 40 ? '#f59e0b' : l.health > 20 ? '#ff9444' : 'var(--red)'}"></div>
        </div>
      </div>`
    const kv = (k, v) => `<div style="min-width:0"><div style="font-size:9.5px;color:var(--muted);text-transform:uppercase;letter-spacing:.05em">${k}</div><div style="font-size:11.5px;font-family:var(--font-mono);overflow:hidden;text-overflow:ellipsis">${v}</div></div>`
    return `
      <div style="margin:7px 0 0;padding:10px 11px;border-radius:10px;background:var(--panel-2);border:1px solid var(--border2)">
        <div style="display:flex;align-items:center;gap:7px">
          <span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:6px;background:${long ? 'rgba(0,229,160,.15)' : 'rgba(255,77,109,.15)'};color:${long ? 'var(--green)' : 'var(--red)'}">${long ? T('LONG') : T('SHORT')}</span>
          <span style="font-size:12px;font-weight:700;color:var(--accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(l.who)}</span>
          ${l.lev ? `<span style="font-size:10px;color:var(--muted)">${l.lev}×</span>` : ''}
          <span style="flex:1"></span>
          <span style="font-size:12.5px;font-weight:800;font-family:var(--font-mono);color:${tone}">${l.uPnl >= 0 ? '+' : '−'}${$(l.uPnl)}</span>
        </div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:8px">
          ${kv(T('Size'),  fmtPx(l.szi))}
          ${kv(T('Entry'), l.entry > 0 ? '$' + fmtPx(l.entry) : '—')}
          ${kv(T('Mark'),  '$' + fmtPx(l.mark))}
          ${kv(T('Value'), $(l.ntl))}
        </div>
        ${bar}
        ${l.liq > 0 ? `<div style="font-size:10.5px;color:var(--muted);margin-top:6px">${T('Liq')} <span style="color:var(--red);font-family:var(--font-mono)">$${fmtPx(l.liq)}</span></div>` : ''}
      </div>`
  }

  const rows = d.coins.map(c => {
    const netTone2 = c.net >= 0 ? 'var(--green)' : 'var(--red)'
    const open = expanded.has(c.coin)
    const sorted = c.legs.slice().sort((a, b) => b.ntl - a.ntl)
    const summary = sorted
      .map(l => `<span style="white-space:nowrap;color:${l.dir > 0 ? 'var(--green)' : 'var(--red)'}">
                   ${l.dir > 0 ? 'L' : 'S'} ${_esc(l.who)}</span>`)
      .join('<span style="color:var(--muted)"> · </span>')
    const chev = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${open ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
    return `
      <div style="border-top:1px solid var(--border2)">
        <div onclick="window.__expToggleAsset('${_esc(c.coin)}')" style="padding:10px 14px;cursor:pointer;touch-action:manipulation">
          <div style="display:flex;align-items:center;gap:8px">
            ${chev}
            <span style="font-size:13px;font-weight:800">${_esc(c.coin)}</span>
            ${c.hedged > 0 ? `<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:9px;
               background:rgba(255,159,10,0.15);color:var(--orange)">${T('SELF-HEDGED')} ${$(c.hedged)}</span>` : ''}
            <span style="flex:1"></span>
            <span style="font-size:13px;font-weight:800;font-family:var(--font-mono);color:${netTone2}">
              ${c.net >= 0 ? '+' : '−'}${$(c.net)}</span>
          </div>
          <div style="display:flex;align-items:baseline;gap:8px;margin-top:2px;padding-left:20px">
            <div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${summary}</div>
            <span style="flex:1"></span>
            <span style="font-size:11px;color:var(--muted);white-space:nowrap">${T('gross')} ${$(c.gross)}</span>
          </div>
        </div>
        ${open ? `<div style="padding:0 14px 12px">${sorted.map(legCard).join('')}</div>` : ''}
      </div>`
  }).join('')

  return `${stats}${findingsHtml}
    <div style="padding:16px 14px 4px;font-size:11px;color:var(--muted);text-transform:uppercase;
                letter-spacing:.06em;font-weight:700;display:flex;justify-content:space-between">
      <span>${T('By asset')}</span><span>${T('Net')}</span>
    </div>
    <div>${rows}</div>
    <div style="padding:14px;font-size:10.5px;color:var(--muted);line-height:1.5">
      ${T('Net sums signed dollar notional across every wallet. It is not beta- or '
        + 'correlation-weighted, so two different coins offsetting here does not mean '
        + 'they offset in a real move.')}
    </div>
    <div style="height:calc(80px + env(safe-area-inset-bottom))"></div>`
}
export function stressHtml(st, unp, fmtUSD, T = (en) => en) {
  const $ = v => '$' + fmtUSD(Math.abs(v), 2)
  if (!st.legs) return ''

  const worst = st.worst
  const head = worst ? `
    <div style="padding:10px 14px 2px">
      <div style="padding:10px 12px;border-radius:10px;border:1px solid var(--border2);background:var(--panel-2)">
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700">${T('Closest to liquidation')}</div>
        <div style="font-size:13px;margin-top:3px">
          <b>${_esc(worst.coin)}</b> ${worst.long ? T('long') : T('short')} · ${_esc(worst.who)} —
          <b style="color:${worst.dist <= 10 ? 'var(--red)' : worst.dist <= 25 ? 'var(--orange)' : 'var(--fg)'}">${worst.dist.toFixed(1)}%</b>
          ${T('move away')}
        </div>
      </div>
    </div>` : ''

  const rows = st.scenarios.map(sc => {
    const label = (sc.dir < 0 ? '▼ −' : '▲ +') + sc.pct + '%'
    const tone  = sc.dir < 0 ? 'var(--red)' : 'var(--green)'
    return `
      <div style="display:flex;align-items:baseline;gap:10px;padding:9px 14px;border-top:1px solid var(--border2)">
        <span style="font-size:12px;font-weight:800;font-family:var(--font-mono);color:${tone};min-width:60px">${label}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:12px">${sc.count} ${sc.count === 1 ? T('position') : T('positions')} ${T('liquidate')} · <span style="color:var(--muted)">${_esc(sc.coins.join(', '))}</span></div>
          <div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${sc.wallets.length} ${sc.wallets.length === 1 ? T('wallet') : T('wallets')}: ${_esc(sc.wallets.join(', '))}</div>
        </div>
        <span style="font-size:12px;font-family:var(--font-mono);color:var(--muted);white-space:nowrap">${$(sc.notional)}</span>
      </div>`
  }).join('')

  const scenarioBlock = st.scenarios.length ? `
    <div style="padding:16px 14px 4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;display:flex;justify-content:space-between">
      <span>${T('If the market moves')}</span><span>${T('Notional')}</span>
    </div>
    <div>${rows}</div>`
    : `<div style="padding:12px 14px;font-size:12px;color:var(--muted)">${T('No position liquidates within a 30% move either way.')}</div>`

  const unprotectedBlock = unp.positions.length ? `
    <div style="padding:16px 14px 4px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;font-weight:700;display:flex;justify-content:space-between">
      <span>${T('No stop or take-profit')}</span><span>${$(unp.notional)}</span>
    </div>
    <div style="padding:0 14px 4px;display:flex;flex-wrap:wrap;gap:6px">
      ${unp.positions.slice(0, 12).map(p => `<span style="font-size:11px;padding:3px 8px;border-radius:9px;background:rgba(255,159,10,0.12);color:var(--orange);white-space:nowrap">${_esc(p.coin)} ${p.long ? 'L' : 'S'} · ${_esc(p.who)}</span>`).join('')}
      ${unp.positions.length > 12 ? `<span style="font-size:11px;color:var(--muted);padding:3px 4px">+${unp.positions.length - 12} ${T('more')}</span>` : ''}
    </div>` : ''

  const caveat = `
    <div style="padding:12px 14px;font-size:10.5px;color:var(--muted);line-height:1.5">
      ${T('Shocks every mark by the same percentage and checks each position against its own liquidation price. It does not model cross-margin cascades, correlation between coins, or funding — treat it as a "how close am I" gauge, not a margin engine.')}
      ${st.unpriced ? '<br>' + st.unpriced + ' ' + T('position(s) have no liquidation price reported and are excluded.') : ''}
    </div>`

  return head + scenarioBlock + unprotectedBlock + caveat
}
