// Extracts the REAL _combinedServerValue (client) and _hlSeriesAt/computeCombined shape
// (server) and checks the property that matters: two devices with DIFFERENT local caches
// must produce the SAME combined equity.
import fs from 'fs'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (src, sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e

// ── client: _combinedServerValue ─────────────────────────────────────────────
const mkClient = (snap, rows, hidden = []) => new Function('SNAP', 'ROWS', 'HIDDEN', `
  const state = { isAllAccounts: true }
  let _combinedSnap = SNAP
  const _allAcctLastResults = ROWS
  const _maHiddenLoad = () => new Set(HIDDEN)
  ${grab(cli, 'function _combinedServerValue(')}
  return _combinedServerValue()
`)(snap, rows, hidden)

const SNAP = { accountValue: 3400, perpBase: 3000, dayAgo: 3250, wallets: 3, updatedAt: 1 }
const rows = (perps) => perps.map((p, i) => ({ addr: '0x' + i, error: null, _perpLive: p }))

// Two devices: identical live perp readings, but they got there from different local caches.
// (_portVal/_perpBase are deliberately different — the server bridge must ignore them.)
const devA = rows([1000, 1200, 900]).map(r => ({ ...r, _portVal: 1111, _perpBase: 999 }))
const devB = rows([1000, 1200, 900]).map(r => ({ ...r, _portVal: 2222, _perpBase: 555 }))

const a = mkClient(SNAP, devA), b = mkClient(SNAP, devB)
t('both devices compute a value', a != null && b != null)
t('the two devices AGREE', near(a, b), `${a} vs ${b}`)
t('value is snapshot + live perp delta', near(a, 3400 + (3100 - 3000)), `${a}`)
t('per-device _portVal/_perpBase are ignored entirely', near(a, b))

// ── it must refuse rather than guess ─────────────────────────────────────────
t('no snapshot → null (fall back to the old path)', mkClient(null, devA) === null)
t('wallet count mismatch → null',
  mkClient({ ...SNAP, wallets: 2 }, devA) === null)
t('a row with no live tick yet → null (never guess a missing leg)',
  mkClient(SNAP, [...rows([1000, 1200]), { addr: '0xz', error: null }]) === null)
t('errored rows are excluded from the count',
  mkClient({ ...SNAP, wallets: 3 }, [...devA, { addr: '0xerr', error: 'x', _perpLive: 500 }]) !== null)
t('hidden wallets are excluded from the count',
  mkClient({ ...SNAP, wallets: 3 }, [...devA, { addr: '0xhid', error: null, _perpLive: 500 }], ['0xhid']) !== null)

// live perp moving changes the value (it must stay live, not frozen to the snapshot)
const moved = mkClient(SNAP, rows([1010, 1200, 900]))
t('a live perp move flows through', near(moved, a + 10), `${moved} vs ${a + 10}`)

// ── server: _hlSeriesAt ──────────────────────────────────────────────────────
const { _hlSeriesAt } = new Function(`${grab(srv, 'function _hlSeriesAt(')}\nreturn { _hlSeriesAt }`)()
const hist = [[0, '100'], [100, '200'], [200, '400']]
t('server interpolation: midpoint', near(_hlSeriesAt(hist, 50), 150))
t('server interpolation: clamps low', near(_hlSeriesAt(hist, -5), 100))
t('server interpolation: clamps high', near(_hlSeriesAt(hist, 500), 400))
t('server interpolation: empty is 0', _hlSeriesAt([], 5) === 0)
t('server interpolation: equal timestamps safe', Number.isFinite(_hlSeriesAt([[5, '1'], [5, '2']], 5)))

// ── server route guards, read off the source ─────────────────────────────────
const route = srv.slice(srv.indexOf("path === '/api/combined'"), srv.indexOf("path === '/api/combined'") + 1600)
t('route dedupes and sorts addresses (stable cache key)', route.includes('new Set') && route.includes('.sort()'))
t('route validates every address', route.includes('isAddr(a)'))
t('route caps the address count', route.includes('addrs.length > 50'))
t('route caches per address-set', route.includes('_combinedCache.get(key)'))
t('route never caches a fully-failed refresh', route.includes('if (data.wallets > 0)'))
t('route serves stale rather than nothing on failure', route.includes('stale: true'))

const comp = grab(srv, 'async function computeCombined(')
t('portfolio is read BEFORE the anchor (pairing rule)',
  comp.indexOf("type: 'portfolio'") < comp.indexOf("type: 'clearinghouseState'"))
t('failed wallets are reported, not silently dropped', comp.includes('missing.push(addr)'))
t('a 429 stops the sweep instead of hammering', comp.includes('e.rateLimited'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
