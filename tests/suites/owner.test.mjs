// Exercises the REAL agentApprovedFor from server.js against the live HL API, using the
// wallet/agent pair that was being wrongly rejected.
import fs from 'fs'

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

const body = `
  const HL_INFO = 'https://api.hyperliquid.xyz/info'
  const _agentOkCache = new Map()
  ${grab('async function agentApprovedFor(')}
  return { agentApprovedFor, _agentOkCache }
`
const { agentApprovedFor, _agentOkCache } = new Function(body)()

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const MASTER = '0xaa7Ad5Fa4D99D9BF3397232Df7F4523853538159'
const AGENT  = '0x92938b23a9c5f13f263d339693a047460c2604b8'   // "Dark" — the only approved agent
const STRANGER = '0x1111111111111111111111111111111111111111'

// ── the case that was being rejected ─────────────────────────────────────────
t('the real agent IS approved for the wallet (unblocks the update)',
  await agentApprovedFor(MASTER, AGENT) === true)

// ── mixed case must not matter ───────────────────────────────────────────────
_agentOkCache.clear()
t('checksum-cased master + agent still match',
  await agentApprovedFor(MASTER, '0x92938B23A9C5F13F263D339693A047460C2604B8') === true)

// ── an unrelated key must still be refused ───────────────────────────────────
t('a stranger key is refused', await agentApprovedFor(MASTER, STRANGER) === false)

// ── malformed input is refused without hitting the network ───────────────────
for (const [m, a, label] of [
  ['', AGENT, 'empty master'],
  [MASTER, '', 'empty agent'],
  ['__all_accounts__', AGENT, 'sentinel address'],
  ['0xaa7ad5fa4d99d9bf3397232df7f4523853538159/../0xaa7ad5f', AGENT, 'path-traversal address'],
  ['not-an-address', AGENT, 'garbage master'],
]) t(`refuses ${label}`, await agentApprovedFor(m, a) === false)

// ── caching: a positive is cached long, a negative only briefly ──────────────
_agentOkCache.clear()
await agentApprovedFor(MASTER, AGENT)
const posEntry = _agentOkCache.get(`${MASTER.toLowerCase()}|${AGENT.toLowerCase()}`)
t('positive cached ~5min', posEntry.ok && posEntry.exp - Date.now() > 240_000)
await agentApprovedFor(MASTER, STRANGER)
const negEntry = _agentOkCache.get(`${MASTER.toLowerCase()}|${STRANGER}`)
t('negative cached only ~15s (a blip must not lock the owner out)',
  !negEntry.ok && negEntry.exp - Date.now() < 20_000)

// ── structural: every gated route awaits the now-async gate ──────────────────
t('no un-awaited requireOwner call remains', !/if \(!requireOwner\(/.test(src))
t('all 7 gated routes await it', (src.match(/if \(!await requireOwner\(/g) || []).length === 7)
t('requireOwner is async', src.includes('async function requireOwner('))
t('/api/start consults HL before refusing',
  src.includes("owner !== auth.signer && !(await agentApprovedFor("))
t('an unapproved key is still refused by /api/start',
  src.includes("error: 'account controlled by another key'"))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
