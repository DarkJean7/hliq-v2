// Candidate signals for the Outlook score (src/outlooksignals.js), and the rule that decides
// whether one earns a place ("do 1"), and the cone calibration (outlook.js coneScale, "do 2").
import fs from 'fs'
import { CANDIDATES, readCandidates, scoreSignal } from '../../src/outlooksignals.js'
import { normInv, normCdf, coneScale, outlookFor } from '../../src/outlook.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const H4 = 4 * 3600e3

let seed = 11
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
const walk = (n) => { let c = 100; return Array.from({ length: n }, (_, i) => { const o = c; c = o * (1 + (rnd() - 0.5) * 0.03); return { t: i * H4, o, c, h: Math.max(o, c) * 1.003, l: Math.min(o, c) * 0.997 } }) }

console.log('-- the candidates --')
const C = walk(700)
const i = 600, v4 = 0.009
const all = readCandidates(C, i, v4, null)
t('every candle-only candidate reads', Object.keys(CANDIDATES).filter(k => !CANDIDATES[k].needs).every(k => k in all), Object.keys(all))
t('each is -1..+1', Object.values(all).every(v => v >= -1 && v <= 1))
t('funding needs funding: without it, nothing', !('fundingFade' in all))
// Nothing after bar i may be read: wreck the future and the readings must not move.
const wrecked = C.map((k, j) => j > i ? { ...k, o: k.o * 5, c: k.c * 5, h: k.h * 5, l: k.l * 5 } : k)
t('no candidate reads past its own candle', JSON.stringify(readCandidates(wrecked, i, v4, null)) === JSON.stringify(all))
// The fades lean against a big move; the follows lean with it.
const up = C.slice(0, 300).map((k, j) => j > 280 ? { ...k, o: 100 * 1.02 ** (j - 281), c: 100 * 1.02 ** (j - 280), h: 100 * 1.02 ** (j - 280) * 1.001, l: 100 * 1.02 ** (j - 281) * 0.999 } : k)
const r = readCandidates(up, 299, 0.009, null)
t('after a run up, the fades lean down', r.revDay < 0 && r.rev3d < 0 && r.bbFade < 0 && r.streak < 0, r)
t('and the follows lean up', r.trend7d > 0 && r.breakout20d === 1, r)
t('RSI fades only its extremes', r.rsiFade < 0 && readCandidates(C, i, v4, null, ['rsiFade']).rsiFade !== undefined)
const fund = Array.from({ length: 48 }, (_, k) => ({ t: C[i].t + H4 - k * 3600e3, rate: 0.0003 }))
t('crowded longs (high funding) lean down', readCandidates(C, i, v4, { funding: fund }, ['fundingFade']).fundingFade === -1)

console.log('-- earning a place --')
const rows = (n, f) => Array.from({ length: n }, (_, k) => f(k))
const works = rows(600, k => { const d = k % 2 ? 1 : -1; return { v: d * 0.8, ret: d * 0.01 * (k % 7 ? 1 : -1), half: k < 300 ? 0 : 1 } })
const sw = scoreSignal(works, 24)
t('a signal right 6 times in 7, in both halves, passes', sw.pass && sw.rate > 0.8 && sw.halves.every(x => x.rate > x.chance), sw)
const noise = rows(600, k => ({ v: rnd() - 0.5 > 0 ? 0.8 : -0.8, ret: (rnd() - 0.5) * 0.02, half: k < 300 ? 0 : 1 }))
t('a coin flip does not', !scoreSignal(noise, 24).pass)
const oneHalf = rows(600, k => { const d = k % 2 ? 1 : -1; return { v: d * 0.8, ret: (k < 300 ? d : -d) * 0.01 * (k % 9 ? 1 : 1.5), half: k < 300 ? 0 : 1 } })
t('one good half and one bad one does not', !scoreSignal(oneHalf, 24).pass)
t('a 7-day horizon counts overlapping days as weeks', scoreSignal(works.slice(0, 60), 168).z < scoreSignal(works.slice(0, 60), 24).z)
t('small leans are not calls', scoreSignal(rows(100, k => ({ v: 0.1, ret: 0.01, half: 0 })), 24).n === 0)

