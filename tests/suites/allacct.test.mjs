// Arming bots from the combined view.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

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

// ── the resolver ─────────────────────────────────────────────────────────────
const mk = (isAll, tradeAcct, addr, keys = {}) => new Function(`
  const state = { isAllAccounts: ${isAll}, addr: ${JSON.stringify(addr)} }
  const window = { __getTradeAcct: () => ${JSON.stringify(tradeAcct)} }
  const localStorage = { getItem: (k) => (${JSON.stringify(keys)})[k] ?? null }
  const _agentKeyForAddr = (a) => a ? 'hliq_agent_key_' + a.toLowerCase() : null
  ${grab(cli, 'function _stratTargetAddr()')}
  ${grab(cli, 'function _stratTargetKey()')}
  return { addr: _stratTargetAddr(), key: _stratTargetKey() }
`)()

const A = '0xAAaa000000000000000000000000000000000001'
const B = '0xBBbb000000000000000000000000000000000002'
const KEYS = { ['hliq_agent_key_' + A.toLowerCase()]: '0xkeyA', ['hliq_agent_key_' + B.toLowerCase()]: '0xkeyB' }

t('single account targets itself', mk(false, null, A, KEYS).addr === A)
t('and uses its own key', mk(false, null, A, KEYS).key === '0xkeyA')
t('combined targets the PICKED account, not the sentinel',
  mk(true, B, '__all_accounts__', KEYS).addr === B)
t('and signs with THAT account\'s key — the whole reason this was blocked',
  mk(true, B, '__all_accounts__', KEYS).key === '0xkeyB')
t('combined with nothing picked resolves to nothing, rather than the sentinel',
  mk(true, null, '__all_accounts__', KEYS).addr === null)
t('and offers no key', mk(true, null, '__all_accounts__', KEYS).key === null)
t('a picked account with no saved key yields no key rather than another account\'s',
  mk(true, '0xCCcc000000000000000000000000000000000003', '__all_accounts__', KEYS).key === null)

// ── the start payload ────────────────────────────────────────────────────────
const run = grab(cli, 'async function runStrategyMob(type)')
t('run resolves the target once, up front', run.includes('const _target = _stratTargetAddr()'))
t('and refuses with a useful message when none is picked',
  run.includes('Pick which account to run this bot on first'))
t('the address SENT is the target, never state.addr',
  run.includes('address: _target,') && !run.includes('address: state.addr'))
t('the key sent is that account\'s', run.includes('const agentKey = _stratTargetKey()'))

const upd = grab(cli, 'async function updateStrategyMob(type)')
t('editing an existing bot targets the same way', !upd.includes('address: state.addr'))
t('and both update paths were fixed, not just the mobile one',
  (cli.match(/address: _stratTargetAddr\(\), instance: newInst/g) ?? []).length === 2)

// ── the view ─────────────────────────────────────────────────────────────────
const strat = grab(cli, 'function _mobVRenderStrategies(el)')
t('combined view no longer dead-ends into the read-only list',
  strat.includes('if (state.isAllAccounts && !_stratTargetAddr()) { _mobVRenderAllAcctStrats(el); return }'))
t('but still falls back to it when no account can be targeted',
  strat.includes('_mobVRenderAllAcctStrats(el); return'))
t('the picker is rendered in the combined view only',
  strat.includes('_stratAcctPickerHtml()') && strat.includes("state.isAllAccounts ? `<div"))
t('and a single account never sees it', /state\.isAllAccounts \?[\s\S]{0,200}_stratAcctPickerHtml\(\) : ''/.test(strat))

const pick = grab(cli, 'function _stratAcctPickerHtml()')
t('an account with no agent key cannot be picked', pick.includes("${key ? '' : 'disabled'}"))
t('and is marked, rather than silently failing at the server', pick.includes("' 🔑'"))
t('it reuses the trade-tab selection rather than a second setting',
  grab(cli, 'window.__pickStratAcct = function(addr)').includes('window.__setTradeAcct(addr)'))
t('picking repaints in place, so half-typed config is not wiped',
  !grab(cli, 'window.__pickStratAcct = function(addr)').includes('_mobVRenderContent'))

// ── the claim that made this possible ────────────────────────────────────────
t('every other combined-view action already routed per account',
  ['closePosition', 'placeLimitOrder', 'cancelOrder'].every(f =>
    new RegExp(f + '\\([^)]*acct').test(fs.readFileSync('src/trading.js', 'utf8'))))

// ── the running list is kept, not replaced ───────────────────────────────────
t('the cross-account running list still shows, above the launch UI',
  strat.includes('_allAcctRunningHtml()'))
t('it is a function returning HTML now, so both views can use it',
  cli.includes('function _allAcctRunningHtml()'))
t('the read-only fallback still paints it',
  grab(cli, 'function _mobVRenderAllAcctStrats(el)').includes('_allAcctRunningHtml()'))
t('the copy no longer tells the user to switch accounts to start a bot',
  !cli.includes('switch to a single account from the wallet switcher'))

// ── the agent-key block must not ask for keys that already exist ─────────────
t('the saved key is read from the TARGET, not the sentinel',
  strat.includes('const savedKey = _stratTargetKey()'))
t('status comes from that key, not from whichever client connected last',
  strat.includes('agentAddressOf(savedKey)'))
t('and says it is saved for THIS account', strat.includes('Saved for this account'))
t('when a key exists the paste box is collapsed behind a disclosure',
  strat.includes('Replace or clear this key'))
t('and it is still reachable, not removed',
  strat.includes('__mobConnectAgentKey()') && strat.includes('__clearAgentKey()'))
t('the auto-generate button only shows when there is genuinely no key',
  strat.indexOf('${autoGenBtn}') > strat.indexOf("_hasKey ? `"))

// Typing in that box used to write hliq_agent_key___all_accounts__ — a junk entry.
const save = grab(cli, 'window.__saveAgentKey = function(val)')
t('saving a key targets the selected account', save.includes('_stratTargetAddr()'))
t('and no longer writes under the sentinel', !save.includes('_agentKeyForAddr(state.addr)'))
t('clearing targets it too',
  grab(cli, 'window.__clearAgentKey = async function()').includes('_stratTargetAddr()'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
