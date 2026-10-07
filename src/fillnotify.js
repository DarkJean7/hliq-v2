/**
 * INSOLVENT TERMINAL — "Order filled" cards
 *
 * The small panel a DEX terminal slides in when one of your orders fills: side, size, coin,
 * average price, and what a closing fill realized. Bottom-right on desktop, under the status
 * bar on a phone.
 *
 * ── one card per ORDER, not per fill ──
 *
 * Hyperliquid fills a single order in as many pieces as the book needs — one close came back
 * as six fills (src/tradegroup.js). Six cards for one click is noise, so fills are grouped by
 * the order they belong to (tradeKey), and a later piece of an order whose card is still on
 * screen updates that card instead of stacking another.
 *
 * ── only news ──
 *
 * The first time an account's fills are seen, they are history: recorded, never shown.
 * After that, a fill is shown only if it is new AND recent (MAX_AGE) — a combined-view
 * refresh after the laptop slept, or a cache from yesterday, must not replay an afternoon of
 * fills as if they had just happened.
 *
 * Main.js feeds it from both shells' data paths (the single-account tick and the All Accounts
 * refresh) and supplies names, privacy and the on/off setting through initFillNotify, so this
 * file never reaches into app state — the shape src/agentkeys.js and src/offexui.js use.
 */
import { tradeKey } from './tradegroup.js'
import { fmtUSD, fmtPrice, fmtSize } from './format.js'

/** A fill older than this when first seen is not news. */
export const MAX_AGE_MS = 15 * 60_000
/** How long a card stays, unless hovered. */
export const SHOW_MS = 7000
/** At most this many on screen; the oldest goes first. */
export const MAX_CARDS = 4

const LS_KEY = 'hliq_fill_toasts'

let ctx = {
  /** 'NVDA' for 'xyz:NVDA', 'PURR' for '@0' — the name the rest of the app shows. */
  name: (coin) => String(coin ?? ''),
  /** The HIP-3 dex of a coin, or null. */
  dex: (coin) => (String(coin ?? '').includes(':') ? String(coin).split(':')[0] : null),
  privacy: () => false,
  now: () => Date.now(),
}
export function initFillNotify(c) { ctx = { ...ctx, ...c } }

/** On by default — a DEX terminal tells you when you get filled. */
export function enabled() { try { return localStorage.getItem(LS_KEY) !== '0' } catch { return true } }
export function setEnabled(on) { try { localStorage.setItem(LS_KEY, on ? '1' : '0') } catch {} }

// ── what has been seen ──────────────────────────────────────────────────────

const seen = new Map()      // acct → Set(fill id)
const seeded = new Set()    // accounts whose history has been recorded
/** A fill's identity. tid is unique per fill; the rest is the fallback for paper/old fills. */
export const fillId = (f) => `${f.tid ?? ''}|${f.oid ?? ''}|${f.time}|${f.px}|${f.sz}|${f.side ?? ''}`
const acctKey = (a) => String(a ?? '').toLowerCase()

/** Record fills as already known, without showing anything (an account's first load). */
export function seedFills(fills, acct = '') {
  const a = acctKey(acct)
  let set = seen.get(a); if (!set) { set = new Set(); seen.set(a, set) }
  for (const f of (fills ?? [])) set.add(fillId(f))
  seeded.add(a)
}

/**
 * Fills → one group per order: side, total size, average price, realized PnL, fee, pieces.
 * Pure; exported for the suite.
 */
export function groupByOrder(fills, acct = '') {
  const by = new Map()
  for (const f of (fills ?? [])) {
    const k = tradeKey({ ...f, _acctAddr: acct })
    let g = by.get(k)
    if (!g) {
      g = { key: k, acct, coin: f.coin, side: f.side, dir: f.dir ?? '', sz: 0, notional: 0, closedPnl: 0, fee: 0, pieces: 0, time: 0 }
      by.set(k, g)
    }
    const sz = Number(f.sz) || 0, px = Number(f.px) || 0
    g.sz += sz
    g.notional += Number.isFinite(f.notional) ? f.notional : sz * px
    g.closedPnl += Number(f.closedPnl) || 0
    g.fee += Number(f.fee) || 0
    g.pieces++
    g.time = Math.max(g.time, Number(f.time) || 0)
  }
  for (const g of by.values()) g.px = g.sz > 0 ? g.notional / g.sz : null
  return [...by.values()].sort((a, b) => a.time - b.time)
}

