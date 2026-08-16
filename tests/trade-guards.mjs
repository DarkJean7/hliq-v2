// Smoke test: trade-action guards must route to the ACTION'S account, not global state.
//
// This locks the regression we hit twice — the All-Accounts close (and edit-order) submit
// handlers checking the globally-connected wallet (`_canAct()`) instead of the position's /
// order's owning wallet. It stubs `__acctCanTrade` to capture which address each submit
// handler guards on, so it needs no real wallet or agent key.
//
// Run:  node tests/trade-guards.mjs            (expects a dev server; pass --port=NNNN)
import { chromium } from 'playwright'

const port = (process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || '5173'
const URL  = `http://localhost:${port}/`

const b  = await chromium.launch()
const pg = await b.newPage()
const errs = []
pg.on('pageerror', e => errs.push(e.message))
await pg.addInitScript(() => localStorage.setItem('hliq_force_mobile', '1'))
await pg.goto(URL, { waitUntil: 'domcontentloaded' })
await pg.waitForTimeout(1500)

const res = await pg.evaluate(async () => {
  const out = {}
  // Force every guard to block, and record the address it was asked about.
  window.__acctCanTrade = (addr) => { window.__guardAddr = addr; return false }

  // Close: the guard must ask about the POSITION's owning account.
  window.__guardAddr = null
  window.__openCloseModal('BTC', 'SHORT', -1000, 50000, '0xPOS_ACCOUNT')
  await window.__confirmClosePosition()
  out.closeGuardAddr = window.__guardAddr
  out.closeStatus    = (document.getElementById('closeModalStatus')?.textContent || '').trim()

  // Edit order: the guard must ask about the ORDER's owning account.
  window.__guardAddr = null
  window.__openEditOrderModal('ETH', 777, true, 1, 2000, false, false, '0xORD_ACCOUNT')
  await window.__confirmEditOrder()
  out.editGuardAddr = window.__guardAddr

  return out
})

await b.close()

const fails = []
if (res.closeGuardAddr !== '0xPOS_ACCOUNT') fails.push(`close guard used "${res.closeGuardAddr}" (expected 0xPOS_ACCOUNT — it's reading global state again)`)
if (!/agent key/i.test(res.closeStatus))    fails.push(`close guard did not surface an agent-key error (got "${res.closeStatus}")`)
if (res.editGuardAddr !== '0xORD_ACCOUNT')  fails.push(`edit-order guard used "${res.editGuardAddr}" (expected 0xORD_ACCOUNT)`)
if (errs.length)                             fails.push('page errors: ' + errs.slice(0, 5).join(' | '))

if (fails.length) {
  console.error('✗ trade-guard smoke test FAILED:')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log('✓ trade-guard smoke test passed — close & edit-order guards route to the action account')
