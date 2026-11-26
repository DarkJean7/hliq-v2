// Owner-only writes refuse a bare address.
//
// On 2026-11-12 a scripted scan walked the API with addresses taken from the public board. Three
// writes believed whatever address they were sent: it burned ten wallets' free trials, pointed
// payments from six wallets at other wallets, and rewrote the contest winner's payout address
// (src/ownerproof.js). This drives the real ownerProofError out of server.js with real
// signatures, and checks that each of the three handlers asks it before writing anything.
import fs from 'fs'
import { ethers } from 'ethers'
import { trialMessage, payFromMessage, PROOF_MAX_AGE_MS } from '../../src/ownerproof.js'

const SRV = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(ok ? '  PASS' : '  FAIL', n, ok ? '' : `→ ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`) }
const grab = (src, sig) => {
  const start = src.indexOf(sig); if (start < 0) throw new Error('not found: ' + sig)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1) }
  throw new Error('unbalanced: ' + sig)
}

// ── the check itself, run for real ──
const LB_PIN = 'pin-1234'
let approved = new Set()                    // `${master}|${agent}` Hyperliquid "lists"
const getAuth = (req) => req.headers.authorization === 'Bearer agent-tok' ? { signer: '0xa9e7', admin: false } : null
const agentApprovedFor = async (m, a) => approved.has(`${m}|${a}`)
const ownerProofError = new Function('LB_PIN', 'getAuth', 'agentApprovedFor', 'ethers', 'PROOF_MAX_AGE_MS',
  `return (${grab(SRV, 'async function ownerProofError(').replace(/^async function ownerProofError/, 'async function')})`)(LB_PIN, getAuth, agentApprovedFor, ethers, PROOF_MAX_AGE_MS)

const owner = ethers.Wallet.createRandom(), other = ethers.Wallet.createRandom()
const A = owner.address.toLowerCase()
const req = (h = {}) => ({ headers: h })
const status = async (p) => (await p)?.status ?? 'ok'
const msg = ts => trialMessage(A, ts)

t('nothing but the address → refused, and told to sign', await ownerProofError(req(), {}, A, msg).then(r => [r?.status, r?.body?.needSignature]), [401, true])
let ts = Date.now()
t('signed by the wallet itself → allowed', await status(ownerProofError(req(), { ts, signature: await owner.signMessage(msg(ts)) }, A, msg)), 'ok')
t('signed by a different wallet → refused', await status(ownerProofError(req(), { ts, signature: await other.signMessage(msg(ts)) }, A, msg)), 403)
ts = Date.now() - PROOF_MAX_AGE_MS - 60_000
t('an old signature cannot be replayed → refused', await status(ownerProofError(req(), { ts, signature: await owner.signMessage(msg(ts)) }, A, msg)), 400)
ts = Date.now()
const trialSig = await owner.signMessage(trialMessage(A, ts))
t('a signature for a different action cannot be reused → refused', await status(ownerProofError(req(), { ts, signature: trialSig }, A, t2 => payFromMessage(A, other.address, t2))), 403)
t('garbage signature → refused', await status(ownerProofError(req(), { ts, signature: '0xdead' }, A, msg)), 400)
t('operator PIN → allowed', await status(ownerProofError(req({ 'x-lb-pin': LB_PIN }), {}, A, msg)), 'ok')
t('wrong PIN → refused outright', await status(ownerProofError(req({ 'x-lb-pin': 'guess' }), {}, A, msg)), 403)
t('agent session HL does NOT list for this wallet → refused', await status(ownerProofError(req({ authorization: 'Bearer agent-tok' }), {}, A, msg)), 401)
approved.add(`${A}|0xa9e7`)
t('agent session HL lists for this wallet → allowed', await status(ownerProofError(req({ authorization: 'Bearer agent-tok' }), {}, A, msg)), 'ok')

