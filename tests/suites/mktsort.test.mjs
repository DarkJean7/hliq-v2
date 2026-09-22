// Sorting the market list by several columns at once. See src/mktsort.js for why it blends
// ranks rather than breaking ties: OI and volume never tie, so a tie-break would do nothing.
import fs from 'fs'
import { SORT_KEYS, cycleSortKey, cleanSortKeys, multiSort } from '../../src/mktsort.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const names = (l) => l.map(x => x.n).join(',')

// Four markets, numbers chosen so each column orders them differently.
const M = [
  { n: 'BTC',  oi: 900, volume: 500, change: 1,  price: 85000 },
  { n: 'ETH',  oi: 800, volume: 900, change: -2, price: 3000 },
  { n: 'PUMP', oi: 100, volume: 950, change: 12, price: 0.0045 },
  { n: 'DOGE', oi: 300, volume: 100, change: 4,  price: 0.2 },
]
const val = (m, k) => m[k]

console.log(nl + '-- choosing columns --')
{
  t('the four columns asked for', SORT_KEYS.join() === 'oi,change,volume,price')
  let k = cycleSortKey([], 'oi')
  t('a press adds a column, descending', JSON.stringify(k) === '[{"k":"oi","dir":"desc"}]')
  k = cycleSortKey(k, 'volume')
  t('the next goes after it', k.map(x => x.k).join() === 'oi,volume')
  k = cycleSortKey(k, 'oi')
  t('pressing a chosen one flips it to ascending, keeping its place', k[0].k === 'oi' && k[0].dir === 'asc')
  k = cycleSortKey(k, 'oi')
  t('and once more takes it out', k.map(x => x.k).join() === 'volume')
  t('an unknown column is ignored', cycleSortKey(k, 'name') === k)
  t('stored junk is cleaned', JSON.stringify(cleanSortKeys([{ k: 'oi', dir: 'x' }, { k: 'oi' }, { k: 'evil' }, null])) === '[{"k":"oi","dir":"desc"}]')
}

console.log(nl + '-- one column is just that column --')
{
  t('OI alone', names(multiSort(M, [{ k: 'oi', dir: 'desc' }], val)) === 'BTC,ETH,DOGE,PUMP')
  t('volume alone', names(multiSort(M, [{ k: 'volume', dir: 'desc' }], val)) === 'PUMP,ETH,BTC,DOGE')
  t('ascending too', names(multiSort(M, [{ k: 'price', dir: 'asc' }], val)) === 'PUMP,DOGE,ETH,BTC')
}

console.log(nl + '-- several at once, the first counting most --')
{
  // OI then volume, weighted 2:1 by rank. OI alone: BTC, ETH, DOGE, PUMP. PUMP is last on OI
  // but first on volume, DOGE is third on OI and last on volume — the blend swaps them, which a
  // strict tie-break never would (their OI values are not equal). BTC keeps the top: one place
  // ahead on the FIRST column outweighs one place behind on the second.
  const ov = multiSort(M, [{ k: 'oi', dir: 'desc' }, { k: 'volume', dir: 'desc' }], val)
  t('OI + volume: the second column moves markets', names(ov) === 'BTC,ETH,PUMP,DOGE', names(ov))
  t('where OI alone would not have', names(multiSort(M, [{ k: 'oi', dir: 'desc' }], val)) === 'BTC,ETH,DOGE,PUMP')
  // Precedence: the same two columns the other way round put a different market on top.
  const vo = multiSort(M, [{ k: 'volume', dir: 'desc' }, { k: 'oi', dir: 'desc' }], val)
  t('volume + OI: the priority decides who leads', vo[0].n === 'PUMP' && ov[0].n === 'BTC', names(vo))
  t('a market last on the FIRST column cannot lead', ov[0].n !== 'PUMP')
  const all = multiSort(M, [{ k: 'oi', dir: 'desc' }, { k: 'change', dir: 'desc' }, { k: 'volume', dir: 'desc' }, { k: 'price', dir: 'desc' }], val)
  t('all four at once', all.length === 4 && new Set(all.map(x => x.n)).size === 4, names(all))
  t('the input is left alone', names(M) === 'BTC,ETH,PUMP,DOGE')
}

console.log(nl + '-- level scores --')
{
  const same = [{ n: 'A', oi: 0, volume: 5 }, { n: 'B', oi: 0, volume: 9 }]
  // Spot markets have no OI: equal values share a rank, and the caller's tiebreak decides.
  const r = multiSort(same, [{ k: 'oi', dir: 'desc' }], val, (a, b) => b.volume - a.volume)
  t('a block of zeros is ordered by the tiebreak', names(r) === 'B,A', names(r))
}

console.log(nl + '-- wired into the Trade tab --')
{
  const main = fs.readFileSync('src/main.js', 'utf8')
  const css = fs.readFileSync('src/style.css', 'utf8')
  t('a Multi toggle beside Symbol', /id="mobMktMultiBtn"[^>]*onclick="window\._mobTradeMulti\(\)"/.test(main))
  t('in multi mode a press cycles the column', /_mobMultiSort\.keys = _mktCycleSortKey\(_mobMultiSort\.keys, type\)/.test(main))
  t('the list is sorted by the blend', /entries = _mktMultiSort\(entries, _mobMultiSort\.keys, val,/.test(main))
  t('OI means market cap under Spot, as in the single sort', /const val = \(\[k, px\], col\) => col === 'oi' \? oiMetric\(k\)/.test(main))
  t('the choice is remembered', /localStorage\.setItem\('hliq_mkt_multisort_v1'/.test(main))
  t('a column shows its place in the order', /<sup class="mob-mkt-sortpos">\$\{pos\}<\/sup>/.test(main))
  t('the Trade tab is solid under a backdrop photo',
    /classList\.toggle\('mob-in-trade', _mobVActiveTab === 'trade'\)/.test(main) &&
    /html\.has-bg-image #mobileView\.mob-in-trade \.mob-v-content \{\s*background: var\(--bg\) !important;/.test(css))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
