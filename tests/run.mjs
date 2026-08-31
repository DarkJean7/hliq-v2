#!/usr/bin/env node
/**
 * Run every suite in tests/suites.
 *
 * These used to live in a scratch directory on one machine, which meant a session working
 * from a phone had no way to check its own work before pushing. They are in the repo now
 * so any clone can run `npm test`.
 *
 * Each suite reads the SOURCE — src/main.js and friends — and asserts against it. Nothing
 * here needs a browser, a server, or a network, so it runs anywhere in a couple of seconds.
 *
 * KNOWN FAILING is not a way to hide broken tests. It is three suites that fail for reasons
 * outside this repo, and listing them is what makes the other sixty trustworthy: without
 * it every run is red and nobody reads the output. Each entry says why. If one of them
 * starts passing, that is reported too — a stale exemption is its own kind of lie.
 */
import { readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const KNOWN_FAILING = {
  'buckets.test.mjs': 'asserts against live HIP-4 outcome data, which drifts as HL adds and settles markets',
  'resume.test.mjs':  'scrapes a symbol that has since moved; the harness needs updating, not the code',
  'subs.test.mjs':    'passes every assertion, then trips a libuv teardown assertion on Windows when it exits',
}

const files = readdirSync(join(here, 'suites')).filter(f => f.endsWith('.test.mjs')).sort()
if (!files.length) { console.error('no suites found'); process.exit(1) }

const only = process.argv[2]                       // npm test -- grid   → suites matching "grid"
const run = only ? files.filter(f => f.includes(only)) : files
if (!run.length) { console.error(`no suite matches "${only}"`); process.exit(1) }

let passed = 0
const broke = []      // failing and NOT expected to
const expected = []   // failing as listed above
const fixed = []      // listed as failing, but passing now

for (const f of run) {
  // cwd is the repo root: every suite reads src/... relative to it.
  const r = spawnSync(process.execPath, [join(here, 'suites', f)], { cwd: root, encoding: 'utf8' })
  const ok = r.status === 0
  const known = KNOWN_FAILING[f]
  if (ok) {
    passed++
    if (known) fixed.push(f)
    continue
  }
  if (known) { expected.push(f); continue }
  broke.push({ f, out: (r.stdout || '') + (r.stderr || '') })
}

const line = (s) => console.log(s)
line('')
line(`${passed} passing · ${expected.length} known-failing · ${broke.length} broken`)

if (fixed.length) {
  line('')
  line('These are listed as known-failing but PASSED — remove them from KNOWN_FAILING in tests/run.mjs:')
  for (const f of fixed) line('  ' + f)
}

if (broke.length) {
  line('')
  for (const b of broke) {
    line('─'.repeat(60))
    line('FAILED  ' + b.f)
    // Just the failures and the tally, not the whole passing list.
    const keep = b.out.split('\n').filter(l => /FAIL|Error|error:|passed,/.test(l)).slice(0, 25)
    for (const l of keep) line('  ' + l.trim())
  }
  line('─'.repeat(60))
  process.exit(1)
}

if (expected.length) {
  line('')
  line('Known-failing, for reasons outside this repo:')
  for (const f of expected) line(`  ${f} — ${KNOWN_FAILING[f]}`)
}
line('')
