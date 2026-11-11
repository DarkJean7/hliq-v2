// Mobile position cards: the liquidation price under the mark (src/main.js _mobVLiqLine).
//
// Asked for: "under positions mark price lets have 'liq price'. in multiple cards use the
// closest to get liquidated". The helper is pure arithmetic over the members it is handed; it
// is lifted out of main.js and run here, so the "closest" rule is tested, not just named.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const src = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

const start = src.indexOf('function _mobVLiqLine(')
const body = src.slice(start, src.indexOf('\n}\n', start) + 2)
const _mobVLiqLine = new Function('_T', 'esc', 'fmtPrice', body + '; return _mobVLiqLine')(
  (en) => en, (s) => String(s), (v) => (+v).toFixed(2))

const val = (h) => (h.match(/\$([\d.]+)<\/span><\/span>$/) ?? [])[1]

console.log('-- one account --')
t('a long at 100 with liquidation at 70 says Liq $70.00', val(_mobVLiqLine([{ liquidationPx: '70' }], 100)) === '70.00')
t('30% away is a plain colour', /color:var\(--fg-2\)/.test(_mobVLiqLine([{ liquidationPx: '70' }], 100)))
t('inside 25% it is amber', /color:var\(--warn\)/.test(_mobVLiqLine([{ liquidationPx: '80' }], 100)))
t('inside 10% it is red', /color:var\(--red\)/.test(_mobVLiqLine([{ liquidationPx: '93' }], 100)))
t('no liquidation price reported says "none" -- a fact, not a blank', /none/.test(_mobVLiqLine([{ liquidationPx: null }], 100)))
t('without a mark there is nothing to measure against: left out', _mobVLiqLine([{ liquidationPx: '70' }], 0) === '')

console.log('-- several accounts: the closest one --')
// The merged card hands over summary members ({ acct, liquidationPx }), not raw positions.
const g = _mobVLiqLine([{ liquidationPx: 60, acct: 'A' }, { liquidationPx: 88, acct: 'Brrr' }, { liquidationPx: 75, acct: 'C' }], 100)
t('it shows the liquidation nearest the mark', val(g) === '88.00', g)
t('and says which account in the hover', /Brrr/.test(g))
t('a short works the same way: liquidation above the mark', val(_mobVLiqLine([{ liquidationPx: '140' }, { liquidationPx: '112' }], 100)) === '112.00')
t('an account with none does not hide the others', val(_mobVLiqLine([{ liquidationPx: null }, { liquidationPx: '80' }], 100)) === '80.00')

console.log('-- on both cards --')
// "move the liq price lower, to the same level as health" -- on the health row, not under the mark.
t('the multi-account card carries it on its health row', src.includes('${summary.label}</span>${_mobVLiqLine(members, markPx)}</span>'))
t('and the single-account card', src.includes('>Health</span>${_mobVLiqLine([p], markPx)}</span>'))
t('no longer under the mark', !/pos-mark-[^\n]*\n\s*\$\{_mobVLiqLine/.test(src))
// It said "none" on every merged card: the members it was handed had no liquidation price.
t('the merged card\'s members carry each account\'s liquidation price', src.includes("acctAddr: p._acctAddr ?? null, liquidationPx: liqPx,"))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
