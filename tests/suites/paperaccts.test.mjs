// As many paper accounts as you want, each one genuinely its own.
//
// The whole promise is isolation: money moved in one account must not appear in another,
// and deleting one must not take anything else with it. That is not something to check by
// reading — this drives the real module against a localStorage stand-in.
import fs from 'fs'

// A localStorage that behaves like the real one, including the part that matters here:
// a quota that can be filled.
let quota = Infinity
const mkStore = () => {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => {
      const size = [...m.entries()].reduce((a, [kk, vv]) => a + kk.length + vv.length, 0) - (m.get(k)?.length ?? 0) - (m.has(k) ? k.length : 0)
      if (size + k.length + String(v).length > quota) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e }
      m.set(k, String(v))
    },
    removeItem: (k) => m.delete(k),
    key: (i) => [...m.keys()][i],
    get length() { return m.size },
    _keys: () => [...m.keys()],
  }
}
globalThis.localStorage = mkStore()

const P = await import('../../src/paper.js')
const src = fs.readFileSync('src/paper.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- you start with the practice account --')
t('the active slot is main', P.paperSlot() === 'main')
t('no extra accounts yet', P.paperAcctList().length === 0)
t('and main is listed', P.paperAccounts().length === 1 && P.paperAccounts()[0].slot === 'main')
t('the practice account opens at the starting balance', P.paperStore().balance === P.PAPER_START)

console.log(nl + '-- making more of them --')
const a = P.paperAcctCreate('Grid experiments')
const b = P.paperAcctCreate('Scalping')
t('two more can be made', !!a.slot && !!b.slot && a.slot !== b.slot, JSON.stringify([a, b]))
t('neither reports an error', !a.error && !b.error)
t('they are registered with their names',
  P.paperAcctList().map(x => x.name).join(',') === 'Grid experiments,Scalping')
t('all three are selectable', P.paperAccounts().length === 3)
t('a blank name still gets one', !!P.paperAcctCreate('').slot && P.paperAcctList()[2].name.length > 0)
t('names are capped at 24 characters', P.paperAcctCreate('x'.repeat(80)).slot && P.paperAcctList()[3].name.length === 24)

console.log(nl + '-- the money in one account is not the money in another --')
// This is the assertion the feature exists for.
P.setPaperSlot(a.slot)
t('switching lands on a fresh account', P.paperStore().balance === P.PAPER_START)
P.paperDeposit(4000)
P.paperSave()
t('a deposit lands here', P.paperStore().balance === P.PAPER_START + 4000)

P.setPaperSlot(b.slot)
t('the other account never saw it', P.paperStore().balance === P.PAPER_START)
P.paperDeposit(11)
P.paperSave()

P.setPaperSlot(a.slot)
t('and coming back, the first one is exactly as it was', P.paperStore().balance === P.PAPER_START + 4000)
P.setPaperSlot('main')
t('the practice account is untouched by both', P.paperStore().balance === P.PAPER_START)

console.log(nl + '-- switching flushes before it moves --')
// Without the flush, whatever was in memory would be written into the NEXT account's key.
P.setPaperSlot(a.slot)
P.paperDeposit(1)                                   // in memory, not yet saved
P.setPaperSlot('main')
P.setPaperSlot(a.slot)
t('an unsaved change survives the round trip', P.paperStore().balance === P.PAPER_START + 4001)
t('the flush is in the switch', grab(src, 'export function setPaperSlot').includes('localStorage.setItem(paperKey()'))

console.log(nl + '-- each account has its own key --')
const keys = localStorage._keys().filter(k => k.startsWith('hliq_paper'))
t('the practice account keeps the original key', keys.includes('hliq_paper_v2'))
t('extras get their own', keys.filter(k => k.startsWith('hliq_paper_s_')).length >= 2, JSON.stringify(keys))
t('the registry is separate from the stores', keys.includes('hliq_paper_accts'))

console.log(nl + '-- deleting --')
const before = P.paperAcctList().length
t('the built-ins cannot be deleted', P.paperAcctDelete('main') === false && P.paperAcctDelete('challenge') === false)
t('nor can an account that does not exist', P.paperAcctDelete('nope') === false)
t('nothing was removed by those', P.paperAcctList().length === before)

