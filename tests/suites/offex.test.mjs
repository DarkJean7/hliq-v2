// Off-exchange holdings: tokens held outside Hyperliquid, typed in by amount, priced live.
//
// The failure modes worth a test are the quiet ones. A holding saved under the combined
// view's '__all_accounts__' key that nothing ever reads back. A price taken from a thin pool
// three times away from the real one. A token GeckoTerminal does not know, printed as $0 —
// "worthless" — instead of a dash. A manual number leaking into account equity, which is the
// one figure in the app that matches Hyperliquid to the cent.
import fs from 'fs'
import { isTokenAddr, normAddr, gtMultiUrl, parseGtToken, parseGtMulti, THIN_LIQUIDITY_USD, storageKey, cleanEntry, loadHoldings, saveHoldings, upsertHolding, removeHolding, holdingValue, holdingsTotal, MAX_PER_REQUEST, dsMultiUrl, parseDsPairs, pickDeepest, mergeQuotes, fetchQuotes, NETWORKS, DEFAULT_NET, normNet, quoteKey, dsFindUrl, pickNetwork, HL_NET } from '../../src/offex.js'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b) => Math.abs(a - b) < 1e-9

const NEST   = '0x07c57e32a3c29d5659bda1d3efc2e7bf004e3035'
const EAGLE  = '0xe99509927aa0dc328e7ab5058cd24be1b2a5f280'
const SIGNAL = '0xf09703969cf55aa8a05ee9c76ab3013477283666'
const ME     = '0xaa7ad5fa4d99d9bf3397232df7f4523853538159'

console.log(nl + '-- addresses --')
{
  t('a contract address is one', isTokenAddr(NEST))
  t('mixed case is the same token', normAddr(NEST.toUpperCase().replace('0X', '0x')) === NEST)
  t('a symbol is not an address', !isTokenAddr('NEST'))
  t('nor is a short hex string', !isTokenAddr('0x1234'))
  t('whitespace from a paste is forgiven', normAddr('  ' + NEST + '\n') === NEST)
}

console.log(nl + '-- the price URL cannot be pointed anywhere else --')
{
  const u = gtMultiUrl([NEST, EAGLE, SIGNAL])
  t('it names GeckoTerminal\'s HyperEVM token endpoint', u.startsWith('https://api.geckoterminal.com/api/v2/networks/hyperevm/tokens/multi/'))
  t('with every token in one call', u.endsWith([NEST, EAGLE, SIGNAL].join(',')))
  // The browser names addresses, never URLs. Anything that is not 0x-hex is dropped before it
  // gets near the path, so the server route cannot be used as an open proxy.
  t('junk is dropped', gtMultiUrl(['../../evil', 'http://x.y', NEST]).endsWith('/multi/' + NEST))
  t('nothing valid means no URL at all', gtMultiUrl(['nope', '']) === null)
  t('duplicates are asked for once', gtMultiUrl([NEST, NEST.toUpperCase().replace('0X', '0x')]).endsWith('/multi/' + NEST))
  const many = Array.from({ length: 50 }, (_, i) => '0x' + String(i).padStart(40, '0'))
  t('and at most GeckoTerminal\'s own cap', gtMultiUrl(many).split('/multi/')[1].split(',').length === MAX_PER_REQUEST)
}

