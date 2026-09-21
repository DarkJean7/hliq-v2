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
         normAddr, isTokenAddr } from './offex.js'
import { fmtUSD, fmtPrice, fmtSize, esc } from './format.js'

let ctx = {
  /** The real accounts this view covers: [{ addr, label }]. Empty in paper mode. */
  accounts: () => [],
  /** The privacy mask — '•••' when the eye is shut. */
  prv: (s) => s,
  /** Repaint whatever shows the group. */
  rerender: () => {},
  store: () => (typeof localStorage !== 'undefined' ? localStorage : null),
}
export function initOffex(overrides = {}) { ctx = { ...ctx, ...overrides } }

// ─── PRICES ───────────────────────────────────────────────────────────────────

/** addr → parsed quote. Missing means "not priced", never $0. */
const _quotes = {}
let _lastFetch = 0
let _inflight = null

/**
 * Ask the server for every token in view, at most once a minute.
 *
 * Only repaints when a price actually changed, so a poll that brings back the same numbers
 * does not rebuild the Spot tab under someone's thumb.
 */
export function refreshPrices({ force = false, extra = [] } = {}) {
  const want = [...new Set([...rows().map(r => r.entry.token), ...extra.map(normAddr).filter(Boolean)])]
  if (!want.length) return Promise.resolve(false)
  if (_inflight) return _inflight
  if (!force && Date.now() - _lastFetch < 60_000 && want.every(a => a in _quotes)) return Promise.resolve(false)
  _lastFetch = Date.now()
  _inflight = (async () => {
    try {
      const r = await fetch('/offexprice?a=' + want.join(','))
      if (!r.ok) return false
      const { prices = {} } = await r.json()
      let changed = false
      for (const a of want) {
        const q = prices[a] ?? null
        if (JSON.stringify(_quotes[a] ?? null) !== JSON.stringify(q)) changed = true
        _quotes[a] = q
      }
      if (changed) { try { ctx.rerender() } catch {} }
      return changed
    } catch { return false }
    finally { _inflight = null }
  })()
  return _inflight
}

export const quoteFor = (token) => _quotes[normAddr(token)] ?? null

// ─── WHAT IS IN VIEW ──────────────────────────────────────────────────────────

/** Every off-exchange holding the current view covers, each with its account and value. */
export function rows() {
  const store = ctx.store()
  const out = []
  for (const a of (ctx.accounts() ?? [])) {
    for (const entry of loadHoldings(store, a.addr)) {
      out.push({ acct: a.addr, label: a.label ?? null, entry, value: holdingValue(entry, quoteFor(entry.token)) })
    }
  }
  return out.sort((x, y) => (y.value.usd ?? -1) - (x.value.usd ?? -1))
}

/** The group's total. `complete: false` when any holding has no price — the sum is a floor. */
export function total() {
  const r = rows()
  const quotes = Object.fromEntries(r.map(x => [x.entry.token, quoteFor(x.entry.token)]))
  return holdingsTotal(r.map(x => x.entry), quotes)
}

// ─── RENDER ───────────────────────────────────────────────────────────────────

const _open = new Set()   // expanded rows, by acct|token

function icon(entry) {
  const letter = esc((entry.symbol || '?').slice(0, 1).toUpperCase())
  const fallback = `<span style="display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-weight:800;font-size:14px;color:var(--fg-2)">${letter}</span>`
  if (!entry.icon) return `<div class="mob-v-row-icon" style="padding:0;overflow:hidden;background:var(--panel-2)">${fallback}</div>`
  // A dead icon URL falls back to the letter rather than a broken-image glyph.
  return `<div class="mob-v-row-icon" style="padding:0;overflow:hidden;background:var(--panel-2)">
    <img src="${esc(entry.icon)}" alt="" style="width:100%;height:100%;object-fit:cover"
      onerror="this.replaceWith(Object.assign(document.createElement('span'),{textContent:'${letter}',style:'display:flex;width:100%;height:100%;align-items:center;justify-content:center;font-weight:800;font-size:14px'}))"></div>`
}

const short = (a) => a.slice(0, 6) + '…' + a.slice(-4)

