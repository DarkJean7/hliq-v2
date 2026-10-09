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
  { key: 'financials',  label: 'Financials',       group: 'tradfi' },
  { key: 'healthcare',  label: 'Healthcare',       group: 'tradfi' },
  { key: 'consumer',    label: 'Consumer',         group: 'tradfi' },
  { key: 'media',       label: 'Telecom & media',  group: 'tradfi' },
  { key: 'industrials', label: 'Industrials',      group: 'tradfi' },
  { key: 'aerospace',   label: 'Aerospace & defense', group: 'tradfi' },
  { key: 'autos',       label: 'Autos',            group: 'tradfi' },
  { key: 'utilities',   label: 'Utilities',        group: 'tradfi' },
  { key: 'materials',   label: 'Materials & mining', group: 'tradfi' },
  { key: 'etf',         label: 'ETFs',             group: 'tradfi' },
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
  semis:   ['NVDA', 'AMD', 'INTC', 'MU', 'AVGO', 'TSM', 'SMCI', 'SNDK', 'ARM', 'QCOM', 'SKHX', 'DRAM', 'ASML',
            // chip-equipment makers, which the SEC files as industrial machinery or instruments
            'LRCX', 'AMAT', 'KLAC', 'TER',
            // memory and chips from companies that do not file with the SEC
            'SMSN', 'KIOXIA', 'CXMT', 'GIGADEV', 'IBIDEN', 'SKHY',
            // semiconductor ETFs
            'SMH', 'SOXL'],
  cryptostocks: ['COIN', 'HOOD', 'MSTR', 'CRCL', 'BMNR', 'MARA', 'RIOT', 'GLXY', 'CIFR', 'SBET', 'BLSH', 'GEMI', 'IREN', 'STRC'],
  // ── stocks the SEC has no industry code for (not SEC filers), and ETFs by theme ──
  stockTech:   ['TCNT', 'TENCENT', 'XIAOMI', 'SOFTBANK', 'MINIMAX', 'ZHIPU', 'IGV', 'MAGS'],
  stockConsumer: ['SHEIN', 'BABA', 'MELI', 'EBAY'],
  stockAutos:  ['HYUNDAI'],
  stockIndustrials: ['UNITREE'],
  stockEnergy: ['XLE'],
  stockHealth: ['XBI'],
  stockMaterials: ['GDX', 'URNM'],
  stockRates:  ['TLT', 'USBOND'],
  etf:     ['SMH', 'SOXL', 'XLE', 'XBI', 'GDX', 'URNM', 'IGV', 'MAGS', 'TLT', 'USBOND', 'EWJ', 'EWT', 'EWY', 'EWZ', 'KORU'],
}

/** Commodities sub-split, by ticker — HL calls all of them "commodities". */
export const METALS = new Set(['GOLD', 'SILVER', 'PALLADIUM', 'PLATINUM', 'COPPER', 'GOLDJM', 'SILVERJM', 'GLDMINE', 'ALUMINIUM', 'ALUMINUM'])
// HO is heating oil — Hyperliquid shows xyz:HO as DIESEL.
export const ENERGY = new Set(['OIL', 'GAS', 'NATGAS', 'USOIL', 'WTI', 'BRENTOIL', 'CL', 'HO', 'DIESEL', 'USENERGY', 'URANIUM', 'URNM'])

const CRYPTO_ONLY = new Set(['l1', 'l2', 'defi', 'dex', 'derivatives', 'lending', 'launchpad', 'memes', 'infra', 'gaming', 'rwa', 'privacy', 'prediction', 'stables', 'hlnative'])
const STOCK_ONLY  = new Set(['tech', 'semis', 'cryptostocks', 'stockTech', 'stockConsumer', 'stockAutos', 'stockIndustrials', 'stockEnergy', 'stockHealth', 'stockMaterials', 'stockRates', 'etf'])
/** Curated list keys that tag under another name. */
const TAG_OF = { aiStocks: 'ai', stockTech: 'tech', stockConsumer: 'consumer', stockAutos: 'autos', stockIndustrials: 'industrials',
                 stockEnergy: 'energy', stockHealth: 'healthcare', stockMaterials: 'materials', stockRates: 'rates' }

/**
 * A company's SEC industry code (SIC, from its filings) → our sectors. This covers every
 * SEC-filing stock without a hand-written list: Chevron 2911 petroleum refining is energy,
 * Costco 5331 variety stores is consumer, Eli Lilly 2834 is healthcare. Ranges follow the
 * SEC's own divisions; only those with a clear meaning are mapped, the rest add nothing.
 */
export function sicSectors(sic) {
  const c = Number(sic)
  if (!Number.isFinite(c) || c <= 0) return []
  const within = (a, b) => c >= a && c <= b
  if (c === 3674) return ['semis', 'tech']
  if (within(3570, 3579) || c === 3672 || within(3660, 3669) || within(7370, 7379) || c === 3825 || c === 3827 || c === 3861) return ['tech']
  if (within(3711, 3716)) return ['autos']
  if (within(3720, 3729) || within(3760, 3769) || c === 3812) return ['aerospace', 'industrials']
  if (within(1300, 1399) || within(2900, 2999) || within(5170, 5172) || within(4920, 4925)) return ['energy']
  if (within(4900, 4919) || within(4926, 4999)) return ['utilities']
  if (within(1000, 1099) || within(1400, 1499) || within(2800, 2829) || within(3300, 3356) || within(2600, 2699)) return ['materials']
  if (within(2830, 2836) || within(3840, 3851) || within(8000, 8099) || c === 5122) return ['healthcare']
  if (within(6000, 6799)) return ['financials']
  if (within(4800, 4899) || within(7800, 7849) || within(2700, 2799)) return ['media']
  if (within(5200, 5999) || within(2000, 2199) || within(2300, 2399) || within(7000, 7099) || within(7900, 7999)) return ['consumer']
  if (within(3357, 3569) || within(3580, 3599) || within(3600, 3659) || within(4000, 4799) || within(8700, 8799)) return ['industrials']
  return []
}
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
export function classify({ sym, hlCat = null, llamaCat = null, sic = null }) {
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
  // A stock's industry, from the SEC's code for the company.
  if (cat === 'stocks') for (const k of sicSectors(sic)) tags.add(k)
  return { group: tradfi ? 'tradfi' : 'crypto', hlCat: cat ?? (tradfi ? null : 'crypto'), tags: [...tags] }
}