/**
 * The entry point. `fills` are parsed fills (src/format.js parseFills) for ONE account;
 * whatever was already seen is skipped, an account's first batch is only recorded, and what
 * is left — new and recent — is shown, one card per order. Returns the groups shown.
 */
export function notifyFills(fills, { acct = '', label = null } = {}) {
  const a = acctKey(acct)
  let set = seen.get(a); if (!set) { set = new Set(); seen.set(a, set) }
  const fresh = []
  for (const f of (fills ?? [])) {
    const id = fillId(f)
    if (set.has(id)) continue
    set.add(id)
    fresh.push(f)
  }
  if (!seeded.has(a)) { seeded.add(a); return [] }      // first sight: history, not news
  const now = ctx.now()
  const recent = fresh.filter(f => now - Number(f.time) < MAX_AGE_MS)
  if (!recent.length || !enabled()) return []
  const groups = groupByOrder(recent, a)
  if (typeof document !== 'undefined') for (const g of groups) show(g, label)
  return groups
}

// ── the cards ───────────────────────────────────────────────────────────────

const live = new Map()      // order key → { el, g, timer }

function host() {
  let h = document.getElementById('fillToasts')
  if (!h) {
    injectCss()
    h = document.createElement('div')
    h.id = 'fillToasts'
    h.className = 'ft-host'
    // Announced politely: a fill is news, not an error.
    h.setAttribute('role', 'status')
    h.setAttribute('aria-live', 'polite')
    document.body.appendChild(h)
  }
  return h
}

// 0.25, not 0.250000: the zeros fmtSize pads a small size with are noise on a card.
export const size = (n) => fmtSize(n).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
const verb = (side) => (side === 'BUY' || side === 'B' ? 'Bought' : 'Sold')

function fill(el, g, label) {
  const buy = g.side === 'BUY' || g.side === 'B'
  const hide = ctx.privacy()
  const name = ctx.name(g.coin), dex = ctx.dex(g.coin)
  el.classList.toggle('ft-buy', buy)
  el.classList.toggle('ft-sell', !buy)
  // Built with textContent: coin names and wallet labels are data, not markup.
  const q = (sel) => el.querySelector(sel)
  q('.ft-title').textContent = g.pieces > 1 ? `Order filled · ${g.pieces} fills` : 'Order filled'
  q('.ft-main').textContent = `${verb(g.side)} ${hide ? '•••' : size(g.sz)} ${name}`
  q('.ft-px').textContent = g.px != null ? `at $${fmtPrice(g.px)}${g.pieces > 1 ? ' avg' : ''}` : ''
  const meta = [g.dir || null, dex ? dex.toUpperCase() : null, label || null, hide ? null : '$' + fmtUSD(g.notional)].filter(Boolean)
  q('.ft-meta').textContent = meta.join(' · ')
  const pnl = q('.ft-pnl')
  // A closing fill realized something: say what, signed — that is the line a trader looks for.
  if (Math.abs(g.closedPnl) >= 0.005) {
    const up = g.closedPnl >= 0
    pnl.hidden = false
    pnl.className = 'ft-pnl ' + (up ? 'ft-up' : 'ft-dn')
    pnl.textContent = hide ? 'Realized •••' : `Realized ${up ? '+' : '-'}$${fmtUSD(Math.abs(g.closedPnl))}`
  } else pnl.hidden = true
}

function arm(entry) {
  clearTimeout(entry.timer)
  entry.timer = setTimeout(() => dismiss(entry.g.key), SHOW_MS)
}

function dismiss(key) {
  const e = live.get(key)
  if (!e) return
  clearTimeout(e.timer)
  live.delete(key)
  e.el.classList.add('ft-out')
  setTimeout(() => e.el.remove(), 220)
}

function show(g, label) {
  const existing = live.get(g.key)
  if (existing) {
    // More pieces of an order whose card is still up: one card, the order's running total.
    const m = existing.g
    m.sz += g.sz; m.notional += g.notional; m.closedPnl += g.closedPnl; m.fee += g.fee; m.pieces += g.pieces
    m.px = m.sz > 0 ? m.notional / m.sz : null
    fill(existing.el, m, label)
    arm(existing)
    return
  }
  const h = host()
  while (live.size >= MAX_CARDS) dismiss(live.keys().next().value)
  const el = document.createElement('div')
  el.className = 'ft-card'
  el.innerHTML = `<i class="ft-bar" aria-hidden="true"></i>
    <div class="ft-body">
      <div class="ft-head"><span class="ft-title"></span><button class="ft-x" aria-label="Dismiss">×</button></div>
      <div class="ft-line"><b class="ft-main"></b> <span class="ft-px"></span></div>
      <div class="ft-meta"></div>
      <div class="ft-pnl" hidden></div>
    </div>`
  fill(el, g, label)
  const entry = { el, g: { ...g }, timer: null }
  live.set(g.key, entry)
  el.querySelector('.ft-x').addEventListener('click', () => dismiss(g.key))
  // Hovering holds it, so a card is not snatched away while it is being read.
  el.addEventListener('pointerenter', () => clearTimeout(entry.timer))
  el.addEventListener('pointerleave', () => arm(entry))
  h.appendChild(el)
  arm(entry)
}

