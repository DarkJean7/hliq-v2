// Off-exchange holdings: tokens held outside Hyperliquid, typed in by amount, priced live.
//
// The failure modes worth a test are the quiet ones. A holding saved under the combined
// view's '__all_accounts__' key that nothing ever reads back. A price taken from a thin pool
// three times away from the real one. A token GeckoTerminal does not know, printed as $0 —
// "worthless" — instead of a dash. A manual number leaking into account equity, which is the
// one figure in the app that matches Hyperliquid to the cent.
import fs from 'fs'
import {
  isTokenAddr, normAddr, gtMultiUrl, parseGtToken, parseGtMulti, THIN_LIQUIDITY_USD,
  storageKey, cleanEntry, loadHoldings, saveHoldings, upsertHolding, removeHolding,
  holdingValue, holdingsTotal, MAX_PER_REQUEST,
} from '../../src/offex.js'

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

console.log(nl + '-- the wiring --')
{
  const main  = fs.readFileSync('src/main.js', 'utf8')
  const ui    = fs.readFileSync('src/offexui.js', 'utf8')
  const serve = fs.readFileSync('serve-prod.js', 'utf8')

  t('the server route validates addresses before fetching', /url === '\/offexprice'[\s\S]{0,600}map\(normAddr\)\.filter\(Boolean\)/.test(serve))
  t('and builds the URL only through gtMultiUrl', /fetch\(gtMultiUrl\(stale\)/.test(serve))
  t('a failed call is not cached as "no price"', /A failed call caches NOTHING/.test(serve))
  t('dev serves the same route', /path === '\/offexprice'/.test(fs.readFileSync('vite.config.js', 'utf8')))

  // The seam: only real accounts, never state.addr raw.
  const seam = main.slice(main.indexOf('initOffex({'), main.indexOf('initOffex({') + 900)
  t('the accounts in view are filtered to real addresses', /_isRealAddr\(e\.addr\)/.test(seam) && /_isRealAddr\(state\.addr\)/.test(seam))
  t('paper mode has none', /if \(isPaper\(\)\) return \[\]/.test(seam))
  t('the UI module cannot see state', !/\bstate\./.test(ui.replace(/^\s*\*.*$/gm, '').replace(/\/\/.*$/gm, '')))

  // Both shells, one renderer.
  t('the mobile Spot tab shows the group', (main.match(/\+ _offex\n/g) ?? []).length === 2 || (main.match(/\) \+ _offex/g) ?? []).length === 2)
  t('and so does the desktop overview', /ov-offex[\s\S]{0,120}_offexSectionHtml/.test(main))

  // The promise that was made: never folded into the account.
  const uses = main.match(/_offexTotal\(/g) ?? []
  t('the total is used for its own caption only', uses.length === 1)
  t('that caption is labelled as a separate figure', /incl\. off-exchange/.test(main))
  t('nothing off-exchange reaches accountValue', !/accountValue[^\n]*offex/i.test(main))

  // Privacy mode covers these like any other holding.
  t('amounts and values go through the privacy mask', (ui.match(/ctx\.prv\(/g) ?? []).length >= 8)
}

console.log(nl + `${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
