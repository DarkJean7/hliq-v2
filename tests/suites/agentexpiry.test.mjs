// An agent approval is capped at 180 days, so a key that has signed for months stops working
// on a date nobody wrote down. The app used to discover that at the moment an order was
// rejected — usually a close — and then blamed the wrong cause: "replaced on another device",
// when the key on the device was the right one all along. This asserts both halves of the fix:
// the expiry is known in advance, and a lapsed approval is told apart from a wrong key.
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

console.log('\n-- the expiry is fetched, not just the membership --')
t('there is a records fetcher', trd.includes('export async function fetchAgentRecords(master'))
const recs = grab(trd, 'export async function fetchAgentRecords(master')
t('it keeps validUntil', recs.includes('validUntil:'))
t('and marks what has already lapsed', recs.includes('expired: until != null && until <= now'))
t('a missing expiry is null, not zero, because absent is not "expires at the epoch"',
  recs.includes("a?.validUntil == null ? null : Number(a.validUntil)"))

console.log('\n-- the approved-set is derived from it, so asking costs no extra request --')
const appr = grab(trd, 'export async function fetchApprovedAgents(master')
t('it calls the records fetcher', appr.includes('await fetchAgentRecords(master'))
t('it still returns a Set of addresses', appr.includes('const addrs = new Set()'))
t('expired agents are excluded', appr.includes('if (!r.expired) addrs.add(addr)'))
t('one cache serves both', (trd.match(/_agentListCache\.set\(/g) ?? []).length === 1)
t('both still share one invalidation', trd.includes('export function invalidateApprovedAgents(master)'))

// The filter itself, over a list shaped like HL's.
const NOW = 1_800_000_000_000
const build = list => {
  const recs = new Map()
  for (const a of list) {
    const addr = String(a?.address ?? '').toLowerCase()
    if (!addr) continue
    const until = a?.validUntil == null ? null : Number(a.validUntil)
    recs.set(addr, { validUntil: Number.isFinite(until) ? until : null, expired: until != null && until <= NOW })
  }
  return recs
}
const r = build([
  { address: '0xLIVE', name: 'ok',   validUntil: NOW + 86400e3 },
  { address: '0xDEAD', name: 'gone', validUntil: NOW - 1 },
  { address: '0xFOREVER', name: 'noexp' },
])
t('a live agent is not expired', r.get('0xlive').expired === false)
t('a lapsed one is', r.get('0xdead').expired === true)
t('one with no expiry never expires', r.get('0xforever').expired === false && r.get('0xforever').validUntil === null)

console.log('\n-- lapsed is told apart from wrong --')
const pf = grab(cli, 'async function _preflightAgent(acct)')
t('the preflight reads records, not just the set', pf.includes('await fetchAgentRecords(master)'))
t('it still fails open when the check itself cannot run', pf.includes('catch { return { ok: true } }'))
t('a visibly expired record is reported as expired', pf.includes("mine?.expired || !anyValid ? 'expired'"))
t('so is an absent one when the account has no valid agent at all — which is what HL pruning looks like',
  pf.includes('const anyValid = [...recs.values()].some(r => !r.expired)'))
t('a wrong key alongside valid agents is still not-approved', pf.includes("'not-approved'"))
t('a healthy key records when it will lapse', pf.includes('_agentExpiry.set(master, mine.validUntil ?? null)'))
t('and a failed one stops claiming an expiry', pf.includes('_agentExpiry.delete(master)'))
t('the reason is explained where the next reader will be', pf.includes('HL prunes lapsed agents'))

// The reason logic, run rather than read.
const reasonOf = new Function('mine', 'recs', `
  const anyValid = [...recs.values()].some(r => !r.expired)
  return mine?.expired || !anyValid ? 'expired' : 'not-approved'
`)
t('expired record → expired',
  reasonOf({ expired: true }, build([{ address: '0xa', validUntil: NOW + 1 }])) === 'expired')
t('pruned, nothing valid left → expired',
  reasonOf(undefined, build([])) === 'expired')
t('unknown key while others are valid → not-approved',
  reasonOf(undefined, build([{ address: '0xa', validUntil: NOW + 86400e3 }])) === 'not-approved')

console.log('\n-- the sheet names the cause it actually found --')
const prompt = grab(cli, 'async function _agentInvalidPrompt(master, agentAddr')
t('it takes the reason', cli.includes("async function _agentInvalidPrompt(master, agentAddr, reason = 'not-approved')"))
t('the gate passes it through', grab(cli, 'async function _guardAgent(acct)').includes('_agentInvalidPrompt(r.master, r.agentAddr, r.reason)'))
t('an expiry gets its own title', prompt.includes("_T('Agent key expired'"))
t('and says the 180-day cap is why it reads as unknown', prompt.includes('caps an approval at 180 days'))
t('it does not blame another device when nothing changed there',
  prompt.includes('nothing was changed on another device'))
t('the wrong-key wording is kept for the wrong-key case',
  prompt.includes('the key was replaced by one generated on another device'))
t('either way it says funds are unaffected',
  (prompt.match(/funds and positions are unaffected/g) ?? []).length === 2)
t('both still offer the one-tap fix', prompt.includes("_T('⚡ Regenerate key'"))

console.log('\n-- and a week of warning before it happens --')
t('there is an expiry store', cli.includes('const _agentExpiry = new Map()'))
t('seven days is the window', cli.includes('const AGENT_EXPIRY_WARN_MS = 7 * 86400e3'))
t('the UI can ask how long is left', cli.includes('window.__agentKeyExpiringIn = addr =>'))
const days = new Function('until', 'now', `
  const WARN = 7 * 86400e3
  if (!until) return null
  const left = until - now
  if (left <= 0 || left > WARN) return null
  return Math.max(1, Math.ceil(left / 86400e3))
`)
t('a key with months left says nothing', days(NOW + 60 * 86400e3, NOW) === null)
t('six days out it warns', days(NOW + 6 * 86400e3, NOW) === 6)
t('an hour out it still reads as a day rather than rounding to zero', days(NOW + 3600e3, NOW) === 1)
t('once lapsed it is the error path, not the warning', days(NOW - 1, NOW) === null)
t('an unknown expiry is silent, not a warning — empty is not the same as unknown', days(null, NOW) === null)

console.log('\n-- both shells show it --')
const st = grab(cli, 'function _agentStatusFor(addr)')
t('the shared status line warns', st.includes('window.__agentKeyExpiringIn?.(addr)'))
t('in warn colour, not the error red', st.includes("Expires in ${days}d for") && st.includes("colour: 'var(--warn)'"))
t('a bad key still outranks an expiring one', st.indexOf('__agentKeyBad') < st.indexOf('__agentKeyExpiringIn'))
t('the mobile settings pane warns too', cli.includes('const agentDays    = !savedKey || agentBad ? null : window.__agentKeyExpiringIn?.(_agentUiAddr())'))
t('and only when there is a key to warn about', cli.includes('!savedKey || agentBad ? null'))
t('the sweep fills the expiry in for healthy keys', grab(cli, 'async function _sweepAgentKeys()').includes('if (r.ok && !_agentExpiry.has(key))'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
