// Bots on the paper account: they must actually run, not just be un-greyed.
//
// A real bot is a server process holding an agent key. A paper account has no key and a
// sentinel address HL has never heard of, so the normal Run path could only fail on it —
// removing the paywall alone would have shipped a button that errors.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const pap = fs.readFileSync('src/paper.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (sig) => {
  const i = cli.indexOf(sig)
  if (i < 0) return ''
  let j = cli.indexOf('{', i), d = 0
  for (; j < cli.length; j++) { if (cli[j] === '{') d++; else if (cli[j] === '}') { d--; if (!d) return cli.slice(i, j + 1) } }
  return ''
}

console.log(String.fromCharCode(10) + '-- the gate opens for paper --')
t('Strats unlock in paper mode', cli.includes('function _stratsUnlocked() { return isPaper() || isDev()'))
t('and the pre-start check passes', cli.includes('if (isPaper()) return true          // simulated account, simulated orders'))
t('why there is nothing to sell is written down', cli.includes('nothing to sell there'))

console.log(String.fromCharCode(10) + '-- and Run does something real --')
t('Run routes to the paper bot before touching the server', () => {
  const body = grab('async function runStrategyMob(type)')
  const paper = body.indexOf('if (isPaper())')
  const key   = body.indexOf("if (!agentKey)")
  const post  = body.indexOf("serverFetch('/api/start'")
  return paper > 0 && paper < key && paper < post
})
{
  const body = grab('async function runStrategyMob(type)')
  const paper = body.indexOf('if (isPaper())'), key = body.indexOf('if (!agentKey)'), post = body.indexOf("serverFetch('/api/start'")
  t('the paper branch comes before the agent-key demand', paper > 0 && paper < key, { paper, key })
  t('and before the server call', paper > 0 && paper < post, { paper, post })
}
t('Stop is routed too', cli.includes('if (isPaper()) { window.__paperBotStop(type); return }'))
t('the running state is synthesised, since there is no server to poll',
  cli.includes('const bots = _paperBotsLoad()\n    serverStatus = { ok: true, _configs: {} }'))
t('the bot advances on the paper loop', cli.includes('_paperBotTick()'))
// Ordering is the point: the reconcile must run AFTER paperTick's fills and BEFORE the
// state below is read, or the Orders tab shows a gap until the next tick.
{
  const fn = grab('function _paperRefresh()')
  const fills = fn.indexOf('const events = paperTick()')
  const bot   = fn.indexOf('_paperBotTick()')
  const read  = fn.indexOf('state.openOrders = paperOpenOrders()')
  t('the reconcile runs after the fills', fills >= 0 && bot > fills, { fills, bot })
  t('and before the state is read back', bot > 0 && read > bot, { bot, read })
}

console.log(String.fromCharCode(10) + '-- only what can be simulated honestly is offered --')
t('grid is the simulated type', cli.includes("const PAPER_BOT_TYPES = new Set(['grid'])"))
t('anything else says so rather than pretending', cli.includes('does not simulate on the paper account yet'))
t('why the others are excluded is recorded', cli.includes('a half-faithful copy that drifts'))

console.log(String.fromCharCode(10) + '-- the engine really does rest and fill limit orders --')
// The whole approach depends on this: the simulation is the paper engine's, not a
// second pretend one written beside it.
t('paperTick fills a resting limit when the mark crosses', pap.includes('const crosses = o.isBuy ? mark <= o.limitPx : mark >= o.limitPx'))
t('at the limit price, as a maker', pap.includes('feeBps: PAPER_COSTS.makerBps'))
t('and the order is removed once filled', pap.includes('s.orders.splice(s.orders.indexOf(o), 1)'))

console.log(String.fromCharCode(10) + '-- the ladder --')
const plan = new Function('paperMark', 'cfg', grab('function _paperGridPlan(cfg)') + '\n return _paperGridPlan(cfg)')
const mk = (mark) => (c) => (c === 'BTC' ? mark : 0)
const P = plan(mk(80000), { coin: 'BTC', lower: 0, upper: 0, levels: 11 })
t('an empty range auto-bands around the mark', Math.abs(P.lower - 76000) < 1e-6 && Math.abs(P.upper - 84000) < 1e-6)
t('levels are evenly spaced', P.prices.length === 11 && Math.abs(P.step - 800) < 1e-6)
t('an explicit range is honoured',
  plan(mk(80000), { coin: 'BTC', lower: 70000, upper: 90000, levels: 5 }).step === 5000)
