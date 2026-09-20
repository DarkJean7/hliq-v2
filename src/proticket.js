/**
 * INSOLVENT TERMINAL — the Pro order ticket
 *
 * The "Pro" button next to Market / Limit / Stop, the menu it opens, the extra fields each
 * Pro type needs, and the code that actually sends them. Hyperliquid puts Chase, Scale, the
 * four trigger types, Trailing Stop and TWAP behind one control; this is that control.
 *
 * ── why the form lives in a variable and not in the DOM ──
 *
 * There are two order tickets in this app — the desktop one in index.html and the mobile one
 * rendered by main.js — and BOTH are in the document at once; the hidden shell is display:
 * none, not absent. Fields keyed by element id would therefore exist twice, and
 * getElementById would hand back whichever came first in the document, which is the shell
 * you are not looking at. So `_form` is the source of truth, inputs write into it, and the
 * markup is a projection of it. The same renderer paints both shells and there is no second
 * copy to forget to fix.
 *
 * ── what needs to stay alive ──
 *
 * Scale, TWAP and the four trigger types are handed to the exchange and are then none of our
 * business. Chase is not: an order that re-prices itself needs something doing the
 * re-pricing, and that something is this tab — which is also true of Hyperliquid's own chase,
 * and why they cap it at five at a time. The ticket says so on the button rather than leaving
 * someone to discover it by closing a laptop.
 *
 * ── what this module is not allowed to see ──
 *
 * `state`. Everything about the current account, coin, size and leverage arrives through the
 * context object injected by main.js, for the reason written at length in CLAUDE.md: in the
 * combined view `state.addr` is the string '__all_accounts__', and per-account work that
 * reaches for it builds storage keys and signs orders for an account that does not exist.
 * A module that cannot read `state` cannot make that mistake.
 */
import { ORDER_TYPES, byId, TIFS, TWAP, SCALE, CHASE, PRO_IDS,
         scaleLadder, ladderAvgPx, validate, describe, tickSize,
         chaseTargetPx, shouldRechase, chaseExceeded } from './protypes.js'
import { openLearn } from './prolearn.js'
import { bestBidAsk } from './api.js'
import { placeScaleOrders, placeStopOrder, placeTwapOrder, placeLimitOrder,
         cancelOrder, parseOrderResult, szDecimalsFor } from './trading.js'

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
))
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null }

/** Injected by main.js. Every one of these is a question only the shell can answer. */
let ctx = {
  coin:        () => null,
  mark:        () => null,
  isBuy:       () => true,
  sizeCoin:    () => 0,
  leverage:    () => 5,
  isolated:    () => false,
  acct:        () => null,
  hasPosition: () => false,
  isSpot:      () => false,
  canTrade:    () => false,
  afterAction: () => {},
  openTrail:   () => {},
  refreshTabs: () => {},
}

export function initPro(overrides = {}) { ctx = { ...ctx, ...overrides } }

/** Which Pro type is selected, or null when the plain Market/Limit/Stop tabs are in charge. */
let _type = null
/** Everything the Pro fields currently say. The DOM paints from this, never the reverse. */
let _form = {}
/** Containers that have asked to show the Pro fields — one per shell. */
const _mounts = new Set()

export const proType   = () => _type
export const proActive = () => _type != null

/**
 * Pick a Pro type, seeding its fields from the market so the form opens usable.
 *
 * Seeded, not blank: a Scale ticket that opens with two empty price boxes is a ticket
 * nobody fills in, and a range centred on the mark is both a sensible default and a visible
 * demonstration of what the two numbers mean.
 */
