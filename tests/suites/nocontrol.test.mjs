// No invisible control characters in anything that ships.
//
// Edits made through scripts turn an escaped "\b" into a literal backspace (0x08). It is invisible
// in an editor and in a diff, and it does damage both ways: in portfolio.html it made the whole
// page fail to parse ("control-character-in-input-stream", caught 2026-10-20 before it shipped),
// and in a regex in src/main.js a /\bcoins\b/ had silently become /␈coins␈/, which never matches.
import fs from 'fs'
import { join } from 'path'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const files = [
  'index.html', 'portfolio.html', 'landing.html', 'markets.html', 'server.js', 'serve-prod.js', 'notify-server.js',
  ...fs.readdirSync('src').filter(f => /\.(js|css)$/.test(f)).map(f => join('src', f)),
  ...fs.readdirSync('strategies').filter(f => /\.js$/.test(f)).map(f => join('strategies', f)),
].filter(f => fs.existsSync(f))
const bad = []
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8')
  const re = /[\x00-\x08\x0b\x0c\x0e-\x1f]/g
  let m
  while ((m = re.exec(s))) bad.push(`${f}:${s.slice(0, m.index).split('\n').length} (0x${m[0].charCodeAt(0).toString(16).padStart(2, '0')})`)
}
t(`no control characters in the ${files.length} files that ship`, bad.length === 0, bad.slice(0, 10))
console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
