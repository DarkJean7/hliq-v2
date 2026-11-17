// Every function the app puts on `window` is defined once.
//
// Twice in one session a new function silently took a name that was already in use, and the later
// definition won: window.__ocTrade (the Outcomes ORDER button) replaced a new "go to this market"
// helper of the same name, so the new Trade button did nothing — and had the order been defined
// first, the button would have replaced the order. Nothing errors when this happens; the build
// passes and the page loads. This makes it fail here instead.
//
// Deliberate wrappers (`const orig = window.x; window.x = function () { orig(); … }`) are not
// matched: they assign through a different form and are written to call what they replace.
import fs from 'fs'
import path from 'path'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const seen = new Map()   // name -> [file:line]
for (const f of fs.readdirSync('src').filter(f => f.endsWith('.js'))) {
  fs.readFileSync(path.join('src', f), 'utf8').split('\n').forEach((line, i) => {
    const m = /^window\.(__?[A-Za-z0-9_]+)\s*=\s*(async\s+)?(function\b|\()/.exec(line)
    if (m) seen.set(m[1], [...(seen.get(m[1]) ?? []), `${f}:${i + 1}`])
  })
}
const dupes = [...seen].filter(([, at]) => at.length > 1)
t(`each of the ${seen.size} window functions is defined once`, dupes.length === 0, dupes)
t('the Outcomes order button and the go-to-market helper have their own names',
  seen.has('__ocTrade') && seen.has('__ocGoTrade'))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
