/**
 * INSOLVENT TERMINAL — off-exchange holdings, on screen
 *
 * The Spot tab's "Off-exchange" group: tokens you hold outside Hyperliquid (a HyperEVM token,
 * locked NEST on Nest Exchange…) that you type in by amount and we price live. src/offex.js
 * holds the rules and the arithmetic; this is the group, the add/edit sheet and the price
 * poll.
 *
 * It cannot see `state`. Which accounts the current view covers, the privacy mask and how to
 * repaint arrive through `initOffex(ctx)` from main.js — the same shape as src/agentkeys.js,
 * and for the same reason: in the combined view `state.addr` is '__all_accounts__', and a
 * holding saved under that key is a holding nothing ever reads back.
 */
import { loadHoldings, saveHoldings, upsertHolding, removeHolding, holdingValue, holdingsTotal,
         normAddr, isTokenAddr, NETWORKS, DEFAULT_NET, normNet, quoteKey,
         HL_NET, normToken, isHlToken } from './offex.js'
import { fmtUSD, fmtPrice, fmtSize, esc } from './format.js'

let ctx = {
  /** The real accounts this view covers: [{ addr, label }]. Empty in paper mode. */
  accounts: () => [],
  /** The privacy mask — '•••' when the eye is shut. */
  prv: (s) => s,
  /** Repaint whatever shows the group. */
  rerender: () => {},
  store: () => (typeof localStorage !== 'undefined' ? localStorage : null),
  /** The app's own artwork for a Hyperliquid-listed coin, as HTML. Injected for the same
   *  reason as hlPrice: this module does not read state. */
  coinIconHtml: null,
  /** Mid price for an HL-listed spot token, or null. Injected: this module does not read
   *  state, and the app already polls these every tick. */
  hlPrice: () => null,
}
export function initOffex(overrides = {}) { ctx = { ...ctx, ...overrides } }

// ─── PRICES ───────────────────────────────────────────────────────────────────

/**
 * addr → parsed quote. Missing means "not priced", never $0.
 *
 * Remembered on the device, and kept through a failed fetch. Both were missing, and together
 * they made the off-exchange value "flicker and disappear and appear when visiting the spot
 * tab": on a fresh load there were no prices at all until the Spot tab asked for them, so the
 * headline ("Count in balance") and the wheel showed nothing and then jumped; and one fetch
 * that came back without a token replaced its known price with nothing, blanking the row
 * until the next one. Not fetched is not the same as not priced.
 */
const LS_QUOTES = 'hliq_offex_quotes'
const QUOTE_KEEP_MS = 30 * 60_000          // a known price outlives a failed fetch this long
const _quotes = {}
const _quoteAt = {}
try {
  const saved = JSON.parse((typeof localStorage !== 'undefined' && localStorage.getItem(LS_QUOTES)) || '{}')
  for (const [a, v] of Object.entries(saved ?? {})) {
    if (v?.q && Date.now() - Number(v.at) < QUOTE_KEEP_MS) { _quotes[a] = v.q; _quoteAt[a] = Number(v.at) }
  }
} catch {}
function _saveQuotes() {
  try {
    const out = {}
    for (const a of Object.keys(_quotes)) if (_quotes[a]) out[a] = { q: _quotes[a], at: _quoteAt[a] ?? Date.now() }
    ctx.store()?.setItem(LS_QUOTES, JSON.stringify(out))
  } catch {}
}
let _lastFetch = 0
let _inflight = null

/**
 * Ask the server for every token in view, at most once a minute.
 *
 * Only repaints when a price actually changed, so a poll that brings back the same numbers
 * does not rebuild the Spot tab under someone's thumb.
 */
// A quote key back into its network and address ("eth:0x…", or a bare HyperEVM address).
const splitKey = (k) => {
  const s = String(k ?? ''), i = s.indexOf(':')
  if (i > 0) { const n = normNet(s.slice(0, i)); return [n, normToken(n, s.slice(i + 1))] }
  return [DEFAULT_NET, normAddr(s)]
}

