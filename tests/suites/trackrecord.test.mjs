// Leaderboard track record — "add more info like the profit factor … this would allow users to
// see if a wallet they want to copy trade has been profitable in the past".
//
// Win rate was already on the row, and it is the figure most likely to mislead a copier: a
// real wallet on the board wins 84.6% of its trades with an average win of $11.91 and an
// average loss of $46.51. These run the real module.
import fs from 'fs'
import { trackRecord, isSmallSample, SMALL_SAMPLE_TRADES } from '../../src/trackrecord.js'

const cli = fs.readFileSync('src/main.js', 'utf8')
const srv = fs.readFileSync('server.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b) => Math.abs(a - b) < 1e-9
const H = 3_600_000, D = 86_400_000
const hour = (ms) => Math.floor(ms / H)

console.log(nl + '-- the ratios --')
{
  // Three wins of 10, one loss of 45: 75% win rate, and a losing strategy.
  const w = { BTC_100: 10, BTC_101: 10, ETH_100: 10, SOL_102: -45 }
  const r = trackRecord({ windows: w })
  t('four trades', r.trades === 4)
  t('profit factor is gross win over gross loss', near(r.profitFactor, 30 / 45), r.profitFactor)
  t('which is below 1 for a 75% win rate — the point of showing it', r.profitFactor < 1)
  t('average win', near(r.avgWin, 10))
  t('average loss is a magnitude', near(r.avgLoss, 45))
  t('per trade is the net over every trade', near(r.expectancy, -15 / 4), r.expectancy)
  t('best and worst', r.best === 10 && r.worst === -45)
  // A coin name can contain an underscore; the hour is always the last segment.
  t('the hour is read from the last segment of the key',
    trackRecord({ windows: { 'A_B_7': 5 } }).firstTradeAt === 7 * H)
}

console.log(nl + '-- no losses is words, not infinity --')
{
  const r = trackRecord({ windows: { X_1: 5, X_2: 7 } })
  t('profit factor is null, not Infinity', r.profitFactor === null)
  t('and flagged so the row can say "No losses yet"', r.noLosses === true)
  t('the row says it', cli.includes("_T('No losses yet'"))
  const e = trackRecord({ windows: {} })
  t('an empty record is not a lossless one', e.noLosses === false && e.trades === 0)
  t('an empty record renders nothing at all', cli.includes("if (!tr || !tr.trades) return ''"))
}

console.log(nl + '-- length of record, and whether it still trades --')
{
  const now = 1_800_000_000_000
  const w = {}
  for (let d = 0; d < 30; d++) w[`BTC_${hour(now - d * D)}`] = d % 3 ? 5 : -2
  const r = trackRecord({ windows: w, lastFillAt: now - 2 * H })
  t('distinct trading days', r.tradingDays === 30, r.tradingDays)
  t('first trade is the earliest hour', r.firstTradeAt === hour(now - 29 * D) * H)
  t('last fill is carried through', r.lastFillAt === now - 2 * H)
  t('30 trades over 30 days is not a small sample', !isSmallSample(r, now))
  const young = trackRecord({ windows: { BTC_1: 1 } })
  t('a thin record is flagged', isSmallSample(young, now))
  t(`under ${SMALL_SAMPLE_TRADES} trades is flagged even if old`,
    isSmallSample(trackRecord({ windows: { [`BTC_${hour(now - 90 * D)}`]: 1 } }), now))
  t('a stale wallet is called out — a copy of it would never act',
    cli.includes('Has not traded in over two weeks'))
}

console.log(nl + '-- 7D / 30D are Hyperliquid’s own, perp series first --')
{
  const pf = [
    ['week',      { pnlHistory: [[1, '0'], [2, '99']],  accountValueHistory: [] }],
    ['perpWeek',  { pnlHistory: [[1, '0'], [2, '12.5']], accountValueHistory: [] }],
    ['month',     { pnlHistory: [[1, '0'], [2, '300']], accountValueHistory: [] }],
  ]
  const r = trackRecord({ windows: {}, portfolio: pf })
  // Copy trading copies perps. Spot P&L in the 7D figure would describe trades a copy never makes.
  t('the perp week wins over the whole-account week', r.pnl7d === 12.5, r.pnl7d)
  t('falls back to the whole-account series when there is no perp one', r.pnl30d === 300)
  t('absent is null, not zero', trackRecord({ windows: {} }).pnl7d === null)
}

console.log(nl + '-- drawdown --')
{
  const series = (pnl, av) => [
    ['perpAllTime', { pnlHistory: pnl, accountValueHistory: [] }],
    ['allTime',     { pnlHistory: pnl, accountValueHistory: av }],
  ]
  const r = trackRecord({ portfolio: series(
    [[1, '0'], [2, '100'], [3, '40'], [4, '120'], [5, '90']],
    [[1, '1000'], [2, '1100'], [3, '1040'], [4, '1120'], [5, '1090']]) })
  t('the worst peak-to-trough fall of the P&L curve', near(r.maxDrawdown.usd, 60), r.maxDrawdown)
  t('as a share of the most the account held during it', near(r.maxDrawdown.pct, 60 / 1100 * 100), r.maxDrawdown.pct)

  // The real case: $846 lost while the account never held more than $658 — deposits kept
  // covering it. "305%" (the old base) and "128%" help nobody.
  const real = trackRecord({ portfolio: series(
    [[1, '0'], [2, '300'], [3, '-545']],
    [[1, '100'], [2, '277'], [2.5, '658'], [3, '465']]) })
  t('a fall bigger than the capital in play shows dollars only', near(real.maxDrawdown.usd, 845) && real.maxDrawdown.pct === null, real.maxDrawdown)
  const tiny = trackRecord({ portfolio: series([[1, '0'], [2, '5'], [3, '1']], [[1, '20'], [2, '25'], [3, '21']]) })
  t('a tiny account gets no percentage either', tiny.maxDrawdown.pct === null)
  const up = trackRecord({ portfolio: series([[1, '0'], [2, '5'], [3, '9']], [[1, '100'], [3, '109']]) })
  t('a curve that only rose has no drawdown', up.maxDrawdown.usd === 0)
  // P&L, not account value: a withdrawal is not a loss.
  const wd = trackRecord({ portfolio: series([[1, '0'], [2, '50'], [3, '60']], [[1, '1000'], [2, '1050'], [3, '60']]) })
  t('a withdrawal does not read as a drawdown', wd.maxDrawdown.usd === 0, wd.maxDrawdown)
}

console.log(nl + '-- one module, both data paths, both shells --')
{
  t('the server computes it for every row', /import \{ trackRecord, openLossOf \}/.test(srv) && /track: trackRecord\(\{ windows, portfolio/.test(srv))
  t('with the open losses of the positions it just read', srv.includes('openLoss: openLossOf(rawPos)'))
  // The stats endpoint strips the internal accumulators; `track` must survive that.
  const strip = srv.slice(srv.indexOf("path === '/api/leaderboard/stats'"), srv.indexOf("path === '/api/leaderboard/stats'") + 1400)
  const stripped = (strip.match(/\.map\(\(\{([^}]*)\.\.\.row \}\) => row\)/) ?? [])[1]
  t('the stats endpoint strips a known list of internals', typeof stripped === 'string' && stripped.includes('windows'), stripped)
  t('and `track` is not on it', !/\btrack\b/.test(stripped ?? 'track'))
  t('the browser fallback computes the same thing',
    cli.includes('const track        = trackRecord({ windows: _windows, portfolio,'))
  // Paper rows now carry a track record too, so the builder no longer excludes them.
  t('mobile rows show it, before the Copy trade button',
    /if \(r\.addr\) expandHtml \+= _lbTrackHtml\(r\)[\s\S]{0,300}expandHtml \+= opts\.paper \? _lbPaperSocialHtml\(r\) : _lbSocialHtml\(r\)/.test(cli))
  t('desktop rows show it', cli.includes('${_lbTrackHtml(entry)}'))
  t('and desktop can finally copy a wallet from the board',
    /\$\{_lbTrackHtml\(entry\)\}[\s\S]{0,200}\$\{isP \? _lbPaperSocialHtml\(entry\) : _lbSocialHtml\(entry\)\}/.test(cli))
  t('the unit is explained on screen, since a "trade" here is not a fill',
    cli.includes('A trade is every close in one coin within an hour'))
}

console.log(nl + '-- the sign on a losing position --')
{
  // Seen while checking this panel: a -$36.26 position read "$36.26" in red.
  t('a loss keeps its minus sign', cli.includes("${pnl >= 0 ? '+' : '-'}$${fmtUSD(Math.abs(pnl))}"))
  t('the signless form is gone', !cli.includes("${pnl >= 0 ? '+' : ''}$${fmtUSD(Math.abs(pnl))}"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
