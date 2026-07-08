/**
 * Shared pause/resume for strategy bots.
 *
 * The strategy server sends SIGUSR1 (pause) / SIGUSR2 (resume) to keep the bot
 * process — and its in-memory agent key — alive while it idles. Importing this
 * module installs the signal handlers; an UNHANDLED SIGUSR1 would terminate the
 * process, so every strategy must import it. Bots check isPaused() in their loop
 * and may register onPause()/onResume() callbacks (e.g. to cancel open orders).
 */
let _paused = false
let _onPause = null
let _onResume = null

process.on('SIGUSR1', async () => {
  if (_paused) return
  _paused = true
  try { await _onPause?.() } catch (_) {}
})
process.on('SIGUSR2', async () => {
  if (!_paused) return
  _paused = false
  try { await _onResume?.() } catch (_) {}
})

export function isPaused() { return _paused }
export function onPause(fn)  { _onPause = fn }
export function onResume(fn) { _onResume = fn }
