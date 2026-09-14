// A market's own rules, and the app finally reading them.
//
// Reported: "make the leverage automatically change based on the asset and set it to the max
// allowed for that asset. for example vvv max leverage is 3x not 10x, if i preview that it does
// lit at 10x even tho its not allowed. make the same apply to margin, by default cross but
// change to isolated if its the only mode allowed for the selected asset. for example in one of
// the images is about openai, the preview shows a mark price of 1,336 which is false since its
// at 1,510 in reality. also the leverage is at 10x which is not allowed and is cross which
// neither is allowed."
//
// Checked against the live metadata while building this, because the numbers matter:
//
//   VVV          maxLeverage 3,  cross allowed,  listed
//   vntl:OPENAI  maxLeverage 3,  onlyIsolated,   DELISTED — and its mid really is 1336.2
//   BTC          maxLeverage 40
//
// So the "wrong" price was Hyperliquid's own: a delisted market keeps quoting its last trade
// forever. Nothing was lying about the number; what was missing was that it is frozen.
import fs from 'fs'
import { assetRules, findUniverse, rulesFor, clampLeverage, marginModeFor, MAX_LEVERAGE_CAP }
  from '../../src/assetrules.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const BOT = fs.readFileSync('strategies/grid.js', 'utf8').replace(/\r\n/g, '\n')

// The three markets above, in the shape allPerpMetas returns.
const METAS = [
  { universe: [{ name: 'BTC', maxLeverage: 40, szDecimals: 5 },
               { name: 'VVV', maxLeverage: 3,  szDecimals: 2 }] },
  { universe: [{ name: 'vntl:OPENAI', maxLeverage: 3, onlyIsolated: true,
                 marginMode: 'strictIsolated', isDelisted: true, szDecimals: 3 }] },
  { universe: [{ name: 'xyz:SPCX', maxLeverage: 20, szDecimals: 2 }] },
]

console.log(nl + '-- what one market allows --')
{
  const vvv = rulesFor(METAS, 'VVV')
  t('VVV tops out at 3x', vvv.maxLeverage === 3 && vvv.known)
  t('and allows cross', vvv.isolatedOnly === false)
  t('and is listed', vvv.delisted === false)

  const oai = rulesFor(METAS, 'vntl:OPENAI')
  t('OPENAI tops out at 3x too', oai.maxLeverage === 3)
  t('but forbids cross', oai.isolatedOnly === true)
  t('and is delisted', oai.delisted === true)

  t('BTC allows 40x', rulesFor(METAS, 'BTC').maxLeverage === 40)
}
{
  // Three spellings of the same constraint; a market only needs to fail one of them.
  t('onlyIsolated forbids cross', assetRules({ onlyIsolated: true }).isolatedOnly)
  t('so does strictIsolated', assetRules({ marginMode: 'strictIsolated' }).isolatedOnly)
  t('and so does noCross', assetRules({ marginMode: 'noCross' }).isolatedOnly)
  t('an ordinary market does not', assetRules({ maxLeverage: 10 }).isolatedOnly === false)
}
{
  // "Not loaded yet" is not "no limit". A caller that cannot tell them apart is how 10x got
  // offered on a 3x market in the first place.
  const unknown = rulesFor(METAS, 'NOPE')
  t('an unknown market says so', unknown.known === false)
  t('and falls back to the exchange cap rather than to a guess', unknown.maxLeverage === MAX_LEVERAGE_CAP)
  t('nothing at all is not a crash', rulesFor(null, null).known === false)
  t('a market with no stated leverage takes the cap',
    assetRules({ name: 'X' }).maxLeverage === MAX_LEVERAGE_CAP)
}

console.log(nl + '-- finding the market, however it was spelled --')
{
  t('a main-dex name', findUniverse(METAS, 'BTC')?.name === 'BTC')
  t('a prefixed HIP-3 name', findUniverse(METAS, 'vntl:OPENAI')?.name === 'vntl:OPENAI')
  t('case does not matter', findUniverse(METAS, 'vvv')?.name === 'VVV')
  // A market typed with its prefix still resolves if only the bare name is in the meta, but
  // never the other way round: a bare "OPENAI" must not silently become a delisted vntl market.
  t('a prefixed ask falls back to the bare name',
    findUniverse([{ universe: [{ name: 'OPENAI', maxLeverage: 5 }] }], 'vntl:OPENAI')?.maxLeverage === 5)
  t('a bare ask does not match a prefixed market', findUniverse(METAS, 'OPENAI') === null)
  // And an exact match anywhere beats a bare match somewhere else.
  const both = [{ universe: [{ name: 'OPENAI', maxLeverage: 5 }] },
                { universe: [{ name: 'vntl:OPENAI', maxLeverage: 3 }] }]
  t('an exact match wins over a bare one on another dex',
    findUniverse(both, 'vntl:OPENAI')?.maxLeverage === 3)
}

