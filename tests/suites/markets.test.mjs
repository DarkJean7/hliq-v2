// /markets: every Hyperliquid asset as rankable rows (src/marketsdata.js), and the page's
// routes. Fixtures are shaped like the real replies, including the traps found building it:
// tokens looked up by index, a $0-volume impersonator, a supply-glitch market cap, wrapped
// UBTC, and dead HIP-3 copies.
import fs from 'fs'
import * as M from '../../src/marketsdata.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = '\n'

const CORE = [
  { universe: [
    { name: 'BTC', maxLeverage: 40 }, { name: 'HYPE', maxLeverage: 10 },
    { name: 'OLD', maxLeverage: 3, isDelisted: true }, { name: 'ZERO', maxLeverage: 3 },
  ] },
  [
    { markPx: '86000', prevDayPx: '80000', dayNtlVlm: '1300000000', openInterest: '38000', funding: '0.0000125' },
    { markPx: '90', prevDayPx: '100', dayNtlVlm: '200000000', openInterest: '20000000', funding: '-0.00001' },
    { markPx: '1', prevDayPx: '1', dayNtlVlm: '5', openInterest: '1', funding: '0' },
    { markPx: '0', prevDayPx: '0', dayNtlVlm: '0', openInterest: '0', funding: '0' },
  ],
]
// Token ids deliberately NOT equal to array positions.
const SPOT = [
  { tokens: [
    { name: 'USDC', index: 0 },
    { name: 'HYPE', index: 150, fullName: 'Hyperliquid', deployerTradingFeeShare: '0.0' },
    { name: 'UBTC', index: 197, fullName: 'Unit Bitcoin', deployerTradingFeeShare: '1.0' },
    { name: 'MSFT', index: 300, deployerTradingFeeShare: '1.0' },           // impersonator, $0 vol
    { name: 'RUBT', index: 301, deployerTradingFeeShare: '0.0' },           // supply glitch
    { name: 'USDT0', index: 268 }, { name: 'WEIRD', index: 400 }, { name: 'JUNK', index: 401 },
  ], universe: [
    { name: '@107', tokens: [150, 0] }, { name: '@142', tokens: [197, 0] }, { name: '@200', tokens: [300, 0] },
    { name: '@201', tokens: [301, 0] }, { name: '@202', tokens: [150, 268] },
    { name: '@203', tokens: [401, 400] },                                    // not quoted in a stable
  ] },
  [
    { coin: '@107', markPx: '90', prevDayPx: '100', dayNtlVlm: '5000000', circulatingSupply: '300000000' },
    { coin: '@142', markPx: '86000', prevDayPx: '85000', dayNtlVlm: '24000000', circulatingSupply: '21000000' },
    { coin: '@200', markPx: '500', prevDayPx: '500', dayNtlVlm: '0', circulatingSupply: '7400000000' },
    { coin: '@201', markPx: '78', prevDayPx: '78', dayNtlVlm: '10', circulatingSupply: '1.8e13' },
    { coin: '@202', markPx: '90', prevDayPx: '100', dayNtlVlm: '1000', circulatingSupply: '300000000' },
    { coin: '@203', markPx: '1', prevDayPx: '1', dayNtlVlm: '99', circulatingSupply: '5' },
  ],
]
const XYZ = [
  { universe: [{ name: 'xyz:NVDA', maxLeverage: 20 }, { name: 'xyz:SP500', maxLeverage: 50 }] },
  [{ markPx: '180', prevDayPx: '170', dayNtlVlm: '9000000', openInterest: '50000', funding: '0' },
   { markPx: '7700', prevDayPx: '7700', dayNtlVlm: '0', openInterest: '0', funding: '0' }],
]
const DEAD = [   // another dex: NVDA again (dead) and SP500 dead too
  { universe: [{ name: 'km:NVDA', maxLeverage: 10 }, { name: 'km:SP500', maxLeverage: 10 }] },
  [{ markPx: '150', prevDayPx: '150', dayNtlVlm: '0', openInterest: '0' },
   { markPx: '7000', prevDayPx: '7000', dayNtlVlm: '0', openInterest: '0' }],
]

console.log(nl + '-- perps --')
const perps = M.perpRows(...CORE)
const btc = perps.find(r => r.sym === 'BTC')
t('delisted and unpriced markets are left out', perps.length === 2, perps.map(r => r.sym))
t('24h change is mark against prevDay', Math.abs(btc.chg24 - 7.5) < 1e-9, btc.chg24)
t('open interest is coins × price, in USD', btc.oi === 38000 * 86000, btc.oi)
t('funding is the hourly rate as a percentage', Math.abs(btc.funding1h - 0.00125) < 1e-12, btc.funding1h)
t('a perp has no market cap of its own (null, not 0)', btc.mcap === null)

