import fs from 'fs'
import os from 'os'
import path from 'path'
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const css = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  // Skip the parameter list first: a default like `patch = {}` would otherwise be mistaken
  // for the function body and the extraction would stop one character in.
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

// ── the real subscription module, driven against temp files ──────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'subs-'))
const SUBS = path.join(dir, 'subs.json')
const PAYS = path.join(dir, 'pays.json')
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a ?? ''))

let feed = []                     // what the fake Hyperliquid returns
let hlCalls = 0
let hlThrow = null
const hlInfo = async (payload) => {
  hlCalls++
  if (hlThrow) throw new Error(hlThrow)
  lastPayload = payload
  return feed
}
let lastPayload = null

const body = srv.slice(srv.indexOf('const SUBS_FILE'), srv.indexOf('const LB_PAPER_FILE'))
const M = new Function('existsSync', 'readFileSync', 'writeFileSync', 'join', '__dirname',
  'hlInfo', 'isAddr', 'console', 'SUBSP', 'PAYSP', `
  ${body.replace("join(__dirname, 'subscriptions.json')", 'SUBSP')
         .replace("join(__dirname, 'sub-payments.json')", 'PAYSP')}
  return { subsRead, subsWrite, subGet, subActive, subExtend, subPayRead, subPayWrite,
           subPollPayments, SUB_TREASURY, SUB_PRICE_USDC, SUB_PERIOD_DAYS, SUB_TRIAL_DAYS }
`)(fs.existsSync, fs.readFileSync, fs.writeFileSync, path.join, dir,
   hlInfo, isAddr, { log() {}, warn() {}, error() {} }, SUBS, PAYS)

const A = '0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa'
const Bx = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const C = '0xcccccccccccccccccccccccccccccccccccccccc'

// ── store ────────────────────────────────────────────────────────────────────
t('missing store reads empty', Object.keys(M.subsRead()).length === 0)
t('unknown wallet is inactive', M.subActive(A) === false)
M.subExtend(A, 30)
t('30 days activates', M.subActive(A) === true)
const until1 = M.subGet(A).until
t('expiry is ~30d out', Math.abs(until1 - (Date.now() + 30 * 86400000)) < 5000)
M.subExtend(A, 30)
t('paying again STACKS rather than resetting',
  Math.abs(M.subGet(A).until - (until1 + 30 * 86400000)) < 5000)
t('address lookup is case-insensitive', M.subActive(A.toLowerCase()) === true)
M.subExtend(Bx, -400)
t('an expired wallet is inactive', M.subActive(Bx) === false)
M.subExtend(A, 1, { trialUsed: true })
t('patch fields persist', M.subGet(A).trialUsed === true)
fs.writeFileSync(SUBS, '{}')

// ── the payment watcher ──────────────────────────────────────────────────────
t('treasury is the address given', M.SUB_TREASURY === '0x8fe3c39057b6348a27d912423a9770b242911c5d')
t('treasury stored lowercase for comparison', M.SUB_TREASURY === M.SUB_TREASURY.toLowerCase())

const send = (from, amount, time, nonce, over = {}) => ({
  time, hash: '0x' + String(nonce).padStart(64, '0'),
  delta: {
    type: 'send', user: from, destination: M.SUB_TREASURY, token: 'USDC',
    amount: String(amount), usdcValue: String(amount), fee: '0.0', nonce, ...over,
  },
})

// First run must only seed the watermark — a send that predates the feature is not a
// subscription and crediting it would hand out free months on deploy day.
feed = [send(A, 50, Date.now() - 86400000, 1)]
await M.subPollPayments()
t('first run seeds the watermark and credits nobody', M.subActive(A) === false)
t('a floor was written', M.subPayRead().floor > 0)
const floor = M.subPayRead().floor

await M.subPollPayments()
t('a pre-install send is still ignored on the second pass', M.subActive(A) === false)
t('the overlap window never reaches back past the floor',
  lastPayload.startTime >= floor, JSON.stringify(lastPayload))
t('asks Hyperliquid for the TREASURY ledger, not the user\'s',
  lastPayload.user === M.SUB_TREASURY && lastPayload.type === 'userNonFundingLedgerUpdates')