function rowHtml(r, showAcct) {
  const { entry: e, value: v } = r
  const id  = r.acct + '|' + e.token
  const xp  = _open.has(id)
  const sym = esc(e.symbol || short(e.token))
  const pnlLine = v.pnl != null
    ? `<div class="mob-v-row-pct" style="color:${v.pnl >= 0 ? 'var(--green)' : 'var(--red)'};white-space:nowrap">${ctx.prv(`${v.pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(v.pnl))} · ${v.roi >= 0 ? '+' : ''}${v.roi.toFixed(2)}%`)}</div>`
    : ''
  const detail = [
    ['Contract', `<span class="notranslate" style="font-family:var(--font-mono)">${esc(short(e.token))}</span>`],
    ...(showAcct ? [['Account', esc(r.label || short(r.acct))]] : []),
    ['Amount', ctx.prv(fmtSize(e.amount)) + ' ' + sym],
    ['Price', v.price != null ? '$' + fmtPrice(v.price) : 'No price yet'],
    ['Value', ctx.prv(v.usd != null ? '$' + fmtUSD(v.usd, 2) : '—')],
    ...(e.cost != null ? [
      ['Cost', ctx.prv('$' + fmtUSD(e.cost, 2))],
      ['Profit', v.pnl != null ? ctx.prv(`${v.pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(v.pnl))}`) : '—'],
    ] : []),
    ...(e.note ? [['Note', esc(e.note)]] : []),
  ].map(([k, val]) => `<div style="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font-size:12px">
      <span style="color:var(--muted)">${k}</span><span style="text-align:right">${val}</span></div>`).join('')

  return `<div>
    <div class="mob-v-row" style="cursor:pointer" onclick="window.__offexToggle('${esc(id)}')">
      ${icon(e)}
      <div class="mob-v-row-info">
        <div class="mob-v-row-name">${sym}</div>
        <div class="mob-v-row-sub">${ctx.prv(fmtSize(e.amount))} ${sym}${showAcct && r.label ? ` · <span class="notranslate" style="color:var(--accent)">${esc(r.label)}</span>` : ''}${e.note ? ` · ${esc(e.note)}` : ''}</div>
      </div>
      <div style="flex-shrink:0;width:74px;display:flex;flex-direction:column">
        <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:0.4px;line-height:1.2;text-align:center">Price</div>
        <div style="font-size:13px;font-weight:500;line-height:1.3;margin-top:2px;white-space:nowrap;text-align:center;overflow:hidden;text-overflow:ellipsis">${v.price != null ? '$' + fmtPrice(v.price) : '—'}</div>
      </div>
      <div class="mob-v-row-right" style="width:104px;flex-shrink:0;flex-grow:0">
        <div class="mob-v-row-val">${ctx.prv(v.usd != null ? '$' + fmtUSD(v.usd) : '—')}</div>
        ${pnlLine}
      </div>
    </div>
    <div style="display:${xp ? '' : 'none'};padding:4px 16px 12px;background:var(--panel-2)">
      ${v.thin ? `<div style="font-size:11px;color:#f59e0b;padding:6px 0 4px">Thin market — this price comes from a pool with little liquidity and may not be what you could sell for.</div>` : ''}
      ${detail}
      <button onclick="event.stopPropagation();window.__offexEdit('${esc(r.acct)}','${esc(e.token)}')"
        style="width:100%;margin-top:8px;padding:9px;border-radius:9px;border:1px solid var(--border2);background:var(--panel-3);color:var(--fg);font-size:12px;font-weight:700;cursor:pointer">Edit</button>
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
export function sectionHtml({ spotUsd = null } = {}) {
  const accts = ctx.accounts() ?? []
  if (!accts.length) return ''            // paper, or no real account in view
  const list = rows()
  const tot  = total()
  const showAcct = accts.length > 1
  if (list.length) refreshPrices()        // at most once a minute; repaints only on change

  const header = `<div style="display:flex;align-items:center;justify-content:space-between;padding:16px 16px 6px">
    <div>
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:var(--muted);text-transform:uppercase">Off-exchange</div>
      ${list.length ? `<div style="font-size:12px;color:var(--fg-2);margin-top:2px">${ctx.prv('$' + fmtUSD(tot.usd))}${tot.complete ? '' : ` <span style="color:var(--muted)">· ${tot.count - tot.priced} unpriced</span>`}</div>` : ''}
    </div>
    <button onclick="window.__offexAdd()" style="border:1px solid var(--accent);background:color-mix(in oklch,var(--accent) 12%,transparent);color:var(--accent);border-radius:9px;padding:7px 12px;font-size:12px;font-weight:700;cursor:pointer">+ Add token</button>
  </div>`

  const body = list.length
    ? list.map(r => rowHtml(r, showAcct)).join('')
    : `<div style="padding:4px 16px 12px;font-size:12px;line-height:1.5;color:var(--muted)">Track tokens you hold outside Hyperliquid — a HyperEVM token in your wallet, NEST locked on Nest Exchange. Enter the amount; the price is looked up live. It is never added to your account equity.</div>`

  const footer = list.length && spotUsd != null
    ? `<div style="display:flex;justify-content:space-between;padding:10px 16px 4px;font-size:12px;border-top:1px solid var(--border);margin-top:4px">
        <span style="color:var(--muted)">Spot incl. off-exchange${tot.complete ? '' : ' (priced only)'}</span>
        <b style="font-family:var(--font-mono)">${ctx.prv('$' + fmtUSD(spotUsd + tot.usd))}</b>
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
const inputCss = 'width:100%;box-sizing:border-box;background:var(--panel-2);border:1px solid var(--border2);border-radius:10px;padding:10px 11px;color:var(--fg);font-size:14px;outline:none'

