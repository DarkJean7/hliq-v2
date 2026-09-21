// Transfers on the PnL calendar.
//
// The calendar kept its own idea of what a transfer was, separate from the Transfers tab, and
// it had drifted twice over:
//
//   • every USDC `send` was booked as a DEPOSIT, whichever way it went — so the three
//     outgoing sends in the report (−$18.81, −$178.40, −$9.35) would have shown on the
//     calendar as "+$206.56 deposited"
//   • spot transfers, spot ↔ perp moves and sub-account transfers did not appear at all
//
// Now there is one rule, ledgerFlow, used by both the Transfers tab's totals and the
// calendar's, and every entry the Transfers tab lists lands on its day.
//
// render.js touches `window` at import, so the suite gives it the smallest stub that lets it
// load, then renders a real calendar into a fake root and reads the HTML back.
import fs from 'fs'

globalThis.window = {}
const nodes = {}
const el = (id) => (nodes[id] ??= { id, innerHTML: '', dataset: {}, _calData: null })
globalThis.document = { getElementById: el, addEventListener() {}, querySelectorAll: () => [], querySelector: () => null }
globalThis.localStorage = { getItem: () => null, setItem() {} }

const { ledgerFlow, ledgerOwner, ledgerAmount, renderPnLCalendar, calDayClick } = await import('../../src/render.js')

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const near = (a, b) => Math.abs(a - b) < 1e-6

const ME    = '0xaa7ad5fa4d99d9bf3397232df7f4523853538159'
const THEM  = '0x1111111111111111111111111111111111111111'
const OTHER = '0x2222222222222222222222222222222222222222'
// Midday, so no timezone can push these across a day boundary.
const day = (d, h = 12) => new Date(2026, 8, d, h, 0, 0).getTime()

const send = (amt, dest, d, h, token = 'USDC') => ({ time: day(d, h), hash: 'h' + amt, delta: {
  type: 'send', user: dest === ME ? THEM : ME, destination: dest, token, amount: String(amt), usdcValue: String(amt), fee: '0' } })

// The report: three outgoing sends on Sep 21.
const LEDGER = [
  send(18.81, THEM, 21, 10),
  send(178.40, OTHER, 21, 11),
  send(9.35, THEM, 21, 12),
  // ...and around them, one of everything else the Transfers tab can list.
  { time: day(20), delta: { type: 'deposit', usdc: '500' } },
  { time: day(19), delta: { type: 'withdraw', usdc: '120', fee: '1' } },
  send(40, ME, 18),                                            // someone sent US money
  { time: day(17), delta: { type: 'spotTransfer', token: 'HYPE', amount: '1', usdcValue: '92.5', user: ME, destination: THEM, fee: '0' } },
  { time: day(16), delta: { type: 'accountClassTransfer', usdc: '300', toPerp: true } },
]

