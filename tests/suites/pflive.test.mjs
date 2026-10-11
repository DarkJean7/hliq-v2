// A /portfolios basket run live (src/pflive.js + strategies/portfolio.js): the decisions, by hand.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = '\n'
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e * Math.max(1, Math.abs(b))

const L = await import('../../src/pflive.js')
const D = 86_400_000
const T0 = Date.UTC(2026, 0, 1)            // a Thursday, the 1st

console.log(nl + '-- what the bot trades --')
{
  const { weights, skipped } = L.liveWeights([{ coin: 'BTC', w: 50 }, { coin: 'ETH', w: 25, side: 'short' }, { coin: '@107', w: 25, kind: 'spot' }, { coin: 'SOL', w: 0 }])
  t('spot is skipped and named; its weight is spread over the rest', skipped.join() === '@107' && near(weights.BTC, 2 / 3) && near(weights.ETH, -1 / 3) && !('SOL' in weights), [weights, skipped])
  t('leverage is capped at the market maximum; Max is the maximum', L.liveLeverage(5, 3) === 3 && L.liveLeverage('max', 40) === 40 && L.liveLeverage(2, 10) === 2 && L.liveLeverage(5, null) === 1)
}

console.log(nl + '-- the first day buys the weights --')
const W = { BTC: 0.5, ETH: 0.5 }
const px = { BTC: 100, ETH: 10 }
{
  const led = L.freshLedger(1000, 'hold', T0)
  const d = L.decide({ strategy: 'hold', weights: W, ledger: led, px, now: T0 })
  t('buy & hold: $500 of each', d.due && near(d.targets.BTC, 5) && near(d.targets.ETH, 50), d)
  const d3 = L.decide({ strategy: 'hold', weights: W, ledger: led, px, levBy: { BTC: 3, ETH: 2 }, now: T0 })
  t('with leverage, each at its own: BTC 3× = $1,500, ETH 2× = $1,000', near(d3.targets.BTC * 100, 1500) && near(d3.targets.ETH * 10, 1000))
  const short = L.decide({ strategy: 'hold', weights: { BTC: -1 }, ledger: led, px, now: T0 })
  t('a short holding is negative units', near(short.targets.BTC, -10))
  const noPx = L.decide({ strategy: 'hold', weights: W, ledger: led, px: { BTC: 100 }, now: T0 })
  t('a market with no price holds everything still, and says which', !noPx.due && /ETH/.test(noPx.reason))
  const after = { ...led, lastRebal: T0, units: { BTC: 5, ETH: 50 }, cash: 0 }
  t('and then never trades again', !L.decide({ strategy: 'hold', weights: W, ledger: after, px, now: T0 + 40 * D }).due)
}

console.log(nl + '-- calendars --')
{
  const after = (t0) => ({ ...L.freshLedger(1000, 'monthly', T0), lastRebal: t0, units: { BTC: 5, ETH: 50 }, cash: 0 })
  const due = (s, now, params = {}) => L.decide({ strategy: s, params, weights: W, ledger: after(T0), px, now }).due
  t('monthly: on the day of the month asked for, not the day before', due('monthly', Date.UTC(2026, 1, 15, 9), { monthDay: 15 }) && !due('monthly', Date.UTC(2026, 1, 14, 9), { monthDay: 15 }))
  t('monthly: once that day, not on every check', !L.decide({ strategy: 'monthly', params: { monthDay: 15 }, weights: W, ledger: after(Date.UTC(2026, 1, 15, 1)), px, now: Date.UTC(2026, 1, 15, 9) }).due)
  t('weekly: on the weekday asked for (Jan 5 2026 is a Monday)', due('weekly', Date.UTC(2026, 0, 5, 3), { weekDay: 1 }) && !due('weekly', Date.UTC(2026, 0, 6, 3), { weekDay: 1 }))
  // The drift band: BTC doubled, so it is 2/3 of the book against a weight of 1/2.
  const drifted = { ...after(T0), units: { BTC: 5, ETH: 50 } }
  const band = L.decide({ strategy: 'band', params: { band: 0.1 }, weights: W, ledger: drifted, px: { BTC: 200, ETH: 10 }, now: T0 + 3 * D })
  t('drift band: 16.7 points off a 10-point band rebalances, back to half each', band.due && near(band.targets.BTC * 200, 750) && near(band.targets.ETH * 10, 750), band)
  t('and inside the band it holds', !L.decide({ strategy: 'band', params: { band: 0.2 }, weights: W, ledger: drifted, px: { BTC: 200, ETH: 10 }, now: T0 + 3 * D }).due)
}

