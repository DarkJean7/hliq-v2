// Send USDC on HyperCore — the routing, the validation, and the button.
import fs from 'fs'
import { sendValidate } from 'file:///C:/Users/jeank/OneDrive/Desktop/hliq-v2/src/trading.js'
const cli  = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const trd  = fs.readFileSync('src/trading.js', 'utf8').replace(/\r\n/g, '\n')
const html = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')
const css  = fs.readFileSync('src/style.css', 'utf8').replace(/\r\n/g, '\n')

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

const A = '0xAAaa000000000000000000000000000000000001'
const B = '0xBBbb000000000000000000000000000000000002'
const base = { connected: true, dest: B, amount: 50, perpFree: 100, spotFree: 0, source: 'perp', self: A }
const v = (o = {}) => sendValidate({ ...base, ...o })

console.log('\n── the blockers, in the order the user can clear them ──')
t('a good send is allowed', v().ok && v().label === 'send')
// Typing a bad address while disconnected must say "connect", not "invalid address":
// connecting is the step in front of them.
t('disconnected beats every other complaint', v({ connected: false, dest: 'junk', amount: -5 }).label === 'connect')
t('an empty destination asks for one, without scolding', v({ dest: '' }).label === 'nodest' && v({ dest: '' }).danger === false)
t('a malformed address is refused', v({ dest: '0xnope' }).label === 'baddest')
t('and explains the format', v({ dest: '0xnope' }).msg === 'badformat')
t('39 hex characters is not an address', v({ dest: '0x' + 'a'.repeat(39) }).ok === false)
t('41 is not either', v({ dest: '0x' + 'a'.repeat(41) }).ok === false)
t('exactly 40 is', v({ dest: '0x' + 'a'.repeat(40) }).ok)
t('case does not matter', v({ dest: B.toUpperCase().replace('0X', '0x') }).ok)
t('sending to yourself is caught', v({ dest: A }).label === 'selfdest')
t('and caught regardless of case', v({ dest: A.toLowerCase() }).label === 'selfdest')
t('a different address is not "yourself"', v({ dest: B }).ok)
t('with no self known, nothing is misflagged as self', v({ self: '', dest: B }).ok)

console.log('\n── amounts ──')
t('no amount asks for one', v({ amount: NaN }).label === 'noamt')
t('zero is not an amount', v({ amount: 0 }).label === 'noamt')
t('negative is not an amount', v({ amount: -10 }).label === 'noamt')
t('more than the pocket holds is refused', v({ amount: 101 }).label === 'nofunds')
t('exactly the balance is allowed', v({ amount: 100 }).ok)
t('a penny over is not', v({ amount: 100.01 }).ok === false)

console.log('\n── the two pockets ──')
t('spot is checked against the spot balance',
  v({ source: 'spot', perpFree: 100, spotFree: 10, amount: 50 }).label === 'nofunds')
t('and allowed when spot can cover it',
  v({ source: 'spot', perpFree: 0, spotFree: 60, amount: 50 }).ok)
// The frustrating case: the money is there, just in the other pocket.
t('when the OTHER pocket could pay, it says to switch rather than just "no"',
  v({ source: 'perp', perpFree: 0, spotFree: 60, amount: 50 }).msg === 'switch')
t('and when neither can, it does not send them on a pointless switch',
  v({ source: 'perp', perpFree: 0, spotFree: 1, amount: 50 }).msg === 'short')
t('the switch hint works in the other direction too',
  v({ source: 'spot', perpFree: 60, spotFree: 0, amount: 50 }).msg === 'switch')

console.log('\n── every refusal is actionable, and only real problems are red ──')
for (const c of [{ connected: false }, { dest: '' }, { dest: 'x' }, { dest: A }, { amount: 0 }, { amount: 1e9 }])
  t(`"${v(c).label}" carries a button label`, !!v(c).label)
t('waiting-for-input states are not painted as errors',
  [v({ connected: false }), v({ dest: '' }), v({ amount: 0 })].every(r => r.danger === false))
t('actual mistakes are', [v({ dest: 'x' }), v({ dest: A }), v({ amount: 1e9 })].every(r => r.danger === true))
t('a valid send still warns that it cannot be undone', v().msg === 'irreversible')

console.log('\n── routing in sendUsdcOnCore ──')
const send = grab(trd, 'export async function sendUsdcOnCore(')
t('an explicit perp source uses usdSend', send.includes("if (source === 'perp' || (source === 'auto' && perpFree >= amt))"))
t('auto still prefers perp, so the subscription flow is unchanged', send.includes("source === 'auto' && perpFree >= amt"))
t('an explicit choice that cannot be covered fails BEFORE any signature is asked for',
  send.indexOf("source === 'perp' && perpFree < amt") < send.indexOf('new ExchangeClient'))
t('and names the shortfall rather than saying "failed"', send.includes('Trading account has $${perpFree.toFixed(2)} free'))
t('the auto-mode both-pockets message is still there for the subscription flow',
  send.includes('Not enough free USDC in one place'))
t('one tap is still at most one signature — no retry after a prompt',
  !/catch[\s\S]{0,200}spotSend/.test(send))
t('the USDC token id is still read from spotMeta, not hardcoded', send.includes('infoClient.spotMeta()'))

console.log('\n── the sheet ──')
const modal = grab(cli, 'function _mobSendModal()')
t('it says an agent key cannot move funds — the reason a wallet is required',
  modal.includes('an agent key cannot move funds'))
t('it offers both pockets with their free balances', modal.includes("pocket('perp'") && modal.includes("pocket('spot'"))
t('your other saved wallets are one tap, so nobody retypes 42 characters',
  grab(cli, 'function _sendRenderAcctPicks()').includes('WM.load()'))
t('and the wallet you are sending FROM is not offered as a destination',
  grab(cli, 'function _sendRenderAcctPicks()').includes("w.addr.toLowerCase() !== me"))
t('it warns this is HyperCore, not an Arbitrum address', modal.includes('not an Arbitrum address'))
t('and points at Withdraw for money leaving Hyperliquid', modal.includes('use Withdraw instead'))
t('MAX floors rather than rounds — rounding up fails after the signature',
  grab(cli, 'window.__sendSetMax = function()').includes('Math.floor'))
t('it opens on whichever pocket can actually pay',
  grab(cli, 'async function _sendLoadBalances()').includes("if (_sendPerpFree <= 0 && _sendSpotFree > 0) window.__sendSetSource('spot')"))
const exec = grab(cli, 'window.__sendExecute = async function()')
t('a declined signature reads as cancelled, not as a crash', exec.includes('Cancelled in your wallet'))
t('the cause chain is walked — the SDK hides the real reason underneath', exec.includes('cur = cur.cause'))
t('balances and the dashboard refresh after a send', exec.includes('_sendLoadBalances()') && exec.includes('refreshLive(true)'))
t('paper mode does not pretend to send real money',
  grab(cli, 'window.mobVSend = function()').includes('Send moves real USDC'))

console.log('\n── the Home button ──')
t('Send sits next to Deposit and Withdraw', html.includes("window.mobVSend()"))
t('and after them, not before', html.indexOf('mobVSend') > html.indexOf('mobVWithdraw'))
t('it is a labelled pill, like they are', /mob-v-act-pill" onclick="window\.mobVSend\(\)/.test(html))
// Three labels + two icon squares do not fit a 390px phone with the arrows shown.
t('the icons drop early enough that no label has to ellipsis', css.includes('@media (max-width: 460px)'))
t('and the reason is written down', css.includes('Three labelled pills now share the row'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
