// The agent key on screen belongs to the account on screen — always, in both shells.
//
// Reported as: "what happened with the agent keys… make sure they always stay connected (they
// like cleared, not showing), remember they are stored per device. if im in account 1, show and
// use agent key of wallet 1, if i change to account 2, display and use agent key of account 2.
// when in all accounts do the same behavior since in it you can also choose the account inside
// all accounts. we need to make sure about the wallet address matches its agent key."
//
// Four separate faults produced that one symptom:
//   1. a "dedupe" pass DELETED keys shared by two accounts — one agent wallet approved by
//      several masters is a normal Hyperliquid setup, not a mis-migration;
//   2. nothing repainted the key panel when the account was changed inside the combined view;
//   3. every reader asked for `state.addr`'s key, and in the combined view that is the
//      "__all_accounts__" sentinel, which owns no key;
//   4. the status line reported the globally-connected client, so an account with no key of
//      its own borrowed a green "connected" from whichever account connected last.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const body = (sig, end) => {
  const i = cli.indexOf(sig)
  if (i < 0) return ''
  const j = cli.indexOf(end, i + sig.length)
  return j < 0 ? cli.slice(i) : cli.slice(i, j)
}

const mod = fs.readFileSync('src/agentkeys.js', 'utf8')
const src = fs.readdirSync('src').filter(f => f.endsWith('.js'))

