// The HIP-3 discovery fan, replaced by what the WebSocket already streams.
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

console.log('\n── the freshness rule ──')
const known = new Function('addr', 'map', 'now', `
  const _HIP3_WS_TTL = 90_000
  const _hip3WsDexes = map
  const Date = { now: () => now }
  ${grab(cli, 'function _hip3KnownDexes(addr)').replace('function _hip3KnownDexes(addr) {', '').slice(0, -1)}
`)
const NOW = 1_000_000
const mk = (ts, dexes) => new Map([['0xa', { dexes, positions: [], ts }]])
t('a fresh reading is used', !!known('0xa', mk(NOW - 1000, ['xyz']), NOW))
t('a stale one is not — a position opened since would be invisible',
  known('0xa', mk(NOW - 120_000, ['xyz']), NOW) === null)
t('exactly at the TTL is stale', known('0xa', mk(NOW - 90_000, ['xyz']), NOW) === null)
t('an unknown wallet is unknown', known('0xb', mk(NOW, ['xyz']), NOW) === null)
t('case does not lose the entry', !!known('0xA', mk(NOW, ['xyz']), NOW))
// "No dexes" is a real answer, not a missing one — it must not fall back to the fan.
t('a wallet the feed says trades nowhere is still a KNOWN answer',
  !!known('0xa', mk(NOW, []), NOW))

console.log('\n── what the fetch does with it ──')
const f = grab(cli, 'async function _lbFetchHip3(addr)')
t('it asks the feed first', f.includes('const known = _hip3KnownDexes(addr)'))
t('a wallet with nothing costs ZERO calls', f.includes("if (!known.dexes.length) return out"))
t('orders are still fetched — the socket does not carry them', f.includes('frontendOpenOrders'))
t('but only for dexes that actually have something', f.includes('hlPool(known.dexes'))
t('positions come from the feed, not a refetch', f.includes('positions: known.positions ?? []'))
t('and the coin keeps its dex prefix, like the fan produced', f.includes("o.coin.includes(':') ? o.coin : `${dex}:${o.coin}`"))
t('with the same display rename', f.includes('hip3Rename(c)'))

console.log('\n── the fan is kept, not deleted ──')
t('the original ten-dex fan still exists', cli.includes('async function _lbFetchHip3Fan(addr)'))
t('and is used whenever the feed cannot answer', f.includes('return _lbFetchHip3Fan(addr)'))
t('it still discovers cheaply then fetches orders narrowly',
  grab(cli, 'async function _lbFetchHip3Fan(addr)').includes('const states = await hlPool(dexes,'))
t('the leaderboard, which has no socket at all, is unaffected',
  grab(cli, 'async function _lbFetchHip3Fan(addr)').includes('info.clearinghouseState({ user: addr, dex })'))

console.log('\n── recording it ──')
const ws = cli.slice(cli.indexOf('const hip3Dexes = []'), cli.indexOf('_hip3WsDexes.set(key,') + 200)
t('a dex counts only when a position is actually open', ws.includes("if (parseFloat(ap.position?.szi ?? 0) === 0) continue"))
t('the event covers every dex, so the list is complete', ws.includes('for (const [dex, st] of states)'))
t('the main dex is not recorded as a builder dex', ws.includes('if (!dex) { mainSt = st; continue }'))
t('the reading is timestamped, so freshness can be judged', ws.includes('ts: Date.now()'))
t('leaving the combined view drops the readings immediately',
  grab(cli, 'async function _stopAllAcctWs()').includes('_hip3WsDexes.clear()'))
t('and the TTL is the backstop if the socket dies quietly', cli.includes('const _HIP3_WS_TTL = 90_000'))

console.log('\n── the reason, on the record ──')
t('why the fan existed and why it no longer needs to', cli.includes('the WebSocket streams all ten states continuously'))
t('the measured cost is written down', cli.includes('~90 per refresh for nine wallets'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