console.log(nl + '-- the leverage the market will actually accept --')
{
  t('10x on a 3x market becomes 3x', clampLeverage(10, 3) === 3)
  t('10x on a 40x market stays 10x', clampLeverage(10, 40) === 10)
  // A blank box means "whatever this market allows" — which is what makes one default correct
  // for every asset without the form knowing anything about assets.
  t('blank means the maximum', clampLeverage('', 3) === 3 && clampLeverage(null, 40) === 40)
  t('and so does nonsense', clampLeverage('abc', 3) === 3)
  t('below 1x is not a leverage', clampLeverage(0, 3) === 3 && clampLeverage(-5, 3) === 3)
  t('fractions are floored, not rounded up', clampLeverage(2.9, 3) === 2)
  t('an unknown maximum falls back to the cap', clampLeverage(999, undefined) === MAX_LEVERAGE_CAP)
}

console.log(nl + '-- and the margin mode it will accept --')
{
  const iso = { isolatedOnly: true }, free = { isolatedOnly: false }
  t('cross stays cross where cross is allowed', marginModeFor('cross', free) === 'cross')
  t('isolated stays isolated', marginModeFor('isolated', free) === 'isolated')
  t('cross becomes isolated where cross is refused', marginModeFor('cross', iso) === 'isolated')
  t('and a market with unknown rules is left alone', marginModeFor('cross', null) === 'cross')
}

console.log(nl + '-- the form offers only what the market allows --')
{
  t('the rules are applied when the coin changes', CLI.includes('_applyGridAssetRules(coin, coinId.startsWith(\'m-\'))'))
  // Placeholder, not value: an empty box still means "this market's maximum", which stays true
  // when the coin changes.
  t('the leverage box advertises the maximum', CLI.includes('levEl.placeholder = String(r.maxLeverage)'))
  t('a number already typed above it is pulled down',
    CLI.includes('if (Number.isFinite(typed) && typed > r.maxLeverage) levEl.value = String(r.maxLeverage)'))
  t('an isolated-only market flips the toggle', CLI.includes("if (r.isolatedOnly && _gridMargin !== 'isolated')"))
  t('and locks it, because a toggle offering a refused mode is not a choice',
    CLI.includes('el.disabled = r.isolatedOnly'))
  t('a delisted market says so, in red', CLI.includes('is delisted on Hyperliquid'))
  t('why a frozen price looks wrong is written down',
    fs.readFileSync('src/assetrules.js', 'utf8').includes('keeps its last mid forever'))
}

