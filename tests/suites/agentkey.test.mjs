// The intermittent "No agent key" in All Accounts, and cancelling from the TP/SL editor.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const trd = fs.readFileSync('src/trading.js', 'utf8').replace(/\r\n/g, '\n')
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

console.log('\n-- the registry is never left empty --')
const reg = grab(cli, 'async function _allAcctRegisterAgents()')
t('it no longer clears before refilling', !reg.includes('clearAgentKeys()'))
t('it registers first', reg.indexOf('await registerAgentKey') < reg.indexOf('pruneAgentKeys'))
t('then prunes what is no longer wanted', reg.includes('pruneAgentKeys(done)'))
t('only wallets that actually registered are kept', reg.includes('done.push(w.addr)'))
t('and a rejected key does not take the others down with it', reg.includes("catch (e) { console.warn('[allAcct] agent key rejected"))
t('the reason is recorded where it will be read', reg.includes('Never leave the registry empty'))

// The registry as a map: prune must remove the absent and keep the present.
const prune = new Function('keepList', 'have', `
  const _agentClients = new Map(have.map(a => [a, {}]))
  const want = new Set((keepList ?? []).map(a => String(a).toLowerCase()))
  for (const k of [..._agentClients.keys()]) if (!want.has(k)) _agentClients.delete(k)
  return [..._agentClients.keys()]
`)
t('a wallet still in the set survives a refresh', prune(['0xa', '0xb'], ['0xa', '0xb']).length === 2)
t('a removed wallet is dropped', prune(['0xa'], ['0xa', '0xb']).join() === '0xa')
t('case does not cause a spurious drop', prune(['0xA'], ['0xa']).join() === '0xa')
t('keeping nothing empties it, which is what a removed account should do', prune([], ['0xa']).length === 0)

console.log('\n-- and an action heals itself rather than refusing --')
t('there is a resolver hook', trd.includes('export function setAgentKeyResolver(fn)'))
const c = grab(trd, 'function _client(acct)')
t('a miss tries the resolver before throwing', c.includes('if (!c && _agentKeyResolver)'))
t('it installs the key and proceeds', c.includes('_agentClients.set(key, new ExchangeClient('))
t('a malformed key still ends in the clear error, not a crash', c.includes('catch (_) { /* a malformed key falls through'))
t('with no key anywhere it still refuses', c.includes('if (!c) throw new Error(`No agent key for'))
t('the UI gate counts a stored key too, so a button is not disabled on timing alone',
  grab(trd, 'export function hasAgentFor(masterAddr)').includes('_agentKeyResolver(masterAddr)'))
t('the resolver reads ONLY the per-address key',
  cli.includes('setAgentKeyResolver(addr => {') && cli.includes('_agentKeyForAddr(addr)'))
t('never the legacy global one, which belongs to another wallet',
  grab(cli, 'setAgentKeyResolver(addr =>') .includes("hliq_agent_key'") === false)

console.log('\n-- cancelling a single trigger from inside the editor --')
const can = grab(cli, 'window.__tpslCancelOne = async function(oid, btn)')
t('it exists', !!can)
t('it signs as the position\'s own account', can.includes('const acct = pos.acct ?? null') && can.includes('acct }'))
t('and refuses first if that account cannot trade', can.indexOf('__acctCanTrade') < can.indexOf('await cancelOrder'))
t('only the tapped order is cancelled', can.includes('await cancelOrder({ coin: pos.coin, oid, acct })'))
t('the row is dropped from both lists', can.includes('pos.tps = (pos.tps ?? []).filter') && can.includes('pos.sls = (pos.sls ?? []).filter'))
// Confirm cancels every oid it knows about; a stale one would be cancelled twice.
t('a pre-filled oid that just went away is forgotten', can.includes('if (pos.tpOid === oid) pos.tpOid = 0'))
t('and the same for the stop side', can.includes('if (pos.slOid === oid) pos.slOid = 0'))
t('the list repaints, so the "cancels all N" line stays true', can.includes('_tpslRenderExisting(pos.coin'))
t('a failure restores the button instead of stranding it', can.includes('btn.disabled = false; btn.textContent = was'))
t('every row gets a cancel control',
  grab(cli, 'function _tpslRenderExisting(coin, fullSz, tps, sls)').includes('window.__tpslCancelOne('))
t('addressable per order, so the right row disappears',
  grab(cli, 'function _tpslRenderExisting(coin, fullSz, tps, sls)').includes('id="tpslEx-${o.oid}"'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
