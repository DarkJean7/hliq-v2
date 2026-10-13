// The All Accounts equity in the first seconds after opening: the server's read of each wallet,
// carried to now by price.
//
// Reported: "when I open the app, Net PnL loads faster than account equity". Measured with
// tests/eqopen-probe.mjs on eight real wallets: Net PnL 0.4s, equity 6-7s on a reopen, because the
// headline waited for every wallet to be re-read one after another. See src/comboseed.js.
import fs from 'fs'
import { spotPxFrom, seedBook, seedValue, seedEval, SEED_MAX_MS, SEED_UNPRICED_USD } from '../../src/comboseed.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.01) => Math.abs(a - b) < e
const pos = (coin, szi, mark) => ({ position: { coin, szi: String(szi), positionValue: String(Math.abs(szi) * mark) } })

console.log(nl + '-- spot prices, by pair name --')
{
  // The contexts are NOT in universe order. Matching by index priced HYPE at $0.08 on the first
  // live run; the pair's own name is the only safe join.
  const meta = {
    tokens: [{ index: 0, name: 'USDC' }, { index: 150, name: 'HYPE' }, { index: 1, name: 'PURR' }, { index: 7, name: 'USDT0' }],
    universe: [
      { name: 'PURR/USDC', index: 0, tokens: [1, 0] },
      { name: '@107', index: 107, tokens: [150, 0] },
      { name: '@166', index: 166, tokens: [150, 7] },       // HYPE/USDT0 -- not the USDC price
    ],
  }
  const ctxs = [{ coin: '@107', midPx: '42.5' }, { coin: '@166', midPx: '99' }, { coin: 'PURR/USDC', midPx: null, markPx: '0.2' }]
  const px = spotPxFrom([meta, ctxs])
  t('HYPE priced from its USDC pair, found by name', px.HYPE === 42.5, px)
  t('a pair with no mid falls back to its mark', px.PURR === 0.2, px)
  t('USDC itself is not a holding to price', !('USDC' in px))
  t('nothing in, nothing out', Object.keys(spotPxFrom(null)).length === 0)
}

console.log(nl + '-- the book --')
{
  const b = seedBook([pos('BTC', 0.1, 60000), pos('ADA', -1000, 0.25)], [{ coin: 'USDC', total: '500' }, { coin: 'HYPE', total: '3', entryNtl: '120' }], { HYPE: 40 })
  t('perps at their mark', b.perp.BTC[0] === 0.1 && near(b.perp.BTC[1], 60000) && b.perp.ADA[0] === -1000)
  t('spot tokens at the price when read', b.spot.HYPE[0] === 3 && b.spot.HYPE[1] === 40)
  t('USDC is cash, not carried', !('USDC' in b.spot))
  t('it survives JSON -- the server sends it', JSON.stringify(JSON.parse(JSON.stringify(b))) === JSON.stringify(b))
  t('dust the server cannot price is left out',
    seedBook([], [{ coin: 'DUST', total: '9', entryNtl: String(SEED_UNPRICED_USD - 1) }], {}) != null)
  t('a real holding it cannot price refuses the whole book -- never a wallet carried as if it did not own it',
    seedBook([], [{ coin: 'KNTQ', total: '500', entryNtl: '180' }], {}) === null)
}