P.setPaperSlot('main')
t('a real one deletes', P.paperAcctDelete(b.slot) === true)
t('it leaves the registry', !P.paperAcctList().some(x => x.slot === b.slot))
t('its store is erased', localStorage.getItem('hliq_paper_s_' + b.slot) === null)
t('and the others are still there', P.paperStore().balance === P.PAPER_START && P.paperAcctList().length === before - 1)

// Deleting the account you are standing in: the dangerous one. If the slot stayed put,
// the next save would write the in-memory state straight back into the key just removed.
P.setPaperSlot(a.slot)
P.paperAcctDelete(a.slot)
t('deleting the active account moves you to the practice account', P.paperSlot() === 'main')
t('and it does not come back on the next save', (P.paperSave(), localStorage.getItem('hliq_paper_s_' + a.slot) === null))
t('the practice account is what you land in', P.paperStore().balance === P.PAPER_START)

console.log(nl + '-- an unknown slot is refused, not obeyed --')
// A stale link or a deleted account must not open a store of its own, or every typo
// becomes a new account nothing lists.
t('an unknown slot is not known', P.paperSlotKnown('does-not-exist') === false)
t('main and challenge always are', P.paperSlotKnown('main') && P.paperSlotKnown('challenge'))
P.setPaperSlot('does-not-exist')
t('setting one lands on main', P.paperSlot() === 'main')

console.log(nl + '-- a full quota is reported, not swallowed --')
// The old paperSave() swallowed every failure. With one account that was unreachable;
// with twelve it is not, and it looks exactly like nothing happening.
t('paperSave reports success normally', P.paperSave() === true)
t('and nothing is flagged', P.paperSaveFailed() === false)
quota = 10                                         // nothing more will fit
t('a failed save returns false', P.paperSave() === false)
t('and is recorded', P.paperSaveFailed() === true)
const created = P.paperAcctCreate('will not fit')
t('creating into a full quota fails cleanly', created.slot === null && created.error === 'quota')
quota = Infinity
t('and recovers once there is room', P.paperSave() === true && P.paperSaveFailed() === false)
t('the app says so rather than losing an afternoon quietly',
  cli.includes('this paper account is no longer being saved'))

console.log(nl + '-- the limit is storage, and it is honest about it --')
while (P.paperAcctList().length < P.PAPER_MAX_ACCTS) P.paperAcctCreate('filler')
t(`${P.PAPER_MAX_ACCTS} accounts fit`, P.paperAcctList().length === P.PAPER_MAX_ACCTS)
const over = P.paperAcctCreate('one too many')
t('the next one is refused', over.slot === null && over.error === 'limit')
t('and the list did not grow', P.paperAcctList().length === P.PAPER_MAX_ACCTS)
t('the cap says it is about storage, not taste', src.includes('it is what localStorage can hold'))

console.log(nl + '-- every paper account is its own row on the board --')
// This section used to hold the opposite rule — "only the practice account is ranked" — on
// the reasoning that one person should be one row. Reversed on request: "do the same for
// created paper accounts, show all". Each is ranked under its own name, with its own secret.
t('every account but the Challenge is listed',
  cli.includes("return paperAccounts().map(a => a.slot).filter(sl => sl !== 'challenge')"))
t('the practice-only gate is gone',
  !grab(cli, 'async function _lbPaperSync').includes("if (paperSlot() !== 'main') return"))
t('why is recorded', cli.includes('Asked for the opposite, plainly: "do the same for created paper'))
t('extra accounts carry their own name', cli.includes('return paperAcctName(s) ?? '))
// ONE shared secret meant posting a second account overwrote the first one's, and the first
// could never update its row again.
t('each account has its own board secret',
  cli.includes("slot === 'main' ? 'hliq_paper_lb_secret' : 'hliq_paper_lb_secret_' + slot"))
t('an account not being viewed is read without switching to it', cli.includes('return paperPeek(slot, () => {'))
t('and waits for its marks rather than posting cash as equity',
  cli.includes('if (s.positions.some(p => !(paperMark(p.coin) > 0))) return null'))
