// The push guard is the only thing standing between two devices and a repeat of the
// eighteen-commit loss. It is a shell script nobody runs by hand, so it is exactly the
// kind of thing that rots silently — it already spent its whole life non-executable,
// which git ignores without a word. These assertions are the tripwire for that.
import { readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const hook = readFileSync('.githooks/pre-push', 'utf8')
let pass = 0, fail = 0
const t = (name, cond) => { cond ? (pass++, console.log('  PASS', name)) : (fail++, console.log('  FAIL', name)) }

// The bit git silently needs. This is not pedantry: it was 100644 for the hook's whole
// life and every push to main went unguarded.
t('hook is executable', (statSync('.githooks/pre-push').mode & 0o111) !== 0)

// Scope: it must stay out of the way on feature branches.
t('only fires on main', /branch=\$\(git rev-parse --abbrev-ref HEAD\)/.test(hook) && /\[ "\$branch" = "main" \] \|\| exit 0/.test(hook))

// The four checks, each of which has its own failure it is there for.
t('checks for a stale base', /rev-list --count HEAD\.\.origin\/main/.test(hook))
t('checks for conflict markers', /git grep .*<<<<<<</.test(hook))
t('checks for a large deletion', /numstat origin\/main\.\.HEAD/.test(hook))
t('runs the suite', /npm test/.test(hook) && /broken/.test(hook))

// An override has to exist, or the first time prod is down someone deletes the hook.
t('has an emergency override', /INSOLVENT_FORCE/.test(hook))

// --- behaviour, not just presence -------------------------------------------------
const sh = script => execFileSync('sh', ['-c', script], { encoding: 'utf8' })

// The marker regex must catch a real merge leftover and ignore prose that merely
// starts with angle brackets.
const markerRe = "grep -cE '^(<<<<<<<|>>>>>>>) '"
t('marker regex catches a real conflict', sh(`printf '<<<<<<< HEAD\\n' | ${markerRe}`).trim() === '1')
t('marker regex ignores <<<<<<< with no space', sh(`printf '<<<<<<<nope\\n' | ${markerRe} || true`).trim() === '0')

// The shrink detector: numstat is "added deleted path". Only a big NET loss counts,
// so a large refactor that rewrites in place does not trip it.
const shrink = `awk '$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && ($2 - $1) > 500 { print $3 }'`
t('flags a file that loses 900 net lines', sh(`printf '10\\t910\\tsrc/main.js\\n' | ${shrink}`).trim() === 'src/main.js')
t('ignores a rewrite of the same size', sh(`printf '900\\t910\\tsrc/main.js\\n' | ${shrink}`).trim() === '')
t('ignores a small deletion', sh(`printf '0\\t40\\tsrc/main.js\\n' | ${shrink}`).trim() === '')
t('ignores binary files (numstat prints -)', sh(`printf -- '-\\t-\\tsrc/logo.png\\n' | ${shrink}`).trim() === '')

// CLAUDE.md tells every clone to switch the hook on; the session hook must actually do it,
// or the guard is back to depending on someone remembering.
const start = readFileSync('.claude/hooks/session-start.sh', 'utf8')
t('session hook enables the guard', /git config core\.hooksPath \.githooks/.test(start))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