// ── the invariants ───────────────────────────────────────────────────────────
// Everything below this heading is here to fail for code that has not been written yet.
// The rest of this suite pins the fix; these pin the SHAPE that made the fix possible, so
// the next person to reach for `state.addr` while touching a key trips over a red test
// rather than shipping the same bug a fifth time.
console.log(nl + '-- one file knows where keys live --')
{
  t('agentkeys.js exists and is the only place that builds the storage key',
    mod.includes("export const PREFIX     = 'hliq_agent_key_'"))
  // Comments may name it; code may not. A second copy of the layout is a second place to get
  // it wrong, which is what lbjoin.js used to be.
  const decomment = (x) => x.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
  const others = src.filter(f => f !== 'agentkeys.js' && /hliq_agent_key_/.test(decomment(fs.readFileSync('src/' + f, 'utf8'))))
  t('no other module builds one', others.length === 0, others)
  // The point of the module is what it CANNOT see. `state` is what every version of this bug
  // reached for; a module that never imports it cannot reach for it by habit.
  t('and it cannot see app state', !/state/.test(mod.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')))
  t('it takes the account explicitly, every time',
    ['storageKeyFor', 'readKey', 'writeKey', 'removeKey'].every(f => mod.includes('export function ' + f)))
  t('and refuses anything that is not an account', mod.includes("if (!isRealAddr(addr)) return misuse('addr', addr)"))
  t('the legacy bare key has one name', mod.includes("export const LEGACY_KEY = 'hliq_agent_key'"))
  t('main.js reaches storage only through the three accessors',
    ['const _agentKeyGet = (addr) => _akRead(localStorage, addr)',
     'const _agentKeySet = (addr, key) => _akWrite(localStorage, addr, key)',
     'const _agentKeyDel = (addr) => _akRemove(localStorage, addr)'].every(x => cli.includes(x)))
  t('and never hand-builds a key name', !/'hliq_agent_key_'|"hliq_agent_key_"/.test(cli))
  t('even the legacy key goes through the constant', !/localStorage\.(get|set|remove)Item\(['"]hliq_agent_key['"]/.test(cli))
}

console.log(nl + '-- a wrong call is loud, not silent --')
{
  // The whole class of bug was silent: a read for a non-account returned nothing and the UI
  // showed "no key". Nothing in the app said anything, so it took a user noticing.
  t('a misuse hook exists', mod.includes('export function onAgentKeyMisuse(fn)'))
  t('main.js wires it to telemetry', cli.includes("kind: 'agentkey'"))
  t('it is capped so a loop cannot flood the log', cli.includes('_akMisuseSeen.size > 8'))
  t('and a key already stored against a non-account is reported', mod.includes('export function strayEntries(storage)') &&
    cli.includes('function _reportStrayAgentKeys()'))
  t('reported, not deleted — it is someone’s private key',
    !body('function _reportStrayAgentKeys()', nl + '}').includes('removeItem'))
  t('the combined view checks on entry', /_syncAgentKeyUI\(\)[\s\S]{0,120}_reportStrayAgentKeys\(\)/.test(cli))
}

console.log(nl + '-- nothing deletes a key behind the user’s back --')
{
  const d = body('function _dedupeAgentKeys()', nl + 'function _updateAutoGenBtnVisibility')
  t('the dedupe pass is inert', d.includes('intentionally does nothing'))
  t('and it no longer removes anything', !d.includes('removeItem'))
  t('why one key can belong to several accounts is written down',
    cli.includes('SEVERAL master accounts'))
  // The honest replacement: a key that does not work is SHOWN as not approved and the user
  // decides. Silence plus deletion is what made keys "disappear".
  t('an unusable key is surfaced instead', cli.includes('function _agentStatusFor(addr)') &&
    cli.includes('Not approved for <span class="notranslate">${label}</span>'))
}

console.log(nl + '-- one account decides what the key UI shows --')
{
  const u = body('function _agentUiAddr()', nl + '/**')
  t('_agentUiAddr exists', u.includes('_stratTargetAddr() ?? state.addr'))
  t('and it refuses the sentinel and the paper address', u.includes('_isRealAddr(a) ? a : null'))
  const sync = body('function _syncAgentKeyUI(addr = _agentUiAddr())', nl + 'window.__syncAgentKeyUI')
  t('the sync reads that account’s key only', sync.includes('_agentKeyGet(addr)'))
  t('it fills both shells’ fields', sync.includes("['agentKey', 'privateKeyInput', 'm-agentKey']"))
  t('and both shells’ status lines', sync.includes("['apiConnectStatus', 'm-agentKeyStatus']"))
  t('the dot follows whether a key exists', sync.includes("dot.classList.toggle('connected', !!key)"))
}

console.log(nl + '-- and every reader asks that account, not state.addr --')
{
  // state.addr is "__all_accounts__" in the combined view. Any read of it for a key comes back
  // empty there, which is what made the panel look cleared.
  const reads = [...cli.matchAll(/_agentKeyForAddr\(state\.addr\)/g)]
  t('no key is looked up by state.addr any more', reads.length === 0, reads.length)
  const inview = body('function _agentKeyInView()', nl + '}')
  t('_agentKeyInView goes through _agentUiAddr', inview.includes('const a = _agentUiAddr()'))
  // A blank line ends these functions' first paragraph, so take a fixed window instead.
  const near = (sig) => { const i = cli.indexOf(sig); return i < 0 ? '' : cli.slice(i, i + 400) }
  for (const fn of ['function _updateAutoGenBtnVisibility()', 'window.__quickConnectAgent = async function()', 'window.__autoGenerateAgentKey = async function()'])
    t(fn.split(/[ (]/)[fn.startsWith('function') ? 1 : 0] + ' uses it', near(fn).includes('_agentKeyInView()'))
  t('so does the mobile Settings card', cli.includes('const savedKey     = _agentKeyInView()'))
  t('and the desktop Settings row', cli.includes('const agentKey = _agentKeyInView() || localStorage.getItem(_AK_LEGACY)'))
}

console.log(nl + '-- saving writes to the account in view --')
{
  const save = body('window.__saveAgentKey = function(val)', nl + nl)
  t('__saveAgentKey targets the account in view', save.includes('const _a = _agentUiAddr()'))
  t('it registers the key for that account', save.includes('registerAgentKey(_a, val)'))
  t('and repaints from it', save.includes('_syncAgentKeyUI(_a)'))
  // Both Connect buttons (desktop panel and mobile Settings) had the same bug.
  const targeted = [...cli.matchAll(/const _target = _agentUiAddr\(\)/g)]
  t('both Connect paths target it too', targeted.length === 2, targeted.length)
  t('each registers under that account', [...cli.matchAll(/registerAgentKey\(_target, keyVal\)/g)].length === 2)
  t('nothing writes a key under the sentinel', !cli.includes("_agentKeyForAddr(state.addr), keyVal"))
  t('auto-generate stores under the account it generated for',
    cli.includes('_agentKeySet(_acct, privateKey)'))
  t('and only the owning wallet may approve it',
    cli.includes("if (!_acct || mainAddr !== _acct.toLowerCase())"))
}

console.log(nl + '-- changing account inside the combined view repaints it --')
{
  const set = body('window.__setTradeAcct = function(v)', nl + 'window.__getTradeAcct')
  t('__setTradeAcct syncs the key UI', set.includes('_syncAgentKeyUI()'))
  t('both pickers go through __setTradeAcct',
    body('window.__pickTradeAcct = function(addr)', nl + nl).includes('window.__setTradeAcct(addr)') &&
    body('window.__pickStratAcct = function(addr)', nl + nl).includes('window.__setTradeAcct(addr)'))
  // Going key → no key swaps one block of controls for another; patching a value into the
  // old one would leave the wrong buttons up.
  t('a change in key PRESENCE re-renders the panel',
    body('window.__pickStratAcct = function(addr)', nl + nl).includes('hadKey !== !!_agentKeyInView()'))
  t('entering the combined view paints the selected account',
    /await _allAcctRegisterAgents\(\)[\s\S]{0,180}_syncAgentKeyUI\(\)/.test(cli))
  // An account with no key must stay reachable, or there is no way to give it one from here.
  t('a keyless account is still pickable', !body('function _stratAcctPickerHtml()', nl + '}').includes('disabled'))
}

console.log(nl + '-- the status line names the wallet, never the agent --')
{
  const st = body('function _agentStatusFor(addr)', nl + nl + 'function _syncAgentKeyUI')
  t('it names the account', st.includes('WM.getLabel(addr)'))
  t('no key says so, for that account by name', st.includes('No key saved for <span class="notranslate">${label}</span>'))
  t('the practice account is not asked for one', st.includes("addr === PAPER_ADDR"))
  t('the mobile Strategies header uses the same answer', cli.includes('const _st         = _agentStatusFor(_tgt)'))
  t('it no longer falls back to the one global client',
    !cli.includes('(isConnected() ? getWalletAddress() : null)'))
  t('why that was wrong is written down', cli.includes('whichever account connected last'))
}

console.log(nl + '-- clearing and regenerating act on that account too --')
{
  t('clear targets the account in view', body('window.__clearAgentKey = async function()', nl + nl).includes('const acct  = _agentUiAddr()'))
  t('regenerate does too', body('window.__regenAgentKey = async function()', nl + nl).includes('const acct = _agentUiAddr()'))
  t('and clearing repaints through the sync', body('window.__clearAgentKey = async function()', nl + nl).includes('_syncAgentKeyUI(acct)'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
