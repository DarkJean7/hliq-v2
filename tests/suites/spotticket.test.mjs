// A spot market is not a perp, and the size box must know it.
//
// Reported: opening a SPOT market showed the perp ticket — Long/Short, Cross, "20x Leverage",
// Funding (8h), Required Margin. The wording was the visible half. The dangerous half was the
// arithmetic: state.leverage is GLOBAL and carries over from the last perp you looked at, and
// every size box multiplies by it —
//
//     const coinSz = unit === 'coin' ? v : (v * lev) / mktPx
//
// so "$10 of USDC" on a spot market with 20x left over asked for $200 of the token, which
// FILLS when the balance covers it. Nothing downstream caught it: placeOrdersRaw already skips
// the leverage UPDATE for spot ("invalid spot"), so it just received a size twenty times too
// big. _coinMaxLev could not clamp it either — assetMap and allMetas are perp universes, so a
// spot coin missed both and fell through to `return 50`.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const fnBody = (sig) => {
  const i = CLI.indexOf(sig); if (i < 0) return ''
  let j = CLI.indexOf('{', i), d = 0
  for (; j < CLI.length; j++) { if (CLI[j] === '{') d++; else if (CLI[j] === '}') { d--; if (!d) return CLI.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- there is one notion of "this market has no leverage" --')
t('the predicate exists', fnBody('function _noLeverageMkt(').length > 0)
t('it covers spot AND outcome markets',
  /isSpotCoin\(coin, _spotNameMap\) \|\| _lbIsOutcome\(coin\)/.test(fnBody('function _noLeverageMkt(')))
t('and an effective leverage built on it', /_noLeverageMkt\(coin\) \? 1 : \(state\.leverage \?\? 5\)/.test(fnBody('function _effLeverage(')))
// The 50x default is only reachable for a perp now; a spot coin is answered before the lookups.
t('maxLev answers spot before it consults the perp universes',
  /function _coinMaxLev[\s\S]{0,300}?if \(_noLeverageMkt\(c\)\) return 1[\s\S]{0,120}?assetMap/.test(CLI))

console.log(nl + '-- and every size box goes through it --')
// Two are allowed to read the raw value: the helper itself, and the leverage PICKER, whose job
// is to show what you have chosen. Everything else sizes an order and must not.
const raw = (CLI.match(/state\.leverage \?\? 5/g) || []).length
t('only the helper and the picker read state.leverage directly', raw === 2, 'sites=' + raw)
t('the mobile sheet sizes with it', /const lev\s*=\s*_effLeverage\(coin\)/.test(CLI))
t('the pro ticket is handed it too', /leverage: \(\) => _effLeverage\(\)/.test(CLI))
t('and the max-notional hint uses it', (CLI.match(/maxNotional: avail \* _effLeverage\(\)/g) || []).length === 3)

console.log(nl + '-- the arithmetic, from the source --')
const effLev = (spot, lev) => new Function('stubs', `
  const { _noLeverageMkt, state } = stubs
  ${fnBody('function _effLeverage(')}
  return _effLeverage('X')
`)({ _noLeverageMkt: () => spot, state: { leverage: lev, selectedCoin: 'X' } })
t('a perp keeps its leverage', effLev(false, 20) === 20)
t('a spot market is 1x, whatever was left over', effLev(true, 20) === 1)
// The reported case: $10 of USDC at a stale 20x asked for $200 of the token.
const size = (spot, lev, usd, px) => (usd * effLev(spot, lev)) / px
t('$10 of a $0.33846 token buys ~29.5 tokens, not 590', Math.round(size(true, 20, 10, 0.33846)) === 30)
t('and the perp case is unchanged', Math.round(size(false, 20, 10, 0.33846)) === 591)

console.log(nl + '-- the ticket stops showing perp furniture --')
t('the sheet knows which kind it is', /const isSpotMkt = _noLeverageMkt\(coin\)/.test(CLI))
t('margin mode and leverage are hidden', /Margin mode \+ leverage[\s\S]{0,160}?isSpotMkt \? 'none' : 'flex'/.test(CLI))
t('funding is hidden', /isSpotMkt \? 'none' : 'flex'[^\n]*Funding \(8h\)/.test(CLI))
t('required margin becomes a total', /isSpotMkt \? 'Total Cost' : 'Required Margin'/.test(CLI))
t('the side toggles say Buy/Sell', /isSpotMkt \? 'Buy' : 'Long'/.test(CLI) && /isSpotMkt \? 'Sell' : 'Short'/.test(CLI))
// The coin page's own pair opens this sheet and had the same wording.
t('so do the buttons that open it', /isSpot \? 'Buy' : 'Long'/.test(CLI) && /isSpot \? 'Sell' : 'Short'/.test(CLI))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
