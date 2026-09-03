// One paper account must never show, or overwrite, another's money.
//
// Reported as "this account got infected with fake trades that i never did", in an account
// the owner had just made — and not once: intermittently, in any of them.
//
// The cause was two lines that looked defensive. paperKey() resolves a slot to a storage
// key on EVERY load and EVERY save, and it decided whether a slot was real by reading the
// account registry out of localStorage. A failed read returned "no accounts", which made an
// ordinary account unknown, and an unknown slot fell back to the practice account:
//
//   return paperSlotKnown(slot) ? extraKey(slot) : PAPER_KEYS.main
//
// So one refused read — iOS under memory pressure, storage being cleared, a private window —
// and the account you were standing in displayed the practice account's positions, and the
// next save wrote your book over the practice account's. Both directions, silently.
//
// This suite runs the real module against a localStorage that refuses exactly one key, and
// it fails on the old code in both directions. That is the point of it: the fix is one line,
// and one line is very easy to put back.
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

// Only the account-list read fails, which is the real shape of it: localStorage refuses one
// call and answers the next. The store read then succeeds — against whichever key the failed
// read caused us to pick. A shim that failed every call would never reach the bug.
const LIST = 'hliq_paper_accts'
let failList = false, store = {}
globalThis.localStorage = {
  getItem(k) {
    if (failList && k === LIST) throw new Error('SecurityError: storage unavailable')
    return k in store ? store[k] : null
  },
  setItem(k, v) { store[k] = String(v) },
  removeItem(k) { delete store[k] },
}

// Imported from a copy so this suite cannot be affected by, or affect, module caching
// elsewhere in the run.
const dir = join(tmpdir(), 'hliq-paperslot-' + process.pid)
mkdirSync(dir, { recursive: true })
const modPath = join(dir, 'paper.mjs')
writeFileSync(modPath, readFileSync('src/paper.js', 'utf8'))
const P = await import('file:///' + modPath.replace(/\\/g, '/'))

const pos = (coin, szi, entryPx) => ({ coin, szi, entryPx, margin: 27, leverage: 10, isIsolated: false })

console.log(nl + '-- accounts start out their own --')
P.setPaperSlot('main')
const main = P.paperStore()
main.positions.push(pos('HYPE', 5, 54))
main.balance = 900
P.paperSave()

const { slot, error } = P.paperAcctCreate('Paper 3')
t('a new account can be made', !!slot && !error, String(error))
P.setPaperSlot(slot)
t('and opens with no positions', P.paperStore().positions.length === 0,
  JSON.stringify(P.paperStore().positions.map(x => x.coin)))
t('and its own opening balance', P.paperStore().balance === P.PAPER_START,
  String(P.paperStore().balance))

console.log(nl + '-- a refused read must not hand over another account --')
// Force a reload of the new slot, then refuse the registry on the way in.
P.setPaperSlot('main'); P.setPaperSlot(slot)
failList = true
const seen = P.paperStore()
failList = false
t('the account does not display the practice account\'s positions',
  !seen.positions.some(x => x.coin === 'HYPE'), JSON.stringify(seen.positions.map(x => x.coin)))
t('nor its balance', seen.balance !== 900, String(seen.balance))

console.log(nl + '-- and must not write one account over another --')
// The damaging direction. The read above only shows you someone else's money; this one
// spends it.
P.setPaperSlot(slot)
P.paperStore().positions.push(pos('ADA', -100, 0.2))
failList = true
P.paperSave()
failList = false
P.setPaperSlot('main')
const after = P.paperStore()
t('the practice account still holds only what it held',
  after.positions.length === 1 && after.positions[0].coin === 'HYPE',
  JSON.stringify(after.positions.map(x => x.coin)))
t('with its balance intact', after.balance === 900, String(after.balance))

console.log(nl + '-- empty is not the same as unknown --')
// The repo has lost a day to this distinction three times. Here it decides whose money is
// on screen: "no key" means there are no extra accounts, a THROW means we could not look.
store[LIST] = JSON.stringify([{ slot, name: 'Paper 3', createdAt: Date.now() }])
t('a readable registry is used', P.paperAcctList().length === 1, String(P.paperAcctList().length))
failList = true
const cached = P.paperAcctList()
failList = false
t('an unreadable one replays the last good answer', cached.length === 1, JSON.stringify(cached))
t('rather than claiming there are none', cached.length !== 0)
delete store[LIST]
t('but a genuinely absent registry is still empty', P.paperAcctList().length === 0)

console.log(nl + '-- the fallback that caused it is gone --')
const src = readFileSync('src/paper.js', 'utf8')
t('an unknown slot no longer resolves to the practice account',
  !src.includes('paperSlotKnown(slot) ? extraKey(slot) : PAPER_KEYS.main'))
t('a slot gets its own store, full stop',
  /function keyFor\(slot\) \{[^}]*return extraKey\(slot\)/s.test(src))
t('why the old fallback existed, and why it was not needed, is recorded',
  src.includes('paperAcctDelete') && src.includes('moves _slot to'))
t('the failure it caused is written down, not just the rule',
  src.includes('trades the owner had never made'))

rmSync(dir, { recursive: true, force: true })
console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
