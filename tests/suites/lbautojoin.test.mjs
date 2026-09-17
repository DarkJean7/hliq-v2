// Every address the app looks up goes on the public leaderboard.
//
// Asked for directly: "make that any address that is being searched from my app is
// automatically added to the leaderboard". This is a reversal of the 2026-08-06 change that
// made joining opt-in, and it is broader than what was removed then: the address a lookup adds
// is usually NOT the searcher's own, and its owner has never used this app. Hyperliquid
// balances are public, so nothing secret is published — but two guards have to survive, and
// they are what most of this suite is about:
//
//   SELF-REMOVAL WINS  an account that took itself off stays off; only its owner's prompted
//                      "Add me" (force: true) can undo that. A stranger's search cannot.
//   THE SERVER DECIDES who is actually added — the equity floor, the cap, the rate limit.
//
// The rate limiter and the join handler are extracted from server.js and driven for real.
import fs from 'fs'

const SRV = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

/** Pull a function out of a source file, braces balanced, and run the real thing. */
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

console.log(nl + '-- the per-IP rate limit, as the server actually runs it --')
{
  const api = new Function('nowRef', `
    const _lbJoinHits = new Map()
    const Date = { now: () => nowRef.t }
    ${grab(SRV, 'function lbJoinAllowed(ip)')}
    return { lbJoinAllowed, hits: _lbJoinHits }`)
  const nowRef = { t: 1_000_000_000_000 }
  const { lbJoinAllowed } = api(nowRef)

  const ip = '1.2.3.4'
  let allowed = 0
  for (let i = 0; i < 40; i++) if (lbJoinAllowed(ip)) allowed++
  // 5 was sized for one wallet connect per person. Looking up a handful of traders used to hit
  // the wall inside a minute, and everything after it silently never joined.
  t('an IP gets 30 joins in an hour, not 5', allowed === 30, allowed)
  t('and is refused after that', lbJoinAllowed(ip) === false)

  t('another IP is unaffected', lbJoinAllowed('9.9.9.9') === true)

  // The window slides; it is not a fixed bucket.
  nowRef.t += 3_600_001
  t('an hour later it is allowed again', lbJoinAllowed(ip) === true)

  // Still bounded: filling the 500 cap from one IP is a day's work, and every entry has to
  // hold real money to pass the floor.
  t('the cap and the equity floor are what really guard the board',
    /const LB_MAX\s+= 500/.test(SRV) && /const LB_MIN_EQUITY = 10/.test(SRV))
}