// ── each handler asks before it writes ──
const handler = (route) => { const i = SRV.indexOf(`path === '${route}'`); return SRV.slice(i, SRV.indexOf('\n  }\n', i)) }
const gatedBefore = (route, write, who) => {
  const h = handler(route), g = h.indexOf(`ownerProofError(req, b, ${who}`), w = h.indexOf(write)
  return g > 0 && w > g
}
t('/api/sub/trial: the wallet proves itself before its trial is spent', gatedBefore('/api/sub/trial', 'subExtend(', 'b.address'), true)
t('/api/sub/payfrom: the PAYER proves itself before its payments are redirected', gatedBefore('/api/sub/payfrom', 'subPayWrite(', 'b.payer'), true)
const claim = handler('/api/challenge/claim')
t('/api/challenge/claim: a payout wallet once set is not replaced without the PIN',
  /store\[id\]\.addr && store\[id\]\.addr !== /.test(claim) && claim.indexOf('409') < claim.indexOf('saveChal('), true)
t('/api/challenge/claim: closed after the round', /CHALLENGE\.end \+ 14 \* 86400_000/.test(claim), true)

// ── the app sends the proof ──
const trialFn = grab(CLI, 'window.__subStartTrial = async function')
const payFn = grab(CLI, 'window.__subPayFrom = async function')
t('the app signs the trial for the wallet it enables', /_ownerProof\(addr, ts => trialMessage\(addr, ts\)\)/.test(trialFn) && /\.\.\.proof\.body/.test(trialFn), true)
t('the app has the PAYING wallet sign a payment redirect', /_ownerProof\(payer, ts => payFromMessage\(payer, addr, ts\)\)/.test(payFn) && /\.\.\.proof\.body/.test(payFn), true)

// ── the operator PIN cannot be guessed at leisure ──
{
  const src = ['PIN_WINDOW_MS', '_pinFails', '_pinFailsAll'].map(k => SRV.match(new RegExp(`^(const|let) ${k}[^\\n]*`, 'm'))[0]).join('\n')
  const lim = new Function(`${src}
    ${grab(SRV, 'function pinLocked(')}
    ${grab(SRV, 'function pinFailed(')}
    return { pinLocked, pinFailed }`)
  const warn = console.warn; console.warn = () => {}
  let L = lim(), now = 1e12
  for (let i = 0; i < 4; i++) L.pinFailed('1.1.1.1', now)
  const four = L.pinLocked('1.1.1.1', now)
  L.pinFailed('1.1.1.1', now)
  t('one IP: locked after 5 wrong PINs, not before', [four, L.pinLocked('1.1.1.1', now), L.pinLocked('2.2.2.2', now)], [false, true, false])
  t('one IP: unlocked again after the hour', L.pinLocked('1.1.1.1', now + 61 * 60_000), false)
  L = lim()
  for (let i = 0; i < 20; i++) L.pinFailed('10.0.0.' + i, now)     // a new address for every guess
  t('many IPs, one guess each: everyone is locked after 20 in the hour', L.pinLocked('9.9.9.9', now), true)
  console.warn = warn
  const top = SRV.slice(SRV.indexOf('const server = createServer('), SRV.indexOf("path === '/api/auth/nonce'"))
  t('the lock is checked before any route sees a PIN, on header and query alike',
    /x-lb-pin.*searchParams\.get\('pin'\)/.test(top) && top.indexOf('pinLocked(ip)') < top.indexOf('pinFailed(ip)'), true)
  t('the PIN is compared in constant time', /timingSafeEqual/.test(grab(SRV, 'function pinMatches(')), true)
}

// ── which wallets run bots is not public ──
const all = handler('/api/status/all')
t('/api/status/all: without the PIN it answers only for addresses it is given',
  /if \(!operator && !named\.size\) return json\(res, 200, \{\}\)/.test(all) && /!operator && !named\.has\(addr\)/.test(all), true)
t('the app asks only about its own saved wallets', !/serverFetch\('\/api\/status\/all'\)/.test(CLI) && /\/api\/status\/all\?addrs=/.test(grab(CLI, 'function _botStatusMine(')), true)

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