// `extra`: quote keys (quoteKey(net, addr)) or bare addresses, which are HyperEVM.
export function refreshPrices({ force = false, extra = [] } = {}) {
  const want = [...new Set([
    ...rows().map(r => quoteKey(r.entry.net, r.entry.token)),
    ...extra.map(k => quoteKey(...splitKey(k))),
  ].filter(Boolean))]
  if (!want.length) return Promise.resolve(false)
  if (_inflight) return _inflight
  if (!force && Date.now() - _lastFetch < 60_000 && want.every(a => a in _quotes)) return Promise.resolve(false)
  _lastFetch = Date.now()
  _inflight = (async () => {
    try {
      // One request per network — each source prices one chain per call.
      const byNet = {}
      for (const k of want) { const [n, a] = splitKey(k); (byNet[n] ??= []).push(a) }
      const answers = await Promise.all(Object.entries(byNet).map(async ([n, addrs]) => {
        // Hyperliquid's own book: the app already has these mids, so there is nothing to
        // fetch and nothing to spend. No contract exists to ask a DEX source about anyway.
        if (n === HL_NET) {
          return addrs.map(a => {
            const px = Number(ctx.hlPrice?.(a))
            return [quoteKey(n, a), Number.isFinite(px) && px > 0
              ? { addr: a, symbol: a, name: 'Hyperliquid spot', icon: null,
                  price: px, liq: null, thin: false, src: 'Hyperliquid', pool: null }
              : null]
          })
        }
        try {
          const r = await fetch('/offexprice?a=' + addrs.join(',') + (n === DEFAULT_NET ? '' : '&n=' + n))
          if (!r.ok) return null
          const { prices = {} } = await r.json()
          return addrs.map(a => [quoteKey(n, a), prices[a] ?? null])
        } catch { return null }     // this network's answer is unknown — leave its quotes alone
      }))
      let changed = false
      // Only what a reader can see counts as a change. Pool liquidity moves on every fetch,
      // and repainting the Spot tab once a minute for a figure nobody is looking at is churn.
      const shown = (q) => q ? [q.price, q.thin, q.icon, q.symbol, q.src, q.pool].join('|') : ''
      for (const [a, q] of answers.filter(Boolean).flat()) {
        if (q) {
          if (shown(_quotes[a]) !== shown(q)) changed = true
          _quotes[a] = q; _quoteAt[a] = Date.now()
        } else if (_quotes[a] && Date.now() - (_quoteAt[a] ?? 0) < QUOTE_KEEP_MS) {
          // Absent from this answer, known recently: keep it. A blip is not a delisting.
        } else {
          // Absent, and nothing recent to fall back on: genuinely unpriced.
          if (_quotes[a]) changed = true
          _quotes[a] = null
        }
      }
      _saveQuotes()
      if (changed) { try { ctx.rerender() } catch {} }
      return changed
    } catch { return false }
    finally { _inflight = null }
  })()
  return _inflight
}

export const quoteFor = (token, net = DEFAULT_NET) => _quotes[quoteKey(net, token)] ?? null

// ─── WHAT IS IN VIEW ──────────────────────────────────────────────────────────

/** Every off-exchange holding the current view covers, each with its account and value. */
export function rows() {
  const store = ctx.store()
  const out = []
  for (const a of (ctx.accounts() ?? [])) {
    for (const entry of loadHoldings(store, a.addr)) {
      out.push({ acct: a.addr, label: a.label ?? null, entry, value: holdingValue(entry, quoteFor(entry.token, entry.net)) })
    }
  }
  return out.sort((x, y) => (y.value.usd ?? -1) - (x.value.usd ?? -1))
}

/** How many holdings are in view — the Spot tab badges add this to the Hyperliquid tokens. */
export function count() { return rows().length }

/**
 * The holdings as allocation-wheel items: priced ones only, since an arc has to have a size.
 * The shape matches the wheel's spot rows so the renderer draws both the same way; `offex`
 * marks them so it can label and icon them from the holding rather than from a HL coin name
 * — "NEST" the HyperEVM token is not whatever Hyperliquid lists under that name.
 */
export function wheelItems() {
  refreshPrices()
  const by = new Map()
  for (const r of rows()) {
    if (r.value.usd == null || !(r.value.usd > 0)) continue
    const q   = quoteFor(r.entry.token, r.entry.net)
    const key = quoteKey(r.entry.net, r.entry.token)
    const it  = by.get(key) ?? {
      coin: r.entry.symbol || r.entry.token, offex: true, token: key,
      label: r.entry.symbol || (r.entry.token.slice(0, 6) + '…' + r.entry.token.slice(-4)),
      icon: q?.icon ?? r.entry.icon ?? null,
      margin: 0, px: r.value.price, size: 0, spotCost: 0, uPnl: 0, notional: 0,
      longs: 0, shorts: 0, accts: new Set(), _costKnown: true,
    }
    it.margin += r.value.usd
    it.size   += r.entry.amount
    if (r.entry.cost != null) it.spotCost += r.entry.cost
    else it._costKnown = false
    if (r.label) it.accts.add(r.label)
    by.set(key, it)
  }
  return [...by.values()].map(it => {
    // PnL only when EVERY holding of the token has a cost — a partial basis would call the
    // uncosted part pure profit.
    if (!it._costKnown) it.spotCost = 0
    it.uPnl = it.spotCost > 0 ? it.margin - it.spotCost : 0
    return it
  }).sort((a, b) => b.margin - a.margin)
}

/** The group's total. `complete: false` when any holding has no price — the sum is a floor. */
export function total() {
  refreshPrices()      // at most once a minute; the headline and the wheel read this, not just Spot
  const r = rows()
  const quotes = Object.fromEntries(r.map(x => [quoteKey(x.entry.net, x.entry.token), quoteFor(x.entry.token, x.entry.net)]))
  return holdingsTotal(r.map(x => x.entry), quotes)
}

