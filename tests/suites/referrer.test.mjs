// The house referral code, on every account that arrives without one.
//
// Asked for: "make that anyone that connects to my app and does not have a referral code it
// uses mine." It already happened on four agent-key paths, so a wallet that connected and
// never set up trading was never referred — and each of those four fired blind, spending a
// signed request to be told the account was already referred.
//
// What makes this worth a suite rather than a one-liner: the account being written to is
// usually NOT the operator's, and a referrer cannot be changed once set. So the funnel has to
// ask Hyperliquid first, act only on an empty slot, and never nag. Those are behaviours, and
// they are driven here for real — the function is lifted out of main.js and run against stubs.
import fs from 'fs'

const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const TRD = fs.readFileSync('src/trading.js', 'utf8').replace(/\r\n/g, '\n')

const grab = (src, sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error('not found: ' + sig)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced: ' + sig)
}

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const ME    = '0x' + 'a'.repeat(40)
const OTHER = '0x' + 'b'.repeat(40)

/** The real funnel, with the world stubbed around it. */
function harness({ referredBy = null, agent = false, mainAddr = null, signer = null,
                   store = {}, throwOn = null } = {}) {
  const calls = { referrerOf: 0, agent: 0, withSigner: 0 }
  const api = new Function('cfg', 'calls', `
    const localStorage = {
      getItem: (k) => Object.hasOwn(cfg.store, k) ? cfg.store[k] : null,
      setItem: (k, v) => { cfg.store[k] = String(v) },
    }
    const console = { debug: () => {} }
    const state = { addr: cfg.viewing }
    const referrerOf = async (a) => {
      calls.referrerOf++
      if (cfg.throwOn === 'referrerOf') throw new Error('offline')
      return cfg.referredBy
    }
    const applyReferrer = async () => {
      calls.agent++
      if (cfg.throwOn === 'agent') throw new Error('already referred')
      return { ok: true }
    }
    const applyReferrerWith = async (s) => {
      calls.withSigner++
      if (cfg.throwOn === 'wallet') throw new Error('user rejected')
      return { ok: true }
    }
    const isConnected    = () => cfg.agent
    const getMainAddress = () => cfg.mainAddr
    const getHlSigner    = () => cfg.signer
    ${CLI.match(/const _isRealAddr = .*/)[0]}
    ${CLI.match(/const _REF_KEY = .*/)[0]}
    ${CLI.match(/const _REF_RETRY_MS = .*/)[0]}
    ${grab(CLI, 'function _refState()')}
    ${grab(CLI, 'function _refRecord(addr, s)')}
    ${grab(CLI, 'async function _ensureReferrer(addr = state.addr)')}
    return _ensureReferrer`)
  const fn = api({ referredBy, agent, mainAddr, signer, store, throwOn, viewing: ME }, calls)
  return { run: (a) => fn(a), calls, store }
}
const recorded = (store, addr = ME) => {
  try { return JSON.parse(store['hliq_ref_state'] || '{}')[addr.toLowerCase()]?.s ?? null }
  catch { return null }
}

console.log(nl + '-- an account that already has a referrer is never touched --')
{
  // It cannot be changed, so trying is pointless; and asking first is what stops us spending a
  // signature to be told no.
  const h = harness({ referredBy: { code: 'RABBYWALLET' }, agent: true })
  await h.run(ME)
  t('it asked Hyperliquid', h.calls.referrerOf === 1)
  t('and signed nothing', h.calls.agent === 0 && h.calls.withSigner === 0, h.calls)
  t('the outcome is remembered as settled', recorded(h.store) === 'had')
  // Second visit: no info call either. Every account switch would otherwise repeat it.
  const before = h.calls.referrerOf
  await h.run(ME)
  t('and it is not asked about again', h.calls.referrerOf === before)
}

console.log(nl + '-- an empty slot gets the code, from whichever signer exists --')
{
  const h = harness({ referredBy: null, agent: true })
  await h.run(ME)
  t('the agent key signs it, with no prompt', h.calls.agent === 1 && h.calls.withSigner === 0)
  t('and that is recorded', recorded(h.store) === 'set')
  await h.run(ME)
  t('once, not once per render', h.calls.agent === 1)
}
{
  // Someone who connected a wallet but never set up trading — the case that was missing.
  const h = harness({ referredBy: null, agent: false, mainAddr: ME, signer: { sign: 1 } })
  await h.run(ME)
  t('the main wallet signs it when there is no agent key', h.calls.withSigner === 1)
  t('and that is recorded too', recorded(h.store) === 'set')
}