/** A sample card, for the Settings row's Preview button. */
export function previewFill() {
  if (typeof document === 'undefined') return
  show({ key: 'preview|' + Date.now(), acct: '', coin: 'BTC', side: 'BUY', dir: 'Open Long', sz: 0.0521, notional: 0.0521 * 86412.5,
         px: 86412.5, closedPnl: 0, fee: 1.62, pieces: 2, time: Date.now() }, 'Preview')
  show({ key: 'preview2|' + Date.now(), acct: '', coin: 'ETH', side: 'SELL', dir: 'Close Long', sz: 1.25, notional: 1.25 * 2731.4,
         px: 2731.4, closedPnl: 48.37, fee: 1.19, pieces: 1, time: Date.now() }, 'Preview')
}

function injectCss() {
  if (document.getElementById('ftCss')) return
  const s = document.createElement('style')
  s.id = 'ftCss'
  s.textContent = `
  .ft-host { position: fixed; right: 18px; bottom: 18px; z-index: 100060; display: flex; flex-direction: column; gap: 8px; align-items: flex-end; pointer-events: none; }
  .ft-card { pointer-events: auto; position: relative; display: flex; width: 300px; max-width: calc(100vw - 24px); overflow: hidden;
    /* Opaque whatever the theme: with a background photo theme.js makes the panels translucent,
       and a card that opens OVER the positions must not show them through it. --bg stays solid. */
    background-color: var(--bg, #0a0c10); background-image: linear-gradient(var(--panel-3, #1c2230), var(--panel-3, #1c2230));
    border: 1px solid var(--rule, #1f2533); border-radius: 12px;
    box-shadow: 0 12px 34px rgba(0,0,0,.45); color: var(--fg, #e5e9f0); font-size: 13px;
    animation: ft-in .22s cubic-bezier(.2,.8,.2,1); }
  .ft-card.ft-out { animation: ft-outk .22s ease forwards; }
  @keyframes ft-in { from { opacity: 0; transform: translateX(16px) scale(.98); } to { opacity: 1; transform: none; } }
  @keyframes ft-outk { to { opacity: 0; transform: translateX(16px); } }
  .ft-bar { flex: 0 0 4px; background: var(--fg-3, #6b7384); }
  .ft-buy .ft-bar { background: var(--green, #2ad1a5); }
  .ft-sell .ft-bar { background: var(--red, #ff4d6d); }
  .ft-body { flex: 1; min-width: 0; padding: 10px 10px 10px 12px; }
  .ft-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .ft-title { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--fg-2, #aab1c0); }
  .ft-x { border: 0; background: none; color: var(--fg-3, #6b7384); font-size: 18px; line-height: 1; padding: 0 2px; cursor: pointer; }
  .ft-x:hover { color: var(--fg, #e5e9f0); }
  .ft-line { margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ft-main { font-weight: 700; font-size: 14px; }
  .ft-px { color: var(--fg-2, #aab1c0); font-variant-numeric: tabular-nums; }
  .ft-meta { margin-top: 3px; font-size: 11.5px; color: var(--fg-3, #6b7384); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ft-pnl { margin-top: 5px; font-weight: 700; font-variant-numeric: tabular-nums; }
  .ft-up { color: var(--green, #2ad1a5); } .ft-dn { color: var(--red, #ff4d6d); }
  @media (max-width: 768px) {
    /* The same corner as desktop, lifted above the bottom nav. */
    .ft-host { right: 10px; bottom: calc(env(safe-area-inset-bottom, 0px) + 78px); }
    .ft-card { width: 270px; max-width: calc(100vw - 20px); font-size: 12.5px; }
    .ft-main { font-size: 13px; }
  }
  @media (prefers-reduced-motion: reduce) { .ft-card, .ft-card.ft-out { animation: none; } }`
  document.head.appendChild(s)
}
