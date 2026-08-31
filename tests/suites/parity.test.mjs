// Desktop parity: views that existed only in the mobile shell.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const htm = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- the views are reachable on desktop --')
for (const tab of ['pulse', 'analysis', 'performance']) {
  t(`${tab} is in the tab bar`, htm.includes(`switchTab('${tab}',this)`), tab)
  t(`${tab} is in the sidebar`, htm.includes(`data-tab="${tab}"`), tab)
}
t('pulse has a pane', htm.includes('id="tab-pulse"') && htm.includes('id="deskPulse"'))
t('analysis has a pane', htm.includes('id="tab-analysis"') && htm.includes('id="deskAnalysis"'))
t('performance already had one', htm.includes('id="tab-performance"'))
t('switchTab draws pulse', cli.includes("if (name === 'pulse') {") && cli.includes("_pulseRender(_ph)"))
t('and analysis', cli.includes("if (name === 'analysis')   _anaRender(_viewHost('deskAnalysis'))"))
t('pulse shows a placeholder until its first load lands', cli.includes("if (!_pulseData && _ph) _ph.innerHTML"))

console.log(String.fromCharCode(10) + '-- a view repaints the container it is actually in --')
// Every handler named #mobVContent, so mounting the same renderer in a desktop pane
// half-worked: first paint landed on desktop, every button after redrew the hidden mobile one.
t('there is one resolver', cli.includes('function _viewHost(deskId)'))
t('it prefers a VISIBLE desktop pane', cli.includes('if (d && d.offsetParent !== null) return d'))
t('and falls back to the mobile shell', cli.includes("return document.getElementById('mobVContent')"))
t('no pulse handler still hardcodes the mobile container',
  !cli.includes("_pulseRender(document.getElementById('mobVContent'))"))
t('nor any analysis handler', !cli.includes("_anaRender(document.getElementById('mobVContent'))"))
t('why is recorded', cli.includes('redrew the hidden mobile one'))

console.log(String.fromCharCode(10) + '-- and repaints when its data lands, on either shell --')
// Pulse kicked off its fetch on desktop, the data arrived, and nothing drew it: the
// repaint was gated on the MOBILE active tab alone.
t('there is one open-check', cli.includes('function _viewOpen(name)'))
t('it accepts either shell', cli.includes("return _mobVActiveTab === name || _activeTab === name"))
t('pulse repaints through it', cli.includes("if (_viewOpen('pulse')) _pulseRender("))
t('no pulse repaint is gated on the mobile tab alone', !cli.includes("if (_mobVActiveTab === 'pulse') _pulseRender("))
t('but the MOBILE dispatch stays mobile-only', cli.includes("if (_mobVActiveTab === 'analysis') {"))
t("and so does the pulse one", cli.includes("if (_mobVActiveTab === 'pulse') {"))
t('the permanent-Loading failure is written down', cli.includes('a permanent "Loading…"'))

console.log(String.fromCharCode(10) + '-- the desktop pane has no mobile-only chrome --')
t('the full-page header is mobile-only', cli.includes("const _desk = el.id === 'deskAnalysis'"))
t('desktop gets a plain title instead', cli.includes('? `<div style="display:flex;align-items:center;padding:14px 16px 11px'))
t('why a close button would be wrong there is recorded', cli.includes('the tab bar is the way out'))

console.log(String.fromCharCode(10) + '-- gaps this session created, closed --')
// runStrategyMob learned about paper accounts; runStrategy did not, so on desktop the
// practice account demanded an agent key it can never have.
{
  const body = cli.slice(cli.indexOf('async function runStrategy(type) {'), cli.indexOf('async function runStrategy(type) {') + 1200)
  const paper = body.indexOf('if (isPaper())')
  const key   = body.indexOf('if (!agentKey)')
  t('desktop Run routes paper accounts to the paper bot', paper > 0, body.slice(0, 60))
  t('before demanding an agent key', paper > 0 && paper < key, { paper, key })
  t('and it refreshes the buttons after starting', body.includes('checkServer(); updateAllStrategyButtons()'))
}
t('Preview is offered on desktop too', cli.includes("onclick=\"window.__botPreview('${type}')\""))
t('only for bots that can be previewed', cli.includes('${PREVIEWABLE.has(type) ?'))
t('Stop already handled paper for both shells', cli.includes('if (isPaper()) { window.__paperBotStop(type); return }'))

