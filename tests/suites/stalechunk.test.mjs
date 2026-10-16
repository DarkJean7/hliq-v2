// A tab opened before a deploy, lazy-loading a screen whose chunk the deploy deleted:
// "Could not open the Grid Ladder: Failed to fetch dynamically imported module:
// https://insolvent.trade/assets/gridladder-ui-BNeupnae.js" (2026-10-16).
import fs from 'fs'
import { isStaleChunk, reloadForStaleChunk } from '../../src/stalechunk.js'

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, JSON.stringify(x)))
const mem = () => { const m = new Map(); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) } }

const chrome = new TypeError('Failed to fetch dynamically imported module: https://insolvent.trade/assets/gridladder-ui-BNeupnae.js')
t('Chrome\'s wording is a stale chunk', isStaleChunk(chrome))
t('so is Safari\'s and Firefox\'s', isStaleChunk(new TypeError('Importing a module script failed.')) && isStaleChunk(new TypeError('error loading dynamically imported module')))
t('an ordinary error is not', !isStaleChunk(new Error('the bot server did not answer')))

const st = mem()
let reloads = 0
t('a stale chunk reloads the page to the new version', reloadForStaleChunk(chrome, { storage: st, reload: () => reloads++, now: 1_000_000 }) && reloads === 1)
t('but not twice in a minute — a chunk still missing after a reload is reported, not looped on', !reloadForStaleChunk(chrome, { storage: st, reload: () => reloads++, now: 1_030_000 }) && reloads === 1)
t('a later one reloads again', reloadForStaleChunk(chrome, { storage: st, reload: () => reloads++, now: 1_200_000 }) && reloads === 2)

const main = fs.readFileSync('src/main.js', 'utf8')
t('the app installs it, and the Grid Ladder opener uses it before alerting', main.includes('installStaleChunkReload()') && /catch\(e => \{ if \(!reloadForStaleChunk\(e\)\) _appAlert\('Could not open the Grid Ladder/.test(main))

// And the root cause: the deploy no longer deletes the chunks an open tab still asks for.
const wf = fs.readFileSync('.github/workflows/deploy.yml', 'utf8')
t('assets are synced without --delete', /rsync -avz --delay-updates dist\/assets\//.test(wf) && /--delete --delay-updates --exclude='\/assets\/' dist\//.test(wf))
t('and old ones are pruned after 14 days', /find '\$DEPLOY_PATH\/dist\/assets' -type f -mtime \+14 -delete/.test(wf))

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
