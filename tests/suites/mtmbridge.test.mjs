// Carrying an equity snapshot forward by price alone.
//
// Reported: "check how account equity is fetched in single and all accounts. because sometimes
// they keep spiking". The eqstep telemetry for 2026-09-21 had five steps over $400 in forty
// minutes, every one of them undone by the next snapshot — the carry between snapshots was
// wrong, not the snapshot. These tests are built from those records; see src/mtmbridge.js.
import fs from 'fs'
import { mtmBook, mergeBooks, mtmDelta } from '../../src/mtmbridge.js'
import { bridgeCombined, booksFrom } from '../../src/comboequity.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const near = (a, b, e = 0.01) => Math.abs(a - b) < e
const pos = (coin, szi, mark, extra = {}) => ({ position: { coin, szi: String(szi), positionValue: String(Math.abs(szi) * mark), ...extra } })

console.log(nl + '-- the book --')
{
  const b = mtmBook([pos('ADA', -6004, 0.2419), pos('xyz:SPCX', 2, 180.5), { position: { coin: 'SOL', szi: '0', positionValue: '0' } }])
  t('mark is positionValue over size', near(b.ADA[1], 0.2419, 1e-9) && b.ADA[0] === -6004)
  t('HIP-3 is included — HL\'s portfolio value includes it', !!b['xyz:SPCX'])
  t('a flat position is not', !('SOL' in b))
  t('bare positions are read too', !!mtmBook([{ coin: 'BTC', szi: '0.1', positionValue: '6000' }]).BTC)
  t('it survives JSON — the server sends it', JSON.stringify(JSON.parse(JSON.stringify(b))) === JSON.stringify(b))
}

console.log(nl + '-- only price moves it --')
{
  const book = mtmBook([pos('ADA', -6004, 0.24), pos('BTC', 0.1, 60000)])
  t('nothing moved: zero', near(mtmDelta(book, [pos('ADA', -6004, 0.24), pos('BTC', 0.1, 60000)]), 0))
  // ADA up a cent against a 6004 short = -60.04; BTC up 100 on 0.1 = +10.
  t('price moved: size times the move', near(mtmDelta(book, [pos('ADA', -6004, 0.25), pos('BTC', 0.1, 60100)]), -50.04))
  // What the old bridge published as money and this cannot see at all: margin moving between
  // spot and perp, an order reserving margin, a row rebuilt, a transfer shift reset. None of
  // them changes a size or a mark. (13:34: liveShift −429.77 → 0 and the headline fell 430.)
  const withNoise = [pos('ADA', -6004, 0.24, { marginUsed: '999', unrealizedPnl: '-430' }), pos('BTC', 0.1, 60000, { marginUsed: '1' })]
  t('margin, unrealized and transfers do not move it', near(mtmDelta(book, withNoise), 0))
}

console.log(nl + '-- trades between snapshots --')
{
  const book = mtmBook([pos('ADA', -6000, 0.24)])
  // Half closed, then price moved: only what is still held accrues.
  t('a partial close accrues on what is left', near(mtmDelta(book, [pos('ADA', -3000, 0.25)]), -30))
  // Added to: the added part's PnL waits for the next snapshot rather than being guessed at.
  t('an add accrues on the snapshot size only', near(mtmDelta(book, [pos('ADA', -9000, 0.25)]), -60))
  t('a close stops accruing', near(mtmDelta(book, []), 0))
  t('a flip counts nothing of the old side', near(mtmDelta(book, [pos('ADA', 500, 0.25)]), 0))
  t('a new coin waits for the snapshot', near(mtmDelta(book, [pos('ADA', -6000, 0.24), pos('ETH', 1, 3000)]), 0))
}

console.log(nl + '-- unknown is not zero --')
{
  t('no book: null', mtmDelta(null, []) === null)
  t('no live positions: null, not a flat account', mtmDelta({ ADA: [-1, 1] }, undefined) === null)
  t('mergeBooks lets the later book win', mergeBooks({ A: [1, 1] }, { A: [2, 2] }).A[0] === 2)
}

