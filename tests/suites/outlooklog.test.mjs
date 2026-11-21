// The Outlook tab's live track record (src/outlooklog.js + serve-prod.js /outlook-log, /outlook-record).
// "do version 2": every rating shown is graded once its horizon has passed, by the server, at the
// server's own price.
import fs from 'fs'
import { cleanSubmission, addEntry, dueEntries, gradeDue, hitOf, recordOf, emptyLog, leanOf, olKey, OL_MAX, OL_GRACE } from '../../src/outlooklog.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const H = 3600e3

console.log('-- what a browser may say --')
t('a good submission', JSON.stringify(cleanSubmission({ coin: 'ETH', hours: 24, score: 42, sigma: 0.03 })) === '{"coin":"ETH","hours":24,"score":42,"sigma":0.03}')
t('HIP-3 and spot names are coins too', !!cleanSubmission({ coin: 'xyz:GOLD', hours: 168, score: -5, sigma: 0.1 }) && !!cleanSubmission({ coin: '@107', hours: 24, score: 0, sigma: 0.02 }))
t('its price, time and lean are never taken', !('px' in cleanSubmission({ coin: 'ETH', hours: 24, score: 42, sigma: 0.03, px: 1, t: 0, lean: 'down' })))
for (const [why, b] of [['an odd horizon', { coin: 'ETH', hours: 12, score: 1, sigma: 0.03 }], ['a score past 100', { coin: 'ETH', hours: 24, score: 101, sigma: 0.03 }],
  ['a fractional score', { coin: 'ETH', hours: 24, score: 1.5, sigma: 0.03 }], ['no volatility', { coin: 'ETH', hours: 24, score: 1, sigma: 0 }],
  ['markup for a coin', { coin: '<b>ETH', hours: 24, score: 1, sigma: 0.03 }], ['nothing', null]]) t(`refused: ${why}`, cleanSubmission(b) === null)

console.log('-- the log --')
const log = emptyLog()
const sub = cleanSubmission({ coin: 'ETH', hours: 24, score: 42, sigma: 0.03 })
t('logged at the server\'s own price and time', addEntry(log, sub, 3000, 10 * H) && log.entries[0].px === 3000 && log.entries[0].t === 10 * H)
t('the lean comes from the score', log.entries[0].lean === 'up' && leanOf(-20) === 'down' && leanOf(14) === 'flat')
t('the same coin, horizon and hour counts once', !addEntry(log, sub, 3100, 10 * H + 50 * 60e3) && log.entries.length === 1)
t('the next hour is a new entry', addEntry(log, sub, 3010, 11 * H) && log.entries.length === 2)
t('another horizon is a new entry', addEntry(log, { ...sub, hours: 168 }, 3000, 10 * H) && log.entries.length === 3)
t('no price, no entry', !addEntry(log, { ...sub, coin: 'BTC' }, null, 10 * H))
const big = emptyLog()
for (let i = 0; i < OL_MAX + 5; i++) big.entries.push({ coin: 'X', hours: 24, t: i * H, px: 1, lean: 'up', score: 20, sigma: 0.01 })
addEntry(big, { coin: 'Y', hours: 24, score: 1, sigma: 0.01 }, 1, (OL_MAX + 10) * H)
t('it keeps the newest only', big.entries.length === OL_MAX && big.entries.at(-1).coin === 'Y')

console.log('-- grading --')
t('nothing is due before its horizon', dueEntries(log, 10 * H + 23 * H).length === 0)
t('due at the horizon', dueEntries(log, 34 * H).length === 1)
t('right: up and higher', hitOf({ lean: 'up', px: 100, sigma: 0.02 }, 101) && !hitOf({ lean: 'up', px: 100, sigma: 0.02 }, 99))
t('right: down and lower', hitOf({ lean: 'down', px: 100, sigma: 0.02 }, 99))
t('neutral is a claim too: within 1σ', hitOf({ lean: 'flat', px: 100, sigma: 0.02 }, 101) && !hitOf({ lean: 'flat', px: 100, sigma: 0.02 }, 103))
const g = emptyLog()
addEntry(g, sub, 3000, 0); addEntry(g, { ...sub, coin: 'BTC', score: -50 }, 50000, 0); addEntry(g, { ...sub, coin: 'SOL' }, 150, 0)
const n = gradeDue(g, { ETH: 3100, BTC: 51000 }, 24 * H + 5 * 60e3)
t('graded at the price at the horizon', n === 2 && g.entries[0].end === 3100 && g.entries[0].hit === true && g.entries[1].hit === false)
t('a market with no price yet waits', g.entries[2].end == null && !g.entries[2].expired)
gradeDue(g, { SOL: 160 }, 24 * H + OL_GRACE + 60e3)
t('too late to be the horizon\'s price: expired, never graded', g.entries[2].expired === true && g.entries[2].hit == null)

console.log('-- the record --')
const rec = recordOf(g, 'ETH', 24)
t('per coin: graded only', rec.coin.n === 1 && rec.coin.hits === 1 && rec.coin.up.n === 1)
t('and across every market', rec.all.n === 2 && rec.all.hits === 1 && rec.all.down.n === 1)
t('per horizon', recordOf(g, 'ETH', 168).all.n === 0)
t('what is still waiting', recordOf(log, 'ETH', 24).pending === 2)
t('keys are coin, horizon and hour', olKey({ coin: 'ETH', hours: 24, t: 5.5 * H }) === 'ETH|24|5')

console.log('-- the server --')
const srv = fs.readFileSync('serve-prod.js', 'utf8'), vite = fs.readFileSync('vite.config.js', 'utf8')
t('both routes exist', /url === '\/outlook-log'/.test(srv) && /url === '\/outlook-record'/.test(srv))
t('the price logged is the server\'s, from Hyperliquid', /const px = Number\(\(await olMidsFor\(\[sub\.coin\]\)\)\[sub\.coin\]\)/.test(srv) && /addEntry\(log, sub, px, Date\.now\(\)\)/.test(srv))
t('one writer at a time across the workers', /openSync\(OL_LOCK, 'wx'\)/.test(srv) && /writeAtomic\(OL_FILE/.test(srv))
t('its Hyperliquid calls are capped, the budget is the bots\'', /olFetches\.length >= 10/.test(srv))
t('a body is small', /readJson\(req, 2_000\)/.test(srv))
t('dev has a twin', /path === '\/outlook-log'/.test(vite) && /path === '\/outlook-record'/.test(vite))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
