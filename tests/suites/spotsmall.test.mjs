// "Hide small" on the Spot list (src/spotsmall.js). Driven for real in tests/spottab-browser.mjs.
import fs from 'fs'
import { isSmallSpot, splitSmall, hideSmallBar, SMALL_SPOT_USD } from '../../src/spotsmall.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

t('the line is $1', SMALL_SPOT_USD === 1)
t('0.013 KNTQ at $0.22 is small', isSmallSpot(0.013 * 0.22372, 0.22372))
t('$34 of HYPE is not', !isSmallSpot(34.07, 63.683))
t('no price is NOT small — unknown is not worthless', !isSmallSpot(0, 0) && !isSmallSpot(0, null) && !isSmallSpot(NaN, 1))
const { keep, small } = splitSmall([{ c: 'A', usd: 0.5, px: 1 }, { c: 'B', usd: 5, px: 1 }, { c: 'C', usd: 0, px: 0 }], r => r)
t('splitSmall keeps the priced and the unpriced, sets aside the dust', keep.map(r => r.c).join() === 'B,C' && small.map(r => r.c).join() === 'A')
t('no chip when there is nothing to hide', hideSmallBar({ smallCount: 0, on: false, onclick: '' }) === '')
t('the chip says what it hides when on', /2 hidden/.test(hideSmallBar({ smallCount: 2, on: true, onclick: 'x()' })))

const m = fs.readFileSync('src/main.js', 'utf8')
t('the phone list uses it, single account and All Accounts', (m.match(/onclick: "window.__spotHideSmall\('m'\)"/g) ?? []).length === 2)
t('the desktop Overview list uses it too', m.includes(`onclick: "window.__spotHideSmall('d')"`) && m.includes('return bar + `${head}'))
t('hiding a row does not take its money out of the desktop total', m.includes('spotUsd: allRows.reduce('))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
