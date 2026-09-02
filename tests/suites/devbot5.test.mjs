// Preview for device bots: the real file, on real data, sending nothing.
import fs from 'fs'
const bot = fs.readFileSync('src/devicebot.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (src, sig) => {
  const i = src.indexOf(sig); if (i < 0) return ''
  let j = src.indexOf('{', i), d = 0
  for (; j < src.length; j++) { if (src[j] === '{') d++; else if (src[j] === '}') { d--; if (!d) return src.slice(i, j + 1) } }
  return ''
}

console.log(String.fromCharCode(10) + '-- both routes out are closed, not just one --')
// Closing only the intent path would let a bot that trades via api.order() place real
// orders during a preview. That is the one outcome a preview must never have.
t('the intent path is stopped', bot.includes("if (this.dry) {") && bot.includes("'Would send '"))
t('the raw api path is stopped too', cli.includes('if (bot?.dry) {') && cli.includes("'Would call api.'"))
t('and answers the bot rather than hanging it', cli.includes("return { status: 'ok', dryRun: true }"))
t('why both is recorded', cli.includes('the one outcome a\n    // preview must never have') || cli.includes('A dry run must close BOTH routes'))

console.log(String.fromCharCode(10) + '-- reads stay real --')
// A preview fed fake market data would be previewing a different bot.
t('info requests are not faked', !grab(cli, "if (kind === 'info')").includes('dry'))
t('why is recorded', bot.includes('previewing a different bot'))

console.log(String.fromCharCode(10) + '-- limits still apply in a preview --')
// Checked first, THEN reported: a preview should also show which intents your limits
// would have refused, not only the ones that would have gone out.
const exec = grab(bot, 'async _execute(intents)')
t('the limit check runs before the dry-run branch',
  exec.indexOf('const why = this._check') < exec.indexOf('if (this.dry)'))
t('a refused intent still reports as blocked', exec.includes("this.say('warn', 'Blocked — ' + why)"))
t('why that order matters is recorded', exec.includes('which intents your\n        // limits would have refused') || bot.includes('limits would have refused'))

console.log(String.fromCharCode(10) + '-- you can always tell which mode it is in --')
// The dangerous confusion is believing a LIVE bot is a preview.
t('the log line says it plainly', bot.includes("'DRY RUN — nothing will be sent · '"))
t('the card carries a badge', cli.includes("_T('DRY RUN', 'SIMULACIÓN')"))
t('and a distinct colour, not the running green', cli.includes("dry ? 'var(--orange,#f59e0b)' : 'var(--green)'"))
t('why the mode must be obvious is recorded', cli.includes('believing a live bot is a preview'))
t('Preview and Run are separate buttons', cli.includes("window.__devBotPreview('${b.id}')") && cli.includes("window.__devBotStart('${b.id}')"))
t('Preview says what it does', cli.includes("_T('Run it for real, but send nothing'"))

console.log(String.fromCharCode(10) + '-- the plumbing --')
t('start takes the flag', bot.includes('start(dry = false) {'))
t('and records it on the bot', bot.includes('this.dry = !!dry'))
// Preview is no longer "start it dry in the background and go read the log" — that
// answered the question but hid the answer. It runs ONE tick and shows the result in a
// sheet, the same shape the built-in bots' preview has.
t('preview runs one tick and returns a result', bot.includes('previewOnce(ms = 15000)'))
t('an empty intent list settles it rather than hanging', bot.includes('this._previewDone = true'))
t('why an empty answer must settle is recorded', bot.includes('looking like it hung'))
t('it opens a sheet', cli.includes('function _devBotPreviewSheet(def, res)'))
t('it uses a throwaway instance', cli.includes('const probe = new DeviceBot(def,'))
t('so it cannot disturb an already-running copy', cli.includes('previewing must never disturb'))
t('the sheet offers Run it / Back like the built-in one does',
  cli.includes("_T('Run it', 'Ejecutar')") && cli.includes("_T('Back', 'Volver')"))
t('and says plainly that nothing ran', cli.includes('Nothing was placed and nothing is running'))
t('an empty decision is named as normal, not as a failure', cli.includes('is a normal answer, not a failure'))
t('the flag reaches the bridge via the bot instance', cli.includes('async function _devBotRequest(def, kind, payload, bot)'))

// Drive the branch itself.
const mk = (dry) => {
  const b = new Function('dry', `${grab(bot, 'class DeviceBot')}
    const b = new DeviceBot({ coin: 'BTC', maxUsd: 25, maxPerMin: 4, maxOpen: 10 }, { onChange(){} })
    b.dry = dry
    return b`)(dry)
  return b
}
const dryBot = mk(true), liveBot = mk(false)
t('a dry bot reports its mode', dryBot.dry === true)
t('a live one does not', liveBot.dry === false)
// The check must be identical in both modes, or a preview would lie about what passes.
const it = { type: 'market', isBuy: true, usd: 15 }
t('the same intent passes the same check in both modes',
  dryBot._check(it, { openOrders: [] }) === liveBot._check(it, { openOrders: [] }))
const big = { type: 'market', isBuy: true, usd: 9999 }
t('and an over-limit one is refused in both',
  /over the/.test(dryBot._check(big, { openOrders: [] })) && /over the/.test(liveBot._check(big, { openOrders: [] })))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