console.log(nl + '-- DCA --')
{
  let led = L.freshLedger(800, 'dca', T0)
  const p = { dcaEvery: 7, dcaBuys: 4, dcaUpfront: 0 }
  const d1 = L.decide({ strategy: 'dca', params: p, weights: W, ledger: led, px, now: T0 })
  t('the first buy releases a quarter of the reserve and invests it', d1.due && near(d1.release, 200) && near(d1.targets.BTC * 100, 100), d1)
  led = { ...led, reserve: 600, cash: 0, units: { BTC: 1, ETH: 10 }, lastRebal: T0, dcaDone: 1 }
  t('the next waits a week', !L.decide({ strategy: 'dca', params: p, weights: W, ledger: led, px, now: T0 + 6 * D }).due && L.decide({ strategy: 'dca', params: p, weights: W, ledger: led, px, now: T0 + 7 * D }).due)
  const up = L.decide({ strategy: 'dca', params: { ...p, dcaUpfront: 0.5 }, weights: W, ledger: L.freshLedger(800, 'dca', T0), px, now: T0 })
  t('half up front: $400 on day one plus the first of four $100 buys', near(up.release, 500), up.release)
  t('after the last buy it holds', !L.decide({ strategy: 'dca', params: p, weights: W, ledger: { ...led, dcaDone: 4 }, px, now: T0 + 90 * D }).due)
}

console.log(nl + '-- trend filter --')
{
  const led = { ...L.freshLedger(1000, 'trend', T0), lastRebal: T0, lastEval: T0, trendOn: { BTC: true, ETH: true }, units: { BTC: 5, ETH: 50 }, cash: 0 }
  const d = L.decide({ strategy: 'trend', weights: W, ledger: led, px: { BTC: 90, ETH: 10 }, sma: { BTC: 100, ETH: 9 }, now: T0 + D })
  t('below its average, a holding goes to cash; the other keeps its share', d.due && d.targets.BTC === 0 && d.targets.ETH > 0 && d.trendOn.BTC === false, d)
  t('checked once a day', /today/.test(L.decide({ strategy: 'trend', weights: W, ledger: { ...led, lastEval: T0 + D + 5 }, px, sma: {}, now: T0 + D + 10 }).reason))
  const buf = L.decide({ strategy: 'trend', params: { trendBuffer: 0.05 }, weights: W, ledger: led, px: { BTC: 98, ETH: 10 }, sma: { BTC: 100, ETH: 9 }, now: T0 + D })
  t('with a 5% buffer, 2% under the average is not enough to leave', !buf.due && buf.trendOn.BTC === true, buf)
}

console.log(nl + '-- orders --')
{
  const { orders, tooSmall } = L.ordersFor({ BTC: 5, ETH: 50 }, { BTC: 3.75, ETH: 75, SOL: 0.05 }, { BTC: 200, ETH: 10, SOL: 100 }, { BTC: 3, ETH: 1, SOL: 2 })
  t('reductions first and reduce-only; buys after', orders[0].coin === 'BTC' && !orders[0].isBuy && orders[0].reduceOnly && near(orders[0].sz, 1.25) && orders[1].coin === 'ETH' && orders[1].isBuy && !orders[1].reduceOnly, orders)
  t('an order under $10 is left out and named', tooSmall.join() === 'SOL' && !orders.some(o => o.coin === 'SOL'))
  const close = L.ordersFor({ BTC: 0.04 }, { BTC: 0 }, { BTC: 100 }, { BTC: 5 })
  t('a close to zero goes even under $10, reduce-only, the whole of it', close.orders.length === 1 && close.orders[0].reduceOnly && near(close.orders[0].sz, 0.04))
  const fl = L.ordersFor({}, { BTC: 0.123456789 }, { BTC: 100 }, { BTC: 3 })
  t('sizes are floored to the market\'s decimals', fl.orders[0].sz === 0.123)
  const sh = L.ordersFor({ ETH: -50 }, { ETH: -40 }, { ETH: 10 }, { ETH: 1 })
  t('a short made smaller is a reduce-only buy', sh.orders[0].isBuy && sh.orders[0].reduceOnly && sh.orders[0].sz === 10)
}