// ─── COUNT IN BALANCE ─────────────────────────────────────────────────────────

/**
 * An opt-in switch that adds off-exchange value to the headline balance. OFF by default —
 * asked for in exactly those words — because the headline otherwise matches Hyperliquid to
 * the cent, and a typed amount priced from a DEX pool cannot be checked against anything.
 *
 * It moves the HEADLINE only. Health, leverage, ROE, Net PnL and the "today" change are all
 * still computed from the Hyperliquid account: a lock on Nest is not margin, and a price move
 * on EAGLE is not trading profit. Per device, like the other display preferences.
 */
const LS_IN_BAL = 'hliq_offex_in_bal'
export function countInBalance() {
  try { return ctx.store()?.getItem(LS_IN_BAL) === '1' } catch { return false }
}
export function setCountInBalance(on) {
  try { ctx.store()?.setItem(LS_IN_BAL, on ? '1' : '0') } catch {}
  try { ctx.rerender() } catch {}
  try { ctx.onBalanceMode?.() } catch {}
}
/**
 * What to add to the headline: the priced off-exchange total when the switch is on, else 0.
 * A holding with no price adds nothing — it is not counted as $0, it is just not counted.
 */
export function balanceAdd() {
  if (!countInBalance()) return 0
  const t = total()
  return t.usd > 0 ? t.usd : 0
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

const _open = new Set()   // expanded rows, by acct|token

function icon(entry) {
  // A Hyperliquid-listed token has no contract and no pool, so neither price source carries an
  // image for it. The app has one — the same icon the Spot rows above use.
  const hl = hlIconHtml(entry)
  if (hl) return `<div class="mob-v-row-icon" style="padding:0;overflow:hidden;background:var(--panel-2)">${hl}</div>`
  // The live quote's image wins over the one saved with the holding: EAGLE was saved when
  // the only source had no image for it, and would otherwise show a letter forever.
  const q = quoteFor(entry.token, entry.net)
  if (q?.icon) entry = { ...entry, icon: q.icon }
  const letter = esc((entry.symbol || '?').slice(0, 1).toUpperCase())
  const fallback = `<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:var(--fg-2)">${letter}</span>`
  if (!entry.icon) return `<div class="mob-v-row-icon" style="padding:0;overflow:hidden;background:var(--panel-2)">${fallback}</div>`
  // A dead icon URL falls back to the letter rather than a broken-image glyph.
  return `<div class="mob-v-row-icon" style="padding:0;overflow:hidden;background:var(--panel-2)">
    <img src="${esc(entry.icon)}" alt="" style="width:100%;height:100%;object-fit:cover"
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${letter}',style:'display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-weight:800;font-size:14px'}))"></div>`
}

/** The app's icon for a Hyperliquid-listed holding, or null for anything else. */
function hlIconHtml(entry) {
  if (normNet(entry?.net) !== HL_NET || !ctx.coinIconHtml) return null
  try { return ctx.coinIconHtml(String(entry.symbol || entry.token)) || null } catch { return null }
}

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4)

// The facts a holding opens to, as [label, value, colour] — the same triples the Hyperliquid
// spot rows open to, so both shells can lay them out exactly as they lay out a HL token.
function facts(r, showAcct) {
  const { entry: e, value: v } = r
  const q   = quoteFor(e.token, e.net)
  const sym = esc(e.symbol || short(e.token))
  return [
    ...(showAcct ? [['Account', esc(r.label || short(r.acct))]] : []),
    ...(e.cost != null ? [
      ['Cost', ctx.prv('$' + fmtUSD(e.cost))],
      ['Avg buy', e.amount > 0 ? '$' + fmtPrice(e.cost / e.amount) : '—'],
      ...(v.pnl == null ? [['Profit', 'No price for this token yet']] : [
        ['Profit', ctx.prv(`${v.pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(v.pnl))}`), v.pnl >= 0 ? 'var(--green)' : 'var(--red)'],
        ['ROI', ctx.prv(`${v.roi >= 0 ? '+' : ''}${v.roi.toFixed(2)}%`), v.roi >= 0 ? 'var(--green)' : 'var(--red)'],
      ]),
    ] : []),
    ['Amount', ctx.prv(fmtSize(e.amount)) + ' ' + sym],
    ['Price', v.price != null ? '$' + fmtPrice(v.price) : '—'],
    ['Value', ctx.prv(v.usd != null ? '$' + fmtUSD(v.usd, 2) : '—')],
    ['Network', esc(NETWORKS[normNet(e.net)].label)],
    ['Contract', `<span class="notranslate" style="font-family:var(--font-mono)">${esc(short(e.token))}</span>`],
    // Where the number came from, so a price that looks wrong can be checked — and so the
    // deepest-pool rule is visible rather than taken on trust.
    ...(q?.src ? [['Priced from', esc([q.pool, q.src].filter(Boolean).join(' · '))
      + (q.liq != null ? ` <span style="color:var(--muted)">($${fmtUSD(q.liq, 0)} liq.)</span>` : '')]] : []),
    ...(e.note ? [['Note', esc(e.note)]] : []),
  ]
}

