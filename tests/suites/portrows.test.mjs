// Portfolio tab: the same rows in both modes, the same profit factor everywhere, and no
// number shown before it is known.
//
// Asked: "why the portfolio tab in single accounts and all accounts differ … single accounts
// are missing total withdrawn. idk if theres other missing data. Also check why this wallet
// has 914 profit factor".
//
//   THE MISSING ROW was not missing data. Six rows were drawn only when non-zero; a wallet
//   that never withdrew had no Total Withdrawn row, while All Accounts — ten wallets summed —
//   did. Checking the wallets involved, four have genuinely withdrawn $0.
//
//   SHOWING THEM AT $0 exposed what hiding them had covered: a new account inherited the
//   PREVIOUS one's ledger (the load seed spreads ...state), so switching from All Accounts to
//   one wallet showed all ten wallets' deposits on it until its own landed — or for good, if
//   that fetch was rate-limited. Funding, loaded in the background, would have read "+$0.00".
//
//   914 was correct for closed trades — $555.53 won, $0.61 lost — on a wallet running grid
//   bots, which never close a losing level. $76 sat in two losing positions. Counting it, ~7.
//   And this tab computed it per fill before fees (940) while the leaderboard computed it per
//   hour after fees (914), and while this tab's own win rate used the leaderboard's unit.
import fs from 'fs'
import { trackRecord, openLossOf } from '../../src/trackrecord.js'

const cli = fs.readFileSync('src/main.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e

const grab = (sig) => {
  const i = cli.indexOf(sig)
  if (i < 0) throw new Error('not found: ' + sig)
  let j = cli.indexOf('{', i), d = 0
  for (; j < cli.length; j++) {
    if (cli[j] === '{') d++
    else if (cli[j] === '}') { d--; if (!d) return cli.slice(i, j + 1) }
  }
}

console.log(nl + '-- profit factor, counting the losses a grid holds open --')
{
  // The real wallet: 165 winning hours, 5 tiny losing ones, two losing grid positions and one
  // winning position that must NOT offset them.
  const w = {}
  for (let i = 0; i < 165; i++) w['NEAR_' + i] = 555.53 / 165
  for (let i = 0; i < 5; i++) w['MEGA_' + (1000 + i)] = -0.61 / 5
  const positions = [
    { position: { coin: 'SOL', unrealizedPnl: '-18.09' } },
    { position: { coin: 'HYPE', unrealizedPnl: '-58.08' } },
    { position: { coin: 'BTC', unrealizedPnl: '12.00' } },
  ]
  const ol = openLossOf(positions)
  t('only losing positions count toward the open loss', near(ol, 76.17), ol)
  t('bare positions work as well as HL wrappers', near(openLossOf([{ unrealizedPnl: '-3' }]), 3))
  const r = trackRecord({ windows: w, openLoss: ol })
  t('closed profit factor is still ~910', r.profitFactor > 900, r.profitFactor)
  t('counting open losses it is ~7', near(r.profitFactorOpen, 555.53 / (0.61 + 76.17), 1e-6), r.profitFactorOpen)
  t('no open losses → no second figure', trackRecord({ windows: w, openLoss: 0 }).profitFactorOpen === null)
  t('unknown open losses → no second figure', trackRecord({ windows: w }).profitFactorOpen === null)
  // A wallet with no closed losses at all still gets the honest figure.
  const lossless = trackRecord({ windows: { A_1: 10 }, openLoss: 40 })
  t('"no losses yet" is qualified by what is being held', lossless.noLosses && near(lossless.profitFactorOpen, 0.25))

  const cell = grab('function _pfCell(tr)')
  t('the second figure is shown only when it changes the picture', cell.includes('po < base * 0.9'))
  t('and names the dollars behind it', cell.includes('counting open losses') && cell.includes('tr.openLoss'))
  t('a four-digit factor is not printed to the cent', cell.includes('v >= 1000 ? Math.round(v).toLocaleString()'))
}

console.log(nl + '-- one formula: the tab, its win rate, and the leaderboard --')
{
  t('the tab takes profit factor from trackRecord', cli.includes('const _pfTrack = trackRecord({ windows,'))
  t('from the same windows as the win rate beside it', /const allW    = Object\.values\(windows\)[\s\S]{0,1200}trackRecord\(\{ windows,/.test(cli))
  // And loss held off-exchange, when the switch counts those holdings as part of the account.
  t('with this account’s losing positions', cli.includes('openLoss: openLossOf(state.perpState?.assetPositions ?? []) + _offexOpenLoss()'))
  t('the per-fill, pre-fee version is gone',
    !cli.includes('const grossWin  = fills.reduce((s, f) => f.closedPnl > 0 ? s + f.closedPnl : s, 0)'))
  t('the leaderboard cell uses the same renderer', cli.includes('const pf = _pfCell(tr)'))
  t('and so does the browser-built row', cli.includes('openLoss: openLossOf([...positions, ...(hip3Res?.positions ?? [])])'))
}

console.log(nl + '-- the same rows in both modes --')
{
  for (const row of ['Net Funding', 'Total Fees', 'Total Volume', 'Total Deposited', 'Total Withdrawn', 'Net Deposited']) {
    const re = new RegExp('\\$\\{[^}]{0,80}\\?\\s*`<div class="mob-v-setting-row"><span>' + row + '</span>')
    t(`${row} is never hidden`, cli.includes(`<span>${row}</span>`) && !re.test(cli))
  }
  t('including on the Accounts overview',
    cli.includes('${depKnown ? \'$\' + fmtUSD(totalWith) : \'—\'}'))
}

console.log(nl + '-- nothing is shown before it is known --')
{
  t('the app starts with no ledger, not an empty one', /currentPeriod:\s*'day',\s*\n\s*ledger:\s*null/.test(cli))
  t('a newly loaded account does not inherit the previous ledger',
    /webData:\s*null, sessionStart: Date\.now\(\),[\s\S]{0,500}ledger:\s*null,/.test(cli))
  t('nor funding', cli.includes('fundingLoaded: false,') && cli.includes('state.fundingLoaded = true'))
  t('the tab dashes an unloaded ledger', cli.includes("${ledgerKnown ? '$' + fmtUSD(totalWithdrawn) : '—'}"))
  t('and fees before any fill has arrived', cli.includes("!fills.length ? '—' :"))
  t('All Accounts has no ledger until every wallet’s has landed',
    cli.includes('ledger:      visible.every(r => r.error || Array.isArray(r.ledgerEntries))'))
  const fl = grab('async function fetchLedger(addr, attempt = 0)')
  t('a slow ledger for an account already left is discarded', fl.includes('if (state.addr !== addr || state.isAllAccounts) return'))
  t('a failed ledger is retried once', fl.includes('if (attempt < 1) setTimeout('))
  // Every reader must survive null now.
  const raw = [...cli.matchAll(/render(?:PnLCalendar|Transfers)\([^)]*state\.ledger(?! \?\?)[,)]/g)].map(m => m[0])
  t('no renderer is handed a raw null ledger', raw.length === 0, raw)
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