console.log(String.fromCharCode(10) + '-- and the reverse gap: Performance had no MOBILE entry --')
// It was in _MOBV_NAV_ORDER, in both dispatch sets, and had a renderer. There was simply
// no button anywhere on mobile, so nothing could reach it.
t('the More drawer links it', htm.includes("window.__mobMoreTab('performance')"))
// It is bot data, so it belongs under the Bot Agents heading rather than loose in the
// general list.
{
  const grid = htm.slice(htm.indexOf('mob-more-grid'))
  const head = grid.indexOf('>Bot Agents<')
  const perf = grid.indexOf("__mobMoreTab('performance')")
  const strat = grid.indexOf("__mobMoreTab('strategies')")
  t('it sits under the Bot Agents heading', head > 0 && perf > head, { head, perf })
  t('and below Strategies — you run a bot, then look at how it did', perf > strat, { perf, strat })
}
// The heading was dev-only, so for a non-dev user the section's only visible item would
// have had no title and read as a stray row in the list above.
t('the heading is no longer dev-gated', htm.includes('<div class="mob-more-section">Bot Agents</div>'))
t('but Strategies still is', htm.includes(`<button class="dev-only" onclick="window.__mobMoreTab('strategies')"`))
t('Bot Performance is readable without dev mode', !/class="dev-only"[^>]*__mobMoreTab\('performance'\)/.test(htm))
t('the mobile dispatch already accepted it', cli.includes("'watch', 'strategies', 'performance'"))
t('every remaining state names the view', (cli.match(/el\.innerHTML = _hd/g) || []).length === 3)
t('including the populated one', cli.includes('el.innerHTML = _hd + _note + `<div style="padding:4px 0 24px">'))
t('the heading is translated', cli.includes("_T('Bot Performance', 'Rendimiento de bots')"))
t('why a heading was needed is recorded', cli.includes('nothing else names the view'))

console.log(String.fromCharCode(10) + '-- Bot Performance works in All Accounts --')
// Both renderers took _botApiAddr() and gave up when it was null -- exactly what the
// combined view returns -- so it told you to go and switch to a single account. There was
// never a reason to: _computeBotPerformance reads state.fills / state.funding, and in All
// Accounts those are ALREADY combined. Only the /api/wins call was single-address.
t('there is one shared fetch', cli.includes('async function _perfFetchWins()'))
t('it fans across the wallets in view', cli.includes('const parts = await hlPool(addrs, a =>'))
t('hidden wallets are excluded, like every other total there',
  cli.includes("const hidden = _maHiddenLoad()") && cli.includes("filter(a => a && !hidden.has(a))"))
t('results are merged per bot type', cli.includes(';(wins[type] ??= []).push(...list)'))
t('a single wallet still takes the direct path', cli.includes('if (!state.isAllAccounts && single)'))
t('one failed wallet does not fail the screen', cli.includes("if (!part || typeof part !== 'object') { missing++; continue }"))
t('but every wallet failing is still a failure', cli.includes('if (missing === addrs.length) return null'))
t('a partial answer says so rather than under-reporting', cli.includes('did not respond — totals below exclude'))
t('neither renderer still refuses the combined view', !cli.includes('Open a single account to see bot performance'))
t('the mobile view uses it', cli.includes('const _res = await _perfFetchWins()'))
t('and so does desktop', (cli.match(/await _perfFetchWins\(\)/g) || []).length === 2)
t('why the old refusal was wrong is recorded', cli.includes('There was never a reason to'))

console.log(String.fromCharCode(10) + '-- drawer order --')
{
  const grid = htm.slice(htm.indexOf('mob-more-grid'))
  const strat = grid.indexOf("__mobMoreTab('strategies')")
  const perf  = grid.indexOf("__mobMoreTab('performance')")
  t('Bot Performance sits BELOW Strategies', strat > 0 && perf > strat, { strat, perf })
}

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