console.log('-- the cone, calibrated --')
t('normInv is normCdf undone', [0.01, 0.2, 0.5, 0.841, 0.975, 0.999].every(p => Math.abs(normCdf(normInv(p)) - p) < 1e-6))
t('a market that ended inside 68% of the time keeps its cone', Math.abs(coneScale({ n: 330, inside: 0.6827 }) - 1) < 0.002)
t('inside more often: the cone narrows', coneScale({ n: 330, inside: 0.73 }) < 0.95)
t('inside less often: it widens', coneScale({ n: 330, inside: 0.6 }) > 1.1)
t('few days: pulled towards ×1', Math.abs(coneScale({ n: 20, inside: 0.9 }) - 1) < Math.abs(coneScale({ n: 330, inside: 0.9 }) - 1))
t('weekly windows count as fewer days', Math.abs(coneScale({ n: 330, inside: 0.9 }, 168) - 1) < Math.abs(coneScale({ n: 330, inside: 0.9 }, 24) - 1))
t('never past ×0.6 or ×1.6', coneScale({ n: 1e6, inside: 0.97 }) >= 0.6 && coneScale({ n: 1e6, inside: 0.3 }) <= 1.6)
t('nothing measured: ×1', coneScale(null) === 1)
const c4 = walk(300), price = c4.at(-1).c
const a = outlookFor({ position: { coin: 'X', szi: '1', entryPx: String(price), liquidationPx: String(price * 0.9) }, price, c4, c1: [], hours: 24 })
const b = outlookFor({ position: { coin: 'X', szi: '1', entryPx: String(price), liquidationPx: String(price * 0.9) }, price, c4, c1: [], hours: 24, sigmaScale: 0.9 })
t('the card\'s cone and its touch chances move with the scale', Math.abs(b.sigma / a.sigma - 0.9) < 1e-9 && b.risk.liq.p < a.risk.liq.p)

console.log('-- what earned a place: the 4h set --')
const { factors, candleIds, weightsFor, HORIZONS, weightedScore, pastSamples, signalRecords } = await import('../../src/outlook.js')
const { OL_HOURS, cleanSubmission } = await import('../../src/outlooklog.js')
const res = JSON.parse(fs.readFileSync('tests/research/signal-results.json', 'utf8'))
const passed = res.results.filter(r => r.pass).map(r => `${r.id}@${r.h}`).sort()
t('the research found what the 4h set is built on', passed.join() === 'bbFade@4,rev3d@4' && res.markets >= 15, passed)
t('and momentum called 4h wrong, in both halves', (() => { const m = res.results.find(r => r.id === 'momentum' && r.h === 4); return m.z <= -2 && m.t <= -2 && m.halves.every(x => x.rate < x.chance) })())
t('the tab has a 4h horizon', HORIZONS['4h'] === 4 && OL_HOURS.includes(4) && !!cleanSubmission({ coin: 'ETH', hours: 4, score: 10, sigma: 0.01 }))
const C1 = walk(260).map((k, j) => ({ ...k, t: j * 864e5 }))
const f4 = factors({ price: C.at(-1).c, c4: C, c1: C1, hours: 4 }).map(x => x.id), f24 = factors({ price: C.at(-1).c, c4: C, c1: C1, hours: 24 }).map(x => x.id)
t('at 4h: the two fades in, momentum out', f4.includes('rev3d') && f4.includes('bbFade') && !f4.includes('momentum'), f4)
t('at 24h and 7d: the set it had, nothing new', f24.includes('momentum') && !f24.includes('rev3d') && !f24.includes('bbFade'), f24)
t('each horizon\'s weights and replayable signals agree', [4, 24, 168].every(h => candleIds(h).every(id => weightsFor(h)[id] > 0)))
const S4 = pastSamples(C, C1)
t('the replay keeps the new signals, so the 4h record can grade them', S4.every(x => 'rev3d' in x.f && 'bbFade' in x.f) && 'rev3d' in signalRecords(S4, 4) && !('momentum' in signalRecords(S4, 4)))
t('the 4h score reads the 4h set', weightedScore({ momentum: 1, rev3d: -1 }, null, 4) === -100 && weightedScore({ momentum: 1, rev3d: -1 }, null, 24) === 100)

console.log('-- wiring --')
const view = fs.readFileSync('src/outlookview.js', 'utf8'), pkg = fs.readFileSync('package.json', 'utf8')
t('the card uses the calibrated cone', /sigmaScale: past\.scale/.test(view) && /scale: coneScale\(cone, h\)/.test(view))
t('and says by how much', /So the cone on this card is scaled/.test(view))
t('the research is one command, and not part of npm test', /"research:signals": "node tests\/signal-research\.mjs"/.test(pkg) && !fs.existsSync('tests/suites/signal-research.mjs'))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
