// A held outcome is valued at Hyperliquid's mark, everywhere it is priced.
//
// "outcomes pnl is spiking": the Outcomes tab showed one holding at 13.03¢ (+$42.13) and 1.54¢
// (−$18.34) in turn. The panel used Hyperliquid's mark; the holding rows, their refresh, What moved
// and the combined view took the raw book mid — one side alone when the book was one-sided — and
// whichever wrote the cache last won. One rule now, the panel's: mark, then a two-sided mid, never a
// lone side.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const main = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')   // a Windows checkout is CRLF

const src = main.slice(main.indexOf('function _ocHeldMark('), main.indexOf('\n}\n', main.indexOf('function _ocHeldMark(')) + 2)
const mark = (mids, book) => new Function('state', `${src}; return _ocHeldMark(7, ${JSON.stringify(book)})`)({ allMids: mids })
const lv = (bid, ask) => ({ levels: [bid ? [{ px: String(bid) }] : [], ask ? [{ px: String(ask) }] : []] })
t("Hyperliquid's mark wins over the book", mark({ '#7': '0.0154' }, lv(0.01, 0.25)) === 0.0154)
t('no mark: a two-sided mid', Math.abs(mark({}, lv(0.25, 0.301)) - 0.2755) < 1e-9)
t('a lone ask is not a price', mark({}, lv(0, 0.25)) === 0)
t('nor a lone bid', mark({}, lv(0.061, 0)) === 0)
t('a mark out of 0..1 is not one', mark({ '#7': '1.2' }, lv(0.2, 0.3)) === 0.25)

t('no lone-side mid is left anywhere', !/\(bid \|\| ask/.test(main))
t('the Outcomes rows, their refresh, What moved and All Accounts all use it',
  (main.match(/_ocHeldMark\(n\)/g) ?? []).length >= 4, (main.match(/_ocHeldMark\(n\)/g) ?? []).length)

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
