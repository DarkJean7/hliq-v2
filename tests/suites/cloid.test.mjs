// Telling a bot's trades from the account owner's own.
//
// Bot Performance attributed by coin: every fill in a market a bot ran on counted as that
// bot's, manual trades included. Nothing on a Hyperliquid fill distinguishes them -- bot
// and manual orders are signed with the same agent key -- so the bot now says who it is
// when it places, using the client order id HL carries through onto the fill.
import fs from 'fs'
import { botCloid, cloidBot, isBotFill, BOT_CODES } from '../../src/cloid.js'

const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const fmt = fs.readFileSync('src/format.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log(String.fromCharCode(10) + '-- the id is well formed and unique --')
const HL_CLOID = /^0x[0-9a-f]{32}$/
t('it matches the shape HL requires', HL_CLOID.test(botCloid('grid')))
const many = new Set(Array.from({ length: 20000 }, () => botCloid('grid')))
t('20,000 in a row are all different', many.size === 20000, many.size)
t('every one is still well formed', [...many].every(c => HL_CLOID.test(c)))

console.log(String.fromCharCode(10) + '-- it round-trips to the right bot --')
for (const type of Object.keys(BOT_CODES)) {
  t(`${type} decodes to itself`, cloidBot(botCloid(type)) === type, cloidBot(botCloid(type)))
}
// guardian.js backs two bot types, so the type cannot come from the filename.
t('the two guardian modes stay distinct', cloidBot(botCloid('liqguard')) !== cloidBot(botCloid('levbrake')))
t('an unknown type still reads as a bot, not as manual', cloidBot(botCloid('nonesuch')) === 'other')

console.log(String.fromCharCode(10) + '-- absent is unknown, never "manual" --')
// The distinction this codebase keeps paying for. A fill with no cloid may be a bot trade
// from before tagging, or a hand-placed one. Nothing can tell, so nothing may claim.
t('no cloid is null', cloidBot(undefined) === null && cloidBot(null) === null)
t('an empty string is null', cloidBot('') === null)
t('a foreign cloid is null', cloidBot('0x' + 'a'.repeat(32)) === null)
t('a malformed one is null', cloidBot('0xb07') === null && cloidBot('nonsense') === null)
t('isBotFill agrees', isBotFill({ cloid: botCloid('dca') }) && !isBotFill({}) && !isBotFill({ cloid: null }))

console.log(String.fromCharCode(10) + '-- every bot stamps every order --')
const files = fs.readdirSync('strategies').filter(f => f.endsWith('.js') && f !== '_pause.js')
for (const f of files) {
  const src = fs.readFileSync('strategies/' + f, 'utf8')
  const orders = (src.match(/orders: \[\{/g) || []).length
  const stamps = (src.match(/c: botCloid\(process\.env\.HLIQ_BOT\)/g) || []).length
  if (orders === 0) continue
  t(`${f}: all ${orders} order site(s) stamped`, stamps === orders, { orders, stamps })
  t(`${f}: imports it`, src.includes("from '../src/cloid.js'"))
}

console.log(String.fromCharCode(10) + '-- the type reaches the bot, and the id reaches the client --')
t('server passes HLIQ_BOT when spawning', (srv.match(/HLIQ_BOT: type/g) || []).length === 2)
t('parseFills carries cloid through', fmt.includes('cloid:     f.cloid ?? null,'))
t('and says absent means unknown', fmt.includes('absent means UNKNOWN here'))

console.log(String.fromCharCode(10) + '-- the screen uses it --')
t('exact mode selects by cloid, not by coin', cli.includes('if (_perfExact) return fills.filter(f => cloidBot(f.cloid) === t)'))
t('the total counts every tagged fill once', cli.includes('statsFrom(fills.filter(f => cloidBot(f.cloid) !== null), [])'))
t('per-market cards follow the same mode', cli.includes('const fills = exact ? all.filter(f => cloidBot(f.cloid) !== null) : all'))
// Funding is charged on a position, not an order, so it has no cloid to attribute by.
t('funding is dropped rather than guessed', cli.includes('for (const f of (exact ? [] : funding))'))
t('auto: exact as soon as anything is tagged', cli.includes("return (fills ?? []).some(f => cloidBot(f.cloid) !== null)"))
t('but the choice can be pinned either way', cli.includes("if (pref === '1') return true") && cli.includes("if (pref === '0') return false"))
t('both layouts show the mode and what it means', (cli.match(/_perfModeBar\('/g) || []).length === 2)
t('the toggle repaints the view it is on', cli.includes('if (_isMobView()) _mobVRenderContent(); else renderPerformance()'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