console.log(nl + '-- an owner who left is not put back in view by someone else --')
{
  // This section used to guard a "removed" list: an address once taken off could not rejoin
  // unless forced. That list is gone — it kept one of the owner's own bot wallets off the
  // board with nothing saying why ("i just want to know why that wallet is not automatically
  // joining"). Leaving is a HIDE now, and only the owner's signature shows the row again.
  t('the removed list is gone', !/lbIsRemoved|lbMarkRemoved|lbClearRemoved|LB_REMOVED_FILE/.test(SRV))
  t('and its stale file is cleaned up', SRV.includes("unlinkSync(join(__dirname, 'leaderboard-removed.json'))"))
  const join = SRV.slice(SRV.indexOf("path === '/api/leaderboard/join'"), SRV.indexOf("path === '/api/leaderboard/join'") + 1500)
  t('the join has no force and no block', !/force|blocked/.test(join))
  t('it tells an already-listed caller whether the row is hidden',
    join.includes('return json(res, 200, { ok: true, already: true, hidden: lbReadHidden().includes(key) })'))
  const rm = SRV.slice(SRV.indexOf("path === '/api/leaderboard/remove'"), SRV.indexOf("path === '/api/leaderboard/paper/remove'"))
  t('an owner removing themselves is hidden, not deleted', /if \(!pinOk\) \{\s*lbSetHidden\(key, true\)/.test(rm))
  t('a dev removal deletes the row', rm.includes('lbWriteList(list.filter(e => e.addr.toLowerCase() !== key))'))
  t('nothing sends force any more', !CLI.includes('force: true') && !/force/.test(fs.readFileSync('src/lbjoin.js', 'utf8').replace(/\/\/.*|\*.*$/gm, '')))
  t('Add me is still behind a confirmation', CLI.includes("title: 'Join the leaderboard?'"))
  t('and shows a hidden row only with the owner\u2019s signature',
    CLI.includes('if (r.hidden && !(await _lbSetMyVisibility(addr, false))) return')
      && grab(CLI, 'async function _lbSetMyVisibility(addr, hidden)').includes('getMainSigner().signMessage(msg)'))
}

console.log(nl + '-- who may join: anyone who has traded, at any balance --')
{
  // A unified account keeps its USDC in spot: an owner's wallet held $494.69, all of it spot,
  // read $0.00 in perps, and was refused. The first fix added spot USDC to perps — which
  // double-counts on a unified account, where the perp margin already sits inside the spot
  // USDC: a wallet showing $960.46 measured $1,058.76 ("if you have that number that is a
  // bug"). HL's portfolio value is the unified figure; without it, never the sum.
  // "allow even $0 wallets, since it can be an old forgotten wallet with good history data".
  // A wallet with ANY trading volume joins at any balance; one that never traded needs $10.
  // An address that has never done anything is still refused — otherwise anyone could fill
  // the 500-row cap with made-up addresses.
  const eq = SRV.slice(SRV.indexOf('async function lbAccountFacts(addr)'), SRV.indexOf('// Cheap spam gate for the public join endpoint.'))
  t('the join reads balance and volume together', SRV.includes('const { equity, volume } = await lbAccountFacts(b.addr)'))
  t('volume is HL\u2019s all-time figure, from the same call', eq.includes("const volume = parseFloat(all?.vlm ?? 0) || 0"))
  t('a wallet that has traded joins at $0', SRV.includes('if (!(volume > 0) && !(equity >= LB_MIN_EQUITY)) {'))
  t('and the refusal says why', SRV.includes('has never traded on Hyperliquid and holds under $'))
  t('which is HL’s own portfolio value first',
    eq.indexOf("type: 'portfolio'") >= 0 && eq.indexOf("type: 'portfolio'") < eq.indexOf("type: 'clearinghouseState'"))
  t('and never perp + spot', !/perp\s*\+\s*usdc/.test(eq) && eq.includes('return { equity: Math.max(perp, usdc), volume }'))
  const row = grab(SRV, 'async function lbRefreshOne(addr, label, prev)')
  t('a board row without a snapshot holds its last value before summing',
    row.includes('(Number.isFinite(prevVal) && prevVal > 0 ? prevVal : perpAcctVal + spotUSDCTotal)'))
  const join = SRV.slice(SRV.indexOf("path === '/api/leaderboard/join'"), SRV.indexOf("path === '/api/leaderboard/join'") + 2500)
  t('the perp-only read is gone from the join', !join.includes("marginSummary?.accountValue"))
  // Every paper account on a device posts now, up to 13.
  t('the paper board allows more posts an hour', SRV.includes('const LB_PAPER_PER_HOUR = 120') && SRV.includes('hits.length >= LB_PAPER_PER_HOUR'))
}

console.log(nl + '-- which lookups post, and how often --')
{
  // The rules live in src/lbjoin.js now and are driven directly, against a scripted server.
  // This section used to lift the old synchronous _lbJoin out of main.js. That version wrote
  // an address to its "tried" set BEFORE the request, so a 429 or a refusal was never asked
  // again on that device — part of why an owner "connected the wallet, reloaded, etc." and
  // still could not join.
  const { createJoiner, ownedAddresses, isSettled, JOINED_KEY, COOLDOWN_KEY } = await import('../../src/lbjoin.js')
  const mk = (reply = () => [200, { ok: true, added: true }], clock = { t: 1_000_000 }) => {
    const store = new Map()
    const posts = []
    const storage = {
      getItem: (k) => store.has(k) ? store.get(k) : null,
      setItem: (k, v) => store.set(k, String(v)),
      get length() { return store.size },
      key: (i) => [...store.keys()][i] ?? null,
    }
    const fetch = async (url, opts) => {
      const body = JSON.parse(opts.body)
      posts.push({ url, body })
      const [status, json] = reply(body)
      return { status, ok: status < 300, json: async () => json }
    }
    const j = createJoiner({ storage, fetch, now: () => clock.t })
    return { ...j, store, posts, storage, clock }
  }
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)

  {
    const { join, posts } = mk()
    const r = await join(A, 1234)
    t('a funded address is posted', posts.length === 1 && posts[0].body.addr === A, posts)
    t('to the join endpoint', posts[0]?.url === '/api/leaderboard/join')
    t('and the answer is reported', r.status === 'added', r)
  }
  {
    const { join, posts } = mk()
    await join(A, 1234); await join(A, 1234); await join(A, 9999)
    // Every account switch and every reload would otherwise re-post the same wallets and burn
    // the hourly allowance on addresses that are already listed.
    t('a settled address is asked once per device', posts.length === 1, posts.length)
    await join(B, 50)
    t('a different address still goes', posts.length === 2)
    const both = await Promise.all([join('0x' + 'c'.repeat(40)), join('0x' + 'c'.repeat(40))])
    t('two calls at once send one request', posts.length === 3 && both.some(x => x.status === 'known'), both)
  }
  {
    // The bug: a failure used to be remembered as done.
    let n = 0
    const { join, posts, clock } = mk(() => (++n === 1 ? [429, { error: 'too many joins, try later' }] : [200, { ok: true, added: true }]))
    const r1 = await join(A)
    t('a throttled request is a "not now"', r1.status === 'retry' && /too many/.test(r1.error), r1)
    t('and is not retried inside its cooldown', (await join(A)).status === 'cooling' && posts.length === 1)
    clock.t += 11 * 60_000
    t('but is asked again after it', (await join(A)).status === 'added' && posts.length === 2)
  }
  {
    const { join, posts, clock } = mk(() => [400, { error: 'needs at least $10 on Hyperliquid' }])
    await join(A)
    clock.t += 60 * 60_000
    t('an unfunded answer waits hours, not one load', (await join(A)).status === 'cooling' && posts.length === 1)
    clock.t += 6 * 60 * 60_000
    await join(A)
    t('then asks again — the wallet may have been funded', posts.length === 2)
  }
  {
    const { join, posts } = mk()
    // No balance is too small to ask about now: a $0 wallet with history is eligible, and only
    // the server can see its history.
    await join(A, 0)
    t('a $0 account is asked', posts.length === 1, posts)
    await join(B, null)
    t('so is an unknown balance', posts.length === 2, posts)
  }
  {
    const { join, posts } = mk()
    for (const x of ['__all_accounts__', 'paper', '', null, '0xnope']) await join(x, 100)
    t('the combined view, paper and junk are never posted', posts.length === 0, posts)
  }
  {
    const { join, posts, store } = mk()
    store.set('hliq_lb_optout', '1')
    await join(A, 1234)
    t('the device opt-out suppresses it entirely', posts.length === 0)
  }
  {
    // v1 remembered failures. Its key must not stop a device asking again.
    const { join, posts, store } = mk()
    store.set('hliq_lb_autojoined', JSON.stringify([A]))
    await join(A)
    t('the old "tried" memory is not honoured', posts.length === 1 && JOINED_KEY !== 'hliq_lb_autojoined')
  }
  {
    // The bug behind "why is that wallet not automatically joining": v2 took the removed
    // list's "blocked" as a final answer and never asked again.
    let n = 0
    const { join, posts, store } = mk(() => (++n === 1 ? [200, { ok: true, blocked: true }] : [200, { ok: true, added: true }]))
    store.set('hliq_lb_autojoined_v2', JSON.stringify([A]))
    t('what v2 remembered is not honoured', JOINED_KEY === 'hliq_lb_autojoined_v3')
    t('"blocked" is not a final answer', (await join(A)).status === 'retry')
    t('so the wallet is asked again, and joins', (await join(A)).status === 'added' && posts.length === 2)
  }
  {
    // Add me asks even when the device already knows, to learn whether the row is hidden.
    const { join, posts } = mk(() => [200, { ok: true, already: true, hidden: true }])
    await join(A)
    t('an automatic join does not ask twice', (await join(A)).status === 'known' && posts.length === 1)
    const r = await join(A, null, { fresh: true })
    t('Add me asks anyway, and hears it is hidden', posts.length === 2 && r.status === 'already' && r.hidden === true, r)
    t('without telling the server anything new', Object.keys(posts[1].body).join() === 'addr')
  }
  t('settled means the server decided', isSettled(200, { added: true }) && isSettled(200, { already: true })
    && !isSettled(200, { ok: true, blocked: true }) && isSettled(400, { error: 'invalid address' })
    && !isSettled(400, { error: 'needs at least $10 on Hyperliquid' }) && !isSettled(503, { error: 'x' }) && !isSettled(429, {}))
  {
    const { storage, store } = mk()
    store.set('hliq_agent_key_' + A, '0xkey')
    store.set('hliq_agent_key_' + B.toUpperCase().replace('0X', '0x'), '0xkey')
    store.set('hliq_agent_key', '0xlegacy')
    store.set('hliq_agent_key___all_accounts__', '0xjunk')
    store.set('hliq_agent_key_' + '0x' + 'd'.repeat(40), '')
    const own = ownedAddresses(storage, ['0x' + 'e'.repeat(40), 'nope', A.toUpperCase().replace('0X', '0x')])
    t('every wallet with a saved agent key is yours', own.includes(A) && own.includes(B))
    t('and every connected wallet', own.includes('0x' + 'e'.repeat(40)))
    t('the legacy unaddressed key, the junk key and an empty key are not',
      own.length === 3, own)
  }
  {
    const { joinAll, posts } = mk()
    const slept = []
    const r = await joinAll([A, B, A], { sleep: async (ms) => slept.push(ms) })
    t('joinAll asks each once', posts.length === 2 && r[A.toLowerCase()].status === 'known')
    t('and spaces the requests it actually sends', slept.length === 2)
  }
}

console.log(nl + '-- and it runs from the one funnel every lookup goes through --')
{
  // loadDashboard is the search box, a recent address, switching to a saved wallet, and
  // connecting your own. Hooking it here is what makes "any address that is searched" true
  // without a second call site to keep in sync.
  // No equity is passed any more: the perp figure alone turned away accounts holding their
  // USDC in spot, and the server checks the whole account.
  t('loadDashboard joins once the account resolves',
    CLI.includes('_lbJoin(addr, null)'))
  // After the first two calls land, so a typo'd or empty address never reaches the board.
  t('and only after its state came back',
    CLI.indexOf('_lbJoin(addr, null)') > CLI.indexOf('infoClient.clearinghouseState({ user: addr })'))
  t('why the address may not be the searcher’s own is written down',
    CLI.includes('its owner has never used this app'))
  t('and the server says so too', SRV.includes('not just for a wallet the caller owns'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
