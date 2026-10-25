// Strict spot search, as Hyperliquid's own is by default. Asked: "make our app trade search be
// strict" — QUANT/USDC showed in ours and only under All in theirs.
import fs from 'fs'
import { STRICT_SPOT_TOKEN_IDS, isStrictSpotToken, spotStrictOn, setSpotStrict, passesStrict } from '../../src/strictspot.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const M = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const H = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')

// Token ids from spotMeta, checked live when the list was copied.
const HYPE = '0x0d01dc56dcaaca66ad901c959b4011ec', QUANT = '0x68c563790c975869358031d0e42e49a1'
t('the list is Hyperliquid\'s 54 mainnet tokens', STRICT_SPOT_TOKEN_IDS.size === 54, STRICT_SPOT_TOKEN_IDS.size)
t('HYPE is on it', isStrictSpotToken(HYPE))
t('QUANT is not', !isStrictSpotToken(QUANT))
t('every entry is a token id', [...STRICT_SPOT_TOKEN_IDS].every(i => /^0x[0-9a-f]{32}$/.test(i)))

const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }
const st = mem()
t('Strict is the default, as on Hyperliquid', spotStrictOn(st) === true)
setSpotStrict(false, st)
t('and All is remembered', spotStrictOn(st) === false)
t('a broken store reads as Strict', spotStrictOn({ getItem() { throw new Error('blocked') } }) === true)

const keys = new Set(['@107'])
t('a strict spot market passes', passesStrict('@107', { on: true, strictKeys: keys }))
t('another spot market does not', !passesStrict('@251', { on: true, strictKeys: keys }))
t('unless it is a favourite', passesStrict('@251', { on: true, strictKeys: keys, favs: ['@251'] }))
t('perps and HIP-3 are not judged', passesStrict('BTC', { on: true, strictKeys: keys }) && passesStrict('xyz:GOLD', { on: true, strictKeys: keys }))
t('All lets every spot market through', passesStrict('@251', { on: false, strictKeys: keys }))
// Empty is not the same as unknown: before spotMeta loads there is no strict set, and hiding every
// spot market then would read as "there are none".
t('before spotMeta loads nothing is hidden', passesStrict('@251', { on: true, strictKeys: new Set() }))

// Five market lists share data but not code; each one asks.
t('the strict set is built from spotMeta\'s token ids', M.includes('if (isStrictSpotToken(base?.tokenId)) _spotStrictKeys.add(atKey)'))
t('the desktop top-bar search filters by it', M.includes('!_isDelistedMkt(c) && !_isDeadMkt(c) && _strictOk(c))'))
t('the market search card filters by it', M.includes('!_isDelistedMkt(k) && !_isDeadMkt(k) && _strictOk(k))'))
t('the desktop dropdown and both phone lists filter by it', (M.match(/\.filter\(\(\[k\]\) => _strictOk\(k, favs\)\)/g) || []).length === 3)
t('the Spot tab under Strict is the list itself', (M.match(/entries = entries\.filter\(\(\[k\]\) => _spotTabOk\(k\)\)/g) || []).length === 2)
t('favourites come from the app\'s own store', M.includes('favs: favs ?? loadFavCoins() })'))
t('a switch on the phone list', M.includes('id="mobMktStrictBtn"') && M.includes('window.__spotStrictToggle = function(on)'))
t('and beside the desktop search', H.includes('class="mkt-strict-seg"') && H.includes('window.__spotStrictToggle(false)'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
