// Profit factor is all-time, from net PnL.
//
// "how an account have 3.46 profit factor and also being down -99.7% roe, net pnl -22M" -- then
// "i want profit factor to be based from all time, net pnl". The trade-based figure only saw
// the fills Hyperliquid still serves (its latest 10,000): a few months of small wins after the
// losses. Built from Hyperliquid's all-time PnL curve, gains − losses IS the net PnL, so the
// factor can never again read above 1 on an account that is down.
//
// Also here: the Popular board's accounts are never auto-joined to the Real board -- Visit on
// one put James Wynn and smartestmoney there ("i never said to add them over there").
import fs from 'fs'
import { pnlCurveFactor } from '../../src/pfnet.js'
import { trackRecord } from '../../src/trackrecord.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const curve = (pts) => [['allTime', { pnlHistory: pts.map((v, i) => [i * 864e5, String(v)]), accountValueHistory: [] }]]

console.log('-- the curve --')
// Up 64M, down 110M, up 23M: net -23M. The recent stretch is all gains.
const wynn = curve([0, 40e6, 64e6, -46e6, -40e6, -30e6, -23e6])
const c = pnlCurveFactor(wynn)
t('gains − losses is the all-time net PnL', Math.abs(c.gain - c.loss - (-23e6)) < 1e-6, c)
t('so an account that is down reads below 1', c.pf < 1, c.pf)
t('and one that is up reads above 1', pnlCurveFactor(curve([0, 5, 3, 9])).pf > 1)
t('a curve that only rose: no losses, not infinity', pnlCurveFactor(curve([0, 2, 5])).pf === null && pnlCurveFactor(curve([0, 2, 5])).noLosses === true)
t('a first point away from 0 counts as a step from 0', pnlCurveFactor(curve([-10, -4])).loss === 10 && pnlCurveFactor(curve([-10, -4])).gain === 6)
t('no curve → null, not 0', pnlCurveFactor([]) === null && pnlCurveFactor(null) === null && pnlCurveFactor(curve([5])) === null)
t('bad points are skipped, not read as 0', pnlCurveFactor([['allTime', { pnlHistory: [[0, '0'], [1, 'x'], [2, '4']] }]]).gain === 4)

console.log('-- the Real board\'s track record uses it --')
// Recent closed trades: all wins. The old figure would have been "no losses".
const tr = trackRecord({ windows: { BTC_1: 500, BTC_2: 800, ETH_3: 300 }, portfolio: wynn, openLoss: 1000 })
t('profit factor is the all-time one', Math.abs(tr.profitFactor - c.pf) < 1e-12, tr.profitFactor)
t('and says so', tr.pfBasis === 'net')
t('no "counting open losses" second reading: net PnL already counts them', tr.profitFactorOpen === null)
t('trade figures beside it stay trade-based', tr.trades === 3 && tr.avgWin === 1600 / 3 && tr.wins === 3)
const paper = trackRecord({ windows: { BTC_1: 10, BTC_2: -5 } })
t('without a curve (a paper row) it is the closed-trade figure, and says so', paper.profitFactor === 2 && paper.pfBasis === 'trades')

console.log('-- wiring --')
const render = fs.readFileSync('src/render.js', 'utf8')
t('the account stats cards use it', /const _curve\s+= pnlCurveFactor\(portfolio\)/.test(render) && /_curve \? _curve\.gain/.test(render))
t('and their caption says which basis', /_curve \? 'All-time PnL gains ÷ losses' : 'Closed trades: wins ÷ losses'/.test(render))
const main = fs.readFileSync('src/main.js', 'utf8')
t('the Real board (server, trackrecord.js) and the cards share one definition',
  /import \{ pnlCurveFactor \} from '\.\/pfnet\.js'/.test(fs.readFileSync('src/trackrecord.js', 'utf8')))
t('the All Accounts total sums the all-time figures', /const _pfCurve = pnlCurveFactor\(portfolio\)/.test(main) && /let grossWin = _pfCurve\?\.gain \?\? 0, grossLoss = _pfCurve\?\.loss \?\? 0/.test(main))
t('a Popular account is never auto-joined to the Real board',
  /function _lbJoin\(addr, equity = null\) \{[\s\S]{0,400}KNOWN\.some\(k => k\.addr === String\(addr \?\? ''\)\.toLowerCase\(\)\)\) return Promise\.resolve\(\{ status: 'skip' \}\)/.test(main))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