t('no mark means no plan', plan(mk(0), { coin: 'BTC', levels: 5 }) === null)
t('an inverted range is refused', plan(mk(80000), { coin: 'BTC', lower: 90000, upper: 70000, levels: 5 }) === null)
t('level count is clamped to something sane',
  plan(mk(80000), { coin: 'BTC', levels: 5000 }).prices.length === 40 &&
  plan(mk(80000), { coin: 'BTC', levels: 1 }).prices.length === 2)

console.log(String.fromCharCode(10) + '-- reconcile: buys below, sells above, nothing in the dead band --')
const runReconcile = (opts) => {
  const placed = []
  const fns = new Function(
    'paperMark', 'paperOpenOrders', 'paperPerpState', 'paperEquity', 'paperOrder', 'cfg',
    grab('function _paperGridPlan(cfg)') + '\n' + grab('function _paperGridReconcile(type, cfg)') +
    '\n return _paperGridReconcile("grid", cfg)')
  fns(
    mk(opts.mark),
    () => opts.resting ?? [],
    () => ({ assetPositions: opts.szi ? [{ position: { coin: 'BTC', szi: String(opts.szi) } }] : [] }),
    () => opts.equity ?? 1000,
    (params) => { const o = params.orders[0]; placed.push({ buy: !!o.b, px: o.p, sz: o.s, reduce: !!o.r }); return {} },
    opts.cfg,
  )
  return placed
}
const CFG = { coin: 'BTC', lower: 76000, upper: 84000, levels: 11, orderUsd: 100, leverage: 5, side: 'long' }

let placed = runReconcile({ mark: 80000, cfg: CFG })
t('every level below the mark becomes a buy', placed.filter(o => o.buy).every(o => o.px < 80000))
t('and there are five of them', placed.filter(o => o.buy).length === 5, placed.filter(o => o.buy).map(o => o.px))
t('no sells are placed with no inventory', placed.filter(o => !o.buy).length === 0)
t('the level AT the mark is left alone (dead band)', !placed.some(o => Math.abs(o.px - 80000) < 1))
t('size follows the configured order value', Math.abs(placed[0].sz * placed[0].px - 100) < 1e-6)

placed = runReconcile({ mark: 80000, cfg: CFG, szi: 0.05 })
const sells = placed.filter(o => !o.buy)
t('with inventory, levels above the mark become sells', sells.length > 0 && sells.every(o => o.px > 80000))
t('sells are reduce-only', sells.every(o => o.reduce))
t('and never exceed the position', sells.reduce((a, o) => a + o.sz, 0) <= 0.05 + 1e-9,
  sells.reduce((a, o) => a + o.sz, 0))

placed = runReconcile({ mark: 80000, cfg: CFG, szi: 0.0001 })
t('a sell worth under $10 is skipped rather than rejected by the exchange',
  placed.filter(o => !o.buy).length === 0)

placed = runReconcile({ mark: 80000, cfg: CFG,
  resting: [{ coin: 'BTC', limitPx: '79200', sz: '0.001', isBuy: true }] })
t('a level already resting is not duplicated', !placed.some(o => Math.abs(o.px - 79200) < 1e-6))
t('the other levels are still filled in', placed.length === 4, placed.length)

placed = runReconcile({ mark: 80000, cfg: { ...CFG, side: 'short' }, szi: -0.05 })
t('a short grid mirrors: sells above the mark are the entries',
  placed.filter(o => !o.buy).every(o => o.px > 80000))
t('and buys below it are the reduce-only exits',
  placed.filter(o => o.buy).every(o => o.px < 80000 && o.reduce))

console.log(String.fromCharCode(10) + '-- stopping takes the ladder with it --')
t('the bot is removed from the store', cli.includes("delete bots[type]; _paperBotsSave(bots)"))
t('and its resting orders are cancelled', cli.includes('paperCancelMany(mine.map(o => ({ a: 0, o: o.oid })))'))
t('why is written down', cli.includes('the ladder outlives the bot that placed it'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
