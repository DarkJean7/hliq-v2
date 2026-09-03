// A bot that ships with the app arrives with the card it needs.
//
// The file was never the hard part of using a device bot. The card was: fifteen markets
// typed in by hand on a phone, and caps whose defaults suit a one-market bot. A portfolio
// bot on the default four-orders-a-minute cap opens its whole book in one tick, gets four
// through and eleven refused, and reads as a broken strategy rather than a filled-in form.
//
// So a preset is the file AND its card, and these assertions are mostly about the card.
import fs from 'fs'
const pre = fs.readFileSync('src/botpresets.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const tokyo = fs.readFileSync('src/bots/tokyo-partners.js', 'utf8')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

console.log(nl + '-- the file ships as a file --')
// Inlining it as a template literal would put backticks and ${ } from a stranger's code
// inside a JS string, which is how a bot that was reviewed stops being the bot that runs.
t('the code is imported raw, not pasted into a string',
  pre.includes("from './bots/tokyo-partners.js?raw'"))
t('why raw matters is recorded', pre.includes('byte for byte'))
t('and the file is actually there', tokyo.length > 5000, String(tokyo.length))
t('it is the multi-market version, not the one-market one',
  tokyo.includes('ctx.coins') && tokyo.includes('for (const coin of mercados)'))
t('presets are their own module, not more of main.js',
  fs.existsSync('src/botpresets.js'))

console.log(nl + '-- the card comes with it --')
const tk = grab(pre, "id: 'tokyo-partners'")
const coins = JSON.parse((tk.match(/coins: (\[[^\]]*\])/s) ?? [])[1].replace(/'/g, '"'))
const cap = Number((tk.match(/maxPerMin: (\d+)/) ?? [])[1])
t('all fifteen markets are listed', coins.length === 15, String(coins.length))
t('they carry their dex prefix, so they resolve', coins.includes('xyz:SMSN'), coins.join(','))
t('every market in the file table is on the card',
  ['ZEC', 'CASHCAT', 'SMSN', 'SKHX', 'LIT', 'XMR', 'SNDK', 'EWY', 'MU', 'NEAR',
   'DRAM', 'PUMP', 'INTC', 'SPCX', 'SOXL'].every(m => coins.some(c => c.endsWith(m))),
  coins.join(','))
// The whole reason presets exist. A cap below the count truncates the portfolio silently.
t('the rate cap can carry one order per market in a tick', cap >= coins.length,
  cap + ' vs ' + coins.length)
t('why the cap is not the form default is recorded',
  pre.includes('one tick opens the whole book at once') &&
  pre.includes('silently truncates the portfolio'))
t('the home market is the first of the list', tk.includes("coins[0]") || cli.includes('coin: b.coins[0]'))

console.log(nl + '-- adding one is still a decision --')
// A preset is a filled-in form, not a privileged path: same sheet, same acknowledgement.
const add = grab(cli, 'window.__devBotPresetAdd = function(id)')
t('it goes through the ordinary install sheet', add.includes('_devBotInstallSheet(null)'))
t('as a new bot', add.includes('_devBotInstallSheet(null)'))
t('it brings its own caps, not the form defaults',
  add.includes('maxPerMin: b.maxPerMin') && add.includes('maxUsd: b.maxUsd'))
t('why its own caps matter is recorded', cli.includes('trades the first four markets and looks broken'))
t('the acknowledgement is still there', cli.includes('id="devBotAck"'))
t('nothing installs without the sheet',
  !add.includes('devBotsSave'))
t('the code can be read before it is added',
  cli.includes('window.__devBotPresetCode = function(id)'))
t('and it is escaped when shown', grab(cli, 'window.__devBotPresetCode = function(id)').includes('esc(b.code)'))

console.log(nl + '-- and it is reachable --')
t('there is a button in the strategies tab', cli.includes('window.__devBotPresets()'))
t('the picker exists', cli.includes('window.__devBotPresets = function()'))
t('it says these run on your device', cli.includes('run on your device like any other'))
t('it tells you to read it first', cli.includes('Read one before you run it'))
t('a small account is warned about, with the arithmetic',
  pre.includes('minEquity') && pre.includes('under the exchange minimum'))
t('the warning is shown, not just stored', cli.includes('b.minEquity ?'))

console.log(nl + '-- a file is not rewritten between reading it and running it --')
// The install path trims whitespace at the ends and does nothing else. If that ever grows
// into reformatting, the code someone reviewed stops being the code that runs.
t('only the ends are trimmed', cli.includes("document.getElementById(id)?.value?.trim() ?? ''"))
t('and that limit is written down', cli.includes('nothing inside it is rewritten'))
t('why it matters is written down too', cli.includes('a bot you read is the bot that runs'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
