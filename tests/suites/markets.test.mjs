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
t('HIP-3 dexes are fetched one at a time, not in a burst', /for \(const d of (last\.)?list\) \{\s*await sleep\(/.test(JS))

console.log(nl + '-- revenue (DefiLlama, src/llama.js) --')
{
  const { buildRevenue } = await import('../../src/llama.js')
  const fees = { protocols: [
    { defillamaId: '1', name: 'pump.fun',  category: 'Launchpad', total24h: 2_000_000, total7d: 12e6, total30d: 40e6, parentProtocol: 'parent#pump', chains: ['Solana'] },
    { defillamaId: '2', name: 'PumpSwap',  category: 'Dexs',      total24h: 700_000,   total7d: 4e6,  total30d: 14e6, parentProtocol: 'parent#pump', chains: ['Solana'] },
    { defillamaId: '3', name: 'Paxos Stablecoin Issuer', category: 'Stablecoin Issuer', total24h: 9e5, total7d: 6e6, total30d: 2e7, parentProtocol: 'parent#paxos' },
    { defillamaId: '4', name: 'Tether', category: 'Stablecoin Issuer', total24h: 1.7e7, total7d: 1e8, total30d: 5e8 },
    { defillamaId: '5', name: 'Velo A', category: 'Dexs', total24h: 10, total7d: 70, total30d: 300 },
    { defillamaId: '6', name: 'Velo B', category: 'Dexs', total24h: 20, total7d: 90, total30d: 400 },
    { defillamaId: '7', name: 'Collector Crypt', category: 'Physical TCG', total24h: 5e5, total7d: 4e6, total30d: 1.3e7 },
  ] }
  const lite = {
    protocols: [
      { defillamaId: '1', symbol: 'PUMP', geckoId: null, parentProtocol: 'parent#pump' },
      { defillamaId: '2', symbol: '-',    geckoId: null, parentProtocol: 'parent#pump' },
      { defillamaId: '3', symbol: '-',    geckoId: null, parentProtocol: 'parent#paxos' },
      { defillamaId: '4', symbol: '-',    geckoId: null },
      { defillamaId: '5', symbol: 'VELO', geckoId: 'velo-a' },
      { defillamaId: '6', symbol: 'VELO', geckoId: 'velo-b' },
      { defillamaId: '7', symbol: 'CARDS', geckoId: 'collector-crypt' },
    ],
    parentProtocols: [
      { id: 'parent#pump', name: 'Pump', symbol: 'PUMP', gecko_id: 'pump-fun' },
      { id: 'parent#paxos', name: 'Paxos', symbol: 'PAXG', gecko_id: null },
    ],
  }
  const { bySym, ambiguous } = buildRevenue(fees, lite)
  t('a parent\'s protocols are summed under its token (pump.fun + PumpSwap = PUMP)', bySym.PUMP?.r24 === 2_700_000 && bySym.PUMP.r30 === 54e6 && bySym.PUMP.protocols === 2, bySym.PUMP)
  t('named after the parent, categorised by its biggest earner', bySym.PUMP.name === 'Pump' && bySym.PUMP.category === 'Launchpad')
  t('no CoinGecko id, no token: Paxos stablecoin revenue is NOT credited to PAXG', !bySym.PAXG)
  t('a protocol with no token earns nothing for anyone', !Object.values(bySym).some(x => x.r24 === 1.7e7))
  t('a ticker shared by two tokens is dropped, not guessed', !bySym.VELO && ambiguous.includes('VELO'))
  t('a token with its own record counts', bySym.CARDS?.category === 'Physical TCG')
}

console.log(nl + '-- categories (src/sectors.js) --')
{
  const { classify, SECTORS } = await import('../../src/sectors.js')
  const tagsOf = (o) => classify(o).tags
  t('HL stocks + our tech, semis and AI: NVDA', ['stocks', 'tech', 'semis', 'ai'].every(k => tagsOf({ sym: 'NVDA', hlCat: 'stocks' }).includes(k)), tagsOf({ sym: 'NVDA', hlCat: 'stocks' }))
  t('a community spot "NVDA" is not Nvidia: no stock or AI tags', tagsOf({ sym: 'NVDA' }).length === 0, tagsOf({ sym: 'NVDA' }))
  t('commodities split: GOLD is metals, CL energy', tagsOf({ sym: 'GOLD', hlCat: 'commodities' })[0] === 'metals' && tagsOf({ sym: 'CL', hlCat: 'commodities' })[0] === 'energy')
  t("HL's inconsistent spellings are normalised (FX, stock)", classify({ sym: 'EUR', hlCat: 'FX' }).hlCat === 'fx' && classify({ sym: 'X', hlCat: 'stock' }).hlCat === 'stocks')
  t('pre-IPO AI labs are AI: OAI', tagsOf({ sym: 'OAI', hlCat: 'preipo' }).includes('ai'))
  t('crypto: DefiLlama Launchpad → launchpad, plus our lists', tagsOf({ sym: 'PUMP', llamaCat: 'Launchpad' }).includes('launchpad'))
  t('a crypto list never tags a TradFi market (a stock called DOGE)', !tagsOf({ sym: 'DOGE', hlCat: 'stocks' }).includes('memes'))
  t('every sector has a label and a group', SECTORS.every(s => s.key && s.label && ['crypto', 'tradfi', 'both'].includes(s.group)))
}

console.log(nl + '-- categories and revenue on rows --')
{
  const SPOT2 = [
    { tokens: [{ name: 'USDC', index: 0 }, { name: 'PUMP', index: 10, deployerTradingFeeShare: '0.0' }, { name: 'UPUMP', index: 11, deployerTradingFeeShare: '1.0' }, { name: 'NVDA', index: 12, deployerTradingFeeShare: '1.0' }],
      universe: [{ name: '@1', tokens: [10, 0] }, { name: '@2', tokens: [11, 0] }, { name: '@3', tokens: [12, 0] }] },
    [{ coin: '@1', markPx: '0.006', prevDayPx: '0.006', dayNtlVlm: '50', circulatingSupply: '1e7' },
     { coin: '@2', markPx: '0.0064', prevDayPx: '0.0063', dayNtlVlm: '90000', circulatingSupply: '1e12' },
     { coin: '@3', markPx: '180', prevDayPx: '178', dayNtlVlm: '20000', circulatingSupply: '24e9' }],
  ]
  const CORE2 = [{ universe: [{ name: 'PUMP', maxLeverage: 10 }, { name: 'NEAR', maxLeverage: 10 }] },
    [{ markPx: '0.0064', prevDayPx: '0.0063', dayNtlVlm: '150000000', openInterest: '5e10', funding: '0' },
     { markPx: '4.9', prevDayPx: '4.8', dayNtlVlm: '120000000', openInterest: '7e7', funding: '0' }]]
  const revenue = { PUMP: { name: 'Pump', category: 'Launchpad', r24: 2.7e6, r7: 1.6e7, r30: 5.5e7 }, NEAR: { name: 'NEAR', category: 'Bridge', r24: 1000, r7: 7000, r30: 30000 } }
  const cats2 = [['xyz:NVDA', 'stocks']]
  const r2 = M.buildMarkets({ core: CORE2, spot: SPOT2, cats: cats2, revenue })
  const pPerp = r2.find(r => r.kind === 'perp' && r.sym === 'PUMP')
  const pComm = r2.find(r => r.kind === 'spot' && r.sym === 'PUMP' && !r.protocol)
  const pWrap = r2.find(r => r.kind === 'spot' && r.wrapped === 'UPUMP')
  t('the perp carries the token revenue and DefiLlama\'s category', pPerp.rev24 === 2.7e6 && pPerp.category === 'Launchpad')
  t('a community spot token with the same ticker does NOT', pComm && pComm.rev24 === null && pComm.category !== 'Launchpad', pComm)
  t('the wrapped protocol spot (UPUMP) may — it is the same asset', pWrap?.rev24 === 2.7e6)
  { const one = M.onePerToken(r2.filter(r => r.rev24 != null && r.sym === 'PUMP'))
    t('but per token, revenue is counted once — by the perp', one.length === 1 && one[0].kind === 'perp', one) }
  t('the shadow is not strict and carries no category', !M.isStrict(pComm) && pComm.tags.length === 0)
  t('a weak DefiLlama label gives way to ours: NEAR is Layer 1, not Bridge', r2.find(r => r.sym === 'NEAR').category === 'Layer 1', r2.find(r => r.sym === 'NEAR').category)
  t('a protocol spot token HL lists as a stock elsewhere is filed as a stock', r2.find(r => r.kind === 'spot' && r.sym === 'NVDA')?.group === 'tradfi')
  t('no revenue loaded → every revenue cell unknown (null), not 0', M.buildMarkets({ core: CORE2 }).every(r => r.rev24 === null && r.rev30 === null))
  t('rank by revenue sorts unknowns last', M.sortRows(r2, 'rev24')[0].rev24 === 2.7e6 && M.sortRows(r2, 'rev24').at(-1).rev24 === null)
  t('filter by group and sector', M.filterRows(r2, { group: 'tradfi' }).every(r => r.group === 'tradfi') && M.filterRows(r2, { sector: 'launchpad' }).every(r => r.tags.includes('launchpad')))
}

console.log(nl + '-- strict --')
{
  t('every core perp is strict', M.isStrict({ kind: 'perp' }))
  t('a dead HIP-3 copy is not; a live one is', !M.isStrict({ kind: 'hip3', vol24: 0, oi: 0 }) && M.isStrict({ kind: 'hip3', vol24: 5, oi: 0 }))
  t('an untraded community spot token is not', !M.isStrict({ kind: 'spot', vol24: 50, tags: [] }))
  t('one that trades, earns, or is on our lists is', M.isStrict({ kind: 'spot', vol24: M.STRICT_SPOT_MIN_VOL }) && M.isStrict({ kind: 'spot', vol24: 0, rev30: 1 }) && M.isStrict({ kind: 'spot', vol24: 0, tags: ['memes'] }))
  t('the page starts in Strict, like Hyperliquid', /strict: true/.test(JS) && /data-strict="1" class="is-on"/.test(HTML))
  t('the server serves revenue from a cache, and says when it has none', PROD.includes("if (url === '/markets-meta')") && PROD.includes(`'{"revenue":null}'`))
}
t('CI ships it', fs.readFileSync('.github/workflows/deploy.yml', 'utf8').includes('rsync -avz markets.html'))

console.log(nl + '-- the right token for a ticker, and fees beside revenue --')
{
  const L = await import('../../src/llama.js')
  // CoinGecko pages are ordered by market cap; the first coin per ticker is what it means.
  const pages = [[
    { id: 'starknet', symbol: 'strk', market_cap: 4.4e8 },
    { id: 'morpho', symbol: 'morpho', market_cap: 1.9e9 },
    { id: 'sideshift-token', symbol: 'xai', market_cap: 2.9e7 },
  ], [
    { id: 'strike', symbol: 'strk', market_cap: 1e6 },
    { id: 'xai-blockchain', symbol: 'xai', market_cap: 2e7 },
  ]]
  const top = L.cgTopBySymbol(pages)
  t('the biggest coin with a ticker is what it means', top.STRK.id === 'starknet')
  const hl = L.cgForHyperliquid(pages)
  t("an override corrects a ticker HL lists differently: XAI is Xai, not SideShift", hl.XAI.id === 'xai-blockchain' && hl.XAI.mcap === 2e7)
  const v = L.verifyRevenue({
    STRK: { gecko: 'strike', r30: 75000 }, MORPHO: { gecko: 'morpho', r30: 0, f30: 2e7 },
    XAI: { gecko: 'sideshift-token', r30: 0 }, CARDS: { gecko: 'collector-crypt', r30: 1.3e7 },
  }, hl)
  t("Strike's revenue is not put on Starknet's STRK", !v.bySym.STRK && v.dropped.some(d => d.startsWith('STRK:')))
  t("nor SideShift's on Xai's XAI", !v.bySym.XAI)
  t('the right token keeps it', !!v.bySym.MORPHO)
  t('a ticker CoinGecko does not list keeps it: nothing contradicts it', !!v.bySym.CARDS)

  const r = L.buildRevenue(
    { protocols: [{ defillamaId: '9', name: 'Morpho Blue', category: 'Lending', total24h: 0, total7d: 0, total30d: 0 }] },
    { protocols: [{ defillamaId: '9', symbol: 'MORPHO', geckoId: 'morpho' }] },
    { protocols: [{ defillamaId: '9', total24h: 6.6e5, total7d: 4.6e6, total30d: 2e7 }] })
  t('fees ride beside revenue: Morpho keeps $0 of $20M', r.bySym.MORPHO.r30 === 0 && r.bySym.MORPHO.f30 === 2e7)

  const CORE3 = [{ universe: [{ name: 'MORPHO', maxLeverage: 5 }, { name: 'KAITO', maxLeverage: 5 }, { name: 'kPEPE', maxLeverage: 10 }] },
    [{ markPx: '1.8', prevDayPx: '1.8', dayNtlVlm: '1e7', openInterest: '1e6' },
     { markPx: '0.9', prevDayPx: '0.9', dayNtlVlm: '5e6', openInterest: '1e6' },
     { markPx: '0.01', prevDayPx: '0.01', dayNtlVlm: '5e7', openInterest: '1e9' }]]
  const revenue = {
    MORPHO: { name: 'Morpho', category: 'Lending', r24: 0, r7: 0, r30: 0, f24: 6.6e5, f30: 2e7 },
    KAITO: { name: 'Kaito', category: 'Launchpad', r24: 0, r7: 0, r30: 0, f24: 0, f30: 0 },
  }
  const cg = { MORPHO: ['morpho', 1.9e9], PEPE: ['pepe', 4e9], KAITO: ['kaito', 8.4e7] }
  const rows3 = M.buildMarkets({ core: CORE3, revenue, cg })
  const mo = rows3.find(x => x.sym === 'MORPHO'), ka = rows3.find(x => x.sym === 'KAITO'), pe = rows3.find(x => x.sym === 'kPEPE')
  t('the row shows $0 revenue and its fees, not a dash', mo.rev30 === 0 && mo.fee30 === 2e7)
  t("an idle DefiLlama entry ($0 and $0) does not name the category: KAITO is not a launchpad", ka.category !== 'Launchpad' && !ka.tags.includes('launchpad'), ka.category)
  t('a perp with no HL market cap takes CoinGecko\'s', mo.mcap === 1.9e9 && mo.mcapFrom === 'coingecko')
  t('kPEPE takes PEPE\'s', pe.mcap === 4e9)
  t('a HIP-3 stock never takes a CoinGecko cap', M.withCgMarketCaps([{ kind: 'hip3', group: 'tradfi', sym: 'MORPHO', mcap: null }], cg)[0].mcap === null)
  t('revenue and fees sort', M.sortRows(rows3, 'fee30')[0].sym === 'MORPHO')
  t('the server will not serve revenue unchecked against CoinGecko',
    /if \(!llamaData \|\| !cgData\) return null/.test(PROD) && PROD.includes('verifyRevenue(llamaData.bySym, cgData.top)'))
  t('and fetches CoinGecko slowly, bounded, cached on disk',
    PROD.includes('setTimeout(r, 13_000)') && PROD.includes('retries++ < 4') && PROD.includes("join(__dirname, 'data', 'cgtop.json')"))
  t('one pm2 worker fetches CoinGecko (lock); the others read its file on request',
    PROD.includes("const CG_LOCK = CG_FILE + '.lock'") && /if \(!cgData \|\| Date\.now\(\) - cgData\.at > CG_TTL\) cgFromDisk\(\)/.test(PROD))
  t('the Revenue view lists tokens with revenue OR fees', /\(r\.fee30 \?\? 0\) > 0/.test(JS) && JS.includes("['fee30', 'Fees 30d']"))
}

console.log(nl + '-- stocks: sectors from the SEC industry code, and our lists --')
{
  const { sicSectors, classify } = await import('../../src/sectors.js')
  const has = (code, k) => sicSectors(code).includes(k)
  // The codes the SEC actually files for these companies.
  t('Chevron 2911 petroleum refining → Energy', has(2911, 'energy'))
  t('Costco 5331 variety stores → Consumer', has(5331, 'consumer'))
  t('Eli Lilly 2834 → Healthcare; Hims 8011 → Healthcare', has(2834, 'healthcare') && has(8011, 'healthcare'))
  t('Vistra 4911 → Utilities', has(4911, 'utilities'))
  t('Rocket Lab 3760 and RTX 3724 → Aerospace & defense', has(3760, 'aerospace') && has(3724, 'aerospace'))
  t('NVIDIA 3674 → Semiconductors and Tech', has(3674, 'semis') && has(3674, 'tech'))
  t('Coinbase 6199, Blackstone 6282 → Financials', has(6199, 'financials') && has(6282, 'financials'))
  t('Netflix 7841 → Telecom & media; Microsoft 7372 → Tech', has(7841, 'media') && has(7372, 'tech'))
  t('Tesla 3711 → Autos; USA Rare Earth 1000 → Materials', has(3711, 'autos') && has(1000, 'materials'))
  t('no code, no guess', sicSectors(null).length === 0 && sicSectors(0).length === 0)
  t('the code applies to stocks only, never to a crypto token with the same ticker',
    classify({ sym: 'CVX', hlCat: 'stocks', sic: 2911 }).tags.includes('energy') && !classify({ sym: 'CVX', sic: 2911 }).tags.includes('energy'))
  t('non-SEC companies from our lists: SK Hynix → Semiconductors, Hyundai → Autos',
    classify({ sym: 'SKHX', hlCat: 'stocks' }).tags.includes('semis') && classify({ sym: 'HYUNDAI', hlCat: 'stocks' }).tags.includes('autos'))
  t('chip-equipment makers are Semiconductors despite their machinery code (ASML 3559)',
    classify({ sym: 'ASML', hlCat: 'stocks', sic: 3559 }).tags.includes('semis'))
  t('ETFs are ETFs, and carry their theme: SMH → Semiconductors, XLE → Energy',
    ['etf', 'semis'].every(k => classify({ sym: 'SMH', hlCat: 'stocks' }).tags.includes(k)) && ['etf', 'energy'].every(k => classify({ sym: 'XLE', hlCat: 'stocks' }).tags.includes(k)))
  t('the server reads each company\'s industry code with its revenue, and refetches a cache from before',
    PROD.includes('data.sec.gov/submissions/CIK') && PROD.includes('secData = d.sic && d.v >= 2 ? d : { ...d, at: 0 }'))
  const rowsC = M.buildMarkets({ hip3: [{ dex: 'xyz', label: 'XYZ', data: [{ universe: [{ name: 'xyz:CVX', maxLeverage: 10 }] }, [{ markPx: '150', prevDayPx: '149', dayNtlVlm: '1e6', openInterest: '1e4' }]] }],
    cats: [['xyz:CVX', 'stocks']], sic: { CVX: [2911, 'Petroleum Refining'] } })
  t('on the page: CVX is Stocks + Energy', rowsC[0].tags.includes('stocks') && rowsC[0].tags.includes('energy'), rowsC[0].tags)
}

console.log(nl + '-- stocks: revenue reported to the SEC (src/secrev.js) --')
{
  const S = await import('../../src/secrev.js')
  // Microsoft's real FY2026 figures ($M): three 10-Q quarters, and a 10-K year whose last
  // quarter is never filed on its own. The same quarter refiled later must not double.
  const f = (start, end, val, filed) => ({ start, end, val: val * 1e6, filed })
  const MSFT = [
    f('2024-04-01', '2024-06-30', 64727, '2024-07-30'),
    f('2024-07-01', '2024-09-30', 65585, '2024-10-30'), f('2024-10-01', '2024-12-31', 69632, '2025-01-29'),
    f('2025-01-01', '2025-03-31', 70066, '2025-04-30'), f('2024-07-01', '2025-06-30', 281724, '2025-07-30'),
    f('2025-07-01', '2025-09-30', 77673, '2025-10-29'), f('2025-10-01', '2025-12-31', 81273, '2026-01-28'),
    f('2025-10-01', '2025-12-31', 81273, '2026-07-29'),   // refiled as a comparative
    f('2026-01-01', '2026-03-31', 82886, '2026-04-29'), f('2025-07-01', '2026-03-31', 241832, '2026-04-29'),
    f('2025-07-01', '2026-06-30', 331839, '2026-07-29'),
  ]
  const series = S.quarterSeries(MSFT)
  const q4 = series.find(q => q.end === '2026-06-30')
  t('the fiscal Q4 is derived from the 10-K: 331,839 − 77,673 − 81,273 − 82,886 = 90,007', q4?.derived && Math.round(q4.val / 1e6) === 90007, q4)
  t('a 9-month year-to-date figure is not taken for a quarter', !series.some(q => q.start === '2025-07-01' && q.end === '2026-03-31'))
  t('a quarter refiled later is counted once', series.filter(q => q.end === '2025-12-31').length === 1)
  const sum = S.summarizeRevenue(series)
  t('last quarter, twelve months, growth year on year', sum.qEnd === '2026-06-30' && Math.round(sum.ttm / 1e6) === 331839 && Math.abs(sum.yoy - (90007 / (281724 - 65585 - 69632 - 70066) - 1) * 100) < 0.01, sum)
  t('no twelve months across a gap', S.summarizeRevenue([{ start: '2025-01-01', end: '2025-03-31', val: 1 }, { start: '2025-07-01', end: '2025-09-30', val: 1 }, { start: '2025-10-01', end: '2025-12-31', val: 1 }, { start: '2026-01-01', end: '2026-03-31', val: 1 }]).ttm === null)
  t('a derived Q4 that comes out negative is dropped, not shown',
    !S.quarterSeries([f('2025-01-01', '2025-03-31', 50, 'a'), f('2025-04-01', '2025-06-30', 50, 'b'), f('2025-07-01', '2025-09-30', 50, 'c'), f('2025-01-01', '2025-12-31', 100, 'd')]).some(q => q.derived))
  t('of several concepts, the one with the latest quarter wins',
    S.companyRevenue({ Revenues: [f('2020-01-01', '2020-03-31', 5, 'x')], RevenueFromContractWithCustomerExcludingAssessedTax: MSFT }).concept === 'RevenueFromContractWithCustomerExcludingAssessedTax')
  const rowsS = M.withStockRevenue([{ sym: 'NVDA', hlCat: 'stocks' }, { sym: 'NVDA', hlCat: 'crypto' }],
    { NVDA: { name: 'NVIDIA CORP', q: 9.6e10, qStart: '2026-04-27', qEnd: '2026-07-26', ttm: 3.0e11, yoy: 105.9 } })
  t('only a market HL calls a stock takes a company\'s revenue', rowsS[0].sq === 9.6e10 && rowsS[1].sq === undefined)
  t('the server fetches the SEC once a day, one worker, identified, paced',
    PROD.includes('const SEC_TTL = 24 * 60 * 60_000') && PROD.includes("const SEC_LOCK = SEC_FILE + '.lock'") && PROD.includes("process.env.SEC_CONTACT") && PROD.includes('setTimeout(r, 170)'))
  t('the TradFi tab has its own revenue columns; crypto revenue does not mix stocks in',
    JS.includes("const stockRevenueView = () => view.mode === 'revenue' && view.tab === 'tradfi'") && JS.includes("['sq', 'Revenue, last quarter']"))
}

console.log(nl + '-- revenue history: the chart (src/revchart.js) and its source --')
{
  const C = await import('../../src/revchart.js')
  const L = await import('../../src/llama.js')
  const S = await import('../../src/secrev.js')
  const day = 86400
  // 400 days of $1,000/day ending on a Wednesday mid-month, as DefiLlama sends them.
  const end = Date.UTC(2026, 9, 7) / 1000
  const pts = Array.from({ length: 400 }, (_, i) => [end - (399 - i) * day, 1000])
  t('a range is measured back from the newest day the series has, not from now (DefiLlama lags)',
    C.windowPoints(pts, 30).length === 30 && C.windowPoints(pts, 30)[0].t === (end - 29 * day) * 1000)
  const d90 = C.bucket(C.windowPoints(pts, 90), 90)
  t('up to 90 days: one bar a day', d90.length === 90 && d90.every(b => b.unit === 'day' && b.v === 1000))
  const w = C.bucket(C.windowPoints(pts, 365), 365)
  t('a year: summed by week, nothing lost', w.every(b => b.unit === 'week') && w.reduce((a, b) => a + b.v, 0) === 365 * 1000)
  t('this week so far is flagged, not drawn as a full week', w.at(-1).partial && w.at(-1).days < 7 && !w[1].partial)
  const mo = C.bucket(C.windowPoints(pts, null), null)
  t('all time: summed by month; this month so far is flagged', mo.every(b => b.unit === 'month') && mo.at(-1).partial && mo.reduce((a, b) => a + b.v, 0) === 400 * 1000)
  const st = C.rangeStats(pts, 90)
  t('range total and average per day', st.total === 90000 && st.avg === 1000 && st.days === 90)
  t('change vs the period before, when that period is fully covered', st.change === 0)
  t('no change against a period the data does not cover', C.rangeStats(pts.slice(-100), 90).change === null)
  t('a clean axis: 0 to a round top in 4 steps', JSON.stringify(C.niceScale(3.3e6).ticks) === JSON.stringify([0, 1e6, 2e6, 3e6, 4e6]))
  t('axis labels are round: $150M, $2.5M', C.tickUsd(150e6) === '$150M' && C.tickUsd(2.5e6) === '$2.5M')
  t('a period still in progress says so in its label', /so far/.test(C.barLabel(w.at(-1))) && /so far/.test(C.barLabel(mo.at(-1))))

  t('daily series from several protocols sum by day', JSON.stringify(L.sumDaily([[[1, 5], [2, 5]], [[2, 3], [3, 1]]])) === JSON.stringify([[1, 5], [2, 8], [3, 1]]))
  const rv = L.buildRevenue({ protocols: [
    { defillamaId: '1', slug: 'aave-v2', total24h: 1, total7d: 1, total30d: 1, parentProtocol: 'parent#aave' },
    { defillamaId: '2', slug: 'aave-v3', total24h: 1, total7d: 1, total30d: 1, parentProtocol: 'parent#aave' },
    { defillamaId: '3', slug: 'spark',   total24h: 1, total7d: 1, total30d: 1, parentProtocol: 'parent#sky' },
  ] }, {
    protocols: [{ defillamaId: '1', symbol: 'AAVE', geckoId: 'aave' }, { defillamaId: '2', symbol: '-', geckoId: null },
                { defillamaId: '3', symbol: 'SPK', geckoId: 'spark-2' }],
    parentProtocols: [{ id: 'parent#aave', symbol: 'AAVE', gecko_id: 'aave' }, { id: 'parent#sky', symbol: 'SKY', gecko_id: 'sky' }],
  })
  t("a token's history comes from its parent alone, never parent + child (aave-v2 is inside Aave)", JSON.stringify(rv.bySym.AAVE.slugs) === '["aave"]')
  t("a child with its OWN token keeps its own history, not its parent's total (SPK is not Sky)", JSON.stringify(rv.bySym.SPK.slugs) === '["spark"]')
  t('the history URL asks for revenue or fees', /dataType=dailyRevenue/.test(L.llamaSummaryUrl('pump', 'revenue')) && /dataType=dailyFees/.test(L.llamaSummaryUrl('pump', 'fees')))
  t('the server charts only a ticker the revenue table carries, and caches each history',
    PROD.includes("if (url === '/markets-revenue')") && PROD.includes('verifyRevenue(llamaData.bySym, cgData.top).bySym[sym]') && PROD.includes('const REVHIST_TTL = 60 * 60_000'))
  const f = (start, endD, val) => ({ start, end: endD, val, filed: endD })
  const co = S.companyRevenue({ Revenues: [f('2025-01-01', '2025-03-31', 10), f('2025-04-01', '2025-06-30', 12), f('2025-07-01', '2025-09-30', 14)] })
  t('a stock keeps its quarters for the chart: [start, end, value, derived]', co.hist.length === 3 && co.hist.at(-1)[2] === 14 && co.hist.at(-1)[3] === 0)
  t('and an old SEC cache without them counts as stale', PROD.includes('d.v >= 2'))
  t('the Revenue view opens a row\'s history', JS.includes("import { openRevenueChart } from './revchart.js'") && JS.includes('mk-row-chart'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