export function selectPro(id, { keep = true } = {}) {
  const t = byId(id)
  if (!t || !PRO_IDS.includes(id)) return
  const mark = num(ctx.mark())
  // `keep: false` is the market changing underneath the form. Carrying a trigger price over
  // from BTC to SOL would leave a number five figures away from the book sitting in a box
  // that looks filled in, which is worse than an empty one.
  const prev = keep ? _form : {}
  _form = {
    tif:           'Gtc',
    limitPx:       mark ? round5(mark) : '',
    triggerPx:     '',
    scaleStartPx:  mark ? round5(mark * 0.995) : '',
    scaleEndPx:    mark ? round5(mark * 0.97)  : '',
    scaleCount:    5,
    scaleSkew:     1,
    twapMinutes:   30,
    twapRandomize: false,
    chaseMaxTicks: '',
    reduceOnly:    false,
    // Keep anything the user already typed for a field the new type also has — switching
    // Stop Market → Stop Limit should not wipe the trigger price you just entered.
    ...pick(prev, t.fields),
  }
  _type = id
  paintAll()
  ctx.refreshTabs()
}

/** Back to the plain tabs. Called by main.js whenever Market/Limit/Stop is pressed. */
export function clearPro() {
  if (_type == null) return
  _type = null
  paintAll()
  ctx.refreshTabs()
}

const pick = (o, keys) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => keys.includes(k)))
const round5 = (n) => parseFloat(Number(n).toPrecision(5))

// ─── THE MENU ─────────────────────────────────────────────────────────────────

/**
 * The dropdown behind the Pro button: every advanced type, then Learn More.
 *
 * Anchored to the button and closed by the next click anywhere else — the same contract as
 * the coin dropdown, so it behaves the way the rest of the app's menus do.
 */
export function openProMenu(anchor) {
  document.getElementById('proMenu')?.remove()
  if (!anchor) return

  const el = document.createElement('div')
  el.id = 'proMenu'
  const r = anchor.getBoundingClientRect()
  el.style.cssText = `position:fixed;z-index:99990;min-width:184px;padding:6px;border-radius:12px;
    background:var(--panel-2);border:1px solid var(--border2);box-shadow:0 18px 44px rgba(0,0,0,.5);
    left:${Math.max(8, Math.min(r.left, window.innerWidth - 200))}px;`
  // Opens upward when there is no room below, which on a phone there usually is not.
  const below = window.innerHeight - r.bottom
  el.style[below > 330 ? 'top' : 'bottom'] = below > 330 ? `${r.bottom + 6}px` : `${window.innerHeight - r.top + 6}px`

  el.innerHTML = ORDER_TYPES.filter(t => PRO_IDS.includes(t.id)).map(t => `
    <div data-pt="${t.id}" role="button" tabindex="0"
      style="padding:9px 11px;border-radius:8px;font-size:13.5px;cursor:pointer;white-space:nowrap;
             color:${t.id === _type ? 'var(--accent)' : 'var(--fg-2)'};font-weight:${t.id === _type ? '700' : '500'}">${esc(t.label)}</div>`).join('')
    + `<div style="height:1px;background:var(--border);margin:6px 4px"></div>
       <div data-pt="__learn" role="button" tabindex="0"
         style="display:flex;align-items:center;gap:7px;padding:9px 11px;border-radius:8px;font-size:13.5px;cursor:pointer;color:var(--muted)">
         Learn More
         <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="7.8" r=".6" fill="currentColor"/></svg>
       </div>`

  document.body.appendChild(el)
  el.querySelectorAll('[data-pt]').forEach(row => {
    row.onclick = () => {
      const id = row.dataset.pt
      el.remove()
      if (id === '__learn') openLearn({ type: _type ?? 'market', isLong: ctx.isBuy(), onPick: id2 => { if (PRO_IDS.includes(id2)) selectPro(id2) } })
      else selectPro(id)
    }
    row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click() } }
  })

  // The click that opened the menu is still propagating; wait a frame before arming the
  // close-on-outside-click handler or the menu shuts itself the moment it appears.
  setTimeout(() => {
    const off = (e) => { if (!el.contains(e.target)) { el.remove(); document.removeEventListener('click', off) } }
    document.addEventListener('click', off)
  }, 0)
}

