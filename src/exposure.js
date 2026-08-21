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
// Self-contained on purpose: it owns its overlay and pulls formatters in through openExposure,
// so removing the feature is deleting this file plus its two call sites.

// One position, normalised out of either shape the app stores them in.
function _norm(ap) {
  const p = ap?.position ?? ap
  if (!p?.coin) return null
  const szi = parseFloat(p.szi ?? 0)
  if (!szi) return null
  // positionValue is HL's |szi| × mark. Fall back to unsigned zero rather than guessing.
  const ntl = Math.abs(parseFloat(p.positionValue ?? 0))
  if (!(ntl > 0)) return null
  return {
    coin: String(p.coin),
    dir:  szi > 0 ? 1 : -1,
    ntl,
    uPnl: parseFloat(p.unrealizedPnl ?? 0),
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
      cur.legs.push({ who, dir: p.dir, ntl: p.ntl })
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

// ─── RENDER ───────────────────────────────────────────────────────────────────
const _esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

export function exposureHtml(d, fmtUSD, T = (en) => en) {
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

  const rows = d.coins.map(c => {
    const netTone2 = c.net >= 0 ? 'var(--green)' : 'var(--red)'
    const legs = c.legs
      .slice()
      .sort((a, b) => b.ntl - a.ntl)
      .map(l => `<span style="white-space:nowrap;color:${l.dir > 0 ? 'var(--green)' : 'var(--red)'}">
                   ${l.dir > 0 ? 'L' : 'S'} ${_esc(l.who)}</span>`)
      .join('<span style="color:var(--muted)"> · </span>')
    return `
      <div style="padding:10px 14px;border-top:1px solid var(--border2)">
        <div style="display:flex;align-items:baseline;gap:8px">
          <span style="font-size:13px;font-weight:800">${_esc(c.coin)}</span>
          ${c.hedged > 0 ? `<span style="font-size:9px;font-weight:800;padding:2px 6px;border-radius:9px;
             background:rgba(255,159,10,0.15);color:var(--orange)">${T('SELF-HEDGED')} ${$(c.hedged)}</span>` : ''}
          <span style="flex:1"></span>
          <span style="font-size:13px;font-weight:800;font-family:var(--font-mono);color:${netTone2}">
            ${c.net >= 0 ? '+' : '−'}${$(c.net)}</span>
        </div>
        <div style="display:flex;align-items:baseline;gap:8px;margin-top:2px">
          <div style="font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${legs}</div>
          <span style="flex:1"></span>
          <span style="font-size:11px;color:var(--muted);white-space:nowrap">${T('gross')} ${$(c.gross)}</span>
        </div>
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

// ─── OVERLAY ──────────────────────────────────────────────────────────────────
const OVERLAY_ID = 'exposureOverlay'

function _ensureOverlay() {
  let el = document.getElementById(OVERLAY_ID)
  if (el) return el
  el = document.createElement('div')
  el.id = OVERLAY_ID
  // z-index must sit in the same band as the other full-screen mobile sheets (Global Chat
  // is 100055). The first version used 60, which put it UNDER #mobileView and the More
  // drawer — on desktop it happened to show, on mobile the panel opened behind everything
  // and the feature looked dead.
  //
  // overflow-x is set EXPLICITLY: with only overflow-y:auto, CSS resolves the other axis
  // from `visible` to `auto`, and any over-wide child makes the whole sheet pan sideways.
  el.style.cssText = 'display:none;position:fixed;inset:0;z-index:100055;background:var(--bg);'
                   + 'flex-direction:column;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch'
  document.body.appendChild(el)
  return el
}

export function closeExposure() {
  const el = document.getElementById(OVERLAY_ID)
  if (el) el.style.display = 'none'
}

/**
 * rows      — [{ label, addr, accountValue, positions }]
 * fmtUSD    — the app's formatter, so figures match every other screen
 * T         — translator
 */
export function openExposure({ rows, fmtUSD, T = (en) => en }) {
  // Close the More drawer first. It is what launched this, and leaving it open left it
  // sitting over the panel — the other drawer entries (__openChat, __mobMoreTab) all do
  // the same thing.
  document.getElementById('mobMoreDrawer')?.classList.remove('open')
  document.getElementById('mobMoreBackdrop')?.classList.remove('open')
  const el = _ensureOverlay()
  const d  = computeExposure(rows)
  el.innerHTML = `
    <div style="flex-shrink:0;position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:10px;
                padding:16px 14px 12px;border-bottom:1px solid var(--border);background:var(--bg)">
      <span style="font-size:16px;font-weight:800">${T('Exposure')}</span>
      <span style="font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;
                   background:rgba(0,229,160,0.12);color:var(--accent)">
        ${d.accounts} ${d.accounts === 1 ? T('account') : T('accounts')}</span>
      <button onclick="window.__closeExposure()" aria-label="Close"
        style="margin-left:auto;display:flex;align-items:center;gap:5px;background:rgba(255,255,255,0.07);
               border:1px solid rgba(255,255,255,0.12);color:var(--fg);border-radius:8px;padding:6px 11px;
               font-size:12px;font-weight:600;cursor:pointer">${T('Close')}</button>
    </div>
    ${exposureHtml(d, fmtUSD, T)}`
  el.style.display = 'flex'
  el.scrollTop = 0
}
