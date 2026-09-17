// Inline handlers run at GLOBAL scope. main.js is a module. Anything an onclick="…" touches
// has to be on window, or the click silently does nothing.
//
// Reported: "this wallet settings button is not working". Its handler did
//   _mobVActiveTab='settings'; …; _mobVRenderContent()
// The call worked (that one happens to be exported). The assignment did not: in a sloppy-mode
// inline handler it CREATES window._mobVActiveTab, a new variable nobody reads, and the
// module's real tab never changed. The button closed the drawer and redrew the tab that was
// already open. No error anywhere.
//
// Scanning for the same shape found two more dead buttons, both on desktop: the Leaderboard's
// "↻ Refresh" (renderLeaderboard) and the grid form's %/$ spacing toggle (toggleGridSpacing).
import fs from 'fs'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)

const files = ['index.html', ...fs.readdirSync('src').filter(f => f.endsWith('.js')).map(f => 'src/' + f)]
const text  = Object.fromEntries(files.map(f => [f, fs.readFileSync(f, 'utf8')]))
const all   = Object.values(text).join(nl)

// Everything any file puts on window.
const exposed = new Set([...all.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map(m => m[1]))
// Browser globals and keywords that look like calls.
const BUILTIN = new Set(['alert', 'confirm', 'prompt', 'event', 'setTimeout', 'clearTimeout',
  'encodeURIComponent', 'decodeURIComponent', 'parseFloat', 'parseInt', 'Number', 'String',
  'Boolean', 'Math', 'JSON', 'console', 'fetch', 'history', 'location', 'navigator', 'document',
  'this', 'if', 'return', 'switch', 'for', 'while', 'function', 'typeof', 'new', 'Array', 'Object',
  'Date', 'isNaN', 'open', 'print', 'scrollTo', 'requestAnimationFrame', 'Promise',
  'localStorage', 'sessionStorage'])

// Module-level `let`s in main.js: the names an inline handler might try to assign.
const moduleLets = new Set([...text['src/main.js'].matchAll(/^let\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]))

const handlers = []
for (const [f, s] of Object.entries(text)) {
  for (const m of s.matchAll(/\bon(?:click|change|input|keydown|keyup|submit|touchstart|blur|focus)="([^"]*)"/g)) {
    // Drop template interpolations and string literals — their contents are not code here.
    const code = m[1].replace(/\$\{[^}]*\}/g, '').replace(/'[^']*'/g, "''")
    handlers.push({ where: f + ':' + s.slice(0, m.index).split(nl).length, code })
  }
}

console.log(nl + '-- every function an inline handler calls is on window --')
{
  const missing = []
  for (const h of handlers) {
    for (const c of h.code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!BUILTIN.has(c[1]) && !exposed.has(c[1])) missing.push(c[1] + ' @ ' + h.where)
    }
  }
  t('the scan found handlers to check', handlers.length > 200, handlers.length)
  t('no inline call to an unexported function', missing.length === 0, missing.slice(0, 10))
  t('the two that were dead are exported now',
    exposed.has('renderLeaderboard') && exposed.has('toggleGridSpacing'))
}

console.log(nl + '-- no inline handler assigns a module variable --')
{
  const assigns = []
  for (const h of handlers) {
    for (const a of h.code.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*=(?!=|>)/g)) {
      if (moduleLets.has(a[1])) assigns.push(a[1] + ' @ ' + h.where)
    }
  }
  t('module variables were found to check against', moduleLets.has('_mobVActiveTab'))
  t('none is assigned from an inline handler — it would create a global nobody reads',
    assigns.length === 0, assigns.slice(0, 10))
}

console.log(nl + '-- the Wallet settings button itself --')
{
  const m = text['src/main.js'].match(/<button class="mob-wallet-settings-btn" onclick="([^"]*)"/)
  t('it exists', !!m)
  t('it goes through the same door as the More menu', m?.[1].includes("window.__mobMoreTab('settings')"), m?.[1])
  t('which really sets the tab', /window\.__mobMoreTab = function[\s\S]{0,1500}_mobVActiveTab = name/.test(text['src/main.js']))
}

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
