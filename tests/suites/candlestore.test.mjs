// Candles kept on the device (src/candlestore.js): "each time i open the app or reload and then
// i open oracle it fetches all the data again, and it takes a while".
import fs from 'fs'
import { mergeCandles, readFrom, KEEP_MS } from '../../src/candlestore.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const k = (t, c) => ({ t, o: c, h: c, l: c, c })

console.log('-- merging what was kept with what is new --')
const kept = [k(1, 10), k(2, 11), k(3, 12)]          // 3 was still forming when it was kept
const fresh = [k(2, 11), k(3, 13), k(4, 14)]
const m = mergeCandles(kept, fresh)
t('one candle per time, oldest first', m.map(x => x.t).join() === '1,2,3,4')
t('a candle read again replaces the kept one (it had not closed)', m.find(x => x.t === 3).c === 13)
t('nothing older than the span', mergeCandles(kept, fresh, 2).map(x => x.t).join() === '2,3,4')
t('nothing kept: just what was read', mergeCandles(null, fresh).length === 3 && mergeCandles(kept, []).length === 3)

console.log('-- where to start reading --')
t('two candles before the last kept: it was forming, and the one before may have closed late', readFrom(kept, 0) === 2)
t('never before the span', readFrom(kept, 5) === 5)
t('nothing kept: the whole span, as before', readFrom(null, 100) === 100 && readFrom([k(9, 1)], 100) === 100)
t('kept for three days at most', KEEP_MS === 3 * 864e5)

console.log('-- wiring --')
const ana = fs.readFileSync('src/analysis.js', 'utf8'), view = fs.readFileSync('src/outlookview.js', 'utf8')
t('a read starts from what was kept, not a year back', ana.includes('startTime: readFrom(kept, spanStart)') && ana.includes('mergeCandles(kept, fresh, spanStart)'))
t('every read is kept for next time', ana.includes('putCandles(coin, { at: now, candles: out })'))
t('fresh candles from the device need no read, only the book', ana.includes('const needC = now - e.candleAt > CANDLE_TTL, needB = needC || !e.books'))
t('Oracle draws what was kept before fetching anything', view.includes('if (await hydrateAnalysis(coins)) paint(true)'))
t('and fetches a market whose book is missing, not only a stale one', view.includes('Date.now() - raw.at > RELOAD_MS || raw.ratio == null'))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
