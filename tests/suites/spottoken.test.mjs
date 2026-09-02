// A spot token's INDEX is not its position in the tokens array.
//
// Hyperliquid's spotMeta returns ~498 tokens carrying indices up to ~871: delistings have
// left gaps. Reading tokens[u.tokens[0]] therefore returns undefined for every token whose
// index outran the array, which was 24 of 326 spot markets. Each one lost its ticker (shown
// as "@702" instead of NVDAX, so unsearchable) and was misfiled as community, because an
// undefined deployerTradingFeeShare parses to 0.
//
// Two consumers had it; a third already did it correctly with an index map. These hold all
// three to the same rule.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

console.log(nl + '-- nothing indexes the tokens array by token id --')
// The whole bug in one line. If this comes back, so do the 24 missing markets.
t('no tokens[...] positional read survives', !/tokens\?\.\[u\.tokens|[^y]tokens\[u\.tokens/.test(cli),
  (cli.match(/[^\n]*tokens\[u\.tokens[^\n]*/g) ?? []).slice(0, 3).join(' | '))

console.log(nl + '-- every site builds an index map instead --')
const maps = cli.match(/new Map\(\(?\s*(meta\?\.tokens \?\? \[\]|tokens|\(meta\.tokens \?\? \[\]\))\s*\)?\.map\(t => \[t\.index/g) ?? []
t('there are at least three of them', maps.length >= 2, String(maps.length))
t('the spot name map uses one', cli.includes('const tokByIdx = new Map(tokens.map(t => [t.index, t]))'))
t('the market-cap pass uses one',
  cli.includes('const tokByIdx = new Map((meta?.tokens ?? []).map(t => [t.index, t]))'))
t('the one that was already correct still is',
  cli.includes('const tokById = new Map((meta.tokens ?? []).map(t => [t.index, t.name]))'))
t('and both new sites read through it',
  (cli.match(/tokByIdx\.get\(u\.tokens\?\.\[0\]\)/g) ?? []).length === 2,
  String((cli.match(/tokByIdx\.get\(u\.tokens\?\.\[0\]\)/g) ?? []).length))

console.log(nl + '-- the reason is written down where the next person will look --')
t('the gap between index and position is explained',
  cli.includes("A token's INDEX is not its position in this array"))
t('with the real numbers, not a generality', cli.includes('indices up to 871'))
t('and the symptom it produced', cli.includes('24 of 326 spot markets'))
t('including why it was misfiled, not just unnamed',
  cli.includes('an undefined deployerTradingFeeShare parses to 0'))
t('the second site points at the first rather than repeating it',
  cli.includes('see the note in _doEnsureMarketData'))

console.log(nl + '-- the neighbouring join stays keyed by name, not position --')
// spotMetaAndAssetCtxs returns 718 ctxs against 326 universe rows, so THAT one was never
// positional and must not become so.
t('spot ctxs are matched on c.coin', cli.includes('const key = c?.coin'))
t('why is recorded', cli.includes('spotCtxs is NOT index-parallel to universe'))
t('the market-cap pass matches on coin too', cli.includes('const name = byCoin[c?.coin]'))

console.log(nl + '-- the protocol/community split reads a real value --')
t('it comes from the token, which now resolves',
  cli.includes("parseFloat(base?.deployerTradingFeeShare ?? '0') === 0"))
t('community and protocol are still separate sets',
  cli.includes('_spotCommunityKeys.add(atKey)') && cli.includes('_spotProtocolKeys.add(atKey)'))

console.log(nl + '-- a protocol market still has to trade to be listed --')
// Not part of the bug: TSLAX and AAPLX resolve their names correctly now and are still
// hidden, because they have never traded. Asserted so the gate is a decision on the
// record rather than something rediscovered as a bug later.
t('protocol spot is gated on volume',
  cli.includes("(_spotProtocolKeys.has(k) && (_mktCtxMap[k]?.volume ?? 0) > 0)"))
t('community spot is not', cli.includes('|| _spotCommunityKeys.has(k)'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
