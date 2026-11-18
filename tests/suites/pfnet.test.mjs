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

// The Real board's track record (server-computed, trackrecord.js) is NOT switched yet: changing
// what the bot server loads restarts it, and the bots with it, on deploy. That waits for a yes.

console.log('-- wiring --')
const render = fs.readFileSync('src/render.js', 'utf8')
t('the account stats cards use it', /const _curve\s+= pnlCurveFactor\(portfolio\)/.test(render) && /_curve \? _curve\.gain/.test(render))
t('and their caption says which basis', /_curve \? 'All-time PnL gains ÷ losses' : 'Closed trades: wins ÷ losses'/.test(render))
const main = fs.readFileSync('src/main.js', 'utf8')
t('the bot server does not load it (so shipping it restarts no bot)',
  !fs.readFileSync('server.js', 'utf8').includes('pfnet.js') && !fs.readFileSync('src/trackrecord.js', 'utf8').includes('pfnet'))
t('the All Accounts total sums the all-time figures', /const _pfCurve = pnlCurveFactor\(portfolio\)/.test(main) && /let grossWin = _pfCurve\?\.gain \?\? 0, grossLoss = _pfCurve\?\.loss \?\? 0/.test(main))
t('a Popular account is never auto-joined to the Real board',
  /function _lbJoin\(addr, equity = null\) \{[\s\S]{0,400}KNOWN\.some\(k => k\.addr === String\(addr \?\? ''\)\.toLowerCase\(\)\)\) return Promise\.resolve\(\{ status: 'skip' \}\)/.test(main))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
