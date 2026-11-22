// The Oracle's server-side logger (src/oraclelogger.js) and the reading it logs (src/oraclescore.js).
// "log every coin automatically even if nobody opens it": every main-dex perp, each hour, on the
// server, inside its own slice of the IP's budget.
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createOracleLogger, needs, patchLast, marketsOf, nextCoin, SPAN, LEASE_MS } from '../../src/oraclelogger.js'
import { readingsFor, setupFrom, ZONE_4H_DAYS } from '../../src/oraclescore.js'
import { outlookFor, pastSamples, learnedWeights, coneRecord, coneScale } from '../../src/outlook.js'
import { emptyLog, addEntry, recordOf, OL_HOURS } from '../../src/outlooklog.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const H = 3600e3, D = 24 * H

// A market that walks: deterministic, a year of 4h and 1000 days.
function series(step, n, end, p0 = 100) {
  let p = p0, s = 7
  const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647
  const out = []
  for (let i = n - 1; i >= 0; i--) {
    const o = p; p = p * Math.exp((rnd() - 0.5) * 0.03)
    out.push({ t: end - i * step, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p, v: 1000 })
  }
  return out
}
const NOW = Date.UTC(2026, 10, 22, 13, 20)
const c4 = series(4 * H, 2190, Math.floor(NOW / (4 * H)) * 4 * H), c1 = series(D, 1000, Math.floor(NOW / D) * D), cw = series(7 * D, 400, NOW - 3 * D)

console.log('-- the reading is the tab\'s --')
const px = c4.at(-1).c
const rd = readingsFor({ candles: { '4h': c4, '1d': c1, '1w': cw }, price: px, ratio: 1.2, fundingPctHr: 0.001, hours: OL_HOURS, now: NOW })
t('a reading at every horizon', OL_HOURS.every(h => rd[h] && Number.isInteger(rd[h].score) && rd[h].sigma > 0), rd)
const s = pastSamples(c4, c1), su = setupFrom({ '4h': c4, '1d': c1, '1w': cw }, px, 1.2, null, NOW)
const by = outlookFor({ position: null, price: px, c4, c1, setup: su, ratio: 1.2, fundingPctHr: 0.001, hours: 24, mult: learnedWeights(s, 24), sigmaScale: coneScale(coneRecord(s, 24), 24) })
t('the same score the card draws: learned weights, calibrated cone, levels, book, funding', rd[24].score === by.score.score && rd[24].sigma === by.sigma)
const ana = fs.readFileSync('src/analysis.js', 'utf8')
t('the levels read the same 4h window as the Analysis tab', ana.includes(`const ZONE_4H_DAYS = ${ZONE_4H_DAYS}`) && ana.includes('readSetup({ zones: r.zones, price, atrD: r.atrD, daily: e.candles[\'1d\'], ratio: e.ratio ?? null'))
t('and the same history', ana.includes(`const SPAN = { '4h': ${SPAN['4h'] / D} * 864e5, '1d': ${SPAN['1d'] / D} * 864e5, '1w': ${SPAN['1w'] / D} * 864e5 }`))
t('a partial reading is not logged', Object.keys(readingsFor({ candles: { '4h': c4.slice(-3), '1d': c1.slice(-3), '1w': [] }, price: px, hours: [24], now: NOW })).length === 0
  || readingsFor({ candles: { '4h': c4.slice(-3), '1d': c1.slice(-3), '1w': [] }, price: px, hours: [24], now: NOW })[24] === null)

console.log('-- what it refetches --')
const fresh = { candles: { '4h': c4, '1d': c1, '1w': cw }, at: { '4h': NOW - 20 * 60e3, '1d': NOW - 20 * 60e3, '1w': NOW - 20 * 60e3 } }
t('nothing, within the same 4h candle and day', needs(fresh, NOW).length === 0, needs(fresh, NOW))
t('4h when a new 4h candle has begun', needs(fresh, Math.ceil(NOW / (4 * H)) * 4 * H + 60e3).includes('4h'))
t('daily when the day turns', needs(fresh, Math.ceil(NOW / D) * D + 60e3).includes('1d'))
t('weekly once a day', needs(fresh, NOW + D).includes('1w') && !needs(fresh, NOW + 3 * H).includes('1w'))
t('everything for a market never read', needs(null, NOW).join() === '4h,1d,1w')
const pl = patchLast([{ t: 0, o: 10, h: 11, l: 9, c: 10 }], 12)
t('between reads the forming candle follows the mid', pl[0].c === 12 && pl[0].h === 12 && pl[0].l === 9 && patchLast([], 5).length === 0)

console.log('-- which markets --')
const ms = marketsOf([{ universe: [{ name: 'BTC' }, { name: 'OLD', isDelisted: true }, { name: 'ETH' }] }, [{ funding: '0.0000125' }, {}, { funding: 'x' }]])
t('main-dex perps that trade, funding as % an hour', ms.length === 2 && ms[0].coin === 'BTC' && Math.abs(ms[0].fundingPctHr - 0.00125) < 1e-12 && ms[1].fundingPctHr === null, ms)
t('next: never read this hour, stalest first', nextCoin(['A', 'B', 'C'], { A: 5, B: 3 }, 6 * H) === 'C' && nextCoin(['A', 'B'], { A: 5, B: 3 }, 6 * H) === 'B' && nextCoin(['A'], { A: 6 }, 6 * H + 1) === null)