t('a name someone else holds gets a distinct board name, once',
  cli.includes('if (r?.ok) localStorage.setItem(_lbPaperBoardKey(slot), name)'))
t('deleting an account removes its row', grab(cli, 'window.__paperAcctDelete = async function(slot)').includes('_lbPaperUnpost(slot, boardName)'))
t('renaming one moves its row instead of leaving a ghost', grab(cli, 'window.__paperRename = async function()').includes('await _lbPaperUnpost(slot, oldBoard)'))
t('reloads do not re-post everything', cli.includes("const _LB_PAPER_SYNC_KEY = 'hliq_paper_lb_sync'"))
t('the rename sheet no longer says extra accounts are off the board',
  !cli.includes('An extra account is never on the board'))

console.log(nl + '-- the paper board is the real board, section for section --')
{
  // Asked: "make paper account leaderboard section exactly the same as the real". Checked in
  // both shells against a real row: stats, track record, Visit / Copy / Copy trade, positions,
  // open orders. Desktop had no paper board at all.
  const srv = fs.readFileSync('server.js', 'utf8')
  const pay = grab(cli, 'function _lbPaperPayload(slot)')
  // The unit is one closing ORDER, not an hour of them and not a fill: an hour bucket merged
  // two separate trades, and a fill count split one close into the pieces it filled in.
  t('trades use the real board’s unit (one closing order)', pay.includes('const windows = tradeWindows(closed)'))
  t('each account posts a track record', pay.includes('const track = trackRecord({') && pay.includes('portfolio: paperPortfolio()'))
  t('and its open orders', pay.includes('openOrders:    paperOpenOrders()'))
  t('the server keeps both, cleaned', srv.includes('      openOrders,\n      track,\n') || (srv.includes('openOrders,') && srv.includes('      track,')))
  t('orders are re-typed, not echoed', srv.includes("const type = ['Limit', 'Take Profit Market', 'Stop Market'].includes(o?.orderType) ? o.orderType : 'Limit'"))
  t('track figures are clamped', srv.includes('profitFactor: optNum(tr.profitFactor, 0, 1e9)'))
  t('paper rows can be hidden by a dev, like real ones',
    srv.includes("path === '/api/leaderboard/paper/hide'") && srv.includes('.filter(r => isAdmin || !r.hidden)'))
  t('one mapper feeds both shells', cli.includes('function _lbPaperRowsMapped()') && cli.includes('rows = _lbPaperRowsMapped().sort('))
  t('desktop has the Real / Paper switch', cli.includes("window.__lbDeskMode = function(m)") && cli.includes('${_lbDeskModeBar()}'))
  t('a real-board load cannot paint over the paper view',
    grab(cli, 'async function renderLeaderboard()').includes("if (_lbDeskMode !== 'real') return")
      && grab(cli, 'async function _lbSilentUpdate()').includes("if (_lbDeskMode !== 'real') return"))
  t('and cannot swallow the switch to it',
    grab(cli, 'async function renderLeaderboard()').indexOf("if (_lbDeskMode === 'paper')") < grab(cli, 'async function renderLeaderboard()').indexOf('if (_lbFetching) return'))
  t('the header has My name, as the real one does', /opts\.paper[\s\S]{0,200}window\.__paperRename\(\)[\s\S]{0,100}✏️ My name/.test(cli))
  const soc = grab(cli, 'function _lbPaperSocialHtml(r)')
  t('Visit opens one of this device\u2019s accounts', soc.includes("window.__goPaper('${esc(r._slot)}')"))
  t('the toasts those buttons call are reachable from an inline handler',
    cli.includes('window._paperToast = (...a) => _paperToast(...a)') && cli.includes('window._T = (...a) => _T(...a)'))
}

console.log(nl + '-- the account you were in comes back after a reload --')
t('the slot is remembered', cli.includes("localStorage.setItem('hliq_paper_slot', paperSlot())"))
t('any account is restored, not just the Challenge', cli.includes('paperSlotKnown(_wantSlot)'))
t('and a deleted one is not', cli.includes("_wantSlot !== 'main' && paperSlotKnown(_wantSlot)"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
