// strategies/grid.js against a fake exchange whose info endpoints LAG, replaying the PURR
// report: "two orders at the same level" — 0x974E…6B, two buys of 555 PURR at $0.083641,
// 8 seconds apart (2026-11-14 16:48 UTC).
//
// What happened: the level-2 buy filled; a moment later it was gone from openOrders while
// orderStatus still said "open" and the fill was not in userFillsByTime yet. The bot took
// "not filled" for granted, re-placed the level, and that filled too. Separately, the fill scan
// resumed strictly after the newest fill it had seen on ANY coin, so a fill on another coin
// (another bot on the wallet) published first buried this one for good.
//
// Rules: src/gridheld.js (goneVerdict, fillKey), tests/suites/gridheld.test.mjs.
// Run:  node tests/gridlimbo-sim.mjs        (~1 min; no network)
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Wallet } from 'ethers'

let pass = 0, fail = 0
const t = (n, c, x = '') => { c ? pass++ : fail++; console.log('  ' + (c ? 'PASS ' : 'FAIL ') + n + (c ? '' : ' → ' + JSON.stringify(x))) }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gridlimbo-'))
const CTL = path.join(dir, 'ctl.json'), EV = path.join(dir, 'ev.jsonl')
const ctl = (o) => fs.writeFileSync(CTL, JSON.stringify(o))
const events = () => fs.existsSync(EV) ? fs.readFileSync(EV, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []
const buysAt = (px) => events().filter(e => e.kind === 'order' && e.side === 'B' && e.px === px).length
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const until = async (fn, ms = 30000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(200) } return false }

const KEY = Wallet.createRandom().privateKey
const ADDR = '0x974e086b541afc90acaf9ac5d3326d666a601e6b'
let out = ''
// A flat account and a $60–$80 long grid, mark $71.5: buys rest at $68.89, $66.67, ….
const bot = spawn(process.execPath, ['--import', './tests/fixtures/hlstub-grid.mjs', 'strategies/grid.js',
  '--address', ADDR, '--coin', 'HYPE', '--lower', '60', '--upper', '80', '--levels', '10', '--size', '400', '--leverage', '10', '--interval', '4'],
  { env: { ...process.env, AGENT_KEY: KEY, HLIQ_BOT: 'grid', HLSTUB_CTL: CTL, HLSTUB_EV: EV,
    HLSTUB_INIT: JSON.stringify({ coin: 'HYPE', szi: 0, entryPx: 0, mark: 71.5, fills: [] }) } })
bot.stdout.on('data', d => { out += d }); bot.stderr.on('data', d => { out += d })

ctl({ mark: 71.5, lagMs: 14000 })
await until(() => events().some(e => e.kind === 'order' && e.side === 'B'))
const px = events().filter(e => e.kind === 'order' && e.side === 'B').map(e => e.px).sort((a, b) => b - a)[0]
t('the grid rests a buy just under the mark', px > 0 && px < 71.5, events())

// It fills. For 14 s HL's status and fills say nothing; meanwhile another coin fills and is
// published at once — the high-water mark moves past this fill.
ctl({ mark: 71.5, lagMs: 14000, fills: [{ id: 1, px }], other: [{ id: 1 }] })
t('it fills', await until(() => events().some(e => e.kind === 'fill' && e.px === px)))
await until(() => /\[WAIT\s*\]/.test(out), 12000)
t('the bot sees the order gone but HL not sure, and holds the level instead of calling it unfilled',
  /\[WAIT\s*\][^\n]*left the book but HL says "open"/.test(out) && !/\(not filled\)/.test(out), out.slice(-1500))
await sleep(10000)    // still inside the lag: the old bot re-placed it here
t('it does NOT place a second buy at that level while HL catches up', buysAt(px) === 1, events())

// HL catches up. The fill is older than the other coin's — the old scan never saw it.
await sleep(14000)
t('once HL has it, the bot logs the FILL', /\[FILL\s*\][^\n]*BUY[^\n]*filled/.test(out), out.slice(-1500))
t('and places the lot\'s exit', events().some(e => e.kind === 'order' && e.side === 'A'), events())
await sleep(10000)
t('and still never buys that level twice', buysAt(px) === 1, events())

bot.kill('SIGTERM')
fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
