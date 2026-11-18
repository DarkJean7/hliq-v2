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

// Numbers: LIVE from Hyperliquid, per account -- `portfolio` (the account value and all-time PnL
// its own portfolio page shows) and `clearinghouseState` (positions, unrealized PnL). They were
// first taken from Hyperliquid's leaderboard stats file, which lags: smartestmoney read value
// $19.68M / PnL +$30.64M on the board while its page said $17.46M / +$28.37M, and "nothing
// matches". Every figure in a row now comes from the same moment, so they add up:
// net = unrealized + realized. serve-prod.js fetches them, paced, at most every few minutes,
// only while someone is looking; knownRow below shapes one, in the Real board's row shape so
// the Real board's renderers draw it.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }

// [key, label, portfolio window]
export const KNOWN_PERIODS = [['d', '24h', 'day'], ['w', '7d', 'week'], ['m', '30d', 'month'], ['a', 'All', 'allTime']]

/**
 * One account's row from its `portfolio` and `clearinghouseState` answers. Null when the
 * portfolio has no all-time point: without it there is no value and no PnL to show, and a row of
 * zeros would read as an empty account.
 */
export function knownRow(addr, portfolio, cs, now = Date.now()) {
  const win = new Map((Array.isArray(portfolio) ? portfolio : []).map(p => [p?.[0], p?.[1] ?? {}]))
  const last = (arr) => (Array.isArray(arr) && arr.length ? num(arr[arr.length - 1]?.[1]) : null)
  const all = win.get('allTime')
  const accountValue = last(all?.accountValueHistory), netPnl = last(all?.pnlHistory)
  if (accountValue == null || netPnl == null) return null
  const open = (cs?.assetPositions ?? []).filter(ap => num(ap?.position?.szi))
  const unrealizedPnl = open.reduce((t, ap) => t + (num(ap.position.unrealizedPnl) ?? 0), 0)
  const positions = open.map(ap => ({ position: {
    coin: ap.position.coin, szi: ap.position.szi, entryPx: ap.position.entryPx,
    positionValue: ap.position.positionValue, unrealizedPnl: ap.position.unrealizedPnl,
    liquidationPx: ap.position.liquidationPx, leverage: ap.position.leverage,
    returnOnEquity: ap.position.returnOnEquity, marginUsed: ap.position.marginUsed,
  } }))
  return {
    addr, accountValue, netPnl, unrealizedPnl,
    // Hyperliquid's PnL is everything since the account began, open positions included; what is
    // not open has been realized -- closed trades, funding and fees together.
    realizedPnl: netPnl - unrealizedPnl,
    periods: Object.fromEntries(KNOWN_PERIODS.map(([k, , w]) => [k, last(win.get(w)?.pnlHistory)])),
    totalVolume: num(all?.vlm) ?? 0,
    positions, openOrders: [], outcomes: [],
    updatedAt: now,
  }
}