// A real payment.
feed = [send(A, 10, floor + 1000, 2)]
await M.subPollPayments()
t('a $10 send activates the SENDER, with no hash submitted', M.subActive(A) === true)
const untilA = M.subGet(A).until
t('one period granted', Math.abs(untilA - (Date.now() + 30 * 86400000)) < 5000)

// Replays must not stack: the same entry is re-read on every overlapping poll.
await M.subPollPayments()
await M.subPollPayments()
t('the same ledger entry is never credited twice', M.subGet(A).until === untilA)

// Underpayment is banked, not swallowed.
feed = [send(Bx, 4, floor + 2000, 3)]
await M.subPollPayments()
t('an underpayment does not activate', M.subActive(Bx) === false)
t('an underpayment is banked as credit', M.subGet(Bx).credit === 4)
feed = [send(Bx, 6, floor + 3000, 4)]
await M.subPollPayments()
t('banked credit completes the purchase', M.subActive(Bx) === true)
t('nothing is left over after an exact top-up', M.subGet(Bx).credit === 0)

// Overpayment buys proportionally more, and the remainder is kept.
feed = [send(C, 25, floor + 4000, 5)]
await M.subPollPayments()
t('overpayment buys whole extra periods',
  Math.abs(M.subGet(C).until - (Date.now() + 60 * 86400000)) < 5000)
t('the remainder stays as credit', M.subGet(C).credit === 5)

// Things that must NOT pay.
const before = JSON.stringify(M.subsRead())
feed = [
  send(A, 99, floor + 5000, 6, { destination: '0x' + '9'.repeat(40) }),  // outgoing
  send(A, 99, floor + 5001, 7, { token: 'HYPE' }),                        // wrong token
  { time: floor + 5002, hash: '0xdead', delta: { type: 'withdraw', usdc: '99' } },
  { time: floor + 5003, hash: '0xbeef', delta: { type: 'deposit', usdc: '99' } },
  { time: floor + 5004, hash: '0xfeed', delta: { type: 'accountClassTransfer', usdc: '99', toPerp: true } },
  send('not-an-address', 99, floor + 5005, 8),
]
await M.subPollPayments()
t('an OUTGOING send from the treasury never credits anyone', JSON.stringify(M.subsRead()) === before)
t('deposits, withdrawals and class transfers carry no destination and are ignored',
  JSON.stringify(M.subsRead()) === before)

// usdSend (perp) and spotSend (spot) do NOT both report as `send` — matching on the type
// would mean one of the two payment paths silently never activating.
const F = '0xffffffffffffffffffffffffffffffffffffffff'
feed = [{ time: floor + 5200, hash: '0xaaa1', delta: {
  type: 'internalTransfer', user: F, destination: M.SUB_TREASURY, usdc: '10', fee: '0', nonce: 77 } }]
await M.subPollPayments()
t('an internalTransfer (usdSend, from the perp balance) activates', M.subActive(F) === true)

const G = '0x1111111111111111111111111111111111111111'
feed = [{ time: floor + 5300, hash: '0xaaa2', delta: {
  type: 'spotTransfer', user: G, destination: M.SUB_TREASURY, token: 'USDC',
  amount: '10', usdcValue: '10', fee: '0', nonce: 78 } }]
await M.subPollPayments()
t('a spotTransfer (spotSend) activates too', M.subActive(G) === true)

// Hyperliquid being down must be a no-op, never a free month and never a crash.
hlThrow = 'HL 429'
const beforeErr = JSON.stringify(M.subsRead())
await M.subPollPayments()
t('an HL failure grants nothing and does not throw', JSON.stringify(M.subsRead()) === beforeErr)
hlThrow = null

// Nominating a different wallet to enable.
const D = '0xdddddddddddddddddddddddddddddddddddddddd'
const E = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'
const st = M.subPayRead(); st.binds = { [D.toLowerCase()]: E.toLowerCase() }; M.subPayWrite(st)
feed = [send(D, 10, floor + 6000, 9)]
await M.subPollPayments()
t('a bind credits the nominated wallet', M.subActive(E) === true)
t('the paying wallet itself is NOT enabled', M.subActive(D) === false)
t('the bind is consumed, so a later send credits the payer', !M.subPayRead().binds[D.toLowerCase()])

