// Pacing the app against Hyperliquid's rate bucket.
//
// HL allows 1200 weight/min per IP, shared between /info and /exchange — so overspending it
// does not merely stall the dashboard, it starves ORDER PLACEMENT. That is the harm.
//
// The limiter behaves like a bucket refilling at ~20 weight a second, and an AVERAGE cannot
// see the failure. Measured on a cold All Accounts load with eight wallets:
//
//     60-second average      992 weight/min    83% of budget   — looks fine
//     peak in any 10s window  1240             refill over 10s is ~200
//     98 requests, every one of them inside 8.0 seconds
//
// Six times the refill rate, while the average said there was headroom.
//
// Clock is injected throughout, so a minute of pacing behaviour runs instantly. A bug that
// only appears forty seconds in is exactly the one nobody re-runs a sleeping test to find.
import fs from 'fs'
import { createBudget, weightOf, HL_BUDGET, HL_REFILL_PER_SEC, HL_RESERVE, SHARE, SHARE_MS } from '../../src/hlbudget.js'

const nl = String.fromCharCode(10)
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

// A controllable clock.
const clock = () => { let ms = 1_000_000; return { now: () => ms, advance: (s) => { ms += s * 1000 } } }

console.log(nl + '-- the documented weights --')
{
  t('cheap endpoints are 2', weightOf('clearinghouseState') === 2 && weightOf('allMids') === 2)
  t('userRole is the expensive outlier', weightOf('userRole') === 60)
  t('everything else is 20', weightOf('frontendOpenOrders') === 20 && weightOf('portfolio') === 20)
  t('including anything unrecognised, which is the safe way to guess', weightOf('somethingNew') === 20)
  t('the budget is HL\'s documented one', HL_BUDGET === 1200 && HL_REFILL_PER_SEC === 20)
}

console.log(nl + '-- a full bucket costs nothing, which is the common case --')
{
  const c = clock()
  const b = createBudget({ now: c.now })
  t('it starts full', b.level() === HL_BUDGET)
  // One wallet's cold fan is about 84 weight. Eight of them is ~670, which fits under the
  // spendable 900 — so a cold load on a rested bucket must not wait at all, or this change
  // would have made every app open slower for nothing.
  let waited = 0
  for (let i = 0; i < 8; i++) { waited += b.waitFor(84); b.spend(84) }
  t('eight wallets go through with no wait at all', waited === 0, String(waited))
  t('and the bucket is drawn down by what they spent', Math.round(b.level()) === HL_BUDGET - 8 * 84)
}

console.log(nl + '-- and it refuses to spend the reserve --')
{
  const c = clock()
  const b = createBudget({ now: c.now })
  // Spend down to exactly the reserve.
  b.spend(HL_BUDGET - HL_RESERVE)
  t('the next request has to wait', b.waitFor(20) > 0)
  // 20 weight at 20/sec is one second.
  t('for precisely as long as the refill needs', b.waitFor(20) === 1000, String(b.waitFor(20)))
  c.advance(1)
  t('and after that second it is free', b.waitFor(20) === 0, String(b.waitFor(20)))
  // The reserve is the part that protects trading: whatever the dashboard is doing, this much
  // is always there for an order and its cancels.
  t('the reserve was never dipped into', b.level() >= HL_RESERVE, String(Math.round(b.level())))
}

console.log(nl + '-- the peak is what it flattens --')
{
  // Replay the measured load: eight wallets at ~84 weight, back to back, and see how long
  // the bucket makes it take. Unpaced it was 8 seconds; the bucket should stretch it only
  // once the spendable budget runs out, and not a moment before.
  const c = clock()
  const b = createBudget({ now: c.now })
  let elapsed = 0
  for (let i = 0; i < 20; i++) {
    const ms = b.waitFor(84)
    if (ms > 0) { c.advance(ms / 1000); elapsed += ms / 1000 }
    b.spend(84)
  }
  // 20 wallets is 1680 weight. Spendable is 900, so the other 780 has to be refilled at
  // 20/sec: 39 seconds, give or take a wallet's rounding.
  t('twenty wallets are spread over the time the refill needs', elapsed > 35 && elapsed < 45, elapsed.toFixed(1) + 's')
  t('and the reserve survives all of it', b.level() >= HL_RESERVE - 1, String(Math.round(b.level())))
  // The rate it settles at IS the refill rate — which is the definition of not over-drawing.
  const spentAfterHeadroom = 20 * 84 - (HL_BUDGET - HL_RESERVE)
  t('the sustained rate is the refill rate', Math.abs(spentAfterHeadroom / elapsed - HL_REFILL_PER_SEC) < 1.5)
}

