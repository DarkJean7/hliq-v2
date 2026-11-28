// "why some accounts dont display the (roe)": an account that has withdrawn its profits has a
// negative start value, so its ROE needs `deposited` (src/roe.js) — which only the server's rows
// carry. When those rows are past their 15 minutes the board reads each wallet itself, and the
// deposits have to come along from the stale server rows (_lbWithDeposits in main.js).
import fs from 'fs'
import { accountRoe } from '../../src/roe.js'
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); ok ? pass++ : fail++; console.log(ok ? '  PASS' : '  FAIL', n, ok ? '' : `→ ${JSON.stringify(got)} (wanted ${JSON.stringify(want)})`) }
const grab = (src, sig) => {
  const start = src.indexOf(sig); if (start < 0) throw new Error('not found: ' + sig)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1) }
}
const withDeposits = new Function(`${grab(CLI, 'function _lbWithDeposits(')}; return _lbWithDeposits`)()

// HYPE on the board that day: $324.77 now, +$669.43 net, $199.60 deposited.
const own = [{ addr: '0xAB33', accountValue: 324.77, netPnl: 669.43 }, { addr: '0x01a4', accountValue: 322.08, netPnl: -228.78 }]
const server = [{ addr: '0xab33', deposited: 199.6 }, { addr: '0x01A4', deposited: 767.13 }]
t('read by the browser alone, a wallet that withdrew its profits has no ROE', accountRoe(own[0]), null)
const merged = withDeposits(own, server)
t('with the server\'s deposits carried over, it has one: +$669.43 on $199.60', Math.round(accountRoe(merged[0])), 335)
t('a wallet still above its start is unchanged by it', Math.round(accountRoe(merged[1])), Math.round(accountRoe(own[1])))
t('addresses match whatever their case', merged.map(x => x.deposited), [199.6, 767.13])
t('a row that already has deposits keeps its own', withDeposits([{ addr: '0xab33', deposited: 5 }], server)[0].deposited, 5)
t('no server rows → rows untouched', withDeposits(own, null), own)
t('the board\'s fallback goes through it', /return _lbWithDeposits\(await _lbFetchResults\(entries\), stale\)/.test(grab(CLI, 'async function _lbFetchRows(')), true)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