/** Opens the explainer from anywhere — the glossary, a help link, the menu. */
export function openProLearn(type = null) {
  openLearn({ type: type ?? _type ?? 'market', isLong: ctx.isBuy(), onPick: id => { if (PRO_IDS.includes(id)) selectPro(id) } })
}

// ─── THE FIELDS ───────────────────────────────────────────────────────────────

/**
 * Attach the Pro fields to a container. Both shells call this with their own element; the
 * renderer is shared so a fix cannot land in one and miss the other.
 */
export function mountProFields(el) {
  if (!el) return
  // The mobile ticket rebuilds its whole form with innerHTML, so the container that was
  // mounted last time is now a detached node. Keeping it would mean painting into a document
  // fragment nobody can see while the live one stayed empty — drop anything that has fallen
  // out of the document every time a new one arrives.
  for (const m of _mounts) if (!m.isConnected) _mounts.delete(m)
  _mounts.add(el)
  paint(el)
}

function paintAll() {
  for (const m of _mounts) if (!m.isConnected) _mounts.delete(m)
  _mounts.forEach(paint)
}

const inputCss = `width:100%;background:var(--panel-2);border:1px solid var(--border2);border-radius:10px;
  padding:9px 11px;color:var(--fg);font-size:13px;font-family:var(--font-mono);outline:none`
const labelCss = `font-size:10.5px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:5px`

const field = (label, inner, hint = '') => `
  <div style="display:flex;flex-direction:column;margin-bottom:10px">
    <div style="${labelCss}">${esc(label)}</div>
    ${inner}
    ${hint ? `<div style="margin-top:4px;font-size:11px;color:var(--muted)">${esc(hint)}</div>` : ''}
  </div>`

const numInput = (key, placeholder = '0.00', step = 'any') =>
  `<input data-pf="${key}" type="number" step="${step}" inputmode="decimal" placeholder="${esc(placeholder)}"
          value="${_form[key] ?? ''}" style="${inputCss}">`

