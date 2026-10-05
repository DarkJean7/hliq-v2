/**
 * Categories for the /markets page — three layers, and a market can carry several tags:
 *
 *   1. Hyperliquid's own (perpCategories): stocks, indices, commodities, fx, rates, preipo,
 *      crypto. Only HIP-3 dexes report one; a main-dex perp is crypto. Commodities are split
 *      into metals and energy by ticker, the same split the app's market list makes.
 *   2. DefiLlama's protocol category, for tokens with revenue (src/llama.js): Launchpad,
 *      Dexs, Derivatives, Trading App… — the "Category" column of DefiLlama's own table.
 *   3. Ours (CURATED below): AI, memes, L1, L2, tech, semiconductors, crypto stocks… — what
 *      neither source says. Edit the lists to add a coin or a whole sector; the page builds
 *      its filter chips from SECTORS, so nothing else needs to change.
 *
 * Curated crypto sectors apply to crypto markets only, and stock sectors to markets that
 * Hyperliquid itself calls stocks: a community spot token named "NVDA" is not Nvidia.
 */

/** Every sector the page can filter by, in display order within each group. */
export const SECTORS = [
  // ── Crypto ──
  { key: 'l1',          label: 'Layer 1',          group: 'crypto' },
  { key: 'l2',          label: 'Layer 2',          group: 'crypto' },
  { key: 'defi',        label: 'DeFi',             group: 'crypto' },
  { key: 'dex',         label: 'DEX',              group: 'crypto' },
  { key: 'derivatives', label: 'Derivatives',      group: 'crypto' },
  { key: 'lending',     label: 'Lending',          group: 'crypto' },
  { key: 'launchpad',   label: 'Launchpad',        group: 'crypto' },
  { key: 'tradingapp',  label: 'Trading app',      group: 'crypto' },
  { key: 'ai',          label: 'AI',               group: 'both' },
  { key: 'memes',       label: 'Memes',            group: 'crypto' },
  { key: 'infra',       label: 'Infra & oracles',  group: 'crypto' },
  { key: 'gaming',      label: 'Gaming',           group: 'crypto' },
  { key: 'rwa',         label: 'RWA',              group: 'crypto' },
  { key: 'privacy',     label: 'Privacy',          group: 'crypto' },
  { key: 'prediction',  label: 'Prediction',       group: 'crypto' },
  { key: 'stables',     label: 'Stablecoins',      group: 'crypto' },
  { key: 'hlnative',    label: 'Hyperliquid-native', group: 'crypto' },
  // ── TradFi ──
  { key: 'stocks',      label: 'Stocks',           group: 'tradfi' },
  { key: 'tech',        label: 'Tech',             group: 'tradfi' },
  { key: 'semis',       label: 'Semiconductors',   group: 'tradfi' },
  { key: 'cryptostocks', label: 'Crypto stocks',   group: 'tradfi' },
  { key: 'preipo',      label: 'Pre-IPO',          group: 'tradfi' },
  { key: 'indices',     label: 'Indices',          group: 'tradfi' },
  { key: 'metals',      label: 'Metals',           group: 'tradfi' },
  { key: 'energy',      label: 'Energy',           group: 'tradfi' },
  { key: 'commodities', label: 'Commodities',      group: 'tradfi' },
  { key: 'fx',          label: 'FX',               group: 'tradfi' },
  { key: 'rates',       label: 'Rates',            group: 'tradfi' },
]
export const SECTOR_LABEL = Object.fromEntries(SECTORS.map(s => [s.key, s.label]))

