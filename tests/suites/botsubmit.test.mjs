// Community bot submissions: a user offers a device bot, the operator reads it.
//
// The whole feature is a message queue that happens to carry source code, and the only way
// it stays safe is that nothing on the server side ever treats that code as code. These
// assertions exist to keep it that way: a later change that adds a "run it" button, or
// drops the PIN off the read, should turn this suite red rather than ship.
import fs from 'fs'
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const ignore = fs.readFileSync('.gitignore', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (src, sig) => {
  const i = src.indexOf(sig); if (i < 0) return ''
  let j = src.indexOf('{', i), d = 0
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1) } }
  return ''
}
const nl = String.fromCharCode(10)

const submit = grab(srv, "path === '/api/bot-submit'")
const list   = grab(srv, "path === '/api/bot-submissions'")
const status = grab(srv, "path === '/api/bot-submission-status'")

console.log(nl + '-- the endpoints exist --')
t('POST /api/bot-submit', submit.length > 0)
t('GET /api/bot-submissions', list.length > 0)
t('POST /api/bot-submission-status', status.length > 0)

console.log(nl + '-- the submitted code is never executed --')
// This is the whole safety story. A submission is text: stored as text, listed as text,
// shown as text. The moment any of these appears near it, the queue becomes a way for a
// stranger to run code as root on the box that holds the trading keys.
const region = submit + list + status
for (const danger of ['eval(', 'new Function', "require('vm')", 'require("vm")', 'vm.runIn',
                      'child_process', 'execSync(', 'spawnSync(', 'import(']) {
  t(`no ${danger} anywhere near a submission`, !region.includes(danger))
}
// The stored file is data, and the only thing that ever opens it parses it as JSON.
t('the inbox is only ever read as JSON', grab(srv, 'function loadSubmissions').includes('JSON.parse'))
t('and only ever written with JSON.stringify', submit.includes('JSON.stringify(list.slice(-500)'))
t('nothing imports the inbox as a module', !srv.includes("from './bot-submissions.json'"))
t('why is written down where the next person will look',
  srv.includes('NOTHING HERE EVER RUNS THE SUBMITTED CODE'))
t('and it names the failure mode, not just the rule',
  srv.includes('remote code execution hole with a friendly label on it'))

console.log(nl + '-- submitting is open, but bounded --')
// Open on purpose: a user who wrote a bot should not need an account to offer it. Bounded
// because open means anyone, including someone with a script.
t('empty code is refused', submit.includes("if (!code.trim()) return json(res, 400, { error: 'no code' })"))
t('a size cap is enforced', /code\.length > 64_?000/.test(submit) && submit.includes('413'))
t('the cap is justified rather than arbitrary',
  srv.includes('a bot file that will not fit in 64KB is not' + nl + '  // a bot file'))
t('it is rate limited per IP', submit.includes('submitAllowed(ip)') && submit.includes('429'))
t('the limiter exists', srv.includes('function submitAllowed(ip)'))
t('the inbox cannot grow without bound', submit.includes('list.slice(-500)'))
t('long text fields are capped too',
  submit.includes(".slice(0, 80)") && submit.includes(".slice(0, 1000)") && submit.includes(".slice(0, 64)"))

// Drive the limiter rather than trusting it by inspection.
const submitAllowed = new Function(`
  const _submitHits = new Map()
  ${grab(srv, 'function submitAllowed(ip)')}
  return submitAllowed`)()
const first5 = [1, 2, 3, 4, 5].map(() => submitAllowed('1.2.3.4'))
t('five in a row are allowed', first5.every(Boolean))
t('the sixth is not', submitAllowed('1.2.3.4') === false)
t('and one caller does not block another', submitAllowed('5.6.7.8') === true)

console.log(nl + '-- reading the queue is operator-only --')
// The queue holds other people's unpublished work. Both operator routes check the PIN, and
// an unset PIN must not read as "no check required".
for (const [name, block] of [['the listing', list], ['the status write', status]]) {
  t(`${name} requires the PIN`, block.includes("LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN"))
  t(`${name} refuses without it`, block.includes("return json(res, 403, { error: 'forbidden' })"))
}
t('an unset PIN locks the door rather than opening it',
  list.includes('LB_PIN &&'))

