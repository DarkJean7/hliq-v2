// Naming a signing failure, and making the rate-limit records distinguishable.
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

const text = new Function('e', `
  const _T = (en) => en
  ${grab(cli, 'function _signErrorText(e)').replace('function _signErrorText(e) {', '').slice(0, -1)}
`)

console.log('\n-- the real reason lives on .cause --')
// The SDK always reports the same top-level line; the cause chain carries the truth.
const wrap = (msg) => Object.assign(new Error('Failed to sign typed data with ethers v6 wallet'), { cause: new Error(msg) })
t('a two-extension conflict is named, not passed through',
  text(wrap('Cannot redefine property: ethereum')).includes('more than one wallet extension'))
t('the read-only-window variant too', text(wrap('Cannot set property ethereum of #<Window> which has only a getter')).includes('more than one wallet extension'))
t('and a disconnected provider', text(wrap('The provider is disconnected from all chains.')).includes('more than one wallet extension'))
t('a declined prompt reads as cancelled, not as an error',
  text(wrap('user rejected action')) === 'Cancelled in your wallet.')
t('rejection wins over the provider check when both words appear',
  text(wrap('User rejected the request')) === 'Cancelled in your wallet.')
t('anything else surfaces its own deepest message', text(wrap('insufficient balance')) === 'insufficient balance')
t('a bare error still says something', text(new Error('boom')) === 'boom')
t('and an empty one does not render blank', text(new Error('')).length > 0)
t('the chain is walked several deep', (() => {
  const deep = Object.assign(new Error('a'), { cause: Object.assign(new Error('b'), { cause: new Error('Cannot redefine property: ethereum') }) })
  return text(deep).includes('more than one wallet extension')
})())
t('it cannot loop forever on a cyclic cause', (() => {
  const a = new Error('x'); a.cause = a
  return typeof text(a) === 'string'
})())

console.log('\n-- the withdraw sheet uses it --')
t('instead of the SDK text', grab(cli, 'window.__executeWithdraw = async function()').includes('_signErrorText(e)'))
t('and escapes it, since it can carry provider text', cli.includes('esc(_signErrorText(e))'))

console.log('\n-- rate-limit records can be told apart now --')
const rep = grab(cli, 'function _hlReportLimit()')
t('the age is in the MESSAGE, which is the dedup key', rep.includes('age=${secSinceLoad < 60'))
t('bucketed, so episodes group instead of each making a record', rep.includes("'<1m' :") && rep.includes("'>30m'"))
t('and the trip reason travels with it', rep.includes('_hlLastTripReason'))
t('why the stack was not enough is recorded', rep.includes('keeps\n        // only the first occurrence'))

const h = grab(cli, 'function _hl429(e)')
t('a real 429 is labelled as such', h.includes("_hlLastTripReason = 'real-429'"))
t('a network-shaped failure is labelled separately', h.includes("_hlLastTripReason = 'network-shaped'"))
t('both still trip the breaker — HL 429s arrive without CORS headers', (h.match(/_hlTrip\(\)/g) ?? []).length === 2)
t('and the reason that forces the ambiguity is written down', cli.includes('WITHOUT CORS headers'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