console.log('-- running, against a stubbed exchange --')
const dir = fs.mkdtempSync(join(os.tmpdir(), 'oracle-'))
let clock = NOW
const calls = []
const book = (mid) => ({ levels: [[{ px: String(mid * 0.999), sz: '100', n: 3 }, { px: String(mid * 0.98), sz: '100', n: 3 }], [{ px: String(mid * 1.001), sz: '80', n: 2 }, { px: String(mid * 1.02), sz: '80', n: 2 }]] })
const raw = (cs) => cs.map(k => ({ t: k.t, o: String(k.o), h: String(k.h), l: String(k.l), c: String(k.c), v: '1' }))
let limited = false
async function info(body) {
  calls.push({ at: clock, body })
  if (limited) { const e = new Error('rate limited'); e.rateLimited = true; throw e }
  if (body.type === 'metaAndAssetCtxs') return [{ universe: [{ name: 'BTC' }, { name: 'ETH' }] }, [{ funding: '0.00001' }, { funding: '0.00002' }]]
  if (body.type === 'candleSnapshot') {
    const src = { '4h': c4, '1d': c1, '1w': cw }[body.req.interval]
    return raw(src.filter(k => k.t >= body.req.startTime))
  }
  if (body.type === 'l2Book') return book(px)
  return {}
}
const log = emptyLog()
const L = createOracleLogger({ dir, info, budgetPerMin: 100, now: () => clock, log: { warn() {} },
  addEntries: (list) => { for (const e of list) addEntry(log, e, e.px, e.t) } })
const spentIn = (from, to) => calls.filter(c => c.at >= from && c.at < to).reduce((s, c) => s + ({ metaAndAssetCtxs: 20, l2Book: 2 }[c.body.type] ?? (20 + Math.ceil(10 / 60))), 0)
// A cold start: two markets never read. Ticks are 15 seconds apart, as serve-prod.js runs them.
for (let i = 0; i < 40 && Object.keys(L._state()?.done ?? {}).length < 2; i++) { await L.tick(); clock += 15e3 }
L.flush()
t('a cold start reads both markets, inside its own ceiling', Object.keys(L._state().done).length === 2)
let worst = 0
for (const c of calls) worst = Math.max(worst, calls.filter(x => x.at > c.at - 60e3 && x.at <= c.at).reduce((s, x) => s + (x.body.type === 'l2Book' ? 2 : x.body.type === 'metaAndAssetCtxs' ? 20 : 20 + Math.ceil(({ '4h': 2190, '1d': 1000, '1w': 400 }[x.body.req.interval]) / 60)), 0))
t('never more than 100 weight in any minute', worst <= 100, worst)
t('every horizon logged for each market, at the book\'s mid', OL_HOURS.every(h => recordOf(log, 'BTC', h).pending === 1 && recordOf(log, 'ETH', h).pending === 1) && log.entries.every(e => Math.abs(e.px - px) < 1e-9))
t('kept on disk per market, for the next worker', fs.existsSync(join(dir, 'BTC.json')) && fs.existsSync(join(dir, 'state.json')))
const before = calls.length
for (let i = 0; i < 8; i++) { await L.tick(); clock += 15e3 }
t('nothing more this hour', calls.length === before && log.entries.length === OL_HOURS.length * 2)

// The next hour, same 4h candle: only the books are read, and the 1h call is logged again.
clock = Math.floor(clock / H) * H + H + 60e3
const c0 = calls.length
for (let i = 0; i < 6; i++) { await L.tick(); clock += 15e3 }
L.flush()
const nextCalls = calls.slice(c0)
t('the next hour reads the books only, not the candles again', nextCalls.length > 0 && nextCalls.every(c => c.body.type === 'l2Book' || c.body.type === 'metaAndAssetCtxs'), nextCalls.map(c => c.body.type))
t('and logs the 1h call again, the 24h one not until its slot', recordOf(log, 'BTC', 1).pending === 2 && recordOf(log, 'BTC', 24).pending === 1)

console.log('-- sharing --')
fs.writeFileSync(join(dir, 'lease'), '999999')
const c1n = calls.length
clock = Math.floor(clock / H) * H + H + 60e3
await L.tick()
t('another worker\'s fresh lease: this one does nothing', calls.length === c1n)
fs.utimesSync(join(dir, 'lease'), new Date(clock - LEASE_MS - 5e3), new Date(clock - LEASE_MS - 5e3))
await L.tick()
t('a lease left for a minute is taken over', calls.length > c1n && fs.readFileSync(join(dir, 'lease'), 'utf8') === String(process.pid))
limited = true
const c2n = calls.length
await L.tick(); clock += 15e3; await L.tick(); clock += 15e3; await L.tick()
t('a 429 stands it down', calls.length === c2n + 1, calls.slice(c2n).map(c => c.body.type))
limited = false
clock += 10 * 60e3
await L.tick()
t('and it resumes ten minutes later', calls.length > c2n + 1)

console.log('-- the server --')
const srv = fs.readFileSync('serve-prod.js', 'utf8')
t('serve-prod runs it every 15 seconds', srv.includes("createOracleLogger({") && srv.includes('setInterval(() => { oracleLogger.tick() }, 15_000)'))
t('its writes go through the log\'s lock', srv.includes('olLocked(log => { let n = 0; for (const e of list) if (addEntry(log, e, e.px, e.t)) n++; return n > 0 })'))
t('a duplicate from a browser is answered without the lock', srv.includes('if (hasEntry(olLoad(), sub, Date.now())) return res.writeHead(204).end()'))
fs.rmSync(dir, { recursive: true, force: true })

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
