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
 * PAPER. "Paper" in the account list runs the same bot on a paper account made for it, with
 * the budget as its balance — no wallet needed, no money at risk (src/paperexchange.js). The
 * account is the device's paper owner's (src/papersync.js), so it appears in the app's paper
 * accounts; while the bot runs it, only the bot trades it. Paper bots are controlled with the
 * owner's secret (/api/paper/*), not an agent key.
 *
 * Every decision the bot makes is in src/pflive.js; this file only asks and shows.
 */
import { keyedAddresses, readKey } from './agentkeys.js'
import { LIVE_STRATEGIES, liveWeights, liveArgs, HL_MIN_ORDER } from './pflive.js'
import { SIGNAL_STRATEGIES } from './pfsignal.js'
import { startPaperSync } from './papersync.js'
import { PAPER_START, paperAcctCreate, paperAcctTag, paperAcctDelete, paperAcctName, paperAcctBot, paperAccounts, paperPeek, paperWithdrawable, paperBind, paperStore, paperSave, paperDeposit, paperWithdraw } from './paper.js'

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

// ── paper: the device's paper owner and its bots ──
// Paper accounts in the picker are "paper:<slot>", and "paper:new" makes one.
const PAPER = 'paper:', PAPER_NEW = 'paper:new'
/**
 * The device's paper accounts a bot may run: each with what it has free (cash less margin in
 * use; open positions' profit is not counted here, the page has no prices for it) and whether a
 * bot already runs it. The Challenge account is left out: it is a contest, not a test bench.
 */
