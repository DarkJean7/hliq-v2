// The wheel over a horizontal strip: moves it while it can, hands back to the page at the ends.
// "is not letting me scroll the trending now cards" -- a mouse could not reach past the fifth.
import fs from 'fs'
import { wheelStep } from '../../src/dragx.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

t('wheel down mid-strip moves it right', wheelStep({ dx: 0, dy: 100, left: 50, max: 800 }) === 100)
t('wheel up mid-strip moves it left', wheelStep({ dx: 0, dy: -100, left: 50, max: 800 }) === -100)
t('at the right end, down goes to the page', wheelStep({ dx: 0, dy: 100, left: 800, max: 800 }) === 0)
t('at the left end, up goes to the page', wheelStep({ dx: 0, dy: -100, left: 0, max: 800 }) === 0)
t('a strip that fits never takes the wheel', wheelStep({ dx: 0, dy: 100, left: 0, max: 0 }) === 0)
t('a sideways trackpad swipe is left native', wheelStep({ dx: 80, dy: 10, left: 50, max: 800 }) === 0)

const main = fs.readFileSync('src/main.js', 'utf8')
t('Trending carries data-dragscroll (the iOS fixed-overlay touch fallback)', /scroller\.setAttribute\('data-dragscroll'/.test(main))
t('and the mouse scroll, imported', /enableMouseScroll\(scroller\)/.test(main) && /import \{ enableMouseScroll \} from '\.\/dragx\.js'/.test(main))
const dx = fs.readFileSync('src/dragx.js', 'utf8')
t('a drag swallows the click that ends it', /addEventListener\('click'[\s\S]{0,80}dragged[\s\S]{0,60}stopPropagation/.test(dx))
t('touch is left to the browser', /pointerType !== 'mouse'/.test(dx))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