function paint(el) {
  if (!el) return
  if (_type == null) { el.innerHTML = ''; el.style.display = 'none'; return }
  el.style.display = ''
  const t = byId(_type)
  const mark = num(ctx.mark())
  const f = readForm()
  const errs = validate(_type, f)

  let body = ''

  if (t.fields.includes('tif')) {
    body += field('Time in force', `
      <div style="display:flex;gap:4px;background:var(--panel-2);border-radius:10px;padding:3px">
        ${TIFS.map(x => `<button data-pf-tif="${x.id}" style="flex:1;padding:7px 0;border:none;border-radius:8px;cursor:pointer;font-size:12px;font-weight:700;
          background:${_form.tif === x.id ? 'var(--panel-3)' : 'transparent'};color:${_form.tif === x.id ? 'var(--fg)' : 'var(--muted)'}">${esc(x.label)}</button>`).join('')}
      </div>`, TIFS.find(x => x.id === _form.tif)?.desc ?? '')
  }

  if (t.fields.includes('triggerPx')) {
    const where = f.isBuy
      ? (t.trigger.tpsl === 'sl' ? 'above' : 'below')
      : (t.trigger.tpsl === 'sl' ? 'below' : 'above')
    body += field('Trigger price', numInput('triggerPx'),
      mark ? `Must sit ${where} the mark ($${fmt(mark)}) or it can never fire.` : 'Fires when the mark price reaches this.')
  }

  if (t.fields.includes('limitPx')) {
    body += field('Limit price', numInput('limitPx'), 'The price the order goes in at once it triggers.')
  }

  if (_type === 'scale') {
    body += `<div style="display:flex;gap:8px">
      <div style="flex:1">${field('From', numInput('scaleStartPx'))}</div>
      <div style="flex:1">${field('To', numInput('scaleEndPx'))}</div>
    </div>
    <div style="display:flex;gap:8px">
      <div style="flex:1">${field('Orders', `<input data-pf="scaleCount" type="number" min="${SCALE.MIN_ORDERS}" max="${SCALE.MAX_ORDERS}" step="1" value="${_form.scaleCount ?? 5}" style="${inputCss}">`)}</div>
      <div style="flex:1">${field('Size skew', `<input data-pf="scaleSkew" type="number" min="${SCALE.MIN_SKEW}" max="${SCALE.MAX_SKEW}" step="0.1" value="${_form.scaleSkew ?? 1}" style="${inputCss}">`, '1 = even')}</div>
    </div>`
    // A permanent host, even when there is nothing to put in it. The ladder depends on the
    // SIZE, which lives in the main ticket's box — so the first paint often has no size and
    // no ladder, and a refresh that only swaps an existing element could never bring one
    // back. The host is always here; only its contents change.
    body += `<div data-pf-ladder></div>`
  }

  if (_type === 'twap') {
    body += field('Duration (minutes)', `<input data-pf="twapMinutes" type="number" min="${TWAP.MIN_MINUTES}" max="${TWAP.MAX_MINUTES}" step="1" value="${_form.twapMinutes ?? 30}" style="${inputCss}">`,
      `${TWAP.MIN_MINUTES}–${TWAP.MAX_MINUTES} minutes. One suborder every ${TWAP.SUB_SECONDS}s.`)
    body += checkbox('twapRandomize', `Randomize suborder sizes (±${TWAP.RANDOMIZE_PCT}%)`)
  }

  if (_type === 'chase') {
    body += field('Max chase distance (ticks)', numInput('chaseMaxTicks', 'no limit', '1'),
      'How far the order may follow the book against you before it gives up. Blank means no limit.')
  }

  if (t.fields.includes('reduceOnly')) body += checkbox('reduceOnly', 'Reduce only')

  if (_type === 'trailingStop') {
    body += `<div style="font-size:12.5px;color:var(--fg-2);line-height:1.55;margin-bottom:10px">
      A trailing stop guards a position that already exists. Pressing the button below opens the
      trailing-stop form for your ${esc(labelOf(ctx.coin()))} position.
    </div>`
  }

  const running = chaseStrip()

  el.innerHTML = `
    <div style="border:1px solid var(--border2);border-radius:14px;padding:12px;background:var(--panel);margin-bottom:12px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px">
        <div style="font-size:13.5px;font-weight:700">${esc(t.label)}</div>
        <button data-pf-learn="1" style="background:none;border:none;color:var(--muted);font-size:11.5px;cursor:pointer;padding:0;text-decoration:underline">What is this?</button>
      </div>
      ${body}
      <div data-pf-preview style="font-size:12px;line-height:1.5;color:${errs.length ? 'var(--red)' : 'var(--fg-2)'};margin-top:2px">
        ${esc(errs.length ? errs[0] : describe(_type, f))}
      </div>
      ${t.liveness ? `<div style="margin-top:7px;font-size:11.5px;color:var(--muted)">${esc(t.liveness)}</div>` : ''}
    </div>
    ${running}`

  // Inputs write into _form and repaint. Repainting on every keystroke would move the caret,
  // so the preview line and the ladder are refreshed in place instead.
  el.querySelectorAll('[data-pf]').forEach(inp => {
    inp.oninput = () => { _form[inp.dataset.pf] = inp.value; refreshPreviews() }
  })
  el.querySelectorAll('[data-pf-check]').forEach(inp => {
    inp.onchange = () => { _form[inp.dataset.pfCheck] = inp.checked; paintAll() }
  })
  el.querySelectorAll('[data-pf-tif]').forEach(b => {
    b.onclick = () => { _form.tif = b.dataset.pfTif; paintAll() }
  })
  el.querySelectorAll('[data-pf-learn]').forEach(b => { b.onclick = () => openProLearn(_type) })
  el.querySelectorAll('[data-pf-stopchase]').forEach(b => {
    b.onclick = () => stopChase(b.dataset.pfStopchase)
  })
}

const checkbox = (key, label) => `
  <label style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer">
    <input type="checkbox" data-pf-check="${key}" ${_form[key] ? 'checked' : ''} style="width:15px;height:15px;accent-color:var(--accent);cursor:pointer">
    <span style="font-size:12.5px;color:var(--fg-2)">${esc(label)}</span>
  </label>`

const labelOf = (coin) => String(coin ?? 'this market').replace(/.*:/, '')
const fmt = (n) => Number(n) >= 1000 ? Number(n).toFixed(2) : String(parseFloat(Number(n).toPrecision(6)))

/** The rungs, as they will actually be placed. Checkable before you sign, not after. */
function ladderPreview(f) {
  const { orders } = scaleLadder({ startPx: f.scaleStartPx, endPx: f.scaleEndPx, count: f.scaleCount, totalSz: f.sz, skew: f.scaleSkew })
  if (!orders) return ''
  const avg = ladderAvgPx(orders)
  // No data-pf-ladder here — that attribute belongs to the permanent HOST this html is put
  // inside. Putting it on both nests them, and a "> div" query then walks the rows as well.
  return `<div style="margin:2px 0 10px;border:1px solid var(--border);border-radius:10px;overflow:hidden">
    ${orders.map(o => `<div style="display:flex;justify-content:space-between;padding:5px 10px;font-size:11.5px;font-family:var(--font-mono);border-bottom:1px solid var(--border)">
      <span style="color:var(--muted)">$${fmt(o.px)}</span><span>${fmt(o.sz)}</span></div>`).join('')}
    <div style="display:flex;justify-content:space-between;padding:6px 10px;font-size:11.5px;background:var(--panel-2)">
      <span style="color:var(--muted)">Average if all fill</span><b style="font-family:var(--font-mono)">$${fmt(avg)}</b></div>
  </div>`
}

/**
 * Repaint only the bits that change as you type.
 *
 * A full repaint on every keystroke would rebuild the input that is being typed into and
 * take the caret with it, so the preview line and the ladder are updated in place. Found by
 * data attribute within the mounted container, never by id: the two shells are both in the
 * document, so an id would resolve to whichever came first — usually the hidden one.
 */
function refreshPreviews() {
  const f = readForm()
  const errs = _type ? validate(_type, f) : []
  _mounts.forEach(el => {
    const prev = el.querySelector('[data-pf-preview]')
    if (prev) {
      prev.textContent = errs.length ? errs[0] : describe(_type, f)
      prev.style.color = errs.length ? 'var(--red)' : 'var(--fg-2)'
    }
    const lad = el.querySelector('[data-pf-ladder]')
    if (lad) lad.innerHTML = _type === 'scale' ? ladderPreview(f) : ''
  })
}

/** Everything the form says, plus the parts of the world the validators need. */
function readForm() {
  const coin = ctx.coin()
  return {
    ..._form,
    coin:         labelOf(coin),
    sz:           ctx.sizeCoin(),
    isBuy:        ctx.isBuy(),
    markPx:       ctx.mark(),
    isSpot:       ctx.isSpot(coin),
    hasPosition:  ctx.hasPosition(coin),
    activeChases: _chases.size,
  }
}

/**
 * The size box changed.
 *
 * Size lives in the main ticket, not in the Pro panel, so nothing here hears about it. Both
 * shells call this from their order-summary update — without it the Scale ladder and the
 * "$100 minimum" TWAP check describe a size the user has since replaced, which is the exact
 * failure this whole panel exists to prevent: the screen and the order disagreeing.
 */
export function refreshProPreview() { if (_type != null) refreshPreviews() }

/** Errors the submit button should refuse on, for the shell to grey itself out with. */
export function proErrors() { return _type ? validate(_type, readForm()) : [] }

/** What the submit button should say. */
export function proButtonLabel() {
  if (_type == null) return null
  const t = byId(_type)
  if (_type === 'trailingStop') return 'Set Trailing Stop'
  return `${ctx.isBuy() ? 'Buy' : 'Sell'} · ${t.label}`
}

// ─── SUBMIT ───────────────────────────────────────────────────────────────────

/**
 * Place whatever the Pro ticket currently describes.
 *
 * `say(kind, msg)` is the shell's status line — the two tickets paint status differently, so
 * they hand in the painter rather than this module reaching for an element id that exists
 * twice.
 *
 * Returns true when something was sent, so the caller knows whether to clear the size box.
 */
export async function submitPro(say = () => {}) {
  if (_type == null) return false
  const t = byId(_type)
  const f = readForm()
  const errs = validate(_type, f)
  if (errs.length) { say('error', errs[0]); return false }

  const coin = ctx.coin()
  const acct = ctx.acct()

  if (_type === 'trailingStop') { ctx.openTrail(coin); return false }

  if (!ctx.canTrade()) { say('error', 'No agent key for the selected account.'); return false }

  try {
    say('pending', 'Signing and submitting…')

    if (_type === 'scale') {
      const { orders, error } = scaleLadder({ startPx: f.scaleStartPx, endPx: f.scaleEndPx, count: f.scaleCount, totalSz: f.sz, skew: f.scaleSkew })
      if (error) { say('error', error); return false }
      const res = parseOrderResult(await placeScaleOrders({
        coin, isBuy: f.isBuy, rungs: orders, leverage: ctx.leverage(), isIsolated: ctx.isolated(), acct,
      }))
      if (!res.ok) { say('error', '✗ ' + res.errors.join(', ')); return false }
      say('success', `✓ ${orders.length} orders resting from $${fmt(orders[0].px)} to $${fmt(orders[orders.length - 1].px)}`)
      ctx.afterAction()
      return true
    }

    if (t.submit === 'trigger') {
      const res = parseOrderResult(await placeStopOrder({
        coin, isBuy: f.isBuy, sz: f.sz,
        triggerPx: num(f.triggerPx), limitPx: num(f.limitPx),
        tpsl: t.trigger.tpsl, isMarket: t.trigger.isMarket,
        reduceOnly: !!f.reduceOnly, leverage: ctx.leverage(), isIsolated: ctx.isolated(), acct,
      }))
      if (!res.ok) { say('error', '✗ ' + res.errors.join(', ')); return false }
      say('success', `✓ ${t.label} armed at $${fmt(num(f.triggerPx))}`)
      ctx.afterAction()
      return true
    }

    if (_type === 'twap') {
      const r = await placeTwapOrder({
        coin, isBuy: f.isBuy, sz: f.sz, minutes: num(f.twapMinutes),
        randomize: !!f.twapRandomize, reduceOnly: !!f.reduceOnly,
        leverage: ctx.leverage(), isIsolated: ctx.isolated(), acct,
      })
      const st = r?.response?.data?.status
      if (st?.error) { say('error', '✗ ' + st.error); return false }
      say('success', `✓ TWAP running over ${fmt(num(f.twapMinutes))} minutes`)
      ctx.afterAction()
      return true
    }

    if (_type === 'chase') {
      const started = await startChase({ coin, isBuy: f.isBuy, sz: f.sz, maxTicks: num(f.chaseMaxTicks), acct, say })
      return started
    }

    say('error', 'That order type is not wired up yet.')
    return false
  } catch (e) {
    say('error', '✗ ' + (e?.message ?? 'Order failed'))
    return false
  }
}

// ─── CHASE ────────────────────────────────────────────────────────────────────

/**
 * A chase, running in this tab.
 *
 * The loop is deliberately dull: read the book, work out where the front of it is, and if
 * the resting order is not there, cancel and re-place. Everything interesting has already
 * been decided by the pure functions in src/protypes.js, which is what makes those decisions
 * testable without a market.
 *
 * Three things it refuses to do, each of which costs money:
 *
 *   • re-price on a book it could not read. bestBidAsk returns nulls on failure and this
 *     treats that as "no information", not "the bid is zero".
 *   • re-price for less than a tick. Float noise on a re-derived target would otherwise
 *     cancel and replace on every poll, burning the shared IP budget for no price improvement.
 *   • chase forever. `maxTicks` is the leash; past it the order stays where it is and the
 *     chase stops, rather than following a market that has run away.
 */
const _chases = new Map()
let _chaseSeq = 0

export const activeChases = () => [..._chases.values()].map(c => ({ id: c.id, coin: c.coin, isBuy: c.isBuy, sz: c.sz, px: c.px }))

function chaseStrip() {
  if (!_chases.size) return ''
  return `<div style="border:1px solid var(--accent);border-radius:12px;padding:10px 11px;background:color-mix(in oklch,var(--accent) 8%,transparent);margin-bottom:12px">
    <div style="font-size:10.5px;font-weight:700;letter-spacing:.05em;color:var(--accent);margin-bottom:6px">CHASING (${_chases.size}/${CHASE.MAX_ACTIVE})</div>
    ${[..._chases.values()].map(c => `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:12px;padding:3px 0">
        <span>${esc(c.isBuy ? 'Buy' : 'Sell')} ${esc(fmt(c.sz))} ${esc(labelOf(c.coin))}
          <span style="color:var(--muted);font-family:var(--font-mono)">@ ${c.px ? '$' + esc(fmt(c.px)) : '—'}</span></span>
        <button data-pf-stopchase="${c.id}" style="background:none;border:1px solid var(--border2);border-radius:7px;color:var(--fg-2);font-size:11px;padding:3px 9px;cursor:pointer">Stop</button>
      </div>`).join('')}
  </div>`
}

async function startChase({ coin, isBuy, sz, maxTicks, acct, say }) {
  if (_chases.size >= CHASE.MAX_ACTIVE) { say('error', `${CHASE.MAX_ACTIVE} chases are already running.`); return false }

  const szDecimals = await szDecimalsFor(coin)
  const { bestBid, bestAsk } = await bestBidAsk(coin)
  if (!bestBid || !bestAsk) { say('error', 'Could not read the order book for ' + labelOf(coin)); return false }

  const tick = tickSize(isBuy ? bestBid : bestAsk, szDecimals)
  const px   = chaseTargetPx({ isBuy, bestBid, bestAsk, tick })
  if (!px) { say('error', 'The order book is too thin to chase right now.'); return false }

  const res = parseOrderResult(await placeLimitOrder({
    coin, isBuy, sz, limitPx: px, tif: 'Alo',
    leverage: ctx.leverage(), isIsolated: ctx.isolated(), acct,
  }))
  if (!res.ok) { say('error', '✗ ' + res.errors.join(', ')); return false }
  const oid = res.resting?.[0]?.resting?.oid
  if (!oid) {
    // An ALO that did not rest either filled outright or was rejected for crossing. Either
    // way there is nothing to chase, and saying so beats a chase entry that tracks nothing.
    say(res.filled.length ? 'success' : 'error', res.filled.length ? '✓ Filled immediately' : 'The post-only order did not rest — try again.')
    if (res.filled.length) ctx.afterAction()
    return !!res.filled.length
  }

  const id = 'c' + (++_chaseSeq)
  const c = { id, coin, isBuy, sz, acct, oid, px, startPx: px, tick, szDecimals, maxTicks, say, stopping: false }
  c.timer = setInterval(() => tickChase(c), Math.max(CHASE.MIN_REPRICE_MS, 3000))
  _chases.set(id, c)
  say('success', `✓ Chasing the ${isBuy ? 'bid' : 'ask'} at $${fmt(px)}`)
  paintAll()
  ctx.afterAction()
  return true
}

async function tickChase(c) {
  if (c.stopping) return
  const { bestBid, bestAsk } = await bestBidAsk(c.coin)
  if (!bestBid || !bestAsk) return          // no information is not the same as a zero bid

  const tick   = tickSize(c.isBuy ? bestBid : bestAsk, c.szDecimals)
  const target = chaseTargetPx({ isBuy: c.isBuy, bestBid, bestAsk, tick })
  if (!target) return
  if (!shouldRechase(c.px, target, tick)) return

  if (chaseExceeded({ isBuy: c.isBuy, startPx: c.startPx, targetPx: target, tick, maxTicks: c.maxTicks })) {
    // The leash ran out. The order is deliberately LEFT resting where it is: it is a real
    // limit order at a price the trader accepted, and cancelling it here would take away a
    // fill they may well still want. Only the re-pricing stops.
    endChase(c, 'success', `Chase stopped — the market moved more than ${c.maxTicks} ticks. Your order is still resting at $${fmt(c.px)}.`)
    return
  }

  c.stopping = true          // no overlapping re-prices while a cancel is in flight
  try {
    const cancelled = parseOrderResult(await cancelOrder({ coin: c.coin, oid: c.oid, acct: c.acct }))
    if (!cancelled.ok) {
      // "never placed / already cancelled / filled" all mean the same thing here: the order
      // we were chasing with is gone, so the chase is over.
      const gone = cancelled.errors.some(e => /never placed|already cancel|filled/i.test(e))
      if (gone) { endChase(c, 'success', '✓ Chase filled or cancelled — nothing left to chase.'); ctx.afterAction(); return }
      c.stopping = false
      return
    }
    const res = parseOrderResult(await placeLimitOrder({
      coin: c.coin, isBuy: c.isBuy, sz: c.sz, limitPx: target, tif: 'Alo',
      leverage: ctx.leverage(), isIsolated: ctx.isolated(), acct: c.acct,
    }))
    const oid = res.resting?.[0]?.resting?.oid
    if (!res.ok || !oid) {
      // The replacement did not rest. The old one is already cancelled, so stop rather than
      // leave a chase entry on screen that is tracking an order that does not exist.
      endChase(c, res.filled.length ? 'success' : 'error',
        res.filled.length ? '✓ Chase filled' : '✗ Chase stopped — the replacement order did not rest.')
      ctx.afterAction()
      return
    }
    c.oid = oid
    c.px  = target
    paintAll()
  } catch (e) {
    endChase(c, 'error', '✗ Chase stopped — ' + (e?.message ?? 'request failed'))
  } finally {
    c.stopping = false
  }
}

function endChase(c, kind, msg) {
  clearInterval(c.timer)
  _chases.delete(c.id)
  try { c.say?.(kind, msg) } catch {}
  paintAll()
}

/**
 * Stop chasing, and cancel what is resting.
 *
 * Cancelling is the right default: the order only ever existed at that price because
 * something was moving it, and leaving an untended order behind at the last price the
 * algorithm happened to pick is not what "stop" means to anyone.
 */
export async function stopChase(id) {
  const c = _chases.get(id)
  if (!c) return
  clearInterval(c.timer)
  _chases.delete(c.id)
  paintAll()
  try { await cancelOrder({ coin: c.coin, oid: c.oid, acct: c.acct }) } catch {}
  ctx.afterAction()
}

/** Every chase, stopped — used when the account or the agent key changes underneath us. */
export function stopAllChases() { [..._chases.keys()].forEach(stopChase) }

// The page going away is not a graceful stop: the resting order stays on the exchange, which
// is the honest outcome (it is a real order), but the user is told so rather than finding out.
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (!_chases.size) return
    e.preventDefault()
    e.returnValue = ''
  })
}
