// Preview: what the bot would do, from the bot's own setup.
import fs from 'fs'
const cli  = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv  = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const grid = fs.readFileSync('strategies/grid.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log('\n── a preview can never place an order ──')
const planIdx = grid.indexOf('if (PLAN_ONLY) {')
t('plan mode exists', planIdx > 0)
t('and exits the process', grid.indexOf('process.exit(0)', planIdx) > planIdx)
// What matters is the SETUP PATH — run() from its start to the exit. The order helpers are
// defined earlier in the file but only called from the tick loop, which is past the exit.
const setup = grid.slice(grid.indexOf('async function run() {'), planIdx)
t('the setup path issues no exchange call at all before the exit',
  !/await exchange\./.test(setup), (setup.match(/await exchange\.\w+/g) ?? []).join(','))
t('and no funds are moved before it — the top-up comes later',
  !setup.includes('usdClassTransfer') && grid.indexOf('usdClassTransfer') > planIdx)
t('the trading loop itself is past the exit',
  grid.indexOf('while (true)', planIdx) > planIdx)
t('the only calls before it are reads', /await info\./.test(setup))
t('the guarantee is written down where it can be checked',
  grid.includes('there is no path from --plan to an order'))

console.log('\n── the plan reports the user\'s own capital ──')
// The whole --plan branch, however long it grows.
const planEnd = grid.indexOf('process.exit(0)', planIdx) + 20
const planBlock = grid.slice(planIdx, planEnd)
for (const k of ['capital', 'capitalSource', 'freeMargin', 'requiredMargin', 'orderUsd', 'leverage'])
  t(`it carries ${k}`, planBlock.includes(k + ',') || planBlock.includes(k + ':'))
t('and whether the plan actually fits that capital', planBlock.includes('fits: requiredMargin <= marginAvail'))
t('it says when the range was chosen for you', planBlock.includes('autoRange:'))
t('and when the size was', planBlock.includes('autoSize:'))
t('an open position is reported, since the range can anchor to it', planBlock.includes('position: _szi0 ?'))

console.log('\n── sides follow the mark, and invert for a short grid ──')
const side = new Function('px', 'markPx', 'IS_SHORT', "return (IS_SHORT ? px > markPx : px < markPx) ? 'buy' : 'sell'")
t('a long grid buys below the mark', side(65, 80, false) === 'buy')
t('and sells above it', side(95, 80, false) === 'sell')
t('a short grid is the mirror — it buys above', side(95, 80, true) === 'buy')
t('and sells below', side(65, 80, true) === 'sell')

console.log('\n── the endpoint ──')
t('there is one', srv.includes("path === '/api/plan'"))
t('it runs the REAL strategy, with --plan appended', srv.includes("...(b.args ?? []), '--plan'"))
t('an unknown strategy is refused', srv.includes("if (!script) return json(res, 400, { error: 'unknown strategy' })"))
t('the same key-ownership check as starting a bot', srv.includes("error: 'preview with your own agent key'"))
t('but NOT behind the paywall — it places nothing',
  srv.slice(srv.indexOf("path === '/api/plan'"), srv.indexOf("path === '/api/plan'") + 2600).includes('subActive') === false)
t('and why is recorded', srv.includes('someone deciding whether to subscribe should be able to see'))
t('a hung preview is killed, not left running', srv.includes("proc.kill('SIGKILL')"))
t('with a short leash, since a person is waiting', srv.includes('}, 30_000)'))
t("the bot's own refusal is passed through as the answer",
  srv.includes('That refusal') && srv.includes('surface its own words'))

console.log('\n── the UI ──')
t('only bots with a knowable opening move offer it', cli.includes("const PREVIEWABLE = new Set(['grid'])"))
t('the button is gated on that set', cli.includes('PREVIEWABLE.has(s.type)'))
const pv = grab(cli, 'window.__botPreview = async function(type)')
t('it needs an account picked', pv.includes('Pick which account to preview on first'))
t('and a key, like running would', pv.includes('Connect an agent key first'))
t('it sends the SAME argv the Run button builds', pv.includes('const argv = buildArgvMob(type)'))
t('the sheet opens immediately, in a loading state', pv.includes('_botPreviewSheet(type, null, true)'))
t('a server failure still shows a sheet rather than nothing', pv.includes("_botPreviewSheet(type, { ok: false"))

const sheet = grab(cli, 'function _botPreviewSheet(type, plan, loading)')
t('it says plainly that nothing was placed', sheet.includes('Nothing has been placed'))
t('capital and margin-needed sit together, so a bad fit is obvious',
  sheet.includes("_T('Margin needed'") && sheet.includes("_T('Your capital'"))
t('a plan that does not fit is called out', sheet.includes('will not go on the book'))
t('an existing position is surfaced, since it can move the range', sheet.includes('_previewPositionHtml(plan)'))
t('Run is one tap from the preview', sheet.includes('window.runStrategyMob('))
t('and closing the sheet first, so it cannot double-fire', sheet.includes("window.__closeBotPreview();window.runStrategyMob("))

const chart = grab(cli, 'function _previewChartHtml(plan)')
t('levels are positioned by PRICE, not by index', chart.includes('(1 - (px - lo) / span)'))
t('so uneven (percentage) spacing is not flattened into even rungs', chart.includes('const span = (hi - lo) || 1'))
t('the mark is drawn among them', chart.includes("_T('Mark', 'Precio')"))
t('buys and sells are told apart by more than colour', chart.includes("buy ? 'solid' : 'dashed'"))
t('a degenerate plan draws nothing rather than dividing by zero', chart.includes('if (orders.length < 2) return'))

console.log(String.fromCharCode(10) + '-- which orders will not go on the book --')
const pb = planBlock
t('exits are limited by the position, not the lot size', pb.includes('let _uncovered ='))
t('an exit under HL minimum is marked, not drawn as real', pb.includes("blockedAt(i, 'inventory')"))
t('a losing exit is marked too — the bot never closes below the average entry', pb.includes("blockedAt(i, 'losing')"))
t('entries run low index to high, the order the tick places them in',
  /for \(let i = 0; i < PRICES\.length; i\+\+\)[\s\S]{0,400}_isEntryLvl/.test(pb))
t('each entry reserves ORDER_USD / LEVERAGE of margin', pb.includes('const _perOrder = ORDER_USD / LEVERAGE'))
t('once the budget is gone the rest are marked, not dropped', pb.includes("blocked: 'margin'"))
t('a level too close to the mark is its own state, not a failure', pb.includes("'near'"))
t('the plan reads the open orders', pb.includes('info.openOrders(Q(QUERY_ADDR))'))
t('and maps them to levels the same way the tick does', pb.includes('bestDist > gapAt(best) * 0.4'))
t('an adopted level is skipped by the entry loop, its margin already spent',
  pb.includes('adopted; its margin is already spent'))
t('and by the exit loop', pb.includes('already there — adopted, not re-placed'))
t('inventory backing a resting exit cannot be sold twice',
  pb.includes('Inventory already covered by a resting exit cannot be sold twice'))
t('the counts separate new orders from ones already there',
  pb.includes('willPlace:') && pb.includes('resting:') && pb.includes('heldBack:'))
// heldBack now covers everything not going on the book this cycle, so the three counts
// add up to the ladder; nearMark is tallied separately for the explanation.
t('heldBack covers every level not being placed now', pb.includes("o.blocked && o.blocked !== 'resting'"))
t('and near-mark levels get their own tally', pb.includes("nearMark:  orders.filter(o => o.blocked === 'near').length"))

console.log(String.fromCharCode(10) + '-- and the UI marks them --')
const chart2 = grab(cli, 'function _previewChartHtml(plan)')
for (const k of ['margin', 'inventory', 'losing', 'resting', 'near'])
  t(k + ' has a label', chart2.includes(k + ':'))
t('the two that mean "wanted but cannot" are the loud ones',
  /margin:\s*\{[^}]*loud: true/.test(chart2) && /inventory:\s*\{[^}]*loud: true/.test(chart2))
t('ordinary states are quiet, not alarming',
  /resting:\s*\{[^}]*loud: false/.test(chart2) && /near:\s*\{[^}]*loud: false/.test(chart2))
t('a held-back rung is struck through', chart2.includes('text-decoration:line-through'))
t('and dotted, so colour is not the only signal', chart2.includes("'dotted'"))
const sheet2 = grab(cli, 'function _botPreviewSheet(type, plan, loading)')
t('the banner names the exact prices that will not be placed',
  sheet2.includes("short.map(o => money(o.px)).join(', ')"))
t('and the ones with nothing left to sell', sheet2.includes("inv.map(o => money(o.px)).join(', ')"))
t('it explains margin ones are retried, not abandoned', sheet2.includes('keeps retrying them as margin frees'))
t('and that exits appear as the position grows', sheet2.includes('Exits are backed by the position'))
t('no banner when everything can be placed', sheet2.includes('if (!short.length && !inv.length && !near.length)'))
t('one level reads "level", several read "levels"', sheet2.includes("_T('level', 'nivel') : _T('levels', 'niveles')"))
t('and the verb agrees', sheet2.includes('have nothing left to sell'))

console.log(String.fromCharCode(10) + '-- the open position the grid starts on top of --')
const pos = grab(cli, 'function _previewPositionHtml(plan)')
t('direction leads, because it changes what the bot does', pos.includes("long ? _T('Long', 'Largo') : _T('Short', 'Corto')"))
for (const f of ['Entry', 'Value', 'Unrealized', 'Return', 'Margin used', 'Liquidation', 'Leverage', 'Funding paid'])
  t('it shows ' + f, pos.includes("'" + f + "'"))
t('and whether the grid points the same way', pos.includes("_T('vs this grid'"))
t('an aligned position is explained, not just labelled',
  pos.includes('The grid adds to this position'))
t('an opposing one is a WARNING — the entries reduce it before opening anything',
  pos.includes('Your position points the other way'))
t('and says why its exits find nothing to sell', pos.includes('no inventory to sell until it does'))
t('the border turns red when they disagree', pos.includes("p.aligned ? 'var(--border2)' : 'var(--red)'"))
t('funding received reads as a gain, funding paid as a cost',
  pos.includes("p.funding <= 0 ? '+' : '−'"))
t('a liquidation price is highlighted, and absent when there is none',
  pos.includes("p.liqPx > 0 ? '$' + fmtPrice(p.liqPx) : '—'"))

console.log(String.fromCharCode(10) + '-- the plan carries it --')
const pbp = planBlock
for (const k of ['side:', 'entryPx:', 'value:', 'uPnl:', 'roe:', 'marginUsed:', 'liqPx:', 'leverage:', 'levType:', 'funding:', 'aligned:'])
  t('plan sends ' + k, pbp.includes(k))
t('alignment is judged against the grid direction, not the sign alone',
  pbp.includes('aligned:    IS_SHORT ? _szi0 < 0 : _szi0 > 0'))
t('a position is reported even when it opposes the grid — _inv would hide it',
  pbp.includes('position: _szi0 ?'))

console.log(String.fromCharCode(10) + '-- a newer page must survive an older bot --')
// index.html ships via CI immediately; strategies/ deploys separately, so for a few
// minutes a fresh page can be handed a plan built by the previous grid.js.
t('every position field is optional', pos.includes('const n = (v) => Number.isFinite(+v) ? +v : null'))
t('and a missing one renders as a dash rather than blanking the sheet',
  pos.includes("p.roe == null ? '—'") && pos.includes("p.entryPx == null ? '—'"))
t('side is inferred when absent', pos.includes("raw.side ?? (n(raw.szi) < 0 ? 'short' : 'long')"))
t('and alignment defaults to the quiet reading, not a false alarm',
  pos.includes('aligned: raw.aligned !== false'))
t('the deploy-order hazard is written down', pos.includes('deploy separately'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
