// Drag to reorder the watch cards (src/watchorder.js). "make the watch cards be able to change order".
import fs from 'fs'
import { applyOrder } from '../../src/watchorder.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('-- the order the screen shows --')
t('a card moved is saved where it was dropped', applyOrder(['BTC', 'ETH', 'SOL'], ['SOL', 'BTC', 'ETH']).join() === 'SOL,BTC,ETH')
t('one added elsewhere meanwhile keeps its place at the end', applyOrder(['BTC', 'ETH', 'HYPE'], ['ETH', 'BTC']).join() === 'ETH,BTC,HYPE')
t('one removed meanwhile is not brought back', applyOrder(['BTC'], ['ETH', 'BTC']).join() === 'BTC')
t('a key twice counts once', applyOrder(['A', 'B'], ['B', 'B', 'A']).join() === 'B,A')
t('no keys leaves the list alone', applyOrder(['A', 'B'], null).join() === 'A,B')

console.log('-- wiring --')
const main = fs.readFileSync('src/main.js', 'utf8')
t('the home strip reorders sideways', /enableReorder\(el, \{ item: '\.mob-watch-cell', axis: 'x'/.test(main))
t('the Watch tab reorders, by grip or by holding anywhere but the ✕', /item: '\.mob-watch-row', axis: 'y', handle: '\.wo-grip', ignore: 'button'/.test(main))
t('the desktop table reorders', /item: 'tr\[data-wk\]'/.test(main))
t('coins and markets are separate groups, saved to their own list',
  /if \(g === 't'\) saveTvWatch\(applyOrder\(loadTvWatch\(\), keys\)\)\s+else saveWatchlist\(applyOrder\(loadWatchlist\(\), keys\)\)/.test(main))
t('every strip card says which list it belongs to', /_mobWatchCell\(c, 'c'\)/.test(main) && /_mobWatchCell\(s, 't'\)/.test(main))
const wo = fs.readFileSync('src/watchorder.js', 'utf8')
t('touchmove can stop the scroll (non-passive)', /'touchmove'[\s\S]{0,600}\{ passive: false \}/.test(wo))
t('a lifted card does not also open its market', /addEventListener\('click', swallow, \{ capture: true, once: true \}\)/.test(wo))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