console.log(nl + '-- reading GeckoTerminal --')
{
  // Shapes copied from the real multi-token reply for the three tokens in the report.
  const reply = { data: [
    { id: 'hyperevm_' + NEST, attributes: { address: NEST, symbol: 'NEST', name: 'Nest', price_usd: '0.02037551306', total_reserve_in_usd: '913455.2', image_url: 'https://coin-images.coingecko.com/nest.png' } },
    { id: 'hyperevm_' + EAGLE, attributes: { address: EAGLE, symbol: 'EAGLE', name: 'Eagle', price_usd: '0.0001914099722', total_reserve_in_usd: '0', image_url: 'missing.png' } },
    { id: 'hyperevm_' + SIGNAL, attributes: { address: SIGNAL, symbol: 'SIGNAL', name: 'Signal', price_usd: '0.005633069232', total_reserve_in_usd: '237024.3', image_url: null } },
  ] }
  const q = parseGtMulti(reply)
  t('all three are read', Object.keys(q).length === 3)
  t('NEST at its price', near(q[NEST].price, 0.02037551306) && q[NEST].symbol === 'NEST')
  // SIGNAL's pools disagree by 3×; the endpoint's price is the deepest pool's, which is the
  // one you could actually sell into. This asserts we take that figure, not a pool's.
  t('SIGNAL at the deepest pool\'s price', near(q[SIGNAL].price, 0.005633069232))
  t('a deep market is not thin', q[NEST].thin === false && q[SIGNAL].thin === false)
  // EAGLE reports a price with $0 of liquidity behind it — the case to warn about.
  t('EAGLE is flagged thin', q[EAGLE].thin === true && THIN_LIQUIDITY_USD > 0)
  t('a non-https icon is refused', q[EAGLE].icon === null && q[SIGNAL].icon === null && q[NEST].icon.startsWith('https://'))
  t('no price is null, never 0', parseGtToken({ attributes: { address: NEST, price_usd: null } }).price === null)
  t('an unknown token is simply absent', parseGtMulti({ data: [] })[NEST] === undefined)
  t('a malformed reply is empty, not a crash', Object.keys(parseGtMulti({ nope: 1 })).length === 0)
}

console.log(nl + '-- two sources, and the deepest pool wins --')
{
  // Reported: "for spot eagle is kinda off". 342K EAGLE showed $65.46 here and $108.95
  // elsewhere. GeckoTerminal's only EAGLE pool was an EAGLE/WHYPE pool created that morning
  // with effectively nothing in it; the real market is EAGLE/NEST on Project X, which only
  // DexScreener indexes. Replies below are the real shapes from that day.
  const gt = parseGtMulti({ data: [
    { attributes: { address: EAGLE, symbol: 'EAGLE', name: 'Eagle', price_usd: '0.0001914099722', total_reserve_in_usd: '0.0000000000000001867' } },
    { attributes: { address: NEST, symbol: 'NEST', name: 'Nest', price_usd: '0.02037', total_reserve_in_usd: '913455' } },
  ] })
  const ds = parseDsPairs([
    { dexId: 'prjx', baseToken: { address: '0xE99509927aa0dc328e7ab5058cd24be1b2a5f280', symbol: 'EAGLE', name: 'Eagle' },
      quoteToken: { symbol: 'NEST' }, priceUsd: '0.0003131', liquidity: { usd: 104211.28 }, info: { imageUrl: 'https://dd.dexscreener.com/eagle.png' } },
    // A pair that QUOTES in NEST must not hand NEST the price of EAGLE.
    { dexId: 'prjx', baseToken: { address: EAGLE, symbol: 'EAGLE' }, quoteToken: { address: NEST, symbol: 'NEST' }, priceUsd: '0.0003131', liquidity: { usd: 104211 } },
    { dexId: 'nest', baseToken: { address: NEST, symbol: 'NEST', name: 'Nest' }, quoteToken: { symbol: 'WHYPE' }, priceUsd: '0.02089', liquidity: { usd: 1090649 } },
  ])
  t('DexScreener finds the real EAGLE market', near(ds[EAGLE].price, 0.0003131) && ds[EAGLE].pool === 'prjx · EAGLE/NEST')
  t('a pair only priced IN a token does not price it', near(ds[NEST].price, 0.02089))

  const m = mergeQuotes(gt, ds)
  t('EAGLE is priced from the deep pool, not the empty one', near(m[EAGLE].price, 0.0003131) && m[EAGLE].src === 'DexScreener', m[EAGLE])
  t('which puts 342K EAGLE at ~$107, not $65', Math.abs(342000 * m[EAGLE].price - 107.08) < 0.01, 342000 * m[EAGLE].price)
  t('and it is no longer called thin', m[EAGLE].thin === false)
  t('the deeper NEST quote wins too', m[NEST].src === 'DexScreener')
  t('an icon only one source has is kept', m[EAGLE].icon === 'https://dd.dexscreener.com/eagle.png')

  // GeckoTerminal still wins where it is the deeper one — the rule is liquidity, not a brand.
  const gtDeep = pickDeepest({ price: 1, liq: 500000, src: 'GeckoTerminal' }, { price: 3, liq: 900, src: 'DexScreener' })
  t('the deeper source wins whichever it is', gtDeep.src === 'GeckoTerminal' && gtDeep.price === 1)
  t('a quote with no price never wins on liquidity', pickDeepest({ price: null, liq: 9e9 }, { price: 2, liq: 10 }).price === 2)
  t('one source alone is used as-is', mergeQuotes({}, ds)[EAGLE].price === ds[EAGLE].price && mergeQuotes(gt, {})[EAGLE].src === 'GeckoTerminal')
  t('the DexScreener URL is validated the same way', dsMultiUrl(['../x', NEST]) === 'https://api.dexscreener.com/tokens/v1/hyperevm/' + NEST)

  // One source down must not take the other with it.
  const r = await fetchQuotes([EAGLE], async (u) => {
    if (u.includes('geckoterminal')) throw new Error('503')
    return [{ dexId: 'prjx', baseToken: { address: EAGLE, symbol: 'EAGLE' }, quoteToken: { symbol: 'NEST' }, priceUsd: '0.0003131', liquidity: { usd: 104211 } }]
  })
  t('GeckoTerminal failing still prices from DexScreener', r.ok && near(r.quotes[EAGLE].price, 0.0003131))
  const dead = await fetchQuotes([EAGLE], async () => { throw new Error('down') })
  t('both failing is reported as a failure, not as "no price"', dead.ok === false)
}

