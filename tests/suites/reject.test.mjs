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

const build = (perp, spot, behaviour = decline, mode = 'default') => {
  prompts = 0
  const calls = []
  const client = {
    usdSend: async (a) => { calls.push(['usdSend', a]); return behaviour() },
    spotSend: async (a) => { calls.push(['spotSend', a]); return behaviour() },
    sendAsset: async (a) => { calls.push(['sendAsset', a]); return behaviour() },
  }
  const fn = new Function('ExchangeClient', 'HttpTransport', 'infoClient', 'infoTransport', `
    const UNIFIED_SEND_GAS = 0.05
    ${grab(src, 'export async function sendUsdcOnCore(').replace('export ', '')}
    return sendUsdcOnCore
  `)(function () { return client }, function () {}, {
    clearinghouseState: async () => ({ withdrawable: String(perp) }),
    spotClearinghouseState: async () => ({ balances: [{ coin: 'USDC', total: String(spot), hold: '0' }] }),
    spotMeta: async () => ({ tokens: [{ name: 'USDC', tokenId: '0xdeadbeef' }] }),
  }, { request: async () => mode })   // userAbstraction: the account's mode
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

// Reported: "Action disabled when unified account is active" — Send from Spot on a unified
// account. There is one balance there (on the spot side) and spotSend is refused, so the
// route is decided from the account's mode, before any prompt. usdSend was refused too
// (reported again), so it is one sendAsset, spot to spot.
{
  const ok = () => { prompts++; return { status: 'ok' } }
  const u = build(0, 246.25, ok, 'unifiedAccount')
  await u.fn({ from: F, destination: D, amount: 150, signer: {}, source: 'spot' })
  t('a unified account sends with ONE sendAsset spot to spot, never usdSend/spotSend — whichever pocket was picked', u.calls.length === 1 && u.calls[0][0] === 'sendAsset' && u.calls[0][1].sourceDex === 'spot' && u.calls[0][1].destinationDex === 'spot' && u.calls[0][1].token === 'USDC:0xdeadbeef' && prompts === 1, u.calls.map(c => c[0]))
  const big = build(0, 100, ok, 'unifiedAccount')
  const e2 = await big.fn({ from: F, destination: D, amount: 150, signer: {}, source: 'spot' }).then(() => null, e => e)
  t('and more than its one balance fails BEFORE any signature, saying what it has', big.calls.length === 0 && /unified account has \$100\.00/.test(String(e2?.message)), e2?.message)
  // Reported next: "Insufficient USDC balance for token transfer gas" on a MAX send — the gas
  // comes out of the same balance, so all of it is refused before the prompt.
  const all = build(0, 199.06, ok, 'unifiedAccount')
  const e3 = await all.fn({ from: F, destination: D, amount: 199.06, signer: {}, source: 'spot' }).then(() => null, e => e)
  t('sending the whole unified balance is refused before signing, naming what can go', all.calls.length === 0 && /at most \$199\.01/.test(String(e3?.message)), e3?.message)
  const split = build(0, 246.25, ok, 'default')
  await split.fn({ from: F, destination: D, amount: 150, signer: {}, source: 'spot' })
  t('a split account still sends spot USDC with spotSend', split.calls[0]?.[0] === 'spotSend')
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
