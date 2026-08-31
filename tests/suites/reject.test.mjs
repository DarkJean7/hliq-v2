// Reproduces the reported loop: decline in the wallet, count how many signature
// requests the app makes. Drives the REAL sendUsdcOnCore with a stub SDK.
import fs from 'fs'
const src = fs.readFileSync('src/trading.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const grab = (s, sig) => {
  const i = s.indexOf(sig)
  let p = s.indexOf('(', i), pd = 0, k = p
  for (; k < s.length; k++) { if (s[k] === '(') pd++; else if (s[k] === ')') { pd--; if (!pd) break } }
  let j = s.indexOf('{', k), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
}

let prompts = 0
// Exactly what @nktkas/hyperliquid throws when the wallet declines: a generic top-level
// message with the real reason on .cause.
const decline = () => {
  prompts++
  throw Object.assign(new Error('Failed to sign typed data with ethers wallet'),
    { cause: new Error('ethers-user-denied: User rejected the request.') })
}

const build = (perp, spot, behaviour = decline) => {
  prompts = 0
  const calls = []
  const client = {
    usdSend: async (a) => { calls.push(['usdSend', a]); return behaviour() },
    spotSend: async (a) => { calls.push(['spotSend', a]); return behaviour() },
  }
  const fn = new Function('ExchangeClient', 'HttpTransport', 'infoClient', `
    ${grab(src, 'export async function sendUsdcOnCore(').replace('export ', '')}
    return sendUsdcOnCore
  `)(function () { return client }, function () {}, {
    clearinghouseState: async () => ({ withdrawable: String(perp) }),
    spotClearinghouseState: async () => ({ balances: [{ coin: 'USDC', total: String(spot), hold: '0' }] }),
    spotMeta: async () => ({ tokens: [{ name: 'USDC', tokenId: '0xdeadbeef' }] }),
  })
  return { fn, calls }
}

const D = '0x8fe3c39057b6348a27d912423a9770b242911c5d'
const F = '0x1111111111111111111111111111111111111111'

// THE BUG: both pockets funded, user declines.
let { fn, calls } = build(500, 500)
let err = await fn({ from: F, destination: D, amount: 10, signer: {} }).then(() => null, e => e)
t('declining asks for exactly ONE signature, not two', prompts === 1, `${prompts} prompts: ${calls.map(c => c[0])}`)
t('the decline is reported, not swallowed', !!err)
t('the error still carries the real reason for the UI to classify',
  /rejected/i.test(err?.cause?.message ?? ''))

// Route selection, with a stub that succeeds.
const ok = () => ({ status: 'ok' })
;({ fn, calls } = build(500, 0, ok))
await fn({ from: F, destination: D, amount: 10, signer: {} })
t('perp funds use usdSend', calls.length === 1 && calls[0][0] === 'usdSend')

;({ fn, calls } = build(0, 500, ok))
await fn({ from: F, destination: D, amount: 10, signer: {} })
t('spot-only funds use spotSend', calls.length === 1 && calls[0][0] === 'spotSend')
t('spotSend carries the resolved token id', calls[0][1].token === 'USDC:0xdeadbeef')

;({ fn, calls } = build(3, 4, ok))
err = await fn({ from: F, destination: D, amount: 10, signer: {} }).then(() => null, e => e)
t('too little in either pocket never reaches the wallet', calls.length === 0)
t('and it says how much is where', /\$3\.00/.test(err.message) && /\$4\.00/.test(err.message), err?.message)

// $6 + $6 is $12 but neither pocket alone covers $10. Splitting would mean two
// signatures for one payment, so it refuses — and must say what to do about it.
;({ fn, calls } = build(6, 6, ok))
err = await fn({ from: F, destination: D, amount: 10, signer: {} }).then(() => null, e => e)
t('funds split across both pockets never become two signatures', calls.length === 0)
t('and the user is told to consolidate rather than left guessing',
  /Move some between Spot/.test(err?.message ?? ''), err?.message)

// Short in total: no consolidation advice, because consolidating would not help.
;({ fn, calls } = build(1, 1, ok))
err = await fn({ from: F, destination: D, amount: 10, signer: {} }).then(() => null, e => e)
t('a genuinely short balance is not told to shuffle money around',
  !/Move some between Spot/.test(err?.message ?? ''), err?.message)

// The UI classifier must recognise the nested reason.
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const payFn = grab(cli, 'window.__subPayNow = async function()')
const classify = new Function('e', `
  const _T = (en) => en
  ${payFn.slice(payFn.indexOf('const parts = []'), payFn.indexOf('_paperToast(msg'))}
  return msg
`)
t('a nested rejection is shown as cancelled, not as a raw SDK error',
  classify(Object.assign(new Error('Failed to sign typed data with ethers wallet'),
    { cause: new Error('User rejected the request.') })) === 'Payment cancelled.')
t('a rejection nested two deep is still recognised',
  classify(Object.assign(new Error('Failed to sign typed data with ethers wallet'),
    { cause: Object.assign(new Error('provider error'),
      { cause: new Error('MetaMask Tx Signature: User denied') }) })) === 'Payment cancelled.')
t('a real failure is NOT mislabelled as a cancellation',
  classify(new Error('Insufficient balance')) !== 'Payment cancelled.')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
