// The Markets card on the Trade tab (src/trademkt.js).
//
// Asked for: "volume(time frames), open interest(time frames), revenue(time frame),
// fees(time frame), worth". Most of that exists per market; one of them does not, and the
// interesting half of this file is what the card refuses to say.
import fs from 'fs'
import { volumeIn, volumeWindows, marketFacts, marketCardHtml, hasFacts, money, symOf, VOL_WINDOWS } from '../../src/trademkt.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const NOW = Date.UTC(2026, 10, 18, 12)
const DAY = 86_400_000
/** n bars ending now, one per `stepMs`, each trading `v` at `c`. */
const bars = (n, v, c, stepMs = 3600e3, from = NOW) =>
  Array.from({ length: n }, (_, i) => ({ t: from - (i + 1) * stepMs, T: from - i * stepMs, v: String(v), c: String(c) }))

console.log('\n-- volume from candles --')
// Checked against the exchange's own dayNtlVlm on BTC, ETH, HYPE and SOL: within 0.1%, which
// is why this is allowed to stand beside Hyperliquid's figure instead of under a caveat.
t('a bar is worth what it traded at', volumeIn(bars(1, 10, 100), DAY, NOW) === 1000)
t('only bars inside the window count', volumeIn(bars(48, 10, 100), DAY, NOW) === 24 * 1000)
t('a longer window reaches further back', volumeIn(bars(48, 10, 100), 2 * DAY, NOW) === 48 * 1000)

console.log('\n-- and what it will not call zero --')
// /extcandles synthesises bars with v:'0' for the markets Hyperliquid does not list (DXY, the
// S&P). They have a price history and no volume; 0 would claim nobody traded them.
t('no candles at all is unknown', volumeIn([], DAY, NOW) === null)
t('not an array is unknown', volumeIn(null, DAY, NOW) === null && volumeIn('loading', DAY, NOW) === null)
t('bars that all carry no volume are unknown, not zero', volumeIn(bars(24, 0, 100), DAY, NOW) === null)
t('nothing inside the window is unknown', volumeIn(bars(2, 10, 100, 3600e3, NOW - 10 * DAY), DAY, NOW) === null)
t('a bar with an unreadable price is skipped, not counted as zero',
  volumeIn([{ T: NOW, v: '10', c: 'x' }, { T: NOW, v: '10', c: '100' }], DAY, NOW) === 1000)

console.log('\n-- each window reads the series that covers it --')
// Hourly candles span 31 days and daily ones go back to 2023, so a year is not summed off a
// series that cannot reach it.
t('six windows', VOL_WINDOWS.length === 6)
t('short windows take the hourly series', VOL_WINDOWS.filter(([, , w]) => w === '1h').map(([l]) => l).join() === '24H,7D,30D')
t('long ones take the daily series', VOL_WINDOWS.filter(([, , w]) => w === '1d').map(([l]) => l).join() === '3M,6M,1Y')
{
  const w = volumeWindows(bars(24 * 31, 10, 100), bars(400, 240, 100, DAY), NOW)
  t('each window gets a label and a figure', w.length === 6 && w.every(([l, v]) => typeof l === 'string' && (v === null || v > 0)))
  t('7d is seven days of the hourly series', w[1][1] === 7 * 24 * 1000)
  t('a year is summed off daily bars', w[5][1] === 365 * 24000)
}
t('with no candles at all, every window is a dash', volumeWindows(null, null, NOW).every(([, v]) => v === null))

console.log('\n-- crypto and TradFi are not given the same figures --')
// A ticker collides: NVDA is a chip company on one dex and could be a token on DefiLlama. The
// split is classify()'s, the same call categorize() makes in src/marketsdata.js.
const META = {
  revenue: { HYPE: { name: 'Hyperliquid', category: 'Derivatives', r24: 1, r7: 2, r30: 3, f24: 4, f7: 5, f30: 6 },
             NVDA: { name: 'Not NVIDIA', category: 'Lending', r24: 99, r7: 99, r30: 99, f24: 99, f7: 99, f30: 99 } },
  stocks: { NVDA: { name: 'NVIDIA CORP', q: 96221000000, qEnd: '2026-07-26', ttm: 302969000000, yoy: 105.85114348672526 } },
  cg: { HYPE: ['hyperliquid', 16039066017], NVDA: ['nvidia-robinhood-tokenized-stock', 19383922] },
  sic: { NVDA: [3674, 'Semiconductors & Related Devices'] },
}
const facts = (coin, hlCat, ctx = null) => marketFacts({ coin, hlCat, ctx, h1: bars(24, 10, 100), d1: null, meta: META, now: NOW })
{
  const n = facts('xyz:NVDA', 'stocks', { volume: 928.1e6, oi: 399.3e6 })
  t('a stock market is tradfi', n.group === 'tradfi')
  t('it does NOT take a protocol’s revenue that shares its ticker', n.rev === null && n.fee === null)
  t('nor the tokenised wrapper’s market cap, which is not what the company is worth', n.worth === null)
  t('it takes the SEC filing instead', n.stock?.name === 'NVIDIA CORP' && n.stock.q === 96221000000 && n.stock.ttm === 302969000000)
  t('and the industry the filing files it under', n.sector === 'Semiconductors & Related Devices')

  const h = facts('HYPE', 'crypto', { volume: 464.7e6, oi: 1.2e9 })
  t('a crypto market is crypto', h.group === 'crypto')
  t('it takes the protocol’s revenue over three windows', h.rev.r24 === 1 && h.rev.r7 === 2 && h.rev.r30 === 3)
  t('and its fees over three windows', h.fee.f24 === 4 && h.fee.f7 === 5 && h.fee.f30 === 6)
  t('and the token’s market cap as its worth', h.worth === 16039066017)
  t('it is not handed an SEC filing', h.stock === null)

  const b = facts('BTC', 'crypto', { volume: 1, oi: 5e9 })
  t('a coin with no protocol behind it reports no revenue, rather than zero', b.rev === null && b.fee === null)
}

