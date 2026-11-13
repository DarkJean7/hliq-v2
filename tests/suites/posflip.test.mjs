// Flip a position in one order (src/posflip.js). Asked for: "if i have 1 long btc, open a 2 btc
// short so it closes the position and opens 1 short btc". Driven in a real page by
// tests/posflip-browser.mjs; these are the rules.
import fs from 'fs'
import { flipPlan, flipOutcome } from '../../src/posflip.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const long = flipPlan({ coin: 'BTC', szi: '1', leverage: { type: 'cross', value: 10 } })
t('1 BTC long flips with a SELL of 2', long.isBuy === false && long.sz === 2 && long.from === 'long' && long.to === 'short', long)
const short = flipPlan({ coin: 'xyz:NVDA', szi: '-3.5', leverage: { type: 'isolated', value: 5 } })
t('a short flips with a BUY of twice its size', short.isBuy === true && short.sz === 7 && short.to === 'long', short)
t('leverage and margin mode are the position\'s own', long.leverage === 10 && !long.isIsolated && short.leverage === 5 && short.isIsolated)
t('HIP-3 coins pass through as written', short.coin === 'xyz:NVDA')
// Doubling is exact in binary floating point, so no rounding leaves a sliver behind.
for (const s of ['0.00123', '0.1', '12.37', '0.30000']) {
  const p = flipPlan({ coin: 'X', szi: s, leverage: { type: 'cross', value: 3 } })
  t(`twice ${s} is exactly twice`, p.sz === 2 * parseFloat(s) && p.sz / 2 === p.size)
}
t('no position, nothing to flip', flipPlan({ coin: 'BTC', szi: '0' }) === null && flipPlan(null) === null && flipPlan({ szi: '1' }) === null)
t('leverage missing reads as 1x, never 0', flipPlan({ coin: 'BTC', szi: '1' }).leverage === 1)

console.log('-- what the reader is told --')
t('all of it filled: flipped', flipOutcome(long, 2).kind === 'flipped')
t('nothing filled: nothing changed', flipOutcome(long, 0).kind === 'none')
const half = flipOutcome(long, 1.4)
t('closed and part-opened: says the short that is left', half.kind === 'partial' && half.side === 'short' && Math.abs(half.left - 0.4) < 1e-9, half)
const part = flipOutcome(long, 0.25)
t('only partly closed: says the long that is left', part.kind === 'partial' && part.side === 'long' && Math.abs(part.left - 0.75) < 1e-9, part)

console.log('-- wiring --')
const main = fs.readFileSync('src/main.js', 'utf8'), render = fs.readFileSync('src/render.js', 'utf8')
const body = main.slice(main.indexOf('window.__posFlip = '), main.indexOf('window._mobVAdjustMargin = '))
t('one order, not reduce-only (placeMarketOrder, never closePosition)', /placeMarketOrder\(\{ coin, isBuy: plan\.isBuy, sz: plan\.sz/.test(body) && !/closePosition|reduceOnly: true/.test(body))
t('asks before it sends', body.indexOf('_appConfirm') > 0 && body.indexOf('_appConfirm') < body.indexOf('placeMarketOrder'))
t('signed for the wallet that holds the position', /acct \}\)/.test(body) && /_guardAgent\(acct\)/.test(body))
t('the combined view refuses a flip with no owner', /state\.isAllAccounts && !acct/.test(body))
t('both shells carry both buttons', /data-pos-flip/.test(main) && /data-pos-trade/.test(main) && /data-pos-flip/.test(render) && /data-pos-trade/.test(render))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