const thinNote = `<div style="font-size:11px;color:#f59e0b;padding:6px 0 4px">Thin market — this price comes from a pool with little liquidity and may not be what you could sell for.</div>`
const editBtn = (r) => `<button onclick="event.stopPropagation();window.__offexEdit('${esc(r.acct)}','${esc(r.entry.token)}','${esc(normNet(r.entry.net))}')"
  style="width:100%;margin-top:8px;padding:9px;border-radius:9px;border:1px solid var(--border2);background:var(--panel-3);color:var(--fg);font-size:12px;font-weight:700;cursor:pointer">Edit</button>`
const rowId = (r) => r.acct + '|' + quoteKey(r.entry.net, r.entry.token)

// What sits under the name, the way a HL row names its account: the account (when more than
// one is in view), then the note — "locked" is the most useful thing to see without opening it.
function subLine(r, showAcct) {
  const parts = []
  if (showAcct && r.label) parts.push(`<span class="notranslate" style="color:var(--accent)">${esc(r.label)}</span>`)
  if (normNet(r.entry.net) !== DEFAULT_NET) parts.push(esc(NETWORKS[normNet(r.entry.net)].label))
  if (r.entry.note) parts.push(esc(r.entry.note))
  return parts.join(' · ')
}

/** Mobile: the same row as a Hyperliquid spot token — icon, name, price, value, chevron. */
function rowHtml(r, showAcct) {
  const { entry: e, value: v } = r
  const id  = rowId(r)
  const xp  = _open.has(id)
  const sym = esc(e.symbol || short(e.token))
  const sub = subLine(r, false)
  const pnlLine = v.pnl != null
    ? `<div class="mob-v-row-pct" style="color:${v.pnl >= 0 ? 'var(--green)' : 'var(--red)'};white-space:nowrap">${ctx.prv(`${v.pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(v.pnl))} · ${v.roi >= 0 ? '+' : ''}${v.roi.toFixed(2)}%`)}</div>`
    : ''
  const chev = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="12" height="12" style="color:var(--muted);flex-shrink:0;transition:transform .2s${xp ? ';transform:rotate(90deg)' : ''}"><polyline points="9 6 15 12 9 18"/></svg>`
  const grid = ctx.detailGrid ? ctx.detailGrid(facts(r, showAcct)) : ''
  return `<div>
    <div class="mob-v-row" style="cursor:pointer" onclick="window.__offexToggle('${esc(id)}')">
      ${icon(e)}
      <div class="mob-v-row-info">
        <div class="mob-v-row-name">${sym}</div>
        <div class="mob-v-row-sub">${ctx.prv(fmtSize(e.amount))} ${sym}${showAcct && r.label ? ` · <span class="notranslate" style="color:var(--accent)">${esc(r.label)}</span>` : ''}${sub ? ` · ${sub}` : ''}</div>
      </div>
      <div style="flex-shrink:0;width:74px;display:flex;flex-direction:column">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;line-height:1.2;text-align:center">Price</div>
        <div style="font-size:13px;font-weight:500;color:var(--fg);line-height:1.3;margin-top:2px;white-space:nowrap;text-align:center;overflow:hidden;text-overflow:ellipsis">${v.price != null ? '$' + fmtPrice(v.price) : '—'}</div>
      </div>
      <div class="mob-v-row-right" style="width:104px;flex-shrink:0;flex-grow:0">
        <div class="mob-v-row-val">${ctx.prv(v.usd != null ? '$' + fmtUSD(v.usd) : '—')}</div>
        ${pnlLine}
      </div>
      ${chev}
    </div>
    <div style="display:${xp ? '' : 'none'}">
      ${grid}
      <div style="padding:0 16px 12px;background:var(--panel-2)">${v.thin ? thinNote : ''}${editBtn(r)}</div>
    </div>
  </div>`
}

/** Desktop: a row of the Hyperliquid spot table itself — Token, Price, Balance, Value, PnL. */
function deskRowHtml(r, showAcct) {
  const { entry: e, value: v } = r
  const id  = rowId(r)
  const xp  = _open.has(id)
  const sym = esc(e.symbol || short(e.token))
  const sub = subLine(r, showAcct)
  const cls = (v.pnl ?? 0) >= 0 ? 'pos' : 'neg'
  const img = (() => {
    const hl = hlIconHtml(e)
    if (hl) return hl
    const q = quoteFor(e.token, e.net)
    const url = q?.icon ?? e.icon
    const letter = esc((e.symbol || '?').slice(0, 1).toUpperCase())
    const letterDiv = `<div style="display:flex;align-items:center;justify-content:center;font-weight:800;font-size:12px;color:var(--fg-2)">${letter}</div>`
    return url
      ? `<img src="${esc(url)}" alt="" style="object-fit:cover" onerror="this.outerHTML='${letterDiv.replace(/'/g, '&#39;').replace(/"/g, '&quot;')}'">`
      : letterDiv
  })()
  return `<div class="ov-oc-item" data-offex-row>
    <div class="ov-ord-row ov-spot-row" style="cursor:pointer" onclick="window.__offexToggle('${esc(id)}')">
      <span class="ov-pos-mkt"><div class="ov-av-img">${img}</div><span class="ov-pos-info"><b>${sym}</b>${sub ? `<i>${sub}</i>` : ''}</span></span>
      <span class="ov-r mono">${v.price != null ? '$' + fmtPrice(v.price) : '—'}</span>
      <span class="ov-r mono">${ctx.prv(fmtSize(e.amount))}</span>
      <span class="ov-r mono">${v.usd != null ? ctx.prv('$' + fmtUSD(v.usd)) : '—'}</span>
      <span class="ov-r mono ${v.pnl != null ? cls : ''}">${v.pnl != null
        ? ctx.prv(`${v.pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(v.pnl))} · ${v.roi >= 0 ? '+' : ''}${v.roi.toFixed(1)}%`)
        : '—'}</span>
    </div>
    <div class="ov-oc-close" style="display:${xp ? '' : 'none'}">
      ${v.thin ? thinNote : ''}
      <div class="ov-spot-facts">${facts(r, showAcct).map(([k, val, c]) => `<span><i>${k}</i><b style="font-weight:600${c ? ';color:' + c : ''}">${val}</b></span>`).join('')}</div>
      <div style="max-width:220px">${editBtn(r)}</div>
    </div>
  </div>`
}