console.log(nl + '-- one rule decides direction --')
{
  const out = LEDGER[0]
  t('an outgoing send is money OUT', near(ledgerFlow(out, ME), -18.81), ledgerFlow(out, ME))
  t('an incoming send is money IN', near(ledgerFlow(LEDGER[5], ME), 40), ledgerFlow(LEDGER[5], ME))
  t('a deposit is in, a withdrawal out', ledgerFlow(LEDGER[3], ME) === 500 && ledgerFlow(LEDGER[4], ME) === -120)
  t('a spot transfer out counts, at its USDC value', near(ledgerFlow(LEDGER[6], ME), -92.5))
  // Moving money between your own pockets is not money arriving.
  t('a spot ↔ perp move is not a flow', ledgerFlow(LEDGER[7], ME) === 0)

  // "transfers in/out should be counted in deposited/withdrawn" — every kind of transfer
  // that crosses the account's edge, not just USDC sends and spot transfers.
  const internalOut = { time: day(15), delta: { type: 'internalTransfer', usdc: '25', user: ME, destination: THEM, fee: '0' } }
  const internalIn  = { time: day(15), delta: { type: 'internalTransfer', usdc: '60', user: THEM, destination: ME, fee: '0' } }
  const subOut      = { time: day(14), delta: { type: 'subAccountTransfer', usdc: '70', user: ME, destination: OTHER } }
  const hypeOut     = send(55, THEM, 14, 12, 'HYPE')
  t('an internal transfer out is a withdrawal', ledgerFlow(internalOut, ME) === -25)
  t('an internal transfer in is a deposit', ledgerFlow(internalIn, ME) === 60)
  t('a sub-account transfer out is a withdrawal', ledgerFlow(subOut, ME) === -70)
  t('a send of any token counts, at its USD value', near(ledgerFlow(hypeOut, ME), -55))

  renderPnLCalendar([], 8, 2026, [internalOut, internalIn, subOut, hypeOut], 'ioRoot', 'ioNav', 'ioDet', ME)
  const io = el('ioRoot')._calData.byDay
  t('the calendar books them as deposited and withdrawn',
    io['2026-09-15'].deposited === 60 && io['2026-09-15'].withdrawn === 25 &&
    near(io['2026-09-14'].withdrawn, 125) && io['2026-09-14'].deposited === 0, io)

  // The combined view's address is a sentinel, not an account. Signing a send against it
  // reads every incoming send as outgoing — so it is refused, and the entry's own wallet wins.
  t('the combined-view sentinel is not an owner', ledgerOwner(out, '__all_accounts__') === null)
  t('an entry tagged with its wallet uses that wallet', ledgerOwner({ ...out, _acctAddr: ME }, '__all_accounts__') === ME)
  t('so direction survives the combined view', near(ledgerFlow({ ...out, _acctAddr: ME }, '__all_accounts__'), -18.81))
}

console.log(nl + '-- the calendar puts every transfer on its day --')
{
  renderPnLCalendar([], 8, 2026, LEDGER, 'calRoot', 'calNav', 'calDet', ME)
  const byDay = el('calRoot')._calData.byDay
  const k = (d) => `2026-09-${String(d).padStart(2, '0')}`

  t('the three sends are on the 21st', byDay[k(21)]?.transfers === 3, byDay[k(21)])
  // THE bug. The old code booked all three as deposits.
  t('as money out, not money in', near(byDay[k(21)].withdrawn, 18.81 + 178.40 + 9.35) && byDay[k(21)].deposited === 0, byDay[k(21)])
  t('an incoming send is a deposit', near(byDay[k(18)].deposited, 40))
  t('a spot transfer appears — it used to be dropped', near(byDay[k(17)].withdrawn, 92.5))
  t('a spot ↔ perp move appears, without moving the totals',
    byDay[k(16)]?.transfers === 1 && byDay[k(16)].deposited === 0 && byDay[k(16)].withdrawn === 0)
  // A transfer is not a trade: best/worst day and the average read pnl and trades only.
  t('and none of them count as trading', Object.values(byDay).every(d => d.trades === 0 && d.pnl === 0))

  const html = el('calRoot').innerHTML
  t('the 21st shows what left', html.includes('WDR -$206.56'), html.match(/WDR[^<]*/g))
  t('the 18th shows what arrived', html.includes('DEP +$40.00'))
  t('the internal move gets a marker so the day is not blank', html.includes('⇄ 1 transfer'))
  t('and every one of those days can be tapped', ['16', '17', '18', '19', '20', '21']
    .every(d => html.includes(`data-key="2026-09-${d}"`)))

  // The month cards agree with the Transfers tab: deposit 500 + received 40, and
  // withdraw 120 + three sends 206.56 + spot 92.5.
  t('the month Deposited agrees with the Transfers tab', html.includes('+$540.00'), html.match(/Deposited[\s\S]{0,120}/)?.[0])
  t('and so does Withdrawn', html.includes('-$419.06'), html.match(/Withdrawn[\s\S]{0,120}/)?.[0])
}

