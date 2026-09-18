// The name on a leaderboard row comes from the wallet's OWNER.
//
// Asked for: "store server side connected users wallet names so we then can have the named
// wallet in the leaderboard instead of just the address. currently i just see the wallet
// address and as dev i can name them, but what is the point of naming wallets of random
// users." — so the name people already typed for their own wallet is what the board shows.
//
// The line that matters: only for wallets this app can PROVE are theirs. The label you gave
// a stranger's address is a private note about them ("whale to watch", "scammer"), and
// publishing it under their row would put your words in their mouth.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8')
const srv = fs.readFileSync('server.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig)
  if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- the server takes either proof of ownership --')
{
  const route = srv.slice(srv.indexOf("path === '/api/leaderboard/name'"), srv.indexOf("// ── GET /api/heatmap/"))
  t('an agent-key session counts', route.includes('const byAgent = !!auth && (auth.admin || await agentApprovedFor(b.addr, auth.signer))'))
  // agentApprovedFor asks Hyperliquid whether that key is CURRENTLY approved for the account,
  // so it is a real proof, not a claim the client makes about itself.
  t('and it is Hyperliquid that vouches for the key',
    grab(srv, 'async function agentApprovedFor(address, agentAddr)').includes("type: 'extraAgents'"))
  t('without one, a signature is still required', route.includes('if (!byAgent) {') && route.includes('ethers.verifyMessage(msg, b.signature'))
  t('and it must match the address it names', route.includes("error: 'signature does not match that address'"))
  t('the name is cleaned and cannot look like an address', route.includes("error: 'name cannot look like an address'"))
  t('a row that is not on the board cannot be named', route.includes("error: 'address is not on the leaderboard'"))
  t('who named it is recorded', route.includes("list[i].namedBy = byAgent ? 'agent' : 'owner'"))
  t('and the rename is logged', route.includes('[lb] name'))
}

console.log(nl + '-- the app publishes your own wallets’ names, and only those --')
{
  // Sliced, not brace-matched: the signature's own destructuring ends a brace scan at once.
  const _pi = cli.indexOf('async function _lbPublishName(addr, { resend = false } = {})')
  const pub = cli.slice(_pi, cli.indexOf(nl + 'window.__lbPublishName', _pi))
  t('it exists', pub.length > 200)
  t('a wallet must be provably yours', pub.includes("if (!ownedAddresses(localStorage, connected).includes(key)) return 'not-yours'"))
  t('why a stranger’s label stays private is written down', cli.includes('private note about a stranger'))
  t('the name is the one you gave it locally', pub.includes("_lbCleanName(WM.getLabel(addr) ?? '')"))
  t('an unnamed wallet posts nothing', pub.includes("if (!name) return 'unnamed'"))
  t('the device opt-out silences it', pub.includes("if (localStorage.getItem('hliq_lb_optout') === '1') return 'optout'"))
  t('the same name is not posted twice', pub.includes("if (!resend && map[key] === name) return 'known'"))
  t('it authenticates as that account', pub.includes('authAddr: key'))
  t('and sends no signature — the agent key is the proof', !pub.includes('signMessage'))
}

console.log(nl + '-- when it runs --')
{
  const jo = grab(cli, 'async function _lbJoinOwned()')
  t('after the joins, since a row must exist first', jo.indexOf('joinAll(owned)') < jo.indexOf('_lbPublishName(a)'))
  t('renaming from the wallet sheet publishes at once',
    /WM\.upsert\(addr, label\)[\s\S]{0,140}_lbPublishName\(addr\)/.test(cli))
  t('and from the Accounts tab too',
    /WM\.upsert\(addr, name\.trim\(\)\)[\s\S]{0,80}_lbPublishName\(addr\)/.test(cli))
  t('the rename sheet says so, but only for an account that is yours',
    cli.includes('it is also the name shown on the public leaderboard') && cli.includes('_lbOwnsAddr(addr) ?'))
}

console.log(nl + '-- the lookup that made every wallet look unnamed --')
{
  // Saved wallets keep checksummed addresses; everything that normalises hands back lowercase.
  // WM.getLabel compared them exactly, so the publisher read "unnamed" for every owned wallet
  // — found by driving it in a browser, not by reading it.
  t('getLabel matches case-insensitively',
    cli.includes("getLabel(addr)      { const k = String(addr ?? '').toLowerCase(); return this.load().find(w => String(w.addr).toLowerCase() === k)?.label ?? null }"))
  const wm = grab(cli, 'const WM = {')
  t('upsert does too — the other casing used to add a SECOND entry for the same wallet',
    wm.includes('const ex   = list.find(w => String(w.addr).toLowerCase() === k)'))
  t('and so does remove', wm.includes('remove(addr) { const k = String(addr ?? ') && wm.includes('String(w.addr).toLowerCase() !== k'))
  const mixed = [...wm.matchAll(/w\.addr === addr|w\.addr !== addr/g)]
  t('no WM lookup is left comparing raw', mixed.length === 0, mixed.length)
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