t('the seen-list is capped so the file cannot grow forever', /seen: o\.seen\.slice\(-500\)/.test(srv))

fs.rmSync(dir, { recursive: true, force: true })

// ── live shape check: the real treasury, the real endpoint ───────────────────
const live = await fetch('https://api.hyperliquid.xyz/info', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'userNonFundingLedgerUpdates', user: M.SUB_TREASURY, startTime: 0 }),
}).then(r => r.json()).catch(() => null)
t('the live treasury ledger is reachable and is an array', Array.isArray(live))
if (Array.isArray(live)) {
  const incoming = live.filter(e => e.delta?.type === 'send'
    && String(e.delta.destination).toLowerCase() === M.SUB_TREASURY)
  t('the treasury account exists on Hyperliquid and can receive sends', live.length > 0)
  t('real incoming sends carry the fields the watcher reads',
    incoming.length === 0 || incoming.every(e =>
      e.delta.user && e.delta.token && e.delta.usdcValue !== undefined && e.delta.nonce !== undefined),
    JSON.stringify(incoming[0]))
}

// ── enforcement ──────────────────────────────────────────────────────────────
const si = srv.indexOf("path === '/api/start'")
const startRoute = srv.slice(si, si + 3000)   // the route grew a comment; keep the whole thing
t('/api/start checks the subscription', startRoute.includes('subActive(b.address'))
t('admin still bypasses the paywall', startRoute.includes('auth.admin ||') && startRoute.includes('!_operator && !subActive'))
t('returns 402 with a machine-readable flag', startRoute.includes('402') && startRoute.includes('subscribe: true'))
t('gate runs BEFORE the strategy spawns',
  startRoute.indexOf('subActive(') < startRoute.indexOf('await startStrategy('))
t('resume path is not gated (a lapse must not kill a running bot)',
  !grab(srv, 'async function resumeBots()').includes('subActive'))

// Dev mode has to mean the same thing on both sides, or the owner gets an unlocked Run
// button and a 402 the instant they press it.
t('the operator bypass accepts the PIN that dev mode is earned with',
  startRoute.includes("(req.headers['x-lb-pin'] ?? '') === LB_PIN"))
t('an unset LB_PIN cannot be matched by an absent header',
  startRoute.includes('!!LB_PIN &&'))
t('the bypass covers the paywall ONLY — key ownership is still enforced',
  startRoute.indexOf('const _operator') > startRoute.indexOf('start with your own agent key'))
