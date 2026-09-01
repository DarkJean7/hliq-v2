// The All Accounts cache. Telemetry from a real nine-wallet phone said this was skipped
// every time -- "allacct cache too-big: 4.25MB over 4MB (9 wallets)" -- so the blocking
// "Combining all accounts" loader and a cold nine-wallet fan-out ran on every entry.
import fs from 'fs'
import { gzipToString, gunzipFromString, gzipSupported } from '../../src/gzstore.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- it fits now --')
const rows = Array.from({ length: 9 }, (_, w) => ({
  addr: '0x' + String(w).repeat(40), label: 'W' + w,
  fills: Array.from({ length: 2200 }, (_, i) => ({
    time: 1756000000000 + i, coin: 'HYPE', side: i % 2 ? 'B' : 'A', sz: '1.2345', px: '81.0234',
    closedPnl: '0.0000', fee: '0.02814', dir: 'Close Long', oid: 100000 + i, tid: 900000 + i,
    hash: '0x' + '0'.repeat(64) })) }))
const json = JSON.stringify({ ts: Date.now(), results: rows })
t('the payload really is over the old cap', json.length > 4_000_000, (json.length / 1e6).toFixed(2) + 'MB')

const z = await gzipToString(json)
t('compression is available', gzipSupported())
t('and it fits with room to spare', z.length < 1_000_000, (z.length / 1e6).toFixed(3) + 'MB')
t('by roughly a factor of ten or better', json.length / z.length > 10, (json.length / z.length).toFixed(1) + 'x')

console.log(String.fromCharCode(10) + '-- nothing is lost on the way --')
const back = await gunzipFromString(z)
t('it round-trips byte for byte', back === json)
const parsed = JSON.parse(back)
t('every wallet survives', parsed.results.length === 9)
t('and every fill', parsed.results[0].fills.length === 2200)
t('base64 is chunked, so a big buffer does not blow the stack', z.length > 100_000 && typeof z === 'string')

console.log(String.fromCharCode(10) + '-- a bad value is a miss, never an empty account list --')
// The distinction this app has got wrong three times: absent is not empty. A cache we
// cannot read must look like "no cache", not like "you have no wallets".
t('garbage decompresses to null', (await gunzipFromString('not-base64-at-all')) === null)
t('and so does an empty value', (await gunzipFromString('')) === null)
t('the reader drops a damaged entry rather than trusting it',
  cli.includes("if (!json) { try { localStorage.removeItem(_ALLACCT_CACHE_KEY_Z) } catch {} ; return null }"))

console.log(String.fromCharCode(10) + '-- wired into the cache --')
t('a second key, so an old plain cache still reads', cli.includes("const _ALLACCT_CACHE_KEY_Z = 'hliq_allacct_v2z'"))
t('the reader falls back to it', cli.includes('return parse(localStorage.getItem(_ALLACCT_CACHE_KEY))'))
t('the writer compresses first', cli.includes('const z = await gzipToString(json)'))
t('and reclaims the space the old copy held', cli.includes('try { localStorage.removeItem(_ALLACCT_CACHE_KEY) } catch {}'))
t('a browser without CompressionStream still uses the old path',
  cli.includes("_allAcctCacheWhy(z ? 'too-big-compressed' : 'too-big',"))
t('both are awaited', cli.includes('const cached = await _allAcctCacheLoad()') &&
  cli.includes('async function _allAcctCachePersist()'))
t('and the skip is still reported, so a regression is visible', cli.includes('function _allAcctCacheWhy(reason, detail)'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