console.log(nl + '-- the ledger --')
{
  let led = L.freshLedger(1000, 'hold', T0)
  led = L.applyFill(led, 'BTC', 5, 100, 0.001)
  t('a buy moves cash to units and pays its fee', near(led.cash, 1000 - 500 - 0.5) && led.units.BTC === 5 && near(led.fees, 0.5))
  t('equity is cash plus units at the price', near(L.equityOf(led, { BTC: 120 }), 499.5 + 600))
  t('equity with a held market unpriced is unknown, not a number', L.equityOf(led, {}) === null)
  led = L.applyFill(led, 'BTC', -5, 110, 0)
  t('a sale back to zero removes the market', !('BTC' in led.units) && near(led.cash, 1049.5))
  const r = L.reconcile({ ...led, units: { BTC: 5, ETH: -10 } }, { BTC: 2, ETH: -30 })
  t('reconcile: the account holds less BTC than the ledger, so the ledger follows', r.ledger.units.BTC === 2 && r.fixed.length === 1)
  t('holding more than the ledger is someone else\'s position, left alone', r.ledger.units.ETH === -10)
  t('a market not read is not taken as empty', L.reconcile({ ...led, units: { BTC: 5 } }, {}).ledger.units.BTC === 5)
  t('an opposite position means the ledger\'s is gone', !('BTC' in L.reconcile({ ...led, units: { BTC: 5 } }, { BTC: -1 }).ledger.units))
}

console.log(nl + '-- the bot and the server --')
{
  const a = L.liveArgs({ id: 'f-abc', name: 'Test', items: [{ coin: 'BTC', w: 60 }, { coin: 'xyz:NVDA', w: 40, side: 'short' }], strategy: 'monthly', params: { monthDay: 15, junk: 1 }, budget: 500, lev: 'max', margin: 'isolated', run: 'r1' })
  const items = JSON.parse(Buffer.from(a[a.indexOf('--items') + 1], 'base64').toString())
  t('launch args: holdings travel intact, unknown settings are dropped, the run id is always sent', items[1].coin === 'xyz:NVDA' && items[1].side === 'short' && a.includes('--monthDay') && !a.includes('--junk') && a[a.indexOf('--run') + 1] === 'r1' && !a.includes('--fresh'), a)
  const bot = fs.readFileSync(new URL('../../strategies/portfolio.js', import.meta.url), 'utf8')
  const server = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8')
  t('the server knows the bot, and resumes it with --resume', /portfolio:\s*'strategies\/portfolio\.js'/.test(server) && /type === 'portfolio'\)\) \? \['--resume'\]/.test(server))
  t('--fresh can never re-buy on a restart: the same run always carries on', /!args\.fresh \|\| \(RUN && saved\.run === RUN\)/.test(bot))
  t('the key comes from the environment, never argv', /process\.env\.AGENT_KEY/.test(bot))
  t('its orders carry the portfolio bot code (HLIQ_BOT is the type the server spawned it as)', /botCloid\(process\.env\.HLIQ_BOT\)/.test(bot) &&/portfolio:\s*'0e'/.test(fs.readFileSync(new URL('../../src/cloid.js', import.meta.url), 'utf8')))
  t('a rebalance counts as done only when every order filled', /if \(!failed\) ledger = \{ \.\.\.ledger, lastRebal: now/.test(bot))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
