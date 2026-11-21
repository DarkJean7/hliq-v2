// The desktop Trade tab's order panel and the "Trade from account" pills: "make the right
// independent. also i cannot scroll the accounts from 'trade from account'".
// tests/tradepanel-browser.mjs drives the real thing; this keeps the wiring from being undone.
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const main = fs.readFileSync('src/main.js', 'utf8'), css = fs.readFileSync('src/style.css', 'utf8'), sticky = fs.readFileSync('src/stickycol.js', 'utf8')

t('the panel is fitted to the visible area when the Trade tab opens', main.includes("fitSticky(document.querySelector('.trade-order-col'))()"))
t('it measures what actually scrolls (the app scrolls <main>, not the document)', sticky.includes("/(auto|scroll)/.test(getComputedStyle(n).overflowY)"))
t('and again when the window changes', sticky.includes("addEventListener('resize', apply)"))
t('one column (phones, narrow windows) is left alone', sticky.includes('innerWidth < minWidth'))
t('on desktop the panel scrolls on its own', /@media \(min-width: 1001px\) \{\s*\.trade-order-col \{ overflow-y: auto; overscroll-behavior: contain;/.test(css))
t('every hidden-scrollbar strip moves with a mouse, wheel and drag', main.includes("const s = e.target?.closest?.('.hscroll-x'); if (s) enableMouseScroll(s)"))
t('the picker is drawn again when the combined load ends', /function _hideAllAcctLoader\(\) \{[\s\S]{0,400}_syncTradeAcctPicker\(\)/.test(main))
t('the browser test is in the suite', fs.readFileSync('tests/browser.mjs', 'utf8').includes("'tradepanel-browser.mjs'"))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