console.log('\n-- open interest, and the window that does not exist --')
{
  const f = facts('BTC', 'crypto', { volume: 1, oi: 5e9 })
  t('the live figure is carried', f.oi === 5e9)
  const o = facts('BTC', 'crypto', { volume: 1, oi: 0 })
  t('a zero open interest is unknown, not a real zero', o.oi === null)
  t('there is no oi window list to render', !('oiWindows' in f))
  // Hyperliquid publishes open interest as it is now and no history of it, so the card says so
  // rather than inventing a 24h-ago figure.
  const html = marketCardHtml(f, {})
  t('and the card says why there is no history', /publishes no history of it/.test(html))
  const src = fs.readFileSync('src/trademkt.js', 'utf8')
  t('the reason is written where the next reader will be', /keeps no\s*\* history of it per market/.test(src) || /no history of it per market/.test(src))
}

console.log('\n-- the card --')
{
  const n = facts('xyz:NVDA', 'stocks', { volume: 928.1e6, oi: 399.3e6 })
  const html = marketCardHtml(n, {})
  t('it is a card like the two above it', html.startsWith('<div class="tb-card">'))
  t('headed Market', /<span>Market<\/span>/.test(html))
  t('volume runs across the window strip', /class="tb-perf"/.test(html) && />24H</.test(html) && />1Y</.test(html))
  t('the SEC figures are labelled as revenue, with the quarter they cover', /Revenue, quarter/.test(html) && /quarter to 2026-07-26/.test(html))
  t('year on year is a percentage, toned', /Year on year<\/span><b class="up">\+105\.9%/.test(html))
  t('and the note names whose revenue it is', /Revenue is NVIDIA CORP(&#39;|')s own/.test(html))

  const h = marketCardHtml(facts('HYPE', 'crypto', { volume: 1, oi: 1 }), {})
  t('a protocol market lists revenue and fees over their windows',
    /Revenue 24h/.test(h) && /Revenue 7d/.test(h) && /Revenue 30d/.test(h) && /Fees 24h/.test(h) && /Fees 30d/.test(h))
  t('and says the revenue is the protocol’s, not this market’s', /are Hyperliquid(&#39;|')s, across every chain/.test(h))
}

console.log('\n-- nothing to say is said as nothing --')
t('no facts, no card', marketCardHtml(marketFacts({ coin: 'BTC', meta: null, now: NOW }), {}) === '')
t('hasFacts is false when every figure is unknown', !hasFacts(marketFacts({ coin: 'BTC', meta: null, now: NOW })))
t('but a lone open interest is enough to draw one', hasFacts(marketFacts({ coin: 'BTC', ctx: { oi: 5e9 }, meta: null, now: NOW })))
t('a market with no candles falls back to the exchange’s own 24h figure',
  /\$928\.1M/.test(marketCardHtml(marketFacts({ coin: 'BTC', ctx: { volume: 928.1e6, oi: 1 }, meta: null, now: NOW }), {})))

console.log('\n-- money, and privacy --')
t('trillions', money(1.27e12) === '$1.27T')
t('billions', money(16.04e9) === '$16.04B')
t('millions', money(2.5e6) === '$2.5M')
t('null is a dash, never $0', money(null) === '—' && money(undefined) === '—')
t('a real zero is still a zero', money(0) === '$0')
t('privacy mode reaches every figure',
  !/\d/.test(marketCardHtml(facts('HYPE', 'crypto', { volume: 1, oi: 1 }), { prv: () => '•••' })
    .replace(/class="[^"]*"/g, '')        // tb-perf-c and the rest are not figures
    .replace(/&#\d+;/g, '')               // nor is the entity in "Hyperliquid's"
    .replace(/24h|7d|30d|24H|7D|30D|3M|6M|1Y/g, '')))   // nor are the window labels

console.log('\n-- the dex prefix is not part of the name --')
t('a HIP-3 coin is looked up by its ticker', symOf('xyz:NVDA') === 'NVDA')
t('a plain perp is itself', symOf('BTC') === 'BTC')
t('and it is upper-cased, the way the feeds key it', symOf('xyz:nvda') === 'NVDA')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