console.log(nl + '-- a 429 means the model was wrong --')
{
  const c = clock()
  const b = createBudget({ now: c.now })
  t('it thinks it is full', b.level() === HL_BUDGET)
  b.drain()
  t('a 429 empties it, whatever it believed', b.level() === 0)
  t('so the next request backs right off', b.waitFor(20) === Math.ceil(((20 + HL_RESERVE) / HL_REFILL_PER_SEC) * 1000))
  c.advance(60)
  t('a minute later it has refilled — but only to its share: after a 429 the IP is assumed shared', b.level() === HL_BUDGET * SHARE, b.level())
  t('and it says so', b.shared() === true)
  c.advance(SHARE_MS / 1000)
  t('ten minutes on, the whole bucket is its own again', b.shared() === false && Math.round(b.level()) === HL_BUDGET, b.level())
}

console.log(nl + '-- it cannot deadlock, and it cannot lie --')
{
  const c = clock()
  const b = createBudget({ now: c.now })
  // A request larger than the whole spendable budget can never satisfy the reserve. Waiting
  // forever would hang the load; being slightly over is recoverable, never loading is not.
  t('an impossible request still goes through on a full bucket', b.waitFor(HL_BUDGET) === 0)
  b.spend(HL_BUDGET)
  t('and waits for a full bucket rather than forever', b.waitFor(HL_BUDGET) === 60000, String(b.waitFor(HL_BUDGET)))
  // spend() must describe reality even when the caller had to proceed anyway.
  b.drain(); b.spend(100)
  t('an overspend is recorded, not clamped away', b.level() === -100)
  c.advance(10)
  t('and refills from there, at the shared rate after a 429', Math.round(b.level()) === -100 + 10 * HL_REFILL_PER_SEC * SHARE, b.level())
}

console.log(nl + '-- and the app actually paces with it --')
{
  const cli = fs.readFileSync('src/main.js', 'utf8')
  const bud = fs.readFileSync('src/hlbudget.js', 'utf8')
  const api = fs.readFileSync('src/api.js', 'utf8')
  // One bucket, because the limit is per IP. main.js and api.js hold separate transports and
  // HL counts them together; two budgets tracking halves of one limit would each believe it
  // had headroom.
  t('there is one bucket for the whole app, starting half full (another device may have just spent it)', bud.includes('export const hlBudget = createBudget({ startLevel: HL_BUDGET / 2, store: localStore })'))
  t('heavy history reads may wait longer than a balance', bud.includes("w >= 20 ? maxWaitHeavyMs : maxWaitMs") && bud.includes('export const HL_MAX_WAIT_HEAVY_MS = 30_000'))
  t('a 429 hidden by CORS ("network-shaped") drains the bucket too — most trips are that kind', /_hlLastTripReason = 'network-shaped'[\s\S]{0,600}_hlBudget\.drain\(\)/.test(cli))
  t('and the reason it is a singleton is written down', bud.includes('because the limit is per IP'))
  t('main.js spends from it', cli.includes("import { hlBudget as _hlBudget, meterTransport"))
  t('and so does api.js, or half the traffic would be invisible',
    api.includes("import { meterTransport } from './hlbudget.js'") && api.includes('meterTransport(new HttpTransport'))

  // Every request is metered at the transport, which is what makes the reserve mean anything:
  // pacing only the wallet fan left the metas, the HIP-3 probes and every poll loop
  // unaccounted, so the model thought it had spent 670 while the wire carried 1196.
  t('the meter sits on the one funnel every client shares', bud.includes('transport.request = async (endpoint, payload, signal)'))
  t('and it is applied once, never twice', bud.includes('transport.__metered'))
  // Ask and claim in the same step. One wallet's fan fires six requests through Promise.all;
  // spending after the wait let all six read the same level and all six go at once.
  t('weight is claimed before the wait, not after',
    /const ms = endpoint === 'info'[\s\S]{0,80}budget\.spend\(w\)[\s\S]{0,120}await new Promise/.test(bud))
  t('why that race mattered is on the record', bud.includes('check-then-act race'))
  // /exchange shares the budget, so it is counted — but throttling trading to protect the
  // dashboard would invert the entire point.
  t('order placement is metered but never delayed', bud.includes("endpoint === 'info' ? Math.min"))
  t('and that is stated in capitals, because it is the point',
    bud.includes('ORDER PLACEMENT IS NEVER DELAYED'))
  // A drained bucket can ask for a minute; a tab that fetches on open would look frozen.
  t('a single wait is bounded', bud.includes('export const HL_MAX_WAIT_MS'))
  t('the wallet fan waits on it', cli.includes('if (i > 0) await _hlPace(_WALLET_FAN_WEIGHT)'))
  // The fixed 650ms stagger it replaced could not work: the right gap depends on what the
  // rest of the app just spent.
  t('the fixed stagger is gone', !cli.includes('entries.length > 4 ? 650 : 350'))
  t('why it could not work is on the record', cli.includes('It could not work: the right gap depends on'))
  t('a real 429 empties the model', cli.includes("_hlLastTripReason = 'real-429'; _hlBudget.drain()"))
  t('the per-wallet cost is derived from the documented weights, not guessed',
    cli.includes('const _WALLET_FAN_WEIGHT = _hlWeightOf('))
}