/**
 * The whole group for the mobile Spot tab.
 *
 * `spotUsd` is what the Hyperliquid spot rows above add up to, so the footer can print
 * "incl. off-exchange" as one combined figure — kept visibly separate from the account's own
 * equity, which it never feeds.
 */
export function sectionHtml({ spotUsd = null, desk = false, withHead = false } = {}) {
  const accts = ctx.accounts() ?? []
  if (!accts.length) return ''            // paper, or no real account in view
  const list = rows()
  const tot  = total()
  const showAcct = accts.length > 1
  if (list.length) refreshPrices()        // at most once a minute; repaints only on change

  // Desktop lines the group up with the table above it: the same 4px gutter as its rows.
  const pad = desk ? '4px' : '16px'
  const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:${desk ? '14px' : '16px'} ${pad} 6px">
    <div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--muted);text-transform:uppercase">Off-exchange</div>
      ${list.length ? `<div style="font-size:12px;color:var(--fg-2);margin-top:2px">${ctx.prv('$' + fmtUSD(tot.usd))}${tot.complete ? '' : ` <span style="color:var(--muted)">· ${tot.count - tot.priced} unpriced</span>`}</div>` : ''}
    </div>
    <button onclick="window.__offexAdd()" style="border:1px solid var(--accent);background:color-mix(in oklch,var(--accent) 12%,transparent);color:var(--accent);border-radius:9px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer">+ Add token</button>
  </div>`

  // With no Hyperliquid rows above, the desktop table has no column header — give it one.
  const deskHead = desk && withHead && list.length
    ? `<div class="ov-ord-head ov-spot-row"><span>Token</span><span class="ov-r">Price</span><span class="ov-r">Balance</span><span class="ov-r">Value</span><span class="ov-r">PnL</span></div>`
    : ''
  const body = list.length
    ? deskHead + list.map(r => (desk ? deskRowHtml(r, showAcct) : rowHtml(r, showAcct))).join('')
    : `<div style="padding:4px ${pad} 12px;font-size:12px;line-height:1.5;color:var(--muted)">Track tokens you hold outside Hyperliquid — a HyperEVM token in your wallet, NEST locked on Nest Exchange. Enter the amount; the price is looked up live. It is never added to your account equity.</div>`

  const inBal = countInBalance()
  const footer = list.length && spotUsd != null
    ? `<div style="display:flex;justify-content:space-between;padding:10px ${pad} 4px;font-size:12px;${desk ? '' : 'border-top:1px solid var(--border);'}margin-top:4px">
        <span style="color:var(--muted)">Spot incl. off-exchange${tot.complete ? '' : ' (priced only)'}</span>
        <b style="font-family:var(--font-mono)">${ctx.prv('$' + fmtUSD(spotUsd + tot.usd))}</b>
      </div>
      <div data-offex-inbal style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px ${pad} 12px;cursor:pointer" onclick="window.__offexToggleInBal()">
        <span style="font-size:12px;line-height:1.4">
          <span style="font-weight:700">Count in balance</span>
          <span style="display:block;color:var(--muted);font-size:11px">Adds off-exchange value to your headline balance only — health, PnL and ROE stay Hyperliquid-only.</span>
        </span>
        <span role="switch" aria-checked="${inBal}"
          style="flex-shrink:0;position:relative;width:38px;height:22px;border-radius:11px;background:${inBal ? 'var(--accent)' : 'var(--panel-3)'};border:1px solid ${inBal ? 'var(--accent)' : 'var(--border2)'};transition:background .15s">
          <span style="position:absolute;top:2px;left:${inBal ? '18px' : '2px'};width:16px;height:16px;border-radius:50%;background:${inBal ? '#000' : 'var(--fg-2)'};transition:left .15s"></span>
        </span>
      </div>`
    : ''

  return `<div data-offex>${header}${body}${footer}</div>`
}

// ─── THE SHEET ────────────────────────────────────────────────────────────────

let _sheet = null   // { acct, token (when editing) }

function sheetEl() {
  let ov = document.getElementById('offexSheet')
  if (ov) return ov
  ov = document.createElement('div')
  ov.id = 'offexSheet'
  ov.style.cssText = 'position:fixed;inset:0;z-index:100050;display:none;align-items:flex-end;justify-content:center;background:rgba(0,0,0,.6)'
  ov.addEventListener('click', e => { if (e.target === ov) closeSheet() })
  document.body.appendChild(ov)
  return ov
}

export function closeSheet() {
  const ov = document.getElementById('offexSheet')
  if (ov) ov.style.display = 'none'
  _sheet = null
}

const field = (label, inner, hint = '') => `<label style="display:block;margin-bottom:12px">
  <div style="font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:5px">${label}</div>
  ${inner}${hint ? `<div style="font-size:11px;color:var(--muted);margin-top:4px">${hint}</div>` : ''}</label>`
/** What the token box wants, which depends entirely on the network. */
const TOKEN_HINT = (net) => normNet(net) === HL_NET
  ? 'A token on Hyperliquid\'s spot book, by symbol — HYPE has no contract address to paste. Priced from the mid the app already has.'
  : 'A token on HyperEVM, Ethereum, Base, Arbitrum or BNB Chain. The network is found for you.'
const inputCss = 'width:100%;box-sizing:border-box;background:var(--panel-2);border:1px solid var(--border2);border-radius:10px;padding:10px 11px;color:var(--fg);font-size:14px;outline:none'

/** Open the sheet to add (no token) or edit (token given) a holding. */
export function openSheet(acct = null, token = null, net = DEFAULT_NET) {
  const accts = ctx.accounts() ?? []
  if (!accts.length) return
  const owner = normAddr(acct) ?? accts[0].addr
  const existing = token ? loadHoldings(ctx.store(), owner).find(e => e.token === normToken(net, token) && e.net === normNet(net)) : null
  _sheet = { acct: owner, token: existing?.token ?? null, net: existing?.net ?? DEFAULT_NET }

  const ov = sheetEl()
  // Solid, not --panel alone: with a photo backdrop --panel is 55% alpha, and the Spot rows
  // showed straight through the form. --bg stays opaque under every theme, and the panel tint
  // is layered over it so the sheet still reads as a raised surface.
  ov.innerHTML = `<div role="dialog" aria-label="Off-exchange token" style="width:min(520px,100%);max-height:90vh;overflow-y:auto;background:linear-gradient(var(--panel),var(--panel)),var(--bg);border:1px solid var(--border);border-radius:18px 18px 0 0;padding:20px 18px calc(20px + env(safe-area-inset-bottom))">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:17px;font-weight:800">${existing ? 'Edit' : 'Add'} off-exchange token</div>
      <button onclick="window.__offexClose()" aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer">&times;</button>
    </div>
    ${field(`<span id="offexTokenLabel">${_sheet.net === HL_NET ? 'Token symbol' : 'Contract address'}</span>`,
      `<input id="offexToken" style="${inputCss};font-family:var(--font-mono);font-size:12.5px" placeholder="${_sheet.net === HL_NET ? 'HYPE' : '0x…'}" value="${esc(existing?.token ?? '')}" ${existing ? 'readonly' : ''} spellcheck="false" autocomplete="off">`,
      `<span id="offexTokenHint">${TOKEN_HINT(_sheet.net)}</span>`)}
    <div id="offexLookup" style="font-size:12.5px;margin:-4px 0 12px;min-height:18px"></div>
    ${field('Network', `<select id="offexNet" onchange="window.__offexNetChange()" style="${inputCss}">${Object.entries(NETWORKS).map(([k, n]) => `<option value="${k}" ${k === _sheet.net ? 'selected' : ''}>${esc(n.label)}</option>`).join('')}</select>`)}
    ${accts.length > 1 ? field('Account', `<select id="offexAcct" style="${inputCss}">${accts.map(a => `<option value="${esc(a.addr)}" ${a.addr === owner ? 'selected' : ''}>${esc(a.label || short(a.addr))}</option>`).join('')}</select>`) : ''}
    ${field('Amount you hold', `<input id="offexAmount" type="number" inputmode="decimal" step="any" min="0" style="${inputCss}" value="${existing ? esc(String(existing.amount)) : ''}" placeholder="0">`,
      'Locked or staked tokens too — a lock does not show up as a wallet balance, so it is typed here.')}
    ${field('What you paid, in USD (optional)', `<input id="offexCost" type="number" inputmode="decimal" step="any" min="0" style="${inputCss}" value="${existing?.cost != null ? esc(String(existing.cost)) : ''}" placeholder="leave blank if unknown">`,
      'Used for profit and ROI. Blank shows no PnL rather than a made-up one.')}
    ${field('Note (optional)', `<input id="offexNote" maxlength="60" style="${inputCss}" value="${esc(existing?.note ?? '')}" placeholder="e.g. locked on Nest">`)}
    <div id="offexStatus" style="font-size:12px;min-height:16px;margin-bottom:8px"></div>
    <div style="display:flex;gap:8px">
      ${existing ? `<button onclick="window.__offexRemove()" style="flex:0 0 auto;padding:12px 16px;border-radius:11px;border:1px solid var(--red);background:transparent;color:var(--red);font-weight:700;cursor:pointer">Remove</button>` : ''}
      <button id="offexSave" onclick="window.__offexSave()" style="flex:1;padding:12px;border-radius:11px;border:none;background:var(--accent);color:#000;font-weight:800;font-size:14px;cursor:pointer">${existing ? 'Save' : 'Add token'}</button>
    </div>
  </div>`
  ov.style.display = 'flex'

  const tokEl = document.getElementById('offexToken')
  // Picking a network by hand asks that network only — no second-guessing the choice.
  const netEl = document.getElementById('offexNet')
  if (netEl) netEl.onchange = () => lookup(tokEl.value, { auto: false })
  if (!existing) {
    tokEl.oninput = () => lookup(tokEl.value)
    setTimeout(() => tokEl.focus(), 50)
  } else {
    // Auto only when it has no price where it is saved: a holding added before networks
    // existed was filed as HyperEVM whatever chain it is on, and this finds the right one —
    // the save then moves it. A priced holding is on the right network and is left alone.
    lookup(existing.token, { auto: !quoteFor(existing.token, existing.net) })
  }
}

let _lookupSeq = 0
/** Resolve a pasted address to a name and a price before it is saved, so a typo shows now. */
async function lookup(raw, { auto = true } = {}) {
  const out = document.getElementById('offexLookup')
  if (!out) return
  if (!raw.trim()) { out.innerHTML = ''; return }
  const netEl0 = document.getElementById('offexNet')
  // Hyperliquid names its tokens; every other network addresses them. HYPE has no contract to
  // paste — its spotMeta record carries evmContract:null — so on this network the box takes a
  // symbol and the price is the mid the app already holds.
  if (normNet(netEl0?.value) === HL_NET) {
    const t = normToken(HL_NET, raw)
    if (!t) { out.innerHTML = '<span style="color:var(--red)">That is not a token symbol (e.g. HYPE).</span>'; return }
    const seq0 = ++_lookupSeq
    await refreshPrices({ force: true, extra: [quoteKey(HL_NET, t)] })
    if (seq0 !== _lookupSeq) return
    const qh = quoteFor(t, HL_NET)
    out.innerHTML = qh && qh.price != null
      ? `<b>${esc(t)}</b> <span style="color:var(--muted)">on Hyperliquid</span> · $${fmtPrice(qh.price)}`
      : `<span style="color:#f59e0b">Hyperliquid is not quoting ${esc(t)}. Check the symbol — it is the one on the spot book.</span>`
    return
  }
  const a = normAddr(raw)
  if (!a) { out.innerHTML = '<span style="color:var(--red)">That is not a contract address (0x followed by 40 characters).</span>'; return }
  const seq = ++_lookupSeq
  out.innerHTML = '<span style="color:var(--muted)">Looking it up…</span>'
  const netEl = document.getElementById('offexNet')
  let net = normNet(netEl?.value)
  await refreshPrices({ force: true, extra: [quoteKey(net, a)] })
  if (seq !== _lookupSeq) return          // a newer paste has taken over
  let q = quoteFor(a, net), moved = false
  // Nothing on the selected network: ask which supported network the address trades on. Every
  // EVM chain uses the same 0x address shape, so a pasted address says nothing about which one
  // it belongs to — DIME is an Ethereum token and HyperEVM had never heard of it.
  if (!q && auto) {
    out.innerHTML = `<span style="color:var(--muted)">Not on ${esc(NETWORKS[net].label)} — checking other networks…</span>`
    const f = await fetch('/offexprice?find=' + a).then(r => (r.ok ? r.json() : null)).catch(() => null)
    if (seq !== _lookupSeq) return
    if (f?.net && normNet(f.net) !== net) {
      net = normNet(f.net)
      if (netEl) netEl.value = net
      await refreshPrices({ force: true, extra: [quoteKey(net, a)] })
      if (seq !== _lookupSeq) return
      q = quoteFor(a, net); moved = !!q
    }
  }
  out.innerHTML = q
    ? `<b>${esc(q.symbol || '')}</b> <span style="color:var(--muted)">${esc(q.name || '')}</span> · ${q.price != null ? '$' + fmtPrice(q.price) : 'no price'}${q.thin ? ' <span style="color:#f59e0b">· thin market</span>' : ''}${moved ? ` <span style="color:var(--muted)">· found on ${esc(NETWORKS[net].label)}</span>` : ''}`
    : `<span style="color:#f59e0b">No ${auto ? 'market on any supported network' : esc(NETWORKS[net].label) + ' market'} for this address. You can still add it — it will show without a price until one exists.</span>`
}

function save() {
  const st = document.getElementById('offexStatus')
  const say = (m) => { if (st) { st.textContent = m; st.style.color = 'var(--red)' } }
  if (!_sheet) return
  // Net FIRST: it decides whether the box holds an address or a symbol. Reading the token as
  // an address before knowing that rejected every Hyperliquid-listed token out of hand.
  const net = normNet(document.getElementById('offexNet')?.value)
  const token = normToken(net, document.getElementById('offexToken')?.value ?? '')
  if (!token) return say(net === HL_NET ? 'Enter the token\'s symbol, e.g. HYPE.' : 'Enter the token\'s contract address.')
  const amount = parseFloat(document.getElementById('offexAmount')?.value)
  if (!(amount > 0)) return say('Enter how much you hold.')
  const acctSel = document.getElementById('offexAcct')
  const acct = normAddr(acctSel ? acctSel.value : _sheet.acct)
  if (!acct) return say('Pick an account.')
  const q = quoteFor(token, net)
  const store = ctx.store()
  // Editing may MOVE the holding to another account, or correct its network. `from`/`fromNet`
  // is where it lives now; it is read from there so the note, cost and date travel with it.
  const from = _sheet.token ? _sheet.acct : acct
  const fromNet = _sheet.token ? _sheet.net : net
  const prev = loadHoldings(store, from).find(e => e.token === token && e.net === fromNet)
    ?? loadHoldings(store, acct).find(e => e.token === token && e.net === net)
  const entry = {
    token, net, amount,
    cost: document.getElementById('offexCost')?.value ?? '',
    note: document.getElementById('offexNote')?.value ?? '',
    // The name and icon are remembered, so the row reads properly even while the price
    // service is down — a bare address is not something anyone recognises at a glance.
    symbol: q?.symbol ?? prev?.symbol ?? null,
    name:   q?.name ?? prev?.name ?? null,
    icon:   q?.icon ?? prev?.icon ?? null,
    added:  prev?.added ?? Date.now(),
  }
  try {
    // Write the new home first, then take it out of the old one — so a failure part-way
    // leaves the holding in two accounts for a moment rather than in none.
    saveHoldings(store, acct, upsertHolding(loadHoldings(store, acct), entry))
    if (from !== acct || fromNet !== net) saveHoldings(store, from, removeHolding(loadHoldings(store, from), token, fromNet))
  } catch (e) { return say(e.message) }
  closeSheet()
  try { ctx.rerender() } catch {}
}

function remove() {
  if (!_sheet?.token) return
  const store = ctx.store()
  try { saveHoldings(store, _sheet.acct, removeHolding(loadHoldings(store, _sheet.acct), _sheet.token, _sheet.net)) } catch {}
  closeSheet()
  try { ctx.rerender() } catch {}
}

if (typeof window !== 'undefined') {
  window.__offexNetChange = () => {
    // The box means a different thing on each side of this switch, so relabel it before the
    // lookup runs — otherwise it reports "not a contract address" at someone typing a symbol.
    const n   = normNet(document.getElementById('offexNet')?.value)
    const lab = document.getElementById('offexTokenLabel')
    const hnt = document.getElementById('offexTokenHint')
    const inp = document.getElementById('offexToken')
    if (lab) lab.textContent = n === HL_NET ? 'Token symbol' : 'Contract address'
    if (hnt) hnt.innerHTML   = TOKEN_HINT(n)
    if (inp) inp.placeholder = n === HL_NET ? 'HYPE' : '0x…'
    if (inp) lookup(inp.value)
  }
  window.__offexAdd    = () => openSheet()
  window.__offexEdit   = (acct, token, net) => openSheet(acct, token, net)
  window.__offexClose  = () => closeSheet()
  window.__offexSave   = () => save()
  window.__offexRemove = () => remove()
  window.__offexToggleInBal = () => setCountInBalance(!countInBalance())
  // render.js builds the desktop headline and cannot import this module's state, so it reads
  // the figure through a bridge, as it already does for the spot and outcome bodies.
  window.__offexBalanceAdd  = () => balanceAdd()
  window.__offexCount       = () => count()
  window.__offexToggle = (id) => {
    _open.has(id) ? _open.delete(id) : _open.add(id)
    try { ctx.rerender() } catch {}
  }
}

export { isTokenAddr }
