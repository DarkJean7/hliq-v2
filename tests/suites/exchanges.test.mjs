// The Exchanges view's CEX list: every exchange DefiLlama reports a number for.
//
// "im wondering where are some popular exchanges like coinbase, kraken". Requiring an assets figure
// dropped Coinbase, Upbit and Bithumb, which have volume but no public wallet list.
import fs from 'fs'
import { buildCexes, buildDexes, sortEx, withCexRevenue, worthOfCex, sharesFromFacts } from '../../src/exchanges.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const rows = buildCexes({ cexs: [
  { name: 'Binance', slug: 'Binance-CEX', cleanAssetsTvl: 1e11, currentTvl: 1e11, spotVolume: 6e9, derivVolume: 5e10, oi: 3e10, inflows_24h: 1e8 },
  { name: 'Coinbase', spotVolume: 2.7e9 },
  { name: 'Robinhood', slug: 'robinhood', cleanAssetsTvl: 1.3e10 },
  { name: 'Crypto.com', slug: 'Crypto-com', spotVolume: 1e9 },
  { name: 'Voyager' },
] })
const by = Object.fromEntries(rows.map(r => [r.name, r]))
t('an exchange with volume and no wallet list is in', !!by.Coinbase, rows.map(r => r.name))
t('its assets are unknown, not 0', by.Coinbase.assets === null, by.Coinbase.assets)
t('its volume shows', by.Coinbase.vol24 === 2.7e9)
t('with the ticker its SEC revenue joins on', by.Coinbase.ticker === 'COIN')
t('and a logo looked up by name, having no slug', by.Coinbase.slug === 'coinbase')
t('an exchange with assets and no volume is still in', by.Robinhood.assets === 1.3e10 && by.Robinhood.vol24 == null)
t('one DefiLlama reports nothing for is not', !by.Voyager)
t('ranked by assets, unknown goes last, not first', sortEx(rows, 'assets').at(-1).assets === null)
t('ranked by volume, Coinbase sits among the others', sortEx(rows, 'vol24')[1].name === 'Coinbase', sortEx(rows, 'vol24').map(r => r.name))

// "do we really not have the revenue, fees of popular cex": only the ones that report it.
const rev = withCexRevenue(rows, { COIN: { q: 1.8e9, ttm: 5.6e9, yoy: 10 } })
const coin = rev.find(r => r.name === 'Coinbase')
t('a company that files shows a 30d of a third of its quarter', coin.r30 === 6e8 && coin.r30Approx === true, coin)
const mk = fs.readFileSync('src/markets.js', 'utf8')
t('marked as an approximation in the cell', /r\.r30Approx \? approx\(r\)/.test(mk))
const bn = rev.find(r => r.name === 'Binance')
t('one that does not has no figure, not a 0', bn.r30 === null && bn.r30Approx === false, bn)
t('missing assets read as not tracked, not as not having any', />not tracked</.test(mk) && !/>not published</.test(mk))

// "cant we not add the exchange worth?"
const shares = { COIN: 264e6 }
const cg = { BNB: ['binancecoin', 90e9] }
const px = (tk) => tk === 'COIN' ? 136.37 : null
const w = (o) => worthOfCex(o, { shares, cg, priceOf: px })
t('a listed company: shares × the live price', w({ ticker: 'COIN' }).worth === 264e6 * 136.37 && w({ ticker: 'COIN' }).worthKind === 'stock')
t('an exchange with a token: its cap, kept apart as the token', w({ coin: 'BNB' }).worth === 90e9 && w({ coin: 'BNB' }).worthKind === 'token' && w({ coin: 'BNB' }).worthSym === 'BNB')
t('a company with shares but no price yet is unknown, not 0', w({ ticker: 'HOOD' }).worth === null, w({ ticker: 'HOOD' }))
t('private with no token is unknown, not 0', w({ name: 'Bitstamp' }).worth === null)
t('the token never stands in for a company that has a price', w({ ticker: 'COIN', coin: 'BNB' }).worthKind === 'stock')
const facts = { facts: { 'us-gaap': { WeightedAverageNumberOfSharesOutstandingBasic: { units: { shares: [
  { end: '2026-06-30', val: 260e6 }, { end: '2026-09-30', val: 263e6 }, { end: '2026-09-30', val: 264e6 }] } } } } }
t('the shares are the latest period\'s, the larger of its entries', sharesFromFacts(facts) === 264e6, sharesFromFacts(facts))
t('filings without them are unknown', sharesFromFacts({ facts: {} }) === null)
const dx = buildDexes({ protocols: [{ defillamaId: '1', name: 'HL Perps', category: 'Derivatives', parentProtocol: 'parent#hl', total30d: 5 }, { defillamaId: '2', name: 'Solo', category: 'Dexs', total30d: 5 }] }, null,
  { parentProtocols: [{ id: 'parent#hl', name: 'Hyperliquid', mcap: 18e9, symbol: 'HYPE' }], protocols: [{ defillamaId: '2', mcap: 0, symbol: '-' }] })
t('a DEX takes its parent\'s token cap', dx.find(d => d.name === 'Hyperliquid').mcap === 18e9 && dx.find(d => d.name === 'Hyperliquid').sym === 'HYPE', dx)
t('and one with no token has none, not 0', dx.find(d => d.name === 'Solo').mcap === null, dx)
t('a token cell names its token', /mk-worth-sym/.test(fs.readFileSync('src/markets.js', 'utf8')))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