console.log(nl + '-- and nothing is signed for an account this browser cannot sign for --')
{
  // A wallet connected for a DIFFERENT account must never be asked to sign for this one.
  const h = harness({ referredBy: null, agent: false, mainAddr: OTHER, signer: { sign: 1 } })
  await h.run(ME)
  t('a wallet for another account does not sign', h.calls.withSigner === 0 && h.calls.agent === 0)
  // Deliberately NOT recorded: the moment a key for this account shows up, it should run.
  t('and the account is left open for a later attempt', recorded(h.store) === null)
}
{
  const h = harness({ referredBy: null, agent: false, mainAddr: null })
  await h.run(ME)
  t('a watched address with no keys signs nothing', h.calls.withSigner === 0 && h.calls.agent === 0)
}
{
  const h = harness({ referredBy: null, agent: true })
  await h.run('__all_accounts__'); await h.run('paper'); await h.run(''); await h.run(null)
  await h.run('0xnope')
  t('the sentinels and junk never reach Hyperliquid', h.calls.referrerOf === 0, h.calls)
}
{
  const h = harness({ referredBy: null, agent: true, store: { hliq_no_ref: '1' } })
  await h.run(ME)
  t('an opted-out device does nothing at all', h.calls.referrerOf === 0 && h.calls.agent === 0)
}

console.log(nl + '-- a failure is quiet, remembered, and retried only much later --')
{
  // Rejected in the wallet, not eligible, offline: all the same to us. Nothing on screen waits
  // on a referral, and nothing should break because one did not stick.
  const h = harness({ referredBy: null, agent: true, throwOn: 'agent' })
  let threw = false
  try { await h.run(ME) } catch { threw = true }
  t('it does not throw at its caller', threw === false)
  t('the attempt is remembered', recorded(h.store) === 'no')
  await h.run(ME)
  t('and not retried the same day', h.calls.agent === 1, h.calls)
}
{
  // An inconclusive attempt is worth one more go eventually — unlike 'set' and 'had', which are
  // final because the slot cannot change.
  const day = 24 * 60 * 60 * 1000
  const stale = { hliq_ref_state: JSON.stringify({ [ME.toLowerCase()]: { s: 'no', at: Date.now() - day - 1000 } }) }
  const h = harness({ referredBy: null, agent: true, store: stale })
  await h.run(ME)
  t('a day later it tries again', h.calls.agent === 1)
  const settled = { hliq_ref_state: JSON.stringify({ [ME.toLowerCase()]: { s: 'had', at: 0 } }) }
  const h2 = harness({ referredBy: null, agent: true, store: settled })
  await h2.run(ME)
  t('but a settled account never does, however old the record', h2.calls.referrerOf === 0)
}
{
  const h = harness({ referredBy: null, agent: true, throwOn: 'referrerOf' })
  await h.run(ME)
  t('an unreachable Hyperliquid signs nothing', h.calls.agent === 0)
  t('and is recorded as inconclusive, not as settled', recorded(h.store) === 'no')
}

console.log(nl + '-- the code, and where it is signed from --')
{
  t('the code is the one from the join link', /export const REFERRAL_CODE = 'INSOLVENTSPARTAN'/.test(TRD))
  t('the agent-key path uses it', TRD.includes('exchangeClient.setReferrer({ code: REFERRAL_CODE })'))
  t('and so does the main-wallet path', TRD.includes('client.setReferrer({ code: REFERRAL_CODE })'))
  // setReferrer is an L1 action, which is why an agent key can sign it at all.
  t('why either signer works is written down', TRD.includes('setReferrer` is an L1 action'))
  t('the live state is read from Hyperliquid, not guessed',
    TRD.includes('const r = await infoClient.referral({ user: addr })'))
}

console.log(nl + '-- every connect path goes through the funnel --')
{
  t('no path signs the referral directly any more',
    !CLI.includes('applyReferrer().catch('))
  // Four agent-key paths (paste, settings, generate, restore-on-load) plus the wallet connect.
  t('there are five call sites', (CLI.match(/_ensureReferrer\(/g) ?? []).length >= 6, // 5 calls + the definition
    (CLI.match(/_ensureReferrer\(/g) ?? []).length)
  t('including the main-wallet connect that was missing',
    /approveBuilderFee\(getHlSigner\(\)\)[\s\S]{0,1600}_ensureReferrer\(addr\)/.test(CLI))
  t('and the key restored on load, which covers accounts set up before this',
    /connectAgentKey\(savedKey\)[\s\S]{0,700}_ensureReferrer\(\)/.test(CLI))
}

console.log(nl + '-- and it is disclosed where the app claims to be straight --')
{
  // The app signs two things on connect that nobody clicked a button for. Both put money on the
  // table, so both are named on the Security page rather than left to be discovered.
  t('the Security page says how the app makes money', CLI.includes("h(_T('How Insolvent makes money'"))
  t('it names the code', CLI.includes('esc(REFERRAL_CODE)'))
  t('it says the user gets a discount too', /discounts <b>your<\/b> taker fees/.test(CLI))
  t('it says an existing referrer is never touched',
    CLI.includes('An account that already has a referrer is never touched'))
  t('and the card is actually on the page', CLI.includes('honest + fees + who'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
