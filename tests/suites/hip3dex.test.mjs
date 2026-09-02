// HIP-3 builder dexes: all of them, and reachable by the name the exchange shows.
//
// Two separate bugs lived here. The dex queue was built from perpCategories, which is not
// the list of builder dexes — it is the list of dexes that bothered to categorise their
// markets. Three of them did not, so their markets existed on Hyperliquid and nowhere in
// this app. And io:GPRO is displayed by HL as "GOPRO", so someone who read that name and
// typed it got "No price for GOPRO": true, and useless.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const api = fs.readFileSync('src/api.js', 'utf8').replace(/\r\n/g, '\n')
const html = fs.readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- every builder dex is discovered, not just the tidy ones --')
const loader = grab(cli, 'function _startHip3CtxLoader')
t('the queue still seeds from the categories it has', loader.includes('Object.keys(_mktCatMap)'))
t('but allPerpMetas is what decides which dexes exist',
  loader.includes('hip3DexNames(state.allMetas ?? [])'))
t('the helper is exported for it', api.includes('export function hip3DexNames(allMetas)'))
t('why perpCategories was the wrong source is recorded',
  cli.includes('perpCategories is NOT the list of dexes'))
t('and what it cost is recorded, not just the rule',
  cli.includes('not in the picker, not in search, not to a bot'))
t('metas are fetched once if the loader runs before a wallet does',
  loader.includes('infoClient.allPerpMetas()') && loader.includes('_hip3MetaTried'))
t('and that retry cannot loop', cli.includes('let _hip3MetaTried   = false'))

console.log(nl + '-- the dex row --')
t('the markets list has one', cli.includes('id="mobMktDexRow"'))
t('the coin picker has one', cli.includes('id="mobCoinPickerDexes"'))
t('both are drag-scrollable, or their tail is unreachable',
  /id="mobMktDexRow" data-dragscroll/.test(cli) && /id="mobCoinPickerDexes" data-dragscroll/.test(cli))
t('the picker row gets the same manual touch-scroll as the pills',
  cli.includes("for (const id of ['#mobCoinPickerPills', '#mobCoinPickerDexes'])"))
t('the dex list is derived from the data, not hardcoded',
  grab(cli, 'function _hip3DexesAvailable').includes('state.allMids') &&
  grab(cli, 'function _hip3DexesAvailable').includes('_mktCtxMap'))
t('why it is derived is recorded', cli.includes('a dex that launches tomorrow appears without a release'))
t('one dex is not offered as a choice',
  grab(cli, 'function _mobVRenderPickerDexes').includes('dexes.length < 2') &&
  grab(cli, 'function _mobRenderMktDexRow').includes('dexes.length < 2'))
t('the row only shows under HIP-3',
  grab(cli, 'function _mobVRenderPickerDexes').includes("_mobVPickerType !== 'hip3'") &&
  grab(cli, 'function _mobRenderMktDexRow').includes("_mobTradeMainFilter !== 'hip3'"))
t('switching category clears the chosen dex',
  grab(cli, 'window._mobVSetPickerType = function').includes("_mobVPickerDex = 'all'") &&
  grab(cli, 'window._mobTradeSetFilter = function').includes("_mobTradeDex = 'all'"))
t('why clearing it matters is recorded', cli.includes('means nothing under Spot'))

console.log(nl + '-- choosing a dex filters to it --')
t('the markets list filters', cli.includes("if (_mobTradeDex !== 'all') entries = entries.filter(([k]) => k.split(':')[0] === _mobTradeDex)"))
t('the coin picker filters', cli.includes("if (_mobVPickerDex !== 'all') entries = entries.filter(([k]) => k.split(':')[0] === _mobVPickerDex)"))
t('the desktop dropdown groups by dex under HIP-3', cli.includes("const byDex = _dropType === 'hip3'"))
t('and filters by it', cli.includes("? entries.filter(([k]) => k.split(':')[0] === _dropCat)"))
t('the picker headings become the dex, not the category',
  cli.includes("const cat = byDex ? (c.split(':')[0] || 'other')"))
t('why a category heading says nothing here is recorded',
  cli.includes('every market is a') && cli.includes('the category says nothing'))
t('the desktop sub-row still shows categories elsewhere',
  cli.includes(': [...new Set(entries.map(([k]) => _mktCatMap[k]).filter(Boolean))].sort()'))
t('the type row that opens all this still exists', html.includes(`data-type="hip3"`))

console.log(nl + '-- a market can be found by the name it is shown under --')
t('GPRO is aliased to GOPRO', /'GPRO':\s*'GOPRO'/.test(cli))
t('the existing WTIOIL alias is untouched', /'CL':\s*'WTIOIL'/.test(cli))
t('there is a reverse map', cli.includes('const _MKT_DISPLAY_REV = Object.fromEntries('))
t('the bot coin field uses it', grab(cli, 'function _resolveGridCoin').includes('_MKT_DISPLAY_REV[up]'))
t('the real ticker still resolves first',
  grab(cli, 'function _resolveGridCoin').indexOf('k.split(\':\').pop().toUpperCase() === up') <
  grab(cli, 'function _resolveGridCoin').indexOf('_MKT_DISPLAY_REV[up]'))
t('an unknown name is still returned as typed, not guessed at',
  grab(cli, 'function _resolveGridCoin').trim().endsWith('return up\n}') ||
  grab(cli, 'function _resolveGridCoin').includes('return up                                       // leave as typed'))
t('why the alias exists is recorded, with the symptom',
  cli.includes('No price for GOPRO'))

console.log(nl + '-- the grid card resolves the same way the launch does --')
// It looked the raw text up in allMids, so the auto bounds stayed empty for every HIP-3
// market — typed as "SPCX" or as "GOPRO", both found nothing.
const defaults = grab(cli, 'function _applyGridDefaults')
t('the card resolves the coin', defaults.includes('_resolveGridCoin(coinEl?.value?.trim()'))
t('it no longer uppercases and hopes', !defaults.includes(".placeholder || 'BTC').toUpperCase()"))
t('why is recorded', cli.includes('auto lower/upper bounds silently stayed empty'))
t('the launch path already resolved, and still does', cli.includes("_resolveGridCoin(get('m-grid-coin')"))

console.log(nl + '-- searching by the shown name --')
t('the markets list matches the alias', grab(cli, 'function _mobBuildMarketRows').includes("(_mktDisplay(k) ?? '').toLowerCase().includes(lq)"))
t('so does the coin picker', grab(cli, 'function _mobVTradeCoinList').includes("(_mktDisplay(k) ?? '').toLowerCase().includes(lq)"))
t('and the desktop dropdown always did', cli.includes("(_mktDisplay(k) ?? '').toLowerCase().includes(q)"))

console.log(nl + '-- the simulator no longer prints what it cannot do --')
t('the section is gone', !cli.includes('Bots this cannot simulate'))
t('and nothing imports the list into the view', !cli.includes('BT_UNSIMULATABLE'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
