// "why some accounts dont show the roe" — a wallet that withdrew its profits had a negative
// start (value - net) and so no ROE, which sorted the board's best performers to the bottom.
// ROE now falls back to every dollar that came in (src/depositbasis.js).
import fs from 'fs'
import { inflowOf, depositStep } from '../../src/depositbasis.js'
import { accountRoe, partRoe } from '../../src/roe.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const ME = '0x974e08000000000000000000000000000001e6b'.slice(0, 42)
const OTHER = '0x1111111111111111111111111111111111111111'
const e = (time, delta) => ({ time, delta })

console.log('\n-- what counts as money in --')
t('a bridge deposit', inflowOf(e(1, { type: 'deposit', usdc: '500' }), ME) === 500)
t('a send received from another wallet', inflowOf(e(1, { type: 'send', user: OTHER, destination: ME, usdcValue: '250' }), ME) === 250)
t('an internal transfer received', inflowOf(e(1, { type: 'internalTransfer', user: OTHER, destination: ME.toUpperCase(), usdc: '40' }), ME) === 40)
t('NOT a send this wallet made', inflowOf(e(1, { type: 'send', user: ME, destination: OTHER, usdcValue: '250' }), ME) === 0)
t('NOT a withdrawal', inflowOf(e(1, { type: 'withdraw', usdc: '900' }), ME) === 0)
t('NOT a spot <-> perp move inside the account', inflowOf(e(1, { type: 'accountClassTransfer', usdc: '300', toPerp: true }), ME) === 0)
t('NOT a rewards claim', inflowOf(e(1, { type: 'rewardsClaim', amount: '12' }), ME) === 0)
t('nothing without an address to judge by', inflowOf(e(1, { type: 'deposit', usdc: '5' }), '') === 0)

console.log('\n-- carried forward like the fills --')
{
  const a = depositStep(null, [e(10, { type: 'deposit', usdc: '100' }), e(10, { type: 'deposit', usdc: '50' })], ME)
  t('two entries in the same millisecond both count', a.deposited === 150 && a.lastLedgerTs === 10, a)
  const b = depositStep(a, [e(10, { type: 'deposit', usdc: '100' }), e(20, { type: 'deposit', usdc: '25' })], ME)
  t('a re-read of what was counted is not counted again', b.deposited === 175 && b.lastLedgerTs === 20, b)
  t('an empty read changes nothing', JSON.stringify(depositStep(b, [], ME)) === JSON.stringify(b))
}

console.log('\n-- ROE --')
{
  // Spartan as reported: +$922.45 on an account now worth $518.57.
  const spartan = { accountValue: 518.57, netPnl: 922.45 }
  t('without deposits it is unknown, as before', accountRoe(spartan) === null)
  t('with them it is a return on what was put in', Math.abs(accountRoe({ ...spartan, deposited: 1000 }) - 92.245) < 1e-9, accountRoe({ ...spartan, deposited: 1000 }))
  t('a parts figure uses the same basis', Math.abs(partRoe(461.225, { ...spartan, deposited: 1000 }) - 46.1225) < 1e-9)
  // Every other row is unchanged: the start value still wins whenever it is usable.
  const near = { accountValue: 781.34, netPnl: 349.46, deposited: 5000 }
  t('a row whose start is usable keeps it', Math.abs(accountRoe(near) - 349.46 / (781.34 - 349.46) * 100) < 1e-9)
  t('deposits too small to divide by are still unknown', accountRoe({ ...spartan, deposited: 0.5 }) === null)
}

console.log('\n-- the server reads and serves it --')
{
  const srv = fs.readFileSync('server.js', 'utf8')
  t('the row refresh reads the ledger incrementally', /userNonFundingLedgerUpdates', user: addr, startTime: start/.test(srv))
  t('and serves deposited', srv.includes('deposited: Number.isFinite(dep.deposited)'))
  t('but not its cursor', srv.includes('.map(({ lastFillTs, lastFundingTs, lastLedgerTs,'))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
