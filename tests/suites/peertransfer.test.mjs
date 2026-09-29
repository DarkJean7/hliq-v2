// Transfers between wallets that are all in "All Accounts" are transfers, not deposits and
// withdrawals.
//
// Asked for: "when an account from all accounts send assets to another account that is also in
// all accounts it should not count as a deposit or withdrawal. label them just as transfers ...
// only do deposit/withdrawals when they are literally it or if the account depositing/receiving
// is not in all accounts. i dont want the sum to affect the real deposits/withdrawals cards".
// A $250 send from Spartan to Insolvent showed as Withdrawn -$250 AND Deposited +$250.
import fs from 'fs'
import { setLedgerPeers, isPeerTransfer, isPeerMirror, peerRoute, peerAmount } from '../../src/ledgerpeers.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const rnd = fs.readFileSync('src/render.js', 'utf8').replace(/\r\n/g, '\n')
// ledgerFlow lives in render.js, which cannot load without a DOM. The REAL functions are lifted
// out of its source and run against the real peer module -- a stand-in here would test itself.
const lift = (src, sig) => {
  const i = src.indexOf(sig); if (i < 0) throw new Error('missing ' + sig)
  if (sig.startsWith('const ')) return src.slice(i, src.indexOf('\n', i))
  let j = src.indexOf('{', src.indexOf(')', i)), d = 0
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) break } }
  return src.slice(i, j + 1).replace(/^export /, '')
}
const ledgerFlow = new Function('isPeerTransfer', `
  ${lift(rnd, 'const _FLOW_TYPES')}
  ${lift(rnd, 'const _realAddr')}
  ${lift(rnd, 'export function ledgerAmount(')}
  ${lift(rnd, 'export function ledgerOwner(')}
  ${lift(rnd, 'export function ledgerFlow(')}
  return ledgerFlow`)(isPeerTransfer)

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40), X = '0x' + 'c'.repeat(40)
const send = (from, to, owner, usd = 250) => ({
  time: 1, _acctAddr: owner, delta: { type: 'send', user: from, destination: to, token: 'USDC', amount: String(usd), usdcValue: String(usd) },
})
const peers = new Map([[A, 'Spartan'], [B, 'Insolvent']])

console.log(nl + '-- in All Accounts --')
setLedgerPeers(() => peers)
const out = send(A, B, A), inn = send(A, B, B)
t('the sender\'s row is not a withdrawal', ledgerFlow(out) === 0)
t('the receiver\'s row is not a deposit', ledgerFlow(inn) === 0)
t('both are recognised as a transfer between wallets in view', isPeerTransfer(out) && isPeerTransfer(inn))
t('the receiver\'s copy is the mirror, listed once through the sender', isPeerMirror(inn) && !isPeerMirror(out))
t('named for what it was', peerRoute(out) === 'Spartan → Insolvent')
t('sized, unsigned', peerAmount(out) === 250)
// Money from or to a wallet NOT in view is still money in or out.
t('a send to a wallet outside the view is still a withdrawal', ledgerFlow(send(A, X, A)) === -250)
t('a send from outside is still a deposit', ledgerFlow(send(X, B, B)) === 250)
t('and neither is relabelled', !isPeerTransfer(send(A, X, A)) && peerRoute(send(X, B, B)) === null)
t('a bridge deposit is a deposit', ledgerFlow({ time: 1, _acctAddr: A, delta: { type: 'deposit', usdc: '100' } }) === 100)
t('a bridge withdrawal is a withdrawal', ledgerFlow({ time: 1, _acctAddr: A, delta: { type: 'withdraw', usdc: '40' } }) === -40)
t('internal and sub-account transfers between two in view count as transfers too',
  ledgerFlow({ time: 1, _acctAddr: A, delta: { type: 'internalTransfer', usdc: '10', user: A, destination: B } }) === 0 &&
  ledgerFlow({ time: 1, _acctAddr: A, delta: { type: 'subAccountTransfer', usdc: '10', user: A, destination: B } }) === 0)

console.log(nl + '-- in a single account --')
setLedgerPeers(() => null)
t('the same send out of the account on screen is a withdrawal', ledgerFlow(out) === -250)
t('and into it, a deposit', ledgerFlow(inn) === 250)
t('with nothing relabelled', !isPeerTransfer(out) && !isPeerMirror(inn))

console.log(nl + '-- one rule, everywhere --')
t('the view says who is in it, asked each time rather than remembered', cli.includes('setLedgerPeers(() => {') &&
  cli.includes('if (!state.isAllAccounts) return null'))
t('hidden wallets are not in it', /setLedgerPeers\(\(\) => \{[\s\S]{0,300}!hidden\.has\(e\.addr\)/.test(cli))
t('Net Deposited uses it', /function _netDepositedFromLedger\(\) \{[\s\S]{0,300}ledgerFlow\(e/.test(cli))
t('the portfolio stats use it', cli.includes('const v = ledgerFlow(e, e._acctAddr ?? state.addr)'))
t('each wallet\'s totals use it, computed each time -- not cached with a stale answer',
  cli.includes('const v = ledgerFlow(e, r.addr)') && !cli.includes('_maLedgerCache.set(r.addr, { totalDeposited'))
t('no copy of the old rule is left', !/if \(\(d\.destination \?\? ''\)\.toLowerCase\(\) === (me|_me)\) (dep|totalDeposited) \+= v/.test(cli))
t('chart markers use it', !cli.includes("((ty === 'send' || ty === 'spotTransfer') && amt > 0)"))
t('the calendar lists a transfer once', rnd.includes('!isPeerMirror(e, cache.owner)') && rnd.includes('if (isPeerMirror(e, owner)) continue'))
t('and labels it Transfer', rnd.includes('<span class="badge badge-transfer">Transfer</span>'))
t('so does the Transfers tab', rnd.includes("visible.filter(e => !isPeerMirror(e, addr))") && cli.includes("'Transfer · ' + route"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