console.log(nl + '-- tapping the day lists them the way the Transfers tab does --')
{
  el('calDet').dataset.activeKey = ''
  calDayClick('2026-09-21', 'calRoot')
  const d = el('calDet').innerHTML
  t('there is a Transfers section', d.includes('>Transfers<'))
  t('each send is named Send', (d.match(/>Send</g) ?? []).length === 3, d.match(/badge[^>]*>[^<]*/g))
  t('and signed as money out', d.includes('-$18.81') && d.includes('-$178.40') && d.includes('-$9.35'))
  t('none of them claims to be a deposit', !/Deposit/.test(d))
  t('the day says how many there were', d.includes('3 transfers'))
  // ...and how much moved, at the top where the PnL is — the sum of the rows below it.
  t('and how much they came to', d.includes('3 transfers · $206.56'), d.match(/cal-detail-pill neu">[^<]*/g))

  el('calDet').dataset.activeKey = ''
  calDayClick('2026-09-18', 'calRoot')
  t('an incoming send reads as a deposit', /badge-deposit[^>]*>Deposit</.test(el('calDet').innerHTML) && el('calDet').innerHTML.includes('+$40.00'))

  el('calDet').dataset.activeKey = ''
  calDayClick('2026-09-16', 'calRoot')
  t('a spot ↔ perp move is listed by name', el('calDet').innerHTML.includes('Spot ↔ Perp'))
  // It has no Deposited or Withdrawn pill, so the transfers pill is the only place its size shows.
  t('and its size shows in the header', el('calDet').innerHTML.includes('1 transfer · $300.00'))
}

console.log(nl + '-- the combined views --')
{
  // The multi-account calendars pass no owner; each entry carries its wallet instead. A send
  // between two of your own wallets is out of one and into the other.
  const A = ME, B = THEM
  const between = { time: day(21), delta: { type: 'send', user: A, destination: B, token: 'USDC', amount: '50', usdcValue: '50', fee: '0' } }
  const tagged = [{ ...between, _acctAddr: A, _label: 'Main' }, { ...between, _acctAddr: B, _label: 'Spartan' }]
  renderPnLCalendar([], 8, 2026, tagged, 'maRoot', 'maNav', 'maDet')
  const bd = el('maRoot')._calData.byDay['2026-09-21']
  t('it is out of one wallet and into the other', bd.deposited === 50 && bd.withdrawn === 50, bd)

  const main = fs.readFileSync('src/main.js', 'utf8')
  t('every multi-account calendar tags its ledger with the wallet',
    (main.match(/_acctAddr: e\._acctAddr \?\? r\.addr/g) ?? []).length === 3)
  // Nine call sites and they have to agree — the single-account ones say whose ledger it is.
  const calls = main.match(/renderPnLCalendar\([^\n]*/g) ?? []
  t('every single-account calendar passes its owner',
    calls.filter(c => c.includes('state.ledger') || c.includes(', ledger,')).every(c => c.includes('state.addr)')),
    calls.filter(c => !c.includes('state.addr)') && !c.includes('allLedger')))
}

console.log(nl + '-- one rule, one copy --')
{
  const rnd = fs.readFileSync('src/render.js', 'utf8')
  t('the Transfers tab totals with ledgerFlow', /for \(const e of ledger\) \{\s*const v = ledgerFlow\(e, addr\)/.test(rnd))
  t('and the calendar with the same', /const v = ledgerFlow\(e, owner\)/.test(rnd))
  t('the old deposit-only filter is gone', !rnd.includes("(t === 'send' && e.delta.token === 'USDC')"))
  // ledgerAmount is still the signed amount of a row; ledgerFlow is which rows count.
  t('ledgerAmount is unchanged underneath', near(ledgerAmount(LEDGER[0], ME), -18.81))
}

console.log(nl + `${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
