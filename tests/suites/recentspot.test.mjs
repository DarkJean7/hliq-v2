// Recent activity (desktop Overview) names a spot trade as a purchase or a sale.
//
// "the desktop recent shows spot buys/sells as if it was a perps open/close position. in history
// is working fine." Hyperliquid's dir for a spot fill is "Buy"/"Sell"; the card read anything
// that was not "close" as an open and made up a side, so a HYPE spot buy was "Opened HYPE long".
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c) => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n))
const r = fs.readFileSync('src/render.js', 'utf8')
const fn = r.slice(r.indexOf('function _ovRecentActivity('), r.indexOf('function _ovTimeAgo('))

t('a spot fill is told apart by its dir or its coin',
  /const spot  = dir === 'buy' \|\| dir === 'sell' \|\| isSpotCoin\(f\.coin\) \|\| String\(f\.coin\)\.startsWith\('#'\)/.test(fn))
t('and reads Bought / Sold, with no position side', /spot \? `\$\{f\.side === 'BUY' \? 'Bought' : 'Sold'\}/.test(fn))
t('it is never an open or a close', /const isClose = spot \? false :/.test(fn))
t('a sale still shows what it realised', /\(isClose \|\| \(spot && f\.side !== 'BUY'\)\) && f\.closedPnl/.test(fn))
t('perps unchanged: Opened / Closed with the side', /`\$\{isClose \? 'Closed' : 'Opened'\} \$\{esc\(_lbl\(f\.coin\)\)\} \$\{sideWord\}`/.test(fn))
t('isSpotCoin is imported where it is used', /import \{[^}]*isSpotCoin[^}]*\} from '\.\/format\.js'/.test(r))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