console.log(nl + '-- spot --')
const spots = M.spotRows(...SPOT)
const hype = spots.find(r => r.sym === 'HYPE')
t('tokens are found by their index field, not array position', !!hype && hype.name === 'Hyperliquid', spots.map(r => r.sym))
t('market cap is circulating supply × price', hype.mcap === 300000000 * 90, hype.mcap)
t('one row per token: its deepest pair stands for it', hype.coin === '@107' && hype.pairs === 2, hype)
t('a pair not quoted in a dollar stablecoin is left out', !spots.some(r => r.sym === 'JUNK'))
t('a protocol token with $0 volume is left out (impersonators)', !spots.some(r => r.sym === 'MSFT'))
t('a supply-glitch cap above the ceiling is unknown, not $1.4 quadrillion', spots.find(r => r.sym === 'RUBT').mcap === null)
t('spot has no open interest or funding', hype.oi === null && hype.funding1h === null)

console.log(nl + '-- everything together --')
const rows = M.buildMarkets({ core: CORE, spot: SPOT, hip3: [{ dex: 'xyz', label: 'XYZ', data: XYZ }, { dex: 'km', label: 'Kinetiq', data: DEAD }] })
const sBtc = rows.find(r => r.kind === 'spot' && r.wrapped === 'UBTC')
t('UBTC shows as BTC, keeping what it wraps', sBtc?.sym === 'BTC', sBtc)
t('a perp takes the market cap of a trading protocol spot token', rows.find(r => r.kind === 'perp' && r.sym === 'BTC').mcap === 21000000 * 86000)
t('and of an allow-listed HL-native token', rows.find(r => r.kind === 'perp' && r.sym === 'HYPE').mcap === 300000000 * 90)
const hips = rows.filter(r => r.kind === 'hip3')
t('HIP-3: a live market stays and its dead copy elsewhere goes', hips.filter(r => r.sym === 'NVDA').length === 1 && hips.find(r => r.sym === 'NVDA').dex === 'xyz', hips.map(r => r.dex + ':' + r.sym))
t('a symbol whose copies are all dead still appears once', hips.filter(r => r.sym === 'SP500').length === 1, hips.map(r => r.dex + ':' + r.sym))
t('HIP-3 rows carry their dex', hips.every(r => r.dexLabel))

console.log(nl + '-- ranking --')
const byCap = M.sortRows(rows, 'mcap')
t('unknown market caps sort LAST, descending', byCap.at(-1).mcap === null && byCap[0].mcap != null)
t('and last ascending too: unknown is not smallest', M.sortRows(rows, 'mcap', true).at(-1).mcap === null && M.sortRows(rows, 'mcap', true)[0].mcap != null)
t('an unknown sort key falls back to volume', M.sortRows(rows, 'nope')[0].sym === 'BTC')
t('filter by kind, dex and search', M.filterRows(rows, { kind: 'hip3', dex: 'xyz' }).length === 2 && M.filterRows(rows, { q: 'hyperl' }).every(r => r.sym === 'HYPE'))
const sum = M.summarize(rows)
t('summary sums only what is known, and says how many', sum.oiN === rows.filter(r => r.oi != null).length)
t('top gainer ignores markets that barely traded', sum.gainer && sum.gainer.vol24 >= M.MOVER_MIN_VOL, sum.gainer)

console.log(nl + '-- the page --')
const HTML = fs.readFileSync('markets.html', 'utf8')
const JS   = fs.readFileSync('src/markets.js', 'utf8')
const PROD = fs.readFileSync('serve-prod.js', 'utf8')
const VITE = fs.readFileSync('vite.config.js', 'utf8')
t('served at /markets in prod', PROD.includes("if (url === '/markets') return serveFile(res, join(DIST, 'markets.html'))"))
t('and in dev and preview', VITE.includes("req.url = '/markets.html'") && /markets: join\(__dirname, 'markets\.html'\)/.test(VITE))
t('the landing links to it', fs.readFileSync('landing.html', 'utf8').includes('<a href="/markets">Markets</a>'))
t('its own nav goes back through ?home (the landing redirects returning users)', HTML.includes('href="/?home#features"'))
t('the page does not pull in the app', !/^import\b.*(main\.js|style\.css)/m.test(JS))
t('icons are read-only from the app cache, at the app version', JS.includes('&ro=1') && /const ICON_V = '(\d+)'/.exec(JS)?.[1] === /const _ICON_V = '(\d+)'/.exec(fs.readFileSync('src/main.js', 'utf8'))?.[1])
t('the server honours ro=1 without writing', /if \(\/\(\?:\^\|&\)ro=1\(\?:&\|\$\)\/\.test\(query\)\)/.test(PROD))
t('HIP-3 dexes are fetched one at a time, not in a burst', /for \(const d of list\) \{\s*await sleep\(/.test(JS))
t('CI ships it', fs.readFileSync('.github/workflows/deploy.yml', 'utf8').includes('rsync -avz markets.html'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
