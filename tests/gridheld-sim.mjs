// strategies/grid.js, the real script, against a fake exchange (tests/fixtures/hlstub-grid.mjs),
// replaying the HYPE report: "the grid bot is buying the same level multiple times without
// selling" (0xAB33…9B79, $70–$90, 10 levels, 2026-11-12/13).
//
// The account holds HYPE from higher up at an average near $79.5. The grid buys at $70; the
// lot's natural exit ($72.22) is below the average, so the profit gate parks it at $81+. The old
// bot then saw no exit at $72.22, thought $70 was free, and bought it again. Now $70 stays held
// until an exit fills, and it still holds across a restart.
//
// Run:  node tests/gridheld-sim.mjs        (~1 min; no network)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Wallet } from 'ethers'

let pass = 0, fail = 0
const t = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x))) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridheld-'))
const CTL = path.join(dir, 'ctl.json'), EV = path.join(dir, 'ev.jsonl')
const ctl = (o) => fs.writeFileSync(CTL, JSON.stringify(o))
const events = () => fs.existsSync(EV) ? fs.readFileSync(EV, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const buysAt = (px, from = 0) => events().slice(from).filter(e => e.kind === 'order' && e.side === 'B' && e.px === px).length
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200) } return false }

const KEY = Wallet.createRandom().privateKey
const ADDR = '0xab333c752402ff3f753ab9eab657e86547a69b79'
let out = ''
const start = (init) => {
  const p = spawn(process.execPath, ['--import', './tests/fixtures/hlstub-grid.mjs', 'strategies/grid.js',
    '--address', ADDR, '--coin', 'HYPE', '--lower', '70', '--upper', '90', '--levels', '10', '--size', '393.88', '--leverage', '10', '--interval', '5'],
    { env: { ...process.env, AGENT_KEY: KEY, HLIQ_BOT: 'grid', HLSTUB_CTL: CTL, HLSTUB_EV: EV, HLSTUB_INIT: JSON.stringify(init) } })
  p.stdout.on('data', d => { out += d }); p.stderr.on('data', d => { out += d })
  return p
}

ctl({ mark: 71.5, fills: [] })
let bot = start({ coin: 'HYPE', szi: 15.87, entryPx: 79.5, mark: 71.5, fills: [] })

t('the grid places its $70 buy', await until(() => buysAt(70) === 1), out.slice(-1200))
ctl({ mark: 71.5, fills: [{ id: 1, px: 70 }] })
t('it fills', await until(() => events().some(e => e.kind === 'fill' && e.px === 70)))
const mark1 = events().findIndex(e => e.kind === "fill" && e.px === 70) + 1   // the old bot re-bought in the very cycle it saw the fill
await until(() => events().slice(mark1).some(e => e.kind === 'order' && e.side === 'A'), 15000)
t('its exit goes where the profit gate allows, above the new average ($77.00), not $72.22',
  events().slice(mark1).filter(e => e.kind === 'order' && e.side === 'A').every(e => e.px > (15.87 * 79.5 + 5.62 * 70) / 21.49), events().slice(mark1))
await sleep(12000)   // two more cycles at the same mark: the old bot re-bought $70 here
t('it does NOT buy $70 again while that lot is still held', buysAt(70, mark1) === 0, events().slice(mark1))
t('and the log says the fill happened', /FILL\s*\] Level 0 BUY @ \$70 filled/.test(out))

// A deploy restarts it. The held level must come back from the fills, not from memory.
bot.kill('SIGTERM'); await new Promise(r => bot.once('exit', r))
const init2 = { coin: 'HYPE', szi: 21.49, entryPx: (15.87 * 79.5 + 5.62 * 70) / 21.49, mark: 71.5,
  fills: [{ coin: 'HYPE', px: '70', sz: '5.62', side: 'B', time: Date.now() - 60000, closedPnl: '0', fee: '0' }] }
fs.writeFileSync(EV, ''); out = ''
bot = start(init2)
t('after a restart it knows $70 is holding', await until(() => /Levels still holding their lot: \$70\b/.test(out), 20000), out.slice(-800))
await sleep(12000)
t('and still does not buy it again', buysAt(70) === 0, events())

// The lot sells, at whichever level the gate put its exit. $70 is free again.
const exitPx = events().filter(e => e.kind === 'order' && e.side === 'A').map(e => e.px).sort((a, b) => a - b)[0]
t('there is a resting exit to fill', exitPx > 0, events())
ctl({ mark: 71.5, fills: [{ id: 2, px: exitPx }] })
t('once an exit fills, $70 is bought again', await until(() => buysAt(70) >= 1, 25000), events())

bot.kill('SIGTERM')
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
