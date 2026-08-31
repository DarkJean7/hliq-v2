// Pulse covers every perp market, not just the main dex.
import fs from 'fs'
import { computeEcosystem, computeEcosystemAll, rankEcosystem, pulseSeries } from 'file:///C:/Users/jeank/OneDrive/Desktop/hliq-v2/src/ecosystem.js'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const mk = (names, oi, vol, apr = 0.0001) => [
  { universe: names.map(n => ({ name: n })) },
  names.map((_, i) => ({ markPx: '10', prevDayPx: '10', openInterest: String(oi[i] / 10),
                         dayNtlVlm: String(vol[i]), funding: String(apr), premium: '0' })),
]
const main = mk(['BTC', 'ETH'], [2_000_000, 1_000_000], [5e6, 4e6])
const dexA = mk(['xyz:SP500'], [1_500_000], [3e6], 0.0009)
const dexB = mk(['para:VST'], [10_000], [200_000], 0.0012)

console.log('\n-- builder markets rank alongside the main dex --')
const all = computeEcosystemAll(main, [{ dex: 'xyz', pair: dexA }, { dex: 'para', pair: dexB }])
t('every market is counted', all.coins === 4)
t('a builder market outranks a smaller main-dex one',
  all.topOi.map(r => r.coin).join(',') === 'BTC,xyz:SP500,ETH,para:VST')
t('main-dex only would have missed it', computeEcosystem(main).topOi.length === 2)
t('rows carry their dex so the UI can say which', all.topOi[1].dex === 'xyz')
t('and a main-dex row carries none', all.topOi[0].dex == null)
t('open interest is the sum across dexes', Math.abs(all.totalOi - 4_510_000) < 1)
t('volume too', Math.abs(all.totalVol - 12_200_000) < 1)
t('the builder share is reported separately', Math.abs(all.hip3Oi - 1_510_000) < 1)

console.log('\n-- funding ranks across everything --')
t('the highest builder funding leads', all.fundingHigh[0].coin === 'para:VST')
t('and the thin-volume filter still applies',
  computeEcosystemAll(main, [{ dex: 'para', pair: mk(['para:TINY'], [1], [50], 0.9) }])
    .fundingHigh.every(r => r.coin !== 'para:TINY'))
t('no dex pairs falls back to the main dex alone', computeEcosystemAll(main, []).coins === 2)
t('and so does a null list', computeEcosystemAll(main, null).coins === 2)
t('a dex that failed to fetch is skipped, not fatal',
  computeEcosystemAll(main, [{ dex: 'x', pair: null }]).coins === 2)

console.log('\n-- the ranking helper is shared, not duplicated --')
t('it is exported', typeof rankEcosystem === 'function')
t('and produces the same slices for the same rows',
  rankEcosystem(all.rows).topOi[0].coin === all.topOi[0].coin)

console.log('\n-- wiring --')
t('the dex fan feeds the lists', cli.includes('_pulseDexPairs = fetched'))
t('and triggers a rebuild when it lands', cli.includes('_pulseRecompute()'))
t('the main fetch also rebuilds, so whichever arrives last wins',
  cli.includes('_pulseMainPair = pair'))
t('before the fan lands it still shows the main dex rather than nothing',
  cli.includes('_pulseDexPairs?.length') && cli.includes(': computeEcosystem(_pulseMainPair)'))
t('a builder market is tagged with its dex in the row', cli.includes('${r.dex ? `<span'))
t('and the subtitle no longer claims more than it shows',
  cli.includes('main dex and builder dexes together'))

console.log('\n-- the recorded series widened with it --')
t('the server records builder volume and OI', srv.includes('let hip3Vol = 0, hip3Oi = 0'))
t('discovered from perpDexs', srv.includes("hlInfo({ type: 'perpDexs' })"))
t('a rate limit still aborts rather than recording a partial figure', srv.includes('if (e.rateLimited) throw e'))
t('the row is appended to, keeping older readings valid',
  srv.includes('Math.round(hip3Vol), Math.round(hip3Oi)'))
// Older points lack fields 5/6 and must not be read as zeros in a way that breaks them.
const older = [[1, 100, 10, 500, 60]]
const newer = [[2, 100, 10, 500, 60, 40, 200]]
t('an older reading still charts, on its own basis', pulseSeries(older).volume[0][1] === 110)
t('a newer one includes the builder half', pulseSeries(newer).volume[0][1] === 150)
t('open interest likewise', pulseSeries(older).oi[0][1] === 500 && pulseSeries(newer).oi[0][1] === 700)
const eco = fs.readFileSync('src/ecosystem.js', 'utf8')
t('and the step is documented rather than hidden',
  srv.includes('the series simply steps once where the basis widened') ||
  eco.includes('steps once where the basis widened'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
