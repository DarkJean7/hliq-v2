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
const FILES = ['agentkeys-browser.mjs', 'cancelcoin-browser.mjs', 'overviewhead-browser.mjs', 'spottab-browser.mjs', 'pfp-browser.mjs', 'allocation-browser.mjs', 'desktoptabs-browser.mjs', 'trailstop-browser.mjs', 'protypes-browser.mjs', 'privacy-browser.mjs', 'offex-browser.mjs', 'calnotes-browser.mjs', 'mktsort-browser.mjs', 'comboequity-browser.mjs', 'defi-browser.mjs', 'guardliq-browser.mjs', 'appdialogs-browser.mjs', 'hlpnl-browser.mjs']

// A failure also goes out as a GitHub Actions annotation naming the file and the assertions
// that failed. The job LOG needs a token to read; annotations are in the run's public
// metadata, so "the browser step went red" can be diagnosed rather than guessed at. Locally
// the ::error:: lines are just a line of text.
const annotate = (f, lines) => {
  if (!process.env.GITHUB_ACTIONS) return
  const body = (lines.length ? lines : ['exited non-zero with no FAIL line'])
    .join(' · ').replace(/[\r\n]+/g, ' ').slice(0, 900)
  console.log(`::error file=tests/${f}::${f} — ${body}`)
}

let failed = []
for (const f of FILES) {
  console.log('\n══ ' + f + ' ' + '═'.repeat(Math.max(0, 60 - f.length)))
  // Piped rather than inherited so a failure's assertions can be pulled back out; written
  // straight through either way, so the log reads exactly as it did.
  const r = spawnSync(process.execPath, [join(here, f), ...args], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  process.stdout.write(out)
  if (r.status !== 0) {
    failed.push(f)
    annotate(f, out.split(/\r?\n/).filter(l => /\bFAIL\b|Error|error:/.test(l)).slice(0, 8))
  }
}

console.log('')
if (failed.length) {
  console.log('FAILED: ' + failed.join(', '))
  if (process.env.GITHUB_ACTIONS) console.log(`::error::browser tests failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(FILES.length + ' browser tests passed')
