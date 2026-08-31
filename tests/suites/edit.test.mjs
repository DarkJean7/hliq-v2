// Verifies the Profit Stack edit path: real launch args parse back into the form,
// and the wiring that was missing is actually present.
import fs from 'fs'

const src = fs.readFileSync('src/main.js', 'utf8').replace(/\r\n/g, '\n')
const grab = (sig) => {
  const start = src.indexOf(sig)
  if (start < 0) throw new Error(`not found: ${sig}`)
  let i = src.indexOf('{', start), depth = 0
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  throw new Error('unbalanced')
}
const { _parseStratArgs } = new Function(`${grab('function _parseStratArgs(')}\nreturn { _parseStratArgs }`)()

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

// Exactly what the server stores as extraArgs for the user's running bot.
const REAL = ['--asset', 'HYPE', '--cut-pct', '25', '--threshold', '11', '--max-daily', '0', '--dry-run']
const p = _parseStratArgs(REAL)

t('asset parsed',      p.asset === 'HYPE', JSON.stringify(p))
t('cut-pct parsed',    p['cut-pct'] === '25')
t('threshold parsed',  p.threshold === '11')
t('max-daily parsed',  p['max-daily'] === '0')
t('dry-run is a bare boolean flag', p['dry-run'] === true)

// The prefill must not write `true` into a text input (that is why the grid setter
// guards on v !== true) — assert the same guard shape for the accumulator setter.
const accumFn = grab('function _mobEditAccumInstance(')
t('prefill guards against writing boolean true into an input', accumFn.includes("v !== true"))
t('prefill sets dry-run toggle BEFORE render', accumFn.indexOf('_mobAccumDryRun') < accumFn.indexOf('_mobVRenderStrategies'))
t('prefill marks the card as being edited', accumFn.includes("_mobEditing       = { type: 'accumulator', instance }"))
for (const id of ['m-accum-asset', 'm-accum-cut', 'm-accum-threshold', 'm-accum-maxdaily'])
  t(`prefills ${id}`, accumFn.includes(id))

// Field ids in the prefill must match the ids the form actually renders.
for (const id of ['m-accum-asset', 'm-accum-cut', 'm-accum-threshold', 'm-accum-maxdaily'])
  t(`${id} exists in the rendered form`, src.includes(`id="${id}"`))

// And the ids the ARGV builder reads, so edit -> apply is a closed loop.
const buildFn = grab('function buildArgvMob(')
for (const id of ['m-accum-asset', 'm-accum-cut', 'm-accum-threshold', 'm-accum-maxdaily'])
  t(`buildArgvMob reads ${id}`, buildFn.includes(id))

// Routing that was missing.
const routeFn = grab('function _mobEditStratInstance(')
t('_mobEditStratInstance routes accumulator', routeFn.includes("type === 'accumulator'"))
t('_mobEditStratInstance still routes grid', routeFn.includes("type === 'grid'"))

// The Edit button must now render for accumulator, not just grid.
t('Edit button shown for accumulator',
  src.includes("(s.type === 'grid' || s.type === 'accumulator') ? `<button onclick=\"window._mobEditStratInstance"))

// Expanding a running Profit Stack should enter edit mode automatically.
const expandFn = grab('function _mobExpandStrat(')
t('expanding a running Profit Stack auto-enters edit mode',
  expandFn.includes("type === 'accumulator'") && expandFn.includes("_configs?.['accumulator:']"))

// Applying an edit must keep the buffer (--resume) — pairs with the accumulator-side fix.
const updFn = grab('async function updateStrategyMob(')
t('update re-launches with --resume so the buffer survives', updFn.includes("argv.push('--resume')"))
t('update stops the edited instance before starting', updFn.indexOf('_postStop') < updFn.indexOf('/api/start'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
