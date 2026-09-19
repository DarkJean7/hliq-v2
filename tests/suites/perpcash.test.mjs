// Telling a margin transfer apart from a trade.
//
// Reported as: "when orders are placed/closed etc the account equity of single and all
// accounts spikes a lot with fake value and then fixes itself."
//
// Every equity figure in the app is `snapshot + (live perp equity - perp equity when the
// snapshot was taken)`. That is only sound while every move in perp equity is a move in the
// ACCOUNT's value, and on a unified account it is not: Hyperliquid moves USDC between the
// spot and perp sides on its own to fund a position's margin or to reserve it for a resting
// order. Perp equity jumps, the account is worth what it was, and the bridge publishes the
// transfer as profit until the next snapshot lands.
//
// Straight out of the eqstep log, which is what settled this rather than screenshots:
//
//   02:04:28  step +181.41 -> 7100.64   perpBase=3602.76  livePerp=3823.75  snapAge=206s
//             worstWallet=0x25A267  worstAcctDelta=+185.49  moved=2
//   02:04:40  step -270.20 -> 6830.89   snapMoved=1  perpBase=3823.62  livePerp=3823.71
//
// One wallet's perp equity up $185.49 in 1.5 seconds with every other row flat, the combined
// total up with it, and the next server snapshot putting it straight back twelve seconds
// later. Nothing earned $185 in a second and a half.
import fs from 'fs'
import { mainPositions, posFingerprint, perpCash, cashSample, classifyCashMove, CASH_TOL } from '../../src/perpcash.js'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const P = (coin, szi, uPnl) => ({ position: { coin, szi: String(szi), unrealizedPnl: String(uPnl) } })

console.log(nl + '-- perp cash is what the market cannot move --')
{
  const held = [P('BTC', '0.5', '120'), P('ETH', '-2', '-40')]
  t('cash takes unrealized back out', perpCash('1000', held) === 1000 - 80)
  // The whole premise: marks moving change unrealized and leave cash alone, so a change in
  // cash is never the market.
  t('a pure price move leaves it flat',
    perpCash('1200', [P('BTC', '0.5', '320'), P('ETH', '-2', '-40')]) === perpCash('1000', held))
  t('unreadable equity gives null, not a guess', perpCash('nope', held) === null)
  t('no positions is just the balance', perpCash('500', []) === 500)
}

console.log(nl + '-- main dex only, on both halves --')
{
  // marginSummary.accountValue is main-dex, while assetPositions arrives with HIP-3 merged in
  // by the time the app sees it. Summing unrealized across both subtracts builder-dex PnL
  // from a main-dex equity figure, and ordinary HIP-3 drift then reads as a transfer on every
  // single tick.
  const mixed = [P('BTC', '1', '50'), P('xyz:SPCX', '3', '-900')]
  t('a builder-dex position is not counted', perpCash('1000', mixed) === 950)
  t('nor does it enter the fingerprint', posFingerprint(mixed) === 'BTC:1')
  t('mainPositions accepts a bare position too', mainPositions([{ coin: 'BTC', szi: '1' }]).length === 1)
}

console.log(nl + '-- the fingerprint is what separates the two cases --')
{
  t('order does not matter',
    posFingerprint([P('B', '1', '0'), P('A', '2', '0')]) === posFingerprint([P('A', '2', '0'), P('B', '1', '0')]))
  // Size, not just the coin list: a partial fill leaves the same coins open and is still a
  // trade, with realized PnL in it.
  t('a partial fill changes it', posFingerprint([P('A', '2', '0')]) !== posFingerprint([P('A', '1.5', '0')]))
  t('an opened coin changes it', posFingerprint([]) !== posFingerprint([P('A', '1', '0')]))
  t('nothing happening does not', posFingerprint([P('A', '1', '9')]) === posFingerprint([P('A', '1', '-400')]))
}

console.log(nl + '-- and the verdict it produces --')
{
  const at = (av, pos) => cashSample(av, pos)
  const one = [P('BTC', '1', '0')]
  t('marks moving is flat', classifyCashMove(at('1000', one), at('1400', [P('BTC', '1', '400')])).kind === 'flat')
  // The reported case: cash up $185 with every position exactly as it was.
  const tr = classifyCashMove(at('1000', one), at('1185.49', one))
  t('cash up with no position touched is a transfer', tr.kind === 'transfer')
  t('and it reports how much to absorb', Math.abs(tr.delta - 185.49) < 1e-9)
  // A fill moves cash by realized PnL AND by the margin posted or released alongside it, and
  // from here those are one number. Absorbing it would erase the trade's result; publishing
  // it would publish the transfer. Neither is right, so the caller re-reads HL's snapshot.
  t('cash moving with a position is a trade',
    classifyCashMove(at('1000', one), at('1185', [P('BTC', '2', '0')])).kind === 'trade')
  t('no previous reading concludes nothing', classifyCashMove(null, at('1000', one)).kind === 'unknown')
  // Funding settles hourly into cash with no position change, so it reads as a transfer. At
  // these account sizes that is cents an hour and the next snapshot puts it back; a margin
  // transfer is tens or hundreds and lasts until something forces a refresh.
  t('funding-sized noise is below the floor',
    classifyCashMove(at('1000', one), at(String(1000 + CASH_TOL), one)).kind === 'flat')
  t('a dollar is not', classifyCashMove(at('1000', one), at('1001', one)).kind === 'transfer')
}

console.log(nl + '-- both shells run the same check --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
  const grab = (sig) => {
    const i = cli.indexOf(sig)
    if (i < 0) return ''
    let j = cli.indexOf('{', i), d = 0
    for (; j < cli.length; j++) {
      if (cli[j] === '{') d++
      else if (cli[j] === '}') { d--; if (!d) return cli.slice(i, j + 1) }
    }
    return ''
  }
  // The single-account tick had this logic, but behind `if (_fillsTick)` — so it only ran on
  // every 3rd tick at best and every 6th on a tab not showing fills, up to thirty seconds of
  // visible fake equity. The combined view, which is what the report was about, had no check
  // at all: it applied the raw perp delta to eight wallets every twelve seconds.
  const live = grab('function _applyAcctLiveCs(r, cs, hip3Override)')
  t('the combined live tick samples cash', live.includes('cashSample(perpNow, mainPos)'))
  t('a transfer moves that row anchor', live.includes("_move.kind === 'transfer'") && live.includes('r._perpBase = '))
  t('a fill re-reads the snapshot for that wallet', live.includes('_maReanchorRow(r.addr)'))
  t('and the reading is remembered for next time', live.includes('if (_sample) r._cash = _sample'))
  t('the telemetry that settled it is on the record', live.includes('$185.49'))

  const re = grab('async function _maReanchorRow(addr)')
  t('the re-read pairs snapshot and anchor', re.includes('row._portVal  = snapVal') && re.includes('row._perpBase = perpAt'))
  t('snapshot first, anchor second', re.indexOf('info.portfolio') < re.indexOf('info.clearinghouseState'))
  t('it is throttled per wallet', re.includes('_MA_REANCHOR_MS'))
  t('and it refuses to add to a rate-limit storm', re.includes('_hlLimited()'))
  t('the cached pair is updated too, or a later fan restores the stale one', re.includes('perpAtHist: perpAt'))

  // A row built by the heavy fan-out must start with a reading, or its first live tick has
  // nothing to compare against and the next transfer goes through unnoticed.
  t('a freshly fanned row is seeded', cli.includes('_cash: cashSample(_perpAcctVal, positions)'))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
