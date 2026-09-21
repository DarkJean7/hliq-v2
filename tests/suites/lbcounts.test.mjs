// Leaderboard card: the counts behind the figures.
//
// Two asks on the expanded board row:
//   • "under win rate display the amount of wins/losses" — 98.4% of 129 trades and 98.4% of
//     five are different claims, and the percentage alone cannot tell them apart
//   • "7 open positions: 6 longs / 1 short" in the collapsed header, so the direction of the
//     book reads without opening the list
import fs from 'fs'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const main = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const a = main.indexOf("const winRate = r.totalWindows > 0 ? (r.winCount / r.totalWindows * 100)")
const card = main.slice(a, main.indexOf('// Remove control', a))

console.log(nl + '-- the card is where this suite thinks it is --')
t('found the board row', a > 0 && card.length > 1000, card.length)

console.log(nl + '-- wins and losses under the rate --')
{
  // Run the exact arithmetic the card uses.
  const src = card.slice(0, card.indexOf('expandHtml = _mobVDetailGrid'))
  const build = new Function('r', src + '; return winRateHtml')
  const html = build({ winCount: 127, totalWindows: 129 })
  t('the rate is still there', html.startsWith('98.4%'), html)
  t('with the wins under it', /127 W/.test(html))
  t('and the losses — every trade that did not win', /2 L/.test(html))
  t('wins in green, losses in red', /var\(--green\)">127 W/.test(html) && /var\(--red\)">2 L/.test(html))
  t('no trades shows a dash and no fake 0 W / 0 L', build({ winCount: 0, totalWindows: 0 }) === '—')
  t('a missing win count is not negative losses', /0 W[\s\S]*3 L/.test(build({ totalWindows: 3 })))
  t('the grid uses the new cell', card.includes("['Win Rate',   winRateHtml]"))
}

console.log(nl + '-- longs and shorts in the positions header --')
{
  const pos = (szi) => ({ position: { szi: String(szi) } })
  const src = card.slice(card.indexOf('const _longs'), card.indexOf('expandHtml += _lbCollapse(`${id}-pos`'))
  const split = new Function('openPos', src + '; return [_longs, _shorts, _side]')
  const [l, s, side] = split([pos(1), pos(2), pos(0.5), pos(3), pos(1), pos(9), pos(-4)])
  t('six longs', l === 6)
  t('one short', s === 1)
  t('singular and plural read right', side(1, 'short') === '1 short' && side(6, 'long') === '6 longs' && side(0, 'short') === '0 shorts')
  t('the header carries both', /Open Position\$\{openPos\.length !== 1 \? 's' : ''\}: <span style="color:var\(--green\)">\$\{_side\(_longs, 'long'\)\}<\/span> \/ <span style="color:var\(--red\)">\$\{_side\(_shorts, 'short'\)\}/.test(card))
}

console.log(nl + `${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
