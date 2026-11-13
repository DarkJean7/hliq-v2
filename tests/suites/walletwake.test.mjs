// "The message to sign the tx was not getting in the wallet app."
//
// A WalletConnect wallet is another app. Every flow opened it on a 350ms timer after firing the
// request, but a Send first reads balances, the account mode and the token from Hyperliquid, so
// the wallet opened before the request existed -- and a phone suspends the browser as soon as it
// leaves the screen, so the request was then never sent. The wallet now opens when WalletConnect
// says the request went out (session_request_sent). The functions are lifted from src/wallet.js
// and run against a fake client, as the real one is a relay socket.
import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? pass++ : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const src = readFileSync(new URL('../../src/wallet.js', import.meta.url), 'utf8')
const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
const grab = (name) => new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`).exec(src)?.[0]

const window = { location: { href: 'https://insolvent.trade/app' } }
const { _openWalletApp, _wakeOnSent } = new Function('window', `${grab('_openWalletApp')}\n${grab('_wakeOnSent')}\nreturn { _openWalletApp, _wakeOnSent }`)(window)

const fakeWc = (topic, redirect) => {
  const client = new EventEmitter()
  return { setDefaultChain() {}, session: { topic, peer: { metadata: { redirect } } }, signer: { client, session: { topic } } }
}
const APP = 'https://insolvent.trade/app'

const wc = fakeWc('t1', { native: 'metamask://', universal: 'https://metamask.app.link' })
_wakeOnSent(wc)
t('hooked once', wc.__wakeOnSent === true)
t('nothing opens before the request has gone out', window.location.href === APP, window.location.href)
wc.signer.client.emit('session_request_sent', { topic: 't1', id: 1 })
t('the wallet opens when it has', window.location.href === 'metamask://', window.location.href)

window.location.href = APP
wc.signer.client.emit('session_request_sent', { topic: 'someone-else', id: 2 })
t('not for another session\'s request', window.location.href === APP, window.location.href)

window.location.href = APP
_wakeOnSent(wc)
wc.signer.client.emit('session_request_sent', { topic: 't1', id: 3 })
t('hooking twice does not add a second listener', wc.signer.client.listenerCount('session_request_sent') === 1)

const uni = fakeWc('t2', { universal: 'https://link.trustwallet.com' })
window.location.href = APP
_wakeOnSent(uni); uni.signer.client.emit('session_request_sent', { topic: 't2' })
t('a universal link when there is no app scheme', window.location.href === 'https://link.trustwallet.com', window.location.href)

const none = fakeWc('t3', null)
window.location.href = APP
_wakeOnSent(none); none.signer.client.emit('session_request_sent', { topic: 't3' })
t('no redirect: nothing is navigated', window.location.href === APP, window.location.href)
t('an extension has no client and is left alone', (() => { const ext = { request() {} }; _wakeOnSent(ext); return !ext.__wakeOnSent })())

// The wiring around it.
t('connectWallet hooks a WalletConnect session as it connects', /await wc\.connect\(\)\s*\n\s*_wakeOnSent\(wc\)/.test(src))
t('the timer-based wake does nothing for a hooked session', /if \(raw\.__wakeOnSent\) return true/.test(grab('wakeWallet') ?? src))
t('Send offers a tap to open the wallet if it did not come up', /Open your wallet app/.test(main) && /window\.__openWalletApp = function/.test(main))
t('and clears that offer once the send settles', (main.match(/clearTimeout\(_waitHint\)/g) ?? []).length === 2)

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