/** Our own lists, by TICKER as Hyperliquid shows it (k-prefixed perps included). */
export const CURATED = {
  l1:      ['BTC', 'ETH', 'SOL', 'AVAX', 'SUI', 'APT', 'SEI', 'NEAR', 'ADA', 'DOT', 'ATOM', 'TON', 'TRX', 'XRP', 'BNB', 'LTC', 'BCH', 'HYPE', 'BERA', 'INJ', 'TIA', 'ALGO', 'HBAR', 'XLM', 'ETC', 'KAS', 'S', 'ICP', 'FTM', 'EGLD', 'MINA', 'MON', 'MEGA'],
  l2:      ['ARB', 'OP', 'STRK', 'MNT', 'ZK', 'IMX', 'POL', 'MATIC', 'BLAST', 'MANTA', 'SCR', 'METIS', 'TAIKO', 'LINEA', 'ZORA'],
  defi:    ['UNI', 'AAVE', 'MKR', 'SKY', 'CRV', 'COMP', 'SNX', 'LDO', 'PENDLE', 'ENA', 'ETHFI', 'EIGEN', 'MORPHO', 'JUP', 'RAY', 'CAKE', 'AERO', 'SUSHI', 'DYDX', 'GMX', '1INCH', 'BAL', 'YFI', 'KMNO', 'SYRUP', 'RESOLV', 'USUAL', 'FXS', 'CVX', 'JTO', 'ORCA', 'DRIFT', 'AVNT', 'LIT'],
  dex:     ['UNI', 'CAKE', 'RAY', 'AERO', 'SUSHI', 'CRV', 'ORCA', 'JUP', '1INCH', 'BAL'],
  derivatives: ['HYPE', 'DYDX', 'GMX', 'DRIFT', 'AVNT', 'LIT', 'APEX', 'ASTER'],
  lending: ['AAVE', 'COMP', 'MORPHO', 'KMNO', 'SYRUP'],
  launchpad: ['PUMP'],
  ai:      ['TAO', 'FET', 'RENDER', 'VIRTUAL', 'AI16Z', 'AIXBT', 'WLD', 'ARKM', 'GRIFFAIN', 'ZEREBRO', 'IO', 'KAITO', 'AR', 'GRASS', 'PROMPT', 'ACT'],
  // Stocks and private companies whose business is AI — tagged 'ai' too, but ONLY where
  // Hyperliquid says stocks or pre-IPO: a community spot token called "NVDA" is not Nvidia.
  aiStocks: ['NVDA', 'AMD', 'PLTR', 'SMCI', 'OAI', 'ANTH', 'XAI', 'CRWV', 'NBIS', 'ARM'],
  memes:   ['DOGE', 'kPEPE', 'kBONK', 'kSHIB', 'kFLOKI', 'kNEIRO', 'WIF', 'POPCAT', 'FARTCOIN', 'PENGU', 'TRUMP', 'MELANIA', 'MEW', 'BRETT', 'MOODENG', 'PNUT', 'GOAT', 'CHILLGUY', 'TURBO', 'SPX', 'PURR', 'BOME', 'MOG', 'kLUNC', 'POPCAT', 'HMSTR', 'DOOD', 'ANIME', 'FARTBOY'],
  infra:   ['LINK', 'PYTH', 'API3', 'W', 'ZRO', 'AXL', 'GRT', 'FIL', 'STX', 'ENS', 'TRB', 'UMA', 'EIGEN', 'ONDO'],
  gaming:  ['IMX', 'GALA', 'SAND', 'MANA', 'AXS', 'BIGTIME', 'YGG', 'ILV', 'APE', 'PIXEL', 'SUPER', 'BEAMX', 'MAVIA', 'NOT'],
  rwa:     ['ONDO', 'PAXG', 'XAUT', 'XAUT0', 'OM', 'CFG', 'PLUME', 'POLYX'],
  privacy: ['ZEC', 'XMR', 'DASH', 'ZEN', 'ROSE'],
  prediction: ['POLY'],
  stables: ['USDC', 'USDT0', 'USDH', 'USDE', 'FEUSD', 'USDHL'],
  hlnative: ['HYPE', 'PURR', 'HFUN', 'JEFF', 'PIP', 'CATBAL', 'KHYPE', 'LHYPE', 'STHYPE'],
  // ── stocks (applied only where Hyperliquid itself says "stocks") ──
  tech:    ['AAPL', 'MSFT', 'GOOGL', 'GOOG', 'AMZN', 'META', 'NVDA', 'TSLA', 'AMD', 'NFLX', 'ORCL', 'PLTR', 'INTC', 'MU', 'AVGO', 'CRWV', 'SNDK', 'IONQ', 'NBIS', 'TCNT', 'BABA', 'UBER', 'SHOP', 'CRM', 'ADBE', 'SMCI', 'ARM', 'TSM', 'QCOM', 'DELL', 'IBM', 'SNOW', 'SPOT', 'RDDT', 'GPRO', 'SKHX', 'DRAM'],
  semis:   ['NVDA', 'AMD', 'INTC', 'MU', 'AVGO', 'TSM', 'SMCI', 'SNDK', 'ARM', 'QCOM', 'SKHX', 'DRAM', 'ASML'],
  cryptostocks: ['COIN', 'HOOD', 'MSTR', 'CRCL', 'BMNR', 'MARA', 'RIOT', 'GLXY', 'CIFR', 'SBET', 'BLSH', 'GEMI'],
}

