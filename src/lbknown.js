// The leaderboard's Popular board: publicly known entities on Hyperliquid.
//
// Asked for: "a new section similar as real and paper, but for popular accounts ... public known
// entities etc. like idk oracle, smartestmoney" -- and, explicitly, NOT Hyperliquid's own
// leaderboard of self-chosen names.
//
// So this is a curated list. Every entry carries where its attribution comes from, because the
// failure that matters here is a real account under the wrong famous name. Rules for adding one:
//   - a FULL address from a named source (a tracker like Arkham / Lookonchain / Nansen, or
//     reporting that cites one) -- never a truncated 0x1f25…f925 completed by guesswork;
//   - checked against Hyperliquid's own data (it exists, and its history matches the story);
//   - disputed or unconfirmed links say so in `note`. Ownership claimed by trackers is a label,
//     not a fact, and the board says that once at the top.
// Left out on purpose (Nov 2026): Arthur Hayes (wallets disputed, he denied one), AguilaTrades
// (only a truncated address public), qwatio (no address tied to him), onchainmonk (no address
// published anywhere, and no onchainmonk.hl name registered).
//
// A ".hl" name is NOT the trading account. Hyperliquid Names (api.hlnames.xyz) resolves
// smartestmoney.hl and loracle.hl to near-empty wallets, not to the accounts trackers report
// trading under those names, and neither ledger shows a transfer between the two. So those
// rows rest on the tracker's attribution, and their notes say so rather than implying the name
// proves it.
//
// Numbers come from Hyperliquid's public stats feed (a CDN file -- no /info weight); serve-prod.js
// fetches it and keeps only these addresses' rows. Pure functions below, shared with the suite.

export const STATS_URL = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard'

export const KNOWN = [
  { addr: '0x5b5d51203a0f9079f8aeb098a6523a13f298c060', name: 'Abraxas Capital', tag: 'Fund',
    note: 'Wallet 1 of 2. Labelled by Arkham and Nansen.',
    src: 'Arkham', url: 'https://info.arkm.com/research/abraxas-capitals-massive-short' },
  { addr: '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36', name: 'Abraxas Capital', tag: 'Fund',
    note: 'Wallet 2 of 2. Labelled by Nansen.',
    src: 'Arkham', url: 'https://info.arkm.com/research/abraxas-capital-still-shorting-500m-of-crypto' },
  { addr: '0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00', name: 'Wintermute', tag: 'Market maker',
    note: 'Labelled by Lookonchain and Hyperinsight; not confirmed by Wintermute.',
    src: 'crypto.news', url: 'https://crypto.news/wintermutes-hyperliquid-shorts-reach-126m/' },
  { addr: '0xdfc24b077bc1425ad1dea75bcb6f8158e10df303', name: 'HLP', tag: 'Protocol vault',
    note: "Hyperliquidity Provider: Hyperliquid's own market-making and liquidation vault.",
    src: 'Trading Strategy', url: 'https://tradingstrategy.ai/trading-view/vaults/address/0xdfc24b077bc1425ad1dea75bcb6f8158e10df303' },
  { addr: '0x8def9f50456c6c4e37fa5d3d57f108ed23992dae', name: 'Loracle', tag: 'Trader',
    note: 'An early Hyperliquid contributor, known for a large HYPE short. Attributed by trackers; the loracle.hl name itself is on a different wallet.',
    src: 'Bitget News', url: 'https://www.bitget.com/news/detail/12560605717139' },
  { addr: '0x082e843a431aef031264dc232693dd710aedca88', name: 'smartestmoney', tag: 'Trader',
    note: 'Known for a 1.38M HYPE long from $38.68. Labelled by OnchainLens; the smartestmoney.hl name itself is on a different wallet.',
    src: 'KuCoin News', url: 'https://www.kucoin.com/news/flash/smartestmoney-hl-s-1-38m-hype-long-hits-79m-unrealized-profit' },
  { addr: '0x020ca66c30bec2c4fe3861a94e4db4a498a35872', name: 'Machi Big Brother', tag: 'Trader',
    note: 'Jeffrey Huang. Labelled by Arkham and Lookonchain; the account names itself too.',
    src: 'Cointelegraph', url: 'https://cointelegraph.com/news/machi-big-brother-44m-profit-10m-loss' },
  { addr: '0x5078c2fbea2b2ad61bc840bc023e35fce56bedb6', name: 'James Wynn', tag: 'Trader',
    note: 'Tagged by Arkham after his $1.1B BTC long in May 2025.',
    src: 'CoinDesk', url: 'https://www.coindesk.com/markets/2025/05/22/crypto-trader-opens-11b-long-bitcoin-bet-on-hyperliquid-using-40x-leverage' },
  { addr: '0xb317d2bc2d3d2df5fa441b5bae0ab9d8b07283ae', name: '10/10 Whale', tag: 'Trader',
    note: 'The Oct 2025 "insider whale". Linked to Garrett Jin, who says it holds clients\' funds -- disputed.',
    src: 'The Block', url: 'https://www.theblock.co/post/374383/alleged-hyperliquid-whale-denies-trump-ties-thanks-cz-for-doxing-and-pitches-market-stabilization-fund' },
]

// [key, chip label, the feed's window name]
export const PERIODS = [['d', '24h', 'day'], ['w', '7d', 'week'], ['m', '30d', 'month'], ['a', 'All', 'allTime']]

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }

/** One feed row → { v: account value, p/r/x: pnl/roi/volume per period }. */
export function compactStats(row) {
  const w = new Map((row?.windowPerformances ?? []).map(x => [x?.[0], x?.[1] ?? {}]))
  const pick = (f) => Object.fromEntries(PERIODS.map(([k, , win]) => [k, num(w.get(win)?.[f])]))
  return { v: num(row?.accountValue), p: pick('pnl'), r: pick('roi'), x: pick('vlm') }
}

/**
 * The stats of `addrs` out of the whole feed's text (~40 MB, ~48,000 rows) without parsing every
 * row into an object -- this runs on the box that also runs the bots. Rows start with
 * {"ethAddress": "0x…"; only the wanted ones are parsed. Whitespace is not assumed (the feed is
 * pretty-printed today). → { addr: stats } -- an address absent from the feed is absent here,
 * which the board shows as unknown, not as zero.
 */
export function statsFor(text, addrs) {
  const want = new Set([...addrs].map(a => String(a).toLowerCase()))
  const START = /\{\s*"ethAddress"\s*:\s*"(0x[0-9a-fA-F]{40})"/g
  const out = {}
  const end = text.lastIndexOf(']')
  let m = START.exec(text)
  while (m) {
    const i = m.index, a = m[1].toLowerCase()
    const next = START.exec(text)
    if (want.has(a) && !out[a]) {
      try { out[a] = compactStats(JSON.parse(text.slice(i, next ? next.index : end).replace(/[\s,]+$/, ''))) } catch {}
    }
    m = next
  }
  return out
}

/**
 * The board: each known entity with its stats (or null), sorted. sort: 'pnl' | 'roi' over
 * `period`, or 'value'. Unknown numbers sort last, never as zero.
 */
export function knownView(stats, { period = 'a', sort = 'pnl' } = {}) {
  const rows = KNOWN.map(k => ({ ...k, s: stats?.[k.addr] ?? null }))
  const key = sort === 'value' ? (r) => r.s?.v : sort === 'roi' ? (r) => r.s?.r?.[period] : (r) => r.s?.p?.[period]
  return rows.sort((x, y) => (key(y) ?? -Infinity) - (key(x) ?? -Infinity))
}