console.log(nl + '-- and every launch path sends what the market allows --')
{
  // Three of them: the desktop command string, the desktop arg array, the mobile arg array.
  t('nothing defaults to a flat 10x any more',
    !CLI.includes("get('grid-leverage') || '10'") && !CLI.includes("get('m-grid-leverage') || '10'"))
  t('all three clamp', (CLI.match(/clampLeverage\(get\('m?-?grid-leverage'\)/g) ?? []).length === 3,
    (CLI.match(/clampLeverage\(get\('m?-?grid-leverage'\)/g) ?? []).length)
  t('and all three decide the margin mode from the market',
    (CLI.match(/marginModeFor\(_gridMargin, /g) ?? []).length === 3)
}

console.log(nl + '-- the bot holds the line too --')
{
  // The UI clamps, but the bot places the orders and its args outlive the form: a saved config,
  // a hand-edited command, an asset whose maximum was lowered since.
  t('the bot clamps before anything is sized', BOT.includes('await applyAssetLimits()'))
  t('which means leverage can be reassigned', /let\s+LEVERAGE\s+= parseInt\(args\.leverage\)/.test(BOT))
  t('and so can the margin mode', /let\s+IS_ISOLATED\s+=/.test(BOT))
  t('it keeps the universe entry it used to throw away', BOT.includes('szDecimals: u.szDecimals ?? 6, u }'))
  t('a delisted market stops the run rather than being clamped', BOT.includes('if (u.isDelisted)'))
  t('and a plan says why, instead of returning a ladder', /PLAN_ONLY.*ok: false/.test(BOT))
  // updateLeverage throwing used to be a logged warning the run carried straight past.
  t('why the warning was not enough is written down', BOT.includes('carried straight past'))
}

console.log(nl + '-- a delisted market is not a market you can pick --')
{
  // Reported: "strats is missing the new openai perps market deployed by io. also the trade tab
  // is showing the delisted version and not the new io one. also from watch tab. why we have
  // that old one when even hyperliquid does not show it."
  //
  // Two separate causes, both confirmed against the live API:
  //   1. `vntl:OPENAI` is delisted, and Hyperliquid KEEPS QUOTING IT — allMids still answers
  //      1336.2 — so every list built from prices showed it as though it were live.
  //   2. The new market is named `io:OAI`. HL's own UI shows it as OPENAI-USDC, so searching
  //      "openai" matched the dead market and nothing else.
  const { delistedNames } = await import('../../src/assetrules.js')
  const set = delistedNames(METAS)
  t('the delisted ones are collected', set.has('vntl:openai'))
  t('and the live ones are not', !set.has('vvv') && !set.has('btc'))
  t('lowercased, so a lookup does not depend on spelling', set.has('vntl:openai') && !set.has('vntl:OPENAI'))
  t('no metas is an empty set, not a crash', delistedNames(null).size === 0)
  // Rebuilt on every keystroke otherwise: eleven universes per search box.
  t('the answer is cached against the metas it came from', delistedNames(METAS) === set)

  t('every picker filters them out',
    (CLI.match(/_isDelistedMkt\(/g) ?? []).length >= 6, (CLI.match(/_isDelistedMkt\(/g) ?? []).length)
  // A position still open in a delisted market must still price and still show.
  t('but a position you hold is not hidden', CLI.includes('hiding a position someone holds is worse'))
}
{
  // The alias is what makes the live market reachable by the only name anyone has seen.
  t('OAI is shown as OPENAI', CLI.includes("'OAI': 'OPENAI'"))
  t('searches match the shown name as well as the stored one',
    (CLI.match(/_mktDisplay\(c(?:oin)?\) \?\? ''\)\.to(?:Lower|Upper)Case\(\)\.(?:includes|startsWith)\(/g) ?? []).length >= 3)
  t('and rows read as the shown name', CLI.includes('_mktDisplay(coin) ?? coin'))
  // Typing OPENAI used to resolve to the dead market before the alias was ever consulted.
  t('resolving a typed name skips delisted markets first',
    CLI.includes('const live = (k) => !_isDelistedMkt(k)') &&
    /const hit = Object\.keys\(state\.allMids \|\| \{\}\)[\s\S]{0,200}&& live\(k\)\)/.test(CLI))
  t('and the alias path skips them too', /aliasHit[\s\S]{0,160}&& live\(k\)\)/.test(CLI))
  t('why the alias exists is written down', CLI.includes('the market exists, under a name they'))
}

console.log(nl + '-- a hidden leaderboard row looks hidden, in BOTH shells --')
{
  // The server withholds these from the public board entirely; a PIN holder gets them back so
  // they can be un-hidden, and the row it drew was identical to a public one.
  const CSS = fs.readFileSync('src/style.css', 'utf8')
  t('the desktop row is marked', CLI.includes("isHidden ? ' lb-row-hidden' : ''"))
  t('and carries a chip saying so', CLI.includes('class="lb-hidden-chip"'))
  t('which is dimmed', /\.lb-row-hidden > td \{[^}]*opacity/.test(CSS))
  t('why it is shown at all is written down', CLI.includes('so it can be un-hidden'))

  // Asked straight out: "are they also hidden in mobile?" They were — the server does the
  // withholding and does not care which shell asked — but the mobile row said nothing, which
  // is indistinguishable from the hiding having failed.
  t('the mobile row is marked too', CLI.includes("isHidden ? ' lb-row-hidden-m' : ''"))
  t('with the same chip', /lb-row-hidden-m[\s\S]{0,400}lb-hidden-chip/.test(CLI))
  t('dimmed as a row, since the mobile board is not a table',
    /\.lb-row-hidden-m \{[^}]*opacity/.test(CSS))
  // A chip describing a state you cannot change from the device you are holding is half an
  // answer: hiding was dev-only AND desktop-only.
  t('and a PIN holder can unhide from the phone', CLI.includes("window.__lbToggleHide('${esc(r.addr)}'"))
  t('next to Remove, not instead of it',
    /hideBtn[\s\S]{0,400}Remove from leaderboard/.test(CLI))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