t('the ownership check still keys off auth.admin, not the PIN',
  /if \(!auth\.admin\) \{[\s\S]{0,400}start with your own agent key/.test(startRoute))
t('the client sends the PIN on /api/start when dev mode is on',
  grab(cli, 'async function serverFetch(path, opts = {})').includes("path === '/api/start' && isDev()"))
t('and only on that route, since it is the only one that reads it',
  (grab(cli, 'async function serverFetch(path, opts = {})').match(/'x-lb-pin'/g) ?? []).length === 1)
t('a 402 in dev mode blames the missing PIN, rather than the wallet',
  cli.includes('Dev mode has no saved PIN'))

// ── routes ───────────────────────────────────────────────────────────────────
t('status route reports Hyperliquid, not Arbitrum', /chain: 'Hyperliquid'/.test(srv))
t('status route exposes the banked credit', srv.includes("credit: Number(r?.credit) || 0"))
t('the check-now route exists', srv.includes("path === '/api/sub/check'"))
t('check-now is throttled so taps cannot hammer HL', srv.includes('Date.now() - _subPollAt >= SUB_POKE_MS'))
t('the pay-from route validates both addresses',
  /payfrom[\s\S]{0,300}isAddr\(b\.address\) \|\| !isAddr\(b\.payer\)/.test(srv))
t('trial is once per wallet', srv.includes("cur?.trialUsed"))
t('the tx-hash claim route is gone', !srv.includes("/api/sub/claim"))
t('no Arbitrum RPC left in the server', !srv.includes('arb1.arbitrum.io'))
t('the watcher is started at boot', /setInterval\(\(\) => subPollPayments\(\), SUB_POLL_MS\)/.test(srv))

// ── client ───────────────────────────────────────────────────────────────────
t('client gate exists', cli.includes('function _stratsUnlocked()'))
t('dev mode bypasses locally', cli.includes('return isDev() || !!_subStatus?.active'))
// The bots must stay VISIBLE when locked — hiding them meant nobody could see what the
// $10 buys. Only the controls that would call /api/start are locked.
const strat = grab(cli, 'function _mobVRenderStrategies(el)')
t('the tab is no longer replaced by the paywall',
  !cli.includes('el.innerHTML = _subPaywallHtml()'))
t('the strategy cards still render when locked',
  strat.includes('const locked = !_stratsUnlocked()') && strat.includes('${cards}'))
t('the Run button is what gets locked',
  strat.includes('Subscribe to run') && strat.includes('window.__subOpenPaywall()'))
t('the locked button stays tappable and leads to the pitch, rather than being inert',
  !/mob-strat-locked[^`]*disabled/.test(strat) && css.includes('.mob-strat-locked'))
t('Stop stays available — a lapse must not strand a running position',
  strat.includes("window.stopStrategyMob('${s.type}')"))
t('Pause / Resume / Restart stay available too',
  strat.includes('resumeStrategyMob') && strat.includes('pauseStrategyMob') && strat.includes('restartStrategyMob'))
t('Logs stay available', strat.includes('_mobShowStratLogs'))
t('and those endpoints really are ungated server-side, matching the UI',
  ['/api/stop', '/api/pause', '/api/resume', '/api/restart'].every(r => {
    const i = srv.indexOf(`path === '${r}'`)
    return i > 0 && !srv.slice(i, i + 500).includes('subActive')
  }))
t('a lock banner explains the state above the cards', strat.includes('_subLockBanner()'))
t('the banner says what the money buys, not just that it is locked',
  grab(cli, 'function _subLockBanner()').includes('trade on our servers'))
t('the full pitch opens as a sheet over the list', cli.includes('window.__subOpenPaywall = function()'))

// The desktop panel has the same rule, or a desktop user fills the whole form and gets a
// bare 402 from the server.
const inject = grab(cli, 'function injectRunButtons(type)')
t('desktop locks the Run button the same way',
  inject.includes('_stratsUnlocked()') && inject.includes('__subOpenPaywall()'))
t('desktop still renders the card, Stop and Logs while locked',
  inject.includes('btn-stop-strategy') && inject.includes('btn-show-logs'))
const upd = grab(cli, 'function updateAllStrategyButtons()')
t('desktop learns the subscription state from its own poll', upd.includes('_subRefresh()'))
t('desktop heals a stale lock instead of needing a reload',
  upd.includes('_rowLocked === _stratsUnlocked()'))
t('unlocking closes the sheet instead of leaving it over the now-usable bots',
  grab(cli, 'async function _subWatchTick()').includes('window.__subClosePaywall()'))
t('client states the gate is cosmetic', cli.includes('This gate is COSMETIC'))
t('402 surfaced to the user, not a raw error', cli.includes('if (r.subscribe)'))
t('the user is never asked for a transaction hash',
  !cli.includes('id="subTx"') && !/Payment transaction hash/.test(cli))
t('treasury comes from the SERVER, not hardcoded in the client',
  !cli.includes('0x8fe3C39057b6348A27D912423A9770B242911C5D') && cli.includes('_subStatus?.treasury'))
t('trial button present', cli.includes('__subStartTrial'))
t('"I sent it" starts the watcher', cli.includes('window.__subSent') && cli.includes('_subWatchStart()'))
t('watching survives a reload', cli.includes("localStorage.setItem('hliq_sub_watch'"))
t('the watcher gives up rather than polling forever', cli.includes('Date.now() > _subWatchUntil'))
t('only the status line repaints, so the disclosure does not collapse',
  grab(cli, 'function _subPaintWatch()').includes("getElementById('subWatchLine')"))
t('a partial payment is spelled out', cli.includes('more to activate'))
t('the minute-poll no longer blind-rerenders over the config forms',
  grab(cli, 'async function _subRefresh(').includes('_stratsUnlocked() !== was'))
t('wrong-chain warning kept', cli.includes('Hyperliquid only'))

// ── paying without leaving the app ───────────────────────────────────────────
const pay = grab(cli, 'window.__subPayNow = async function()')
t('an in-app pay action exists', pay.length > 0)
t('it signs with the MAIN wallet, not the agent key (agents cannot move funds)',
  pay.includes('getHlSigner()') && !pay.includes('agentKey'))
t('no wallet connected opens the picker instead of failing',
  pay.includes('isMainWalletConnected()') && pay.includes('openWalletPicker()'))
t('a wallet/account mismatch is confirmed, since the PAYER is what gets credited',
  pay.includes('main !== target') && pay.includes('confirm('))
t('mobile WalletConnect gets the deep-link nudge', pay.includes('wakeWallet()'))
t('success starts the watcher rather than claiming activation',
  pay.includes('window.__subSent()') && !/_subStatus\.active\s*=\s*true/.test(pay))
t('a cancellation is named as one, not shown as a raw SDK error',
  pay.includes('Payment cancelled.'))
t('the whole cause chain is searched — the SDK buries the real reason',
  pay.includes('cur = cur.cause'))
t('the button is re-enabled even when the send throws', pay.includes('} finally {'))
t('the manual address is still reachable as a fallback', cli.includes('Rather send it yourself?'))

const sendFn = fs.readFileSync('src/trading.js', 'utf8')
const core = grab(sendFn, 'export async function sendUsdcOnCore(')
t('sendUsdcOnCore exists', core.length > 0)
t('it checks BOTH pockets before asking for a signature',
  core.includes('clearinghouseState') && core.includes('spotClearinghouseState'))
t('an insufficient balance names both figures rather than a bare failure',
  core.includes('Trading account has') && core.includes('spot has'))
t('the USDC token id is resolved from spotMeta, never hardcoded',
  core.includes('infoClient.spotMeta()') && !/USDC:0x[0-9a-f]/.test(core))
// The reported bug: declining fired a SECOND signature request. The route is now chosen
// from balances before anything is signed, so there is no post-prompt retry to get wrong.
t('nothing is retried after a signature has been requested',
  !core.includes('try {'), 'a try around the send can only mean a re-prompt')
t('the route is decided from balances, before the wallet is touched',
  core.indexOf('perpFree >= amt') < core.indexOf('client.usdSend'))
t('funds split across both pockets are refused with advice, not two prompts',
  core.includes('enoughTogether') && core.includes('Move some between Spot'))
t('the destination is validated before anything is signed',
  core.includes('Invalid destination address'))

// ── Profit Stack mode: LIVE by default, and unmistakably so ──────────────────
t('the Profit Stack default is LIVE, not dry-run',
  /let _mobAccumDryRun\s*=\s*false/.test(cli))
t('the bot itself also treats a missing flag as live',
  /'dry-run':\s*\{ type: 'boolean', default: false \}/
    .test(fs.readFileSync('strategies/accumulator.js', 'utf8')))
t('--dry-run is only sent when dry-run is actually chosen',
  cli.includes("if (_mobAccumDryRun) argv.push('--dry-run')"))
t('Mode is a two-option segmented control, not one toggling word',
  strat.includes('mob-seg-b') && strat.includes('_mobSetAccumDryRun(false')
    && strat.includes('_mobSetAccumDryRun(true'))
t('the live state is visually distinct from the dry one', strat.includes('mob-seg--live'))
t('the consequence is spelled out under the control, not left to the word "Dry-run"',
  cli.includes('Places real transfers and spot buys.'))
t('switching mode repaints in place — a full re-render would wipe half-typed fields',
  !grab(cli, 'function _mobPaintAccumMode()').includes('_mobVRenderContent'))

// ── form density ─────────────────────────────────────────────────────────────
t('the config form is two columns', /\.mob-strat-body \{[^}]*grid-template-columns: 1fr 1fr/.test(css))
t('short numeric fields pair up, everything else spans',
  css.includes('.mob-strat-field:has(> input[type="number"]) { grid-column: span 1; }')
    && css.includes('.mob-strat-body > * { grid-column: 1 / -1;'))
t('inputs no longer sit on the card colour, so they read as fields',
  /\.mob-strat-input \{[\s\S]{0,300}background: var\(--panel\); border: 1px solid var\(--rule\)/.test(css))
t('bare label+chip toggles line up with the ones that already did',
  css.includes('.mob-strat-field:has(> .btn-size-unit)'))
t('the inline toggles got a bigger tap target',
  css.includes('.mob-strat-body .btn-size-unit'))

// ── leaving full-screen Strats by any route ──────────────────────────────────
// The class lives on #mobileView and only the Exit button removed it, so tapping Home
// left every other tab rendering inside a fixed z-index-120 pane over the app.
const render = grab(cli, 'function _mobVRenderContent(tick = false)')
t('any render of another tab drops full screen',
  render.includes("if (_stratsFull && _mobVActiveTab !== 'strategies') _stratsExitFull()"))
t('the guard runs before the tab is drawn, not after',
  render.indexOf('_stratsExitFull()') < render.indexOf('_i18nHarvest'))
t('exiting does NOT re-render — it is called from inside the render',
  !grab(cli, 'function _stratsExitFull()').includes('_mobVRenderContent'))
t('the toggle and the guard share one place that touches the class',
  (cli.match(/classList\.toggle\('mob-strats-full'/g) ?? []).length === 1)
t('the button still toggles both ways',
  grab(cli, 'window.__stratsToggleFull = function()').includes('_stratsFull = !_stratsFull'))

// Drive the real pair against a stub element.
const full = new Function(`
  let _stratsFull = false
  const host = { on: false }
  const document = { getElementById: () => ({ classList: { toggle: (_c, v) => { host.on = v } } }) }
  ${grab(cli, 'function _stratsApplyFull()')}
  ${grab(cli, 'function _stratsExitFull()')}
  const toggle = () => { _stratsFull = !_stratsFull; _stratsApplyFull() }
  return { host, toggle, exit: _stratsExitFull, get on() { return _stratsFull } }
`)()
full.toggle()
t('entering sets the class', full.on === true && full.host.on === true)
full.exit()
t('leaving clears both the flag and the class', full.on === false && full.host.on === false)
full.exit()
t('exiting when already out is a no-op, not a crash', full.host.on === false)

// ── styling ──────────────────────────────────────────────────────────────────
for (const c of ['.sub-wrap', '.sub-hero', '.sub-price', '.sub-feats', '.sub-cta', '.sub-or',
                 '.sub-card', '.sub-paynow', '.sub-addr', '.sub-btn', '.sub-watching', '.sub-details',
                 '.sub-lock', '.sub-lock-btns', '.sub-sheet', '.sub-sheet-body',
                 '.mob-seg', '.mob-seg-b', '.mob-strat-hint'])
  t('styled: ' + c, css.includes(c + ' ') || css.includes(c + ',') || css.includes(c + '{'))
t('the waiting indicator animates', css.includes('@keyframes sub-pulse'))

// ── full screen (unchanged, still wired) ─────────────────────────────────────
t('expand toggle exists', cli.includes('window.__stratsToggleFull'))
t('full-screen css defined', css.includes('#mobileView.mob-strats-full .mob-v-content'))
t('sits below the bottom nav so Home/Trade stay reachable', /mob-strats-full[\s\S]{0,400}z-index: 120/.test(css))

// ── why the tab is unlocked ──────────────────────────────────────────────────
// A running trial and dev mode unlock the same UI, so turning dev mode off looked broken:
// nothing changed, because a 7-day trial was active on that wallet.
const why = new Function('isDev', '_T', '_subStatus', `
  ${grab(cli, 'function _stratsWhyUnlocked()')}
  return _stratsWhyUnlocked
`)
t('dev mode says so', /Dev mode/.test(why(() => true, (e) => e, null)()))
t('an active subscription says so instead',
  /Active/.test(why(() => false, (e) => e, { active: true, until: Date.now() + 3 * 86400000 })()))
t('and counts the days left',
  /3d left/.test(why(() => false, (e) => e, { active: true, until: Date.now() + 3 * 86400000 - 1000 })()))
t('nothing to say when it is genuinely locked',
  why(() => false, (e) => e, { active: false })() === '')
t('an expired-but-flagged subscription is not called active',
  why(() => false, (e) => e, { active: true, until: Date.now() - 1000 })() === '')
t('it is rendered in the Strats header',
  grab(cli, 'function _mobVRenderStrategies(el)').includes('_stratsWhyUnlocked()'))
t('styled', css.includes('.strat-ent'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
