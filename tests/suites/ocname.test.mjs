// Outcome names without the HIP-3 deployer ("xyz:GOLD >$4,600 …" → "GOLD >$4,600 …"), and a
// solid Sell sheet. Asked: "make the spot sell panel non-transparent. lets try and remove the
// hip3 deployer in the outcomes name, across the app like from outcomes tab, section,
// history, calendar".
import fs from 'fs'
const CLI = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

const src = CLI.slice(CLI.indexOf('function _ocStripDex(s) {'), CLI.indexOf('\n}\n', CLI.indexOf('function _ocStripDex(s) {')) + 2)
const strip = new Function(src + '; return _ocStripDex')()
t('the deployer goes', strip('xyz:GOLD >$4,600 (Oct 30, 2026)') === 'GOLD >$4,600 (Oct 30, 2026)')
t('any dex, mid-sentence too', strip('Will flx:BTC close above $100k') === 'Will BTC close above $100k')
t('a time is not a deployer', strip('Fed decision at 10:00 UTC') === 'Fed decision at 10:00 UTC')
t('nor a colon in a sentence', strip('BTC above $100k: yes') === 'BTC above $100k: yes')
t('nothing to strip, nothing changes', strip('USA vs Brazil') === 'USA vs Brazil' && strip(null) === null)

// Once, wherever a name is made or loaded — so every surface that shows one shows it without.
t('names are stripped as they are built', CLI.includes('const underlying  = _ocStripDex(d.underlying || o.name)') && CLI.includes('state.ocQuestionMap[oid] = _ocStripDex(qName)'))
t('and as saved ones load (names cached before this are cleaned)', /for \(const v of Object\.values\(cached\)\) if \(v && v\.name\) v\.name = _ocStripDex\(v\.name\)/.test(CLI))
t('and in the label every surface reads (History, Calendar, positions, Outcomes)', CLI.includes('const nm = _ocStripDex(t.name); return t.side'))
t('the Outcomes card says shares, not the name with its spaces turned into dashes', !CLI.includes("nm.replace(/\\s+/g, '-')") && CLI.includes("['Size', _prv(fmtSize(total)) + ' ' + _T('shares', 'acciones')]"))

// Asked: "similar as positions, include the whole outcome title, the current price, etc. — all
// important info I may want without visiting the outcomes marketplace".
t('each outcome keeps its terms with its name, and they are saved and loaded like the names',
  CLI.includes('state.ocInfoMap[o.outcome] = { u: d.underlying || null, t: num(d.targetPrice)') &&
  CLI.includes("localStorage.setItem('hliq_oc_info_map'") && CLI.includes("JSON.parse(localStorage.getItem('hliq_oc_info_map')"))
t('the phone card and the desktop row both read the one helper, with the position\'s mark', (CLI.match(/const facts = _ocFacts\(b\.coin, mark\)/g) || []).length === 2)
t('the title is the whole market, wrapping instead of cut off', CLI.includes('-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden">${esc(facts.market || title)}'))
t('the underlying against the target, how far, and time left, under the title', CLI.includes('function _ocFactsLine(f)') && CLI.includes("% ${_T('away', 'de distancia')}"))
t('the details add the question, underlying, target or range, settle time, chance and other sides', CLI.includes('..._ocFactsRows(facts),') && /function _ocFactsRows\(f\)[\s\S]{0,1600}Implied chance[\s\S]{0,400}f\.others/.test(CLI))
t('a side not loaded falls back to the mark, its complement for a two-sided market', CLI.includes('own != null && sides.length === 2 ? 1 - own : null'))

const ss = fs.readFileSync('src/spotsell.js', 'utf8')
t('the Sell sheet paints solid, even over a wallpaper (the opaque copy of its surface)', ss.includes('background:var(--panel-3-o, var(--panel-3, var(--bg)))'))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