/** Open the sheet to add (no token) or edit (token given) a holding. */
export function openSheet(acct = null, token = null) {
  const accts = ctx.accounts() ?? []
  if (!accts.length) return
  const owner = normAddr(acct) ?? accts[0].addr
  const existing = token ? loadHoldings(ctx.store(), owner).find(e => e.token === normAddr(token)) : null
  _sheet = { acct: owner, token: existing?.token ?? null }

  const ov = sheetEl()
  ov.innerHTML = `<div role="dialog" aria-label="Off-exchange token" style="width:min(520px,100%);max-height:90vh;overflow-y:auto;background:var(--panel);border:1px solid var(--border);border-radius:18px 18px 0 0;padding:20px 18px calc(20px + env(safe-area-inset-bottom))">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <div style="font-size:17px;font-weight:800">${existing ? 'Edit' : 'Add'} off-exchange token</div>
      <button onclick="window.__offexClose()" aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:22px;cursor:pointer">&times;</button>
    </div>
    ${field('Contract address (HyperEVM)',
      `<input id="offexToken" style="${inputCss};font-family:var(--font-mono);font-size:12.5px" placeholder="0x…" value="${esc(existing?.token ?? '')}" ${existing ? 'readonly' : ''} spellcheck="false" autocomplete="off">`,
      'NEST, a token in your HyperEVM wallet, anything with a contract address.')}
    <div id="offexLookup" style="font-size:12.5px;margin:-4px 0 12px;min-height:18px"></div>
    ${accts.length > 1 ? field('Account', `<select id="offexAcct" style="${inputCss}" ${existing ? 'disabled' : ''}>${accts.map(a => `<option value="${esc(a.addr)}" ${a.addr === owner ? 'selected' : ''}>${esc(a.label || short(a.addr))}</option>`).join('')}</select>`) : ''}
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
  if (!existing) {
    tokEl.oninput = () => lookup(tokEl.value)
    setTimeout(() => tokEl.focus(), 50)
  } else {
    lookup(existing.token)
  }
}

let _lookupSeq = 0
/** Resolve a pasted address to a name and a price before it is saved, so a typo shows now. */
async function lookup(raw) {
  const out = document.getElementById('offexLookup')
  if (!out) return
  const a = normAddr(raw)
  if (!raw.trim()) { out.innerHTML = ''; return }
  if (!a) { out.innerHTML = '<span style="color:var(--red)">That is not a contract address (0x followed by 40 characters).</span>'; return }
  const seq = ++_lookupSeq
  out.innerHTML = '<span style="color:var(--muted)">Looking it up…</span>'
  await refreshPrices({ force: true, extra: [a] })
  if (seq !== _lookupSeq) return          // a newer paste has taken over
  const q = quoteFor(a)
  out.innerHTML = q
    ? `<b>${esc(q.symbol || '')}</b> <span style="color:var(--muted)">${esc(q.name || '')}</span> · ${q.price != null ? '$' + fmtPrice(q.price) : 'no price'}${q.thin ? ' <span style="color:#f59e0b">· thin market</span>' : ''}`
    : '<span style="color:#f59e0b">No HyperEVM market found for this address. You can still add it — it will show without a price until one exists.</span>'
}

function save() {
  const st = document.getElementById('offexStatus')
  const say = (m) => { if (st) { st.textContent = m; st.style.color = 'var(--red)' } }
  if (!_sheet) return
  const token = normAddr(document.getElementById('offexToken')?.value ?? '')
  if (!token) return say('Enter the token\'s contract address.')
  const amount = parseFloat(document.getElementById('offexAmount')?.value)
  if (!(amount > 0)) return say('Enter how much you hold.')
  const acctSel = document.getElementById('offexAcct')
  const acct = normAddr(acctSel && !acctSel.disabled ? acctSel.value : _sheet.acct)
  if (!acct) return say('Pick an account.')
  const q = quoteFor(token)
  const store = ctx.store()
  const prev = loadHoldings(store, acct).find(e => e.token === token)
  const entry = {
    token, amount,
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
    saveHoldings(store, acct, upsertHolding(loadHoldings(store, acct), entry))
  } catch (e) { return say(e.message) }
  closeSheet()
  try { ctx.rerender() } catch {}
}

function remove() {
  if (!_sheet?.token) return
  const store = ctx.store()
  try { saveHoldings(store, _sheet.acct, removeHolding(loadHoldings(store, _sheet.acct), _sheet.token)) } catch {}
  closeSheet()
  try { ctx.rerender() } catch {}
}

if (typeof window !== 'undefined') {
  window.__offexAdd    = () => openSheet()
  window.__offexEdit   = (acct, token) => openSheet(acct, token)
  window.__offexClose  = () => closeSheet()
  window.__offexSave   = () => save()
  window.__offexRemove = () => remove()
  window.__offexToggle = (id) => {
    _open.has(id) ? _open.delete(id) : _open.add(id)
    try { ctx.rerender() } catch {}
  }
}

export { isTokenAddr }
