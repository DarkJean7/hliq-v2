/**
 * What the paper leaderboard shows, on top of the rows hliq-strat keeps (server.js
 * /api/leaderboard/paper). serve-prod.js applies it in front of that route, so none of it
 * restarts a bot.
 *
 * Two rules, both asked for:
 *
 *   QUIET ACCOUNTS LEAVE. "remove accounts that does not have positions open and that have not
 *   traded the last 2 weeks (make this a behaviour)". An account with no open position whose
 *   last fill is more than QUIET_DAYS old is left off the board. Left off, not deleted: the row
 *   and its name stay on the server, so the owner keeps the name, and the first trade brings it
 *   back. An account that has never traded is given the same two weeks from when it was made,
 *   so a new one is not gone the moment it appears.
 *
 *   THE AGENTS ARE ON IT. "add the agents to the paper leaderboard with their names and besides
 *   the name "(agent)"". Their rows come from the arena runner (src/agentrunner.js → board.json),
 *   not from a client post, and a posted row whose name claims "(agent)" is dropped: nobody else
 *   may sign as one.
 */
const DAY = 86400e3
export const QUIET_DAYS = 14
export const AGENT_TAG = '(agent)'
export const agentName = (name) => `${name} ${AGENT_TAG}`
export const isAgentName = (n) => /\(\s*agent\s*\)\s*$/i.test(String(n ?? ''))

/** When the account last did anything: its last fill, else when it was made. 0 = unknown. */
export function lastActive(r) {
  return Number(r?.track?.lastFillAt) || Number(r?.created) || Number(r?.updated) || 0
}
export function hasOpen(r) {
  return (r?.positions ?? []).some(ap => parseFloat((ap?.position ?? ap)?.szi ?? 0) !== 0)
}
export function isQuiet(r, now = Date.now()) {
  return !hasOpen(r) && now - lastActive(r) > QUIET_DAYS * DAY
}

/**
 * The board: the posted rows less the quiet ones and any impostor "(agent)", plus the agents,
 * by PnL. `quiet` names what was left off, so a client whose own account is among them does not
 * re-post it on every view thinking the post was lost (main.js self-heal).
 */
export function paperBoard(posted, agents, now = Date.now()) {
  const quiet = []
  const rows = []
  for (const r of posted ?? []) {
    if (isAgentName(r?.name)) continue
    if (isQuiet(r, now)) { quiet.push(r.name); continue }
    rows.push(r)
  }
  for (const a of agents ?? []) rows.push(a)
  rows.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
  return { rows, quiet }
}
