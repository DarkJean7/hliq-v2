// Device bots, part three: the same lifecycle a built-in bot has, and no paywall.
import fs from 'fs'
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const grab = (sig) => {
  const i = cli.indexOf(sig); if (i < 0) return ''
  let j = cli.indexOf('{', i), d = 0
  for (; j < cli.length; j++) { if (cli[j] === '{') d++; else if (cli[j] === '}') { d--; if (!d) return cli.slice(i, j + 1) } }
  return ''
}

console.log(String.fromCharCode(10) + '-- the same controls a built-in bot has --')
for (const f of ['__devBotStart', '__devBotStop', '__devBotEdit', '__devBotUpdate', '__devBotLogs', '__devBotDelete'])
  t(`${f} exists`, cli.includes(`window.${f} =`), f)
t('the card offers Edit', cli.includes("window.__devBotEdit('${b.id}')"))
t('Run and Stop swap on the same spot', cli.includes("window.__devBotStop('${b.id}')") && cli.includes("window.__devBotStart('${b.id}')"))

console.log(String.fromCharCode(10) + '-- editing reuses the install form --')
t('one sheet serves both', cli.includes('function _devBotInstallSheet(existing = null)'))
t('and says which it is', cli.includes("ed ? _T('Edit bot', 'Editar bot') : _T('Add a bot', 'Añadir un bot')"))
t('why one form and not two is recorded', cli.includes('one form to learn'))
// Every field must come back, or Update would quietly reset the ones that did not.
for (const [id, prop] of [['devBotMaxUsd', 'maxUsd'], ['devBotMaxMin', 'maxPerMin'],
                          ['devBotMaxOpen', 'maxOpen'], ['devBotEvery', 'everySec'], ['devBotLev', 'leverage']])
  t(`${id} is prefilled from ${prop}`, cli.includes(`d.${prop} ??`), id)
t('the markets come back as chips, which is where they now live',
  cli.includes('_devBotChipsHtml(_devBotCoinsOf(d))') &&
  cli.includes('value="${esc(JSON.stringify(_devBotCoinsOf(d)))}"'))
t('and the picker deliberately preselects nothing',
  !cli.includes("${c === d.coin ? ' selected' : ''}"))
t('the button becomes Update', cli.includes("_T('Update bot', 'Actualizar bot')"))

console.log(String.fromCharCode(10) + '-- update restarts a running bot --')
const upd = grab('window.__devBotUpdate = function(id)')
t('it notices whether it was running', upd.includes('const wasRunning ='))
t('stops the old worker', upd.includes('was?.stop()'))
t('keeps the same id', upd.includes('b.id === id ? { ...def, id } : b'))
t('restarts only if it was running', upd.includes('if (wasRunning) window.__devBotStart(id)'))
t('and says which happened', upd.includes("_T('Updated and restarted', 'Actualizado y reiniciado')"))
// The worker holds the OLD code, so leaving it up would show new settings beside old behaviour.
t('why a restart is required is recorded', cli.includes('holds the OLD code'))
t('the sheet warns about it', cli.includes('it will be restarted, so the new file is what actually runs'))

console.log(String.fromCharCode(10) + '-- add and update share one validator --')
t('there is a single reader', cli.includes('function _devBotRead(existingId)'))
t('install uses it', cli.includes('const def = _devBotRead(null)'))
t('update uses it', upd.includes('const def = _devBotRead(id)'))
t('why sharing matters is recorded', cli.includes('an edit\nn that skipped a check') || cli.includes('the two cannot drift'))
t('both still require the acknowledgement', cli.includes("document.getElementById('devBotAck')?.checked"))
t('both still require an onTick', cli.includes("if (!/onTick/.test(code))"))

// Number('') is 0, so a naive read turns a field the user cleared into an UNLIMITED cap —
// the most dangerous default there is, reached by accident. Empty must mean "default".
const read = new Function('vals', `
  const g = id => vals[id] ?? ''
  const cap = (v, dflt, max) => {
    const s = String(v ?? '').trim()
    if (s === '') return dflt
    const n = Number(s)
    if (!Number.isFinite(n)) return dflt
    return Math.max(0, Math.min(max, n))
  }
  return {
    maxUsd: cap(g('devBotMaxUsd'), 25, 1e9),
    maxPerMin: cap(g('devBotMaxMin'), 4, 600),
    maxOpen: cap(g('devBotMaxOpen'), 10, 1000),
  }`)
t('a blank field falls back to the default', read({}).maxUsd === 25)
t('0 is kept, not treated as blank', read({ devBotMaxUsd: '0' }).maxUsd === 0)
t('and 0 survives on every cap',
  read({ devBotMaxUsd: '0', devBotMaxMin: '0', devBotMaxOpen: '0' }).maxPerMin === 0)
t('a real value is kept', read({ devBotMaxUsd: '250' }).maxUsd === 250)
t('junk falls back rather than becoming NaN', read({ devBotMaxUsd: 'abc' }).maxUsd === 25)
t('an absurd value is clamped', read({ devBotMaxMin: '99999' }).maxPerMin === 600)
t('a negative cannot sneak in', read({ devBotMaxUsd: '-5' }).maxUsd === 0)

console.log(String.fromCharCode(10) + '-- never behind the paywall --')
// The subscription pays for bots running on OUR servers with the app closed. A device bot
// runs on the user's own machine and costs nothing to have running.
const start = grab('window.__devBotStart = function(id)')
t('start does not consult the subscription', !start.includes('_stratsUnlocked') && !start.includes('_canStartBot'))
t('nor the paywall opener', !start.includes('__subOpenPaywall'))
t('the section renders outside the locked branch', cli.includes('${_devBotsHtml()}'))
// Not a bare "locked" search: the card legitimately says "N blocked" for refused intents,
// and "blocked" contains "locked".
t('the section itself has no paywall', ['_stratsUnlocked', '__subOpenPaywall', 'mob-strat-locked']
  .every(k => !grab('function _devBotsHtml()').includes(k)))
t('the reasoning is written down so a later edit does not undo it',
  cli.includes('NOT behind the subscription gate, deliberately'))
t('and names what the subscription is actually for', cli.includes('that is the thing being paid for'))
t('a 0 cap reads as "no cap" on the card, not as zero dollars',
  cli.includes("_T('no size cap', 'sin límite de tamaño')") && cli.includes("_T('no rate cap', 'sin límite de ritmo')"))

console.log(String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