console.log(nl + '-- the combined headline --')
{
  const A = '0x01A4062754D9Cc42C728F3277B5a2C46FdbBd6D7', B = '0x974e086b541afc90acaf9ac5d3326d666a601e6b'
  const serverBooks = { [A.toLowerCase()]: mtmBook([pos('ADA', -6004, 0.24)]), [B]: mtmBook([pos('BTC', 0.1, 60000)]) }
  const rows0 = [
    { addr: A, positions: [pos('ADA', -6004, 0.24), pos('xyz:SPCX', 1, 180)], accountValue: 529, _perpLive: 186 },
    { addr: B, positions: [pos('BTC', 0.1, 60000), pos('xyz:SPCX', 2, 180)], accountValue: 1200, _perpLive: 900 },
  ]
  const books = booksFrom(serverBooks, rows0)
  t('main dex from the server, HIP-3 from the rows', !!books[A.toLowerCase()].ADA && !!books[A.toLowerCase()]['xyz:SPCX'])
  t('a wallet the server sent no book for: no books at all', booksFrom({ [B]: {} }, rows0) === null)

  // 13:40: acctBase 7607.61 against 6595.32 live — the base was sampled from rows mid-rebuild.
  // With books the base is not consulted, so however wrong it is the headline is not.
  const snap = { accountValue: 6595.71, wallets: 2, acctBase: 7607.61, perpBase: 2599.54, books }
  const rowsBad = rows0.map(r => ({ ...r, accountValue: r.accountValue - 500, _perpLive: r._perpLive + 300 }))
  const b1 = bridgeCombined(snap, rowsBad)
  t('rows lurching do not move the headline', b1.basis === 'mtm' && near(b1.val, 6595.71), b1)
  const rowsMoved = [
    { ...rows0[0], positions: [pos('ADA', -6004, 0.245), pos('xyz:SPCX', 1, 182)] },
    { ...rows0[1], positions: [pos('BTC', 0.1, 60200), pos('xyz:SPCX', 2, 182)] },
  ]
  // ADA -30.02, SPCX +2 and +4, BTC +20
  t('price does', near(bridgeCombined(snap, rowsMoved).val, 6595.71 - 30.02 + 2 + 4 + 20), bridgeCombined(snap, rowsMoved))
  t('a snapshot without books falls back to the old bridge', bridgeCombined({ ...snap, books: null }, rowsBad).basis === 'total')
}

console.log(nl + '-- wired in --')
{
  const srv = fs.readFileSync('server.js', 'utf8')
  const main = fs.readFileSync('src/main.js', 'utf8')
  const rnd = fs.readFileSync('src/render.js', 'utf8')
  t('the server snapshot carries each wallet\'s book', /books\[String\(addr\)\.toLowerCase\(\)\] = mtmBook\(cs\?\.assetPositions\)/.test(srv) && /accountValue, perpBase, dayAgo, books,/.test(srv))
  t('the client keeps it on the adopted snapshot', /books:\s+complete \? booksFrom\(d\.books, visible\) : null/.test(main))
  t('the single account stamps its book with its anchor', /portfolio\._mtmBook = mtmBook\(perpState\.assetPositions\)/.test(main))
  t('and its headline is carried by it', /const mtm = portfolio\?\._mtmBook \? mtmDelta\(portfolio\._mtmBook, livePositions\) : null/.test(rnd))
  t('every caller hands over the live positions', (rnd.match(/liveAccountValue\([^)]*perpState\?\.assetPositions\)/g) ?? []).length === 3)
  t('synthetic portfolios never carry a stale book', (main.match(/_perpAnchor = parseFloat\([^)]*\); delete state\.portfolio\._mtmBook/g) ?? []).length === 3)
  t('a combined row is carried the same way', /const cand\s+= _mtm != null \? _base \+ _mtm : _base \+ \(perpNow - _perpB\)/.test(main))
  t('and its book is stored with its anchor', (main.match(/bookAtHist: _bookAtHist/g) ?? []).length >= 3)
  t('single-account spikes are recorded too', /src=single snapMoved=/.test(main))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
