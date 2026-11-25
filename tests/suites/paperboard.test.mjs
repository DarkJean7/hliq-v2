// The paper leaderboard as the app reads it (src/paperboard.js, served at /paper-board by
// serve-prod.js). Asked for:
//   "add the agents to the paper leaderboard with their names and besides the name "(agent)",
//    to identify them and be able to watch the accounts like a regular paper account"
//   "in paper remove accounts that does not have positions open and that have not traded the
//    last 2 weeks (make this a behaviour)"
import fs from 'fs'
import { paperBoard, isQuiet, isAgentName, agentName, lastActive, QUIET_DAYS } from '../../src/paperboard.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const DAY = 86400e3, NOW = Date.UTC(2026, 10, 25)
const pos = (szi) => [{ position: { coin: 'BTC', szi: String(szi) } }]

console.log('-- quiet accounts leave --')
t('two weeks', QUIET_DAYS === 14)
t('no position, last fill 15 days ago: quiet', isQuiet({ positions: [], track: { lastFillAt: NOW - 15 * DAY }, created: NOW - 90 * DAY }, NOW))
t('no position, last fill 13 days ago: stays', !isQuiet({ positions: [], track: { lastFillAt: NOW - 13 * DAY } }, NOW))
t('an open position keeps it, however old the last fill', !isQuiet({ positions: pos(0.5), track: { lastFillAt: NOW - 90 * DAY } }, NOW))
t('a zero-size position is not open', isQuiet({ positions: pos(0), track: { lastFillAt: NOW - 30 * DAY } }, NOW))
t('never traded: two weeks from when it was made', !isQuiet({ positions: [], track: { lastFillAt: null }, created: NOW - 5 * DAY }, NOW) && isQuiet({ positions: [], created: NOW - 20 * DAY }, NOW))
t('the last fill wins over when it was made', lastActive({ track: { lastFillAt: 5 }, created: 1 }) === 5)
t('nothing known at all: quiet (0 is long ago)', isQuiet({}, NOW))

console.log('-- the agents --')
t('the name carries "(agent)"', agentName('Oracle') === 'Oracle (agent)' && isAgentName('Oracle (agent)') && isAgentName('x (Agent) ') && !isAgentName('agent smith'))
const posted = [
  { name: 'alice', pnl: 50, positions: [], track: { lastFillAt: NOW - DAY } },
  { name: 'old', pnl: 900, positions: [], track: { lastFillAt: NOW - 40 * DAY } },
  { name: 'holder', pnl: -20, positions: pos(1), track: { lastFillAt: NOW - 40 * DAY } },
  { name: 'Oracle (agent)', pnl: 1e6, positions: pos(1), track: { lastFillAt: NOW } },   // somebody posting as one
]
const agents = [{ name: 'Oracle (agent)', agent: true, pnl: 12, positions: [] }, { name: 'Dip buyer (agent)', agent: true, pnl: -3, positions: [] }]
const b = paperBoard(posted, agents, NOW)
t('quiet left off, open and recent kept, agents added, by PnL', b.rows.map(r => r.name).join() === 'alice,Oracle (agent),Dip buyer (agent),holder', b.rows.map(r => r.name))
t('a posted row claiming "(agent)" is dropped: only the server\'s is shown', b.rows.filter(r => r.name === 'Oracle (agent)').length === 1 && b.rows.find(r => r.name === 'Oracle (agent)').agent === true)
t('an agent is never quiet: it is the server\'s, not a stale post', paperBoard([], agents, NOW + 365 * DAY).rows.length === 2)
t('what was left off is named, so its owner does not re-post it', b.quiet.join() === 'old')
t('nothing posted is not an error', paperBoard(null, [], NOW).rows.length === 0)

console.log('-- wiring --')
const srv = fs.readFileSync('serve-prod.js', 'utf8'), main = fs.readFileSync('src/main.js', 'utf8'), vite = fs.readFileSync('vite.config.js', 'utf8')
t('serve-prod serves it, in front of hliq-strat (nginx sends /api there, so not /api)', srv.includes("if (url === '/paper-board' || url === '/paper-board/one')") && srv.includes('paperBoard(posted.rows, agents.map(a => a.row), Date.now())'))
t('the people\'s rows unknown → 502, not a board of agents alone', /catch \{\s*\/\/ Not "the agents are the whole board"[^\n]*\n\s*return send\(502/.test(srv))
t('an agent out of the arena is not on it', srv.includes('const agents = (board?.agents ?? []).filter(a => !a.hidden)'))
t('Visit answers for an agent from its own trades', srv.includes('if (isAgentName(name))') && main.includes("fetch('/paper-board/one?name='"))
t('the app reads the board from there, and a failure keeps the rows it has', main.includes("fetch('/paper-board', pin ?") && main.includes("if (!x.ok) throw new Error(); return x.json()"))
t('its own quiet account is not re-posted on every view', main.includes('if (!_lbPaperQuiet.has(mine) && !_lbPaperRows.some('))
t('an agent row offers no hide, remove or copy trade', main.includes('if (pname && !r._agent && (dev || owner))') && main.includes("const ct = r._agent ? ''") && main.includes("${entry.known || entry._agent ? '' : isP"))
t('posting still goes to hliq-strat', main.includes("const post = (name) => fetch('/api/leaderboard/paper', {"))
t('a dev twin, so the board loads under vite too', vite.includes("path === '/paper-board' || path === '/paper-board/one'"))

console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
