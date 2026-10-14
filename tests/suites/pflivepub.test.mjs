// Running portfolios, publicly (src/pflivepub.js, server.js /api/portfolios/live*).
// Asked: "make the running portfolio visible to every user not just to the deployer …
// performance, graph … pause, stop … only available for the deployer".
import fs from 'fs'
import { parseEquity, parseEvents, downsample, maxDrawdown, visibilityDefault, publicRun, entriesFrom } from '../../src/pflivepub.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const T0 = Date.parse('2026-10-11T22:57:28Z')
const LOG = [
  '[2026-10-11 21:43:41] [START   ] Portfolio "old run" · dca',                     // an earlier run
  '[2026-10-11 21:50:00] [HOLD    ] buy 2 of 8 · equity $1500.00',
  '[2026-10-11 22:57:28] [START   ] Portfolio "insolvent" (F-X) · dca · budget $1000 · leverage 3× cross',
  '[2026-10-11 22:57:35] [REBAL   ] buy 1 of 8',
  '[2026-10-11 22:57:35] [FILL    ] BUY 0.39 HYPE @ $86.36',
  '[2026-10-11 22:57:36] [EQUITY  ] $999.72 of $1000 · fees $0.15',
  '[2026-10-11 23:02:37] [HOLD    ] buy 2 of 8 on 2026-10-18 · equity $1010.00',
  '[2026-10-11 23:07:39] [HOLD    ] buy 2 of 8 on 2026-10-18 · equity $980.00',
  '[2026-10-11 23:09:00] [ERROR   ] 429 Too Many Requests - null',
  '[2026-10-12 00:53:55] [START   ] carrying on from the saved ledger (11 positions)',  // a restart
  '[2026-10-12 00:58:00] [HOLD    ] buy 2 of 8 · equity $1000.00',
].join('\n')

console.log('\n-- the history, from the bot\'s own log --')
const eq = parseEquity(LOG, T0)
t('equity lines of THIS run only (the earlier run is left out)', eq.length === 4 && eq[0][1] === 999.72 && eq.every(([tt]) => tt >= T0), eq)
t('both forms are read: "[EQUITY] $X of" and "equity $X"', eq.map(p => p[1]).join() === '999.72,1010,980,1000')
t('drawdown: the biggest fall from a high', Math.abs(maxDrawdown(eq) - (980 / 1010 - 1)) < 1e-12)
t('downsampling keeps the first and last', (() => { const d = downsample(Array.from({ length: 1000 }, (_, i) => [i, i]), 50); return d.length === 50 && d[0][0] === 0 && d[49][0] === 999 })())

console.log('\n-- what is public --')
const pub = parseEvents(LOG, T0, { sizes: false })
t('a real-money run\'s fills (its position sizes) are never in the public events', !pub.some(e => e.kind === 'FILL') && pub.some(e => e.kind === 'REBAL'))
t('paper (or the owner) sees its fills', parseEvents(LOG, T0, { sizes: true }).some(e => e.kind === 'FILL'))
t('exchange errors are not events; a restart is not news', !pub.some(e => /429/.test(e.text)) && pub.filter(e => e.kind === 'START').length === 1)
t('paper is public by default, real money private', visibilityDefault(['--paper', 's']) === true && visibilityDefault(['--strategy', 'dca']) === false)
const state = { name: 'insolvent', strategy: 'dca', budget: 1000, equity: 1000, fees: 0.15, trades: 11, startedAt: T0, at: T0 + 3600e3, units: { HYPE: 0.39, SOL: -0.3 }, reason: 'buy 2 of 8' }
const real = publicRun({ pid: 'p', state, args: ['--strategy', 'dca', '--leverage', '3'], text: LOG, px: { HYPE: 87, SOL: 113 }, full: true })
t('a real-money run is shown in percent: no budget, equity or fees in dollars', real.budget === undefined && real.equity === undefined && real.fees === undefined && real.ret === 0 && real.costPct > 0)
t('its holdings are shares of the book, shorts marked', Math.abs(real.holdings.reduce((s, h) => s + h.share, 0) - 1) < 1e-9 && real.holdings.find(h => h.coin === 'SOL').short)
t('nothing in it names an address or a key', !/0x[0-9a-f]{8}|secret|agent/i.test(JSON.stringify(real)))
const paper = publicRun({ pid: 'p', state, args: ['--paper', 's'], text: LOG, px: {}, full: true })
t('a paper run shows its dollars', paper.budget === 1000 && paper.equity === 1000 && paper.paper === true)

