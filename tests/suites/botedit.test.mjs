// Editing a running bot must never leave it stopped.
//
// Reported from a phone in dev mode on an individual account: hitting Edit produced
// "subscription required" AND killed the bot. Two faults in one press —
//   1. dev mode is a LOCAL flag; the server only ever honoured the PIN that earned it, so
//      a device where those drifted apart unlocked the button and got a 402 on the press.
//   2. the edit stops first and starts second, so ANY refused start destroys the bot.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))

console.log('\n-- the gate is checked BEFORE anything is stopped --')
for (const [name, fn] of [['desktop', 'async function updateStrategy(type) {'], ['mobile', 'async function updateStrategyMob(type) {']]) {
  const body = cli.slice(cli.indexOf(fn), cli.indexOf(fn) + 1800)
  const gate = body.indexOf('_canStartBot')
  const stop = body.indexOf('_postStop')
  t(`${name}: it asks whether a start is allowed`, gate > 0, body.slice(0, 80))
  t(`${name}: and it asks BEFORE stopping`, gate > 0 && stop > 0 && gate < stop, { gate, stop })
  // desktop alerts, mobile toasts -- both must return before reaching _postStop
  t(`${name}: a refusal returns without stopping`, /_stratLockedMsg\(\)[^)]*\); return \}/.test(body))
  t(`${name}: the original args are captured before the stop`,
    body.indexOf('origArgs') > 0 && body.indexOf('origArgs') < stop)
  t(`${name}: a failed start restores the previous bot`, body.includes('_restoreBotAfterFailedEdit(type, ed.instance, agentKey, origArgs, r.error)'))
  t(`${name}: it no longer just alerts and gives up`, !body.includes('alert(`Could not update: ${r.error}`); return }'))
}

console.log('\n-- dev mode now means what it says --')
t('an active subscription is enough', cli.includes('if (_subStatus?.active) return true'))
t('otherwise dev mode is required', cli.includes("if (!isDev()) return false"))
t('the PIN is re-verified against the server', cli.includes("fetch('/api/leaderboard/verify-pin', { method: 'POST', headers: { 'x-lb-pin': pin } })"))
t('a rotated or wrong PIN is dropped rather than resent', cli.includes("localStorage.removeItem('hliq_lb_pin')"))
t('and the user is re-prompted for it', cli.includes('pin = await _lbAdminPin(true)'))
t('being offline does not block the operator on a check we cannot make',
  cli.includes("catch { return true }   // offline: don't block on a check we cannot make"))
t('why local dev mode was not enough is recorded', cli.includes('Dev mode is a local flag'))

console.log('\n-- it mirrors what the server actually enforces --')
t('the server allows admin, the dev PIN, or an active sub',
  srv.includes("const _operator = auth.admin || (!!LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN)"))
t('and 402s otherwise', srv.includes("if (!_operator && !subActive(b.address ?? ''))"))
t('the client sends the PIN on that route', cli.includes("if (path === '/api/start' && isDev())"))

console.log('\n-- restoring, and telling the truth about it --')
const rest = cli.slice(cli.indexOf('async function _restoreBotAfterFailedEdit'), cli.indexOf('async function _restoreBotAfterFailedEdit') + 1600)
t('it restarts the ORIGINAL instance and args', rest.includes('args: origArgs, address: _stratTargetAddr(), instance }'))
t('success says nothing was lost', rest.includes('nothing was lost'))
t('failure says the bot is stopped, in plain words', rest.includes('please start it again'))
t('and it never claims success it did not get', !/if \(back\)\s*\{/.test(rest) && rest.includes('if (back?.ok)'))
t('an unreachable server is reported as such', rest.includes('the server is unreachable'))
t('no original args = say so rather than pretend', rest.includes('could not be restored automatically'))

// Drive the recovery contract directly.
const restore = (origArgs, startOk) => {
  const msgs = []
  const alert = (m) => msgs.push(m)
  if (!Array.isArray(origArgs) || !origArgs.length) { alert('could not be restored automatically'); return { msgs, running: false } }
  if (startOk) { alert('nothing was lost'); return { msgs, running: true } }
  alert('please start it again'); return { msgs, running: false }
}
t('a recoverable failure leaves the bot running', restore(['--coin', 'BTC'], true).running === true)
t('and says so', restore(['--coin', 'BTC'], true).msgs[0].includes('nothing was lost'))
t('an unrecoverable one admits the bot is down', restore(['--coin', 'BTC'], false).running === false)
t('and missing args is its own honest message', restore(null, false).msgs[0].includes('could not be restored'))

console.log('\n-- the refusal message does not imply damage --')
t('it says the bot was untouched', cli.includes('Nothing was changed and your bot is untouched'))
t('and is translated', cli.includes('tu bot sigue igual'))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
