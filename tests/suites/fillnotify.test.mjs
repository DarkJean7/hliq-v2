// "Order filled" cards (src/fillnotify.js): one card per order, only for fills that are news.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = '\n'

// localStorage for node
const store = new Map()
globalThis.localStorage = { getItem: k => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) }

const N = await import('../../src/fillnotify.js')
let now = 1_800_000_000_000
N.initFillNotify({ now: () => now })
const fill = (o) => ({ coin: 'BTC', side: 'BUY', dir: 'Open Long', sz: 0.1, px: 86000, closedPnl: 0, fee: 1, time: now - 1000, oid: 1, tid: 1, ...o })

console.log(nl + '-- one card per order --')
{
  const g = N.groupByOrder([fill({ tid: 1, sz: 0.1, px: 86000 }), fill({ tid: 2, sz: 0.3, px: 86100 }), fill({ oid: 2, tid: 3, coin: 'ETH', side: 'SELL', sz: 1, px: 2700, closedPnl: 40 })], '0xa')
  t('the pieces of one order are one group, a second order its own', g.length === 2)
  const btc = g.find(x => x.coin === 'BTC')
  t('sizes add up', Math.abs(btc.sz - 0.4) < 1e-12 && btc.pieces === 2)
  t('price is the volume-weighted average', Math.abs(btc.px - (0.1 * 86000 + 0.3 * 86100) / 0.4) < 1e-6, btc.px)
  t('a close carries what it realized', g.find(x => x.coin === 'ETH').closedPnl === 40)
}

console.log(nl + '-- only news --')
{
  const A = '0xAAA'
  t('an account\'s first batch is history: recorded, not shown', N.notifyFills([fill({ tid: 10 })], { acct: A }).length === 0)
  t('the same fill again is not news', N.notifyFills([fill({ tid: 10 })], { acct: A }).length === 0)
  const shown = N.notifyFills([fill({ tid: 11, oid: 5 }), fill({ tid: 12, oid: 5 })], { acct: A })
  t('a new fill after that is shown, one card for its order', shown.length === 1 && shown[0].pieces === 2)
  t('an old fill first seen now is not news (a refresh after sleep, a stale cache)',
    N.notifyFills([fill({ tid: 13, oid: 6, time: now - N.MAX_AGE_MS - 1 })], { acct: A }).length === 0)
  t('accounts are separate: another wallet\'s first batch is its own history', N.notifyFills([fill({ tid: 20 })], { acct: '0xBBB' }).length === 0)
  N.seedFills([fill({ tid: 30 })], '0xCCC')
  t('seedFills records history without showing it', N.notifyFills([fill({ tid: 30 })], { acct: '0xCCC' }).length === 0 && N.notifyFills([fill({ tid: 31, oid: 9 })], { acct: '0xCCC' }).length === 1)
  N.setEnabled(false)
  t('switched off in Settings: nothing is shown', N.notifyFills([fill({ tid: 40, oid: 10 })], { acct: A }).length === 0)
  N.setEnabled(true)
  t('on by default', (() => { store.delete('hliq_fill_toasts'); return N.enabled() })())
}

console.log(nl + '-- wired into both shells --')
{
  const MAIN = fs.readFileSync('src/main.js', 'utf8')
  t('the single-account tick feeds it the fills that just arrived', /notifyFills\(_fresh, \{ acct: state\.addr \}\)/.test(MAIN))
  t('and records an account\'s first load as history', MAIN.includes('if (_isRealAddr(addr)) seedFills(fills, addr)'))
  t('All Accounts feeds it from BOTH refresh paths, per wallet, skipping hidden wallets',
    (MAIN.match(/_notifyComboFills\(base\)/g) ?? []).length === 2 && /hidden\.has\(r\.addr\)/.test(MAIN.slice(MAIN.indexOf('function _notifyComboFills'), MAIN.indexOf('function _notifyComboFills') + 900)))
  t('not for the sentinels (paper, All Accounts)', MAIN.includes('if (_fresh.length && _isRealAddr(state.addr))'))
  t('a Settings row in both shells', fs.readFileSync('index.html', 'utf8').includes('id="fillToastToggle"') && MAIN.includes("window.__toggleFillToasts(this.checked)"))
  const SRC = fs.readFileSync('src/fillnotify.js', 'utf8')
  t('coin names and wallet labels go in as text, not markup', !/innerHTML\s*=\s*`[^`]*\$\{/.test(SRC.replace(/el\.innerHTML = `<i class="ft-bar"[\s\S]*?<\/div>`/, '')))
  t('privacy mode hides sizes and amounts', SRC.includes("hide ? '•••' : size(g.sz)") && SRC.includes("hide ? 'Realized •••'"))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
