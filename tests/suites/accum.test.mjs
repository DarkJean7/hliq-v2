// Exercises the real accumulator arm paths. The script exits early without an agent
// key / network, so we drive the state logic the same way main() does by extracting the
// persistence helpers plus the three arm branches out of the real file.
import fs from 'fs'
import os from 'os'
import path from 'path'

const src = fs.readFileSync('strategies/accumulator.js', 'utf8').replace(/\r\n/g, '\n')

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

// The arm branch, lifted verbatim out of the IIFE.
const armStart = src.indexOf('  if (RESUME) {')
const armEnd   = src.indexOf("\n  log('START'", armStart)
if (armStart < 0 || armEnd < 0) throw new Error('arm branch not found')
const armSrc = src.slice(armStart, armEnd)

const tmp = path.join(os.tmpdir(), `acc-test-${Date.now()}.json`)
const helpers = [grab('function _readAllState()'), grab('function loadState()'),
                 grab('function saveState()'), grab('function clearState()')].join('\n')

function makeArm({ RESUME, RESET_BUFFER, QUERY_ADDR = '0xABC', ASSET_SYM = 'HYPE', today = '2026-08-20' }) {
  const body = `
    const { readFileSync, writeFileSync } = fs
    const STATE_FILE = ${JSON.stringify(tmp)}
    const _today = () => ${JSON.stringify(today)}
    function _stateKey() { return \`\${(QUERY_ADDR || '').toLowerCase()}:\${ASSET_SYM}\` }
    ${helpers}
    let lastFillScan = Date.now(), toBuyUsd = 0, lifetimeSpent = 0, lifetimeQty = 0
    let dayKey = _today(), daySkimmed = 0
    const logs = []
    const log = (t, m) => logs.push(\`[\${t}] \${m}\`)
    ${armSrc}
    return { lastFillScan, toBuyUsd, lifetimeSpent, lifetimeQty, dayKey, daySkimmed, logs }
  `
  return new Function('fs', 'RESUME', 'RESET_BUFFER', 'QUERY_ADDR', 'ASSET_SYM', body)(
    fs, RESUME, RESET_BUFFER, QUERY_ADDR, ASSET_SYM)
}

const seed = (obj) => fs.writeFileSync(tmp, JSON.stringify({ '0xabc:HYPE': obj }, null, 2))
const readKey = () => JSON.parse(fs.readFileSync(tmp, 'utf8'))['0xabc:HYPE']

let pass = 0, fail = 0
const t = (n, c, x = '') => c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n, x))

const SAVED = { lastFillScan: 1000, toBuyUsd: 2.72, lifetimeSpent: 50, lifetimeQty: 1.5,
                dayKey: '2026-08-20', daySkimmed: 4.4, ts: 1 }

// ── 1. fresh arm (the edit case) keeps the buffer, resets the cursor ──────────
seed(SAVED)
let r = makeArm({ RESUME: false, RESET_BUFFER: false })
t('edit keeps the buffer', r.toBuyUsd === 2.72, `got ${r.toBuyUsd}`)
t('edit keeps lifetime totals', r.lifetimeQty === 1.5 && r.lifetimeSpent === 50)
t('edit RESETS the cursor to now (no re-skim of history)', r.lastFillScan > 1e12)
t('edit carries today\'s daily-cap total', r.daySkimmed === 4.4, `got ${r.daySkimmed}`)
t('edit logs that it carried the buffer', r.logs.some(l => l.includes('Carried buffer $2.72')))
t('edit persists the carried buffer', readKey().toBuyUsd === 2.72)

// ── 2. --reset-buffer really does clear it ───────────────────────────────────
seed(SAVED)
r = makeArm({ RESUME: false, RESET_BUFFER: true })
t('--reset-buffer zeroes the buffer', r.toBuyUsd === 0)
t('--reset-buffer zeroes lifetime', r.lifetimeQty === 0)
t('--reset-buffer says so in the log', r.logs.some(l => l.includes('Buffer reset')))

// ── 3. --resume (deploy/reboot) still restores the cursor too ────────────────
seed(SAVED)
r = makeArm({ RESUME: true, RESET_BUFFER: false })
t('resume restores buffer', r.toBuyUsd === 2.72)
t('resume restores the CURSOR (unlike a fresh arm)', r.lastFillScan === 1000, `got ${r.lastFillScan}`)

// ── 4. daily cap cannot be bypassed by re-arming, but rolls over next day ────
seed({ ...SAVED, dayKey: '2026-08-19' })
r = makeArm({ RESUME: false, RESET_BUFFER: false, today: '2026-08-20' })
t('stale day does NOT carry daySkimmed', r.daySkimmed === 0, `got ${r.daySkimmed}`)
t('stale day still carries the buffer', r.toBuyUsd === 2.72)

// ── 5. no prior state: fresh arm starts clean, no crash ──────────────────────
fs.writeFileSync(tmp, '{}')
r = makeArm({ RESUME: false, RESET_BUFFER: false })
t('no prior state → buffer 0', r.toBuyUsd === 0)
t('no prior state → no carry log', !r.logs.some(l => l.includes('Carried')))

// ── 6. a different asset is a different key — no cross-contamination ─────────
seed(SAVED)
r = makeArm({ RESUME: false, RESET_BUFFER: false, ASSET_SYM: 'PURR' })
t('other asset does not inherit HYPE buffer', r.toBuyUsd === 0)

fs.unlinkSync(tmp)
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
