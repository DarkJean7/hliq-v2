/**
 * Grid Ladder — the panel. More → Grid Ladder (window.__openGridLadder, src/main.js).
 *
 * Configures the five bots, starts / pauses / stops them on the bot server (the generic
 * /api/start, /api/pause, /api/resume with type "gridladder", plus /api/gridladder/stop for the
 * stop mode), and shows each bot's numbers and the ladder's totals from /api/gridladder/status,
 * which reads the bots' own SQLite state. Nothing here decides a trade: the engine is
 * src/gridladder.js, and the same functions validate the config here and on the server.
 *
 * Network: testnet by default. Mainnet is a switch that has to be confirmed, and the bot
 * refuses mainnet without the flag that switch sends.
 */
import './gridladder.css'
import { ExchangeClient, HttpTransport } from '@nktkas/hyperliquid'
import { DEFAULT_LADDER, validateBot, levelsOf, botCapital, ladderStats, pairSize, fitLadder } from './gridladder.js'
import { keyedAddresses, readKey } from './agentkeys.js'
import { botApi, acctName } from './botapi.js'
import { infoClient } from './api.js'
import { getHlSigner, getMainAddress } from './wallet.js'
import { approveAgentKey } from './trading.js'

const CFG_KEY = 'hliq_gridladder_cfg', SWEEP_KEY = 'hliq_gridladder_swept'
const ADDR = /^0x[0-9a-fA-F]{40}$/
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
const usd = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (+v < 0 ? '-$' : '$') + Math.abs(+v).toFixed(d))
const sgn = (v, d = 2) => (v == null || !Number.isFinite(+v) ? '—' : (+v > 0 ? '+' : '') + usd(v, d))
const cls = (v) => (+v > 0 ? 'pos' : +v < 0 ? 'neg' : '')
// The app's own themed dialogs (src/main.js) — never the browser's grey boxes.
const ask = (o) => window.__appConfirm ? window.__appConfirm(o) : Promise.resolve(false)
const askText = (o) => window.__appPrompt ? window.__appPrompt(o) : Promise.resolve(null)
const jget = (k, d) => { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? d } catch { return d } }
const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)) } catch {} }

function loadCfg() {
  const c = jget(CFG_KEY, {})
  const bots = DEFAULT_LADDER.map((d, i) => ({ ...d, ...(c.bots?.[i] ?? {}), id: i + 1 }))
  return { network: ['testnet', 'dry', 'mainnet'].includes(c.network) ? c.network : 'testnet', mainnetOk: !!c.mainnetOk, bots }
}

let cfg = loadCfg(), meta = {}, rows = {}, ov = null, timer = null, busy = new Set(), note = ''
const save = () => jset(CFG_KEY, cfg)
const tradeOf = (b) => String(b.sub || b.account || '').toLowerCase()
const masters = () => [...new Set(cfg.bots.map(b => String(b.account || '').toLowerCase()).filter(a => ADDR.test(a)))]
/** The server's row for this bot: same slot, same account, this network — or whatever runs in that slot. */
const rowOf = (b) => {
  const list = rows[String(b.account || '').toLowerCase()] ?? []
  return list.find(r => r.bot === b.id && r.trade === tradeOf(b) && r.network === cfg.network) ?? list.find(r => r.bot === b.id && r.running) ?? null
}