console.log(nl + '-- the submitter\'s address is not part of the review --')
// The IP is kept so the rate limiter has something to count. Nothing about reading a bot
// needs to know where the person lives.
t('the listing strips it', list.includes('.map(({ ip, ...rest }) => rest)'))
t('why is recorded', list.includes('not for reading'))
t('the inbox file is gitignored', /^bot-submissions\.json$/m.test(ignore))
t('and the reason is in the ignore file', ignore.includes("IP addresses; never commit it"))

console.log(nl + '-- a status is one of three words --')
t('the set is closed', status.includes("['new', 'kept', 'declined'].includes(b.status)"))
t('anything else is a bad request', status.includes("return json(res, 400, { error: 'bad request' })"))
t('an unknown id is a 404, not a silent no-op', status.includes("404, { error: 'not found' }"))
t('a new submission starts as new', submit.includes("status: 'new'"))

console.log(nl + '-- the app side --')
t('every device bot can be offered', cli.includes("window.__devBotSubmit('${b.id}')"))
t('the sheet exists', cli.includes('window.__devBotSubmit = function(id)'))
t('it sends the code and the settings it ran with',
  grab(cli, 'window.__devBotSubmitSend = async function(id)').includes('code: def.code') &&
  grab(cli, 'window.__devBotSubmitSend = async function(id)').includes('config: { coin: def.coin'))
t('it tells the user the bot keeps running on their device',
  cli.includes('It keeps running on your device either way'))
t('and that sending it does not run it elsewhere',
  cli.includes('sending it does not run it anywhere else'))

console.log(nl + '-- the review queue is dev-mode only --')
const strat = grab(cli, 'function _devBotsHtml')
t('the button is behind isDev()',
  /isDev\(\) \? `<div[^`]*__openBotSubmissions/s.test(cli))
t('the queue sends the PIN it has', grab(cli, 'window.__openBotSubmissions').includes("'x-lb-pin': pin"))
t('a 403 says so plainly rather than looking empty',
  grab(cli, 'window.__openBotSubmissions').includes("_botSubsRender('forbidden')") &&
  cli.includes('The server did not accept the dev PIN.'))
t('an empty queue and a failed load do not look alike',
  cli.includes('Nothing submitted yet.') && cli.includes('Could not load submissions.'))

console.log(nl + '-- a stranger\'s file is displayed, never interpreted --')
const codeSheet = grab(cli, 'window.__botSubCode = function(id)')
t('the code is escaped', codeSheet.includes('${esc(row.code)}'))
t('the name is escaped too', codeSheet.includes('esc(row.name)'))
t('it renders in a pre, not as markup', codeSheet.includes('<pre style='))
t('the reader is told whose code it is', codeSheet.includes('It is somebody else'))
// Copying used to carry the file through an inline onclick attribute, which is exactly
// where a quoting bug becomes an injection.
t('copy reads from the rendered element', grab(cli, 'window.__botSubCopy = function').includes("querySelector('#botSubCodeSheet pre')"))
t('nothing interpolates raw code into an attribute', !codeSheet.includes('onclick="navigator.clipboard'))
t('every field in a row is escaped',
  ['esc(s.name)', 'esc(s.author', 'esc(s.status)', 'esc(s.note)', 'esc(s.id)'].every(x => cli.includes(x)))

console.log(nl + '-- keeping one is a note to self, not an install --')
// The operator marks a submission; shipping it is still a person reading the file and
// committing it. Nothing in the app installs a submitted bot.
t('the sheet says so', cli.includes('Nothing here installs or runs a submitted file.'))
t('keeping is described as marking, not shipping', cli.includes('marks it for you to ship through the normal path'))
t('no client path installs a submission',
  !grab(cli, 'window.__botSubStatus').includes('devBotsSave') &&
  !grab(cli, 'function _botSubsRender').includes('devBotsSave'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