function paperList() {
  const out = []
  for (const a of paperAccounts()) {
    if (a.slot === 'challenge') continue
    const name = a.slot === 'main' ? (ls.get('hliq_paper_name') || 'Practice account') : (a.name || 'Paper account')
    let free = null
    try { free = paperPeek(a.slot, () => paperWithdrawable()) } catch {}
    out.push({ slot: a.slot, name, free, bot: paperAcctBot(a.slot) })
  }
  return out
}
let psync = null
const paperSync = () => (psync ??= startPaperSync({ holdKey: () => null }))
const paperSecret = () => ls.get('hliq_paper_owner')
/** The paper owner's bot address: 0x + the first 40 hex of sha256(secret), as the server makes it. */
async function paperOwnerAddr() {
  const sec = paperSecret()
  if (!/^[0-9a-f]{64}$/.test(sec ?? '')) return null
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sec))
  return '0x' + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 40)
}
async function paperApi(act, body) {
  const r = await fetch('/api/paper/' + act, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ secret: paperSecret(), ...body }) })
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
    // The strategy the page is testing: a trading one if one is picked, else the first allocation one.
    const bot = p.bots.find(b => SIGNAL_STRATEGIES.includes(b))
    const strat = bot ? 'bot:' + bot : (p.strats.find(s => LIVE_STRATEGIES.includes(s)) ?? 'hold')
    const chip = (v, l) => `<button data-s="${v}" class="${v === strat ? 'is-on' : ''}">${esc(l)}</button>`
    const stored = ls.get('hliq_pf_trade_acct')
    const lastAcct = stored === 'paper' ? PAPER_NEW : (stored ?? (accts.length ? accts[0] : PAPER_NEW))
    const papers = paperList()
    sheet = document.createElement('div')
    sheet.className = 'pf-sheet-bg'
    sheet.innerHTML = `<div class="pf-sheet" role="dialog" aria-modal="true" aria-labelledby="pfTradeH">
      <div class="pf-sheet-h"><h3 id="pfTradeH">Trade “${esc(p.name)}” live</h3><button class="pf-sheet-x" data-x aria-label="Close">×</button></div>
      <label class="pf-tr-row"><span>Account</span><select id="pfTrAcct">${accts.map(a => `<option value="${a}" ${a === lastAcct ? 'selected' : ''} title="${a}">${esc(acctName(a))}${acctName(a) === short(a) ? '' : ' · ' + short(a)}</option>`).join('')}<optgroup label="Paper · simulated money">${papers.map(a => `<option value="${PAPER}${esc(a.slot)}" ${lastAcct === PAPER + a.slot ? 'selected' : ''} ${a.bot ? 'disabled' : ''}>${esc(a.name)}${a.free != null ? ' · ' + usd(a.free) + ' free' : ''}${a.bot ? ' · a bot runs it' : ''}</option>`).join('')}<option value="${PAPER_NEW}" ${lastAcct === PAPER_NEW ? 'selected' : ''}>New paper account…</option></optgroup></select></label>
      <label class="pf-tr-row" id="pfTrStartBalRow" hidden><span>Starting balance</span><span class="pf-tr-in"><input id="pfTrStartBal" type="number" min="${HL_MIN_ORDER}" step="100" value="${esc(ls.get('hliq_pf_trade_startbal') ?? String(PAPER_START))}"> USDC</span></label>
      ${accts.length ? '' : '<p class="pf-help">To trade with real money, open <a href="/app">the app</a>, connect your wallet and set up an agent key under <b>Bots</b>. Paper needs none.</p>'}
      <p class="pf-help" id="pfTrPaperNote" hidden></p>
      <div class="pf-tr-row pf-tr-strats" id="pfTrStrat"><span>Strategy</span>
        <div><i class="pf-for">Allocation</i><div class="pf-chips pf-strats">${LIVE_STRATEGIES.map(s => chip(s, p.labels[s] ?? s)).join('')}</div>
        <i class="pf-for">Trading</i><div class="pf-chips pf-strats">${SIGNAL_STRATEGIES.map(b => chip('bot:' + b, p.labels['bot:' + b] ?? b)).join('')}</div></div></div>
      <p class="pf-help" id="pfTrStratNote"></p>
      <label class="pf-tr-row" id="pfTrBuysRow" hidden><span>Buys</span><span class="pf-tr-in"><input id="pfTrBuys" type="number" min="1" max="52" step="1" value="8"> parts</span></label>
      <label class="pf-tr-row"><span>Budget</span><span class="pf-tr-in"><input id="pfTrBudget" type="number" min="${HL_MIN_ORDER}" step="10" value="${esc(ls.get('hliq_pf_trade_budget') ?? '100')}"> USDC</span></label>
      <p class="pf-help">The money the bot manages, split over the holdings by weight. Leverage ${p.lev === 'max' ? 'at each market\'s maximum' : p.lev + '× (capped per market)'}, ${p.margin === 'isolated' ? 'isolated' : 'cross'}: from <b>Account</b> above.</p>
      ${skipped.length ? `<p class="pf-warn">A spot holding cannot be short, so these are skipped and their weight spread over the rest: ${skipped.map(c => esc(p.nameOf({ coin: c }))).join(', ')}.</p>` : ''}
      ${!Object.keys(weights).length ? '<p class="pf-warn">Nothing here a bot can trade.</p>' : ''}
      <div class="pf-tr-plan" id="pfTrPlan"><button class="pf-btn pf-btn--ghost" id="pfTrPreview">Preview</button></div>
      <label class="pf-check pf-tr-ack"><input type="checkbox" id="pfTrAck"> <span id="pfTrAckText"></span></label>
      <div class="pf-tr-go"><button class="pf-btn" id="pfTrStart" disabled>Start</button><span class="pf-help" id="pfTrMsg"></span></div>
    </div>`
    document.body.appendChild(sheet)
    document.addEventListener('keydown', onKey)
    sheet.addEventListener('click', onClick)
    sheet.addEventListener('change', e => {
      if (e.target.id === 'pfTrAcct' || e.target.id === 'pfTrBudget' || e.target.id === 'pfTrBuys' || e.target.id === 'pfTrStartBal') { if (plan) { plan = null; renderPlan() } }
      if (e.target.id === 'pfTrAcct') acctNote()
      if (e.target.id === 'pfTrAck') gate()
    })
    stratNote()
    acctNote()
    sheet.querySelector('#pfTrPreview, [data-x]')?.focus()
  }

  const chosen = () => sheet?.querySelector('#pfTrStrat .is-on')?.dataset.s ?? 'hold'
  const acctVal = () => sheet?.querySelector('#pfTrAcct')?.value ?? ''
  const isPaperAcct = () => acctVal().startsWith(PAPER)
  const startBal = () => Number(sheet?.querySelector('#pfTrStartBal')?.value)
  // What Start does, said where it is ticked: real orders, or a simulated account.
  function acctNote() {
    if (!sheet) return
    const paper = isPaperAcct()
    const fresh = acctVal() === PAPER_NEW
    const n = sheet.querySelector('#pfTrPaperNote')
    if (n) {
      n.hidden = !paper
      n.textContent = fresh
        ? 'A new paper account with the starting balance below; the bot trades the budget out of it. It keeps running with this page closed, and you can follow it in the app under that paper account.'
        : 'The bot trades the budget out of this paper account; what else it holds stays as it is. While the bot runs, the account is the bot\'s: stop the bot to trade it by hand again.'
    }
    const sb = sheet.querySelector('#pfTrStartBalRow'); if (sb) sb.hidden = !fresh
    const a = sheet.querySelector('#pfTrAckText')
    if (a) a.textContent = paper ? `I understand this is a paper run: simulated money on ${fresh ? 'a new paper account' : 'this paper account'}, at live prices.` : 'I understand this places real orders on Hyperliquid with this account.'
    const ack = sheet.querySelector('#pfTrAck'); if (ack) ack.checked = false
    gate()
  }
  function stratNote() {
    const el = sheet?.querySelector('#pfTrStratNote'); if (!el) return
    const p = get(), s = chosen(), q = p.params
    const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][q.weekDay] ?? 'Monday'
    if (s.startsWith('bot:')) {
      el.textContent = `Each holding is its own sub-account with its weight of the budget, trading ${p.both ? 'both directions' : 'only in its own direction'} on ${p.tf === '1d' ? 'daily' : p.tf === '1h' ? '1-hour' : '4-hour'} candles: the bot replays the backtest's own engine on every closed candle and copies the trade it is in. Stops and targets rest on Hyperliquid as trigger orders (on spot, which cannot carry them, the bot watches them itself). Spot is long only, at 1×. A trade the strategy is already in when you start is not joined; the bot waits for the next entry. Its settings are the ones on its card under Trading strategies.`
      const buys = sheet.querySelector('#pfTrBuysRow'); if (buys) buys.hidden = true
      return
    }
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
      budget: Number(sheet.querySelector('#pfTrBudget').value), lev: p.lev, margin: p.margin, fresh,
      tf: p.tf, both: p.both, sparams: chosen().startsWith('bot:') ? (p.botParams?.[chosen().slice(4)] ?? {}) : null })
  }

  // What a preview was made FOR: the bot's arguments, less the two that differ every call by
  // design (a run id, and carry-on vs fresh). Start compares against it, so a run can never
  // go out with settings the preview did not show — a portfolio previewed at 5× and started
  // at 3× bought 40% less than the table said.
  function sigOf(a) {
    const out = []
    for (let i = 0; i < a.length; i++) {
      if (a[i] === '--run') { i++; continue }
      if (a[i] === '--fresh') continue
      out.push(a[i])
    }
    return JSON.stringify(out)
  }
  const stale = () => !plan?.sig || plan.sig !== sigOf(args(false))
  function refuseStale() {
    plan = null; renderPlan()
    msg('The portfolio’s settings changed since this preview (leverage, holdings or strategy settings). Preview again to see what will be bought.', true)
  }

  function renderPlan() {
    const el = sheet?.querySelector('#pfTrPlan'); if (!el) return
    if (!plan) { el.innerHTML = '<button class="pf-btn pf-btn--ghost" id="pfTrPreview">Preview</button>'; gate(); return }
    if (!plan.ok) { el.innerHTML = `<p class="pf-warn">${esc(plan.error ?? 'no preview')}</p><button class="pf-btn pf-btn--ghost" id="pfTrPreview">Try again</button>`; gate(); return }
    const p = get()
    // A real account posts perp margin from the perp side and pays for spot from the SPOT balance;
    // a paper account has one pool of cash for both.
    const under = plan.free != null && plan.free < (plan.margin ?? 0) + (plan.paper ? (plan.spotNeed ?? 0) : 0)
    const spotShort = !plan.paper && plan.spotNeed > 0 && plan.spotFree != null && plan.spotFree < plan.spotNeed
    // DCA reaches the Position only after its LAST buy. Showing that one number read as "it will
    // buy $454 now" — reported as "it did not buy the supposed amount" when the first buy was 1/8
    // of it. So DCA shows what each buy adds, then where it ends up.
    const dca = chosen() === 'dca'
    const nBuys = Math.max(1, Math.min(52, Math.round(Number(sheet.querySelector('#pfTrBuys')?.value) || 8)))
    const up = Math.min(1, Math.max(0, Number(p.params?.dcaUpfront) || 0))
    const first = up + (1 - up) / nBuys, later = (1 - up) / nBuys
    const dcaHead = dca ? `<th>First buy</th>${nBuys > 1 ? `<th>Each later buy</th>` : ''}<th>After all ${nBuys}</th>` : '<th>Position</th>'
    const dcaCells = r => dca ? `<td>${usd(r.usd * first)}</td>${nBuys > 1 ? `<td>${usd(r.usd * later)}</td>` : ''}<td>${usd(r.usd)}</td>` : `<td>${usd(r.usd)}</td>`
    el.innerHTML = `${dca ? `<p class="pf-help">DCA buys in ${nBuys} parts, one every ${Number(p.params?.dcaEvery) || 7} days${up ? `, with ${Math.round(up * 100)}% of the budget in the first` : ''}: the first buy is ${(first * 100).toFixed(1)}% of each position, each later one ${(later * 100).toFixed(1)}%. Positions reach the last column only after the final buy.</p>` : ''}<table class="pf-tr-tbl"><thead><tr><th>Market</th><th>Weight</th><th>Leverage</th>${dcaHead}${plan.rows.some(r => 'now' in r) ? '<th>Now</th>' : ''}</tr></thead><tbody>
      ${plan.rows.map(r => `<tr><td>${esc(p.nameOf({ coin: r.coin }))}${r.w < 0 ? ' <em>short</em>' : ''}</td><td>${(Math.abs(r.w) * 100).toFixed(1)}%</td><td>${r.spot ? '1× spot' : `${r.lev}×${r.isolated ? ' iso' : ''}`}</td>${dcaCells(r)}${'now' in r ? `<td>${r.now === undefined ? '—' : r.now ? `in a ${r.now.side} since ${new Date(r.now.since).toISOString().slice(5, 16).replace('T', ' ')}: waits for the next entry` : 'waiting for an entry'}</td>` : ''}</tr>`).join('')}
      </tbody></table>
      ${plan.tooSmall?.length ? tooSmallHtml(p) : ''}
      ${plan.missing?.length ? `<p class="pf-warn">No price right now for ${plan.missing.map(c => esc(p.nameOf({ coin: c }))).join(', ')}; the bot waits for one before trading.</p>` : ''}
      <p class="pf-help">${plan.margin > 0 ? `Perp margin: about ${usd(plan.margin)}${dca ? ` once fully invested (${usd(plan.margin * first)} after the first buy)` : ''}. ` : ''}${plan.spotNeed > 0 ? `Spot, paid in full: about ${usd(plan.spotNeed)}${dca ? ` once fully invested` : ''}. ` : ''}${plan.free != null ? `Free on this account: ${usd(plan.free)}.` : ''}</p>
      ${under ? '<p class="pf-warn">The account has less free than this needs: some orders may be refused. Deposit, or lower the budget.</p>' : ''}
      ${spotShort ? `<p class="pf-warn">Spot is bought with the USDC in your SPOT balance: about ${usd(plan.spotNeed)} needed, ${usd(plan.spotFree)} there. Move USDC from perps to spot in the app first — the bot's agent key cannot move funds, so those buys would be refused.</p>` : ''}
      ${plan.resumes ? `<label class="pf-check"><input type="checkbox" id="pfTrCarry" checked> Carry on from the positions it left last time (${Object.keys(plan.held ?? {}).length}); off starts a new ledger and buys everything again.</label>` : ''}`
    gate()
  }

  /**
   * Why Start is off when an order is too small, with the fix one click away. Hyperliquid's
   * minimum is on an order's VALUE (size × price), whatever margin backs it: leverage makes the
   * same margin a bigger order, which is why the Position column, at leverage, can look fine
   * while each DCA buy — a slice of it — is not.
   */
  function smallest() {
    const p = get(), dca = chosen() === 'dca'
    const up = dca ? Math.min(1, Math.max(0, Number(p.params.dcaUpfront) || 0)) : 1
    const n = dca ? Math.max(1, Math.round(Number(sheet.querySelector('#pfTrBuys')?.value) || 8)) : 1
    // The smallest order there will be: a whole position, or one DCA buy after any up-front part.
    const part = (k) => (dca ? (up >= 1 ? 1 : (1 - up) / k) : 1)
    const minPos = Math.min(...plan.rows.map(r => r.usd))
    const budget = Number(sheet.querySelector('#pfTrBudget').value)
    const order = minPos * part(n)
    const needBudget = Math.ceil(budget * HL_MIN_ORDER / order / 10) * 10
    let maxBuys = 0
    if (dca && up < 1) for (let k = n - 1; k >= 1; k--) if (minPos * part(k) >= HL_MIN_ORDER) { maxBuys = k; break }
    return { dca, n, order, needBudget, maxBuys, lev: plan.rows.find(r => r.usd === minPos)?.lev ?? 1 }
  }
  function tooSmallHtml(p) {
    const x = smallest()
    const names = plan.tooSmall.map(c => esc(p.nameOf({ coin: c }))).join(', ')
    const what = x.dca
      ? `In ${x.n} buys, each buy of the smallest holding is an order of about ${usd(x.order)} (about ${usd(x.order / x.lev)} of margin at ${x.lev}×).`
      : `The smallest position is an order of about ${usd(x.order)}.`
    return `<p class="pf-warn">${what} Hyperliquid refuses orders under $${HL_MIN_ORDER} of value — size × price, whatever the margin — so these would never be placed: ${names}.</p>
      <div class="pf-tr-fix"><button class="pf-btn pf-btn--ghost" data-fix="budget:${x.needBudget}">Use a $${x.needBudget.toLocaleString('en-US')} budget</button>${x.maxBuys ? `<button class="pf-btn pf-btn--ghost" data-fix="buys:${x.maxBuys}">Use ${x.maxBuys} buy${x.maxBuys === 1 ? '' : 's'}</button>` : ''}</div>`
  }

  async function onClick(e) {
    // A fix from the too-small message: set it and preview again.
    const fix = e.target.closest('[data-fix]')
    if (fix) {
      const [k, v] = fix.dataset.fix.split(':')
      const input = sheet.querySelector(k === 'budget' ? '#pfTrBudget' : '#pfTrBuys')
      if (input) input.value = v
      if (k === 'budget' && acctVal() === PAPER_NEW && startBal() < Number(v)) sheet.querySelector('#pfTrStartBal').value = v
      plan = null
      renderPlan()
      sheet.querySelector('#pfTrPreview')?.click()
      return
    }
    if (e.target === sheet || e.target.closest('[data-x]')) return close()
    const s = e.target.closest('#pfTrStrat [data-s]')
    if (s) { sheet.querySelectorAll('#pfTrStrat [data-s]').forEach(b => b.classList.toggle('is-on', b === s)); plan = null; stratNote(); renderPlan(); return }
    const addr = sheet.querySelector('#pfTrAcct')?.value
    if (e.target.closest('#pfTrPreview')) {
      const budget = Number(sheet.querySelector('#pfTrBudget').value)
      if (!(budget >= HL_MIN_ORDER)) { plan = { ok: false, error: `The budget must be at least $${HL_MIN_ORDER}.` }; return renderPlan() }
      ls.set('hliq_pf_trade_acct', addr); ls.set('hliq_pf_trade_budget', String(budget))
      const el = sheet.querySelector('#pfTrPlan'); el.innerHTML = '<p class="pf-help">Asking the bot…</p>'
      try {
        // Paper: the bot's preview on a paper account (a blank one — the real one is made at Start,
        // funded with exactly the budget, so there is no "free" to compare against).
        let r
        if (isPaperAcct()) {
          // The server's copy is what the bot will trade: bring it up to date first.
          await paperSync().syncNow()
          const sel = addr.slice(PAPER.length)
          if (sel === 'new' && !(startBal() >= budget)) throw new Error('The starting balance must be at least the budget.')
          r = await paperApi('plan', { slot: sel === 'new' ? 'preview' : sel, args: args(true) })
          // A new account has exactly its starting balance free; an existing one, what the server says.
          if (r.ok !== false && r.status < 400) r = { ...r, free: sel === 'new' ? startBal() : r.free, resumes: false, paper: true }
        } else r = await api('/api/plan', addr, { type: 'portfolio', agentKey: readKey(localStorage, addr), address: addr, args: args(false) })
        plan = r.ok === false || r.status >= 400 ? { ok: false, error: r.error } : { ...r, sig: sigOf(args(false)) }
      } catch (err) { plan = { ok: false, error: err.message } }
      return renderPlan()
    }
    if (e.target.closest('#pfTrStart') && plan?.ok && !busy && stale()) return refuseStale()
    if (e.target.closest('#pfTrStart') && plan?.ok && !busy && isPaperAcct()) {
      busy = true; gate(); msg('Making the paper account…')
      try { await startPaper(addr.slice(PAPER.length)); msg('Running on paper.'); setTimeout(() => { close(); refresh() }, 900) }
      catch (err) { msg(err.message, true) }
      busy = false; gate()
      return
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

  // A paper run: on a paper account you pick, or a new one named after the portfolio and funded
  // with the starting balance. Tagged as the bot's, up to the server, then the bot.
  async function startPaper(sel) {
    const sync = paperSync()
    const inst = portfolioId(get())
    let slot, undo
    if (sel === 'new') {
      const bal = startBal()
      ls.set('hliq_pf_trade_startbal', String(bal))
      const made = paperAcctCreate(('PF · ' + get().name).slice(0, 24))
      slot = made.slot
      if (!slot) throw new Error(made.error === 'limit' ? 'This device has the most paper accounts it can hold. Delete one in the app first.' : 'The paper account could not be made (browser storage is full).')
      undo = async () => { paperAcctTag(slot, null); paperAcctDelete(slot); await sync.syncNow() }
      paperAcctTag(slot, inst)
      paperBind(slot)
      paperStore()
      if (bal > PAPER_START) paperDeposit(bal - PAPER_START)
      else if (bal < PAPER_START) paperWithdraw(PAPER_START - bal)
      else paperSave()
      paperBind('main')
    } else {
      slot = sel
      if (paperAcctBot(slot)) throw new Error('A bot already runs that paper account.')
      undo = async () => { paperAcctTag(slot, null); await sync.syncNow() }
      paperAcctTag(slot, inst)
    }
    await sync.syncNow()
    if (sync.state().online !== true) { await undo(); throw new Error('The server could not be reached; nothing was started.') }
    const r = await paperApi('start', { slot, instance: inst, args: args(true) })
    if (!r.ok) { await undo(); throw new Error(r.error ?? 'did not start') }
  }

  // ── running portfolio bots, on every account with a key ──
  let live = []
  async function refresh() {
    const el = $('pfLive'); if (!el) return
    const accts = accounts()
    const out = []
    const paperAddr = await paperOwnerAddr()
    await Promise.all([...accts, ...(paperAddr ? [paperAddr] : [])].map(async a => {
      try {
        const s = await (await fetch('/api/status?address=' + a)).json()
        for (const [k, c] of Object.entries(s._configs ?? {})) {
          if (c.type !== 'portfolio') continue
          const pi = (c.args ?? []).indexOf('--paper')
          out.push({ addr: a, id: c.instance, paused: !!s._paused?.[k], st: s._portfolios?.[c.instance] ?? null, args: c.args, paper: a === paperAddr ? (c.args?.[pi + 1] ?? '') : null })
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
      const argOf = k => { const i = (b.args ?? []).indexOf(k); return i >= 0 ? b.args[i + 1] : null }
      const lev = argOf('--leverage'), mg = argOf('--margin')
      const levTxt = lev ? ` · ${lev === 'max' ? 'max' : lev + '×'}${mg === 'isolated' ? ' isolated' : ''}` : ''
      return `<div class="pf-live-card">
        <div class="pf-live-top"><b>${b.paper != null ? '<span class="pf-paper-tag">PAPER</span> ' : ''}${esc(st?.name ?? b.id)}</b><small>${esc(strat)}${esc(levTxt)} · ${esc(b.paper != null ? (paperAcctName(b.paper) ?? 'paper account') : acctName(b.addr))}${b.paused ? ' · <span class="pf-warn">paused</span>' : ''}</small></div>
        <div class="pf-live-ret ${ret == null ? '' : ret >= 0 ? 'up' : 'dn'}">${ret == null ? '—' : (ret >= 0 ? '+' : '') + (ret * 100).toFixed(2) + '%'}</div>
        <div class="pf-live-sub">${usd(st?.equity)} of ${usd(st?.budget)} · ${Object.keys(st?.units ?? {}).length} positions · fees ${usd(st?.fees)}</div>
        <div class="pf-live-sub">${esc(st?.reason ?? 'starting…')}</div>
        <div class="pf-live-btns"><button class="pf-btn pf-btn--ghost" data-live="${b.paused ? 'resume' : 'pause'}" data-a="${b.addr}" data-i="${esc(b.id)}" data-paper="${esc(b.paper ?? '')}">${b.paused ? 'Resume' : 'Pause'}</button>
          <button class="pf-btn pf-btn--ghost" data-live="stop" data-a="${b.addr}" data-i="${esc(b.id)}" data-paper="${esc(b.paper ?? '')}">Stop</button></div>
      </div>`
    }).join('')
  }
  $('pfLive')?.addEventListener('click', async e => {
    const b = e.target.closest('[data-live]'); if (!b) return
    const act = b.dataset.live
    if (act === 'stop' && b.dataset.armed !== '1') { b.dataset.armed = '1'; b.textContent = 'Stop? Positions stay open'; return }
    b.disabled = true
    const paperSlot = b.dataset.paper
    try {
      const r = paperSlot
        ? await paperApi(act, { instance: b.dataset.i })
        : await api('/api/' + act, b.dataset.a, { type: 'portfolio', address: b.dataset.a, instance: b.dataset.i })
      if (!r.ok) throw new Error(r.error ?? 'refused')
      // A stopped paper bot hands its account back: tradable by hand in the app again.
      if (paperSlot && act === 'stop') { paperAcctTag(paperSlot, null); paperSync().syncNow() }
    } catch (err) { b.textContent = err.message.slice(0, 40); return }
    refresh()
  })
  $('pfTrade')?.addEventListener('click', open)
  refresh()
  setInterval(() => { if (!document.hidden) refresh() }, 30_000)
  return { open, refresh }
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
