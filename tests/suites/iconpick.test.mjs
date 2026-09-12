// The wrong company's logo on a market.
//
// Reported: "nvda has robinhood icon". The card for "Will NVDA be above $218.33" drew
// Robinhood's mark, and the reason is a name collision the icon cache had no defence against:
// CoinGecko's top-1000 lists a token whose SYMBOL is `nvda` — "NVIDIA • Robinhood Token", a
// tokenized wrapper — and its artwork is the issuer's, not NVIDIA's.
//
// The client was already asking correctly: for `xyz:NVDA` it ranks Hyperliquid's own artwork
// first and TradingView's NVIDIA logo second. The server fetched the right one, stored it, and
// then its UPGRADE rule — "a CoinGecko candidate exists and what we hold is not from
// CoinGecko" — replaced it with the wrapper. That rule ignored the one thing only the client
// knows: `cands` arrives in priority order.
import fs from 'fs'
import { coinGeckoUpgrade } from '../../src/iconpick.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const HL_NVDA  = 'https://app.hyperliquid.xyz/coins/xyz%3ANVDA.svg'
const TV_NVDA  = 'https://s3-symbol-logo.tradingview.com/nvidia--big.svg'
const CG_WRAP  = 'https://coin-images.coingecko.com/coins/images/102174110/small/0xd06.png'
const HL_BTC   = 'https://app.hyperliquid.xyz/coins/BTC.svg'
const CG_BTC   = 'https://coin-images.coingecko.com/coins/images/1/small/bitcoin.png'

console.log(nl + '-- the upgrade this rule exists for still happens --')
{
  // A coin first requested before the client's CoinGecko map had loaded gets cached from HL's
  // fallback artwork and would otherwise stay there forever.
  t('CoinGecko ranked above what we hold is an upgrade',
    coinGeckoUpgrade([CG_BTC, HL_BTC], HL_BTC) === CG_BTC)
  t('and the URL returned is the one the client offered',
    coinGeckoUpgrade(['x', CG_BTC, HL_BTC], HL_BTC) === CG_BTC)
  // Nothing to upgrade to, or nothing to upgrade from.
  t('already CoinGecko: nothing to do', coinGeckoUpgrade([CG_BTC, HL_BTC], CG_BTC) === null)
  t('no CoinGecko candidate at all', coinGeckoUpgrade([HL_BTC, TV_NVDA], HL_BTC) === null)
  t('an empty list is not a crash', coinGeckoUpgrade([], HL_BTC) === null)
  t('no list at all is not a crash', coinGeckoUpgrade(undefined, HL_BTC) === null)
}

console.log(nl + '-- THE BUG: a ranking the client set on purpose --')
{
  // This is the NVDA list, in the order the client sends it. CoinGecko is third BECAUSE its
  // entry for this ticker is a wrapper token. Promoting it is a downgrade.
  const cands = [HL_NVDA, TV_NVDA, CG_WRAP]
  t('CoinGecko ranked BELOW what we hold is not an upgrade',
    coinGeckoUpgrade(cands, HL_NVDA) === null, coinGeckoUpgrade(cands, HL_NVDA))
  t('nor when we hold the second choice',
    coinGeckoUpgrade(cands, TV_NVDA) === null)
  // The old rule was presence-only. Spelled out so this cannot quietly come back.
  t('presence alone would have swapped it — that is the reported bug',
    cands.some(u => u.includes('coingecko')) && !HL_NVDA.includes('coingecko'))
}

console.log(nl + '-- a source the client no longer offers ranks last --')
{
  // Cached under an older resolution: the current list is the better authority, so CoinGecko
  // wins over a URL nothing offers any more.
  t('an unoffered stored source loses to CoinGecko',
    coinGeckoUpgrade([CG_BTC, HL_BTC], 'https://example.invalid/old.png') === CG_BTC)
  t('and so does a missing one', coinGeckoUpgrade([CG_BTC, HL_BTC], null) === CG_BTC)
  t('but only if CoinGecko is actually offered',
    coinGeckoUpgrade([HL_BTC], 'https://example.invalid/old.png') === null)
}

console.log(nl + '-- and the server uses it, once, where it used to decide for itself --')
{
  const SRV = fs.readFileSync('serve-prod.js', 'utf8').replace(/\r\n/g, '\n')
  t('serve-prod imports the rule', SRV.includes("from './src/iconpick.js'"))
  t('and calls it', SRV.includes('const cgCand = coinGeckoUpgrade(cands, meta.src)'))
  // The old presence-only test must be gone, not merely bypassed.
  t('the presence-only test is gone',
    !/cands\.find\(u => u\.includes\('coingecko'\)\)/.test(SRV))

  // Half the fix is reaching the entry that is ALREADY wrong on disk. The cache is keyed by
  // coin alone, so a poisoned NVDA would have been served forever no matter what the client
  // asked for next.
  t('each cached icon records the resolution generation that chose it',
    SRV.includes('src: r.src, v: iconVer'))
  t('the client generation is read off the request', SRV.includes("query.match(/(?:^|&)v=(\\d{1,4})(?:&|$)/)"))
  t('an entry from an older generation is re-probed',
    SRV.includes('const staleGen = String(meta.v ?? \'\') !== String(iconVer)') &&
    SRV.includes('if (meta.miss || staleGen) {'))
  // A miss that is not stamped reads as stale on every request, which would re-probe four
  // external CDNs for a logo-less coin forever.
  t('a miss is stamped too', SRV.includes('miss: true, at: Date.now(), v: iconVer'))
}

console.log(nl + '-- the client stops offering the wrapper at all --')
{
  const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  // Belt and braces: with the ranking fixed, CoinGecko is only reached if HL and TradingView
  // both fail — and for a ticker we have curated real-world artwork for, its answer is a
  // wrapper's logo. A letter avatar is a better answer than the wrong company.
  t('a HIP-3 market with a curated logo does not offer CoinGecko',
    CLI.includes('tvLogo, tvLogo ? null : _cgIconMap?.[sym]'))
  t('and one without it still does',
    /const tvLogo = _tradFiIconUrl\(sym\)/.test(CLI))
  // Bumping this is what makes the server re-probe every icon chosen by the old logic.
  t('the icon generation was bumped past the poisoned one',
    parseInt((CLI.match(/const _ICON_V = '(\d+)'/) || [])[1] ?? '0') >= 5)
  t('and its comment says the server honours it now',
    CLI.includes("It reaches the SERVER's disk cache too"))
  t('why is written down where the rule lives',
    fs.readFileSync('src/iconpick.js', 'utf8').includes('NVIDIA • Robinhood Token'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