console.log(nl + '-- carried by price, and only by price --')
{
  const now = 1_000_000_000_000
  const seed = { value: 1000, at: now - 30_000, book: { perp: { BTC: [0.1, 60000], ADA: [-1000, 0.25] }, spot: { HYPE: [3, 40] } } }
  const mids = { BTC: 60100, ADA: 0.24 }, spot = { HYPE: 41 }
  const v = seedValue(seed, c => mids[c], c => spot[c], now)
  // +0.1*100 long BTC, +(-1000)*(-0.01) short ADA, +3*1 spot HYPE
  t('value + Σ size × (price now − price then)', near(v, 1000 + 10 + 10 + 3), v)
  t('an empty wallet is worth $0, not unknown', seedValue({ value: 0, at: now, book: { perp: {}, spot: {} } }, () => 1, () => 1, now) === 0)
  t('a negative or missing value is still unknown', seedValue({ value: -5, at: now, book: { perp: {}, spot: {} } }, () => 1, () => 1, now) === null && seedValue({ at: now, book: { perp: {}, spot: {} } }, () => 1, () => 1, now) === null)
  t('no move, no change',near(seedValue(seed, c => ({ BTC: 60000, ADA: 0.25 })[c], () => 40, now), 1000))
  t('a price not known yet: null, not the uncarried value',
    seedValue(seed, c => (c === 'BTC' ? 60100 : 0), c => spot[c], now) === null)
  t('a spot price not known yet: null', seedValue(seed, c => mids[c], () => undefined, now) === null)
  t('older than SEED_MAX_MS: null -- the wallet waits for its own row',
    seedValue({ ...seed, at: now - SEED_MAX_MS - 1 }, c => mids[c], c => spot[c], now) === null)
  t('no book: null', seedValue({ value: 1000, at: now }, () => 1, () => 1, now) === null)
  t('no seed: null', seedValue(undefined, () => 1, () => 1, now) === null)
  t('an empty book is a wallet that holds nothing: its value as read',
    seedValue({ value: 150, at: now, book: { perp: {}, spot: {} } }, () => 0, () => 0, now) === 150)
}

console.log(nl + '-- why a seed has no value, said out loud --')
{
  const now = Date.now()
  const book = { perp: { BTC: [1, 100] }, spot: {} }
  const ok = (sd, mid = () => 100) => seedEval(sd, mid, () => 1, now)
  t('a usable seed has no complaint', ok({ value: 10, at: now, book }).why === '' && ok({ value: 10, at: now, book }).value === 10)
  t('no seed at all says so', seedEval(undefined, () => 1, () => 1, now).why === 'noseed')
  t('and a seed with no value', seedEval({ at: now, book }, () => 1, () => 1, now).why === 'noval')
  t('a stale one says HOW stale, which is the number that mattered',
    /^old:\d+s$/.test(seedEval({ value: 1, at: now - SEED_MAX_MS - 5000, book }, () => 1, () => 1, now).why))
  t('a seed with no book', seedEval({ value: 1, at: now }, () => 1, () => 1, now).why === 'nobook')
  // An unpriced market refuses the wallet, and naming it is the difference between "equity is
  // not loading" and "this one market has no mid".
  t('an unpriced perp names the market', seedEval({ value: 1, at: now, book }, () => 0, () => 1, now).why === 'noperp:BTC')
  t('and an unpriced spot token', seedEval({ value: 1, at: now, book: { perp: {}, spot: { PURR: [1, 1] } } }, () => 1, () => 0, now).why === 'nospot:PURR')
  // One walk, so the number on screen and the reason in the telemetry cannot describe
  // different things.
  t('seedValue is seedEval\'s value, not a second opinion',
    seedValue({ value: 10, at: now, book }, () => 100, () => 1, now) === ok({ value: 10, at: now, book }).value &&
    seedValue(undefined, () => 1, () => 1, now) === null)
}

console.log(nl + '-- the cliff a ten-wallet set could not stay under --')
{
  // The server re-reads a watched wallet every SEED_EVERY_MS (110s) and a 429 breaks the
  // round, so a wallet's turn can come far less often. Measured against the live server on a
  // set of THREE with no contention: seeds already 115-117s old. At three minutes a ten-wallet
  // set was past the cliff routinely, the seed was refused, and the whole headline was a dash.
  t('a seed is good for ten minutes', SEED_MAX_MS === 10 * 60_000)
  t('which is longer than the server takes to come round again', SEED_MAX_MS > 110_000 * 3)
  // The server made the same judgement for itself; the client throwing the read away sooner
  // was an asymmetry, not a second opinion.
  const srvTxt = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8')
  t('and matches the server\'s own window for the same read', /const WALLET_MAX_MS   = 10 \* 60_000/.test(srvTxt))
  t('the reason is written down', fs.readFileSync(new URL('../../src/comboseed.js', import.meta.url), 'utf8').includes('matched to the server'))
}

