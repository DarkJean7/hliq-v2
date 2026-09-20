// Leaving Pro must change the button back.
//
// Reported: with Market selected, the mobile ticket's submit button still read "Buy · Chase".
// Chase is a Pro type; Market is not. _mobVSyncProBtn painted the submit button only when Pro
// was ON:
//
//     const sub = document.getElementById('mobTradeSubmitBtn')
//     if (sub && on) sub.textContent = proButtonLabel()
//
// Pressing Market or Limit calls clearPro(), which calls this with on=false -- and the guard
// meant it did nothing, so the Pro label outlived the Pro mode. The button then named an order
// type the ticket was not going to send.
//
// The plain label existed in three places saying the same thing (the sheet's markup, the side
// toggle, and the desktop's own) and in none of them for this case, which is why nothing
// repainted it. There is one definition now.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const PRO = fs.readFileSync('src/proticket.js', 'utf8').replace(/\r\n/g, '\n')

const fnBody = (sig) => {
  const i = CLI.indexOf(sig); if (i < 0) return ''
  let j = CLI.indexOf('{', i), d = 0
  for (; j < CLI.length; j++) { if (CLI[j] === '{') d++; else if (CLI[j] === '}') { d--; if (!d) return CLI.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- the mobile ticket repaints the button BOTH ways --')
const sync = fnBody('function _mobVSyncProBtn(')
t('there is a sync function', sync.length > 0)
// Comments stripped: the note above the fix quotes the old guard verbatim to explain it.
const syncCode = sync.replace(/\/\/[^\n]*/g, '')
t('it no longer paints only when Pro is on', !/if \(sub && on\)/.test(syncCode))
t('it picks a label for each state', /sub\.textContent = on \? proButtonLabel\(\) : _mobVPlainSubmitLabel\(\)/.test(sync))
t('and why the old guard was wrong is written down', sync.includes('outlived the Pro mode'))

console.log(nl + '-- and the plain label has one definition --')
t('the helper exists', fnBody('function _mobVPlainSubmitLabel(').length > 0)
t('the side toggle uses it', /submitBtn\.textContent = _mobVPlainSubmitLabel\(\)/.test(CLI))
t('the sheet markup uses it', /\$\{esc\(_mobVPlainSubmitLabel\(\)\)\}/.test(CLI))
// The literal that used to be written out three times must not be back anywhere.
// Exactly one: the definition itself. Three was the bug.
t('the rule is written once', (CLI.match(/`Long \$\{display\}`/g) || []).length === 1)
t('nor in the markup', !/\(isBuy \? `Long \$\{esc\(display\)\}`/.test(CLI))

console.log(nl + '-- leaving Pro is still wired to both type tabs --')
// The label only goes stale if something clears the type without repainting; these are the
// two callers that clear it, and losing either brings the bug back by another route.
t('the desktop tabs leave Pro', /function setOrderType\(type\) \{[\s\S]{0,300}?clearPro\(\)/.test(CLI))
t('the mobile tabs leave Pro', /_mobVSetOrderType = function\(type\) \{[\s\S]{0,300}?clearPro\(\)/.test(CLI))
t('clearPro really nulls the type', /export function clearPro\(\) \{[\s\S]{0,160}?_type = null/.test(PRO))
t('and the desktop button has always had both branches',
  /if \(proActive\(\)\) \{[\s\S]{0,200}?proButtonLabel\(\)/.test(CLI) && /Buy \/ Long/.test(CLI))

console.log(nl + '-- the label itself says the right thing --')
// Built from the source so the assertion tracks the real function, not a copy of it.
const mk = (canTrade, side, coin) => new Function('stubs', `
  const { __canTradeUI, isMainWalletConnected, state, _spotNameMap, _mktDisplay } = stubs
  const window = { __canTradeUI }
  ${fnBody('function _mobVPlainSubmitLabel(')}
  return _mobVPlainSubmitLabel()
`)({ __canTradeUI: () => canTrade, isMainWalletConnected: () => false,
     state: { selectedCoin: coin, tradeSide: side }, _spotNameMap: {}, _mktDisplay: () => null })
t('long side names the coin', mk(true, 'long', 'LIT') === 'Long LIT')
t('short side names the coin', mk(true, 'short', 'LIT') === 'Short LIT')
t('and it never says Chase', !mk(true, 'long', 'LIT').includes('Chase'))
t('not tradeable falls back to the connect prompt', mk(false, 'long', 'LIT').includes('Connect wallet'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