console.log(nl + '-- storage belongs to a real account --')
{
  const mem = new Map()
  const store = { getItem: k => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) }

  t('a real account has a key', storageKey(ME) === 'hliq_offex_' + ME)
  // CLAUDE.md: agent keys were wiped for a day because writes went to
  // hliq_agent_key___all_accounts__, which nothing ever reads. Same trap, refused.
  t('the combined view is not an account', storageKey('__all_accounts__') === null)
  t('nor is the paper account', storageKey('paper') === null)
  let threw = false
  try { saveHoldings(store, '__all_accounts__', [{ token: NEST, amount: 1 }]) } catch { threw = true }
  t('saving under one throws instead of writing nowhere', threw && mem.size === 0)

  let list = upsertHolding([], { token: NEST, amount: 12000, note: 'locked on Nest' })
  list = upsertHolding(list, { token: EAGLE, amount: 5e6 })
  saveHoldings(store, ME, list)
  t('holdings round-trip', loadHoldings(store, ME).length === 2)
  // One row per token: entering NEST again updates it rather than adding a second NEST row.
  list = upsertHolding(loadHoldings(store, ME), { token: NEST.toUpperCase().replace('0X', '0x'), amount: 15000 })
  t('adding a token again updates it', list.length === 2 && list.find(e => e.token === NEST).amount === 15000)
  t('removing one leaves the other', removeHolding(list, NEST).map(e => e.token).join() === EAGLE)

  t('a zero amount is not a holding', cleanEntry({ token: NEST, amount: 0 }) === null)
  t('nor is a bad address', cleanEntry({ token: 'NEST', amount: 5 }) === null)
  // Absent cost is UNKNOWN. A 0 basis would print the whole value as profit.
  t('a blank cost stays unknown', cleanEntry({ token: NEST, amount: 5, cost: '' }).cost === null)
  mem.set('hliq_offex_' + ME, '{not json')
  t('a damaged store reads as empty, not a crash', loadHoldings(store, ME).length === 0)
}

console.log(nl + '-- value --')
{
  const nest = cleanEntry({ token: NEST, amount: 12000, cost: 200 })
  const v = holdingValue(nest, { price: 0.02, thin: false })
  t('value is amount × price', near(v.usd, 240))
  t('profit is value less cost', near(v.pnl, 40) && near(v.roi, 20))
  const noCost = holdingValue(cleanEntry({ token: NEST, amount: 10 }), { price: 0.02 })
  t('no cost basis means no PnL, not a fabricated one', noCost.pnl === null && noCost.roi === null && near(noCost.usd, 0.2))
  const noPx = holdingValue(nest, null)
  t('no price means no value — a dash, not $0', noPx.usd === null && noPx.pnl === null)

  const tot = holdingsTotal([nest, cleanEntry({ token: EAGLE, amount: 5 })], { [NEST]: { price: 0.02 } })
  // "Empty is not the same as unknown": a total missing a price is a floor and says so.
  t('a total with an unpriced holding is marked incomplete', tot.complete === false && near(tot.usd, 240) && tot.priced === 1 && tot.count === 2)
  t('and a fully priced one is complete', holdingsTotal([nest], { [NEST]: { price: 0.02 } }).complete === true)
}

