// The bug inbox: reports users send in, and the dev-mode view that reads them.
//
// Reports were write-only for months — they landed in bug-reports.json and reading one
// meant SSHing into the box, so nobody did. Now they are readable in the app, which means
// a stranger's text is rendered on the operator's screen. One report already in the live
// inbox is an <img onerror> that posts document.cookie to somebody's domain. It is inert
// only because every field goes through esc() into text. That is what this suite holds.
import fs from 'fs'
const srv = fs.readFileSync('server.js', 'utf8').replace(/\r\n/g, '\n')
const cli = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const ignore = fs.readFileSync('.gitignore', 'utf8').replace(/\r\n/g, '\n')

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const nl = String.fromCharCode(10)
const grab = (s, sig) => {
  const i = s.indexOf(sig); if (i < 0) return ''
  let j = s.indexOf('{', i), d = 0
  for (; j < s.length; j++) { if (s[j] === '{') d++; else if (s[j] === '}') { d--; if (!d) return s.slice(i, j + 1) } }
  return ''
}

const read   = grab(srv, "path === '/api/bug-reports'")
const status = grab(srv, "path === '/api/bug-report-status'")
const post   = grab(srv, "path === '/api/bug-report'")

console.log(nl + '-- reports can be read now, by the operator --')
t('GET /api/bug-reports exists', read.length > 0)
t('POST /api/bug-report-status exists', status.length > 0)
t('sending one still works', post.length > 0)
t('reading requires the PIN', read.includes("LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN"))
t('marking one requires it too', status.includes("LB_PIN && (req.headers['x-lb-pin'] ?? '') === LB_PIN"))
t('an unset PIN locks the door rather than opening it', read.includes('LB_PIN &&'))
t('both refuse without it',
  read.includes("403, { error: 'forbidden' }") && status.includes("403, { error: 'forbidden' }"))
t('why it was worth building is recorded', srv.includes('Reports used to be write-only'))

console.log(nl + '-- the reporter\'s address is not part of reading a bug --')
t('the listing strips it', read.includes('.map(({ ip, ...rest }) => rest)'))
t('but it is still stored, because the rate limiter counts it', post.includes('ip,'))
t('the inbox file is gitignored', /^bug-reports\.json$/m.test(ignore))

console.log(nl + '-- an id that survives the trim --')
// Reports predate having an id, and the file is trimmed to the last 2,000 — so an index
// would name a different report after every trim. Ids are backfilled once instead.
t('missing ids are backfilled', read.includes('if (e && !e.id)'))
t('the backfill is persisted', read.includes('if (added)'))
t('why an index would not do is recorded', srv.includes('would not survive the 2,000-report trim'))
t('the status is looked up by id', status.includes('list.find(x => x && x.id === b.id)'))

console.log(nl + '-- a status is one of two words --')
t('the set is closed', status.includes("['new', 'done'].includes(b.status)"))
t('anything else is a bad request', status.includes("400, { error: 'bad request' }"))
t('an unknown id is a 404, not a silent no-op', status.includes("404, { error: 'not found' }"))

console.log(nl + '-- the app side --')
t('the viewer exists', cli.includes('window.__openBugReports = async function'))
t('it is behind dev mode', /devOn \? `[\s\S]*?__openBugReports/.test(cli))
t('it sends the PIN it has', grab(cli, 'window.__openBugReports = async function').includes("'x-lb-pin': pin"))
t('a 403 says so plainly rather than looking empty',
  grab(cli, 'window.__openBugReports = async function').includes("_bugsRender('forbidden')"))
t('an empty inbox and a failed load do not look alike',
  cli.includes('No reports yet.') && cli.includes('Could not load reports.'))
t('it says how many are still open', cli.includes("_T('open', 'abiertos')"))

console.log(nl + '-- a stranger\'s text is rendered as text --')
const render = grab(cli, 'function _bugsRender')
t('the message is escaped', render.includes('esc(b.message ?? \'\')'))
t('the timestamp is escaped', render.includes('esc(String(b.receivedAt'))
t('the id is escaped where it reaches an attribute', render.includes("esc(b.id)"))
t('the diagnostics are escaped', render.includes('.map(x => esc(String(x).slice(0, 60)))'))
t('the user agent is escaped', render.includes('esc(String(d.ua)'))
t('nothing in a row is interpolated raw',
  !/\$\{b\.(message|id|status|receivedAt)\}/.test(render) && !/\$\{d\.(ua|tab|url)\}/.test(render))
t('the live payload is named, so nobody removes esc() as tidying',
  cli.includes('an <img onerror> that posts document.cookie'))

console.log(nl + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
