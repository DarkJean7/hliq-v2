// Every browser test, one command. CI runs this before the deploy, so a red one cannot ship.
//
// These are the tests that drive the real app. They exist for the things reading the source
// cannot show: several places disagreeing about which account the UI means, or a button that
// sends different orders from the ones it named. They are hermetic — the app's own server and
// the exchange are both stubbed — so they are fast and cannot fail because Hyperliquid is
// having a bad morning.
//
//   npm run test:browser                 # expects a dev server on 5175
//   npm run test:browser -- --port=4173  # or wherever
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const FILES = ['agentkeys-browser.mjs', 'cancelcoin-browser.mjs', 'overviewhead-browser.mjs', 'spottab-browser.mjs', 'pfp-browser.mjs', 'allocation-browser.mjs', 'desktoptabs-browser.mjs', 'trailstop-browser.mjs', 'protypes-browser.mjs', 'privacy-browser.mjs', 'offex-browser.mjs', 'calnotes-browser.mjs', 'mktsort-browser.mjs']

let failed = []
for (const f of FILES) {
  console.log('\n══ ' + f + ' ' + '═'.repeat(Math.max(0, 60 - f.length)))
  const r = spawnSync(process.execPath, [join(here, f), ...args], { stdio: 'inherit' })
  if (r.status !== 0) failed.push(f)
}

console.log('')
if (failed.length) { console.log('FAILED: ' + failed.join(', ')); process.exit(1) }
console.log(FILES.length + ' browser tests passed')