console.log(nl + '-- prices that do not flicker --')
{
  // "The off-exchange balance sometimes flickers and disappears and appears when visiting the
  // spot tab."
  const ui    = fs.readFileSync('src/offexui.js', 'utf8')
  const serve = fs.readFileSync('serve-prod.js', 'utf8')
  t('prices are remembered on the device', /const LS_QUOTES = 'hliq_offex_quotes'/.test(ui) && /_saveQuotes\(\)/.test(ui))
  t('a token missing from one answer keeps its recent price', /A blip is not a delisting/.test(ui) && /QUOTE_KEEP_MS/.test(ui))
  t('the headline and the wheel ask for prices themselves, not only the Spot tab',
    /export function total\(\) \{\s*refreshPrices\(\)/.test(ui) && /export function wheelItems\(\) \{\s*refreshPrices\(\)/.test(ui))
  t('a liquidity-only change does not repaint', /const shown = \(q\) => q \? \[q\.price, q\.thin, q\.icon/.test(ui))
  // One source down must not swap EAGLE onto its empty pool for a minute.
  t('the server keeps the deeper quote when only one source answered',
    /const t = both \? \(got\[a\] \?\? null\) : pickDeepest\(prev, got\[a\] \?\? null\)/.test(serve))
  t('and retries a half answer soon', /Date\.now\(\) - OFFEX_TTL \+ 10_000/.test(serve))
  const r = await fetchQuotes([EAGLE], async (u) => { if (u.includes('dexscreener')) throw new Error('503'); return { data: [] } })
  t('fetchQuotes says when only one source answered', r.ok === true && r.both === false)
}

console.log(nl + '-- the wiring --')
{
  const main  = fs.readFileSync('src/main.js', 'utf8')
  const ui    = fs.readFileSync('src/offexui.js', 'utf8')
  const serve = fs.readFileSync('serve-prod.js', 'utf8')

  // Two ways in now — ?find= and ?a= — and both validate before anything is fetched.
  t('the server route validates addresses before fetching',
    /const find = normAddr\(qs\.get\('find'\) \|\| ''\)/.test(serve) && /\(qs\.get\('a'\) \|\| ''\)\.split\(','\)\.map\(normAddr\)\.filter\(Boolean\)/.test(serve))
  t('and the network only ever selects from the table', /const net  = normNet\(qs\.get\('n'\)\)/.test(serve))
  t('and asks both sources through fetchQuotes', /await fetchQuotes\(stale,/.test(serve))
  t('a failed call is not cached as "no price"', /When BOTH sources fail, nothing is cached/.test(serve) && /if \(ok\) \{/.test(serve))
  t('dev serves the same route', /path === '\/offexprice'/.test(fs.readFileSync('vite.config.js', 'utf8')))

  // The seam: only real accounts, never state.addr raw.
  const seam = main.slice(main.indexOf('initOffex({'), main.indexOf('initOffex({') + 900)
  t('the accounts in view are filtered to real addresses', /_isRealAddr\(e\.addr\)/.test(seam) && /_isRealAddr\(state\.addr\)/.test(seam))
  t('paper mode has none', /if \(isPaper\(\)\) return \[\]/.test(seam))
  t('the UI module cannot see state', !/\bstate\./.test(ui.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')))

  // Both shells, one renderer.
  t('the mobile Spot tab shows the group', (main.match(/\+ _offex\n/g) ?? []).length === 2 || (main.match(/\) \+ _offex/g) ?? []).length === 2)
  t('and so does the desktop overview', /ov-offex[\s\S]{0,120}_offexSectionHtml/.test(main))

  // Off-exchange value is its own figure unless the user switches "Count in balance" on —
  // asked for with "by default should be off". Even then it moves the HEADLINE only.
  const uses = main.match(/_offexTotal\(/g) ?? []
  t('the wheel total is used for its own caption only', uses.length === 1)
  t('that caption is labelled as a separate figure', /incl\. off-exchange/.test(main))
  t('the switch is off unless explicitly set on', /getItem\(LS_IN_BAL\) === '1'/.test(ui))
  t('and adds nothing while off', /if \(!countInBalance\(\)\) return 0/.test(ui))
  // accountValue feeds health, ROE and the allocation cross-check; the add goes to the
  // printed string and the shown number, never into accountValue itself.
  const rnd = fs.readFileSync('src/render.js', 'utf8')
  t('desktop adds it to the printed string only', /fmtUSD\(accountValue \+ _oxAdd\)/.test(rnd) && /_shownEquity = Number\.isFinite\(accountValue\) \? accountValue : null/.test(rnd))
  t('mobile adds it to the shown figure, not to val', /const shown = val \+ _ox/.test(main) && !/val\s*=\s*val \+ _ox/.test(main))
  t('and labels it when it is in there', /incl\. \$\{_privacyMode \? '•••' : '\$' \+ fmtUSD\(_ox\)\} off-exchange/.test(main))
  t('nothing off-exchange reaches accountValue', !/accountValue\s*[+]?=[^\n]*offex/i.test(main + rnd))

  // Privacy mode covers these like any other holding.
  t('amounts and values go through the privacy mask', (ui.match(/ctx\.prv\(/g) ?? []).length >= 8)
}

console.log(nl + '-- the combined snapshot survives a restart --')
{
  // "The account equity sometimes does not render." Every deploy that touched server.js threw
  // away the last complete All Accounts snapshot, and a cold, rate-limited recompute left
  // every client refusing a partial one — a dash for equity and Net PnL.
  const srv = fs.readFileSync('server.js', 'utf8')
  t('it is written to disk when it changes', /_combinedComplete\.set\(key, \{ at: Date\.now\(\), data \}\)\s*combinedCompleteSave\(\)/.test(srv))
  t('read back at startup, under the same age cap', /readFileSync\(COMBINED_COMPLETE_FILE[\s\S]{0,300}< COMBINED_COMPLETE_MAX_MS\) _combinedComplete\.set/.test(srv))
  t('owner-only', /writeFileSync\(COMBINED_COMPLETE_FILE, JSON\.stringify\(out\), \{ mode: 0o600 \}\)/.test(srv))
  t('and never committed', /combined-complete\.json/.test(fs.readFileSync('.gitignore', 'utf8')))
}

console.log(nl + '-- other networks --')
{
  // Reported: DIME, 0xb32e…0fa7, "is from the eth network" — HyperEVM had no market for it.
  const DIME = '0xb32e10022ffbedfe10bc818a1c7e67d9d87e0fa7'
  t('HyperEVM is still the default', DEFAULT_NET === 'hyperevm' && gtMultiUrl([DIME]).includes('/networks/hyperevm/'))
  t('Ethereum asks each source by its own id',
    gtMultiUrl([DIME], 'eth').includes('/networks/eth/tokens/multi/') && dsMultiUrl([DIME], 'eth') === 'https://api.dexscreener.com/tokens/v1/ethereum/' + DIME)
  // The network goes into a URL, so it may only ever pick from the table.
  t('an unknown network is HyperEVM, never text in a URL', normNet('../../x') === 'hyperevm' && !gtMultiUrl([DIME], '../../x').includes('..'))
  t('toString and friends are not networks', normNet('toString') === 'hyperevm' && normNet('__proto__') === 'hyperevm')
  t('a HyperEVM quote keeps its old key — cached prices stay valid', quoteKey('hyperevm', DIME) === DIME)
  t('another network\'s carries the network', quoteKey('eth', DIME.toUpperCase().replace('0X', '0x')) === 'eth:' + DIME)
  t('the cross-chain lookup URL is validated', dsFindUrl('../x') === null && dsFindUrl(DIME).endsWith('/latest/dex/tokens/' + DIME))

  const reply = { pairs: [
    { chainId: 'ethereum', baseToken: { address: DIME }, liquidity: { usd: 94698 } },
    { chainId: 'base', baseToken: { address: DIME }, liquidity: { usd: 500 } },
    // DIME as the QUOTE token on a deeper pool elsewhere says nothing about where DIME trades.
    { chainId: 'bsc', baseToken: { address: '0x' + '1'.repeat(40) }, quoteToken: { address: DIME }, liquidity: { usd: 1e7 } },
    { chainId: 'solana', baseToken: { address: DIME }, liquidity: { usd: 1e9 } },
  ] }
  t('the network with its deepest pool wins', pickNetwork(reply, DIME) === 'eth')
  t('unsupported chains and quote-side pairs do not count', pickNetwork({ pairs: reply.pairs.slice(2) }, DIME) === null)
  t('nothing found is null', pickNetwork({ pairs: null }, DIME) === null)

  const r = await fetchQuotes([DIME], async (u) => {
    if (u.includes('geckoterminal')) return { data: [{ attributes: { address: DIME, symbol: 'DIME', price_usd: '0.0612', total_reserve_in_usd: '64142' } }] }
    return [{ baseToken: { address: DIME, symbol: 'DIME' }, priceUsd: '0.0606', liquidity: { usd: 94698 }, dexId: 'uniswap', quoteToken: { symbol: 'WETH' } }]
  }, 'eth')
  t('priced on Ethereum from the deeper pool', r.quotes[DIME]?.price === 0.0606 && r.both, r.quotes[DIME])

  // Stored holdings: the network travels, old ones read as HyperEVM, and one address on two
  // chains is two holdings.
  t('an old holding reads as HyperEVM', cleanEntry({ token: DIME, amount: 1 }).net === 'hyperevm')
  let list = upsertHolding([], { token: DIME, amount: 1617.19, net: 'eth' })
  list = upsertHolding(list, { token: DIME, amount: 5, net: 'hyperevm' })
  t('the same address on two networks is two holdings', list.length === 2)
  list = upsertHolding(list, { token: DIME, amount: 2000, net: 'eth' })
  t('re-adding on the same network updates it', list.length === 2 && list.find(e => e.net === 'eth').amount === 2000)
  t('removing takes only that network\'s', removeHolding(list, DIME, 'eth').map(e => e.net).join() === 'hyperevm')
  const tot = holdingsTotal(list, { ['eth:' + DIME]: { price: 0.06 } })
  t('the total prices each holding on its own network', near(tot.usd, 120) && tot.complete === false, tot)
  // Was "every network has both ids". Hyperliquid is now in this table and deliberately has
  // NEITHER: it is priced from the mids the app already polls, because HYPE has no contract
  // for a DEX source to quote (spotMeta gives it evmContract:null). So the rule is now: a
  // network is either DEX-priced and carries both ids, or it is HL and carries neither.
  t('every DEX-priced network has both ids',
    Object.entries(NETWORKS).every(([k, n]) => k === HL_NET ? (!n.gt && !n.ds) : (n.gt && n.ds)))
  t('and every network is labelled', Object.values(NETWORKS).every(n => n.label))
  t('the HL network asks no DEX source', gtMultiUrl(['HYPE'], HL_NET) === null && dsMultiUrl(['HYPE'], HL_NET) === null)
  // Its tokens are NAMED, not addressed — the whole reason it exists.
  t('an HL holding is keyed by symbol', quoteKey(HL_NET, 'hype') === 'hl:HYPE')
  t('and a symbol is refused on an addressed network', quoteKey('eth', 'HYPE') === null)
  const hl = cleanEntry({ token: 'hype', net: HL_NET, amount: 19.87 })
  t('an HL entry survives cleaning', hl && hl.token === 'HYPE' && hl.net === HL_NET && near(hl.amount, 19.87), hl)
  t('an address is still refused there', cleanEntry({ token: DIME, net: HL_NET, amount: 1 }) === null)
  t('removing one matches by symbol', removeHolding([hl], 'HYPE', HL_NET).length === 0)
  t('an HL holding prices from its own quote',
    near(holdingsTotal([hl], { 'hl:HYPE': { price: 97.5 } }).usd, 19.87 * 97.5))
}

console.log(nl + `${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
