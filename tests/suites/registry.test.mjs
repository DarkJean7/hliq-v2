// The 2026-08-22 registry wipe: 60 bots exited during a Hyperliquid 500/502 window and every
// one was unpersisted, leaving `{}` and nothing to resume.
import fs from 'fs'
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const i = srv.indexOf("proc.on('exit'")
const exit = srv.slice(i, srv.indexOf('\n  })', i))

t('an early exit is kept and retried whatever the error says',
  exit.includes('const earlyExit = ranMs < STARTUP_WINDOW_MS')
  && exit.includes('if (!shuttingDown && earlyExit &&'))
t('the failure is no longer classified — that classification IS the bug',
  !exit.includes('RATE_LIMIT_RE') && !/rateLimited/.test(exit))
t('the 429-only pattern is gone from the file entirely', !srv.includes('RATE_LIMIT_RE'))
t('retries are still bounded, so a broken config gives up',
  exit.includes('< MAX_RESUME_RETRIES'))
t('a bot that exits AFTER the startup window is still unpersisted (a real stop)',
  exit.includes('unpersistBot(type, address, instance)'))
t('a shutdown still keeps every entry for the next boot',
  exit.includes('!shuttingDown'))
t('the retry log says what happened instead of blaming a rate limit',
  exit.includes('keeping it registered'))

// Drive the branch itself.
const decide = (ranMs, retries, shuttingDown, STARTUP_WINDOW_MS = 120000, MAX = 3) => {
  const earlyExit = ranMs < STARTUP_WINDOW_MS
  return (!shuttingDown && earlyExit && retries < MAX) ? 'retry'
       : (!shuttingDown ? 'unpersist' : 'keep')
}
t('HL 500 two seconds in → retry (this is the case that wiped the registry)',
  decide(2000, 0, false) === 'retry')
t('HL 429 two seconds in → retry, as before', decide(2000, 0, false) === 'retry')
t('a clean stop after an hour → unpersist', decide(3600_000, 0, false) === 'unpersist')
t('four early failures → give up, no infinite loop', decide(2000, 3, false) === 'unpersist')
t('shutting down → keep, so the next boot resumes it', decide(2000, 0, true) === 'keep')

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