console.log(nl + '-- wired in --')
{
  const main = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
  const srv  = fs.readFileSync(new URL('../../server.js', import.meta.url), 'utf8')
  const rv = main.slice(main.indexOf('function _comboRowsValue()'), main.indexOf('function _comboRowsValue()') + 2000)
  t('a wallet uses its own fresh row first', /const fresh = r && !r\.error/.test(rv) && /fresh \? parseFloat\(r\.accountValue\)/.test(rv))
  // seedEval now, not seedValue: the same walk answers with the value AND why there is none,
  // so the reason the headline is withheld can be recorded instead of guessed at next time.
  t('then the seed, carried by live prices', /seedEval\(_comboSeeds\[lc\], c => state\.allMids\?\.\[c\], _spotMid, now\)/.test(rv))
  t('every saved wallet must answer one way or the other', /for \(const a of addrs\)/.test(rv) && /return null/.test(rv))
  t('seeds are asked for on entry, from the endpoint that never reads HL', /_fetchComboSeeds\(\)/.test(main) && /'\/api\/combined\/seeds'/.test(main))
  t('prices are asked for on entry too -- the socket\'s first push measured six seconds', /infoClient\.allMids\(\)\.then\(m => \{/.test(main))
  t('the server answers seeds from memory', /path === '\/api\/combined\/seeds'[\s\S]{0,700}combinedSeeds\(addrs\)/.test(srv))
  t('and keeps them warm, without the PnL accrual', /computeCombined\(e\.addrs, \{ pnl: false, freshMs: SEED_EVERY_MS \}\)/.test(srv))
  t('the warm list is bounded -- the endpoint is public', /SEED_SETS_MAX/.test(srv) && /_seedSets\.size > SEED_SETS_MAX/.test(srv))
  t('the book is read with the value it belongs to', /next\.book = seedBook\(cs\?\.assetPositions, spot\?\.balances, await seedSpotPx\(\)\)/.test(srv))
}

console.log(nl + '-- and it never withholds in silence again --')
{
  const main = fs.readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8')
  // Two earlier rounds of this bug could only be diagnosed because the OLD snapshot chain
  // happened to log rowVals=. That chain is not what the screen is drawn from any more, and
  // the path that is drew a dash and said nothing at all.
  t('the withholding path records it', main.includes('function _comboWaitSay'))
  t('naming every wallet it is waiting on, not just the first',
    /waiting\.push\(\{ addr: a, label: _comboLabelOf\(a\), why/.test(main) &&
    /\{ _comboWaiting = waiting; [\s\S]{0,120}\}|_comboWaiting = waiting/.test(main))
  t('with what is wrong with each', main.includes("waiting.map(w => String(w.addr).slice(0, 8) + ':' + w.why)"))
  t('as eqstep, the kind the last two were found under', /kind: 'eqstep',\s*\n\s*message: `combined equity withheld/.test(main))
  t('at most once in ten minutes, so a stuck wallet cannot flood it',
    /if \(now - _comboWaitSaidAt < 10 \* 60_000\) return/.test(main))
  t('and it is readable from a console', main.includes('window.__comboWaiting = () => _comboWaitingOn()'))
  // Every wallet is still required: a sum missing one is a wrong total, which is the rule
  // this whole file exists to keep.
  t('a missing wallet still withholds the total, it is not summed around',
    /if \(waiting\.length\) \{ _comboWaitSay\(waiting, addrs\.length\); return null \}/.test(main))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
