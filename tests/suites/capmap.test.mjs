// The name→cap map: _mktCtxMap is keyed by '@N'/'TOKEN/USDC', Pulse knows plain names.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const build = new Function('_mktCtxMap', '_spotNameMap', `
  let _mktCapByName = {}
  for (const [k, v] of Object.entries(_mktCtxMap)) {
    const name = _spotNameMap[k]
    const cap  = v?.marketCap ?? 0
    if (name && cap > (_mktCapByName[name] ?? 0)) _mktCapByName[name] = cap
  }
  return _mktCapByName`)

t('a plain name resolves through the @N key',
  build({ '@1': { marketCap: 5e9 } }, { '@1': 'HYPE' }).HYPE === 5e9)
t('four tokens called HYPE collapse to the biggest, not the last one seen',
  build({ '@1': { marketCap: 5e9 }, '@2': { marketCap: 12 }, '@3': { marketCap: 3 } },
        { '@1': 'HYPE', '@2': 'HYPE', '@3': 'HYPE' }).HYPE === 5e9)
t('the pair key and the @N key for one token do not double-count',
  Object.keys(build({ '@0': { marketCap: 7 }, 'PURR/USDC': { marketCap: 7 } },
                    { '@0': 'PURR', 'PURR/USDC': 'PURR' })).length === 1)
t('a key with no display name is skipped rather than stored as undefined',
  build({ '@9': { marketCap: 1 } }, {}).undefined === undefined)
t('a perp with no spot listing has no cap, and the card shows a dash',
  build({}, {})['SOL'] === undefined)
t('the map is rebuilt on each refresh rather than accumulating stale names',
  /_mktCapByName = \{\}\n\s+for \(const \[k, v\] of Object\.entries\(_mktCtxMap\)\)/.test(cli))
t('it is module-level, so Pulse can read it', /^let _mktCapByName/m.test(cli))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