/** Commodities sub-split, by ticker — HL calls all of them "commodities". */
export const METALS = new Set(['GOLD', 'SILVER', 'PALLADIUM', 'PLATINUM', 'COPPER', 'GOLDJM', 'SILVERJM', 'GLDMINE', 'ALUMINIUM', 'ALUMINUM'])
export const ENERGY = new Set(['OIL', 'GAS', 'NATGAS', 'USOIL', 'WTI', 'BRENTOIL', 'CL', 'USENERGY', 'URANIUM', 'URNM'])

const CRYPTO_ONLY = new Set(['l1', 'l2', 'defi', 'dex', 'derivatives', 'lending', 'launchpad', 'memes', 'infra', 'gaming', 'rwa', 'privacy', 'prediction', 'stables', 'hlnative'])
const STOCK_ONLY  = new Set(['tech', 'semis', 'cryptostocks'])
/** Curated list keys that tag under another name. */
const TAG_OF = { aiStocks: 'ai' }
const MEMBERS = new Map()
for (const [k, list] of Object.entries(CURATED)) for (const s of list) {
  if (!MEMBERS.has(s)) MEMBERS.set(s, new Set())
  MEMBERS.get(s).add(k)
}

/** HL's category strings are case- and form-inconsistent ('FX'/'fx', 'stock'/'stocks'). */
export function normHlCat(c) {
  const s = String(c ?? '').trim().toLowerCase()
  if (!s) return null
  if (s === 'stock') return 'stocks'
  return ['crypto', 'stocks', 'commodities', 'indices', 'fx', 'rates', 'preipo', 'metals', 'energy'].includes(s) ? s : null
}

/** DefiLlama category → our sector keys. Unlisted categories add nothing. */
export const LLAMA_TO_SECTOR = {
  'Dexs': ['defi', 'dex'], 'DEX Aggregator': ['defi', 'dex'],
  'Derivatives': ['defi', 'derivatives'], 'Options': ['defi', 'derivatives'], 'Basis Trading': ['defi'],
  'Lending': ['defi', 'lending'], 'CDP': ['defi', 'lending'],
  'Launchpad': ['launchpad'], 'Trading App': ['tradingapp'], 'Telegram Bot': ['tradingapp'], 'Interface': ['tradingapp'],
  'Liquid Staking': ['defi'], 'Liquid Restaking': ['defi'], 'Yield': ['defi'], 'Yield Aggregator': ['defi'], 'Restaking': ['defi'],
  'AI Agents': ['ai'], 'Chain': ['l1'], 'RWA': ['rwa'], 'Stablecoin Issuer': ['stables'],
  'Prediction Market': ['prediction'], 'Gaming': ['gaming'], 'Oracle': ['infra'], 'Bridge': ['infra'], 'Cross Chain Bridge': ['infra'],
  'Privacy': ['privacy'],
}

/**
 * A row's group ('crypto' | 'tradfi'), its Hyperliquid category, and every sector it is in.
 * `hlCat` is what Hyperliquid said for this market (null when it said nothing); `llamaCat`
 * the DefiLlama category of its token, when it has revenue.
 */
export function classify({ sym, hlCat = null, llamaCat = null }) {
  const cat = normHlCat(hlCat)
  const tradfi = !!cat && cat !== 'crypto'
  const tags = new Set()
  if (tradfi) {
    if (cat === 'commodities') tags.add(METALS.has(sym) ? 'metals' : ENERGY.has(sym) ? 'energy' : 'commodities')
    else tags.add(cat)
  }
  for (const k of (MEMBERS.get(sym) ?? [])) {
    if (CRYPTO_ONLY.has(k) && tradfi) continue
    if (STOCK_ONLY.has(k) && cat !== 'stocks') continue
    if (k === 'ai' && tradfi) continue                                       // crypto AI tokens
    if (k === 'aiStocks' && cat !== 'stocks' && cat !== 'preipo') continue   // AI companies
    tags.add(TAG_OF[k] ?? k)
  }
  if (!tradfi) for (const k of (LLAMA_TO_SECTOR[llamaCat] ?? [])) tags.add(k)
  return { group: tradfi ? 'tradfi' : 'crypto', hlCat: cat ?? (tradfi ? null : 'crypto'), tags: [...tags] }
}
