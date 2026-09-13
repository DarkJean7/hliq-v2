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

console.log(nl + '-- a self-removed account is not put back by someone else --')
{
  // The single most important line here. `force` comes only from the owner-prompted ➕ Add me;
  // the automatic join must never send it, or a search would silently undo a removal.
  t('the server blocks a removed address unless forced',
    SRV.includes('if (!force && lbIsRemoved(key)) return json(res, 200, { ok: true, blocked: true })'))
  t('force comes from the request, not from a default', SRV.includes('const force = !!b.force'))
  const auto = grab(CLI, 'function _lbJoin(addr, equity = null)')
  t('the automatic join never forces', !auto.includes('force'))
  t('only the prompted Add me does', CLI.includes('body: JSON.stringify({ addr, force: true })'))
  t('and it is still behind a confirmation', CLI.includes("title: 'Join the leaderboard?'"))
}

console.log(nl + '-- which lookups post, and how often --')
{
  // Drive the real client function with a stubbed browser.
  const mk = () => {
    const store = new Map()
    const posts = []
    const api = new Function('store', 'posts', `
      const localStorage = {
        getItem: (k) => store.has(k) ? store.get(k) : null,
        setItem: (k, v) => store.set(k, String(v)),
      }
      const fetch = (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return { catch: () => {} } }
      ${CLI.match(/const _isRealAddr = .*/)[0]}
      ${CLI.match(/const _LB_MIN_EQUITY = .*/)[0]}
      ${CLI.match(/const _LB_TRIED_KEY\s+= .*/)[0]}
      ${grab(CLI, 'function _lbTriedSet()')}
      ${grab(CLI, 'function _lbJoin(addr, equity = null)')}
      return { _lbJoin, store, posts }`)
    return api(store, posts)
  }
  const A = '0x' + 'a'.repeat(40)
  const B = '0x' + 'b'.repeat(40)

  {
    const { _lbJoin, posts } = mk()
    _lbJoin(A, 1234)
    t('a funded address is posted', posts.length === 1 && posts[0].body.addr === A, posts)
    t('to the join endpoint', posts[0]?.url === '/api/leaderboard/join')
  }
  {
    const { _lbJoin, posts } = mk()
    _lbJoin(A, 1234); _lbJoin(A, 1234); _lbJoin(A, 9999)
    // Every account switch and every reload would otherwise re-post the same wallets and burn
    // the hourly allowance on addresses that are already listed.
    t('the same address is asked once per device', posts.length === 1, posts.length)
    _lbJoin(B, 50)
    t('a different address still goes', posts.length === 2)
  }
  {
    const { _lbJoin, posts } = mk()
    // Below the floor the server would reject it anyway, and the attempt costs a slot.
    _lbJoin(A, 4)
    t('a dust account is not even asked', posts.length === 0)
    // Unknown is not small: those are still worth asking about.
    _lbJoin(B, null)
    t('an unknown balance is still asked', posts.length === 1, posts)
  }
  {
    const { _lbJoin, posts } = mk()
    _lbJoin('__all_accounts__', 100)
    _lbJoin('paper', 100)
    _lbJoin('', 100)
    _lbJoin(null, 100)
    _lbJoin('0xnope', 100)
    t('the combined view, paper and junk are never posted', posts.length === 0, posts)
  }
  {
    const { _lbJoin, posts, store } = mk()
    store.set('hliq_lb_optout', '1')
    _lbJoin(A, 1234)
    t('the device opt-out suppresses it entirely', posts.length === 0)
  }
}

console.log(nl + '-- and it runs from the one funnel every lookup goes through --')
{
  // loadDashboard is the search box, a recent address, switching to a saved wallet, and
  // connecting your own. Hooking it here is what makes "any address that is searched" true
  // without a second call site to keep in sync.
  t('loadDashboard joins once the account resolves',
    CLI.includes('_lbJoin(addr, totalPerpEquity(perpState))'))
  // After the first two calls land, so a typo'd or empty address never reaches the board.
  t('and only after its state came back',
    CLI.indexOf('_lbJoin(addr, totalPerpEquity(perpState))') > CLI.indexOf('infoClient.clearinghouseState({ user: addr })'))
  t('why the address may not be the searcher’s own is written down',
    CLI.includes('its owner has never used this app'))
  t('and the server says so too', SRV.includes('not just for a wallet the caller owns'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
