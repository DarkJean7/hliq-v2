// Telling two paper accounts apart on screen.
//
// Reported as "same paper account, different account equity": two accounts both showing
// the name "tokyo", the same subtitle, and different balances. Nothing on the main screen
// distinguished them, so it read as one account whose equity kept changing.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const pap = fs.readFileSync('src/paper.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- the line under the name says which account it is --')
const kind = grab(cli, 'function _paperKindLabel')
t('there is a label for it', kind.length > 100)
t('the practice account is named as such', kind.includes('Paper · practice account'))
t('the Challenge keeps its own line', kind.includes('Challenge · $1,000 paper'))
t('a created account is numbered', kind.includes('Paper · account ${i + 2} of ${list.length + 1}'))
t('an account with no registry row still gets a line, not a blank',
  kind.includes("i < 0 ? _T('Paper · simulated funds'"))
t('why the identical subtitle was a problem is recorded',
  cli.includes('reads as one account whose'))

console.log(nl + '-- every place that showed the old fixed text uses it --')
t('the mobile header', cli.includes('addrEl.textContent = _paperKindLabel()'))
t('the desktop wallet strip', cli.includes(': addr === PAPER_ADDR ? _paperKindLabel()'))
t('and the account switcher', cli.includes(': _isPaperCur ? _paperKindLabel()'))
t('no fixed "simulated funds, no real orders" line survives',
  !cli.includes("'Paper · simulated funds, no real orders'"))

console.log(nl + '-- the function it needs is actually imported --')
// It was not. The render threw ReferenceError, the caller swallowed it, and the header
// kept the PREVIOUS account's name -- which is the same symptom, from a new cause.
t('paperAcctList is imported into main.js', /paperAcctName, paperAcctList,/.test(cli))
t('and the label is the only thing that needed it',
  grab(cli, 'function _paperKindLabel').includes('paperAcctList()'))

console.log(nl + '-- two accounts cannot end up with one name --')
t('there is a uniqueness helper', pap.includes('export function paperUniqueName'))
t('creating uses it', grab(pap, 'export function paperAcctCreate').includes('paperUniqueName'))
t('renaming uses it too', grab(pap, 'export function paperAcctRename').includes('paperUniqueName(name, slot)'))
t('an account may keep its own name when renamed', pap.includes('a.slot !== exceptSlot'))
t('the practice account name counts as taken, though it is not in the registry',
  pap.includes("localStorage.getItem('hliq_paper_name')"))
t('a clash is numbered rather than refused', pap.includes('`${want} ${i}`'))
t('why numbering rather than refusing is recorded', pap.includes('which is what a person would have done anyway'))
t('the numbering gives up rather than looping forever', pap.includes('i < 100'))
t('an empty name is left alone for the caller to default', pap.includes("if (!want) return want"))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