console.log('\n-- positions, like the leaderboard cards --')
{
  const L = ['[2026-10-12 00:00:00] [FILL    ] BUY 2 HYPE @ $100', '[2026-10-12 00:00:01] [FILL    ] BUY 2 HYPE @ $110', '[2026-10-12 00:00:02] [FILL    ] SELL 1 HYPE @ $120', '[2026-10-12 00:00:03] [FILL    ] SELL 1 ETH @ $50'].join('\n')
  const e = entriesFrom(L, 0)
  t('the entry is the average of its own buys; a partial sell keeps it', e.HYPE.units === 3 && Math.abs(e.HYPE.entry - 105) < 1e-9, e.HYPE)
  t('a sell from flat is a short at its price', e.ETH.units === -1 && e.ETH.entry === 50)
  const st = { budget: 1000, equity: 1000, startedAt: 0, at: 1, units: { HYPE: 3, ETH: -1 } }
  const real = publicRun({ pid: 'p', state: st, args: [], text: L, px: { HYPE: 126, ETH: 45 } })
  const h = real.holdings.find(x => x.coin === 'HYPE'), s2 = real.holdings.find(x => x.coin === 'ETH')
  t('each card: entry, mark and the move in percent (a short gains as price falls)', Math.abs(h.pnlPct - 0.2) < 1e-9 && Math.abs(s2.pnlPct - 0.1) < 1e-9 && s2.short)
  t('a real-money card has no size, value or dollar PnL', h.size === undefined && h.value === undefined && h.pnl === undefined)
  const paper = publicRun({ pid: 'p', state: st, args: ['--paper', 's'], text: L, px: { HYPE: 126, ETH: 45 } })
  t('paper shows size, value and dollar PnL', paper.holdings.find(x => x.coin === 'HYPE').pnl === 63 && paper.holdings.find(x => x.coin === 'HYPE').value === 378)
  const srv = fs.readFileSync('server.js', 'utf8')
  t('a HIP-3 holding is priced by its own dex (CRCL had no share)', srv.includes('const pfDexes = (runs) =>') && srv.includes("{ type: 'allMids', dex: d }"))
  const rv = fs.readFileSync('src/pfrunview.js', 'utf8')
  t('spot ids in the actions are named (@700 becomes its token)', rv.includes('const named = (t) =>') && rv.includes('esc(named(e.text))'))
}

console.log('\n-- the routes --')
{
  const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
  t('the public list serves public runs only', srv.includes("const runs = pfRuns().filter(r => r.isPublic)"))
  t('one run, publicly: public runs only', srv.includes("if (!r || !r.isPublic) return json(res, 404, { ok: false, error: 'not found' })"))
  t('the owner opens a private run by PROVING it is theirs (sign-in, or the paper secret) — not by naming an address',
    /\/api\/portfolios\/mine\/[\s\S]{0,700}requireOwner\(req, res, b\.address/.test(srv) && /\/api\/portfolios\/mine\/[\s\S]{0,700}createHash\('sha256'\)\.update\(String\(b\.secret\)\)/.test(srv))
  t('only the owner can change visibility (real: sign-in; paper: its secret)', /path === '\/api\/portfolio\/visibility'[\s\S]{0,200}requireOwner/.test(srv) && srv.includes("if (act === 'visibility') {"))
  const pt = fs.readFileSync('src/pftrade.js', 'utf8')
  t('Pause and Stop sit behind Manage on your own cards only', pt.includes('class="pf-live-face pf-live-back"') && pt.includes('Only you see these') && !/othersHtml[\s\S]{0,1500}data-live=/.test(pt.slice(pt.indexOf('const othersHtml'), pt.indexOf('el.innerHTML = mineHtml + othersHtml'))))
}

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
