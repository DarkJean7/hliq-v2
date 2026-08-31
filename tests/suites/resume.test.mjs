// Runs the REAL resumeBots from server.js against stubs, and checks the 429-retry
// decision the exit handler now makes.
import fs from 'fs'

const src = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

// ── pull the constants + resumeBots out, with a tiny stagger so the test is quick ──
const cStart = src.indexOf('const RESUME_STAGGER_MS')
const fStart = src.indexOf('async function resumeBots()')
let i = src.indexOf('{', fStart), depth = 0, fEnd = -1
for (; i < src.length; i++) {
  if (src[i] === '{') depth++
  else if (src[i] === '}') { depth--; if (depth === 0) { fEnd = i + 1; break } }
}
const block = src.slice(cStart, fEnd).replace('const RESUME_STAGGER_MS   = 1500', 'const RESUME_STAGGER_MS   = 20')

const mk = (registry, opts = {}) => {
  const started = []
  const body = `
    let shuttingDown = ${opts.shuttingDown ? 'true' : 'false'}
    const console = { log(){}, error(){} }
    const loadRegistry = () => (${JSON.stringify(registry)})
    const decryptKey   = (k) => { if (k === 'BAD') throw new Error('bad key'); return 'key:' + k }
    const claimOwner   = (a, k) => claimed.push([a, k])
    const startStrategy = (...a) => { started.push({ at: Date.now(), args: a }); if (a[0] === 'boom') throw new Error('spawn failed') }
    ${block}
    return { resumeBots, RESUME_STAGGER_MS, STARTUP_WINDOW_MS, RESUME_RETRY_BASE_MS, MAX_RESUME_RETRIES, RATE_LIMIT_RE }
  `
  const claimed = []
  const api = new Function('started', 'claimed', body)(started, claimed)
  return { ...api, started, claimed }
}

// ── stagger actually spaces the launches ────────────────────────────────────
{
  const reg = { a: { type: 'grid', address: '0xA', instance: 'HYPE', key: 'k1', extraArgs: ['--coin', 'HYPE'] },
                b: { type: 'dca',  address: '0xB', instance: '',     key: 'k2', extraArgs: [] },
                c: { type: 'grid', address: '0xC', instance: 'BTC',  key: 'k3', extraArgs: [] } }
  const h = mk(reg)
  const t0 = Date.now()
  await h.resumeBots()
  t('all three resumed', h.started.length === 3)
  t('launches are spaced, not simultaneous', Date.now() - t0 >= 2 * 20, `${Date.now() - t0}ms`)
  const gaps = h.started.slice(1).map((s, k) => s.at - h.started[k].at)
  t('every gap is at least the stagger', gaps.every(g => g >= 15), JSON.stringify(gaps))
  t('resume passes resume=true', h.started.every(s => s.args[5] === true))
  t('extraArgs preserved', JSON.stringify(h.started[0].args[1]) === '["--coin","HYPE"]')
}

// ── ownership is claimed for ALL bots before the staggered spawns ───────────
{
  const reg = {}
  for (let n = 0; n < 5; n++) reg['b' + n] = { type: 'dca', address: '0x' + n, instance: '', key: 'k' + n, extraArgs: [] }
  const h = mk(reg)
  const p = h.resumeBots()
  // Synchronously after the call, before any stagger has elapsed:
  t('all owners claimed up front (no owner-gate gap during boot)', h.claimed.length === 5, `${h.claimed.length}`)
  await p
}

// ── a bad key is skipped without aborting the rest ──────────────────────────
{
  const reg = { a: { type: 'dca', address: '0xA', instance: '', key: 'BAD', extraArgs: [] },
                b: { type: 'dca', address: '0xB', instance: '', key: 'k2',  extraArgs: [] } }
  const h = mk(reg)
  await h.resumeBots()
  t('undecryptable entry skipped, others still resume', h.started.length === 1 && h.started[0].args[3] === '0xB')
}

// ── a spawn throw does not abort the remaining bots ─────────────────────────
{
  const reg = { a: { type: 'boom', address: '0xA', instance: '', key: 'k1', extraArgs: [] },
                b: { type: 'dca',  address: '0xB', instance: '', key: 'k2', extraArgs: [] } }
  const h = mk(reg)
  await h.resumeBots()
  t('one failed spawn does not stop the loop', h.started.length === 2)
}

// ── shutting down mid-resume stops launching more ───────────────────────────
{
  const reg = {}
  for (let n = 0; n < 4; n++) reg['b' + n] = { type: 'dca', address: '0x' + n, instance: '', key: 'k' + n, extraArgs: [] }
  const h = mk(reg, { shuttingDown: true })
  await h.resumeBots()
  t('aborts immediately when shutting down', h.started.length === 0)
}

// ── empty registry is a no-op ───────────────────────────────────────────────
{
  const h = mk({})
  await h.resumeBots()
  t('empty registry resumes nothing', h.started.length === 0)
}

// ── the 429 classifier ──────────────────────────────────────────────────────
{
  const { RATE_LIMIT_RE } = mk({})
  for (const s of ['Fatal: 429 Too Many Requests - null', 'HTTP 429', 'Too Many Requests', 'rate limit exceeded'])
    t(`classified as rate-limited: "${s.slice(0, 32)}"`, RATE_LIMIT_RE.test(s))
  for (const s of ['Size per level $0.00 is below HL\'s $10 minimum', 'TimeoutError: aborted due to timeout', 'exited with code 1', 'order 4290 rejected'])
    t(`NOT rate-limited: "${s.slice(0, 32)}"`, !RATE_LIMIT_RE.test(s))
}

// ── retry policy shape ──────────────────────────────────────────────────────
{
  const c = mk({})
  t('real stagger is 1500ms', src.includes('const RESUME_STAGGER_MS   = 1500'))
  t('startup window is 2min', c.STARTUP_WINDOW_MS === 120_000)
  t('backoff widens 30/60/90s', c.RESUME_RETRY_BASE_MS === 30_000 && c.MAX_RESUME_RETRIES === 3)
}

// ── structural: the exit handler only retries transient startup deaths ──────
{
  const ex = src.slice(src.indexOf("proc.on('exit'"), src.indexOf("proc.on('exit'") + 2200)
  t('retry requires a rate-limit error', ex.includes('rateLimited &&'))
  t('retry requires dying inside the startup window', ex.includes('ranMs < STARTUP_WINDOW_MS'))
  t('retry is bounded', ex.includes('< MAX_RESUME_RETRIES'))
  t('non-429 exits still unpersist', ex.includes('unpersistBot(type, address, instance)'))
  t('retry does NOT unpersist (registry entry survives)',
    ex.indexOf('resumeRetries.set') < ex.indexOf('unpersistBot(type, address, instance)'))
  t('retry skipped while shutting down', ex.includes('!shuttingDown && rateLimited'))
  t('retry will not double-spawn', ex.includes('if (shuttingDown || procs[key]) return'))
  t('counter cleared once it stops rate-limiting', ex.includes('resumeRetries.delete(key)'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
