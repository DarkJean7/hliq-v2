/**
 * /portfolios → trading it. A few clicks from a tested basket to a running bot.
 *
 * "Trade live" opens a sheet: pick the account, one allocation strategy, a budget; the bot's
 * own preview (POST /api/plan, the strategy run with --plan) says what it would hold and
 * whether the account can carry it; Start launches strategies/portfolio.js on the bot server.
 * "Running" lists the portfolio bots on your accounts, with what each is worth now.
 *
 * Signing in is the app's own: the page shares the app's origin, so the agent key the app saved
 * for an account (src/agentkeys.js) signs the bot-server login here too. An account without a
 * key cannot be traded from here — the sheet says so and sends you to the app to set one up.
 * ethers is loaded only when a sheet is opened.
 *
 * Every decision the bot makes is in src/pflive.js; this file only asks and shows.
 */
import { keyedAddresses, readKey } from './agentkeys.js'
import { LIVE_STRATEGIES, liveWeights, liveArgs, HL_MIN_ORDER } from './pflive.js'

const $ = (id) => document.getElementById(id)
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`
/** The name the user gave the account in the app's wallet list (savedWallets), or its short address. */
function acctName(a) {
  try {
    const k = String(a).toLowerCase()
    const w = (JSON.parse(localStorage.getItem('savedWallets') || '[]') || []).find(x => String(x?.addr).toLowerCase() === k)
    if (w?.label && String(w.label).trim()) return String(w.label).trim()
  } catch {}
  return short(a)
}
const usd = (v) => (v == null || !Number.isFinite(v) ? '—' : (Math.abs(v) >= 1000 ? '$' + Math.round(v).toLocaleString('en-US') : '$' + v.toFixed(2)))
const ls = { get: (k) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }

// ── the bot server, signed in the way the app does it ──
const tokens = {}
async function token(addr) {
  const c = tokens[addr.toLowerCase()]
  if (c && c.exp - 60_000 > Date.now()) return c.token
  const key = readKey(localStorage, addr)
  if (!key) throw new Error('no agent key for this account')
  const { Wallet } = await import('ethers')
  const { nonce } = await (await fetch('/api/auth/nonce')).json()
  if (!nonce) throw new Error('the bot server did not answer')
  const msg = `Insolvent Trade — bot control login\nAccount: ${addr.toLowerCase()}\nNonce: ${nonce}`
  const signature = await new Wallet(key).signMessage(msg)
  const j = await (await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr, nonce, signature }) })).json()
  if (!j.token) throw new Error(j.error || 'sign-in to the bot server failed')
  tokens[addr.toLowerCase()] = { token: j.token, exp: j.exp ?? Date.now() + 11 * 3600_000 }
  return j.token
}
async function api(path, addr, body) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token(addr) }
  // Dev mode is earned by the PIN; the server checks the same PIN on /api/start only.
  if (path === '/api/start' && ls.get('hliq_dev') === '1' && ls.get('hliq_lb_pin')) headers['x-lb-pin'] = ls.get('hliq_lb_pin')
  const r = await fetch(path, body ? { method: 'POST', headers, body: JSON.stringify(body) } : { headers })
  const j = (r.headers.get('content-type') ?? '').includes('json') ? await r.json() : { ok: false, error: (await r.text()).slice(0, 200) || 'the bot server did not answer' }
  return { status: r.status, ...j }
}

/** A stable id for a portfolio: the featured id, or the name of one of yours. */
export function portfolioId(p) {
  if (p.featuredId) return ('F-' + p.featuredId).toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40)
  let h = 5381
  for (const ch of String(p.name ?? '')) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0
  return ('L-' + h.toString(36)).toUpperCase()
}

/**
 * Wire it up.
 *   get(): the portfolio on the page right now —
 *     { name, featuredId, items, strats, lev, margin, params: { monthDay, … as the bot reads them }, labels: { id: label }, nameOf(item) }
 */
export function initTrade(get) {
  let sheet = null, plan = null, busy = false
  const accounts = () => keyedAddresses(localStorage)

  function close() { sheet?.remove(); sheet = null; plan = null; document.removeEventListener('keydown', onKey) }
  const onKey = (e) => { if (e.key === 'Escape') close() }

  function open() {
    close()
    const p = get()
    const { weights, skipped } = liveWeights(p.items)
    const accts = accounts()
    const strat = p.strats.find(s => LIVE_STRATEGIES.includes(s)) ?? 'hold'
    const lastAcct = ls.get('hliq_pf_trade_acct')
    sheet = document.createElement('div')
    sheet.className = 'pf-sheet-bg'
    sheet.innerHTML = `<div class="pf-sheet" role="dialog" aria-modal="true" aria-labelledby="pfTradeH">
      <div class="pf-sheet-h"><h3 id="pfTradeH">Trade “${esc(p.name)}” live</h3><button class="pf-sheet-x" data-x aria-label="Close">×</button></div>
      ${!accts.length ? `<p class="pf-help">No account on this device has an agent key yet. Open the app, connect your wallet and set one up under <b>Bots</b>; then come back here.</p>
        <a class="pf-btn" href="/app">Open the app</a>` : `
      <label class="pf-tr-row"><span>Account</span><select id="pfTrAcct">${accts.map(a => `<option value="${a}" ${a === lastAcct ? 'selected' : ''} title="${a}">${esc(acctName(a))}${acctName(a) === short(a) ? '' : ' · ' + short(a)}</option>`).join('')}</select></label>
      <div class="pf-tr-row"><span>Strategy</span><div class="pf-chips pf-strats" id="pfTrStrat">${LIVE_STRATEGIES.map(s => `<button data-s="${s}" class="${s === strat ? 'is-on' : ''}">${esc(p.labels[s] ?? s)}</button>`).join('')}</div></div>
      <p class="pf-help" id="pfTrStratNote"></p>
      <label class="pf-tr-row" id="pfTrBuysRow" hidden><span>Buys</span><span class="pf-tr-in"><input id="pfTrBuys" type="number" min="1" max="52" step="1" value="8"> parts</span></label>
      <label class="pf-tr-row"><span>Budget</span><span class="pf-tr-in"><input id="pfTrBudget" type="number" min="${HL_MIN_ORDER}" step="10" value="${esc(ls.get('hliq_pf_trade_budget') ?? '100')}"> USDC</span></label>
      <p class="pf-help">The money the bot manages: it buys the weights with it${p.lev === 'max' || Number(p.lev) > 1 ? `, at ${p.lev === 'max' ? 'each market\'s maximum leverage' : p.lev + '× (capped per market)'} ${p.margin === 'isolated' ? 'isolated' : 'cross'}` : ''}, and rebalances inside it. Leverage and margin come from <b>Account</b> above.</p>
      ${skipped.length ? `<p class="pf-warn">Spot holdings are skipped (bots cannot trade spot yet), their weight spread over the rest: ${skipped.map(c => esc(p.nameOf({ coin: c }))).join(', ')}.</p>` : ''}
      ${!Object.keys(weights).length ? '<p class="pf-warn">Nothing here a bot can trade.</p>' : ''}
      <div class="pf-tr-plan" id="pfTrPlan"><button class="pf-btn pf-btn--ghost" id="pfTrPreview">Preview</button></div>
      <label class="pf-check pf-tr-ack"><input type="checkbox" id="pfTrAck"> I understand this places real orders on Hyperliquid with this account.</label>
      <div class="pf-tr-go"><button class="pf-btn" id="pfTrStart" disabled>Start</button><span class="pf-help" id="pfTrMsg"></span></div>`}
    </div>`
    document.body.appendChild(sheet)
    document.addEventListener('keydown', onKey)
    sheet.addEventListener('click', onClick)
    sheet.addEventListener('change', e => { if (e.target.id === 'pfTrAcct' || e.target.id === 'pfTrBudget' || e.target.id === 'pfTrBuys') { if (plan) { plan = null; renderPlan() } } if (e.target.id === 'pfTrAck') gate() })
    stratNote()
    sheet.querySelector('#pfTrPreview, [data-x]')?.focus()
  }

  const chosen = () => sheet?.querySelector('#pfTrStrat .is-on')?.dataset.s ?? 'hold'
  function stratNote() {
    const el = sheet?.querySelector('#pfTrStratNote'); if (!el) return
    const p = get(), s = chosen(), q = p.params
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][q.weekDay] ?? 'Monday'
    el.textContent = {
      hold: 'Buys the weights once and holds them.',
      monthly: `Rebalances on day ${q.monthDay} of every month (UTC).`,
      weekly: `Rebalances every ${day} (UTC).`,
      band: `Rebalances when a holding drifts more than ${Math.round(q.band * 100)} points from its weight; checked daily.`,
      dca: `Buys one part every ${q.dcaEvery} days${q.dcaUpfront ? `, ${Math.round(q.dcaUpfront * 100)}% up front` : ''}.`,
      trend: `Holds each market while it is above its ${q.trendDays}-day average${q.trendBuffer ? ` (${(q.trendBuffer * 100).toFixed(1)}% buffer)` : ''}; cash otherwise. Checked daily.`,
    }[s] + ' Its settings are the ones on its card under Allocation strategies.'
    // A backtest spreads DCA over its window; a live run has no end date, so it needs a count.
    const buys = sheet.querySelector('#pfTrBuysRow')
    if (buys) buys.hidden = s !== 'dca'
  }
  const gate = () => {
    const b = sheet?.querySelector('#pfTrStart'); if (!b) return
    b.disabled = busy || !plan?.ok || !sheet.querySelector('#pfTrAck')?.checked || (plan.tooSmall?.length > 0)
  }
  const msg = (t, bad = false) => { const m = sheet?.querySelector('#pfTrMsg'); if (m) { m.textContent = t; m.classList.toggle('pf-warn', bad) } }

  function args(fresh) {
    const p = get()
    const buys = Math.max(1, Math.min(52, Math.round(Number(sheet.querySelector('#pfTrBuys')?.value) || 8)))
    return liveArgs({ id: portfolioId(p), name: p.name, items: p.items, strategy: chosen(), params: { ...p.params, dcaBuys: buys },
      budget: Number(sheet.querySelector('#pfTrBudget').value), lev: p.lev, margin: p.margin, fresh })
  }

  function renderPlan() {
    const el = sheet?.querySelector('#pfTrPlan'); if (!el) return
    if (!plan) { el.innerHTML = '<button class="pf-btn pf-btn--ghost" id="pfTrPreview">Preview</button>'; gate(); return }
    if (!plan.ok) { el.innerHTML = `<p class="pf-warn">${esc(plan.error ?? 'no preview')}</p><button class="pf-btn pf-btn--ghost" id="pfTrPreview">Try again</button>`; gate(); return }
    const p = get()
    const under = plan.free != null && plan.free < plan.margin
    el.innerHTML = `<table class="pf-tr-tbl"><thead><tr><th>Market</th><th>Weight</th><th>Leverage</th><th>Position</th></tr></thead><tbody>
      ${plan.rows.map(r => `<tr><td>${esc(p.nameOf({ coin: r.coin }))}${r.w < 0 ? ' <em>short</em>' : ''}</td><td>${(Math.abs(r.w) * 100).toFixed(1)}%</td><td>${r.lev}×${r.isolated ? ' iso' : ''}</td><td>${usd(r.usd)}</td></tr>`).join('')}
      </tbody></table>
      ${plan.tooSmall?.length ? `<p class="pf-warn">Under Hyperliquid's $${HL_MIN_ORDER} minimum order: ${plan.tooSmall.map(c => esc(p.nameOf({ coin: c }))).join(', ')}. Raise the budget.</p>` : ''}
      ${plan.missing?.length ? `<p class="pf-warn">No price right now for ${plan.missing.map(c => esc(p.nameOf({ coin: c }))).join(', ')}; the bot waits for one before trading.</p>` : ''}
      <p class="pf-help">Margin used: about ${usd(plan.margin)}. ${plan.free != null ? `Free on this account: ${usd(plan.free)}.` : ''}</p>
      ${under ? '<p class="pf-warn">The account has less free than the budget: some orders may be refused. Deposit, or lower the budget.</p>' : ''}
      ${plan.resumes ? `<label class="pf-check"><input type="checkbox" id="pfTrCarry" checked> Carry on from the positions it left last time (${Object.keys(plan.held ?? {}).length}); off starts a new ledger and buys everything again.</label>` : ''}`
    gate()
  }

  async function onClick(e) {
    if (e.target === sheet || e.target.closest('[data-x]')) return close()
    const s = e.target.closest('#pfTrStrat [data-s]')
    if (s) { sheet.querySelectorAll('#pfTrStrat [data-s]').forEach(b => b.classList.toggle('is-on', b === s)); plan = null; stratNote(); renderPlan(); return }
    const addr = sheet.querySelector('#pfTrAcct')?.value
    if (e.target.closest('#pfTrPreview')) {
      const budget = Number(sheet.querySelector('#pfTrBudget').value)
      if (!(budget >= HL_MIN_ORDER)) { plan = { ok: false, error: `The budget must be at least $${HL_MIN_ORDER}.` }; return renderPlan() }
      ls.set('hliq_pf_trade_acct', addr); ls.set('hliq_pf_trade_budget', String(budget))
      const el = sheet.querySelector('#pfTrPlan'); el.innerHTML = '<p class="pf-help">Asking the bot…</p>'
      try { const r = await api('/api/plan', addr, { type: 'portfolio', agentKey: readKey(localStorage, addr), address: addr, args: args(false) }); plan = r.ok === false || r.status >= 400 ? { ok: false, error: r.error } : r }
      catch (err) { plan = { ok: false, error: err.message } }
      return renderPlan()
    }
    if (e.target.closest('#pfTrStart') && plan?.ok && !busy) {
      busy = true; gate(); msg('Starting…')
      const fresh = plan.resumes ? !sheet.querySelector('#pfTrCarry')?.checked : false
      try {
        const r = await api('/api/start', addr, { type: 'portfolio', agentKey: readKey(localStorage, addr), address: addr, instance: portfolioId(get()), args: args(fresh) })
        if (r.status === 402) msg('Server bots need a subscription. Subscribe in the app, under Bots.', true)
        else if (!r.ok) msg(r.error ?? 'did not start', true)
        else { msg('Running.'); setTimeout(() => { close(); refresh() }, 900) }
      } catch (err) { msg(err.message, true) }
      busy = false; gate()
    }
  }

  // ── running portfolio bots, on every account with a key ──
  let live = []
  async function refresh() {
    const el = $('pfLive'); if (!el) return
    const accts = accounts()
    if (!accts.length) { live = []; return render() }
    const out = []
    await Promise.all(accts.map(async a => {
      try {
        const s = await (await fetch('/api/status?address=' + a)).json()
        for (const [k, c] of Object.entries(s._configs ?? {})) {
          if (c.type !== 'portfolio') continue
          out.push({ addr: a, id: c.instance, paused: !!s._paused?.[k], st: s._portfolios?.[c.instance] ?? null, args: c.args })
        }
      } catch { /* the server did not answer for this account: it is left out, not shown as stopped */ }
    }))
    live = out.sort((x, y) => (x.st?.name ?? x.id).localeCompare(y.st?.name ?? y.id))
    render()
  }
  function render() {
    const sec = $('pfLiveSec'), el = $('pfLive'); if (!sec || !el) return
    sec.hidden = !live.length
    el.innerHTML = live.map(b => {
      const st = b.st, ret = st?.equity != null && st.budget ? st.equity / st.budget - 1 : null
      const strat = get().labels[st?.strategy] ?? st?.strategy ?? ''
      return `<div class="pf-live-card">
        <div class="pf-live-top"><b>${esc(st?.name ?? b.id)}</b><small>${esc(strat)} · ${esc(acctName(b.addr))}${b.paused ? ' · <span class="pf-warn">paused</span>' : ''}</small></div>
        <div class="pf-live-ret ${ret == null ? '' : ret >= 0 ? 'up' : 'dn'}">${ret == null ? '—' : (ret >= 0 ? '+' : '') + (ret * 100).toFixed(2) + '%'}</div>
        <div class="pf-live-sub">${usd(st?.equity)} of ${usd(st?.budget)} · ${Object.keys(st?.units ?? {}).length} positions · fees ${usd(st?.fees)}</div>
        <div class="pf-live-sub">${esc(st?.reason ?? 'starting…')}</div>
        <div class="pf-live-btns"><button class="pf-btn pf-btn--ghost" data-live="${b.paused ? 'resume' : 'pause'}" data-a="${b.addr}" data-i="${esc(b.id)}">${b.paused ? 'Resume' : 'Pause'}</button>
          <button class="pf-btn pf-btn--ghost" data-live="stop" data-a="${b.addr}" data-i="${esc(b.id)}">Stop</button></div>
      </div>`
    }).join('')
  }
  $('pfLive')?.addEventListener('click', async e => {
    const b = e.target.closest('[data-live]'); if (!b) return
    const act = b.dataset.live
    if (act === 'stop' && b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Stop? Positions stay open'; return }
    b.disabled = true
    try {
      const r = await api('/api/' + act, b.dataset.a, { type: 'portfolio', address: b.dataset.a, instance: b.dataset.i })
      if (!r.ok) throw new Error(r.error ?? 'refused')
    } catch (err) { b.textContent = err.message.slice(0, 40); return }
    refresh()
  })
  $('pfTrade')?.addEventListener('click', open)
  refresh()
  setInterval(() => { if (!document.hidden) refresh() }, 30_000)
  return { open, refresh }
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
