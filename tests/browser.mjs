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
//   BROWSER_JOBS=1 npm run test:browser  # one at a time
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const FILES = ['uinova-browser.mjs', 'gridladder-browser.mjs', 'agentkeys-browser.mjs', 'cancelcoin-browser.mjs', 'overviewhead-browser.mjs', 'spottab-browser.mjs', 'pfp-browser.mjs', 'allocation-browser.mjs', 'desktoptabs-browser.mjs', 'trailstop-browser.mjs', 'protypes-browser.mjs', 'privacy-browser.mjs', 'offex-browser.mjs', 'calnotes-browser.mjs', 'chatmedia-browser.mjs', 'mktsort-browser.mjs', 'comboequity-browser.mjs', 'defi-browser.mjs', 'guardliq-browser.mjs', 'appdialogs-browser.mjs', 'hlpnl-browser.mjs', 'eqclose-browser.mjs', 'monthchart-browser.mjs', 'shelltab-browser.mjs', 'liqdeposit-browser.mjs', 'wakealarm-browser.mjs', 'simulator-browser.mjs', 'landing-browser.mjs', 'markets-browser.mjs', 'periodchange-browser.mjs', 'fillnotify-browser.mjs', 'sectoralloc-browser.mjs', 'portfolio-browser.mjs', 'pftrade-browser.mjs', 'pfbot-e2e.mjs', 'papersync-browser.mjs', 'papernetpnl-browser.mjs', 'paperslot-browser.mjs', 'paperbots-browser.mjs', 'analysis-browser.mjs', 'spotsell-browser.mjs']

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

// IN PARALLEL. One after another, they took 651 seconds of a 768-second deploy ("15 minutes just
// to make grid ladder dev mode only??? why all changes take so long?"). Each file is hermetic —
// its own browser, its own stubbed exchange — so they can share the machine: JOBS at a time
// (default 3, for CI's 4 cores; BROWSER_JOBS to change it). Each file's output is printed as one
// block when it finishes, so the log still reads file by file.
//
// A file that fails is run ONCE more, alone, after the rest. A few of these follow real timing
// (a slide-in, a refresh) and can trip on a busy machine. A real failure fails twice and still
// blocks the deploy; a pass on the second run is reported, never hidden.
const JOBS = Math.max(1, parseInt(process.env.BROWSER_JOBS || '3', 10) || 3)
const head = (f) => '\n══ ' + f + ' ' + '═'.repeat(Math.max(0, 60 - f.length))
const runOne = (f) => new Promise((resolve) => {
  const p = spawn(process.execPath, [join(here, f), ...args])
  let out = ''
  p.stdout.on('data', d => { out += d })
  p.stderr.on('data', d => { out += d })
  p.on('close', (code) => resolve({ f, code, out }))
})

const t0 = Date.now()
const first = []
let next = 0
await Promise.all(Array.from({ length: Math.min(JOBS, FILES.length) }, async () => {
  while (next < FILES.length) {
    const r = await runOne(FILES[next++])
    process.stdout.write(head(r.f) + '\n' + r.out)
    if (r.code !== 0) first.push(r)
  }
}))

const failed = [], flaky = []
for (const r0 of first) {
  console.log(head(r0.f + ' — again, alone'))
  const r = spawnSync(process.execPath, [join(here, r0.f), ...args], { encoding: 'utf8' })
  const out = (r.stdout ?? '') + (r.stderr ?? '')
  process.stdout.write(out)
  if (r.status !== 0) {
    failed.push(r0.f)
    annotate(r0.f, out.split(/\r?\n/).filter(l => /\bFAIL\b|Error|error:/.test(l)).slice(0, 8))
  } else flaky.push(r0.f)
}

console.log('')
if (flaky.length) console.log('Passed on a second run alone (timing under load): ' + flaky.join(', '))
console.log(`${FILES.length} files, ${JOBS} at a time, in ${Math.round((Date.now() - t0) / 1000)}s`)
if (failed.length) {
  console.log('FAILED: ' + failed.join(', '))
  if (process.env.GITHUB_ACTIONS) console.log(`::error::browser tests failed: ${failed.join(', ')}`)
  process.exit(1)
}
console.log(FILES.length + ' browser tests passed')