console.log(nl + '-- the bucket outlives the page ("got rate limited for just entering the app") --')
{
  // A reload one second after a page spent 900 used to start from a fresh model while the real
  // bucket was nearly empty — a 429 at sinceLoad=1s, ten wallets.
  const c = clock()
  let saved = null
  const store = { load: () => saved, save: (v) => { saved = JSON.parse(JSON.stringify(v)) } }
  const a = createBudget({ now: c.now, store })
  a.spend(900)
  c.advance(1)
  const b = createBudget({ now: c.now, startLevel: HL_BUDGET / 2, store })
  t('a reload continues from what was spent, refilled for the time since', Math.abs(b.level() - (HL_BUDGET - 900 + HL_REFILL_PER_SEC)) < 1e-6, b.level())
  t('so the first burst after it waits', b.waitFor(200) > 0)
  // Two tabs on one device, one IP: each sees the other's spend.
  const c2 = clock(); let sv = null
  const st2 = { load: () => sv, save: (v) => { sv = { ...v } } }
  const x = createBudget({ now: c2.now, store: st2 }), y = createBudget({ now: c2.now, store: st2 })
  x.spend(500)
  t('a second tab sees what the first spent', y.level() === HL_BUDGET - 500, y.level())
  y.drain()
  // The other tab sees the bucket emptied, but not the ten-minute "shared" guess: carried across
  // pages, that guess kept every reload after one 429 crawling at half rate with equity on dashes.
  t('and a 429 in one tab empties the bucket for the other', x.level() === 0)
  t('but the shared-for-ten-minutes guess stays with the page that got it', y.shared() && !x.shared())
  const c3 = clock(); let s3 = null
  const st3 = { load: () => s3, save: (v) => { s3 = { ...v } } }
  createBudget({ now: c3.now, store: st3 }).drain()
  c3.advance(5)
  const r3 = createBudget({ now: c3.now, store: st3 })
  t('a reload five seconds after a 429 refills at the full rate, not half', r3.level() === 5 * HL_REFILL_PER_SEC && !r3.shared(), r3.level())
  // Nothing stored, or garbage: the half-full start, never a crash.
  const g = createBudget({ now: c.now, startLevel: 600, store: { load: () => ({ level: 'x' }), save() {} } })
  t('an unreadable record falls back to the start level', g.level() === 600)
  const th = createBudget({ now: c.now, startLevel: 600, store: { load() { throw new Error('denied') }, save() { throw new Error('denied') } } })
  th.spend(10)
  t('and storage that throws (private mode) costs nothing', th.level() === 590)
}

console.log(nl + '-- no read of /info bypasses the bucket --')
{
  // The chart's candles, the history drawdown and the game's sparkline called fetch directly,
  // so a cold load drew weight the model never saw.
  const direct = ['src/main.js', 'src/render.js', 'src/game.js'].filter(f => fs.readFileSync(f, 'utf8').includes("fetch('https://api.hyperliquid.xyz/info'"))
  t('main.js, render.js and game.js post to /info only through hlInfo', direct.length === 0, direct)
  t('and each imports it', ['src/main.js', 'src/render.js', 'src/game.js'].every(f => /import \{[^}]*hlInfo as _hlInfo[^}]*\} from '\.\/hlbudget\.js'/.test(fs.readFileSync(f, 'utf8'))))
  t('hlInfo claims its weight before it waits, like the transport', /const w = weightOf\(body\?\.type\)\r?\n\s*const ms = [^\n]*\n\s*budget\.spend\(w\)\r?\n\s*if \(ms > 0\) await/.test(fs.readFileSync('src/hlbudget.js', 'utf8')))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