async function loadMeta(net) {
  if (meta[net]?.at > Date.now() - 60_000) return meta[net]
  let m
  if (net === 'testnet') {
    const r = await fetch('https://api.hyperliquid-testnet.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) })
    const [u, ctx] = await r.json()
    const i = u.universe.findIndex(x => x.name === 'HYPE')
    m = { szDecimals: u.universe[i].szDecimals, maxLeverage: u.universe[i].maxLeverage, onlyIsolated: !!u.universe[i].onlyIsolated, mid: +ctx[i].midPx || +ctx[i].markPx }
  } else {
    const [u, mids] = await Promise.all([infoClient.meta(), infoClient.allMids()])
    const h = u.universe.find(x => x.name === 'HYPE')
    m = { szDecimals: h.szDecimals, maxLeverage: h.maxLeverage, onlyIsolated: !!h.onlyIsolated, mid: +mids.HYPE }
  }
  return (meta[net] = { ...m, at: Date.now() })
}

async function refresh() {
  for (const m of masters()) {
    if (!readKey(localStorage, m)) continue
    try { const r = await botApi('/api/gridladder/status?address=' + m, m); if (Array.isArray(r.bots)) rows[m] = r.bots }
    catch (e) { note = `Could not read ${acctName(m)}: ${e.message}` }
  }
  try { await loadMeta(cfg.network) } catch {}
  render()
}

/** Everything that would stop this bot starting, as sentences. */
function problems(b) {
  const m = meta[cfg.network]
  const e = validateBot(b, m ?? {})
  if (!ADDR.test(b.account || '')) e.push('Pick the account whose agent key runs this bot.')
  else if (!readKey(localStorage, b.account)) e.push('That account has no agent key in this browser.')
  if (b.sub && !ADDR.test(b.sub)) e.push('The subaccount must be an address.')
  if (m?.onlyIsolated && b.margin !== 'isolated') e.push('HYPE is isolated-only on this network.')
  const t = tradeOf(b)
  if (t && cfg.bots.some(o => o.id !== b.id && tradeOf(o) === t)) e.push('Another bot uses this account. Each bot needs its own account or subaccount — one account holds one HYPE position.')
  if (cfg.network === 'mainnet' && !cfg.mainnetOk) e.push('Mainnet is off.')
  return e
}

function argsOf(b) {
  return ['--bot', String(b.id), '--low', String(b.low), '--high', String(b.high), '--levels', String(b.levels), '--usd', String(b.usd),
    '--leverage', String(b.leverage), '--margin', b.margin, '--kill', String(+b.killPrice || 0), '--network', cfg.network,
    ...(cfg.network === 'mainnet' ? ['--mainnet-ok'] : []), ...(b.sub ? ['--vault', b.sub.toLowerCase()] : [])]
}

async function act(b, what) {
  const addr = String(b.account).toLowerCase(), inst = 'L' + b.id
  busy.add(b.id); render()
  try {
    let r
    if (what === 'start') {
      const p = problems(b)
      if (p.length) throw new Error(p[0])
      r = await botApi('/api/start', addr, { type: 'gridladder', agentKey: readKey(localStorage, addr), address: addr, instance: inst, args: argsOf(b) })
      if (r.subscribe) throw new Error('A subscription is needed to run bots.')
    } else if (what === 'pause' || what === 'resume') r = await botApi('/api/' + what, addr, { type: 'gridladder', address: addr, instance: inst })
    else r = await botApi('/api/gridladder/stop', addr, { address: addr, instance: inst, mode: what === 'close' ? 'close' : 'stop' })
    if (r.ok === false || r.error) throw new Error(r.error || 'the bot server refused')
    note = ''
  } catch (e) { note = `Bot ${b.id}: ${e.message}` }
  busy.delete(b.id)
  setTimeout(refresh, what === 'start' ? 4_000 : 1_500)
  render()
}

async function all(what) {
  if (what === 'close' && !await ask({ title: 'Stop and close every bot?', body: 'Cancels every running bot’s orders and market-closes its HYPE position.', confirmText: 'Stop & close all', danger: true })) return
  for (const b of cfg.bots) {
    const r = rowOf(b), running = !!r?.running
    if (what === 'start' ? !running && ADDR.test(b.account || '') : running && (what !== 'pause' || !r.paused) && (what !== 'resume' || r.paused)) await act(b, what)
  }
}

/** Move realized profit out of a subaccount bot's margin, back to its master (main wallet signs). */
async function sweep(b, amount) {
  const signer = getHlSigner(b.account)
  if (!signer || String(getMainAddress() ?? '').toLowerCase() !== String(b.account).toLowerCase()) { note = `Connect ${acctName(b.account)} as the main wallet to sweep.`; return render() }
  try {
    const client = new ExchangeClient({ transport: new HttpTransport({ isTestnet: cfg.network === 'testnet', timeout: 60_000 }), wallet: signer })
    await client.subAccountTransfer({ subAccountUser: b.sub, isDeposit: false, usd: Math.floor(amount * 1e6) })
    const s = jget(SWEEP_KEY, {}), k = cfg.network + ':' + tradeOf(b)
    s[k] = { total: (s[k]?.total ?? 0) + amount, at: Date.now() }
    jset(SWEEP_KEY, s)
    note = `Swept ${usd(amount)} from bot ${b.id} to ${acctName(b.account)}.`
  } catch (e) { note = `Sweep failed: ${e.message}` }
  render()
}
function sweepDue(b, r) {
  if (!b.sweepEnabled || !b.sub || !r) return 0
  const s = jget(SWEEP_KEY, {})[cfg.network + ':' + tradeOf(b)] ?? { total: 0, at: 0 }
  const earned = (r.stats?.realized ?? 0) + (r.lifetime?.realized ?? 0)
  const due = earned - s.total
  return Date.now() - s.at >= (+b.sweepDays || 7) * 86_400_000 && due >= 1 ? Math.floor(due * 100) / 100 : 0
}

async function approveTestnet(master) {
  const signer = getHlSigner(master)
  if (!signer || String(getMainAddress() ?? '').toLowerCase() !== master) { note = `Connect ${acctName(master)} as the main wallet first — only it can approve an agent.`; return render() }
  try {
    const { Wallet } = await import('ethers')
    await approveAgentKey(signer, new Wallet(readKey(localStorage, master)).address, { testnet: true })
    note = `${acctName(master)}'s agent key is approved on testnet.`
  } catch (e) { note = `Testnet approval failed: ${e.message}` }
  render()
}

// ── drawing ──────────────────────────────────────────────────────────────────
function ladderSvg(mid) {
  const lo = Math.min(...cfg.bots.map(b => +b.low)), hi = Math.max(...cfg.bots.map(b => +b.high))
  const span = (hi - lo) || 1, pad = span * 0.08, a = lo - pad, z = hi + pad
  const W = 320, H = 150, x = (v) => 34 + ((v - a) / (z - a)) * (W - 44)
  const bars = cfg.bots.map((b, i) => {
    const r = rowOf(b), on = r?.running
    return `<rect x="${x(+b.low).toFixed(1)}" y="${12 + i * 24}" width="${Math.max(2, x(+b.high) - x(+b.low)).toFixed(1)}" height="16" rx="4" class="gl-bar ${on ? (r.paused ? 'paused' : 'on') : ''}"/>` +
      `<text x="4" y="${24 + i * 24}" class="gl-ax">Bot ${b.id}</text>`
  }).join('')
  const ticks = [lo, (lo + hi) / 2, hi].map(v => `<text x="${x(v).toFixed(1)}" y="${H - 2}" class="gl-ax" text-anchor="middle">$${+v.toFixed(2)}</text>`).join('')
  const m = mid > 0 && mid >= a && mid <= z ? `<line x1="${x(mid).toFixed(1)}" x2="${x(mid).toFixed(1)}" y1="4" y2="${H - 14}" class="gl-mid"/><text x="${x(mid).toFixed(1)}" y="10" class="gl-ax gl-midtx" text-anchor="middle">$${mid}</text>` : ''
  return `<svg class="gl-ladder" viewBox="0 0 ${W} ${H}" role="img" aria-label="The five ranges and the current price">${bars}${ticks}${m}</svg>`
}

function strip(b, r) {
  const m = meta[cfg.network]
  if (!m) return ''
  const px = r?.prices?.length ? r.prices : levelsOf(+b.low, +b.high, +b.levels, m.szDecimals)
  const mark = new Map()
  for (const p of r?.pairs ?? []) {
    if (p.phase === 'B' && p.placed) mark.set(p.i, 'b')
    if (p.phase === 'S' && p.placed) mark.set(p.i + 1, 's')
    if (p.phase === 'S' && !p.placed) mark.set(p.i + 1, 'h')
  }
  const mid = r?.live?.mid || m.mid
  return `<div class="gl-strip" data-dragscroll>${px.map((v, i) => `<span class="gl-lv ${mark.get(i) ?? ''} ${mid >= v && mid < (px[i + 1] ?? Infinity) ? 'here' : ''}" title="${mark.get(i) === 'b' ? 'Buy resting' : mark.get(i) === 's' ? 'Sell resting' : mark.get(i) === 'h' ? 'Held, sell not on the book' : 'No order'} at $${v}">${v}</span>`).join('')}</div>`
}

function stat(label, val, c = '') { return `<div class="gl-stat"><i>${label}</i><b class="${c}">${val}</b></div>` }

function card(b) {
  const r = rowOf(b), s = r?.stats, m = meta[cfg.network]
  const running = !!r?.running, paused = !!r?.paused
  const state = running ? (paused ? 'Paused' : r.waiting ? 'Waiting for range' : 'Running') : r?.killed ? 'Killed' : r ? 'Stopped' : 'Not started'
  const badge = running ? (paused ? 'paused' : 'on') : r?.killed ? 'bad' : ''
  const errs = running ? [] : problems(b)
  const cap = m ? botCapital(b, m.szDecimals) : null
  const sizes = m && +b.levels >= 2 ? levelsOf(+b.low, +b.high, +b.levels, m.szDecimals).slice(0, -1).map(p => pairSize(+b.usd, p, m.szDecimals)) : []
  const due = sweepDue(b, r)
  const accts = keyedAddresses(localStorage)
  const lock = running || busy.has(b.id) ? 'disabled' : ''
  const f = (k, label, type = 'number', extra = '') => `<label><span>${label}</span><input data-k="${k}" data-b="${b.id}" type="${type}" value="${esc(b[k] ?? '')}" ${extra} ${lock}></label>`
  return `<article class="gl-card" data-bot="${b.id}">
    <header><b>Bot ${b.id}</b><span class="gl-range">$${b.low}–$${b.high}</span><span class="gl-badge ${badge}">${state}</span>${r && r.network !== cfg.network ? `<span class="gl-badge">${esc(r.network)}</span>` : ''}</header>
    ${s ? `<div class="gl-stats">
      ${stat('Realized', sgn(s.realized), cls(s.realized))}${stat('Cycles', s.cycles)}
      ${stat('Holding', s.inventory > 0 ? `${s.inventory.toFixed(2)} @ ${usd(s.avgEntry, 3)}` : '—')}${stat('Unrealized', sgn(s.unrealized), cls(s.unrealized))}
      ${stat('Fees', usd(s.fees))}${stat('Funding paid', sgn(s.funding), cls(-s.funding))}
      ${stat('In use / idle', `${usd(s.capitalInUse, 0)} / ${usd(s.capitalIdle, 0)}`)}${stat('Per day · week', `${sgn(s.perDay)} · ${sgn(s.perWeek)}`, cls(s.perDay))}
    </div>` : ''}
    ${r?.drift ? `<p class="gl-warn">The account holds ${(+r.live?.pos || 0).toFixed(2)} HYPE but the bot's books say ${s?.inventory?.toFixed(2)} — something outside the bot traded this account.</p>` : ''}
    ${r?.lastError && !running ? `<p class="gl-warn">${esc(r.lastError)}</p>` : ''}
    ${strip(b, r)}
    <div class="gl-ctl">
      ${running ? `${paused ? `<button data-act="resume" data-b="${b.id}">Resume</button>` : `<button data-act="pause" data-b="${b.id}">Pause</button>`}
        <button data-act="stop" data-b="${b.id}" title="Cancel the bot's orders, keep its HYPE">Stop</button>
        <button data-act="close" data-b="${b.id}" class="danger" title="Cancel the bot's orders and market-close its HYPE">Stop &amp; close</button>`
      : `<button data-act="start" data-b="${b.id}" class="go" ${errs.length || busy.has(b.id) ? 'disabled' : ''}>${busy.has(b.id) ? 'Starting…' : r?.stopped && (s?.inventory ?? 0) > 0 ? 'Start (resume)' : 'Start'}</button>`}
      ${due ? `<button data-act="sweep" data-b="${b.id}" data-amt="${due}">Sweep ${usd(due)}</button>` : ''}
    </div>
    <details class="gl-cfg" ${running ? '' : 'open'}><summary>${running ? 'Settings (stop the bot to edit)' : 'Settings'}</summary>
      <div class="gl-form">
        <label class="wide"><span>Account (agent key)</span><select data-k="account" data-b="${b.id}" ${lock}><option value="">Pick an account…</option>${accts.map(a => `<option value="${a}" ${String(b.account).toLowerCase() === a.toLowerCase() ? 'selected' : ''}>${esc(acctName(a))}</option>`).join('')}</select></label>
        ${f('sub', 'Subaccount (optional)', 'text', 'placeholder="0x… — trades a subaccount of this account" class="mono"')}
        ${f('low', 'Range low $', 'number', 'step="any" min="0"')}${f('high', 'Range high $', 'number', 'step="any" min="0"')}
        ${f('levels', 'Levels', 'number', 'step="1" min="2" max="100"')}${f('usd', 'USD per level', 'number', 'step="any" min="0"')}
        ${f('leverage', 'Leverage', 'number', `step="1" min="1" max="${m?.maxLeverage ?? 10}"`)}
        <label><span>Margin</span><select data-k="margin" data-b="${b.id}" ${lock}><option value="isolated" ${b.margin === 'isolated' ? 'selected' : ''}>Isolated</option><option value="cross" ${b.margin === 'cross' ? 'selected' : ''} ${m?.onlyIsolated ? 'disabled' : ''}>Cross</option></select></label>
        ${f('killPrice', 'Kill price $ (0 = off)', 'number', 'step="any" min="0"')}
        <label class="chk"><input type="checkbox" data-k="sweepEnabled" data-b="${b.id}" ${b.sweepEnabled ? 'checked' : ''} ${lock}><span>Sweep profit every</span><input data-k="sweepDays" data-b="${b.id}" type="number" min="1" step="1" value="${esc(b.sweepDays)}" ${lock} style="width:56px"><span>days</span></label>
      </div>
      ${cap ? `<p class="gl-hint">${+b.levels - 1} pairs · ${sizes.length ? `${Math.min(...sizes)}–${Math.max(...sizes)} HYPE each` : ''} · full grid ${usd(cap.notional, 0)} notional · needs ~${usd(cap.margin, 0)} margin at ${b.leverage}×${b.sweepEnabled && !b.sub ? ' · sweeping works for subaccount bots only (the agent key cannot move funds)' : ''}</p>` : ''}
      ${errs.length ? `<ul class="gl-errs">${errs.map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
    </details>
    ${r?.events?.length ? `<details class="gl-log"><summary>Activity</summary>${r.events.map(e => `<div><time>${new Date(e.time).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time> <em>${esc(e.kind)}</em> ${esc(e.msg)}</div>`).join('')}</details>` : ''}
  </article>`
}

function render() {
  if (!ov) return
  // Not under someone's cursor: a field being edited is redrawn when it loses focus.
  const a = document.activeElement
  if (a && ov.contains(a) && /^(INPUT|SELECT)$/.test(a.tagName)) { ov.dataset.stale = '1'; return }
  delete ov.dataset.stale
  const m = meta[cfg.network]
  const list = cfg.bots.map(rowOf).filter(Boolean)
  const tot = list.length ? ladderStats(list.map(r => r.stats).filter(Boolean)) : null
  const anyRunning = list.some(r => r.running)
  const scroll = ov.querySelector('.gl-body')?.scrollTop ?? 0
  const open = new Set([...ov.querySelectorAll('details[open]')].map(d => d.closest('[data-bot]')?.dataset.bot + ':' + d.className))
  ov.innerHTML = `<div class="gl-sheet" role="dialog" aria-label="Grid Ladder">
    <header class="gl-top">
      <div><h2>Grid Ladder</h2><small>5 long-only HYPE grids, one account each</small></div>
      <div class="gl-net" role="tablist">${['dry', 'testnet', 'mainnet'].map(n => `<button data-net="${n}" class="${cfg.network === n ? 'on' : ''}" ${anyRunning ? 'disabled' : ''}>${n === 'dry' ? 'Dry run' : n === 'testnet' ? 'Testnet' : 'Mainnet'}</button>`).join('')}</div>
      <button class="gl-x" data-close aria-label="Close">×</button>
    </header>
    <div class="gl-body">
      ${note ? `<p class="gl-note">${esc(note)}</p>` : ''}
      ${cfg.network === 'mainnet' ? `<p class="gl-warn">${cfg.mainnetOk ? 'Mainnet is ON — these bots trade real money.' : 'Mainnet is off. Turning it on lets these bots trade real money.'} <button data-mainnet>${cfg.mainnetOk ? 'Turn off' : 'Turn on…'}</button></p>`
        : cfg.network === 'testnet' ? `<p class="gl-hint">Testnet: Hyperliquid's test exchange, test USDC. Each account needs testnet funds, and its agent key approved on testnet: ${masters().map(a => `<button data-approve="${a}">${esc(acctName(a))}</button>`).join(' ') || 'pick accounts below first'}</p>`
        : `<p class="gl-hint">Dry run: the real bot against a simulated account, priced from live mainnet HYPE. No orders leave the server. A dry bot starts fresh each time it starts.</p>`}
      ${tot ? `<section class="gl-tiles">
        ${stat('Net PnL', sgn(tot.net), cls(tot.net))}${stat('Realized', sgn(tot.realized), cls(tot.realized))}${stat('Cycles', tot.cycles)}
        ${stat('Holding', tot.inventory > 0 ? `${tot.inventory.toFixed(2)} @ ${usd(tot.avgEntry, 3)}` : '—')}${stat('Unrealized', sgn(tot.unrealized), cls(tot.unrealized))}
        ${stat('Fees', usd(tot.fees))}${stat('Funding paid', sgn(tot.funding), cls(-tot.funding))}
        ${stat('In use / idle', `${usd(tot.capitalInUse, 0)} / ${usd(tot.capitalIdle, 0)}`)}${stat('Per day · week', `${sgn(tot.perDay)} · ${sgn(tot.perWeek)}`, cls(tot.perDay))}
      </section>` : ''}
      ${ladderSvg(m?.mid)}
      <div class="gl-ctl gl-all">
        <button data-all="start" class="go">Start all</button><button data-all="pause">Pause all</button><button data-all="resume">Resume all</button>
        <button data-all="stop">Stop all</button><button data-all="close" class="danger">Stop &amp; close all</button>
        <button data-fit ${anyRunning || !m ? 'disabled' : ''} title="Shift every range so the ladder is centred on the current price">Centre on $${m?.mid ?? '…'}</button>
        <button data-reset ${anyRunning ? 'disabled' : ''}>Default ladder</button>
      </div>
      ${cfg.bots.map(card).join('')}
      <p class="gl-hint">Each pair buys at one level and sells one level up, post-only, reduce-only sells. A level's sell goes up only after its buy has fully filled. Backtest it on real HYPE data with <code>npm run gridladder-backtest</code>.</p>
    </div></div>`
  for (const d of ov.querySelectorAll('details')) { const k = d.closest('[data-bot]')?.dataset.bot + ':' + d.className; if (open.has(k)) d.open = true }
  const body = ov.querySelector('.gl-body'); if (body) body.scrollTop = scroll
}

function onInput(e) {
  const el = e.target, k = el.dataset?.k, id = +el.dataset?.b
  if (!k || !id) return
  const b = cfg.bots.find(x => x.id === id)
  b[k] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? '' : +el.value) : el.value.trim()
  save()
  if (e.type === 'change') { if (el.tagName === 'SELECT' || el.type === 'checkbox') el.blur(); render() }
}

async function onClick(e) {
  const t = e.target.closest('button'); if (!t) { if (e.target === ov) close(); return }
  const id = +t.dataset.b, b = cfg.bots.find(x => x.id === id)
  if (t.dataset.close !== undefined) return close()
  if (t.dataset.net) { cfg.network = t.dataset.net; save(); note = ''; await loadMeta(cfg.network).catch(() => {}); return refresh() }
  if (t.dataset.mainnet !== undefined) {
    if (cfg.mainnetOk) cfg.mainnetOk = false
    else if (String(await askText({ title: 'Turn on mainnet?', body: 'These bots will place real orders with real money on Hyperliquid mainnet. Type MAINNET to turn it on.', placeholder: 'MAINNET', confirmText: 'Turn on' }) ?? '').trim() === 'MAINNET') cfg.mainnetOk = true
    save(); return render()
  }
  if (t.dataset.approve) return approveTestnet(t.dataset.approve)
  if (t.dataset.fit !== undefined) { const m = meta[cfg.network]; if (m?.mid) { const f = fitLadder(cfg.bots, m.mid); cfg.bots = cfg.bots.map((x, i) => ({ ...x, low: f[i].low, high: f[i].high })); save(); render() } return }
  if (t.dataset.reset !== undefined) { cfg.bots = DEFAULT_LADDER.map((d, i) => ({ ...d, account: cfg.bots[i].account, sub: cfg.bots[i].sub })); save(); return render() }
  if (t.dataset.all) return all(t.dataset.all)
  if (t.dataset.act === 'sweep') return sweep(b, +t.dataset.amt)
  if (t.dataset.act === 'close' && !await ask({ title: `Stop and close bot ${id}?`, body: 'Cancels its orders and market-closes its HYPE position.', confirmText: 'Stop & close', danger: true })) return
  if (t.dataset.act && b) return act(b, t.dataset.act)
}

function close() {
  clearInterval(timer); timer = null
  ov?.remove(); ov = null
  document.removeEventListener('keydown', onKey)
}
const onKey = (e) => { if (e.key === 'Escape') close() }

export function openGridLadder() {
  if (ov) return
  cfg = loadCfg()
  if (!cfg.bots.some(b => b.account)) {
    // First open: the accounts that have agent keys, one per bot, in the order of the user's
    // own wallet list (localStorage's key order is not an order anyone chose).
    const saved = jget('savedWallets', []).map(w => String(w?.addr ?? '').toLowerCase())
    const rank = (x) => { const i = saved.indexOf(x.toLowerCase()); return i < 0 ? 1e9 : i }
    const a = keyedAddresses(localStorage).sort((x, y) => rank(x) - rank(y))
    cfg.bots.forEach((b, i) => { if (a[i]) b.account = a[i] })
  }
  ov = document.createElement('div')
  ov.className = 'gl-ov'
  ov.addEventListener('click', onClick)
  ov.addEventListener('input', onInput)
  ov.addEventListener('change', onInput)
  ov.addEventListener('focusout', () => setTimeout(() => { if (ov?.dataset.stale) render() }, 0))
  document.body.appendChild(ov)
  document.addEventListener('keydown', onKey)
  render()
  loadMeta(cfg.network).then(render).catch(() => {})
  refresh()
  timer = setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 10_000)
}
